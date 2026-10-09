// 对局结束自动化: 返回房间 / 自动排队 (参考 Sona, 开黑车队保留场景)
// 状态机: EndOfGame/WaitingForStats 触发 → 等 gameflow 回到 None/EndOfGame 完成 →
//   模式 A "返回房间": 创建同队列房间, 车队成员需重新邀请 (LCU 无法自动重建车队)
//   模式 B "返回房间并排队": 建房后直接发起匹配
// 全程守卫 complianceOn; 单次对局只执行一轮, 失败重试上限 3 次。
let _autoReturn = { enabled: false, autoQueue: false, running: false, attempt: 0, lastQueueId: null };
let _autoReturnSeenEnd = false;

function autoReturnLoad() {
  try {
    _autoReturn.enabled = storeGet('autoReturnLobby') === '1';
    _autoReturn.autoQueue = storeGet('autoReturnQueue') === '1';
  } catch (e) {}
  initAutoReturnToggles();
}
// 恢复工具箱开关 UI 状态
function initAutoReturnToggles() {
  const lobby = document.getElementById('autoReturnLobbyToggle');
  const queue = document.getElementById('autoReturnQueueToggle');
  const row = document.getElementById('autoReturnQueueRow');
  if (lobby) lobby.checked = _autoReturn.enabled;
  if (queue) queue.checked = _autoReturn.autoQueue;
  if (row) row.style.display = _autoReturn.enabled ? '' : 'none';
}
function toggleAutoReturnLobby(on) {
  _autoReturn.enabled = !!on;
  storeSet('autoReturnLobby', on ? '1' : '');
  const q = document.getElementById('autoReturnQueueRow');
  if (q) q.style.display = on ? '' : 'none';
  toolMsg(on ? '对局结束后将自动返回房间' : '已关闭自动返回房间');
}
function toggleAutoReturnQueue(on) {
  _autoReturn.autoQueue = !!on;
  storeSet('autoReturnQueue', on ? '1' : '');
}

async function autoReturnCreateRoom(queueId) {
  const map = QUEUE_MODE_MAP[queueId] || QUEUE_MODE_MAP[430];
  const r = await lolAPI.lcuRequest('POST', '/lol-lobby/v2/lobby', {
    queueId: queueId, lobbyChange: { gameMode: map.gameMode, mapId: map.mapId }
  });
  if (r && r.__error) throw new Error(r.message || r.__error);
  return true;
}

async function autoReturnStartQueue() {
  const r = await lolAPI.lcuRequest('POST', '/lol-lobby/v2/lobby/matchmaking/search');
  if (r && r.__error) throw new Error(r.message || r.__error);
  return true;
}

async function autoReturnRun() {
  if (_autoReturn.running) return;
  _autoReturn.running = true;
  _autoReturn.attempt = 0;
  try {
    // 等客户端离开结算界面 (EndOfGame → None), 最多 40s
    let settled = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const phase = window._gameflowPhase;
      if (phase === 'None' || phase === 'Lobby') { settled = true; break; }
      if (['ChampSelect', 'GameStart', 'InProgress'].includes(phase)) { _autoReturn.running = false; return; } // 已在下一局
    }
    if (!settled) { showToast('自动返回房间: 客户端未退出结算界面', 'negative'); return; }
    const queueId = _autoReturn.lastQueueId || 430;
    while (_autoReturn.attempt < 3) {
      _autoReturn.attempt++;
      try {
        await autoReturnCreateRoom(queueId);
        showToast('已自动返回房间 (' + (QUEUE_NAMES[queueId] || queueId) + ')', 'positive');
        if (_autoReturn.autoQueue) {
          await new Promise(r => setTimeout(r, 1200));
          await autoReturnStartQueue();
          showToast('已自动开始排队', 'positive');
        }
        return;
      } catch (e) {
        try { lolAPI.debugLog('[AUTO-RETURN] attempt ' + _autoReturn.attempt + ' failed: ' + e.message); } catch (e2) {}
        await new Promise(r => setTimeout(r, 2500));
      }
    }
    showToast('自动返回房间失败 (重试 3 次)', 'negative');
  } finally {
    _autoReturn.running = false;
  }
}

// 挂接点: handleGameflowPhase 的 EndOfGame 分支调用
function autoReturnMaybeTrigger(phase) {
  if (phase === 'None' || phase === 'Lobby') {
    // 对局流程结束, 记住本局队列由 lobby 接口在进入时刷新
    return;
  }
  if (phase === 'ChampSelect') {
    // 选人时记录本局队列, 供结算后建房用
    try {
      lolAPI.lcuRequest('GET', '/lol-gameflow/v1/session').then(gs => {
        const qid = gs?.gameData?.queue?.id;
        if (qid) _autoReturn.lastQueueId = qid;
      }).catch(() => {});
    } catch (e) {}
    return;
  }
  if ((phase === 'EndOfGame' || phase === 'WaitingForStats') && !_autoReturnSeenEnd) {
    _autoReturnSeenEnd = true;
    if (_autoReturn.enabled && !complianceOn) autoReturnRun();
  }
  if (phase === 'ChampSelect' || phase === 'GameStart') _autoReturnSeenEnd = false;
}
