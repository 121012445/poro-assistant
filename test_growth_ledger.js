'use strict';
// 战绩库「伤害占比 / 参团」整列恒为 0% 的回归测试。
//
// 用户截图: 成长页战绩库 121 场, 每行右侧两列全是 0%, 顶部汇总也是「伤害占比 0% · 参团 0%」。
// 根因是两层 bug 叠在一起:
//   ① 写入端 compactGame 用 x.team 分阵营, 但历史战绩 (LCU/SGP) 给的字段是 teamId ——
//      队友全部失配, team 变成空数组, 分母恒为 0, dmg/kp 只能存 null;
//   ② 读取端把 null 画成了 0%: +null === 0 且 Number.isFinite(0) 为真,
//      于是「这一局没有分母」被显示成「这局伤害占比真的是 0」, 把 ① 完全掩盖了。
// 这个文件同时守两件事: 分队字段必须兼容 teamId, null 不许被当成 0 参与统计与展示。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const Growth = require('./renderer/js/growth-model.js');
const Insights = require('./renderer/js/live-insights.js');

// 一场标准的历史战绩: 阵营只有 teamId, 没有 team (和 home.js 归一化后一致)
function mkGame(over) {
  const g = {
    gid: 'g-1', time: 1700000000000, queueId: 420, dur: 1800, mode: 'CLASSIC',
    participants: [
      { puuid: 'me', championId: 86, position: 'TOP', teamId: 100, win: true, k: 3, d: 2, a: 6, cs: 200, dmg: 30000, gold: 12000, visionScore: 20 },
      { puuid: 'm2', championId: 64, position: 'JUNGLE', teamId: 100, win: true, k: 9, d: 5, a: 4, cs: 150, dmg: 20000, gold: 10000, visionScore: 15 },
      { puuid: 'e1', championId: 103, position: 'MID', teamId: 200, win: false, k: 7, d: 7, a: 4, cs: 120, dmg: 45000, gold: 9000, visionScore: 10 }
    ]
  };
  return Object.assign(g, over || {});
}

// 1. 分队必须认 teamId —— 这正是用户那 121 场全 0% 的根因
{
  const rec = Growth.compactGame(mkGame(), 'me', null);
  assert.ok(rec, 'compactGame 要能产出记录');
  // 本队伤害 30000+20000=50000 -> 30000/50000 = 60%
  assert.strictEqual(rec.dmg, 60, '伤害占比要按本队总量算 (30000/50000=60%), 不能是 null/0');
  // 本队击杀 3+9=12 -> (3+6)/12 = 75%
  assert.strictEqual(rec.kp, 75, '参团率要按本队击杀算 ((3+6)/12=75%)');
  // 本队经济 12000+10000=22000 -> 12000/22000 = 55%
  assert.strictEqual(rec.gld, 55, '经济占比同样按本队总量算');
  // 敌方伤害不能算进分母
  assert.ok(rec.dmg !== 40, '分母只能是本队, 敌方 45000 不能计入');
}

// 2. 两套阵营字段都要认 (实时对局给 team, 历史战绩给 teamId)
{
  const withTeam = mkGame();
  withTeam.participants = withTeam.participants.map(p => {
    const { teamId, ...rest } = p;
    return { ...rest, team: teamId };
  });
  const rec = Growth.compactGame(withTeam, 'me', null);
  assert.strictEqual(rec.dmg, 60, '只给 team 字段 (实时对局口径) 时也要能算出伤害占比');
  assert.strictEqual(rec.kp, 75, '只给 team 字段时参团率也要正确');
}

// 3. 拿不到阵营就输出 null, 不许猜。猜"全队只有我"会得到 100%, 比 null 更误导
{
  const g = mkGame();
  g.participants = g.participants.map(p => {
    const { teamId, ...rest } = p;
    return rest;
  });
  const rec = Growth.compactGame(g, 'me', null);
  assert.strictEqual(rec.dmg, null, '阵营不可知时 dmg 必须是 null (不能是 0 也不能是 100)');
  assert.strictEqual(rec.kp, null, '阵营不可知时 kp 必须是 null');
  assert.strictEqual(rec.gld, null, '阵营不可知时 gld 必须是 null');
  assert.strictEqual(rec.k, 3, '自己的 KDA 不依赖分母, 必须照常记录');
}

// 4. teamId=0 是上游"拿不到阵营"的兜底值, 必须当未知, 不能当"一队"
{
  const g = mkGame();
  g.participants = g.participants.map(p => ({ ...p, teamId: 0 }));
  const rec = Growth.compactGame(g, 'me', null);
  assert.strictEqual(rec.dmg, null, 'teamId 全为 0 时不能把十人算成一队 (会得到约 10% 的假占比)');
  assert.strictEqual(rec.kp, null, '参团同理');
}

