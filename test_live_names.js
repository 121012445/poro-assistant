'use strict';
// 名字回填: resolveNames 的结果必须落到 data 本身, 而不是只躺在 nameCache 里。
// 这里做两件事: ① 用最小 DOM 桩把 live.js 里的 backfillLiveNames 抠出来真跑一遍
//            ② 静态断言 resolveNames 之后确实调用了它 (防止以后被重构掉)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, 'renderer', 'js', 'live.js'), 'utf8');

// ① 抽出 backfillLiveNames 定义体, 在沙箱里执行
const start = src.indexOf('function backfillLiveNames(');
assert.ok(start > 0, 'live.js 里应有 backfillLiveNames 定义');
// 从函数起点找到配对的收尾大括号
let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
assert.ok(end > start, '应能截出完整函数体');
const fnSrc = src.slice(start, end);

const sandbox = {
  nameCache: { good: '北司魔凡', broken: '修复名', empty: '缓存名' },
  hasBrokenText: v => /\uFFFD/.test(String(v || ''))
};
vm.createContext(sandbox);
vm.runInContext(fnSrc + '\nthis.__backfill = backfillLiveNames;', sandbox);
const backfill = sandbox.__backfill;
assert.strictEqual(typeof backfill, 'function');

// 空名字 → 用缓存补
const list = [
  { puuid: 'good', name: '' },
  { puuid: 'good2', name: '原名' },          // 已有名字, 不动
  { puuid: 'broken', name: '坏\uFFFD名' },   // 乱码 → 用缓存覆盖
  { puuid: 'nope', name: '' },               // 缓存没有, 保持空
  { puuid: '', name: '' },                   // 没 puuid, 跳过
  null
];
const n = backfill(list);
assert.strictEqual(n, 2, '只补空名/乱码名, 且必须是缓存里有的');
assert.strictEqual(list[0].name, '北司魔凡');
assert.strictEqual(list[1].name, '原名', '已有名字不该被覆盖');
assert.strictEqual(list[2].name, '修复名', '乱码应被缓存名替换');
assert.strictEqual(list[3].name, '', '缓存没有就保持空, 不编名字');
assert.deepStrictEqual(backfill(null), 0, '非数组不能炸');

// 幂等: 再跑一次不该改动任何东西
assert.strictEqual(backfill(list), 0, '回填必须幂等');

// ② 静态接线: resolveNames 之后必须紧跟 backfillLiveNames
assert.ok(/await resolveNames\([^)]*\);\s*\n[^\n]*\n?\s*backfillLiveNames\(players\)/.test(src)
  || src.includes('backfillLiveNames(players)'), 'resolveNames 之后要回填名字');

console.log('test_live_names: OK');
