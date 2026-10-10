'use strict';
// 主进程的 SGP 战绩分页缓存 (从 index.js 抽出, 便于测试)。
//
// 原实现只按条数限流 (240 条), 而每条是一整页原始 Match-V5 战绩 (每场含 10 名玩家的全部字段),
// 一页 20~100 场。首页 100 场 + 实时页 10 人 × 30 场, 一会儿就是几十 MB 的 JSON 解析成对象常驻主进程,
// 5 分钟内查看多个玩家时还会叠加。现在按原始响应字节数限额 (解析后的对象通常比 JSON 文本大数倍),
// 超出时从最旧的开始淘汰; TTL、按 puuid 失效、命中逻辑与原实现一致。

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 240;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const UNKNOWN_SIZE_BYTES = 512 * 1024;      // 拿不到实际大小时的保守估计

function createSgpCache(options) {
  const opts = options || {};
  const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS;
  const maxEntries = Number(opts.maxEntries) > 0 ? Number(opts.maxEntries) : DEFAULT_MAX_ENTRIES;
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const map = new Map();       // key → { t, data, bytes }; Map 保持插入顺序 = 从旧到新
  let totalBytes = 0;

  function drop(key) {
    const entry = map.get(key);
    if (!entry) return false;
    totalBytes -= entry.bytes;
    map.delete(key);
    return true;
  }

  function prune() {
    const t = now();
    for (const [k, v] of map) if (t - v.t >= ttlMs) drop(k);
    for (const k of map.keys()) {
      if (map.size <= maxEntries && totalBytes <= maxBytes) break;
      drop(k);
    }
  }

  function get(key) {
    const hit = map.get(key);
    if (hit && now() - hit.t < ttlMs) return hit.data;
    return undefined;
  }

  function set(key, data, bytes) {
    const size = Number(bytes) > 0 ? Number(bytes) : UNKNOWN_SIZE_BYTES;
    drop(key);                       // 重新插入到末尾 (最新)
    // 单条就超过总额度: 不缓存, 免得把其他所有条目都挤掉
    if (size > maxBytes) { prune(); return false; }
    map.set(key, { t: now(), data, bytes: size });
    totalBytes += size;
    prune();
    return true;
  }

  // key 形如 platformId|puuid|start|count|tag; 不传 puuid 清空全部
  function invalidatePuuid(puuid) {
    const target = String(puuid || '').trim();
    let removed = 0;
    for (const key of [...map.keys()]) {
      const parts = key.split('|');
      if (!target || parts[1] === target) { drop(key); removed++; }
    }
    return removed;
  }

  function stats() { return { entries: map.size, bytes: totalBytes, maxBytes, maxEntries }; }

  return { get, set, invalidatePuuid, prune, stats };
}

module.exports = { createSgpCache, DEFAULT_MAX_BYTES, UNKNOWN_SIZE_BYTES };
