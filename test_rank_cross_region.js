'use strict';
// 1.6.30 跨区段位: LCU 的 /lol-ranked/v1/ranked-stats/{puuid} 只认本区。
// 别的 shard(如联盟三区 CQ100) 的玩家一律返回结构完整但 tier 为空的空壳
// (实测 岛村之刃#24310 的 10 人样本全空), 所以"段位同步中"会一直挂着。
// 这一版:
//   1) 认得出跨区, 段位行/段位卡直接写"跨区"而不是留空或写"无排位";
//   2) 搜索路径先定位大区再进档案页, 否则跨区玩家的战绩会按本区去查 (0 场);
//   3) 大区探测结果回写 profileOverride, 让上面两条判断真的生效。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('renderer/js/home.js', 'utf8').replace(/\r\n/g, '\n');
const hex = fs.readFileSync('renderer/js/hex.js', 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync('renderer/css/v4.css', 'utf8').replace(/\r\n/g, '\n');

function slice(startNeedle, endNeedle, label) {
  const a = src.indexOf(startNeedle);
  const b = src.indexOf(endNeedle);
  assert.ok(a > 0 && b > a, '应能定位 ' + label);
  return src.slice(a, b);
}

const crossSrc = slice('function playerCrossRegion', 'function renderHomeMmr', '跨区判定');
const lineSrc = src.match(/function rankLineOf\(p\) \{[\s\S]*?\n\}\n/);
assert.ok(lineSrc, '应能定位 rankLineOf');

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('ok ' + pass + ' - ' + name); };
const makeCtx = extra => vm.createContext(Object.assign({
  console,
  rankCache: {},
  cachedPlatformId: 'HN1',
  profileOverride: null,
  TIER_ICON: { DIAMOND: '<gem>' },
  rankTierCN: t => ({ DIAMOND: '璀璨钻石' }[t] || t),
  // 只认这两个 puuid 的平台, 其它人当作"平台未知"
  getRememberedPlayerPlatform: puuid => ({
    'cross-puuid': 'CQ100',
    'same-puuid': 'HN1'
  }[puuid] || '')
}, extra || {}));

const crossCtx = makeCtx();
vm.runInContext(crossSrc, crossCtx, { filename: 'home.cross.js' });

ok('本区玩家不算跨区', () => {
  assert.strictEqual(vm.runInContext("playerCrossRegion('same-puuid')", crossCtx), false);
});
ok('平台缓存不同 → 判为跨区', () => {
  assert.strictEqual(vm.runInContext("playerCrossRegion('cross-puuid')", crossCtx), true);
});
ok('平台未知的玩家不误判成跨区', () => {
  assert.strictEqual(vm.runInContext("playerCrossRegion('unknown-puuid')", crossCtx), false);
});
ok('当前大区还没识别出来时不判跨区', () => {
  const ctx = makeCtx({ cachedPlatformId: null });
  vm.runInContext(crossSrc, ctx, { filename: 'home.cross.js' });
  assert.strictEqual(vm.runInContext("playerCrossRegion('cross-puuid')", ctx), false);
});
ok('档案是大区探测出来的其它区 → homeProfileCrossRegion 为 true', () => {
  const ctx = makeCtx({ profileOverride: { puuid: 'cross-puuid', platformId: 'CQ100' } });
  vm.runInContext(crossSrc, ctx, { filename: 'home.cross.js' });
  assert.strictEqual(vm.runInContext('homeProfileCrossRegion()', ctx), true);
});
ok('档案大区还没回写时, 用玩家平台缓存兜底', () => {
  const ctx = makeCtx({ profileOverride: { puuid: 'cross-puuid', platformId: '' } });
  vm.runInContext(crossSrc, ctx, { filename: 'home.cross.js' });
  assert.strictEqual(vm.runInContext('homeProfileCrossRegion()', ctx), true);
});
ok('自己的档案不判跨区', () => {
  const ctx = makeCtx({ profileOverride: { puuid: 'same-puuid', platformId: 'HN1' } });
  vm.runInContext(crossSrc, ctx, { filename: 'home.cross.js' });
  assert.strictEqual(vm.runInContext('homeProfileCrossRegion()', ctx), false);
});

