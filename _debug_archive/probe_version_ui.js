'use strict';
/**
 * 端到端验证「界面版本号」: 启动 Electron -> 通过 CDP 远程调试读取真实 DOM。
 * 不改动任何应用代码, 直接问渲染层"你到底显示了什么"。
 *
 * 用法:
 *   node _debug_archive/probe_version_ui.js                              # 跑源码目录
 *   node _debug_archive/probe_version_ui.js ".\Poro\Poro.exe"   # 跑本地已安装的正式包
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('D:/lol-assistant/node_modules/ws');

const ROOT = 'D:\\lol-assistant';
const PORT = 9333;
const LOG = path.join(__dirname, 'probe_version_ui.txt');
const out = [];
const P = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;   // 本环境该变量被继承为 1, 会让 electron 退化成 node
env.PORO_TEST = '1';               // 不显示窗口
delete env.PORO_SMOKE;             // 不要自动退出, 我们要读 DOM

const packagedExe = process.argv[2] || null;
const electron = packagedExe || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electron)) { P('找不到可执行文件:', electron); finish(1); }

// 关键: 正在运行的 Poro 会和本探针抢同一个单实例锁 (同名 app -> 同 userData),
// 导致探针进程刚启动就被重定向退出。给独立 userData 目录即可并存。
const PROBE_USERDATA = path.join(__dirname, '_probe_userdata');

const spawnArgs = packagedExe
  ? ['--no-sandbox', '--disable-gpu-sandbox', '--in-process-gpu', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROBE_USERDATA]
  : ['.', '--no-sandbox', '--disable-gpu-sandbox', '--in-process-gpu', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROBE_USERDATA];

const child = spawn(electron, spawnArgs, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });

let childOut = '';
child.stdout.on('data', d => { childOut += d.toString(); });
child.stderr.on('data', d => { childOut += d.toString(); });

function finish(code) {
  // 用 taskkill /T 整棵进程树一起收, 否则 GPU/渲染子进程会残留成孤儿
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
  try { child.kill(); } catch (e) {}
  setTimeout(() => {
    try { child.kill('SIGKILL'); } catch (e) {}
    fs.writeFileSync(LOG, out.join('\n') + '\n\n--- electron stdout/stderr ---\n' + childOut, 'utf8');
    process.exit(code);
  }, 500);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const http = require('http');

// 注意: 本机 Node 的 fetch 会被环境里的代理设置干扰(用户有 7897 代理), 必须用原生 http 直连
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON 解析失败, 原始响应前 300 字: ' + body.slice(0, 300))); }
      });
    });
    req.on('error', e => reject(e));
    req.setTimeout(4000, () => { req.destroy(new Error('请求超时')); });
  });
}

async function getPageTarget() {
  let lastErr = '';
  for (let i = 0; i < 40; i++) {
    try {
      const list = await httpGetJson('http://127.0.0.1:' + PORT + '/json/list');
      const desc = list.map(t => t.type + ':' + (t.url || '').slice(0, 70)).join(' | ');
      if (i % 5 === 0) P('  [轮询 ' + i + '] targets=' + desc);
      const page = list.find(t => t.type === 'page');
      if (page) return page;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(500);
  }
  P('!! /json/list 始终没有 page 目标。最后一次错误: ' + lastErr);
  return null;
}

function cdpEval(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.terminate(); } catch (e) {} reject(new Error('CDP 超时')); }, 15000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    ws.on('message', data => {
      let msg; try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.result && msg.result.exceptionDetails) return resolve('__EXC__ ' + JSON.stringify(msg.result.exceptionDetails.exception));
      resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
    });
    ws.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

(async () => {
  P('=== 端到端读取界面版本号 (CDP 远程调试) ===');
  P('可执行文件:', electron + (packagedExe ? '  [已安装正式包]' : '  [源码目录]'));
  P('启动中, 等待渲染层就绪...');

  const page = await getPageTarget();
  if (!page) { P('!! 拿不到调试目标, 可执行文件可能没起来'); finish(1); return; }
  P('页面:', page.url);
  P('title:', page.title);

  // 版本号来自 IPC, 给渲染层一点时间跑完 init()
  await sleep(1500);

  const exprs = {
    '界面版本号 (#versionText)': "document.getElementById('versionText') ? document.getElementById('versionText').textContent : '(元素不存在)'",
    '版本号 tooltip (title)': "document.getElementById('versionText') ? (document.getElementById('versionText').title || '(空)') : 'n/a'",
    'window.__appVersion': "String(window.__appVersion)",
    'IPC 直读 lolAPI.getAppVersion()': "(async()=>{try{return String(await window.lolAPI.getAppVersion())}catch(e){return '__ERR__ '+e.message}})()",
    '渲染层 JS 是否报错': "String(window.__lastError || '(无记录)')"
  };

  P('');
  for (const [label, expr] of Object.entries(exprs)) {
    try {
      const v = await cdpEval(page.webSocketDebuggerUrl, expr);
      P('  ' + label + ' = ' + JSON.stringify(v));
    } catch (e) {
      P('  ' + label + ' = 读取失败: ' + e.message);
    }
  }

  P('');
  P('=== 判定 ===');
  const txt = await cdpEval(page.webSocketDebuggerUrl, "document.getElementById('versionText') ? document.getElementById('versionText').textContent : ''").catch(() => '');
  let pkgVer;
  if (packagedExe) {
    const asarMod = require('D:/lol-assistant/node_modules/@electron/asar');
    const depAsar = path.join(path.dirname(packagedExe), 'resources', 'app.asar');
    P('受检 asar =', depAsar);
    pkgVer = JSON.parse(asarMod.extractFile(depAsar, 'package.json').toString('utf8')).version;
    P('期望版本来源 = 已安装 asar 内 package.json');
  } else {
    pkgVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    P('期望版本来源 = 源码 package.json');
  }
  P('期望版本 =', pkgVer);
  P('界面实际显示     =', txt);
  const ok = typeof txt === 'string' && txt.indexOf('v' + pkgVer) === 0;
  P(ok ? '通过: 界面版本号与包内 package.json 一致' : '不通过: 界面未显示包内 package.json 的版本号');
  finish(ok ? 0 : 1);
})();
