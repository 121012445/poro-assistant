'use strict';
const assert = require('assert');
const fs = require('fs');
const { deriveHomeFunStats } = require('./renderer/js/home');

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
assert.ok(flavor.combatStyle?.label && flavor.heroPoolProfile?.label, '战斗风格与英雄池专一度必须生成');

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
