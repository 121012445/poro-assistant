'use strict';
/**
 * 端到端验证「界面版本号」: 启动 Electron -> 通过 CDP 远程调试读取真实 DOM。
 * 不改动任何应用代码, 直接问渲染层"你到底显示了什么"。
 *
 * 用法:
 *   node _debug_archive/probe_version_ui.js                                   # 跑源码目录
 *   node _debug_archive/probe_version_ui.js ".\Poro\Poro.exe"               # 跑本地已安装的正式包
 *   node _debug_archive/probe_version_ui.js ".\Poro\resources\app.asar"     # 用 electron 直接加载已安装的 asar
 *
 * 第三种模式是为什么存在: Poro 正在运行时, 部分环境下 spawn Poro.exe 会直接
 * 报 EACCES (应用自己占着镜像)。此时改用 electron.exe 加载**同一份已安装 asar**,
 * 跑到的就是线上 JS 包, 能验证的东西和跑 exe 完全一致。
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

const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const arg = process.argv[2] || null;
// 三种模式: 给 .exe -> 直接跑它; 给 .asar/目录 -> 用 electron 加载它; 不给 -> 跑源码目录
const packagedExe = arg && /\.exe$/i.test(arg) ? arg : null;
const appPath = arg && !packagedExe ? arg : null;
const electron = packagedExe || electronExe;
const modeText = packagedExe ? '已安装正式包' : (appPath ? 'electron 加载 ' + appPath : '源码目录');
if (!fs.existsSync(electron)) { P('找不到可执行文件:', electron); finish(1); }
if (appPath && !fs.existsSync(appPath)) { P('找不到要加载的包:', appPath); finish(1); }

// 关键: 正在运行的 Poro 会和本探针抢同一个单实例锁 (同名 app -> 同 userData),
// 导致探针进程刚启动就被重定向退出。给独立 userData 目录即可并存。
const PROBE_USERDATA = path.join(__dirname, '_probe_userdata');

// 旧日志必须先清掉: crash.log 是追加写, 不清会把上一轮的报错算到这一轮头上。
for (const f of ['crash.log', 'crash.log.old']) {
  try { fs.rmSync(path.join(PROBE_USERDATA, f), { force: true }); } catch (e) {}
}

const COMMON_ARGS = ['--no-sandbox', '--disable-gpu-sandbox', '--in-process-gpu', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROBE_USERDATA];
const spawnArgs = packagedExe ? COMMON_ARGS : [(appPath || '.'), ...COMMON_ARGS];

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
  P('可执行文件:', electron + '  [' + modeText + ']');
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

  // ---- 启动健康: init() 有没有在中途被掐断 ----
  // 主进程把渲染层 error 级 console 写进 userData/crash.log
  // (main/index.js: console-message -> logErr('[CONSOLE ERR] ...'))。
  // 这是最实在的端到端证据: 1.5.0/1.5.1 的 loadAramBalance 就栽在这里 ——
  // 它在 init() 的 try/catch 之外抛 ReferenceError, 界面照画、DOM 一切正常、
  // 版本号也显示对了, 只有 crash.log 里留了一行, 首页却永远不加载。
  await sleep(1200);
  const crashLog = path.join(PROBE_USERDATA, 'crash.log');
  let logText = '';
  try { logText = fs.readFileSync(crashLog, 'utf8'); } catch (e) { logText = ''; }
  const errLines = logText.split('\n').filter(l => l.includes('[CONSOLE ERR]'));
  const fatalLines = errLines.filter(l => /ReferenceError|is not defined|TypeError|SyntaxError|not a function/.test(l));
  P('');
  P('--- 启动健康 (crash.log) ---');
  P('日志文件: ' + crashLog + (logText ? '  (' + logText.length + ' 字节)' : '  (不存在)'));
  if (!errLines.length) P('  [OK]   无 [CONSOLE ERR]');
  else {
    errLines.slice(0, 10).forEach(l => P('  [ERR]  ' + l.trim().slice(0, 180)));
    if (errLines.length > 10) P('  ... 另有 ' + (errLines.length - 10) + ' 条');
  }
  const initHealthy = fatalLines.length === 0;
  P(initHealthy
    ? '  [OK]   未见 ReferenceError / 类型错误 — init() 没有被中途掐断'
    : '  [FAIL] 初始化期间有致命错误, 后面的初始化步骤很可能没执行');

  P('');
  P('=== 判定 ===');
  const txt = await cdpEval(page.webSocketDebuggerUrl, "document.getElementById('versionText') ? document.getElementById('versionText').textContent : ''").catch(() => '');
  let pkgVer;
  const asarTarget = packagedExe
    ? path.join(path.dirname(packagedExe), 'resources', 'app.asar')
    : (appPath && /\.asar$/i.test(appPath) ? appPath : null);
  if (asarTarget) {
    const asarMod = require('D:/lol-assistant/node_modules/@electron/asar');
    P('受检 asar =', asarTarget);
    pkgVer = JSON.parse(asarMod.extractFile(asarTarget, 'package.json').toString('utf8')).version;
    P('期望版本来源 = 已安装 asar 内 package.json');
  } else {
    pkgVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    P('期望版本来源 = 源码 package.json');
  }
  P('期望版本 =', pkgVer);
  P('界面实际显示     =', txt);
  const verOk = typeof txt === 'string' && txt.indexOf('v' + pkgVer) === 0;
  P(verOk ? '通过: 界面版本号与包内 package.json 一致' : '不通过: 界面未显示包内 package.json 的版本号');
  P(initHealthy ? '通过: 初始化无致命错误' : '不通过: 初始化期间有致命错误 (见上方 crash.log)');
  finish(verOk && initHealthy ? 0 : 1);
})();
