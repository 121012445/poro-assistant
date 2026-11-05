// 对局提示语音的在线合成通道
//
// 为什么需要它: 渲染层的 speechSynthesis 只能拿到 Windows 自带的 SAPI 音色
// (Huihui/Kangkang/Yaoyao), 是十几年前的拼接式合成, 念中文像机器报站。
//
// 两条在线通道, 按自然度降级:
//   1) edge  —— 微软神经语音 (main/tts-edge.js), 音色接近真人, 可选男女声
//   2) legacy —— 公开的翻译发声接口: 免注册、无需 key、国内直连、返回 mp3。
//               只有一个老式女声, 机械感明显, 仅在神经通道不可用时兜底。
// 两条都可能挂 (没有 SLA / 微软改协议), 所以调用方必须能在失败时退回本机合成。
//
// 只发送播报文本 (一句 20 字以内的提示), 不涉及账号、对局数据或本地文件。
'use strict';
const https = require('https');
const edge = require('./tts-edge');

const CACHE_MAX = 240;
// 提示是有时效的: 超过这个时间就算拿到音频也已经是旧闻, 直接当失败处理
const REQUEST_TIMEOUT_MS = 3500;
// key → { dataUrl, source }; source 决定渲染层要不要再做"柔和化"后处理
const cache = new Map();

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const v = cache.get(key);
  // 命中即刷新 LRU 顺序: 一局里高频复用的是"拿下双杀""大龙到手"这类固定句
  cache.delete(key);
  cache.set(key, v);
  return v;
}

function cacheSet(key, value) {
  cache.set(key, value);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// 语速 1-7, 传入值超出范围时收敛到区间内 (legacy 通道的档位)
function normalizeSpeed(speed) {
  const n = Math.round(Number(speed) || 5);
  return Math.max(1, Math.min(7, n));
}

function normalizeText(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 120);
}

// 调用方可以传对象 { voice, rate, pitch }, 也可以只传旧式的语速数字
function normalizeOptions(opts) {
  if (opts && typeof opts === 'object') {
    return {
      voice: edge.pickVoice(opts.voice),
      rate: edge.normalizeRate(opts.rate),
      pitch: edge.normalizePitch(opts.pitch)
    };
  }
  // 旧式 speed 数字: 5 是基准, 每档 ±12% (只在 legacy 通道有意义)
  const speed = normalizeSpeed(opts);
  return {
    voice: edge.DEFAULT_VOICE,
    rate: Math.round((speed - 5) * 12),
    pitch: 0
  };
}

// 必须是真 mp3: 上游出错时会用 200 返回一段 html 错误页, 只查状态码会把
// 一段 html 当音频丢给渲染层, 表现成"点了没声音"。
function looksLikeMp3(buf) {
  if (!buf || buf.length < 1000) return false;
  return buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0;
}

function fetchMp3(text, speed) {
  return new Promise(resolve => {
    const p = '/gettts?lan=zh&text=' + encodeURIComponent(text) + '&spd=' + normalizeSpeed(speed) + '&source=web';
    let req;
    try {
      req = https.get({
        hostname: 'fanyi.baidu.com', port: 443, path: p, method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
          'Referer': 'https://fanyi.baidu.com/',
          'Accept': 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8'
        }
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode !== 200 || !looksLikeMp3(buf)) return resolve(null);
          resolve(buf);
        });
      });
    } catch (e) { return resolve(null); }
    req.on('error', () => resolve(null));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { try { req.destroy(); } catch (e) {} resolve(null); });
  });
}

function toDataUrl(buf) {
  return 'data:audio/mpeg;base64,' + buf.toString('base64');
}

// 返回 { ok:true, dataUrl, source } 或 { ok:false, error }
// source: 'edge' (神经语音, 原声即可) | 'legacy' (老接口, 需要后处理压机械感)
// 失败计数由调用方维护 (它更清楚什么时候该整体降级)
async function synthesize(text, opts) {
  const clean = normalizeText(text);
  if (!clean) return { ok: false, error: '空文本' };
  const o = normalizeOptions(opts);
  const key = o.voice + '|' + o.rate + '|' + o.pitch + '|' + clean;
  const hit = cacheGet(key);
  if (hit) return { ok: true, dataUrl: hit.dataUrl, source: hit.source, cached: true };

  // 1) 神经语音: 自然度最高, 没了才往下掉
  if (edge.isAvailable()) {
    const buf = await edge.synthesize(clean, o.voice, { rate: o.rate, pitch: o.pitch });
    if (buf) {
      const entry = { dataUrl: toDataUrl(buf), source: 'edge' };
      cacheSet(key, entry);
      return { ok: true, dataUrl: entry.dataUrl, source: 'edge' };
    }
  }

  // 2) 旧在线接口: 音色单一且偏机械, 只保证"有声音"
  const legacyBuf = await fetchMp3(clean, 5);
  if (legacyBuf) {
    const entry = { dataUrl: toDataUrl(legacyBuf), source: 'legacy' };
    cacheSet(key, entry);
    return { ok: true, dataUrl: entry.dataUrl, source: 'legacy' };
  }

  return { ok: false, error: edge.isAvailable() ? '在线语音不可用' : '神经语音冷却中且旧接口不可用' };
}

function clearCache() { cache.clear(); }
function cacheSize() { return cache.size; }
function voiceList() { return edge.voiceList(); }
function status() { return edge.status(); }
function resetCooldown() { edge.resetCooldown(); }

module.exports = {
  synthesize, normalizeSpeed, normalizeText, normalizeOptions,
  looksLikeMp3, clearCache, cacheSize, voiceList, status, resetCooldown
};
