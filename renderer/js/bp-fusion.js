// BP 融合结论：把三套现成信号揉成一条「这一手该拿谁」。
//
// 背景：软件里原本就有三套 BP 情报，但分散在不同页面、各说各话：
//   1) bp-advisor  ——  对位克制胜率（page-counters，本面板的数据来源）
//   2) draft-coach ——  己方阵容结构缺口（page-live 的作战计划浮层）
//   3) enemy-intel ——  敌方画像（依赖近期战绩，BP 阶段官方匿名拿不到）
// 这里不重复它们的实现，只复用「英雄 tags 统计」这一层事实，做一层编排：
//   - 对位维度：直接用 bp-advisor 已算好的 pick.score（百分点优势）
//   - 阵容维度：己方已亮英雄缺什么 tag（前排/法术/保护），候选能补就加分
//   - 敌方维度：敌方已亮英雄的结构（刺客多/前排多），候选能针对就加分
//   total = 对位分 + Σ命中维度的补位权重，取 top1 作「综合首选」。
//
// 诚实边界：
//   - 敌方 recent 在 BP 阶段拿不到（Riot 匿名 theirTeam 只给 obfuscatedPuuid），
//     所以敌方维度只用「已亮英雄英雄池结构」，不伪装成「擅长英雄」。
//   - 纯函数、无 DOM / 无 IO，可在 node 里断言。
(function (root) {
  'use strict';

  const TAGS = ['Tank', 'Fighter', 'Assassin', 'Mage', 'Marksman', 'Support'];
  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s)) : String(s));
  const sign = n => (n >= 0 ? '+' : '') + Number(n).toFixed(1);

  // 英雄 tags：champNumMap[id].id 是 DDragon 的字母 id（如 Aatrox），allChampions 用它取 tags
  function tagsOf(id, ctx) {
    const map = (ctx && ctx.champNumMap) || (typeof champNumMap !== 'undefined' ? champNumMap : null);
    const all = (ctx && ctx.allChampions) || (typeof allChampions !== 'undefined' ? allChampions : null);
    if (!map || !all) return [];
    const num = map[String(id)];
    if (!num) return [];
    const full = all[num.id];
    return (full && Array.isArray(full.tags)) ? full.tags : [];
  }

  function nameOf(id, ctx) {
    const map = (ctx && ctx.champNumMap) || (typeof champNumMap !== 'undefined' ? champNumMap : null);
    const num = map && map[String(id)];
    return num ? num.name : String(id);
  }

  function countTags(ids, ctx) {
    const out = {};
    for (const t of TAGS) out[t] = 0;
    for (const id of (ids || [])) {
      for (const t of tagsOf(id, ctx)) if (out[t] != null) out[t]++;
    }
    return out;
  }

  // 由己方 / 敌方已亮的 tags 推出「这一手需要什么」，每条带权重与理由。
  // onlyRift：海斗/大乱斗没有视野与兵线，不谈「保护/视野」「前排承压」那套峡谷话术。
  function needs(ownTags, enemyTags, onlyRift) {
    const out = [];
    const front = (ownTags.Tank || 0) + (ownTags.Fighter || 0);
    const ap = ownTags.Mage || 0;
    const prot = ownTags.Support || 0;
    if (front < 2) out.push({ tags: ['Tank', 'Fighter'], reason: '己方前排不足', weight: 1.5 });
    if (ap < 1) out.push({ tags: ['Mage'], reason: '己方法术输出不足', weight: 1.2 });
    if (onlyRift && prot < 1) out.push({ tags: ['Support'], reason: '己方缺保护/视野', weight: 1.0 });
    // 敌方针对：按已亮英雄结构，不假设擅长
    if ((enemyTags.Assassin || 0) >= 2) out.push({ tags: ['Tank', 'Support'], reason: '敌方刺客多', weight: 1.3 });
    if ((enemyTags.Tank || 0) + (enemyTags.Fighter || 0) >= 2) out.push({ tags: ['Mage', 'Marksman'], reason: '敌方前排多', weight: 1.1 });
    return out;
  }

  function fitFor(id, needsList, ctx) {
    const tags = tagsOf(id, ctx);
    let score = 0;
    const reasons = [];
    for (const nd of (needsList || [])) {
      if (nd.tags.some(t => tags.indexOf(t) >= 0)) {
        score += nd.weight;
        reasons.push(nd.reason);
      }
    }
    return { score, reasons, tags };
  }

  // picks：bp-advisor.recommend() 的输出；opts：{ally,enemy,ctx,mode}
  function blend(picks, opts) {
    const o = opts || {};
    const ctx = o.ctx || o; // 允许直接把 champNumMap/allChampions 挂在 opts 上
    const allyIds = (o.ally || []).map(p => (p && p.id) || p).filter(Boolean);
    const enemyIds = (o.enemy || []).map(p => (p && p.id) || p).filter(Boolean);
    const fam = String(o.mode || '').toLowerCase();
    const onlyRift = !/mayhem|aram|arena|fun/.test(fam);
    const ownTags = countTags(allyIds, ctx);
    const enemyTags = countTags(enemyIds, ctx);
    const needsList = needs(ownTags, enemyTags, onlyRift);
    // 第四个信号源：复盘沉淀的「上局短板」(来自 review-bp-bridge.adopt)。
    // 只在本局 needs 没覆盖同一 tag 时补进来，避免同一短板重复计分。
    for (const h of (o.reviewHints || [])) {
      if (!h || !Array.isArray(h.tags) || !h.tags.length) continue;
      const dup = needsList.some(n => n.tags.some(t => h.tags.indexOf(t) >= 0));
      if (!dup) needsList.push(h);
    }
    const rows = (picks || []).map(p => {
      const fit = fitFor(p.id, needsList, ctx);
      return {
        id: p.id,
        counter: Number(p.score) || 0,
        fit: fit.score,
        reasons: fit.reasons,
        tags: fit.tags,
        total: (Number(p.score) || 0) + fit.score,
        hasCounter: Array.isArray(p.edges) && p.edges.length > 0
      };
    });
    rows.sort((a, b) => b.total - a.total || b.counter - a.counter);
    return { rows, ownTags, enemyTags, needs: needsList, onlyRift };
  }

  function render(model, ctx) {
    if (!model || !model.rows || !model.rows.length) return '';
    const top = model.rows[0];
    const name = esc(nameOf(top.id, ctx));
    const bits = [];
    if (top.hasCounter) bits.push('对位 ' + sign(top.counter));
    bits.push(...top.reasons.map(esc));
    const why = bits.length ? bits.join(' · ') : '版本强度优先，暂无明显补位需求';
    const runners = model.rows.slice(1, 3).map(r =>
      '<span class="bp-fusion-alt">' + esc(nameOf(r.id, ctx)) + '<i>' + sign(r.total) + '</i></span>').join('');
    return '<div class="bp-fusion">'
      + '<div class="bp-fusion-head"><b>综合首选</b><span>对位 + 阵容补位 + 敌方结构，三套信号叠加</span></div>'
      + '<div class="bp-fusion-main"><span class="bp-fusion-name">' + name + '</span>'
      + '<span class="bp-fusion-total">' + sign(top.total) + '</span>'
      + '<span class="bp-fusion-why">' + why + '</span></div>'
      + (runners ? '<div class="bp-fusion-alts"><span>次选</span>' + runners + '</div>' : '')
      + '</div>';
  }

  const api = { TAGS, tagsOf, nameOf, countTags, needs, fitFor, blend, render };
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  if (root) root.PoroBPFusion = api;
})(typeof window !== 'undefined' ? window : this);
