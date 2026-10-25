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
let gtSeen = new Set();          // conversationId:messageId, 防止重复翻译
let gtQueue = [];                // 待翻译
let gtRecent = [];               // 最近推送过的行 (浮窗保持最后几条)
let gtTranslateCache = new Map(); // text -> 译文 (LRU 120, 同一句话反复刷屏不重复调接口)

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
}

function toggleGameTranslate(on) {
  gtEnabled = !!on;
  storeSet('gameTranslate', on ? '1' : '');
  const state = document.getElementById('gameTranslateState');
  if (state) { state.textContent = on ? '已开启' : '已关闭'; state.style.color = on ? 'var(--positive)' : ''; }
  gtSyncPolling();
}

function setTranslateTarget(value) {
  storeSet('translateTarget', String(value || 'en'));
}

function gtSyncPolling() {
  const shouldPoll = gtEnabled && window._gameflowPhase === 'InProgress' && lcuConnected;
  if (shouldPoll && !gtPollTimer) {
    gtScan();
    gtPollTimer = setInterval(gtScan, 1500);
  } else if (!shouldPoll && gtPollTimer) {
    clearInterval(gtPollTimer);
    gtPollTimer = null;
  }
}

// 阶段变化时重置本局状态 (由 handleGameflowPhase 调用)
function gameTranslateOnPhase(phase) {
  if (phase === 'InProgress') {
    gtSeen = new Set();
    gtQueue = [];
    gtRecent = [];
    gtMyChatId = '';
  }
  gtSyncPolling();
}

async function gtScan() {
  if (!gtEnabled || !lcuConnected || window._gameflowPhase !== 'InProgress') { gtSyncPolling(); return; }
  if (gtBusy) return;
  try {
    if (!gtMyChatId) {
      const me = await lolAPI.lcuRequest('GET', '/lol-chat/v1/me').catch(() => null);
      gtMyChatId = String(me?.id || '');
    }
    // 只翻对局聊天房间 (与 chat.js 的发送通道同源), 不碰好友私聊
    const cid = typeof getGameChatCid === 'function' ? await getGameChatCid() : null;
    if (!cid) return;
    const msgs = await lolAPI.lcuRequest('GET', `/lol-chat/v1/conversations/${encodeURIComponent(cid)}/messages`).catch(() => null);
    const rows = Array.isArray(msgs) ? msgs : (Array.isArray(msgs?.messages) ? msgs.messages : []);
    let fresh = 0;
    for (const m of rows) {
      const mid = String(m?.id || '');
      if (!mid) continue;
      const key = cid + ':' + mid;
      if (gtSeen.has(key)) continue;
      gtSeen.add(key);
      if (gtSeen.size > 3000) gtSeen = new Set([...gtSeen].slice(-1200));
      const body = String(m?.body || '').trim();
      if (!body || body.startsWith('/') || body.startsWith('【Poro】')) continue;
      if (String(m?.fromId || '') === gtMyChatId) continue;
      if (!gtLooksForeign(body)) continue;
      const display = m?.fromDisplay || {};
      gtQueue.push({ name: display.gameName || display.name || '玩家', body });
      fresh++;
    }
    if (fresh) gtFlush();
  } catch (e) { try { lolAPI.debugLog('[GT] scan error: ' + (e?.message || e)); } catch (e2) {} }
}

async function gtFlush() {
  if (gtBusy || !gtQueue.length) return;
  const now = Date.now();
  if (now - gtFlushAt < 700) { setTimeout(gtFlush, 800); return; }
  gtFlushAt = now;
  gtBusy = true;
  const batch = gtQueue.splice(0, 8);
  try {
    const texts = batch.map(it => it.body);
    const cached = texts.map(t => gtCacheGet(t));
    const need = [];
    cached.forEach((v, i) => { if (v === undefined) need.push(texts[i]); });
    let fetched = null;
    if (need.length) {
      const r = await lolAPI.translateText(need, 'zh-CN').catch(() => null);
      fetched = Array.isArray(r) ? r : null;
    }
    const lines = [];
    let fi = 0;
    batch.forEach((it, i) => {
      let translated = cached[i];
      if (translated === undefined) {
        const value = fetched ? String(fetched[fi++] || '') : '';
        translated = value || it.body;
        if (translated && translated !== it.body) {
          gtTranslateCache.set(it.body, translated);
          if (gtTranslateCache.size > 120) gtTranslateCache.delete(gtTranslateCache.keys().next().value);
        }
      }
      lines.push({ name: it.name, body: it.body, translated, ts: Date.now() });
    });
    gtRecent = gtRecent.concat(lines).slice(-5);
    if (lolAPI.gameTranslatePush) lolAPI.gameTranslatePush({ lines: gtRecent });
  } catch (e) {
    try { lolAPI.debugLog('[GT] flush error: ' + (e?.message || e)); } catch (e2) {}
  } finally {
    gtBusy = false;
    if (gtQueue.length) setTimeout(gtFlush, 800);
  }
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
