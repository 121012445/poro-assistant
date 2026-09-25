/*
真机冒烟: 启动 Electron 后通过远程调试端口 (CDP) 直接向真实渲染层提问。

为什么不能只看 crash.log:
  拆分后的模块是独立的 <script>, 就算某个模块整体加载失败, app.js 依然会加载、
  首页依然会渲染并写出 [RENDERER] [PERF] home 行 —— 日志看起来"正常", 功能却是坏的。
  必须真的进渲染层求值, 确认那些全局绑定确实存在。

做法:
  1. 启动 Electron 并连上 CDP
  2. 注入一个 window.onerror 计数器, 然后 reload —— 这样能抓到"加载期抛异常"
     (光连上去是抓不到已经发生过的错误的)
  3. 逐项求值, 确认每个模块的代表性绑定都在
  4. 杀掉整棵进程树

用法:
  node _debug_archive/probe_renderer.js
    探源码版 (用 node_modules 里的 electron 直接跑项目目录)

  PORO_EXE=dist/win-unpacked/Poro.exe PORO_CWD=dist/win-unpacked PORO_ARG= \
    node _debug_archive/probe_renderer.js
    探打包产物 —— 同一套探测跑在安装包解出来的 exe 上, 用来确认"新代码确实进了包, 且包里的东西也能正常加载"
*/
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.env.PORO_EXE
  ? path.resolve(ROOT, process.env.PORO_EXE)
  : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const CWD = process.env.PORO_CWD ? path.resolve(ROOT, process.env.PORO_CWD) : ROOT;
// 源码版要把项目目录当参数传给 electron; 打包产物自带 app, 传空串即可
const APP_ARG = process.env.PORO_ARG === undefined ? '.' : process.env.PORO_ARG;
const PORT = 9222;

// 每个模块至少一项"拆分后最容易丢"的代表性绑定。
// 函数声明挂在 window 上; 顶层 let/const 在全局词法环境里 (不在 window 上), 所以统一用 typeof。
//
// 第 4 项是可选的判定模式, 缺省 truthy:
//   truthy - 必须是"有意义的值" (排除 undefined / false / 0 / -1)
//   bool   - 必须严格 === true
//   count  - 必须是 >= 0 的整数; -1 表示"计数器没注入", 0 是合法结果
//   exact  - 必须 === 第 5 项给定的值
// 踩过的坑: 早期版本一律按 truthy 判定, 于是"加载期报错数 = 0"被误报成失败,
// 而 0 恰恰是我们要的结果; 只有 -1 (计数器未注入) 才是失败。
const PROBES = [
  ['utils.js', 'escapeHtml', "typeof escapeHtml"],
  ['utils.js', 'mapWithConcurrency', "typeof mapWithConcurrency"],
  ['app.js', 'modeName (核心工具)', "typeof modeName"],
  ['app.js', 'init', "typeof init"],
  ['app.js', 'allChampions (核心 let)', "typeof allChampions"],
  ['app.js', 'QUEUE_NAMES (核心 const)', "typeof QUEUE_NAMES"],
  ['bench.js', 'benchAlertWatch', "typeof benchAlertWatch"],
  ['bench.js', 'benchRenderSwapButtons', "typeof benchRenderSwapButtons"],
  ['bench.js', '_benchSubsetState (let)', "typeof _benchSubsetState"],
  ['bench.js', 'BENCH_SWAP_RETRY_MS (const)', "typeof BENCH_SWAP_RETRY_MS"],
  ['champions.js', 'opggOf', "typeof opggOf"],
  ['champions.js', 'opggPosList (let)', "typeof opggPosList"],
  ['home.js', 'rankTierCN', "typeof rankTierCN"],
  ['home.js', 'TIER_CN (const)', "typeof TIER_CN"],
  ['review.js', 'buildPoroRating', "typeof buildPoroRating"],
  ['theme.js', 'applyTheme', "typeof applyTheme"],
  ['hex.js', 'collectHexAugments', "typeof collectHexAugments"],
  ['history.js', 'ensureChampMap', "typeof ensureChampMap"],
  ['live.js', 'sgpProfileFor', "typeof sgpProfileFor"],
  ['live.js', 'TIMER_DEFS (const)', "typeof TIMER_DEFS"],
  ['compliance.js', 'applyComplianceState', "typeof applyComplianceState"],
  ['compliance.js', 'complianceOn (let)', "typeof complianceOn"],
  // 这里曾经被误判成"拆分把顺序搞坏了"。事实是: populateBgChampionList 是函数,
  // _bgChampEntries 是它的产物而不是顶层语句; 而 init() 里静态数据 (ddragon) 是
  // 异步加载且没被 await, 所以调用时 allChampions 还是空对象, 产物自然是空数组 ——
  // 拆分前 (app.js 第 3178 行) 就是这个行为, 属于原有设计而非回归。
  // 因此这里只验"函数在 + 调用不抛异常 + 产物是数组", 不要求非空。
  ['compliance.js', 'populateBgChampionList', "typeof populateBgChampionList"],
  ['compliance.js', '_bgChampEntries 是数组 (可为空)',
   "(function () { try { populateBgChampionList(); return Array.isArray(window._bgChampEntries); } catch (e) { return 'throw: ' + e.message; } })()",
   'bool'],
  ['blacklist.js', 'addToBlacklist', "typeof addToBlacklist"],
  ['social.js', 'spectateFriendInfo', "typeof spectateFriendInfo"],
  ['social.js', 'addEncounter', "typeof addEncounter"],
  ['chat.js', 'sendGameChat', "typeof sendGameChat"],
  ['autobp.js', 'toggleAutoBP', "typeof toggleAutoBP"],
  ['lcu-events.js', 'handleGameflowPhase', "typeof handleGameflowPhase"],
  ['settings.js', 'getGsCameraMode', "typeof getGsCameraMode"],
  ['persist.js', 'loadStore', "typeof loadStore"],
  ['DOM', '#benchDiag 元素', "!!document.getElementById('benchDiag')"],
  ['DOM', '页面就绪状态', "document.readyState"],
  ['DOM', '脚本数量 (应为 18)', "document.scripts.length", 'exact', 18],
  ['加载', '页面重载后的 JS 报错数 (0 才算通过)',
   "window.__probeErrors === undefined ? -1 : window.__probeErrors", 'count']
];

