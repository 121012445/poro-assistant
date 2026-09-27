'use strict';
const assert = require('assert');
const fs = require('fs');
const { deriveHomeFunStats, pickFunHighlights, classifyHeroPool, classifyCombatStyle } = require('./renderer/js/home');

const base = new Date(2026, 8, 20, 20, 0, 0).getTime();
const rows = [
  { game: { dur: 1800, time: base + 4 * 3600000 }, me: { win: false, championId: 2, k: 3, d: 7, a: 8, dmg: 12000 } },
  { game: { dur: 2400, time: base + 3 * 3600000 }, me: { win: true, championId: 1, k: 12, d: 0, a: 9, dmg: 36000 } },
  { game: { dur: 2100, time: base + 2 * 3600000 }, me: { win: true, championId: 1, k: 8, d: 2, a: 11, dmg: 28000 } },
  { game: { dur: 1500, time: base + 1 * 3600000 }, me: { win: true, championId: 3, k: 6, d: 3, a: 7, dmg: 19000 } },
  { game: { dur: 1200, time: base }, me: { win: false, championId: 2, k: 2, d: 5, a: 5, dmg: 9000 } }
];

const stats = deriveHomeFunStats(rows);
assert.strictEqual(stats.sampleSize, 5);
assert.strictEqual(stats.longestWinStreak, 3, '应按连续对局计算最长连胜');
assert.strictEqual(stats.zeroDeaths, 1, '应统计零阵亡场次');
assert.strictEqual(stats.uniqueChampions, 3, '应统计近期不同英雄数');
assert.strictEqual(stats.maxDamage.value, 36000, '应找出单局最高英雄伤害');
assert.strictEqual(stats.maxDamage.championId, 1);
assert.strictEqual(stats.longestGame.seconds, 2400, '应找出最长对局');
assert.strictEqual(stats.luckyChampion.id, 1, '至少两场时应按胜率和场次选幸运英雄');
assert.strictEqual(stats.favoritePeriod.key, 'evening', '应按本地时间聚合活跃时段');

const metricRows = [
  {
    game: { dur: 600, participants: [{ teamId: 100, k: 5 }, { teamId: 100, k: 5 }, { teamId: 200, k: 7 }] },
    me: { win: true, championId: 1, teamId: 100, k: 5, d: 2, a: 5, dmg: 10000, dmgTaken: 8000, gold: 5000 }
  },
  {
    game: { dur: 1200, participants: [{ teamId: 100, k: 2 }, { teamId: 100, k: 10 }, { teamId: 200, k: 8 }] },
    me: { win: false, championId: 2, teamId: 100, k: 2, d: 3, a: 4, dmg: 20000, dmgTaken: 12000, gold: 10000 }
  }
];
const performance = deriveHomeFunStats(metricRows).performance;
assert.strictEqual(performance.averageKda, 3.2, '平均 KDA 应按总击杀助攻与总死亡计算');
assert.strictEqual(performance.averageKills, 3.5);
assert.strictEqual(performance.averageDeaths, 2.5);
assert.strictEqual(performance.averageAssists, 4.5);
assert.strictEqual(performance.damageConversion, 200, '伤害转化率应使用英雄伤害/金币');
assert.strictEqual(performance.damagePerMinute, 1000, '每分钟伤害应按有效总时长加权');
assert.strictEqual(performance.averageDamage, 15000);
assert.strictEqual(performance.averageDamageTaken, 10000);
assert.strictEqual(performance.averageParticipation, 75, '参团率应逐局计算后取平均');
assert.strictEqual(performance.participationGames, 2);

const missingPerformance = deriveHomeFunStats([{ game: { dur: 0 }, me: { k: 0, d: 0, a: 0 } }]).performance;
assert.strictEqual(missingPerformance.damageConversion, null, '缺少金币时不应伪装成 0%');
assert.strictEqual(missingPerformance.damagePerMinute, null, '缺少有效时长时不应伪装成 0');
assert.strictEqual(missingPerformance.averageParticipation, null, '缺少队伍击杀时不应伪装成 0%');

