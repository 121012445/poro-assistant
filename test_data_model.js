'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const context = vm.createContext({ Date, Set, String, Number, Object });
vm.runInContext(fs.readFileSync('renderer/js/utils.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('renderer/js/data-model.js', 'utf8'), context);

context.raw = { puuid: 'p1', gameName: '测试', level: 16, profileIconId: 10 };
const participant = JSON.parse(vm.runInContext("JSON.stringify(normalizeSummonerProfile(raw, {source:'MATCH'}))", context));
assert.strictEqual(participant.summonerLevel, '', '对局英雄等级不能冒充账号等级');
assert.strictEqual(participant.dataMeta.partial, true);

context.base = { puuid: 'p1', gameName: '测试', summonerLevel: 200, dataMeta: { source: 'CACHE' } };
context.incoming = { puuid: 'p1', level: 16, summonerLevel: 0, __error: 'bad' };
const merged = JSON.parse(vm.runInContext("JSON.stringify(mergePlayerProfile(base, incoming, {source:'LCU'}))", context));
assert.strictEqual(merged.summonerLevel, 200, '无效新档案不得覆盖可靠等级');
assert.strictEqual(merged.__error, undefined);
assert.strictEqual(merged.dataMeta.source, 'LCU');

context.qm = {
  RANKED_SOLO_5x5: { tier: 'GOLD', wins: 10, losses: 8 },
  RANKED_FLEX_SR: { tier: 'EMERALD', wins: 5, losses: 1 }
};
assert.strictEqual(vm.runInContext("shouldShowRecentModeRow('单双排', qm)", context), false, '有当前赛段单双排时不应再显示近期重复行');
assert.strictEqual(vm.runInContext("shouldShowRecentModeRow('灵活组排', qm)", context), false, '有当前赛段灵活组排时不应再显示近期重复行');
assert.strictEqual(vm.runInContext("shouldShowRecentModeRow('海克斯大乱斗', qm)", context), true, '非排位模式仍应显示');
assert.strictEqual(vm.runInContext("shouldShowRecentModeRow('灵活组排', {})", context), true, '无赛段数据时应保留近期样本行');

context.flashSamples = Array.from({ length: 45 }, () => [4, 14]).concat(Array.from({ length: 2 }, () => [14, 4]));
const mixedFlash = JSON.parse(vm.runInContext('JSON.stringify(summarizeFlashPreference(flashSamples))', context));
assert.deepStrictEqual(mixedFlash, { d: 45, f: 2, total: 47, preferred: 'D', inconsistent: true });
context.flashSamples = [{ spells: [14, 4] }, { spell1Id: 12, spell2Id: 4 }, { stats: { spell1Id: 4, spell2Id: 7 } }];
const objectFlash = JSON.parse(vm.runInContext('JSON.stringify(summarizeFlashPreference(flashSamples))', context));
assert.deepStrictEqual(objectFlash, { d: 1, f: 2, total: 3, preferred: 'F', inconsistent: true });
assert.strictEqual(vm.runInContext('summarizeFlashPreference([[14, 12]])', context), null, '没有闪现时不应显示键位标签');

context.tagTeam = [
  { k: 2, d: 3, a: 18, dmg: 8000, dmgTaken: 7000, gold: 9000, healing: 12000, allyHeal: 8000, shielding: 5000, visionScore: 30, position: 'SUPPORT', win: true },
  { dmg: 24000, dmgTaken: 22000, gold: 10000, healing: 1000, visionScore: 8 },
  { dmg: 22000, dmgTaken: 20000, gold: 10000, healing: 500, visionScore: 7 },
  { dmg: 20000, dmgTaken: 18000, gold: 9500, healing: 700, visionScore: 6 },
  { dmg: 18000, dmgTaken: 16000, gold: 9000, healing: 600, visionScore: 5 }
];
context.tagPlayer = context.tagTeam[0];
const supportTags = JSON.parse(vm.runInContext('JSON.stringify(derivePerformanceTags(tagPlayer, tagTeam, 70, 9, 20))', context));
assert.ok(supportTags.some(tag => tag.label === '治疗给力'), '高治疗/护盾贡献应生成治疗给力标签');
assert.ok(!supportTags.some(tag => tag.label === '输出乏力'), '辅助位高治疗贡献不应被简单标记为输出乏力');
context.lowPlayer = { k: 1, d: 5, a: 4, dmg: 5000, dmgTaken: 5000, gold: 10000, healing: 100, visionScore: 4, position: 'MIDDLE', win: false };
context.lowTeam = [context.lowPlayer,
  { dmg: 30000, dmgTaken: 25000, gold: 10000 }, { dmg: 28000, dmgTaken: 24000, gold: 10000 },
  { dmg: 26000, dmgTaken: 23000, gold: 10000 }, { dmg: 22000, dmgTaken: 22000, gold: 10000 }];
const lowTags = JSON.parse(vm.runInContext('JSON.stringify(derivePerformanceTags(lowPlayer, lowTeam, 30, 5, 20))', context));
assert.ok(lowTags.some(tag => tag.label === '输出乏力'), '低于队均的输出应生成输出乏力标签');
assert.ok(lowTags.some(tag => tag.label === '承伤偏少'), '显著低于队均的承伤应生成承伤偏少标签');
context.convertPlayer = { k: 3, d: 4, a: 7, dmg: 14000, dmgTaken: 20000, gold: 10000, position: 'MIDDLE', win: false };
context.convertTeam = [context.convertPlayer,
  { dmg: 30000, dmgTaken: 25000, gold: 10000 }, { dmg: 28000, dmgTaken: 24000, gold: 10000 },
  { dmg: 26000, dmgTaken: 23000, gold: 10000 }, { dmg: 22000, dmgTaken: 22000, gold: 10000 }];
const convertTags = JSON.parse(vm.runInContext('JSON.stringify(derivePerformanceTags(convertPlayer, convertTeam, 45, 14, 20))', context));
assert.ok(convertTags.some(tag => tag.label === '伤转偏低'), '金币转化明显低于队均时应生成伤转偏低标签');
context.highConvertPlayer = { k: 10, d: 2, a: 9, dmg: 35000, dmgTaken: 18000, gold: 8000, position: 'MIDDLE', win: true };
context.highConvertTeam = [context.highConvertPlayer,
  { dmg: 21000, dmgTaken: 25000, gold: 10000 }, { dmg: 20000, dmgTaken: 24000, gold: 10000 },
  { dmg: 19000, dmgTaken: 23000, gold: 10000 }, { dmg: 18000, dmgTaken: 22000, gold: 10000 }];
const highConvertTags = JSON.parse(vm.runInContext('JSON.stringify(derivePerformanceTags(highConvertPlayer, highConvertTeam, 70, 31, 20))', context));
assert.ok(highConvertTags.some(tag => tag.label === '伤转高'), '伤害转化显著高于队均时应生成伤转高标签');

console.log('统一玩家数据模型测试通过');
