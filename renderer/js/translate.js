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
let _gtSkipEmpty = 0, _gtSkipEcho = 0, _gtSkipMineOff = 0, _gtSkipNoMatch = 0;
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
    _gtSkipEmpty = 0; _gtSkipEcho = 0; _gtSkipMineOff = 0; _gtSkipNoMatch = 0;
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
          if (gtEchoed.has(body)) { _gtSkipEcho++; continue; }   // 我们自己补发出去的译文
          if (GT_ZH_RE.test(body)) {
            if (!gtAutoMine) { _gtSkipMineOff++; continue; }
            gtQueue.push({ name: '我', body, mine: true });
            fresh++;
          } else if (gtLooksForeign(body)) {
            gtQueue.push({ name: '我', body, mine: false, self: true });
            fresh++;
          } else { _gtSkipNoMatch++; }
          continue;
        }
        if (!gtLooksForeign(body)) { _gtSkipNoMatch++; continue; }
        gtQueue.push({ name: fromName || '玩家', body });
        fresh++;
      }
    }
    // 每局第一次真的读到东西 → 记一行，用来区分"读不到"和"读到了没处理"
    if (scanned && !_gtReadTotal) {
      try { lolAPI.debugLog('[GT] first read, cids=' + JSON.stringify(cids) + ' msgs=' + scanned); } catch (e) {}
    }
    _gtReadTotal += scanned;
    // 界面上的可见反馈：读不到时至少要能看出来，而不是"没反应"
    const readEl = document.getElementById('gtReadState');
    if (readEl) {
      if (_gtReadTotal) {
        readEl.textContent = '本局已读到 ' + _gtReadTotal + ' 条聊天（房间 ' + cids.join(' / ') + '）';
        readEl.style.color = 'var(--positive)';
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
    const skipped = _gtSkipEmpty + _gtSysSkipped + _gtSkipEcho + _gtSkipMineOff + _gtSkipNoMatch;
    if (skipped && Date.now() - (_gtSkipLogAt || 0) > 20000) {
      _gtSkipLogAt = Date.now();
      try {
        lolAPI.debugLog('[GT] skip stats: empty=' + _gtSkipEmpty + ' sys=' + _gtSysSkipped
          + ' echo=' + _gtSkipEcho + ' mineOff=' + _gtSkipMineOff + ' noMatch=' + _gtSkipNoMatch
          + ' myId=' + (gtMyChatId ? 'ok' : '-') + ' myName=' + (gtMyName || '-'));
      } catch (e) {}
    }
    if (fresh) gtFlush();
  } catch (e) { try { lolAPI.debugLog('[GT] scan error: ' + (e?.message || e)); } catch (e2) {} }
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
        foreignItems.forEach((it, i) => lines.push({ name: it.name, body: it.body, translated: tr[i], ts: Date.now() }));
      }));
    }
    if (mineItems.length) {
      jobs.push(gtTranslateBatch(mineItems.map(it => it.body), target).then(tr => {
        mineItems.forEach((it, i) => {
          const out = String(tr[i] || '');
          if (!gtEchoOk(it.body, out)) return;
          gtEchoSend({ body: it.body, translated: out, target });
          // 浮窗也显示一条：自己确认实际补发出去的是哪句话
          lines.push({ name: '我（已补发）', body: it.body, translated: out, ts: Date.now() });
        });
      }));
    }
    await Promise.all(jobs);
    if (lines.length) {
      gtRecent = gtRecent.concat(lines).slice(-10);
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
