'use strict';
/**
 * 一条命令完成 Poro 的「改完 -> 上线 -> 验证」闭环。
 *
 *   node _debug_archive/deploy.js                    # 全流程
 *   node _debug_archive/deploy.js --skip-tests       # 跳过测试(只打包替换)
 *   node _debug_archive/deploy.js --dry              # 只打包不替换安装目录
 *
 * 流程: 跑测试 -> 打 asar(含标记校验) -> 备份并热替换安装目录 -> CDP 实测(版本号 + 启动健康)
 * 任一步失败即中止, 不会把半成品推上线。
 *
 * ⚠ 本环境限制: 沙箱会拦截**同步**子进程调用 —— spawnSync / execSync 一律报
 *   `EBUSY`(连 cmd.exe 也拦), 而且失败是静默的(零输出), 曾经让 10 个测试同时"FAIL"却
 *   看不出原因。所以这里**一律用异步 spawn** 包成 Promise 再 await。
 *   想改回 spawnSync 之前请先跑一次本脚本确认链路还活着。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

// 统一的子进程执行器(异步): 返回 { status, out }
function runProc(cmd, args, opts) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, Object.assign({ cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }, opts || {}));
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });
    child.on('error', e => resolve({ status: -1, out: out + '\n[spawn error] ' + e.message }));
    child.on('close', code => resolve({ status: code, out }));
  });
}

// ---- 安装目录探测 ----
// 血的教训: 这里曾硬编码 D:\lol-assistant\Poro, 但用户实际运行的是 electron-builder
// 的默认安装位置 %LOCALAPPDATA%\Programs\Poro。于是每次部署都在对一个"没人运行的目录"
// 打字 —— 打包成功、门禁全绿、探针也绿(它测的就是被替换的那份), 而用户界面症状照旧。
// 现在按「显式指定 -> 正在运行的进程 -> 默认安装位置 -> 开发目录」依次探测, 并打印结果。
async function resolveInstallDir() {
  const hasExe = d => { try { return !!d && fs.existsSync(path.join(d, 'Poro.exe')); } catch (e) { return false; } };

  const env = process.env.PORO_INSTALL_DIR;
  if (env) {
    if (!hasExe(env)) { console.error('PORO_INSTALL_DIR 指向的目录里没有 Poro.exe: ' + env); process.exit(1); }
    return { dir: env, from: 'PORO_INSTALL_DIR 环境变量' };
  }

  // 正在运行的 Poro 进程最权威 —— 它才是用户眼睛看到的那一份
  try {
    const r = await runProc('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Where-Object Name -eq Poro.exe | Select-Object -First 1 -ExpandProperty ExecutablePath']);
    const p = (r.out || '').trim();
    if (p && hasExe(path.dirname(p))) return { dir: path.dirname(p), from: '正在运行的进程' };
  } catch (e) { /* 取不到就继续走候选 */ }

  const cands = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Poro') : '',
    'D:\\lol-assistant\\Poro'
  ];
  for (const d of cands) if (hasExe(d)) return { dir: d, from: '默认候选' };
  return { dir: null, from: null };
}

async function isPoroRunning() {
  const r = await runProc('tasklist', ['/FI', 'IMAGENAME eq Poro.exe', '/NH']);
  return /Poro\.exe/i.test(r.out || '');
}

// 测试清单从 package.json 的 pretest + test 脚本**现场解析**。
// 根治老问题: 部署脚本自带的列表曾与 npm test 漂移(10 vs 39) —— 新加的守卫只进 npm test,
// 上线路径上根本不执行。现在 npm test 加了什么, 这里自动跟着跑什么。
function listTests() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const s = pkg.scripts || {};
    const script = [s.pretest, s.test].filter(Boolean).join(' && ');
    return [...new Set(script.match(/[\w.-]+\.js/g) || [])]
      .filter(f => fs.existsSync(path.join(ROOT, f)));
  } catch (e) { return []; }
}
const TESTS = listTests();
if (!TESTS.length) { console.error('未能从 package.json 解析出测试清单, 中止。'); process.exit(1); }

const skipTests = process.argv.includes('--skip-tests');
const dry = process.argv.includes('--dry');

function step(n, title) { console.log('\n=== ' + n + '. ' + title + ' ==='); }

