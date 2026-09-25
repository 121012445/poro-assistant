const { app, BrowserWindow, Menu, ipcMain, Tray, globalShortcut, screen: electronScreen, safeStorage, nativeImage, desktopCapturer, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFile, spawn } = require('child_process');
const { pathToFileURL } = require('url');

// 启动诊断必须早于本地模块加载。以前这里之后任意 require/初始化失败时，
// Electron 会在窗口出现前直接退出，用户看到的就只是“点开后消失”。
const USER_DATA = app.getPath('userData');
const LOG_FILE = path.join(USER_DATA, 'crash.log');
const STARTUP_MARKER = path.join(USER_DATA, 'startup-pending.json');
const SAFE_MODE_ARG = '--poro-safe-mode';
const RENDERER_COMPAT_ARG = '--poro-renderer-compat';
function logErr(msg) {
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    // 日志轮转: 超过 512KB 换 .old, 防止无限增长
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size > 512 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    } catch (e) {}
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) {}
}

let startupComplete = false;
let fatalErrorReported = false;
function formatError(error) {
  if (error instanceof Error) return error.stack || error.message;
  try { return JSON.stringify(error); } catch (e) { return String(error); }
}
function reportFatal(stage, error) {
  const detail = formatError(error);
  logErr(`[FATAL ${stage}] ${detail}`);
  if (fatalErrorReported) return;
  fatalErrorReported = true;
  try {
    dialog.showErrorBox(
      startupComplete ? 'Poro 运行错误' : 'Poro 启动失败',
      `${stage}\n\n${detail.substring(0, 1400)}\n\n诊断日志：${LOG_FILE}`
    );
  } catch (e) {}
  if (!startupComplete) {
    try { app.exit(1); } catch (e) { process.exitCode = 1; }
  }
}
process.on('uncaughtException', error => reportFatal('未捕获异常', error));
process.on('unhandledRejection', error => reportFatal('未处理的异步异常', error));

const hasSingleInstanceLock = app.requestSingleInstanceLock();
let previousStartupInterrupted = false;
if (hasSingleInstanceLock) {
  try { previousStartupInterrupted = fs.existsSync(STARTUP_MARKER); } catch (e) {}
}
const rendererCompatActive = process.argv.includes(RENDERER_COMPAT_ARG);
const safeModeActive = process.env.PORO_DISABLE_GPU === '1'
  || process.argv.includes(SAFE_MODE_ARG)
  || rendererCompatActive
  || previousStartupInterrupted;
if (safeModeActive) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  logErr(`[STARTUP] software rendering enabled explicit=${process.argv.includes(SAFE_MODE_ARG)} previousIncomplete=${previousStartupInterrupted}`);
}
if (rendererCompatActive) {
  // 仅关闭 Poro 本地 BrowserWindow 的 renderer sandbox，不使用全局 --no-sandbox。
  // nodeIntegration/contextIsolation/webSecurity/导航白名单仍保持原来的安全边界。
  logErr('[STARTUP] renderer compatibility mode enabled (per-window sandbox disabled)');
}
if (hasSingleInstanceLock) {
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.writeFileSync(STARTUP_MARKER, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
  } catch (error) { logErr('[STARTUP MARKER WRITE FAILED] ' + formatError(error)); }
}

const lcu = require('./lcu');
const sgp = require('./sgp');
const lcuWs = require('./lcu-ws');
const gameSettings = require('./game-settings');
const aramkit = require('./aramkit');
// 选人浮窗的两块支撑: 读客户端窗口矩形 (koffi 直调 user32, 无需编译) + 纯函数位置计算
const winRect = require('./win-rect');
const overlayPosition = require('./overlay-position');
const augmentRecognizerFactory = require('./augment-recognizer');
const augmentVision = require('./augment-vision');
const augmentOcrMatch = require('./augment-ocr-match');
const hotkeyPollerFactory = require('./hotkey-poller');

if (process.platform === 'win32') app.setAppUserModelId('com.poro.assistant');

const APP_ICON_ICO = app.isPackaged
  ? path.join(process.resourcesPath, 'app-icon.ico')
  : path.join(__dirname, '..', 'build', 'icon.ico');
const APP_ICON_PNG = app.isPackaged
  ? path.join(process.resourcesPath, 'app-icon.png')
  : path.join(__dirname, '..', 'renderer', 'assets', 'icon.png');

function loadAppIcon() {
  const pngIcon = nativeImage.createFromPath(APP_ICON_PNG);
  if (!pngIcon.isEmpty()) return pngIcon;
  const icoIcon = nativeImage.createFromPath(APP_ICON_ICO);
  return icoIcon.isEmpty() ? null : icoIcon;
}

const augmentRecognizer = augmentRecognizerFactory.createRecognizer(nativeImage, USER_DATA, logErr);

let mainWindow = null;
if (!hasSingleInstanceLock) {
  logErr('[SINGLE INSTANCE] duplicate launch redirected to the existing instance');
  app.quit();
} else {
  logErr('=== APP START ===');
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function log() {
  try { process.stdout.write(Array.from(arguments).join(' ') + '\n'); } catch (e) { }
}

const API_HOST = 'ddragon.leagueoflegends.com';
const RIOT_REGIONS = ['americas', 'europe', 'asia', 'sea'];
const FALLBACK_VERSION = '14.18.1';
const MAX_JSON_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_USER_FILE_BYTES = 5 * 1024 * 1024;

// 通用 GET
function httpGet(hostname, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname, port: 443, path: urlPath, method: 'GET',
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, headers || {})
    }, (res) => {
      let data = '';
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_JSON_RESPONSE_BYTES) return req.destroy(new Error('响应数据过大'));
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// 通用 POST (AI 复盘用, OpenAI 兼容接口)
function httpsPost(hostname, port, urlPath, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body, 'utf8');
    const req = https.request({
      hostname, port: port || 443, path: urlPath, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': payload.length }, headers || {})
    }, (res) => {
      let data = '';
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_JSON_RESPONSE_BYTES) return req.destroy(new Error('AI 响应数据过大'));
        data += chunk;
      });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) {
          reject(new Error('HTTP ' + res.statusCode + ' 响应非JSON: ' + data.substring(0, 150)));
        }
      });
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(timeoutMs || 60000, () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(payload);
    req.end();
  });
}

const ddragonRequest = (p) => httpGet(API_HOST, p);

// Riot API - 区域路由 (americas/europe/asia/sea)
function riotRequest(region, urlPath, apiKey) {
  if (!RIOT_REGIONS.includes(region)) return Promise.reject(new Error('无效区域: ' + region));
  return httpGet(region + '.api.riotgames.com', urlPath, { 'X-Riot-Token': apiKey });
}

// ---------- Data Dragon 静态数据磁盘缓存 ----------
// 具体实现见 main/gamedata.js (可独立单测); 这里注入 userData 目录与日志函数。
const gamedata = require('./gamedata').createStore(path.join(USER_DATA, 'gamedata'), logErr);
let versionCache = { v: null, t: 0 };
async function resolveVersion() {
  if (versionCache.v && Date.now() - versionCache.t < 30 * 60 * 1000) return versionCache.v;
  try {
    const r = await ddragonRequest('/api/versions.json');
    if (Array.isArray(r) && r[0]) {
      versionCache = { v: r[0], t: Date.now() };
      return r[0];
    }
  } catch (e) { /* 国服对 /api/ 返回 403 或超时, 交给磁盘兜底 */ }
  const cached = gamedata.cachedVersions()[0];
  return cached || FALLBACK_VERSION;
}

