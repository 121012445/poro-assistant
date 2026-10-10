'use strict';
/**
 * 构建 app.asar (只打 main/ + renderer/ + package.json + node_modules/ws, 与线上 asar 清单一致),
 * 可选热替换到已安装目录。
 *
 * 用法:
 *   node _debug_archive/build_asar.js                     # 只构建到 D:\_asar_out\app.asar
 *   node _debug_archive/build_asar.js "<目标 app.asar>"    # 构建 + 备份并替换目标
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STAGE = 'D:\\_asar_stage';
const OUT = 'D:\\_asar_out\\app.asar';

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }

function fileHash(p) {
  return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
}

/** 列出正在运行的 Poro 进程。优先用 CIM 拿到可执行路径; 拿不到就退回 tasklist (只有 PID)。 */
function listPoroProcesses() {
  try {
    const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'Poro.exe\'" | '
      + 'ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }';
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(line => {
      const i = line.indexOf('|');
      return { pid: Number(line.slice(0, i)), exe: i >= 0 ? line.slice(i + 1).trim() : '' };
    }).filter(p => Number.isFinite(p.pid) && p.pid > 0);
  } catch (e) { /* 落到 tasklist */ }
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Poro.exe', '/NH'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return out.split(/\r?\n/).map(s => s.trim())
      .filter(s => /^Poro\.exe/i.test(s))
      .map(s => ({ pid: Number(s.split(/\s+/)[1]) || 0, exe: '' }));
  } catch (e) { return []; }
}

/**
 * 热替换 app.asar 前必须确认 Poro 没在跑。
 *
 * 为什么: Electron 会把 asar 的头表(每文件的 offset 表)缓存在进程里。运行中把
 * app.asar 换成另一份(文件数/布局不同 -> 偏移全变), 之后**才创建**的窗口会拿
 * 旧偏移去读新文件, 读到别的文件的内容。启动时就加载好的主窗口没事, 所以界面
 * 看起来一切正常, 只有延迟创建的窗口(选人浮窗 / 海斗强化浮窗)炸。
 *
 * 2026-10-11 真实踩到: 浮窗里显示的是 node_modules/koffi 的 C++ 源码
 * (`K_UNREACHABLE` / `MUST_TAIL`), 排查了半天以为是渲染层坏了。
 */
function assertTargetNotInUse(target, force) {
  const installDir = path.dirname(path.dirname(target));   // <install>/resources/app.asar -> <install>
  const procs = listPoroProcesses();
  if (!procs.length) return true;
  const inInstall = procs.filter(p => p.exe && p.exe.toLowerCase().startsWith(installDir.toLowerCase()));
  const relevant = inInstall.length ? inInstall : procs;
  const detail = relevant.map(p => 'PID ' + p.pid + (p.exe ? '  ' + p.exe : '  (路径未知)')).join('\n     ');
  if (force) {
    console.log('!! 检测到 Poro 正在运行, 但指定了 --force, 继续热替换:');
    console.log('     ' + detail);
    console.log('   !! 运行中的实例仍在用旧头表偏移读新 asar —— 之后创建的浮窗会显示成乱码。');
    console.log('   !! 替换完请立刻完全退出并重启 Poro。');
    return true;
  }
  console.log('');
  console.log('XX 检测到 Poro 正在运行, 拒绝热替换 app.asar:');
  console.log('     ' + detail);
  console.log('   原因: Electron 把 asar 头表(偏移表)缓存在进程里。运行中换文件后, 之后才');
  console.log('         创建的窗口会用旧偏移读新文件, 读到别的文件内容 —— 浮窗里出现一堆');
  console.log('         乱码源码。(2026-10-11 实测: 浮窗显示了 koffi 的 C++ 源码)');
  console.log('   处理: 从托盘完全退出 Poro (确认 Poro.exe 全部结束) 后重新运行本脚本。');
  console.log('         确实要强行热替换就加 --force, 但之后必须立刻重启 Poro。');
  console.log('');
  return false;
}


