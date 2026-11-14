'use strict';
// 重复失误判定 (renderer/js/repeat-mistakes.js) 的回归测试。
// 重点: 按模式分流 —— 大乱斗/海斗/斗魂里不能出现"视野/补刀/带线/资源"这类峡谷专属判定,
// 阈值也要按模式分开 (大乱斗一场死得更多)。
const assert = require('assert');
const path = require('path');
const M = require(path.join(__dirname, '..', 'renderer', 'js', 'repeat-mistakes.js'));

const RIFT = { mode: '召唤师峡谷', queueId: 420 };
const ARAM = { mode: '极地大乱斗', queueId: 450 };
const MAYHEM = { mode: '海克斯大乱斗', queueId: 2400 };
const ARENA = { mode: '斗魂竞技场', queueId: 1700 };

function game(over) {
  const me = {
    puuid: 'me', teamId: 100, position: 'MIDDLE',
    k: 3, d: 4, a: 6, cs: 200, visionScore: 25, dmg: 20000, dmgTaken: 15000, ...(over.me || {})
  };
  const mates = [
    me,
    { puuid: 'a', teamId: 100, k: 5, d: 3, a: 5, cs: 180, visionScore: 30, dmg: 22000, dmgTaken: 18000 },
    { puuid: 'b', teamId: 100, k: 4, d: 5, a: 8, cs: 160, visionScore: 22, dmg: 18000, dmgTaken: 20000 }
  ];
  const foes = [
    { puuid: 'x', teamId: 200, k: 6, d: 2, a: 4, cs: 210, visionScore: 28, dmg: 21000 },
    { puuid: 'y', teamId: 200, k: 2, d: 6, a: 7, cs: 150, visionScore: 19, dmg: 17000 }
  ];
  return {
    gid: over.gid || 1,
    dur: over.dur != null ? over.dur : 1800,
    mode: (over.mode || RIFT.mode), queueId: over.queueId != null ? over.queueId : RIFT.queueId,
    participants: [...mates, ...foes],
    teamsObj: over.teamsObj || null
  };
}

// 1) 短局不判定
assert.deepStrictEqual(M.detect(game({ dur: 420, me: { d: 12, visionScore: 1 } }), 'me'), [], '10 分钟以下不判定');

// 2) 模式判定
{
  assert.strictEqual(M.classifyMode(game({})), 'rift');
  assert.strictEqual(M.classifyMode(game(ARAM)), 'aram');
  assert.strictEqual(M.classifyMode(game(MAYHEM)), 'mayhem');
  assert.strictEqual(M.classifyMode(game(ARENA)), 'arena');
  assert.strictEqual(M.classifyMode({ mode: '无限火力', queueId: 900 }), 'fun');
  assert.strictEqual(M.classifyMode({ mode: '未知模式', queueId: 0 }), 'unknown');
}

// 3) 峡谷: 五类判定都可用 (一次最多返回 3 条, 所以分组验证)
{
  const out = M.detect(game({ me: { d: 9, visionScore: 8, k: 0, a: 0 } }), 'me');
  const keys = out.map(x => x.key);
  assert.strictEqual(out[0].key, 'deaths', '最严重的是高阵亡');
  assert.ok(keys.includes('vision'), '峡谷应判视野');
  assert.ok(keys.includes('kp'), '峡谷应判参团');
  assert.ok(out.length <= 3, '一次最多 3 条');
  // 补刀单独立一条 (上面三条已经占满 3 个位置)
  const csOnly = M.detect(game({ me: { d: 2, visionScore: 40, k: 10, a: 10, cs: 90 } }), 'me');
  assert.ok(csOnly.some(x => x.key === 'cs'), '峡谷应判补刀');
  assert.match(csOnly.find(x => x.key === 'cs').evidence, /分均补刀 3/);
}

// 4) 大乱斗: 不判视野/补刀/资源, 参团文案要提"一直在打团"
{
  const out = M.detect(game({ ...ARAM, me: { d: 5, visionScore: 1, k: 0, a: 0, cs: 40 } }), 'me');
  const keys = out.map(x => x.key);
  assert.ok(!keys.includes('vision'), '大乱斗不该判视野');
  assert.ok(!keys.includes('cs'), '大乱斗不该判补刀');
  assert.ok(!keys.includes('objectives'), '大乱斗没有小龙/大龙, 不该判资源');
  const kp = out.find(x => x.key === 'kp');
  assert.ok(kp, '大乱斗仍可判参团');
  assert.match(kp.tip || M.tipOf('kp', 'aram'), /打团/);
  assert.ok(!/带线/.test(M.tipOf('kp', 'aram')), '大乱斗文案不得提"带线"');
  assert.ok(!/视野/.test(M.tipOf('kp', 'aram')), '大乱斗文案不得提"视野"');
}

