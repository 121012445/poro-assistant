'use strict';
// 批量功能回归:
//   ② 阵容教练按模式给规则（海斗不再说"带线/视野"）
//   底座 台账字段（伤害占比/参团/经济占比/视野/强化）
//   ①⑤⑥④ 接线（成长页两个新板块 / 实时页最该盯的人 + 简报）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(SRC, p), 'utf8');

// ---------- ② 阵容教练 ----------
{
  const ctx = vm.createContext({ escapeHtml: s => String(s == null ? '' : s), console });
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.runInContext(read('renderer/js/draft-coach.js'), ctx);
  const DC = ctx.PoroDraftCoach;
  assert.ok(DC, 'PoroDraftCoach 未挂载');

  const champs = {
    1: { tags: ['Assassin'] }, 2: { tags: ['Assassin'] }, 3: { tags: ['Assassin'] },
    4: { tags: ['Assassin'] }, 5: { tags: ['Assassin'] },
    9: { tags: ['Tank'] }, 10: { tags: ['Marksman'] }, 11: { tags: ['Mage'] },
    12: { tags: ['Support'] }, 13: { tags: ['Fighter'] }
  };
  const champOf = id => champs[id] || { tags: [] };
  const mk = (ids, team) => ids.map((id, i) => ({ puuid: team + '-' + i, team, championId: id }));

  // 5 个刺客、没有前排 -> 海斗规则
  const mayhem = DC.build(mk([1, 2, 3, 4, 5], 100).concat(mk([9, 10, 11, 12, 13], 200)), { selfTeam: 100, champOf, mode: 'mayhem' });
  assert.strictEqual(mayhem.fam, 'mayhem');
  assert.strictEqual(mayhem.modeLabel, '海克斯大乱斗');
  assert.ok(mayhem.gaps.some(g => g.includes('前排')), '应指出没有前排');
  assert.ok(mayhem.plan.length === 3, '应给 3 条行动, 实际 ' + mayhem.plan.length);
  assert.ok(mayhem.plan.some(p => p.includes('没有兵线')), '海斗应明确"没有兵线"');
  const mayhemText = mayhem.plan.join(' ');
  assert.ok(!/分推|边线|视野/.test(mayhemText), '海斗不应出现分推/边线/视野建议: ' + mayhemText);

  // 同一套阵容在峡谷 -> 出现视野/分推类建议
  const rift = DC.build(mk([1, 2, 3, 4, 5], 100).concat(mk([9, 10, 11, 12, 13], 200)), { selfTeam: 100, champOf, mode: 'rift' });
  assert.strictEqual(rift.fam, 'rift');
  assert.ok(rift.plan.some(p => p.includes('视野')), '峡谷应讲视野');
  assert.ok(!rift.plan.some(p => p.includes('血包')), '峡谷不应提血包');

  // 有前排的海斗: 第一条建议应转成"可以主动开团"
  const tanky = DC.build(mk([9, 13, 10, 11, 12], 100).concat(mk([1, 2, 3, 4, 5], 200)), { selfTeam: 100, champOf, mode: 'mayhem' });
  assert.ok(tanky.plan[0].includes('主动'), '有前排时应建议主动开团: ' + tanky.plan[0]);

  const html = DC.render(mayhem);
  assert.ok(html.includes('阵容教练') && html.includes('海克斯大乱斗'), '渲染缺标题/模式');
  assert.ok((html.match(/class="dc-num"/g) || []).length === 3, '渲染应有 3 条行动');
}

