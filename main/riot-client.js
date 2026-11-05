// Riot Client (国服同样存在) 本地接口: 按名字查全部 Riot ID。
//
// 为什么需要它: 国服 LCU 的 /lol-summoner/v1/alias/lookup 必须同时给 gameName 与
// tagLine, 少一个就 400 "A value for 'tagLine' is required."; 而 Riot Client 的
// /player-account/aliases/v1/lookup 只给 gameName 就能返回该名字下的**全部** Riot ID
// (实测 "雨未散" 返回 16 条), 这正是 Akari 那种"不用输完整 Tag"的来源。
//
// 连接参数: --riotclient-app-port / --riotclient-auth-token, 和 LCU 的
// --app-port / --remoting-auth-token 一起写在 LeagueClientUx.log 启动行里。
// 国服客户端以管理员运行时读不到进程命令行, 所以日志是唯一可靠来源 (与 lcu.js 同理)。
// 老客户端 / 只开 WeGame 没起 Riot Client 时这两个参数可能缺失, 此时本模块返回
// 空结果, 调用方退回本地玩家索引, 不影响原有查询。

const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { StringDecoder } = require('string_decoder');
const lcu = require('./lcu');

const RC_DEBUG = process.env.PORO_RC_DEBUG === '1';
const RC_PORT_RE = /--riotclient-app-port=(\d+)/;
const RC_TOKEN_RE = /--riotclient-auth-token=([\w-]+)/;
const HEAD_BYTES = 256 * 1024;      // 启动参数就在日志开头, 读多了纯浪费
const OK_TTL = 10 * 60 * 1000;      // 端口/token 在一次客户端生命周期内不变
const FAIL_TTL = 30 * 1000;         // 没找到就冷却一会, 别每敲一个字都全盘扫
const LOOKUP_TIMEOUT = 5000;

const agent = new https.Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 2000 });

let cached = null;      // { port, token }
let cachedAt = 0;
let failedAt = 0;
let probing = null;

// 只读文件头, 找到两个参数就停 (日志可能上百 MB, 不能整文件读)
async function readRCFromFile(file) {
  let handle = null;
  try {
    handle = await fsp.open(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const port = text.match(RC_PORT_RE);
    const token = text.match(RC_TOKEN_RE);
    if (!port || !token) return null;
    return { port: +port[1], token: token[1] };
  } catch (e) {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function newestLogs(dir) {
  for (const t of [dir, path.join(dir, 'Logs')]) {
    let names;
    try { names = await fsp.readdir(t); } catch (e) { continue; }
    const logs = names.filter(f => f.endsWith('_LeagueClientUx.log'));
    if (!logs.length) continue;
    const withTime = await Promise.all(logs.map(async f => {
      const full = path.join(t, f);
      try { const st = await fsp.stat(full); return { full, mtime: st.mtimeMs }; } catch (e) { return null; }
    }));
    return withTime.filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 2).map(x => x.full);
  }
  return [];
}

async function probe() {
  let dirs = [];
  try {
    dirs = lcu._internals.knownClientDirs(lcu._internals.fixedDrives());
  } catch (e) { dirs = []; }
  for (const dir of dirs) {
    const logs = await newestLogs(dir);
    if (!logs.length) continue;
    for (const file of logs) {
      const conn = await readRCFromFile(file);
      if (conn) return { ...conn, dir };
    }
  }
  return null;
}

async function getRC() {
  if (cached && Date.now() - cachedAt < OK_TTL) return cached;
  if (Date.now() - failedAt < FAIL_TTL) return null;
  if (probing) return probing;
  probing = probe().then(conn => {
    if (conn) { cached = { port: conn.port, token: conn.token }; cachedAt = Date.now(); }
    else failedAt = Date.now();
    return cached;
  }).finally(() => { probing = null; });
  return probing;
}

function reset() { cached = null; cachedAt = 0; failedAt = 0; }

function rawRequest(conn, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      Authorization: 'Basic ' + Buffer.from('riot:' + conn.token).toString('base64'),
      Accept: 'application/json'
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload, 'utf8');
    }
    const req = https.request({
      hostname: '127.0.0.1', port: conn.port, path: urlPath, method, headers,
      rejectUnauthorized: false, agent
    }, res => {
      let data = '';
      const decoder = new StringDecoder('utf8');
      res.on('data', c => { data += decoder.write(c); });
      res.on('end', () => {
        data += decoder.end();
        if (RC_DEBUG) console.log('[RC]', method, urlPath, 'status=' + res.statusCode, 'len=' + data.length);
        if (res.statusCode === 401 || res.statusCode === 403) {
          const err = new Error('Riot Client 认证失败');
          err.authFail = true;
          return reject(err);
        }
        if (res.statusCode >= 400) {
          const err = new Error('HTTP ' + res.statusCode + (data ? ': ' + data.slice(0, 160) : ''));
          err.httpStatus = res.statusCode;
          if (res.statusCode === 404) err.notFound = true;
          return reject(err);
        }
        try { resolve(data ? JSON.parse(data) : null); } catch (e) { resolve(data); }
      });
    });
    req.on('error', e => reject(new Error('Riot Client 连接失败: ' + e.message)));
    req.setTimeout(LOOKUP_TIMEOUT, () => { req.destroy(); reject(new Error('Riot Client 请求超时')); });
    if (payload) req.write(Buffer.from(payload, 'utf8'));
    req.end();
  });
}

