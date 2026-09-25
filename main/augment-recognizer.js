'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const vision = require('./augment-vision');

const MAX_ICON_BYTES = 512 * 1024;
// 当前 CommunityDragon 中文目录已经超过 550 行。旧的 420 上限会让目录尾部强化
// 完全没有视觉模板，恰好在短标题 OCR 漏读时造成整轮推荐无法凑齐三张。
const MAX_CANDIDATES = 700;
const MIN_SCORE = 0.28;
const SAFE_VISUAL_SCORE = 0.82;
const SAFE_VISUAL_MARGIN = 0.06;

function isSafeVisualMatch(offer, iconUnique) {
  return !!iconUnique
    && Number(offer?.score) >= SAFE_VISUAL_SCORE
    && Number(offer?.margin) >= SAFE_VISUAL_MARGIN;
}

function createRecognizer(nativeImage, userDataPath, logger) {
  const cacheFile = path.join(userDataPath, 'augment-icon-descriptors.json');
  const cache = new Map();
  let loaded = false;
  let dirty = false;
  let saveTimer = null;

  function log(message) { try { logger && logger(message); } catch (e) {} }

  function loadCache() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      for (const [url, value] of Object.entries(raw || {})) {
        const descriptor = vision.descriptorFromBase64(value);
        if (descriptor) cache.set(url, descriptor);
      }
    } catch (e) {}
  }

  function saveCacheSoon() {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!dirty) return;
      dirty = false;
      try {
        const data = {};
        for (const [url, descriptor] of cache) data[url] = vision.descriptorToBase64(descriptor);
        fs.writeFileSync(cacheFile, JSON.stringify(data), 'utf8');
      } catch (e) { log('[AUGMENT VISION] cache save failed: ' + e.message); }
    }, 800);
  }

  function validIconUrl(value) {
    try {
      const u = new URL(String(value || ''));
      return u.protocol === 'https:' && u.hostname === 'raw.communitydragon.org' ? u.toString() : '';
    } catch (e) { return ''; }
  }

  function download(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { 'User-Agent': 'Poro/1.4' } }, res => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const chunks = [];
        let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_ICON_BYTES) return req.destroy(new Error('icon too large'));
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('icon timeout')));
    });
  }

  async function descriptorFor(url) {
    loadCache();
    if (cache.has(url)) return cache.get(url);
    try {
      const image = nativeImage.createFromBuffer(await download(url));
      const descriptor = vision.descriptorFromImage(image, 'template');
      if (descriptor) {
        cache.set(url, descriptor);
        saveCacheSoon();
      }
      return descriptor;
    } catch (e) {
      log('[AUGMENT VISION] icon failed ' + url.substring(0, 120) + ': ' + e.message);
      return null;
    }
  }

  async function mapLimit(rows, limit, worker) {
    let cursor = 0;
    const out = new Array(rows.length);
    const jobs = Array.from({ length: Math.min(limit, rows.length) }, async () => {
      while (cursor < rows.length) {
        const index = cursor++;
        out[index] = await worker(rows[index], index);
      }
    });
    await Promise.all(jobs);
    return out;
  }

  async function recognize(screenshot, rawCandidates) {
    if (!screenshot || screenshot.isEmpty()) throw new Error('游戏截图为空');
    const candidates = (Array.isArray(rawCandidates) ? rawCandidates : [])
      .slice(0, MAX_CANDIDATES)
      .map(row => ({
        id: Number(row?.id) || 0,
        name: String(row?.name || '').substring(0, 60),
        icon: validIconUrl(row?.icon),
        priority: Math.max(0, Number(row?.priority) || 0)
      }))
      .filter(row => row.id > 0 && row.name && row.icon);
    if (!candidates.length) throw new Error('强化图标资料尚未加载');

    const byIcon = new Map();
    for (const row of candidates) {
      const previous = byIcon.get(row.icon);
      if (!previous || row.priority > previous.priority) byIcon.set(row.icon, row);
    }
    const unique = [...byIcon.values()];
    const templates = (await mapLimit(unique, 14, async row => ({ row, descriptor: await descriptorFor(row.icon) })))
      .filter(item => item.descriptor);
    if (templates.length < Math.min(3, candidates.length)) throw new Error('强化图标缓存不完整，请稍后重试');

    const size = screenshot.getSize();
    const rects = vision.offerIconRects(size.width, size.height);
    const offers = rects.map((rect, slot) => {
      const descriptor = vision.descriptorFromImage(screenshot.crop(rect), 'screen');
      const ranked = templates.map(item => ({
        id: item.row.id,
        name: item.row.name,
        icon: item.row.icon,
        score: vision.compareDescriptors(descriptor, item.descriptor)
      })).sort((a, b) => b.score - a.score);
      const best = ranked[0] || null;
      const second = ranked[1] || null;
      return {
        slot,
        id: best?.id || 0,
        name: best?.name || '',
        icon: best?.icon || '',
        score: best?.score || 0,
        margin: best && second ? best.score - second.score : 0,
        accepted: !!best && best.score >= MIN_SCORE,
        alternatives: ranked.slice(0, 4).map(x => ({ id: x.id, name: x.name, score: +x.score.toFixed(4) }))
      };
    });
    log('[AUGMENT VISION] ' + offers.map(o => `${o.slot + 1}:${o.name || '?'}=${o.score.toFixed(3)}/${o.margin.toFixed(3)}`).join(' '));
    return { width: size.width, height: size.height, offers };
  }

  return { recognize, cacheSize: () => cache.size };
}

module.exports = {
  createRecognizer,
  isSafeVisualMatch,
  MIN_SCORE,
  MAX_CANDIDATES,
  SAFE_VISUAL_SCORE,
  SAFE_VISUAL_MARGIN
};
