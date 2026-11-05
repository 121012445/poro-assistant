// 对局提示语音的神经合成通道 (微软 Edge 朗读)
//
// 为什么换这里: 之前用的公开翻译发声接口只有一个老式女声, 音色本身就是拼接式
// 合成, 再怎么用 EQ/降调包也压不掉机械感 —— 柔和的听感来自"真人的共振腔",
// 不是来自滤波。Edge 朗读用的是同一条神经 TTS (和 Azure 同源), 中文音色
// 接近真人, 且免注册、免 key、国内直连, 是最省事的一档。
//
// 鉴权: 微软按 Chromium 大版本校验连接签名 (Sec-MS-GEC), 版本号与 UA 里的
// Chrome 版本、Sec-MS-GEC-Version 必须同源, 任一不匹配直接 403。所以这三个
// 常量要一起改。签名的值是 "Windows FILETIME 秒数向下取整到 5 分钟 + 固定
// token" 的 SHA-256, 详见 secMsGec()。
//
// 上游没有 SLA 也可能改协议, 因此本模块只负责"拿到 mp3 或返回 null",
// 降级由调用方 (tts.js) 决定: 神经语音 → 旧在线接口 → 本机音色。
'use strict';
const crypto = require('crypto');

let WebSocket = null;
try { WebSocket = require('ws'); } catch (e) { WebSocket = null; }

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS_URL = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';
// 三者必须同源: UA 里的 Chrome/Edge 版本、Sec-MS-GEC-Version 的后半段
const CHROMIUM_VERSION = '155.0.4283.45';
const SEC_MS_GEC_VERSION = '1-' + CHROMIUM_VERSION;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const REQUEST_TIMEOUT_MS = 4000;

// 中文神经音色白名单: 只留实测可用的 (晓辰/晓涵/云泽等会被服务端
// 以 "Unsupported voice" 拒绝, 列出来只会让用户选到哑的档位)
const VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔女声', desc: '最自然, 播报不抢戏' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 清亮女声', desc: '声音偏亮, 听得清' },
  { id: 'zh-CN-XiaoxuanNeural', label: '晓璇 · 冷静女声', desc: '平稳, 情绪起伏小' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 年轻男声', desc: '偏解说腔' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 沉稳男声', desc: '低沉, 适合当背景音' }
];
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

// 连续失败到阈值就歇一会, 避免每句提示都白等一个超时 (对局里最忌讳卡顿)
const FAIL_THRESHOLD = 3;
const COOLDOWN_MS = 90000;
let _failStreak = 0;
let _offUntil = 0;

function voiceList() { return VOICES.map(v => ({ ...v })); }

function pickVoice(name) {
  const hit = VOICES.find(v => v.id === name);
  return hit ? hit.id : DEFAULT_VOICE;
}

function isAvailable() {
  return !!WebSocket && Date.now() >= _offUntil;
}

// Windows FILETIME 秒数 (Unix 秒 + 1601→1970 的偏移), 向下取整到 5 分钟后
// 乘以 1e7 转成 100ns 单位, 与固定 token 拼起来做 SHA-256。
// 服务端按同一个 5 分钟窗口算, 所以不必精确到毫秒。
function secMsGec(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const ticks = Math.floor(now / 1000) + 11644473600;
  const rounded = ticks - (ticks % 300);
  const windowsTicks = rounded * 10000000;
  return crypto.createHash('sha256')
    .update(String(windowsTicks) + TRUSTED_CLIENT_TOKEN, 'ascii')
    .digest('hex')
    .toUpperCase();
}

function buildUrl(connectionId, nowMs) {
  return WSS_URL
    + '?Ocp-Apim-Subscription-Key=' + TRUSTED_CLIENT_TOKEN
    + '&Sec-MS-GEC=' + secMsGec(nowMs)
    + '&Sec-MS-GEC-Version=' + SEC_MS_GEC_VERSION
    + '&ConnectionId=' + connectionId;
}

// SSML 里文本必须转义, 否则 "10 < 20" 这种提示会让整条请求变成非法 XML
function escapeXml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// rate 是相对百分比: '+10%' 比默认快一成。对局提示要跟上节奏, 但太快会糊,
// 所以调用方给的值限制在 -30%~+30%。
function normalizeRate(rate) {
  const n = Math.round(Number(String(rate == null ? '' : rate).replace('%', '')) || 0);
  return Math.max(-30, Math.min(30, n));
}

function normalizePitch(pitch) {
  const n = Math.round(Number(String(pitch == null ? '' : pitch).replace('Hz', '')) || 0);
  return Math.max(-20, Math.min(20, n));
}

