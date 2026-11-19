// LCU (League Client Update) 本地客户端连接模块
// 探测策略(依次尝试): 进程命令行 -> lockfile -> 客户端日志(国服客户端提权+lockfile为空, 日志是唯一来源)
const https = require('https');
const { StringDecoder } = require('string_decoder');
const { exec } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const LCU_DEBUG = process.env.PORO_LCU_DEBUG === '1';
// 应用以管理员运行, PowerShell 必须用 System32 绝对路径, 不能交给 PATH 解析。
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// keep-alive agent: LCU/SGP 高频请求复用 TLS 连接, 省掉每次握手的固定开销
// (本地 LCU 毫秒级握手是纯浪费; 客户端重启导致连接失效时在错误回调里销毁整个池, 下一请求自动重建)
const lcuAgent = new https.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 2000 });

let cached = null;      // { port, token }
let lastProbe = 0;
let probing = null;
const PROBE_COOLDOWN = 5000;

function decodeBuf(buf) {
  try { return new TextDecoder('gbk').decode(buf); } catch (e) { return buf.toString('utf8'); }
}

function execCmd(cmd, timeout = 10000, gbk = false) {
  return new Promise(resolve => {
    exec(cmd, { encoding: 'buffer', timeout, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve('');
      resolve(gbk ? decodeBuf(stdout) : stdout.toString('utf8'));
    });
  });
}

function parseConn(text) {
  const port = text.match(/--app-port=(\d+)/);
  const token = text.match(/--remoting-auth-token=([\w-]+)/);
  return port && token ? { port: +port[1], token: token[1] } : null;
}

// Windows 只在路径含空格时才给 exe 加引号。旧实现只认 "..." 形式, 遇到
// D:\WeGameApps\英雄联盟\LeagueClient\LeagueClientUx.exe 这种无空格路径会解析出
// exeDir=null —— 于是 conn 有值却没有 clientDir, 它被当成权威候选缓存下来,
// 之后 getLCU() 只返回它, resolveGameConfigDir 全跳过, 表现为
// "锁定游戏设置开启失败: 未找到当前英雄联盟的 Config 目录"。
function exeDirFromCommandLine(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  const quoted = text.match(/"([^"]+\.exe)"/i);
  if (quoted) return path.dirname(quoted[1]);
  const bare = text.match(/^([A-Za-z]:\\[^\s"]+\.exe)/i) || text.match(/([A-Za-z]:\\[^\s"]*LeagueClientUx\.exe)/i);
  return bare ? path.dirname(bare[1]) : null;
}

// 策略1: LeagueClientUx.exe 进程命令行 (非提权环境可用)
async function fromProcess() {
  const out = await execCmd(`"${POWERSHELL}" -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object Name -EQ 'LeagueClientUx.exe' | Select-Object -First 1 -ExpandProperty CommandLine"`);
  const line = out.trim();
  const conn = parseConn(line);
  return { conn, exeDir: exeDirFromCommandLine(line) };
}

// 注册表查询 (输出为 GBK, 需转码; 兼容国服腾讯/外服 Riot 键)
// 安装路径几乎不会变, 而客户端未运行时 probe 每 5 秒会走到这里: 每次起 3 个 reg 子进程纯属浪费。
// 查到路径缓存 10 分钟; 一个都没查到只缓存 1 分钟 (用户可能刚装好客户端)。reset() 会清掉。
let _regPathsCache = null;   // { t, paths }
const REG_CACHE_TTL = 10 * 60 * 1000;
const REG_CACHE_EMPTY_TTL = 60 * 1000;
async function regInstallPaths() {
  if (_regPathsCache && Date.now() - _regPathsCache.t < (_regPathsCache.paths.length ? REG_CACHE_TTL : REG_CACHE_EMPTY_TTL)) {
    return _regPathsCache.paths;
  }
  const keys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\LOL',
    'HKCU\\Software\\Tencent\\LOL',
    'HKLM\\SOFTWARE\\WOW6432Node\\Riot Games, Inc.\\League of Legends'
  ];
  const paths = [];
  for (const k of keys) {
    const out = await execCmd(`reg query "${k}" /v InstallPath`, 5000, true);
    const m = out.match(/REG_SZ\s+(.+)/);
    if (m) paths.push(m[1].trim());
  }
  _regPathsCache = { t: Date.now(), paths };
  return paths;
}

