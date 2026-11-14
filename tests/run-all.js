'use strict';
// 依次跑 tests/ 下的所有 *.js (1.6.1 起的测试入口; 旧根目录 test_*.js 属于 1.5.x, 不再纳入)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'run-all.js').sort();
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, [path.join(dir, f)], { stdio: 'pipe' });
    console.log('PASS ' + f);
  } catch (e) {
    failed++;
    console.log('FAIL ' + f);
    const out = (e.stdout || Buffer.from('')).toString() + (e.stderr || Buffer.from('')).toString();
    console.log(out.split('\n').slice(0, 12).join('\n'));
  }
}
console.log('---- ' + (files.length - failed) + '/' + files.length + ' 通过 ----');
process.exit(failed ? 1 : 0);