function createWindow() {
  const appIcon = loadAppIcon();
  if (appIcon) {
    const iconSize = appIcon.getSize();
    logErr(`[ICON] native image loaded ${iconSize.width}x${iconSize.height}`);
  } else {
    logErr('[ICON] failed to load runtime icon');
  }
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600,
    frame: false, backgroundColor: '#faf6ee', show: !process.env.PORO_TEST,
    icon: appIcon || APP_ICON_ICO,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: !rendererCompatActive,
      webSecurity: true,
      // 主窗口最小化/隐藏到托盘后仍需持续监听对局阶段并扫描强化选择画面。
      // Chromium 默认会把隐藏渲染器的 setInterval 强烈节流，表现为“有时整轮不识别”。
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
      devTools: !app.isPackaged
    }
  });
  if (appIcon) mainWindow.setIcon(appIcon);
  if (process.platform === 'win32') {
    mainWindow.setAppDetails({
      appId: 'com.poro.assistant',
      appIconPath: APP_ICON_ICO,
      appIconIndex: 0,
      relaunchCommand: process.execPath,
      relaunchDisplayName: 'Poro'
    });
  }
  // 页面深链: electron . --page=tools 直接打开指定页
  const pageHintArg = process.argv.find(a => a.startsWith('--page='));
  const pageHint = pageHintArg ? { hash: pageHintArg.split('=')[1] } : undefined;
  const rendererEntry = path.join(__dirname, '..', 'renderer', 'index.html');
  const rendererUrl = pathToFileURL(rendererEntry).toString();
  mainWindow.loadFile(rendererEntry, pageHint);
  mainWindow.webContents.on('did-finish-load', () => {
    startupComplete = true;
    try { fs.unlinkSync(STARTUP_MARKER); } catch (e) {}
    logErr(`[STARTUP] renderer ready softwareRendering=${safeModeActive}`);
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(rendererUrl)) event.preventDefault();
  });
  let rendererRecoveryStarted = false;
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    const reason = details?.reason || 'unknown';
    logErr('[RENDERER GONE] reason=' + reason + ' exitCode=' + (details?.exitCode ?? 'unknown'));
    if (reason === 'clean-exit' || rendererRecoveryStarted) return;
    rendererRecoveryStarted = true;
    if (!safeModeActive) {
      logErr('[STARTUP RECOVERY] relaunching once with software rendering');
      try {
        const args = process.argv.slice(1)
          .filter(arg => arg !== SAFE_MODE_ARG && arg !== RENDERER_COMPAT_ARG)
          .concat(SAFE_MODE_ARG);
        app.relaunch({ args });
        app.exit(0);
        return;
      } catch (error) { logErr('[STARTUP RECOVERY FAILED] ' + formatError(error)); }
    }
    if (reason === 'launch-failed' && !rendererCompatActive) {
      logErr('[STARTUP RECOVERY] renderer launch failed; relaunching with per-window sandbox compatibility');
      try {
        const args = process.argv.slice(1)
          .filter(arg => arg !== SAFE_MODE_ARG && arg !== RENDERER_COMPAT_ARG)
          .concat(SAFE_MODE_ARG, RENDERER_COMPAT_ARG);
        app.relaunch({ args });
        app.exit(0);
        return;
      } catch (error) { logErr('[RENDERER COMPAT RECOVERY FAILED] ' + formatError(error)); }
    }
    reportFatal('渲染进程异常退出（已尝试兼容模式）', new Error(`reason=${reason}, exitCode=${details?.exitCode ?? 'unknown'}`));
  });
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    logErr('[LOAD FAILED] ' + code + ' ' + desc + ' mainFrame=' + isMainFrame);
    console.error('[LOAD FAILED]', code, desc);
    if (isMainFrame && code !== -3) reportFatal('主页面加载失败', new Error(`${code} ${desc}`));
  });
  // Electron 开发模式的固有安全警告 (打包后自动消失): 只打印到控制台, 不写 crash.log
  const BENIGN_CONSOLE = [
    /Electron Security Warning/i,
    /Insecure Content-Security-Policy/i
  ];
  mainWindow.webContents.on('console-message', (e, level, msg) => {
    if (level < 2) return;
    const text = String(msg || '');
    if (!BENIGN_CONSOLE.some(re => re.test(text))) logErr('[CONSOLE ERR] ' + text.substring(0, 500));
    console.error('[CONSOLE]', text.substring(0, 200));
  });
  // 关窗进托盘常驻 (退出走托盘菜单)
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  const menu = Menu.buildFromTemplate([{
    label: '查看',
    submenu: [
      { label: '开发者工具', accelerator: 'Ctrl+Shift+I', click: () => mainWindow.webContents.openDevTools() },
      { label: '刷新', accelerator: 'F5', click: () => mainWindow.reload() }
    ]
  }]);
  mainWindow.setMenu(menu);
}

// ---------- 选人浮窗 (备战区助手) ----------
// 一个无边框、置顶的小窗, 选人时浮在客户端旁边, 让玩家不切回主窗口就能换备战区英雄。
// 它自己完全不碰 LCU: 按钮数据和状态文案都由主窗口渲染层推过来, 点击再回传给主窗口,
// 复用同一套换人逻辑 (门禁/重试/合规拦截) —— 浮窗只是"把那只手伸到客户端旁边"。
let overlayWindow = null;
let overlayPayload = { title: '备战区', items: [], state: '', stateClass: '' };
let overlayVisible = false;

const OVERLAY_BOUNDS_FILE = () => path.join(USER_DATA, 'overlay.json');
const OVERLAY_SIZE = overlayPosition.OVERLAY_SIZE;
let lastClientRect = null;            // 最近一次读到的客户端矩形, 仅供 overlay:status 诊断
let lastOverlayWorkArea = null;       // 同上: 上次用于夹边界的工作区
let lastOverlaySaved = null;          // 同上: 上次用到的"用户拖拽位置" (null = 走自动吸附)
let overlayProgrammaticMove = false;  // 区分"我们自己摆的"与"用户拖的" —— 只有后者才落盘

function loadOverlayBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(OVERLAY_BOUNDS_FILE(), 'utf8'));
    if (b && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(b[k]))) return b;
  } catch (e) {}
  return null;
}

function saveOverlayBounds() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    if (!fs.existsSync(USER_DATA)) fs.mkdirSync(USER_DATA, { recursive: true });
    fs.writeFileSync(OVERLAY_BOUNDS_FILE(), JSON.stringify(overlayWindow.getBounds()));
  } catch (e) {}
}

// 默认贴主屏工作区右侧、垂直居中 —— 客户端通常居中或靠左, 这里不挡画面
function defaultOverlayBounds() {
  let wa = { x: 0, y: 0, width: 1280, height: 720 };
  try { wa = electronScreen.getPrimaryDisplay().workArea; } catch (e) {}
  return overlayPosition.defaultOverlayBounds(wa, OVERLAY_SIZE);
}

// 摆哪儿: 用户拖过就沿用用户的位置; 否则贴客户端外侧边缘; 拿不到客户端矩形就退回贴屏幕边缘。
// 每次显示都重算, 这样客户端换位置 / 最大化时浮窗会跟着走。
function overlayBoundsForShow() {
  const saved = loadOverlayBounds();
  lastOverlaySaved = saved;
  let clientRect = null;
  try { clientRect = winRect.getLeagueClientRect(); } catch (e) { clientRect = null; }
  lastClientRect = clientRect;
  let workArea = null;
  try {
    // 客户端在副屏时, 要按它所在那块屏的工作区来夹边界
    const display = clientRect ? electronScreen.getDisplayMatching(clientRect) : electronScreen.getPrimaryDisplay();
    if (display && display.workArea) workArea = display.workArea;
  } catch (e) {}
  lastOverlayWorkArea = workArea;
  if (!workArea) return defaultOverlayBounds();
  return overlayPosition.computeOverlayBounds({ clientRect: clientRect, workArea: workArea, size: OVERLAY_SIZE, saved: saved });
}

// setBounds 同样会触发 'moved'; 用这个标记把"程序摆的"排除掉,
// 否则自动吸附的位置会被当成用户意图存下来, 之后就不再跟着客户端走了。
function applyOverlayBounds(win, bounds) {
  overlayProgrammaticMove = true;
  try { win.setBounds(bounds); } catch (e) {}
  setTimeout(() => { overlayProgrammaticMove = false; }, 500);
}