// 服务端返回 [{ alias:{game_name,tag_line}, puuid }]; 统一成驼峰并丢掉残缺项。
// 抽成纯函数: 字段名是 Riot 内部命名 (历史上两种写法都出现过), 拆开才测得动。
function mapAliasList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const alias = item && item.alias;
    if (!alias || !item.puuid) continue;
    const gameName = String(alias.game_name || alias.gameName || '');
    const tagLine = String(alias.tag_line || alias.tagLine || '');
    if (!gameName) continue;
    out.push({ gameName, tagLine, puuid: String(item.puuid) });
  }
  return out;
}

// 按精确名字查全部 Riot ID。返回 [{ gameName, tagLine, puuid }]
// 注意: 该接口**只认完整名字**, 前缀 (如 "雨未") 一律返回空数组 —— 这是服务端行为,
// 不是我们的过滤; 前缀/子串匹配仍由本地玩家索引负责。
// 区分"服务端没有这个人"与"通道没通": 渲染层要靠这个区别决定提示文案
// (前者是查无此人, 后者是 Riot Client 没起来, 别让人以为名字打错了)。
async function aliasLookupEx(gameName) {
  const name = String(gameName == null ? '' : gameName).trim();
  if (!name) return { ok: false, list: [], error: '名字为空' };
  const conn = await getRC();
  if (!conn) return { ok: false, list: [], error: 'Riot Client 未就绪' };
  try {
    const list = await rawRequest(conn, 'GET', '/player-account/aliases/v1/lookup?gameName=' + encodeURIComponent(name));
    return { ok: true, list: mapAliasList(list) };
  } catch (err) {
    return { ok: false, list: [], error: err.message };
  }
}

async function aliasLookup(gameName) {
  const name = String(gameName == null ? '' : gameName).trim();
  if (!name) return [];
  const res = await aliasLookupEx(name);
  if (!res.ok) throw new Error(res.error);
  return res.list;
}

// puuid → {gameName, tagLine}。Riot Client 的 nameset 接口对**任意大区**的 puuid 都
// 给名字 (对局来源: LeagueAkari src/shared/http-api-axios-helper/riot-client/player-account.ts
// 的 getPlayerAccountNamesets)。这补上了两条链路的最大缺口:
//   - 跨区档案: SGP summoner-ledge 对外区账号返回 unnamed:true, 名字只能靠调用方携带;
//     有了它, 只有 puuid 也能查到真名 (黑名单/旧缓存这类"没名字只剩 puuid"的记录)。
//   - PUUID 直查 (Akari 搜索框支持粘贴 puuid): 以前我们拿到 puuid 也没有名字可显示。
async function namesetsByPuuidsEx(puuids) {
  const ids = (Array.isArray(puuids) ? puuids : [])
    .map(x => String(x == null ? '' : x).trim())
    .filter(Boolean)
    .slice(0, 64);   // 接口按批查询, 上限给 64 足够搜索/补名场景
  if (!ids.length) return { ok: false, map: {}, error: 'puuid 为空' };
  const conn = await getRC();
  if (!conn) return { ok: false, map: {}, error: 'Riot Client 未就绪' };
  try {
    const res = await rawRequest(conn, 'POST', '/player-account/lookup/v1/namesets-for-puuids', { puuids: ids });
    const map = {};
    const arr = (res && Array.isArray(res.namesets)) ? res.namesets : [];
    for (const n of arr) {
      if (!n || !n.puuid || !n.gnt) continue;
      map[n.puuid] = { gameName: n.gnt.gameName || '', tagLine: n.gnt.tagLine || '' };
    }
    return { ok: true, map };
  } catch (err) {
    return { ok: false, map: {}, error: err.message };
  }
}

module.exports = {
  aliasLookup, aliasLookupEx, namesetsByPuuidsEx, getRC, reset,
  _internals: { readRCFromFile, newestLogs, mapAliasList, RC_PORT_RE, RC_TOKEN_RE }
};
