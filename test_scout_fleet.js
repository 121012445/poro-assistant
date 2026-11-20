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

// ---------- 车队 ----------
const team = players.slice(0, 5).map((p, i) => Object.assign({}, p, { premadeGroupId: i < 3 ? 'g1' : null }));
const view = fleet.build(team, { selfTeam: 100, champName: () => '亚索', tags: () => ['Mage'] });
assert.ok(view.ready);
assert.strictEqual(view.partySize, 3, '3 人开黑');
const g1 = view.groups.find(g => g.size === 3);
assert.ok(g1 && g1.label === '开黑1');
assert.strictEqual(view.wr, 50, '五人 20 场 10 胜');
// 全员法师 → 提示缺前排与持续输出
assert.ok(view.warnings.some(w => w.includes('没有前排')), '应提示没有前排');
assert.ok(view.warnings.some(w => w.includes('持续输出')), '应提示缺少持续输出点');

// 有坦克 + ADC 时不该再报缺口
const mixed = fleet.build(team.map((p, i) => Object.assign({}, p, { championId: i })), {
  selfTeam: 100, champName: () => '', tags: id => (Number(id) === 0 ? ['Tank'] : ['Marksman'])
});
assert.ok(!mixed.warnings.some(w => w.includes('没有前排')));
assert.ok(!mixed.warnings.some(w => w.includes('持续输出')));

// 人数不足时明确不给面板
assert.strictEqual(fleet.build([P('独狼', 100)], { selfTeam: 100 }).ready, false);

// ---------- 车队默认折叠: 只保留一条摘要 ----------
assert.ok(view.gaps.some(g => g === '没有前排'), 'gaps 要给折叠条用的短标签');
assert.ok(view.gaps.every(g => g.length <= 5), '短标签不能太长, 折叠条排不下');
const folded = fleet.html(view, { collapsed: true });
const open = fleet.html(view);
assert.ok(folded.includes('ft-card collapsed'), '折叠态要带 collapsed 类');
assert.ok(open.includes('ft-card') && !open.includes('ft-card collapsed'), '展开态默认不带 collapsed');
assert.ok(folded.includes('toggleFleetCard(this)'), '折叠条要能点开');
assert.ok(folded.includes(`团队 <b>${view.games}</b> 场`), '折叠时仍要给出团队样本量');
assert.ok(folded.includes('没有前排'), '折叠时仍要露出首个缺口');
assert.ok(folded.includes('展开') && open.includes('收起'), '开关文案要跟着状态走');
// 缺口多于一个时折叠成 "+N", 不把整排句子塞进标题条
assert.ok(folded.includes('+' + (view.gaps.length - 1)) || view.gaps.length === 1);
assert.ok(!fleet.html({ ready: false }, { collapsed: true }), '数据没齐时不出空壳');

console.log('test_scout_fleet: OK');
