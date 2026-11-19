// 1.6.12 回归: LCU-match-v5 (日服/外服首页战绩走这条) 装备字段在 stats.item0..6,
// 而 normalizeGame 的 LCU 分支此前完全没读 items -> 战绩卡装备栏整排空。
// SGP SUMMARY 分支的装备在顶层 item0..6, 两条口径必须都产出 items。
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync('renderer/js/home.js', 'utf8');

// 静态: LCU 分支确实补了 stats.item0..6 读取
assert.ok(src.includes("[0, 1, 2, 3, 4, 5, 6].map(i => p.stats?.['item' + i])"), 'LCU 分支应读 stats.item0..6');
assert.ok(src.includes('items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6]'), 'SGP 分支顶层 item0..6 口径不应被破坏');

// 用最小沙箱截取 augmentIdsOf + perkPageOf/perkPageFields + normalizeGame 这几个纯函数
// (1.6.23 起 normalizeGame 会展开完整符文页, 缺这两个函数会在沙箱里 ReferenceError)
const aof = src.match(/function augmentIdsOf\(p\) \{[\s\S]*?\n\}/)[0];
const perk = src.match(/function perkPageOf\(p\) \{[\s\S]*?\n\}/)[0] + '\n'
  + src.match(/function perkPageFields\(p\) \{[\s\S]*?\n\}/)[0];
const ng = src.match(/function normalizeGame\(g, isSgp\) \{[\s\S]*?\n\}/)[0];
const ctx = {
  normalizeChampId: id => (+id >= 60000 ? +id - 60000 : +id),
  modeName: g => g.gameMode || '其他'
};
vm.runInNewContext(aof + '\n' + perk + '\n' + ng + '\nthis.ng = normalizeGame;', ctx);

// --- LCU-match-v5 形状 (日服实际): 装备在 stats.item0..6 ---
const lcuGame = {
  gameId: 613482272, queueId: 2400, gameMode: 'CLASSIC', gameDuration: 1200, gameCreation: 1700000000000,
  participantIdentities: [
    { participantId: 1, player: { puuid: 'me-puuid', gameName: '哈土奇', tagLine: 'JP1', profileIcon: 1 } }
  ],
  participants: [{
    participantId: 1, championId: 103, teamId: 100, spell1Id: 4, spell2Id: 7,
    stats: {
      kills: 10, deaths: 2, assists: 8, win: true, goldEarned: 15000, champLevel: 16,
      totalDamageDealtToChampions: 30000, totalDamageTaken: 12000, visionScore: 30,
      item0: 2503, item1: 3020, item2: 4645, item3: 4646, item4: 3089, item5: 1052, item6: 2052,
      playerAugment1: 1401, playerAugment2: 2116
    }
  }]
};
const boxed = v => JSON.parse(JSON.stringify(v)); // vm 沙箱数组跨 realm, 转回主上下文再深比
const lcuNorm = ctx.ng(lcuGame, false);
const lcuMe = lcuNorm.participants[0];
assert.deepStrictEqual(boxed(lcuMe.items), [2503, 3020, 4645, 4646, 3089, 1052, 2052], 'LCU 分支应按 stats.item0..6 产出完整 7 件装备');
assert.deepStrictEqual(boxed(lcuMe.augmentIds), [1401, 2116], 'LCU 分支海克斯仍应正常 (stats.playerAugment1..6)');
assert.strictEqual(lcuMe.puuid, 'me-puuid', 'puuid 仍从 participantIdentities 取');
assert.strictEqual(lcuMe.name, '哈土奇', '名字仍从 participantIdentities 取');

// item0..6 有 0 (空槽) 时过滤掉, 与 SGP 分支 filter(id>0) 口径一致
const lcuPartial = JSON.parse(JSON.stringify(lcuGame));
lcuPartial.participants[0].stats.item2 = 0;
lcuPartial.participants[0].stats.item6 = 0;
const partialItems = ctx.ng(lcuPartial, false).participants[0].items;
assert.deepStrictEqual(boxed(partialItems), [2503, 3020, 4646, 3089, 1052], '空槽(0)应被过滤');

// stats 整个缺失时 items 为空数组, 不抛错
const lcuNoStats = JSON.parse(JSON.stringify(lcuGame));
delete lcuNoStats.participants[0].stats;
assert.deepStrictEqual(boxed(ctx.ng(lcuNoStats, false).participants[0].items), [], '无 stats 时 items 为空数组');

// --- SGP 形状: 装备在顶层 item0..6, 口径不变 ---
const sgpGame = {
  gameId: 1, queueId: 2400, gameMode: 'CLASSIC', gameDuration: 1200, gameCreation: 1700000000000,
  participants: [{
    puuid: 'me-puuid', championId: 103, teamId: 100,
    item0: 1001, item1: 1002, item2: 0, item3: 1004, item4: 0, item5: 0, item6: 2052,
    playerAugment1: 1401, totalDamageDealtToChampions: 30000, goldEarned: 15000, deaths: 2
  }]
};
assert.deepStrictEqual(boxed(ctx.ng(sgpGame, true).participants[0].items), [1001, 1002, 1004, 2052], 'SGP 分支顶层 item0..6 口径不变');

console.log('test_lcu_game_items: 全部断言通过');
