'use strict';
// 载入侦察 + 车队视角: 分数必须带理由, 样本不足不给分, 强度差只算差值不下"胜率"结论。
const assert = require('assert');
const scout = require('./renderer/js/scout-report.js');
const fleet = require('./renderer/js/fleet.js');

function recent(n, wins, over) {
  return Array.from({ length: n }, (_, i) => Object.assign({ win: i < wins, k: 8, d: 3, a: 6, champId: 103 }, over || {}));
}
function P(name, team, opt) {
  return Object.assign({ name, team, puuid: 'p-' + name, position: 'MIDDLE', rank: 'GOLD II', championId: 103, recent: recent(20, 10) }, opt || {});
}

const players = [
  P('我', 100, { puuid: 'me' }),
  P('队友A', 100), P('队友B', 100), P('队友C', 100), P('队友D', 100),
  P('强敌', 200, { recent: recent(20, 17), rank: 'DIAMOND I' }),
  P('弱敌', 200, { recent: recent(20, 3) }),
  P('普通1', 200), P('普通2', 200), P('样本少', 200, { recent: recent(2, 2) })
];

const rep = scout.build(players, { selfPuuid: 'me', champName: () => '亚索' });
assert.ok(rep.ready, '应能生成报告');
assert.strictEqual(rep.enemies.length, 5);
assert.strictEqual(rep.mates.length, 5);

// ① 威胁分: 强敌 > 普通 > 弱敌; 样本不足的敌人不给分
const byName = Object.fromEntries(rep.enemies.map(e => [e.name, e]));
assert.ok(byName['强敌'].threat > byName['普通1'].threat, '胜率高的威胁分应更高');
assert.ok(byName['弱敌'].threat < byName['普通1'].threat);
assert.strictEqual(byName['样本少'].threat, null, '不到 5 场不给威胁分');

// ② 每个分数都带理由
assert.ok(byName['强敌'].reasons.length > 0 && byName['强敌'].reasons.join().includes('胜率'));

// ③ 最该盯 = 敌方威胁最高的人
assert.strictEqual(rep.watch.name, '强敌');
assert.ok(/%/.test(rep.bans[0].reason) || /威胁/.test(rep.bans[0].reason), 'ban 理由要带证据');

// ④ 强度差: 只给差值, 不给胜率
assert.ok(typeof rep.diff === 'number');
assert.ok(['明显占优', '略占优', '基本持平', '略吃亏', '明显吃亏'].includes(rep.verdict));
assert.ok(!/胜率 *\d+%/.test(rep.verdict), 'verdict 不能伪装成胜率预测');
assert.ok(scout.html(rep).indexOf('不是胜率预测') > 0, '页面必须写清不是胜率预测');

// ⑤ 没有自己的队伍时明确说原因
const noTeam = scout.build(players, { selfPuuid: '不存在' });
assert.strictEqual(noTeam.ready, false);
assert.ok(noTeam.reason);

// ⑥ 连败识别
assert.deepStrictEqual(scout.streakOf([{ win: false }, { win: false }, { win: true }]), { type: 'loss', n: 2 });
assert.deepStrictEqual(scout.streakOf([{ win: true }]), { type: '', n: 1 });

// ---------- 阵容缺口 (1.6.36 起只留一行, 不再有成员列表/分组) ----------
const team = players.slice(0, 5);
// 全员法师 → 没有前排 / 缺硬辅 / 缺输出
const view = fleet.build(team, { selfTeam: 100, tags: () => ['Mage'] });
assert.ok(view.ready);
assert.deepStrictEqual(view.gaps.join('|'), '没有前排|缺硬辅|缺输出');
assert.strictEqual(view.size, 5);
assert.ok(view.warnings.some(w => w.includes('没有前排')), '完整句子要留着做 title');
// 不再产出被砍掉的东西: 成员列表 / 分组 / 团队合并胜率
assert.strictEqual(view.members, undefined, '成员明细已砍 (十人卡里有同一份数据)');
assert.strictEqual(view.groups, undefined, '分组已砍 (十人卡已有组1/组2 标签)');
assert.strictEqual(view.wr, undefined, '团队合并胜率已砍 (同队五人样本相关, 不是独立样本)');

// 有坦克 + ADC 时不再报前排/输出, 但"全物理伤害"仍该报
const mixed = fleet.build(team.map((p, i) => Object.assign({}, p, { championId: i })), {
  selfTeam: 100, tags: id => (Number(id) === 0 ? ['Tank'] : ['Marksman'])
});
assert.deepStrictEqual(mixed.gaps, ['伤害单一'], '一队全物理仍要提示伤害类型单一');

// 五个位置结构齐全时不该再报任何缺口, 也就不占那一行
const FULL = [['Tank'], ['Mage'], ['Marksman'], ['Support'], ['Assassin']];
const full = fleet.build(team.map((p, i) => Object.assign({}, p, { championId: i })), {
  selfTeam: 100, tags: id => FULL[Number(id)] || []
});
assert.strictEqual(full.gaps.length, 0, '阵容齐了就不报缺口');
assert.strictEqual(fleet.gapLine(full, { mode: 'rift' }), '', '没缺口就不占地方');

// 人数不足时明确不给结论
assert.strictEqual(fleet.build([P('独狼', 100)], { selfTeam: 100 }).ready, false);
assert.strictEqual(fleet.gapLine({ ready: false }), '', '数据没齐时不出空壳');

// 只有峡谷才提示: 大乱斗/斗魂的阵容是系统随机的, 谈"缺前排"是废话
assert.ok(fleet.gapLine(view, { mode: 'rift' }).includes('阵容缺口'));
assert.ok(fleet.gapLine(view, { mode: 'rift' }).includes('没有前排'));
assert.strictEqual(fleet.gapLine(view, { mode: 'aram' }), '', '海斗/极地不提示');
assert.strictEqual(fleet.gapLine(view, { mode: 'arena' }), '', '斗魂不提示');
assert.strictEqual(fleet.gapLine(view, { mode: 'fun' }), '', '无限火力不提示');
assert.ok(fleet.gapLine(view).includes('阵容缺口'), '不传 mode 时默认显示');

// 一行, 不是卡片: 不能出现卡片外框/折叠开关那些旧结构
const line = fleet.gapLine(view, { mode: 'rift' });
assert.ok(!/ft-card|ft-head|toggleFleetCard|ft-members/.test(line), '不该再输出旧面板结构');
assert.ok(line.indexOf('按英雄标签粗判') > 0, 'title 要写清口径');

console.log('test_scout_fleet: OK');