// 策略2: lockfile (国服客户端写的是空文件, 读取失败则跳过)
async function fromLockfile(dir) {
  try {
    const txt = await fsp.readFile(path.join(dir, 'lockfile'), 'utf8');
    const [, , port, token] = txt.split(':');
    return port && token ? [{ port: +port, token, clientDir: dir }] : [];
  } catch (e) { return []; }
}

// 策略3: 客户端日志 (国服唯一可行来源, 取最新3个日志解析 token/port)
//
// 这里原先是 readFileSync 整文件读入再正则匹配, 跑在主进程上: 客户端日志可能很大, 且未连接时
// 每 5 秒重来一次, 会直接卡住主进程事件循环 (IPC、轮询、定时器全部排队)。现在:
//   · 异步 I/O, 不阻塞事件循环
//   · 分块读取, 拿到 port 和 token 就停 (连接参数在启动命令行里, 通常在文件最前面)
//   · 按 mtime+size 缓存解析结果, 没变化的旧日志不再重读
// parseConn 的两个正则都不跨行, 所以"逐行段解析 + 各取第一个匹配"与整文件匹配结果一致。
const CONN_READ_CHUNK = 64 * 1024;
const CONN_FILE_CACHE_MAX = 64;
const _connFileCache = new Map();   // file → { mtimeMs, size, conn }
const PORT_RE = /--app-port=(\d+)/;
const TOKEN_RE = /--remoting-auth-token=([\w-]+)/;

async function readConnFromFile(file) {
  let stat;
  try { stat = await fsp.stat(file); } catch (e) { return null; }
  const hit = _connFileCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.conn;

  let port = null;
  let token = null;
  let handle = null;
  try {
    handle = await fsp.open(file, 'r');
    let position = 0;
    let carry = Buffer.alloc(0);   // 上一块末尾不完整的行 (字节级保留, 避免截断多字节字符或 token)
    for (;;) {
      const chunk = Buffer.alloc(CONN_READ_CHUNK);
      const { bytesRead } = await handle.read(chunk, 0, CONN_READ_CHUNK, position);
      position += bytesRead;
      const eof = bytesRead === 0;
      const data = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      // 只解析到最后一个换行: 0x0A 不会出现在多字节 UTF-8 字符中间, 也保证 token 不被块边界截断。
      const lastNewline = eof ? data.length : data.lastIndexOf(0x0a);
      const usable = lastNewline >= 0 ? data.subarray(0, eof ? data.length : lastNewline + 1) : null;
      carry = usable ? data.subarray(usable.length) : data;
      if (usable && usable.length) {
        const text = usable.toString('utf8');
        if (!port) { const m = text.match(PORT_RE); if (m) port = +m[1]; }
        if (!token) { const m = text.match(TOKEN_RE); if (m) token = m[1]; }
        if (port && token) break;
      }
      if (eof) break;
    }
  } catch (e) { return null; /* 单个日志读取失败: 不缓存, 下次再试 */ }
  finally { if (handle) await handle.close().catch(() => {}); }

  const conn = port && token ? { port, token } : null;
  _connFileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, conn });
  if (_connFileCache.size > CONN_FILE_CACHE_MAX) _connFileCache.delete(_connFileCache.keys().next().value);
  return conn;
}

