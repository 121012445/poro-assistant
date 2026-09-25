// 对局内聊天 + KDA 简报
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 对局内聊天 (参考 LeagueAkari: 先从 conversations 识别对局会话, 再向会话发消息) ==========
let _gameChatCid = null;
let _champSelectChatCid = null;   // 选人阶段聊天房间 (上等马通道: 同一房间贯穿选人与对局)
let _champSelectSideAnnouncedFor = '';
let _champSelectSideAnnounceBusy = false;
let _champSelectSideLastAttempt = 0;

// lol-chat 会先把 POST 的内容乐观插入界面，再由聊天服务同步确认。只发送 body/type
// 时部分客户端会显示一瞬间后删除；使用完整 ChatMessage 信封与客户端自身的发送格式一致。
function buildLcuChatMessage(conversationId, body, chatSelf, type = 'chat') {
  const summonerId = Number(chatSelf?.summonerId || 0);
  return {
    body: String(body || ''),
    fromId: String(chatSelf?.id || ''),
    fromObfuscatedSummonerId: Number(chatSelf?.obfuscatedSummonerId || 0),
    fromPid: String(chatSelf?.pid || ''),
    fromSummonerId: summonerId,
    id: conversationId,
    isHistorical: false,
    timestamp: '',
    type
  };
}

function chatHistoryContains(messages, body) {
  const rows = Array.isArray(messages) ? messages : (Array.isArray(messages?.messages) ? messages.messages : []);
  return rows.some(message => String(message?.body || '') === String(body || ''));
}

function activeChampSelectConversation(conversations, champSession) {
  const rooms = Array.isArray(conversations)
    ? conversations.filter(conversation => conversation?.type === 'championSelect' && conversation.id)
    : [];
  if (!rooms.length) return null;
  const activeId = String(champSession?.chatDetails?.multiUserChatId || '');
  if (activeId) {
    const exact = rooms.find(room => [room.id, room.pid, room.name].some(value => {
      const candidate = String(value || '');
      return !!candidate && (candidate === activeId || candidate.includes(activeId) || activeId.includes(candidate));
    }));
    if (exact) return exact;
  }
  // LCU 会话通常按创建时间排列；残留多个选人房间时，最后一项是本轮最新房间。
  return rooms[rooms.length - 1];
}

function normalizedSide(value) {
  const side = String(value ?? '').toUpperCase();
  if (side === '1' || side === '100' || side === 'ORDER' || side === 'BLUE') return 100;
  if (side === '2' || side === '200' || side === 'CHAOS' || side === 'RED') return 200;
  return 0;
}

function playerIdentityValues(player) {
  return [player?.puuid, player?.summonerId, player?.accountId, player?.gameAccountId]
    .map(value => String(value || '')).filter(Boolean);
}

function champSelectSideFromData(gameflow, champSession, self) {
  const ownIds = new Set(playerIdentityValues(self));
  const localCell = Number(champSession?.localPlayerCellId);
  const ownSlot = (Array.isArray(champSession?.myTeam) ? champSession.myTeam : [])
    .find(player => Number(player?.cellId) === localCell || playerIdentityValues(player).some(id => ownIds.has(id)));
  for (const id of playerIdentityValues(ownSlot)) ownIds.add(id);
  const direct = normalizedSide(ownSlot?.teamId ?? ownSlot?.team);
  if (direct) return direct;

  const gameData = gameflow?.gameData || {};
  const sideOf = (rows, side) => (Array.isArray(rows) && rows.some(player =>
    playerIdentityValues(player).some(id => ownIds.has(id)))) ? side : 0;
  return sideOf(gameData.teamOne, 100)
    || sideOf(gameData.teamTwo, 200)
    || (() => {
      const participants = Array.isArray(gameData.participants) ? gameData.participants : [];
      const mine = participants.find(player => playerIdentityValues(player).some(id => ownIds.has(id)));
      return normalizedSide(mine?.teamId ?? mine?.team);
    })();
}

function resetChampSelectSideAnnouncement() {
  _champSelectSideAnnouncedFor = '';
  _champSelectSideAnnounceBusy = false;
  _champSelectSideLastAttempt = 0;
}