function pushOverlayData() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try { overlayWindow.webContents.send('overlay:data', overlayPayload); } catch (e) {}
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const bounds = overlayBoundsForShow();
  overlayWindow = new BrowserWindow(Object.assign({}, bounds, {
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    title: 'Poro 备战区浮窗',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: !rendererCompatActive,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
      devTools: !app.isPackaged
    }
  }));
  // screen-saver 层级才能稳定盖在客户端之上; 主窗口那边的 alwaysOnTop 不共享
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  try { overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}
  overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  overlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlayWindow.webContents.on('did-finish-load', pushOverlayData);
  overlayWindow.webContents.on('did-fail-load', (e, code, desc) => logErr('[OVERLAY LOAD FAILED] ' + code + ' ' + desc));
  overlayWindow.on('moved', () => { if (!overlayProgrammaticMove) saveOverlayBounds(); });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    overlayVisible = false;
  });
  return overlayWindow;
}

// 渲染层每次重绘备战区按钮/状态时调用。浮窗只是转发目标, 判定逻辑全在主窗口那边。
ipcMain.handle('overlay:update', async (e, payload) => {
  if (!mainWindow || mainWindow.isDestroyed() || e.sender.id !== mainWindow.webContents.id) return false;
  const p = payload || {};
  overlayPayload = {
    title: String(p.title || '备战区').substring(0, 40),
    items: (Array.isArray(p.items) ? p.items : [])
      .filter(it => it && Number.isInteger(Number(it.id)) && Number(it.id) > 0)
      .slice(0, 24)
      .map(it => ({
        id: Number(it.id),
        name: String(it.name || ('英雄#' + it.id)).substring(0, 24),
        tag: String(it.tag || '').substring(0, 8)
      })),
    state: String(p.state || '').substring(0, 200),
    stateClass: String(p.stateClass || '').substring(0, 40)
  };
  // 主进程是最终门禁：即使渲染层收到迟到的 champ-select/列表事件，只要已经进入
  // GameStart（加载页）或 InProgress，就拒绝重新显示备战区浮窗。
  const want = !!p.visible && lastReportedPhase === 'ChampSelect';
  if (want) {
    const win = createOverlayWindow();
    overlayVisible = true;
    // 每次显示都重新贴一次: 期间客户端可能换过位置或被最大化
    applyOverlayBounds(win, overlayBoundsForShow());
    // showInactive: 只显示不抢焦点。抢焦点会把客户端顶到后台, 玩家会以为卡了。
    if (!win.isVisible()) win.showInactive();
    pushOverlayData();
  } else if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayVisible = false;
    overlayWindow.hide();
  } else {
    overlayVisible = false;
  }
  return true;
});

// 浮窗点了某个英雄 -> 回传主窗口, 由 benchSwapNow 走完整流程
ipcMain.handle('overlay:swap', async (e, championId) => {
  if (!overlayWindow || overlayWindow.isDestroyed() || e.sender.id !== overlayWindow.webContents.id) return false;
  const id = Number(championId);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('overlay:swap', id);
  return true;
});

// 浮窗自带的收起按钮：本局隐藏，下一局选人重新允许出现。
ipcMain.handle('overlay:hide', async (e) => {
  if (!overlayWindow || overlayWindow.isDestroyed() || e.sender.id !== overlayWindow.webContents.id) return false;
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  overlayVisible = false;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('overlay:hidden');
  return true;
});

// 浮窗状态查询 (含诊断字段), 供渲染层与自动化探针确认浮窗真实状态与位置
ipcMain.handle('overlay:status', async () => ({
  visible: !!(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()),
  exists: !!(overlayWindow && !overlayWindow.isDestroyed()),
  // 下面三项只为诊断与自动化验证: 用来确认"浮窗真的贴到了客户端旁边", 而不是靠肉眼看。
  bounds: (overlayWindow && !overlayWindow.isDestroyed()) ? overlayWindow.getBounds() : null,
  clientRect: lastClientRect,
  workArea: lastOverlayWorkArea,
  savedBounds: lastOverlaySaved,
  winRectAvailable: winRect.isAvailable()
}));

// ---------- 对局内强化识别与推荐浮层 ----------
// 与选人浮窗分开：前者贴 RCLIENT 并可点击，强化浮层贴 RiotWindowClass、完全穿透鼠标。
let augmentOverlayWindow = null;
let augmentOverlayPayload = { champion: '', items: [], state: '' };
const AUGMENT_OVERLAY_SIZE = { width: 410, height: 262 };
let lastAugmentOverlayScale = 1;

function augmentOverlayMetrics() {
  let game = null;
  try { game = winRect.getLeagueGameRect(); } catch (e) {}
  let display = null;
  try { display = game ? electronScreen.getDisplayMatching(game) : electronScreen.getPrimaryDisplay(); } catch (e) {}
  const area = display?.workArea || { x: 0, y: 0, width: 1280, height: 720 };
  // 以 1440p 为视觉基准，同时考虑系统 DPI。限制范围避免小屏不可读或大屏遮挡过多。
  const heightScale = game?.height ? game.height / 1440 : area.height / 1080;
  const dpiScale = Math.max(1, Number(display?.scaleFactor) || 1);
  const scale = Math.max(0.78, Math.min(1.18, heightScale * Math.min(1.12, Math.sqrt(dpiScale))));
  const width = Math.round(AUGMENT_OVERLAY_SIZE.width * scale);
  const height = Math.round(AUGMENT_OVERLAY_SIZE.height * scale);
  const x = game ? game.x + 18 : area.x + 18;
  const y = game ? game.y + Math.max(54, Math.round(game.height * 0.065)) : area.y + 60;
  return { scale, bounds: {
    x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
    width,
    height
  }};
}

function augmentOverlayBounds() { return augmentOverlayMetrics().bounds; }

function pushAugmentOverlayData() {
  if (!augmentOverlayWindow || augmentOverlayWindow.isDestroyed()) return;
  try { augmentOverlayWindow.webContents.send('augment-overlay:data', augmentOverlayPayload); } catch (e) {}
}

function showAugmentOverlayWindow(win, reason) {
  if (!win || win.isDestroyed()) return false;
  try {
    const metrics = augmentOverlayMetrics();
    lastAugmentOverlayScale = metrics.scale;
    win.setBounds(metrics.bounds);
    try { win.webContents.setZoomFactor(metrics.scale); } catch (e) {}
    win.setOpacity(1);
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setIgnoreMouseEvents(true, { forward: false });
    // 全屏/无边框游戏切换后，showInactive 偶尔只更新 Electron 内部状态而 HWND
    // 仍是隐藏的。窗口本身不可聚焦，因此直接 show 不会抢走游戏键盘焦点。
    win.show();
    try { win.moveTop(); } catch (e) {}
    pushAugmentOverlayData();
    logErr('[AUGMENT OVERLAY] show reason=' + reason + ' visible=' + win.isVisible() + ' bounds=' + JSON.stringify(win.getBounds()));
    return win.isVisible();
  } catch (error) {
    logErr('[AUGMENT OVERLAY] show failed: ' + error.message);
    return false;
  }
}

function createAugmentOverlayWindow() {
  if (augmentOverlayWindow && !augmentOverlayWindow.isDestroyed()) return augmentOverlayWindow;
  augmentOverlayWindow = new BrowserWindow(Object.assign(augmentOverlayBounds(), {
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    focusable: false,
    alwaysOnTop: true,
    title: 'Poro 海斗强化推荐',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: !rendererCompatActive,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
      devTools: !app.isPackaged
    }
  }));
  augmentOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
  augmentOverlayWindow.setIgnoreMouseEvents(true, { forward: false });
  try { augmentOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}
  augmentOverlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'augment-overlay.html'));
  augmentOverlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  augmentOverlayWindow.webContents.on('did-finish-load', () => {
    pushAugmentOverlayData();
    if (augmentOverlayPayload.items.length) showAugmentOverlayWindow(augmentOverlayWindow, 'did-finish-load');
  });
  augmentOverlayWindow.once('ready-to-show', () => {
    if (augmentOverlayPayload.items.length) showAugmentOverlayWindow(augmentOverlayWindow, 'ready-to-show');
  });
  augmentOverlayWindow.webContents.on('did-fail-load', (e, code, desc) => logErr('[AUGMENT OVERLAY LOAD FAILED] ' + code + ' ' + desc));
  augmentOverlayWindow.on('closed', () => { augmentOverlayWindow = null; });
  return augmentOverlayWindow;
}

function normalizeOcrText(value) {
  return augmentOcrMatch.normalizeOcrText(value);
}

let augmentOcrWorker = null;
let augmentOcrOutput = '';
let augmentOcrPending = [];

function augmentOcrWorkerPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'main', 'native', 'PoroOcrWorker.ps1')
    : path.join(__dirname, 'native', 'PoroOcrWorker.ps1');
}

function rejectAugmentOcrPending(error) {
  const pending = augmentOcrPending.splice(0);
  for (const item of pending) {
    clearTimeout(item.timer);
    item.reject(error);
  }
}

function stopAugmentOcrWorker() {
  const worker = augmentOcrWorker;
  augmentOcrWorker = null;
  augmentOcrOutput = '';
  rejectAugmentOcrPending(new Error('OCR 识别进程已停止'));
  try { worker?.kill(); } catch (e) {}
}

function ensureAugmentOcrWorker() {
  if (augmentOcrWorker && !augmentOcrWorker.killed) return augmentOcrWorker;
  const worker = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', augmentOcrWorkerPath()
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  augmentOcrWorker = worker;
  worker.stdout.setEncoding('utf8');
  worker.stdout.on('data', chunk => {
    augmentOcrOutput += chunk;
    let newline;
    while ((newline = augmentOcrOutput.indexOf('\n')) >= 0) {
      const line = augmentOcrOutput.slice(0, newline).replace(/\r$/, '');
      augmentOcrOutput = augmentOcrOutput.slice(newline + 1);
      const pending = augmentOcrPending.shift();
      if (!pending) continue;
      clearTimeout(pending.timer);
      const [status, encoded = ''] = line.split('\t', 2);
      let value = '';
      try { value = Buffer.from(encoded, 'base64').toString('utf8'); } catch (e) {}
      if (status === 'OK') pending.resolve(value);
      else pending.reject(new Error(value || 'OCR 识别失败'));
    }
  });
  worker.stderr.setEncoding('utf8');
  worker.stderr.on('data', chunk => logErr('[AUGMENT OCR WORKER] ' + String(chunk).trim().substring(0, 400)));
  const failed = error => {
    if (augmentOcrWorker !== worker) return;
    augmentOcrWorker = null;
    rejectAugmentOcrPending(error instanceof Error ? error : new Error('OCR 识别进程已退出'));
  };
  worker.on('error', failed);
  worker.on('exit', code => failed(new Error('OCR 识别进程已退出 (' + code + ')')));
  return worker;
}

function requestAugmentOcr(imagePath) {
  return new Promise((resolve, reject) => {
    const worker = ensureAugmentOcrWorker();
    const pending = { resolve, reject, timer: null };
    pending.timer = setTimeout(() => {
      if (!augmentOcrPending.includes(pending)) return;
      stopAugmentOcrWorker();
      reject(new Error('OCR 识别超时'));
    }, 4000);
    augmentOcrPending.push(pending);
    const encodedPath = Buffer.from(imagePath, 'utf8').toString('base64');
    worker.stdin.write(encodedPath + '\n', error => {
      if (!error) return;
      const index = augmentOcrPending.indexOf(pending);
      if (index >= 0) augmentOcrPending.splice(index, 1);
      clearTimeout(pending.timer);
      reject(error);
    });
  });
}

async function recognizeAugmentNamesByOcr(screenshot, candidates) {
  if (process.platform !== 'win32' || !screenshot || screenshot.isEmpty()) return [];
  const size = screenshot.getSize();
  // 每张卡单独 OCR，才能保证结果与左/中/右槽位一一对应。整块 OCR 会按版面分析顺序
  // 返回“左、右、中”，曾导致推荐名称和游戏卡片对不上。
  // 每次使用唯一文件名；Windows OCR 对仍被上一轮 StorageFile 持有的同名文件会间歇性打开失败。
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const titleRects = augmentVision.offerTitleRects(size.width, size.height);
  const jobs = augmentVision.offerNameRects(size.width, size.height).map(async (rect, slot) => {
    const imagePath = path.join(USER_DATA, `augment-ocr-${stamp}-${slot}.png`);
    const titlePath = path.join(USER_DATA, `augment-ocr-${stamp}-${slot}-title.png`);
    try {
      // Windows OCR 对 1440p 卡面里的短标题（例如“捐赠”）会优先跳到下方较大的说明文字，
      // 造成图标明明命中却始终缺一个槽位。放大后再识别不会改变布局，但能稳定保留标题。
      const crop = screenshot.crop(rect);
      const cropSize = crop.getSize();
      const ocrImage = crop.resize({ width: cropSize.width * 2, height: cropSize.height * 2, quality: 'best' });
      fs.writeFileSync(imagePath, ocrImage.toPNG());
      const text = await requestAugmentOcr(imagePath);
      let match = augmentOcrMatch.matchAugmentNames(text, candidates, 1)[0] || null;
      let titleText = '';
      if (!match) {
        const titleCrop = screenshot.crop(titleRects[slot]);
        const titleSize = titleCrop.getSize();
        const titleImage = titleCrop.resize({ width: titleSize.width * 3, height: titleSize.height * 3, quality: 'best' });
        fs.writeFileSync(titlePath, titleImage.toPNG());
        titleText = await requestAugmentOcr(titlePath);
        match = augmentOcrMatch.matchAugmentNames(titleText, candidates, 1)[0] || null;
      }
      logErr(`[AUGMENT OCR] slot=${slot + 1} text=${String(text).replace(/\s+/g, ' ').substring(0, 80)} title=${String(titleText).replace(/\s+/g, ' ').substring(0, 40)} match=${match?.name || ''}`);
      return match ? Object.assign({ slot }, match) : null;
    } finally {
      try { fs.unlinkSync(imagePath); } catch (e) {}
      try { fs.unlinkSync(titlePath); } catch (e) {}
    }
  });
  return (await Promise.all(jobs)).filter(Boolean);
}

ipcMain.handle('augment-overlay:update', async (e, payload) => {
  if (!mainWindow || mainWindow.isDestroyed() || e.sender.id !== mainWindow.webContents.id) return false;
  const p = payload || {};
  augmentOverlayPayload = {
    champion: String(p.champion || '').substring(0, 36),
    state: String(p.state || '').substring(0, 100),
    items: (Array.isArray(p.items) ? p.items : []).slice(0, 3).map((item, index) => ({
      rank: index + 1,
      slot: Math.max(0, Math.min(2, Number(item?.slot) || 0)),
      name: String(item?.name || '').substring(0, 60),
      icon: String(item?.icon || '').startsWith('https://raw.communitydragon.org/') ? String(item.icon) : '',
      winRate: item?.winRate != null && Number.isFinite(Number(item.winRate)) ? Number(item.winRate) : null,
      recommendationScore: item?.recommendationScore != null && Number.isFinite(Number(item.recommendationScore)) ? Number(item.recommendationScore) : null,
      games: Math.max(0, Number(item?.games) || 0),
      confidenceLevel: ['high', 'medium', 'low'].includes(String(item?.confidenceLevel)) ? String(item.confidenceLevel) : 'low',
      confidenceLabel: String(item?.confidenceLabel || '').substring(0, 12),
      reason: String(item?.reason || '').substring(0, 120),
      confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0))
    })).filter(item => item.name)
  };
  if (p.visible && augmentOverlayPayload.items.length) {
    const win = createAugmentOverlayWindow();
    const visible = showAugmentOverlayWindow(win, 'update');
    // Chromium 首次创建透明窗口时可能晚于 IPC 返回才完成合成，再补一次不抢焦点的确认。
    if (!visible || win.webContents.isLoading()) {
      setTimeout(() => {
        if (augmentOverlayPayload.items.length) showAugmentOverlayWindow(win, 'delayed-confirm');
      }, 120);
    }
  } else if (augmentOverlayWindow && !augmentOverlayWindow.isDestroyed()) {
    logErr('[AUGMENT OVERLAY] hide requested items=' + augmentOverlayPayload.items.length + ' visible=' + !!p.visible);
    augmentOverlayWindow.hide();
  }
  return {
    ok: true,
    visible: !!(augmentOverlayWindow && !augmentOverlayWindow.isDestroyed() && augmentOverlayWindow.isVisible()),
    bounds: augmentOverlayWindow && !augmentOverlayWindow.isDestroyed() ? augmentOverlayWindow.getBounds() : null
  };
});