async function fromLogs(dir) {
  const targets = [dir, path.join(dir, 'Logs')];
  const perTarget = await Promise.all(targets.map(async t => {
    let names;
    try { names = await fsp.readdir(t); } catch (e) { return []; /* 目录不存在 */ }
    const logs = names
      .filter(f => f.endsWith('_LeagueClientUx.log'))
      .sort()
      .reverse()
      .slice(0, 3);
    const conns = await Promise.all(logs.map(f => readConnFromFile(path.join(t, f))));
    return conns.filter(Boolean).map(conn => ({ ...conn, clientDir: dir }));
  }));
  return perTarget.flat();   // 顺序与原实现一致: 先 dir 再 dir/Logs, 各自新→旧
}

const KNOWN_CLIENT_DIRS = [
  'C:\\Riot Games\\League of Legends',
  'D:\\Riot Games\\League of Legends',
  'C:\\Riot Games\\League of Legends\\LeagueClient',
  'D:\\Riot Games\\League of Legends\\LeagueClient',
  'D:\\WeGameApps\\英雄联盟\\LeagueClient',
  'C:\\WeGameApps\\英雄联盟\\LeagueClient',
  'D:\\WeGame\\rail_files\\英雄联盟\\LeagueClient',
  'C:\\Program Files\\WeGame\\rail_files\\英雄联盟\\LeagueClient',
  'C:\\英雄联盟\\LeagueClient',
  'D:\\英雄联盟\\LeagueClient'
];

// 快速扫描原先只看 C/D 盘上的常见路径。国服客户端以管理员身份运行时, 受限版 Poro 读不到它的进程
// 命令行, 若注册表里也没有安装路径, 装在 E/F 等盘上的客户端就永远连不上。这里把同样的相对路径
// 扩展到其他本地固定磁盘。只取"固定磁盘" (GetDriveTypeW = DRIVE_FIXED): 网络盘、光驱、可移动盘
// 不扫 —— 断开的网络盘上 fs 调用可能挂起几十秒。盘符列表缓存 10 分钟。
const EXTRA_CLIENT_DIR_SUFFIXES = [
  'Riot Games\\League of Legends',
  'Riot Games\\League of Legends\\LeagueClient',
  'WeGameApps\\英雄联盟\\LeagueClient',
  'WeGame\\rail_files\\英雄联盟\\LeagueClient',
  '英雄联盟\\LeagueClient'
];
const DRIVE_LIST_TTL = 10 * 60 * 1000;
let _driveCache = null;     // { t, drives }
let _listFixedDrives = defaultListFixedDrives;

function defaultListFixedDrives() {
  if (process.platform !== 'win32') return [];
  const koffi = require('koffi');
  const kernel32 = koffi.load('kernel32.dll');
  const GetLogicalDrives = kernel32.func('uint32 GetLogicalDrives()');
  const GetDriveTypeW = kernel32.func('uint32 GetDriveTypeW(str16 lpRootPathName)');
  const DRIVE_FIXED = 3;
  const mask = GetLogicalDrives();
  const drives = [];
  for (let i = 2; i < 26; i++) {               // 从 C 开始; A/B 是软驱
    if (!(mask & (1 << i))) continue;
    const letter = String.fromCharCode(65 + i);
    if (GetDriveTypeW(letter + ':\\') === DRIVE_FIXED) drives.push(letter);
  }
  return drives;
}

function fixedDrives() {
  if (_driveCache && Date.now() - _driveCache.t < DRIVE_LIST_TTL) return _driveCache.drives;
  let drives = [];
  try { drives = (_listFixedDrives() || []).map(d => String(d).toUpperCase()).filter(d => /^[C-Z]$/.test(d)); } catch (e) { drives = []; }
  _driveCache = { t: Date.now(), drives };
  return drives;
}

// 原有清单原样在前 (顺序 = 优先级不变), 其他盘的候选追加在后
function knownClientDirs(drives) {
  const extra = [];
  for (const d of drives || []) {
    if (d === 'C' || d === 'D') continue;
    for (const suffix of EXTRA_CLIENT_DIR_SUFFIXES) extra.push(d + ':\\' + suffix);
  }
  return KNOWN_CLIENT_DIRS.concat(extra);
}

