'use strict';
// 辅助位标签回归 (2026-11-20 用户报: 2/2/27 的辅助挂着「输出乏力/伤转偏低」)
// 根因: LCU/SGP 的分路枚举是 UTILITY, 旧代码只认 SUPPORT, 辅助整批漏判。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('renderer/js/utils.js', 'utf8');
const context = vm.createContext({ Date, Set, String, Number, Object, Math, JSON });
vm.runInContext(src, context);

const tagsOf = (player, team, kp, share, mins, mode) => JSON.parse(vm.runInContext(
  `JSON.stringify(derivePerformanceTags(${JSON.stringify(player)}, ${JSON.stringify(team)}, ${kp}, ${share}, ${mins}, ${JSON.stringify(mode || '')}))`,
  context));
const labels = list => list.map(t => t.label);

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass++; } catch (e) { console.error('FAIL ' + name + '\n  ' + e.message); process.exitCode = 1; }
};

// 一条典型辅助线: 2/2/27, 5k 伤害, 视野最好, 控制最长
const supTeam = [
  { k: 2, d: 2, a: 27, dmg: 5100, dmgTaken: 7800, gold: 8200, healing: 1500, allyHeal: 4200, shielding: 3100, visionScore: 62, wardsKilled: 11, ccTime: 78, position: 'UTILITY', win: true },
  { k: 9, d: 4, a: 8, dmg: 28000, dmgTaken: 21000, gold: 13000, visionScore: 14, wardsKilled: 2, ccTime: 12, position: 'BOTTOM', win: true },
  { k: 7, d: 6, a: 6, dmg: 24000, dmgTaken: 24000, gold: 12500, visionScore: 12, wardsKilled: 3, ccTime: 20, position: 'MIDDLE', win: true },
  { k: 5, d: 5, a: 9, dmg: 19000, dmgTaken: 26000, gold: 11000, visionScore: 13, wardsKilled: 1, ccTime: 30, position: 'TOP', win: true },
  { k: 3, d: 7, a: 10, dmg: 15000, dmgTaken: 25000, gold: 10500, visionScore: 15, wardsKilled: 4, ccTime: 25, position: 'JUNGLE', win: true }
];
const sup = supTeam[0];
const supTags = tagsOf(sup, supTeam, 78, 5, 24, '单双排');

ok('UTILITY 辅助不吃「输出乏力」', () => {
  assert(!labels(supTags).includes('输出乏力'), '实际标签: ' + labels(supTags).join('/'));
});
ok('UTILITY 辅助不吃「伤转偏低」', () => {
  assert(!labels(supTags).includes('伤转偏低'), '实际标签: ' + labels(supTags).join('/'));
});
ok('UTILITY 辅助拿到视野类标签', () => {
  assert(labels(supTags).some(l => ['视野掌控', '视野扎实'].includes(l)), '实际标签: ' + labels(supTags).join('/'));
});
ok('UTILITY 辅助拿到控制类标签', () => {
  assert(labels(supTags).includes('控制拉满'), '实际标签: ' + labels(supTags).join('/'));
});
ok('辅助标签最多 4 条', () => {
  assert(supTags.length <= 4, '实际 ' + supTags.length + ' 条');
});
ok('辅助的视野/控制/保护都能同时出现', () => {
  const got = labels(supTags);
  ['视野掌控', '控制拉满', '治疗给力'].forEach(label => {
    assert(got.includes(label), '缺 ' + label + '，实际: ' + got.join('/'));
  });
});
ok('控制拉满的提示带控制秒数', () => {
  const cc = supTags.find(t => t.label === '控制拉满');
  assert(cc && /78 秒/.test(cc.tip), 'tip: ' + (cc && cc.tip));
});

// 旧写法 SUPPORT 也要认 (历史数据/测试数据里都是它)
ok('SUPPORT 写法同样识别为辅助', () => {
  const tags = tagsOf({ ...sup, position: 'SUPPORT' }, supTeam, 78, 5, 24, '单双排');
  assert(!labels(tags).includes('输出乏力'), '实际标签: ' + labels(tags).join('/'));
});

// 反眼: 队内最多且够量 (把视野/控制/治疗压下去, 单测这条规则本身)
ok('排眼最多给出「排眼积极」', () => {
  const team = supTeam.map(p => ({ ...p, wardsKilled: 1, ccTime: 5, healing: 0, allyHeal: 0, shielding: 0 }));
  team[0] = { ...team[0], wardsKilled: 9, visionScore: 8 };
  const tags = labels(tagsOf(team[0], team, 70, 6, 24, '单双排'));
  assert(tags.includes('排眼积极'), '实际标签: ' + tags.join('/'));
});
ok('已经拿到视野掌控时不重复叠排眼', () => {
  const team = supTeam.map(p => ({ ...p, wardsKilled: 1 }));
  team[0] = { ...team[0], wardsKilled: 9 };
  const tags = labels(tagsOf(team[0], team, 78, 5, 24, '单双排'));
  assert(tags.includes('视野掌控') && !tags.includes('排眼积极'), '实际标签: ' + tags.join('/'));
});
ok('排眼只有 2 个时不给「排眼积极」', () => {
  const team = supTeam.map(p => ({ ...p, wardsKilled: 1, ccTime: 5, healing: 0, allyHeal: 0, shielding: 0 }));
  team[0] = { ...team[0], wardsKilled: 2, visionScore: 8 };
  const tags = labels(tagsOf(team[0], team, 70, 6, 24, '单双排'));
  assert(!tags.includes('排眼积极'), '实际标签: ' + tags.join('/'));
});

