'use strict';
// LP 曲线: 绝对 LP 换算 / 同日去重 / 斜率 / 升段天数。全部是可断言的纯函数。
const assert = require('assert');
const lp = require('./renderer/js/growth-lp.js');

const DAY = 86400000;

// ① 绝对 LP: 每大段 400, 小段 100
assert.strictEqual(lp.absLp({ tier: 'GOLD', division: 'II', leaguePoints: 50 }), 3 * 400 + 2 * 100 + 50);
assert.strictEqual(lp.absLp({ tier: 'IRON', division: 'IV', leaguePoints: 0 }), 0);
assert.strictEqual(lp.absLp({ tier: '', division: 'NA', leaguePoints: 0 }), null, '无段位不给数');
// 大师以上没有小段
assert.strictEqual(lp.absLp({ tier: 'MASTER', division: 'I', leaguePoints: 120 }), 7 * 400 + 120);

// ② 展示文案
assert.strictEqual(lp.labelOf({ tier: 'GOLD', division: 'II', leaguePoints: 50 }), '黄金II 50LP');
assert.strictEqual(lp.fmtAbs(3 * 400 + 2 * 100 + 50), '黄金II 50LP');
assert.strictEqual(lp.labelOf({ tier: '', division: 'NA', leaguePoints: 0 }), '无段位');

// ③ 下一段门槛
const mile = lp.nextMilestone({ tier: 'GOLD', division: 'II', leaguePoints: 50 });
assert.strictEqual(mile.need, 50, '黄金 II 50LP → 上到黄金 I 还差 50');
assert.strictEqual(lp.nextMilestone({ tier: 'GOLD', division: 'I', leaguePoints: 90 }).need, 10);

// ④ 采样: 同一天同队列只保留最后一个
const t0 = new Date('2026-11-18T10:00:00Z').getTime();
let list = lp.appendSample([], { t: t0, tier: 'GOLD', division: 'II', leaguePoints: 10 });
list = lp.appendSample(list, { t: t0 + 3600000, tier: 'GOLD', division: 'II', leaguePoints: 30 });
assert.strictEqual(list.length, 1, '同一天只留一个点');
assert.strictEqual(list[0].leaguePoints, 30, '留最后一个');
// 不同队列分开记
list = lp.appendSample(list, { t: t0, queue: 'RANKED_FLEX_SR', tier: 'SILVER', division: 'I', leaguePoints: 40 });
assert.strictEqual(list.length, 2);
// 非法条目被丢弃
assert.strictEqual(lp.appendSample(list, { t: t0, tier: '' }).length, 2);

// ⑤ 序列过滤 + 排序
const raw = [
  { t: t0 + 2 * DAY, queue: 'RANKED_SOLO_5x5', tier: 'GOLD', division: 'II', leaguePoints: 50, abs: lp.absLp({ tier: 'GOLD', division: 'II', leaguePoints: 50 }) },
  { t: t0, queue: 'RANKED_SOLO_5x5', tier: 'GOLD', division: 'II', leaguePoints: 10, abs: lp.absLp({ tier: 'GOLD', division: 'II', leaguePoints: 10 }) },
  { t: t0 + DAY, queue: 'RANKED_FLEX_SR', tier: 'SILVER', division: 'I', leaguePoints: 40, abs: lp.absLp({ tier: 'SILVER', division: 'I', leaguePoints: 40 }) }
];
const solo = lp.series(raw, 'RANKED_SOLO_5x5');
assert.strictEqual(solo.length, 2, '只取指定队列');
assert.ok(solo[0].t < solo[1].t, '按时间升序');

// ⑥ 斜率: 两天涨 40 LP → 20 LP/天
assert.strictEqual(lp.slopePerDay(solo), 20);
assert.strictEqual(lp.slopePerDay(solo.slice(0, 1)), null, '单点无法拟合');

// ⑦ 升段预估: 黄金 II 50LP 距黄金 I 还差 50, 20/天 → 3 天 (向上取整)
const f = lp.forecast(solo, { now: t0 + 2 * DAY, latest: { tier: 'GOLD', division: 'II', leaguePoints: 50 } });
assert.ok(f.ready);
assert.strictEqual(f.rate, 20);
assert.strictEqual(f.need, 50, '黄金 II 50LP → 黄金 I 还差 50');
assert.strictEqual(f.days, 3, '50 / 20 向上取整 = 3 天');
assert.strictEqual(f.verdict, '在涨');

// ⑧ 负增长不给天数 (掉分时不该编"还需几天升段")
const down = lp.forecast([
  { t: t0, abs: 1300, tier: 'GOLD', division: 'I', lp: 60 },
  { t: t0 + 2 * DAY, abs: 1200, tier: 'GOLD', division: 'II', lp: 60 }
], { latest: { tier: 'GOLD', division: 'II', leaguePoints: 60 } });
assert.ok(down.ready);
assert.strictEqual(down.days, null);
assert.strictEqual(down.verdict, '在掉');

// ⑨ 采样上限
let many = [];
for (let i = 0; i < lp.MAX_SAMPLES + 20; i++) many = lp.appendSample(many, { t: t0 + i * DAY, tier: 'GOLD', division: 'II', leaguePoints: i % 100 });
assert.strictEqual(many.length, lp.MAX_SAMPLES, '采样超过上限应裁剪最旧的');

// ⑩ 折线 SVG: 两个点就出图, 单点不出
assert.ok(lp.svg(solo).indexOf('<polyline') > 0);
assert.strictEqual(lp.svg(solo.slice(0, 1)), '');

console.log('test_growth_lp: OK');
