'use strict';
// 位置 KPI 卡: 五个位置各看不同的四个指标; 辅助位不该出现"伤害占比"这种中单尺子。
const assert = require('assert');
const kpi = require('./renderer/js/position-kpi.js');

function row(over) {
  return Object.assign({ win: true, k: 5, d: 4, a: 8, cs: 160, dur: 1800, kp: 55, dmgPct: 22, tankPct: 20, goldPct: 21, vision: 30, dmgGold: 100 }, over);
}

// ① 聚合: 均值口径正确, 缺失的占比字段不会被当成 0
const agg = kpi.aggregate([row({}), row({ dmgPct: null, kp: null })]);
assert.strictEqual(agg.games, 2);
assert.strictEqual(Math.round(agg.dmgPct), 22, 'dmgPct 均值应只按有值样本平均');
assert.strictEqual(Math.round(agg.kp), 55);
assert.strictEqual(Math.round(agg.kda * 100) / 100, 3.25, '(5+8)/4 = 3.25');
assert.ok(Math.abs(agg.cspm - 160 / 30) < 0.01, '分均补刀 = 补刀 / 分钟');

// ② 样本不足不出 KPI
assert.deepStrictEqual(kpi.kpis([row({})], 'UTILITY'), [], '1 场不出 KPI');

// ③ 辅助位: 首要指标是视野, 且不含伤害占比
const sup = kpi.kpis([row({}), row({}), row({}), row({})], 'UTILITY');
assert.strictEqual(sup[0].key, 'vspm', '辅助第一项应该是视野/分');
assert.ok(sup.some(x => x.key === 'kp'), '辅助要有参团');
assert.ok(!sup.some(x => x.key === 'dmgPct'), '辅助不该出伤害占比');
assert.ok(!sup.some(x => x.key === 'dmgGold'), '辅助不该出伤转');

// ④ 中单位: 首要指标是伤害占比
const mid = kpi.kpis([row({}), row({}), row({}), row({})], 'MIDDLE');
assert.strictEqual(mid[0].key, 'dmgPct');

// ⑤ 位置别名归一
assert.strictEqual(kpi.normPosition('MID'), 'MIDDLE');
assert.strictEqual(kpi.normPosition('adc'), 'BOTTOM');
assert.strictEqual(kpi.normPosition('SUPPORT'), 'UTILITY');
assert.strictEqual(kpi.normPosition(''), '');
// 位置缺失时用 prefer 兜底
assert.strictEqual(kpi.kpis([row({}), row({}), row({}), row({})], '', { prefer: 'UTILITY' })[0].key, 'vspm');

// ⑥ 阈值分档: 优秀线以上 good, 中位线以上 ok, 以下 weak
assert.strictEqual(kpi.toneOf(2.0, [2.0, 3.4]), 'ok');
assert.strictEqual(kpi.toneOf(3.5, [2.0, 3.4]), 'good');
assert.strictEqual(kpi.toneOf(1.2, [2.0, 3.4]), 'weak');
assert.strictEqual(kpi.toneOf(null, [2.0, 3.4]), 'none');

// ⑦ 渲染: 至少能出 HTML, 带位置名
const html = kpi.html([row({}), row({}), row({}), row({})], 'UTILITY');
assert.ok(html.indexOf('pk-row') > 0 && html.indexOf('辅助') > 0, 'HTML 应含容器与位置名');

console.log('test_position_kpi: OK');
