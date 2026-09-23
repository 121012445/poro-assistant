'use strict';

const assert = require('assert');
const { normalizeChampionData } = require('./main/aramkit');

const data = normalizeChampionData({
  champion: { rank: 7, tier: 'A', stats: { winRate: 0.4977, sampleCount: 4117141, kda: 3.21 } },
  summoners: [{ rank: 1, spells: [{ id: 4 }, { id: 1 }], sampleCount: 1000, pickRate: 0.5, winRate: 0.51 }],
  skills: [{ rank: 1, order: 'Q>E>W', sampleCount: 900, pickRate: 0.45, winRate: 0.52 }],
  augments: { all: [
    { id: 2095, winRate: 0.6164, sampleCount: 81818, pickRate: 0.0209, rank: 1 },
    { id: 1092, winRate: 0.5573, sampleCount: 948100, pickRate: 0.2422, rank: 2 },
    { id: -1, winRate: 2, sampleCount: 1 }
  ], stages: { 1: [{ id: 2095, tier: 'S', winRate: 0.6536, sampleCount: 59813, pickRate: 0.0121, rank: 1 }] } },
  augmentCombinations: [{ rank: 1, augmentIds: [1092, 2095], sampleCount: 21720, pickRate: 0.0043, winRate: 0.6749 }],
  items: { filtered: { sampleCount: 100, pickRate: 0.5, all: [{ id: 3031, rank: 1, sampleCount: 80, pickRate: 0.4, winRate: 0.55 }], slots: {} } },
  builds: { filtered: { archetypes: [{ key: 'crit', rank: 1, sampleCount: 1000, pickRate: 0.8, winRate: 0.51, calibratedWinRate: 0.53, profiles: [{ itemSet: [{ id: 6676 }, { id: 3031 }, { id: 6696 }] }] }] } }
}, 236, { version: '16.18', dataDate: '2026-09-18', allMatches: 31104446, highMatches: 2000000 }, 'high');

assert.strictEqual(data.championId, 236);
assert.strictEqual(data.version, '16.18');
assert.strictEqual(data.championGames, 4117141);
assert.strictEqual(data.augments[2095].winRate, 0.6164);
assert.strictEqual(data.augments[1092].games, 948100);
assert.strictEqual(data.augments[1092].lift.toFixed(4), '0.0596');
assert.strictEqual(Object.keys(data.augments).length, 2, '非法强化数据应被丢弃');
assert.strictEqual(data.scope, 'high');
assert.strictEqual(data.augmentStages['1'][2095].winRate, 0.6536);
assert.deepStrictEqual(data.augmentCombinations[0].augmentIds, [1092, 2095]);
assert.deepStrictEqual(data.summoners[0].spellIds, [4, 1]);
assert.strictEqual(data.skills[0].order, 'Q>E>W');
assert.strictEqual(data.items.filtered.all[0].id, 3031);
assert.deepStrictEqual(data.builds.filtered[0].itemIds, [6676, 3031, 6696]);
console.log('ARAMKit 胜率数据归一化测试通过');