async function maybeAnnounceChampSelectSide(champSession) {
  if (window._gameflowPhase !== 'ChampSelect' || complianceOn || _champSelectSideAnnounceBusy) return false;
  const now = Date.now();
  if (now - _champSelectSideLastAttempt < 1200) return false;
  _champSelectSideLastAttempt = now;
  _champSelectSideAnnounceBusy = true;
  try {
    const [gameflow, self, conversations, chatSelf] = await Promise.all([
      lolAPI.lcuRequest('GET', '/lol-gameflow/v1/session'),
      lolAPI.lcuRequest('GET', '/lol-summoner/v1/current-summoner'),
      lolAPI.lcuRequest('GET', '/lol-chat/v1/conversations'),
      lolAPI.lcuRequest('GET', '/lol-chat/v1/me')
    ]);
    if (window._gameflowPhase !== 'ChampSelect') return false;
    const room = activeChampSelectConversation(conversations, champSession);
    const side = champSelectSideFromData(gameflow, champSession, self);
    if (!room?.id || !side) return false; // 数据尚未齐全，等待下一次选人事件重试。
    const key = `${room.id}:${side}`;
    if (_champSelectSideAnnouncedFor === key) return true;
    const mapId = Number(gameflow?.gameData?.mapId || gameflow?.map?.id || 0);
    const direction = !mapId || mapId === 11 || mapId === 12
      ? (side === 100 ? '（地图左下侧）' : '（地图右上侧）')
      : '';
    const sideName = side === 100 ? '蓝色方' : '红色方';
    const body = `【Poro】本局己方位于${sideName}${direction}`;
    const endpoint = `/lol-chat/v1/conversations/${encodeURIComponent(room.id)}/messages`;
    // 国服聊天服务要求消息携带 /lol-chat/v1/me 中的真实聊天身份。fromId/pid 为空或
    // fromSummonerId=0 时客户端只会乐观显示，随后服务器同步会将其撤回。
    const payload = buildLcuChatMessage(room.id, body, chatSelf, 'chat');
    if (!payload.fromId || !payload.fromPid || !payload.fromSummonerId) return false;
    const result = await lolAPI.lcuRequest(
      'POST',
      endpoint,
      payload
    );
    if (result?.__error) return false;
    // 回读只在服务明确返回消息数组且目标消息缺失时补发一次。接口不可读时不盲目重发，
    // 避免不同客户端版本下产生重复队伍消息。
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (window._gameflowPhase === 'ChampSelect') {
      const history = await lolAPI.lcuRequest('GET', endpoint).catch(() => null);
      const readableHistory = Array.isArray(history) || Array.isArray(history?.messages);
      if (readableHistory && !chatHistoryContains(history, body)) {
        const retry = await lolAPI.lcuRequest('POST', endpoint, payload);
        if (retry?.__error) return false;
        try { lolAPI.debugLog(`[SIDE] first message not persisted; resent room=${room.id}`); } catch (e) {}
      }
    }
    _champSelectChatCid = room.id;
    _champSelectSideAnnouncedFor = key;
    try { lolAPI.debugLog(`[SIDE] announced room=${room.id} side=${sideName} map=${mapId || 'unknown'}`); } catch (e) {}
    return true;
  } catch (error) {
    try { lolAPI.debugLog('[SIDE] announce failed: ' + (error?.message || String(error))); } catch (e) {}
    return false;
  } finally {
    _champSelectSideAnnounceBusy = false;
  }
}
async function getGameChatCid() {
  if (_gameChatCid) return _gameChatCid;
  if (_champSelectChatCid) return _gameChatCid = _champSelectChatCid;
  try {
    // 选人房间是主通道: 会话列表里 type=championSelect 的会话即队伍聊天房间
    const convs = await lolAPI.lcuRequest('GET', '/lol-chat/v1/conversations');
    if (Array.isArray(convs)) {
      const csRoom = convs.find(c => c && c.type === 'championSelect' && c.id);
      if (csRoom) return _gameChatCid = csRoom.id;
      const gs = await lolAPI.lcuRequest('GET', '/lol-gameflow/v1/session');
      const gameId = gs?.gameData?.gameId;
      if (gameId) {
        const conv = convs.find(c => c && String(c.id || '').includes(String(gameId)));
        if (conv && conv.id) return _gameChatCid = conv.id;
      }
    }
  } catch (e) {}
  return null;
}
async function sendGameChat(text) {
  // 对局中必须优先走本机预填。LCU 的 championSelect 会话即使返回 200，也不代表消息会进入
  // 正在运行的游戏聊天；而且产品文案承诺“预填后由用户确认发送”，不能在后台直接发出。
  if (window._gameflowPhase === 'InProgress' && lolAPI.prefillGameChat) {
    const inputResult = await lolAPI.prefillGameChat(text, true);
    if (inputResult?.ok) return inputResult;
    if (lolAPI.copyText) {
      const copied = await lolAPI.copyText(text);
      return { ok: false, error: (inputResult?.error || '游戏输入失败') + (copied ? '；简报已复制到剪贴板' : ''), via: copied ? 'clipboard' : '' };
    }
    return inputResult || { ok: false, error: '游戏输入失败' };
  }
  // 路径1: LCU 对局聊天会话 (选人/房间阶段可能有)
  const cid = await getGameChatCid();
  try { lolAPI.debugLog('[CHAT] cid=' + (cid ? 'found' : 'none') + ' phase=' + window._gameflowPhase); } catch (e) {}
  if (cid) {
    const r = await lolAPI.lcuRequest('POST', `/lol-chat/v1/conversations/${encodeURIComponent(cid)}/messages`, { body: text, type: 'chat' });
    if (!(r && r.__error)) return { ok: true };
    const r2 = await lolAPI.lcuRequest('POST', '/lol-chat/v1/messages', { body: text, cid, type: 'chat' });
    if (!(r2 && r2.__error)) return { ok: true };
  }
  return { ok: false, error: cid ? '消息发送失败' : '未在对局中, 无法发送' };
}

