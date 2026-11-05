// 外服聊天翻译 + 对局计时浮窗 (主窗口侧)
// 由 lcu-events.js 的 handleGameflowPhase 调用 gameTranslateOnPhase(phase);
// 依赖 utils.js (showToast), compliance.js (guardWrite), chat.js (getGameChatCid)。
// 只读翻译是对局浮窗展示, 不属于自动化; 发送遵循「预填后由用户确认」并受合规模式限制。

// ========== 聊天翻译 (接收 → 翻译 → 推送浮窗) ==========
let gtEnabled = false;
let gtPollTimer = null;
let gtBusy = false;
let gtFlushAt = 0;
let gtMyChatId = '';
let gtMyName = '';               // chat id 取不到时用召唤师名字认自己
let gtMyPuuid = '';              // 用来从"会话清单"里排除自己的私聊主会话
let _gtPuuidTried = false;
let gtSeen = new Set();          // conversationId:messageId, 防止重复翻译
let gtQueue = [];                // 待翻译
let gtRecent = [];               // 最近推送过的行 (浮窗保持最后几条)
let gtTranslateCache = new Map(); // text -> 译文 (LRU 120, 同一句话反复刷屏不重复调接口)
let gtAutoMine = true;            // 我发的中文自动补一条译文给队友 (默认开: 这才是"不用切窗口"的用法)
let gtEchoQueue = [];            // 待补发的译文 (串行, 避免连发时互相打断)
let gtEchoBusy = false;
const gtEchoed = new Set();      // 我们自己补发出去的文本, 扫到自己时跳过, 否则会自我循环
let _gtCidDiagDone = false;
let _gtReadTotal = 0;            // 本局累计读到的消息条数 (诊断用)
let _gtLastStat = 0;             // 上次打"还没读到消息"日志的时间
let _gtCidsCache = { at: 0, ids: [] };  // 房间列表 10 秒内复用, 别每 1.5 秒都查一遍
let _gtCidLogAt = 0;             // 上次打房间解析日志的时间 (限频)
let _gtConvDumped = false;       // 本局是否已 dump 过会话清单
let _gtHistRead = 0;             // 本局 firstScan 读到的历史消息条数 (非新消息, 展示用区分)
let _gtFreshTotal = 0;           // 本局读到的新消息条数 (真实进入翻译管线的)
let _gtPhaseInAt = 0;            // 本局进局时间 (OCR 通道延迟启动用)
let _gtOcrNextAt = 0;            // 下次聊天框 OCR 的时间
let _gtOcrTotal = 0;             // OCR 通道累计送进翻译管线的行数 (诊断用)
let _gtOcrSkipLogAt = 0;         // 上次打"OCR 全被过滤"日志的时间 (限频)
// OCR 消息去重: 最近读到的消息 [{ norm, body, sent, at }]。
// 1.5.50 按文本精确去重 (抖动就变新消息); 1.5.51 按频道+时间戳 (时间戳读不准);
// 1.5.52 改为**归一化后模糊比对** —— 见 gtOcrSame。
let gtOcrRecent = [];
let _gtSkipEmpty = 0, _gtSkipEcho = 0, _gtSkipMineOff = 0, _gtSkipNoMatch = 0;
let _gtSkipHist = 0;             // 跳过的"进局前的我方历史消息"条数
let _gtSkipLogAt = 0;            // 上次打跳过统计日志的时间 (限频)
// 阶段闸门: bench.js 的兜底轮询每 12 秒都会调一次 handleGameflowPhase('InProgress'),
// 早先每次调用都重置 gtSeen → 同一批消息被当成新消息反复翻译、反复补发 = 无限刷屏 (1.5.32 实测)。
let _gtPhaseLatch = '';
let _gtSysSkipped = 0;           // 本局跳过的系统播报条数 (诊断用)
let _gtEchoLastAt = 0;           // 上次自动补发的时间 (节流)
let _gtEchoSent = 0;             // 本局自动补发次数 (总量闸门)
const _gtEchoRecent = new Map(); // 译文 -> 上次发送时间, 5 秒内不重发同一句 (防连点, 不挡正常重复说话)
// 刷屏已经在源头掐掉了 (阶段闸门 + 系统播报过滤 + 消息 id 去重),
// 所以这里只需要"排队不丢、别糊屏"级别的节流, 不能卡到正常说话都发不出去。
const GT_ECHO_GAP_MS = 1500;     // 两条补发之间最少 1.5 秒 (快了队友看不清)
const GT_ECHO_MAX_GAME = 40;     // 每局上限, 只防失控
const GT_ECHO_SAME_MS = 5000;    // 同一句 5 秒内不重发

// 击杀播报等系统消息: 会被 LCU 当成"某玩家发的消息"，而且经常挂着本人的名字。
// 一旦当成"我发的消息"处理，就会把「杀人如麻」翻成 "on a killing streak" 再发回聊天 →
// 自己读到自己发的英文 → 再翻 → 刷屏。这里直接从源头掐掉。
const GT_SYS_BODY_RE = new RegExp([
  'killing spree', 'killing streak', 'is legendary', 'legendary\\b', 'is godlike', 'godlike',
  'is unstoppable', 'unstoppable', 'is dominating', 'dominating', 'rampage',
  'has been slain', 'slain', 'has shut down', 'shut down', 'first blood',
  'double kill', 'triple kill', 'quadra kill', 'penta kill', '\\bace\\b',
  '大杀特杀', '杀人如麻', '超神', '双杀', '三杀', '四杀', '五杀', '团灭', '第一滴血',
  '无人能挡', '势不可挡', '主宰比赛', '暴走', '被击杀', '终结了'
].join('|'), 'i');

function gtIsSystemMsg(m, body) {
  const t = String(m?.type || '').toLowerCase();
  if (t && t !== 'chat') return true;          // system / notice / celebration ...
  return GT_SYS_BODY_RE.test(String(body || ''));
}

const GT_ZH_RE = /[\u4e00-\u9fff]/;

// 含中文的消息不需要翻 (混排的按含外语处理); 其余出现字母/假名/谚文/西里尔/泰文的都翻
const GT_FOREIGN_RE = /[a-zA-Z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u3040-\u30ff\uac00-\ud7af\u0e00-\u0e7f]/;
function gtLooksForeign(text) {
  return !!text && !/[\u4e00-\u9fff]/.test(text) && GT_FOREIGN_RE.test(text);
}

function gtCacheGet(text) {
  const hit = gtTranslateCache.get(text);
  if (hit !== undefined) { gtTranslateCache.delete(text); gtTranslateCache.set(text, hit); }
  return hit;
}

function initGameTranslate() {
  gtEnabled = storeGet('gameTranslate') === '1';
  const el = document.getElementById('gameTranslateToggle');
  if (el) el.checked = gtEnabled;
  const state = document.getElementById('gameTranslateState');
  if (state) { state.textContent = gtEnabled ? '已开启' : '已关闭'; state.style.color = gtEnabled ? 'var(--positive)' : ''; }
  const target = document.getElementById('translateTarget');
  if (target) target.value = storeGet('translateTarget') || 'en';
  // 默认开启: 在游戏里正常打中文、回车，工具自动补一句英文给队友，不用切窗口。
  // 想完全手动就手动关掉这个开关（关掉后只有「翻译并发送」按钮可用）。
  gtAutoMine = storeGet('gtAutoMine') !== '0';
  const mine = document.getElementById('gtAutoMineToggle');
  if (mine) mine.checked = gtAutoMine;
  // 启动后静默跑一次诊断：把当前能看到的聊天会话结构写进日志，
  // 每次启动都留一条痕迹，出问题时能直接判断"房间叫什么、能不能读"。
  setTimeout(() => { try { if (lcuConnected) gtDiagnose(true); } catch (e) {} }, 6000);
}

function toggleGtAutoMine(on) {
  gtAutoMine = !!on;
  storeSet('gtAutoMine', on ? '1' : '0');
}

