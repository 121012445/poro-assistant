// 1.6.23 回归: 对局评分按位置归一化
// - 旧公式 k + a*0.7 - d*0.5 + dmg/4000 + gold/6000 偏向输出位, 辅助几乎不可能拿 MVP
// - 新公式每一项除以位置基线再乘权重, 各位置"正常发挥"应落在同一分数带
// - 辅助 carry 局 (视野/参团/保护拉满) 必须能压过普通 ADC 局
// - C 位高光局仍然第一 (不能为了照顾辅助把评分反过来搞坏)
// - 位置缺失时退回同一把尺, 不能 NaN
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync('renderer/js/utils.js', 'utf8');
const home = fs.readFileSync('renderer/js/home.js', 'utf8');
const hex = fs.readFileSync('renderer/js/hex.js', 'utf8');
const live = fs.readFileSync('renderer/js/live.js', 'utf8');

// ---------- 静态断言: 三个调用点都换成统一实现 ----------
assert.ok(!/cardRating/.test(home), 'home.js 不应再有独立的 cardRating 旧公式');
assert.ok(home.includes('championRatingOf(b, tlist)'), '战绩卡 MVP/ACE 应走位置归一化评分');
assert.ok(!/const rating = p => p\.k \+ p\.a \* 0\.7/.test(hex), 'hex.js 旧评分公式应已替换');
assert.ok(hex.includes('championRatingOf(p, norm.participants'), '对局详情排行应走统一评分');
assert.ok(live.includes('championRatingOf(me, mates)'), '小代标签的队内最佳应走统一评分');
assert.ok(!/function championRatingOf\(p\) \{/.test(live), 'live.js 不应再保有旧的一份评分实现');

// ---------- vm ----------
const ctx = vm.createContext({ console, localStorage: { getItem: () => null, setItem: () => {} }, window: {} });
vm.runInContext(src, ctx, { filename: 'utils.js' });
const R = ctx.championRatingOf;

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('ok ' + pass + ' - ' + name); };

// 造一个人: 位置 + 各项数据 (走 normalizeGame 压平后的字段名)
const P = (position, o) => Object.assign({
  position, k: 0, d: 0, a: 0, dmg: 0, gold: 0, visionScore: 0, dmgTaken: 0, allyHeal: 0, shielding: 0
}, o);

ok('各位置等于基线时分数接近 (归一化生效)', () => {
  const team = [
    P('TOP', { k: 5.5, a: 6.5, d: 5.0, dmg: 19000, gold: 11000, visionScore: 22, dmgTaken: 24000, allyHeal: 500 }),
    P('JUNGLE', { k: 6.0, a: 9.0, d: 4.8, dmg: 16000, gold: 11000, visionScore: 26, dmgTaken: 22000, allyHeal: 800 }),
    P('MIDDLE', { k: 6.5, a: 7.0, d: 5.0, dmg: 23000, gold: 12000, visionScore: 26, dmgTaken: 18000, allyHeal: 700 }),
    P('BOTTOM', { k: 7.5, a: 6.5, d: 4.8, dmg: 25000, gold: 12500, visionScore: 24, dmgTaken: 16000, allyHeal: 600 }),
    P('UTILITY', { k: 2.5, a: 15.0, d: 5.5, dmg: 8000, gold: 7500, visionScore: 55, dmgTaken: 17000, allyHeal: 6000 })
  ];
  const scores = team.map(p => R(p, team));
  const max = Math.max(...scores), min = Math.min(...scores);
  assert.ok(max - min < 0.45, '五个位置都在基线时分数应几乎相同, 实际 ' + scores.map(s => s.toFixed(2)).join(' / '));
});

ok('辅助 carry 局压过普通 ADC 局', () => {
  const sup = P('UTILITY', { k: 2, d: 4, a: 24, dmg: 9000, gold: 8000, visionScore: 95, dmgTaken: 20000, allyHeal: 5000, shielding: 2000 });
  const adc = P('BOTTOM', { k: 8, d: 5, a: 8, dmg: 30000, gold: 14000, visionScore: 25, dmgTaken: 15000, allyHeal: 300 });
  const team = [sup, adc,
    P('TOP', { k: 3, d: 6, a: 4, dmg: 15000, gold: 9000, visionScore: 15, dmgTaken: 26000 }),
    P('JUNGLE', { k: 4, d: 5, a: 8, dmg: 12000, gold: 9500, visionScore: 20, dmgTaken: 23000 }),
    P('MIDDLE', { k: 5, d: 5, a: 6, dmg: 18000, gold: 10500, visionScore: 18, dmgTaken: 19000 })];
  const s = R(sup, team), a = R(adc, team);
  assert.ok(s > a, '2/4/24 + 视野 95 的辅助应高于 8/5/8 的普通 ADC: ' + s.toFixed(2) + ' vs ' + a.toFixed(2));
});