function kdaTeamId(player) {
  const value = player?.teamId ?? player?.team ?? 0;
  if (+value === 100 || String(value).toUpperCase() === 'ORDER' || String(value).toUpperCase() === 'BLUE') return 100;
  if (+value === 200 || String(value).toUpperCase() === 'CHAOS' || String(value).toUpperCase() === 'RED') return 200;
  return 0;
}

function kdaBestRoster(sessionRows, selectedRows, cachedRows) {
  const lists = [sessionRows, selectedRows, cachedRows].filter(rows => Array.isArray(rows) && rows.length);
  const rows = (lists.sort((a, b) => b.length - a.length)[0] || []).map(player => ({
    ...player,
    teamId: kdaTeamId(player)
  }));
  const seen = new Set();
  return rows.filter(player => {
    const key = String(player.puuid || player.riotId || player.name || player.summonerName || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function kdaTargetRoster(roster, myPuuid, ally) {
  const mine = roster.find(player => String(player.puuid || '') === String(myPuuid || ''));
  if (!mine) return { mine: null, target: [] };
  const target = roster.filter(player => ally
    ? kdaTeamId(player) === kdaTeamId(mine)
    : kdaTeamId(player) !== 0 && kdaTeamId(player) !== kdaTeamId(mine));
  return { mine, target };
}

async function sendAllGameChat(text) {
  if (window._gameflowPhase !== 'InProgress') return { ok: false, error: '当前不在对局中' };
  if (!lolAPI.sendGameChatNow) return { ok: false, error: '游戏聊天发送组件不可用' };
  const message = '/all ' + String(text || '').trim();
  const result = await lolAPI.sendGameChatNow(message, true);
  if (result?.ok) return result;
  if (lolAPI.copyText) {
    const copied = await lolAPI.copyText(message);
    return { ok: false, error: (result?.error || '游戏聊天发送失败') + (copied ? '；内容已复制到剪贴板' : '') };
  }
  return result || { ok: false, error: '游戏聊天发送失败' };
}

// ========== 自动发送KDA简报 ==========
async function sendKDABriefing(ally) {
  const dlog = m => { try { lolAPI.debugLog('[KDA] ' + m); } catch (e) {} };
  if (!guardWrite('KDA简报')) { dlog('blocked by guardWrite'); return; }
  dlog('called ally=' + ally + ' phase=' + window._gameflowPhase + ' lcuConnected=' + lcuConnected);
  if (!lcuConnected) { showToast('客户端未连接', 'negative'); return; }
  try {
    showToast('正在生成' + (ally ? '己方' : '敌方') + ' KDA 简报…', 'positive');
    const st = await lolAPI.lcuRequest('GET', '/lol-gameflow/v1/session');
    dlog('session phase=' + (st?.phase || '') + ' hasGameData=' + !!st?.gameData + ' error=' + (st?.__error || ''));
    if (!st || st.__error) { showToast('获取对局信息失败: ' + (st?.__error || '未知'), 'negative'); return; }
    if (!st.gameData) { showToast('当前不在对局中', 'negative'); return; }
    const sessionParts = (st.gameData.teamOne || []).map(p => ({ ...p, teamId: p.teamId || 100 }))
      .concat((st.gameData.teamTwo || []).map(p => ({ ...p, teamId: p.teamId || 200 })));
    if (!sessionParts.length && st.gameData.participants && st.gameData.participants.length) sessionParts.push(...st.gameData.participants);
    const parts = kdaBestRoster(sessionParts, champSelectParticipants, livePlayersCache?.data);
    dlog('roster session=' + sessionParts.length + ' selected=' + (champSelectParticipants?.length || 0) + ' cached=' + (livePlayersCache?.data?.length || 0) + ' chosen=' + parts.length);
    if (!parts.length) { showToast('未获取到玩家数据', 'negative'); return; }
    if (!window._myPuuid) {
      try {
        const me = await lolAPI.lcuRequest('GET', '/lol-summoner/v1/current-summoner');
        dlog('fetch self=' + (me?.puuid ? 'ok' : 'missing') + ' error=' + (me?.__error || ''));
        if (me && me.puuid) window._myPuuid = me.puuid;
      } catch (e) { console.log('[KDA] fetch _myPuuid error:', e); }
    }
    if (!window._myPuuid) { showToast('无法获取自己的信息', 'negative'); return; }
    const selected = kdaTargetRoster(parts, window._myPuuid, ally);
    const myInfo = selected.mine;
    dlog('self=' + (myInfo ? 'found' : 'missing') + ' team=' + (myInfo?.teamId || 0));
    if (!myInfo) { showToast('未在对局玩家列表中找到自己', 'negative'); return; }
    const target = selected.target;
    dlog('target count=' + target.length + ' ally=' + ally);
    if (!target.length) {
      const reason = parts.length <= 1 ? '当前训练/自定义局只返回你自己，无法获取敌方玩家' : '目标玩家列表为空';
      showToast(reason, 'negative');
      lolAPI.notify && lolAPI.notify('KDA 简报不可用', reason);
      return;
    }
    // 名字解析: gameflow 会话可能不带名字, 用缓存兜底 (否则简报里全是"未知")
    await resolveNames(target.map(p => p.puuid).filter(Boolean));
    const platformId = await getPlatformId();
    console.log('[KDA] platformId:', platformId);
    const buildLine = async p => {
      try {
        const profile = await recentProfileFor(platformId, p.puuid, 10);
        const games = (profile?.recent || []).slice(0, 5);
        if (!games.length) return null;
        let k = 0, d = 0, a = 0, w = 0;
        for (const g of games) {
          k += g.k || 0; d += g.d || 0; a += g.a || 0;
          if (g.win) w++;
        }
        const kda = d > 0 ? ((k + a) / d).toFixed(2) : 'perfect';
        const name = p.gameName || p.summonerName || p.riotIdGameName || nameCache[p.puuid] || '玩家' + String(p.puuid || '').substring(0, 6);
        return `${name}: ${games.length}场${w}胜 ${k}/${d}/${a} KDA${kda}`;
      } catch (e) { return null; }
    };
    const built = typeof mapWithConcurrency === 'function'
      ? await mapWithConcurrency(target, 4, buildLine)
      : await Promise.all(target.map(buildLine));
    const lines = built.filter(Boolean);
    dlog('lines=' + lines.length + '/' + target.length);
    if (lines.length) {
      const msg = `[战绩简报] ${lines.join(' | ')}`;
      dlog('sending, lines=' + lines.length + ', msgLen=' + msg.length);
      const r = await sendAllGameChat(msg);
      dlog('send result: ' + JSON.stringify(r));
      if (r.ok) {
        showToast('KDA 简报已发送到所有人', 'positive');
        lolAPI.notify && lolAPI.notify('KDA 简报已发送到所有人', msg.replace('[战绩简报] ', ''));
      } else {
        showToast('发送失败: ' + (r.error || ''), 'negative');
        lolAPI.notify && lolAPI.notify('KDA 简报未能预填', r.error || '请切回游戏后重试');
      }
    } else {
      dlog('no lines built');
      showToast('未获取到战绩数据', 'negative');
      lolAPI.notify && lolAPI.notify('KDA 简报失败', '未获取到战绩数据');
    }
  } catch (e) {
    console.error('[KDA] exception:', e);
    showToast('发送失败: ' + e.message, 'negative');
  }
}
