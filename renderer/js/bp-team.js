// 己方预选视角：BP 建议的另一半。
//
// 为什么单独一个模块: bp-advisor.js 只回答"对面已经亮了谁, 我打谁有优势",
// 它不知道**我方**已经选/预选了什么。实际选人时另一半信息同样重要 ——
//   1) 我方阵容缺什么(前排/物理/法术/保护), 我这一手该补什么
//   2) 队友预选的英雄最怕谁, ban 位上帮他清掉
// 这个模块只做这两件事, 打分口径与 bp-advisor 保持同一量纲(百分点),
// 由 bp-advisor 决定要不要把它并进总分 —— 这里不直接改排序。
//
// 数据边界(不编造):
//   - 英雄标签用 DDragon tags; 伤害类型用官方 info.attack / info.magic 权重差判定,
//     两者相差不到 2 分算混合伤害。没有"这个英雄有没有开团/位移"这类字段, 所以不谈。
//   - 没有双排/组合胜率数据源, 所以这里**不算 synergy 胜率**, 只谈结构缺口。
//   - 阵容缺口是启发性规则, 不是胜率回归; 面板上写的是"缺前排", 不写"胜率高 X%"。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  if (typeof window !== 'undefined') window.PoroBPTeam = api; else if (root) root.PoroBPTeam = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const TAG_CN = { Tank: '前排', Fighter: '战士', Assassin: '刺客', Mage: '法师', Marksman: '射手', Support: '辅助' };
  const DMG_CN = { AP: '法伤', AD: '物伤', MIX: '混伤' };
  const DMG_GAP = 2;        // info.attack 与 info.magic 的差额阈值
  const MIN_PLAY = 50;      // 对位样本下限, 与 bp-advisor 一致
  const SAMPLE_FULL = 300;  // 样本权重封顶, 与 bp-advisor 一致

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s)) : String(s));
  const sign = n => (n >= 0 ? '+' : '') + Number(n).toFixed(1);

  function maps(ctx) {
    const o = ctx || {};
    return {
      map: o.champNumMap || (typeof champNumMap !== 'undefined' ? champNumMap : null),
      all: o.allChampions || (typeof allChampions !== 'undefined' ? allChampions : null)
    };
  }

  // champNumMap[数字id].id 是 DDragon 的字母 id, allChampions 用它取 tags/info
  function rawOf(id, ctx) {
    const m = maps(ctx);
    if (!m.map || !m.all) return null;
    const ref = m.map[String(id)];
    if (!ref) return null;
    return m.all[ref.id] || null;
  }

  function nameOf(id, ctx) {
    const m = maps(ctx);
    const ref = m.map && m.map[String(id)];
    return (ref && ref.name) || String(id);
  }

  function tagsOf(id, ctx) {
    const raw = rawOf(id, ctx);
    return (raw && Array.isArray(raw.tags)) ? raw.tags : [];
  }

  function dmgOf(id, ctx) {
    const raw = rawOf(id, ctx);
    const info = raw && raw.info;
    if (!info || typeof info.attack !== 'number' || typeof info.magic !== 'number') return '';
    if (info.attack - info.magic >= DMG_GAP) return 'AD';
    if (info.magic - info.attack >= DMG_GAP) return 'AP';
    return 'MIX';
  }

  // 一队已亮英雄的结构画像
  function profileOf(ids, ctx) {
    const p = { total: 0, Tank: 0, Fighter: 0, Assassin: 0, Mage: 0, Marksman: 0, Support: 0, AP: 0, AD: 0, MIX: 0, unknown: 0 };
    const seen = new Set();
    for (const raw of (ids || [])) {
      const id = Number(raw);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      p.total++;
      const tags = tagsOf(id, ctx);
      if (!tags.length) { p.unknown++; continue; }
      for (const t of tags) if (t !== 'total' && typeof p[t] === 'number') p[t]++;
      const dmg = dmgOf(id, ctx);
      if (dmg === 'AP') p.AP++;
      else if (dmg === 'AD') p.AD++;
      else if (dmg === 'MIX') p.MIX++;
      else p.unknown++;
    }
    return p;
  }

  // 我方缺口 + 敌方结构带来的针对性需求。own/foe 是 profileOf 的结果。
  function needsOf(own, foe, opts) {
    const o = opts || {};
    const rift = o.rift !== false;
    const out = [];
    if (own && own.total >= 2) {
      if (own.Tank + own.Fighter < 2) {
        out.push({ key: 'front', label: '己方前排不足', tags: ['Tank', 'Fighter'], weight: 1.5 });
      }
      const knownDmg = own.AP + own.AD + own.MIX;
      if (knownDmg >= 2 && own.AP >= 2 && own.AD === 0) {
        out.push({ key: 'ad', label: '己方全是法伤，缺物理输出', tags: ['Marksman', 'Fighter'], weight: 1.2 });
      } else if (knownDmg >= 2 && own.AD >= 2 && own.AP === 0) {
        out.push({ key: 'ap', label: '己方全是物伤，缺法术输出', tags: ['Mage'], weight: 1.2 });
      }
      if (rift && own.total >= 3 && own.Support === 0) {
        out.push({ key: 'prot', label: '己方缺保护/视野', tags: ['Support'], weight: 0.8 });
      }
    }
    if (foe && foe.total >= 2) {
      if (foe.Assassin >= 2) {
        out.push({ key: 'antiAssassin', label: '敌方已亮两名刺客', tags: ['Tank', 'Support'], weight: 1.3 });
      }
      if (foe.Tank + foe.Fighter >= 2) {
        out.push({ key: 'antiFront', label: '敌方前排偏多', tags: ['Mage', 'Marksman'], weight: 1.1 });
      }
      if (foe.AP >= 2 && foe.AD === 0) {
        out.push({ key: 'antiAp', label: '敌方法伤偏多', tags: ['Tank'], weight: 0.9 });
      }
    }
    return out;
  }

  // 某个候选英雄能补上多少缺口
  function fitOf(id, needs, ctx) {
    const tags = tagsOf(id, ctx);
    let fit = 0;
    const reasons = [];
    for (const nd of (needs || [])) {
      if (!nd || !Array.isArray(nd.tags)) continue;
      if (nd.tags.some(t => tags.indexOf(t) >= 0)) {
        fit += nd.weight;
        if (reasons.indexOf(nd.label) < 0) reasons.push(nd.label);
      }
    }
    return { fit: Math.round(fit * 100) / 100, reasons, tags };
  }

  // state: bp-advisor.readSession() 的输出（ally 里带 locked / intent 标记时更准）
  function analyze(state, ctx, opts) {
    const s = state || {};
    const allyAll = (Array.isArray(s.ally) ? s.ally : []).filter(a => a && Number(a.id) > 0);
    const ownIds = allyAll.map(a => Number(a.id));
    const foeIds = (Array.isArray(s.enemy) ? s.enemy : []).map(a => a && Number(a.id)).filter(Boolean);
    const own = profileOf(ownIds, ctx);
    const foe = profileOf(foeIds, ctx);
    const needs = needsOf(own, foe, opts);
    return {
      own, foe, needs, intents: allyAll, ownIds, foeIds,
      lockedCount: allyAll.filter(a => a.locked).length,
      intentCount: allyAll.filter(a => a.intent && !a.locked).length
    };
  }

  // 帮队友清路：队友预选的英雄被谁克制最深。
  // tables 的键与取值方向与 bp-advisor 完全一致: tables['队友id:位置'][敌人id] = { play, wr }。
  function banAgainstIntents(intents, tables, opts) {
    const o = opts || {};
    const t = tables || {};
    const limit = o.limit || 3;
    const minPlay = o.minPlay || MIN_PLAY;
    const exclude = o.exclude || null;
    const acc = new Map();
    for (const it of (intents || [])) {
      if (!it || !it.id || !it.pos) continue;
      const table = t[it.id + ':' + it.pos];
      if (!table) continue;
      for (const key of Object.keys(table)) {
        const id = Number(key);
        const row = table[key];
        if (!id || !row) continue;
        if (row.play < minPlay) continue;
        if (exclude && exclude.has(id)) continue;
        const delta = (row.wr - 0.5) * 100;
        if (!(delta > 0)) continue;
        const cur = acc.get(id) || { id, score: 0, hits: [] };
        cur.score += delta * Math.min(1, row.play / SAMPLE_FULL);
        cur.hits.push({ forId: Number(it.id), wr: row.wr, play: row.play });
        acc.set(id, cur);
      }
    }
    return [...acc.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(r => ({
        id: r.id,
        score: r.score,
        basis: 'intent',
        hits: r.hits.sort((a, b) => b.wr - a.wr).slice(0, 2)
      }));
  }

  // 一行摘要：双方已亮 + 缺口。给 bp-advisor 的标题栏用。
  function briefHtml(model, ctx) {
    if (!model) return '';
    const chips = (model.intents || []).map(a => {
      const dmg = dmgOf(a.id, ctx);
      const tags = tagsOf(a.id, ctx);
      const main = tags.length ? (TAG_CN[tags[0]] || tags[0]) : '';
      const meta = [main, DMG_CN[dmg] || ''].filter(Boolean).join('·');
      return '<span class="bpt-chip' + (a.locked ? ' bpt-chip-lock' : '') + '">'
        + esc(nameOf(a.id, ctx)) + (meta ? '<i>' + esc(meta) + '</i>' : '') + '</span>';
    }).join('');
    const gaps = (model.needs || []).slice(0, 3).map(n =>
      '<span class="bpt-gap">' + esc(n.label) + '</span>').join('');
    return '<div class="bpt-brief">'
      + '<div class="bpt-side">'
      + '<b>我方</b>' + (chips || '<span class="bpt-none">还没人亮</span>')
      + '</div>'
      + (gaps ? '<div class="bpt-needs"><b>缺口</b>' + gaps + '</div>' : '')
      + '</div>';
  }

  // 综合首选：picks[0] 带上"补了什么缺口"
  function verdictHtml(pick, model, ctx) {
    if (!pick) return '';
    const bits = [];
    if (pick.edges && pick.edges.length) {
      const best = pick.edges[0];
      bits.push('对位 ' + esc(best.enemyName) + (best.lane ? '' : '（非对线）') + ' ' + sign(best.delta));
    }
    for (const r of (pick.fitReasons || [])) bits.push(esc(r));
    if (!bits.length) bits.push('版本强度优先，暂无明显补位需求');
    return '<div class="bp-fusion">'
      + '<div class="bp-fusion-head"><b>综合首选</b><span>对位优势 + 我方缺口补位（含队友预选）</span></div>'
      + '<div class="bp-fusion-main"><span class="bp-fusion-name">' + esc(nameOf(pick.id, ctx)) + '</span>'
      + '<span class="bp-fusion-total">' + sign(pick.total != null ? pick.total : pick.score) + '</span>'
      + '<span class="bp-fusion-why">' + bits.join(' · ') + '</span></div>'
      + '</div>';
  }

  return {
    TAG_CN, DMG_CN, DMG_GAP, MIN_PLAY, SAMPLE_FULL,
    rawOf, nameOf, tagsOf, dmgOf, profileOf, needsOf, fitOf, analyze,
    banAgainstIntents, briefHtml, verdictHtml
  };
});
