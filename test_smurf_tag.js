// 1.6.21 回归: 小代标签 (排位专属)
// - 只在单双排(420)/灵活组排(440) 判定; 匹配/大乱斗/斗魂不出
// - 段位分层: 黑铁~黄金 72% + 2 条个人证据; 铂金/翡翠 82% + KDA5.5 + 3 条; 钻石以上/未定级不出
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

console.log('\nPASS ' + pass + ' cases');
