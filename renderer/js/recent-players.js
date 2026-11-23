// 最近玩家 / 遭遇库 —— 把散在对话里的"这个人我见过"变成可浏览的列表。
//
// 数据来源 (都已在内存里, 不新增请求):
//   encounterMap  social.js 记录 { puuid: {name, count, lastSeen, ...} }
//   playerMarks   social.js 的人工标签/备注
//   playerIndex   player-index.js 见过的玩家索引 (含等级/头像)
//
// 与"玩家记忆"页的区别: 那一页只显示"有标签或备注"的人; 这一页是全部遭遇过的人,
// 按再遇次数/时间排序, 支持搜索 —— 用来回答"上周那个五五开是谁"。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  // window.X 形式既是浏览器里的真实赋值, 也让静态检查 (test_undef_globals) 认得出这个名字
  if (typeof window !== 'undefined') window.PoroRecentPlayers = api;
  else if (root) root.PoroRecentPlayers = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  // 内联到 onclick="..." 的字符串参数。不能直接用 JSON.stringify: 它产出的双引号会
  // 提前结束属性, 浏览器拿到的处理器只剩 `showMarkModal(` —— 点击必报 SyntaxError,
  // 用户看到的就是"编辑按钮没反应"(1.6.50 及以前)。转成 &quot; 后浏览器解码回原文,
  // 参数语义不变。本地实现而不复用全局 inlineArg: 本文件会被 Node 单测直接 require。
  function arg(v) { return esc(JSON.stringify(String(v == null ? '' : v))); }
  function known(name) { return !!(name && name !== '未知' && name !== '未知玩家'); }

  /**
   * @param {object} encounters { puuid: {name, count, lastSeen, wins?, games?} }
   * @param {object} marks      { puuid: {tags:[], note, color} }
   * @param {object} opts       { query, sort: 'recent'|'count'|'name', includeUnknown }
   */
  function build(encounters, marks, opts) {
    const o = opts || {};
    const src = encounters && typeof encounters === 'object' ? encounters : {};
    const mk = marks && typeof marks === 'object' ? marks : {};
    const q = String(o.query || '').trim().toLowerCase();
    let rows = Object.keys(src).map(puuid => {
      const e = src[puuid] || {};
      const m = mk[puuid] || {};
      return {
        puuid,
        name: e.name || m.name || '',
        count: Number(e.count) || 0,
        lastSeen: Number(e.lastSeen || e.last || 0) || 0,
        tags: Array.isArray(m.tags) ? m.tags : (Array.isArray(m.marks) ? m.marks : []),
        note: m.note || '',
        color: m.color || ''
      };
    });
    if (!o.includeUnknown) rows = rows.filter(r => known(r.name));
    if (q) rows = rows.filter(r => (r.name || '').toLowerCase().includes(q) || r.note.toLowerCase().includes(q)
      || r.tags.some(t => String(t).toLowerCase().includes(q)));
    const sort = o.sort || 'recent';
    rows.sort((a, b) => {
      if (sort === 'count') return b.count - a.count || b.lastSeen - a.lastSeen;
      if (sort === 'name') return String(a.name).localeCompare(String(b.name), 'zh-CN');
      return b.lastSeen - a.lastSeen || b.count - a.count;
    });
    const repeat = rows.filter(r => r.count >= 3).length;
    return { rows, total: rows.length, repeat, tagged: rows.filter(r => r.tags.length || r.note).length };
  }

  function html(view, opts) {
    const o = opts || {};
    const v = view || { rows: [], total: 0, repeat: 0, tagged: 0 };
    const head = `<div class="rp-head"><b>遭遇库</b>
      <span>${v.total} 人 · 再见 3 次以上 ${v.repeat} 人 · 有标签 ${v.tagged} 人</span>
      <input class="rp-search" id="rpQuery" value="${esc(o.query || '')}" placeholder="搜名字 / 标签 / 备注" oninput="renderRecentPlayers(this.value)">
      <select class="rp-sort" id="rpSort" onchange="renderRecentPlayers()">
        <option value="recent"${o.sort === 'count' || o.sort === 'name' ? '' : ' selected'}>最近遇到</option>
        <option value="count"${o.sort === 'count' ? ' selected' : ''}>再见次数</option>
        <option value="name"${o.sort === 'name' ? ' selected' : ''}>按名字</option>
      </select></div>`;
    if (!v.rows.length) {
      return head + `<div class="rp-empty">${o.query ? '没有匹配的玩家' : '还没攒下遭遇记录。打几局之后，这里会列出所有同局过的人。'}</div>`;
    }
    const rows = v.rows.slice(0, o.limit || 200).map(r => `<div class="rp-item" style="${r.color ? `--rp-color:${esc(r.color)}` : ''}">
      <span class="rp-dot"></span>
      <b class="rp-name">${esc(r.name || '未知')}</b>
      <span class="rp-count">再见 ${r.count} 次</span>
      <span class="rp-time">${r.lastSeen ? new Date(r.lastSeen).toLocaleDateString() : '—'}</span>
      <span class="rp-tags">${r.tags.map(t => `<i>${esc(t)}</i>`).join('')}${r.note ? `<em>${esc(r.note)}</em>` : ''}</span>
      <button class="btn-secondary" onclick="showMarkModal(${arg(r.puuid)},${arg(r.name || '')})">编辑</button>
    </div>`).join('');
    return head + `<div class="rp-list">${rows}</div>`;
  }

  return { build, html };
});
