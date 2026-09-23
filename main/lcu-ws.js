// LCU WebSocket 事件订阅模块
// 通过 wss 订阅客户端事件 (gameflow 阶段/选人/readyCheck), 推送给渲染层
// 替代高频轮询: 自动接受/自动BP/阶段感知全部由事件驱动, 轮询仅作兜底
// ws 模块容错: 打包遗漏时退化为纯轮询, 不阻塞主进程启动
let WebSocket = null;
try { WebSocket = require('ws'); } catch (e) {
  console.error('[lcu-ws] ws 模块缺失, WebSocket 事件功能停用 (轮询兜底)');
}
const lcu = require('./lcu');

let ws = null;
let retryTimer = null;
let consecutiveFailures = 0;
let mainWindow = null;
let lastPhase = null;
let phaseHandler = null;

// 主进程侧阶段联动 (全局快捷键)
function setPhaseHandler(fn) { phaseHandler = fn; }

// 只转发渲染层关心的端点, 降低 IPC 噪音
const FORWARD_URIS = [
  '/lol-gameflow/v1/gameflow-phase',
  '/lol-champ-select/v1/session',
  // 服务器权威的"你现在可以选哪些英雄"列表, 备战区助手用它做门禁
  '/lol-champ-select/v1/pickable-champion-ids',
  // ARAM 类模式的抽卡池: 这些英雄没有备战席 3 秒冷却。
  // 注意: 真机上 lol-lobby-team-builder 插件在 champ-select 上只注册了【节点级】事件
  // (GET /help 的 events 里只有 OnJsonApiEvent_lol-lobby-team-builder_champ-select_v1,
  //  没有 ..._subset-champion-list 叶子事件), 所以下面那行叶子 URI 基本不会命中。
  // 真正会到的是下一行的节点 URI —— 渲染层收到它必须主动重拉抽卡池, 不能指望 payload 带子资源。
  '/lol-lobby-team-builder/champ-select/v1/subset-champion-list',
  '/lol-lobby-team-builder/champ-select/v1',
  '/lol-matchmaking/v1/ready-check',
  '/lol-lobby/v2/lobby',
  '/lol-end-of-game/v1/eog-stats-block',
  '/lol-summoner/v1/current-summoner'
];

function attach(win) { mainWindow = win; }

function sendToRenderer(channel, data) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
  } catch (e) {}
}

function scheduleRetry(ms) {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, ms);
}

// 连接条件: 已有缓存的 LCU 连接凭证 (由 REST 成功后写入)
// 客户端未运行时静默等待, 下一次 REST 成功会再次调用 connect()
function connect() {
  if (!WebSocket) return;
  if (ws) return;
  const conn = lcu.getCached();
  if (!conn) return;
  let opened = false;
  try {
    ws = new WebSocket('wss://127.0.0.1:' + conn.port, {
      rejectUnauthorized: false,
      headers: { Authorization: 'Basic ' + Buffer.from('riot:' + conn.token).toString('base64') }
    });
  } catch (e) { ws = null; scheduleRetry(10000); return; }

  ws.on('open', () => {
    opened = true;
    consecutiveFailures = 0;
    try { ws.send(JSON.stringify([5, 'OnJsonApiEvent'])); } catch (e) {}
    sendToRenderer('lcu:wsState', { connected: true });
  });

  ws.on('message', (buf) => {
    try {
      const msg = JSON.parse(buf.toString('utf8'));
      if (!Array.isArray(msg) || msg[0] !== 8 || !msg[2]) return;
      const payload = msg[2];
      const uri = payload.uri || '';
      if (!FORWARD_URIS.some(u => uri.startsWith(u))) return;
      // gameflow 阶段去重: 阶段未变化不重复广播
      if (uri === '/lol-gameflow/v1/gameflow-phase') {
        if (payload.data === lastPhase) return;
        lastPhase = payload.data;
        if (phaseHandler) { try { phaseHandler(payload.data); } catch (e) {} }
      }
      // eventType 一并转发: 列表类端点被清空时是 'Delete', 渲染层需要据此把本地缓存归零
      sendToRenderer('lcu:event', { uri, data: payload.data, eventType: payload.eventType });
    } catch (e) {}
  });

  const onFail = () => {
    if (!ws) return;
    try { ws.removeAllListeners(); ws.close(); } catch (e) {}
    ws = null;
    sendToRenderer('lcu:wsState', { connected: false });
    if (opened) {
      // 连上后断开: 客户端重启或网络抖动, 快速重试
      scheduleRetry(3000);
    } else {
      consecutiveFailures++;
      // 反复握手失败 -> 凭证过期, 清缓存让下次 REST 探测刷新
      if (consecutiveFailures >= 2) { lcu.reset(); lastPhase = null; consecutiveFailures = 0; return; }
      scheduleRetry(5000);
    }
  };
  ws.on('error', onFail);
  ws.on('close', onFail);
}

function disconnect() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  lastPhase = null;
  if (ws) {
    try { ws.removeAllListeners(); ws.close(); } catch (e) {}
    ws = null;
  }
  sendToRenderer('lcu:wsState', { connected: false });
}

module.exports = { attach, connect, disconnect, setPhaseHandler };
