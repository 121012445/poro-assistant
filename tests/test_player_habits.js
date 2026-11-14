'use strict';
// 习惯卡判定 (renderer/js/player-habits.js) 的回归测试。
// 锁住三条产品原则: 样本不足不出结论 / 每条结论带分母 / 字段缺失不能当成"没有"。
const assert = require('assert');
const path = require('path');
const habits = require(path.join(__dirname, '..', 'renderer', 'js', 'player-habits.js'));

const games = n => Array.from({ length: n }, (_, i) => ({ position: 'JUNGLE', champId: 64, d: 4, fb: i < 8 }));

// 1) 样本不足: 7 场一律不出结论
{
  const p = habits.buildHabitProfile(games(7));
  assert.strictEqual(p.games, 7);
  assert.deepStrictEqual(habits.habitItems(p), [], '少于 8 场不得下任何结论');
}

// 2) 位置: 18 场里 14 场打野 (77%) -> 「主玩 打野 14/18」
{
  const list = games(18);
  list[4].position = 'TOP'; list[7].position = 'MIDDLE'; list[9].position = 'BOTTOM'; list[12].position = 'UTILITY';
  const p = habits.buildHabitProfile(list);
  const pos = habits.habitItems(p).find(it => it.key === 'position');
  assert.ok(pos, '应给出一条位置结论');
  assert.strictEqual(pos.value, '打野 14/18', '位置结论必须带分母');
  assert.match(pos.label, /主玩/);
}

// 3) 位置分散: 横跨 4 个位置 -> 「补位型」
{
  const list = [];
  for (const [i, pos] of ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM'].entries()) {
    for (let k = 0; k < 3; k++) list.push({ position: pos, champId: 1, d: 4, fb: false });
  }
  const p = habits.buildHabitProfile(list);
  const pos = habits.habitItems(p).find(it => it.key === 'position');
  assert.ok(pos && /补位/.test(pos.label), '横跨 4 个位置应标补位型, 实际 ' + JSON.stringify(pos));
}

// 4) 位置字段缺失: 不能算成"补位"
{
  const list = Array.from({ length: 12 }, () => ({ position: '', champId: 1, d: 4, fb: false }));
  const p = habits.buildHabitProfile(list);
  assert.strictEqual(p.positioned, 0);
  assert.ok(!habits.habitItems(p).some(it => it.key === 'position'), '没有位置字段时不得下位置结论');
}

// 5) 阵亡: 场均 7.5 -> 告警; 场均 2.5 -> 少死; 场均 5 -> 不出
{
  const high = habits.buildHabitProfile(Array.from({ length: 10 }, () => ({ position: 'JUNGLE', champId: 1, d: 7.5, fb: false })));
  assert.strictEqual(habits.habitItems(high).find(it => it.key === 'deaths').tone, 'warn');

  const low = habits.buildHabitProfile(Array.from({ length: 10 }, () => ({ position: 'JUNGLE', champId: 1, d: 2.5, fb: false })));
  assert.strictEqual(habits.habitItems(low).find(it => it.key === 'deaths').tone, 'good');

  const mid = habits.buildHabitProfile(Array.from({ length: 10 }, () => ({ position: 'JUNGLE', champId: 1, d: 5, fb: false })));
  assert.ok(!habits.habitItems(mid).some(it => it.key === 'deaths'), '中间值不该占位');
}

// 6) 一血: 字段缺失(null)不进分母; 9/12 才出结论
{
  const missing = habits.buildHabitProfile(Array.from({ length: 12 }, () => ({ position: 'JUNGLE', champId: 1, d: 4 })));
  assert.strictEqual(missing.fbTotal, 0, '没有 fb 字段时不得计入分母');
  assert.ok(!habits.habitItems(missing).some(it => it.key === 'firstBlood'));

  const list = Array.from({ length: 12 }, (_, i) => ({ position: 'JUNGLE', champId: 1, d: 4, fb: i < 9 }));
  const p = habits.buildHabitProfile(list);
  const fb = habits.habitItems(p).find(it => it.key === 'firstBlood');
  assert.strictEqual(fb.value, '9/12');
}

// 7) 卡片最多两条, 顺序 位置 > 阵亡 > 一血
{
  const list = Array.from({ length: 20 }, (_, i) => ({ position: 'JUNGLE', champId: 1, d: 7, fb: i < 12 }));
  const p = habits.buildHabitProfile(list);
  const pills = habits.habitPills(p, 2);
  assert.strictEqual(pills.length, 2);
  assert.deepStrictEqual(pills.map(it => it.key), ['position', 'deaths']);
}

// 8) 中文/小写位置归一
{
  assert.strictEqual(habits.normalizePosition('打野'), 'JUNGLE');
  assert.strictEqual(habits.normalizePosition('jungle'), 'JUNGLE');
  assert.strictEqual(habits.normalizePosition('MID'), 'MIDDLE');
  assert.strictEqual(habits.normalizePosition('INVALID'), '');
  assert.strictEqual(habits.normalizePosition(undefined), '');
}

// 9) 模式家族判定 (大乱斗/海斗归同一族)
{
  assert.strictEqual(habits.modeFamilyOf('极地大乱斗', 450), 'aram');
  assert.strictEqual(habits.modeFamilyOf('海克斯大乱斗', 2400), 'aram');
  assert.strictEqual(habits.modeFamilyOf('斗魂竞技场', 1700), 'arena');
  assert.strictEqual(habits.modeFamilyOf('召唤师峡谷', 420), 'rift');
  assert.strictEqual(habits.modeFamilyOf('无限火力', 900), 'fun');
  assert.strictEqual(habits.modeFamilyOf('未知', 9999), 'other');
}

// 10) 按模式家族筛样本 + 分模式阈值: 大乱斗场均 9 次死亡不该按峡谷标准报"偏多"
{
  const riftGames = Array.from({ length: 10 }, () => ({ mode: '召唤师峡谷', queueId: 420, position: 'JUNGLE', champId: 1, d: 4, fb: false }));
  const aramGames = Array.from({ length: 10 }, () => ({ mode: '极地大乱斗', queueId: 450, position: '', champId: 1, d: 9, fb: false }));
  const mixed = [...riftGames, ...aramGames];

  const aramProfile = habits.buildHabitProfile(mixed, 'aram');
  assert.strictEqual(aramProfile.games, 10, '只取大乱斗样本');
  assert.strictEqual(aramProfile.avgDeaths, 9);
  assert.ok(!habits.habitItems(aramProfile).some(it => it.key === 'deaths'),
    '大乱斗场均 9 次死亡不该按峡谷的 6.5 阈值报警');

  const death12 = habits.buildHabitProfile(
    Array.from({ length: 12 }, () => ({ mode: '海克斯大乱斗', queueId: 2400, position: '', champId: 1, d: 12, fb: false })), 'aram');
  assert.strictEqual(habits.habitItems(death12).find(it => it.key === 'deaths').tone, 'warn',
    '大乱斗场均 12 次死亡才报偏多');

  const riftProfile = habits.buildHabitProfile(mixed, 'rift');
  assert.strictEqual(riftProfile.games, 10, '只取峡谷样本');
  assert.strictEqual(riftProfile.avgDeaths, 4);
  assert.ok(!habits.habitItems(riftProfile).some(it => it.key === 'deaths'), '峡谷场均 4 次不报警');

  // 'other' (判定不出模式) 不筛样本
  const all = habits.buildHabitProfile(mixed, 'other');
  assert.strictEqual(all.games, 20);
}

console.log('习惯卡判定测试通过');
