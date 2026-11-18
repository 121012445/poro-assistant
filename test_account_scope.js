// 账号作用域存储键断言 (persist.js)
// 运行: node test_account_scope.js
//
// 背景: 成长台账/复盘/玩家记忆原本是全局单键, 切到日服账号后仍读国服历史。
// 修复: 外服账号用 '@<平台>:<puuid前缀>' 作键后缀隔离; 国服(HN1)/未知账号走原键,
// 保证已有的国服历史原封不动保留, 零迁移、零丢失。这里覆盖这条不变量。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('renderer/js/persist.js', 'utf8');
const START = source.indexOf('function currentAccountScope()');
const END = source.indexOf('async function loadStore()');
assert(START >= 0 && END > START, '未能截取账号作用域函数片段');
const slice = source.slice(START, END);

// 构造可注入身份的沙箱
function makeCtx({ puuid = '', platform = '', sessionPlatform = '', localStoragePlatform = '' } = {}) {
  const ls = {};
  if (localStoragePlatform && puuid) ls['poro.playerPlatform.' + puuid] = JSON.stringify({ platformId: localStoragePlatform });
  const ctx = {
    window: {
      _myPuuid: puuid,
      poroSession: { snapshot: () => ({ accountPuuid: puuid, platformId: sessionPlatform }) }
    },
    localStorage: { getItem: k => (k in ls ? ls[k] : null) },
    cachedPlatformId: platform
  };
  vm.createContext(ctx);
  vm.runInContext(slice, ctx);
  return ctx;
}

let fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '  → ' + e.message); }
}

console.log('— 国服/未知账号走原键 —');
ok('国服 HN1 用原键(保留历史)', () => {
  const c = makeCtx({ puuid: 'abcdef-国服账号', platform: 'HN1' });
  assert.strictEqual(vm.runInContext("accountStoreKey('gameLedger')", c), 'gameLedger');
});
ok('无 puuid(未登录)用原键', () => {
  const c = makeCtx({ puuid: '', platform: 'JP1' });
  assert.strictEqual(vm.runInContext("accountStoreKey('gameLedger')", c), 'gameLedger');
});
ok('平台未知(空)用原键', () => {
  const c = makeCtx({ puuid: 'some-puuid', platform: '' });
  assert.strictEqual(vm.runInContext("accountStoreKey('gameLedger')", c), 'gameLedger');
});

console.log('— 外服账号隔离 —');
ok('日服 JP1 用隔离键, 含平台与 puuid 前缀', () => {
  const c = makeCtx({ puuid: '87d257af-b874-5b5e', platform: 'JP1' });
  const key = vm.runInContext("accountStoreKey('gameLedger')", c);
  assert.strictEqual(key, 'gameLedger@JP1:87d257af-b874-5b');
  assert.strictEqual(key.length, 'gameLedger@JP1:'.length + 16);
});
ok('两个不同日服账号键不同(互不干扰)', () => {
  const a = makeCtx({ puuid: '87d257af-aaaa-bbbb', platform: 'JP1' });
  const b = makeCtx({ puuid: '87d257af-cccc-dddd', platform: 'JP1' });
  const ka = vm.runInContext("accountStoreKey('playerMarks')", a);
  const kb = vm.runInContext("accountStoreKey('playerMarks')", b);
  assert.notStrictEqual(ka, kb, '不同 puuid 必须隔离');
});
ok('同 puuid 不同平台键不同', () => {
  const a = makeCtx({ puuid: 'same-puuid-123456', platform: 'JP1' });
  const b = makeCtx({ puuid: 'same-puuid-123456', platform: 'NA1' });
  assert.notStrictEqual(
    vm.runInContext("accountStoreKey('gameLedger')", a),
    vm.runInContext("accountStoreKey('gameLedger')", b)
  );
});
ok('platform 回退: cachedPlatformId 为空时用 poroSession', () => {
  const c = makeCtx({ puuid: 'feedface-1234-5678', platform: '', sessionPlatform: 'JP1' });
  assert.strictEqual(vm.runInContext("accountStoreKey('gameLedger')", c), 'gameLedger@JP1:feedface-1234-56');
});
ok('platform 回退: 再用 localStorage 记忆', () => {
  const c = makeCtx({ puuid: 'cafebeef-1234-5678', platform: '', sessionPlatform: '', localStoragePlatform: 'JP1' });
  assert.strictEqual(vm.runInContext("accountStoreKey('gameLedger')", c), 'gameLedger@JP1:cafebeef-1234-56');
});

console.log('— aiReview 前缀扫描 —');
ok('国服前缀 = aiReview:', () => {
  const c = makeCtx({ puuid: 'x', platform: 'HN1' });
  assert.strictEqual(vm.runInContext("accountKeyPrefix('aiReview:')", c), 'aiReview:');
});
ok('外服前缀含作用域, 只扫当前账号复盘', () => {
  const c = makeCtx({ puuid: '87d257af-b874-5b5e', platform: 'JP1' });
  assert.strictEqual(vm.runInContext("accountKeyPrefix('aiReview:')", c), 'aiReview:@JP1:87d257af-b874-5b:');
});

console.log('— 作用域变化检测 —');
ok('同一作用域第二次返回 false', () => {
  const c = makeCtx({ puuid: 'abc', platform: 'JP1' });
  assert.strictEqual(vm.runInContext('accountScopeChanged()', c), true);
  assert.strictEqual(vm.runInContext('accountScopeChanged()', c), false);
});
ok('账号切换后返回 true', () => {
  const c = makeCtx({ puuid: 'abc', platform: 'JP1' });
  vm.runInContext('accountScopeChanged()', c);
  // snapshot 是身份首选来源, 切换账号时它先变(真实流程里 setAccount 更新它)
  c.window.poroSession.snapshot = () => ({ accountPuuid: 'xyz-changed', platformId: 'JP1' });
  assert.strictEqual(vm.runInContext('accountScopeChanged()', c), true);
});

console.log('\n账号作用域存储键测试通过\n');
if (fail) { console.error(fail + ' 条失败'); process.exitCode = 1; }
