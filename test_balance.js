'use strict';
// renderer/js/balance.js: 大乱斗/海斗平衡性调整的加载与显示; 以及实时页、备战区、启动流程的接线。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const src = read('renderer/js/balance.js');
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function load(api) {
  const logs = [];
  const ctx = vm.createContext({ console, Date, escapeHtml, window: { lolAPI: api }, lolAPI: Object.assign({ debugLog: m => logs.push(m) }, api) });
  ctx.window.lolAPI = ctx.lolAPI;
  vm.runInContext(src, ctx, { filename: 'balance.js' });
  return { ctx, logs, run: c => vm.runInContext(c, ctx) };
}
const sample = {
  champions: {
    2: [{ key: 'dmgDealt', label: '造成伤害', unit: 'pct', delta: 5, effect: 'buff' }, { key: 'abilityHaste', label: '技能急速', unit: 'flat', delta: 10, effect: 'buff' }],
    3: [{ key: 'dmgDealt', label: '造成伤害', unit: 'pct', delta: -10, effect: 'nerf' }],
    4: [{ key: 'dmgDealt', label: '造成伤害', unit: 'pct', delta: 5, effect: 'buff' }, { key: 'dmgTaken', label: '承受伤害', unit: 'pct', delta: 5, effect: 'nerf' }]
  },
  count: 3
};

