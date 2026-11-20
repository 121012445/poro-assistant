'use strict';
// 技能计时: 只列敌方, 冷却换算正确, 倒计时到 0 变就绪。
const assert = require('assert');
const cd = require('./renderer/js/game-cd.js');

// ① 技能基础冷却 (中英文名都能认)
assert.strictEqual(cd.spellCd('闪现'), 300);
assert.strictEqual(cd.spellCd('Flash'), 300);
assert.strictEqual(cd.spellCd('传送'), 360);
assert.strictEqual(cd.spellCd('引燃'), 180);
assert.strictEqual(cd.spellCd('惩戒'), 15);
assert.strictEqual(cd.spellCd('未知技能'), null);
assert.strictEqual(cd.spellCd(''), null);

// ② 数字 id 兜底 (选人阶段 participants 只给 id)
assert.strictEqual(cd.spellById(4), '闪现');
assert.strictEqual(cd.spellById(12), '传送');
assert.strictEqual(cd.spellById(9999), '');

// ③ 技能急速: 50 急速 → 300 * 100/150 = 200
assert.strictEqual(cd.applyHaste(300, 50), 200);
assert.strictEqual(cd.applyHaste(300, 0), 300);
assert.strictEqual(cd.applyHaste(0, 50), null);

// ④ 大招冷却从 DDragon 条目取
assert.strictEqual(cd.ultCdOf({ spells: [null, null, null, { cooldown: [120, 100, 80] }] }), 120);
assert.strictEqual(cd.ultCdOf({ spells: [null, null, null, { cooldown: [120] }] }, 20), 100);
assert.strictEqual(cd.ultCdOf({}), null);
assert.strictEqual(cd.ultCdOf(null), null);

// ⑤ 只列敌方 5 人
const players = [
  { name: '我', team: 100, puuid: 'me', spells: ['闪现', '传送'], championId: 103 },
  { name: '敌人1', team: 200, puuid: 'e1', spells: ['闪现', '引燃'], championId: 103 },
  { name: '敌人2', team: 200, puuid: 'e2', spellIds: [4, 12], championId: 103 },
  { name: '人机', team: 200, puuid: 'bot', isBot: true }
];
const rows = cd.rowsFor(players, {
  selfTeam: 100,
  champOf: () => ({ name: '亚索', id: 'Yasuo', champion: { name: '亚索', id: 'Yasuo', spells: [null, null, null, { cooldown: [80] }] } })
});
assert.strictEqual(rows.length, 2, '自己和 BOT 都不该出现在计时条里');
assert.strictEqual(rows[0].spells[0].cd, 300);
assert.strictEqual(rows[0].ult.cd, 80);
assert.strictEqual(rows[1].spells[0].name, '闪现', '数字 id 应被翻成名字');
assert.strictEqual(rows[1].spells[1].cd, 360);

// ⑥ 倒计时状态
const now = 1000000;
assert.strictEqual(cd.stateOf(null, 300, now).ready, true);
const cooling = cd.stateOf(now - 10000, 300, now);
assert.strictEqual(cooling.ready, false);
assert.strictEqual(cooling.remaining, 290);
assert.strictEqual(cooling.text, '4:50');
assert.strictEqual(cd.stateOf(now - 300000, 300, now).ready, true, '到点即就绪');
assert.strictEqual(cd.stateOf(now - 299000, 300, now).remaining, 1, '最后一秒显示 1');
assert.strictEqual(cd.stateOf(now - 299000, 300, now).ready, false);

console.log('test_game_cd: OK');
