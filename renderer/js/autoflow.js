// 对局流程自动化: 结算后自动点赞 / 掉线后自动重连
// 与「对局结束自动化」(autoreturn.js) 同一套约定: 默认关闭、合规模式下停用、单次只跑一轮、失败有上限。
//
// 自动点赞: 对局结束的阶段顺序是 WaitingForStats → PreEndOfGame → EndOfGame, 点赞选票在 PreEndOfGame 才生成,
//   所以在 PreEndOfGame 进入时开始 (EndOfGame 再兜底一次), 不在 WaitingForStats 提前消耗重试次数。
//   从本局真人队友 (不含自己、不含人机、不含对手) 中随机选 1 人、随机选一种称赞。
//   点赞发生在返回房间之前 (自动返回房间要等阶段回到 None), 两者不会互相抢。
// 掉线重连: 阶段变为 Reconnect (客户端出现「重新连接」) 时调用 gameflow 的重连接口。

const AUTO_HONOR_CATEGORIES = ['COOL', 'SHOTCALLER', 'HEART'];
const AUTO_HONOR_PHASES = ['PreEndOfGame', 'EndOfGame'];
const AUTO_HONOR_ATTEMPTS = 4;
const AUTO_RECONNECT_ATTEMPTS = 4;
const AUTOFLOW_MEMORY_MAX = 30;

let autoflow = { honor: false, reconnect: false };
let _autoHonorRunning = false;
const _autoHonorSeenPhases = new Set();      // 本局已经触发过的阶段, 同一阶段不重复触发
const _autoHonoredGames = new Set();        // 已处理过的 gameId, 避免同一局重复点赞
let _autoReconnectRunning = false;
let _autoReconnectSeen = false;

function autoflowSleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function autoflowLoad() {
  try {
    autoflow.honor = storeGet('autoHonor') === '1';
    autoflow.reconnect = storeGet('autoReconnect') === '1';
  } catch (e) {}
  initAutoflowToggles();
}
function initAutoflowToggles() {
  const h = document.getElementById('autoHonorToggle');
  const r = document.getElementById('autoReconnectToggle');
  if (h) h.checked = !!autoflow.honor;
  if (r) r.checked = !!autoflow.reconnect;
  if (typeof applyComplianceState === 'function') applyComplianceState();
}
function toggleAutoHonor(on) {
  if (on && !guardAutomation('自动点赞')) { document.getElementById('autoHonorToggle').checked = false; return; }
  autoflow.honor = !!on;
  storeSet('autoHonor', on ? '1' : '');
  toolMsg(on ? '对局结束后将自动给一名队友点赞' : '已关闭自动点赞');
}
function toggleAutoReconnect(on) {
  if (on && !guardAutomation('掉线重连')) { document.getElementById('autoReconnectToggle').checked = false; return; }
  autoflow.reconnect = !!on;
  storeSet('autoReconnect', on ? '1' : '');
  toolMsg(on ? '掉线后将自动重连' : '已关闭掉线重连');
}

// 从点赞选票里挑一个人: 真人队友, 排除自己和人机。选票里的字段名以 LCU 接口定义为准 (puuid / summonerId / botPlayer)
function pickHonorTarget(ballot, myPuuid, rand) {
  const r = typeof rand === 'function' ? rand : Math.random;
  const allies = (Array.isArray(ballot && ballot.eligibleAllies) ? ballot.eligibleAllies : [])
    .filter(p => p && !p.botPlayer && p.puuid && p.puuid !== myPuuid);
  if (!allies.length) return null;
  const player = allies[Math.min(allies.length - 1, Math.floor(r() * allies.length))];
  const category = AUTO_HONOR_CATEGORIES[Math.min(AUTO_HONOR_CATEGORIES.length - 1, Math.floor(r() * AUTO_HONOR_CATEGORIES.length))];
  return { player, category };
}

function rememberHonoredGame(gameId) {
  _autoHonoredGames.add(String(gameId));
  while (_autoHonoredGames.size > AUTOFLOW_MEMORY_MAX) _autoHonoredGames.delete(_autoHonoredGames.values().next().value);
}

