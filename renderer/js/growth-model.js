// 成长页的数据模型：跨局训练计划 + 本机长期趋势。
//
// 两块数据来源完全不同，这里刻意分开：
//   1. 训练计划 —— 读本机已缓存的 AI 复盘文本 (store 里 aiReview:<gameId>.t<style>.p4)，
//      把每局复盘的"问题类"要点按主题归类，统计哪些问题在多局里反复出现。
//      不调用模型、不新增请求，纯本地聚合。
//   2. 长期趋势 —— 读本机对局台账 (gameLedger)，每次首页加载战绩时增量写入，
//      因此能跨会话累积到 SGP 接口一次只给 50 局的限制之外。
//
// 设计原则（与 enemy-intel 一致）：
//   - 只报能数出来的事实：几局提到、哪一局、原句是什么；不做"你在变强"这类判断；
//   - 样本不足就明确说不足，不硬凑结论；
//   - 纯函数，无 DOM / 无 IO，可在 node 里直接断言。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  if (root) root.PoroGrowth = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const DAY = 86400000;
  const REVIEW_WINDOW = 10;    // 只统计最近 N 局的复盘
  const MIN_REVIEWS = 3;       // 少于这么多局复盘就不出计划（一局的问题不叫共性问题）
  const MIN_HIT = 2;           // 同一主题至少被几局提到才算"反复出现"
  const PLAN_LIMIT = 3;        // 最多给几条训练目标
  const LEDGER_CAP = 800;      // 台账最多留多少局
  const LEDGER_KEEP_DAYS = 400;
  const QUOTE_MAX = 60;

  // 问题主题词表。顺序即优先级：一条要点命中第一个主题就归进去，
  // 所以"站位"这类多义词放在团战里、死亡类只留真正的死亡描述，避免互相抢。
  const CATS = [
    { key: 'cs', label: '补刀与发育', kw: ['补刀', '刀数', '发育', '兵线', '漏刀', '吃线', '推线', '塔刀', 'farm', 'farm差'],
      action: '每波兵清完看一眼小地图，别为了多补两个兵掉血；回城前把线状态调到能推回来。' },
    { key: 'vision', label: '视野与地图', kw: ['视野', '插眼', '眼位', '排眼', '小地图', '扫描', '控图', '没眼'],
      action: '每次回城带一个控制守卫，进河道前先在手边草丛落眼，别裸走进黑区。' },
    { key: 'death', label: '阵亡控制', kw: ['阵亡', '死亡', '死太多', '送头', '被抓', '被单杀', '单杀', '越塔', '送掉', '白给', '掉点', '被抓死'],
      action: '血量低于一半先退到塔下再判断，别在没视野的河道换血；一波团先求活再求杀。' },
    { key: 'fight', label: '团战站位与输出', kw: ['团战', '开团', '先手', '切入', '集火', '站位', '拉扯', '输出位置', '承伤', '绕后', '跟团', '被开'],
      action: '开团前先确认自己站在第二排、有退路；技能留给对面突进而不是见人就交。' },
    { key: 'objective', label: '资源运营', kw: ['大龙', '小龙', '先锋', '龙坑', '远古龙', '推塔', '塔皮', '分推', '带线', '先锋团', '控龙'],
      action: '资源刷新前 60 秒先把线推过去、把眼做到龙坑，别等刷了才集合。' },
    { key: 'roam', label: '支援与节奏', kw: ['参团', '支援', '游走', 'gank', '抓人', '节奏', '回城', '刷野', '清野', '支援慢'],
      action: '清完野/线先看边路血量差，能打就抓，不能打就回自己野区；别在路上空转。' },
    { key: 'skill', label: '技能释放', kw: ['技能', '空大', '空技能', '命中', '连招', '预判', '空放', '大招'],
      action: '关键技能等对面交完位移再打，宁可晚半秒也别抢那一下。' },
    { key: 'economy', label: '经济与出装', kw: ['经济', '金币', '出装', '装备', '落后', '领先', '性价比', '补装'],
      action: '劣势局先出能落地的过渡装，不要憋大件；每分钟对着补刀数看一次经济差。' },
    { key: 'mind', label: '决策与心态', kw: ['决策', '犹豫', '急躁', '心态', '判断', '取舍', '冒险', '上头', '节奏拖'],
      action: '每波团前问一句"这波我必须打吗"，打完立刻决定推还是退，别原地僵住。' }
  ];

  // 旧版主进程按分片解码，4 字节字符（emoji）被从中间切开时两侧各留一个 U+FFFD，
  // 这个码位在微软雅黑里画出来就是 ◆，于是原句变成"前期◆◆◆◆全段导致崩盘"。
  // 主进程已改成先攒 Buffer 再整体解码，但本地缓存里那些旧文本还是坏的，读出来必须抹掉。
  const BAD_CHAR = /\uFFFD/;

  function scrub(s) {
    return String(s == null ? '' : s)
      .replace(/[\uFFFD\u200B-\u200D\uFEFF]/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 这些标签下的要点算"问题"。没有标签的要点只有在整局没有任何问题标签时才兜底参与。
  const ISSUE_TAGS = /^(问题|失误|败因|短板|风险|槽点|改进|改进点|建议|下一步|优化|问题点|失误点)$/;
  const TAG_RE = /^【([^】]{1,10})】\s*(.*)$/;
  const TAG2_RE = /^(亮点|胜因|优势|做得好|值得肯定|问题|失误|败因|短板|风险|槽点|建议|改进|改进点|下一步|优化|总评|关键|数据|复盘)\s*[：:]\s*(.*)$/;

  // ---------- 复盘文本解析 ----------
  // 只取"一行一条"的要点行；总评那种整段话不参与归类（它往往覆盖多个主题，按句首切分不靠谱）。
  // damaged 标记这一行原本带过 U+FFFD：抹掉后句子会少字，但仍能表达大意，
  // 所以允许它当证据，只是同一主题里有完好的句子时优先挑完好的那句。
  function itemsOf(text) {
    const out = [];
    const lines = String(text || '').split(/\r?\n/);
    for (const raw of lines) {
      const damaged = BAD_CHAR.test(raw);
      let line = scrub(raw).replace(/^\s*[-*•·]\s*/, '').replace(/^\s*\d+[.、)]\s*/, '').trim();
      if (!line) continue;
      let tag = '', body = line;
      let m = TAG_RE.exec(line);
      if (m) { tag = m[1]; body = m[2]; }
      else {
        m = TAG2_RE.exec(line);
        if (m) { tag = m[1]; body = m[2]; }
      }
      body = scrub(body);
      if (!body) continue;
      out.push({ tag, body, damaged });
    }
    return out;
  }

  function catOf(text) {
    const s = String(text || '').toLowerCase();
    if (!s) return null;
    for (const c of CATS) {
      for (const k of c.kw) {
        if (s.indexOf(k.toLowerCase()) !== -1) return c;
      }
    }
    return null;
  }

  // 一局复盘命中的主题 → { key: { cat, quote, damaged, mentions } }
  // 原句优先取"问题标签"下的那一条：总评、亮点、建议里的句子往往覆盖多个主题，
  // 拿它当某个具体问题的证据会张冠李戴（实测把总评"视野没跟上"当成了河道被抓的原句）。
  // 同优先级里先挑没被截断过的句子，再比长度——被抹过乱码的句子少几个字，不该因为"更长"胜出。
  function gameCats(text) {
    const items = itemsOf(text);
    const hits = new Map();
    const add = (it, strong) => {
      const c = catOf(it.body);
      if (!c) return;
      const dmg = !!it.damaged;
      const cur = hits.get(c.key);
      if (!cur) { hits.set(c.key, { cat: c, quote: it.body, damaged: dmg, mentions: 1, strong }); return; }
      cur.mentions++;
      let better;
      if (strong && !cur.strong) better = true;
      else if (strong !== cur.strong) better = false;
      else if (cur.damaged && !dmg) better = true;
      else if (cur.damaged !== dmg) better = false;
      else better = it.body.length > cur.quote.length;
      if (better) { cur.quote = it.body; cur.damaged = dmg; cur.strong = !!strong; }
    };
    const used = new Set();
    for (const it of items) {
      if (!ISSUE_TAGS.test(it.tag)) continue;
      add(it, true);
      used.add(it);
    }
    // 整局一条问题标签都没有，或某些主题只出现在"关键/建议"里时兜底
    for (const it of items) {
      if (used.has(it)) continue;
      add(it, false);
    }
    return hits;
  }

  function clip(s, n) {
    const t = scrub(s).replace(/\s+/g, ' ');
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  // ---------- 训练计划 ----------
  // reviews: [{ gameId, text, at }]；games: homeGamesData（新局在前，用来还原时间/胜负）
  function buildTrainingPlan(opts) {
    const o = opts || {};
    const now = +o.now || Date.now();
    const reviews = Array.isArray(o.reviews) ? o.reviews : [];
    const games = Array.isArray(o.games) ? o.games : [];
    const byId = new Map();
    for (const g of games) if (g && g.gid != null) byId.set(String(g.gid), g);

    const list = reviews
      .filter(r => r && String(r.text || '').trim())
      // 只认当前战绩列表里的对局：看别人档案时也会产生 AI 复盘缓存，
      // 那些局不在自己的 games 里，混进来会让训练计划变成"给别人的建议"。
      .filter(r => !games.length || byId.has(String(r.gameId)))
      .map(r => {
        const g = byId.get(String(r.gameId));
        const t = (g && +g.time) || +r.at || 0;
        return { gameId: String(r.gameId || ''), text: r.text, at: +r.at || 0, t };
      })
      .sort((a, b) => b.t - a.t)
      .slice(0, REVIEW_WINDOW);

    // 窗口场次：按 games 的最近 N 局算，用于"复盘覆盖 X/10"
    const windowGames = games.slice(0, REVIEW_WINDOW).filter(g => g && g.participants);
    let wins = 0, losses = 0;
    for (const r of list) {
      const g = byId.get(r.gameId);
      const me = g && Array.isArray(g.participants)
        ? g.participants.find(p => p && p.puuid === o.puuid)
        : null;
      if (!me) continue;
      if (me.win) wins++; else losses++;
    }

    const base = {
      reviewed: list.length,
      // 有几局的复盘文本带着旧版解码留下的 U+FFFD（抹掉了乱码，但原字回不来）。
      // 数字交给调用方决定怎么提示，模型层不写死措辞。
      damaged: list.filter(r => BAD_CHAR.test(String(r.text || ''))).length,
      windowSize: windowGames.length || REVIEW_WINDOW,
      minReviews: MIN_REVIEWS,
      wins, losses,
      targets: [],
      note: '',
      span: ''
    };
    if (list.length < MIN_REVIEWS) {
      base.note = `最近 ${base.windowSize} 局里只有 ${list.length} 局做过 AI 复盘，至少 ${MIN_REVIEWS} 局才能归纳共性问题。`;
      return base;
    }

    const tally = new Map();
    for (const r of list) {
      const hits = gameCats(r.text);
      for (const [key, hit] of hits) {
        let row = tally.get(key);
        if (!row) {
          row = { key, label: hit.cat.label, action: hit.cat.action, games: [], mentions: 0, quote: '', damaged: true };
          tally.set(key, row);
        }
        row.games.push(r.gameId);
        row.mentions += hit.mentions;
        // 跨局选证据句：先挑没被截断过的，再比长度（受损句少几个字，长度不具参考性）
        const replace = !row.quote
          || (row.damaged && !hit.damaged)
          || (row.damaged === !!hit.damaged && hit.quote.length > row.quote.length);
        if (replace) { row.quote = hit.quote; row.damaged = !!hit.damaged; }
      }
    }

    const rows = [...tally.values()]
      .filter(r => r.games.length >= MIN_HIT)
      .sort((a, b) => (b.games.length - a.games.length) || (b.mentions - a.mentions));

    base.targets = rows.slice(0, PLAN_LIMIT).map(r => ({
      key: r.key,
      label: r.label,
      games: r.games.length,
      mentions: r.mentions,
      reviewed: list.length,
      quote: clip(r.quote, QUOTE_MAX),
      action: r.action
    }));
    if (!base.targets.length) {
      base.note = `最近 ${list.length} 局复盘里没有反复出现的问题（同一主题至少 ${MIN_HIT} 局才算）。`;
    }
    const first = list[list.length - 1];
    if (first && first.t) {
      base.span = `复盘区间 ${fmtDate(first.t)} 至今`;
    }
    void now;
    return base;
  }

  function fmtDate(ts) {
    const d = new Date(+ts || 0);
    if (!+d) return '';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  // ---------- 本机对局台账 ----------
  // 只存判断趋势必需的字段，一局约 90 字节，800 局 ≈ 72KB，放在 poro-config.json 里可接受。
  function compactGame(game, puuid, isExcluded) {
    if (!game || !Array.isArray(game.participants)) return null;
    if (typeof isExcluded === 'function' && isExcluded({ mode: game.mode, queueId: game.queueId, gameType: game.gameType })) return null;
    const me = game.participants.find(p => p && p.puuid && p.puuid === puuid);
    if (!me) return null;
    const t = +game.time || 0;
    if (!t) return null;
    return {
      id: String(game.gid || game.gameId || ''),
      t,
      q: Number(game.queueId) || 0,
      c: Number(me.championId) || 0,
      p: String(me.position || me.role || '').trim(),
      w: me.win ? 1 : 0,
      k: +me.k || 0,
      d: +me.d || 0,
      a: +me.a || 0,
      cs: +me.cs || 0,
      dur: Math.max(0, Math.round(+game.dur || 0))
    };
  }

  // 增量并入台账：按 id 去重、按时间倒序、截断到上限并丢掉过老的记录。
  function mergeLedger(existing, games, puuid, isExcluded, now) {
    const t0 = +now || Date.now();
    const map = new Map();
    const push = rec => {
      if (!rec || !rec.id) return;
      if (!map.has(rec.id)) map.set(rec.id, rec);
    };
    for (const r of Array.isArray(existing) ? existing : []) {
      if (r && r.id && +r.t) push(r);
    }
    let added = 0;
    for (const g of Array.isArray(games) ? games : []) {
      const rec = compactGame(g, puuid, isExcluded);
      if (!rec) continue;
      if (!map.has(rec.id)) added++;
      push(rec);
    }
    const rows = [...map.values()]
      .filter(r => r.t >= t0 - LEDGER_KEEP_DAYS * DAY)
      .sort((a, b) => b.t - a.t)
      .slice(0, LEDGER_CAP);
    return { records: rows, added };
  }

  // ---------- 长期趋势 ----------
  function statsOf(rows) {
    const n = rows.length;
    let k = 0, d = 0, a = 0, cs = 0, dur = 0, w = 0;
    const champs = {};
    for (const r of rows) {
      k += +r.k || 0; d += +r.d || 0; a += +r.a || 0;
      cs += +r.cs || 0; dur += +r.dur || 0;
      if (r.w) w++;
      const c = +r.c || 0;
      if (c) champs[c] = (champs[c] || 0) + 1;
    }
    const mins = dur / 60;
    return {
      n, wins: w,
      wr: n ? Math.round(w / n * 100) : null,
      kda: n ? +((k + a) / Math.max(1, d)).toFixed(1) : null,
      dAvg: n ? +(d / n).toFixed(1) : null,
      csMin: mins > 0 ? +(cs / mins).toFixed(1) : null,
      champs
    };
  }

  function breakdownOf(rows, key) {
    const map = new Map();
    for (const r of rows) {
      const value = String(r?.[key] || '').trim() || (key === 'p' ? '未识别位置' : '未知英雄');
      let row = map.get(value);
      if (!row) row = { key: value, n: 0, wins: 0, wr: null, dAvg: 0, kda: 0 };
      row.n++; if (r.w) row.wins++;
      row.dAvg += +r.d || 0;
      row.kda += ((+r.k || 0) + (+r.a || 0)) / Math.max(1, +r.d || 0);
      map.set(value, row);
    }
    return [...map.values()].map(r => ({ ...r, wr: Math.round(r.wins / r.n * 100), dAvg: +(r.dAvg / r.n).toFixed(1), kda: +(r.kda / r.n).toFixed(1) }))
      .sort((a, b) => b.n - a.n || b.wr - a.wr);
  }

  function topChamps(champs, limit) {
    return Object.entries(champs || {})
      .map(([id, n]) => ({ id: +id, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, limit || 3);
  }

  function weekStart(ts) {
    const d = new Date(+ts || 0);
    d.setHours(0, 0, 0, 0);
    const dow = (d.getDay() + 6) % 7;   // 周一为 0
    d.setDate(d.getDate() - dow);
    return d.getTime();
  }

  // records 为台账（新局在前）
  function buildTrend(records, now) {
    const t0 = +now || Date.now();
    const rows = (Array.isArray(records) ? records : []).filter(r => r && +r.t);
    const since = days => rows.filter(r => +r.t >= t0 - days * DAY);
    const d30 = since(30), d90 = since(90);
    const prev30 = rows.filter(r => +r.t >= t0 - 60 * DAY && +r.t < t0 - 30 * DAY);
    const oldest = rows.length ? Math.min(...rows.map(r => +r.t)) : 0;
    const s30 = statsOf(d30), sPrev = statsOf(prev30), s90 = statsOf(d90);

    // 近 13 周（约 90 天）按周聚合，用来画柱状图：周胜率需要样本，样本 <2 场的周只画灰色空柱
    const thisWeek = weekStart(t0);
    const weeks = [];
    for (let i = 12; i >= 0; i--) {
      const start = thisWeek - i * 7 * DAY;
      const end = start + 7 * DAY;
      const bucket = rows.filter(r => +r.t >= start && +r.t < end);
      const s = statsOf(bucket);
      weeks.push({ start, n: s.n, wins: s.wins, wr: s.wr });
    }

    return {
      total: rows.length,
      firstAt: oldest || 0,
      spanDays: oldest ? Math.round((t0 - oldest) / DAY) : 0,
      currentWeekStart: thisWeek,
      currentWeekEnd: thisWeek + 6 * DAY,
      currentWeekGames: weeks[weeks.length - 1] ? weeks[weeks.length - 1].n : 0,
      d30: s30,
      prev30: sPrev,
      d90: s90,
      byChampion: breakdownOf(d90, 'c'),
      byPosition: breakdownOf(d90, 'p'),
      wrDelta: (s30.wr != null && sPrev.wr != null) ? s30.wr - sPrev.wr : null,
      weeks,
      champs30: topChamps(s30.champs, 3),
      champs90: topChamps(s90.champs, 3),
      enough: rows.length >= 5
    };
  }

  return {
    CATS, MIN_REVIEWS, MIN_HIT, REVIEW_WINDOW, LEDGER_CAP,
    itemsOf, catOf, gameCats, buildTrainingPlan,
    compactGame, mergeLedger, buildTrend, statsOf, weekStart, fmtDate
  };
});
