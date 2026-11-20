// 挑战徽章：把客户端的挑战积分做成卡片右上角那枚小徽章。
//
// 数据来源只有一条: GET /lol-challenges/v1/summary-player-data/local-player
//   → { overallChallengeLevel, overallChallengePoints, categoryProgress: [...] }
// **只对"本机玩家"可用**。LCU 没有给任意 puuid 直接读挑战分的公开路径,
// 所以这枚徽章只挂在自己那张卡上 —— 给对手/队友乱贴分数是编数据, 不做。
//
// 等级与积分的字段名在不同版本里有过变化(overallChallengeLevel / challengeLevel),
// 取不到就返回 null, 界面整块隐藏, 不显示 0。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  if (typeof window !== 'undefined') window.PoroChallenge = api; else if (root) root.PoroChallenge = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // factory 与 IIFE 的参数不在同一作用域: 全局对象要自己取一次
  const GLOB = (typeof window !== 'undefined') ? window : (typeof global !== 'undefined' ? global : {});

  const TTL = 30 * 60 * 1000;   // 挑战分一天变不了几次, 半小时的缓存足够
  let cache = { t: 0, data: null, pending: null };

  function parse(raw) {
    if (!raw || raw.__error || typeof raw !== 'object') return null;
    const level = Number(raw.overallChallengeLevel != null ? raw.overallChallengeLevel : raw.challengeLevel);
    const points = Number(raw.overallChallengePoints != null ? raw.overallChallengePoints
      : (raw.challengePoints != null ? raw.challengePoints : raw.totalPoints));
    const lv = Number.isFinite(level) && level > 0 ? level : 0;
    const pts = Number.isFinite(points) && points > 0 ? points : 0;
    if (!lv && !pts) return null;
    return {
      level: lv,
      points: pts,
      // 分类进度只用来做 tooltip，不参与打分
      categories: Array.isArray(raw.categoryProgress) ? raw.categoryProgress.length : 0
    };
  }

  function fmtPoints(points) {
    const p = Number(points) || 0;
    if (p >= 10000) return Math.round(p / 1000) + 'k';
    if (p >= 1000) return (p / 1000).toFixed(1) + 'k';
    return String(p);
  }

  // 只按等级给颜色, 不给"青铜/钻石"这类段位名 —— 客户端没有提供名字,
  // 自己编一套映射等于替官方下定义。
  function tierClass(level) {
    const lv = Number(level) || 0;
    if (lv >= 7) return 'chg-hi';
    if (lv >= 5) return 'chg-mid';
    if (lv >= 3) return 'chg-low';
    return 'chg-base';
  }

  function html(data, opts) {
    const d = data || cache.data;
    if (!d) return '';
    const o = opts || {};
    const title = (d.level ? '挑战等级 ' + d.level + ' · ' : '') + '积分 ' + d.points
      + (o.suffix ? ' · ' + o.suffix : '');
    return '<span class="chg-badge ' + tierClass(d.level) + '" title="' + String(title).replace(/"/g, '&quot;') + '">'
      + '◆' + fmtPoints(d.points) + '</span>';
  }

  function get() {
    if (cache.data && Date.now() - cache.t < TTL) return cache.data;
    return cache.data || null;    // 过期也先给旧的, 后台再刷
  }

  async function load(force) {
    const lcu = GLOB.lolAPI;
    if (!lcu || typeof lcu.lcuRequest !== 'function') return null;
    if (!force && cache.data && Date.now() - cache.t < TTL) return cache.data;
    if (cache.pending) return cache.pending;
    cache.pending = (async () => {
      try {
        const raw = await lcu.lcuRequest('GET', '/lol-challenges/v1/summary-player-data/local-player');
        const data = parse(raw);
        if (data) { cache.data = data; cache.t = Date.now(); }
        return data;
      } catch (e) {
        return cache.data || null;
      } finally {
        cache.pending = null;
      }
    })();
    return cache.pending;
  }

  function reset() { cache = { t: 0, data: null, pending: null }; }

  return { TTL, parse, fmtPoints, tierClass, html, get, load, reset };
});
