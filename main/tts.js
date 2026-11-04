// 解说语音的在线合成通道
//
// 为什么需要它: 渲染层的 speechSynthesis 只能拿到 Windows 自带的 SAPI 音色
// (Huihui/Kangkang/Yaoyao), 是十几年前的拼接式合成, 念中文像机器报站。
// 这条通道用在线合成拿到明显更自然的人声, 本地音色退化为兜底。
//
// 上游是公开的翻译发声接口: 免注册、无需 key、国内直连、返回 mp3。
// 它没有 SLA, 所以调用方必须在失败时退回本地合成, 不能把它当唯一通道。
//
// 只发送播报文本 (一句 20 字以内的解说), 不涉及账号、对局数据或本地文件。
'use strict';
const https = require('https');

const CACHE_MAX = 240;
// 解说是有时效的: 超过这个时间就算拿到音频也已经是旧闻, 直接当失败处理
const REQUEST_TIMEOUT_MS = 3500;
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

// 语速 1-7, 传入值超出范围时收敛到区间内
function normalizeSpeed(speed) {
  const n = Math.round(Number(speed) || 5);
  return Math.max(1, Math.min(7, n));
}

function normalizeText(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 120);
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

// 返回 { ok:true, dataUrl } 或 { ok:false, error }
// 失败计数由调用方维护 (它更清楚什么时候该整体降级)
async function synthesize(text, speed) {
  const clean = normalizeText(text);
  if (!clean) return { ok: false, error: '空文本' };
  const key = normalizeSpeed(speed) + '|' + clean;
  const hit = cacheGet(key);
  if (hit) return { ok: true, dataUrl: hit, cached: true };

  const buf = await fetchMp3(clean, speed);
  if (!buf) return { ok: false, error: '在线语音不可用' };
  const dataUrl = 'data:audio/mpeg;base64,' + buf.toString('base64');
  cacheSet(key, dataUrl);
  return { ok: true, dataUrl };
}

function clearCache() { cache.clear(); }
function cacheSize() { return cache.size; }

module.exports = { synthesize, normalizeSpeed, normalizeText, looksLikeMp3, clearCache, cacheSize };
