// LCU (League Client Update) 本地客户端连接模块
// 探测策略(依次尝试): 进程命令行 -> lockfile -> 客户端日志(国服客户端提权+lockfile为空, 日志是唯一来源)
const https = require('https');
const { StringDecoder } = require('string_decoder');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const LCU_DEBUG = process.env.PORO_LCU_DEBUG === '1';

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

// 策略1: LeagueClientUx.exe 进程命令行 (非提权环境可用)
async function fromProcess() {
  const out = await execCmd('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object Name -EQ \'LeagueClientUx.exe\' | Select-Object -First 1 -ExpandProperty CommandLine"');
  const line = out.trim();
  const conn = parseConn(line);
  let exeDir = null;
  const exeMatch = line.match(/^"([^"]+LeagueClientUx\.exe)"/i);
  if (exeMatch) exeDir = path.dirname(exeMatch[1]);
  return { conn, exeDir };
}

// 注册表查询 (输出为 GBK, 需转码; 兼容国服腾讯/外服 Riot 键)
async function regInstallPaths() {
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
  return paths;
}

// 策略2: lockfile (国服客户端写的是空文件, 读取失败则跳过)
function fromLockfile(dir) {
  try {
    const txt = fs.readFileSync(path.join(dir, 'lockfile'), 'utf8');
    const [, , port, token] = txt.split(':');
    return port && token ? [{ port: +port, token, clientDir: dir }] : [];
  } catch (e) { return []; }
}

// 策略3: 客户端日志 (国服唯一可行来源, 取最新3个日志解析 token/port)
function fromLogs(dir) {
  const targets = [dir, path.join(dir, 'Logs')];
  const out = [];
  for (const t of targets) {
    try {
      const logs = fs.readdirSync(t)
        .filter(f => f.endsWith('_LeagueClientUx.log'))
        .sort()
        .reverse()
        .slice(0, 3);
      for (const f of logs) {
        try {
          const conn = parseConn(fs.readFileSync(path.join(t, f), 'utf8'));
          if (conn) out.push({ ...conn, clientDir: dir });
        } catch (e) { /* 单个日志读取失败 */ }
      }
    } catch (e) { /* 目录不存在 */ }
  }
  return out;
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

function collectCandidates(dirs, initial) {
  const candidates = initial ? initial.slice() : [];
  const seen = new Set();
  for (const c of candidates) seen.add(c.port + '|' + c.token);
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const c of [...fromLockfile(d), ...fromLogs(d)]) {
      const key = c.port + '|' + c.token;
      if (!seen.has(key)) { seen.add(key); candidates.push(c); }
    }
  }
  return candidates;
}

async function probe() {
  // 国服通常以管理员权限运行，进程命令行不可读；先直接扫常见目录的最新日志，避免每次启动等待 PowerShell/注册表。
  const fast = collectCandidates(KNOWN_CLIENT_DIRS);
  if (fast.length) return fast;

  const { conn, exeDir } = await fromProcess();
  const dirs = exeDir ? [exeDir] : [];
  for (const p of await regInstallPaths()) dirs.push(p, path.join(p, 'LeagueClient'));
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

function reset() { cached = null; lastProbe = 0; }

// 供 WebSocket 模块读取当前凭证 (未连接时返回 null)
function getCached() { return cached; }

async function getGameConfigDir() {
  const candidates = await getLCU();
  const ordered = cached ? [cached, ...candidates.filter(candidate => candidate !== cached)] : candidates;
  for (const candidate of ordered) {
    if (!candidate.clientDir) continue;
    const gameRoot = path.dirname(candidate.clientDir);
    const configDirs = [path.join(gameRoot, 'Config'), path.join(gameRoot, 'Game', 'Config')];
    for (const configDir of configDirs) {
      if (fs.existsSync(path.join(configDir, 'PersistedSettings.json'))) return configDir;
    }
  }
  throw new Error('未找到当前英雄联盟的 Config 目录');
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
        console.log('[LCU] <<', method, urlPath, 'status=' + res.statusCode, 'len=' + data.length);
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
        // 与 rawRequest 对齐: 便于排查对局数据问题 (liveRequest 走单独 https 跳过 rawRequest 日志)
        console.log('[LCU-LCD] <<', 'GET', urlPath, 'status=' + res.statusCode, 'len=' + data.length);
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try {
          const obj = JSON.parse(data);
          // 调试: 标识数组/对象 + 长度, 必要时打印首项字段名, 便于排查 playerlist/allPlayers 返回 1 的根因
          if (Array.isArray(obj)) {
            console.log('[LCU-LCD] <<', 'GET', urlPath, 'status=200 arrayLen=' + obj.length + (obj.length ? ' firstKeys=' + Object.keys(obj[0] || {}).slice(0, 12).join(',') : ''));
          } else if (obj && typeof obj === 'object') {
            console.log('[LCU-LCD] <<', 'GET', urlPath, 'status=200 objectKeys=' + Object.keys(obj).slice(0, 12).join(',') + (obj.allPlayers ? ' allPlayersLen=' + (Array.isArray(obj.allPlayers) ? obj.allPlayers.length : '?') : ''));
          } else {
            console.log('[LCU-LCD] <<', 'GET', urlPath, 'status=200 type=' + typeof obj);
          }
          resolve(obj);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', () => { reject(new Error('对局数据接口不可用(未在游戏中)')); });
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('对局数据请求超时')); });
  });
}

// 修复 LCU 窗口大小 (Win32 SetWindowPos, 异步不阻塞)
async function fixLCUWindow() {
  const script = [
    'Add-Type -TypeDefinition "using System;using System.Runtime.InteropServices;public class Win32Fix{[DllImport(\\"user32.dll\\")]public static extern IntPtr FindWindow(string cls,string title);[DllImport(\\"user32.dll\\")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);}"',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$h=[Win32Fix]::FindWindow("RiotWindowClass",$null)',
    'if($h -ne [IntPtr]::Zero){$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen;$x=[int](($vs.Width-1280)/2);$y=[int](($vs.Height-720)/2);[Win32Fix]::SetWindowPos($h,[IntPtr]::Zero,$x,$y,1280,720,0x0040)|Out-Null;Write-Output "OK"}else{Write-Output "NOT_FOUND"}'
  ].join('; ');
  const out = await execCmd(`powershell -NoProfile -Command "${script}"`, 12000);
  return out.includes('OK');
}

module.exports = { getLCU, lcuRequest, liveRequest, fixLCUWindow, reset, getCached, getGameConfigDir };
