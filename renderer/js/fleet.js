// 车队视角 —— 把"五个人各自怎样"收敛成"这一队是什么队"。
//
// 单排视角下, 实时页只回答"这个人强不强"; 开黑时需要的是:
//   1. 谁和谁是一伙的 (premadeGroupId 已由 live.js 算好)
//   2. 这伙人整体胜率/场次 (样本合并, 比单看五人平均更稳)
//   3. 阵容缺口 (没有前排 / 只有一种伤害类型 / 没人带控)
//
// 阵容判定用 DDragon 的英雄 tags (Fighter/Tank/Mage/Assassin/Marksman/Support),
// 是"标签粗判", 不是模型结论 —— 页面上如实这么写。
// 纯函数, 无 DOM/IO, 可在 node 里断言。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  // window.X 形式既是浏览器里的真实赋值, 也让静态检查 (test_undef_globals) 认得出这个名字
  if (typeof window !== 'undefined') window.PoroFleet = api;
  else if (root) root.PoroFleet = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const POS_CN = { TOP: '上单', JUNGLE: '打野', MIDDLE: '中单', BOTTOM: '下路', UTILITY: '辅助', MID: '中单', ADC: '下路', SUPPORT: '辅助' };

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function posOf(p) {
    const s = String((p && (p.position || p.teamPosition)) || '').toUpperCase();
    return POS_CN[s] || '';
  }

  function stats(p) {
    const recent = Array.isArray(p && p.recent) ? p.recent : [];
    const games = recent.length;
    const wins = recent.filter(r => r.win === true || r.win === 'Win').length;
    const k = recent.reduce((s, r) => s + (num(r.k) || 0), 0);
    const d = recent.reduce((s, r) => s + (num(r.d) || 0), 0);
    const a = recent.reduce((s, r) => s + (num(r.a) || 0), 0);
    return {
      games, wins,
      wr: games ? Math.round(wins / games * 100) : null,
      kda: games ? Math.round((k + a) / Math.max(1, d) * 10) / 10 : null
    };
  }

  /**
   * @param {Array} players live.js 的 10 人 (或 5 人) 数组
   * @param {object} opts { selfTeam, tags(id) -> string[], champName(id) -> string, nameOf(player) -> string }
   */
  function build(players, opts) {
    const o = opts || {};
    const list = (Array.isArray(players) ? players : []).filter(p => p && !p.isBot);
    const teamNo = Number(o.selfTeam || 0);
    const team = teamNo ? list.filter(p => Number(p.team) === teamNo) : list;
    if (team.length < 2) return { ready: false, reason: '还没识别到己方队伍' };

    // 名字兜底: 实时页的 p.name 在国服常常是空的 (Live Client Data 只给 riotId),
    // 十人卡靠 nameCache 补名 —— 车队没有那份缓存, 所以让调用方把补名函数传进来。
    // 这里不做第二次兜底, 页面上的"未知"就必须是"真的查不到", 而不是"忘了查"。
    const nameOf = p => {
      try {
        if (typeof o.nameOf === 'function') {
          const n = o.nameOf(p);
          if (n) return String(n);
        }
      } catch (e) { /* 兜底失败就退回原字段 */ }
      return p.name || '未知';
    };

    const members = team.map(p => {
      const st = stats(p);
      return {
        name: nameOf(p),
        puuid: p.puuid || '',
        position: posOf(p),
        championId: +p.championId || 0,
        champName: (() => { try { return o.champName ? (o.champName(p.championId) || '') : ''; } catch (e) { return ''; } })(),
        group: p.premadeGroupId || null,
        rank: p.rank || '',
        ...st
      };
    });

    // 分组: 有 premadeGroupId 的归组, 其余算散人
    const byGroup = new Map();
    for (const m of members) {
      const key = m.group ? String(m.group) : '__solo';
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(m);
    }
    let gi = 0;
    const groups = [...byGroup.entries()].map(([key, ms]) => {
      const games = ms.reduce((s, m) => s + m.games, 0);
      const wins = ms.reduce((s, m) => s + m.wins, 0);
      return {
        id: key,
        label: key === '__solo' ? '散人' : '开黑' + (++gi),
        size: ms.length,
        members: ms.map(m => m.name),
        games, wins,
        wr: games ? Math.round(wins / games * 100) : null
      };
    }).sort((a, b) => b.size - a.size || (b.wr || 0) - (a.wr || 0));

    // 阵容缺口 (按英雄标签粗判)
    const tagsOf = id => {
      try { const t = o.tags ? o.tags(id) : null; return Array.isArray(t) ? t : []; } catch (e) { return []; }
    };
    const all = members.flatMap(m => tagsOf(m.championId));
    const has = t => all.includes(t);
    const warnings = [];   // 完整句子, 展开后看
    const gaps = [];       // 折叠条上的短标签, 四个字以内
    const note = (short, full) => { gaps.push(short); warnings.push(full); };
    if (!has('Tank') && !has('Fighter')) note('没有前排', '没有前排，开团靠先手失误');
    if (!has('Mage') && has('Marksman')) note('伤害单一', '伤害类型偏单一 (物理为主)');
    if (!has('Support') && !has('Tank')) note('缺硬辅', '缺少硬辅/开团位');
    if (!has('Marksman') && !has('Assassin')) note('缺输出', '缺少持续输出点');
    if (!warnings.length) { gaps.push('阵容完整'); warnings.push('标签层面没有明显缺口'); }

    const totalGames = members.reduce((s, m) => s + m.games, 0);
    const totalWins = members.reduce((s, m) => s + m.wins, 0);
    return {
      ready: true,
      members,
      groups,
      warnings,
      gaps,
      wr: totalGames ? Math.round(totalWins / totalGames * 100) : null,
      games: totalGames,
      partySize: groups.filter(g => g.id !== '__solo').reduce((s, g) => s + g.size, 0)
    };
  }

  /**
   * opts.collapsed 默认由调用方传 true —— 实时页主体是十人卡, 车队只在"想深看"时展开。
   * 折叠状态下仍然把最关键的三件事留在一条里: 团队样本、开黑构成、阵容缺口。
   */
  function html(view, opts) {
    if (!view || !view.ready) return '';
    const o = opts || {};
    const collapsed = !!o.collapsed;
    const wrCls = view.wr == null ? 'flat' : view.wr >= 55 ? 'up' : view.wr <= 45 ? 'down' : 'flat';
    const groupHtml = view.groups.map(g => `<span class="ft-group${g.id === '__solo' ? ' solo' : ''}">${esc(g.label)} <b>${g.size}人</b>${g.wr == null ? '' : ` · ${g.wr}%`}</span>`).join('');
    // 成员一格两行: 上排 位置+名字(+开黑标), 下排 英雄+胜率+KDA。竖排 5 行改成网格, 高度压到一行
    const memberHtml = view.members.map(m => {
      const cls = m.wr == null ? 'flat' : m.wr >= 55 ? 'up' : m.wr <= 45 ? 'down' : 'flat';
      return `<div class="ft-m">
      <div class="ft-m-top">
        ${m.position ? `<span class="ft-pos">${esc(m.position)}</span>` : ''}
        <b class="ft-name" title="${esc(m.name)}">${esc(m.name)}</b>
        ${m.group ? '<span class="ft-tag">开黑</span>' : ''}
      </div>
      <div class="ft-m-bot">
        <span class="ft-champ">${esc(m.champName || '')}</span>
        <b class="ft-wr ${cls}">${m.wr == null ? '--' : m.wr + '%'}</b>
        <span class="ft-kda">KDA ${m.kda == null ? '--' : m.kda}</span>
      </div>
    </div>`;
    }).join('');
    // 折叠条只带首个缺口, 其余折叠成 "+N", 完整句子在展开后的 body 里
    const gapChips = view.gaps.length
      ? `<span class="ft-gap${view.gaps[0] === '阵容完整' ? ' ok' : ''}">${esc(view.gaps[0])}${view.gaps.length > 1 ? ` +${view.gaps.length - 1}` : ''}</span>`
      : '';
    return `<section class="ft-card${collapsed ? ' collapsed' : ''}">
      <div class="ft-head" onclick="toggleFleetCard(this)" role="button" tabindex="0" onkeydown="if(event.key==='Enter'){toggleFleetCard(this)}">
        <b>车队视角</b>
        <span class="ft-sum">团队 <b>${view.games}</b> 场 · 胜率 <i class="${wrCls}">${view.wr == null ? '--' : view.wr + '%'}</i></span>
        ${view.partySize ? `<span class="ft-party">开黑 ${view.partySize} 人</span>` : '<span class="ft-party solo">全员散人</span>'}
        ${gapChips}
        <span class="ft-toggle">${collapsed ? '展开' : '收起'}</span>
      </div>
      <div class="ft-body">
        <div class="ft-groups">${groupHtml}</div>
        <div class="ft-members">${memberHtml}</div>
        <div class="ft-warn">${view.warnings.map(w => `<span>${esc(w)}</span>`).join('')}</div>
        <p class="ft-foot">分组来自近 30 场共同出场证据; 阵容缺口按英雄标签粗判, 不替代你自己的判断。</p>
      </div>
    </section>`;
  }

  return { build, html, stats, posOf };
});
