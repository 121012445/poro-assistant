'use strict';
/**
 * 一条命令完成 Poro 的「改完 -> 上线 -> 验证」闭环。
 *
 *   node _debug_archive/deploy.js                    # 全流程
 *   node _debug_archive/deploy.js --skip-tests       # 跳过测试(只打包替换)
 *   node _debug_archive/deploy.js --dry              # 只打包不替换安装目录
 *
 * 流程: 跑 8 个测试 -> 打 asar(含标记校验) -> 备份并热替换安装目录 -> 用 CDP 实测界面版本号
 * 任一步失败即中止, 不会把半成品推上线。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const INSTALLED = 'D:\\lol-assistant\\Poro\\resources\\app.asar';
const INSTALLED_EXE = 'D:\\lol-assistant\\Poro\\Poro.exe';

const skipTests = process.argv.includes('--skip-tests');
const dry = process.argv.includes('--dry');

const TESTS = [
  'check_build.js', 'test_bench_alert.js', 'test_overlay_position.js', 'test_security.js', 'test_audit.js',
  'test_dangling.js', 'test_split_order.js', 'test_gamedata.js', 'test_game_settings.js'
];

function run(label, args) {
  const r = spawnSync(NODE, args, { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = r.status === 0;
  console.log((ok ? '  [OK]   ' : '  [FAIL] ') + label);
  if (!ok) console.log(out.split('\n').map(l => '         ' + l).join('\n'));
  return { ok, out };
}

function step(n, title) { console.log('\n=== ' + n + '. ' + title + ' ==='); }

// ---- 1. 测试 ----
step(1, '测试');
let failed = [];
if (skipTests) {
  console.log('  (--skip-tests 已跳过)');
} else {
  for (const t of TESTS) {
    const r = run(t, [t]);
    if (!r.ok) failed.push(t);
  }
  if (failed.length) { console.log('\n测试未通过, 中止: ' + failed.join(', ')); process.exit(1); }
  console.log('  全部 ' + TESTS.length + ' 个测试通过');
}

// ---- 2. 打包 ----
step(2, '打包 asar');
const buildArg = dry ? ['_debug_archive/build_asar.js'] : ['_debug_archive/build_asar.js', INSTALLED];
const b = spawnSync(NODE, buildArg, { cwd: ROOT, encoding: 'utf8' });
const bOut = (b.stdout || '') + (b.stderr || '');
console.log(bOut.trim().split('\n').map(l => '  ' + l).join('\n'));
if (b.status !== 0) { console.log('\n打包失败, 中止。'); process.exit(1); }

// ---- 3. 验证安装目录内容 ----
step(3, '校验安装目录 asar');
const asar = require(path.join(ROOT, 'node_modules', '@electron', 'asar'));
const target = dry ? 'D:\\_asar_out\\app.asar' : INSTALLED;
// 缺文件时返回空串: 让下面的 check 报一行 FAIL, 而不是把整个脚本崩在栈里
const pick = f => { try { return asar.extractFile(target, f.split('/').join('\\')).toString('utf8'); } catch (e) { return ''; } };
let bad = 0;
function check(name, cond, extra) {
  if (!cond) bad++;
  console.log('  ' + (cond ? '[OK]   ' : '[FAIL] ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
const pkg = JSON.parse(pick('package.json'));
check('package.json 版本', /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version);
const html = pick('renderer/index.html');
const tag = (html.match(/id="versionText"[^>]*>([^<]*)</) || [])[1] || '';
check('index.html 未硬编码版本号', !/\d+\.\d+\.\d+/.test(tag), tag.trim());
const mainjs = pick('main/index.js');
check('main 有 app:version IPC', /ipcMain\.handle\(\s*'app:version'/.test(mainjs));
check('preload 暴露 getAppVersion', /getAppVersion\s*:/.test(pick('main/preload.js')));
const bench = pick('renderer/js/bench.js');
check('bench 立即发(无 firstDelay)', !/_benchSwapFirstDelay/.test(bench));
check('bench PATCH 选择分支', /session\/actions\//.test(bench));
check('bench null 判成功', /if\s*\(!r\s*\|\|\s*!r\.__error\)\s*ok\s*=\s*true/.test(bench));
const ws = pick('main/lcu-ws.js');
check('lcu-ws 订阅 LTB 节点级事件', /'\/lol-lobby-team-builder\/champ-select\/v1'/.test(ws));
// 选人浮窗: 它是最容易被"漏打包"的东西 —— 页面不在 index.html 的 script 清单里,
// 一旦漏了, 表现是"开关能打开但浮窗永不出现", 从界面上完全看不出是打包缺文件。
const preload = pick('main/preload.js');
const overlayHtml = pick('renderer/overlay.html');
check('overlay.html 已打包', /<title>/.test(overlayHtml) && /js\/overlay\.js/.test(overlayHtml));
check('overlay.js 已打包', /onOverlayData/.test(pick('renderer/js/overlay.js')));
check('main 有 overlay:update IPC', /ipcMain\.handle\(\s*'overlay:update'/.test(mainjs));
check('main 有 overlay:swap IPC', /ipcMain\.handle\(\s*'overlay:swap'/.test(mainjs));
check('preload 暴露浮窗通道', /overlayUpdate\s*:/.test(preload) && /overlaySwap\s*:/.test(preload) && /onOverlaySwap\s*:/.test(preload));
check('强化推荐浮层已打包', /js\/augment-overlay\.js/.test(pick('renderer/augment-overlay.html')) && /onAugmentOverlayData/.test(pick('renderer/js/augment-overlay.js')));
check('强化截图识别 IPC', /ipcMain\.handle\(\s*'game:recognizeAugments'/.test(mainjs) && /recognizeAugments\s*:/.test(preload));
check('bench 浮窗点击复用 benchSwapNow', /onOverlaySwap\(\s*id\s*=>/.test(bench));
// 贴边: 读客户端窗口矩形 (koffi) + 位置计算, 两者都要在包里
check('main/win-rect.js 已打包', /SetThreadDpiAwarenessContext/.test(pick('main/win-rect.js')));
check('main/overlay-position.js 已打包', /computeOverlayBounds/.test(pick('main/overlay-position.js')));
// 原生模块必须落在 app.asar.unpacked 里, 否则 dlopen 失败 → 浮窗只能贴屏幕边缘
const koffiBin = path.join(target + '.unpacked', 'node_modules', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node');
check('koffi.node 已解包到 app.asar.unpacked', fs.existsSync(koffiBin), koffiBin);
const ocrScript = path.join(target + '.unpacked', 'main', 'native', 'PoroOcr.ps1');
check('PoroOcr.ps1 已解包到 app.asar.unpacked', fs.existsSync(ocrScript), ocrScript);
const ocrWorker = path.join(target + '.unpacked', 'main', 'native', 'PoroOcrWorker.ps1');
check('PoroOcrWorker.ps1 已解包到 app.asar.unpacked', fs.existsSync(ocrWorker), ocrWorker);
if (bad) { console.log('\n校验未通过 (' + bad + ' 项), 中止。'); process.exit(1); }

if (dry) { console.log('\n--dry: 已打包到 D:\\_asar_out\\app.asar, 未替换安装目录。'); process.exit(0); }

// ---- 4. 端到端实测界面版本号 ----
step(4, '端到端实测界面版本号 (启动已安装包)');
if (!fs.existsSync(INSTALLED_EXE)) {
  console.log('  找不到 ' + INSTALLED_EXE + ', 跳过实测。');
} else {
  const p = spawnSync(NODE, ['_debug_archive/probe_version_ui.js', INSTALLED_EXE], { cwd: ROOT, encoding: 'utf8' });
  const pOut = (p.stdout || '') + (p.stderr || '');
  console.log(pOut.trim().split('\n').map(l => '  ' + l).join('\n'));
  if (p.status !== 0) { console.log('\n界面版本号实测未通过。'); process.exit(1); }
}

console.log('\n部署完成。重启 Poro 即可生效 (注意托盘退出, 单实例锁会接管重复启动)。');