const morning = new Date(2026, 8, 21, 9, 0, 0).getTime();
const flavorRows = [
  {
    game: { dur: 1200, time: morning, participants: [{ puuid: 'self', teamId: 100, k: 8 }, { puuid: 'duo', name: '黄金队友', tagLine: '001', teamId: 100, k: 4 }, { puuid: 'enemy1', championId: 9, teamId: 200, k: 5 }] },
    me: { puuid: 'self', teamId: 100, win: true, championId: 1, k: 8, d: 2, a: 6, dmg: 18000, dmgTaken: 9000, items: [3001, 3003, 3004, 3002, 3340, 1001] }
  },
  {
    game: { dur: 1300, time: morning + 3600000, participants: [{ puuid: 'self', teamId: 100, k: 7 }, { puuid: 'duo', name: '黄金队友', tagLine: '001', teamId: 100, k: 3 }, { puuid: 'enemy2', championId: 9, teamId: 200, k: 6 }] },
    me: { puuid: 'self', teamId: 100, win: true, championId: 1, k: 7, d: 3, a: 8, dmg: 17000, dmgTaken: 10000, items: [3001, 3003, 3004, 2003] }
  },
  {
    game: { dur: 1400, time: morning + 7200000, participants: [{ puuid: 'self', teamId: 100, k: 3 }, { puuid: 'duo', name: '黄金队友', tagLine: '001', teamId: 100, k: 2 }, { puuid: 'enemy3', championId: 9, teamId: 200, k: 8 }] },
    me: { puuid: 'self', teamId: 100, win: false, championId: 2, k: 3, d: 6, a: 5, dmg: 12000, dmgTaken: 16000, items: [3001, 3004, 3005] }
  }
];
const flavor = deriveHomeFunStats(flavorRows, {
  champions: {
    Alpha: { key: '1', tags: ['Mage', 'Support'] },
    Beta: { key: '2', tags: ['Fighter'] }
  },
  items: {
    1001: { name: '速度之靴', tags: ['Boots'], gold: { total: 300 } },
    2003: { name: '生命药水', tags: ['Consumable'], gold: { total: 50 } },
    3001: { name: '招牌成装', tags: ['SpellDamage'], gold: { total: 3000 } },
    3002: { name: '可升级散件', tags: ['SpellDamage'], into: ['3005'], gold: { total: 1800 } },
    3003: { name: '另一成装', tags: ['SpellDamage'], gold: { total: 2800 } },
    3004: { name: '战士成装', tags: ['Damage'], gold: { total: 2900 } },
    3005: { name: '防御成装', tags: ['Health'], gold: { total: 2700 } }
  }
});
assert.strictEqual(flavor.favoriteItem.id, 3001, '钟爱装备应按携带场次统计最终成装');
assert.strictEqual(flavor.favoriteItem.games, 3);
assert.strictEqual(flavor.favoriteRole.tag, 'Mage', '英雄分类应优先近期使用场次，再比较表现');
assert.strictEqual(flavor.favoriteRole.games, 2);
assert.strictEqual(flavor.favoriteRole.championCount, 1);
assert.deepStrictEqual(flavor.favoriteTriple.ids, [3001, 3003, 3004], '最常用三件套应忽略散件、鞋子和饰品');
assert.strictEqual(flavor.favoriteTriple.games, 2);
assert.strictEqual(flavor.goldenPartner.name, '黄金队友');
assert.strictEqual(flavor.goldenPartner.games, 3);
assert.strictEqual(flavor.nemesis.id, 9);
assert.strictEqual(flavor.nemesis.games, 3);
assert.strictEqual(flavor.bestPeriod.key, 'morning');
assert.strictEqual(flavor.combatStyle.label, '稳健输出型',
  '战斗风格：参团 100% 但无治疗/护盾数据时不应误判为团队辅助型，应落到稳健输出型');
assert.strictEqual(flavor.heroPoolProfile.label, '均衡英雄池',
  '英雄池：3 场样本不足任何分支的 5 场门槛，应落到均衡英雄池兜底');

// ── 分类阈值 ────────────────────────────────────────────────────────────────
// 2026-09-27 补。此前这里只有 `assert.ok(flavor.combatStyle?.label && ...)` ——
// 只要 label 非空就绿，**阈值改错了完全测不出来**，和 test_live_layout.js 里的
// 字符串 grep 是同一类"永远绿"的假断言。
// 现在 classifyCombatStyle / classifyHeroPool 已抽成具名纯函数，直接按输入钉住每条分支
// 与每个边界（>= 与 > 的差别、门槛值本身）。
const perfBase = () => ({ averageKda: 2, averageKills: 5, averageDeaths: 5, averageUtility: 0 });
const styleOf = (patch, participation, dmg, taken) =>
  classifyCombatStyle(Object.assign(perfBase(), patch), participation, dmg, taken).label;