ipcMain.handle('augment-overlay:status', async () => ({
  exists: !!(augmentOverlayWindow && !augmentOverlayWindow.isDestroyed()),
  visible: !!(augmentOverlayWindow && !augmentOverlayWindow.isDestroyed() && augmentOverlayWindow.isVisible()),
  bounds: augmentOverlayWindow && !augmentOverlayWindow.isDestroyed() ? augmentOverlayWindow.getBounds() : null,
  items: augmentOverlayPayload.items.length,
  scale: Number(lastAugmentOverlayScale.toFixed(2)),
  gameRectAvailable: (() => { try { return !!winRect.getLeagueGameRect(); } catch (e) { return false; } })()
}));

ipcMain.handle('game:recognizeAugments', async (e, candidates) => {
  if (!mainWindow || mainWindow.isDestroyed() || e.sender.id !== mainWindow.webContents.id) {
    return { __error: '调用来源无效' };
  }
  try {
    // 抓“屏幕最终合成画面”，而不是 RiotWindowClass 的 DirectX 窗口表面。
    // 后者在部分显卡/全屏模式下只返回游戏世界，恰好会漏掉强化卡等 HUD 图层。
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 2560, height: 1440 },
      fetchWindowIcons: false
    });
    if (!sources.length) throw new Error('未能获取屏幕画面');
    const gameRect = winRect.getLeagueGameRect();
    let display = null;
    try { display = gameRect ? electronScreen.getDisplayMatching(gameRect) : electronScreen.getPrimaryDisplay(); } catch (e) {}
    const displayId = display ? String(display.id) : '';
    const source = sources.find(x => String(x.display_id || '') === displayId) || sources[0];
    let screenshot = source.thumbnail;
    // 窗口化/无边框但未铺满屏幕时，从目标显示器截图中精确裁出游戏区域。
    if (gameRect && display?.bounds && !screenshot.isEmpty()) {
      const size = screenshot.getSize();
      const sx = size.width / Math.max(1, display.bounds.width);
      const sy = size.height / Math.max(1, display.bounds.height);
      const crop = {
        x: Math.max(0, Math.round((gameRect.x - display.bounds.x) * sx)),
        y: Math.max(0, Math.round((gameRect.y - display.bounds.y) * sy)),
        width: Math.min(size.width, Math.max(1, Math.round(gameRect.width * sx))),
        height: Math.min(size.height, Math.max(1, Math.round(gameRect.height * sy)))
      };
      crop.width = Math.min(crop.width, size.width - crop.x);
      crop.height = Math.min(crop.height, size.height - crop.y);
      if (crop.width > 300 && crop.height > 200) screenshot = screenshot.crop(crop);
    }
    // 高频自动扫描先只检查六条卡框边缘；没有三选一卡片时不加载图标模板，也不启动 OCR。
    const layoutDetected = augmentVision.isLikelyOfferLayout(screenshot);
    if (!layoutDetected) return { source: source.name, width: screenshot.getSize().width, height: screenshot.getSize().height, offers: [], layoutDetected: false };
    const rawCandidates = Array.isArray(candidates) ? candidates : [];
    const iconNames = new Map();
    for (const row of rawCandidates) {
      const icon = String(row?.icon || '').trim().toLowerCase();
      const name = augmentOcrMatch.normalizeOcrText(row?.name);
      if (icon && name) {
        const names = iconNames.get(icon) || new Set();
        names.add(name);
        iconNames.set(icon, names);
      }
    }
    const result = await augmentRecognizer.recognize(screenshot, rawCandidates);
    const looksLikeOfferScreen = layoutDetected || augmentVision.isLikelyOfferScreen(result.offers);
    if (looksLikeOfferScreen) {
      try {
        const names = await recognizeAugmentNamesByOcr(screenshot, candidates);
        // 每个 OCR 成功的卡槽都立即回传。后两轮强化光效较强时，常出现本次只读到
        // 2 张、下一次读到另 1 张；渲染层会在很短的同轮窗口内按 slot 汇总。
        const ocrBySlot = new Map(names.map(item => [Number(item.slot), item]));
        result.offers = result.offers.map((visionOffer, slot) => {
          const item = ocrBySlot.get(slot);
          if (item) return {
            slot,
            id: item.id,
            name: item.name,
            icon: item.icon,
            score: visionOffer?.score || 1,
            margin: 1,
            accepted: true,
            confirmedBy: 'ocr',
            alternatives: []
          };
          const iconUnique = iconNames.get(String(visionOffer?.icon || '').trim().toLowerCase())?.size === 1;
          const safeVisual = augmentRecognizer.isSafeVisualMatch(visionOffer, iconUnique);
          return Object.assign({}, visionOffer, {
            // 同一图标可能对应多个强化名称；重复两帧只能证明图标稳定，不能证明名称正确。
            // 不同资源地址也可能使用高度相似的图形（如溢流/活力再生），因此视觉兜底
            // 还必须同时满足高分和足够大的第一、第二候选差值。
            accepted: safeVisual,
            confirmedBy: 'vision-safe',
            iconUnique
          });
        });
      } catch (ocrError) {
        logErr('[AUGMENT OCR] ' + ocrError.message);
        result.offers.forEach(item => {
          const iconUnique = iconNames.get(String(item?.icon || '').trim().toLowerCase())?.size === 1;
          const safeVisual = augmentRecognizer.isSafeVisualMatch(item, iconUnique);
          item.accepted = safeVisual;
          item.confirmedBy = 'vision-safe';
          item.iconUnique = iconUnique;
        });
      }
    } else {
      result.offers?.forEach(item => { item.accepted = false; });
    }
    return Object.assign({ source: source.name, layoutDetected: true }, result);
  } catch (error) {
    logErr('[AUGMENT VISION] recognize failed: ' + error.message);
    return { __error: error.message };
  }
});

// ---------- 窗口控制 ----------
ipcMain.on('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window:maximize', () => { if (mainWindow) { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); } });
ipcMain.on('window:close', () => { if (mainWindow) mainWindow.close(); });

// ---------- Data Dragon ----------
// 注意: /api/ 路径对国内 IP 返回 403, 数据文件统一走 /cdn/
ipcMain.handle('ddragon:getVersion', async () => resolveVersion());

ipcMain.handle('ddragon:getChampions', async (e, version) => {
  const v = version || await resolveVersion();
  const hit = await gamedata.get('champion.json', v, ver => ddragonRequest(`/cdn/${ver}/data/zh_CN/champion.json`));
  return hit && hit.data && hit.data.data ? { version: hit.version, champions: hit.data.data } : { version: FALLBACK_VERSION, champions: {} };
});

ipcMain.handle('ddragon:getChampionDetail', async (e, version, id) => {
  // id 来自渲染层并直接参与 URL 与文件名, 只接受英雄 key 形态 (字母/数字/点)
  const key = String(id || '').replace(/[^0-9A-Za-z._-]/g, '');
  if (!key) return null;
  const v = version || await resolveVersion();
  const hit = await gamedata.get(`champion/${key}.json`, v, ver => ddragonRequest(`/cdn/${ver}/data/zh_CN/champion/${key}.json`));
  return hit && hit.data && hit.data.data ? hit.data.data[key] || null : null;
});

ipcMain.handle('ddragon:getItems', async (e, version) => {
  const v = version || await resolveVersion();
  const hit = await gamedata.get('item.json', v, ver => ddragonRequest(`/cdn/${ver}/data/zh_CN/item.json`));
  return hit && hit.data ? hit.data : { data: {} };
});

ipcMain.handle('ddragon:getSummonerSpells', async (e, version) => {
  const v = version || await resolveVersion();
  const hit = await gamedata.get('summoner.json', v, ver => ddragonRequest(`/cdn/${ver}/data/zh_CN/summoner.json`));
  return hit && hit.data ? hit.data : { data: {} };
});

// ---------- Riot 远程 API (战绩查询) ----------
ipcMain.handle('riot:getAccount', async (e, region, gameName, tagLine, apiKey) => {
  try {
    return await riotRequest(region, `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`, apiKey);
  } catch (err) { return { __error: err.message }; }
});

