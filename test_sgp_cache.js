'use strict';
// main/sgp-cache.js: 战绩分页缓存按字节限额; TTL、按 puuid 失效与原实现一致。
const assert = require('assert');
const fs = require('fs');
const { createSgpCache, UNKNOWN_SIZE_BYTES } = require('./main/sgp-cache');

let clock = 0;
const MB = 1024 * 1024;
const cache = createSgpCache({ ttlMs: 5 * 60 * 1000, maxEntries: 240, maxBytes: 32 * MB, now: () => clock });
const key = (puuid, start = 0, count = 20, tag = '') => `HN1|${puuid}|${start}|${count}|${tag}`;

// ---------- 1) 命中 / TTL ----------
const page = { games: [1, 2, 3] };
assert.strictEqual(cache.set(key('a'), page, 1 * MB), true);
assert.strictEqual(cache.get(key('a')), page, '应原样返回同一个对象');
clock += 5 * 60 * 1000 - 1;
assert.strictEqual(cache.get(key('a')), page, 'TTL 内命中');
clock += 1;
assert.strictEqual(cache.get(key('a')), undefined, '满 5 分钟后不再命中');
assert.strictEqual(cache.get(key('nope')), undefined);

// ---------- 2) 按字节限额: 模拟 5 分钟内查看多名玩家 ----------
clock = 1000;
const c2 = createSgpCache({ maxBytes: 32 * MB, now: () => clock });
// 首页每人 5 页 × 2MB, 实时页 10 人 × 1.5MB
const players = Array.from({ length: 8 }, (_, i) => 'p' + i);
for (const p of players) for (let s = 0; s < 5; s++) { clock += 10; c2.set(key(p, s * 20), { p, s }, 2 * MB); }
for (let i = 0; i < 10; i++) { clock += 10; c2.set(key('live' + i, 0, 30), { i }, 1.5 * MB); }
const st = c2.stats();
assert.ok(st.bytes <= 32 * MB, `总占用不得超过 32MB (实际 ${(st.bytes / MB).toFixed(1)}MB)`);
assert.ok(st.entries < 50, '条数应远小于原先放行的 240 条');
assert.ok(c2.get(key('live9', 0, 30)), '最新写入的应保留');
assert.strictEqual(c2.get(key('p0', 0)), undefined, '最早写入的应先被淘汰');
// 对照: 原实现只按条数 (240) 限流, 同样的 50 页全部保留
const naiveBytes = players.length * 5 * 2 * MB + 10 * 1.5 * MB;
console.log(`  同样 50 页 (共 ${(naiveBytes / MB).toFixed(0)}MB JSON): 原实现全部常驻; 现在保留 ${st.entries} 页 / ${(st.bytes / MB).toFixed(1)}MB`);

// ---------- 3) 记账一致: 覆盖写入、失效、过期 ----------
const c3 = createSgpCache({ maxBytes: 10 * MB, now: () => clock });
c3.set(key('x'), 1, 3 * MB);
c3.set(key('x'), 2, 1 * MB);                         // 同键覆盖不能重复计数
assert.strictEqual(c3.stats().bytes, 1 * MB);
assert.strictEqual(c3.get(key('x')), 2);
c3.set(key('y'), 3, 2 * MB);
c3.set(key('y', 20), 4, 2 * MB);
assert.strictEqual(c3.invalidatePuuid('y'), 2, '只清掉该 puuid 的分页');
assert.strictEqual(c3.stats().bytes, 1 * MB);
assert.strictEqual(c3.get(key('x')), 2, '其他玩家不受影响');
c3.set(key('xyz'), 9, 1);
assert.strictEqual(c3.invalidatePuuid('xy'), 0, '按 | 分段精确匹配, 不能前缀误删');
assert.strictEqual(c3.get(key('xyz')), 9, 'puuid 以 xy 开头的玩家不能被误删');
c3.invalidatePuuid('xyz');
clock += 6 * 60 * 1000;
c3.set(key('z'), 5, 1 * MB);                         // 写入时顺带清掉过期条目
assert.strictEqual(c3.stats().entries, 1);
assert.strictEqual(c3.stats().bytes, 1 * MB);
assert.strictEqual(c3.invalidatePuuid(''), 1, '不传 puuid 清空全部');
assert.strictEqual(c3.stats().bytes, 0);

// ---------- 4) 覆盖写入会刷新新旧顺序 ----------
const c4 = createSgpCache({ maxBytes: 2.5 * MB, now: () => clock });
c4.set(key('old'), 'old', 1 * MB);
c4.set(key('mid'), 'mid', 1 * MB);
c4.set(key('old'), 'old2', 1 * MB);                  // 重新写入 → 变成最新
c4.set(key('new'), 'new', 1 * MB);                   // 超额 → 淘汰最旧的 mid
assert.strictEqual(c4.get(key('mid')), undefined);
assert.strictEqual(c4.get(key('old')), 'old2');

// ---------- 5) 单条超过总额度不缓存; 大小未知按保守值计 ----------
const c5 = createSgpCache({ maxBytes: 4 * MB, now: () => clock });
c5.set(key('keep'), 'k', 1 * MB);
assert.strictEqual(c5.set(key('huge'), 'h', 5 * MB), false, '单条超额不缓存');
assert.strictEqual(c5.get(key('keep')), 'k', '也不能因此把其他条目挤掉');
c5.set(key('unknown'), 'u', 0);
assert.strictEqual(c5.stats().bytes, 1 * MB + UNKNOWN_SIZE_BYTES, '未知大小按保守估计计入');

// ---------- 6) 条数上限仍然生效 ----------
const c6 = createSgpCache({ maxEntries: 3, maxBytes: 100 * MB, now: () => clock });
for (let i = 0; i < 5; i++) c6.set(key('e' + i), i, 1);
assert.strictEqual(c6.stats().entries, 3);
assert.strictEqual(c6.get(key('e0')), undefined);

// ---------- 7) 接线 ----------
const sgpSrc = fs.readFileSync('main/sgp.js', 'utf8');
const main = fs.readFileSync('main/index.js', 'utf8');
assert.ok(/RESPONSE_BYTES\.set\(parsed, bytes\)/.test(sgpSrc), 'sgp.js 应记录每个响应的原始字节数');
assert.ok(/module\.exports = \{[^}]*responseBytes/.test(sgpSrc));
const { responseBytes } = require('./main/sgp');
assert.strictEqual(responseBytes(null), 0);
assert.strictEqual(responseBytes({}), 0, '不是 SGP 返回的对象应得到 0 (按保守值计)');
assert.ok(main.includes("sgpHistoryCache.set(key, data, sgp.responseBytes(data))"), 'index.js 写缓存时应带上响应大小');
assert.ok(main.includes('maxBytes: 32 * 1024 * 1024'), '主进程缓存应设置 32MB 字节上限');
assert.ok(!main.includes('const _sgpCache = new Map()'), '旧的按条数缓存应已移除');

console.log('SGP 分页缓存按字节限额测试通过');
