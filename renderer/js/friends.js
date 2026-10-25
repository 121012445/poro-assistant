// 好友助手: 上线提醒 + 一键邀请常一起玩的好友进房
// 事件来自 LCU WS 的 /lol-chat/v1/friends (已加入 main/lcu-ws.js 的转发白名单);
// 邀请走官方 /lol-lobby/v2/lobby/invitations 接口。上线判定与通知只在本地做。
let friendNotifyEnabled = false;
let friendNotifyList = [];           // 关注名单 (名字, 留空=全部好友)
let friendAvail = new Map();         // puuid -> 上次 availability (启动时快照, 避免把已在线的报一遍)

function initFriendAssist() {
  friendNotifyEnabled = storeGet('friendNotify') === '1';
  const el = document.getElementById('friendNotifyToggle');
  if (el) el.checked = friendNotifyEnabled;
  const state = document.getElementById('friendNotifyState');
  if (state) { state.textContent = friendNotifyEnabled ? '已开启' : '已关闭'; state.style.color = friendNotifyEnabled ? 'var(--positive)' : ''; }
  const input = document.getElementById('friendNotifyList');
  if (input) input.value = storeGet('friendNotifyList') || '';
  friendNotifyList = parseFriendNotifyList(storeGet('friendNotifyList') || '');
  // 初始快照
  lolAPI.lcuRequest('GET', '/lol-chat/v1/friends').then(fs => {
    if (Array.isArray(fs)) for (const f of fs) if (f?.id) friendAvail.set(f.id, String(f.availability || '').toLowerCase());
  }).catch(() => {});
  if (lolAPI.onLcuEvent) {
    lolAPI.onLcuEvent(({ uri, data }) => {
      if (uri === '/lol-chat/v1/friends' && Array.isArray(data)) handleFriendEvent(data);
    });
  }
  refreshDuoChips();
}

function parseFriendNotifyList(raw) {
  return String(raw || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
}

function friendWatchMatch(f) {
  if (!friendNotifyList.length) return true;
  const names = [f.name, f.gameName, f.riotIdGameName].map(v => String(v || '').toLowerCase()).filter(Boolean);
  return friendNotifyList.some(n => names.some(nm => nm.includes(n)));
}

function handleFriendEvent(friends) {
  for (const f of friends) {
    if (!f?.id) continue;
    const avail = String(f.availability || '').toLowerCase();
    const prev = friendAvail.get(f.id) || 'offline';
    friendAvail.set(f.id, avail);
    if (!friendNotifyEnabled) continue;
    // 上线判定: 离线/隐身/手机在线 -> 任意 PC 在线形态; 游戏中(inGame)与手机登录不提醒
    const wasOffline = prev === 'offline' || prev === 'invisible' || prev === 'mobile';
    const nowOnline = avail && !['offline', 'invisible', 'inGame', 'mobile'].includes(avail);
    if (wasOffline && nowOnline && friendWatchMatch(f)) {
      const name = f.name || f.gameName || f.riotIdGameName || '好友';
      const status = f.gameStatus && f.gameStatus !== 'none' ? ' (' + f.gameStatus + ')' : '';
      lolAPI.notify && lolAPI.notify('好友上线', name + ' 上线了' + status);
      if (typeof showToast === 'function') showToast('👥 ' + name + ' 上线了' + status, 'positive');
    }
  }
}

function toggleFriendNotify(on) {
  friendNotifyEnabled = !!on;
  storeSet('friendNotify', on ? '1' : '');
  const state = document.getElementById('friendNotifyState');
  if (state) { state.textContent = on ? '已开启' : '已关闭'; state.style.color = on ? 'var(--positive)' : ''; }
}

function saveFriendNotifyList() {
  const input = document.getElementById('friendNotifyList');
  const v = (input?.value || '').trim();
  storeSet('friendNotifyList', v);
  friendNotifyList = parseFriendNotifyList(v);
  showToast(friendNotifyList.length ? '关注名单已保存 (' + friendNotifyList.length + ' 人)' : '已设为提醒所有好友', 'positive');
}

// ========== 一键邀请常一起玩的好友 (数据由 home.js 挂到 window._poroDuoList) ==========
function refreshDuoChips() {
  const box = document.getElementById('duoInviteChips');
  if (!box) return;
  const list = window._poroDuoList || [];
  if (!list.length) {
    box.innerHTML = '<span class="tool-state">首页战绩加载后, 这里显示常一起玩的好友</span>';
    return;
  }
  box.innerHTML = list.map(([puuid, f]) => {
    const tag = f.tagLine || '';
    const name = f.name + (tag ? '#' + tag : '');
    return `<button class="duo-chip" onclick="inviteDuo(${inlineArg(puuid)}, ${inlineArg(name)})" title="邀请 ${escapeHtml(name)} 进入当前房间">${escapeHtml(f.name)}<i>${f.count}场</i></button>`;
  }).join('');
}

async function inviteDuo(puuid, name) {
  if (typeof guardWrite === 'function' && !guardWrite('邀请好友')) return;
  try {
    const lobby = await lolAPI.lcuRequest('GET', '/lol-lobby/v2/lobby');
    if (!lobby || lobby.__error || !lobby.roomId) return showToast('请先创建一个房间, 再邀请好友', 'negative');
    const friends = await lolAPI.lcuRequest('GET', '/lol-chat/v1/friends');
    const f = (Array.isArray(friends) ? friends : []).find(x => x && x.id === puuid);
    if (!f || !f.summonerId) return showToast('好友列表里找不到 ' + name + ' (需要互为好友)', 'negative');
    const r = await lolAPI.lcuRequest('POST', '/lol-lobby/v2/lobby/invitations', [{ summonerId: f.summonerId }]);
    if (r && r.__error) return showToast('邀请失败: ' + r.__error, 'negative');
    showToast('已向 ' + name + ' 发送房间邀请', 'positive');
  } catch (e) { showToast('邀请失败: ' + (e?.message || e), 'negative'); }
}

async function inviteAllDuos() {
  const list = window._poroDuoList || [];
  if (!list.length) return showToast('还没有常一起玩的数据', 'negative');
  if (typeof guardWrite === 'function' && !guardWrite('批量邀请好友')) return;
  let sent = 0, failed = 0;
  for (const [puuid] of list) {
    try {
      const friends = await lolAPI.lcuRequest('GET', '/lol-chat/v1/friends');
      const f = (Array.isArray(friends) ? friends : []).find(x => x && x.id === puuid);
      if (f && f.summonerId) {
        const r = await lolAPI.lcuRequest('POST', '/lol-lobby/v2/lobby/invitations', [{ summonerId: f.summonerId }]);
        if (r && !r.__error) { sent++; } else { failed++; }
      } else { failed++; }
      await new Promise(resolve => setTimeout(resolve, 350));   // 避免请求过密
    } catch (e) { failed++; }
  }
  showToast(`已发送 ${sent} 个邀请` + (failed ? ` (失败 ${failed})` : '') + (sent + failed ? '' : ' (请先创建房间)'), sent ? 'positive' : 'negative');
}
