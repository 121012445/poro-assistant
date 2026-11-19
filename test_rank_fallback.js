'use strict';
// 1.6.29 段位回退: LCU 对"未定级"的账号返回的是结构完整但 tier 为空的对象。
// 旧写法 `qm.RANKED_SOLO_5x5 || qm.RANKED_FLEX_SR` 会拿到空壳就返回,
// 灵活已经有段位也不显示 —— 实测某玩家单双排空壳 + 灵活钻石 24LP, 详情页整行空白。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('renderer/js/home.js', 'utf8').replace(/\r\n/g, '\n');

const helperStart = src.indexOf('const RANK_DISPLAY_QUEUES');
const helperEnd = src.indexOf('function hasRankedQueueData');
assert.ok(helperStart > 0 && helperEnd > helperStart, '应能定位段位取用 helper');

const lineMatch = src.match(/function rankLineOf\(p\) \{[\s\S]*?\n\}\n/);
assert.ok(lineMatch, '应能定位 rankLineOf');

const ctx = vm.createContext({
  console,
  TIER_ICON: { DIAMOND: '<gem>', GOLD: '<medal>' },
  rankTierCN: t => ({ DIAMOND: '钻石', GOLD: '黄金', EMERALD: '翡翠' }[t] || t),
  rankCache: {}
});
vm.runInContext(src.slice(helperStart, helperEnd), ctx, { filename: 'home.rank-helpers.js' });
vm.runInContext(lineMatch[0], ctx, { filename: 'home.rankLine.js' });

const run = code => vm.runInContext(code, ctx);
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('ok ' + pass + ' - ' + name); };

// LCU 真实返回的空壳: tier 空、division "NA"、prov 剩 5 场
const emptySolo = { queueType: 'RANKED_SOLO_5x5', tier: '', division: 'NA', isProvisional: true, provisionalGamesRemaining: 5, leaguePoints: 0, wins: 0, losses: 0 };
const flexDiamond = { queueType: 'RANKED_FLEX_SR', tier: 'DIAMOND', division: 'II', leaguePoints: 24, wins: 30, losses: 20 };

ok('单双排空壳时回退灵活, 不再被空壳拦住', () => {
  const q = run(`rankedEntryOf(${JSON.stringify({ RANKED_SOLO_5x5: emptySolo, RANKED_FLEX_SR: flexDiamond })})`);
  assert.strictEqual(q.tier, 'DIAMOND');
  assert.strictEqual(q.queueType, 'RANKED_FLEX_SR');
});

ok('单双排有段位时优先单双排', () => {
  const solo = { queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', division: 'I', leaguePoints: 40 };
  const q = run(`rankedEntryOf(${JSON.stringify({ RANKED_SOLO_5x5: solo, RANKED_FLEX_SR: flexDiamond })})`);
  assert.strictEqual(q.tier, 'GOLD');
});

ok('打灵活的局里可以按队列优先取灵活', () => {
  const solo = { queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', division: 'I', leaguePoints: 40 };
  const q = run(`rankedEntryOf(${JSON.stringify({ RANKED_SOLO_5x5: solo, RANKED_FLEX_SR: flexDiamond })}, 'RANKED_FLEX_SR')`);
  assert.strictEqual(q.tier, 'DIAMOND');
});

ok('两个队列都空时返回 null, 不返回空壳', () => {
  assert.strictEqual(run(`rankedEntryOf(${JSON.stringify({ RANKED_SOLO_5x5: emptySolo, RANKED_FLEX_SR: { tier: '' } })})`), null);
  assert.strictEqual(run('rankedEntryOf(null)'), null);
});

ok('全空但带定级进度 → 认出"未定级", 不是无数据', () => {
  const prov = run(`rankedProvisionalOf(${JSON.stringify({ RANKED_SOLO_5x5: emptySolo })})`);
  assert.ok(prov, '应认出未定级');
  assert.strictEqual(prov.provisionalGamesRemaining, 5);
  // 有段位的队列不算未定级
  assert.strictEqual(run(`rankedProvisionalOf(${JSON.stringify({ RANKED_SOLO_5x5: { tier: 'GOLD' } })})`), null);
});

ok('详情页行: 灵活段位能显示出来, 并带"灵"标记', () => {
  run(`rankCache['p1'] = ${JSON.stringify({ RANKED_SOLO_5x5: emptySolo, RANKED_FLEX_SR: flexDiamond })}`);
  const html = run("rankLineOf({ puuid: 'p1' })");
  assert.ok(html.includes('钻石'), '应显示灵活段位, 实际 ' + html);
  assert.ok(html.includes('II'), '应带分段');
  assert.ok(html.includes('24'), '应带 LP');
  assert.ok(html.includes('ogd-rank-q'), '应带"来自灵活"的标记');
  assert.ok(html.includes('data-queue="flex"'));
});

ok('详情页行: 未定级显示进度而不是空白', () => {
  run(`rankCache['p2'] = ${JSON.stringify({ RANKED_SOLO_5x5: emptySolo })}`);
  const html = run("rankLineOf({ puuid: 'p2' })");
  assert.ok(html.includes('未定级'), '应写明未定级, 实际 ' + html);
  assert.ok(html.includes('剩5场'), '应带剩余定级场次');
  assert.ok(html.includes('is-unranked'), '应有未定级样式钩子');
});

ok('完全没有段位数据时保持空字符串 (回落到位置文案)', () => {
  assert.strictEqual(run("rankLineOf({ puuid: 'unknown' })"), '');
  run(`rankCache['p3'] = {}`);
  assert.strictEqual(run("rankLineOf({ puuid: 'p3' })"), '');
});

ok('空壳结果按失败档进缓存 (30 秒后可重查), 真段位按成功档', () => {
  // resolveRanks 里用 !!rankedEntryOf(queueMap) 决定 ok 位
  assert.ok(/rankCacheStore\(puuid, r\.queueMap \|\| \{\}, !!rankedEntryOf\(r\.queueMap\)\)/.test(src),
    '空壳结果应标记为非成功, 用短 TTL 重试');
  assert.ok(src.includes("const RANK_CACHE_FAIL_TTL = 30 * 1000"), '失败档 TTL 应为 30 秒');
});

ok('个人页段位卡区分"未定级"与"无排位"', () => {
  assert.ok(src.includes("const text = prov ? ('未定级' + (rem > 0 ? ` · 剩${rem}场` : '')) : '无排位';"),
    '两张段位卡应共用同一套未定级文案');
  assert.strictEqual(src.split("'未定级'").length - 1 >= 2, true, 'renderRankCards 与 rankCard 都要处理');
});

console.log('\nPASS ' + pass + ' cases');
