'use strict';
// 「最近一局复盘」三条建议必须各不相同, 且每局随数据变化。
// 旧版 bug: 4 个触发条件全不满足时用 while 循环压同一句兜底, 于是出现三条一模一样的文案。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const home = fs.readFileSync('renderer/js/home.js', 'utf8');
const PoroMistakes = require('./renderer/js/repeat-mistakes');

const start = home.indexOf('function buildPostGameCoach(');
const end = home.indexOf('async function loadHomeStats(');
assert(start > 0 && end > start, '定位不到 buildPostGameCoach');

function build(games, puuid = 'me') {
  const ctx = {
    window: { PoroMistakes, _myPuuid: puuid },
    escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    Math, Number, String, Object, Array, Set, JSON, console,
  };
  vm.createContext(ctx);
  ctx.games = games;
  vm.runInContext(home.slice(start, end), ctx);
  const html = vm.runInContext('buildPostGameCoach(games)', ctx);
  const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => m[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  return { html, items };
}

function game(over = {}) {
  const me = Object.assign({
    puuid: 'me', teamId: 100, k: 8, d: 2, a: 9, dmg: 26000, cs: 190,
    visionScore: 30, position: 'MIDDLE', win: true,
  }, over.me || {});
  const mates = [
    me,
    { puuid: 'a2', teamId: 100, k: 4, d: 6, a: 8, dmg: 15000, cs: 120, visionScore: 12, position: 'TOP' },
    { puuid: 'a3', teamId: 100, k: 3, d: 5, a: 12, dmg: 11000, cs: 30, visionScore: 20, position: 'UTILITY' },
    { puuid: 'a4', teamId: 100, k: 6, d: 4, a: 7, dmg: 18000, cs: 140, visionScore: 14, position: 'JUNGLE' },
    { puuid: 'a5', teamId: 100, k: 9, d: 3, a: 6, dmg: 21000, cs: 160, visionScore: 11, position: 'BOTTOM' },
  ];
  const foes = [1, 2, 3, 4, 5].map(n => ({
    puuid: 'e' + n, teamId: 200, k: 4, d: 7, a: 5, dmg: 14000, cs: 110, visionScore: 10, position: 'MIDDLE',
  }));
  return Object.assign({
    gid: 1001, queueId: 420, mode: '匹配', dur: 1800, win: true,
    participants: [...mates, ...foes],
  }, over.game || {});
}

// A. 打得好的一局: 一条失误都不触发 (旧版就是在这里吐三条相同文案)
const good = build([game()]);
assert.strictEqual(good.items.length, 3, '必须给满三条');
assert.strictEqual(new Set(good.items).size, 3, '三条建议必须互不相同');
assert(!good.html.includes('继续保持当前节奏，下一局重点观察死亡前的视野和资源交换'), '旧兜底文案必须消失');
assert(/阵亡 \d+ 次|分均补刀 \d/.test(good.items.join(' ')), '正向建议要带本局真实数字');
for (const line of good.items) assert(line.trim().length > 10, '每条都要有实质内容: ' + line);
assert(good.html.includes('胜局巩固'), '胜局标记');
// 已经夸过的指标不能再当目标, 否则「分均补刀 6.3 不错」+「分均补刀提到 7.1」读起来像凑数
for (const kw of ['分均补刀', '视野得分', '参团率', '伤害占比']) {
  const praised = good.items.filter(t => t.includes(kw) && !t.includes('目标'));
  const goal = good.items.filter(t => t.includes(kw) && t.includes('目标'));
  assert(!(praised.length && goal.length), `${kw} 同时出现在表扬与目标里: ` + good.items.join(' | '));
}
// 好局也要给出下一步, 不能三条全是表扬
assert(good.items.some(t => t.includes('下局目标')), '好局应至少留一条下一局目标');

// B. 打得差的一局: 由 repeat-mistakes 的按模式判定给出, 且带证据数字
const bad = build([game({
  game: { gid: 1002, win: false },
  me: { k: 1, d: 13, a: 2, cs: 40, visionScore: 2, dmg: 6000, win: false },
})]);
assert.strictEqual(bad.items.length, 3);
assert.strictEqual(new Set(bad.items).size, 3, '失败局三条也必须不同');
assert(/阵亡 13 次/.test(bad.items[0]), '最严重的一条 (阵亡) 应排第一并带证据: ' + bad.items[0]);
assert(bad.items.some(t => /视野得分 2/.test(t)), '应给出视野证据');
assert(bad.html.includes('败局改进'));

// C. 一条具体数据都算不出来的极端局 (斗魂/辅助/全队 0 杀): 只能靠通用目标池,
//    旧版在这里吐三条相同文案。现在池子按 gameId 轮转 —— 同一局稳定、换局会变。
function sparseGame(gid) {
  const mk = (puuid, teamId) => ({ puuid, teamId, k: 0, d: 5, a: 0, dmg: 0, cs: 0,
    visionScore: 0, position: 'UTILITY', win: true });
  return { gid, queueId: 1700, mode: '斗魂', dur: 1200, win: true,
    participants: [mk('me', 100), mk('a2', 100), mk('e1', 200), mk('e2', 200)] };
}
const g1 = build([sparseGame(5001)]).items;
const g2 = build([sparseGame(5002)]).items;
assert.strictEqual(new Set(g1).size, 3, '兜底局三条也必须不同: ' + g1.join(' | '));
assert.notDeepStrictEqual(g1, g2, '不同对局不应给出一模一样的三条');
assert.strictEqual(build([sparseGame(5001)]).items.join('|'), g1.join('|'), '同一局的建议要稳定');

// D. 大乱斗: 不谈补刀/视野, 只谈阵亡/参团/伤害
const aram = build([game({
  game: { gid: 1003, queueId: 450, mode: '大乱斗', dur: 1200 },
  me: { d: 14, dmg: 4000, cs: 12, visionScore: 0, position: 'MIDDLE' },
})]);
assert(!aram.items.some(t => /补刀|视野得分/.test(t)), '大乱斗不该出现补刀/视野建议: ' + aram.items.join(' | '));
assert(aram.items.some(t => /阵亡 14 次/.test(t)), '大乱斗应报到阵亡');

// E. 数据缺失时不崩、不输出空条目
const sparse = build([game({ me: { cs: 0, dmg: 0, visionScore: 0, d: 0, k: 0, a: 0 } })]);
assert.strictEqual(sparse.items.length, 3);
sparse.items.forEach(t => assert(t.trim().length > 0));

console.log('最近一局复盘 (post-game coach) 测试通过 — 三条建议不再重复');
