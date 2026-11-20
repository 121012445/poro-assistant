// 账号漂移 / 多账号对比
//
// 场景: 一个人有主号 + 小号 + 朋友号。切号之后, Poro 的成长账本按账号隔离
// (accountStoreKey), 于是"这个号最近怎么了"永远只能跟自己的过去比。
// 这里把每个号的关键指标存一份"跨账号"的快照, 用来横向比。
//
// 指标口径 (只用账本里已有的字段, 不做模型):
//   场次 / 胜率 / KDA / 近 10 场胜率 / 近 10 场 KDA
//   漂移 = 近 10 场 vs 之前全部 —— 用来判断"最近是不是状态掉了"。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  // window.X 形式既是浏览器里的真实赋值, 也让静态检查 (test_undef_globals) 认得出这个名字
  if (typeof window !== 'undefined') window.PoroDrift = api;
  else if (root) root.PoroDrift = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const KEY = 'accountSnapshots';
  const MAX = 12;
  const RECENT = 10;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  // 兼容多种行形态: {win, k, d, a} / {win, kills, deaths, assists} / 原始 participant
  function winOf(r) { return r && (r.win === true || r.win === 'Win' || r.win === 'win'); }
  function kdaOf(rows) {
    let k = 0, d = 0, a = 0;
    for (const r of rows) {
      k += num(r.k ?? r.kills);
      d += num(r.d ?? r.deaths);
      a += num(r.a ?? r.assists);
    }
    return Math.round((k + a) / Math.max(1, d) * 100) / 100;
  }

  function summarize(rows) {
    const list = (Array.isArray(rows) ? rows : []).filter(r => r && typeof r === 'object');
    const games = list.length;
    if (!games) return null;
    const wins = list.filter(winOf).length;
    const recent = list.slice(0, RECENT);
    const before = list.slice(RECENT);
    const rw = recent.filter(winOf).length;
    return {
      games,
      wr: Math.round(wins / games * 100),
      kda: kdaOf(list),
      recentGames: recent.length,
      recentWr: recent.length ? Math.round(rw / recent.length * 100) : null,
      recentKda: recent.length ? kdaOf(recent) : null,
      beforeGames: before.length,
      beforeWr: before.length ? Math.round(before.filter(winOf).length / before.length * 100) : null,
      beforeKda: before.length ? kdaOf(before) : null
    };
  }

  function driftOf(stats) {
    if (!stats || stats.recentWr == null || stats.beforeWr == null) return null;
    return {
      wr: stats.recentWr - stats.beforeWr,
      kda: Math.round((stats.recentKda - stats.beforeKda) * 100) / 100
    };
  }

  // 一个账号只留一条, 重复记录直接覆盖 (同一天记录多次也没关系)
  function record(list, entry) {
    const arr = (Array.isArray(list) ? list : []).filter(x => x && x.puuid);
    if (!entry || !entry.puuid || !entry.stats) return arr;
    const rec = {
      puuid: String(entry.puuid), platform: String(entry.platform || ''),
      name: String(entry.name || '').slice(0, 24),
      t: entry.t || Date.now(),
      stats: entry.stats
    };
    const idx = arr.findIndex(x => String(x.puuid) === rec.puuid);
    if (idx >= 0) arr[idx] = rec; else arr.unshift(rec);
    return arr.sort((a, b) => b.t - a.t).slice(0, MAX);
  }

  function sorted(list) {
    return (Array.isArray(list) ? list : [])
      .filter(x => x && x.stats)
      .map(x => Object.assign({}, x, { drift: driftOf(x.stats) }))
      .sort((a, b) => (b.stats.games || 0) - (a.stats.games || 0));
  }

  function html(list, currentPuuid) {
    const rows = sorted(list);
    if (!rows.length) return `<div class="ad-empty">还没有账号快照。打开「成长」页会自动记录当前账号；切到另一个号再打开一次，就能横向对比。</div>`;
    const body = rows.map(r => {
      const s = r.stats;
      const d = r.drift;
      const wrCls = s.wr >= 55 ? 'up' : s.wr <= 45 ? 'down' : 'flat';
      const dCls = !d ? 'flat' : d.wr >= 5 ? 'up' : d.wr <= -5 ? 'down' : 'flat';
      return `<div class="ad-item${currentPuuid && r.puuid === currentPuuid ? ' current' : ''}">
        <b class="ad-name">${esc(r.name || r.puuid.slice(0, 8))}</b>
        <span class="ad-plat">${esc(r.platform || '—')}</span>
        <span class="ad-games">${s.games} 场</span>
        <span class="ad-wr ${wrCls}">${s.wr}%</span>
        <span class="ad-kda">KDA ${s.kda}</span>
        <span class="ad-drift ${dCls}" title="近 ${s.recentGames} 场 vs 之前 ${s.beforeGames} 场">${d ? (d.wr > 0 ? '+' : '') + d.wr + 'pt · KDA ' + (d.kda > 0 ? '+' : '') + d.kda : '样本不足'}</span>
      </div>`;
    }).join('');
    return `<div class="ad-head"><b>账号对比</b><span>${rows.length} 个账号 · 只在本机保存</span></div><div class="ad-list">${body}</div>
      <p class="ad-foot">漂移 = 近 ${RECENT} 场与更早场次的差值；它回答“最近掉没掉”，不解释原因。</p>`;
  }

  // ---------- 运行时 ----------
  function readAll() {
    try { const raw = storeGet(KEY); const arr = raw ? JSON.parse(raw) : []; return Array.isArray(arr) ? arr : []; } catch (e) { return []; }
  }
  function writeAll(list) { try { storeSet(KEY, JSON.stringify(list)); } catch (e) {} }

  function currentIdentity() {
    let puuid = window._myPuuid || '';
    if (!puuid) { try { const s = window.poroSession?.snapshot?.(); puuid = s?.accountPuuid || ''; } catch (e) {} }
    let platform = '';
    try { platform = String(cachedPlatformId || ''); } catch (e) {}
    let name = '';
    try { name = (window._myName || (window.lcuStatusCache && lcuStatusCache.summoner && lcuStatusCache.summoner.displayName) || ''); } catch (e) {}
    return { puuid, platform, name };
  }

  function recordCurrent() {
    const id = currentIdentity();
    if (!id.puuid) return;
    let rows = [];
    try { if (typeof growthLedger === 'function') rows = growthLedger(); } catch (e) {}
    const stats = summarize(rows);
    if (!stats) return;
    writeAll(record(readAll(), Object.assign({}, id, { stats })));
  }

  function render() {
    const box = document.getElementById('accountDriftPanel');
    if (!box) return;
    const id = currentIdentity();
    box.innerHTML = html(readAll(), id.puuid);
  }

  return { summarize, driftOf, record, sorted, html, readAll, writeAll, recordCurrent, render, RECENT };
});
