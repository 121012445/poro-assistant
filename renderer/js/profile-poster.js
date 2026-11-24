// 生涯海报：把「最近这些场打成什么样」排成一张可以直接发出去的长图，支持按模式分开看。
//
// 与战报卡 / 周报卡同一条导出通道 —— 渲染层拼 HTML，主进程离屏渲染截 PNG，
// 再交给 PoroBattleCard.preview 预览 / 保存 / 复制。样式写在 premium.css 的 pp-* 段，
// 导出时注入的是同一批 CSS，所以「预览长什么样，存下来就是什么样」。
//
// 取舍：只摆算得出来的东西。场次、胜负、KDA、伤害分项、英雄/装备/强化/同局玩家的频次，
// 都是从对局记录直接数的；「评分」「MVP 率」这类要先自定口径的数字一律不做 ——
// 口径写不清的指标，图和数据对不上就是误导。
(function (root) {
  'use strict';

  const CARD_W = 680;
  const TOP_CHAMP = 8;
  const TOP_ITEM = 6;
  const TOP_PLAYER = 10;
  const TOP_AUG = 10;
  const RECENT_N = 12;

  // 强化小图标是纯白剪影，必须垫稀有度底色才看得见（与 hex.js / battle-card.js 同一份）
  const AUG_RARITY_BG = {
    '白银': '#6f7c8a',
    '黄金': '#b8892b',
    '棱彩': 'linear-gradient(135deg,#7d5bd6 0%,#3fa6c9 100%)',
    '活动': '#8a5bc9'
  };
  const augBg = rarity => 'background:' + (AUG_RARITY_BG[String(rarity || '')] || '#5b6673') + ';';

  // ---------- 格式化 ----------
  function num(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return Math.round(n).toLocaleString('en-US');
  }

  // 伤害/金币动辄七八位数，长图上要的是「一眼能读出量级」，不是精确到个位
  function bigNum(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    const abs = Math.abs(n);
    if (abs >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
    if (abs >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
    return num(n);
  }

  function pct(part, total) {
    if (!total) return 0;
    return Math.round(part / total * 1000) / 10;
  }

  function durText(sec) {
    const s = Math.max(0, Math.round(+sec || 0));
    if (!s) return '—';
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    if (h) return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
    return m + ' 分';
  }

  function durShort(sec) {
    const s = Math.max(0, Math.round(+sec || 0));
    if (!s) return '—';
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function median(list) {
    const a = list.filter(v => Number.isFinite(v) && v > 0).slice().sort((x, y) => x - y);
    if (!a.length) return 0;
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
  }

  function dateCn(ts) {
    const d = new Date(+ts || 0);
    if (!+d) return '';
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  // ---------- 图片地址 ----------
  function champOf(cid) {
    const hit = (typeof champNumMap === 'object' && champNumMap) ? champNumMap[String(cid)] : null;
    if (hit && hit.id) return { key: hit.id, name: hit.name || hit.id };
    // 资料还没加载出来时至少别把英雄画成空白：拿英雄名兜底，图留空
    return { key: '', name: '' };
  }

  function headUrl(key) {
    if (!key) return '';
    if (typeof champImg === 'function') {
      try { const u = champImg(key); if (u) return u; } catch (e) { /* 退回手拼 */ }
    }
    const cdn = typeof CDN !== 'undefined' && CDN ? CDN : 'https://ddragon.leagueoflegends.com/cdn';
    const v = typeof version !== 'undefined' ? version : '';
    return cdn + '/' + v + '/img/champion/' + key + '.png';
  }

  function itemUrl(id) {
    const cdn = typeof CDN !== 'undefined' && CDN ? CDN : 'https://ddragon.leagueoflegends.com/cdn';
    const v = typeof version !== 'undefined' ? version : '';
    return cdn + '/' + v + '/img/item/' + id + '.png';
  }

  function itemName(id) {
    const it = (typeof allItems === 'object' && allItems) ? allItems[String(id)] : null;
    return (it && it.name) || ('装备 #' + id);
  }

  function avatarUrlOf(s) {
    const id = s && s.profileIconId;
    if (id == null || Number(id) < 0) return '';
    if (typeof profileIcon === 'function') {
      try { const u = profileIcon(id); if (u) return u; } catch (e) { /* 手动拼 */ }
    }
    const cdn = typeof CDN !== 'undefined' && CDN ? CDN : 'https://ddragon.leagueoflegends.com/cdn';
    const v = typeof version !== 'undefined' ? version : '';
    return cdn + '/' + v + '/img/profileicon/' + id + '.png';
  }

  // 内联缓存统一走 battle-card.js 的 IMG_CACHE（那边已经按显示尺寸重编码过，
  // 再开一份只会让同一张图在内存里存两遍）。模块没加载到就退回外链 ——
  // 界面上预览够用，只是导出时可能缺图。
  function srcOf(url) {
    if (typeof root.PoroBattleCard === 'object' && root.PoroBattleCard && typeof root.PoroBattleCard.srcOf === 'function') {
      return root.PoroBattleCard.srcOf(url);
    }
    return url || '';
  }

  async function warmSrc(url, opt) {
    if (typeof root.PoroBattleCard === 'object' && root.PoroBattleCard && typeof root.PoroBattleCard.warmSrc === 'function') {
      return root.PoroBattleCard.warmSrc(url, opt);
    }
    return 0;
  }

  // ---------- 统计 ----------
  // 阵营字段两套：历史战绩给 teamId，实时对局给 team。0/空视为未知 ——
  // 把未知当成某一队，会让对手榜里混进队友（1.6.48 踩过同一个坑）。
  function sideOf(p) {
    const raw = p && (p.teamId != null ? p.teamId : p.team);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function knownName(n) {
    if (typeof isKnownPlayerName === 'function') { try { return isKnownPlayerName(n); } catch (e) { /* 退回本地判定 */ } }
    const s = String(n == null ? '' : n).trim();
    return !!s && !/^(未知|未知玩家|unknown|player|\?|-)$/i.test(s);
  }

  function excluded(g) {
    if (typeof isExcludedGame !== 'function') return false;
    try { return isExcludedGame({ mode: g.mode, gameMode: g.gameMode, queueId: g.queueId, gameType: g.gameType }); }
    catch (e) { return false; }
  }

  // 按模式分组的可选列表：只数「本人真的参与了」的对局，否则标签上的数字和点开的内容对不上
  function modesOf(games, ownerPuuid) {
    const out = [];
    const map = new Map();
    for (const g of (Array.isArray(games) ? games : [])) {
      if (!g || excluded(g)) continue;
      const ps = Array.isArray(g.participants) ? g.participants : [];
      if (ownerPuuid && !ps.some(p => p && p.puuid === ownerPuuid)) continue;
      const key = String(g.mode || '其他');
      map.set(key, (map.get(key) || 0) + 1);
    }
    for (const [key, n] of map) out.push({ key, n });
    out.sort((a, b) => b.n - a.n);
    return [{ key: 'all', n: out.reduce((s, x) => s + x.n, 0) }].concat(out);
  }

  function collect(games, ownerPuuid) {
    const rows = [];
    for (const g of (Array.isArray(games) ? games : [])) {
      if (!g || excluded(g)) continue;
      const ps = Array.isArray(g.participants) ? g.participants : [];
      const me = ownerPuuid ? ps.find(p => p && p.puuid === ownerPuuid) : null;
      if (!me) continue;
      rows.push({ g, me, ps });
    }
    // 首页给的是新局在前；统计里统一按时间倒序，连败/连胜要用正序
    rows.sort((a, b) => (+b.g.time || 0) - (+a.g.time || 0));

    const s = {
      n: rows.length, wins: 0,
      k: 0, d: 0, a: 0, bestK: 0, bestA: 0,
      dmg: 0, taken: 0, heal: 0, phys: 0, magic: 0, trueD: 0, bestDmg: 0,
      gold: 0, bestGold: 0, dur: 0, durs: [],
      fb: 0, multi: { d: 0, t: 0, q: 0, p: 0 },
      firstTime: 0, lastTime: 0, bestStreak: 0, streakType: 'win',
      champs: new Map(), items: new Map(), augs: new Map(),
      allies: new Map(), foes: new Map(),
      recent: []
    };
    if (!rows.length) return s;

    const chrono = rows.slice().reverse();
    let streak = 0, streakWin = true;
    for (const r of chrono) {
      const win = !!r.me.win;
      if (win === streakWin) streak++;
      else { streakWin = win; streak = 1; }
      if (streak > s.bestStreak) { s.bestStreak = streak; s.streakType = win ? 'win' : 'lose'; }
    }

    for (const r of rows) {
      const me = r.me, g = r.g;
      const k = Math.max(0, +me.k || 0), d = Math.max(0, +me.d || 0), a = Math.max(0, +me.a || 0);
      if (me.win) s.wins++;
      s.k += k; s.d += d; s.a += a;
      if (k > s.bestK) s.bestK = k;
      if (a > s.bestA) s.bestA = a;
      if (me.fb) s.fb++;

      const dmg = Math.max(0, +me.dmg || 0);
      s.dmg += dmg;
      if (dmg > s.bestDmg) s.bestDmg = dmg;
      s.taken += Math.max(0, +me.dmgTaken || 0);
      s.heal += Math.max(0, +me.healing || 0);
      s.phys += Math.max(0, +me.physDmg || 0);
      s.magic += Math.max(0, +me.magicDmg || 0);
      s.trueD += Math.max(0, +me.trueDmg || 0);
      s.gold += Math.max(0, +me.gold || 0);
      if ((+me.gold || 0) > s.bestGold) s.bestGold = +me.gold || 0;

      const dur = Math.max(0, +g.dur || 0);
      s.dur += dur;
      if (dur) s.durs.push(dur);

      const t = +g.time || 0;
      if (t) {
        if (!s.lastTime || t > s.lastTime) s.lastTime = t;
        if (!s.firstTime || t < s.firstTime) s.firstTime = t;
      }

      // 多杀：新数据带原始四项（含同一局里的多次），老缓存只有「本局最高」那一个字符串，
      // 后者会漏掉低级别多杀 —— 有原始字段就用原始字段，没有就退化成字符串计数。
      const mm = me.multis && typeof me.multis === 'object' ? me.multis : null;
      if (mm) {
        s.multi.d += Math.max(0, +mm.d || 0);
        s.multi.t += Math.max(0, +mm.t || 0);
        s.multi.q += Math.max(0, +mm.q || 0);
        s.multi.p += Math.max(0, +mm.p || 0);
      } else {
        const label = String(me.multi || '');
        if (label === '五杀') s.multi.p++;
        else if (label === '四杀') s.multi.q++;
        else if (label === '三杀') s.multi.t++;
        else if (label === '双杀') s.multi.d++;
      }

      const cid = me.championId;
      if (cid) {
        const cur = s.champs.get(cid) || { cid, n: 0, wins: 0 };
        cur.n++;
        if (me.win) cur.wins++;
        s.champs.set(cid, cur);
      }

      for (const id of (Array.isArray(me.items) ? me.items : [])) {
        if (!id || +id <= 0) continue;
        s.items.set(+id, (s.items.get(+id) || 0) + 1);
      }

      for (const id of (Array.isArray(me.augmentIds) ? me.augmentIds : [])) {
        if (!id || +id <= 0) continue;
        const cur = s.augs.get(+id) || { id: +id, n: 0, wins: 0 };
        cur.n++;
        if (me.win) cur.wins++;
        s.augs.set(+id, cur);
      }

      const mySide = sideOf(me);
      for (const p of (Array.isArray(r.ps) ? r.ps : [])) {
        if (!p || p === me || (ownerPuuid && p.puuid === ownerPuuid)) continue;
        const nm = String(p.name || '').trim();
        if (!knownName(nm)) continue;
        const otherSide = sideOf(p);
        // 任一方阵营未知就不进榜：分不清队友/对手时宁可少一个，也不能张冠李戴
        if (!mySide || !otherSide) continue;
        const bucket = otherSide === mySide ? s.allies : s.foes;
        const key = p.puuid || ('n:' + nm);
        const cur = bucket.get(key) || { name: nm + (p.tagLine ? '#' + p.tagLine : ''), n: 0 };
        cur.n++;
        bucket.set(key, cur);
      }

      if (s.recent.length < RECENT_N) s.recent.push({ win: !!me.win, cid });
    }

    s.wr = s.n ? Math.round(s.wins / s.n * 1000) / 10 : 0;
    s.kda = (s.k + s.a) / Math.max(1, s.d);
    s.avgK = s.k / Math.max(1, s.n);
    s.avgD = s.d / Math.max(1, s.n);
    s.avgA = s.a / Math.max(1, s.n);
    s.avgDmg = s.dmg / Math.max(1, s.n);
    s.dmgPerMin = s.dur ? s.dmg / (s.dur / 60) : 0;
    s.goldPerMin = s.dur ? s.gold / (s.dur / 60) : 0;
    s.goldPerGame = s.gold / Math.max(1, s.n);
    s.longest = s.durs.length ? Math.max.apply(null, s.durs) : 0;
    s.shortest = s.durs.length ? Math.min.apply(null, s.durs) : 0;
    s.medianDur = median(s.durs);
    s.champList = [...s.champs.values()].sort((x, y) => y.n - x.n || y.wins - x.wins).slice(0, TOP_CHAMP);
    s.itemList = [...s.items.entries()].sort((x, y) => y[1] - x[1]).slice(0, TOP_ITEM)
      .map(([id, n]) => ({ id, n }));
    s.augList = [...s.augs.values()].sort((x, y) => y.n - x.n).slice(0, TOP_AUG);
    s.allyList = [...s.allies.values()].sort((x, y) => y.n - x.n).slice(0, TOP_PLAYER);
    s.foeList = [...s.foes.values()].sort((x, y) => y.n - x.n).slice(0, TOP_PLAYER);
    return s;
  }

  // ---------- 段位 ----------
  const TIER_HEX = {
    IRON: '#9BA3AD', BRONZE: '#C98A5C', SILVER: '#A9B6C4', GOLD: '#E3B455',
    PLATINUM: '#2FBFA8', EMERALD: '#2BC98B', DIAMOND: '#6FA5FF',
    MASTER: '#B583F8', GRANDMASTER: '#F26376', CHALLENGER: '#F0C24F'
  };

  function rankChip(puuid) {
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
      const lp = q.leaguePoints != null ? ' ' + q.leaguePoints + ' LP' : '';
      return '<span class="pp-rank" style="color:' + color + '">' + escapeHtml(cn + div + lp) + '</span>';
    } catch (e) { return ''; }
  }

  // ---------- 拼图 ----------
  function kpi(v, label, cls) {
    return '<div class="pp-kpi"><b class="' + (cls || '') + '">' + v + '</b><span>' + label + '</span></div>';
  }

  function row(label, value) {
    return '<div class="pp-row"><span>' + label + '</span><b>' + value + '</b></div>';
  }

  function bar(label, value, color) {
    return '<div class="pp-bar"><span>' + label + '</span>'
      + '<i><em style="width:' + Math.max(0, Math.min(100, value)) + '%;background:' + color + '"></em></i>'
      + '<b>' + value.toFixed(1) + '%</b></div>';
  }

  function build(sum, opts) {
    const o = opts || {};
    const s = sum;
    if (!s || !s.n) return '';
    const name = String(o.name || '未知玩家').trim();
    const tag = String(o.tag || '').trim();
    const modeLabel = String(o.modeLabel || '全部模式');
    const ava = srcOf(o.avatar || '');
    const level = o.level ? 'Lv.' + o.level : '';
    const range = (s.firstTime && s.lastTime)
      ? dateCn(s.firstTime) + ' - ' + dateCn(s.lastTime)
      : '';

    const recent = s.recent.map(r => '<i class="pp-dot ' + (r.win ? 'w' : 'l') + '"></i>').join('');

    const highs = [
      ['五杀', s.multi.p], ['四杀', s.multi.q], ['三杀', s.multi.t], ['双杀', s.multi.d],
      ['一血', s.fb], ['单场最高击杀', s.bestK]
    ].map(([label, v]) => '<div class="pp-high"><b>' + num(v) + '</b><span>' + label + '</span></div>').join('');

    const champCells = s.champList.map(c => {
      const info = champOf(c.cid);
      const img = info.key ? srcOf(headUrl(info.key)) : '';
      const wr = c.n ? Math.round(c.wins / c.n * 100) : 0;
      return '<div class="pp-champ">'
        + (img ? '<img src="' + img + '" alt="" onerror="this.style.visibility=\'hidden\'">' : '<span class="pp-champ-ph"></span>')
        + '<div class="pp-champ-t"><b>' + escapeHtml(info.name || '') + '</b>'
        + '<span>' + c.n + ' 场 · <i class="' + (wr >= 50 ? 'good' : 'bad') + '">' + wr + '%</i></span></div>'
        + '</div>';
    }).join('');

    const itemCells = s.itemList.map(it => {
      const img = srcOf(itemUrl(it.id));
      return '<div class="pp-item" title="' + escapeHtml(itemName(it.id)) + '">'
        + '<img src="' + img + '" alt="" onerror="this.style.visibility=\'hidden\'">'
        + '<b>' + it.n + ' 次</b></div>';
    }).join('');

    const playerRows = (list, emptyText) => {
      if (!list.length) return '<div class="pp-empty">' + emptyText + '</div>';
      return list.map((p, i) => '<div class="pp-prow">'
        + '<em>' + (i + 1) + '</em>'
        + '<span title="' + escapeHtml(p.name) + '">' + escapeHtml(p.name) + '</span>'
        + '<b>' + p.n + '</b></div>').join('');
    };

    const meta = (typeof hexAugMeta !== 'undefined' && hexAugMeta) ? hexAugMeta : null;
    const augCells = (meta ? s.augList.filter(a => meta[a.id] && meta[a.id].name) : []).map(a => {
      const m = meta[a.id];
      const augIcon = (m.icon && typeof root.PoroBattleCard === 'object' && root.PoroBattleCard
        && typeof root.PoroBattleCard.augIconSrc === 'function') ? root.PoroBattleCard.augIconSrc(m.icon) : (m.icon || '');
      const icon = augIcon
        ? '<img class="pp-aug-i" style="' + augBg(m.rarity) + '" src="' + augIcon + '" alt="" onerror="this.style.visibility=\'hidden\'">'
        : '';
      const wr = a.n ? Math.round(a.wins / a.n * 100) : 0;
      return '<div class="pp-aug">' + (icon || '<span class="pp-aug-i"></span>')
        + '<div class="pp-aug-t"><b>' + escapeHtml(m.name) + '</b>'
        + '<span>' + a.n + ' 次 · ' + wr + '% 胜</span></div></div>';
    }).join('');

    const dmgTotal = s.dmg || 1;
    const winBarW = s.n ? (s.wins / s.n * 100) : 0;
    // 角色信息只摆查得到的：段位胶囊、等级、时间范围，缺哪样就少哪样，不留前导分隔符
    const subParts = [];
    const rank = rankChip(o.puuid);
    if (rank) subParts.push(rank);
    if (level) subParts.push(escapeHtml(level));
    if (range) subParts.push(escapeHtml(range));

    return '<div class="pp-wrap"><div class="pp-card' + (o.dark ? ' is-dark' : '') + '">'
      + '<header class="pp-head">'
      + '<div class="pp-ava-wrap">'
      + (ava ? '<img class="pp-ava" src="' + ava + '" alt="" onerror="this.style.visibility=\'hidden\'">' : '<span class="pp-ava"></span>')
      + '<span class="pp-ava-ring"></span></div>'
      + '<div class="pp-id"><div class="pp-name">' + escapeHtml(name)
      + (tag ? '<i>#' + escapeHtml(tag) + '</i>' : '') + '</div>'
      + '<div class="pp-sub">' + '<span class="pp-dim">' + subParts.join(' · ') + '</span></div></div>'
      + '<div class="pp-mode">' + escapeHtml(modeLabel) + '</div>'
      + '</header>'

      + '<div class="pp-kpis">'
      + kpi(num(s.n), '总场次')
      + kpi(s.wr + '%', '胜率', 'pp-wr')
      + kpi(s.kda.toFixed(2), '总 KDA')
      + kpi(((s.k + s.a) / Math.max(1, s.n)).toFixed(1), '场均 K+A')
      + '</div>'
      + '<div class="pp-recent"><span class="pp-dim">最近 ' + s.recent.length + ' 场</span>' + recent + '</div>'

      + '<section class="pp-sec"><h4>高光时刻</h4><div class="pp-highs">' + highs + '</div></section>'

      + '<section class="pp-sec"><h4>战绩总览</h4><div class="pp-ov">'
      + '<div class="pp-ovc"><div class="pp-ovt">胜率</div><b class="pp-ovn pp-wr">' + s.wr + '%</b>'
      + '<div class="pp-wbar"><i style="width:' + winBarW + '%"></i></div>'
      + '<div class="pp-ovs"><span>胜 <b>' + s.wins + '</b></span><span>负 <b>' + (s.n - s.wins) + '</b></span></div></div>'
      + '<div class="pp-ovc"><div class="pp-ovt">对局时长</div><b class="pp-ovn">' + durText(s.dur) + '</b>'
      + '<div class="pp-ovr">' + row('最长', durShort(s.longest)) + row('中位', durShort(s.medianDur))
      + row('平均', durShort(Math.round(s.dur / Math.max(1, s.n)))) + row('最短', durShort(s.shortest)) + '</div></div>'
      + '<div class="pp-ovc"><div class="pp-ovt">金币经济</div><b class="pp-ovn pp-gold">' + bigNum(s.gold) + '</b>'
      + '<div class="pp-ovr">' + row('分均', num(s.goldPerMin)) + row('场均', num(s.goldPerGame))
      + row('单场最高', num(s.bestGold)) + '</div></div>'
      + '</div></section>'

      + '<div class="pp-cols">'
      + '<section class="pp-sec"><h4>击杀数据</h4><div class="pp-panel">'
      + '<div class="pp-trio">'
      + '<div><b class="pp-rose">' + num(s.k) + '</b><span>击杀</span></div>'
      + '<div><b>' + num(s.d) + '</b><span>死亡</span></div>'
      + '<div><b class="pp-blue">' + num(s.a) + '</b><span>助攻</span></div>'
      + '</div>'
      + '<div class="pp-big"><b>' + s.kda.toFixed(2) + '</b><span>KDA</span></div>'
      + '<div class="pp-ovr">' + row('场均', s.avgK.toFixed(1) + ' / ' + s.avgD.toFixed(1) + ' / ' + s.avgA.toFixed(1))
      + row('单场最高击杀', num(s.bestK)) + '</div>'
      + '</div></section>'
      + '<section class="pp-sec"><h4>伤害数据</h4><div class="pp-panel">'
      + '<div class="pp-trio">'
      + '<div><b class="pp-gold">' + bigNum(s.dmg) + '</b><span>总伤害</span></div>'
      + '<div><b>' + bigNum(s.taken) + '</b><span>承受</span></div>'
      + '<div><b class="pp-teal">' + bigNum(s.heal) + '</b><span>治疗</span></div>'
      + '</div>'
      + '<div class="pp-bars">'
      + bar('物理', pct(s.phys, dmgTotal), '#e0637f')
      + bar('魔法', pct(s.magic, dmgTotal), '#6aa9f0')
      + bar('真实', pct(s.trueD, dmgTotal), '#e0b76a')
      + '</div>'
      + '<div class="pp-ovr">' + row('场均伤害', num(s.avgDmg)) + row('分均伤害', num(s.dmgPerMin)) + '</div>'
      + '</div></section>'
      + '</div>'

      + '<section class="pp-sec"><h4>英雄使用</h4><div class="pp-champs">'
      + (champCells || '<div class="pp-empty">没有英雄数据</div>') + '</div></section>'

      + '<section class="pp-sec"><h4>常见装备</h4><div class="pp-items">'
      + (itemCells || '<div class="pp-empty">没有装备数据</div>') + '</div></section>'

      + '<div class="pp-cols">'
      + '<section class="pp-sec"><h4>最常同队</h4><div class="pp-panel pp-plist">'
      + playerRows(s.allyList, '暂无同队记录') + '</div></section>'
      + '<section class="pp-sec"><h4>最常对手</h4><div class="pp-panel pp-plist">'
      + playerRows(s.foeList, '暂无对手记录') + '</div></section>'
      + '</div>'

      + (augCells ? '<section class="pp-sec"><h4>海克斯强化</h4><div class="pp-augs">' + augCells + '</div></section>' : '')

      + '<footer class="pp-foot"><span>Poro · 英雄联盟游戏助手</span><span>' + escapeHtml(modeLabel)
      + ' · 最近 ' + s.n + ' 场</span></footer>'
      + '</div></div>';
  }

  // ---------- 导出前把图内联 ----------
  function imagePlan(s) {
    const plan = new Map();
    if (s.avatar) plan.set(s.avatar, { maxW: 192, mime: 'image/png' });
    for (const c of s.champList) {
      const info = champOf(c.cid);
      if (info.key) plan.set(headUrl(info.key), { maxW: 96, mime: 'image/png' });
    }
    for (const it of s.itemList) plan.set(itemUrl(it.id), { maxW: 88, mime: 'image/png' });
    return plan;
  }

  async function warmImages(s) {
    let done = 0;
    const plan = imagePlan(s);
    const jobs = [...plan].map(([url, opt]) => warmSrc(url, opt));
    const res = await Promise.all(jobs);
    for (const r of res) done += (r ? 1 : 0);
    // 强化图标走 battle-card 的那套（先问主进程要包内 png，再回退网络）
    try {
      const ids = s.augList.map(a => a.id);
      if (ids.length && typeof root.PoroBattleCard === 'object' && root.PoroBattleCard
        && typeof root.PoroBattleCard.warmAugmentIcons === 'function') {
        await root.PoroBattleCard.warmAugmentIcons({ participants: [{ augmentIds: ids }] });
      }
    } catch (e) { /* 图标缺一两个不影响整张图 */ }
    return done;
  }

  // 先塞进隐藏容器量一次真实高度：写死 1600 会把最后一段裁掉
  function measure(html) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-9999px;top:0;width:' + CARD_W + 'px;visibility:hidden;';
    host.innerHTML = html;
    document.body.appendChild(host);
    const el = host.querySelector('.pp-wrap');
    const r = el ? el.getBoundingClientRect() : null;
    const size = { width: Math.ceil((r && r.width) || CARD_W), height: Math.ceil((r && r.height) || 900) };
    document.body.removeChild(host);
    return size;
  }

  // ---------- 弹窗 ----------
  function state() {
    if (!root.__poroPoster) root.__poroPoster = { mode: 'all', busy: false };
    return root.__poroPoster;
  }

  function ownerInfo() {
    const s = (typeof cachedSummoner === 'object' && cachedSummoner) ? cachedSummoner : null;
    const puuid = (typeof homeGamesOwner === 'string' && homeGamesOwner)
      || (typeof window !== 'undefined' && window._myPuuid) || '';
    const label = (typeof homeGamesOwnerLabel === 'string' && homeGamesOwnerLabel) || '';
    // 首页可能正显示别人的战绩（搜了别的玩家）。那时 cachedSummoner 还是本机的，
    // 直接拿来当主角就成了「拿别人的数据配自己的名字」—— 先判归属再取名字/头像。
    const isSelf = !s || !s.puuid || !puuid || String(s.puuid) === String(puuid);
    let name = '', tag = '';
    if (label) {
      const at = label.lastIndexOf('#');
      name = at > 0 ? label.slice(0, at) : label;
      tag = at > 0 ? label.slice(at + 1) : '';
    }
    if (isSelf && s && (s.gameName || s.displayName)) {
      name = String(s.gameName || s.displayName);
      tag = String(s.tagLine || '');
    }
    // 头像/等级只有本人查得到：别人的 summoner 没拉过，宁可不显示也别挂错头像
    const icon = (isSelf && s && s.profileIconId != null && Number(s.profileIconId) >= 0) ? s.profileIconId : -1;
    return {
      puuid,
      name: name || '未知玩家',
      tag,
      level: isSelf && s && s.summonerLevel ? s.summonerLevel : '',
      avatar: icon >= 0 ? avatarUrlOf({ profileIconId: icon }) : ''
    };
  }

  function filteredGames(games, mode) {
    if (mode === 'all') return games;
    return (Array.isArray(games) ? games : []).filter(g => g && String(g.mode || '其他') === mode);
  }

  function renderHolder() {
    const box = document.getElementById('ppHolder');
    if (!box) return;
    const st = state();
    const games = (typeof homeGamesData !== 'undefined' && Array.isArray(homeGamesData)) ? homeGamesData : [];
    const info = ownerInfo();
    const sum = collect(filteredGames(games, st.mode), info.puuid);
    // 头像单独带上（collect 不关心是谁的头像）
    sum.avatar = info.avatar;
    const el = document.querySelector('#poroPoster .pp-hint');
    if (!sum.n) {
      box.innerHTML = '<div class="pp-none">这个模式下还没有对局记录</div>';
      if (el) el.textContent = '';
      return;
    }
    box.innerHTML = build(sum, {
      name: info.name, tag: info.tag, puuid: info.puuid, level: info.level, avatar: info.avatar,
      modeLabel: st.mode === 'all' ? '全部模式' : st.mode,
      dark: document.body.classList.contains('dark')
    });
    if (el) el.textContent = '最近 ' + sum.n + ' 场 · 预览即导出效果';
  }

  function renderTabs() {
    const bar = document.querySelector('#poroPoster .pp-tabs');
    if (!bar) return;
    const games = (typeof homeGamesData !== 'undefined' && Array.isArray(homeGamesData)) ? homeGamesData : [];
    const info = ownerInfo();
    const st = state();
    const list = modesOf(games, info.puuid);
    if (!list.some(m => m.key === st.mode)) st.mode = 'all';
    bar.innerHTML = list.map(m => '<button type="button" class="pp-tab' + (m.key === st.mode ? ' on' : '')
      + '" data-mode="' + escapeHtml(m.key) + '">'
      + escapeHtml(m.key === 'all' ? '全部' : m.key) + '<i>' + m.n + '</i></button>').join('');
  }

  function close() {
    const el = document.getElementById('poroPoster');
    if (!el) return;
    el.classList.remove('show');
    setTimeout(() => { if (!el.classList.contains('show')) el.hidden = true; }, 180);
  }

  function open() {
    const games = (typeof homeGamesData !== 'undefined' && Array.isArray(homeGamesData)) ? homeGamesData : [];
    if (!games.length) { showToast('战绩还没加载好, 稍后再试', 'negative'); return; }
    let el = document.getElementById('poroPoster');
    if (!el) {
      el = document.createElement('div');
      el.id = 'poroPoster';
      el.className = 'pp-modal';
      el.hidden = true;
      el.innerHTML = '<div class="pp-dialog" role="dialog" aria-modal="true">'
        + '<div class="pp-dhead"><b>生涯海报</b><div class="pp-tabs"></div>'
        + '<button type="button" class="pp-close" title="关闭 (Esc)">×</button></div>'
        + '<div class="pp-scroll"><div id="ppHolder"></div></div>'
        + '<div class="pp-dfoot"><span class="pp-hint"></span>'
        + '<button type="button" class="btn-primary pp-go">生成图片</button></div></div>';
      document.body.appendChild(el);
      el.querySelector('.pp-close').addEventListener('click', close);
      el.addEventListener('mousedown', ev => { if (ev.target === el) close(); });
      document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !el.hidden) close(); });
      el.querySelector('.pp-tabs').addEventListener('click', ev => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('.pp-tab') : null;
        if (!btn) return;
        state().mode = btn.getAttribute('data-mode') || 'all';
        renderTabs();
        renderHolder();
      });
      el.querySelector('.pp-go').addEventListener('click', () => { exportPng(); });
    }
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('show'));
    renderTabs();
    renderHolder();
  }

  // ---------- 出图 ----------
  async function exportPng() {
    const st = state();
    if (st.busy) { showToast('上一张还在生成, 稍等一下', 'info'); return; }
    const games = (typeof homeGamesData !== 'undefined' && Array.isArray(homeGamesData)) ? homeGamesData : [];
    const info = ownerInfo();
    const sum = collect(filteredGames(games, st.mode), info.puuid);
    if (!sum.n) { showToast('这个模式下没有对局', 'negative'); return; }
    sum.avatar = info.avatar;
    st.busy = true;
    const go = document.querySelector('#poroPoster .pp-go');
    if (go) { go.disabled = true; go.textContent = '生成中…'; }
    try {
      // 离屏窗口只等 600ms：外链图必须先落成本地 dataURL，否则导出的图上装备/头像全是空格
      await warmImages(sum);
      const html = build(sum, {
        name: info.name, tag: info.tag, puuid: info.puuid, level: info.level, avatar: info.avatar,
        modeLabel: st.mode === 'all' ? '全部模式' : st.mode,
        dark: document.body.classList.contains('dark')
      });
      if (!html) { showToast('没有可用的对局数据', 'negative'); return; }
      const size = measure(html);
      const theme = document.body.classList.contains('dark') ? 'dark' : 'light';
      const renderOpts = { title: '生涯海报预览', saveTitle: '保存生涯海报', prefix: 'Poro生涯', theme };
      showToast('正在生成图片…', 'info');
      const r = await lolAPI.renderShareCard(html, size.width, size.height, renderOpts)
        .catch(e => ({ __error: (e && e.message) || String(e) }));
      if (r && r.ok && r.dataUrl) {
        close();
        if (root.PoroBattleCard && typeof root.PoroBattleCard.preview === 'function') {
          root.PoroBattleCard.preview(r.dataUrl, renderOpts);
        }
        return;
      }
      showToast('生成图片失败: ' + ((r && r.__error) || '未知错误'), 'negative');
    } catch (e) {
      showToast('生成图片失败: ' + ((e && e.message) || e), 'negative');
    } finally {
      st.busy = false;
      if (go) { go.disabled = false; go.textContent = '生成图片'; }
    }
  }

  root.PoroProfilePoster = {
    open, close, collect, modesOf, build, measure, exportPng, warmImages,
    _format: { num, bigNum, durText, durShort, median }, _CARD_W: CARD_W
  };
})(typeof window !== 'undefined' ? window : this);