/**
 * 逐文件同步解包目录 (app.asar.unpacked), 返回是否全部成功。
 *
 * 为什么不用 fs.cpSync 一把梭: 应用正在运行时会 dlopen 里面的原生模块 (.node),
 * Windows 上写不进去 -> cpSync 整体抛错 -> **排在它后面的文件一个都没同步到**,
 * 而且报错只说"另一个进程正在使用", 看不出是哪个文件、也不知道漏了哪些。
 * (2026-10-02 真实踩到: asar 已替换成功, 解包目录同步却失败, 是混合状态。)
 *
 * 策略: 内容一致的直接跳过 (被占用也无所谓), 真的需要更新却写不进去才报错。
 * 保留 cpSync 原有的"合并"语义 —— 不删目标里已经有的文件 (例如 PoroInput.exe)。
 */
function syncUnpacked(src, dst) {
  let copied = 0, skipped = 0;
  const locked = [];
  const walk = (rel) => {
    const dir = rel ? path.join(src, rel) : src;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? path.join(rel, ent.name) : ent.name;
      const s = path.join(src, r);
      const d = path.join(dst, r);
      if (ent.isDirectory()) { fs.mkdirSync(d, { recursive: true }); walk(r); continue; }
      let same = false;
      try {
        same = fs.existsSync(d) && fs.statSync(d).size === fs.statSync(s).size && fileHash(s) === fileHash(d);
      } catch (e) { same = false; }
      if (same) { skipped++; continue; }
      try {
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.copyFileSync(s, d);
        copied++;
      } catch (e) {
        locked.push(r + '   (' + (e.code || e.message) + ')');
      }
    }
  };
  walk('');
  console.log('已同步解包目录 -> ' + dst + '  (更新 ' + copied + ' 个, 内容未变跳过 ' + skipped + ' 个)');
  if (locked.length) {
    console.log('!! ' + locked.length + ' 个文件需要更新但被占用 (应用正在运行):');
    locked.forEach(f => console.log('     ' + f));
    console.log('   请先从托盘退出 Poro, 再重新部署。');
    return false;
  }
  return true;
}

