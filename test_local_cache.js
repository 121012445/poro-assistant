'use strict';
// renderer/js/local-cache.js: localStorage 里按玩家累积的首页缓存要能淘汰, 撞配额时要能自救。
// 用一个带配额的假 localStorage 跑真实脚本; 尺寸按比例缩小 (一份档案 7000 字符, 配额 1MiB ≈ 真实的 70 万字符 / 100MiB)。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('renderer/js/local-cache.js', 'utf8');
const html = fs.readFileSync('renderer/index.html', 'utf8');
const home = fs.readFileSync('renderer/js/home.js', 'utf8');

function makeStorage(quotaBytes) {
  const map = new Map();
  const bytes = () => { let n = 0; for (const [k, v] of map) n += (k.length + v.length) * 2; return n; };   // UTF-16
  return {
    map,
    get length() { return map.size; },
    key: i => [...map.keys()][i] ?? null,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      const old = map.has(k) ? (k.length + map.get(k).length) * 2 : 0;
      if (bytes() - old + (k.length + String(v).length) * 2 > quotaBytes) {
        const e = new Error('quota'); e.name = 'QuotaExceededError'; e.code = 22; throw e;
      }
      map.set(k, String(v));
    },
    removeItem: k => { map.delete(k); },
    bytes
  };
}
function load(store) {
  const ctx = vm.createContext({ localStorage: store, console, Date, JSON, Number, Math, Set, Array, Object, String, Error });
  vm.runInContext(src, ctx, { filename: 'local-cache.js' });   // 没有 window: 不会排启动定时器
  return ctx;
}
const QUOTA = 1024 * 1024;
const payload = (ts, n = 7000) => JSON.stringify({ ts, s: { puuid: 'x' }, games: 'g'.repeat(n) });
const HC = p => `poro.homeCache.${p}.0`;

// ---------- 1) 改动前的行为: 直接 setItem, 查过的人一多就撞配额, 连小缓存也写不进去 ----------
{
  const store = makeStorage(QUOTA);
  let failedAt = -1;
  for (let i = 0; i < 120; i++) {
    try { store.setItem(HC('p' + i), payload(1000 + i)); } catch (e) { failedAt = i; break; }
  }
  assert.ok(failedAt > 0, '对照组应当撞到配额');
  assert.throws(() => store.setItem('poro.perkMaps.v1', 'x'.repeat(2000)), /quota/, '对照组: 撞配额后符文图标缓存也写不进去');
  console.log(`  对照 (改动前): 查到第 ${failedAt + 1} 个玩家时开始写入失败, 之后所有缓存都写不进去`);
}

// ---------- 2) 改动后: 查 120 个玩家, 只保留本人 + 最近 12 个 ----------
{
  const store = makeStorage(QUOTA);
  const ctx = load(store);
  store.setItem('poro.selfPuuid', 'me');
  assert.strictEqual(ctx.writeHomeCacheEntry(HC('me'), payload(1)), true);
  store.setItem('poro.homeCache.me.1', payload(2));                 // 本人另一种组合 (很旧, 也不能删)
  for (let i = 0; i < 120; i++) {
    assert.strictEqual(ctx.writeHomeCacheEntry(HC('p' + i), payload(1000 + i), 1000 + i), true, `第 ${i + 1} 个玩家写入应成功`);
  }
  const homeKeys = [...store.map.keys()].filter(k => k.startsWith('poro.homeCache.')).sort();
  const others = homeKeys.filter(k => !k.startsWith('poro.homeCache.me.'));
  assert.ok(homeKeys.includes(HC('me')) && homeKeys.includes('poro.homeCache.me.1'), '本人的两份首页缓存必须保留');
  assert.ok(others.length <= 12 + 2, `其他玩家的缓存应被限制在约 12 份 (实际 ${others.length})`);
  assert.ok(others.length >= 12, '最近使用的 12 份应保留');
  assert.ok(others.includes(HC('p119')) && others.includes(HC('p108')), '最近查看的应保留');
  assert.ok(!others.includes(HC('p0')) && !others.includes(HC('p100')), '最早查看的应淘汰');
  assert.doesNotThrow(() => store.setItem('poro.perkMaps.v1', 'x'.repeat(2000)), '其他缓存仍能正常写入');
  const index = JSON.parse(store.getItem('poro.homeCacheIndex'));
  assert.ok(Object.keys(index).every(k => store.map.has(k)), '索引里不应残留已删除的键');
  console.log(`  改动后: 查 120 个玩家仍全部写入成功, 首页缓存保留 ${homeKeys.length} 份, 占用 ${(store.bytes() / 1024).toFixed(0)}KB / ${QUOTA / 1024}KB`);
}

