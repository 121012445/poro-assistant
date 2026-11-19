// 1.6.21 回归: 小代标签 (排位专属)
// - 只在单双排(420)/灵活组排(440) 判定; 匹配/大乱斗/斗魂不出
// - 段位分层: 黑铁~黄金 72% + 2 条个人证据; 铂金/翡翠 82% + KDA5.5 + 3 条; 钻石以上/未定级不出
// - 1.6.22: 第二条路径 —— 胜率不够但"队内最佳/伤害占比/爆炸局"这类数据碾压证据够, 同样出
// - 老缓存战绩行没有 queueId 时退回全量样本; 有 queueId 时严格按队列过滤
// - 自己身上不贴; title 必须写明"疑似"与"仅供参考"
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync('renderer/js/smurf-tags.js', 'utf8');
const live = fs.readFileSync('renderer/js/live.js', 'utf8');
const html = fs.readFileSync('renderer/index.html', 'utf8');
const css = fs.readFileSync('renderer/css/v4.css', 'utf8');

// ---------- 静态断言 ----------
assert.ok(html.includes('js/smurf-tags.js'), 'index.html 必须加载 smurf-tags.js');
assert.ok(css.includes('.lp-tag-smurf'), 'v4.css 应有小代标签样式');
assert.ok(live.includes('smurfTagHtml('), 'buildLivePills 应调用 smurfTagHtml');
assert.ok(live.includes('liveRankedEntryOf('), '段位必须按当前排位队列取');
assert.ok(live.includes("queueId: Number(gj.queueId) || 0"), '战绩行应带 queueId 供队列过滤');

// ---------- vm 执行 ----------
const ranks = { IRON: '黑铁', BRONZE: '青铜', SILVER: '白银', GOLD: '黄金', PLATINUM: '铂金', EMERALD: '翡翠', DIAMOND: '钻石' };
const ctx = vm.createContext({
  console,
  escapeHtml: s => String(s),
  rankTierCN: t => ranks[t] || t
});
vm.runInContext(src, ctx, { filename: 'smurf-tags.js' });

const game = o => Object.assign({ win: true, k: 10, d: 2, a: 8, cs: 200, dur: 1800, dmgGold: 150, solo: 1, queueId: 420 }, o);
const many = (n, o) => Array.from({ length: n }, () => game(o));
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('ok ' + pass + ' - ' + name); };

// 1) 黄金 + 12 场 11 胜 (91%) + 高 KDA/伤转 → 出
ok('黄金 92% 胜率出小代', () => {
  const rows = [...many(11, {}), game({ win: false })];
  const t = ctx.deriveSmurfTag({ recent: rows }, { queueId: 420, tier: 'GOLD', division: 'II' });
  assert.ok(t, '应判定为小代');
  assert.strictEqual(t.label, '小代');
  assert.ok(t.detail.includes('近 12 场排位'), 'detail 应含样本数: ' + t.detail);
  assert.ok(t.detail.includes('92%'), 'detail 应含胜率: ' + t.detail);
  assert.ok(t.detail.includes('黄金 II'), 'detail 应含段位: ' + t.detail);
});

// 2) 同样数据但钻石段位 → 不出
ok('钻石段位不出', () => {
  assert.strictEqual(ctx.deriveSmurfTag({ recent: many(12, {}) }, { queueId: 420, tier: 'DIAMOND' }), null);
});

// 3) 未定级 → 不出
ok('未定级不出', () => {
  assert.strictEqual(ctx.deriveSmurfTag({ recent: many(12, {}) }, { queueId: 420, tier: '' }), null);
});

// 4) 非排位队列 → 不出
ok('匹配模式不出', () => {
  assert.strictEqual(ctx.deriveSmurfTag({ recent: many(12, { queueId: 430 }) }, { queueId: 430, tier: 'GOLD' }), null);
});

// 5) 样本不足 10 场 → 不出
ok('样本不足不出', () => {
  assert.strictEqual(ctx.deriveSmurfTag({ recent: many(8, {}) }, { queueId: 420, tier: 'GOLD' }), null);
});

// 6) 胜率够但个人证据不足 → 不出 (只看胜率会误伤被队友带飞的人)
ok('只有胜率没有个人证据不出', () => {
  const rows = [...many(10, { k: 3, d: 2, a: 2, dmgGold: 90, cs: 100, solo: 0 }), ...many(2, { win: false, k: 1, d: 3, a: 1, dmgGold: 70, cs: 80, solo: 0 })];
  assert.strictEqual(ctx.deriveSmurfTag({ recent: rows }, { queueId: 420, tier: 'GOLD' }), null);
});

// 7) 翡翠 85% + KDA 6 + 三条证据 → 出
ok('翡翠极端数据出', () => {
  const rows = [...many(10, { k: 12, d: 2, a: 10, solo: 2 }), ...many(2, { win: false, k: 4, d: 4, a: 4, dmgGold: 110, solo: 0 })];
  const t = ctx.deriveSmurfTag({ recent: rows }, { queueId: 420, tier: 'EMERALD', division: 'III' });
  assert.ok(t, '翡翠 83% 胜率 + KDA 5.5 应出');
  assert.ok(t.detail.includes('翡翠 III'));
});

