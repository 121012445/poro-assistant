// 1.5.139 回归: 玩家卡「单杀 / 击杀伤害效率」标签 (Akari 同款, 纯 summary 数据零请求)
// - 单杀 = challenges.soloKills 场均, >0 才占位; 字段缺失的局不计入分母
// - 击杀伤害效率 kde = (击杀/全队击杀) ÷ (伤害/全队伤害), 仅 >1.35 或 <0.65 显示 (Akari 阈值)
// - 连胜/连败/伤效胶囊在「+N」浮层里也保语义色 (v4.css unscoped 规则)
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const live = fs.readFileSync('renderer/js/live.js', 'utf8');
const css = fs.readFileSync('renderer/css/v4.css', 'utf8');

// 静态断言: 新字段与新样式都落位
assert.ok(live.includes('challenges?.soloKills'), 'SGP 路径应读取 challenges.soloKills');
assert.ok(live.includes("['solo', '单杀'"), 'liveMetricPills 应包含单杀标签');
assert.ok(live.includes('kdehi') && live.includes('kdelo'), '击杀伤害效率高/低两态标签应存在');
assert.ok(css.includes('.lp-metric-kdehi') && css.includes('.lp-metric-kdelo'), 'v4.css 应有伤效语义色');
assert.ok(css.includes('.lp-metric-winstreak {\n  color: var(--pos);\n  background: var(--pos-soft);\n  font-weight: 650;\n}\n.lp-metric-lossstreak'), '浮层内连胜/连败应有 unscoped 语义色');
assert.ok(!live.includes('lp-tags-more') && !live.includes('lp-extra-metric'), '收纳/浮层应整体退役 (1.5.142 全部直接展示)');

// 动态断言: vm 隔离执行 live.js
const ctx = vm.createContext({
  console, window: {},
  document: {
    querySelectorAll: () => [], getElementById: () => null, addEventListener: () => {},
    createElement: () => ({ style: {}, addEventListener: () => {} }), body: { appendChild: () => {} }
  },
  poroIcon: () => '', escapeHtml: s => String(s), toggleLiveMetricsPop: () => {}
});
vm.runInContext(live, ctx, { filename: 'live.js' });

const g = o => Object.assign(
  { dmgPct: 25, tankPct: 20, goldPct: 22, kp: 60, dmgGold: 120, vision: 30, cs: 200, dur: 1800 },
  o
);

// 单杀 + 效率高
const t1 = ctx.liveMetricPills([g({ solo: 1, kde: 1.5 }), g({ solo: 1, kde: 1.5 }), g({ solo: 1, kde: 1.5 })]);
assert.ok(t1.includes('lp-metric-solo') && t1.includes('单杀<b>1</b>'), '场均单杀应显示');
assert.ok(t1.includes('lp-metric-kdehi') && t1.includes('拿头<b>1.50</b>'), '效率高应显示');

// 效率低 / 正常区间
const t2 = ctx.liveMetricPills([g({ solo: null, kde: 0.5 }), g({ solo: null, kde: 0.5 })]);
assert.ok(t2.includes('lp-metric-kdelo'), '效率低应显示');
const t3 = ctx.liveMetricPills([g({ solo: null, kde: 1.0 }), g({ solo: null, kde: 1.0 })]);
assert.ok(!t3.includes('kdehi') && !t3.includes('kdelo'), '正常区间不占位');

// 零单杀 / 字段缺失 / 平均跨阈值
const t4 = ctx.liveMetricPills([g({ solo: 0, kde: 1.0 }), g({ solo: 0, kde: 1.0 })]);
assert.ok(!t4.includes('lp-metric-solo'), '零单杀不占位');
const t5 = ctx.liveMetricPills([g({ solo: null, kde: null })]);
assert.ok(!t5.includes('lp-metric-solo') && !t5.includes('lp-metric-kde'), '字段缺失安全');
const t6 = ctx.liveMetricPills([g({ solo: null, kde: 1.3 }), g({ solo: null, kde: 1.5 })]);
assert.ok(t6.includes('kdehi'), '平均 1.4 > 1.35 判定为高');

// kde 公式 (teamShareOf, SGP/LCU 共用)
const me = { teamId: 100, puuid: 'me', kills: 10, assists: 5, totalDamageDealtToChampions: 30000, goldEarned: 15000, visionScore: 30, challenges: { soloKills: 2 } };
const mates = [me,
  { teamId: 100, kills: 10, assists: 0, totalDamageDealtToChampions: 30000, goldEarned: 15000, visionScore: 25 },
  { teamId: 100, kills: 0, assists: 0, totalDamageDealtToChampions: 20000, goldEarned: 12000, visionScore: 20 },
  { teamId: 100, kills: 0, assists: 0, totalDamageDealtToChampions: 10000, goldEarned: 10000, visionScore: 15 },
  { teamId: 100, kills: 0, assists: 0, totalDamageDealtToChampions: 10000, goldEarned: 10000, visionScore: 10 },
  { teamId: 200, kills: 0, assists: 0, totalDamageDealtToChampions: 10000, goldEarned: 10000 }];
const s = ctx.teamShareOf(mates, me, 10, 5);
assert.strictEqual(s.kde, 1.67, 'kde = (10/20) ÷ (30000/100000) ≈ 1.67');
assert.strictEqual(s.kp, 75, '既有 kp 口径不受影响');

// 1.5.141: 特色标签 (大腿/本命) + 标签专属配色 (§23) + 组队色轮换
assert.ok(live.includes('lp-tag-hiwr') && live.includes(">大腿</span>"), '应有高胜率「大腿」特色标签');
assert.ok(live.includes('lp-tag-main') && live.includes(">本命</span>"), '应有本命英雄特色标签');
assert.ok(live.includes('specialTags.length'), '特色标签应计入 reservedSlots');
assert.ok(!live.includes('toggleLiveMetricsPop'), '指标浮层死代码应随收纳一起删除 (1.5.142)');
assert.ok(live.includes('lp-pg-'), '组队标签应按组号挂色类');
const cssAll = fs.readFileSync('renderer/css/v4.css', 'utf8');
for (const c of ['dmg', 'tank', 'kp', 'gold', 'csm', 'vision']) {
  assert.ok(cssAll.includes(`#page-live .lp-profile-line .lp-metric-${c}`), `§23 应有 lp-metric-${c} 专属色 (scoped 版本压过旧中性规则)`);
}
assert.ok(cssAll.includes('.lp-pg-1') && cssAll.includes('.lp-behavior-warn'), '§23 应有组队六色与行为分档色');
assert.ok(cssAll.includes('#page-live .page-header { padding-bottom: 0; }'), '§22.5 计划条头应去掉 padding-bottom');

console.log('test_live_metric_tags: 全部断言通过');
