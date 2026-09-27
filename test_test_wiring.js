'use strict';
// 测试接线守卫: 防止"测试写了但没接进 npm test"
//
// 为什么需要:
//   2026-09-27 分析源码时发现 6 个 test_*.js (eog_ledger / home_identity /
//   match_premade / profile_refresh / progress_report / rank_recovery) 单独跑全部通过,
//   却都不在 package.json 的 test 脚本里 —— 既不被执行, 又都还是 untracked。
//   它们覆盖的正好是近期改动最密的区域, 等于那部分的回归保护是空的。
//
//   npm test 是一串 `&&` 拼起来的显式列表, 新增测试时忘了往里加**完全静默**:
//   `npm test` 照样全绿, 谁也不会发现少跑了几个。所以这里用静态检查把它钉死。
//
// 用法: node test_test_wiring.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const script = pkg.scripts.test || '';

// npm test 里真正被 node 执行的脚本
const invoked = new Set();
for (const m of script.matchAll(/node\s+([^\s&|;]+\.js)/g)) invoked.add(path.basename(m[1]));

// 磁盘上的所有 test_*.js
const onDisk = fs.readdirSync(root).filter(f => /^test_.*\.js$/.test(f)).sort();

// 故意不接线的 (手工 E2E, 有副作用): 必须在文件里自己写 `// npm-test: opt-out (原因)`。
// 用文件内标记而不是集中白名单 —— 白名单会和文件脱节: 文件删了它还在, 或者反过来。
const OPT_OUT = /\/\/\s*npm-test:\s*opt-out\s*\(?([^\n]*)\)?/;
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const optedOut = onDisk.filter(f => !invoked.has(f) && OPT_OUT.test(read(f)));
const missing = onDisk.filter(f => !invoked.has(f) && !optedOut.includes(f));
const ghost = [...invoked].filter(f => /^test_/.test(f) && !onDisk.includes(f));

console.log('测试接线检查');
console.log('  npm test 执行的脚本 :', invoked.size);
console.log('  磁盘上的 test_*.js  :', onDisk.length);

if (optedOut.length) {
  console.log('\n故意不接线 (已在文件里声明 opt-out):');
  for (const f of optedOut) console.log('  - ' + f + '  ' + (OPT_OUT.exec(read(f))[1] || '').trim());
}
if (missing.length) {
  console.log('\n写了但没接进 npm test (不会被执行):');
  for (const f of missing) console.log('  - ' + f);
}
if (ghost.length) {
  console.log('\nnpm test 引用了磁盘上不存在的文件:');
  for (const f of ghost) console.log('  - ' + f);
}

assert.deepStrictEqual(missing, [], '有 test_*.js 没接进 npm test —— 写了也不会被执行');
assert.deepStrictEqual(ghost, [], 'npm test 引用了不存在的测试文件');

console.log('\n测试接线检查通过: 所有 test_*.js 都在 npm test 里');