// 8) 翡翠 80% 未达 82% → 不出
ok('翡翠未达门槛不出', () => {
  const rows = [...many(10, { k: 12, d: 2, a: 10 }), ...many(3, { win: false }), game({})];
  const t = ctx.deriveSmurfTag({ recent: rows }, { queueId: 420, tier: 'EMERALD' });
  assert.strictEqual(t, null, '13 场 10 胜 = 77% 不应出');
});

// 9) 混合队列: 只有 5 场排位, 其余是大乱斗 → 样本不够, 不出
ok('队列过滤精确', () => {
  const rows = [...many(5, { queueId: 420 }), ...many(9, { queueId: 450 })];
  assert.strictEqual(ctx.deriveSmurfTag({ recent: rows }, { queueId: 420, tier: 'GOLD' }), null);
});

// 10) 自己对不贴
ok('自己不出', () => {
  assert.strictEqual(ctx.deriveSmurfTag({ recent: many(12, {}) }, { queueId: 420, tier: 'GOLD', isSelf: true }), null);
});

// 11) title 必须写明疑似与仅供参考
ok('title 写明疑似/仅供参考', () => {
  const h = ctx.smurfTagHtml({ recent: many(12, {}) }, { queueId: 420, tier: 'GOLD', division: 'IV' });
  assert.ok(h.includes('lp-tag-smurf'));
  assert.ok(h.includes('疑似小号/代练'), h);
  assert.ok(h.includes('仅供参考'), h);
  assert.ok(!h.includes('>疑似'), '标签正文应只写「小代」');
});

// 12) 白银 75% + 两条证据 → 出
ok('白银达门槛出', () => {
  const rows = [...many(9, {}), ...many(3, { win: false })];
  const t = ctx.deriveSmurfTag({ recent: rows }, { queueId: 420, tier: 'SILVER' });
  assert.ok(t, '白银 75% + KDA 9 + 伤转 150 应出');
});

// 13) 黄金 71.4% 未达 72% → 不出
ok('胜率不足不出', () => {
  const rows = [...many(10, {}), ...many(4, { win: false })];
  assert.strictEqual(ctx.deriveSmurfTag({ recent: rows }, { queueId: 420, tier: 'GOLD' }), null);
});

// 14) 老缓存无 queueId 字段 → 退回全量样本
ok('老缓存无队列号时退回全量', () => {
  const rows = many(12, { queueId: 0 });
  const t = ctx.deriveSmurfTag({ recent: rows }, { queueId: 420, tier: 'GOLD' });
  assert.ok(t, '缺 queueId 的老缓存不应导致永不判定');
});

// 15) 灵活组排(440) 同样生效
ok('灵活组排生效', () => {
  const t = ctx.deriveSmurfTag({ recent: many(12, { queueId: 440 }) }, { queueId: 440, tier: 'GOLD' });
  assert.ok(t);
});

// ---------- 1.6.22: 数据维度 (不能只看胜率) ----------
// 6 胜 6 负 = 50%, 但 9 场队内最佳、伤害占比 38%、KDA 8 —— 典型"个人碾压队友拖后腿"
const carryRows = () => [
  ...many(6, { best: true, k: 8, d: 2, a: 8, dmgPct: 40, dmgGold: 150, cs: 200, solo: 1 }),
  ...many(3, { win: false, best: true, k: 8, d: 2, a: 8, dmgPct: 40, dmgGold: 150, cs: 200, solo: 1 }),
  ...many(3, { win: false, best: false, k: 4, d: 3, a: 2, dmgPct: 32, dmgGold: 130, cs: 180, solo: 1 })
];

// 16) 胜率 50% 未达 72%, 但队内最佳 9/12 + 伤害占比 → 数据路径出
ok('胜率不足但数据碾压出', () => {
  const t = ctx.deriveSmurfTag({ recent: carryRows() }, { queueId: 420, tier: 'GOLD', division: 'IV' });
  assert.ok(t, '50% 胜率 + 队内最佳 75% + 伤害占比 38% 应判定为小代');
  assert.strictEqual(t.mode, 'data', '应走数据路径');
  assert.ok(t.detail.includes('但个人数据碾压'), t.detail);
  assert.ok(t.detail.includes('队内最佳 9/12'), 'detail 应写出队内最佳场次: ' + t.detail);
  assert.ok(t.detail.includes('50% 胜率'), t.detail);
});

// 17) 数据碾压但基础个人能力证据不足 (KDA 2 / 兵线差) → 不出
ok('只有队内最佳没有基础能力不出', () => {
  const rows = many(12, { best: true, win: false, k: 3, d: 3, a: 3, dmgPct: 40, dmgGold: 90, cs: 100, solo: 0 });
  assert.strictEqual(ctx.deriveSmurfTag({ recent: rows }, { queueId: 420, tier: 'GOLD' }), null);
});