function toggleGameTranslate(on) {
  gtEnabled = !!on;
  storeSet('gameTranslate', on ? '1' : '');
  const state = document.getElementById('gameTranslateState');
  if (state) { state.textContent = on ? '已开启' : '已关闭'; state.style.color = on ? 'var(--positive)' : ''; }
  gtSyncPolling();
}

function setTranslateTarget(value) {
  const v = String(value || 'en');
  storeSet('translateTarget', v);
  // 浮窗输入框的目标语言在主进程里, 只靠消息推送刷新 —— 对局中改语言后马上
  // Ctrl+F10 打字会发成旧语言 (1.5.40 用户实测), 所以切换时立刻下发一次。
  if (lolAPI.gameTranslateSetTarget) lolAPI.gameTranslateSetTarget(v);
}

// 对局进行中（重连期间 LCU 同样在跑，也要继续翻）
function gtInGame() {
  const p = window._gameflowPhase;
  return p === 'InProgress' || p === 'Reconnect';
}

function gtSyncPolling() {
  const shouldPoll = gtEnabled && gtInGame() && lcuConnected;
  // 900ms: 消息从发出到出现在浮窗 = 扫描间隔 + 翻译请求。1.5s 时最坏要等 1.5s 才被
  // 看见, 用户反馈"翻译很慢"; 900ms 对 LCU messages 接口压力可接受。
  if (shouldPoll && !gtPollTimer) {
    gtScan();
    gtPollTimer = setInterval(gtScan, 900);
  } else if (!shouldPoll && gtPollTimer) {
    clearInterval(gtPollTimer);
    gtPollTimer = null;
  }
}

// 阶段变化时重置本局状态 (由 handleGameflowPhase 调用)
// 注意: 这个函数每 12 秒就会被兜底轮询重复调用一次（阶段没变也调），
// 所以只能用「进入对局的那一次」当重置条件，不能见到 InProgress 就清空。
function gameTranslateOnPhase(phase) {
  const wasIn = _gtPhaseLatch === 'InProgress' || _gtPhaseLatch === 'Reconnect';
  const isIn = phase === 'InProgress' || phase === 'Reconnect';
  _gtPhaseLatch = phase;
  if (isIn && !wasIn) {
    gtSeen = new Set();
    gtQueue = [];
    gtRecent = [];
    gtMyChatId = '';
    gtMyName = '';
    gtMyPuuid = '';
    _gtPuuidTried = false;
    gtEchoQueue = [];
    gtEchoed.clear();
    _gtCidDiagDone = false;
    _gtReadTotal = 0;
    _gtLastStat = 0;
    _gtSysSkipped = 0;
    _gtEchoLastAt = 0;
    _gtEchoSent = 0;
    _gtEchoRecent.clear();
    _gtCidsCache = { at: 0, ids: [] };
    _gtCidLogAt = 0;
    _gtConvDumped = false;
    _gtHistRead = 0;
    _gtFreshTotal = 0;
    _gtPhaseInAt = Date.now();
    _gtOcrNextAt = Date.now() + 30000;   // 进局 30s 后才考虑 OCR (LCU 通道先给机会)
    gtOcrRecent = [];
    _gtOcrTotal = 0;
    _gtOcrSkipLogAt = 0;
    _gtSkipEmpty = 0; _gtSkipEcho = 0; _gtSkipMineOff = 0; _gtSkipNoMatch = 0; _gtSkipHist = 0;
    _gtSkipLogAt = 0;
    // chat.js 的选人房间 cid 跨局残留会让扫描/补发永远盯着死房间 (1.5.42 实测:
    // rooms empty 从进局刷到结束, 真对局房间被 strict 挡死) —— 每局开始作废重取
    if (typeof resetGameChatCid === 'function') { try { resetGameChatCid(); } catch (e) {} }
    // 进局即自动弹出弹幕浮窗 (带 show 标记, 空行也让主进程开窗), 不用等第一条消息
    if (gtEnabled && lolAPI.gameTranslatePush) {
      lolAPI.gameTranslatePush({ lines: gtRecent, target: (storeGet('translateTarget') || 'en'), show: true });
    }
  }
  gtSyncPolling();
}

// 对局中的聊天房间：championSelect 会话进对局后会消失，chat.js 的 getGameChatCid
// 只认它和「id 含 gameId」两种，对局里常常取不到 → gtScan 直接 return，整块功能静默失效。
//
// 实测国服对局内的队伍/全体聊天就是 c1 / c2 两个会话，所以要**都扫**：
// 只取一个的话，另一边的消息永远看不到（比如对面在全体里说话你看不到）。
async function gtResolveCids(force) {
  const now = Date.now();
  if (!force && _gtCidsCache.ids.length && now - _gtCidsCache.at < 10000) return _gtCidsCache.ids;
  const strict = [];   // 能确定是对局聊天的房间
  const loose = [];    // 兜底：对局中任何非好友私聊的会话
  // LCU 里同一个人有两种写法（裸 puuid / 带 @pvp.net 后缀），比较前统一掉后缀，
  // 否则"排除自己的主会话"永远不生效。
  const bare = s => String(s || '').replace(/@pvp\.net$/i, '');
  if (!gtMyPuuid && typeof window._myPuuid === 'string') gtMyPuuid = window._myPuuid;
  // 自己的 puuid 用来排除"和自己聊"的那条主会话
  if (!gtMyPuuid && !_gtPuuidTried) {
    _gtPuuidTried = true;
    try {
      const s = await lolAPI.lcuRequest('GET', '/lol-summoner/v1/current-summoner');
      if (s && !s.__error) {
        gtMyPuuid = String(s.puuid || '');
        gtMyName = gtMyName || String(s.gameName || s.displayName || s.name || '');
      }
    } catch (e) {}
  }
  const push = (arr, id) => {
    const s = String(id || '');
    if (s && !arr.includes(s) && arr.length < 4) arr.push(s);
  };
  try {
    if (typeof getGameChatCid === 'function') push(strict, await getGameChatCid().catch(() => null));
  } catch (e) {}
  try {
    const convs = await lolAPI.lcuRequest('GET', '/lol-chat/v1/conversations');
    if (Array.isArray(convs)) {
      for (const c of convs) {
        const id = String(c && c.id ? c.id : '');
        if (!id) continue;
        const type = String(c && c.type ? c.type : '');
        // 1.5.43: 选人房间进对局后不再产生任何消息 (实测 InProgress 全程空),
        // 无条件排除, 防止它占住扫描位挡住真对局房间 (gtScan 只在对局期跑,
        // 选人阶段的聊天不归翻译管, 所以这里不需要分阶段)
        if (/@lol-champ-select\.pvp\.net/i.test(id) || /champ/i.test(type)) continue;
        // 实测国服(2026-11-04): 非对局时只有一条 type=chat、id 为本人 puuid 的会话，
        // 没有 c1/c2，也没有 championSelect。对局中的队伍/全体聊天只在 InProgress 才出现，
        // 名字不一定叫 c1/c2，所以这里分两级：先认确定的，认不出来再放宽度到"非好友会话"。
        if (/^c\d+$/i.test(id) || /game|groupchat/i.test(type)) push(strict, id);
        else if (!/friend/i.test(type) && (!gtMyPuuid || bare(id) !== bare(gtMyPuuid))) push(loose, id);
      }
      if (!strict.length && !loose.length && !_gtCidDiagDone) {
        _gtCidDiagDone = true;
        const summary = convs.slice(0, 15).map(c => (c && c.type ? c.type : '?') + ':' + (c && c.id ? c.id : '?') + ':' + (c && c.name ? c.name : ''));
        try { lolAPI.debugLog('[GT] no cid, conversations=' + JSON.stringify(summary)); } catch (e) {}
      }
      // 1.5.45: 对局期无条件 dump 一次会话全清单 —— 15:29 局实测 InProgress 全程
      // 只有旧局残留会话 (105694a4), 本局聊天房间从未出现, 但"只有它一个"和
      // "还有别的被过滤"无法区分。每局一条, 量可控。
      if (window._gameflowPhase === 'InProgress' && !_gtConvDumped) {
        _gtConvDumped = true;
        const summary = convs.slice(0, 15).map(c => (c && c.type ? c.type : '?') + ':' + (c && c.id ? c.id : '?') + ':' + (c && c.name ? c.name : '') + ':msgs?' );
        try { lolAPI.debugLog('[GT] conv dump (' + convs.length + '): ' + JSON.stringify(summary)); } catch (e) {}
      }
    }
  } catch (e) {}
  // 1.5.44: strict 不再挡死 loose —— 实测上一局的对局会话 (uuid@pvp.net) 游戏结束后
  // 不销毁, 进局首次解析时列表里只有它 (本局 c1/c2 还没建), 它先进 loose; 若之后
  // strict 只含旧房间 (getGameChatCid 的 gameId 模糊匹配等), 本局真房间就被
  // 「strict.length ? strict : loose」挡死, 聊天永远不翻 (1.5.43 下午实测)。
  // 全扫无害: 旧房间没有新消息 (历史已标已读), 本人主会话已排除。
  const ids = [...strict, ...loose.filter(id => !strict.includes(id))].slice(0, 4);
  _gtCidsCache = { at: now, ids };
  if (ids.length && now - (_gtCidLogAt || 0) > 30000) {
    _gtCidLogAt = now;
    try { lolAPI.debugLog('[GT] cids=' + JSON.stringify(ids) + ' phase=' + window._gameflowPhase + ' strict=' + strict.length + ' loose=' + loose.length); } catch (e) {}
  }
  return ids;
}

