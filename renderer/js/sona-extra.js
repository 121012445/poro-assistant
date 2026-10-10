// Sona 借鉴功能集 B: 回放观看 / 好友游戏中状态 / 选择性领奖 / 符文记忆
// 依赖: app.js 全局 (lolAPI, storeGet/storeSet, toolMsg, showToast, complianceOn, champNumMap)
// 注: 红蓝方提示由 chat.js 的 maybeAnnounceChampSelectSide 承担 (更完善: mapId 方向+身份+去重),
//     此处只保留开关; bench.js 的 handleChampSelectEvent 已挂接调用。

// ========== 红蓝方提示开关 ==========
function toggleSideAnnounce(on) {
  storeSet('sideAnnounce', on ? '1' : '');
  toolMsg(on ? '<span style="color:var(--positive)">选人时将发送红蓝方提示</span>' : '已关闭红蓝方提示');
}
function restoreSideAnnounceToggle() {
  const el = document.getElementById('sideAnnounceToggle');
  if (el) el.checked = storeGet('sideAnnounce') === '1';
}

// ========== 回放观看 (Game ID → 下载并播放) ==========
// 原实现调用 POST /lol-replays/v1/rocks —— LCU 里没有这个接口, 且 /lol-replays 不在主进程白名单内,
// 所以这个功能一直不可用。按 LCU 接口定义 (lol-replays) 的流程:
//   1. GET  /lol-replays/v1/configuration            回放是否可用 (对局中/客户端更新中不可用)
//   2. POST /lol-replays/v2/metadata/{id}/create      告诉客户端这局的版本/类型/队列/结束时间
//   3. GET  /lol-replays/v1/metadata/{id}             state: checking/found → 稍候; download → 下载; watch → 播放; incompatible → 版本过旧
//   4. POST /lol-replays/v1/rofls/{id}/download 或 /watch, 请求体 { componentType }
// 下载完成后自动开始播放 (最多等 REPLAY_WAIT_MS)。
const REPLAY_COMPONENT = { componentType: 'replay-button_match-history' };
const REPLAY_POLL_MS = 2000;
const REPLAY_WAIT_MS = 90 * 1000;
let _replayBusy = false;

function replayFailed(r) { return !!(r && r.__error); }
function replayErrorText(r) { return (r && (r.message || r.__error)) || '未知错误'; }

// 回放需要这局的版本等信息: 先查本地客户端战绩, 拿不到再查国服战绩服务 (SGP)
async function replayGameMeta(gameId, platformId) {
  try {
    const g = await lolAPI.lcuRequest('GET', `/lol-match-history/v1/games/${gameId}`);
    if (g && !g.__error && g.gameVersion) {
      return { gameVersion: g.gameVersion, gameType: g.gameType || '', queueId: Number(g.queueId) || 0,
        gameEnd: (Number(g.gameCreation) || 0) + (Number(g.gameDuration) || 0) * 1000 };
    }
  } catch (e) {}
  try {
    if (lolAPI.sgpGameSummary && typeof isTencentPlatform === 'function' && isTencentPlatform(platformId)) {
      const resp = await lolAPI.sgpGameSummary(platformId, gameId);
      const j = resp && !resp.__error ? (resp.json || resp) : null;
      if (j && j.gameVersion) {
        return { gameVersion: j.gameVersion, gameType: j.gameType || '', queueId: Number(j.queueId) || 0,
          gameEnd: Number(j.gameEndTimestamp) || ((Number(j.gameCreation) || 0) + (Number(j.gameDuration) || 0) * 1000) };
      }
    }
  } catch (e) {}
  return null;
}