function main() {
  const force = process.argv.includes('--force');
  const target = process.argv.slice(2).find(a => !a.startsWith('--')) || null;

  // 尽早拦: 别白构建一遍再失败
  if (target && !assertTargetNotInUse(target, force)) process.exit(1);

  rmrf(STAGE);
  fs.mkdirSync(path.join(STAGE, 'node_modules'), { recursive: true });
  for (const item of ['main', 'renderer', 'package.json']) {
    fs.cpSync(path.join(ROOT, item), path.join(STAGE, item), { recursive: true });
  }
  fs.cpSync(path.join(ROOT, 'node_modules', 'ws'), path.join(STAGE, 'node_modules', 'ws'), { recursive: true });
  // koffi: 预编译的 N-API 原生桥 (浮窗贴边要读客户端窗口矩形), 实际是 2 个包。
  // 缺了它不会崩 —— win-rect.js 会静默降级成"贴屏幕边缘", 但还是在这里直接拦下来更清楚。
  for (const pkg of ['koffi', path.join('@koromix', 'koffi-win32-x64')]) {
    const from = path.join(ROOT, 'node_modules', pkg);
    if (!fs.existsSync(from)) { console.log('缺少运行时依赖 node_modules/' + pkg + ' (先执行 npm install)'); process.exit(1); }
    fs.cpSync(from, path.join(STAGE, 'node_modules', pkg), { recursive: true });
  }

  const asar = require('@electron/asar');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // 原生模块 (.node) 必须解包: dlopen 读不了 asar 内的文件, Electron 会自动去
  // app.asar.unpacked 里找同名文件。漏了这一步, koffi 加载失败 → 浮窗退回贴屏幕边缘。
  asar.createPackageWithOptions(STAGE, OUT, { unpack: '**/*.node' }).then(() => {
    // PoroInput.exe 也放进 unpacked: 与应用里 `process.resourcesPath/app.asar.unpacked/...`
    // 的读取路径保持一致, 这样只拿我们这个 asar 也能跑
    for (const nativeFile of ['PoroInput.exe', 'PoroOcr.ps1', 'PoroOcrWorker.ps1']) {
      const nativeSrc = path.join(STAGE, 'main', 'native', nativeFile);
      const nativeDst = path.join(OUT + '.unpacked', 'main', 'native', nativeFile);
      if (fs.existsSync(nativeSrc)) { fs.mkdirSync(path.dirname(nativeDst), { recursive: true }); fs.copyFileSync(nativeSrc, nativeDst); }
    }
    const list = asar.listPackage(OUT);
    const version = JSON.parse(fs.readFileSync(path.join(STAGE, 'package.json'), 'utf8')).version;
    const body = fs.readFileSync(OUT);
    const markers = [
      ['lcu-ws 节点级事件', Buffer.from("'/lol-lobby-team-builder/champ-select/v1'")],
      ['benchFetchLists(force)', Buffer.from('function benchFetchLists(force)')],
      ['PATCH 选择分支', Buffer.from('/lol-champ-select/v1/session/actions/')],
      ['null 判成功', Buffer.from('if (!r || !r.__error) ok = true;')],
      ['app:version IPC', Buffer.from("ipcMain.handle('app:version'")],
      ['preload getAppVersion', Buffer.from('getAppVersion')],
      ['渲染层动态取版本', Buffer.from('setVersionText')],
      // 浮窗: 页面不在 index.html 的 script 清单里, 漏打包时界面完全看不出异常 (开关能开、窗不出现)
      ['浮窗页面 overlay.html', Buffer.from('js/overlay.js')],
      ['浮窗 IPC overlay:update', Buffer.from("ipcMain.handle('overlay:update'")],
      ['浮窗 preload 通道', Buffer.from('overlayUpdate:')],
      ['强化识别 IPC', Buffer.from("ipcMain.handle('game:recognizeAugments'")],
      ['强化推荐浮层', Buffer.from('augment-overlay.html')],
      // 贴边: 读客户端窗口矩形 + 位置计算, 两者缺一浮窗就只贴屏幕边缘
      ['贴边 win-rect', Buffer.from('SetThreadDpiAwarenessContext')],
      ['贴边 位置计算', Buffer.from('computeOverlayBounds')],
      // 海斗强化识别 (2026-10-11 修): createRecognizer 的返回对象必须带上
      // isSafeVisualMatch。漏了它, 只要 OCR 漏读任意一张卡, 视觉兜底分支就抛
      // "is not a function" 把整轮识别打挂 —— 现象是"三选一浮窗反应慢, 刷新后
      // 要等两三秒"(得等到某一轮 OCR 恰好三张全对才出结果)。这条必须钉死在包里。
      ['强化视觉兜底工厂暴露', Buffer.from('cacheSize: () => cache.size, isSafeVisualMatch')],
      ['强化视觉兜底自检', Buffer.from("typeof augmentRecognizer.isSafeVisualMatch !== 'function'")],
      ['强化补帧 chain', Buffer.from('scanCurrentAugmentOffers(false, chain + 1)')]
    ];
    console.log('打包完成: ' + OUT + '  (' + (body.length / 1024).toFixed(0) + ' KB, ' + list.length + ' 个条目, v' + version + ')');
    let allOk = true;
    for (const [name, needle] of markers) {
      const hit = body.includes(needle);
      if (!hit) allOk = false;
      console.log('  ' + (hit ? 'OK  ' : '缺失') + ' ' + name);
    }
    // 反向校验: 渲染层不许残留写死的版本号, 否则 UI 显示旧号会让人误判"部署没生效"
    const htmlTxt = fs.readFileSync(path.join(STAGE, 'renderer', 'index.html'), 'utf8');
    const hardTag = (htmlTxt.match(/id="versionText"[^>]*>([^<]*)</) || [])[1] || '';
    const badTag = /\d+\.\d+\.\d+/.test(hardTag);
    console.log('  ' + (badTag ? '缺失' : 'OK  ') + ' index.html 无硬编码版本 (' + hardTag.trim() + ')');
    if (badTag) allOk = false;
    // 浮窗页面必须真的在包内 (markers 只在二进制里找字符串, 这条按清单核对路径)
    const hasOverlayPage = list.some(p => String(p).replace(/\\/g, '/').includes('renderer/overlay.html'));
    console.log('  ' + (hasOverlayPage ? 'OK  ' : '缺失') + ' renderer/overlay.html 在包内');
    if (!hasOverlayPage) allOk = false;
    // koffi 的原生二进制必须落在 unpacked 里; 没解包 = dlopen 失败 = 浮窗贴不了边
    const nodeBin = path.join(OUT + '.unpacked', 'node_modules', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node');
    const hasKoffi = fs.existsSync(nodeBin);
    console.log('  ' + (hasKoffi ? 'OK  ' : '缺失') + ' koffi.node 已解包到 app.asar.unpacked');
    if (!hasKoffi) allOk = false;
    const ocrScript = path.join(OUT + '.unpacked', 'main', 'native', 'PoroOcr.ps1');
    const hasOcr = fs.existsSync(ocrScript);
    console.log('  ' + (hasOcr ? 'OK  ' : '缺失') + ' PoroOcr.ps1 已解包到 app.asar.unpacked');
    if (!hasOcr) allOk = false;
    const ocrWorker = path.join(OUT + '.unpacked', 'main', 'native', 'PoroOcrWorker.ps1');
    const hasOcrWorker = fs.existsSync(ocrWorker);
    console.log('  ' + (hasOcrWorker ? 'OK  ' : '缺失') + ' PoroOcrWorker.ps1 已解包到 app.asar.unpacked');
    if (!hasOcrWorker) allOk = false;
    if (!allOk) { console.log('关键改动未进包, 中止。'); process.exit(1); }

    if (target) {
      // 顺序很重要: **先**同步解包目录, **后**替换 asar。
      // 解包目录里是原生模块 (.node), 应用运行时会被 dlopen 占用而写不进去;
      // 若先换了 asar 再失败, 就留下"JS 是新的 / 原生模块是旧的"混合状态 ——
      // 这种状态界面看不出异常, 只有功能静默失效, 最难排查。
      const unpackedSrc = OUT + '.unpacked';
      const unpackedDst = target + '.unpacked';
      if (fs.existsSync(unpackedSrc)) {
        if (!syncUnpacked(unpackedSrc, unpackedDst)) {
          console.log('解包目录未能同步完成, 已中止 (asar 未替换, 安装目录保持原样)。');
          process.exit(1);
        }
      } else {
        console.log('!! 没有解包目录, 原生模块可能加载不了');
      }

      if (fs.existsSync(target)) {
        // 用本地日期, 别用 toISOString() (那是 UTC, 晚上会标成前一天)
        const d = new Date();
        const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
        // 文件名必须写清"里面装的是哪个版本", 否则回滚时会把新版当旧版用
        let oldVer = 'unknown';
        try {
          const pkg = JSON.parse(asar.extractFile(target, 'package.json').toString('utf8'));
          if (pkg && pkg.version) oldVer = pkg.version;
        } catch (e) {}
        const bak = target + '.bak-' + oldVer + '-to-' + version + '-' + ymd;
        fs.copyFileSync(target, bak);
        console.log('已备份原 asar (内含 v' + oldVer + ') -> ' + bak);
      }
      // 再拦一次: 构建期间用户可能刚把 Poro 打开, 那时上面那次检查还是"没在跑"
      if (!assertTargetNotInUse(target, force)) process.exit(1);
      fs.copyFileSync(OUT, target);
      console.log('已热替换 -> ' + target);
      console.log('提示: 若刚才有实例在跑(--force), 请立刻完全退出并重启 Poro, 否则浮窗会显示乱码。');
    }
  }).catch(e => { console.log('打包失败: ' + e.message); process.exit(1); });
}
main();
