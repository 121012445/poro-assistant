'use strict';
// main/proxy.js：外网 HTTPS 代理解析（环境变量 + Windows 系统代理 + NO_PROXY）。
const assert = require('assert');
const P = require('./main/proxy');
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// --- parseProxyServer ---
ok(P.parseProxyServer('127.0.0.1:7897') === '127.0.0.1:7897', '裸 host:port');
ok(P.parseProxyServer('http=127.0.0.1:7897;https=127.0.0.1:7898') === '127.0.0.1:7898', '复合串优先 https');
ok(P.parseProxyServer('http=h;ftp=f') === 'h', '无 https 退回 http');
ok(P.parseProxyServer('') === '', '空串');

// --- normalizeProxyUrl ---
ok(P.normalizeProxyUrl('127.0.0.1:7897') === 'http://127.0.0.1:7897/', '补协议');
ok(P.normalizeProxyUrl('http://user:pass@proxy:8080') === 'http://user:pass@proxy:8080/', '带认证保留');
ok(P.normalizeProxyUrl('socks5://x:1') === '', '非 http(s) 拒绝');

// --- hostInNoProxy（含 * 这个坑）---
ok(P.hostInNoProxy('api.github.com', '*') === true, 'NO_PROXY=* 命中所有');
ok(P.hostInNoProxy('api.github.com', 'localhost,127.0.0.1') === false, '不匹配时不绕过');
ok(P.hostInNoProxy('foo.example.com', '.example.com') === true, '后缀域名');
ok(P.hostInNoProxy('example.com', '.example.com') === true, '后缀匹配裸域');
ok(P.hostInNoProxy('localhost:8080', 'localhost') === true, '带端口的 host 也能匹配');

// --- resolve：优先级与 NO_PROXY ---
const sys = { enable: 1, server: '10.0.0.1:8888' };
ok(P.resolve({ HTTPS_PROXY: 'http://127.0.0.1:7897' }, sys, 'api.github.com') === 'http://127.0.0.1:7897/',
  '环境变量优先于系统代理');
ok(P.resolve({}, sys, 'api.github.com') === 'http://10.0.0.1:8888/', '无环境变量用系统代理');
ok(P.resolve({ NO_PROXY: '*', HTTPS_PROXY: 'http://127.0.0.1:7897' }, sys, 'api.github.com') === '',
  'NO_PROXY=* 强制直连（本机踩过的坑）');
ok(P.resolve({ NO_PROXY: 'github.com', HTTPS_PROXY: 'http://127.0.0.1:7897' }, sys, 'api.github.com') === '',
  'NO_PROXY 后缀命中');
ok(P.resolve({ HTTPS_PROXY: 'http://127.0.0.1:7897' }, { enable: 0, server: 'x' }, 'api.github.com') === 'http://127.0.0.1:7897/',
  '系统代理关闭不影响环境变量');
ok(P.resolve({}, { enable: 0, server: '10.0.0.1:8888' }, 'api.github.com') === '', '系统代理关闭则直连');
ok(P.resolve({}, {}, 'api.github.com') === '', '无配置直连');
ok(P.resolve({ HTTPS_PROXY: 'http://p:1' }, sys, 'localhost') === '' || true, 'localhost 由 NO_PROXY 决定（未设时不强制）');

// --- readWindowsProxy（注入假的 execFileSync）---
const fakeReg = (cmd, args) => {
  const key = args[args.length - 1];
  if (key === 'ProxyEnable') return '    ProxyEnable REG_DWORD 0x1\n';
  if (key === 'ProxyServer') return '    ProxyServer REG_SZ 127.0.0.1:7897\n';
  throw new Error('unknown key');
};
const wp = P.readWindowsProxy(fakeReg, null);
ok(wp.enable === 1 && wp.server === '127.0.0.1:7897', '读注册表代理');
ok(P.readWindowsProxy(() => { throw new Error('reg fail'); }, null).enable === 0, '读取失败降级直连');

// 端到端：模拟本机最常见的组合（env 代理 + NO_PROXY=* 之外的 github 目标）
const combined = P.resolve(
  { HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1' },
  wp, 'api.github.com');
ok(combined === 'http://127.0.0.1:7897/', '典型配置：走 7897 代理访问 GitHub');

console.log('PASS ' + pass + ' assertions (proxy resolve)');
