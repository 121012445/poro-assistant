// 选人期对手情报：把"对手近 10 场玩了什么"收敛成一条 ban 建议。
//
// 数据来源: live.js 的 sgpProfileFor() 已经为 10 名玩家拉过近期战绩 (p.recent,
// 新局在前, 每项 {champId, win, k, d, a, mode}), 这里只做聚合, **不发任何新请求**。
//
// 设计原则:
//   1. 只统计能确认的事实 —— 场次、胜负、连胜/连败; 不做"胜率 62% 所以强"之类的推断;
//   2. 样本不足就不出建议 —— 少于 MIN_GAMES 场的对手不参与 ban 排序, 避免一局巧合;
//   3. 建议带理由 —— 每个 ban 候选都说明"几个人在玩、谁几场几胜", 让玩家自己判断;
//   4. 纯函数, 无 DOM / 无 IO, 可在 node 里断言。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  if (root) root.PoroEnemyIntel = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const MIN_GAMES = 3;          // 单个对手至少这么多场才计入
  const POOL_LIMIT = 2;         // 每个对手取最常用的前 N 个英雄
  const BAN_LIMIT = 3;          // 最多给几个 ban 候选

  function normRecent(recent) {
    return Array.isArray(recent) ? recent.filter(r => r && +r.champId) : [];
  }

  // 单个玩家的英雄池: 按使用次数降序, 次数相同看胜场
  function poolOf(recent, limit) {
    const rows = normRecent(recent);
    const map = new Map();
    for (const r of rows) {
      const id = +r.champId;
      const cur = map.get(id) || { champId: id, games: 0, wins: 0 };
      cur.games++;
      if (r.win === true || r.win === 'Win') cur.wins++;
      map.set(id, cur);
    }
    const list = [...map.values()].sort((a, b) => b.games - a.games || b.wins - a.wins || a.champId - b.champId);
    return limit ? list.slice(0, limit) : list;
  }

  // 当前连胜/连败 (新局在前): { type: 'win'|'lose'|'', n }
  function streakOf(recent) {
    const rows = normRecent(recent);
    if (!rows.length) return { type: '', n: 0 };
    const isWin = r => r.win === true || r.win === 'Win';
    const type = isWin(rows[0]) ? 'win' : 'lose';
    let n = 0;
    for (const r of rows) { if (isWin(r) === (type === 'win')) n++; else break; }
    return { type, n };
  }

  // 单个对手的画像
  function buildOne(p, champName) {
    const recent = normRecent(p.recent);
    const games = recent.length;
    const wins = recent.filter(r => r.win === true || r.win === 'Win').length;
    const pool = poolOf(recent, POOL_LIMIT).map(c => Object.assign({}, c, {
      name: (champName && champName(c.champId)) || ('#' + c.champId)
    }));
    return {
      puuid: p.puuid || '',
      name: p.name || '未知',
      games,
      wins,
      winRate: games ? Math.round(wins / games * 100) : null,
      streak: streakOf(recent),
      pool
    };
  }

  // ban 候选: 跨对手累加同一英雄的使用次数。
  // 分数只用三件可查证的事: 多少人在玩 / 一共玩了几场 / 在这些场次里赢了几场。
  function banRows(enemies) {
    const map = new Map();
    for (const e of enemies) {
      if (e.games < MIN_GAMES) continue;
      for (const c of e.pool) {
        const cur = map.get(c.champId) || { champId: c.champId, name: c.name, owners: 0, games: 0, wins: 0, who: [] };
        cur.owners++;
        cur.games += c.games;
        cur.wins += c.wins;
        cur.who.push({ name: e.name, games: c.games, wins: c.wins });
        map.set(c.champId, cur);
      }
    }
    const rows = [...map.values()].map(r => {
      // 多人都在玩 > 一个人玩得多; 赢得多再加权
      const score = r.owners * 10 + r.games * 2 + r.wins;
      return Object.assign(r, {
        score,
        winRate: r.games ? Math.round(r.wins / r.games * 100) : null,
        reason: r.owners > 1
          ? `${r.owners} 人合计 ${r.games} 场`
          : `${r.who[0].name} ${r.who[0].games} 场 ${r.who[0].wins} 胜`
      });
    });
    rows.sort((a, b) => b.score - a.score || b.games - a.games || a.champId - b.champId);
    return rows;
  }

  /**
   * @param {Array} players 实时页的玩家数组 (含 team / recent / name / puuid)
   * @param {{ selfTeam?: number, champName?: (id:number)=>string }} opts
   * @returns {{ enemies: Array, bans: Array, sample: number, enough: boolean }}
   */
  function build(players, opts) {
    const o = opts || {};
    const selfTeam = o.selfTeam === 200 ? 200 : (o.selfTeam === 100 ? 100 : 0);
    const list = Array.isArray(players) ? players : [];
    const enemies = [];
    for (const p of list) {
      if (!p) continue;
      const team = +p.team;
      if (selfTeam && team && team === selfTeam) continue;     // 队友跳过
      if (selfTeam && !team) continue;                          // 队伍未知的不猜
      enemies.push(buildOne(p, o.champName));
    }
    // 全都拿不到战绩时不要硬凑建议
    const sample = enemies.filter(e => e.games >= MIN_GAMES).length;
    const bans = sample ? banRows(enemies).slice(0, BAN_LIMIT) : [];
    return { enemies, bans, sample, enough: sample > 0 };
  }

  // ---------- 渲染 ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function streakText(st) {
    if (!st || !st.n || !st.type) return '';
    return st.type === 'win' ? `${st.n} 连胜` : `${st.n} 连败`;
  }

  /**
   * @param {ReturnType<typeof build>} intel
   * @returns {string} HTML; 无数据时返回空串 (不占位)
   */
  function render(intel) {
    if (!intel || !intel.enough) return '';
    const head = `<div class="ei-head"><b>对手情报</b><span>${intel.enemies.filter(e => e.games).length} 名对手有近期战绩</span></div>`;
    const banLine = intel.bans.length
      ? `<div class="ei-bans"><span class="ei-ban-label">优先考虑 ban</span>${intel.bans.map(b =>
          `<span class="ei-ban"><b>${esc(b.name)}</b><i>${esc(b.reason)}</i></span>`).join('')}</div>`
      : '';
    const rows = intel.enemies
      .filter(e => e.games)
      .map(e => {
        const pool = e.pool.map(c => `<span class="ei-champ" title="${esc(c.name)} ${c.games} 场 ${c.wins} 胜">${esc(c.name)}<i>${c.games}</i></span>`).join('');
        const st = streakText(e.streak);
        return `<div class="ei-row">
          <span class="ei-name">${esc(e.name)}</span>
          <span class="ei-pool">${pool}</span>
          <span class="ei-wr">${e.winRate == null ? '--' : e.winRate + '%'}<i>${e.wins}/${e.games}</i></span>
          ${st ? `<span class="ei-streak ${e.streak.type === 'win' ? 'up' : 'down'}">${esc(st)}</span>` : '<span class="ei-streak"></span>'}
        </div>`;
      }).join('');
    return `<section class="ei-card">${head}${banLine}<div class="ei-list">${rows}</div></section>`;
  }

  return { build, render, poolOf, streakOf, banRows, MIN_GAMES };
});