async function gtScan() {
  if (!gtEnabled || !lcuConnected || !gtInGame()) { gtSyncPolling(); return; }
  if (gtBusy) return;
  try {
    if (!gtMyChatId || !gtMyName) {
      if (!gtMyChatId) {
        const me = await lolAPI.lcuRequest('GET', '/lol-chat/v1/me').catch(() => null);
        gtMyChatId = String(me?.id || '');
      }
      // 两个身份都取：LCU 不同版本里 fromId 有时对不上 chat id，
      // 只认 id 会出现"我打的中文永远不被补发"（这是 1.5.29 之前的老毛病）
      if (!gtMyName) {
        const s = await lolAPI.lcuRequest('GET', '/lol-summoner/v1/current-summoner').catch(() => null);
        gtMyName = String(s?.gameName || s?.displayName || s?.name || '');
        gtMyPuuid = gtMyPuuid || String(s?.puuid || '');
      }
    }
    const cids = await gtResolveCids();
    if (!cids.length) {
      // 一条都取不到时也要留下痕迹, 否则用户只会看到"功能没反应"
      if (Date.now() - _gtLastStat > 30000) {
        _gtLastStat = Date.now();
        try { lolAPI.debugLog('[GT] no room, phase=' + window._gameflowPhase + ' myId=' + (gtMyChatId || '-')); } catch (e) {}
      }
      return;
    }
    let fresh = 0;
    let scanned = 0;
    const firstScan = !_gtReadTotal;
    for (const cid of cids) {
      const msgs = await lolAPI.lcuRequest('GET', `/lol-chat/v1/conversations/${encodeURIComponent(cid)}/messages`).catch(() => null);
      const rows = Array.isArray(msgs) ? msgs : (Array.isArray(msgs?.messages) ? msgs.messages : []);
      scanned += rows.length;
      // 本局第一次读到这个房间时, 里面可能已经有历史消息 (房间复用/重连)。
      // 只翻最后 3 条, 其余直接标记已读, 否则会一口气把几十条旧消息全翻出来刷屏。
      if (firstScan && rows.length > 3) {
        for (const old of rows.slice(0, rows.length - 3)) {
          const oid = String(old?.id || '');
          if (oid) gtSeen.add(cid + ':' + oid);
        }
      }
      for (const m of rows) {
        const mid = String(m?.id || '');
        if (!mid) continue;
        const key = cid + ':' + mid;
        if (gtSeen.has(key)) continue;
        gtSeen.add(key);
        if (gtSeen.size > 3000) gtSeen = new Set([...gtSeen].slice(-1200));
        const body = String(m?.body || '').trim();
        if (!body || body.startsWith('/') || body.startsWith('【Poro】')) { _gtSkipEmpty++; continue; }
        // 击杀播报之类不是"谁说的话", 既不翻译也不补发
        if (gtIsSystemMsg(m, body)) { _gtSysSkipped++; continue; }
        const display = m?.fromDisplay || {};
        const fromName = String(display.gameName || display.name || '');
        const mine = (!!gtMyChatId && String(m?.fromId || '') === gtMyChatId)
          || (!!gtMyName && fromName === gtMyName);
        // 自己发的消息也翻，两个方向：
        //   打中文 → 翻成目标语言补发一条给队友（gtAutoMine 可关）
        //   打英文 → 翻成中文放进浮窗，确认自己刚才那句在外服语境里是什么意思
        if (mine) {
          // 1.5.46: 历史存量里的"我发过的"绝不补发不显示 —— 用户上午发过的话
          // (如"连败衰神")留在旧会话里, 每局进局 firstScan 都会读到, 若当成新
          // 发言就会自动翻成英文补发给全体 (用户感知: 每局开局自动发一句)。
          // 判据用消息时间戳 < 进局时间 (而非 firstScan 标记, 否则会吞掉进局后
          // 立刻发出的第一条); LCU 无 timestamp 的消息按新消息处理。
          let mTs = 0;
          try { mTs = m.timestamp ? (Date.parse(m.timestamp) || 0) : 0; } catch (e) {}
          if (mine && mTs > 0 && _gtPhaseInAt > 0 && mTs < _gtPhaseInAt - 5000) { _gtSkipHist++; continue; }
          if (gtEchoed.has(body)) { _gtSkipEcho++; continue; }   // 我们自己补发出去的译文
          if (GT_ZH_RE.test(body)) {
            if (!gtAutoMine) { _gtSkipMineOff++; continue; }
            gtQueue.push({ name: '我', body, mine: true, k: key });
            fresh++;
          } else if (gtLooksForeign(body)) {
            gtQueue.push({ name: '我', body, mine: false, self: true, k: key });
            fresh++;
          } else { _gtSkipNoMatch++; }
          continue;
        }
        if (!gtLooksForeign(body)) { _gtSkipNoMatch++; continue; }
        gtQueue.push({ name: fromName || '玩家', body, k: key });
        fresh++;
      }
    }
    // 每局第一次真的读到东西 → 记一行，用来区分"读不到"和"读到了没处理"
    if (scanned && !_gtReadTotal) {
      try { lolAPI.debugLog('[GT] first read, cids=' + JSON.stringify(cids) + ' msgs=' + scanned); } catch (e) {}
    }
    _gtReadTotal += scanned;
    _gtFreshTotal += fresh;
    // 界面上的可见反馈：读不到时至少要能看出来，而不是"没反应"
    // 1.5.45: 历史消息 (firstScan 一次性读到的存量) 与新消息分开显示,
    // 否则扫到旧局残留消息会显示"已读到 4 条", 让人误以为功能在工作
    const readEl = document.getElementById('gtReadState');
    if (readEl) {
      if (_gtReadTotal) {
        if (firstScan) {
          _gtHistRead = scanned;
          readEl.textContent = '读到 ' + scanned + ' 条历史消息（房间 ' + cids.join(' / ') + '）— 等待新消息；若整局都无新消息，说明本局聊天房间未接入';
          readEl.style.color = 'var(--warn, #e0a030)';
        } else {
          readEl.textContent = '本局已读到 ' + _gtFreshTotal + ' 条新聊天（房间 ' + cids.join(' / ') + '）';
          readEl.style.color = 'var(--positive)';
        }
      } else {
        readEl.textContent = '还没读到聊天（房间 ' + cids.join(' / ') + '，等待消息…）';
        readEl.style.color = '';
      }
    }
    if (!_gtReadTotal && Date.now() - _gtLastStat > 30000) {
      _gtLastStat = Date.now();
      try { lolAPI.debugLog('[GT] rooms empty, cids=' + JSON.stringify(cids) + ' phase=' + window._gameflowPhase); } catch (e) {}
    }
    // 1.5.44: 读到了消息但一条都没进翻译队列时, 必须留下"为什么被跳过"的痕迹,
    // 否则"没读到"和"读到了全被过滤"无法区分 (1.5.43 下午排障时缺的就是这块)
    const skipped = _gtSkipEmpty + _gtSysSkipped + _gtSkipEcho + _gtSkipMineOff + _gtSkipNoMatch + _gtSkipHist;
    if (skipped && Date.now() - (_gtSkipLogAt || 0) > 20000) {
      _gtSkipLogAt = Date.now();
      try {
        lolAPI.debugLog('[GT] skip stats: empty=' + _gtSkipEmpty + ' sys=' + _gtSysSkipped
          + ' echo=' + _gtSkipEcho + ' mineOff=' + _gtSkipMineOff + ' noMatch=' + _gtSkipNoMatch
          + ' hist=' + _gtSkipHist
          + ' myId=' + (gtMyChatId ? 'ok' : '-') + ' myName=' + (gtMyName || '-'));
      } catch (e) {}
    }
    if (fresh) gtFlush();
    // 1.5.46 OCR 兜底通道: 国服对局聊天不进 LCU (conv dump 实证), 进局 30s 后
    // LCU 仍零新消息 → 每 4s OCR 一次游戏左下聊天框。LCU 恢复有数据则自动停。
    if (gtInGame() && !_gtFreshTotal && Date.now() - _gtPhaseInAt > 30000 && Date.now() >= _gtOcrNextAt) {
      _gtOcrNextAt = Date.now() + 4000;
      gtOcrScan();
    }
  } catch (e) { try { lolAPI.debugLog('[GT] scan error: ' + (e?.message || e)); } catch (e2) {} }
}