// 团队辅助型：治疗护盾 ≥3500 且参团 ≥60%，两个条件缺一不可
// 下面三条把门槛**精确钉在临界值上**：只测 4000/3499 和 70/59 是拦不住
// "3500 -> 3501"、"60 -> 61" 这类改动的（负向验证实测漏过）。
assert.strictEqual(styleOf({ averageUtility: 3500 }, 60, 10000, 10000), '团队辅助型',
  '治疗护盾 3500 与参团 60% 恰好等于门槛时应判为团队辅助型');
assert.strictEqual(styleOf({ averageUtility: 3500 }, 59, 10000, 10000), '稳健输出型',
  '参团 59% 未达 60% 门槛，不应判为团队辅助型');
assert.strictEqual(styleOf({ averageUtility: 3499 }, 60, 10000, 10000), '稳健输出型',
  '治疗护盾 3499 未达 3500 门槛，不应判为团队辅助型');
assert.strictEqual(styleOf({ averageUtility: 4000 }, 70, 10000, 10000), '团队辅助型');
// 前排抗压型：承伤 ≥12000 且严格大于输出 1.2 倍（注意是 > 不是 >=）
// 9000/12000 把 12000 门槛钉死；10000/12500（比值 1.25）把 1.2 倍钉死 ——
// 只用 10000/15000 是拦不住 "12000 -> 13000" 和 "1.2 -> 1.3" 的。
assert.strictEqual(styleOf({}, 0, 9000, 12000), '前排抗压型',
  '承伤恰好 12000 且高于输出 1.2 倍时应判为前排抗压型');
assert.strictEqual(styleOf({}, 0, 9000, 11999), '均衡适应型', '承伤 11999 未达 12000 门槛');
assert.strictEqual(styleOf({}, 0, 10000, 12500), '前排抗压型',
  '承伤为输出 1.25 倍时仍应判为前排抗压型（1.2 倍门槛的临界之上）');
assert.strictEqual(styleOf({}, 0, 10000, 12000), '稳健输出型',
  '承伤恰好等于输出 1.2 倍时不应判为前排抗压型（该规则是严格大于）');
assert.strictEqual(styleOf({}, 0, 10000, 15000), '前排抗压型');
// 激进收割型：场均击杀 ≥8，或（场均死亡 ≥8 且输出 ≥15000）
assert.strictEqual(styleOf({ averageKills: 8 }, 0, 10000, 10000), '激进收割型');
assert.strictEqual(styleOf({ averageDeaths: 8, averageKills: 3 }, 0, 15000, 10000), '激进收割型');
assert.strictEqual(styleOf({ averageDeaths: 8, averageKills: 3 }, 0, 14999, 10000), '均衡适应型',
  '输出 14999 未达 15000 门槛，不应判为激进收割型');
// 稳健输出型：场均死亡 ≤5 且输出不低于承伤 0.8 倍
assert.strictEqual(styleOf({ averageDeaths: 5 }, 0, 20000, 20000), '稳健输出型');
// 兜底
assert.strictEqual(styleOf({ averageDeaths: 6 }, 0, 20000, 10000), '均衡适应型',
  '场均死亡 6 已越过 ≤5 门槛，应落到均衡适应型兜底');
// 兜底详情的参团占位符：0 要显示 '--' 而不是 '0%'
assert.strictEqual(classifyCombatStyle(Object.assign(perfBase(), { averageDeaths: 6 }), 0, 20000, 10000).detail,
  'KDA 2.00 · 参团 --', '参团率为 0 时应显示占位符 --');
assert.strictEqual(classifyCombatStyle(Object.assign(perfBase(), { averageDeaths: 6 }), 50, 20000, 10000).detail,
  'KDA 2.00 · 参团 50%');

// 英雄池专一度：判定顺序即优先级，先看最常用英雄占比 → 英雄数 → 前三占比
const poolOf = (games, distinct, topShare, topThreeShare) =>
  classifyHeroPool(new Array(games), new Map(Array.from({ length: distinct }, (_, i) => ['c' + i, {}])),
    topShare, topThreeShare).label;
assert.strictEqual(poolOf(5, 2, 0.45, 1), '绝活专精', '最常用英雄占比恰好 45% 即达门槛');
assert.strictEqual(poolOf(5, 2, 0.44, 0.75), '精简英雄池', '占比 44% 未达 45%，应继续往下判定');
assert.strictEqual(poolOf(4, 2, 0.5, 1), '均衡英雄池', '4 场未达任何分支的 5 场门槛，应兜底');
assert.strictEqual(poolOf(8, 6, 0.25, 0.625), '全能选手', '8 场 6 位英雄恰好 75% 即达门槛');
assert.strictEqual(poolOf(8, 5, 0.25, 0.625), '均衡英雄池', '5/8=62.5% 未达 75%，且前三占比未达 75%');
assert.strictEqual(poolOf(5, 3, 0.4, 1), '精简英雄池', '前三英雄覆盖 100% 即达门槛');
assert.strictEqual(poolOf(5, 3, 0.4, 0.74), '均衡英雄池', '前三覆盖 74% 未达 75%');
assert.strictEqual(poolOf(9, 6, 0.22, 0.667), '均衡英雄池', '全部门槛均未命中时应兜底');
assert.strictEqual(poolOf(8, 7, 0.5, 0.9), '绝活专精',
  '绝活专精优先级高于全能选手：同时满足时取前者');

