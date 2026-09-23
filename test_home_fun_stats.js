'use strict';
const assert = require('assert');
const { deriveHomeFunStats } = require('./renderer/js/home');

const base = new Date(2026, 8, 20, 20, 0, 0).getTime();
const rows = [
  { game: { dur: 1800, time: base + 4 * 3600000 }, me: { win: false, championId: 2, k: 3, d: 7, a: 8, dmg: 12000 } },
  { game: { dur: 2400, time: base + 3 * 3600000 }, me: { win: true, championId: 1, k: 12, d: 0, a: 9, dmg: 36000 } },
  { game: { dur: 2100, time: base + 2 * 3600000 }, me: { win: true, championId: 1, k: 8, d: 2, a: 11, dmg: 28000 } },
  { game: { dur: 1500, time: base + 1 * 3600000 }, me: { win: true, championId: 3, k: 6, d: 3, a: 7, dmg: 19000 } },
  { game: { dur: 1200, time: base }, me: { win: false, championId: 2, k: 2, d: 5, a: 5, dmg: 9000 } }
];

const stats = deriveHomeFunStats(rows);
assert.strictEqual(stats.sampleSize, 5);
assert.strictEqual(stats.longestWinStreak, 3, '应按连续对局计算最长连胜');
assert.strictEqual(stats.zeroDeaths, 1, '应统计零阵亡场次');
assert.strictEqual(stats.uniqueChampions, 3, '应统计近期不同英雄数');
assert.strictEqual(stats.maxDamage.value, 36000, '应找出单局最高英雄伤害');
assert.strictEqual(stats.maxDamage.championId, 1);
assert.strictEqual(stats.longestGame.seconds, 2400, '应找出最长对局');
assert.strictEqual(stats.luckyChampion.id, 1, '至少两场时应按胜率和场次选幸运英雄');
assert.strictEqual(stats.favoritePeriod.key, 'evening', '应按本地时间聚合活跃时段');

console.log('首页趣味数据计算测试通过');
