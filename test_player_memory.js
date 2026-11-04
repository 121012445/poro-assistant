// 玩家记忆（遭遇记录）断言
// 运行: node test_player_memory.js
//
// 背景：同一局里 gameId 可能晚一步才就绪，先按 p:<puuid集合> 记一次，随后变成
// g:<gameId> 又记一次，只碰过一次的人于是显示“遇见 2 次”。这里覆盖两条防线：
//   1) addEncounter 在换键时把上一条 p: 改成 g:，不再新增一局；
//   2) loadEncounters 的 v4→v5 迁移把历史数据里的同局双键合并掉。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('renderer/js/social.js', 'utf8');
const HEAD = '// ========== 对局历史遭遇标记 ==========';
const END = 'let _encounterHydrateBusy';
const slice = source.slice(source.indexOf(HEAD), source.indexOf(END));
assert(slice.length > 500, '未能截取遭遇记录片段');

function makeContext(stored, nowFn) {
  const store = new Map(stored ? [['encounters', JSON.stringify(stored)]] : []);
  const ctx = {
    console,
    playerMarks: {},
    // 沙箱内的 Date 是独立实例，必须注入一个可控时钟才能测时间窗
    Date: { now: () => (nowFn ? nowFn() : Date.now()) },
    storeGet: k => (store.has(k) ? store.get(k) : null),
    storeSet: (k, v) => { store.set(k, v); },
    isKnownPlayerName: n => !!n && !/^(未知|未知玩家|unknown|player|\?|-)$/i.test(String(n)),
    normalizePlayerMemory: (v, n) => ({ name: n, marks: [], note: '' }),
    savePlayerMemory: () => {}
  };
  vm.createContext(ctx);
  vm.runInContext(slice, ctx);
  ctx.__read = () => JSON.parse(store.get('encounters'));
  // let/const 声明不会挂到 context 上，只能回沙箱里取值
  ctx.__map = () => vm.runInContext('encounterMap', ctx);
  return ctx;
}

const P = 'p:AAA,BBB,CCC';
const G = 'g:11330512959';
let fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '  → ' + e.message); }
}

console.log('— 换键去重 —');
ok('同一局 p:→g: 只算一次', () => {
  const ctx = makeContext();
  ctx.addEncounter('u1', '小明', P);
  ctx.addEncounter('u1', '小明', G);
  const e = ctx.__map().u1;
  assert.strictEqual(e.count, 1, 'count=' + e.count);
  assert.deepStrictEqual([...e.seenGames], [G], JSON.stringify(e.seenGames));
});

ok('换键后重复渲染仍然只算一次', () => {
  const ctx = makeContext();
  ctx.addEncounter('u1', '小明', P);
  ctx.addEncounter('u1', '小明', G);
  ctx.addEncounter('u1', '小明', G);
  ctx.addEncounter('u1', '小明', G);
  assert.strictEqual(ctx.__map().u1.count, 1);
});

ok('换键发生在时间窗之外 → 按新的一局算', () => {
  const HOUR = 60 * 60 * 1000;
  let t = Date.now() - 3 * HOUR;
  const ctx = makeContext(null, () => t);
  ctx.addEncounter('u1', '小明', P);
  t = Date.now();
  ctx.addEncounter('u1', '小明', G);
  assert.strictEqual(ctx.__map().u1.count, 2, '3 小时前的 p: 不应被当成同一局');
});

ok('g:→p: 不归一（那是下一局 gameId 还没就绪）', () => {
  const ctx = makeContext();
  ctx.addEncounter('u1', '小明', G);
  ctx.addEncounter('u1', '小明', 'p:AAA,BBB,DDD');
  assert.strictEqual(ctx.__map().u1.count, 2, '两把不同的键必须算两局');
});

ok('两个不同 gameId 算两局', () => {
  const ctx = makeContext();
  ctx.addEncounter('u1', '小明', 'g:1');
  ctx.addEncounter('u1', '小明', 'g:2');
  assert.strictEqual(ctx.__map().u1.count, 2);
});

ok('未知名字不记录', () => {
  const ctx = makeContext();
  ctx.addEncounter('u1', '未知玩家', G);
  assert.strictEqual(ctx.__map().u1, undefined);
});

