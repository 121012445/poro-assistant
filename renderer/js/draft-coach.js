// 阵容教练：按**模式**给出结构化缺口与「本局要做的事」。
// 历史: 旧版只数 6 个英雄标签, 且不分模式 —— 海斗里也会给"边线压力/抓单/无视野不接战"
// 这类只适用于召唤师峡谷的建议。海斗没有兵线、没有常规视野, 于是整块结论失去可信度。
// 现在: 规则集按模式族切换 (海斗 / 极地 / 斗魂 / 峡谷), 每条结论都带计数依据。
// 仍然只做"能数出来的事实": 不预测胜负、不给评分、不替你选英雄。
(function (root) {
  'use strict';
  const TAGS = ['Tank', 'Fighter', 'Assassin', 'Mage', 'Marksman', 'Support'];
  const LABEL = { Tank: '前排', Fighter: '战士', Assassin: '刺客', Mage: '法系', Marksman: '射手', Support: '保护' };

  // 模式族: 与 live.js 的 liveModeFamily / PoroHabits 保持一致
  function familyOf(opts) {
    const m = String((opts && opts.mode) || '').toLowerCase();
    if (m === 'mayhem' || m === 'fun') return 'mayhem';
    if (m === 'aram') return 'aram';
    if (m === 'arena') return 'arena';
    return 'rift';
  }
  const FAMILY_LABEL = { mayhem: '海克斯大乱斗', aram: '极地大乱斗', arena: '斗魂竞技场', rift: '召唤师峡谷' };

  function tagsOf(p, champOf) {
    try { return (champOf && champOf(p && p.championId) && champOf(p.championId).tags) || []; } catch (e) { return []; }
  }
  function countTags(rows, champOf) {
    const out = Object.fromEntries(TAGS.map(k => [k, 0]));
    for (const p of rows) for (const t of tagsOf(p, champOf)) if (out[t] != null) out[t]++;
    return out;
  }

  function build(players, opts) {
    const o = opts || {};
    const list = Array.isArray(players) ? players.filter(Boolean) : [];
    const selfTeam = o.selfTeam === 200 || o.selfTeam === '200' ? 200 : 100;
    const own = list.filter(p => +p.team === selfTeam);
    const enemy = list.filter(p => +p.team && +p.team !== selfTeam);
    const ownTags = countTags(own, o.champOf);
    const enemyTags = countTags(enemy, o.champOf);
    const fam = familyOf(o);
    const line = ownTags.Tank + ownTags.Fighter;      // 能吃伤害的
    const ranged = ownTags.Marksman + ownTags.Mage;   // 能在后面输出的

    const gaps = [];
    const strengths = [];
    const plan = [];

    if (fam === 'mayhem' || fam === 'aram') {
      // 海斗/极地: 没有兵线与常规视野, 只有"团战 + 血包/强化"
      if (line < 2) gaps.push('没有前排，接团只能拉扯');
      if (ranged < 2) gaps.push('远程输出不足，容易被一起收掉');
      if (ownTags.Support === 0) gaps.push('缺少保护/控制');
      if (ownTags.Assassin >= 3) gaps.push('身板偏脆，被集火就崩');
      if (line >= 2) strengths.push('正面能扛（前排 ' + line + ' 个）');
      if (ranged >= 3) strengths.push('远程火力足（输出 ' + ranged + ' 个）');
      if (ownTags.Support >= 2) strengths.push('有保护和反手');

      plan.push(gaps.some(g => g.indexOf('前排') >= 0)
        ? '别先入场：让对面先交开团和强化，你们打反手（我方前排 ' + line + ' 个）'
        : '前排 ' + line + ' 个，可以主动开团抢血包');
      plan.push('海斗没有兵线，不要带线或单走：时间全部花在血包和团战上');
      plan.push(ranged >= 3
        ? '远程 ' + ranged + ' 个：站前排身后持续输出，不要追残血'
        : '近战偏多（' + (own.length - ranged) + ' 个）：集火同一个目标，别分散');
    } else if (fam === 'arena') {
      if (line < 1) gaps.push('没有能先手吃伤害的人');
      if (ranged < 1) gaps.push('缺少远程消耗');
      if (!own.length) gaps.push('数据未到');
      if (line >= 1) strengths.push('有前排可以卡位');
      plan.push('斗魂是 2v2：先集火一个，别各打各的');
      plan.push('看对面强化决定先手顺序（对面先手型强化就直接反打）');
      if (enemyTags.Tank + enemyTags.Fighter >= 2) plan.push('对面两个都能扛：优先打脆的那个');
    } else {
      // 召唤师峡谷: 才谈分推/视野/资源
      if (line < 2) gaps.push('正面承压不足');
      if (ranged < 2) gaps.push('持续输出不足');
      if (ownTags.Support === 0) gaps.push('视野/保护不足');
      if (ownTags.Assassin + ownTags.Fighter >= 2) strengths.push('边线压力');
      if (line >= 2) strengths.push('正面承压');
      if (ranged >= 3) strengths.push('后排输出');
      plan.push(gaps.some(g => g.indexOf('承压') >= 0)
        ? '别接无准备的正面团：先做视野、用边线压力换资源'
        : '前排能扛：围绕大龙/小龙逼团，靠前排制造空间');
      plan.push('开团前先确认视野：没有视野的河道不要进去（我方保护 ' + ownTags.Support + ' 个）');
      plan.push(ownTags.Assassin + ownTags.Fighter >= 2
        ? '边线可以多点开花：抓单后立刻转资源'
        : '专注正面：把资源换成塔，不要长时间分推');
    }

    return {
      fam,
      modeLabel: FAMILY_LABEL[fam],
      own, enemy, ownTags, enemyTags,
      gaps, strengths, plan,
      // 兼容旧字段
      winCondition: plan[0] || '',
      complete: own.length >= 2
    };
  }

  function render(model) {
    if (!model || !model.complete) return '';
    const gap = model.gaps.length ? model.gaps.join('、') : '结构完整';
    const strengths = model.strengths.length ? model.strengths.join('、') : '暂无明显结构优势';
    const plan = (model.plan || []).map((t, i) =>
      '<li><span class="dc-num">' + (i + 1) + '</span>' + (typeof escapeHtml === 'function' ? escapeHtml(t) : t) + '</li>').join('');
    const tags = model.ownTags || {};
    return '<div class="dc-card">'
      + '<div class="dc-title"><b>阵容教练</b><span>' + (typeof escapeHtml === 'function' ? escapeHtml(model.modeLabel) : '') + ' · 只按英雄标签统计，不预测胜负</span></div>'
      + '<div class="dc-grid">'
      + '<div><small>己方结构</small><p>' + (typeof escapeHtml === 'function' ? escapeHtml(strengths) : strengths) + '</p></div>'
      + '<div><small>当前缺口</small><p>' + (typeof escapeHtml === 'function' ? escapeHtml(gap) : gap) + '</p></div>'
      + '</div>'
      + '<ol class="dc-plan">' + plan + '</ol>'
      + '<div class="dc-tags"><i>前排 ' + (tags.Tank + tags.Fighter) + '</i><i>远程 ' + (tags.Marksman + tags.Mage) + '</i><i>刺客 ' + tags.Assassin + '</i><i>保护 ' + tags.Support + '</i></div>'
      + '</div>';
  }

  root.PoroDraftCoach = { build, render, familyOf };
})(typeof window !== 'undefined' ? window : this);
