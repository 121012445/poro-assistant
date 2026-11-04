// 单局战报卡：把一局的关键数据排成一张可直接发给朋友的图。
//
// 与周报卡(weekly.js)同一套导出通道 (share-card:save) —— 主进程离屏渲染 + 保存 PNG。
// 卡片的样式写在 premium.css 里，导出时由主进程把应用 CSS 一起注入，
// 所以「预览长什么样，存下来就是什么样」，不靠内联样式硬编码。
//
// 只摆数得出来的东西：KDA、参团、伤害占比、补刀、视野、经济、装备、双方阵容。
// 不写"你这局打得很好"这类评价 —— 评分口径因人而异，写上去就是替用户下结论。
(function (root) {
  'use strict';

  const CARD_W = 460;

  function num(n) { return Number(n || 0).toLocaleString('en-US'); }

  function champOf(p) {
    const hit = (typeof champNumMap === 'object' && champNumMap) ? champNumMap[String(p.championId)] : null;
    return { id: hit && hit.id ? hit.id : '', name: (hit && hit.name) || p.championName || ('英雄#' + p.championId) };
  }

  function imgOf(p) {
    const c = champOf(p);
    if (c.id && typeof champImg === 'function') return champImg(c.id);
    return typeof placeholder === 'function' ? placeholder('?') : '';
  }

  function fmtDur(sec) {
    const s = Math.max(0, Math.round(+sec || 0));
    return Math.floor(s / 60) + '分' + (s % 60 ? (s % 60) + '秒' : '');
  }

  function fmtWhen(ts) {
    const d = new Date(+ts || 0);
    if (!+d) return '';
    const p2 = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }

  const POS_CN = { TOP: '上单', JUNGLE: '打野', MIDDLE: '中单', BOTTOM: '下路', UTILITY: '辅助' };

  function teamBlock(list, me, label) {
    const rows = list.map(p => {
      const kda = `${p.k}/${p.d}/${p.a}`;
      return `<span class="bc-mate${p === me ? ' is-me' : ''}"><img src="${imgOf(p)}" alt="" onerror="this.style.visibility='hidden'"><b>${kda}</b></span>`;
    }).join('');
    return `<div class="bc-team"><span class="bc-team-label">${label}</span><div class="bc-mates">${rows}</div></div>`;
  }

  // norm: normalizeGame() 输出; ownerPuuid: 这张卡以谁为主角
  function build(norm, ownerPuuid) {
    const ps = Array.isArray(norm && norm.participants) ? norm.participants : [];
    const me = ps.find(p => p.puuid && p.puuid === ownerPuuid) || ps.find(p => p.win) || ps[0];
    if (!me) return '';
    const team = ps.filter(p => p.teamId === me.teamId);
    const foes = ps.filter(p => p.teamId !== me.teamId);
    const teamKills = team.reduce((s, p) => s + (+p.k || 0), 0);
    const teamDmg = team.reduce((s, p) => s + Math.max(0, +p.dmg || 0), 0);
    const kda = ((+me.k || 0) + (+me.a || 0)) / Math.max(1, +me.d || 0);
    // 参团率封顶 100%：数据不全（缺少队友击杀数）时会算出 117% 这种不可能的数
    const part = teamKills ? Math.min(100, Math.round(((+me.k || 0) + (+me.a || 0)) / teamKills * 100)) : 0;
    const dmgShare = teamDmg ? Math.round((+me.dmg || 0) / teamDmg * 100) : 0;
    const conv = +me.gold ? Math.round((+me.dmg || 0) / (+me.gold) * 100) : 0;
    const mins = (+norm.dur || 0) / 60;
    const csMin = mins > 0 ? Math.round((+me.cs || 0) / mins * 10) / 10 : 0;
    const c = champOf(me);
    const pos = POS_CN[me.position] || '';
    const items = (me.items || []).filter(Boolean).slice(0, 7);
    const itemHtml = items.length
      ? items.map(id => `<img class="bc-item" src="https://ddragon.leagueoflegends.com/cdn/${typeof version !== 'undefined' ? version : ''}/img/item/${id}.png" alt="" onerror="this.style.visibility='hidden'">`).join('')
      : '<span class="bc-item-none">装备数据缺失</span>';
    const cell = (v, label) => `<div class="bc-cell"><b>${v}</b><span>${label}</span></div>`;

    return `<div class="bc-pad"><div class="bc-card ${me.win ? 'bc-win' : 'bc-loss'}">
  <div class="bc-band"></div>
  <div class="bc-top">
    <span class="bc-logo">P</span>
    <div class="bc-meta"><b>${me.win ? '胜利' : '失败'}</b><span>${escapeHtml(norm.mode || '对局')} · ${fmtDur(norm.dur)} · ${fmtWhen(norm.time)}</span></div>
  </div>
  <div class="bc-hero">
    <img class="bc-champ" src="${imgOf(me)}" alt="" onerror="this.style.visibility='hidden'">
    <div class="bc-heroinfo"><b>${escapeHtml(c.name)}</b><span>${pos ? pos + ' · ' : ''}${me.level || 1} 级${me.multi ? ' · ' + escapeHtml(me.multi) : ''}${me.fb ? ' · 一血' : ''}</span></div>
    <div class="bc-kda"><b>${me.k}<i>/</i><em>${me.d}</em><i>/</i>${me.a}</b><span>${kda.toFixed(1)} KDA · 参团 ${part}%</span></div>
  </div>
  <div class="bc-grid">
    ${cell(num(me.dmg), '伤害')}
    ${cell(dmgShare + '%', '伤害占比')}
    ${cell(me.cs || 0, '补刀（' + csMin + '/分）')}
    ${cell(me.visionScore || 0, '视野得分')}
    ${cell(num(me.gold), '经济')}
    ${cell(conv + '%', '伤害转化')}
  </div>
  <div class="bc-items">${itemHtml}</div>
  ${teamBlock(team, me, '我方')}
  ${foes.length ? teamBlock(foes, me, '对方') : ''}
  <div class="bc-foot"><span>Poro · 英雄联盟游戏助手</span><span>${escapeHtml(c.name)} 战报</span></div>
</div></div>`;
  }

  // 先塞进隐藏容器量一次真实尺寸，再交给主进程离屏渲染：
  // 写死宽度高度的话，内容换行一变就会被裁掉半行。
  function measure(html) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-9999px;top:0;width:' + CARD_W + 'px;visibility:hidden;';
    host.innerHTML = html;
    document.body.appendChild(host);
    const el = host.firstElementChild;
    const r = el ? el.getBoundingClientRect() : null;
    const size = { width: Math.ceil((r && r.width) || CARD_W), height: Math.ceil((r && r.height) || 520) };
    document.body.removeChild(host);
    return size;
  }

  async function save(norm, ownerPuuid) {
    const html = build(norm, ownerPuuid);
    if (!html) { if (typeof showToast === 'function') showToast('这局没有可用的玩家数据', 'negative'); return; }
    const size = measure(html);
    const theme = document.body.classList.contains('dark') ? 'dark' : 'light';
    const r = await lolAPI.saveShareCard(html, size.width, size.height, {
      title: '保存战报图片', prefix: 'Poro战报', theme
    }).catch(e => ({ __error: (e && e.message) || String(e) }));
    if (r && r.ok) { if (typeof showToast === 'function') showToast('战报已保存: ' + r.filePath, 'positive'); }
    else if (r && !r.canceled) { if (typeof showToast === 'function') showToast('保存失败: ' + (r.__error || '未知错误'), 'negative'); }
  }

  root.PoroBattleCard = { build, save, measure };
})(typeof window !== 'undefined' ? window : this);