// OCR 输出解析 (可单测)。
// 1.5.50 之前的思路是"尽量多收": 只要行里有外文片段就送去翻译。18:31 局日志
// 证明这条路走不通 —— Windows OCR 把整个聊天列表读成**一整行**, 同一条消息在
// 不同轮次被读成多个残缺版本 (congratulations → "gra 卣 白 tion" / "ulations" /
// "ülations"), 解析器把每个版本都当成新消息, 于是浮窗里出现"从没出现过的消息"。
// 1.5.51 改为"只认证据", 三条:
//   ① 必须有**完整聊天头**: 时间戳 + 频道标记 ([队伍]/[全体]/[All]...), 缺一不可。
//      头部之前的文字一律丢弃 (那是 "输入 /help 获取命令列表"、选人播报、界面文字)。
//   ② 消息体必须干净: 混进中文 / 竖线等 OCR 噪声就**整条丢弃**, 不再"从中抽片段"
//      —— 抽出来的 "tion"、"gra" 正是幻影消息的来源。
//   ③ 去重键改成"频道+时间戳" (见 gtOcrScan): 同一条消息的多个 OCR 版本只会
//      产生一条翻译。
// 注意: GT_OCR_NOISE_RE 不能带 /i —— "Esc" 靠大小写区分, 否则 "escape" 会被误杀
const GT_OCR_NOISE_RE = /打字|回车|发给队友|滚轮|拖动|双击|取消|发送|行情|买币|Esc/;
// 1.5.52: 聊天行的唯一可靠锚点是**频道方括号**, 不是时间戳。
// 19:13 局实测 (同一帧喂 3 种裁剪/2x~5x 放大): Windows OCR 把 "00:17" 读成
// "ÖO ： 17" / "当 7" / "丽 ： 17" / "中 ： 17", 放大到 5x 也读不对 ——
// 靠时间戳断行/去重天生不成立。而 "[ 队 伍 ]" 每轮都在 (最差剩 "伍 ]")。
// 允许缺左括号: 只留 "[队伍全体] + 右括号" 也算一个聊天头。
// 1.5.54: 第三种写法 —— **右括号整个丢了**。真实帧里出现过
// "[ 队 囿 雨 末 散 （ 傲 之 追 猎 者 ） 《 he everyone" (伍→囿, 且没有 ]),
// 前两种都匹配不上, 整条消息凭空消失。既然 1.5.54 起 OCR 已经是**一行一条**,
// 锚点放宽到"左括号 + 队伍全体"是安全的: 每行最多产出一条消息, 不会像
// 1.5.50 那样从一行里抽出多个残片。
const GT_OCR_CHANNEL_RE = /(?:[\[【「『〔]\s*([^\[\]【】「」『』〔〕]{1,8}?)\s*[\]】」』〕]|([队伍全体])\s*[\]】」]|[\[【「『〔]\s*([队伍全体])\s*[\]】」』〕]?)/g;
const GT_OCR_TS_ANY_RE = /(\d{1,2})\s*[:：]\s*(\d{2})/g;
const GT_OCR_ZH_RE = /[\u4e00-\u9fff]/;
// 合法的"一个词"消息: 只有一两个词的消息不能因为"像残片"就被丢掉
const GT_OCR_SHORT_OK = new Set([
  'gg', 'wp', 'gj', 'ggwp', 'lol', 'lmao', 'hi', 'hello', 'hey', 'ty', 'thx', 'thanks',
  'omw', 'ez', 'op', 'ff', 'jg', 'mid', 'top', 'adc', 'sup', 'jungle', 'nice', 'good',
  'yes', 'no', 'ok', 'okay', 'push', 'care', 'help', 'run', 'wait', 'ult', 'flash',
  'baron', 'dragon', 'herald', 'sry', 'sorry', 'np', 'yep', 'nope', 'go', 'back', 'recall',
  // 1.5.55: 完整单词不该被当成残片扣一轮 (真实帧里 11:04/11:20 两条 goodluck)
  'goodluck', 'congrats', 'congratulations', 'welcome'
]);
// 本文件解析器的"丢弃留痕" (诊断用): 每轮重置, 只留前 4 条, 供 gtOcrScan 写日志
let _gtOcrDropped = [];

function gtNormalizeOcrText(raw) {
  return String(raw || '')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    // 1.5.68: OCR 会在数字和冒号之间插一个"点"当分隔符 —— 05:57 局真实帧把
    // "02:38" 读成 "02 ． ： 38", 于是这一帧取不到时间戳, 同一条消息的去重键
    // 从 "02:38" 变成空串, 下一帧就被当成新消息又翻一遍。点必须在冒号前才折叠,
    // 否则 "6．62" 这种小数会被吃掉。
    .replace(/(?<=\d)\s*[.．。·、]\s*(?=[:：])/g, '')
    .replace(/(?<=\d)\s*[:：]\s*(?=\d)/g, ':');   // "00 ： 18" → "00:18"
}

