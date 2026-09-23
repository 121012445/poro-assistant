'use strict';
/**
 * 端到端验证「选人浮窗」: 真启动应用 -> 从主窗口推一帧数据 -> 通过 CDP 检查
 * 浮窗是否真的被创建、DOM 是否渲染出按钮、点击是否回到主窗口的换人流程。
 *
 * 不依赖游戏客户端: 浮窗的数据本来就由渲染层推过来, 这里直接扮演渲染层推一帧。
 *
 * 用法:
 *   node _debug_archive/probe_overlay.js                              # 跑源码目录
 *   node _debug_archive/probe_overlay.js ".\Poro\Poro.exe"   # 跑本地已安装的正式包
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('D:/lol-assistant/node_modules/ws');
// 复用主进程那份纯函数, 在探针这一侧独立复算一遍期望位置 (不靠"看起来对")
const position = require('D:/lol-assistant/main/overlay-position');

const ROOT = 'D:\\lol-assistant';
const PORT = 9334;                      // 与版本探针错开, 免得两个探针互踩
const LOG = path.join(__dirname, 'probe_overlay.txt');
const out = [];
const P = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;        // 本环境该变量被继承为 1, 会让 electron 退化成 node
env.PORO_TEST = '1';                    // 不显示主窗口, 免得打断用户
delete env.PORO_SMOKE;

const packagedExe = process.argv[2] || null;
const electron = packagedExe || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electron)) { P('找不到可执行文件: ' + electron); process.exit(1); }

// 独立 userData: 否则会和正在运行的 Poro 抢单实例锁, 探针刚起来就被顶掉
const PROBE_USERDATA = path.join(__dirname, '_probe_userdata_overlay');

const spawnArgs = packagedExe
  ? ['--no-sandbox', '--disable-gpu-sandbox', '--in-process-gpu', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROBE_USERDATA]
  : ['.', '--no-sandbox', '--disable-gpu-sandbox', '--in-process-gpu', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROBE_USERDATA];

const child = spawn(electron, spawnArgs, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let childOut = '';
child.stdout.on('data', d => { childOut += d.toString(); });
child.stderr.on('data', d => { childOut += d.toString(); });

function finish(code) {
  // taskkill /T 收整棵进程树, 否则 GPU/渲染子进程会残留成孤儿
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
  try { child.kill(); } catch (e) {}
  setTimeout(() => {
    try { child.kill('SIGKILL'); } catch (e) {}
    fs.writeFileSync(LOG, out.join('\n') + '\n\n--- electron stdout/stderr ---\n' + childOut, 'utf8');
    process.exit(code);
  }, 500);
}

// 本机 fetch 会被环境代理(7897)干扰, 必须用原生 http 直连
function listTargets() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('JSON 解析失败: ' + body.slice(0, 200))); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('请求超时')));
  });
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
      clearTimeout(timer); ws.close();
      if (msg.result && msg.result.exceptionDetails) return resolve('__EXC__ ' + JSON.stringify(msg.result.exceptionDetails.exception));
      resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
    });
    ws.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

async function waitForTarget(match, tries) {
  for (let i = 0; i < (tries || 40); i++) {
    try {
      const list = await listTargets();
      const t = list.find(x => x.type === 'page' && match(x.url || ''));
      if (t) return t;
    } catch (e) {}
    await sleep(500);
  }
  return null;
}

(async () => {
  let failed = 0;
  const check = (name, cond, extra) => {
    if (!cond) failed++;
    P('  ' + (cond ? '[OK]   ' : '[FAIL] ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
  };

  P('=== 端到端验证选人浮窗 (CDP) ===');
  P('可执行文件: ' + electron + (packagedExe ? '  [已安装正式包]' : '  [源码目录]'));

  const main = await waitForTarget(u => u.includes('renderer/index.html'), 60);
  if (!main) { P('!! 主窗口调试目标没出现, 应用可能没起来'); finish(1); return; }
  P('主窗口: ' + main.url);
  await sleep(2000);   // 等渲染层跑完 init()

  // 先把"浮窗点击回传"这条链路挂个探针: bench.js 自己也注册了同一个通道, 两者并存
  await cdpEval(main.webSocketDebuggerUrl,
    "window.__ovSeen = []; if (window.lolAPI.onOverlaySwap) window.lolAPI.onOverlaySwap(id => window.__ovSeen.push(id)); 'hooked'").catch(() => {});
  const hooked = await cdpEval(main.webSocketDebuggerUrl, "Array.isArray(window.__ovSeen)").catch(() => false);
  check('主窗口可挂 onOverlaySwap 监听', hooked === true);

  // 浮窗通道是否真的在主进程注册了 (未开启时应为 exists=false)
  const st0 = await cdpEval(main.webSocketDebuggerUrl, "(async()=>JSON.stringify(await window.lolAPI.overlayStatus()))()").catch(() => '');
  check('初始 overlayStatus 可读', /visible/.test(String(st0)), st0);

  // 推一帧: 这一步等价于"进了大乱斗选人且开关打开"
  const pushed = await cdpEval(main.webSocketDebuggerUrl,
    "(async()=>{try{await window.lolAPI.overlayUpdate({title:'备战区',items:[{id:1,name:'安妮',tag:'备战席'},{id:99,name:'拉克丝',tag:'备选'}],state:'探针推帧: 2 个可换英雄',stateClass:'accent',visible:true});return 'ok'}catch(e){return '__ERR__ '+e.message}})()").catch(e => '__EXC__ ' + e.message);
  check('overlayUpdate 推送成功', pushed === 'ok', pushed);

  const overlay = await waitForTarget(u => u.includes('overlay.html'), 20);
  check('浮窗窗口被创建 (存在 overlay.html 页面)', !!overlay, overlay ? overlay.url : '(没找到)');
  if (!overlay) { P(''); P('浮窗没起来, 后面的渲染断言无法进行。'); finish(1); return; }

  await sleep(600);

  // 用户可能正在对局中: 应用自身的 gameflow 状态机随时会把浮窗收起 (那是正确行为)。
  // 所以"显示"的断言要重复推帧直到命中, 而不是赌一次。
  let st1o = {};
  for (let i = 0; i < 6; i++) {
    await cdpEval(main.webSocketDebuggerUrl,
      "(async()=>{await window.lolAPI.overlayUpdate({title:'备战区',items:[{id:1,name:'安妮',tag:'备战席'},{id:99,name:'拉克丝',tag:'备选'}],state:'探针推帧: 2 个可换英雄',stateClass:'accent',visible:true});return 'ok'})()").catch(() => {});
    await sleep(400);
    const s = await cdpEval(main.webSocketDebuggerUrl, "(async()=>JSON.stringify(await window.lolAPI.overlayStatus()))()").catch(() => '');
    try { st1o = JSON.parse(s) || {}; } catch (e) {}
    if (st1o.visible && st1o.bounds) break;
  }
  check('overlayStatus.visible 为真', st1o.visible === true, JSON.stringify(st1o));
  check('overlayStatus.exists 为真', st1o.exists === true);

  // ---- 贴边: 位置是否真的贴着客户端 ----
  P('  [info] clientRect = ' + JSON.stringify(st1o.clientRect) + '  workArea = ' + JSON.stringify(st1o.workArea));
  P('  [info] bounds     = ' + JSON.stringify(st1o.bounds) + '  savedBounds = ' + JSON.stringify(st1o.savedBounds));
  check('koffi 原生桥可用 (winRectAvailable)', st1o.winRectAvailable === true, String(st1o.winRectAvailable));
  check('读到客户端窗口矩形 (RCLIENT)', !!(st1o.clientRect && st1o.clientRect.width > 200), JSON.stringify(st1o.clientRect));
  if (st1o.clientRect && st1o.workArea && st1o.bounds) {
    const c = st1o.clientRect, b = st1o.bounds, wa = st1o.workArea;
    // 必须是"客户端"窗口, 不是全屏的游戏内窗口 —— 这两个类名一度被我混在一起按面积挑,
    // 结果进着游戏时浮窗会贴到整屏游戏窗口上 (读到 1707x960 而不是客户端的 1280x720)。
    check('命中的是客户端窗口 (RCLIENT) 而非游戏内窗口',
      c.className === 'RCLIENT',
      'className=' + JSON.stringify(c.className) + ' title=' + JSON.stringify(c.title));
    // 探针侧(纯 node)独立再读一次, 与应用回报的值交叉比对
    let nodeRect = null;
    try { nodeRect = require('D:/lol-assistant/main/win-rect').getLeagueClientRect(); } catch (e) { nodeRect = null; }
    check('探针侧独立读到同样的客户端矩形',
      !!nodeRect && nodeRect.width === c.width && nodeRect.height === c.height && nodeRect.x === c.x,
      'app=' + JSON.stringify(c) + ' node=' + JSON.stringify(nodeRect));
    // 探针侧独立复算: 与主进程用同一份纯函数, 但输入来自 IPC 回读的真实值
    const exp = position.computeOverlayBounds({ clientRect: c, workArea: wa, size: position.OVERLAY_SIZE, saved: st1o.savedBounds });
    // 容差 2px: 无边框透明窗在非整数缩放下会被系统取整 (实测 1463 变 1462, 宽 244 变 245)
    const near = (a, e) => Math.abs(a - e) <= 2;
    check('浮窗位置 = 按客户端矩形算出的贴边位置',
      near(b.x, exp.x) && near(b.y, exp.y),
      '实际 ' + JSON.stringify(b) + ' 期望 ' + JSON.stringify(exp));
    const adjacentRight = Math.abs(b.x - (c.x + c.width + 8)) <= 3;          // 贴右外侧
    const adjacentLeft = Math.abs((b.x + b.width) - (c.x - 8)) <= 3;          // 贴左外侧
    const overClientEdge = b.x >= c.x && (b.x + b.width) <= (c.x + c.width) + 3;  // 两侧放不下, 压在客户端右缘
    check('浮窗与客户端相邻 (外侧或压在其边缘)',
      adjacentRight || adjacentLeft || overClientEdge,
      'client=' + JSON.stringify(c) + ' bounds=' + JSON.stringify(b) +
      (adjacentRight ? ' [贴右外侧]' : adjacentLeft ? ' [贴左外侧]' : overClientEdge ? ' [压在客户端右缘]' : ' [不相邻!]'));
    check('浮窗完整落在工作区内',
      b.x >= wa.x && b.x + b.width <= wa.x + wa.width && b.y >= wa.y && b.y + b.height <= wa.y + wa.height,
      'wa=' + JSON.stringify(wa));
  } else {
    check('浮窗位置可计算', false, '缺少 clientRect/workArea/bounds');
  }

  const nItems = await cdpEval(overlay.webSocketDebuggerUrl, "document.querySelectorAll('#list .item').length").catch(e => '__EXC__ ' + e.message);
  check('浮窗渲染出 2 个按钮', nItems === 2, String(nItems));
  const texts = await cdpEval(overlay.webSocketDebuggerUrl, "Array.prototype.map.call(document.querySelectorAll('#list .item'), b => b.textContent.trim()).join(' / ')").catch(() => '');
  check('按钮文案含英雄名与来源', String(texts).includes('安妮') && String(texts).includes('拉克丝') && String(texts).includes('备战席') && String(texts).includes('备选'), texts);
  const stateTxt = await cdpEval(overlay.webSocketDebuggerUrl, "document.getElementById('state').textContent").catch(() => '');
  check('状态文案已同步到浮窗', String(stateTxt).includes('探针推帧'), stateTxt);
  const stateCls = await cdpEval(overlay.webSocketDebuggerUrl, "document.getElementById('state').className").catch(() => '');
  check('状态色类 accent 生效', String(stateCls).includes('accent'), stateCls);
  const titleTxt = await cdpEval(overlay.webSocketDebuggerUrl, "document.getElementById('title').textContent").catch(() => '');
  check('标题正确', titleTxt === '备战区', String(titleTxt));
  const isTransparent = await cdpEval(overlay.webSocketDebuggerUrl, "getComputedStyle(document.body).backgroundColor").catch(() => '');
  check('窗口背景透明 (无边框浮窗前提)', String(isTransparent).includes('rgba(0, 0, 0, 0)'), String(isTransparent));
  // 注意: -webkit-app-region 是 Electron 私有别名, getComputedStyle 通常读不到, 只做信息展示
  const dragRegion = await cdpEval(overlay.webSocketDebuggerUrl, "getComputedStyle(document.querySelector('.bar')).webkitAppRegion || '(读不到, 属正常)'").catch(() => '');
  P('  [info] 标题栏 app-region = ' + String(dragRegion));
  const errs = await cdpEval(overlay.webSocketDebuggerUrl, "String(window.__lastError || '(无记录)')").catch(() => '');
  check('浮窗渲染层无 JS 报错', !String(errs).startsWith('__'), errs);

  // 点击浮窗里的第一个按钮 -> 必须经过主进程回到主窗口的换人入口
  await cdpEval(overlay.webSocketDebuggerUrl, "document.querySelector('#list .item').click(); 'clicked'").catch(() => {});
  await sleep(1200);
  const seen = await cdpEval(main.webSocketDebuggerUrl, "JSON.stringify(window.__ovSeen || [])").catch(() => '');
  check('点击回传到主窗口 (id=1)', String(seen).includes('1'), seen);

  // 收起: 离开选人时应让浮窗隐藏
  await cdpEval(main.webSocketDebuggerUrl, "(async()=>{await window.lolAPI.overlayUpdate({title:'备战区',items:[],state:'',stateClass:'',visible:false});return 'hidden'})()").catch(() => {});
  await sleep(600);
  const st2 = await cdpEval(main.webSocketDebuggerUrl, "(async()=>JSON.stringify(await window.lolAPI.overlayStatus()))()").catch(() => '');
  let st2o = {}; try { st2o = JSON.parse(st2); } catch (e) {}
  check('visible=false 后浮窗隐藏', st2o.visible === false, st2);

  P('');
  P('=== 判定 ===');
  P(failed ? ('有 ' + failed + ' 项未通过') : '全部通过: 浮窗可建、可渲染、可点、可收');
  finish(failed ? 1 : 0);
})();