ipcMain.handle('riot:getMatchIds', async (e, region, puuid, apiKey) => {
  try {
    return await riotRequest(region, `/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=10`, apiKey);
  } catch (err) { return { __error: err.message }; }
});

ipcMain.handle('riot:getMatch', async (e, region, matchId, apiKey) => {
  try {
    return await riotRequest(region, `/lol/match/v5/matches/${matchId}`, apiKey);
  } catch (err) { return { __error: err.message }; }
});

// ---------- op.gg 英雄强度数据 (KR 服务器, 10分钟缓存) ----------
let opggCache = { t: 0, data: null };
ipcMain.handle('opgg:champions', async () => {
  if (opggCache.data && Date.now() - opggCache.t < 600000) return opggCache.data;
  try {
    const d = await httpGet('lol-api-champion.op.gg', '/api/KR/champions/ranked?tier=all');
    opggCache = { t: Date.now(), data: d };
    return d;
  } catch (err) { return { __error: err.message, data: [] }; }
});

// 海克斯大乱斗：真实英雄维度强化胜率，主进程统一做校验、缓存和失败回退。
ipcMain.handle('hex:championAugments', async (e, championId, scope) => {
  try { return await aramkit.getChampionAugments(championId, USER_DATA, scope); }
  catch (error) {
    logErr('[HEX STATS] champion=' + String(championId) + ' ' + error.message);
    return { __error: true, message: error.message };
  }
});

// ---------- LCU 本地客户端 ----------
// '/lol-lobby-team-builder' 用于取 ARAM 类模式的抽卡池 (subset-champion-list):
// 这些英雄不是"刚被重随进备战席"的, 没有 3 秒冷却, 换过去是瞬时的。
const LCU_PREFIXES = ['/lol-summoner', '/lol-ranked', '/lol-champ-select', '/lol-gameflow',
  '/lol-matchmaking', '/lol-match-history', '/lol-lobby', '/lol-spectator', '/lol-game-data', '/lol-perks',
  '/lol-chat', '/lol-regalia', '/lol-loot', '/lol-event-hub', '/lol-missions', '/lol-challenges', '/lol-game-settings', '/lol-item-sets',
  '/lol-lobby-team-builder'];

let lcuStatusCache = { t: 0, data: null };
let lcuStatusInFlight = null;
function isReadySummoner(summoner) {
  return !!(summoner && typeof summoner === 'object' && !summoner.__error &&
    typeof summoner.puuid === 'string' && summoner.puuid.trim() &&
    (summoner.gameName || summoner.displayName || summoner.name));
}
ipcMain.handle('lcu:status', async () => {
  const now = Date.now();
  if (lcuStatusCache.data && now - lcuStatusCache.t < 1000) return lcuStatusCache.data;
  if (lcuStatusInFlight) return lcuStatusInFlight;
  lcuStatusInFlight = (async () => {
    try {
      let summoner = null;
      // 客户端刚登录/切区时此接口偶尔先返回 200 + 空对象。给 LCU 一个很短的
      // 就绪窗口，避免渲染端把空档案当成“未知玩家”并覆盖正常首页缓存。
      for (let attempt = 0; attempt < 3; attempt++) {
        summoner = await lcu.lcuRequest('GET', '/lol-summoner/v1/current-summoner');
        if (isReadySummoner(summoner)) break;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250));
      }
      lcuWs.connect();
      if (!isReadySummoner(summoner)) {
        return { connected: true, summoner: null, summonerReady: false, error: '客户端玩家档案尚未就绪' };
      }
      return { connected: true, summoner, summonerReady: true };
    } catch (err) { return { connected: false, error: err.message }; }
  })();
  try {
    const data = await lcuStatusInFlight;
    lcuStatusCache = { t: Date.now(), data };
    return data;
  } finally { lcuStatusInFlight = null; }
});

ipcMain.handle('lcu:reset', async () => {
  lcuStatusCache = { t: 0, data: null };
  lcuStatusInFlight = null;
  lcuWs.disconnect();
  lcu.reset();
  return true;
});

ipcMain.handle('lcu:request', async (e, method, urlPath, body) => {
  if (typeof urlPath !== 'string' || !LCU_PREFIXES.some(p => urlPath.startsWith(p))) {
    return { __error: 'LCU 路径不在白名单内' };
  }
  if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) return { __error: '方法不允许' };
  try {
    console.log('[LCU-IPC]', method, urlPath, body ? JSON.stringify(body).substring(0, 300) : '(no body)');
    const result = await lcu.lcuRequest(method, urlPath, body);
    lcuWs.connect();
    return result;
  } catch (err) { return { __error: err.message }; }
});

ipcMain.handle('game-settings:capture-full', async () => {
  try { return gameSettings.capture(await lcu.getGameConfigDir(), USER_DATA); }
  catch (error) { logErr('[GS FULL] capture failed: ' + error.message); return { ok: false, error: error.message }; }
});
ipcMain.handle('game-settings:apply-full', async () => {
  try {
    const result = gameSettings.apply(await lcu.getGameConfigDir(), USER_DATA);
    logErr(`[GS FULL] applied files=${result.fileCount} settings=${result.settingCount} dir=${result.configDir}`);
    return result;
  } catch (error) { logErr('[GS FULL] apply failed: ' + error.message); return { ok: false, error: error.message }; }
});
ipcMain.handle('game-settings:full-status', async () => gameSettings.status(USER_DATA));
ipcMain.handle('game-settings:verify-full', async () => {
  try { return gameSettings.verify(await lcu.getGameConfigDir(), USER_DATA); }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('game-settings:clear-full', async () => {
  try { return gameSettings.clear(USER_DATA); }
  catch (error) { return { ok: false, error: error.message }; }
});

// 渲染层兜底轮询上报的阶段变化 (WS 不可用时快捷键仍能联动)
let lastReportedPhase = null;
let inProgressHotkeysActive = false;
const lastHotkeyDispatchAt = { f6: -Infinity, f7: -Infinity, f8: -Infinity };
const hotkeyPoller = hotkeyPollerFactory.createNativePoller(
  (action) => dispatchInGameHotkey(action, 'win32-poll'),
  logErr
);
ipcMain.on('phase:report', (e, phase) => {
  if (!phase || phase === lastReportedPhase) return;
  lastReportedPhase = phase;
  handlePhaseChange(phase);
});

function dispatchInGameHotkey(action, source) {
  if (!inProgressHotkeysActive) return;
  const now = Date.now();
  if (now - (lastHotkeyDispatchAt[action] || 0) < 250) return;
  lastHotkeyDispatchAt[action] = now;
  if (action === 'f7') {
    logErr('[SHORTCUT] F7 fired source=' + source + ' -> KDABriefing(ally)');
    sendToWindow('shortcut:kda', true);
  } else if (action === 'f8') {
    logErr('[SHORTCUT] F8 fired source=' + source + ' -> KDABriefing(enemy)');
    sendToWindow('shortcut:kda', false);
  } else if (action === 'f6') {
    logErr('[SHORTCUT] F6 fired source=' + source + ' -> AugmentRecognition');
    sendToWindow('shortcut:augment', true);
  }
}

// 主进程阶段联动: Electron 注册为第一通道，Win32 GetAsyncKeyState 为游戏吞键时的第二通道。
function handlePhaseChange(phase) {
  try {
    if (phase !== 'ChampSelect' && overlayWindow && !overlayWindow.isDestroyed()) {
      overlayVisible = false;
      overlayWindow.hide();
    }
    if (phase === 'GameStart' || phase === 'InProgress') ensureAugmentOcrWorker();
    else stopAugmentOcrWorker();
    if (phase === 'InProgress') {
      inProgressHotkeysActive = true;
      const pollStarted = hotkeyPoller.start();
      const ok1 = globalShortcut.isRegistered('F7') || globalShortcut.register('F7', () => dispatchInGameHotkey('f7', 'electron'));
      const ok2 = globalShortcut.isRegistered('F8') || globalShortcut.register('F8', () => dispatchInGameHotkey('f8', 'electron'));
      const ok3 = globalShortcut.isRegistered('F6') || globalShortcut.register('F6', () => dispatchInGameHotkey('f6', 'electron'));
      logErr('[SHORTCUT] register F6=' + ok3 + ' F7=' + ok1 + ' F8=' + ok2 + (ok1 && ok2 && ok3 ? '' : ' (注册失败, Win32轮询仍会接管)'));
      logErr('[HOTKEY POLL] available=' + hotkeyPoller.available + ' running=' + hotkeyPoller.isRunning() + ' started=' + pollStarted);
    } else {
      inProgressHotkeysActive = false;
      hotkeyPoller.stop();
      for (const key of ['F6', 'F7', 'F8']) {
        if (globalShortcut.isRegistered(key)) globalShortcut.unregister(key);
      }
      if (augmentOverlayWindow && !augmentOverlayWindow.isDestroyed()) augmentOverlayWindow.hide();
      logErr('[SHORTCUT] unregistered (left InProgress)');
    }
  } catch (e) { logErr('[SHORTCUT] ' + e.message); }
}

function sendToWindow(channel, data) {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data); } catch (e) {}
}