// pickFunHighlights 是纯搬移（逐字节 diff 已验证），这里只钉住它"故意写回对象"的那一行
const highlights = pickFunHighlights({
  periods: [{ key: 'evening', games: 3, wins: 2 }],
  champions: new Map([['1', { id: 1, games: 3, wins: 3 }], ['2', { id: 2, games: 1, wins: 0 }]]),
  favoriteItems: new Map(),
  itemTriples: new Map(),
  roleStats: new Map([['Mage', { tag: 'Mage', games: 2, wins: 2, k: 10, d: 2, a: 12, champions: new Set([1, 3]) }]]),
  partners: new Map(),
  nemeses: new Map()
});
assert.strictEqual(highlights.luckyChampion.id, 1, '幸运英雄只统计至少 2 场的英雄');
assert.strictEqual(highlights.favoriteRole.championCount, 2,
  'favoriteRole.championCount 必须由 champions.size 回填（下游按该字段显示"用过 N 个英雄"）');
assert.strictEqual(highlights.favoriteItem, null, '没有装备数据时应返回 null 而不是 undefined');
assert.strictEqual(highlights.favoriteTriple, null, '没有三件套数据时应返回 null 而不是 undefined');
assert.strictEqual(highlights.goldenPartner, null, '没有队友数据时应返回 null 而不是 undefined');
assert.strictEqual(highlights.nemesis, null);

const homeSource = fs.readFileSync('renderer/js/home.js', 'utf8');
const searchSource = fs.readFileSync('renderer/js/hex.js', 'utf8');
assert.ok(homeSource.includes('function preserveHomeScroll(targetPuuid)')
  && homeSource.includes("panel.style.minHeight")
  && homeSource.includes('function restoreHomeScroll(targetPuuid)'),
  '异步重绘玩家档案时必须保留滚动坐标并维持加载期页面高度');
assert.ok(homeSource.includes('top: sameTarget ? Math.max(0, scroller.scrollTop || 0) : 0'),
  '切换到不同玩家时应从新档案顶部展示，不能继承上一位玩家的像素位置');
assert.ok(homeSource.includes("scroller.style.scrollBehavior = 'auto'")
  && homeSource.includes("behavior: 'auto'"),
  '程序性首页定位必须绕过平滑滚动，避免异步重绘途中停在模式统计区');
assert.ok(homeSource.includes("label === '常用三件套'") && homeSource.includes('home-fun-card-wide'),
  '常用三件套必须使用宽卡片，避免三个装备名称被单行省略');
const premiumCss = fs.readFileSync('renderer/css/premium.css', 'utf8');
const styleCss = fs.readFileSync('renderer/css/style.css', 'utf8');
const extrasCss = fs.readFileSync('renderer/css/extras.css', 'utf8');
assert.match(extrasCss, /\.home-fun-card-wide\s*\{[^}]*grid-column:\s*span 2;/s,
  '常用三件套宽卡片必须横跨两列');
assert.match(extrasCss, /\.home-fun-card-wide b\s*\{[^}]*white-space:\s*normal;[^}]*-webkit-line-clamp:\s*2;/s,
  '三件套名称必须允许两行展示');
assert.match(premiumCss, /\.main-content\s*\{[^}]*scroll-behavior:\s*auto;[^}]*overflow-anchor:\s*none;/s,
  '主滚动容器必须关闭平滑动画和 Chromium 滚动锚定');
assert.match(styleCss, /\.home-layout\s*\{[^}]*overflow-anchor:\s*none;/s,
  '首页异步档案内容必须关闭嵌套滚动锚定');
assert.ok(searchSource.indexOf('preserveHomeScroll(puuid)') < searchSource.indexOf("panel.innerHTML = '<div class=\"meta-loading\">正在查询该召唤师战绩...</div>'"),
  '查询其他玩家时必须在替换旧页面之前保存滚动位置');

console.log('首页趣味数据计算测试通过');