function buildSsml(text, voice, rate, pitch) {
  const r = normalizeRate(rate);
  const p = normalizePitch(pitch);
  const signR = r >= 0 ? '+' : '';
  const signP = p >= 0 ? '+' : '';
  return '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"'
    + ' xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN">'
    + '<voice name="' + pickVoice(voice) + '">'
    + '<prosody pitch="' + signP + p + 'Hz" rate="' + signR + r + '%" volume="+0%">'
    + escapeXml(text)
    + '</prosody></voice></speak>';
}

function buildConfigMessage(timestamp) {
  return 'X-Timestamp:' + timestamp
    + '\r\nContent-Type:application/json; charset=utf-8'
    + '\r\nPath:speech.config\r\n\r\n'
    + '{"context":{"synthesis":{"audio":{"metadataoptions":'
    + '{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},'
    + '"outputFormat":"' + OUTPUT_FORMAT + '"}}}}';
}

function buildSsmlMessage(requestId, timestamp, ssml) {
  return 'X-RequestId:' + requestId
    + '\r\nContent-Type:application/ssml+xml'
    + '\r\nX-Timestamp:' + timestamp
    + '\r\nPath:ssml\r\n\r\n' + ssml;
}

// 文本帧: "Path:xxx" 之类头部 + 空行 + body
function parseTextFrame(text) {
  const s = String(text || '');
  const split = s.indexOf('\r\n\r\n');
  const head = split === -1 ? s : s.slice(0, split);
  const body = split === -1 ? '' : s.slice(split + 4);
  const m = /Path:([^\r\n]*)/i.exec(head);
  return { path: m ? m[1].trim() : '', body };
}

// 二进制帧: 2 字节大端头部长度 + 头部文本 + 音频数据
function parseBinaryFrame(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 2) return { path: '', audio: Buffer.alloc(0) };
  const headerLength = b.readUInt16BE(0);
  if (b.length < 2 + headerLength) return { path: '', audio: Buffer.alloc(0) };
  const head = b.slice(2, 2 + headerLength).toString('utf8');
  const m = /Path:([^\r\n]*)/i.exec(head);
  return { path: m ? m[1].trim() : '', audio: b.slice(2 + headerLength) };
}

function newConnectionId() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

function newRequestId() { return crypto.randomUUID().replace(/-/g, ''); }

// 返回 mp3 Buffer 或 null。任何异常都不抛给调用方 —— 语音失败不该影响提示逻辑。
function synthesize(text, voice, opts) {
  const body = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!body || !isAvailable()) return Promise.resolve(null);

  const o = opts || {};
  return new Promise(resolve => {
    let ws = null;
    let settled = false;
    const chunks = [];
    const finish = (buf) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (ws) ws.close(); } catch (e) {}
      if (buf && buf.length > 800) {
        _failStreak = 0;
        resolve(buf);
        return;
      }
      _failStreak++;
      if (_failStreak >= FAIL_THRESHOLD) _offUntil = Date.now() + COOLDOWN_MS;
      resolve(null);
    };
    const timer = setTimeout(() => finish(null), o.timeout || REQUEST_TIMEOUT_MS);

    try {
      ws = new WebSocket(buildUrl(newConnectionId()), {
        headers: {
          'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent': USER_AGENT,
          'Pragma': 'no-cache',
          'Cache-Control': 'no-cache'
        }
      });
    } catch (e) { return finish(null); }

    ws.on('open', () => {
      try {
        const ts = new Date().toUTCString();
        ws.send(buildConfigMessage(ts));
        ws.send(buildSsmlMessage(newRequestId(), ts,
          buildSsml(body, voice, o.rate, o.pitch)));
      } catch (e) { finish(null); }
    });

    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          const f = parseBinaryFrame(data);
          if (f.path === 'audio' && f.audio.length) chunks.push(f.audio);
          return;
        }
        const f = parseTextFrame(data.toString('utf8'));
        if (f.path === 'turn.end') finish(Buffer.concat(chunks));
      } catch (e) { finish(null); }
    });

    ws.on('error', () => finish(null));
    ws.on('unexpected-response', () => finish(null));
    ws.on('close', () => { if (!settled) finish(Buffer.concat(chunks)); });
  });
}

// 用户手动重选音色时清掉冷却, 否则要干等 90 秒才听到新音色
function resetCooldown() { _failStreak = 0; _offUntil = 0; }

function status() {
  return { available: isAvailable(), failStreak: _failStreak, cooldownLeftMs: Math.max(0, _offUntil - Date.now()) };
}

module.exports = {
  VOICES, DEFAULT_VOICE, OUTPUT_FORMAT,
  voiceList, pickVoice, isAvailable, status, resetCooldown,
  secMsGec, buildUrl, buildSsml, buildConfigMessage, buildSsmlMessage,
  parseTextFrame, parseBinaryFrame, escapeXml, normalizeRate, normalizePitch,
  synthesize
};