// ---------- 底座: 台账字段 ----------
{
  const Growth = require(path.join(SRC, 'renderer/js/growth-model.js'));
  const game = {
    gid: 'G1', time: Date.UTC(2026, 10, 15), queueId: 2400, dur: 1200,
    participants: [
      { puuid: 'me', team: 100, championId: 64, win: true, k: 10, d: 4, a: 12, cs: 60,
        dmg: 30000, gold: 12000, visionScore: 21, augmentIds: [101, 202, 303] },
      { puuid: 'mate', team: 100, championId: 103, win: true, k: 3, d: 9, a: 8, cs: 20,
        dmg: 10000, gold: 8000, visionScore: 5 },
      { puuid: 'foe', team: 200, championId: 99, win: false, k: 2, d: 11, a: 4, cs: 10,
        dmg: 50000, gold: 14000, visionScore: 3 }
    ]
  };
  const rec = Growth.compactGame(game, 'me');
  assert.ok(rec, 'compactGame 应返回记录');
  assert.strictEqual(rec.dmg, 75, '伤害占比按本队总量算 (30000/40000)');
  assert.strictEqual(rec.gld, 60, '经济占比 (12000/20000)');
  assert.strictEqual(rec.kp, Math.round((10 + 12) / 13 * 100), '参团率按本队击杀算');
  assert.strictEqual(rec.vis, 21);
  assert.strictEqual(JSON.stringify(rec.aug), JSON.stringify([101, 202, 303]));
  // 没有 dmg/gold 字段的老数据: 百分比应为 null 而不是 0
  const legacy = Growth.compactGame({
    gid: 'G2', time: Date.now(), queueId: 450, dur: 900,
    participants: [{ puuid: 'me', team: 100, championId: 1, win: false, k: 0, d: 8, a: 2, cs: 5 }]
  }, 'me');
  assert.strictEqual(legacy.dmg, null, '老数据无伤害字段应为 null');
  assert.strictEqual(legacy.kp, null, '老数据无队伍击杀应为 null');
  assert.strictEqual(JSON.stringify(legacy.aug), '[]');
}

// ---------- 接线 ----------
{
  const growth = read('renderer/js/growth.js');
  assert.ok(growth.includes('growthAugmentHtml') && growth.includes('growthHistoryHtml'), '成长页缺两个新板块');
  assert.ok(growth.includes('${growthAugmentHtml(ledger)}') && growth.includes('${growthHistoryHtml(ledger)}'), '新板块未挂到页面');
  assert.ok(growth.includes("growthHistSet('family'"), '战绩库缺模式筛选');
  assert.ok(growth.includes('PoroInsights.augmentCombos') && growth.includes('PoroInsights.filterLedger'), '应复用 live-insights');

  const live = read('renderer/js/live.js');
  assert.ok(/PoroInsights\.watchTarget\(list/.test(live), '实时页应计算最该盯的人');
  assert.ok(live.includes('lp-team-watch'), '缺少最该盯的人的 DOM 类名');
  assert.ok(live.includes('lp-brief-btn') && live.includes('copyLiveBrief'), '缺少简报按钮/实现');
  assert.ok(/PoroInsights\.teamBrief\(data/.test(live), '简报应复用 PoroInsights.teamBrief');
  assert.ok(/mode: \(typeof liveModeFamily === 'string'/.test(live), '阵容教练应收到模式');
  assert.ok(/function champNameOf\(/.test(live), '缺少 champNameOf');

  const html = read('renderer/index.html');
  const iIns = html.indexOf('js/live-insights.js');
  const iLive = html.indexOf('js/live.js');
  const iGrowth = html.indexOf('js/growth.js');
  assert.ok(iIns > 0, 'index.html 未加载 live-insights.js');
  assert.ok(iIns < iLive && iIns < iGrowth, 'live-insights.js 必须排在 live.js / growth.js 之前');

  const css = read('renderer/css/v4.css');
  assert.ok(css.includes('32. 新功能 UI'), 'v4.css 缺第 32 节');
  ['lp-team-watch', 'lp-brief-btn', 'gw-aug-row', 'gw-hist-row', 'gw-chip', 'dc-plan'].forEach(cls => {
    assert.ok(css.includes('.' + cls), '缺样式 .' + cls);
  });
}

console.log('批量功能（阵容教练模式化 / 台账字段 / 强化组合 / 战绩库 / 最该盯的人 / 简报）检查通过');