async function autoHonorRun() {
  if (_autoHonorRunning) return;
  _autoHonorRunning = true;
  try {
    await autoflowSleep(1500 + Math.floor(Math.random() * 2500));      // 不要比人手还快
    for (let attempt = 0; attempt < AUTO_HONOR_ATTEMPTS; attempt++) {
      if (!autoflow.honor || complianceOn) return;
      const ballot = await lolAPI.lcuRequest('GET', '/lol-honor-v2/v1/ballot');
      if (!ballot || ballot.__error || !ballot.gameId) { await autoflowSleep(2500); continue; }   // 点赞界面还没出现
      if (_autoHonoredGames.has(String(ballot.gameId))) return;
      if ((ballot.honoredPlayers || []).length) { rememberHonoredGame(ballot.gameId); return; }   // 已经点过 (手动)
      if (ballot.votePool && Number(ballot.votePool.votes) === 0) { rememberHonoredGame(ballot.gameId); return; }   // 没有可用票数
      const pick = pickHonorTarget(ballot, window._myPuuid);
      if (!pick) { rememberHonoredGame(ballot.gameId); return; }
      // 请求体同时带 honorCategory 与 honorType (取值相同): LCU 接口定义里叫 honorType,
      // 同类项目 LeagueAkari 实际发的是 honorCategory, 无法在真实客户端上确认哪个生效, 两个都带。
      const res = await lolAPI.lcuRequest('POST', '/lol-honor-v2/v1/honor-player', {
        gameId: ballot.gameId, honorCategory: pick.category, honorType: pick.category,
        puuid: pick.player.puuid, summonerId: pick.player.summonerId
      });
      if (res && res.__error) {
        try { lolAPI.debugLog?.('[AUTO-HONOR] attempt ' + (attempt + 1) + ' failed: ' + res.__error); } catch (e) {}
        await autoflowSleep(2500);
        continue;
      }
      rememberHonoredGame(ballot.gameId);
      showToast('已自动给队友点赞: ' + (pick.player.summonerName || '队友'), 'positive');
      return;
    }
  } finally {
    _autoHonorRunning = false;
  }
}

async function autoReconnectRun() {
  if (_autoReconnectRunning) return;
  _autoReconnectRunning = true;
  try {
    await autoflowSleep(1500 + Math.floor(Math.random() * 1500));
    for (let attempt = 0; attempt < AUTO_RECONNECT_ATTEMPTS; attempt++) {
      if (!autoflow.reconnect || complianceOn) return;
      if (window._gameflowPhase !== 'Reconnect') return;                 // 已经连上了 / 对局结束了
      const res = await lolAPI.lcuRequest('POST', '/lol-gameflow/v1/reconnect');
      if (!(res && res.__error)) { showToast('已自动重新连接对局', 'positive'); return; }
      try { lolAPI.debugLog?.('[AUTO-RECONNECT] attempt ' + (attempt + 1) + ' failed: ' + res.__error); } catch (e) {}
      await autoflowSleep(3000);
    }
    showToast('自动重连失败, 请在客户端手动点击「重新连接」', 'negative');
  } finally {
    _autoReconnectRunning = false;
  }
}

// 挂接点: handleGameflowPhase 每次阶段上报 (含轮询的重复上报) 都会调用; 这里按「进入阶段」去重
function autoflowOnPhase(phase) {
  if (AUTO_HONOR_PHASES.includes(phase)) {
    if (!_autoHonorSeenPhases.has(phase)) {
      _autoHonorSeenPhases.add(phase);
      if (autoflow.honor && !complianceOn) autoHonorRun();
    }
  } else if (phase === 'None' || phase === 'Lobby' || phase === 'ChampSelect' || phase === 'GameStart' || phase === 'InProgress') {
    _autoHonorSeenPhases.clear();
  }
  if (phase === 'Reconnect') {
    if (!_autoReconnectSeen) {
      _autoReconnectSeen = true;
      if (autoflow.reconnect && !complianceOn) autoReconnectRun();
    }
  } else {
    _autoReconnectSeen = false;
  }
}
