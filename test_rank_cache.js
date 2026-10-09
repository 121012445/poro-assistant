'use strict';
// rankCache: 成功结果 5 分钟过期, 失败结果 30 秒重试, 错误响应不得被当成"无段位"永久缓存, 数量有上限。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('renderer/js/home.js', 'utf8').replace(/\r\n/g, '\n');
const utils = fs.readFileSync('renderer/js/utils.js', 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('// puuid→段位缓存');
const end = source.indexOf('function hasRankedQueueData');
assert.ok(start > 0 && end > start, '应能在 home.js 中定位 rankCache 代码段');

let calls = [];
let responder = async () => ({ queueMap: { RANKED_SOLO_5x5: { tier: 'GOLD' } } });
const context = vm.createContext({
  console,
  poroIcon: name => '<' + name + '>',
  lolAPI: { lcuRequest: async (method, url) => { calls.push(url); return responder(url); } }
});
const mapStart = utils.indexOf('async function mapWithConcurrency');
assert.ok(mapStart >= 0, '应能在 utils.js 中定位 mapWithConcurrency');
vm.runInContext(utils.slice(mapStart, utils.indexOf('\n}\n', mapStart) + 3), context);   // 函数体以顶格的 "}" 结束
vm.runInContext(source.slice(start, end), context);
const run = code => vm.runInContext(code, context);
const url = id => `/lol-ranked/v1/ranked-stats/${id}`;

(async () => {
  // 1) 首次查询写入, 新鲜期内不重复请求
  await run("resolveRanks(['a', 'b', 'a'])");
  assert.deepStrictEqual(calls.sort(), [url('a'), url('b')], '重复 puuid 只应请求一次');
  calls = [];
  await run("resolveRanks(['a', 'b'])");
  assert.strictEqual(calls.length, 0, '5 分钟内不应重复请求');
  assert.strictEqual(run("rankCache.a.RANKED_SOLO_5x5.tier"), 'GOLD', '调用方仍按 rankCache[puuid] 读取');

  // 2) 成功结果超过 TTL 后重新请求, 且刷新期间旧值可读、更新后换新值
  run("rankCacheAt.a.t -= RANK_CACHE_TTL + 1");
  responder = async () => ({ queueMap: { RANKED_SOLO_5x5: { tier: 'PLATINUM' } } });
  await run("resolveRanks(['a', 'b'])");
  assert.deepStrictEqual(calls, [url('a')], '只有过期的 a 需要刷新');
  assert.strictEqual(run("rankCache.a.RANKED_SOLO_5x5.tier"), 'PLATINUM', '过期后应取到新段位');
  calls = [];

  // 3) 带 __error 的响应 (LCU 对 4xx/5xx 不抛异常) 不得被固化成"没有段位"
  responder = async () => ({ __error: 'HTTP 500', httpStatus: 500 });
  await run("resolveRanks(['c'])");
  assert.deepStrictEqual(JSON.parse(run("JSON.stringify(rankCache.c)")), {}, '首次失败只能暂存空段位');
  assert.strictEqual(run("rankCacheAt.c.ok"), false, '必须标记为失败');
  calls = [];
  await run("resolveRanks(['c'])");
  assert.strictEqual(calls.length, 0, '失败后 30 秒内不应打爆 LCU');
  run("rankCacheAt.c.t -= RANK_CACHE_FAIL_TTL + 1");
  responder = async () => ({ queueMap: { RANKED_SOLO_5x5: { tier: 'SILVER' } } });
  await run("resolveRanks(['c'])");
  assert.strictEqual(calls.length, 1, '失败结果过期后应重试');
  assert.strictEqual(run("rankCache.c.RANKED_SOLO_5x5.tier"), 'SILVER', '重试成功后恢复正常');
  assert.strictEqual(run("rankCacheAt.c.ok"), true);
  calls = [];

  // 4) 刷新失败时保留旧值, 而不是退化成空段位
  run("rankCacheAt.a.t -= RANK_CACHE_TTL + 1");
  responder = async () => { throw new Error('LCU 连接失败'); };
  await run("resolveRanks(['a'])");
  assert.strictEqual(run("rankCache.a.RANKED_SOLO_5x5.tier"), 'PLATINUM', '刷新失败应保留上次已知段位');
  assert.strictEqual(run("rankCacheAt.a.ok"), false);

  // 5) 空响应 (null) 同样按失败处理
  responder = async () => null;
  await run("resolveRanks(['d'])");
  assert.strictEqual(run("rankCacheAt.d.ok"), false, 'null 响应不是有效段位数据');

  // 6) 数量上限: 超出后淘汰最旧的
  for (let i = 0; i < 305; i++) run(`rankCacheStore('p${i}', {}, true, ${1000 + i})`);
  assert.ok(Object.keys(run('rankCache')).length <= run('RANK_CACHE_MAX'), '缓存条数不得超过上限');
  assert.strictEqual(Object.keys(run('rankCache')).length, Object.keys(run('rankCacheAt')).length, '两张表必须同步淘汰');
  assert.strictEqual(run("'p0' in rankCache"), false, '最旧的条目应被淘汰');
  assert.strictEqual(run("'p304' in rankCache"), true, '最新的条目应保留');

  console.log('段位缓存 TTL / 失败重试 / 上限测试通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
