// 强化 × 英雄 反向查询 —— "这个强化在哪些英雄身上最变态"。
//
// 原有的强化页是"英雄 → 强化"方向 (选英雄看推荐)。反向问题同样常见:
// 抽到某个强化, 不知道该往哪个英雄身上押; 或者想知道某个强化是不是"只有某几个英雄吃"。
//
// 数据: main/aramkit.js 的 augmentFit —— 只扫本机已缓存的英雄数据 (champ-*.json),
// 不联网、不编数。所以面板上必须写清楚"基于已缓存的 N 个英雄", 不装作全服榜单。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  // window.X 形式既是浏览器里的真实赋值, 也让静态检查 (test_undef_globals) 认得出这个名字
  if (typeof window !== 'undefined') window.PoroHexCross = api;
  else if (root) root.PoroHexCross = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  // 内联到 onclick="..." 里的字符串参数: 必须把 JSON 的双引号转成 &quot;, 否则属性会被截断成
  // onclick="fn(" —— 点击直接 SyntaxError, 表现为"按钮没反应" (1.6.51 修)。
  function arg(v) { return esc(JSON.stringify(String(v == null ? '' : v))); }
  function meta() { return (typeof window !== 'undefined' && window.PORO_AUG_META) || {}; }

  function searchAugments(query, limit) {
    const m = meta();
    const q = String(query || '').trim();
    if (!q) return [];
    const out = [];
    for (const [id, info] of Object.entries(m)) {
      if (!info || !info.name) continue;
      if (info.name.includes(q)) out.push({ id: Number(id), name: info.name, rarity: info.rarity || '', local: info.local || '' });
      if (out.length >= (limit || 8)) break;
    }
    return out;
  }

  function listHtml(rows) {
    if (!rows.length) return '';
    return `<div class="hx-hits">${rows.map(r => `<button type="button" class="hx-hit" onclick="poroAugmentFit(${r.id},${arg(r.name)})">
      ${r.local ? `<img src="${esc(r.local)}" alt="" onerror="this.style.visibility='hidden'">` : ''}
      <span>${esc(r.name)}</span><i>${esc(r.rarity)}</i></button>`).join('')}</div>`;
  }

  function fitHtml(data, augmentName) {
    if (!data || data.ok === false) return `<div class="hx-empty">查询失败：${esc((data && data.error) || '未知错误')}</div>`;
    if (!data.scanned) return `<div class="hx-empty">本机还没有缓存任何英雄的强化统计。先在强化页查几个英雄，再回来用这个反向查询。</div>`;
    if (!data.champions || !data.champions.length) return `<div class="hx-empty">已缓存的 ${data.scanned} 个英雄里没有这个强化（可能只在特定阶段出现）。</div>`;
    const rows = data.champions.map(c => {
      const name = (typeof champNameOf === 'function' ? champNameOf(c.championId) : '') || ('#' + c.championId);
      const lift = c.lift == null ? null : Math.round(c.lift * 1000) / 10;
      const cls = lift == null ? 'flat' : lift >= 3 ? 'up' : lift <= 0 ? 'down' : 'flat';
      return `<div class="hx-row">
        <img src="${esc(typeof champImg === 'function' ? champImg(c.championId) : '')}" alt="" onerror="this.style.visibility='hidden'">
        <b>${esc(name)}</b>
        <span class="hx-wr">${c.winRate == null ? '--' : Math.round(c.winRate * 1000) / 10 + '%'}</span>
        <span class="hx-lift ${cls}">${lift == null ? '—' : (lift > 0 ? '+' : '') + lift + 'pt'}</span>
        <span class="hx-rank">该英雄第 ${c.rank || '—'} 名 · ${c.games || 0} 场</span>
      </div>`;
    }).join('');
    return `<div class="hx-fit-head">「${esc(augmentName || '')}」在已缓存 ${data.scanned} 个英雄里的收益排序<span>lift = 胜率 − 该英雄基础胜率</span></div>
      <div class="hx-rows">${rows}</div>
      <p class="hx-foot">只统计本机查过的英雄，不是全服榜单；lift 越高说明这个强化对该英雄的相对提升越大。</p>`;
  }

  // ---------- 运行时 ----------
  async function runFit(id, name) {
    const box = document.getElementById('hexFitBody');
    if (!box) return;
    box.innerHTML = '<div class="hx-empty">读取本机缓存…</div>';
    let data = null;
    try { data = await lolAPI.getHexAugmentFit(id, (typeof hexDataScope !== 'undefined' ? hexDataScope : 'all')); } catch (e) { data = { ok: false, error: e.message }; }
    box.innerHTML = fitHtml(data, name);
  }

  function onSearchInput(input) {
    const box = document.getElementById('hexFitHits');
    if (!box) return;
    box.innerHTML = listHtml(searchAugments(input && input.value, 8));
  }

  return { searchAugments, listHtml, fitHtml, runFit, onSearchInput };
});
