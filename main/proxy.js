'use strict';
// 代理解析：给外网 HTTPS 请求（更新器查 GitHub / 下载包）提供统一的代理配置。
//
// 背景：Node 的 https.get 不读系统代理，国内直连 api.github.com 会超时，
// 导致「检查更新」永远失败。这里按优先级解析出代理 URL：
//   1) 环境变量 HTTPS_PROXY / https_proxy / ALL_PROXY（用户显式配置，最高优先）
//   2) Windows 系统代理（HKCU Internet Settings 的 ProxyEnable + ProxyServer）
//
// NO_PROXY 必须遵守——尤其 "*"（本机的 v9.9 引擎就因 NO_PROXY="*" 绕过代理导致
// fapi.binance.com 超时）。这里对 github 目标也照此处理：设了 NO_PROXY=* 就不走代理。
//
// 纯函数 split，Windows 注册表读取单独封装并可注入，便于 node 里断言。

const DEFAULT_NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '::1'];

// 解析 Windows 代理字符串：可能是 "127.0.0.1:7897" 或 "http=127.0.0.1:7897;https=127.0.0.1:7897"
function parseProxyServer(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.indexOf('=') >= 0) {
    // 形如 http=h;https=h2;ftp=f —— 优先取 https，其次 http
    const parts = {};
    for (const kv of s.split(';')) {
      const i = kv.indexOf('=');
      if (i > 0) parts[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
    }
    return parts.https || parts.http || '';
  }
  return s;
}

// 判断 host 是否命中 no_proxy 列表。支持 "*"、前导 "." 后缀、精确 host、 host:port。
function stripPort(s) {
  const i = String(s).lastIndexOf(':');
  // 仅当冒号后是纯数字且不是 IPv6（IPv6 有多个冒号）时去掉端口
  return (i > 0 && String(s).indexOf(':') === i && /^\d+$/.test(String(s).slice(i + 1)))
    ? String(s).slice(0, i) : String(s);
}
function hostInNoProxy(host, noProxy) {
  const list = String(noProxy || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  const h = stripPort(String(host || '').toLowerCase());
  for (const entry of list) {
    if (entry === '*') return true;
    const e = stripPort(entry);
    if (e.startsWith('.')) { if (h.endsWith(e) || h === e.slice(1)) return true; }
    else if (e === h || h.endsWith('.' + e)) return true;
  }
  return false;
}

// 把裸 host:port 补成带协议的 URL（https-proxy-agent 需要）
function normalizeProxyUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  try { const u = new URL(s); return (u.protocol === 'http:' || u.protocol === 'https:') ? u.toString() : ''; }
  catch (e) { return ''; }
}

// 统一入口。env: 环境变量对象；sysProxy: {enable, server}（Windows 注册表读取结果）；
// targetHost: 目标主机名。返回代理 URL 或 ''（直连）。
function resolve(env, sysProxy, targetHost) {
  const e = env || {};
  const httpsProxy = e.HTTPS_PROXY || e.https_proxy || e.ALL_PROXY || e.all_proxy || '';
  const noProxy = e.NO_PROXY || e.no_proxy || '';
  if (hostInNoProxy(targetHost, noProxy)) return ''; // NO_PROXY 最优先，含 "*"
  const fromEnv = normalizeProxyUrl(httpsProxy);
  if (fromEnv) return fromEnv;
  if (sysProxy && (sysProxy.enable === true || sysProxy.enable === 1 || sysProxy.enable === '1')) {
    return normalizeProxyUrl(parseProxyServer(sysProxy.server));
  }
  return '';
}

// 读取 Windows 系统代理。用 reg.exe（系统自带，无需依赖）；失败返回 {enable:0,server:''}。
function readWindowsProxy(execFileSync, log) {
  try {
    const reg = typeof execFileSync === 'function' ? execFileSync
      : require('child_process').execFileSync;
    const q = key => String(reg('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', key], { encoding: 'utf8' }));
    const enableTxt = q('ProxyEnable');
    const serverTxt = q('ProxyServer');
    const mEnable = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(enableTxt);
    const mServer = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(serverTxt);
    return { enable: mEnable ? parseInt(mEnable[1], 16) : 0, server: mServer ? mServer[1].trim() : '' };
  } catch (e) {
    if (log) { try { log('[PROXY] read windows proxy failed: ' + (e && e.message)); } catch (_) {} }
    return { enable: 0, server: '' };
  }
}

const api = { resolve, hostInNoProxy, parseProxyServer, normalizeProxyUrl, readWindowsProxy, DEFAULT_NO_PROXY_HOSTS };
try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
if (typeof window !== 'undefined') window.PoroProxyUtil = api;