// 18) 翡翠: 队内最佳 58% 未达 70% 的硬要求 → 数据路径不出
ok('翡翠弱数据信号不出', () => {
  const rows = [
    ...many(6, { best: true, k: 8, d: 2, a: 8, dmgPct: 35, dmgGold: 150, cs: 200, solo: 2 }),
    ...many(1, { best: true, win: false, k: 8, d: 2, a: 8, dmgPct: 35, dmgGold: 150, cs: 200, solo: 2 }),
    ...many(5, { best: false, win: false, k: 3, d: 4, a: 2, dmgPct: 25, dmgGold: 110, cs: 160, solo: 0 })
  ];
  assert.strictEqual(ctx.deriveSmurfTag({ recent: rows }, { queueId: 420, tier: 'EMERALD' }), null);
});

// 19) 翡翠: 队内最佳 83% + 三条基础证据 → 数据路径出
ok('翡翠强数据信号出', () => {
  const rows = [
    ...many(6, { best: true, k: 9, d: 2, a: 9, dmgPct: 38, dmgGold: 150, cs: 200, solo: 2 }),
    ...many(4, { best: true, win: false, k: 9, d: 2, a: 9, dmgPct: 38, dmgGold: 150, cs: 200, solo: 2 }),
    ...many(2, { best: false, win: false, k: 2, d: 4, a: 1, dmgPct: 20, dmgGold: 100, cs: 150, solo: 0 })
  ];
  const t = ctx.deriveSmurfTag({ recent: rows }, { queueId: 420, tier: 'EMERALD', division: 'II' });
  assert.ok(t, '翡翠 50% 胜率但 83% 队内最佳 + KDA 9 应判定');
  assert.strictEqual(t.mode, 'data');
});

// 20) 胜率低于 45% 下限: 数据再好也是送, 不出
ok('胜率过低不出', () => {
  const rows = [
    ...many(4, { best: true, k: 8, d: 2, a: 8, dmgPct: 40, dmgGold: 150, cs: 200, solo: 1 }),
    ...many(8, { win: false, best: false, k: 3, d: 4, a: 2, dmgPct: 25, dmgGold: 100, cs: 150, solo: 0 })
  ];
  assert.strictEqual(ctx.deriveSmurfTag({ recent: rows }, { queueId: 420, tier: 'GOLD' }), null);
});

// 21) 拿不到队友数据 (best 全 null, 外服单人返回) → 退回战绩路径, 不能因数据缺失而不判定
ok('队友数据缺失时退回战绩路径', () => {
  const rows = [...many(11, { best: null, dmgPct: null }), game({ win: false, best: null, dmgPct: null })];
  const t = ctx.deriveSmurfTag({ recent: rows }, { queueId: 420, tier: 'GOLD' });
  assert.ok(t, 'best 缺失不应导致永不判定');
  assert.strictEqual(t.mode, 'win');
  assert.ok(!t.carry.some(x => x.includes('队内最佳')), '无队友数据时不应产生队内最佳证据: ' + t.carry.join(','));
  assert.ok(!t.detail.includes('队内最佳'), 'title 里不能出现没算出来的队内最佳');
});

// 22) teamBestFlag: 只有我方 5 人齐才判定, 单人返回给 null
ok('teamBestFlag 语义', () => {
  const liveSrc = fs.readFileSync('renderer/js/live.js', 'utf8');
  const fnSrc = liveSrc.match(/function championRatingOf\(p\) \{[\s\S]*?\n\}/)[0]
    + '\n' + liveSrc.match(/function teamBestFlag\(participants, me\) \{[\s\S]*?\n\}/)[0];
  const c = vm.createContext({});
  vm.runInContext(fnSrc, c, { filename: 'live.rating.js' });
  const p = (k, d, a, dmg, gold) => ({ puuid: 'p' + k + d + a + dmg, teamId: 100, k, d, a, dmg, gold });
  const me = p(12, 2, 8, 30000, 15000);
  const mates = [me, p(2, 6, 3, 9000, 7000), p(4, 5, 6, 15000, 9000), p(1, 7, 2, 6000, 5000), p(3, 4, 5, 11000, 8000)];
  assert.strictEqual(c.teamBestFlag(mates, me), true, '自己分最高应为 true');
  const better = p(20, 1, 12, 45000, 20000);
  assert.strictEqual(c.teamBestFlag([me, better, ...mates.slice(2)], me), false, '有人分更高应为 false');
  assert.strictEqual(c.teamBestFlag([me], me), null, '数据不全应为 null 而不是 false');
  // SGP 原始结构 (stats 嵌套 + kills 命名) 同样能算
  const raw = (kills, deaths, assists, dmg, gold, pu) => ({ puuid: pu, teamId: 100, stats: { kills, deaths, assists, totalDamageDealtToChampions: dmg, goldEarned: gold } });
  const meRaw = raw(12, 2, 8, 30000, 15000, 'me');
  const five = [meRaw, raw(2, 6, 3, 9000, 7000, 'a'), raw(4, 5, 6, 15000, 9000, 'b'), raw(1, 7, 2, 6000, 5000, 'c'), raw(3, 4, 5, 11000, 8000, 'd')];
  assert.strictEqual(c.teamBestFlag(five, meRaw), true, 'SGP 嵌套 stats 结构应能判定');
});

console.log('\nPASS ' + pass + ' cases');