console.log('— v4 历史数据迁移 —');
const V4 = {
  __v: 4,
  map: {
    u1: { name: '甲', count: 2, lastTime: 1, seenGames: [P, G] },
    u2: { name: '乙', count: 2, lastTime: 1, seenGames: [P, G] },
    u3: { name: '丙', count: 2, lastTime: 1, seenGames: [P, G] },
    // 只有 p: 键（此局名字没解析出来）→ 不该被动
    u4: { name: '丁', count: 1, lastTime: 1, seenGames: [P] },
    // 真两局：两个不同 gameId
    u5: { name: '戊', count: 2, lastTime: 1, seenGames: ['g:1', 'g:2'] },
    // p: 键单独出现、没有配对 g: → 不动
    u6: { name: '己', count: 1, lastTime: 1, seenGames: ['p:ZZZ'] }
  }
};

ok('同局双键被合并，count 减 1', () => {
  const ctx = makeContext(V4);
  ctx.loadEncounters();
  const m = ctx.__read().map;
  for (const u of ['u1', 'u2', 'u3']) {
    assert.strictEqual(m[u].count, 1, u + ' count=' + m[u].count);
    assert.deepStrictEqual(m[u].seenGames, [G], u + ' keys=' + JSON.stringify(m[u].seenGames));
  }
});

ok('只有 p: 键的玩家不受影响', () => {
  const ctx = makeContext(V4);
  ctx.loadEncounters();
  const m = ctx.__read().map;
  assert.strictEqual(m.u4.count, 1);
  assert.deepStrictEqual(m.u4.seenGames, [P]);
});

ok('两个不同 gameId 的真两局不受影响', () => {
  const ctx = makeContext(V4);
  ctx.loadEncounters();
  assert.strictEqual(ctx.__read().map.u5.count, 2);
});

ok('孤立的 p: 键不受影响', () => {
  const ctx = makeContext(V4);
  ctx.loadEncounters();
  assert.strictEqual(ctx.__read().map.u6.count, 1);
});

ok('只有 1 人共现的同局对不合并（证据不足）', () => {
  const ctx = makeContext({ __v: 4, map: { solo: { name: '甲', count: 2, lastTime: 1, seenGames: [P, G] } } });
  ctx.loadEncounters();
  assert.strictEqual(ctx.__read().map.solo.count, 2, '单人证据不足以判定同局');
});

ok('p: 键若配对多个 g: 键则不合并', () => {
  const ctx = makeContext({
    __v: 4,
    map: {
      a: { name: '甲', count: 3, lastTime: 1, seenGames: [P, 'g:1'] },
      b: { name: '乙', count: 3, lastTime: 1, seenGames: [P, 'g:2'] }
    }
  });
  ctx.loadEncounters();
  const m = ctx.__read().map;
  assert.strictEqual(m.a.count, 3);
  assert.strictEqual(m.b.count, 3);
});

ok('升级到 v5 时不再把 count 折算成 1', () => {
  const ctx = makeContext({ __v: 4, map: { u9: { name: '庚', count: 7, lastTime: 1, seenGames: ['g:1', 'g:2', 'g:3'] } } });
  ctx.loadEncounters();
  const m = ctx.__read().map;
  assert.strictEqual(m.u9.count, 7, 'v4 的 count 是可信基线，不能折算');
  assert.strictEqual(ctx.__read().__v, 5);
});

ok('迁移只跑一次（v5 再载入不变）', () => {
  const ctx = makeContext(V4);
  ctx.loadEncounters();
  const first = JSON.stringify(ctx.__read());
  ctx.loadEncounters();
  assert.strictEqual(JSON.stringify(ctx.__read()), first, '二次载入不应再减');
});

ok('v3 旧数据仍按“至少 1 次”折算', () => {
  const ctx = makeContext({ __v: 3, map: { old: { name: '辛', count: 42, lastTime: 1, seenGames: [] } } });
  ctx.loadEncounters();
  assert.strictEqual(ctx.__read().map.old.count, 1);
});

console.log('');
if (fail) { console.log(fail + ' 条失败'); process.exit(1); }
console.log('玩家记忆断言全部通过');