// 5) 阈值按模式分开: 大乱斗 11 次不报, 12 次才报; 峡谷 8 次就报
{
  assert.ok(!M.detect(game({ ...ARAM, me: { d: 11 } }), 'me').some(x => x.key === 'deaths'), '大乱斗 11 次阵亡不提示');
  assert.ok(M.detect(game({ ...ARAM, me: { d: 12 } }), 'me').some(x => x.key === 'deaths'), '大乱斗 12 次才提示');
  assert.ok(M.detect(game({ me: { d: 8 } }), 'me').some(x => x.key === 'deaths'), '峡谷 8 次就提示');
}

// 6) 海斗: 伤害占比 <10% 且不是坦克 -> 伤害占比低; 文案不提视野
{
  const out = M.detect(game({ ...MAYHEM, me: { dmg: 2000, dmgTaken: 1800 } }), 'me');
  const dmg = out.find(x => x.key === 'dmg');
  assert.ok(dmg, '海斗应判伤害占比');
  assert.strictEqual(dmg.modeLabel, '海斗');
  assert.ok(!/视野|补刀/.test(dmg.tip));
  // 坦克 (承伤远大于输出) 不判
  assert.ok(!M.detect(game({ ...MAYHEM, me: { dmg: 2000, dmgTaken: 30000 } }), 'me').some(x => x.key === 'dmg'), '坦克不判伤害占比');
}

// 7) 斗魂: 只判阵亡
{
  const out = M.detect(game({ ...ARENA, me: { d: 11, visionScore: 0, k: 0, a: 0, cs: 10, dmg: 1000 } }), 'me');
  assert.deepStrictEqual(out.map(x => x.key), ['deaths'], '斗魂只判阵亡');
}

// 8) 台账: 同 gid 覆盖, 新的在前, 有上限, 带模式
{
  let rows = [];
  rows = M.mergeLedger(rows, 1, ['deaths'], 1000, 3, 'rift');
  rows = M.mergeLedger(rows, 2, ['kp'], 2000, 3, 'aram');
  rows = M.mergeLedger(rows, 1, ['deaths', 'vision'], 1000, 3, 'rift');
  assert.deepStrictEqual(rows.map(r => r.gid), ['2', '1'], '同 gid 不重复');
  assert.deepStrictEqual(rows[1].keys, ['deaths', 'vision'], '同 gid 覆盖为最新判定');
  assert.strictEqual(rows[1].m, 'rift', '台账要记模式');
  rows = M.mergeLedger(rows, 3, ['cs'], 3000, 3, 'rift');
  rows = M.mergeLedger(rows, 4, ['cs'], 4000, 3, 'rift');
  assert.deepStrictEqual(rows.map(r => r.gid), ['4', '3', '2'], '超过上限只留最近的');
}

// 9) 汇总: 同一规则不同模式分开统计; 按模式过滤
{
  let rows = [];
  rows = M.mergeLedger(rows, 1, ['deaths'], 100, 60, 'rift');
  rows = M.mergeLedger(rows, 2, ['deaths'], 200, 60, 'rift');
  rows = M.mergeLedger(rows, 3, ['deaths'], 300, 60, 'mayhem');
  rows = M.mergeLedger(rows, 4, ['deaths'], 400, 60, 'mayhem');
  rows = M.mergeLedger(rows, 5, ['deaths'], 500, 60, 'mayhem');
  const all = M.summarize(rows);
  const mayhem = all.find(r => r.key === 'deaths' && r.mode === 'mayhem');
  const rift = all.find(r => r.key === 'deaths' && r.mode === 'rift');
  assert.strictEqual(mayhem.count, 3);
  assert.strictEqual(mayhem.status, 'habit');
  assert.strictEqual(rift.count, 2);
  assert.strictEqual(rift.status, 'watch');
  const filtered = M.summarize(rows, { mode: 'mayhem' });
  assert.deepStrictEqual(filtered.map(r => r.mode + ':' + r.key), ['mayhem:deaths'], '按模式过滤后只剩海斗');
}

// 10) 曾经的习惯最近消失 -> 已改掉
{
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ gid: 'n' + i, at: 100 - i, m: 'rift', keys: [] });
  for (let i = 0; i < 4; i++) rows.push({ gid: 'o' + i, at: 50 - i, m: 'rift', keys: ['deaths'] });
  const fixed = M.summarize(rows).find(r => r.key === 'deaths' && r.mode === 'rift');
  assert.strictEqual(fixed.status, 'fixed');
  assert.strictEqual(fixed.count, 0);
}

// 11) primaryOf 取最严重的一条
{
  const out = M.detect(game({ me: { d: 9, visionScore: 5 } }), 'me');
  assert.strictEqual(M.primaryOf(out).key, out[0].key);
  assert.strictEqual(M.primaryOf([]), null);
}

console.log('重复失误判定测试通过 (含按模式分流)');
