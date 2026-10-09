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
async function watchReplay() {
  const input = document.getElementById('replayGameId');
  const raw = (input?.value || '').trim();
  if (!raw || !/^\d+$/.test(raw)) return toolMsg('<span style="color:var(--negative)">请输入纯数字 Game ID (对局详情卡上可复制)</span>');
  if (!guardWrite('观看回放')) return;
  toolMsg('请求回放中...');
  try {
    // platformId: 优先用当前大区
    let platformId = cachedPlatformId || 'HN1';
    const r = await lolAPI.lcuRequest('POST', '/lol-replays/v1/rocks', {
      platformId: platformId, gameId: Number(raw)
    });
    if (r && r.__error) {
      return toolMsg('<span style="color:var(--negative)">回放请求失败: ' + (r.message || r.__error) + '</span>');
    }
    toolMsg('<span style="color:var(--positive)">回放下载已开始, 完成后客户端会自动提示观看 (下载进度见客户端生涯-回放)</span>');
  } catch (e) {
    toolMsg('<span style="color:var(--negative)">回放失败: ' + e.message + '</span>');
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
