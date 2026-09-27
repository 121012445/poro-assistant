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
  },

  // ---- test_installer_nsh.js: 安装期自检日志（"装完闪退"的唯一证据来源）----
  // 这一组的篡改有个共同点：**构建全都照样成功**，坏的只是那份日志，
  // 而且要等到下一个用户来报"闪退"才会暴露。所以守卫必须条条都拦得住。
  {
    guard: 'test_installer_nsh.js', file: 'build/installer.nsh',
    from: 'FileWriteUTF16LE', to: 'FileWrite',
    desc: '日志退回 FileWrite（转系统代码页，英文系统上中文全变 "?"，用户看不懂该换受限版）'
  },
  {
    guard: 'test_installer_nsh.js', file: 'build/installer.nsh',
    from: 'S-1-5-32-544', to: 'Administrators',
    desc: '管理员判定退回英文组名（跨语言机器上误判成"不在管理员组"）'
  },
  {
    guard: 'test_installer_nsh.js', file: 'build/installer.nsh',
    from: '"$SYSDIR\\whoami.exe" /groups', to: 'whoami /groups',
    desc: 'whoami 退回裸命令名（依赖 PATH，实测安装器环境里报"不是内部或外部命令"）'
  },
  {
    guard: 'test_installer_nsh.js', file: 'build/installer.nsh',
    from: 'IfSilent poroCheckDone', to: 'Nop',
    desc: '去掉 IfSilent 守卫（静默升级时弹窗会卡住自动更新流程）'
  },
  {
    guard: 'test_installer_nsh.js', file: 'build/installer.nsh',
    fromRe: /\r?\n  Pop \$R9\r?\n  Pop \$R8/, to: '\n  Pop $R9',
    desc: '寄存器还原少 pop 一个（栈不平衡，安装段后续指令的寄存器被踩坏）'
  },
  {
    guard: 'test_installer_nsh.js', file: 'package.json',
    from: '"include": "build/installer.nsh"', to: '"include": "build/other.nsh"',
    desc: 'nsis.include 指向别处（构建静默跳过自检，其它断言却全部照常通过）'
  },
  {
    guard: 'test_installer_nsh.js', file: 'build/installer.nsh',
    from: '改用受限版安装包', to: '换个包试试',
    desc: '删掉"改用受限版"的指引（日志退化成"记录了环境但没说怎么办"）'
  },
  {
    guard: 'test_installer_nsh.js', file: 'build/installer.nsh',
    from: 'MessageBox', to: 'DetailPrint',
    desc: '去掉弹框（不在管理员组的用户不会主动翻日志，等于没提示）'
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
