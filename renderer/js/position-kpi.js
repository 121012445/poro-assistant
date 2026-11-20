// 位置专属 KPI 卡 —— 不同分路看不同的四个指标。
//
// 背景: 原先所有人的卡片都是同一组标签 (输出/承伤/参团), 辅助位会被判成
// "输出乏力 / 伤转偏低" —— 那是拿中单的尺子量辅助。1.6.29 先给标签做了
// 辅助分支, 这里把口径固定成"每个位置一组 KPI", 五个位置各不相同。
//
// 数据来源: live.js 已为每名玩家拉过近 20 场 (p.recent), 每行含
//   k/d/a、cs、dur、dmgPct、tankPct、goldPct、kp、vision、dmgGold
// 本模块只做聚合, 不发任何请求; 无 DOM 依赖, 可在 node 里断言。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  // window.X 形式既是浏览器里的真实赋值, 也让静态检查 (test_undef_globals) 认得出这个名字
  if (typeof window !== 'undefined') window.PoroPositionKpi = api;
  else if (root) root.PoroPositionKpi = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // LCU/SGP 给的是大写下划线枚举; 也别把 SUPPORT/MID/ADC 漏掉 (历史别名)
  const POS_CN = {
    TOP: '上单', JUNGLE: '打野', MIDDLE: '中单', BOTTOM: '下路', UTILITY: '辅助',
    MID: '中单', ADC: '下路', SUPPORT: '辅助'
  };

  function normPosition(raw) {
    const s = String(raw || '').trim().toUpperCase();
    if (POS_CN[s] && ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'].includes(s)) return s;
    if (s === 'MID') return 'MIDDLE';
    if (s === 'ADC') return 'BOTTOM';
    if (s === 'SUPPORT') return 'UTILITY';
    if (s === 'JUG') return 'JUNGLE';
    return '';
  }

  // 指标定义: ref = [中位线, 优秀线]。阈值是经验值 (按各位置常见分布设的参考带),
  // 不是官方统计, 页面上写成"参考区间", 不给"合格/不合格"的判定。
  const METRICS = {
    kda:    { label: 'KDA',     ref: [2.0, 3.4],  fmt: v => v.toFixed(2) },
    kp:     { label: '参团率',  ref: [45, 62],    fmt: v => Math.round(v) + '%' },
    cspm:   { label: '补刀/分', ref: [4.6, 6.6],  fmt: v => v.toFixed(1) },
    dmgPct: { label: '伤害占比', ref: [18, 25],    fmt: v => Math.round(v) + '%' },
    tankPct:{ label: '承伤占比', ref: [17, 25],    fmt: v => Math.round(v) + '%' },
    vspm:   { label: '视野/分', ref: [0.75, 1.35], fmt: v => v.toFixed(2) },
    goldPct:{ label: '经济占比', ref: [18, 24],    fmt: v => Math.round(v) + '%' },
    dmgGold:{ label: '伤转',    ref: [85, 115],   fmt: v => Math.round(v) + '%' }
  };

  // 每个位置四个指标: 前两个是该位置的"本职指标", 后两个是通用项。
  const BY_POS = {
    TOP:     ['tankPct', 'cspm', 'kp', 'kda'],
    JUNGLE:  ['kp', 'vspm', 'kda', 'dmgPct'],
    MIDDLE:  ['dmgPct', 'cspm', 'kp', 'kda'],
    BOTTOM:  ['dmgPct', 'cspm', 'kp', 'kda'],
    UTILITY: ['vspm', 'kp', 'tankPct', 'kda'],
    DEFAULT: ['kda', 'kp', 'dmgPct', 'cspm']
  };

  const MIN_SAMPLE = 4;   // 少于 4 场不出 KPI, 避免一局定生死

  // null/空串必须回 null 而不是 0 —— 否则"队友数据缺失"的占比会被当成 0 拉低均值
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // 把 recent[] 聚合成一组均值。占比类字段在"队友数据缺失"时是 null, 聚合时跳过而不是当 0。
  function aggregate(recent) {
    const rows = Array.isArray(recent) ? recent.filter(r => r && !r.__error) : [];
    const acc = { n: 0, k: 0, d: 0, a: 0, cs: 0, dur: 0, kp: 0, kpN: 0, dmgPct: 0, dmgN: 0,
      tankPct: 0, tankN: 0, goldPct: 0, goldN: 0, vision: 0, visionN: 0, dmgGold: 0, dgN: 0 };
    for (const r of rows) {
      acc.n += 1;
      acc.k += num(r.k) || 0; acc.d += num(r.d) || 0; acc.a += num(r.a) || 0;
      acc.cs += num(r.cs) || 0; acc.dur += num(r.dur) || 0;
      const kp = num(r.kp); if (kp != null) { acc.kp += kp; acc.kpN += 1; }
      const dp = num(r.dmgPct); if (dp != null) { acc.dmgPct += dp; acc.dmgN += 1; }
      const tp = num(r.tankPct); if (tp != null) { acc.tankPct += tp; acc.tankN += 1; }
      const gp = num(r.goldPct); if (gp != null) { acc.goldPct += gp; acc.goldN += 1; }
      const vs = num(r.vision); if (vs != null && num(r.dur) > 0) { acc.vision += vs / (num(r.dur) / 60); acc.visionN += 1; }
      const dg = num(r.dmgGold); if (dg != null) { acc.dgN += 1; acc.dmgGold += dg; }
    }
    const avg = (sum, n) => (n > 0 ? sum / n : null);
    return {
      games: acc.n,
      kda: acc.n ? (acc.k + acc.a) / Math.max(1, acc.d) : null,
      cspm: acc.dur > 0 ? acc.cs / (acc.dur / 60) : null,
      kp: avg(acc.kp, acc.kpN),
      dmgPct: avg(acc.dmgPct, acc.dmgN),
      tankPct: avg(acc.tankPct, acc.tankN),
      goldPct: avg(acc.goldPct, acc.goldN),
      vspm: avg(acc.vision, acc.visionN),
      dmgGold: avg(acc.dmgGold, acc.dgN)
    };
  }

  function toneOf(value, ref) {
    if (value == null) return 'none';
    if (value >= ref[1]) return 'good';
    if (value >= ref[0]) return 'ok';
    return 'weak';
  }

  /**
   * @param {Array} recent 近 N 场
   * @param {string} position LCU 位置枚举 (可为空)
   * @param {object} [opts] { prefer: 'UTILITY', ref: { kda: [中位, 优秀] } }
   *   ref 由 rank-bench.js 按段位算出来 (OP.GG 只覆盖 KDA), 传进来就顶掉 METRICS 里的经验值
   * @returns {Array<{key,label,text,tone,value,samples,ref}>}
   */
  function kpis(recent, position, opts) {
    const pos = normPosition(position) || normPosition(opts && opts.prefer) || '';
    const agg = aggregate(recent);
    if (agg.games < MIN_SAMPLE) return [];
    const keys = BY_POS[pos] || BY_POS.DEFAULT;
    const override = (opts && opts.ref) || null;
    const out = [];
    for (const key of keys) {
      const m = METRICS[key];
      if (!m) continue;
      const value = agg[key];
      if (value == null) continue;      // 该指标在这个样本里算不出来 → 整条不出
      const ref = override && Array.isArray(override[key]) && override[key].length === 2 ? override[key] : m.ref;
      out.push({
        key,
        label: m.label,
        text: m.fmt(value),
        value: Math.round(value * 100) / 100,
        tone: toneOf(value, ref),
        samples: key === 'kp' || key === 'dmgPct' || key === 'tankPct' || key === 'goldPct' || key === 'vspm' || key === 'dmgGold' ? agg.games : agg.games,
        ref,
        refSrc: ref === m.ref ? 'local' : 'opgg'
      });
    }
    return out;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function html(recent, position, opts) {
    const rows = kpis(recent, position, opts);
    if (!rows.length) return '';
    const pos = normPosition(position) || normPosition(opts && opts.prefer);
    const head = `<span class="pk-pos">${esc(POS_CN[pos] || '未知位置')}</span>`;
    return `<div class="pk-row" title="近 ${rows[0].samples} 场均值；阈值是参考带，不是官方统计">${head}` +
      rows.map(r => {
        const tip = `${r.label} 参考带 ${r.ref[0]}–${r.ref[1]}` + (r.refSrc === 'opgg' ? '（同段位，OP.GG）' : '（本地经验值）');
        return `<span class="pk-item pk-${r.tone}" title="${esc(tip)}"><i>${esc(r.label)}</i><b>${esc(r.text)}</b></span>`;
      }).join('') +
      '</div>';
  }

  return { kpis, html, aggregate, normPosition, toneOf, METRICS, BY_POS, POS_CN, MIN_SAMPLE };
});