// 控制拉满要"密度够": 全队都少的时候不该给
ok('全队控制都少时不给「控制拉满」', () => {
  const team = supTeam.map(p => ({ ...p, ccTime: 3 }));
  const tags = labels(tagsOf(team[0], team, 70, 6, 30, '单双排'));
  assert(!tags.includes('控制拉满'), '实际标签: ' + tags.join('/'));
});
ok('控制不是队内最长时不给「控制拉满」', () => {
  const team = supTeam.map(p => ({ ...p }));
  team[2] = { ...team[2], ccTime: 200 };
  const tags = labels(tagsOf(team[0], team, 70, 6, 24, '单双排'));
  assert(!tags.includes('控制拉满'), '实际标签: ' + tags.join('/'));
});

// 输出位不受影响: 中单低伤害仍然吃「输出乏力 / 伤转偏低」
ok('中单低于队均仍标记输出乏力', () => {
  const mid = { k: 1, d: 5, a: 4, dmg: 5000, dmgTaken: 5000, gold: 10000, visionScore: 4, position: 'MIDDLE', win: false };
  const team = [mid,
    { dmg: 30000, dmgTaken: 25000, gold: 10000 }, { dmg: 28000, dmgTaken: 24000, gold: 10000 },
    { dmg: 26000, dmgTaken: 23000, gold: 10000 }, { dmg: 22000, dmgTaken: 22000, gold: 10000 }];
  const tags = labels(tagsOf(mid, team, 30, 5, 20, '单双排'));
  assert(tags.includes('输出乏力'), '实际标签: ' + tags.join('/'));
});

// 大乱斗: 没有视野数据, 不能出视野类标签 (但控制类可以, 有真实值)
ok('大乱斗不出视野类标签', () => {
  const team = supTeam.map(p => ({ ...p, visionScore: 0, wardsKilled: 0 }));
  const tags = labels(tagsOf(team[0], team, 70, 20, 16, '海克斯大乱斗'));
  assert(!tags.some(l => ['视野掌控', '视野扎实', '排眼积极'].includes(l)), '实际标签: ' + tags.join('/'));
});
ok('大乱斗控制时长有数据时可以给「控制拉满」', () => {
  const team = supTeam.map(p => ({ ...p, visionScore: 0, wardsKilled: 0 }));
  team[0] = { ...team[0], ccTime: 45 };
  const tags = labels(tagsOf(team[0], team, 70, 20, 16, '海克斯大乱斗'));
  assert(tags.includes('控制拉满'), '实际标签: ' + tags.join('/'));
});

// 辅助的承伤阈值更严: 8% 分摊对辅助正常, 不该被打上「承伤偏少」
ok('辅助承伤 8% 不触发「承伤偏少」', () => {
  const team = supTeam.map((p, i) => ({ ...p, dmgTaken: i === 0 ? 8000 : 23000 }));
  const tags = labels(tagsOf(team[0], team, 78, 5, 24, '单双排'));
  assert(!tags.includes('承伤偏少'), '实际标签: ' + tags.join('/'));
});

// 没有分路数据 (旧数据/部分模式) 时不能把人当辅助, 输出乏力照旧
ok('无位置信息时不套用辅助规则', () => {
  const anon = { k: 1, d: 6, a: 3, dmg: 5000, dmgTaken: 6000, gold: 10000, visionScore: 5, win: false };
  const team = [anon,
    { dmg: 30000, dmgTaken: 25000, gold: 10000 }, { dmg: 28000, dmgTaken: 24000, gold: 10000 },
    { dmg: 26000, dmgTaken: 23000, gold: 10000 }, { dmg: 22000, dmgTaken: 22000, gold: 10000 }];
  const tags = labels(tagsOf(anon, team, 30, 5, 20, '单双排'));
  assert(tags.includes('输出乏力'), '实际标签: ' + tags.join('/'));
});

// 数据归一化: 两条分支都要把 timeCCingOthers 带出来
const homeSrc = fs.readFileSync('renderer/js/home.js', 'utf8');
ok('SGP 分支映射 ccTime', () => {
  assert(homeSrc.includes('ccTime: p.timeCCingOthers || 0'), 'SGP 摘要分支缺 ccTime');
});
ok('LCU 兜底分支映射 ccTime', () => {
  assert(homeSrc.includes('ccTime: p.stats?.timeCCingOthers || 0'), 'LCU 分支缺 ccTime');
});

console.log(`辅助位标签测试通过 (${pass} 项)`);