(async () => {
  // ---------- 加载 ----------
  let calls = 0;
  const { ctx, run } = load({ getAramBalance: async () => { calls++; await new Promise(r => setImmediate(r)); return sample; } });
  await Promise.all([ctx.loadAramBalance(), ctx.loadAramBalance()]);
  assert.strictEqual(calls, 1, '并发调用应合并');
  await ctx.loadAramBalance();
  assert.strictEqual(calls, 1, '30 分钟内不重复请求');
  await ctx.loadAramBalance(true);
  assert.strictEqual(calls, 2, 'force 时重新请求');

  // ---------- 文案与徽标 ----------
  assert.strictEqual(ctx.balanceTipFor(2), '造成伤害 +5% · 技能急速 +10');
  assert.strictEqual(ctx.balanceTipFor(3), '造成伤害 -10%');
  assert.strictEqual(ctx.balanceTipFor('2'), ctx.balanceTipFor(2), '字符串与数字 ID 等价');
  assert.strictEqual(ctx.balanceTipFor(999), '', '没有调整返回空串');
  assert.ok(/class="lp-balance lp-balance-buff"[^>]*>增强</.test(ctx.balanceBadgeHtml(2)));
  assert.ok(/class="lp-balance lp-balance-nerf"[^>]*>削弱</.test(ctx.balanceBadgeHtml(3)));
  assert.ok(/class="lp-balance lp-balance-mixed"[^>]*>调整</.test(ctx.balanceBadgeHtml(4)), '有增有减显示「调整」');
  assert.strictEqual(ctx.balanceBadgeHtml(999), '');
  assert.ok(ctx.balanceBadgeHtml(2).includes('title="大乱斗平衡性调整 (OP.GG): 造成伤害 +5% · 技能急速 +10"'));

  // 标签来自主进程, 仍要转义 (防止数据源被污染时注入属性)
  run(`aramBalance.champions[9] = [{ label: '"><img src=x onerror=1>', unit: 'pct', delta: 1, effect: 'buff' }]`);
  const hostile = ctx.balanceBadgeHtml(9);
  assert.ok(!hostile.includes('<img') && hostile.includes('&lt;img'), '数据里的标签必须转义: ' + hostile);

  // ---------- 模式判断 ----------
  assert.strictEqual(ctx.isBalanceMode(450, ''), true, '极地大乱斗');
  assert.strictEqual(ctx.isBalanceMode(2400, ''), true, '海克斯大乱斗');
  assert.strictEqual(ctx.isBalanceMode(0, 'kiwi'), true, 'gameMode 也可识别');
  assert.strictEqual(ctx.isBalanceMode(420, 'CLASSIC'), false, '排位不显示');
  assert.strictEqual(ctx.isBalanceMode(undefined, undefined), false);

  // ---------- 失败: 不抛异常, 保留上一份 ----------
  {
    const { ctx: c2, logs } = load({ getAramBalance: async () => ({ __error: 'HTTP 503' }) });
    const r = await c2.loadAramBalance();
    assert.strictEqual(r.error, 'HTTP 503');
    assert.strictEqual(c2.balanceTipFor(2), '');
    assert.ok(logs.some(l => l.includes('[BALANCE] 加载失败')));
    const { ctx: c3 } = load({ getAramBalance: async () => { throw new Error('IPC 断开'); } });
    await assert.doesNotReject(c3.loadAramBalance(), 'loadAramBalance 永远不能抛异常 (1.5.1 的教训)');
    const { ctx: c4 } = load({});
    await assert.doesNotReject(c4.loadAramBalance(), 'preload 没有该接口时也不能抛');
    // 已有数据时刷新失败: 继续用旧数据
    let n = 0;
    const { ctx: c5, run: r5 } = load({ getAramBalance: async () => (n++ === 0 ? sample : { __error: 'x' }) });
    await c5.loadAramBalance();
    await c5.loadAramBalance(true);
    assert.strictEqual(c5.balanceTipFor(3), '造成伤害 -10%', '刷新失败应保留上一份数据');
    assert.strictEqual(r5('aramBalance.error'), 'x');
  }

  // ---------- 接线 ----------
  const html = read('renderer/index.html');
  const scripts = [...html.matchAll(/<script src="js\/([^"?]+)/g)].map(m => m[1]);
  assert.ok(scripts.includes('balance.js') && scripts.indexOf('balance.js') < scripts.indexOf('bench.js'), 'balance.js 必须在 bench.js 之前加载');
  const app = read('renderer/js/app.js');
  assert.ok(app.includes('loadAramBalance().catch(() => {});'), 'app.js 启动时应加载 (不等待、吞掉错误)');
  const live = read('renderer/js/live.js');
  assert.ok(/liveBalanceMode = isBalanceMode\(session\?\.gameData\?\.queue\?\.id/.test(live), '实时页应按队列判断是否显示');
  assert.ok(live.includes("const balanceHtml = liveBalanceMode ? balanceBadgeHtml(p.championId) : '';"));
  assert.ok(live.includes('${premadeTag}${balanceHtml}${marksHtml}'), '徽标应渲染在玩家名字行');
  const bench = read('renderer/js/bench.js');
  assert.ok(bench.includes("'</span>' + balanceBadgeHtml(it.id) + '<small"), '备战区换英雄按钮上应显示');
  assert.ok(bench.includes("'|' + aramBalance.loadedAt;"), '数据加载完成后备战区按钮要能重绘');
  const css = read('renderer/css/premium.css');
  for (const cls of ['.lp-balance-buff', '.lp-balance-nerf', '.lp-balance-mixed']) assert.ok(css.includes(cls), '缺少样式 ' + cls);

  // 实时页真实渲染: 大乱斗显示徽标, 排位不显示
  const liveCtx = vm.createContext({
    console, Date, Map, Set, escapeHtml, window: {}, performance: { now: () => 0 },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    lolAPI: { lcuStatus: async () => ({ summoner: { puuid: 'me' } }), getAramBalance: async () => sample },
    checkBlacklist: () => {}, isKnownPlayerName: () => false, addEncounter: () => {},
    deriveRiskProfile: () => ({ level: 'steady', label: '稳定', confidence: 80, evidence: [] }),
    getPlayerMarksHtml: () => '', inlineArg: v => JSON.stringify(String(v)), poroIcon: () => '<i></i>', nameCache: {},
    champImg: () => '', placeholder: () => '', champIconAttrs: () => '', champNumMap: { 2: { id: 'A', name: 'A' } }, allChampions: {}
  });
  liveCtx.window.lolAPI = liveCtx.lolAPI;
  vm.runInContext(src, liveCtx);
  vm.runInContext(read('renderer/js/live.js'), liveCtx);
  await vm.runInContext('loadAramBalance()', liveCtx);
  assert.strictEqual(vm.runInContext('balanceTipFor(2)', liveCtx), '造成伤害 +5% · 技能急速 +10', '前置条件: 实时页上下文里数据已加载');
  const body = { innerHTML: '' };
  const data = [{ puuid: 'a', name: 'A', team: 100, championId: 2, recent: [] }, { puuid: 'b', name: 'B', team: 200, championId: 3, recent: [] }];
  vm.runInContext('liveBalanceMode = true', liveCtx);
  await liveCtx.renderLiveTeams(body, data, null, null);
  assert.ok(body.innerHTML.includes('lp-balance-buff') && body.innerHTML.includes('lp-balance-nerf'), '大乱斗时玩家卡应显示平衡性徽标');
  vm.runInContext('liveBalanceMode = false', liveCtx);
  await liveCtx.renderLiveTeams(body, data, null, null);
  assert.ok(!body.innerHTML.includes('lp-balance'), '非大乱斗模式不显示');

  console.log('大乱斗平衡性调整显示测试通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
