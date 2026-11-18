// 回归: 切换账号/切换客户端后, 大区(platformId)必须重新识别, 不能沿用上一个账号的。
// 背景 bug: getPlatformId() 只按进程生命周期缓存 cachedPlatformId, 从日服切到国服账号后
// 首页仍显示"大区: 日本", 且国服账号被误判成外服走 LCU 分支, currentAccountScope()
// 还会给国服账号套上 '@JP1:...' 的作用域键。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HOME = path.join(__dirname, 'renderer', 'js', 'home.js');
const src = fs.readFileSync(HOME, 'utf8');

function extractFn(source, name) {
  let start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing fn ' + name);
  const asyncIdx = source.lastIndexOf('async ', start);
  if (asyncIdx >= 0 && start - asyncIdx === 6) start = asyncIdx;
  let depth = 0, began = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') { depth++; began = true; }
    else if (source[i] === '}') { depth--; if (began && depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const aliasesMatch = src.match(/const PLATFORM_ALIASES = \{[\s\S]*?\n\};/);
assert.ok(aliasesMatch, '找不到 PLATFORM_ALIASES');

const preamble = `
let cachedPlatformId = null;
let cachedPlatformIdPuuid = null;
const SGP_PLATFORM_IDS = ['HN1','HN10','NJ100','GZ100','CQ100','TJ100','TJ101','BGP2'];
const RIOT_PLATFORM_IDS = ['BR1','EUN1','EUW1','JP1','KR','LA1','LA2','NA1','OC1','TR1','RU','PH2','SG2','TH2','TW2','VN2'];
const __calls = { status: 0, request: 0 };
let __status = null;
let __history = null;
const lolAPI = {
  lcuStatus: async () => { __calls.status++; return __status; },
  lcuRequest: async () => { __calls.request++; return __history; },
  debugLog: () => {}
};
${aliasesMatch[0]}
${extractFn(src, 'normalizePlatformId')}
${extractFn(src, 'syncPlatformCacheAccount')}
${extractFn(src, 'rememberPlatformId')}
${extractFn(src, 'getPlatformId')}
globalThis.__api = {
  getPlatformId, syncPlatformCacheAccount, rememberPlatformId,
  setCache: (p, u) => { cachedPlatformId = p; cachedPlatformIdPuuid = u; },
  getCache: () => ({ platformId: cachedPlatformId, puuid: cachedPlatformIdPuuid }),
  calls: __calls,
  setStatus: s => { __status = s; },
  setHistory: h => { __history = h; },
  reset: () => { __calls.status = 0; __calls.request = 0; }
};
`;

const ctx = vm.createContext({ console });
vm.runInContext(preamble, ctx, { filename: 'home-platform-extract.js' });
const api = ctx.__api;

(async () => {
  // ---- 用例 1: 日服 → 国服换号, 必须重新识别 (核心 bug) ----
  api.setCache('JP1', 'puuid-JP');
  api.reset();
  api.setStatus({ connected: true, summoner: { puuid: 'puuid-CN', platformId: 'HN1' } });
  const p1 = await api.getPlatformId();
  assert.strictEqual(p1, 'HN1', '换号后必须识别成 HN1(国服), 不能沿用 Japan(JP1)');
  assert.strictEqual(api.getCache().puuid, 'puuid-CN', '平台缓存必须重新绑定到新账号');
  assert.strictEqual(api.calls.request, 0, '能直接从 status 拿到平台时不该再打历史接口');

  // ---- 用例 2: 同一账号复用缓存, 不重复探测 ----
  api.reset();
  api.setStatus({ connected: true, summoner: { puuid: 'puuid-CN', platformId: 'HN1' } });
  const p2 = await api.getPlatformId();
  assert.strictEqual(p2, 'HN1');
  assert.strictEqual(api.calls.request, 0, '同账号应直接命中缓存');

  // ---- 用例 3: 换号且 status 没给平台 → 走历史接口定位, 结果要绑到新账号 ----
  api.setCache('JP1', 'puuid-JP');
  api.reset();
  api.setStatus({ connected: true, summoner: { puuid: 'puuid-JP2' } });
  api.setHistory({ games: { games: [{ platformId: 'JP1' }] } });
  const p3 = await api.getPlatformId();
  assert.strictEqual(p3, 'JP1', '历史接口定位日服应得 JP1');
  assert.strictEqual(api.getCache().puuid, 'puuid-JP2', '历史接口定位结果也必须绑到新账号');
  assert.ok(api.calls.request >= 1, 'status 缺平台时应回落到历史接口');

  // ---- 用例 4: 客户端瞬时未连接(拿不到 puuid)时, 不能把已知大区抹掉 ----
  api.setCache('JP1', 'puuid-JP');
  api.reset();
  api.setStatus({ connected: false, summoner: null });
  const p4 = await api.getPlatformId();
  assert.strictEqual(p4, 'JP1', '读不到当前账号时应保留已知平台, 避免每次断连都重新探测');

  // ---- 用例 5: 国服 TENCENT 别名归一化仍然正确 ----
  api.setCache(null, null);
  api.reset();
  api.setStatus({ connected: true, summoner: { puuid: 'puuid-CN2', platformId: 'TENCENT' } });
  const p5 = await api.getPlatformId();
  assert.strictEqual(p5, 'HN1', 'TENCENT 必须归一化成 HN1');

  // ---- 用例 6: PoroSessionState 换账号时必须丢掉上一个大区 ----
  const sessionSrc = fs.readFileSync(path.join(__dirname, 'renderer', 'js', 'session-state.js'), 'utf8');
  const sctx = vm.createContext({ window: {}, console });
  vm.runInContext(sessionSrc, sctx, { filename: 'session-state.js' });
  const st = sctx.window.poroSession;
  st.setAccount('puuid-JP', 'JP1');
  assert.strictEqual(st.snapshot().platformId, 'JP1');
  st.setAccount('puuid-CN', '');
  assert.strictEqual(st.snapshot().platformId, '', '换账号后不能让上一个账号的 JP1 继续挂着');
  st.setAccount('puuid-CN', 'HN1');
  assert.strictEqual(st.snapshot().platformId, 'HN1', '识别完成后应能写入正确平台');

  console.log('test_home_platform_account: 6 组断言全部通过');
})().catch(e => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
