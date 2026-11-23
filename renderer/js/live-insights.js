'use strict';
// 实时页/成长页的纯计算逻辑（不碰 DOM、不发请求），单测友好。
//   ① augmentCombos  —— 海斗强化组合台账：组合 -> 场次/胜率（样本不足只出场次）
//   ② filterLedger   —— 战绩库检索：按英雄/模式/胜负/天数筛选本机台账
//   ③ ledgerStats    —— 台账统计（胜率/KDA/场均死亡/伤害占比/参团/视野），无分母时返回 null
//   ④ watchTarget    —— 敌方"最该盯的一个人"：近 20 场伤害占比中位数最高者（样本门槛）
//   ⑤ teamBrief      —— 本局 10 人简报，纯文本，一键复制到开黑群
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PoroInsights = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_MIN = 8;   // 与 player-habits / repeat-mistakes 保持同一门槛

  // 队列号 -> 模式族。海克斯大乱斗 2400，极地大乱斗 450，斗魂竞技场 1700/1710。
  function queueFamily(q) {
    const n = Number(q) || 0;
    if (n === 2400) return 'mayhem';
    if (n === 450) return 'aram';
    if (n === 1700 || n === 1710) return 'arena';
    return 'rift';
  }

  const nums = list => (Array.isArray(list) ? list : []).map(Number).filter(n => Number.isFinite(n));
  function mean(list) {
    const v = nums(list);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  }
  function median(list) {
    const v = nums(list).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  const round1 = n => (n == null ? null : Math.round(n * 10) / 10);
  const round2 = n => (n == null ? null : Math.round(n * 100) / 100);

  // ③ 台账统计。任何指标都自带分母（n / 参与统计的场次），样本不足返回 null。
  function ledgerStats(rows) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    const n = list.length;
    if (!n) return { n: 0, wins: 0, wr: null, kda: null, dAvg: null, dmgN: 0, dmgAvg: null, kpN: 0, kpAvg: null, visN: 0, visAvg: null };
    let wins = 0, k = 0, d = 0, a = 0, dur = 0;
    const dmg = [], kp = [], vis = [];
    // 判"有没有这个值"必须先看 null/undefined: +null === 0 且 isFinite(0) 为真,
    // 只判 isFinite(+字段) 会把整列缺失当成一堆 0, 均值算出来就是 0%。
    const num = v => (v == null || !Number.isFinite(+v)) ? null : +v;
    for (const r of list) {
      if (r.w) wins++;
      k += +r.k || 0; d += +r.d || 0; a += +r.a || 0; dur += +r.dur || 0;
      const dv = num(r.dmg), kv = num(r.kp), vv = num(r.vis);
      if (dv != null) dmg.push(dv);
      if (kv != null) kp.push(kv);
      if (vv != null) vis.push(vv);
    }
    return {
      n, wins,
      wr: Math.round(wins / n * 100),
      kda: round2((k + a) / Math.max(1, d)),
      dAvg: round1(d / n),
      durMin: dur > 0 ? round1(dur / 60 / n) : null,
      dmgN: dmg.length, dmgAvg: round1(mean(dmg)),
      kpN: kp.length, kpAvg: round1(mean(kp)),
      visN: vis.length, visAvg: round1(mean(vis))
    };
  }

  // ① 强化组合：同局 4~6 个强化作为一套"组合"，按组合聚合场次/胜率。
  // 只统计条数 >= 2 的组合（单强化就是"只有 1 个强化"的残缺局，参考价值低）。
  function augmentCombos(rows, opts) {
    const o = opts || {};
    const minGames = Number.isFinite(+o.minGames) ? +o.minGames : DEFAULT_MIN;
    const map = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      const ids = nums(r && r.aug).slice().sort((a, b) => a - b);
      if (ids.length < 2) continue;
      const key = ids.join(',');
      const cur = map.get(key) || { key, ids, games: 0, wins: 0 };
      cur.games++;
      if (r.w) cur.wins++;
      map.set(key, cur);
    }
    const out = [...map.values()].map(c => ({
      ...c,
      // 样本不足只给场次，不给胜率 —— 和"拿不准就不输出"一个口径
      wr: c.games >= minGames ? Math.round(c.wins / c.games * 100) : null
    }));
    out.sort((x, y) => (y.games - x.games) || ((y.wr ?? -1) - (x.wr ?? -1)));
    return out;
  }

  // 单个强化在台账里的出现次数与胜率（用于"哪个强化你拿得多、赢得多"）
  function augmentUsage(rows, opts) {
    const o = opts || {};
    const minGames = Number.isFinite(+o.minGames) ? +o.minGames : DEFAULT_MIN;
    const map = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      for (const id of new Set(nums(r && r.aug))) {
        const cur = map.get(id) || { id, games: 0, wins: 0 };
        cur.games++;
        if (r.w) cur.wins++;
        map.set(id, cur);
      }
    }
    const out = [...map.values()].map(c => ({ ...c, wr: c.games >= minGames ? Math.round(c.wins / c.games * 100) : null }));
    out.sort((x, y) => (y.games - x.games) || ((y.wr ?? -1) - (x.wr ?? -1)));
    return out;
  }

  // ② 战绩库检索
  function filterLedger(rows, opts) {
    const o = opts || {};
    const now = Number.isFinite(+o.now) ? +o.now : Date.now();
    const days = Number.isFinite(+o.days) && +o.days > 0 ? +o.days : 0;
    const since = days ? now - days * 86400000 : 0;
    const champ = Number(o.champId) || 0;
    const family = o.family || '';
    const wantWin = o.win === true ? true : o.win === false ? false : null;
    return (Array.isArray(rows) ? rows : []).filter(r => {
      if (!r) return false;
      if (champ && +r.c !== champ) return false;
      if (family && queueFamily(r.q) !== family) return false;
      if (since && +r.t < since) return false;
      if (wantWin === true && !r.w) return false;
      if (wantWin === false && r.w) return false;
      return true;
    }).sort((a, b) => (+b.t || 0) - (+a.t || 0));
  }

  // ④ 敌方最该盯的人：只按"伤害占比中位数"排序，且要求该玩家样本 >= minGames。
  // 海斗没有对位，所以输出的是"最值得盯的人"，不是"你的对线对手"。
  function watchTarget(players, opts) {
    const o = opts || {};
    const minGames = Number.isFinite(+o.minGames) ? +o.minGames : 6;
    let best = null;
    for (const p of Array.isArray(players) ? players : []) {
      const recent = Array.isArray(p && p.recent) ? p.recent : [];
      const dmg = recent.map(r => +r.dmgPct).filter(n => Number.isFinite(n) && n > 0);
      const sample = dmg.length >= minGames ? dmg.length : 0;
      if (!sample) continue;
      const mid = median(dmg);
      if (mid == null) continue;
      const deaths = recent.map(r => +r.d).filter(n => Number.isFinite(n));
      const cand = {
        puuid: p.puuid || '',
        name: p.name || '',
        championId: +p.championId || 0,
        dmg: Math.round(mid),
        dmgGames: sample,
        deaths: deaths.length ? round1(mean(deaths)) : null,
        main: mainChampion(recent)
      };
      if (!best || cand.dmg > best.dmg) best = cand;
    }
    return best;
  }

  // 近 N 场玩得最多的英雄（并列时取更近出现的）
  function mainChampion(recent) {
    const list = Array.isArray(recent) ? recent : [];
    const map = new Map();
    for (const r of list) {
      const c = +((r && r.champId) || 0);
      if (!c) continue;
      map.set(c, (map.get(c) || 0) + 1);
    }
    let bestId = 0, bestN = 0;
    for (const [id, n] of map) if (n > bestN) { bestN = n; bestId = id; }
    return bestId ? { championId: bestId, games: bestN } : null;
  }

  // ⑤ 本局简报（纯文本）
  function teamBrief(data, selfPuuid, opts) {
    const o = opts || {};
    const list = Array.isArray(data) ? data.filter(Boolean) : [];
    if (!list.length) return '';
    const nameOf = id => (typeof o.championName === 'function' ? o.championName(id) : '');
    const teamStats = team => {
      const rows = list.filter(p => +p.team === team);
      let k = 0, d = 0, a = 0, matches = 0, wins = 0;
      for (const p of rows) for (const r of (p.recent || [])) {
        matches++; if (r.win) wins++;
        k += +r.k || 0; d += +r.d || 0; a += +r.a || 0;
      }
      return {
        n: rows.length, matches,
        wr: matches ? Math.round(wins / matches * 100) : null,
        kda: matches ? round2((k + a) / Math.max(1, d)) : null
      };
    };
    const lineOf = p => {
      const recent = Array.isArray(p.recent) ? p.recent : [];
      const matches = recent.length;
      const wins = recent.filter(r => r.win).length;
      let k = 0, d = 0, a = 0;
      for (const r of recent) { k += +r.k || 0; d += +r.d || 0; a += +r.a || 0; }
      const wr = matches ? Math.round(wins / matches * 100) : null;
      const kda = matches ? round2((k + a) / Math.max(1, d)) : null;
      const main = mainChampion(recent);
      const mainTxt = main ? (nameOf(main.championId) || ('#' + main.championId)) + ' ' + main.games + '场' : '';
      const parts = [
        (p.name || '未知') + (+p.team === 100 || p.team === 200 ? '' : ''),
        p.puuid && p.puuid === selfPuuid ? '（我）' : '',
        p.rank ? String(p.rank) : '无段位',
        wr == null ? '无战绩' : '近' + matches + '场 ' + wr + '%',
        kda == null ? '' : 'KDA ' + kda,
        mainTxt
      ].filter(Boolean);
      return '- ' + parts.join(' · ');
    };
    const mode = o.mode || '';
    const blue = teamStats(100), red = teamStats(200);
    const head = '【Poro 本局简报】' + (mode ? mode : '对局');
    const teamLine = (label, s) => label + ' ' + s.n + '人 · ' +
      (s.wr == null ? '战绩加载中' : '近战 ' + s.matches + ' 场 ' + s.wr + '% · KDA ' + s.kda);
    const bluePlayers = list.filter(p => +p.team === 100).map(lineOf);
    const redPlayers = list.filter(p => +p.team === 200).map(lineOf);
    const otherPlayers = list.filter(p => !(+p.team === 100) && !(+p.team === 200)).map(lineOf);
    const out = [head, teamLine('蓝方', blue), ...bluePlayers, teamLine('红方', red), ...redPlayers];
    if (otherPlayers.length) out.push('其他', ...otherPlayers);
    const groups = typeof o.premadeSummary === 'string' ? o.premadeSummary.trim() : '';
    if (groups) out.push('组队：' + groups);
    return out.join('\n');
  }

  return {
    DEFAULT_MIN, queueFamily, mean, median,
    ledgerStats, augmentCombos, augmentUsage, filterLedger, watchTarget, mainChampion, teamBrief
  };
});