// ---------- 3) 升级前已累积的旧缓存 (没有索引): 启动清理按值里的 ts 排序 ----------
{
  const store = makeStorage(QUOTA * 4);
  const ctx = load(store);
  store.setItem('poro.selfPuuid', 'me');
  store.setItem(HC('me'), payload(5));
  const order = Array.from({ length: 40 }, (_, i) => i).sort(() => Math.random() - 0.5);   // 写入顺序打乱, 只能靠 ts
  for (const i of order) store.setItem(HC('old' + i), payload(2000 + i));
  store.setItem('poro.homeCache.weird.0', 'not json');                                     // 读不出 ts 的坏值: 视为最旧
  const removed = ctx.pruneLocalCaches({ now: 5000 });
  const left = [...store.map.keys()].filter(k => k.startsWith('poro.homeCache.old'));
  assert.strictEqual(left.length, 12, '旧缓存应只剩 12 份');
  for (let i = 28; i < 40; i++) assert.ok(left.includes(HC('old' + i)), `ts 最新的 old${i} 应保留`);
  assert.ok(!store.map.has('poro.homeCache.weird.0'), '读不出时间的坏值应优先淘汰');
  assert.ok(store.map.has(HC('me')), '本人缓存保留');
  assert.strictEqual(removed, 29);
  const index = JSON.parse(store.getItem('poro.homeCacheIndex'));
  assert.strictEqual(index[HC('old39')], 2039, '旧缓存的时间应补进索引');
}

// ---------- 4) 小缓存: 过期的大区记忆、已空的待结算记录 ----------
{
  const store = makeStorage(QUOTA);
  const ctx = load(store);
  const now = 100 * 24 * 3600 * 1000;
  store.setItem('poro.playerPlatform.fresh', JSON.stringify({ platformId: 'HN1', ts: now - 1000 }));
  store.setItem('poro.playerPlatform.stale', JSON.stringify({ platformId: 'HN1', ts: now - 31 * 24 * 3600 * 1000 }));
  store.setItem('poro.playerPlatform.bad', '{');
  store.setItem('poro.pendingEog.empty', '[]');
  store.setItem('poro.pendingEog.old', JSON.stringify([{ gid: 1, savedAt: now - 7 * 3600 * 1000 }]));
  store.setItem('poro.pendingEog.live', JSON.stringify([{ gid: 2, savedAt: now - 3600 * 1000 }]));
  store.setItem('poro.perkMaps.v1', '{}');
  store.setItem('poro.hexAugMeta.v1', '{}');
  ctx.pruneLocalCaches({ now });
  const keys = [...store.map.keys()];
  assert.ok(keys.includes('poro.playerPlatform.fresh') && keys.includes('poro.pendingEog.live'), '仍有效的应保留');
  for (const k of ['poro.playerPlatform.stale', 'poro.playerPlatform.bad', 'poro.pendingEog.empty', 'poro.pendingEog.old']) {
    assert.ok(!keys.includes(k), k + ' 应被清理');
  }
  assert.ok(keys.includes('poro.perkMaps.v1') && keys.includes('poro.hexAugMeta.v1'), '无关的缓存不能动');
}

// ---------- 5) 撞配额: 只留本人与当前档案后重试 ----------
{
  const store = makeStorage(QUOTA);
  const ctx = load(store);
  store.setItem('poro.selfPuuid', 'me');
  store.setItem(HC('me'), payload(1));
  // 绕过统一入口塞满配额 (模拟升级前就快满了)
  for (let i = 0; ; i++) { try { store.setItem(HC('fill' + i), payload(3000 + i)); } catch (e) { break; } }
  const big = payload(9999, 40000);
  assert.strictEqual(ctx.writeHomeCacheEntry(HC('current'), big, 9999), true, '撞配额时应腾出空间后写入成功');
  assert.strictEqual(store.getItem(HC('current')), big);
  assert.ok(store.map.has(HC('me')), '腾空间时也不能删本人缓存');
  // 真放不下 (比配额还大) 时返回 false, 不抛异常
  assert.strictEqual(ctx.writeHomeCacheEntry(HC('huge'), 'x'.repeat(QUOTA), 10000), false);
  // 非配额错误不应触发清理
  const s2 = makeStorage(QUOTA);
  const c2 = load(s2);
  s2.setItem(HC('keepme'), payload(1));
  s2.setItem = () => { throw new Error('SecurityError'); };
  assert.strictEqual(c2.writeHomeCacheEntry(HC('x'), payload(2)), false);
  assert.ok(s2.map.has(HC('keepme')), '非配额错误不应删除任何缓存');
  assert.strictEqual(ctx.isQuotaError({ name: 'QuotaExceededError' }), true);
  assert.strictEqual(ctx.isQuotaError(new Error('x')), false);
}

// ---------- 6) 没有 localStorage (测试/异常环境): 不抛异常 ----------
{
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  assert.strictEqual(ctx.writeHomeCacheEntry('k', 'v'), false);
  assert.strictEqual(ctx.pruneLocalCaches(), 0);
}

// ---------- 7) 接线 ----------
const scripts = [...html.matchAll(/<script src="js\/([^"?]+)/g)].map(m => m[1]);
assert.ok(scripts.includes('local-cache.js'), 'index.html 应加载 local-cache.js');
assert.ok(scripts.indexOf('local-cache.js') < scripts.indexOf('home.js'), 'local-cache.js 必须在 home.js 之前加载');
assert.strictEqual((home.match(/writeHomeCacheEntry\(/g) || []).length, 3, 'home.js 的三处首页缓存写入都应走统一入口');
assert.ok(!/localStorage\.setItem\((state\.)?cacheKey/.test(home), 'home.js 不应再直接写首页缓存');
assert.ok(/setTimeout\(\(\) => \{ try \{ pruneLocalCaches\(\); \} catch \(e\) \{\} \}, 15000\)/.test(src), '启动后应空闲清理一次旧缓存');

console.log('首页 localStorage 缓存淘汰与配额保护测试通过');
