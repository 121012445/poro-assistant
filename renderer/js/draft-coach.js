// 阵容教练：只根据当前已知阵容给出结构化缺口和胜利条件。
// 不负责配装/符文；这些仍由当前模式、阵容和实时数据驱动。
(function (root) {
  'use strict';
  const TAGS = ['Tank', 'Fighter', 'Assassin', 'Mage', 'Marksman', 'Support'];
  const label = { Tank: '前排', Fighter: '战士', Assassin: '刺客', Mage: '法系', Marksman: '射手', Support: '保护' };
  function tagsOf(p, champOf) {
    try { return (champOf && champOf(p?.championId)?.tags) || []; } catch (e) { return []; }
  }
  function build(players, opts) {
    const o = opts || {};
    const list = Array.isArray(players) ? players.filter(Boolean) : [];
    const selfTeam = o.selfTeam === 200 ? 200 : 100;
    const own = list.filter(p => +p.team === selfTeam);
    const enemy = list.filter(p => +p.team && +p.team !== selfTeam);
    const count = rows => {
      const out = Object.fromEntries(TAGS.map(k => [k, 0]));
      for (const p of rows) for (const t of tagsOf(p, o.champOf)) if (out[t] != null) out[t]++;
      return out;
    };
    const ownTags = count(own), enemyTags = count(enemy);
    const gaps = [];
    if (ownTags.Tank + ownTags.Fighter < 2) gaps.push('前排不足');
    if (ownTags.Marksman + ownTags.Mage < 2) gaps.push('持续输出不足');
    if (ownTags.Support === 0) gaps.push('保护/控制不足');
    if (ownTags.Assassin >= 3 && ownTags.Tank === 0) gaps.push('阵容偏脆');
    const strengths = [];
    if (ownTags.Marksman + ownTags.Mage >= 3) strengths.push('后排输出');
    if (ownTags.Tank + ownTags.Fighter >= 2) strengths.push('正面承压');
    if (ownTags.Assassin >= 2) strengths.push('边线和抓单');
    if (ownTags.Support >= 2) strengths.push('保护和反开');
    let winCondition = '围绕兵线和资源打有准备的团战，避免无视野接战。';
    if (gaps.includes('前排不足')) winCondition = '先消耗和拉扯，等对手关键技能交出后再反打。';
    else if (ownTags.Assassin >= 2) winCondition = '利用边线压力和人数差抓单，避免正面长时间站撸。';
    else if (ownTags.Tank + ownTags.Fighter >= 2) winCondition = '让前排先制造空间，后排跟进输出，不要各自追击。';
    return { own, enemy, ownTags, enemyTags, gaps, strengths, winCondition, complete: own.length >= 3 && enemy.length >= 3 };
  }
  function render(model) {
    if (!model || !model.complete) return '';
    const gap = model.gaps.length ? model.gaps.join('、') : '结构完整';
    const strengths = model.strengths.length ? model.strengths.join('、') : '暂无明显结构优势';
    return `<div class="dc-card"><div class="dc-title"><b>阵容教练</b><span>只做结构分析，不替你锁定英雄</span></div><div class="dc-grid"><div><small>己方优势</small><p>${escapeHtml(strengths)}</p></div><div><small>当前缺口</small><p>${escapeHtml(gap)}</p></div></div><div class="dc-win"><b>胜利条件</b><span>${escapeHtml(model.winCondition)}</span></div></div>`;
  }
  root.PoroDraftCoach = { build, render };
})(typeof window !== 'undefined' ? window : this);