const getJson = url => new Promise((resolve, reject) => {
  http.get(url, res => {
    let d = '';
    res.on('data', c => (d += c));
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const args = [
    `--remote-debugging-port=${PORT}`,
    '--disable-gpu', '--disable-software-rasterizer', '--no-sandbox'
  ];
  if (APP_ARG) args.push(APP_ARG);
  const child = spawn(EXE, args, { cwd: CWD, stdio: ['ignore', 'ignore', 'ignore'] });

  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) break;
    } catch (e) { /* 还没起来 */ }
  }
  if (!page) {
    console.error('拿不到调试目标 —— 窗口可能根本没起来');
    child.kill();
    process.exit(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg.method);
  });
  const send = (method, params) => new Promise(resolve => {
    const myId = ++id;
    pending.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
  });
  const evaluate = expr => send('Runtime.evaluate', { expression: expr, returnByValue: true });

  await new Promise(r => ws.on('open', r));

  // 预热: 刚连上时执行上下文可能还没就绪, 第一次 evaluate 会返回空结果 (实测踩过, 会误报第一条)
  for (let i = 0; i < 10; i++) {
    const w = await evaluate('1 + 1');
    if (w.result && w.result.result && w.result.result.value === 2) break;
    await sleep(300);
  }

  // 注入错误计数器后重载: 只有这样才能抓到"某个模块在加载时抛异常"
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__probeErrors = 0;'
      + 'window.addEventListener("error", function (e) { window.__probeErrors++;'
      + '  (window.__probeErrList = window.__probeErrList || []).push(String(e.message)); });'
  });
  await send('Page.reload', { ignoreCache: true });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const r = await evaluate('document.readyState');
    if (r.result && r.result.result && r.result.result.value === 'complete') break;
  }
  await sleep(1200);

  console.log('已连上渲染层:', page.title || '(无标题)');
  console.log('  被测程序  :', EXE);
  console.log('  工作目录  :', CWD, '\n');

  let bad = 0;
  const rows = [];
  for (const [mod, label, expr, mode, exact] of PROBES) {
    const res = await evaluate(expr);
    const r = res.result && res.result.result;
    const val = r ? r.value : undefined;
    const err = res.result && res.result.exceptionDetails;
    let ok;
    if (err) ok = false;
    else if (mode === 'bool') ok = val === true;
    else if (mode === 'count') ok = typeof val === 'number' && Number.isInteger(val) && val >= 0;
    else if (mode === 'exact') ok = val === exact;
    else ok = val !== undefined && val !== 'undefined' && val !== false && val !== 0 && val !== -1;
    if (!ok) bad++;
    rows.push([ok ? 'OK  ' : '!!  ', mod, label, err ? '求值异常: ' + (err.exception && err.exception.description || '') : String(val)]);
  }

  const w = Math.max(...rows.map(r => r[2].length));
  for (const [flag, mod, label, val] of rows) {
    console.log(`${flag} ${mod.padEnd(14)} ${label.padEnd(w)}  -> ${val}`);
  }

  const errs = await evaluate('JSON.stringify(window.__probeErrList || [])');
  const errList = JSON.parse((errs.result.result || {}).value || '[]');
  if (errList.length) {
    console.log('\n加载期报错明细:');
    for (const e of errList) console.log('   ' + e);
  }

  console.log(bad ? `\n有 ${bad} 项异常 —— 拆分破坏了全局绑定` : '\n全部命中: 拆分后各模块的全局绑定在真实页面里都存在, 且加载期无报错');

  ws.close();
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(800);
  process.exit(bad ? 1 : 0);
})();
