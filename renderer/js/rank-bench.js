// 同段位基准线 —— 用 OP.GG 的分段数据给"位置 KPI"换上真参考带。
//
// 为什么要它: position-kpi.js 里的参考带 (KDA 2.0–3.4 之类) 是经验值, 不分段位 ——
// 同样 2.5 的 KDA, 在白银算不错, 在钻石就是拖后腿。这里按你当前段位取真实分布。
//
// 数据能覆盖什么 (实测 OP.GG /api/{region}/champions/ranked?tier=xxx):
//   每个 (英雄, 分路) 只有 play / 胜率 / 登场率 / 禁用率 / KDA / 名次。
//   补刀、伤害占比、视野这些 OP.GG 不提供 —— 所以本模块只重写 KDA 的参考带,
//   其余指标继续用本地经验值, 页面上分两栏写明来源, 不混着算。
//
// 国服注意: OP.GG 不接受 region=cn ("Region was invalid"), 只能拿 global / kr 当参考。
// 面板上固定写明"全球服聚合", 不给"你和韩国钻石一样强"的暗示。
//
// 纯函数 + 一个加载器; 无 DOM 依赖, 可在 node 里断言。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  if (typeof window !== 'undefined') window.PoroRankBench = api;
  else if (root) root.PoroRankBench = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // LCU 段位枚举 → OP.GG 的 tier 参数 (实测 16 个取值都返回 173 个英雄)
  const TIER_PARAM = {
    IRON: 'iron', BRONZE: 'bronze', SILVER: 'silver', GOLD: 'gold', PLATINUM: 'platinum',
    EMERALD: 'emerald', DIAMOND: 'diamond', MASTER: 'master', GRANDMASTER: 'grandmaster', CHALLENGER: 'challenger'
  };
  const TIER_CN = {
    all: '全段位', iron: '黑铁', bronze: '青铜', silver: '白银', gold: '黄金', platinum: '铂金',
    emerald: '翡翠', diamond: '钻石', master: '大师', grandmaster: '宗师', challenger: '王者'
  };
  const POS_KEY = {
    TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MID', MID: 'MID',
    BOTTOM: 'ADC', ADC: 'ADC', UTILITY: 'SUPPORT', SUPPORT: 'SUPPORT'
  };
  const POS_CN = { TOP: '上单', JUNGLE: '打野', MID: '中单', ADC: '下路', SUPPORT: '辅助' };
  const POS_ORDER = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'];
  const REGION_CN = {
    global: '全球服', kr: '韩服', na: '美服', euw: '欧西', eune: '欧东', br: '巴西', jp: '日服',
    lan: '拉美北', las: '拉美南', oce: '大洋洲', ru: '俄服', tr: '土耳其', vn: '越南', tw: '台服', sg: '新加坡'
  };

  // 少于这么多场的英雄不参与分位数: 冷门英雄 KDA 抖动太大, 会把参考带拉歪
  const MIN_PLAY = 200;
  const MIN_CHAMPS = 8;     // 该位置有效英雄不到 8 个就认为这份数据不可用
  // 参考带 = 中位 × BAND_LOW ~ × BAND_HIGH。这是展示口径 (怎么算"好/弱"), 不是分位数,
  // 面板上明写系数, 不假装是从分布里统计出来的。
  const BAND_LOW = 0.95;
  const BAND_HIGH = 1.15;

  function tierParamOf(tier) {
    const key = String(tier || '').trim().toUpperCase();
    return TIER_PARAM[key] || 'all';
  }
  function posKeyOf(pos) {
    const key = String(pos || '').trim().toUpperCase();
    return POS_KEY[key] || '';
  }

  // 加权分位数: 按 KDA 升序累计场次, 落在第 q 分位的那一档。
  // 不用简单中位数——173 个英雄里冷门英雄一堆, 简单中位数会被它们主导。
  function weightedQuantile(rows, q) {
    const list = (Array.isArray(rows) ? rows : [])
      .filter(r => r && Number(r.kda) > 0 && Number(r.play) > 0)
      .sort((a, b) => a.kda - b.kda);
    const total = list.reduce((s, r) => s + Number(r.play), 0);
    if (!total) return null;
    const target = total * q;
    let acc = 0;
    for (const r of list) {
      acc += Number(r.play);
      if (acc >= target) return Number(r.kda);
    }
    return Number(list[list.length - 1].kda);
  }

  // 某位置所有英雄的条目
  function rowsOf(bench, posKey) {
    const champs = (bench && bench.champions) || {};
    const out = [];
    for (const id of Object.keys(champs)) {
      const row = champs[id] && champs[id][posKey];
      if (!row) continue;
      if (Number(row.play) < MIN_PLAY) continue;
      out.push({ championId: Number(id), play: Number(row.play), kda: Number(row.kda), rank: Number(row.rank) || 0 });
    }
    return out;
  }

  /**
   * 一个位置的基准。
   * 只给"中位数"一个实测值 —— 实测过 16 个段位: 各英雄平均 KDA 的分布非常集中
   * (铂金中单 75 分位 2.37 vs 中位 2.22, 只差 7%), 用 75 分位充当"优秀线"会让
   * 几乎所有人都是 good。所以这里不编分位数, 而是给出明确的换算口径:
   *   参考带 = 中位 × 0.95 ~ 中位 × 1.15 (高于上沿记好, 低于下沿记弱)
   * 系数写在面板注释和 tooltip 里, 用户能自己复核。
   * @returns {{mid:number, low:number, high:number, play:number, champs:number}|null}
   */
  function positionRef(bench, posKey) {
    const rows = rowsOf(bench, posKey);
    if (rows.length < MIN_CHAMPS) return null;
    const mid = weightedQuantile(rows, 0.5);
    if (mid == null || !(mid > 0)) return null;
    const play = rows.reduce((s, r) => s + r.play, 0);
    const r2 = v => Math.round(v * 100) / 100;
    return {
      mid: r2(mid),
      low: r2(mid * BAND_LOW),
      high: r2(mid * BAND_HIGH),
      play,
      champs: rows.length
    };
  }

  // 给 position-kpi 的 opts.ref 用: 只覆盖 KDA, 其它指标保持本地经验值
  function refFor(bench, pos) {
    const key = posKeyOf(pos);
    if (!key) return null;
    const r = positionRef(bench, key);
    if (!r) return null;
    return { kda: [r.low, r.high] };
  }

  // 单个英雄在该段位该位置的战绩
  function championRow(bench, championId, pos) {
    const key = posKeyOf(pos);
    const row = bench && bench.champions && bench.champions[Number(championId)];
    if (!key || !row || !row[key]) return null;
    return Object.assign({ position: key }, row[key]);
  }

  // 该位置名次最靠前的几个英雄 (rank 小 = 强)
  function strongest(bench, posKey, n) {
    return rowsOf(bench, posKey)
      .filter(r => r.rank > 0)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, Math.max(1, n || 3));
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /**
   * 面板 HTML
   * @param {object} bench /api/{region}/champions/ranked 的规范化结果
   * @param {object} [opts] { champName(id), now }
   */
  function html(bench, opts) {
    const o = opts || {};
    if (!bench || bench.__error) {
      return '<div class="rbk-head"><b>同段位基准线</b><span class="rbk-src">取不到数据</span></div>' +
        '<div class="rbk-empty">连接 OP.GG 失败，位置 KPI 仍用本地经验参考带。' +
        (bench && bench.__error ? '（' + esc(bench.__error) + '）' : '') + '</div>';
    }
    const nameOf = id => {
      try { return o.champName ? (o.champName(id) || '') : ''; } catch (e) { return ''; }
    };
    const tierCn = TIER_CN[bench.tier] || bench.tier || '全段位';
    const rows = POS_ORDER.map(pos => {
      const ref = positionRef(bench, pos);
      const top = strongest(bench, pos, 3).map(r => {
        const nm = nameOf(r.championId);
        // 英雄名来自 DDragon/LCU, 数据没到位时按 Poro 其它页面的惯例退成 "英雄#id"
        return nm ? esc(nm) : '英雄#' + r.championId;
      });
      return { pos, ref, top };
    });
    const head = '<div class="rbk-head"><b>同段位基准线</b>' +
      `<span class="rbk-src">OP.GG · ${esc(tierCn)} · ${esc(REGION_CN[bench.region] || bench.region || '全球服')}` +
      (bench.version ? ` · ${esc(bench.version)}` : '') +
      (bench.fetchedAt ? ` · ${esc(fmtTime(bench.fetchedAt))}` : '') +
      (bench.stale ? ' · 缓存' : '') + '</span></div>';

    const table = '<table class="rbk-table"><thead><tr>' +
      '<th>位置</th><th>中位 KDA</th><th>参考带</th><th>样本场次</th><th>该位置最强</th>' +
      '</tr></thead><tbody>' +
      rows.map(r => {
        const ref = r.ref;
        return '<tr>' +
          `<td class="rbk-pos">${esc(POS_CN[r.pos] || r.pos)}</td>` +
          `<td>${ref ? ref.mid.toFixed(2) : '—'}</td>` +
          `<td>${ref ? ref.low.toFixed(2) + '–' + ref.high.toFixed(2) : '—'}</td>` +
          `<td>${ref ? ref.play.toLocaleString('en-US') : '—'}</td>` +
          `<td class="rbk-top">${r.top.length ? r.top.join('、') : '—'}</td>` +
          '</tr>';
      }).join('') +
      '</tbody></table>';

    const note = '<div class="rbk-note">' +
      '「中位 KDA」是该段位同位置全部英雄的场次加权中位数（OP.GG 实测值）。' +
      `参考带固定取 中位 ×${BAND_LOW} ~ ×${BAND_HIGH}：高于上沿记「好」，低于下沿记「弱」。` +
      'OP.GG 不提供补刀、伤害、视野，这几项仍用本地经验参考带。' +
      '国服无 OP.GG 覆盖，这里取全球服聚合值，只作参照，不是国服分位。' +
      '</div>';

    return head + table + note;
  }

  // ---------- 加载器 (单例, 失败不重试到死) ----------
  const cache = new Map();       // tierParam → bench
  const pending = new Map();
  let last = null;
  let lastError = null;
  const readyCbs = [];

  function benchSync() { return last; }
  function refSync(pos) { return last ? refFor(last, pos) : null; }
  function onReady(cb) {
    if (typeof cb !== 'function') return;
    if (last) { try { cb(last); } catch (e) {} return; }
    readyCbs.push(cb);
  }

  function ensure(tier, region) {
    const t = tierParamOf(tier);
    const r = String(region || 'global');
    const key = r + '|' + t;
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (pending.has(key)) return pending.get(key);
    // 用 window.lolAPI 而不是裸的 lolAPI: 裸标识符的 typeof 守卫会被静态检查
    // (test_undef_globals) 判成"恒为假" —— 它只认得渲染层自己定义的全局。
    const api = (typeof window !== 'undefined' && window.lolAPI) || null;
    if (!api || typeof api.getOpggBench !== 'function') return Promise.resolve(null);
    const job = Promise.resolve(api.getOpggBench(t, r)).then(res => {
      if (!res || res.__error) { lastError = (res && res.__error) || '未知错误'; return null; }
      cache.set(key, res);
      last = res;
      for (const cb of readyCbs.splice(0)) { try { cb(res); } catch (e) {} }
      return res;
    }).catch(err => {
      lastError = (err && err.message) || String(err);
      return null;
    }).finally(() => { pending.delete(key); });
    pending.set(key, job);
    return job;
  }

  // 给「等一会儿再渲染」用的软超时: 超时返回 null, 不拖住首屏
  function ensureSoft(tier, region, ms) {
    return Promise.race([
      ensure(tier, region),
      new Promise(resolve => setTimeout(() => resolve(null), Math.max(200, Number(ms) || 2500)))
    ]);
  }

  function lastErr() { return lastError; }
  function clear() { cache.clear(); pending.clear(); last = null; lastError = null; }

  return {
    TIER_PARAM, TIER_CN, POS_KEY, POS_CN, POS_ORDER, REGION_CN, MIN_PLAY, MIN_CHAMPS, BAND_LOW, BAND_HIGH,
    tierParamOf, posKeyOf, weightedQuantile, rowsOf, positionRef, refFor, championRow, strongest,
    html, ensure, ensureSoft, benchSync, refSync, onReady, lastErr, clear
  };
});