// 消息体是否"干净且像一句完整的话"。这里是过滤残片的主闸门。
function gtOcrBodyOk(body) {
  const s = String(body || '').trim();
  if (s.length < 2 || s.length > 160) return false;
  if (GT_OCR_ZH_RE.test(s)) return false;                 // 混进中文 = 两行糊在一起
  if (/[|｜`~^\\]/.test(s)) return false;                 // 竖线/反引号是 OCR 噪声标志
  if (GT_OCR_NOISE_RE.test(s)) return false;
  if (!gtLooksForeign(s)) return false;
  const tokens = s.split(/\s+/).filter(Boolean);
  const words = tokens.filter(t => /[A-Za-z]{2,}/.test(t));
  if (!words.length) return false;
  // 单个短词: 除非是常见短句, 否则当残片丢 ("tion" / "gra" / "he")
  if (tokens.length === 1 && s.replace(/[^A-Za-z]/g, '').length < 5
    && !GT_OCR_SHORT_OK.has(s.toLowerCase())) return false;
  // 一半以上是单字符 token = 断字噪声 ("h 0 00 0 g")
  if (tokens.length >= 3 && words.length * 2 < tokens.length) return false;
  return true;
}

// 单个词的短消息先"待确认": 它可能只是长词被截断的一半 ("ulations")。
// 下一轮读到同样内容才发出, 读到更完整的版本就用更完整的那个。
function gtOcrNeedsConfirm(body) {
  const tokens = String(body || '').split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) return false;
  const word = String(body).toLowerCase();
  if (GT_OCR_SHORT_OK.has(word)) return false;
  // 1.5.55: 长单词 (≥10 个字母) 基本不可能是"被截断的一半" —— 真实帧里的
  // "congradulations" 每次都被扣一轮才发, 白等 4 秒。短的 (ulations / tokyo)
  // 仍然扣一轮等更完整的版本。
  return word.replace(/[^a-z]/g, '').length < 10;
}

// OCR 把单词拆成单个字母: "the top very strong" → "th e to p very strong"。
// Windows OCR 在字号小、背景花的时候会按字符框间隙断词, 05:19 局真实帧就是这样。
// 机翻拿到 "th e to p very strong" 只能瞎猜 (实测译成"这是非常强大的"), 用户看到
// 的就是"改意思了"。判据: 单字母 token 占比 ≥1/4 时把单字母并回前一个词;
// i/I/a/A 是真词, 不并 ("i am good" 不能被拼成 "iam good")。
function gtOcrJoinSplitWords(s) {
  const toks = String(s || '').split(/\s+/).filter(Boolean);
  if (toks.length < 3) return s;
  const singles = toks.filter(t => t.length === 1 && /[A-Za-z]/.test(t)).length;
  if (singles / toks.length < 0.25) return s;
  const out = [];
  for (const t of toks) {
    const prev = out.length ? out[out.length - 1] : '';
    if (t.length === 1 && /[A-Za-z]/.test(t) && /[A-Za-z]$/.test(prev) && !/^[iIaA]$/.test(t)) out[out.length - 1] = prev + t;
    else out.push(t);
  }
  return out.join(' ');
}

function gtOcrStripBody(seg) {
  let s = String(seg || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.replace(/^[\]】)）:：\s]+/, '').trim();
  // "玩家名 (英雄名): 内容" 前缀剥除; 前缀以数字结尾时不剥 (防把 "15:30" 当分隔符)
  const m = s.match(/^(.{1,40}?)[:：]\s*(.+)$/);
  if (m && m[2].trim() && !/\d\s*$/.test(m[1])) s = m[2].trim();
  // OCR 经常把 "）：" 整个吞掉, 中文名字/英雄名残渣就粘在正文前面
  // ("雨 未 散 （ 傲 之 追 猎 者 heIIO everyone")。正文必须是纯外文,
  // 所以从第一个拉丁字母处切 —— 切完还剩中文就整条丢。
  if (GT_OCR_ZH_RE.test(s)) {
    const i = s.search(/[A-Za-z]/);
    if (i > 0) s = s.slice(i).trim();
  }
  // 行尾残留的"半个聊天头" (裁剪边缘切断): "hello everyone 00:2"
  s = s.replace(/\s+\d{1,2}[:：]\d{0,1}$/, '').trim();
  s = s.replace(/\s+[\[\]【】()（）]+$/g, '').trim();
  s = s.replace(/[\s，,、。;；:：·]+$/g, '').trim();
  s = s.replace(/^[^A-Za-z]+/, '').trim();
  s = gtOcrJoinSplitWords(s);
  return gtOcrBodyOk(s) ? s : '';
}

// 1.5.55: 频道方括号**整个消失**时的兜底锚点。真实帧里出现过
// "0 60 1 雨 禾 散 @咳 鬼 才 ） ： hello everyone" —— 既没有 "[", 也没有 "队" 或 "伍",
// 三种方括号写法全都匹配不上, 消息凭空消失。既然 OCR 已经是一行一条, 改用
// "冒号"当锚点: 从左往右找第一个"左边像聊天头、右边能过正文校验"的冒号。
// 左边必须含中文或以 )/]/】 结尾 —— 否则 "dragon at 15:30" 会被切成 "30"。
// 返回 { body, cut }: cut 是切点位置, 调用方靠它取出**这条消息自己的**时间戳。
// 1.5.68: 之前这里只返回 body, 兜底路径硬写 ts='' —— 而频道方括号恰恰是最常被
// OCR 读烂的部分 ("[ 队 伍 ]" 读成 "」 五 ]"), 于是最需要时间戳兜底的那些帧
// 反而一个时间戳都拿不到, 去重键直接退化成空串。
function gtOcrSplitByColon(line) {
  const re = /[:：]/g;
  let m;
  while ((m = re.exec(line))) {
    const left = line.slice(0, m.index);
    const right = line.slice(m.index + 1).trim();
    if (!right) continue;
    if (!GT_OCR_ZH_RE.test(left) && !/[)\]】」]\s*$/.test(left)) continue;
    const body = gtOcrStripBody(right);
    if (body) return { body, cut: m.index };
  }
  return null;
}

// 一行文本里"这条消息"的时间戳 = 断点之前**最近**的一个时间戳。
// 断点就是聊天头 (频道标记或兜底冒号) 的起点 —— 时间戳永远排在它前面。
function gtOcrTsBefore(line, cut) {
  const before = String(line || '').slice(0, Math.max(0, cut));
  let ts = '', tm;
  GT_OCR_TS_ANY_RE.lastIndex = 0;
  while ((tm = GT_OCR_TS_ANY_RE.exec(before))) ts = String(Number(tm[1])).padStart(2, '0') + ':' + tm[2];
  return ts;
}

// "02:38" → 158 (秒)。浮窗靠它把**后补读到的一条老消息**插回它该在的位置,
// 而不是直接追加到最新一条下面 (用户报障: 旧消息插在两条新消息中间)。
// 取不到时间戳返回 0 = 顺序未知, 调用方按"最新"处理。
function gtOrdOfTs(ts) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(ts || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

// 返回 [{ ts, channel, body }]。ts = 这条消息自己的时间戳 (mm:ss), 1.5.68 起它是
// 去重键 + 浮窗排序依据; channel 只是辅助 (两边都读到且不一致时否决合并)。
// 先按行切: 一条聊天永远在一行内 —— 不按行切的话上一条消息的正文会把下面
// 无关的界面文字一起吞进去。
function gtParseOcrChatLines(raw) {
  _gtOcrDropped = [];
  const text = gtNormalizeOcrText(raw);
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const marks = [];
    GT_OCR_CHANNEL_RE.lastIndex = 0;
    let m;
    while ((m = GT_OCR_CHANNEL_RE.exec(line))) {
      marks.push({ start: m.index, end: m.index + m[0].length, channel: String(m[1] || m[2] || m[3] || '').replace(/\s+/g, '') });
    }
    if (!marks.length) {
      // 1.5.55: 方括号全丢的行退到冒号锚点, 别直接扔
      const byColon = gtOcrSplitByColon(line);
      // 1.5.68: 兜底路径也要取时间戳 (见 gtOcrSplitByColon 注释)。这条分支正是
      // "频道方括号被读烂"时唯一的入口, 时间戳在这里丢掉 = 这条消息永远拿不到稳定键。
      if (byColon) { out.push({ ts: gtOcrTsBefore(line, byColon.cut), channel: '', body: byColon.body }); continue; }
      if (_gtOcrDropped.length < 4) _gtOcrDropped.push('(无频道标记) ' + line.trim().slice(0, 40));
      continue;
    }
    // 第一个频道标记之前是界面文字 ("输入 /help 获取命令列表"、选人播报), 丢掉
    if (marks[0].start > 0 && _gtOcrDropped.length < 4) {
      _gtOcrDropped.push('(头部前杂音) ' + line.slice(0, marks[0].start).trim().slice(0, 40));
    }
    for (let i = 0; i < marks.length; i++) {
      const h = marks[i];
      const segEnd = i + 1 < marks.length ? marks[i + 1].start : line.length;
      let seg = line.slice(h.end, segEnd);
      // 下一条消息的时间戳排在它的频道标记**前面**, 所以会粘在本条正文尾部
      // ("hello everyone OO ： 31")。时间戳常被读成 "OO"/"ÖO"/"当", 前缀允许字母。
      // 只有"后面还有消息"时才能这样剥 —— 最后一条的尾部可能是正文里真实的时间
      // ("dragon at 15:30")。
      if (i + 1 < marks.length) seg = seg.replace(/\s*(?:[A-Za-z]{1,3}|\d{1,2})\s*[:：]\s*\d{1,2}\s*[，,。.、]?\s*$/, '');
      const body = gtOcrStripBody(seg);
      if (!body) {
        if (_gtOcrDropped.length < 4) _gtOcrDropped.push('(' + h.channel + ') ' + seg.trim().slice(0, 40));
        continue;
      }
      // ts = 这条消息自己的时间戳 (取聊天头之前最近的一个)。它只在这条消息的
      // 聊天头之前找, 所以不会串到上一条去 —— 上一条的时间戳排在它自己的头上,
      // 已经被上一个 segEnd 切走了。
      const ts = gtOcrTsBefore(line, h.start);
      out.push({ ts, channel: h.channel, body });
    }
  }
  return out;
}

// ===== OCR 消息去重: 模糊比对, 不依赖时间戳 =====
// 归一化后只留字母数字: "heIIO everyone" → "heiioeveryone", "hello everyone" → "helloeveryone"
function gtOcrNorm(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
    // OCR 会把字母读成形近数字 ("heII0 everyone" 其实就是 "hello everyone"),
    // 比对前先折叠, 否则同一句话会被当成两条
    .replace(/0/g, 'o').replace(/1/g, 'l').replace(/5/g, 's');
}
// OCR 读烂的痕迹: 正文里混进了非拉丁符号 (№ 丨 」 《 之类) 基本可以断定这一版是乱码。
// 用来判断"后到的一版虽然没更长, 但明显更干净, 值得替换掉浮窗里那一行"。
// 只放过拉丁字母 (含带重音的西语/葡语), 其余非 ASCII 一律算脏。
function gtOcrDirty(s) {
  return /[^\x20-\x7e\u00c0-\u024f]/.test(String(s || ''));
}
function gtOcrDistance(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
// 两条归一化文本是否是"同一条消息的不同 OCR 版本"
function gtOcrSame(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = short === a ? b : a;
  // 1.5.55: 包含判定加长度比例门禁。真实帧里 00:16 是 "hello everyone"、00:39 是
  // "hello" —— 后者是前者的子串, 旧的裸包含判定把第二条真消息当成了重复直接吞掉。
  // 比例 ≥0.6 才认为是"同一条的更完整/更残缺版本"; 真正的残片 (ulations /
  // congratulations = 0.53) 由下面"长句差 ≤3"和 gtOcrNeedsConfirm 兜住。
  if (short.length >= 3 && short.length >= long.length * 0.6 && long.includes(short)) return true;
  // 1.5.54: 长句上差 ≤3 个字符基本就是同一条消息的两次识别 —— 真实帧里
  // "he everyone" 与下一轮的 "hello everyone" 只差 3 个字母, 相似度 0.77 卡在
  // 阈值下, 于是同一句被翻了两遍。短句不敢这么放宽: "gg" 和 "ggwp" 也只差 2 个
  // 字符, 一放宽就会把两条真消息并成一条。
  if (long.length >= 8 && gtOcrDistance(a, b) <= 3) return true;
  if (long.length - short.length > Math.max(2, long.length * 0.35)) return false;
  return 1 - gtOcrDistance(a, b) / long.length >= 0.8;
}

async function gtOcrScan() {
  if (!lolAPI.gameTranslateOcrChat) return;
  try {
    const raw = await lolAPI.gameTranslateOcrChat();
    if (!raw) return;
    const parsed = gtParseOcrChatLines(raw);
    let fresh = 0, dup = 0, held = 0;
    // 诊断用: 本轮最后一条进管线的正文+键。日志里只有 "+1" 的时候完全看不出
    // 进管线的是哪句话、键是什么, 排查"旧消息又冒出来"只能靠猜。
    let lastFresh = '';
    for (const item of parsed) {
      const body = item.body;
      // 系统播报 (击杀/streak 类) 不处理
      if (GT_SYS_BODY_RE.test(body) || !gtLooksForeign(body)) continue;
      const norm = gtOcrNorm(body);
      if (norm.length < 2) continue;
      // 去重键 = 聊天框里那行显示的时间戳 (mm:ss)。
      // 1.5.67 用的是 "频道|时间戳", 但频道方括号恰恰是全行里最容易被读烂的部分:
      // 同一句话这轮读成 "队伍|02:38"、下轮方括号糊掉走冒号兜底读成 "|02:38",
      // 就成了两个键 → 同一条消息翻两遍、浮窗里多出一行, 而且新的一行落在
      // 后到的新消息之间 (用户报障: "marry me 和 good job 中间插了一条旧消息")。
      // 时间戳精确到秒, 一局里不会撞车, 单独当键最稳; 频道降级成**否决条件**:
      // 两边都读到且不一致时说明数字读错了, 不许合并。
      const key = item.ts ? String(item.ts) : '';
      const ch = item.channel || '';
      const ord = gtOrdOfTs(item.ts);
      // 同一条消息的多个 OCR 版本: 先按时间戳键找, 再按正文模糊比对 (时间戳读错时兜底)
      let rec = null;
      if (key) rec = gtOcrRecent.find(r => r.key === key && (!r.ch || !ch || r.ch === ch)) || null;
      if (!rec) {
        for (const r of gtOcrRecent) {
          // 1.5.55: 已发出的记录只认严格相似 (否则 "hello" 会被 "hello everyone" 吞掉);
          // 还没发出的"待确认"记录放宽到包含判定 —— 它就是靠"读到更完整的版本"来升级的。
          if (gtOcrSame(r.norm, norm)
            || (!r.sent && (norm.includes(r.norm) || r.norm.includes(norm)))) { rec = r; break; }
        }
      }
      if (!rec) {
        if (gtOcrNeedsConfirm(body)) { gtOcrRecent.push({ key, ch, ord, norm, body, sent: false, at: Date.now() }); held++; continue; }
        gtOcrRecent.push({ key, ch, ord, norm, body, sent: true, at: Date.now() });
        gtQueue.push({ name: '聊天', body, k: key || undefined, ord });
        _gtOcrTotal++; fresh++; lastFresh = body + '@' + (key || '无键');
        continue;
      }
      // 已经发过 = 同一条消息的另一个版本。只有"这轮读得明显更完整 / 更干净"时才
      // 替换那一条 (浮窗里同一行原地更新译文), 否则就是重复 ——
      // 这是"旧消息被重新翻译一遍"的根治点。
      if (rec.sent) {
        // 记录上一轮没拿到键 (那帧时间戳读不出来), 这轮读到了就补上 ——
        // 浮窗靠 k 复用同一行, 键补齐之后后续版本才是"原地更新"而不是新开一行。
        if (!rec.key && key) rec.key = key;
        if (!rec.ch && ch) rec.ch = ch;
        // 两个升级条件:
        //  a) 明显更完整 (+3 字符以上): "h eryone" → "hello everyone"
        //  b) 更干净: 上一条里还夹着 OCR 垃圾字符 ("Vhe № everyonq"), 这条没有。
        //     b 不看长度 —— 乱码版经常比正确版还长, 只比长度的话乱码会一直挂在浮窗上。
        const cleaner = gtOcrDirty(rec.body) && !gtOcrDirty(body);
        const longer = norm.length >= rec.norm.length + 3;
        const better = rec.key && (longer || cleaner) && Date.now() - rec.at < 20000;
        if (better) {
          rec.norm = norm; rec.body = body; rec.at = Date.now();
          if (ord) rec.ord = ord;
          gtQueue.push({ name: '聊天', body, k: rec.key, ord: rec.ord || 0 });
          _gtOcrTotal++; fresh++; lastFresh = body + '@' + rec.key;
        } else { dup++; }
        continue;
      }
      // 上一轮是"待确认"的单字词: 这轮读到更完整的版本就用更完整的发出
      if (norm.includes(rec.norm) || gtOcrSame(rec.norm, norm)) {
        rec.norm = norm; rec.body = body; rec.sent = true; rec.at = Date.now();
        if (!rec.key && key) rec.key = key;
        if (!rec.ch && ch) rec.ch = ch;
        if (ord) rec.ord = ord;
        gtQueue.push({ name: '聊天', body, k: rec.key || undefined, ord: rec.ord || 0 });
        _gtOcrTotal++; fresh++;
      } else {
        dup++;   // 这轮读得更残, 忽略
      }
    }
    // 待确认的单字词一直没被第二轮读到 (消息已经滚出聊天框) 时不能永远悬着:
    // 15 秒后按读到的那一版发出去, 否则这条消息就静默消失了。
    const nowTs = Date.now();
    for (const rec of gtOcrRecent) {
      if (rec.sent || !rec.at || nowTs - rec.at < 15000) continue;
      rec.sent = true;
      gtQueue.push({ name: '聊天', body: rec.body, k: rec.key || undefined, ord: rec.ord || 0 });
      _gtOcrTotal++; fresh++;
    }
    // 记录要留得比聊天框可见行数多得多: 消息滚出视野后还可能被重新读进来,
    // 一局 40 分钟几百条, 只留 60 条会让早先的消息在后半局被当成新消息重翻。
    if (gtOcrRecent.length > 300) gtOcrRecent.splice(0, gtOcrRecent.length - 240);
    if (fresh) {
      try {
        lolAPI.debugLog('[GT] ocr lines +' + fresh + ' (total=' + _gtOcrTotal + ' dup=' + dup + ')'
          + (lastFresh ? ' last=' + JSON.stringify(lastFresh.slice(0, 60)) : ''));
      } catch (e) {}
      gtFlush();
    } else if ((dup || held || _gtOcrDropped.length) && Date.now() - (_gtOcrSkipLogAt || 0) > 30000) {
      // 被过滤的必须留痕, 否则"OCR 读到了但一条都没进管线"和"OCR 什么都没读到"无法区分
      _gtOcrSkipLogAt = Date.now();
      try {
        lolAPI.debugLog('[GT] ocr filtered: dup=' + dup + ' held=' + held
          + ' drop=' + JSON.stringify(_gtOcrDropped.slice(0, 3)));
      } catch (e) {}
    }
  } catch (e) { try { lolAPI.debugLog('[GT] ocr error: ' + (e?.message || e)); } catch (e2) {} }
}

async function gtTranslateBatch(texts, target) {
  const out = new Array(texts.length);
  const need = [];
  texts.forEach((t, i) => {
    const hit = gtCacheGet(t + '|' + target);
    if (hit === undefined) need.push(i); else out[i] = hit;
  });
  if (need.length) {
    let fetched = null;
    let fetchErr = '';
    try {
      const r = await lolAPI.translateText(need.map(i => texts[i]), target);
      fetched = Array.isArray(r) ? r : null;
      if (!fetched) fetchErr = '返回结构异常';
    } catch (e) { fetchErr = (e && e.message) || String(e); }
    if (fetchErr) {
      // 接口挂了之前完全静默 (浮窗显示原文, 和"没翻译"无法区分) —— 留痕
      try { lolAPI.debugLog('[GT] translate failed: ' + fetchErr + ' target=' + target + ' texts=' + need.map(i => texts[i]).join(' | ').slice(0, 120)); } catch (e) {}
    }
    need.forEach((idx, k) => {
      const value = fetched ? String(fetched[k] || '') : '';
      const translated = value || texts[idx];
      out[idx] = translated;
      if (translated && translated !== texts[idx]) {
        gtTranslateCache.set(texts[idx] + '|' + target, translated);
        if (gtTranslateCache.size > 120) gtTranslateCache.delete(gtTranslateCache.keys().next().value);
      }
    });
  }
  texts.forEach((t, i) => { if (out[i] === undefined) out[i] = t; });
  return out;
}

async function gtFlush() {
  if (gtBusy || !gtQueue.length) return;
  const now = Date.now();
  if (now - gtFlushAt < 250) { setTimeout(gtFlush, 350); return; }
  gtFlushAt = now;
  gtBusy = true;
  const batch = gtQueue.splice(0, 8);
  try {
    const target = storeGet('translateTarget') || 'en';
    const foreignItems = batch.filter(it => !it.mine);
    const mineItems = batch.filter(it => it.mine);
    const lines = [];
    // 别人的消息翻成中文放进浮窗；我的消息翻成目标语言补发给队友。
    // 两个方向目标语言不同必须分开请求, 但可以并行 —— 串行时两边各等一次接口, 白慢一倍。
    const jobs = [];
    if (foreignItems.length) {
      jobs.push(gtTranslateBatch(foreignItems.map(it => it.body), 'zh-CN').then(tr => {
        foreignItems.forEach((it, i) => lines.push({ name: it.name, body: it.body, translated: tr[i], ts: Date.now(), k: it.k, ord: it.ord || 0 }));
      }));
    }
    if (mineItems.length) {
      jobs.push(gtTranslateBatch(mineItems.map(it => it.body), target).then(tr => {
        mineItems.forEach((it, i) => {
          const out = String(tr[i] || '');
          if (!gtEchoOk(it.body, out)) return;
          gtEchoSend({ body: it.body, translated: out, target });
          // 浮窗也显示一条：自己确认实际补发出去的是哪句话
          lines.push({ name: '我（已补发）', body: it.body, translated: out, ts: Date.now(), k: it.k, ord: it.ord || 0 });
        });
      }));
    }
    await Promise.all(jobs);
    if (lines.length) {
      // 同一个 k = 同一条消息的另一个版本 (OCR 这轮读得更完整): 原地替换, 不新增一行。
      // 之前直接 concat, 于是同一句话在浮窗里出现两次, 且后一次是重新翻译的
      // —— 用户看到的就是"来新消息时旧消息又被翻了一遍"。
      for (const ln of lines) {
        const i = ln.k ? gtRecent.findIndex(x => x && x.k === ln.k) : -1;
        if (i >= 0) gtRecent[i] = ln; else gtRecent.push(ln);
      }
      // 按聊天框里的时间戳排序, 而不是按"我们什么时候读到它"。
      // OCR 是每 4 秒重读整个聊天框, 一条消息这一帧读烂了 (整行没解析出来)、下一帧
      // 才读出来时, 它其实比刚推进来的新消息更早 —— 按到达顺序追加就会落在新消息
      // 中间 (用户报障: "marry me 和 good job 中间又插了一条旧消息")。
      // 拿不到时间戳的 (ord=0) 排最后, 互相之间保持到达顺序。
      gtRecent.sort((a, b) => {
        const oa = a.ord > 0 ? a.ord : Number.MAX_SAFE_INTEGER;
        const ob = b.ord > 0 ? b.ord : Number.MAX_SAFE_INTEGER;
        return oa - ob;
      });
      gtRecent = gtRecent.slice(-10);
      // target 一起推: 悬浮输入框按它决定"回车后发成哪种语言"
      if (lolAPI.gameTranslatePush) lolAPI.gameTranslatePush({ lines: gtRecent, target });
    }
  } catch (e) {
    try { lolAPI.debugLog('[GT] flush error: ' + (e?.message || e)); } catch (e2) {}
  } finally {
    gtBusy = false;
    if (gtQueue.length) setTimeout(gtFlush, 350);
  }
}

// ========== 自己发的消息：翻译后补发一条给队友 ==========
// 译文可用的判据（补发与浮窗共用，避免浮窗显示"已补发"但实际上被拦下）
function gtEchoOk(body, translated) {
  if (!translated || translated === body) return false;   // 接口没返回结果，别把原文再发一遍
  if (GT_ZH_RE.test(translated)) return false;             // 译文里还有中文，说明没翻干净
  // 击杀播报类文本永远不进聊天: 它们的译文就是 "on a killing streak" 这种，
  // 一旦发出去被自己读回来，就是刷屏循环的燃料。
  if (GT_SYS_BODY_RE.test(body) || GT_SYS_BODY_RE.test(translated)) return false;
  return true;
}

function gtEchoSend(job) {
  if (!job) return;
  if (!gtEchoOk(job.body, job.translated)) return;
  gtEchoQueue.push(job);
  gtEchoDrain();
}

async function gtEchoDrain() {
  if (gtEchoBusy || !gtEchoQueue.length) return;
  // 自动以你的名义发消息属于写操作，合规模式下整块停用（只在入队时提示一次）
  if (typeof guardWrite === 'function' && !guardWrite('聊天自动翻译')) { gtEchoQueue = []; return; }
  if (!lolAPI.sendGameChatNow) { gtEchoQueue = []; return; }
  gtEchoBusy = true;
  try {
    while (gtEchoQueue.length) {
      const job = gtEchoQueue.shift();
      if (window._gameflowPhase !== 'InProgress') break;
      // 三道闸门: 总量、间隔、同一句重发窗口。任何一道拦住就丢弃这一条,
      // 宁可少发一句, 也不能再出现"一直自动发消息"。
      if (_gtEchoSent >= GT_ECHO_MAX_GAME) {
        try { lolAPI.debugLog('[GT] echo 达到每局上限 ' + GT_ECHO_MAX_GAME + ', 停止补发'); } catch (e) {}
        gtEchoQueue = [];
        break;
      }
      const now = Date.now();
      const lastSame = _gtEchoRecent.get(job.translated) || 0;
      if (now - lastSame < GT_ECHO_SAME_MS) {
        try { lolAPI.debugLog('[GT] echo 跳过重复句: ' + job.translated); } catch (e) {}
        continue;
      }
      const wait = Math.max(650, GT_ECHO_GAP_MS - (now - _gtEchoLastAt));
      if (wait > 650) await new Promise(r => setTimeout(r, Math.min(wait, GT_ECHO_GAP_MS)));
      await new Promise(r => setTimeout(r, 650));   // 让原文先显示出来，别两条挤在同一帧
      gtEchoed.add(job.translated);
      if (gtEchoed.size > 200) gtEchoed.delete(gtEchoed.values().next().value);
      _gtEchoRecent.set(job.translated, Date.now());
      if (_gtEchoRecent.size > 50) _gtEchoRecent.delete(_gtEchoRecent.keys().next().value);
      const r = await lolAPI.sendGameChatNow(job.translated, false).catch(() => null);
      if (!r?.ok) {
        // 游戏窗口不在前台时注入会被拦下 ("请先切回英雄联盟游戏窗口再按快捷键")。
        // 你要发消息的时候本来就在游戏里, 所以这里补一次"激活游戏窗口再发",
        // 否则补发会静默失败, 用户只能退回切窗口点按钮。
        const firstErr = String(r?.error || '');
        const retry = await lolAPI.sendGameChatNow(job.translated, true).catch(() => null);
        if (!retry?.ok) {
          try { lolAPI.debugLog('[GT] echo send failed: ' + (retry?.error || firstErr || 'unknown')); } catch (e) {}
          break;   // 发送通道不可用时不重试，避免反复抢输入框
        }
      }
      _gtEchoSent++;
      _gtEchoLastAt = Date.now();
    }
  } finally { gtEchoBusy = false; }
}

// ========== 手动诊断: 一眼看清"聊天通道到底通不通" ==========
// 之前失败时界面上什么反应都没有，只能靠猜。这个按钮把房间和会话清单直接摊出来，
// 同时写进 crash.log，出问题时能直接定位是"读不到房间"还是"读到了没处理"。
async function gtDiagnose(silent) {
  const out = silent ? null : document.getElementById('gtReadState');
  if (out) { out.textContent = '检查中…'; out.style.color = ''; }
  const cids = await gtResolveCids(true);
  let detail = '';
  try {
    const convs = await lolAPI.lcuRequest('GET', '/lol-chat/v1/conversations');
    if (Array.isArray(convs)) {
      detail = convs.slice(0, 15).map(c => (c && c.type ? c.type : '?') + ':' + (c && c.id ? c.id : '?')).join(' ');
    } else {
      detail = '读取异常 ' + JSON.stringify(convs).slice(0, 120);
    }
  } catch (e) { detail = '读取失败 ' + (e && e.message ? e.message : e); }
  const text = '阶段=' + (window._gameflowPhase || '-')
    + ' ｜ 聊天房间=' + (cids.join(' / ') || '无')
    + ' ｜ 会话清单=' + (detail || '空');
  if (out) {
    out.textContent = text;
    out.style.color = cids.length ? 'var(--positive)' : 'var(--negative)';
  }
  try { lolAPI.debugLog('[GT] diagnose: ' + text); } catch (e) {}
}

// ========== 试译: 不在对局里也能验证翻译质量 (走与对局中完全相同的通道) ==========
async function testTranslate() {
  const input = document.getElementById('translateSendInput');
  const out = document.getElementById('translateTestOut');
  const text = (input?.value || '').trim() || '上路差距';
  const target = storeGet('translateTarget') || 'en';
  if (out) { out.textContent = '翻译中…'; out.style.color = ''; }
  let forward = '';
  try {
    const r = await lolAPI.translateText([text], target);
    forward = Array.isArray(r) ? String(r[0] || '') : '';
  } catch (e) {}
  if (!forward) {
    if (out) { out.textContent = '翻译失败：接口没有返回结果（检查网络或「AI 复盘设置」里的接口）'; out.style.color = 'var(--negative)'; }
    return;
  }
  let back = '';
  try {
    const r2 = await lolAPI.translateText([forward], 'zh-CN');
    back = Array.isArray(r2) ? String(r2[0] || '') : '';
  } catch (e) {}
  if (out) {
    out.textContent = '「' + text + '」→ ' + forward + (back && back !== forward ? '　｜　再翻回来：' + back : '');
    out.style.color = 'var(--positive)';
  }
  try { lolAPI.debugLog('[GT] test translate: ' + text + ' -> ' + forward + (back ? ' -> ' + back : '')); } catch (e) {}
}

// ========== 发送翻译 (主窗口输入 → 翻译 → 预填到游戏聊天框, 用户回车确认) ==========
async function translateAndPrefill() {
  const input = document.getElementById('translateSendInput');
  const text = (input?.value || '').trim();
  if (!text) return;
  if (window._gameflowPhase !== 'InProgress') return showToast('当前不在对局中', 'negative');
  if (typeof guardWrite === 'function' && !guardWrite('翻译发送')) return;
  const target = storeGet('translateTarget') || 'en';
  let translated = '';
  try {
    const r = await lolAPI.translateText([text], target);
    translated = Array.isArray(r) ? String(r[0] || '') : '';
  } catch (e) {}
  if (!translated) return showToast('翻译失败 (可配置 AI 接口, 或检查网络)', 'negative');
  if (input) input.value = '';
  const pre = await lolAPI.prefillGameChat(translated, true).catch(() => null);
  if (pre?.ok) showToast('已翻译并预填到游戏输入框, 回车发送', 'positive');
  else showToast('预填失败: ' + (pre?.error || '未知错误'), 'negative');
}

// 一步到位: 翻译后直接发进游戏聊天, 不用再回游戏按一次回车
async function translateAndSend() {
  const input = document.getElementById('translateSendInput');
  const text = (input?.value || '').trim();
  if (!text) return;
  if (window._gameflowPhase !== 'InProgress') return showToast('当前不在对局中', 'negative');
  if (typeof guardWrite === 'function' && !guardWrite('翻译发送')) return;
  if (!lolAPI.sendGameChatNow) return showToast('游戏聊天发送组件不可用', 'negative');
  const target = storeGet('translateTarget') || 'en';
  let translated = '';
  try {
    const r = await lolAPI.translateText([text], target);
    translated = Array.isArray(r) ? String(r[0] || '') : '';
  } catch (e) {}
  if (!translated) return showToast('翻译失败 (可配置 AI 接口, 或检查网络)', 'negative');
  if (input) input.value = '';
  // 记下来, 免得被 gtScan 当成别人的消息再翻一遍
  gtEchoed.add(translated);
  const r = await lolAPI.sendGameChatNow(translated, true).catch(() => null);
  if (r?.ok) showToast('已发送: ' + translated, 'positive');
  else showToast('发送失败: ' + (r?.error || '未知错误'), 'negative');
}
