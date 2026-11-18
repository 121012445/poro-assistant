// 1.6.11 回归: 日服/外服走 LCU 兜底, 客户端战绩只返回自己 1 人。
// 旧逻辑算 "我的值/同队总和" 恒等于 100% (参团 k+a 除以自己的击杀甚至 >100%),
// 是一排彻底失真的假占比。本测试锁定: 占比类字段置 null 让渲染层跳过,
// 而伤转/视野/分均CS 这类只靠自己数据就能算的真指标必须保留。
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const live = fs.readFileSync('renderer/js/live.js', 'utf8');

// 静态: 修复代码落位
assert.ok(live.includes('const soloOnly = mates.length < 2'), '应有「只有自己」的单人数据检测');
assert.ok(live.includes('r.dmgGold != null || r.vision != null'), '入口应放行无占比但有真指标的局');

// 动态: vm 隔离执行 live.js
const ctx = vm.createContext({
  console, window: {},
  document: {
    querySelectorAll: () => [], getElementById: () => null, addEventListener: () => {},
    createElement: () => ({ style: {}, addEventListener: () => {} }), body: { appendChild: () => {} }
  },
  poroIcon: () => '', escapeHtml: s => String(s), toggleLiveMetricsPop: () => {}
});
vm.runInContext(live, ctx, { filename: 'live.js' });

// --- teamShareOf: LCU 路径口径 (日服实际走的) ---
const lcuMe = { teamId: 100, puuid: 'me', k: 10, a: 5, dmg: 30000, dmgTaken: 12000, gold: 15000, vision: 30 };
const lcuKeys = { dmg: 'dmg', tank: 'dmgTaken', gold: 'gold', kills: 'k' };
const solo = ctx.teamShareOf([lcuMe], lcuMe, 10, 5, lcuKeys);
assert.strictEqual(solo.dmgPct, null, '单人时伤害占比必须 null (旧逻辑给假的 100%)');
assert.strictEqual(solo.tankPct, null, '单人时承伤占比必须 null');
assert.strictEqual(solo.goldPct, null, '单人时经济占比必须 null');
assert.strictEqual(solo.kp, null, '单人时参团必须 null (旧逻辑给假的 300%)');
assert.strictEqual(solo.kde, null, '单人时击杀伤害效率必须 null');
assert.strictEqual(solo.dmgGold, 200, '单人时伤转率仍是真实值 30000/15000=200%');
assert.strictEqual(solo.vision, null, 'LCU 路径 keys 未映射视野, 保持 null (既有行为, 非本次改动)');

// SGP 路径口径 (默认 keys) 同样生效
const sgpMe = { teamId: 100, puuid: 'me', totalDamageDealtToChampions: 30000, totalDamageTaken: 12000, goldEarned: 15000, visionScore: 30 };
const soloSgp = ctx.teamShareOf([sgpMe], sgpMe, 10, 5);
assert.strictEqual(soloSgp.dmgPct, null, 'SGP 口径单人时占比同样 null');
assert.strictEqual(soloSgp.dmgGold, 200, 'SGP 口径单人时伤转同样保留');
assert.strictEqual(soloSgp.vision, 30, 'SGP 口径单人时视野真值保留');

// --- liveMetricPills: 假占比不渲染, 真标签保留 ---
const soloRecent = [{ dmgPct: null, tankPct: null, goldPct: null, kp: null, kde: null, dmgGold: 200, vision: 30, cs: 200, dur: 1800, win: true }];
const pills = ctx.liveMetricPills(soloRecent);
assert.ok(!pills.includes('lp-metric-dmg"'), '单人时不渲染假的伤害占比标签');
assert.ok(!pills.includes('lp-metric-tank"'), '单人时不渲染假的承伤占比标签');
assert.ok(!pills.includes('lp-metric-gold"'), '单人时不渲染假的经济占比标签');
assert.ok(!pills.includes('lp-metric-kp"'), '单人时不渲染假的参团标签');
assert.ok(pills.includes('lp-metric-dmgGold"') && pills.includes('伤转<b>200%</b>'), '单人时真实伤转标签保留');
assert.ok(pills.includes('lp-metric-vision"'), '单人时真实视野标签保留');
assert.ok(pills.includes('lp-metric-csm"'), '单人时真实分均CS标签保留');
assert.strictEqual(ctx.liveMetricPills([{ dmgPct: null, dmgGold: null, vision: null, cs: 0, dur: 0 }]), '', '完全无数据时整排不显示');

// --- 多人时既有口径完全不变 (防止误伤国服 SGP 路径) ---
const me = { teamId: 100, puuid: 'me', kills: 10, totalDamageDealtToChampions: 30000, totalDamageTaken: 5000, goldEarned: 15000, visionScore: 30 };
const mates = [me,
  { teamId: 100, kills: 10, totalDamageDealtToChampions: 30000, totalDamageTaken: 4000, goldEarned: 15000, visionScore: 25 },
  { teamId: 100, kills: 0, totalDamageDealtToChampions: 20000, totalDamageTaken: 3000, goldEarned: 12000, visionScore: 20 },
  { teamId: 100, kills: 0, totalDamageDealtToChampions: 10000, totalDamageTaken: 2000, goldEarned: 10000, visionScore: 15 },
  { teamId: 200, kills: 0, totalDamageDealtToChampions: 10000, totalDamageTaken: 1000, goldEarned: 10000, visionScore: 10 }];
const multi = ctx.teamShareOf(mates, me, 10, 5);
assert.strictEqual(multi.dmgPct, 33, '多人时伤害占比 30000/90000≈33% 口径不变 (数值按实际队友和)');
assert.ok(multi.tankPct != null && multi.goldPct != null && multi.kp != null, '多人时占比类字段照常返回');

console.log('test_live_single_mate: 全部断言通过');