async function collectCandidates(dirs, initial) {
  const candidates = initial ? initial.slice() : [];
  const seen = new Set();
  for (const c of candidates) seen.add(c.port + '|' + c.token);
  // 各目录并行读取, 但按 dirs 的原顺序合并, 候选优先级不变。
  const perDir = await Promise.all(dirs.map(async d => {
    try { await fsp.access(d); } catch (e) { return []; }
    const [lock, logs] = await Promise.all([fromLockfile(d), fromLogs(d)]);
    return [...lock, ...logs];
  }));
  for (const list of perDir) {
    for (const c of list) {
      const key = c.port + '|' + c.token;
      if (!seen.has(key)) { seen.add(key); candidates.push(c); }
    }
  }
  return candidates;
}

async function probe() {
  // 进程命令行是当前运行客户端最权威的凭证来源: 端口/token 必然属于正开着的那个客户端。
  // 必须优先用它, 并把它的安装目录(exeDir)纳入扫描 —— 日服/外服常装在非清单路径
  // (如 D:\lol\Riot Games\League of Legends), 只扫 knownClientDirs 会漏掉。
  //
  // 旧实现先扫 knownClientDirs 的日志, 一旦命中就 return。但那些是历史日志: 客户端关掉后
  // 端口失效, 日志仍在磁盘上 —— 结果 fast 命中的全是过期凭证, fromProcess 永远不被调用,
  // 真正活着的客户端反而连不上, 表现为"未连接客户端"。现在改为: 进程命令行优先取权威 conn,
  // 再叠加各目录 lockfile/日志作兜底; 国服以管理员运行时命令行读不到(conn 为空), 行为回退到
  // 原来的目录扫描 + 注册表, 不受影响。
  const { conn, exeDir } = await fromProcess();

  const dirs = [];
  if (exeDir) dirs.push(exeDir);
  for (const d of knownClientDirs(fixedDrives())) if (d !== exeDir) dirs.push(d);
  for (const p of await regInstallPaths()) {
    for (const d of [p, path.join(p, 'LeagueClient')]) if (!dirs.includes(d)) dirs.push(d);
  }
  return collectCandidates(dirs, conn ? [{ ...conn, clientDir: exeDir }] : []);
}

// 获取候选连接 (带冷却, 避免频繁探测造成卡顿)
async function getLCU() {
  if (cached) return [cached];
  // 并发请求共享正在进行的探测；原先先判断冷却会让后来的请求直接误报“未检测到客户端”。
  if (probing) return probing;
  if (Date.now() - lastProbe < PROBE_COOLDOWN) return [];
  lastProbe = Date.now();
  probing = probe().finally(() => { probing = null; });
  return probing;
}

function reset() { cached = null; lastProbe = 0; _regPathsCache = null; _connFileCache.clear(); _driveCache = null; }

// 供 WebSocket 模块读取当前凭证 (未连接时返回 null)
function getCached() { return cached; }

// 从候选客户端解析游戏 Config 目录。兼容两种客户端目录结构:
//   - 国服 WeGame: exe 在 <游戏根>\LeagueClient\ 子目录, Config 在 dirname(clientDir)\Config
//   - 官方/外服(含日服): exe 直接在 <游戏根>\ 下, Config 就在 clientDir 同层
// 顺序: 父级优先(保持国服既有行为完全不变), 父级找不到再补试同层。
// 以 PersistedSettings.json 实际存在为判定, 不依赖平台/路径硬编码。
function resolveGameConfigDir(candidates, cachedCandidate, exists) {
  const ordered = cachedCandidate ? [cachedCandidate, ...candidates.filter(c => c !== cachedCandidate)] : candidates;
  for (const candidate of ordered) {
    if (!candidate || !candidate.clientDir) continue;
    const gameRoots = [path.dirname(candidate.clientDir), candidate.clientDir];
    for (const gameRoot of gameRoots) {
      for (const configDir of [path.join(gameRoot, 'Config'), path.join(gameRoot, 'Game', 'Config')]) {
        if (exists(path.join(configDir, 'PersistedSettings.json'))) return configDir;
      }
    }
  }
  return null;
}

