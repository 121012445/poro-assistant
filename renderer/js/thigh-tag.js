// 大腿标签判定 (实时对局卡片) —— 1.6.60 起不再"只看胜率"
//
// 旧口径: 近 14 场胜率 ≥65% 就贴「大腿」。问题是胜率是**团队结果**:
// 被队友带赢的人胜率同样高, 但个人战绩可能很难看 (死得多、输出低),
// 贴上去反而是误导 —— 你会照着它去打, 结果它比你还惨。
//
// 新口径: 主判据是**加权 KDA**, 助攻按半次计 (ASSIST_WEIGHT = 0.5)。
//   标准 KDA 的 (K+A)/D 里助攻与击杀等权, 而助攻是最容易"刷"的一项
//   (辅助站后排丢技能、参团蹭助攻), 全额计权会把混子抬成大腿;
//   压到 0.5 让"亲手拿人头"才是主要加分项。
// 胜率降为兜底门槛 (≥50%): 杀得多但一直输, 说明人头换不来胜势, 也不该封大腿。
//
// 纯函数, 无 DOM / 无 IO, 可在 node 里直接断言。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  if (typeof window !== 'undefined') window.PoroThigh = api;
  else if (root) root.PoroThigh = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const ASSIST_WEIGHT = 0.5;   // 助攻权重: 标准 KDA 是 1.0, 这里压到半次
  const MIN_GAMES = 14;        // 与旧口径一致, 少于 14 场统计噪声太大
  const MIN_WR = 50;           // 胜率兜底: 赢不了的人不叫大腿
  const MIN_WKDA = 2.4;        // 加权 KDA 门槛 (约等于标准 KDA 3.0 / 0.5 权重下的中上水准)

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  // recent 行里短名字段是 k/d/a (live.js 聚合口径), 长名是 SGP 原始字段, 两者都认
  function field(r, short, long) {
    const v = r[short] != null ? r[short] : r[long];
    return num(v);
  }
  function r1(n) { return Math.round(n * 10) / 10; }

  function judge(recent) {
    const list = Array.isArray(recent) ? recent.filter(r => r && typeof r === 'object') : [];
    const games = list.length;
    if (!games) return { hit: false, games: 0, reason: '没有对局样本' };

    let K = 0, D = 0, A = 0;
    let hasKA = false, hasD = false;
    for (const r of list) {
      const k = field(r, 'k', 'kills');
      const d = field(r, 'd', 'deaths');
      const a = field(r, 'a', 'assists');
      if (k != null || a != null) hasKA = true;
      if (d != null) hasD = true;
      K += k || 0; D += d || 0; A += a || 0;
    }
    // 字段缺失时 D 会全是 0, 除下去 KDA 会虚高到几十 —— 宁可不出标签
    if (!hasKA || !hasD) return { hit: false, games, reason: '缺少击杀/死亡数据' };
    if (games < MIN_GAMES) return { hit: false, games, reason: `样本不足 (${games} 场)` };

    const wins = list.filter(r => r.win === true || r.win === 'Win').length;
    const wr = Math.round(wins / games * 100);
    const denom = Math.max(1, D);
    const kda = (K + A) / denom;                        // 标准口径, 仅用于展示
    const wkda = (K + A * ASSIST_WEIGHT) / denom;       // 判定口径
    const info = {
      hit: false,
      games, wins, wr,
      kda: r1(kda),
      wkda: r1(wkda),
      avgK: r1(K / games),
      avgD: r1(D / games),
      avgA: r1(A / games),
      reason: ''
    };
    if (wr < MIN_WR) {
      info.reason = `胜率 ${wr}% 不到 ${MIN_WR}%`;
      return info;
    }
    if (info.wkda < MIN_WKDA) {
      info.reason = `加权 KDA ${info.wkda} 不到 ${MIN_WKDA}`;
      return info;
    }
    info.hit = true;
    info.tip = `近 ${games} 场 ${wins} 胜 ${wr}%｜加权 KDA ${info.wkda}`
      + `（场均 ${info.avgK}/${info.avgD}/${info.avgA}，助攻按半次计）`
      + ' — 个人战绩硬，前期多照顾他一路';
    return info;
  }

  return { judge, ASSIST_WEIGHT, MIN_GAMES, MIN_WR, MIN_WKDA };
});