ok('辅助正常局不会虚高压过 ADC 高光局', () => {
  const sup = P('UTILITY', { k: 0, d: 5, a: 12, dmg: 5000, gold: 6500, visionScore: 40, dmgTaken: 16000, allyHeal: 5000 });
  const adc = P('BOTTOM', { k: 15, d: 2, a: 5, dmg: 38000, gold: 17000, visionScore: 28, dmgTaken: 14000, allyHeal: 2000 });
  const team = [sup, adc,
    P('TOP', { k: 4, d: 5, a: 3, dmg: 16000, gold: 9500, visionScore: 16, dmgTaken: 25000 }),
    P('JUNGLE', { k: 5, d: 4, a: 7, dmg: 13000, gold: 10000, visionScore: 22, dmgTaken: 22000 }),
    P('MIDDLE', { k: 6, d: 4, a: 5, dmg: 20000, gold: 11000, visionScore: 19, dmgTaken: 18000 })];
  assert.ok(R(adc, team) > R(sup, team), '15/2/5 的 ADC 高光局必须仍是队内第一');
});

ok('真实国服对局回放: 2/2/10 视野 29 的辅助排第一', () => {
  // 取自本机 home-cache 的队列 430 对局 (旧公式下辅助排第 2, 新公式第 1)
  const team = [
    P('MIDDLE', { k: 3, d: 6, a: 4, dmg: 12548, gold: 7173, visionScore: 15, dmgTaken: 9000 }),
    P('BOTTOM', { k: 8, d: 3, a: 2, dmg: 18262, gold: 12871, visionScore: 27, dmgTaken: 11000 }),
    P('JUNGLE', { k: 4, d: 1, a: 2, dmg: 5850, gold: 8069, visionScore: 20, dmgTaken: 12000 }),
    P('UTILITY', { k: 2, d: 2, a: 10, dmg: 7896, gold: 7112, visionScore: 29, dmgTaken: 13000, allyHeal: 3000 }),
    P('TOP', { k: 3, d: 2, a: 1, dmg: 15403, gold: 9052, visionScore: 13, dmgTaken: 14000 })
  ];
  const best = team.slice().sort((a, b) => R(b, team) - R(a, team))[0];
  assert.strictEqual(best.position, 'UTILITY', '该局辅助应排第一: ' + team.map(p => p.position + '=' + R(p, team).toFixed(2)).join(' '));
});

ok('位置缺失时退回同一把尺, 不返回 NaN', () => {
  const team = [
    P('', { k: 10, d: 2, a: 8, dmg: 25000, gold: 14000, visionScore: 20 }),
    P('', { k: 2, d: 2, a: 20, dmg: 8000, gold: 8000, visionScore: 60, allyHeal: 6000 })
  ];
  for (const p of team) {
    const v = R(p, team);
    assert.ok(Number.isFinite(v), '位置缺失时应返回有限数, 实际 ' + v);
  }
  // 位置未知无法做位置归一化, 只能"用同一把尺"; 但极端表现的排序仍必须成立
  const monster = P('', { k: 20, d: 0, a: 5, dmg: 50000, gold: 18000, visionScore: 20 });
  const feeder = P('', { k: 0, d: 10, a: 0, dmg: 2000, gold: 4000, visionScore: 5 });
  assert.ok(R(monster, [monster, feeder]) > R(feeder, [monster, feeder]) + 2, '20/0/5 应显著高于 0/10/0');
});

ok('SGP 原始结构 (stats 嵌套) 与压平结构结果一致', () => {
  const flat = P('UTILITY', { k: 2, d: 2, a: 10, dmg: 7896, gold: 7112, visionScore: 29, dmgTaken: 13000, allyHeal: 3000 });
  const raw = { position: 'UTILITY', stats: { kills: 2, deaths: 2, assists: 10, totalDamageDealtToChampions: 7896, goldEarned: 7112, visionScore: 29, totalDamageTaken: 13000, totalHealsOnTeammates: 3000 } };
  assert.ok(Math.abs(R(flat, [flat]) - R(raw, [raw])) < 1e-6, '两种字段结构应算出同一分数');
  // teamPosition 也能识别位置
  const raw2 = { teamPosition: 'UTILITY', k: 2, d: 2, a: 10, dmg: 7896, gold: 7112, visionScore: 29, dmgTaken: 13000, allyHeal: 3000 };
  assert.ok(Math.abs(R(flat, [flat]) - R(raw2, [raw2])) < 1e-6, 'SGP 的 teamPosition 应被识别为辅助基线');
});

ok('INVALID 位置退回默认基线', () => {
  const v = R(P('INVALID', { k: 5, d: 5, a: 5, dmg: 15000, gold: 10000 }), []);
  assert.ok(Number.isFinite(v) && v > 0, 'INVALID 不应算出 0 或 NaN');
});

console.log('\nPASS ' + pass + ' cases');