async function watchReplay() {
  const input = document.getElementById('replayGameId');
  const raw = (input?.value || '').trim();
  if (!raw || !/^\d+$/.test(raw)) return toolMsg('<span style="color:var(--negative)">请输入纯数字 Game ID (对局详情卡上可复制)</span>');
  if (!guardWrite('观看回放')) return;
  if (_replayBusy) return toolMsg('回放正在处理中, 请稍候');
  _replayBusy = true;
  const gameId = raw;
  const fail = text => toolMsg('<span style="color:var(--negative)">' + escapeHtml(text) + '</span>');
  try {
    toolMsg('检查回放...');
    const conf = await lolAPI.lcuRequest('GET', '/lol-replays/v1/configuration');
    if (replayFailed(conf)) return fail('回放请求失败: ' + replayErrorText(conf));
    if (conf && conf.isReplaysEnabled === false) return fail('客户端当前不允许回放 (可能在对局中、正在更新, 或该大区未开放回放)');
    if (conf && conf.isPlayingGame) return fail('对局进行中无法观看回放');

    const platformId = cachedPlatformId || 'HN1';
    const meta = await replayGameMeta(gameId, platformId);
    if (!meta) return fail('查不到这局对局的信息 (Game ID 是否属于当前大区?)');
    const created = await lolAPI.lcuRequest('POST', `/lol-replays/v2/metadata/${gameId}/create`, meta);
    if (replayFailed(created)) return fail('回放请求失败: ' + replayErrorText(created));

    const deadline = Date.now() + REPLAY_WAIT_MS;
    let requestedDownload = false;
    for (;;) {
      const m = await lolAPI.lcuRequest('GET', `/lol-replays/v1/metadata/${gameId}`);
      if (replayFailed(m)) return fail('回放状态读取失败: ' + replayErrorText(m));
      const state = String(m?.state || '');
      if (state === 'watch') {
        const w = await lolAPI.lcuRequest('POST', `/lol-replays/v1/rofls/${gameId}/watch`, REPLAY_COMPONENT);
        if (replayFailed(w)) return fail('启动回放失败: ' + replayErrorText(w));
        return toolMsg('<span style="color:var(--positive)">正在启动回放</span>');
      }
      if (state === 'incompatible') return fail('这局回放与当前游戏版本不兼容 (回放只能在同一版本内观看)');
      if (state === 'download' && !requestedDownload) {
        const d = await lolAPI.lcuRequest('POST', `/lol-replays/v1/rofls/${gameId}/download`, REPLAY_COMPONENT);
        if (replayFailed(d)) return fail('回放下载失败: ' + replayErrorText(d));
        requestedDownload = true;
      }
      if (Date.now() >= deadline) {
        return toolMsg(requestedDownload
          ? '回放仍在下载, 完成后可在客户端「生涯 - 对局记录」里观看'
          : '<span style="color:var(--negative)">客户端迟迟没有返回回放状态 (' + escapeHtml(state || '未知') + '), 请稍后重试</span>');
      }
      toolMsg(state === 'downloading' ? `回放下载中${m?.downloadProgress > 0 && m.downloadProgress <= 100 ? ' ' + m.downloadProgress + '%' : ''}...` : '准备回放...');
      await new Promise(r => setTimeout(r, REPLAY_POLL_MS));
    }
  } catch (e) {
    fail('回放失败: ' + e.message);
  } finally {
    _replayBusy = false;
  }
}
// Game ID 复制 (对局详情处调用)
function copyGameId(gameId) {
  if (lolAPI.copyText) {
    lolAPI.copyText(String(gameId));
    showToast('Game ID 已复制: ' + gameId, 'positive');
  }
}