ok('详情页段位行: 跨区且无缓存 → 写"跨区"而不是空白', () => {
  const ctx = makeCtx();
  vm.runInContext(crossSrc, ctx, { filename: 'home.cross.js' });
  vm.runInContext(slice('const RANK_DISPLAY_QUEUES', 'function hasRankedQueueData', '段位 helper'), ctx, { filename: 'home.rank-helpers.js' });
  vm.runInContext(lineSrc[0], ctx, { filename: 'home.rankLine.js' });
  const html = vm.runInContext("rankLineOf({ puuid: 'cross-puuid' })", ctx);
  assert.ok(/ogd-rank is-cross/.test(html), '应带 is-cross 标记');
  assert.ok(/跨区/.test(html), '应有"跨区"文案');
  assert.ok(/title="[^"]*大区/.test(html), '应说明原因');
});
ok('详情页段位行: 平台未知且无缓存 → 仍然留空 (不误标)', () => {
  const ctx = makeCtx();
  vm.runInContext(crossSrc, ctx, { filename: 'home.cross.js' });
  vm.runInContext(slice('const RANK_DISPLAY_QUEUES', 'function hasRankedQueueData', '段位 helper'), ctx, { filename: 'home.rank-helpers.js' });
  vm.runInContext(lineSrc[0], ctx, { filename: 'home.rankLine.js' });
  assert.strictEqual(vm.runInContext("rankLineOf({ puuid: 'unknown-puuid' })", ctx), '');
});
ok('详情页段位行: 跨区 + LCU 空壳 → 仍是"跨区", 不能把本区默认的"未定级"当结论', () => {
  const ctx = makeCtx();
  vm.runInContext(crossSrc, ctx, { filename: 'home.cross.js' });
  vm.runInContext(slice('const RANK_DISPLAY_QUEUES', 'function hasRankedQueueData', '段位 helper'), ctx, { filename: 'home.rank-helpers.js' });
  vm.runInContext(lineSrc[0], ctx, { filename: 'home.rankLine.js' });
  const html = vm.runInContext("rankLineOf({ puuid: 'cross-puuid' }).length >= 0 && (rankCache['cross-puuid']={RANKED_SOLO_5x5:{tier:'',division:'NA',isProvisional:true,provisionalGamesRemaining:5}}, rankLineOf({ puuid: 'cross-puuid' }))", ctx);
  assert.ok(/is-cross/.test(html), '应标跨区');
  assert.ok(!/未定级/.test(html), '空壳的定级进度不能显示给跨区玩家');
});
ok('详情页段位行: 跨区玩家如果真有段位数据, 照常显示段位', () => {
  const ctx = makeCtx();
  vm.runInContext(crossSrc, ctx, { filename: 'home.cross.js' });
  vm.runInContext(slice('const RANK_DISPLAY_QUEUES', 'function hasRankedQueueData', '段位 helper'), ctx, { filename: 'home.rank-helpers.js' });
  vm.runInContext(lineSrc[0], ctx, { filename: 'home.rankLine.js' });
  const html = vm.runInContext("rankLineOf({ puuid: 'cross-puuid' }).length >= 0 && (rankCache['cross-puuid']={RANKED_SOLO_5x5:{tier:'DIAMOND',division:'II',leaguePoints:24}}, rankLineOf({ puuid: 'cross-puuid' }))", ctx);
  assert.ok(/data-tier="DIAMOND"/.test(html));
  assert.ok(!/is-cross/.test(html), '有真段位时不该再标跨区');
});

ok('resolveRanks 跳过跨区玩家, 不拿 LCU 空壳反复打请求', () => {
  assert.ok(/rankCacheFresh\(p, now\)\s*\n?\s*&& !\(typeof playerCrossRegion === 'function' && playerCrossRegion\(p\)\)/.test(src),
    'missing 过滤应排除跨区玩家');
});
ok('大区探测结果回写 profileOverride.platformId', () => {
  assert.ok(/if \(profileOverride && located\.found && located\.platformId\) \{\s*\n\s*profileOverride\.platformId = located\.platformId;/.test(src),
    'findSgpPlatform 分支应回写');
  assert.ok(/if \(profileOverride\) profileOverride\.platformId = e\.platformId;/.test(src),
    'catch 分支应回写');
  assert.ok(/if \(profileOverride && cached\.platformId\) profileOverride\.platformId = cached\.platformId;/.test(src),
    '缓存命中分支应回写');
});
ok('段位卡: 跨区写"跨区/需在对应大区查看", 不写"无排位"', () => {
  assert.ok(/homeProfileCrossRegion\(\) \|\| \(typeof playerCrossRegion === 'function' && playerCrossRegion\(s\.puuid\)\)/.test(src),
    'rankCard 应先判跨区');
  assert.ok(/rank-card-tier is-unranked"[^>]*>跨区</.test(src), '应输出跨区文案');
  assert.ok(/需在对应大区查看/.test(src), '应给出下一步');
});
ok('按名字搜索: LCU 命中后仍要定位大区并带进档案页', () => {
  const seg = hex.slice(hex.indexOf('const sum = await resolveSummonerByName'), hex.indexOf('// 点击玩家 → 首页档案页显示该玩家'));
  assert.ok(seg.includes('playerResolveRegions'), '应调大区定位');
  assert.ok(seg.includes('rememberPlayerPlatform'), '应缓存大区');
  assert.ok(/searchPlayerByPuuid\(sum\.puuid, fullTag, sum, hintPlatform \? \{ platformId: hintPlatform \} : \{\}\)/.test(seg),
    '应把 platformId 传给档案页');
});
ok('CSS: 跨区标记有中性灰样式', () => {
  assert.ok(/#page-home \.ogd-rank\.is-cross\s*\{[^}]*color: var\(--ink-3\)/.test(css), 'is-cross 应有样式');
});

console.log('\nPASS ' + pass + ' cases');