// ---------- Live Client Data (对局内) ----------
ipcMain.handle('live:gameData', async () => {
  try {
    return await lcu.liveRequest('/liveclientdata/allgamedata');
  } catch (err) { return { __error: err.message }; }
});
ipcMain.handle('live:playerlist', async () => {
  try {
    return await lcu.liveRequest('/liveclientdata/playerlist');
  } catch (err) { return { __error: err.message }; }
});

// ---------- 系统 ----------
ipcMain.handle('system:fixWindow', async () => lcu.fixLCUWindow());

// ---------- 剪贴板写入 (对局内简报复制) ----------
ipcMain.handle('clipboard:write', async (e, text) => {
  try {
    const { clipboard } = require('electron');
    clipboard.writeText(String(text || '').substring(0, 10000));
    return true;
  } catch (err) { return false; }
});

// ---------- 游戏内聊天预填 (Win32 SendInput, 不自动按最终 Enter) ----------
function runGameChatInput(text, activate, submit) {
  const message = String(text || '').trim().substring(0, 1000);
  if (!message) return { ok: false, error: '简报内容为空' };
  const helper = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'main', 'native', 'PoroInput.exe')
    : path.join(__dirname, 'native', 'PoroInput.exe');
  if (!fs.existsSync(helper)) return { ok: false, error: '游戏输入组件缺失' };
  return new Promise(resolve => {
    execFile(helper, [Buffer.from(message, 'utf8').toString('base64'), activate ? '1' : '0', submit ? '1' : '0'], {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 16 * 1024,
      encoding: 'buffer'
    }, (error, stdout, stderr) => {
      const decode = value => {
        if (!Buffer.isBuffer(value)) return String(value || '');
        try { return new TextDecoder('utf-8', { fatal: true }).decode(value); }
        catch (e) { try { return new TextDecoder('gbk').decode(value); } catch (e2) { return value.toString('utf8'); } }
      };
      const output = decode(stdout).trim();
      if (!error && output === 'OK') return resolve({ ok: true, via: submit ? 'native-send' : 'native-input' });
      const detail = (decode(stderr) || error?.message || '输入失败').trim().substring(0, 240);
      logErr('[GAME INPUT] ' + detail);
      resolve({ ok: false, error: detail });
    });
  });
}

ipcMain.handle('game:prefillChat', async (e, text, activate) => {
  return runGameChatInput(text, activate, false);
});

ipcMain.handle('game:sendChat', async (e, text, activate) => {
  return runGameChatInput(text, activate, true);
});

// ---------- 系统通知 (游戏中主窗口不可见时的反馈) ----------
ipcMain.on('app:notify', (e, payload) => {
  try {
    const { Notification } = require('electron');
    const title = String(payload?.title || 'Poro').substring(0, 80);
    const body = String(payload?.body || '').substring(0, 220);
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch (e) {}
});

// 渲染层诊断日志 (写 crash.log)
ipcMain.on('app:debugLog', (e, msg) => logErr('[RENDERER] ' + String(msg || '').substring(0, 1000)));

ipcMain.handle('diag:recentLogs', async () => {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const stat = fs.statSync(LOG_FILE);
    const start = Math.max(0, stat.size - 64 * 1024);
    const fd = fs.openSync(LOG_FILE, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    const home = app.getPath('home').replace(/\\/g, '/');
    return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-60).map(line => line
      .replace(/\\/g, '/')
      .replaceAll(home, '<USER>')
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/ig, '<UUID>')
      .replace(/\b[A-Za-z0-9_-]{50,100}\b/g, '<ID>'));
  } catch (error) { return ['读取诊断日志失败: ' + error.message]; }
});

// ---------- SGP 服务器网关 (完整战绩) ----------
// 战绩分页缓存: 同一 puuid 的分页结果短时复用, 避免"点别人→返回→再点"重复走网络
const _sgpCache = new Map();
const SGP_CACHE_TTL = 5 * 60 * 1000;   // 战绩是历史数据, 5 分钟内重拉毫无意义; 原先 60s 是"回到我的"点击变慢的主因
const SGP_CACHE_MAX = 240;
function _sgpInvalidateMatchHistory(puuid) {
  const target = String(puuid || '').trim();
  let removed = 0;
  for (const key of _sgpCache.keys()) {
    const parts = key.split('|');
    if (!target || parts[1] === target) {
      _sgpCache.delete(key);
      removed++;
    }
  }
  return removed;
}
function _sgpPrune() {
  const now = Date.now();
  for (const [k, v] of _sgpCache) if (now - v.t >= SGP_CACHE_TTL) _sgpCache.delete(k);
  if (_sgpCache.size > SGP_CACHE_MAX) {
    let cut = _sgpCache.size - SGP_CACHE_MAX;
    for (const k of _sgpCache.keys()) { if (cut-- <= 0) break; _sgpCache.delete(k); }
  }
}
ipcMain.handle('sgp:matchHistory', async (e, platformId, puuid, startIndex, count, tag) => {
  if (!sgp.SGP_HOSTS[platformId]) return { __error: '不支持的大区: ' + platformId };
  const key = `${platformId}|${puuid}|${startIndex}|${count}|${tag || ''}`;
  const hit = _sgpCache.get(key);
  if (hit && Date.now() - hit.t < SGP_CACHE_TTL) return hit.data;
  try {
    const data = await sgp.matchHistory(platformId, puuid, startIndex, count, tag);
    if (!data.__error) { _sgpCache.set(key, { t: Date.now(), data }); _sgpPrune(); }
    return data;
  } catch (err) { return { __error: err.message }; }
});

// 对局结算后，新战绩通常需要几秒才写入 SGP。渲染层会短间隔重试；每次重试前
// 必须主动清掉该玩家的分页缓存，否则即使服务器已经入库仍会继续看到最多 5 分钟旧数据。
ipcMain.handle('sgp:invalidateMatchHistory', (e, puuid) => ({
  ok: true,
  removed: _sgpInvalidateMatchHistory(puuid)
}));

ipcMain.handle('sgp:summonerByPuuid', async (e, platformId, puuid) => {
  if (!sgp.SGP_HOSTS[platformId]) return { __error: '不支持的大区: ' + platformId };
  try {
    return await sgp.summonerByPuuid(platformId, puuid);
  } catch (err) { return { __error: err.message }; }
});

ipcMain.handle('sgp:gameSummary', async (e, platformId, gameId) => {
  if (!sgp.SGP_HOSTS[platformId]) return { __error: '不支持的大区: ' + platformId };
  try {
    return await sgp.gameSummary(platformId, gameId);
  } catch (err) { return { __error: err.message }; }
});

ipcMain.handle('sgp:gameDetails', async (e, platformId, gameId) => {
  if (!sgp.SGP_HOSTS[platformId]) return { __error: '不支持的大区: ' + platformId };
  try {
    return await sgp.gameDetails(platformId, gameId);
  } catch (err) { return { __error: err.message }; }
});

// ---------- 文件读写 (持久化配置, 白名单: 仅 userData 目录) ----------
const ALLOWED_USER_DATA_FILES = new Set(['poro-config.json', 'jade-calib.json', 'hexdata.json', 'gs_lock.json', 'home-cache-0.json', 'home-cache-1.json']);
function isPathAllowed(p) {
  try {
    const resolved = path.resolve(p);
    const relative = path.relative(USER_DATA, resolved);
    return !path.isAbsolute(relative) && !relative.includes(path.sep) && ALLOWED_USER_DATA_FILES.has(relative);
  } catch (e) { return false; }
}

