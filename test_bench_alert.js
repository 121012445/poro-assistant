'use strict';
// 备战区抢英雄倒计时 (大乱斗/海斗) 逻辑测试
//
// 被测对象是渲染层的本地差分检测 + 倒计时展示, 不需要真实 DOM 与 Electron 环境,
// 因此用最小 DOM 桩把 renderer 脚本加载进 vm 上下文后直接驱动。
//
// 注意: app.js 里的 let/const 声明不会成为 vm 上下文对象的属性,
// 读写这些绑定必须用 vm.runInContext, 否则拿到的是 undefined。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = __dirname;
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

// ---- 可控时钟: 让 3 秒冷却可以在测试里瞬间走完 ----
let NOW = 1000000;
const RealDate = Date;
const FakeDate = function (...args) { return new RealDate(...args); };
FakeDate.now = () => NOW;
FakeDate.parse = RealDate.parse;
FakeDate.UTC = RealDate.UTC;
FakeDate.prototype = RealDate.prototype;

// ---- 最小 DOM 桩 ----
const elements = {};
const elStub = () => ({ innerHTML: '', className: '', textContent: '', style: {}, checked: false, disabled: false, value: '' });
const getEl = id => (elements[id] || (elements[id] = elStub()));

// ---- 可编程的 LCU 桩: 记录调用, 并可控制每次返回成功还是失败 ----
let lcuCalls = [];
let lcuResponder = () => ({});
const resetLcu = responder => { lcuCalls = []; lcuResponder = responder || (() => ({})); };
// 浮窗通道: 记录主窗口推给浮窗的每一帧, 用于断言"推出去的内容正确 / 该显示时才显示"
let overlayCalls = [];