// 候选连接都没带安装目录时的兜底: 直接按已知安装目录清单 + 注册表查
// (命令行读不到 / exe 路径无引号解析失败 / 缓存的是另一个客户端, 都会走到这里)。
// 只做 fs 存在性检查, 不依赖 LCU 连接。
function resolveFallbackConfigDir(dirs, exists) {
  const candidates = (dirs || []).filter(Boolean).map(d => ({ clientDir: d }));
  return resolveGameConfigDir(candidates, null, exists);
}

async function getGameConfigDir() {
  const candidates = await getLCU();
  let dir = resolveGameConfigDir(candidates, cached, p => fs.existsSync(p));
  let fallbackCount = 0;
  if (!dir) {
    const dirs = knownClientDirs(fixedDrives());
    for (const p of await regInstallPaths()) {
      dirs.push(p, path.join(p, 'LeagueClient'));
    }
    fallbackCount = dirs.length;
    dir = resolveFallbackConfigDir(dirs, p => fs.existsSync(p));
  }
  if (!dir) throw new Error('未找到当前英雄联盟的 Config 目录（已检查 ' + fallbackCount + ' 个安装路径）');
  return dir;
}

function rawRequest(conn, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const contentLength = payload ? Buffer.byteLength(payload, 'utf8') : 0;
    if (LCU_DEBUG && payload) console.log('[LCU] >>', method, urlPath, 'len=' + contentLength, payload.substring(0, 500));
    const headers = {
      'Authorization': 'Basic ' + Buffer.from('riot:' + conn.token).toString('base64'),
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    if (method !== 'GET' && method !== 'DELETE') {
      headers['Content-Length'] = contentLength;
    }
    const req = https.request({
      hostname: '127.0.0.1', port: conn.port, path: urlPath, method, headers,
      rejectUnauthorized: false, agent: lcuAgent
    }, (res) => {
      let data = '';
      const decoder = new StringDecoder('utf8');
      res.on('data', c => { data += decoder.write(c); });
      res.on('end', () => {
        data += decoder.end();
        if (LCU_DEBUG) console.log('[LCU] <<', method, urlPath, 'status=' + res.statusCode, 'len=' + data.length);
        if (LCU_DEBUG && data) console.log('[LCU] body', data.substring(0, 1200));
        if (res.statusCode === 401 || res.statusCode === 403) {
          const err = new Error('LCU 认证失败');
          err.authFail = true;
          return reject(err);
        }
        if (res.statusCode === 204) return resolve(null);
        // 4xx/5xx: 解析错误体并附加 __error 标记, 让渲染层能区分失败与成功
        // (此前 400/500 被当作正常数据返回, 调用方误判成功 — 如一键领取奖励虚报数量)
        if (res.statusCode >= 400) {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch (e) { /* 空或非 JSON 响应体 */ }
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            parsed.__error = 'HTTP ' + res.statusCode + (parsed.message ? ': ' + parsed.message : '');
            parsed.httpStatus = res.statusCode;
            return resolve(parsed);
          }
          return resolve({ __error: 'HTTP ' + res.statusCode, httpStatus: res.statusCode });
        }
        try { resolve(data ? JSON.parse(data) : null); } catch (e) { resolve(data); }
      });
    });
    // 单个 socket 出错不能销毁首页、实时页与工具箱共用的 Agent，否则会让
    // 其它并发请求一起失败并触发重连雪崩。当前 req 销毁时会自行回收坏 socket。
    req.on('error', (e) => { reject(new Error('LCU 连接失败: ' + e.message)); });
    req.setTimeout(6000, () => { req.destroy(); reject(new Error('LCU 请求超时')); });
    if (payload) req.write(Buffer.from(payload, 'utf8'));
    req.end();
  });
}

