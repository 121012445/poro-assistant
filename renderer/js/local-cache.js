// localStorage 里按玩家累积的缓存: 淘汰与配额保护
//
// 问题: 每查看一个玩家, 首页就把他最近 100 场战绩 (约 70 万字符, UTF-16 约 1.4MB) 写进
// 'poro.homeCache.<puuid>.<0|1>', 从不删除。Chromium 会把整个 localStorage 常驻在渲染进程内存里,
// 查过的人越多, 内存越大; Electron 的单源配额是 100MiB, 约 70 个玩家后 setItem 开始抛
// QuotaExceededError —— 首页的写入都包在 try/catch 里, 于是缓存静默失效, 而且同一配额下的
// 符文图标、强化名称等兜底缓存也一起写不进去。
//
// 做法:
//   · 本人的首页缓存 (两种"含训练"组合) 永远保留
//   · 其他玩家只保留最近使用的 HOME_CACHE_MAX_OTHERS 份 (按写入时间)
//   · 顺带清理过期的大区记忆 (30 天) 和已经没有内容的待结算记录
//   · 写入撞到配额时: 先腾出空间再重试一次
// 写入时间记在一个小索引里; 没有索引的旧缓存从值开头的 {"ts":... 读取 (首页写入的对象 ts 总在第一位)。

const HOME_CACHE_PREFIX = 'poro.homeCache.';
const HOME_CACHE_INDEX_KEY = 'poro.homeCacheIndex';
const HOME_CACHE_MAX_OTHERS = 12;
const PLAYER_PLATFORM_PREFIX = 'poro.playerPlatform.';
const PENDING_EOG_PREFIX = 'poro.pendingEog.';
const PLAYER_PLATFORM_KEEP_MS = 30 * 24 * 60 * 60 * 1000;   // 与 home.js 的 PLAYER_PLATFORM_TTL 一致
const PENDING_EOG_KEEP_MS = 6 * 60 * 60 * 1000;             // 与 readPendingEogGames 的过滤一致

function localCacheStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
}

function readHomeCacheIndex(store) {
  try {
    const value = JSON.parse(store.getItem(HOME_CACHE_INDEX_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (e) { return {}; }
}

function homeCacheTimestamp(store, key, index) {
  const indexed = Number(index[key]);
  if (indexed > 0) return indexed;
  try {
    const m = /^\{"ts":(\d+)/.exec(String(store.getItem(key) || '').slice(0, 40));
    return m ? Number(m[1]) : 0;
  } catch (e) { return 0; }
}

function localCacheKeys(store) {
  const keys = [];
  try { for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k != null) keys.push(k); } } catch (e) {}
  return keys;
}

// 返回删掉的键数。opts.keep: 额外必须保留的键 (例如当前正在显示的档案);
// opts.maxOthers: 其他玩家最多保留几份 (配额告急时传 0)。
function pruneLocalCaches(opts) {
  const store = localCacheStorage();
  if (!store) return 0;
  const o = opts || {};
  const now = Number(o.now) || Date.now();
  const maxOthers = Number.isFinite(o.maxOthers) ? Math.max(0, o.maxOthers) : HOME_CACHE_MAX_OTHERS;
  const keep = new Set([].concat(o.keep || []).filter(Boolean));
  let selfPuuid = '';
  try { selfPuuid = String(store.getItem('poro.selfPuuid') || ''); } catch (e) {}
  if (selfPuuid) { keep.add(HOME_CACHE_PREFIX + selfPuuid + '.0'); keep.add(HOME_CACHE_PREFIX + selfPuuid + '.1'); }

  const index = readHomeCacheIndex(store);
  const keys = localCacheKeys(store);
  const remove = [];

  const others = keys
    .filter(k => k.startsWith(HOME_CACHE_PREFIX) && !keep.has(k))
    .map(k => ({ key: k, ts: homeCacheTimestamp(store, k, index) }))
    .sort((a, b) => b.ts - a.ts);
  for (const item of others.slice(maxOthers)) remove.push(item.key);

  for (const k of keys) {
    if (k.startsWith(PLAYER_PLATFORM_PREFIX)) {
      try {
        const v = JSON.parse(store.getItem(k) || 'null');
        if (!v || !(now - Number(v.ts) < PLAYER_PLATFORM_KEEP_MS)) remove.push(k);
      } catch (e) { remove.push(k); }
    } else if (k.startsWith(PENDING_EOG_PREFIX)) {
      try {
        const rows = JSON.parse(store.getItem(k) || '[]');
        const live = Array.isArray(rows) && rows.some(g => g && now - (+g.savedAt || +g.time || 0) < PENDING_EOG_KEEP_MS);
        if (!live) remove.push(k);
      } catch (e) { remove.push(k); }
    }
  }

  for (const k of remove) { try { store.removeItem(k); } catch (e) {} }
  // 索引只保留仍存在的首页缓存; 旧缓存的时间顺手补进索引, 下次不必再读值
  const alive = {};
  const removed = new Set(remove);
  for (const k of keys) {
    if (!k.startsWith(HOME_CACHE_PREFIX) || removed.has(k)) continue;
    const ts = homeCacheTimestamp(store, k, index);
    if (ts > 0) alive[k] = ts;
  }
  try { store.setItem(HOME_CACHE_INDEX_KEY, JSON.stringify(alive)); } catch (e) {}
  return remove.length;
}

function isQuotaError(error) {
  return !!error && (error.name === 'QuotaExceededError' || error.code === 22 || error.code === 1014);
}

// 首页缓存的统一写入口: 记录写入时间、超量时淘汰旧档案; 撞配额时只留本人和当前档案再重试一次。
// 返回是否写入成功 (调用方原先就忽略失败, 这里保持不抛异常)。
function writeHomeCacheEntry(key, value, now) {
  const store = localCacheStorage();
  if (!store || !key) return false;
  const t = Number(now) || Date.now();
  let ok = false;
  try {
    store.setItem(key, value);
    ok = true;
  } catch (error) {
    if (!isQuotaError(error)) return false;
    pruneLocalCaches({ keep: [key], maxOthers: 0, now: t });
    try { store.setItem(key, value); ok = true; } catch (e) { return false; }
  }
  const index = readHomeCacheIndex(store);
  index[key] = t;
  try { store.setItem(HOME_CACHE_INDEX_KEY, JSON.stringify(index)); } catch (e) {}
  const count = Object.keys(index).length;
  // 只有可能超量时才整体扫描, 平时写入只多一次小索引的读写
  if (count > HOME_CACHE_MAX_OTHERS + 2) pruneLocalCaches({ keep: [key], now: t });
  return ok;
}

// 启动后空闲时清理一次 (处理升级前已经累积的旧缓存); 不放在首屏路径上
if (typeof window !== 'undefined' && typeof setTimeout === 'function') {
  setTimeout(() => { try { pruneLocalCaches(); } catch (e) {} }, 15000);
}