ipcMain.handle('fs:readFile', async (e, filePath) => {
  if (!isPathAllowed(filePath)) return null;
  try {
    if (fs.statSync(filePath).size > MAX_USER_FILE_BYTES) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) { return null; }
});

ipcMain.handle('fs:writeFile', async (e, filePath, content) => {
  if (!isPathAllowed(filePath)) return false;
  try {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_USER_FILE_BYTES) return false;
    if (!fs.existsSync(USER_DATA)) fs.mkdirSync(USER_DATA, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  } catch (err) { return false; }
});

ipcMain.handle('app:userData', async () => USER_DATA);

// 应用版本: 优先读包内 package.json (asar 内的才是真正部署的版本),
// 拿不到再退回 app.getVersion()。渲染层绝不要再硬编码版本号。
ipcMain.handle('app:version', async () => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
    if (pkg && pkg.version) return String(pkg.version);
  } catch (e) {}
  try { return String(app.getVersion()); } catch (e) { return 'unknown'; }
});

// ---------- 主进程设置 (托盘/自启) ----------
let mainSettings = { autoLaunch: false };
try {
  const s = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'settings.json'), 'utf8'));
  Object.assign(mainSettings, s);
} catch (e) {}
function saveMainSettings() {
  try { fs.writeFileSync(path.join(USER_DATA, 'settings.json'), JSON.stringify(mainSettings, null, 2)); } catch (e) {}
}

ipcMain.handle('settings:get', async () => {
  mainSettings.autoLaunch = app.getLoginItemSettings().openAtLogin;
  return mainSettings;
});

ipcMain.handle('settings:autoLaunch', async (e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath });
  mainSettings.autoLaunch = !!on;
  saveMainSettings();
  return true;
});

const AI_CONFIG_FILE = path.join(USER_DATA, 'ai.json');

function resolveAiConfig(rawConfig) {
  const cfg = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  let apiKey = '';
  if (cfg.apiKeyEncrypted) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用');
    apiKey = safeStorage.decryptString(Buffer.from(cfg.apiKeyEncrypted, 'base64'));
  } else if (typeof cfg.apiKey === 'string') {
    // 兼容旧版明文配置；读取成功后立即迁移为 Windows 加密存储。
    apiKey = cfg.apiKey;
    if (apiKey && safeStorage.isEncryptionAvailable()) {
      const migrated = {
        baseUrl: String(cfg.baseUrl || ''),
        model: String(cfg.model || 'glm-4-flash'),
        apiKeyEncrypted: safeStorage.encryptString(apiKey).toString('base64')
      };
      fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify(migrated, null, 2), 'utf8');
    }
  }
  return { baseUrl: String(cfg.baseUrl || ''), model: String(cfg.model || 'glm-4-flash'), apiKey };
}

function readAiConfig() {
  const raw = JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8'));
  return resolveAiConfig(raw);
}

ipcMain.handle('ai:getConfig', async () => {
  try {
    const cfg = readAiConfig();
    return { baseUrl: cfg.baseUrl, model: cfg.model, hasApiKey: !!cfg.apiKey };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { baseUrl: '', model: 'glm-4-flash', hasApiKey: false };
    return { __error: err.message };
  }
});

ipcMain.handle('ai:saveConfig', async (e, input) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return { __error: '系统安全存储不可用，未保存 API Key' };
    const baseUrl = String(input?.baseUrl || '').trim();
    const model = String(input?.model || 'glm-4-flash').trim() || 'glm-4-flash';
    let apiKey = String(input?.apiKey || '').trim();
    if (!apiKey) {
      try { apiKey = readAiConfig().apiKey; } catch (err) {}
    }
    if (!baseUrl || !apiKey) return { __error: '请填写接口地址和 API Key' };
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:') return { __error: 'AI 接口必须使用 HTTPS' };
    const stored = {
      baseUrl,
      model,
      apiKeyEncrypted: safeStorage.encryptString(apiKey).toString('base64')
    };
    fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify(stored, null, 2), 'utf8');
    return { ok: true, baseUrl, model, hasApiKey: true };
  } catch (err) { return { __error: err.message }; }
});

// OpenAI 兼容地址补全: 域名/带版本前缀均可, 自动补 /chat/completions
function resolveChatUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error('接口地址无效: ' + raw); }
  if (u.protocol !== 'https:') throw new Error('AI 接口必须使用 HTTPS');
  let path = u.pathname.replace(/\/+$/, '') || '';
  if (!/chat\/completions$/i.test(path)) {
    if (/\/v\d+[a-z]*$/i.test(path)) path += '/chat/completions';
    else path += '/v1/chat/completions';
  }
  return { hostname: u.hostname, port: u.port || 443, path: path + (u.search || '') };
}

// ---------- AI 复盘 (OpenAI 兼容接口) ----------
ipcMain.handle('ai:chat', async (e, messages) => {
  try {
    const cfg = readAiConfig();
    if (!cfg.apiKey || !cfg.baseUrl) return { __error: '未配置 AI 接口 (工具箱 → AI 复盘设置)' };
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 20) return { __error: 'AI 消息格式无效' };
    let totalChars = 0;
    const safeMessages = messages.map(message => {
      const role = ['system', 'user', 'assistant'].includes(message?.role) ? message.role : 'user';
      const content = String(message?.content || '').substring(0, 100000);
      totalChars += content.length;
      return { role, content };
    });
    if (totalChars > 200000) return { __error: 'AI 请求内容过大' };
    const target = resolveChatUrl(cfg.baseUrl);
    const body = JSON.stringify({ model: cfg.model || 'glm-4-flash', messages: safeMessages, temperature: 0.5 });
    const resp = await httpsPost(target.hostname, target.port, target.path, {
      'Authorization': 'Bearer ' + cfg.apiKey
    }, body, 90000);
    if (resp.error) return { __error: resp.error.message || JSON.stringify(resp.error) };
    return resp;
  } catch (err) { return { __error: err.message }; }
});

// ---------- 托盘常驻 ----------
let tray = null;
function createTray() {
  const { Tray: TrayCls, nativeImage } = require('electron');
  const iconPath = APP_ICON_PNG;
  let img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new TrayCls(img.resize({ width: 16, height: 16 }));
  tray.setToolTip('Poro');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: 'KDA简报·发送己方', click: () => { logErr('[TRAY] KDA ally clicked'); sendToWindow('shortcut:kda', true); } },
    { label: 'KDA简报·发送敌方', click: () => { logErr('[TRAY] KDA enemy clicked'); sendToWindow('shortcut:kda', false); } },
    { label: '开机自启', type: 'checkbox', checked: mainSettings.autoLaunch, click: (mi) => { app.setLoginItemSettings({ openAtLogin: mi.checked, path: process.execPath }); mainSettings.autoLaunch = mi.checked; saveMainSettings(); } },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

if (hasSingleInstanceLock) {
  app.whenReady().then(() => {
    createWindow();
    // 托盘不是主窗口启动的必要条件；个别系统若托盘图标初始化失败，不应拖垮整个程序。
    try { createTray(); } catch (error) { logErr('[TRAY INIT FAILED] ' + formatError(error)); }
    lcuWs.attach(mainWindow);
    lcuWs.setPhaseHandler(handlePhaseChange);
    // 冒烟测试钩子: PORO_SMOKE=1 时自动退出
    if (process.env.PORO_SMOKE) setTimeout(() => app.quit(), 5000);
  }).catch(error => reportFatal('初始化失败', error));
}
app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => {
  // 只有页面确实加载成功才清理标记；启动中途退出会在下次自动启用软件渲染。
  if (startupComplete) { try { fs.unlinkSync(STARTUP_MARKER); } catch (e) {} }
  try { globalShortcut.unregisterAll(); } catch (e) {}
  try { hotkeyPoller.stop(); } catch (e) {}
  try { stopAugmentOcrWorker(); } catch (e) {}
});
app.on('activate', () => { if (mainWindow) mainWindow.show(); });