// ========== 增强游戏中好友状态 (模式 + 实时时长) ==========
// 数据源: /lol-chat/v1/friends 的 lol 字段 (gameStatus/gameMode/gameQueueType/timestamp)
function fmtGameDuration(ms) {
  if (!ms || ms <= 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚开局';
  if (min < 60) return min + ' 分钟';
  return Math.floor(min / 60) + ' 小时 ' + (min % 60) + ' 分';
}
function friendInGameMeta(f) {
  const lol = f && f.lol;
  if (!lol || !lol.gameStatus || lol.gameStatus === 'outOfGame' || !lol.gameId) return null;
  const mode = MODE_NAMES[lol.gameMode] || lol.gameMode || '';
  const dur = fmtGameDuration(lol.gameTime ? Date.now() - lol.gameTime : 0);
  return { mode, dur };
}
// 挂到好友列表渲染 (social.js 的好友区块渲染后调用, 每条前缀标注)
function enrichFriendGameStatus() {
  try {
    lolAPI.lcuRequest('GET', '/lol-chat/v1/friends').then(friends => {
      if (!Array.isArray(friends)) return;
      const map = {};
      for (const f of friends) {
        const meta = friendInGameMeta(f);
        if (meta) map[(f.gameName || f.name || '') + '#' + (f.gameTag || f.tagLine || '')] = meta;
      }
      // 标注到首页"常一起玩"与黑名单页出现的名字元素 (数据驱动的轻量方案)
      window._friendGameMeta = map;
    }).catch(() => {});
  } catch (e) {}
}

// ========== 选择性领取通行证奖励 ==========
let _selectableRewards = [];   // { missionId, missionName, options: [{rewardId, name, ...}] }
// 展开/收起「选择性领取」面板; 首次展开自动扫描, 省掉一次手动点击。
// (与"一键全部领取"共用同一张卡片: 全自动走 claimAllRewards, 挑着领走这里)
function toggleRewardPicker(btn) {
  const wrap = document.getElementById('selectableRewardWrap');
  if (!wrap) return;
  const show = wrap.hidden;
  wrap.hidden = !show;
  btn.textContent = show ? '选择性领取 ▴' : '选择性领取 ▾';
  if (show) loadSelectableRewards();
}
async function loadSelectableRewards() {
  const box = document.getElementById('selectableRewardList');
  if (!box) return;
  _selectableRewards = [];
  box.innerHTML = '<div class="meta-loading">扫描待选择奖励...</div>';
  try {
    const missions = await lolAPI.lcuRequest('GET', '/lol-missions/v1/missions');
    if (!missions || missions.__error || !Array.isArray(missions)) {
      box.innerHTML = '<div class="meta-loading">任务列表获取失败</div>';
      return;
    }
    const pending = missions.filter(m => m.status === 'SELECT_REWARDS');
    if (!pending.length) {
      box.innerHTML = '<div class="meta-loading">没有待选择的任务奖励</div>';
      return;
    }
    _selectableRewards = pending.map(m => ({
      missionId: m.id,
      missionName: m.name || m.id,
      options: (m.rewardOptions || []).map(o => ({ rewardId: o.rewardId || o.id, name: o.rewardName || o.name || '奖励' }))
    }));
    box.innerHTML = _selectableRewards.map((m, mi) => `
      <div class="sel-reward-mission">
        <b>${m.missionName}</b>
        ${m.options.map((o, oi) => `<label class="sel-reward-item"><input type="checkbox" data-mi="${mi}" data-oi="${oi}" checked> ${o.name}</label>`).join('')}
      </div>`).join('');
  } catch (e) {
    box.innerHTML = '<div class="meta-loading">扫描失败: ' + e.message + '</div>';
  }
}
async function claimSelectedRewards() {
  if (!guardWrite('领取选择的奖励')) return;
  const checks = [...document.querySelectorAll('#selectableRewardList input[type="checkbox"]:checked')];
  if (!checks.length) return toolMsg('<span style="color:var(--warning)">未勾选任何奖励</span>');
  let done = 0;
  for (const chk of checks) {
    const m = _selectableRewards[Number(chk.dataset.mi)];
    if (!m) continue;
    try {
      await lolAPI.lcuRequest('PUT', '/lol-missions/v1/player', { missionIds: [m.missionId] });
      done++;
    } catch (e) {}
  }
  toolMsg(done ? '<span style="color:var(--positive)">已提交 ' + done + ' 项奖励选择</span>' : '<span style="color:var(--negative)">提交失败</span>');
  loadSelectableRewards();
}

// ========== 符文页记忆恢复 (个人习惯优先, OP.GG 兜底) ==========
// 记录玩家手动保存过的符文页 (英雄+模式 → 页快照), 自动符文时优先恢复记忆
let runeMemory = {};
let _runeMemTimer = null;
function runeMemPath() { return (window._userDataPath || '') + '/rune-memory.json'; }
async function loadRuneMemory() {
  try {
    const c = await lolAPI.readFile(runeMemPath());
    if (c) { const d = JSON.parse(c); if (d && typeof d === 'object') runeMemory = d; }
  } catch (e) {}
}
function scheduleRuneMemSave() {
  clearTimeout(_runeMemTimer);
  _runeMemTimer = setTimeout(async () => { try { await lolAPI.writeFile(runeMemPath(), JSON.stringify(runeMemory)); } catch (e) {} }, 1500);
}
// 记录: 玩家在选人阶段手动编辑符文页后触发 (champ-select session 事件里检测本地玩家)
async function captureRuneMemory(championId, gameMode) {
  if (!championId || complianceOn) return;
  try {
    const page = await lolAPI.lcuRequest('GET', '/lol-perks/v1/currentpage');
    if (!page || page.__error || !page.selectedPerkIds || !page.selectedPerkIds.length) return;
    const key = championId + '|' + (gameMode || 'any');
    const prev = runeMemory[key];
    // 未变化则跳过
    if (prev && JSON.stringify(prev.perks) === JSON.stringify({ p: page.primaryStyleId, s: page.subStyleId, ids: page.selectedPerkIds })) return;
    runeMemory[key] = { p: page.primaryStyleId, s: page.subStyleId, ids: page.selectedPerkIds, ts: Date.now() };
    scheduleRuneMemSave();
  } catch (e) {}
}
// 恢复: 自动符文时优先用记忆, 失败/无记忆返回 false 由原 OP.GG 逻辑兜底
async function applyRememberedRune(championId, gameMode) {
  const key = championId + '|' + (gameMode || 'any');
  const mem = runeMemory[key];
  if (!mem) return false;
  try {
    const pages = await lolAPI.lcuRequest('GET', '/lol-perks/v1/pages');
    if (!pages || pages.__error || !Array.isArray(pages)) return false;
    let autoPage = pages.find(p => p.name === 'Auto' && p.isEditable) || pages.find(p => p.isEditable);
    if (!autoPage) return false;
    const putRes = await lolAPI.lcuRequest('PUT', `/lol-perks/v1/pages/${autoPage.id}`, {
      name: 'Auto',
      primaryStyleId: mem.p,
      subStyleId: mem.s,
      selectedPerkIds: mem.ids,
      current: true
    });
    if (putRes && putRes.__error) return false;
    return true;
  } catch (e) { return false; }
}