const sandbox = {
  console: { log() {}, error() {}, warn() {} },
  Date: FakeDate,
  JSON, Math, Promise, Object, Array, String, Number, Boolean, Set, Map, RegExp, Error,
  setTimeout, clearTimeout, setInterval, clearInterval,
  document: {
    getElementById: getEl,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => elStub(),
    body: elStub()
  },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  lolAPI: {
    lcuRequest: (method, path, body) => {
      lcuCalls.push({ method, path, body });
      return Promise.resolve(lcuResponder(method, path, body));
    },
    // 浮窗数据推送 (主窗口 -> 主进程 -> 浮窗); 测试里只记录, 不真的开窗
    overlayUpdate: (payload) => { overlayCalls.push(payload); return Promise.resolve(true); }
  },
  navigator: { userAgent: 'node' }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
// 渲染层是多文件: 严格按 index.html 里的 <script src> 顺序加载, 让测试的加载顺序
// 与真实页面完全一致 —— index.html 里漏写某个模块或顺序放错, 这里就会直接炸。
const scriptSrcs = [...read('renderer/index.html').matchAll(/<script src="([^"]+)"/g)]
  .map(m => m[1].split('?')[0]);
for (const src of scriptSrcs) {
  vm.runInContext(read('renderer/' + src), sandbox, { filename: src });
}

// let/const 绑定读写器
const binding = expr => vm.runInContext(expr, sandbox);

const alertEl = () => getEl('benchAlert');
const isShown = () => alertEl().className.includes('show');
const alertHtml = () => alertEl().innerHTML;
const benchSession = (...championIds) => ({ benchChampions: championIds.map(championId => ({ championId })) });

// 模拟 ddragon 已加载 (必须从上下文内部赋值)
binding("champNumMap = { '1': { id: 'Annie', name: '安妮' }, '7': { id: 'LeBlanc', name: '乐芙兰' }, '99': { id: 'Lux', name: '拉克丝' } };");

// 换英雄的失败返回形态与主进程一致: { __error: 'HTTP 4xx', httpStatus: 4xx }
const httpFail = code => ({ __error: 'HTTP ' + code, httpStatus: code });
// 冲刷微任务 (async 重试里的 await 需要让出一次事件循环才能落地)
const flush = () => new Promise(r => setTimeout(r, 0));
// 真实短等待: 重试间隔走的是真实 setTimeout(250ms), 需要真等才能验证自动重试确实接上了
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 1. 默认关闭 ----
assert.strictEqual(binding('benchAlertOn'), false, '备战区倒计时应默认关闭 (带风险提示的功能默认不自动启用)');
sandbox.benchAlertWatch(benchSession(1));
assert.ok(!isShown(), '关闭状态下不得弹浮层');

// ---- 2. 开启后首次快照只建基线 ----
sandbox.toggleBenchAlert(true);
assert.strictEqual(binding('benchAlertOn'), true, '开启后开关状态应为 true');
assert.strictEqual(getEl('benchAlertState').textContent, '已开启', '开关文案应变为已开启');
sandbox.benchAlertWatch(benchSession(1, 7));
assert.ok(!isShown(), '首次快照只建基线: 进房间时已在备战区的英雄早已过冷却, 不得报警');

// ---- 3. 新增英雄才起倒计时 ----
sandbox.benchAlertWatch(benchSession(1, 7, 99));
assert.ok(isShown(), '备战区新增英雄后应弹浮层');
assert.ok(alertHtml().includes('拉克丝'), '应提示新增的英雄名');
assert.ok(!alertHtml().includes('安妮'), '不应提示原有的备战区英雄');
assert.match(alertHtml(), /3\.0s/, '应显示 3.0s 倒计时');
assert.ok(!alertEl().className.includes('ready'), '未归零时不应是 ready 态');
assert.strictEqual(getEl('benchAlertState').textContent, '监听中', '检测到备战区字段后状态应显示监听中');

// ---- 4. 同一英雄重复上报不重复报警 ----
const stableHtml = alertHtml();
sandbox.benchAlertWatch(benchSession(1, 7, 99));
assert.strictEqual(alertHtml(), stableHtml, '备战区集合无变化时不应重复报警');

// ---- 5. 归零后提示可抢 ----
NOW += 3000;
sandbox._benchAlertRender();
assert.ok(alertHtml().includes('现在可抢'), '归零后应提示现在可抢');
assert.ok(alertEl().className.includes('ready'), '归零后应切换为 ready 态');
assert.doesNotMatch(alertHtml(), /\d\.\ds/, '归零后不应再显示秒数');

// ---- 6. 保留期结束后自动隐藏 (由真实计时器驱动) ----
NOW += 9000;
setTimeout(async () => {
  assert.ok(!isShown(), '超过保留期后浮层应自动收起');
  assert.strictEqual(binding('_benchTick'), null, 'tick 定时器应被清理, 不能泄漏');

  // ---- 7. 非大乱斗模式不响应 ----
  sandbox.benchAlertWatch({ myTeam: [] });
  assert.ok(!isShown(), '无备战区字段时不应弹浮层');
  assert.strictEqual(getEl('benchAlertState').textContent, '当前模式无备战区', '非大乱斗模式应明确提示无备战区, 而不是静默无反应');
  assert.strictEqual(binding('_benchKnownIds'), null, '离开大乱斗后应清空基线以便下次重建');

  // ---- 8. 重新进入大乱斗: 又是首次快照 ----
  sandbox.benchAlertWatch(benchSession(99));
  assert.ok(!isShown(), '重建基线时不得误报');

  // ---- 9. 离开选人清空 ----
  sandbox.benchAlertWatch(benchSession(99, 7));
  assert.ok(isShown(), '新增英雄应触发倒计时');
  assert.ok(alertHtml().includes('乐芙兰'), '应提示新增的乐芙兰');
  sandbox._benchAlertReset();
  assert.ok(!isShown(), '重置后浮层应收起');
  assert.strictEqual(binding('_benchKnownIds'), null, '重置后基线应清空');

  // ---- 10. 关闭开关时清空 ----
  sandbox.benchAlertWatch(benchSession(1));
  sandbox.benchAlertWatch(benchSession(1, 7));
  assert.ok(isShown(), '关闭前应处于显示状态');
  sandbox.toggleBenchAlert(false);
  assert.ok(!isShown(), '关闭开关后浮层应收起');
  assert.strictEqual(getEl('benchAlertState').textContent, '已关闭', '关闭后文案应为已关闭');

  // ---- 11. 同屏条目上限, 避免刷屏 ----
  sandbox.toggleBenchAlert(true);
  sandbox._benchAlertReset();
  sandbox.benchAlertWatch(benchSession());
  const pool = [1, 7, 99, 5, 6];
  for (let i = 0; i < pool.length; i++) {
    binding(`champNumMap['${pool[i]}'] = { id: 'X${pool[i]}', name: '英雄${pool[i]}' };`);
    sandbox.benchAlertWatch(benchSession(...pool.slice(0, i + 1)));
  }
  const shown = (alertHtml().match(/<b>/g) || []).length;
  assert.ok(shown <= 3, `同屏条目应不超过 3 个, 实际 ${shown}`);

  // ---- 12. 英雄名转义 ----
  sandbox._benchAlertReset();
  binding("champNumMap['88'] = { id: 'Evil', name: '<img src=x onerror=alert(1)>' };");
  sandbox.benchAlertWatch(benchSession());
  sandbox.benchAlertWatch(benchSession(88));
  assert.ok(alertHtml().includes('&lt;img'), '英雄名必须转义后再拼 HTML');
  assert.ok(!alertHtml().includes('<img'), '不得把英雄名原样注入 innerHTML');

  // ---- 13. 合规模式语义: 纯本地提示, 不产生任何客户端写入 ----
  // 源码切片也要跨全部渲染层脚本, 否则代码拆到 bench.js 之后这里会切不到东西而"假装通过"
  const source = scriptSrcs.map(src => read('renderer/' + src)).join('\n');
  const watchBody = source.slice(source.indexOf('function benchAlertWatch'), source.indexOf('// ---- 一键换英雄'));
  assert.doesNotMatch(watchBody, /lcuRequest|writeFile|send\(/, '备战区倒计时不得调用任何客户端写入接口');
  // 反过来: 换英雄是唯一的写入点, 必须被 guardWrite 门禁挡住, 否则合规模式形同虚设
  const swapBody = source.slice(source.indexOf('function benchSwapNow'), source.indexOf('async function _benchSwapAttempt'));
  assert.match(swapBody, /guardWrite\(/, '换英雄入口必须先过合规门禁');
  assert.ok(swapBody.indexOf('guardWrite(') < swapBody.indexOf('_benchSwapCancel('),
    '门禁必须排在真正发起请求之前');

  // ================= 一键换英雄: 立即发起 + 被拒重试 =================
  // 第 11 组为了测上限覆盖过 champNumMap, 这里恢复, 否则断言英雄名会失真
  binding("champNumMap = { '1': { id: 'Annie', name: '安妮' }, '7': { id: 'LeBlanc', name: '乐芙兰' }, '99': { id: 'Lux', name: '拉克丝' } };");

  // ---- 14. 服务器接受时: 一次 POST 成功, 不留重试定时器 ----
  resetLcu(() => ({}));
  getEl('benchSwapState').textContent = '';
  sandbox.benchSwapNow(1);
  await flush();
  assert.strictEqual(lcuCalls.length, 1, '点击后应立即发出 1 次换英雄请求, 不能先等冷却再发');
  assert.strictEqual(lcuCalls[0].method, 'POST', '换英雄必须是 POST');
  assert.strictEqual(lcuCalls[0].path, '/lol-champ-select/v1/session/bench/swap/1', '换英雄路径应与 LCU 接口一致');
  assert.match(getEl('benchSwapState').textContent, /第 1 次即成功/, '首次即成功时应明说未遇到冷却, 这是判断冷却是否存在的直接依据');
  assert.ok(!/等待/.test(getEl('benchSwapState').textContent), '首次即成功时不应出现等待字样');
  assert.strictEqual(binding('_benchSwapTimer'), null, '成功后不得残留重试定时器');
  assert.strictEqual(binding('_benchSwapTask'), null, '成功后任务应结束');

  // ---- 15. 服务器因冷却拒绝时: 持续重试直到成功 ----
  let attempts = 0;
  resetLcu(() => (++attempts === 1 ? httpFail(409) : {}));
  sandbox.benchSwapNow(7);
  await flush();
  assert.strictEqual(lcuCalls.length, 1, '被拒前只应发出 1 次请求');
  assert.match(getEl('benchSwapState').textContent, /等待服务器允许/, '被拒后状态应说明在等服务器放行, 而不是直接报失败');
  assert.match(getEl('benchSwapState').textContent, /HTTP 409/, '状态里应带上拒绝原因, 便于真机排查');
  assert.match(getEl('benchSwapState').textContent, /已重试 1 次/, '应显示已重试次数');
  assert.ok(binding('_benchSwapTimer') !== null, '被拒后必须安排下一次重试');
  await sleep(400);   // 重试间隔 250ms, 留足余量
  assert.strictEqual(lcuCalls.length, 2, '应在 250ms 后自动重试, 无需用户再点一次');
  assert.match(getEl('benchSwapState').textContent, /等待 \d+\.\ds 后成功，共 2 次请求/, '第二次成功时应说明等待时长与总请求数');
  assert.match(getEl('benchSwapState').textContent, /乐芙兰/, '成功文案里应带英雄名');
  assert.strictEqual(binding('_benchSwapTimer'), null, '成功收尾时不得残留定时器');

  // ---- 16. 一直失败: 到上限放弃, 不无限打接口 ----
  resetLcu(() => httpFail(409));
  sandbox.benchSwapNow(99);
  await flush();
  assert.strictEqual(lcuCalls.length, 1, '首次请求应已发出');
  // 把截止时间推到过去以触发放弃分支 (否则要真等 15 秒)
  binding('_benchSwapTask.until = Date.now() - 1');
  await sandbox._benchSwapAttempt();
  assert.match(getEl('benchSwapState').textContent, /换英雄失败/, '超过上限应明确报失败');
  assert.match(getEl('benchSwapState').textContent, /已重试 2 次后放弃/, '应说明重试次数后放弃');
  assert.strictEqual(binding('_benchSwapTask'), null, '放弃后任务应清空');
  assert.strictEqual(binding('_benchSwapTimer'), null, '放弃后不得再安排重试');

  // ---- 17. 合规模式: 只读, 点击不产生任何请求 ----
  resetLcu(() => ({}));
  getEl('benchSwapState').textContent = '哨兵';
  getEl('globalToast').textContent = '';
  binding('complianceOn = true');
  sandbox.benchSwapNow(1);
  await flush();
  assert.strictEqual(lcuCalls.length, 0, '合规模式下换英雄必须一次请求都不发');
  assert.strictEqual(getEl('benchSwapState').textContent, '哨兵', '合规模式下不应改动任何状态文案');
  assert.match(getEl('globalToast').textContent, /合规模式/, '合规模式拦截时应给出明确提示, 不能静默失效');
  assert.strictEqual(binding('_benchSwapTask'), null, '合规模式拦截后不应留下任务');
  binding('complianceOn = false');

  // ---- 18. 按钮行: 按备战区渲染, 集合不变不重绘, 英雄名转义 ----
  resetLcu(() => ({}));
  binding("_benchSwapBtnsKey = ''");
  sandbox.benchRenderSwapButtons(benchSession(1, 7));
  const btnHtml = getEl('benchSwapBtns').innerHTML;
  assert.match(btnHtml, /benchSwapNow\(1\)/, '应为备战区每个英雄渲染换英雄按钮');
  assert.match(btnHtml, /安妮/, '按钮文案应带英雄名');
  assert.match(btnHtml, /乐芙兰/, '第二个英雄也应渲染');
  assert.ok(!btnHtml.includes('benchSwapNow(99)'), '不应渲染不在备战区里的英雄');
  sandbox.benchRenderSwapButtons(benchSession(1, 7));
  assert.strictEqual(getEl('benchSwapBtns').innerHTML, btnHtml, '集合未变化时不应重绘 (选人事件很密集)');
  sandbox.benchRenderSwapButtons(benchSession(7));
  assert.ok(!getEl('benchSwapBtns').innerHTML.includes('benchSwapNow(1)'), '英雄离开备战区后按钮应消失');
  binding("champNumMap['88'] = { id: 'Evil', name: '<img src=x onerror=alert(1)>' };");
  binding("_benchSwapBtnsKey = ''");
  sandbox.benchRenderSwapButtons(benchSession(88));
  assert.ok(getEl('benchSwapBtns').innerHTML.includes('&lt;img'), '按钮里的英雄名必须转义');
  assert.ok(!getEl('benchSwapBtns').innerHTML.includes('<img'), '不得把英雄名原样注入按钮 HTML');

  // ---- 19. 换英雄路径必须落在主进程白名单内 (否则请求会被静默拒绝) ----
  const idxSrc = read('main/index.js');
  const prefixStart = idxSrc.indexOf('const LCU_PREFIXES');
  const prefixList = idxSrc.slice(prefixStart, idxSrc.indexOf('];', prefixStart));
  assert.ok(prefixList.includes("'/lol-champ-select'"), '换英雄路径前缀必须在 LCU 白名单内');

  // ---- 20. 离开选人: 停止重试并复位按钮行 ----
  resetLcu(() => httpFail(409));
  sandbox.benchRenderSwapButtons(benchSession(1, 7));   // 先让按钮行处于"有英雄"状态
  sandbox.benchSwapNow(1);
  await flush();
  assert.ok(binding('_benchSwapTimer') !== null, '前置条件: 此时应正在重试中');
  sandbox._benchAlertReset();
  assert.strictEqual(binding('_benchSwapTimer'), null, '离开选人必须清掉重试定时器, 不能选人结束后还在打接口');
  assert.strictEqual(binding('_benchSwapTask'), null, '离开选人必须清掉任务');
  assert.match(getEl('benchSwapBtns').innerHTML, /当前没有可换的英雄/, '离开选人后按钮行应复位');
  assert.strictEqual(getEl('benchSwapState').textContent, '', '离开选人后状态行应清空');

  // ---- 21. 首次出手永不等待; 被拒后才把重试排到保护期结束 ----
  // 真实机制 (官方 14.13 公告 + 国服客户端实测): 那 3 秒只保护「用骰子重随进备战席」的那一个英雄,
  // 其余备战席英雄服务器允许立即选择。本地只能看到"备战区多了一个英雄", 分不清来源,
  // 所以首次出手必须立刻发、由服务器答复说了算 —— 否则本来能瞬换的英雄会被本地白白拖 3 秒。
  resetLcu(() => httpFail(409));
  binding("champNumMap['5'] = { id: 'Olaf', name: '奥拉夫' };");
  sandbox._benchAlertReset();
  sandbox.toggleBenchAlert(false);            // 关掉提醒, 验证冷却记账不受开关影响
  sandbox.benchAlertWatch(benchSession());    // 建基线
  sandbox.benchAlertWatch(benchSession(5));   // 英雄 5 刚进备战区, 本地记 3s
  assert.strictEqual(lcuCalls.length, 0, '仅记账不得产生任何请求');
  assert.strictEqual(binding('_benchItems').length, 1, '关闭提醒时也应记账 (换英雄要用它挑重试时机)');

  sandbox.benchSwapNow(5);
  await flush();
  assert.strictEqual(lcuCalls.length, 1, '首次出手必须立刻发: "备战席新增"推不出"有冷却", 不能本地干等 3 秒');
  assert.strictEqual(lcuCalls[0].path, '/lol-champ-select/v1/session/bench/swap/5', '已有英雄时走 bench/swap');
  const t21 = binding('_benchSwapTask');
  assert.ok(t21 && t21.waitedLocally === true, '被拒之后才进入"等本地记录的保护期"状态');
  const delay21 = t21.scheduledFor - NOW;
  assert.ok(delay21 >= 2400 && delay21 <= 3200, `重试应排在保护期结束附近, 实际 ${delay21}ms (盲试是 250ms)`);
  assert.match(getEl('benchSwapState').textContent, /等待服务器允许/, '应说明在等服务器放行而不是已出手');
  assert.match(getEl('benchSwapState').textContent, /后自动再试/, '应告诉用户会自动再试, 不需要盯着');

  resetLcu(() => ({}));
  NOW += 3100;                                // 保护期走完, 服务器放行
  await sandbox._benchSwapAttempt();
  assert.strictEqual(lcuCalls.length, 1, `保护期结束后只应出手 1 次, 实际 ${lcuCalls.length} 次 (盲试会是十几次)`);
  assert.match(getEl('benchSwapState').textContent, /共 2 次请求/, '应如实报告总请求次数');
  assert.match(getEl('benchSwapState').textContent, /奥拉夫/, '成功文案里应带英雄名');
  assert.strictEqual(binding('_benchSwapTimer'), null, '成功后应清掉排期定时器');

  // ---- 21b. 空响应 (204 / 200 空体) 是成功, 不是失败 ----
  // 主进程 rawRequest 把这两种情况都 resolve 成 null。曾经这里写成 `if (r && !r.__error)`,
  // 于是换人明明成功了却报"服务器拒绝", 还白重试 15 秒。
  resetLcu(() => null);
  sandbox._benchAlertReset();
  sandbox.benchSwapNow(1);
  await flush();
  assert.match(getEl('benchSwapState').textContent, /已换到 安妮/, 'null 必须判为成功');
  assert.match(getEl('benchSwapState').textContent, /第 1 次即成功/, '空响应成功时应如实说没遇到冷却');
  assert.ok(!/失败/.test(getEl('benchSwapState').textContent), '空响应不得被报成失败');
  assert.strictEqual(binding('_benchSwapTask'), null, '成功后任务应结束, 不得继续重试');
  assert.strictEqual(binding('_benchSwapTimer'), null, '成功后不得残留重试定时器');

  // ---- 21c. 抽卡/选用阶段且自己还没有英雄时走 PATCH actions (对齐 Akari), 而不是 bench/swap ----
  // 没有英雄就没有东西可"交换", 这时候服务器允许的是"选择"。曾经只会发 bench/swap, 必然被拒。
  resetLcu(() => ({}));
  sandbox._benchAlertReset();
  sandbox.benchRenderSwapButtons({
    localPlayerCellId: 2,
    myTeam: [{ cellId: 2, championId: 0 }],
    benchChampions: [{ championId: 1 }],
    actions: [[{ id: 77, actorCellId: 2, type: 'pick', completed: false }]],
    allowSubsetChampionPicks: true,
    timer: { phase: 'BAN_PICK' }
  });
  sandbox.benchSwapNow(1);
  await flush();
  assert.strictEqual(lcuCalls.length, 1, '应只发出 1 次请求');
  assert.strictEqual(lcuCalls[0].method, 'PATCH', '自己还没有英雄时只能"选择", 不是"交换"');
  assert.strictEqual(lcuCalls[0].path, '/lol-champ-select/v1/session/actions/77', '应打自己那条未完成的 pick action');
  // 逐字段比对: 跨 vm 上下文的对象原型不同, deepStrictEqual 会假失败
  const pickBody = lcuCalls[0].body || {};
  assert.strictEqual(pickBody.championId, 1, '选择请求应带 championId');
  assert.strictEqual(pickBody.type, 'pick', '选择请求 type 应为 pick');
  assert.strictEqual(pickBody.completed, true, '选择请求应 completed=true (确实锁定该英雄)');
  assert.match(getEl('benchSwapState').textContent, /已换到 安妮/, '应报告成功');

  resetLcu(() => ({}));
  sandbox.benchRenderSwapButtons({
    localPlayerCellId: 2,
    myTeam: [{ cellId: 2, championId: 5 }],
    benchChampions: [{ championId: 1 }],
    actions: [[{ id: 78, actorCellId: 2, type: 'pick', completed: false }]],
    timer: { phase: 'BAN_PICK' }
  });
  sandbox.benchSwapNow(1);
  await flush();
  assert.strictEqual(lcuCalls[0].method, 'POST', '已经有英雄时必须回到 bench/swap');
  assert.strictEqual(lcuCalls[0].path, '/lol-champ-select/v1/session/bench/swap/1', '路径应为 bench/swap');

  // ---- 22. 冷却已过: 立刻出手 ----
  resetLcu(() => ({}));
  sandbox.benchSwapNow(5);                     // 英雄 5 的 readyAt 已在过去
  assert.strictEqual(lcuCalls.length, 1, '冷却已过应立刻出手, 不再排期');
  await flush();
  assert.match(getEl('benchSwapState').textContent, /第 1 次即成功，未遇到冷却/, '冷却已过时应如实说未遇到冷却');
  assert.strictEqual(binding('_benchSwapTask'), null);

  // ================= 抽卡池 (ARAM 类模式的 subset) =================
  // 抽卡池里的英雄开局就固定, 不是"刚被重随进备战席"的, 因此从来没有 3 秒冷却。
  // 把它们一并列出来, 才是用户感受到的"点一下就换到, 不用等"。

  // ---- 23. 主动拉取抽卡池与服务器可选列表 (WS 事件只在变化时推, 进选人时列表可能早已就位) ----
  resetLcu((method, path) => {
    if (path === '/lol-lobby-team-builder/champ-select/v1/subset-champion-list') return [5, 6, 7];
    if (path === '/lol-champ-select/v1/pickable-champion-ids') return [1, 5, 7, 99];
    return {};
  });
  binding('_benchListsTries = 0');
  await sandbox.benchFetchLists();
  const fetched = lcuCalls.map(c => c.method + ' ' + c.path);
  assert.ok(fetched.includes('GET /lol-lobby-team-builder/champ-select/v1/subset-champion-list'), '应主动拉取抽卡池');
  assert.ok(fetched.includes('GET /lol-champ-select/v1/pickable-champion-ids'), '应主动拉取服务器可选列表');
  assert.strictEqual(JSON.stringify(binding('_benchSubsetIds')), '[5,6,7]', '抽卡池应写入本地');
  assert.strictEqual(JSON.stringify(binding('_benchPickableIds')), '[1,5,7,99]', '可选列表应写入本地');
  const afterFetch = lcuCalls.length;
  await sandbox.benchFetchLists();
  assert.strictEqual(lcuCalls.length, afterFetch, '权威列表到手后不应再重复拉取, 交给 WS 事件增量更新');

  // ---- 23b. 客户端还没就绪 (404) 时会重试, 就绪后拿到数据 ----
  resetLcu(() => httpFail(404));
  binding('_benchListsTries = 0');
  binding('_benchSubsetTries = 0');
  binding("_benchSubsetState = 'idle'");
  binding("_benchPickableState = 'idle'");
  binding('_benchPickableIds = null');
  binding('_benchSubsetIds = []');
  await sandbox.benchFetchLists();
  assert.strictEqual(binding('_benchPickableIds'), null, '拿不到时不应写入假数据');
  assert.ok(binding('_benchListsTries') > 0 && binding('_benchListsTries') < 5, '应保留重试余量');
  resetLcu((method, path) => (path === '/lol-champ-select/v1/pickable-champion-ids' ? [3, 4] : {}));
  await sandbox.benchFetchLists();
  assert.strictEqual(JSON.stringify(binding('_benchPickableIds')), '[3,4]', '客户端就绪后重试应能拿到数据');
  const triesAfter = binding('_benchListsTries');
  await sandbox.benchFetchLists();
  assert.strictEqual(binding('_benchListsTries'), triesAfter, '拿到之后不应再打该接口');

  // ---- 23c. 选人事件密集时不得并发重复拉取 ----
  resetLcu(() => httpFail(404));
  binding('_benchListsTries = 0');
  binding('_benchSubsetTries = 0');
  binding("_benchSubsetState = 'idle'");
  binding("_benchPickableState = 'idle'");
  binding('_benchListsInFlight = false');
  const before23c = lcuCalls.length;
  // 不 await, 模拟同一批选人事件连续触发
  const p1 = sandbox.benchFetchLists();
  const p2 = sandbox.benchFetchLists();
  const p3 = sandbox.benchFetchLists();
  await Promise.all([p1, p2, p3]);
  assert.strictEqual(lcuCalls.length - before23c, 2, '并发调用只应真正发出 1 轮请求 (2 个端点), 实际 ' + (lcuCalls.length - before23c));
  assert.strictEqual(binding('_benchListsTries'), 1, '并发不应把重试额度一次烧掉');

  // ---- 23d. 可选列表成功不得烧掉抽卡池的额度 ----
  // 这正是一直"换不了抽卡池英雄"的根因: 两者原先共用一份额度, 可选列表往往第 1 次就成功,
  // 顺手把额度一次性拉满, 而抽卡池要晚一步才就绪 (真机先 404) —— 于是抽卡池整局都拿不到,
  // 「备选」按钮直接消失, 只剩下带保护期的备战席按钮, 用户感受就是"没法无 cd 换英雄"。
  resetLcu((method, path) => (path === '/lol-champ-select/v1/pickable-champion-ids' ? [1, 2] : httpFail(404)));
  binding('_benchListsTries = 0');
  binding('_benchSubsetTries = 0');
  binding('_benchSubsetIds = []');
  binding('_benchPickableIds = null');
  binding("_benchSubsetState = 'idle'");
  binding("_benchPickableState = 'idle'");
  for (let i = 0; i < 4; i++) await sandbox.benchFetchLists();   // 前 4 轮抽卡池都还没就绪
  assert.strictEqual(binding('_benchListsTries'), 1, '可选列表拿到后就不该再打该接口');
  assert.strictEqual(binding('_benchSubsetTries'), 4, '抽卡池必须继续用自己那份额度重试');
  resetLcu((method, path) => (path === '/lol-lobby-team-builder/champ-select/v1/subset-champion-list' ? [5, 6] : {}));
  await sandbox.benchFetchLists();
  assert.strictEqual(JSON.stringify(binding('_benchSubsetIds')), '[5,6]', '抽卡池最终拿到, 备选按钮才有数据可用');

  // ---- 24. BAN_PICK 阶段把抽卡池英雄列成"备选"按钮 ----
  resetLcu(() => ({}));
  binding('_benchSubsetIds = [5, 7, 99]');
  binding("_benchSubsetState = 'ok'");
  binding('_benchPickableIds = null');
  binding("_benchPickableState = 'idle'");
  binding("_benchSwapBtnsKey = ''");
  const banPick = { benchChampions: [{ championId: 1 }], allowSubsetChampionPicks: true, timer: { phase: 'BAN_PICK' } };
  sandbox.benchRenderSwapButtons(banPick);
  // 与 handleChampSelectEvent 里的调用顺序一致 (按钮渲染 + 诊断行)
  sandbox._benchRenderDiag(banPick);
  const html24 = getEl('benchSwapBtns').innerHTML;
  assert.ok(html24.includes('benchSwapNow(1)'), '备战席英雄应出按钮');
  assert.ok(html24.includes('benchSwapNow(5)'), '抽卡池英雄应出按钮 (这些没有冷却, 是"瞬换"的来源)');
  assert.ok(html24.includes('benchSwapNow(99)'), '抽卡池全部英雄都应列出');
  assert.ok(html24.includes('备战席') && html24.includes('备选'), '应标注每个按钮的来源');
  assert.match(getEl('benchDiag').textContent, /备选池 3/, '诊断行应显示抽卡池数量');
  assert.match(getEl('benchDiag').textContent, /阶段 BAN_PICK/, '诊断行应显示当前阶段');

  // ---- 25. 非 BAN_PICK 阶段不再列抽卡池 (与客户端自身逻辑一致) ----
  binding("_benchSwapBtnsKey = ''");
  sandbox.benchRenderSwapButtons({ benchChampions: [{ championId: 1 }], allowSubsetChampionPicks: true, timer: { phase: 'FINALIZATION' } });
  const html25 = getEl('benchSwapBtns').innerHTML;
  assert.ok(html25.includes('benchSwapNow(1)'), 'FINALIZATION 阶段备战席英雄仍应出按钮');
  assert.ok(!html25.includes('benchSwapNow(5)'), 'FINALIZATION 阶段不应再列抽卡池');

  // ---- 26. 非抽卡式选人时不列抽卡池 ----
  binding("_benchSwapBtnsKey = ''");
  sandbox.benchRenderSwapButtons({ benchChampions: [], allowSubsetChampionPicks: false, timer: { phase: 'BAN_PICK' } });
  assert.ok(!getEl('benchSwapBtns').innerHTML.includes('benchSwapNow(5)'), 'allowSubsetChampionPicks 为假时不应列抽卡池');

  // ---- 27. 可选列表只约束抽卡池，不能误伤权威备战席 ----
  binding("_benchSwapBtnsKey = ''");
  binding('_benchPickableIds = [1, 5]');
  sandbox.benchRenderSwapButtons({ benchChampions: [{ championId: 1 }, { championId: 7 }], allowSubsetChampionPicks: true, timer: { phase: 'BAN_PICK' } });
  const html27 = getEl('benchSwapBtns').innerHTML;
  assert.ok(html27.includes('benchSwapNow(1)'), '在服务器可选列表里的英雄应出按钮');
  assert.ok(html27.includes('benchSwapNow(7)'), '备战席是权威来源，即使临时可选列表缺项也必须显示');
  assert.ok(!html27.includes('benchSwapNow(99)'), '不在可选列表里的抽卡池英雄不应出按钮');
  assert.match(html27, /另有 1 个备选池英雄暂不可选/, '只应拦截不在可选列表中的抽卡池英雄');
  assert.match(html27, /该列表仅 2 项/, '必须报出门禁列表的大小, 真机上数字异常小即可看出是列表语义对不上');

  // ---- 27b. 瞬时异常列表不得让备战席按钮全部消失 ----
  binding("_benchSwapBtnsKey = ''");
  binding('_benchPickableIds = [42]');
  sandbox.benchRenderSwapButtons({ benchChampions: [{ championId: 1 }], allowSubsetChampionPicks: false, timer: { phase: 'BAN_PICK' } });
  const html27b = getEl('benchSwapBtns').innerHTML;
  assert.ok(html27b.includes('benchSwapNow(1)'), '异常小列表也不能隐藏真实备战席英雄');
  assert.ok(!html27b.includes('当前没有可换的英雄'), '已有备战席时不得显示为空');

  // ---- 28. 备战席与抽卡池重叠时只出一个按钮, 且归为备战席 ----
  binding("_benchSwapBtnsKey = ''");
  binding('_benchPickableIds = null');
  binding('_benchSubsetIds = [1, 5]');
  sandbox.benchRenderSwapButtons({ benchChampions: [{ championId: 1 }], allowSubsetChampionPicks: true, timer: { phase: 'BAN_PICK' } });
  const html28 = getEl('benchSwapBtns').innerHTML;
  assert.strictEqual((html28.match(/benchSwapNow\(1\)/g) || []).length, 1, '同一英雄只应出一个按钮');
  assert.ok(html28.includes('安妮 <span class="bench-tag">备战席</span>'), '重叠时归为备战席 (那个才可能带冷却)');

  // ---- 29. 列表被清空 (Delete 事件) 时归零 ----
  sandbox.benchSetSubset([]);
  assert.strictEqual(JSON.stringify(binding('_benchSubsetIds')), '[]', '抽卡池被清空时应归零, 不能留旧数据');
  sandbox.benchSetPickable([]);
  assert.strictEqual(JSON.stringify(binding('_benchPickableIds')), '[]', '可选列表被清空时应归零');

  // ---- 30. 离开选人清掉列表缓存 (否则下一局会列出上局才可选的英雄) ----
  binding('_benchSubsetIds = [5, 7]');
  binding('_benchPickableIds = [5, 7]');
  binding('_benchListsTries = 3');
  binding('_benchSubsetTries = 3');
  binding("_benchLastPhase = 'BAN_PICK'");
  sandbox._benchAlertReset();
  assert.strictEqual(JSON.stringify(binding('_benchSubsetIds')), '[]', '离开选人应清掉抽卡池');
  assert.strictEqual(binding('_benchPickableIds'), null, '离开选人应清掉可选列表');
  assert.strictEqual(binding('_benchListsTries'), 0, '离开选人应重置拉取计数, 允许下局重新拉');
  assert.strictEqual(binding('_benchSubsetTries'), 0, '抽卡池的独立计数也要重置, 否则下一局没额度可用');
  assert.strictEqual(binding('_benchLastPhase'), null, '阶段记忆要清掉, 下局切进 BAN_PICK 才会再触发一次强制重拉');

  // ================= 选人浮窗 (贴边小窗) =================
  // 浮窗不碰 LCU: 它只把主窗口算好的"可用英雄列表 + 状态文案"转过去显示, 点击再回传。
  // 因此断言集中在两件事: (1) 推出去的内容正确、(2) 点击走的是与主窗口按钮同一条流程。

  // ---- 30b. 默认关闭: 不得让浮窗冒出来 ----
  sandbox._gameflowPhase = 'ChampSelect';
  overlayCalls = [];
  assert.strictEqual(binding('benchOverlayOn'), false, '选人浮窗应默认关闭 (不能不打一声招呼就在屏幕上多一个窗)');
  binding("_benchSwapBtnsKey = ''");
  sandbox.benchRenderSwapButtons(benchSession(1));
  assert.strictEqual(overlayCalls.filter(c => c && c.visible).length, 0, '未开启浮窗时不得推送"显示"指令');

  // ---- 34. 开启后: 推送可用英雄列表, 带名字与来源标签 ----
  binding('_benchPickableIds = null');
  binding('_benchSubsetIds = []');
  sandbox._benchAlertReset();
  overlayCalls = [];
  sandbox.toggleBenchOverlay(true);
  assert.strictEqual(binding('benchOverlayOn'), true, '开启后开关状态应为 true');
  binding("_benchSwapBtnsKey = ''");
  sandbox.benchRenderSwapButtons(benchSession(1, 7));
  const last34 = overlayCalls[overlayCalls.length - 1];
  assert.ok(last34 && last34.visible === true, '开启且处于大乱斗选人时, 浮窗应显示');
  assert.strictEqual(last34.items.length, 2, '浮窗按钮应覆盖全部可用英雄, 与主窗口一致');
  assert.strictEqual(last34.items[0].name, '安妮', '浮窗按钮应带英雄名 (不能只给一个 id)');
  assert.strictEqual(last34.items[0].tag, '备战席', '浮窗按钮应标注英雄来源');
  assert.ok(last34.items.every(it => typeof it.id === 'number' && it.id > 0), '浮窗按钮必须带合法 championId');
  assert.ok(source.includes('_benchLoadHexWinRates') && source.includes('getHexChampionAugments'), '海斗备战区应异步补充同模式英雄胜率');
  assert.ok(read('renderer/js/overlay.js').includes('it.winRate'), '备战区浮窗应展示英雄胜率，同时保留原点击换取链路');

  // ---- 34b. 状态文案也要同步过去 (否则浮窗上点完看不到结果) ----
  overlayCalls = [];
  binding("_benchSwapState = ''");
  binding("_benchOverlayKey = ''");
  sandbox._benchSetSwapState('等待服务器允许…', 'text-muted');
  const last34b = overlayCalls[overlayCalls.length - 1];
  assert.strictEqual(last34b.state, '等待服务器允许…', '状态文案必须推给浮窗');
  assert.strictEqual(last34b.stateClass, '', '主题变量名 (text-muted) 不在浮窗色类里, 必须降级为空而不是原样传过去');

  // ---- 35. 非大乱斗模式: 没有备战区, 浮窗应收起而不是空浮着 ----
  overlayCalls = [];
  binding("_benchSwapBtnsKey = ''");
  sandbox.benchRenderSwapButtons({ myTeam: [] });
  const last35 = overlayCalls[overlayCalls.length - 1];
  assert.ok(last35 && last35.visible === false, '没有备战区字段时应让浮窗收起, 不留一个空窗');

  // ---- 35b. 加载页硬门禁: 迟到的旧选人事件也不能把浮窗重新唤醒 ----
  sandbox._gameflowPhase = 'GameStart';
  binding("_benchLastSession = { benchChampions: [{ championId: 1 }] }");
  binding("_benchOverlayKey = ''");
  overlayCalls = [];
  binding('_benchOverlaySync()');
  const last35b = overlayCalls[overlayCalls.length - 1];
  assert.ok(last35b && last35b.visible === false, '进入加载页后必须强制隐藏，不能沿用旧选人会话');
  sandbox._gameflowPhase = 'ChampSelect';

  // ---- 36. 离开选人: 浮窗收起且不带走上一局的英雄 ----
  binding("_benchSwapBtnsKey = ''");
  sandbox.benchRenderSwapButtons(benchSession(1, 7));
  overlayCalls = [];
  sandbox._benchAlertReset();
  const last36 = overlayCalls[overlayCalls.length - 1];
  assert.ok(last36 && last36.visible === false, '离开选人后浮窗必须收起, 不能留孤儿窗');
  assert.strictEqual(last36.items.length, 0, '离开选人后不应再带着上一局的英雄列表');
  assert.strictEqual(binding('_benchLastSession'), null, '离开选人后必须清掉旧会话，迟到事件不能复活浮窗');

  // ---- 37. 浮窗点击复用主窗口同一条换人流程 ----
  // 若浮窗另写一套请求逻辑, 门禁/重试/合规拦截就会各说各话, 合规模式甚至可能被绕过。
  resetLcu(() => ({}));
  binding('complianceOn = false');
  binding('_benchPickableIds = null');
  sandbox._benchAlertReset();
  sandbox.benchRenderSwapButtons(benchSession(1));
  overlayCalls = [];
  sandbox.benchSwapNow(1);      // 主进程把浮窗点击回传到渲染层后的入口
  await flush();
  assert.strictEqual(lcuCalls.length, 1, '浮窗点击应产生 1 次换英雄请求');
  assert.strictEqual(lcuCalls[0].path, '/lol-champ-select/v1/session/bench/swap/1', '路径与主窗口按钮完全一致');
  assert.match(source, /onOverlaySwap\(\s*id\s*=>\s*\{[^}]*benchSwapNow\(/, '浮窗回传必须直接调用 benchSwapNow, 不得另起一套');
  assert.ok(source.includes("benchSwapNow(' + it.id + ')"), '主窗口按钮同样走 benchSwapNow (两处同一个入口)');

  // ---- 30h. 主进程 / preload 接线齐备 ----
  const idxSrc3 = read('main/index.js');
  const preloadSrc3 = read('main/preload.js');
  assert.ok(/ipcMain\.handle\(\s*['"]overlay:update['"]/.test(idxSrc3), '主进程必须处理 overlay:update');
  assert.ok(/ipcMain\.handle\(\s*['"]overlay:swap['"]/.test(idxSrc3), '主进程必须处理 overlay:swap (承接浮窗点击)');
  assert.ok(/overlayUpdate\s*:/.test(preloadSrc3), 'preload 必须暴露 overlayUpdate');
  assert.ok(/overlaySwap\s*:/.test(preloadSrc3), 'preload 必须暴露 overlaySwap');
  assert.ok(/onOverlaySwap\s*:/.test(preloadSrc3), 'preload 必须暴露 onOverlaySwap');
  assert.ok(/onOverlayData\s*:/.test(preloadSrc3), 'preload 必须暴露 onOverlayData (浮窗收数据)');
  assert.ok(fs.existsSync(path.join(root, 'renderer/overlay.html')), '浮窗页面 overlay.html 必须存在');
  assert.ok(fs.existsSync(path.join(root, 'renderer/js/overlay.js')), '浮窗脚本 overlay.js 必须存在');
  const overlayHtmlSrc = read('renderer/overlay.html');
  assert.ok(overlayHtmlSrc.includes('js/overlay.js'), 'overlay.html 必须加载 overlay.js');
  assert.ok(/Content-Security-Policy/.test(overlayHtmlSrc), '浮窗页面必须带 CSP, 它是独立窗口不能裸奔');
  // 浮窗是"哑终端": 判定逻辑只允许有一处, 否则两个窗口的行为会分叉
  const overlayJsSrc = read('renderer/js/overlay.js');
  assert.doesNotMatch(overlayJsSrc, /lcuRequest|ipcRenderer\.invoke\('lcu/, '浮窗不得自己打 LCU (判定逻辑必须留在 bench.js)');

  // ---- 31. 主进程接线: 白名单 + 事件转发 ----
  const idxSrc2 = read('main/index.js');
  const wsSrc = read('main/lcu-ws.js');
  assert.ok(/'\/lol-lobby-team-builder'/.test(idxSrc2), '抽卡池端点前缀必须在主进程白名单内, 否则请求会被直接拒绝');
  assert.ok(wsSrc.includes("'/lol-lobby-team-builder/champ-select/v1/subset-champion-list'"), '抽卡池事件必须转发到渲染层');
  assert.ok(wsSrc.includes("'/lol-champ-select/v1/pickable-champion-ids'"), '可选列表事件必须转发到渲染层');
  // 真机上 LTB 插件在 champ-select 上只注册了节点级事件 (GET /help 的 events 里没有叶子项),
  // 所以叶子 URI 那行基本不会命中 —— 节点级这行才是真正会到的, 必须订阅且必须有人消费
  assert.ok(wsSrc.includes("'/lol-lobby-team-builder/champ-select/v1'"), '必须订阅 LTB champ-select 的节点级事件');
  assert.ok(source.includes("uri === '/lol-lobby-team-builder/champ-select/v1'"),
    '收到 LTB 节点事件必须主动重拉抽卡池 (payload 不带子资源)');
  assert.ok(source.includes('function benchFetchLists(force)'), '拉取入口必须支持强制重拉, 否则阶段切换时没有重试机会');
  assert.ok(wsSrc.includes('eventType'), '必须转发 eventType, 否则列表被清空时无法归零');
  // 选人事件进来时必须同时驱动按钮渲染、诊断行与列表拉取, 少一个功能就会静默失效
  const csStart = source.indexOf('function handleChampSelectEvent');
  const champSelectBody = source.slice(csStart, source.indexOf('\nfunction ', csStart + 10));
  assert.ok(champSelectBody.includes('benchRenderSwapButtons('), 'handleChampSelectEvent 必须渲染换英雄按钮');
  assert.ok(champSelectBody.includes('_benchRenderDiag('), 'handleChampSelectEvent 必须刷新诊断行');
  assert.ok(champSelectBody.includes('benchFetchLists('), 'handleChampSelectEvent 必须拉取抽卡池/可选列表');
  // 列表事件必须接到渲染层处理函数上, 否则订阅了也没人消费
  assert.ok(source.includes('benchSetSubset(eventType'), '抽卡池事件必须接到 benchSetSubset');
  assert.ok(source.includes('benchSetPickable(eventType'), '可选列表事件必须接到 benchSetPickable');

  // ---- 32. 诊断行必须能区分"没拉到" / "拉到了但是空" / "接口报错" ----
  // 真机上这三种情况的修法完全不同 (分别是 时序/模式不支持/接口挂了), 全都显示成 0 会让排查无从下手
  const diagOf = sess => { sandbox._benchRenderDiag(sess); return getEl('benchDiag').textContent; };
  const banPick32 = { benchChampions: [], allowSubsetChampionPicks: true, timer: { phase: 'BAN_PICK' } };

  binding('_benchSubsetIds = []');
  binding('_benchPickableIds = null');
  binding("_benchSubsetState = 'idle'");
  binding("_benchPickableState = 'idle'");
  const diagIdle = diagOf(banPick32);
  assert.match(diagIdle, /备选池 0\(未拉\)/, '还没拉过时必须显示"未拉", 不能只显示一个 0');
  assert.match(diagIdle, /可选 未知\(未拉\)/, '可选列表没拉到时必须显示"未知(未拉)"');
  assert.match(diagIdle, /抽卡 是/, '诊断行必须显示该模式是否支持抽卡式选人 (否则无法判断"备选池 0"是否正常)');

  binding("_benchSubsetState = 'error'");
  binding("_benchPickableState = 'error'");
  const diagErr = diagOf(banPick32);
  assert.match(diagErr, /备选池 0\(失败\)/, '接口报错时必须显示"失败"');
  assert.match(diagErr, /可选 未知\(失败\)/, '接口报错时可选列表也要显示"失败"');

  // 拉到了、但列表就是空的 (该模式确实没有抽卡池) —— 必须和"失败"区分开
  sandbox.benchSetSubset([]);
  sandbox.benchSetPickable([]);
  const diagEmpty = getEl('benchDiag').textContent;
  assert.match(diagEmpty, /备选池 0\(空\)/, '拿到空列表必须显示"空", 不能和"失败"混为一谈');
  assert.match(diagEmpty, /可选 0\(空\)/, '同上');

  // 真拿到数据时不加任何后缀, 只显示数字
  sandbox.benchSetSubset([5, 7]);
  sandbox.benchSetPickable([5, 7, 9]);
  const diagOk = getEl('benchDiag').textContent;
  assert.match(diagOk, /备选池 2 ·/, '拿到数据时不应带状态后缀');
  assert.match(diagOk, /可选 3 ·/, '同上');

  // 非抽卡模式: allowSubsetChampionPicks 为假时"备选池 0"是正常的, 诊断行要能说明这一点
  binding("_benchSubsetState = 'idle'");
  const diagNoSub = diagOf({ benchChampions: [], allowSubsetChampionPicks: false, timer: { phase: 'BAN_PICK' } });
  assert.match(diagNoSub, /抽卡 否/, '非抽卡模式必须显示"抽卡 否"');

  // 收尾: 假时钟在测试里是冻结的, 倒计时 tick 永远等不到过期, 必须显式清掉才能退出
  sandbox._benchAlertReset();
  assert.strictEqual(binding('_benchTick'), null, '收尾后不应残留 tick 定时器');

  console.log('备战区抢英雄倒计时测试通过 (13 组断言)');
  console.log('备战区一键换英雄测试通过 (12 组断言: 首次即出手 / 被拒后按保护期排重试 / 空响应判成功 / PATCH 选择分支 / 超限放弃 / 合规拦截 / 按钮渲染 / 白名单 / 离开清理)');
  console.log('备战区抽卡池测试通过 (14 组断言: 主动拉取 / 就绪重试 / 额度与可选列表分离 / 并发去重 / BAN_PICK 列出 / 阶段门禁 / 模式门禁 / 仅约束备选池 / 异常列表不误伤备战席 / 重叠去重 / 清空归零 / 离开清理 / 节点级事件兜底 / 诊断行状态区分)');
  console.log('备战区选人浮窗测试通过 (7 组断言: 默认关闭 / 推送可用列表与来源 / 状态文案与色类降级 / 非大乱斗收起 / 离开清理 / 点击复用 benchSwapNow / 主进程-preload 接线与页面齐备 / 浮窗不碰 LCU)');
  process.exit(0);
}, 300);