// 5. 统计: null 不参与均值, 也不许把均值拉成 0
{
  const s = Insights.ledgerStats([
    { w: true, k: 1, d: 1, a: 1, dmg: null, kp: null, vis: null },
    { w: false, k: 1, d: 2, a: 1, dmg: null, kp: null, vis: null }
  ]);
  assert.strictEqual(s.dmgN, 0, '全是 null 时 dmgN 必须是 0 (不代表"两场都测到了 0%")');
  assert.strictEqual(s.dmgAvg, null, '没有样本时均值必须是 null, 显示端才会留空');
  assert.strictEqual(s.kpAvg, null, '参团同理');
  assert.strictEqual(s.dmgAvg === 0, false, '绝不能把 null 算成 0');

  const mixed = Insights.ledgerStats([
    { w: true, k: 1, d: 1, a: 1, dmg: null, kp: null },
    { w: true, k: 1, d: 1, a: 1, dmg: 60, kp: 80 }
  ]);
  assert.strictEqual(mixed.dmgN, 1, '只有一局有值, 样本数应为 1');
  assert.strictEqual(mixed.dmgAvg, 60, '均值只能拿有值的场次算');
  assert.strictEqual(mixed.kpAvg, 80, '参团同样只算有值的场次');
}

// 5. 回填: 老台账里 dmg/kp 是 null, 同 id 的新数据要能补上 (否则那批旧局永远 0%/—)
{
  const oldRec = { id: 'g-1', t: 1700000000000, q: 420, c: 86, w: 1, k: 3, d: 2, a: 6, dmg: null, kp: null, gld: null };
  const r = Growth.mergeLedger([oldRec], [mkGame()], 'me', null, 1700000000000);
  const got = r.records.find(x => x.id === 'g-1');
  assert.strictEqual(got.dmg, 60, '旧记录的 dmg 要能被回填');
  assert.strictEqual(got.kp, 75, '旧记录的 kp 要能被回填');
  assert.strictEqual(r.added, 0, '同 id 不算新增');
  assert.ok(r.filled >= 1, '回填必须上报 filled, 否则 growthRecordGames 不会落盘');
}

// 6. 回填只补空, 不许覆盖已有有效值 (两套口径不能互相改历史)
{
  const oldRec = { id: 'g-1', t: 1700000000000, q: 420, c: 86, w: 1, k: 3, d: 2, a: 6, dmg: 42, kp: 42, gld: 42 };
  const r = Growth.mergeLedger([oldRec], [mkGame()], 'me', null, 1700000000000);
  const got = r.records.find(x => x.id === 'g-1');
  assert.strictEqual(got.dmg, 42, '已有有效值不能被重算值覆盖');
  assert.strictEqual(got.kp, 42, '参团同理');
}

// 7. 展示端: null 必须画成「—」, 不能画成 0%
{
  const src = fs.readFileSync(path.join(__dirname, 'renderer/js/growth.js'), 'utf8');
  const a = src.indexOf('function growthHistoryHtml(');
  const b = src.indexOf('function renderGrowthPage(');
  assert.ok(a >= 0 && b > a, 'growthHistoryHtml 必须存在');

  const ctx = {
    console,
    PoroInsights: Insights,
    GW_FAM_LABEL: { rift: '峡谷', aram: '极地', mayhem: '海斗', arena: '斗魂' },
    escapeHtml: s => String(s == null ? '' : s),
    growthChampName: id => '英雄' + id,
    growthChampImg: () => '',
    growthHistState: { champId: 0, family: '', win: '', days: 0 },
    growthHistLimit: 40
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(a, b), ctx);

  // 三局: 一局有值, 两局是 null
  const html = ctx.growthHistoryHtml([
    { id: 'a', t: 1700000000000, q: 420, c: 86, w: 1, k: 3, d: 2, a: 6, dmg: 60, kp: 75 },
    { id: 'b', t: 1699000000000, q: 420, c: 86, w: 1, k: 3, d: 2, a: 6, dmg: null, kp: null },
    { id: 'c', t: 1698000000000, q: 420, c: 86, w: 0, k: 1, d: 9, a: 2, dmg: null, kp: null }
  ]);
  assert.ok(html.includes('60%'), '有值的局要正常显示百分比');
  assert.ok(html.includes('75%'), '参团同理');
  assert.ok(!/>0%</.test(html), 'null 不许被渲染成 0% —— 这是把缺失伪装成真实数据');
  assert.ok((html.match(/—/g) || []).length >= 4, '四列 null 都要显示 — (两局 × 两列)');

  // 顶部汇总: 有样本才显示, 且只按有值的场次算
  assert.ok(html.includes('伤害占比 60%'), '汇总要按有值的场次算');
  assert.ok(html.includes('参团 75%'), '参团汇总同理');
}

// 8. 源码级门禁: 别再把 null 直接喂给 Number.isFinite(+x)
{
  const gi = fs.readFileSync(path.join(__dirname, 'renderer/js/growth.js'), 'utf8');
  assert.ok(!/Number\.isFinite\(\+r\.(dmg|kp)\)/.test(gi), 'growth.js 不许直接用 Number.isFinite(+r.dmg) 判空');
  const li = fs.readFileSync(path.join(__dirname, 'renderer/js/live-insights.js'), 'utf8');
  assert.ok(!/Number\.isFinite\(\+r\.(dmg|kp|vis)\)/.test(li), 'ledgerStats 不许把 null 当 0 计入');
  const gm = fs.readFileSync(path.join(__dirname, 'renderer/js/growth-model.js'), 'utf8');
  assert.ok(!/\+\s*x\.team\s*===\s*\+\s*me\.team/.test(gm), 'compactGame 不许只认 team 字段');
}

console.log('test_growth_ledger: all assertions passed');
