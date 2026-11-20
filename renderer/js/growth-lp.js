// LP 曲线 + 升段预估
//
// 之前成长页只有"胜负/胜率"的趋势, 没有 LP —— 因为 LP 从来没被存下来过。
// 这里补上采样: 每次首页拉到排位条目 (leaguePoints) 就记一个点, 按账号隔离,
// 同一天同一队列只留最后一个点 (避免刷新页面刷出锯齿)。
//
// 画图用 SVG 而不是 canvas: 复盘页的 canvas 曾经因为 display:none 下 clientWidth=0
// 与 devicePixelRatio 对不齐被拉长过一次 (§1.6.29 修过), SVG 用 viewBox 就没这问题。
//
// 预估口径 (页面上必须写清楚):
//   线性拟合最近 N 天采样 → LP/天 → 距下一段还差多少 LP → 需要几天。
//   是"按最近速度外推", 不是胜率模型, 不承诺一定到。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  // window.X 形式既是浏览器里的真实赋值, 也让静态检查 (test_undef_globals) 认得出这个名字
  if (typeof window !== 'undefined') window.PoroLp = api;
  else if (root) root.PoroLp = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
  const TIER_CN = { IRON: '黑铁', BRONZE: '青铜', SILVER: '白银', GOLD: '黄金', PLATINUM: '铂金', EMERALD: '翡翠', DIAMOND: '钻石', MASTER: '大师', GRANDMASTER: '宗师', CHALLENGER: '王者' };
  const DIVS = ['IV', 'III', 'II', 'I'];
  const MAX_SAMPLES = 400;

  function tierIndex(tier) {
    const i = TIERS.indexOf(String(tier || '').toUpperCase());
    return i < 0 ? -1 : i;
  }
  function divIndex(div) {
    const i = DIVS.indexOf(String(div || '').toUpperCase());
    return i < 0 ? 0 : i;
  }

  // 绝对 LP: 每段 100 LP, 每大段 4 小段 (大师以上不设小段, 直接用 LP)
  function absLp(entry) {
    if (!entry) return null;
    const t = tierIndex(entry.tier);
    if (t < 0) return null;
    const lp = Math.max(0, Math.min(9999, Number(entry.leaguePoints) || 0));
    if (t >= TIERS.indexOf('MASTER')) return t * 400 + lp;
    return t * 400 + divIndex(entry.division) * 100 + lp;
  }

  function labelOf(entry) {
    if (!entry) return '';
    const t = tierIndex(entry.tier);
    if (t < 0) return '无段位';
    const cn = TIER_CN[String(entry.tier).toUpperCase()] || entry.tier;
    const d = t >= TIERS.indexOf('MASTER') ? '' : String(entry.division || '').toUpperCase();
    return cn + d + ' ' + (Number(entry.leaguePoints) || 0) + 'LP';
  }

  // 下一段门槛 (绝对 LP)
  function nextMilestone(entry) {
    const a = absLp(entry);
    if (a == null) return null;
    const t = tierIndex(entry.tier);
    const isApex = t >= TIERS.indexOf('MASTER');
    const base = isApex ? t * 400 : t * 400 + divIndex(entry.division) * 100;
    const next = isApex ? (t + 1) * 400 : base + 100;
    return { next, need: Math.max(0, next - a) };
  }

  function dayKey(ts) { return new Date(ts).toISOString().slice(0, 10); }

  /**
   * 追加采样 (同一天同队列只保留最后一个)
   * @param {Array} list 旧列表
   * @param {{t:number, queue:string, tier:string, division:string, leaguePoints:number}} sample
   */
  function appendSample(list, sample) {
    const arr = Array.isArray(list) ? list.slice() : [];
    const s = sample && sample.t ? sample : Object.assign({}, sample, { t: Date.now() });
    if (absLp(s) == null) return arr;
    const key = s.queue || 'RANKED_SOLO_5x5';
    const day = dayKey(s.t);
    const idx = arr.findIndex(x => (x.queue || 'RANKED_SOLO_5x5') === key && dayKey(x.t) === day);
    const rec = { t: s.t, queue: key, tier: s.tier, division: s.division || '', leaguePoints: Number(s.leaguePoints) || 0, abs: absLp(s) };
    if (idx >= 0) arr[idx] = rec; else arr.push(rec);
    arr.sort((a, b) => a.t - b.t);
    return arr.length > MAX_SAMPLES ? arr.slice(arr.length - MAX_SAMPLES) : arr;
  }

  function series(list, queueKey) {
    const key = queueKey || 'RANKED_SOLO_5x5';
    return (Array.isArray(list) ? list : [])
      .filter(x => (x.queue || 'RANKED_SOLO_5x5') === key && Number.isFinite(Number(x.abs)))
      .sort((a, b) => a.t - b.t)
      .map(x => ({ t: Number(x.t), abs: Number(x.abs), tier: x.tier, division: x.division, lp: Number(x.leaguePoints) || 0 }));
  }

  // 最近 days 天的采样 (不足则全给)
  function recentOf(points, days, now) {
    const t = now || Date.now();
    const from = t - (days || 30) * 86400000;
    const out = points.filter(p => p.t >= from);
    return out.length >= 2 ? out : points.slice(-Math.min(points.length, 10));
  }

  // 最小二乘: 返回 LP/天
  function slopePerDay(points) {
    const n = points.length;
    if (n < 2) return null;
    const t0 = points[0].t;
    const xs = points.map(p => (p.t - t0) / 86400000);
    const ys = points.map(p => p.abs);
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    if (!den) return null;
    return Math.round((num / den) * 100) / 100;
  }

  /**
   * @param {Array} points series() 的输出
   * @param {object} opts { now, days, latest(entry) }
   */
  function forecast(points, opts) {
    const o = opts || {};
    if (!Array.isArray(points) || points.length < 2) return { ready: false, reason: 'LP 采样还不够，至少需要两天数据' };
    const recent = recentOf(points, o.days || 30, o.now);
    const rate = slopePerDay(recent);
    const last = points[points.length - 1];
    const rawMs = o.latest || { tier: last.tier, division: last.division, leaguePoints: last.lp };
    const mile = nextMilestone(rawMs) || nextMilestone(last);
    if (rate == null || !mile) return { ready: false, reason: '样本不足以拟合趋势' };
    const days = rate > 0 ? Math.ceil(mile.need / rate) : null;
    const spanDays = Math.max(1, Math.round((recent[recent.length - 1].t - recent[0].t) / 86400000));
    return {
      ready: true,
      rate,                       // LP/天
      spanDays,
      need: mile.need,
      days,
      samples: recent.length,
      delta: Math.round((last.abs - recent[0].abs) * 10) / 10,
      verdict: rate > 1 ? '在涨' : rate < -1 ? '在掉' : '基本横盘'
    };
  }

  function fmtAbs(abs) {
    const v = Math.round(abs);
    const t = Math.floor(v / 400);
    if (t < 0 || t >= TIERS.length) return String(v);
    const rest = v - t * 400;
    const cn = TIER_CN[TIERS[t]];
    if (t >= TIERS.indexOf('MASTER')) return cn + ' ' + rest + 'LP';
    return cn + DIVS[Math.min(3, Math.floor(rest / 100))] + ' ' + (rest % 100) + 'LP';
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // SVG 折线: width 固定 640 (随容器 100% 缩放), 高度 160
  function svg(points, opts) {
    const o = opts || {};
    if (!Array.isArray(points) || points.length < 2) return '';
    const W = 640, H = 160, PAD = 8;
    const xs = points.map(p => p.t), ys = points.map(p => p.abs);
    const tMin = Math.min(...xs), tMax = Math.max(...xs);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    const spanT = Math.max(1, tMax - tMin);
    const spanY = Math.max(1, yMax - yMin);
    const px = t => PAD + ((t - tMin) / spanT) * (W - PAD * 2);
    const py = v => H - PAD - ((v - yMin) / spanY) * (H - PAD * 2 - 12);
    const pts = points.map(p => px(p.t).toFixed(1) + ',' + py(p.abs).toFixed(1)).join(' ');
    const up = ys[ys.length - 1] >= ys[0];
    const stroke = up ? '#58b98d' : '#d97070';
    const area = `0,${H} ` + pts + ` ${W},${H}`;
    return `<svg class="lpc-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="LP 曲线">
      <polygon points="${area}" fill="${up ? '#58b98d1f' : '#d970701f'}"></polygon>
      <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"></polyline>
      ${o.dot === false ? '' : `<circle cx="${px(tMax).toFixed(1)}" cy="${py(ys[ys.length - 1]).toFixed(1)}" r="2.6" fill="${stroke}"></circle>`}
    </svg>`;
  }

  // ---------- 运行时 (渲染层): 采样读写 + 面板 ----------
  const STORE_KEY = 'lpHistory';

  function readList() {
    try {
      const k = (typeof accountStoreKey === 'function') ? accountStoreKey(STORE_KEY) : STORE_KEY;
      const raw = storeGet(k);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function writeList(list) {
    try {
      const k = (typeof accountStoreKey === 'function') ? accountStoreKey(STORE_KEY) : STORE_KEY;
      storeSet(k, JSON.stringify(list));
    } catch (e) {}
  }

  function record(queue, entry) {
    if (!entry || !entry.tier) return;
    const list = appendSample(readList(), {
      t: Date.now(), queue,
      tier: entry.tier, division: entry.division, leaguePoints: entry.leaguePoints
    });
    writeList(list);
  }

  function panelHtml() {
    const list = readList();
    const solo = series(list, 'RANKED_SOLO_5x5');
    if (solo.length < 2) {
      return `<div class="lpc-empty">LP 曲线需要至少两天的排位采样。每次打开首页会自动记一个点，明天再看就有线了。</div>`;
    }
    const pts = recentOf(solo, 90);
    const f = forecast(solo, { days: 30 });
    const first = pts[0], last = pts[pts.length - 1];
    const delta = Math.round((last.abs - first.abs) * 10) / 10;
    const spanDays = Math.max(1, Math.round((last.t - first.t) / 86400000));
    const fc = f.ready
      ? `<span class="lpc-fc">最近 ${f.spanDays} 天 <b class="${f.rate >= 0 ? 'up' : 'down'}">${f.rate > 0 ? '+' : ''}${f.rate} LP/天</b> · 距下一段 ${f.need} LP${f.days != null ? ` · 约 ${f.days} 天` : ''}</span>`
      : `<span class="lpc-fc muted">${esc(f.reason)}</span>`;
    return `<div class="lpc-head"><b>LP 曲线</b><span class="lpc-range">${esc(fmtAbs(first.abs))} → ${esc(fmtAbs(last.abs))}<i class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : ''}${delta}</i><em>${spanDays} 天</em></span></div>
      ${svg(pts)}
      <div class="lpc-foot">${fc}<span class="lpc-note">按采样线性外推，不是胜率模型</span></div>`;
  }

  return { TIERS, TIER_CN, absLp, labelOf, nextMilestone, appendSample, series, recentOf, slopePerDay, forecast, svg, fmtAbs, record, panelHtml, readList, MAX_SAMPLES };
});