// 请求入口: 依次尝试候选连接, 成功的缓存
async function lcuRequest(method, urlPath, body) {
  const candidates = await getLCU();
  if (!candidates.length) throw new Error('未检测到英雄联盟客户端，请先启动游戏客户端');
  let lastErr = null;
  for (const conn of candidates) {
    try {
      const result = await rawRequest(conn, method, urlPath, body);
      if (cached !== conn) { cached = conn; lastProbe = 0; }
      return result;
    } catch (e) {
      lastErr = e;
      if (!e.authFail && !/ECONNREFUSED|连接失败|超时/.test(e.message)) throw e;
    }
  }
  cached = null;
  throw lastErr || new Error('LCU 连接失败，请重启客户端');
}

// Live Client Data API (对局内, 2999 端口, 无需认证)
const lcdAgent = new https.Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 2000 });
function liveRequest(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: '127.0.0.1', port: 2999, path: urlPath,
      rejectUnauthorized: false, agent: lcdAgent,
      headers: { 'Accept': 'application/json' }
    }, (res) => {
      let data = '';
      const decoder = new StringDecoder('utf8');
      res.on('data', c => { data += decoder.write(c); });
      res.on('end', () => {
        data += decoder.end();
        // 与 rawRequest 对齐 (仅调试模式): liveRequest 被渲染层亚秒级轮询,
        // 无条件打印会在整局游戏中持续产生日志开销。
        if (LCU_DEBUG) console.log('[LCU-LCD] <<', 'GET', urlPath, 'status=' + res.statusCode, 'len=' + data.length);
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try {
          const obj = JSON.parse(data);
          // 调试: 标识数组/对象 + 长度, 必要时打印首项字段名, 便于排查 playerlist/allPlayers 返回 1 的根因
          if (LCU_DEBUG) {
            if (Array.isArray(obj)) {
              console.log('[LCU-LCD] <<', 'GET', urlPath, 'status=200 arrayLen=' + obj.length + (obj.length ? ' firstKeys=' + Object.keys(obj[0] || {}).slice(0, 12).join(',') : ''));
            } else if (obj && typeof obj === 'object') {
              console.log('[LCU-LCD] <<', 'GET', urlPath, 'status=200 objectKeys=' + Object.keys(obj).slice(0, 12).join(',') + (obj.allPlayers ? ' allPlayersLen=' + (Array.isArray(obj.allPlayers) ? obj.allPlayers.length : '?') : ''));
            } else {
              console.log('[LCU-LCD] <<', 'GET', urlPath, 'status=200 type=' + typeof obj);
            }
          }
          resolve(obj);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', e => { reject(new Error('对局数据接口不可用(未在游戏中): ' + (e?.message || e))); });
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('对局数据请求超时')); });
  });
}

// 修复 LCU 窗口大小 —— 已迁到 win-rect.setClientBounds (koffi 直调 user32)。
// 旧实现是 PowerShell FindWindow("RiotWindowClass") + SetWindowPos, 两个问题:
//   1. 类名错了: 客户端主窗是 RCLIENT, RiotWindowClass 只在进游戏后才存在,
//      所以在选人/大厅点"立即修复"必然返回 NOT_FOUND;
//   2. 坐标没做 DPI 换算, 缩放不是 100% 时会偏出屏幕。
// 这里保留一个薄封装给测试/兼容用, 行为已与按钮一致。

module.exports = {
  getLCU, lcuRequest, liveRequest, reset, getCached, getGameConfigDir,
  // 仅供测试
  _internals: {
    parseConn, readConnFromFile, fromLogs, fromLockfile, collectCandidates, regInstallPaths, CONN_READ_CHUNK,
    knownClientDirs, fixedDrives, KNOWN_CLIENT_DIRS, probe, fromProcess, resolveGameConfigDir,
    exeDirFromCommandLine, resolveFallbackConfigDir,
    setDriveLister: fn => { _listFixedDrives = fn || defaultListFixedDrives; _driveCache = null; }
  }
};
