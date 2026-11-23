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
  // 竖幅原画: 战报卡左侧那条。ddragon 的 loading 图是 308x560 竖构图, 正好铺一条竖栏。
  const SPLASH_CDN = 'https://ddragon.leagueoflegends.com/cdn/img/champion/loading/';
  // 段位色: 与 v4.css §33 的**深色档**同源。原画区永远是深底, 只取深色那套;
  // 不能读 --tier-* —— 导出渲染只注入 style/extras/dark/premium/ui-polish,
  // v4.css 不参与, 令牌在离屏窗口里根本不存在, 出图会变成继承色。
  const TIER_HEX = {
    IRON: '#9BA3AD', BRONZE: '#C98A5C', SILVER: '#A9B6C4', GOLD: '#E3B455',
    PLATINUM: '#2FBFA8', EMERALD: '#2BC98B', DIAMOND: '#6FA5FF',
    MASTER: '#B583F8', GRANDMASTER: '#F26376', CHALLENGER: '#F0C24F'
  };
  // 与 home.js 的 TIER_ICON 同一套图标名, 两处不一致会显得段位有两套视觉
  const TIER_ICON_NAME = {
    IRON: 'rock', BRONZE: 'medal', SILVER: 'medal', GOLD: 'medal',
    PLATINUM: 'shield', EMERALD: 'shield', DIAMOND: 'gem',
    MASTER: 'gem', GRANDMASTER: 'crown', CHALLENGER: 'crown'
  };
  // 卡片上所有图片 url -> dataURL。导出走离屏窗口且只等 600ms, 外链根本来不及下载:
  // 实测不内联时装备格是 7 个空白方块、队伍行头像缺一半 —— 导出的是一张"成品图",
  // 这种缺图比版式难看严重得多, 所以原画/装备/头像统一走这一份缓存。
  const IMG_CACHE = new Map();
  // 强化图标缓存: url -> dataURL。导出用的是主进程离屏窗口, 它只等 600ms 就截图,
  // 直接引外链很可能还没下载完 —— 表现为"图上有名字没图标"。先在渲染层下载成
  // dataURL 再内联, 离屏窗口就不需要联网了 (CORS: communitydragon 允许 *)。
  const AUG_ICON_CACHE = new Map();
  // 稀有度底色: 强化小图标是纯白剪影, 必须垫色块才看得见 (与 hex.js 的 HEX_RARITY_BG 同一份)
  const AUG_RARITY_BG = {
    '白银': '#6f7c8a',
    '黄金': '#b8892b',
    '棱彩': 'linear-gradient(135deg,#7d5bd6 0%,#3fa6c9 100%)',
    '活动': '#8a5bc9'
  };
  const augBg = rarity => 'background:' + (AUG_RARITY_BG[String(rarity || '')] || '#5b6673') + ';';


  function num(n) { return Number(n || 0).toLocaleString('en-US'); }

  // 经济类数字用 k 缩写: 460px 宽的卡上 "15,240" 与 "对位经济" 挤在一格里会换行
  function kFmt(n) {
    const v = Number(n || 0);
    if (!Number.isFinite(v)) return '—';
    if (Math.abs(v) < 1000) return String(Math.round(v));
    return (v / 1000).toFixed(1) + 'k';
  }

  function champOf(p) {
    const hit = (typeof champNumMap === 'object' && champNumMap) ? champNumMap[String(p.championId)] : null;
    return { id: hit && hit.id ? hit.id : '', name: (hit && hit.name) || p.championName || ('英雄#' + p.championId) };
  }

  function imgOf(p) {
    const c = champOf(p);
    if (c.id) return inline(headUrl(c.id));
    return typeof placeholder === 'function' ? placeholder('?') : '';
  }

  // 走产品自己的 champImg (它内部会用 allChampions[key].image.full, 个别英雄的
  // 文件名和 key 不一致), 拿不到才退回按 key 拼
  function headUrl(champKey) {
    if (typeof champImg === 'function') {
      try { const u = champImg(champKey); if (u) return u; } catch (e) {}
    }
    const cdn = typeof CDN !== 'undefined' && CDN ? CDN : 'https://ddragon.leagueoflegends.com/cdn';
    const v = typeof version !== 'undefined' ? version : '';
    return cdn + '/' + v + '/img/champion/' + champKey + '.png';
  }

  function itemUrl(id) {
    const cdn = typeof CDN !== 'undefined' && CDN ? CDN : 'https://ddragon.leagueoflegends.com/cdn';
    const v = typeof version !== 'undefined' ? version : '';
    return cdn + '/' + v + '/img/item/' + id + '.png';
  }

  // 命中缓存就用 dataURL, 没命中就退回外链 (界面上预览时外链是够用的)
  function inline(url) { return (url && IMG_CACHE.get(url)) || url || ''; }

  // 竖幅原画地址。拿不到英雄 key (资料还没加载) 就返回空 —— 宁可露深色底, 也不猜一个错的英雄。
  function splashOf(p) {
    const c = champOf(p);
    if (!c.id) return '';
    return inline(SPLASH_CDN + encodeURIComponent(c.id) + '_0.jpg');
  }

  function readAsDataUrl(blob) {
    return new Promise(resolve => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => resolve('');
      fr.readAsDataURL(blob);
    });
  }

  // 卡片上的图全部按「实际显示尺寸的 2 倍」重编码再内联。原图都是 120~560px 的大图:
  // 10 个 120x120 头像转 base64 各约 41KB (合计 410KB), 一张卡的内联体积 90% 耗在这。
  // 头像在卡上只显示 17px、装备 26px、原画 138px, 按 2 倍重编码后视觉无损, 体积降一个数量级。
  // 大图 (原画) 走 jpeg: 本来就无透明通道, 用 jpeg 比 png 小 5 倍。
  // 头像/装备必须留 png: 它们有透明边缘, 转 jpeg 会糊出黑边。
  async function shrinkAsDataUrl(blob, maxW, mime, quality) {
    try {
      // 用 window. 前缀调: test_undef_globals 只认裸调用, 成员访问不误报;
      // 它的 // undef-ok 逃生注释实际失效 (blankLiterals 会把整行注释清成空格)。
      if (typeof window.createImageBitmap !== 'function') return '';
      const bmp = await window.createImageBitmap(blob);
      const scale = Math.min(1, maxW / (bmp.width || 1));
      const w = Math.max(1, Math.round((bmp.width || 1) * scale));
      const h = Math.max(1, Math.round((bmp.height || 1) * scale));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      if (!ctx) { if (bmp.close) bmp.close(); return ''; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      return cv.toDataURL(mime || 'image/png', quality);
    } catch (e) { return ''; }
  }

  async function inlineImg(url, opt) {
    if (!url || IMG_CACHE.has(url) || !/^https?:/i.test(url)) return 0;
    try {
      const r = await fetch(url, { cache: 'force-cache' });
      if (!r.ok) return 0;
      const blob = await r.blob();
      // 原画 (138px 宽) / 头像 (17px) / 装备 (26px) 一律按 2 倍采样重编码
      let dataUrl = '';
      if (opt && opt.maxW) {
        dataUrl = await shrinkAsDataUrl(blob, opt.maxW, opt.mime, opt.quality);
      }
      if (!dataUrl) dataUrl = await readAsDataUrl(blob);
      if (dataUrl) { IMG_CACHE.set(url, dataUrl); return 1; }
    } catch (e) { /* 取不到就用外链 */ }
    return 0;
  }

  // 一次性把这张卡要用的图全部落成本地 dataURL: 主角原画 + 10 个头像 + 7 件装备 + 强化图标。
  // 返回成功张数 (0 也有意义: 离线时会全失败, 但卡片仍能出, 只是图缺)。
  async function warmImages(norm, ownerPuuid) {
    if (typeof fetch !== 'function') return 0;
    const ps = Array.isArray(norm && norm.participants) ? norm.participants : [];
    const me = ps.find(p => p.puuid && p.puuid === ownerPuuid) || ps.find(p => p.win) || ps[0];
    const urls = new Map();   // url -> 重编码参数 (按图在卡上的实际显示尺寸决定)
    if (me) {
      const c = champOf(me);
      if (c.id) urls.set(SPLASH_CDN + encodeURIComponent(c.id) + '_0.jpg',
        { maxW: 276, mime: 'image/jpeg', quality: 0.82 });   // 原画显示 138px 宽
    }
    for (const p of ps) {
      const c = champOf(p);
      if (c.id) urls.set(headUrl(c.id), { maxW: 48, mime: 'image/png' });   // 队伍行头像 17px
      for (const id of (p && Array.isArray(p.items) ? p.items : []).slice(0, 7)) {
        if (id) urls.set(itemUrl(id), { maxW: 56, mime: 'image/png' });     // 装备 26px
      }
    }
    const list = [...urls];
    const results = await Promise.all(list.map(([u, opt]) => inlineImg(u, opt)));
    return results.reduce((a, b) => a + b, 0);
  }

  // 兼容旧名 (save 里原来只预热原画)
  const warmSplash = warmImages;

  // 段位胶囊: 只摆查得到的。rankCache / rankedEntryOf 都在 home.js 的顶层作用域,
  // 经典 script 共享全局, 这里直接读; 沙箱里没有这两个就整块不出 (不编段位)。
  function rankBadge(puuid) {
    try {
      if (typeof rankCache !== 'object' || !rankCache || !puuid) return '';
      const qm = rankCache[puuid];
      if (!qm) return '';
      const q = typeof rankedEntryOf === 'function' ? rankedEntryOf(qm) : null;
      if (!q || !q.tier) return '';
      const tier = String(q.tier).toUpperCase();
      const color = TIER_HEX[tier];
      if (!color) return '';
      const cn = typeof rankTierCN === 'function' ? rankTierCN(tier) : tier;
      const div = q.division && !['NA', ''].includes(q.division) ? ' ' + q.division : '';
      const lp = q.leaguePoints != null ? ' ' + q.leaguePoints : '';
      const iconName = TIER_ICON_NAME[tier];
      const icon = (iconName && typeof poroIcon === 'function')
        ? poroIcon(iconName, 11) : '';
      return `<div class="bc-rank">${icon}<span style="color:${color}">${escapeHtml(cn)}${escapeHtml(div)}${escapeHtml(lp)}</span></div>`;
    } catch (e) { return ''; }
  }

  // KDA 分级: 与首页战绩卡同一口径 (home.js kdaClass) —— ≥3 绿 / <2 红 / 其余蓝。
  // 注意分级色只上"KDA 比值"那行小字 (8.7 KDA), 大字号 11/3/9 用主文字色:
  // 大字整串随局变色会让人以为出图不稳定 (同一操作, 这局绿下局蓝), 而战绩卡本身
  // 也是"比分主色 + 比值分档"。视觉重心留给数字本身, 语义交给比值。
  function kdaTone(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || !n) return '';
    return n >= 3 ? ' k-hi' : (n < 2 ? ' k-lo' : ' k-mid');
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

  // 本局强化 (海克斯 / 斗魂): 图标与名称来自 hex.js 的 hexAugMeta (cherry-augments)。
  // 资料没加载出来时整块不显示 —— 不拿 "#123" 糊弄人, 也不猜。
  function augIconSrc(url) {
    return (url && AUG_ICON_CACHE.get(url)) || url || '';
  }

  // 把这一局出现的强化图标下载成 dataURL (失败就保留外链, 不影响出图)
  async function warmAugmentIcons(norm) {
    if (!norm || !Array.isArray(norm.participants)) return 0;
    const meta = (typeof hexAugMeta !== 'undefined' && hexAugMeta) ? hexAugMeta : null;
    if (!meta) return 0;
    const ids = new Set();
    const urls = new Set();
    for (const p of norm.participants) {
      for (const id of (p && Array.isArray(p.augmentIds) ? p.augmentIds : [])) {
        const m = meta[id];
        if (!m || !m.icon) continue;
        ids.add(Number(id));
        if (!AUG_ICON_CACHE.has(m.icon)) urls.add(m.icon);
      }
    }
    let done = 0;
    // ① 先问主进程要包内 png 的 dataURL: 同步可读, 与网络无关 (离屏窗口只等 600ms)
    if (typeof lolAPI !== 'undefined' && lolAPI && typeof lolAPI.augmentIconData === 'function' && ids.size) {
      try {
        const map = await lolAPI.augmentIconData([...ids]);
        for (const id of Object.keys(map || {})) {
          const m = meta[id];
          if (m && m.icon && map[id]) { AUG_ICON_CACHE.set(m.icon, map[id]); done++; }
        }
      } catch (e) { /* 回退外网 */ }
    }
    if (typeof fetch !== 'function') return done;
    await Promise.all([...urls].map(async url => {
      try {
        const r = await fetch(url, { cache: 'force-cache' });
        if (!r.ok) return;
        const blob = await r.blob();
        const dataUrl = await new Promise(resolve => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result || ''));
          fr.onerror = () => resolve('');
          fr.readAsDataURL(blob);
        });
        if (dataUrl) { AUG_ICON_CACHE.set(url, dataUrl); done++; }
      } catch (e) { /* 取不到就用外链 */ }
    }));
    return done;
  }

  function augmentRow(p, mode) {
    const ids = Array.isArray(p && p.augmentIds) ? p.augmentIds.filter(id => Number(id) > 0).slice(0, 6) : [];
    if (!ids.length) return '';
    if (typeof hexAugMeta === 'undefined' || !hexAugMeta) return '';
    const cells = [];
    for (const id of ids) {
      const m = hexAugMeta[id];
      if (!m || !m.name) continue;
      // 图标拿不到 (没地址/离线) 就退化成带名称的文字块 —— 卡片上不留空白
      // 图标是白剪影, 必须垫稀有度底色, 否则白底卡片上完全看不见
      const bgStyle = augBg(m.rarity);
      const icon = m.icon
        ? `<img class="bc-aug-icon" style="${bgStyle}" src="${augIconSrc(m.icon)}" alt="" onerror="this.style.visibility='hidden'">`
        : '';
      const textOnly = m.icon ? '' : ' is-text';
      cells.push(`<span class="bc-aug${textOnly}">${icon}<b>${escapeHtml(m.name)}</b></span>`);
    }
    if (!cells.length) return '';
    const label = /斗魂|竞技场|CHERRY|ARENA/i.test(String(mode || '')) ? '斗魂强化' : '海克斯强化';
    return `<div class="bc-augs"><span class="bc-augs-label">${label}</span><div class="bc-aug-list">${cells.join('')}</div></div>`;
  }

  // norm: normalizeGame() 输出; ownerPuuid: 这张卡以谁为主角
  // opts.name: 主角的 Riot ID —— 这张卡最终是要发到群里的, 图上不写"是谁的",
  // 别人只看到"某人 11/3/9"就完全失去了分享的意义。拿不到就不显示 (不编名字)。
  function build(norm, ownerPuuid, opts) {
    const o = opts || {};
    const ownerName = String(o.name == null ? '' : o.name).trim();
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
    const pos = hasRealPositions(norm) ? (POS_CN[me.position] || '') : '';
    // 对位经济: 同分路的敌方玩家。没有真实分路 (乱斗/斗魂) 或对位缺失时该格显示 —,
    // 不拿"经济占比"之类换了口径的数值顶上 —— 格子标题写什么就得是什么。
    const laneFoe = (hasRealPositions(norm) && me.position)
      ? foes.find(p => String(p.position) === String(me.position)) : null;
    const laneGold = laneFoe ? ((+me.gold || 0) - (+laneFoe.gold || 0)) : null;
    const laneCell = laneGold == null
      ? '—'
      : (laneGold >= 0 ? '+' : '−') + kFmt(Math.abs(laneGold));
    const items = (me.items || []).filter(Boolean).slice(0, 7);
    const itemHtml = items.length
      ? items.map(id => `<img class="bc-item" src="${inline(itemUrl(id))}" alt="" onerror="this.style.visibility='hidden'">`).join('')
      : '<span class="bc-item-none">装备数据缺失</span>';
    const cell = (v, label) => `<div class="bc-cell"><b>${v}</b><span>${label}</span></div>`;
    const splash = splashOf(me);
    const rankHtml = rankBadge(me.puuid);
    // 一血/多杀做成原画右上角的角标。原先塞在头部那行里, 会和「模式·时长」「玩家名」
    // 抢同一行的宽度, 最后三样全部被省略号截断 —— 荣誉标记放到原画上反而更醒目。
    const honor = [me.fb ? '一血' : '', me.multi ? String(me.multi) : ''].filter(Boolean).join(' · ');

    return `<div class="bc-pad"><div class="bc-card bc-cardA ${me.win ? 'bc-win' : 'bc-loss'}">
  <div class="bc-art">
    ${splash ? `<img class="bc-art-img" src="${splash}" alt="" onerror="this.style.visibility='hidden'">` : ''}
    <span class="bc-art-fade"></span><span class="bc-art-edge"></span>
    ${honor ? `<span class="bc-art-honor">${escapeHtml(honor)}</span>` : ''}
    <div class="bc-art-id">
      <b>${escapeHtml(c.name)}</b>
      <span>${pos ? pos + ' · ' : ''}${me.level || 1} 级</span>
      ${rankHtml}
    </div>
  </div>
  <div class="bc-body">
    <div class="bc-top">
      <span class="bc-state">${me.win ? '胜利' : '失败'}</span>
      <span class="bc-sub">${escapeHtml(norm.mode || '对局')} · ${fmtDur(norm.dur)}</span>
      ${ownerName ? `<span class="bc-owner" title="${escapeHtml(ownerName)}">${escapeHtml(ownerName)}</span>` : ''}
    </div>
    <div class="bc-kda">
      <b class="bc-kda-num"><span class="k-k">${me.k}</span><i>/</i><span class="k-d">${me.d}</span><i>/</i><span class="k-a">${me.a}</span></b>
      <div class="bc-kda-sub">
        <span><strong class="${kdaTone(kda).trim()}">${kda.toFixed(1)}</strong> KDA</span>
        <span>参团 ${part}%</span>
        <span>伤害占比 ${dmgShare}%</span>
      </div>
    </div>
    <div class="bc-grid">
      ${cell(num(me.dmg), '伤害')}
      ${cell(me.cs || 0, '补刀（' + csMin + '/分）')}
      ${cell(me.gold ? kFmt(me.gold) : '—', '经济')}
      ${cell(me.visionScore || 0, '视野得分')}
      ${cell(conv + '%', '伤害转化')}
      ${cell(laneCell, '对位经济')}
    </div>
    <div class="bc-items">${itemHtml}</div>
    ${augmentRow(me, norm.mode)}
    ${teamBlock(team, me, '我方')}
    ${foes.length ? teamBlock(foes, me, '对方') : ''}
    <div class="bc-foot"><span>Poro · 英雄联盟游戏助手</span><span>${fmtWhen(norm.time)}</span></div>
  </div>
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

  // 预览层: 先看图再决定存哪。旧流程点一下就弹系统保存框, 用户看不到自己要存的是什么。
  function previewLayer() {
    let el = document.getElementById('shareCardPreview');
    if (el && document.body.contains(el)) return el;
    el = document.createElement('div');
    el.id = 'shareCardPreview';
    el.className = 'scp';
    el.hidden = true;
    el.innerHTML = '<div class="scp-dialog" role="dialog" aria-modal="true">'
      + '<div class="scp-head"><b class="scp-title">预览</b>'
      + '<button type="button" class="scp-close" title="关闭 (Esc)">×</button></div>'
      + '<div class="scp-body"><img class="scp-img" alt="战报卡预览"></div>'
      + '<div class="scp-foot">'
      + '<span class="scp-hint">检查无误后再决定存到哪</span>'
      + '<button type="button" class="btn-secondary scp-copy">复制图片</button>'
      + '<button type="button" class="btn-primary scp-save">保存到…</button>'
      + '</div></div>';
    document.body.appendChild(el);
    el.querySelector('.scp-close').addEventListener('click', () => closePreview());
    el.addEventListener('mousedown', (ev) => { if (ev.target === el) closePreview(); });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !el.hidden) closePreview();
    });
    return el;
  }

  function closePreview() {
    const el = document.getElementById('shareCardPreview');
    if (!el) return;
    el.classList.remove('show');
    setTimeout(() => {
      if (el.classList.contains('show')) return;
      el.hidden = true;
      const img = el.querySelector('.scp-img');
      if (img) img.removeAttribute('src');   // 松开内存里那张 base64
    }, 180);
  }

  // dataURL -> Blob: Chromium 异步剪贴板只吃 Blob/Blob 数组, 不认 base64 字符串。
  // 用 atob 逐字节拷进 Uint8Array 而不是 fetch(dataURL): 后者在 file:// 页面里
  // 会被 CSP / 跨源拦掉, 而且多一次异步往返。
  function dataUrlToBlob(dataUrl) {
    const s = String(dataUrl || '');
    const comma = s.indexOf(',');
    if (comma < 0) return null;
    const head = s.slice(0, comma);
    const b64 = s.slice(comma + 1);
    if (!/^data:image\/png;base64$/i.test(head)) return null;
    let bin;
    try { bin = atob(b64); } catch (e) { return null; }
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: 'image/png' });
  }

  // 复制到系统剪贴板 —— 必须在渲染层做, 不能走主进程。
  // Electron 44 把主进程 clipboard 模块换成了 Promise 化的 read()/write() 语义:
  // writeImage / readImage / writeBuffer / has() 全没了(has 变 Promise),
  // 而 write() 只接受 ClipboardItem 数组, 主进程又没有全局 ClipboardItem。
  // 所以旧代码的 `clipboard.writeImage(...)` 每次必然抛
  // "clipboard.writeImage is not a function" —— 这就是「复制图片不生效」的全部原因
  // (crash.log 里 1.6.48 及以前每次点击都留了一条 copy failed)。
  // 渲染层这边是 Chromium 的异步剪贴板, 能力齐全, 手势由用户的点击提供。
  async function copyImage(dataUrl) {
    if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function' || typeof window.ClipboardItem !== 'function') {
      throw new Error('当前环境不支持复制图片');
    }
    const blob = dataUrlToBlob(dataUrl);
    if (!blob || !blob.size) throw new Error('图片数据无效');
    // 只在用户手势内调用; Windows 上 Chromium 会另写一份位图格式,
    // 微信 / QQ / 文档 都能直接 Ctrl+V 粘贴。
    await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
    return blob.size;
  }

  function preview(dataUrl, opts) {
    const o = opts || {};
    const el = previewLayer();
    const img = el.querySelector('.scp-img');
    el.querySelector('.scp-title').textContent = o.title || '预览';
    img.src = dataUrl;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('show'));
    const saveBtn = el.querySelector('.scp-save');
    const copyBtn = el.querySelector('.scp-copy');
    saveBtn.disabled = false;
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try {
        const r = await lolAPI.saveShareCardImage(dataUrl, o)
          .catch(e => ({ __error: (e && e.message) || String(e) }));
        if (r && r.ok) { showToast('已保存: ' + r.filePath, 'positive'); closePreview(); }
        else if (r && !r.canceled) { showToast('保存失败: ' + (r.__error || '未知错误'), 'negative'); }
      } finally { saveBtn.disabled = false; }
    };
    copyBtn.onclick = async () => {
      copyBtn.disabled = true;
      const label = copyBtn.textContent;
      copyBtn.textContent = '复制中…';
      const toast = (m, t) => { if (typeof showToast === 'function') showToast(m, t); };
      try {
        const bytes = await copyImage(dataUrl);
        toast('已复制到剪贴板 (' + Math.round(bytes / 1024) + ' KB), 直接 Ctrl+V 粘贴', 'positive');
      } catch (e) {
        // NotAllowedError 基本都是窗口没焦点 (Chromium 要求手势 + 焦点), 单独给一句人话
        const msg = (e && e.name === 'NotAllowedError')
          ? '窗口没有焦点, 点一下 Poro 窗口再复制'
          : ((e && e.message) || String(e));
        toast('复制失败: ' + msg, 'negative');
      } finally {
        copyBtn.disabled = false;
        copyBtn.textContent = label;
      }
    };
  }

  // 点「保存战报卡」: 只渲染并预览, 不弹保存框。
  // 互斥锁: 连点会同时发两次导出 —— 主进程虽然排队, 但用户会看到两张一样的预览
  // 依次弹出、toast 互相打断。这里直接挡掉第二次, 比排队体验好。
  let saving = false;
  async function save(norm, ownerPuuid, opts) {
    if (saving) {
      if (typeof showToast === 'function') showToast('上一张还在生成，稍等一下', 'info');
      return;
    }
    saving = true;
    try { await saveOnce(norm, ownerPuuid, opts); }
    finally { saving = false; }
  }

  async function saveOnce(norm, ownerPuuid, opts) {
    const o = opts || {};
    // 强化名称/图标来自 cherry-augments; 第一次用时补拉一次 (loadHexAugments 自带 20s 冷却)
    try {
      const hasAug = Array.isArray(norm && norm.participants)
        && norm.participants.some(p => p && Array.isArray(p.augmentIds) && p.augmentIds.length);
      if (hasAug && typeof loadHexAugments === 'function') {
        const meta = (typeof hexAugMeta !== 'undefined' && hexAugMeta) || {};
        // 元数据为空, 或有 id 在本地资料里查不到 (强化比缓存新) -> 强制刷新一次
        const unknown = norm.participants.some(p => (p && Array.isArray(p.augmentIds) ? p.augmentIds : [])
          .some(id => !meta[id]));
        if (!Object.keys(meta).length || unknown) await loadHexAugments(true);
      }
      // 图标内联: 离屏窗口只等 600ms, 外链很可能来不及下载
      if (hasAug) await warmAugmentIcons(norm);
    } catch (e) {}
    // 卡片上的图全部内联: 离屏窗口只等 600ms, 外链的原画/装备/头像一个都下载不完。
    // 实测不内联时装备格是 7 个空白方块、队伍行头像缺一半 —— 这是"成品图"级别的事故。
    try { await warmImages(norm, ownerPuuid); } catch (e) {}
    const html = build(norm, ownerPuuid, o);
    if (!html) { if (typeof showToast === 'function') showToast('这局没有可用的玩家数据', 'negative'); return; }
    const size = measure(html);
    const theme = document.body.classList.contains('dark') ? 'dark' : 'light';
    const renderOpts = { title: '战报预览', saveTitle: '保存战报图片', prefix: 'Poro战报', theme };
    if (typeof showToast === 'function') showToast('正在生成图片…', 'info');
    const r = await lolAPI.renderShareCard(html, size.width, size.height, renderOpts)
      .catch(e => ({ __error: (e && e.message) || String(e) }));
    if (r && r.ok && r.dataUrl) { preview(r.dataUrl, renderOpts); return; }
    if (typeof showToast === 'function') showToast('生成图片失败: ' + ((r && r.__error) || '未知错误'), 'negative');
  }

  root.PoroBattleCard = { build, save, preview, measure, copyImage, warmAugmentIcons, warmImages, warmSplash, augIconSrc };
})(typeof window !== 'undefined' ? window : this);
