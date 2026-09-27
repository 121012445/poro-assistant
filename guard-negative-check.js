#!/usr/bin/env node
'use strict';
/**
 * 守卫负向验证（元测试）—— **手工运行，不在 `npm test` 里**。
 *
 *   node guard-negative-check.js
 *
 * 为什么需要它
 * ------------
 * 一个只会输出"通过"的检查，如果它其实抓不到任何东西，看起来是一模一样的。
 * 2026-09-27 就实测到一个完全瞎掉的守卫：`test_dangling.js` 的旧正则只取
 * `="` 后面的第一个标识符，于是 `onclick="if(x)closeModal()"` 这种写法
 * 把 `if` 报成函数名（噪音），而真正被调用的 `closeModal` 完全看不到（漏报）——
 * **按钮已经死了，测试照样全绿。**
 *
 * 所以：判断一个守卫有没有价值，唯一办法是**故意注入一个它本该抓到的错误**，
 * 看它报不报；而且要确认它是**因为正确的理由**报的（断言消息要对得上），
 * 不能只是"被篡改搞崩了"。
 *
 * 为什么不在 npm test 里
 * --------------------
 * 它会**临时篡改工作区文件**（备份 → 篡改 → 跑守卫 → 无条件还原）。
 * 放进 `npm test` 一旦被中断，可能留下被篡改的源码。所以只做手工工具。
 * 脚本末尾有"还原自检"，会比对每个文件与备份是否一致。
 *
 * 改了守卫之后请跑一次，并在提交信息里留下结果。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const BACKUP = path.join(os.tmpdir(), 'poro-guard-backup');

// 每条: { guard, file, from|fromRe, to, desc }
// 用 fromRe 而不是写死字符串的地方，是因为缓存戳每次升版都会变（写死会失效）。
const CASES = [
  // ---- check_build.js: 出包自检 ----
  {
    guard: 'check_build.js', file: 'renderer/index.html',
    fromRe: /js\/utils\.js\?v=\d+"/, to: 'js/utils.js"',
    desc: 'JS 缓存戳整个丢失'
  },
  {
    guard: 'check_build.js', file: 'renderer/index.html',
    fromRe: /css\/dark\.css\?v=\d+"/, to: 'css/dark.css"',
    desc: 'CSS 缓存戳整个丢失'
  },
  {
    guard: 'check_build.js', file: 'renderer/index.html',
    from: 'href="css/extras.css?v=', to: 'href="css/__missing_file__.css?v=',
    desc: '样式表文件不存在'
  },

  // ---- test_diagnostics.js: 提权状态上界面 ----
  {
    guard: 'test_diagnostics.js', file: 'renderer/index.html',
    from: 'id="elevationNotice"', to: 'id="elevationNoticeRENAMED"',
    desc: '提权提示挂载点被改名'
  },
  {
    guard: 'test_diagnostics.js', file: 'main/index.js',
    from: "ipcMain.handle('app:elevation'", to: "ipcMain.handle('app:elevationRENAMED'",
    desc: 'app:elevation IPC 被改名'
  },

  // ---- test_limited_build.js: 双包防漂移 ----
  {
    guard: 'test_limited_build.js', file: 'electron-builder.limited.js',
    from: "requestedExecutionLevel: 'asInvoker'", to: "requestedExecutionLevel: 'requireAdministrator'",
    desc: '受限版被改回需要提权（这正是"装完闪退"的成因，守卫必须拦住）'
  },
  {
    guard: 'test_limited_build.js', file: 'electron-builder.limited.js',
    from: "output: 'dist-limited'", to: "output: 'dist'",
    desc: '两个包输出到同一目录（会互相覆盖可执行文件）'
  },

  // ---- test_startup_resilience.js: 渲染进程崩溃恢复 ----
  {
    guard: 'test_startup_resilience.js', file: 'main/index.js',
    from: 'if (!rendererCompatActive) {',
    to: "if (reason === 'launch-failed' && !rendererCompatActive) {",
    desc: '第二级恢复被改回只认 launch-failed（renderer 被杀时就会直接 FATAL）'
  },

  // ---- test_log_change.js: 日志降噪 ----
  {
    guard: 'test_log_change.js', file: 'main/log-change.js',
    from: 'if (seen.get(key) === line) return false;', to: 'if (false) return false;',
    desc: '日志去重失效（噪声会重新淹没启动行）'
  }
];

fs.mkdirSync(BACKUP, { recursive: true });

const results = [];
let caught = 0, blind = 0;

for (const c of CASES) {
  const abs = path.join(ROOT, c.file);
  const bak = path.join(BACKUP, c.file.replace(/[/\\]/g, '__'));

  if (!fs.existsSync(abs)) {
    results.push({ c, verdict: 'SKIP', detail: '文件不存在: ' + c.file });
    continue;
  }
  const original = fs.readFileSync(abs, 'utf8');
  const mutated = c.fromRe ? original.replace(c.fromRe, c.to) : original.split(c.from).join(c.to);

  if (mutated === original) {
    results.push({ c, verdict: 'SKIP', detail: '找不到要篡改的片段（守卫或代码已变，请更新用例）' });
    continue;
  }

  let verdict, detail = '';
  try {
    fs.writeFileSync(bak, original);
    fs.writeFileSync(abs, mutated);

    const r = spawnSync('node', [c.guard], { cwd: ROOT, encoding: 'utf8' });
    const raw = (r.stderr || '') + '\n' + (r.stdout || '');
    // Node 断言失败会先打 node:internal/... 与 throw err;，真正的原因在
    // `AssertionError [ERR_ASSERTION]: <消息>` 那一行 —— 专门找 Error 行。
    const errLine = raw.split('\n').map(s => s.trim())
      .find(s => /^[A-Za-z_$]*Error\b/.test(s) && !/^at /.test(s));
    const out = errLine || raw.trim().split('\n').map(s => s.trim()).filter(Boolean).slice(-1)[0] || '';

    if (r.status === 0) {
      verdict = 'BLIND';
      blind++;
      detail = '篡改后仍返回 0！守卫没拦住。输出: ' + out.substring(0, 160);
    } else {
      verdict = 'CAUGHT';
      caught++;
      detail = '返回 ' + r.status + '：' + out.substring(0, 200);
    }
  } catch (e) {
    verdict = 'ERROR';
    detail = String((e && e.message) || e);
  } finally {
    fs.writeFileSync(abs, original);   // 无条件还原
  }
  results.push({ c, verdict, detail });
}

console.log('');
for (const r of results) {
  const mark = r.verdict === 'CAUGHT' ? '✓ 拦住了' : (r.verdict === 'BLIND' ? '✗ 瞎的  ' : '· ' + r.verdict + '  ');
  console.log(mark + '  ' + r.c.guard + '  ←  ' + r.c.desc);
  if (r.detail) console.log('            ' + r.detail);
}
console.log('');
console.log('能拦住 ' + caught + ' / ' + CASES.length + '，瞎的 ' + blind + ' 个');

// 还原自检: 逐文件与备份比对，防止任何一条路径没还原干净
const dirty = [];
for (const c of CASES) {
  const abs = path.join(ROOT, c.file);
  const bak = path.join(BACKUP, c.file.replace(/[/\\]/g, '__'));
  if (fs.existsSync(bak) && fs.existsSync(abs) && fs.readFileSync(abs, 'utf8') !== fs.readFileSync(bak, 'utf8')) {
    dirty.push(c.file);
  }
}
console.log('还原自检: ' + (dirty.length ? '有文件未还原! ' + dirty.join(', ') : '全部已还原'));

if (blind || dirty.length) {
  console.log('');
  console.log('提示: 有守卫是瞎的, 或者没还原干净。瞎的守卫必须修 —— 它给人"有保护"的错觉。');
}
process.exit(blind > 0 || dirty.length ? 1 : 0);
