// LCU WebSocket 事件驱动
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== LCU WebSocket 事件驱动 (轮询仅作兜底) ==========
async function reconnectLcu() {
  await lolAPI.lcuReconnect();
  document.getElementById("lcuStatusText").textContent = "重新检测中...";
}
let _lastAutoBPTs = 0;
let _readyCheckAccepting = false;
let _autoLiveSwitched = false;   // 每次对局仅自动跳一次实时页, 避免反复抢焦点
let _lastGameflowPhase = '';
let _postGameRefreshRun = 0;
let _postGameRefreshActive = false;

function newestHomeGameId() {
  return String(homeGamesData?.[0]?.gid || '');
}

function waitPostGameRefresh(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 结算写入不是原子的：客户端先进入 WaitingForStats/EndOfGame，SGP/LCU 往往数秒后
// 才能查到新 gameId。不能只刷新一次，也不能继续命中首页 3 分钟和 SGP 5 分钟缓存。
async function refreshAfterGameEnd(reason) {
  if (_postGameRefreshActive || profileOverride) {
    window._homeCacheNeedRefresh = true;
    return;
  }
  _postGameRefreshActive = true;
  const run = ++_postGameRefreshRun;
  const baselineGameId = newestHomeGameId();
  const delays = [400, 1600, 3000, 5000, 8000, 12000, 18000];
  try {
    for (const delay of delays) {
      await waitPostGameRefresh(delay);
      if (run !== _postGameRefreshRun) return;
      // 新一局已经开始时停止后台结算刷新，避免与实时页取数争用。
      if (['ChampSelect', 'GameStart', 'InProgress'].includes(window._gameflowPhase)) return;
      if (homeStatsLoading) continue;
      const puuid = window._myPuuid || cachedSummoner?.puuid || '';
      try {
        if (lolAPI.sgpInvalidateMatchHistory) await lolAPI.sgpInvalidateMatchHistory(puuid);
      } catch (e) {}
      homeStatsLoaded = false;
      await loadHomeStats(true, { skipCache: true });
      const latestGameId = newestHomeGameId();
      if (latestGameId && (!baselineGameId || latestGameId !== baselineGameId)) {
        window._homeCacheNeedRefresh = false;
        try { lolAPI.debugLog(`[HOME] post-game refresh ready reason=${reason} gameId=${latestGameId}`); } catch (e) {}
        return;
      }
    }
    // 极端情况下服务器一分钟后仍未入库，保留补刷标记让常规轮询继续处理。
    window._homeCacheNeedRefresh = true;
    try { lolAPI.debugLog(`[HOME] post-game refresh pending reason=${reason}`); } catch (e) {}
  } finally {
    if (run === _postGameRefreshRun) _postGameRefreshActive = false;
  }
}

function handleGameflowPhase(phase) {
  const previousPhase = _lastGameflowPhase;
  const sessionTransition = window.poroSession?.transition(phase) || {};
  const enteringChampSelect = sessionTransition.entering ?? (phase === 'ChampSelect' && previousPhase !== 'ChampSelect');
  _lastGameflowPhase = phase;
  window._gameflowPhase = phase;
  lolAPI.reportPhase && lolAPI.reportPhase(phase);
  syncAugmentRecognitionForPhase(phase);
  // 阶段到达 ReadyCheck (匹配确认弹窗出现) 即刻接受: 最可靠触发通道, 不依赖 GET ready-check 的具体字段
  if (phase === 'ReadyCheck' && autoAcceptOn && !complianceOn) {
    console.log('[auto-accept] phase=ReadyCheck → 立即接受');
    acceptReadyCheckNow();
  }
  const activePage = document.querySelector(".page.active")?.id;
  if (enteringChampSelect) {
    // 新选人房间开始：立即废弃上一局阵容和所有尚未完成的异步回填。
    champSelectParticipants = null;
    livePlayersCache.key = '';
    livePlayersCache.data = null;
    liveRenderToken++;
    _encounterTrackedFor = '';
    _currentGameKey = '';
    const liveBody = document.getElementById('liveGameArea');
    if (liveBody) liveBody.innerHTML = '<div class="meta-loading">正在读取本局选人阵容...</div>';
  }
  // 进入对局流程 (选人/加载/进行中) 自动跳一次"实时对局"页并刷新:
  // 选人阶段即可看队友近期战绩 (gameflow session 带完整 puuid), 加载页用 session 数据, 对局中由 Live Client Data 提供完整双方 (含海斗)
  if (phase === "ChampSelect" || phase === "GameStart" || phase === "InProgress") {
    if (!_autoLiveSwitched) {
      _autoLiveSwitched = true;
      if (activePage !== "page-live") switchPage("live");
    }
    updateLivePage(phase);
    if (phase !== 'ChampSelect' && phase !== previousPhase) updateHexRecommendationContext(null, true);
  } else if (activePage === "page-live") {
    updateLivePage(phase);
  }
  // 离开对局后重置"已跳转"标记, 下一局重新自动跳
  if (phase !== "ChampSelect" && phase !== "GameStart" && phase !== "InProgress") _autoLiveSwitched = false;
  if (phase !== "ChampSelect") _benchAlertReset();   // 离开选人即清掉备战区倒计时浮层
  // GameStart/加载页/对局内仍需展示本局已选英雄的强化排序。只有真正离开本局流程才清空。
  if (!["ChampSelect", "GameStart", "InProgress"].includes(phase)) resetHexRecommendationContext();
  if (["ChampSelect", "GameStart", "InProgress"].includes(phase)) {
    const lockOn = document.getElementById("gsLockToggle")?.checked;
    if (!complianceOn && lockOn && gsAppliedPhase !== phase) applyLockedGameSettings(phase);
  } else {
    if (phase !== 'GameStart') {
      champSelectParticipants = null;
      livePlayersCache.key = '';
      livePlayersCache.data = null;
      liveRenderToken++;
    }
    if (gsAppliedPhase) {
      gsAppliedPhase = null;
      _autoRuneAppliedFor = 0;
      _encounterTrackedFor = '';
      _currentGameKey = '';
    }
    _premadeNotifiedFor = '';
    _gameChatCid = null;
    _champSelectChatCid = null;
    resetChampSelectSideAnnouncement();
    // 离开选人后恢复卡片状态文字
    const psEl = document.getElementById('premadeNotifyState');
    if (psEl && premadeNotifyOn && psEl.textContent !== '已开启') psEl.textContent = '已开启';
  }
  if (phase === "EndOfGame" || phase === "WaitingForStats") {
    homeStatsLoaded = false;
    window._homeCacheNeedRefresh = true;
    // 只在首次进入结算阶段启动一条重试链；轮询反复读到同一 phase 不会并发刷新。
    if (phase !== previousPhase) refreshAfterGameEnd('phase:' + phase);
  }
}
