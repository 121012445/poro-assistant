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

用法 (注意 env -u, 理由见下面 PORT 上方的环境自检):
  env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS PORO_UDD=D:/poro_probe_udd \
    node _debug_archive/probe_renderer.js > out.txt 2>&1
    探源码版 (用 node_modules 里的 electron 直接跑项目目录)

  机器上已经开着 Poro 时必须给 PORO_UDD —— 否则 requestSingleInstanceLock()
  会把这次探测重定向到那个实例, 探针只能看到 [SINGLE INSTANCE] duplicate launch。

  PORO_EXE=dist/win-unpacked/Poro.exe PORO_CWD=dist/win-unpacked PORO_ARG= \
    node _debug_archive/probe_renderer.js
    探打包产物 —— 同一套探测跑在安装包解出来的 exe 上, 用来确认"新代码确实进了包, 且包里的东西也能正常加载"

结果同时落一份到 _debug_archive/probe_result.txt, 所以重定向丢了也能拿到结论。
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

// 环境自检 —— 这两条是踩出来的, 症状是"探针静默退出、连一个字输出都没有",
// 极难倒查, 所以宁可在入口就拦下来:
//   1) ELECTRON_RUN_AS_NODE=1 (WorkBuddy 的 bash 工具会注入) 会让 electron.exe
//      退化成纯 Node 模式: require('electron') 返回一个路径字符串、app 是 undefined,
//      窗口根本不会出现, 于是探针一直连不上调试端口。
//   2) NODE_OPTIONS 被注入了语言垫片, 同样会干扰子进程启动。
// 正确跑法见文件头注释里的命令行 (env -u ...)。
if (process.env.ELECTRON_RUN_AS_NODE) {
  console.error('环境不对: ELECTRON_RUN_AS_NODE=' + process.env.ELECTRON_RUN_AS_NODE
    + ' —— 被测 electron.exe 会退化成 Node 模式, 窗口起不来。');
  console.error('正确跑法: env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS node '
    + path.relative(ROOT, __filename));
  process.exit(2);
}

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
  // 2026-09-27: 首页模板从 loadHomeStats 抽成了 buildHomeTemplate(v)。
  // 光验 typeof 不够 —— 它是纯函数, 直接喂一组最小数据看产出,
  // 才能真正证明"搬移之后模板还能拼出完整首页"。
  ['home.js', 'buildHomeTemplate 存在', "typeof buildHomeTemplate"],
  ['home.js', 'buildHomeTemplate 产出完整首页 HTML',
   "(function () { try { var h = buildHomeTemplate({" +
   "s: { gameName: 'Probe', profileIconId: 1, summonerLevel: 30, puuid: 'p1' }," +
   "server: 'X', includePractice: false, n: 10, rawGameCount: 10, wins: 5, wr: 50," +
   "isSelf: true, mmrChips: [], ranked: null, rankFromCache: false, rankPending: false," +
   "qm: {}, totDur: 3600, totK: 1, totD: 2, totA: 3, avgKda: 2, maxK: 5, maxD: 5," +
   "penta: 0, fb: 1, games: [], champCount: {}, champMeta: {}, friendCount: {}," +
   "tagCache: {}, rankRows: [], modeStats: {}" +
   "}); return ['home-layout', 'home-header', 'home-stats', 'home-games'," +
   " 'home-mode-filter', 'Probe'].every(function (c) { return h.indexOf(c) >= 0; });" +
   " } catch (e) { return 'throw: ' + e.message; } })()",
   'bool'],
  // 2026-09-27: 挑亮点/分类从 deriveHomeFunStats 抽成了三个具名纯函数。
  // 为什么值得在真机探针里再验一遍（test_home_fun_stats.js 已经测过阈值）:
  //   1) 单测是 require 进来的模块实例, 探针验的是**页面里那份脚本**真的加载成功、
  //      三个函数真的挂到了全局 —— 少一个模块、加载顺序错了, 单测照样全绿。
  //   2) 阈值用"恰好等于门槛"的输入钉住, 改错一个 >= 立刻红。
  ['home.js', 'pickFunHighlights 存在', "typeof pickFunHighlights"],
  ['home.js', 'classifyHeroPool 存在', "typeof classifyHeroPool"],
  ['home.js', 'classifyCombatStyle 存在', "typeof classifyCombatStyle"],
  ['home.js', 'pickFunHighlights 只统计 >=2 场 + championCount 回填 + 空数据返回 null',
   "(function () { try {"
   + " var h = pickFunHighlights({"
   + "   periods: [{ key: 'evening', games: 3, wins: 2 }],"
   + "   champions: new Map([['1', { id: 1, games: 3, wins: 3 }], ['2', { id: 2, games: 1, wins: 0 }]]),"
   + "   favoriteItems: new Map(), itemTriples: new Map(),"
   + "   roleStats: new Map([['Mage', { tag: 'Mage', games: 2, wins: 2, k: 10, d: 2, a: 12, champions: new Set([1, 3]) }]]),"
   + "   partners: new Map(), nemeses: new Map() });"
   + " if (h.luckyChampion.id !== 1) return '幸运英雄应只统计 >=2 场的: ' + JSON.stringify(h.luckyChampion);"
   + " if (h.favoriteRole.championCount !== 2) return 'championCount 未按 champions.size 回填: ' + h.favoriteRole.championCount;"
   + " if (h.favoriteItem !== null || h.favoriteTriple !== null || h.goldenPartner !== null || h.nemesis !== null)"
   + "   return '空数据应返回 null 而不是 undefined';"
   + " return true;"
   + " } catch (e) { return 'throw: ' + e.message; } })()",
   'bool'],
  ['home.js', 'classifyCombatStyle 阈值与优先级（含临界值）',
   "(function () { try {"
   + " var p = function (o) { return Object.assign({ averageKda: 2, averageKills: 5, averageDeaths: 5, averageUtility: 0 }, o || {}); };"
   + " var s = function (o, pa, d, t) { return classifyCombatStyle(p(o), pa, d, t).label; };"
   + " var cases = ["
   + "   [s({ averageUtility: 3500 }, 60, 10000, 10000), '团队辅助型'],"
   + "   [s({ averageUtility: 3500 }, 59, 10000, 10000), '稳健输出型'],"
   + "   [s({ averageUtility: 3499 }, 60, 10000, 10000), '稳健输出型'],"
   + "   [s({}, 0, 9000, 12000), '前排抗压型'],"
   + "   [s({}, 0, 9000, 11999), '均衡适应型'],"
   + "   [s({}, 0, 10000, 12500), '前排抗压型'],"
   + "   [s({}, 0, 10000, 12000), '稳健输出型'],"
   + "   [s({ averageKills: 8 }, 0, 10000, 10000), '激进收割型'],"
   + "   [s({ averageDeaths: 8, averageKills: 3 }, 0, 15000, 10000), '激进收割型'],"
   + "   [s({ averageDeaths: 8, averageKills: 3 }, 0, 14999, 10000), '均衡适应型'],"
   + "   [s({ averageDeaths: 6 }, 0, 20000, 10000), '均衡适应型']"
   + " ];"
   + " for (var i = 0; i < cases.length; i++) if (cases[i][0] !== cases[i][1])"
   + "   return '第 ' + (i + 1) + ' 条期望 ' + cases[i][1] + ', 实际 ' + cases[i][0];"
   + " var d = classifyCombatStyle(p({ averageDeaths: 6 }), 0, 20000, 10000).detail;"
   + " if (d.indexOf('参团 --') < 0) return '参团率 0 应显示占位符 --, 实际: ' + d;"
   + " return true;"
   + " } catch (e) { return 'throw: ' + e.message; } })()",
   'bool'],
  ['home.js', 'classifyHeroPool 阈值与优先级（含临界值）',
   "(function () { try {"
   + " var pool = function (n, size, a, b) {"
   + "   var m = new Map(); for (var i = 0; i < size; i++) m.set('c' + i, {});"
   + "   return classifyHeroPool(new Array(n), m, a, b).label; };"
   + " var cases = ["
   + "   [pool(5, 2, 0.45, 1), '绝活专精'],"
   + "   [pool(5, 2, 0.44, 0.75), '精简英雄池'],"
   + "   [pool(4, 2, 0.5, 1), '均衡英雄池'],"
   + "   [pool(8, 6, 0.25, 0.625), '全能选手'],"
   + "   [pool(8, 5, 0.25, 0.625), '均衡英雄池'],"
   + "   [pool(5, 3, 0.4, 1), '精简英雄池'],"
   + "   [pool(5, 3, 0.4, 0.74), '均衡英雄池'],"
   + "   [pool(9, 6, 0.22, 0.667), '均衡英雄池'],"
   + "   [pool(8, 7, 0.5, 0.9), '绝活专精']"
   + " ];"
   + " for (var i = 0; i < cases.length; i++) if (cases[i][0] !== cases[i][1])"
   + "   return '第 ' + (i + 1) + ' 条期望 ' + cases[i][1] + ', 实际 ' + cases[i][0];"
   + " return true;"
   + " } catch (e) { return 'throw: ' + e.message; } })()",
   'bool'],
  ['review.js', 'buildPoroRating', "typeof buildPoroRating"],
  ['theme.js', 'applyTheme', "typeof applyTheme"],
  ['hex.js', 'collectHexAugments', "typeof collectHexAugments"],
  // 2026-09-27: 浮窗展示行的构造从 scanCurrentAugmentOffers 抽成了 buildAugmentOverlayRows()。
  // 同样不能只验 typeof —— 它是纯函数, 直接喂一组最小数据, 验的是**业务规则**:
  // 胜率要透传、样本 1000 应判为"收益可靠"、gain 要相对基准胜率算出来。
  // 这三条正是抽出去那段里最容易在搬移时写错的地方。
  ['hex.js', 'buildAugmentOverlayRows 存在', "typeof buildAugmentOverlayRows"],
  ['hex.js', 'buildAugmentOverlayRows 产出带收益判定的 rows',
   "(function () { try {"
   + " var r = buildAugmentOverlayRows("
   + "   [{ slot: 0, id: 2095, name: 'X', icon: 'i', score: 0.9 }],"
   + "   { all: [{ id: 2095, name: 'X', icon: 'i', winRate: 0.52, publicGames: 1000 }],"
   + "     selectedIds: [], itemIds: [], winStats: { baseline: 0.5 }, stage: 1 });"
   + " if (!Array.isArray(r) || r.length !== 1) return 'rows 不是长度 1 的数组: ' + JSON.stringify(r);"
   + " var row = r[0];"
   + " if (row.winRate !== 0.52) return 'winRate 未透传: ' + row.winRate;"
   + " if (row.gainReliable !== true) return '样本 1000 应判为收益可靠, 实际: ' + row.gainReliable;"
   + " if (Math.abs(row.gain - 0.02) > 1e-9) return 'gain 未按基准胜率算: ' + row.gain;"
   + " if (typeof row.recommendationScore !== 'number') return '缺 recommendationScore';"
   + " return true;"
   + " } catch (e) { return 'throw: ' + e.message; } })()",
   'bool'],
  ['history.js', 'ensureChampMap', "typeof ensureChampMap"],
  ['live.js', 'sgpProfileFor', "typeof sgpProfileFor"],
  ['live.js', 'TIMER_DEFS (const)', "typeof TIMER_DEFS"],
  // 2026-09-27: 取数与组装从 renderLiveFromGameflow 抽成了 fetchLivePlayers / buildLivePlayers。
  // fetchLivePlayers 只验存在 —— 它是 async 且真的会去问主进程要 live data,
  // 探针的 Runtime.evaluate 没有开 awaitPromise, 硬调拿不到结果 (注释在此, 免得下次困惑)。
  // buildLivePlayers 是同步的, 所以**真的调用它**, 而且两条数据路径都走一遍,
  // 验的是从 test_live_layout.js 里继承下来的那几条业务规则 —— 那个测试只是字符串
  // grep (`live.includes('index < 5 ? 100 : 200')`), 搬移后照样绿, 抓不到行为回归。
  ['live.js', 'fetchLivePlayers 存在', "typeof fetchLivePlayers"],
  ['live.js', 'buildLivePlayers 存在', "typeof buildLivePlayers"],
  ['live.js', 'buildLivePlayers 两路数据 + 队伍/英雄ID 归一化',
   "(function () { try {"
   // 路径1: 只有 session 数据 (选人/加载阶段)。ChampSelect 下不走加载页兜底, 阵容原样。
   + " var a = buildLivePlayers(null, ["
   + "   { puuid: 'p1', championId: 81, team: 'ORDER', summonerName: 'A' },"
   + "   { puuid: 'p2', championId: 60099, team: 'CHAOS', summonerName: 'B' }"
   + " ], 'ChampSelect');"
   + " if (!Array.isArray(a) || a.length !== 2) return 'session 路径应产出 2 人: ' + JSON.stringify(a);"
   + " if (a[0].team !== 100) return \"team 'ORDER' 应归一化为 100, 实际 \" + a[0].team;"
   + " if (a[1].team !== 200) return \"team 'CHAOS' 应归一化为 200, 实际 \" + a[1].team;"
   + " if (a[1].championId !== 99) return '国服 60099 应归一化为 99, 实际 ' + a[1].championId;"
   + " if (a[0].name !== 'A') return 'summonerName 未透传: ' + a[0].name;"
   // 路径2: 有 Live Client Data。验 items 抽取 (对象/数字两种形态) 与 isBot。
   + " var b = buildLivePlayers([{ championId: 81, team: 100, riotIdGameName: 'C',"
   + "   items: [{ itemID: 1001 }, 1002, null], isBot: false }], [], 'InProgress');"
   + " if (!Array.isArray(b) || b.length !== 1) return 'live 路径应产出 1 人: ' + JSON.stringify(b);"
   + " if (b[0].name !== 'C') return 'riotIdGameName 未透传: ' + b[0].name;"
   + " if (b[0].items.join(',') !== '1001,1002') return 'items 未抽取: ' + JSON.stringify(b[0].items);"
   // 两路都空 -> undefined 是原实现的既有行为, 别顺手改成 []
   + " if (buildLivePlayers(null, [], 'InProgress') !== undefined) return '两路都空时应返回 undefined';"
   + " return true;"
   + " } catch (e) { return 'throw: ' + e.message; } })()",
   'bool'],
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
  // 机器上已经有 Poro 在跑时, 必须隔离 userData —— 否则 requestSingleInstanceLock()
  // 会把这次探测重定向到那个实例, 探针只能看到 [SINGLE INSTANCE] duplicate launch,
  // 拿不到真正的渲染层。设 PORO_UDD 即可 (如 PORO_UDD=D:/poro_probe_udd)。
  const UDD = process.env.PORO_UDD;
  if (UDD) args.push(`--user-data-dir=${UDD}`);
  if (APP_ARG) args.push(APP_ARG);
  const child = spawn(EXE, args, { cwd: CWD, stdio: ['ignore', 'ignore', 'ignore'] });

  // requireAdministrator 的 exe 在非提权会话里 spawn 会直接 EACCES
  // (Win32 740 ERROR_ELEVATION_REQUIRED, Node 侧 errno=-4092): 进程**从未被创建**,
  // 所以不产生任何日志, 也连不上调试端口 —— 现象和"探针坏了"一模一样。
  // 不接住它就是一个 unhandled 'error' 事件的堆栈, 更像探针坏了。
  // 实测: 正式版(dist/win-unpacked/Poro.exe, requireAdministrator) 必失败,
  //       受限版(dist-limited/..., asInvoker) 正常 —— 这是预期, 不是缺陷。
  child.on('error', err => {
    if (err.code === 'EACCES') {
      console.error('起不来: ' + EXE);
      console.error('  EACCES / errno=' + err.errno + ' —— 这是 Windows 740 ERROR_ELEVATION_REQUIRED。');
      console.error('  该 exe 的 manifest 是 requireAdministrator(正式版), 非提权会话创建不了它。');
      console.error('  要在管理员终端里跑, 或者改探受限版:');
      console.error('    PORO_EXE=dist-limited/win-unpacked/Poro.exe \\');
      console.error('      PORO_CWD=dist-limited/win-unpacked PORO_ARG= node ' + path.relative(ROOT, __filename));
    } else {
      console.error('起不来: ' + EXE + ' -> ' + err.code + ' ' + err.message);
    }
    process.exit(1);
  });

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

  // 脚本文件存在性 —— 这里原先是一条写死的 `document.scripts.length === 18`。
  // 两个问题都踩过了, 记下来:
  //   1) 写死的数字会烂: 模块一路变多, 18 没跟着改, 这条断言常年红着。
  //      "永远红的断言"等于没有断言 —— 真出事时也分不出是新问题还是这个老数字。
  //   2) 改成"拿 index.html 当基准比对页面清单"是**自证**: 页面的脚本清单本来
  //      就来自 index.html, 两边永远相等, 断言恒真。已用"注入一个假脚本标签"的
  //      负向验证实测确认过它拦不住任何东西。
  // 所以换成这个方向: 页面报告的每个 src 回磁盘查存在性。
  // 为什么值得单独查 —— <script src> 指向不存在的文件时浏览器只发一个 404,
  // 既不抛异常, 资源加载错误也不会冒泡到 window 的 error 事件 (上面那个计数器
  // 用的是默认冒泡监听, 抓不到), 所以它是**完全静默**的: 少一个模块, 页面照样
  // 渲染, 功能悄悄没了。这类"静默缺失"正是探针存在的理由。
  // 打包产物里源文件在 app.asar 内, 磁盘上查不到 —— 此时明确跳过, 不误报。
  {
    const rendererDir = path.join(CWD, 'renderer');
    const r = await evaluate(
      "JSON.stringify(Array.prototype.map.call(document.scripts, function (s) {"
      + " return s.getAttribute('src') || ''; }).filter(Boolean))"
    );
    let srcs = null;
    try {
      srcs = JSON.parse((r.result && r.result.result && r.result.result.value) || 'null');
    } catch (e) { /* 拿不到清单 */ }

    if (!require('fs').existsSync(rendererDir)) {
      rows.push(['--  ', 'DOM', '脚本文件在磁盘上存在 (打包产物, 跳过)',
        `无源目录 ${rendererDir}`]);
    } else if (!Array.isArray(srcs)) {
      bad++;
      rows.push(['!!  ', 'DOM', '脚本文件在磁盘上存在', '拿不到页面脚本清单']);
    } else {
      const missing = srcs
        .map(s => s.split('?')[0])
        .filter(rel => !require('fs').existsSync(path.join(rendererDir, rel)));
      const ok = missing.length === 0;
      if (!ok) bad++;
      rows.push([ok ? 'OK  ' : '!!  ', 'DOM',
        `脚本文件在磁盘上存在 (共 ${srcs.length} 个)`,
        ok ? 'true' : '找不到: ' + missing.join(', ')]);
    }
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

  // 非 TTY(输出重定向到文件/管道)时, 本会话里 stdout 经常整个拿不到内容 ——
  // 所以顺手把结果也落一份盘, 保证任何场景都能拿到结论。
  try {
    require('fs').writeFileSync(path.join(__dirname, 'probe_result.txt'),
      rows.map(([flag, mod, label, val]) => `${flag} ${mod.padEnd(14)} ${label} -> ${val}`).join('\n')
      + `\n\n异常项: ${bad}\n加载期报错: ${JSON.stringify(errList)}\n`);
  } catch (e) { }

  ws.close();
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(800);
  // 不要用 process.exit(): 它会在 stdout 排空前就结束进程 ——
  // 实测把输出重定向到文件/管道时(非 TTY), 上面所有 console.log 会**全部消失**,
  // 只剩一个退出码, 看起来像"探针根本没跑"。改成写一个换行等排空 + 设 exitCode 自然退出。
  await new Promise(r => process.stdout.write('\n', r));
  process.exitCode = bad ? 1 : 0;
})();
