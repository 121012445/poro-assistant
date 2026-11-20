// 英雄熟练度 + 挑战进度 (英雄库页顶部区块)
//
// 数据全部来自本机客户端, 只读:
//   GET /lol-champion-mastery/v1/local-player/champion-mastery          熟练度列表
//   GET /lol-challenges/v1/summary-player-data/local-player             挑战汇总
//   GET /lol-challenges/v1/challenges/local-player                      挑战逐条 (兜底)
//
// 这两组接口在不同版本/大区可能返回不同结构, 所以解析一律"能取到多少算多少",
// 取不到就显示"当前客户端没有返回" —— 不编造进度。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  // window.X 形式既是浏览器里的真实赋值, 也让静态检查 (test_undef_globals) 认得出这个名字
  if (typeof window !== 'undefined') window.PoroMastery = api;
  else if (root) root.PoroMastery = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function rows(raw) {
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.championMasteries) ? raw.championMasteries : []);
    return list.filter(x => x && (x.championId || x.championID)).map(x => ({
      championId: Number(x.championId || x.championID) || 0,
      level: Number(x.championLevel) || 0,
      points: Number(x.championPoints) || 0,
      lastPlay: Number(x.lastPlayTime) || 0,
      tokens: Number(x.tokensEarned) || 0,
      chest: !!x.chestGranted
    })).filter(x => x.championId);
  }

  function top(list, limit) {
    return rows(list).sort((a, b) => b.points - a.points).slice(0, limit || 8);
  }

  // 等级分布: 5/6/7 级各几个, 以及总点数
  function buckets(list) {
    const all = rows(list);
    const byLevel = {};
    let points = 0;
    for (const r of all) {
      byLevel[r.level] = (byLevel[r.level] || 0) + 1;
      points += r.points;
    }
    return { total: all.length, byLevel, points, l5: byLevel[5] || 0, l6: byLevel[6] || 0, l7: byLevel[7] || 0 };
  }

  // 挑战: 结构不稳定, 只做"总数 / 已完成 / 按分类前几"的宽松解析
  function challengeSummary(raw) {
    if (!raw || raw.__error) return null;
    const arr = Array.isArray(raw) ? raw : (Array.isArray(raw.challenges) ? raw.challenges : null);
    if (arr) {
      const isDone = c => {
        if (!c) return false;
        if (Array.isArray(c.completedIds)) return c.completedIds.length > 0;
        if (c.isCompleted != null) return !!c.isCompleted;
        return !!(c.maxLevel && c.currentLevel === c.maxLevel);
      };
      const done = arr.filter(isDone);
      const total = arr.length;
      return { total, done: done.length, categories: [] };
    }
    // summary-player-data 的形态: { categoryProgress: [{category, completedIds:[], totalIds?}] }
    const cats = Array.isArray(raw.categoryProgress) ? raw.categoryProgress : [];
    if (!cats.length) return null;
    let total = 0, done = 0;
    const categories = cats.map(c => {
      const d = Array.isArray(c.completedIds) ? c.completedIds.length : (Number(c.completed) || 0);
      const t = Number(c.totalIds || c.total) || d;
      total += t; done += d;
      return { name: c.category || c.name || '—', done: d, total: t };
    });
    return { total, done, categories };
  }

  function html(masteryRaw, challengeRaw, opts) {
    const o = opts || {};
    const tb = buckets(masteryRaw);
    if (!tb.total && !challengeSummary(challengeRaw)) {
      return `<div class="ms-empty">客户端没有返回熟练度/挑战数据（未登录或该大区不支持）。</div>`;
    }
    const nameOf = id => { try { return o.champName ? (o.champName(id) || '') : ''; } catch (e) { return ''; } };
    const iconOf = id => { try { return o.champImg ? (o.champImg(id) || '') : ''; } catch (e) { return ''; } };
    const list = top(masteryRaw, o.limit || 8).map(m => `<div class="ms-item" title="${m.points} 点 · ${m.lastPlay ? new Date(m.lastPlay).toLocaleDateString() : '未记录最近使用'}">
      ${iconOf(m.championId) ? `<img src="${esc(iconOf(m.championId))}" alt="" onerror="this.style.visibility='hidden'">` : ''}
      <span class="ms-lv l${m.level}">${m.level}</span>
      <b>${esc(nameOf(m.championId) || ('#' + m.championId))}</b>
      <i>${Math.round(m.points / 1000)}k</i>
    </div>`).join('');
    const cs = challengeSummary(challengeRaw);
    const chHtml = cs
      ? `<div class="ms-ch"><b>挑战</b><span>${cs.done}/${cs.total}</span>${cs.categories.slice(0, 3).map(c => `<em>${esc(c.name)} ${c.done}/${c.total}</em>`).join('')}</div>`
      : '';
    return `<div class="ms-head"><b>熟练度</b><span>${tb.total} 个英雄 · ${Math.round(tb.points / 1000)}k 点</span>
        <span class="ms-lvcount">5级 ${tb.l5} · 6级 ${tb.l6} · 7级 ${tb.l7}</span></div>
      <div class="ms-list">${list}</div>${chHtml}`;
  }

  // ---------- 运行时 ----------
  let loading = false;

  async function load() {
    const box = document.getElementById('masteryPanel');
    if (!box || loading) return;
    loading = true;
    box.innerHTML = '<div class="ms-empty">读取客户端熟练度…</div>';
    let m = null, c = null;
    try { m = await lolAPI.lcuRequest('GET', '/lol-champion-mastery/v1/local-player/champion-mastery'); } catch (e) {}
    try { c = await lolAPI.lcuRequest('GET', '/lol-challenges/v1/summary-player-data/local-player'); } catch (e) {}
    if (!challengeSummary(c)) {
      try { c = await lolAPI.lcuRequest('GET', '/lol-challenges/v1/challenges/local-player'); } catch (e) {}
    }
    loading = false;
    box.innerHTML = html(m, c, {
      limit: 8,
      champName: id => (typeof champNameOf === 'function' ? champNameOf(id) : ''),
      champImg: id => (typeof champImg === 'function' ? champImg(id) : '')
    });
  }

  return { rows, top, buckets, challengeSummary, html, load };
});