(async () => {
  const INSTALL = await resolveInstallDir();
  if (!INSTALL.dir) {
    console.error('找不到 Poro 安装目录。请用 PORO_INSTALL_DIR=<目录> 显式指定。');
    process.exit(1);
  }
  const INSTALLED = path.join(INSTALL.dir, 'resources', 'app.asar');
  const INSTALLED_EXE = path.join(INSTALL.dir, 'Poro.exe');

  // ---- 1. 测试 ----
  step(1, '测试');
  const failed = [];
  if (skipTests) {
    console.log('  (--skip-tests 已跳过)');
  } else {
    for (const t of TESTS) {
      const r = await runProc(NODE, [t]);
      const ok = r.status === 0;
      console.log((ok ? '  [OK]   ' : '  [FAIL] ') + t);
      if (!ok) console.log(r.out.split('\n').map(l => '         ' + l).join('\n'));
      if (!ok) failed.push(t);
    }
    if (failed.length) { console.log('\n测试未通过, 中止: ' + failed.join(', ')); process.exit(1); }
    console.log('  全部 ' + TESTS.length + ' 个测试通过');
  }

  // ---- 2. 打包 ----
  step(2, '打包 asar');
  console.log('  目标安装目录: ' + INSTALL.dir + '   [来源: ' + INSTALL.from + ']');
  if (!dry && await isPoroRunning()) {
    console.log('  ⚠ 检测到 Poro 正在运行 —— asar 可能被占用, 替换若失败请先退出应用(含托盘)。');
  }
  const buildArg = dry ? ['_debug_archive/build_asar.js'] : ['_debug_archive/build_asar.js', INSTALLED];
  const b = await runProc(NODE, buildArg);
  console.log(b.out.trim().split('\n').map(l => '  ' + l).join('\n'));
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
  // 工具箱: 两个领取奖励已合并成一张卡 + 分区标题, 这里守住"别再拆回去/别漏打包"
  check('工具箱已分区(tools-section)', /class="tools-section"/.test(html));
  check('领取奖励已合并为单卡', (html.match(/<h3>领取奖励<\/h3>/g) || []).length === 1 && !/一键领取活动奖励/.test(html) && !/选择性领取奖励/.test(html));
  check('选择性领取面板接线', /toggleRewardPicker/.test(html) && /toggleRewardPicker/.test(pick('renderer/js/sona-extra.js')));
  // 原生模块必须落在 app.asar.unpacked 里, 否则 dlopen 失败 → 浮窗只能贴屏幕边缘
  const koffiBin = path.join(target + '.unpacked', 'node_modules', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node');
  check('koffi.node 已解包到 app.asar.unpacked', fs.existsSync(koffiBin), koffiBin);
  const ocrScript = path.join(target + '.unpacked', 'main', 'native', 'PoroOcr.ps1');
  check('PoroOcr.ps1 已解包到 app.asar.unpacked', fs.existsSync(ocrScript), ocrScript);
  const ocrWorker = path.join(target + '.unpacked', 'main', 'native', 'PoroOcrWorker.ps1');
  check('PoroOcrWorker.ps1 已解包到 app.asar.unpacked', fs.existsSync(ocrWorker), ocrWorker);
  if (bad) { console.log('\n校验未通过 (' + bad + ' 项), 中止。'); process.exit(1); }

  if (dry) { console.log('\n--dry: 已打包到 D:\\_asar_out\\app.asar, 未替换安装目录。'); process.exit(0); }

  // ---- 4. 端到端实测: 界面版本号 + 启动健康 ----
  step(4, '端到端实测 (启动已安装包: 版本号 + init 是否被掐断)');
  if (!fs.existsSync(INSTALLED_EXE)) {
    console.log('  找不到 ' + INSTALLED_EXE + ', 跳过实测。');
  } else {
    const runProbe = async arg => {
      const p = await runProc(NODE, ['_debug_archive/probe_version_ui.js', arg]);
      return { status: p.status, out: p.out };
    };
    let r = await runProbe(INSTALLED_EXE);
    // 应用正在运行时, spawn Poro.exe 不一定能起来 (镜像被自己占着 / 单实例锁)。
    // 这不是被测代码的问题, 退回"用 electron 加载同一份已安装 asar" —— 跑到的
    // 还是线上 JS 包, 验证力等价。只在确实是 spawn 失败时才回退, 免得把真问题掩盖掉。
    if (r.status !== 0 && /spawn .*Poro\.exe EACCES|EACCES.*Poro\.exe/.test(r.out)) {
      console.log('  提示: Poro.exe 启动被拒 (EACCES, 应用正在运行?) -> 改用 electron 加载同一份已安装 asar');
      r = await runProbe(INSTALLED);
    }
    console.log(r.out.trim().split('\n').map(l => '  ' + l).join('\n'));
    if (r.status !== 0) { console.log('\n端到端实测未通过。'); process.exit(1); }
  }

  console.log('\n部署完成。重启 Poro 即可生效 (注意托盘退出, 单实例锁会接管重复启动)。');
})();
