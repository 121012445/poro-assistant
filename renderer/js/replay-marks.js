// 回放书签 —— 复盘看到"这波不该打"时, 记下是哪一局、第几分钟, 之后一键打开回放。
//
// 为什么存在: 复盘页能画时间轴, 但关掉就没了; 错误库 (repeat-mistakes) 记的是"哪类错误",
// 没有"具体是哪一局哪一分钟"。书签补上这一段: 它是"证据坐标"。
//
// 数据: 本机 poro-config.json, 按账号隔离 (accountStoreKey), 上限 200 条。
// 打开回放复用 sona-extra.js 的 watchReplay(gameId, platformId)。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  // window.X 形式既是浏览器里的真实赋值, 也让静态检查 (test_undef_globals) 认得出这个名字
  if (typeof window !== 'undefined') window.PoroReplayMarks = api;
  else if (root) root.PoroReplayMarks = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const KEY = 'replayMarks';
  const MAX = 200;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function key() { return (typeof accountStoreKey === 'function') ? accountStoreKey(KEY) : KEY; }

  function read() {
    try {
      const raw = storeGet(key());
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function write(list) {
    try { storeSet(key(), JSON.stringify(list.slice(0, MAX))); } catch (e) {}
  }

  // 纯函数, 便于断言: 去重 (同局同分钟只留一条) + 新在前
  function merge(list, item) {
    const arr = (Array.isArray(list) ? list : []).filter(x => x && x.gameId);
    // 没有 gameId 的条目不是书签 (可能是"还没打开过复盘"时点到的), 直接不动列表
    if (!item || !item.gameId) return arr;
    const gid = String(item.gameId);
    const minute = Math.max(0, Math.round(Number(item.minute) || 0));
    const idx = arr.findIndex(x => String(x.gameId) === gid && Math.round(Number(x.minute) || 0) === minute);
    const rec = { gameId: gid, platformId: item.platformId || '', minute, note: String(item.note || '').slice(0, 120), at: item.at || Date.now() };
    if (idx >= 0) arr[idx] = rec; else arr.unshift(rec);
    return arr.slice(0, MAX);
  }

  function add(gameId, platformId, minute, note) {
    if (!gameId) return null;
    const list = merge(read(), { gameId, platformId, minute, note });
    write(list);
    return list;
  }

  function remove(gameId, minute) {
    const gid = String(gameId);
    write(read().filter(x => !(String(x.gameId) === gid && Math.round(Number(x.minute) || 0) === Math.round(Number(minute) || 0))));
  }

  function note(gameId, minute, text) {
    const gid = String(gameId);
    const list = read().map(x => (String(x.gameId) === gid && Math.round(Number(x.minute) || 0) === Math.round(Number(minute) || 0))
      ? Object.assign({}, x, { note: String(text || '').slice(0, 120) }) : x);
    write(list);
  }

  function html() {
    const list = read();
    if (!list.length) {
      return `<div class="rm-empty">还没有书签。打开一局的复盘后点「收藏这一局」，或在下方手动加一条。</div>`;
    }
    const rows = list.slice(0, 30).map(m => `<div class="rm-item">
      <span class="rm-min">${m.minute ? m.minute + "'" : '—'}</span>
      <span class="rm-gid">#${esc(m.gameId)}</span>
      <input class="rm-note" value="${esc(m.note)}" placeholder="记一句：这波为什么不该打"
        onchange="editReplayMarkNote(${JSON.stringify(m.gameId)},${Number(m.minute) || 0},this.value)">
      <button class="btn-secondary" onclick="openReplayMark(${JSON.stringify(m.gameId)},${JSON.stringify(m.platformId || '')})">看回放</button>
      <button class="btn-secondary" onclick="dropReplayMark(${JSON.stringify(m.gameId)},${Number(m.minute) || 0})">删</button>
    </div>`).join('');
    return `<div class="rm-head"><b>回放书签</b><span>${list.length} 条 · 本机保存</span>
      <span class="rm-add"><input id="rmNewMinute" class="rm-min" placeholder="分钟" style="width:56px">
      <input id="rmNewNote" class="rm-note" placeholder="补一条：第几分钟 + 发生了什么">
      <button class="btn-secondary" onclick="addReplayMarkManual()">添加</button></span></div>
      <div class="rm-list">${rows}</div>`;
  }

  // ---------- 运行时 ----------
  function render() {
    const box = document.getElementById('replayMarksPanel');
    if (box) box.innerHTML = html();
  }

  // 复盘页 (review.js) 在渲染时会写 window.__poroReviewCtx; 有它才能"收藏当前这局"
  function markCurrent() {
    const ctx = window.__poroReviewCtx;
    if (!ctx || !ctx.gameId) { if (typeof toolMsg === 'function') toolMsg('先打开一局的复盘，再收藏'); return; }
    add(ctx.gameId, ctx.platformId, 0, ctx.champName ? String(ctx.champName) : '');
    render();
    if (typeof toolMsg === 'function') toolMsg('已收藏这一局');
  }

  function addManual() {
    const minEl = document.getElementById('rmNewMinute');
    const noteEl = document.getElementById('rmNewNote');
    const ctx = window.__poroReviewCtx;
    if (!ctx || !ctx.gameId) { if (typeof toolMsg === 'function') toolMsg('先打开一局的复盘，才知道要记哪一局'); return; }
    add(ctx.gameId, ctx.platformId, Number(minEl && minEl.value) || 0, noteEl && noteEl.value);
    if (noteEl) noteEl.value = '';
    if (minEl) minEl.value = '';
    render();
  }

  function open(gameId, platformId) {
    if (typeof watchReplay === 'function') watchReplay(gameId, platformId);
    else if (typeof toolMsg === 'function') toolMsg('回放模块未加载');
  }

  return { read, merge, add, remove, note, html, render, markCurrent, addManual, open, MAX };
});
