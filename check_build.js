// 构建前自检: 防止 package.json/依赖/源码缺失导致打包出坏安装包
const fs = require('fs');
const fail = [];
const warn = [];   // 不阻断构建, 但值得在出包前看一眼
if (!fs.existsSync('package.json')) fail.push('package.json 缺失');
else {
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  if (!p.dependencies || !p.dependencies.ws) fail.push('dependencies.ws 缺失 (WebSocket 模块将不会打包)');
  // koffi 是浮窗贴边的原生桥 (读客户端窗口矩形), 缺了它不会崩但功能会静默降级成"贴屏幕边缘"
  if (!p.dependencies || !p.dependencies.koffi) fail.push('dependencies.koffi 缺失 (浮窗将无法贴客户端边缘)');
  if (p.build.asar !== true) fail.push('build.asar 配置异常');
  if (fs.existsSync('package-lock.json')) {
    const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
    if (lock.version !== p.version || lock.packages?.['']?.version !== p.version) {
      fail.push(`package-lock.json 版本与 package.json 不一致 (${lock.version || '?'} / ${p.version})`);
    }
  }
}
// 渲染层脚本直接从 index.html 解析出来: 以后拆分/新增模块不用回来手工补一遍,
// 漏补的后果是打包出一个"少文件"的坏包, 而且本地跑得好好的。
// **例外**: 独立窗口页面 (renderer/overlay.html) 不在 index.html 的 <script src> 里,
// 必须手工登记 —— 漏了它的表现是"开关打得开但浮窗永不出现", 界面上完全看不出是缺文件。
const htmlSrc = fs.existsSync('renderer/index.html') ? fs.readFileSync('renderer/index.html', 'utf8') : '';
const rendererScripts = [...htmlSrc.matchAll(/<script src="([^"]+)"/g)].map(m => 'renderer/' + m[1].split('?')[0]);
// 样式表同样从 index.html 解析: 漏一个的表现是"界面整体错位", 比缺脚本更显眼但也更该在出包前拦住
const rendererStyles = [...htmlSrc.matchAll(/<link[^>]*href="(css\/[^"?]+)/g)].map(m => 'renderer/' + m[1]);
const requiredFiles = ['main/index.js', 'main/lcu.js', 'main/lcu-ws.js', 'main/sgp.js', 'main/gamedata.js', 'main/game-settings.js', 'main/preload.js', 'main/native/PoroInput.exe', 'main/native/PoroOcrWorker.ps1', 'main/win-rect.js', 'main/overlay-position.js', ...rendererScripts, ...rendererStyles, 'renderer/index.html', 'renderer/overlay.html', 'renderer/js/overlay.js'];
for (const f of requiredFiles) {
  if (!fs.existsSync(f)) fail.push(f + ' 缺失');
}
for (const f of requiredFiles.filter(f => f.endsWith('.js'))) {
  if (!fs.existsSync(f)) continue;
  try { new Function(fs.readFileSync(f, 'utf8')); } catch (error) { fail.push(f + ' 语法错误: ' + error.message); }
}
// 渲染层资源的缓存戳 (?v=): 打包后做 in-place 升级时 file:// 的 URL 没变,
// Chromium 可能继续用缓存里的旧副本 —— 表现为"装了新版但跑的还是旧逻辑/旧样式"。
// 2026-09-27 实测: 23 个脚本里 12 个戳过期, 最旧的落后 11 天, 还有 1 个压根没戳。
// 同日补充: **CSS 也漏在外面** —— 3 个 <link> 的戳比最近提交还旧, 而改样式时
// 恰恰最容易忘记刷戳, 后果是"新样式不生效"且从界面上完全看不出原因。
// 缺戳直接拦下; 戳偏旧只警告 (开发期频繁改动, 每次都拦会很难受), 出包前统一刷一次即可。
const stamped = [
  ...htmlSrc.matchAll(/<script src="(js\/[^"?]+)(?:\?v=([0-9]+))?"/g),
  ...htmlSrc.matchAll(/<link[^>]*href="(css\/[^"?]+)(?:\?v=([0-9]+))?"/g)
].map(m => ({ path: m[1], stamp: m[2] }));
if (!stamped.length) fail.push('未能从 index.html 解析出任何渲染层资源, 缓存戳检查形同虚设');
const noStamp = stamped.filter(s => !s.stamp).map(s => s.path);
if (noStamp.length) fail.push('渲染层资源缺少 ?v= 缓存戳: ' + noStamp.join(', '));
let headDate = null;
try {
  headDate = require('child_process').execSync('git log -1 --date=short --format=%cd', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch (e) { headDate = null; }
if (headDate) {
  const ymd = headDate.replace(/-/g, '');
  const stale = stamped.filter(s => s.stamp && String(s.stamp).slice(0, 8) < ymd).map(s => `${s.path}?v=${s.stamp}`);
  if (stale.length) warn.push(`缓存戳早于最近一次提交 (${headDate}), 出包前建议统一刷新: ` + stale.join(', '));
}
// 版本号只能有一个来源: package.json。
// 渲染层若写死版本号, 会出现"改了 package.json 但界面还显示旧号"的假象,
// 极易被误判成"部署没生效" —— 这类问题排查成本很高, 所以在构建前直接拦下。
const verTags = [...htmlSrc.matchAll(/id="versionText"[^>]*>([^<]*)</g)].map(m => m[1].trim());
for (const v of verTags) {
  if (/\d+\.\d+\.\d+/.test(v)) fail.push('renderer/index.html 的 versionText 写死了版本号 "' + v + '", 应留占位符由 app.js 动态填入');
}
const appSrc = fs.existsSync('renderer/js/app.js') ? fs.readFileSync('renderer/js/app.js', 'utf8') : '';
if (/versionText"\)\.textContent\s*=\s*["'`]v?\d+\.\d+/.test(appSrc)) {
  fail.push('renderer/js/app.js 写死了 versionText 版本号, 应改用 lolAPI.getAppVersion()');
}
const mainSrc = fs.existsSync('main/index.js') ? fs.readFileSync('main/index.js', 'utf8') : '';
const preloadSrc = fs.existsSync('main/preload.js') ? fs.readFileSync('main/preload.js', 'utf8') : '';
if (!/ipcMain\.handle\(\s*['"]app:version['"]/.test(mainSrc)) fail.push('main/index.js 缺少 app:version IPC');
if (!/getAppVersion\s*:/.test(preloadSrc)) fail.push('main/preload.js 未暴露 getAppVersion');
// 选人浮窗的接线: 主进程要收数据(overlay:update)并转发点击(overlay:swap),
// preload 要同时给主窗口与浮窗提供通道 —— 少一个都会让浮窗"要么不显示、要么点了没反应"。
if (!/ipcMain\.handle\(\s*['"]overlay:update['"]/.test(mainSrc)) fail.push('main/index.js 缺少 overlay:update IPC');
if (!/ipcMain\.handle\(\s*['"]overlay:swap['"]/.test(mainSrc)) fail.push('main/index.js 缺少 overlay:swap IPC');
if (!/overlayUpdate\s*:/.test(preloadSrc)) fail.push('main/preload.js 未暴露 overlayUpdate');
if (!/overlaySwap\s*:/.test(preloadSrc)) fail.push('main/preload.js 未暴露 overlaySwap');
if (!/onOverlaySwap\s*:/.test(preloadSrc)) fail.push('main/preload.js 未暴露 onOverlaySwap');
if (!/onOverlayHidden\s*:/.test(preloadSrc)) fail.push('main/preload.js 未暴露 onOverlayHidden');
// 浮窗渲染层不得自己去打 LCU: 判定逻辑只允许有一处 (renderer/js/bench.js)
const overlaySrc = fs.existsSync('renderer/js/overlay.js') ? fs.readFileSync('renderer/js/overlay.js', 'utf8') : '';
if (/lcuRequest|ipcRenderer/.test(overlaySrc)) fail.push('renderer/js/overlay.js 不应直接调用 LCU 或 IPC (判定逻辑必须留在 bench.js)');
if (!/<script src="js\/overlay\.js"/.test(fs.existsSync('renderer/overlay.html') ? fs.readFileSync('renderer/overlay.html', 'utf8') : '')) {
  fail.push('renderer/overlay.html 未加载 js/overlay.js');
}

for (const w of warn) console.warn('[警告] ' + w);

if (fail.length) { console.error('构建自检失败: ' + fail.join('; ')); process.exit(1); }
console.log('构建自检通过' + (warn.length ? ` (${warn.length} 条警告)` : ''));
