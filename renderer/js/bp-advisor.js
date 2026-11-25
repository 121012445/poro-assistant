// BP 对位建议：选人阶段按**敌方已亮英雄的对位胜率**实时给出「该 pick 谁 / 该 ban 谁」。
//
// 与 autobp.js 的分工：那边是"按预设名单替你把英雄点下去"（会写客户端），
// 这边只读会话、只出建议，一个 PATCH 都不发 —— 决策权仍在人手上。
//
// 数据：main 的 opgg:counters（GET /api/KR/champions/ranked/{id}/{pos}/counters），
// 每个 (英雄,位置) 返回 40+ 条全池对位。首页那份 rank 接口只有 3 条，不够用。
// 胜率方向：win 是**被列出英雄自己**的胜率（两方向互为补数，实测 52.31 ⇄ 47.69），
// 所以"C 打敌方 E 的胜率" = 查 E 的对位表里的 C，不用取反。
//
// 打分（单位：百分点，正数=优势）：
//   score = 0.6 × (自身该位置胜率 − 50) + Σ 对位优势 × 距离权重 × 样本权重
//   距离权重：敌方同位置（可能对线）1.0，其他位置 0.35（只影响团战/后期）
//   样本权重：min(1, 对位场次 / 300)；对位场次 < 50 视为无数据，不参与计分
// 宁可少给一个建议，也不拿 8 场的小样本吹成"克制"。
(function (root) {
  'use strict';

  // LCU assignedPosition → 内部位置键
  const ENUM_TO_KEY = { TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'mid', BOTTOM: 'adc', UTILITY: 'support' };
  // op.gg 的 position.name / opggPosList[].positionKey 是另一套大写（ADC/SUPPORT），单独映射
  const RAW_TO_KEY = { TOP: 'top', JUNGLE: 'jungle', MID: 'mid', ADC: 'adc', SUPPORT: 'support' };
  const KEY_CN = { top: '上单', jungle: '打野', mid: '中单', adc: '下路', support: '辅助' };

  // 1.6.72 浮窗筛选条。默认口径与老版本一致（KR / 全部段位 / 跟随我的位置），
  // 筛选改变时清掉所有按维度缓存的 table，再拿 _lastSession 重算一帧推回去。
  const FILTER_REGIONS = ['kr', 'global', 'na', 'euw', 'eune', 'br', 'jp', 'lan', 'las', 'oce', 'ru', 'tr', 'vn', 'tw', 'sg'];
  const FILTER_TIERS = ['all', 'iron', 'bronze', 'silver', 'gold', 'gold_plus', 'platinum', 'platinum_plus',
    'emerald', 'emerald_plus', 'diamond', 'diamond_plus', 'master', 'master_plus', 'grandmaster', 'challenger'];
  const FILTER_POSITIONS = ['auto', 'top', 'jungle', 'mid', 'adc', 'support'];
  const FILTER_DEFAULT = { region: 'kr', tier: 'all', position: 'auto', version: 'auto' };
  let _filters = Object.assign({}, FILTER_DEFAULT);
  let _filterVersion = '';

  const MIN_PLAY = 50;       // 对位样本下限
  const SAMPLE_FULL = 300;   // 样本权重封顶场次
  const LANE_WEIGHT = 1;     // 敌方同位置
  const OFF_WEIGHT = 0.35;   // 敌方其他位置
  const BASE_WEIGHT = 0.6;   // 自身强度权重
  const PICK_COUNT = 5;
  const BAN_COUNT = 3;

  const sign = n => (n >= 0 ? '+' : '') + n.toFixed(1);
  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s)) : String(s));

  // ---------- 会话解析 ----------
  function posKeyOf(slot) {
    const raw = String((slot && (slot.assignedPosition || slot.position)) || '').toUpperCase();
    return ENUM_TO_KEY[raw] || '';
  }

  // 敌方/我方没有 assignedPosition 时（盲选、自定义），用 op.gg 的主玩位置推一个，
  // 并标记 guessed —— 猜出来的位置只用来挑对位表，界面上要说清是推断。
  function guessPos(championId) {
    const o = (typeof opggMap !== 'undefined' && opggMap) ? opggMap[+championId] : null;
    const first = o && Array.isArray(o.positions) ? o.positions[0] : null;
    const key = first ? RAW_TO_KEY[String(first.name || '').toUpperCase()] : '';
    return key || '';
  }

  function readSession(session) {
    const state = {
      inChampSelect: false,
      myPosition: '',
      myChampionId: 0,
      myIntentId: 0,
      enemy: [],          // [{ id, pos, guessed }]
      ally: [],           // [{ id, pos }]
      openPositions: [],  // 己方还没定人的分路 [{ pos, cellId, mine }] —— 阵容视角的候选位
      unavailable: new Set(),
      bannedMy: [],
      bannedTheir: [],
      myAction: ''        // 'ban' / 'pick' / ''：当前轮到我的动作类型
    };
    if (!session || typeof session !== 'object') return state;
    const myTeam = Array.isArray(session.myTeam) ? session.myTeam : [];
    const theirTeam = Array.isArray(session.theirTeam) ? session.theirTeam : [];
    if (!myTeam.length && !theirTeam.length) return state;
    state.inChampSelect = true;

    const me = myTeam.find(p => p && p.cellId === session.localPlayerCellId) || {};
    state.myPosition = posKeyOf(me);
    state.myChampionId = +me.championId || 0;
    state.myIntentId = +me.championPickIntent || 0;

    const theirCells = new Set(theirTeam.map(p => p && p.cellId).filter(v => v != null));
    const actions = Array.isArray(session.actions) ? session.actions.flat() : [];

    const addEnemy = (id, pos) => {
      if (!id || state.enemy.some(e => e.id === id)) return;
      const p = posKeyOf(theirTeam.find(t => +t.championId === id || +t.championPickIntent === id));
      const key = pos || p || guessPos(id);
      state.enemy.push({ id, pos: key, guessed: !(pos || p) });
      state.unavailable.add(id);
    };

    for (const p of theirTeam) {
      if (+p.championId > 0) addEnemy(+p.championId, posKeyOf(p));
    }
    // locked = 已锁, intent = 只预选(悬停)。1.6.32: 两者都要, 但界面和打分的用法不同 ——
    // 已锁的英雄已经占住一个位置, 预选可能改; ban 建议要针对"队友真想玩什么"。
    for (const p of myTeam) {
      if (+p.championId > 0) {
        state.ally.push({ id: +p.championId, pos: posKeyOf(p), locked: true, cellId: p.cellId });
        state.unavailable.add(+p.championId);
      }
      if (+p.championPickIntent > 0 && +p.championPickIntent !== +p.championId) {
        state.ally.push({ id: +p.championPickIntent, pos: posKeyOf(p), intent: true, cellId: p.cellId });
        state.unavailable.add(+p.championPickIntent);
      }
    }
    // 正在进行的动作里若已填了英雄（对面 hover / 锁定前一刻），也当作"已亮"
    for (const a of actions) {
      if (!a || !a.championId || a.championId <= 0) continue;
      if (a.type === 'ban') state.unavailable.add(+a.championId);
      if (a.type === 'pick' && theirCells.has(a.actorCellId)) addEnemy(+a.championId, '');
      if (a.type === 'pick' && a.actorCellId === session.localPlayerCellId) {
        state.unavailable.add(+a.championId);
        if (!state.myChampionId) state.myChampionId = +a.championId;
      }
      if (a.actorCellId === session.localPlayerCellId && a.isInProgress) state.myAction = a.type;
    }

    const bans = session.bans || {};
    const addBans = (list, bucket) => {
      for (const raw of (Array.isArray(list) ? list : [])) {
        const id = +raw;
        if (id > 0) { bucket.push(id); state.unavailable.add(id); }
      }
    };
    addBans(bans.myTeamBans, state.bannedMy);
    addBans(bans.theirTeamBans, state.bannedTheir);

    if (state.myChampionId) state.unavailable.add(state.myChampionId);
    if (state.myIntentId) state.unavailable.add(state.myIntentId);

    // 1.6.68: 己方还没定人的分路 —— 阵容视角要给每个空位都出候选，而不是只看自己那路。
    // 顺序: 自己在最前（他的候选不该被队友位抢走），其余按 cellId（= 选人顺位）。
    // 位置已定（有人锁了/预选了）就把这个位置标为占用，第二个人乱选同一位置时不再重复出现。
    const myCell = session.localPlayerCellId;
    const orderedSlots = myTeam.slice().sort((a, b) => {
      if (a.cellId === myCell) return -1;
      if (b.cellId === myCell) return 1;
      return (Number(a.cellId) || 0) - (Number(b.cellId) || 0);
    });
    const seenPos = new Set();
    for (const p of orderedSlots) {
      const pos = posKeyOf(p);
      if (!pos || seenPos.has(pos)) continue;
      seenPos.add(pos);
      const decided = state.ally.some(a => a.cellId === p.cellId && (a.locked || a.intent))
        || +p.championId > 0 || +p.championPickIntent > 0;
      if (decided) continue;
      state.openPositions.push({ pos, cellId: p.cellId, mine: p.cellId === myCell });
    }
    return state;
  }

  // ---------- 候选池 ----------
  function poolFor(positionKey) {
    const out = [];
    const seen = new Set();
    const list = (typeof opggPosList !== 'undefined' && Array.isArray(opggPosList)) ? opggPosList : [];
    for (const entry of list) {
      if (!entry || !entry.stats) continue;
      if (RAW_TO_KEY[String(entry.positionKey || '').toUpperCase()] !== positionKey) continue;
      const id = +entry.championId;
      if (!id || seen.has(id) || !Number.isFinite(entry.stats.win_rate)) continue;
      seen.add(id);
      out.push({
        id,
        winRate: entry.stats.win_rate,
        pickRate: entry.stats.pick_rate,
        banRate: entry.stats.ban_rate,
        play: entry.stats.play,
        tier: entry.stats.tier_data && entry.stats.tier_data.tier
      });
    }
    return out;
  }

  // ---------- 打分 ----------
  // tables: { '敌人id:位置键' -> { '候选id' -> { play, wr } } }
  // opts.fitOf(id) -> 补位加分（百分点），来自 bp-team 的阵容缺口分析。
  //   不传时行为与 1.6.31 完全一致（score 就是对位分），旧测试与旧调用不受影响。
  // pos: 要评估的候选位置，缺省 = 我自己那一路（1.6.68 起阵容建议要按别的位置算）。
  //   对位权重按"敌方这个人是不是和我这个候选同位置"判断，所以换了 pos 之后
  //   权重也跟着换 —— 给队友中单位的建议，不会拿我上路那条对位线去算。
  function recommendFor(state, tables, pos, opts) {
    const t = tables || {};
    const o = opts || {};
    const fitOf = (typeof o.fitOf === 'function') ? o.fitOf : null;
    const limit = Number(o.limit) > 0 ? Number(o.limit) : PICK_COUNT;
    const position = pos || state.myPosition;
    const rows = [];
    for (const c of poolFor(position)) {
      if (state.unavailable.has(c.id)) continue;
      let score = (c.winRate - 0.5) * 100 * BASE_WEIGHT;
      const edges = [];
      let missing = 0;
      for (const en of state.enemy) {
        const table = en.pos ? t[en.id + ':' + en.pos] : null;
        if (!table) { missing++; continue; }
        const row = table[String(c.id)];
        if (!row || row.play < MIN_PLAY) { missing++; continue; }
        const delta = (row.wr - 0.5) * 100;
        const w = (en.pos === position ? LANE_WEIGHT : OFF_WEIGHT) * Math.min(1, row.play / SAMPLE_FULL);
        score += delta * w;
        edges.push({ enemyId: en.id, enemyName: champName(en.id), delta, play: row.play, lane: en.pos === position });
      }
      edges.sort((a, b) => b.delta * b.play - a.delta * a.play);
      const fit = fitOf ? (Number(fitOf(c.id)) || 0) : 0;
      rows.push({
        id: c.id, score, base: c.winRate, edges, missing, tier: c.tier, banRate: c.banRate,
        fit, total: score + fit
      });
    }
    rows.sort((a, b) => (b.total - a.total) || b.score - a.score || b.base - a.base);
    return rows.slice(0, limit);
  }

  // 老签名保持不变：就是"我那一路"的推荐。
  function recommend(state, tables, opts) {
    return recommendFor(state, tables, state.myPosition, opts);
  }

  // 1.6.68: 己方阵容视角 —— 每个还空着的位置各出 perPos 个候选。
  // 打分口径与单路完全一致（对位 + 缺口补位 + 本位置强度），只是把候选池换成
  // 那个位置自己的池子。跨位置做一次去重：一个英雄只出现在第一处（自己在最前），
  // 否则面板上会出现"打野阿木木 / 辅助阿木木"这种看起来像算错了的重复。
  function teamPicks(state, tables, opts) {
    const o = opts || {};
    const perPos = Number(o.perPos) > 0 ? Number(o.perPos) : 3;
    // 自己那一路下面已经有完整的「推荐 Pick」栏（带补位理由），这里只给首选，
    // 免得同一批候选在同一屏里出现两遍。
    const mineCount = Number(o.minePerPos) >= 0 ? Number(o.minePerPos) : 1;
    const slots = Array.isArray(state.openPositions) ? state.openPositions : [];
    if (!slots.length) return [];
    const used = new Set();
    const out = [];
    for (const slot of slots) {
      const want = slot.mine ? Math.max(1, mineCount) : perPos;
      // 去重会吃掉候选，多取几个再筛，保证每个位置都凑得够
      const rows = recommendFor(state, tables, slot.pos, { fitOf: o.fitOf, limit: want + used.size });
      const picks = [];
      for (const r of rows) {
        if (used.has(r.id)) continue;
        used.add(r.id);
        picks.push(r);
        if (picks.length >= want) break;
      }
      if (picks.length) out.push({ pos: slot.pos, posCn: KEY_CN[slot.pos] || slot.pos, mine: !!slot.mine, picks });
    }
    return out;
  }

  // ban 建议：我已选/预选 → 优先 ban 掉最克制我的；还没选 → 退化成版本强势（胜率 + ban 率）
  // opts.intents: 队友已锁/预选的英雄。我没选时优先 ban 掉"克制队友预选"的敌人 —— 帮队友清路。
  function recommendBans(state, tables, opts) {
    const t = tables || {};
    const o = opts || {};
    const intents = Array.isArray(o.intents) ? o.intents : [];
    const myId = state.myChampionId || state.myIntentId;
    const myTable = myId && state.myPosition ? t[myId + ':' + state.myPosition] : null;
    if (myTable) {
      const rows = Object.keys(myTable)
        .map(id => ({ id: +id, delta: (myTable[id].wr - 0.5) * 100, play: myTable[id].play }))
        .filter(r => r.delta > 0 && !state.unavailable.has(r.id))
        .sort((a, b) => b.delta * Math.min(1, b.play / SAMPLE_FULL) - a.delta * Math.min(1, a.play / SAMPLE_FULL))
        .slice(0, BAN_COUNT)
        .map(r => ({ ...r, basis: 'counter', score: r.delta * Math.min(1, r.play / SAMPLE_FULL) }));
      if (rows.length) return rows;
    }
    // 自己还没定 -> 先照顾队友的预选
    if (intents.length && root.PoroBPTeam) {
      const rows = root.PoroBPTeam.banAgainstIntents(intents, t, {
        exclude: state.unavailable, limit: BAN_COUNT, minPlay: MIN_PLAY
      }).map(r => {
        const best = r.hits[0] || { wr: 0.5, play: 0 };
        return {
          id: r.id, delta: (best.wr - 0.5) * 100, play: best.play,
          basis: 'intent', score: r.score, hits: r.hits,
          forName: champName(best.forId)
        };
      });
      if (rows.length) return rows;
    }
    return poolFor(state.myPosition)
      .filter(c => !state.unavailable.has(c.id))
      .map(c => ({
        id: c.id,
        delta: (c.winRate - 0.5) * 100,
        play: c.play || 0,
        banRate: c.banRate || 0,
        basis: 'meta',
        // 版本强势 = 胜率溢出 + 一半的 ban 率（别人都在 ban 它，说明它确实难打）
        score: (c.winRate - 0.5) * 100 + (c.banRate || 0) * 100 * 0.5
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, BAN_COUNT);
  }

  function champName(id) {
    const c = (typeof champNumMap !== 'undefined' && champNumMap) ? champNumMap[String(id)] : null;
    return c ? c.name : String(id);
  }
  function champKeyOf(id) {
    const c = (typeof champNumMap !== 'undefined' && champNumMap) ? champNumMap[String(id)] : null;
    return c ? c.id : '';
  }

  // ---------- 渲染 ----------
  // 一张卡片的"依据"文案。面板 HTML 与浮窗 HTML 共用同一段，
  // 免得同一个候选在主窗口和浮窗里给出两种说法。
  function whyText(item, kind) {
    let why = '';
    if (kind === 'pick') {
      const best = item.edges[0];
      const bits = [];
      if (best) {
        bits.push('对位 ' + esc(best.enemyName) + (best.lane ? '' : '（非对线）') + ' ' + sign(best.delta));
      }
      // 1.6.32: 补位加分只在我方已有人亮时才存在（fit > 0），否则不提，免得每张卡都写"补位"
      if (item.fit) bits.push('补位 +' + item.fit.toFixed(1));
      bits.push('自身 ' + (item.base * 100).toFixed(1) + '%');
      if (item.missing) bits.push(item.missing + ' 人无对位样本');
      why = bits.join(' · ');
    } else if (item.basis === 'counter') {
      why = '克制你 ' + (50 + item.delta).toFixed(1) + '% · 样本 ' + item.play;
    } else if (item.basis === 'intent') {
      const top = item.hits && item.hits[0];
      why = '克制队友 ' + esc(item.forName || '') + (top ? ' ' + (top.wr * 100).toFixed(1) + '%' : '')
        + (item.hits && item.hits.length > 1 ? ' · 还克 ' + esc(champName(item.hits[1].forId)) : '');
    } else {
      why = '版本强势 ' + (50 + item.delta).toFixed(1) + '% · ban ' + ((item.banRate || 0) * 100).toFixed(1) + '%';
    }
    return why;
  }

  function cardHtml(item, kind) {
    const key = champKeyOf(item.id);
    if (!key) return '';
    const name = esc(champName(item.id));
    let scoreText = sign(item.score);
    if (kind === 'pick') {
      // 没有任何对位样本时：如果这手是靠"补我方缺口"进来的，就把补位后的总分显示出来，
      // 否则显示「无对位样本」——那才是这张卡的真实依据。
      if (!item.edges.length) scoreText = item.fit ? sign(item.total) : '无对位样本';
      else if (item.fit) scoreText = sign(item.total);
    } else if (item.basis === 'counter') {
      // ban 的分数是" ban 优先级", 不是胜率差 —— 不带正负号, 免得看成 +7% 优势
      scoreText = item.score.toFixed(1);
    } else {
      scoreText = item.score.toFixed(1);
    }
    const why = whyText(item, kind);
    const cls = kind === 'pick' ? (item.score >= 0 ? 'pos' : 'neg') : 'ban';
    return '<div class="bp-card" title="' + esc(why) + '">'
      + '<img class="bp-icon" src="' + (typeof champImg === 'function' ? champImg(key) : '') + '" loading="lazy" alt="">'
      + '<div class="bp-body">'
      + '<div class="bp-name"><span>' + name + '</span><b class="bp-score ' + cls + '">' + esc(scoreText) + '</b></div>'
      + '<div class="bp-why">' + why + '</div>'
      + '</div></div>';
  }

  // ---------- 对位数据 ----------
  // 方向（main 的 opgg:counters 注释里有实测）：每条 { champion_id, play, win } 的
  // win/play 是**列表主人自己**的胜率。所以 map[id].counters 里 wr 越高 = 我打他越顺。
  // 1.6.71: 以前还倒着扫一遍"别人的 counters 里有没有我"，当成"克制我的人"，
  // 但那份数据同样是他自己的胜率 —— 两侧都按降序取前 8，页面上两组标题正好互换。
  // 现在只认一个方向：我一个英雄的对位表，wr ≥ 50% 是优势，< 50% 是劣势。
  const CNT_MIN_PLAY = 30;                 // 网格展示下限（计分仍用 MIN_PLAY = 50）
  const CNT_CACHE_MS = 10 * 60 * 1000;

  function splitCounters(rows, myId) {
    const id = +myId;
    const list = [];
    const seen = new Set();
    for (const r of (rows || [])) {
      const cid = +((r && (r.championId != null ? r.championId : r.champion_id)) || 0);
      const play = +((r && r.play) || 0);
      const win = +((r && r.win) || 0);
      if (!cid || cid === id || seen.has(cid)) continue;
      if (!(play >= CNT_MIN_PLAY) || win < 0 || win > play) continue;
      seen.add(cid);
      list.push({ id: cid, play, win, wr: win / play });
    }
    if (!list.length) return null;
    list.sort((a, b) => b.wr - a.wr || b.play - a.play);
    return {
      good: list.filter(t => t.wr >= 0.5),
      bad: list.filter(t => t.wr < 0.5).sort((a, b) => a.wr - b.wr || b.play - a.play),
      total: list.length
    };
  }

  // 降级：没有位置 / 对位接口不可用时，用首页榜每个位置自带的 3 条 counters（可能稀疏）。
  function countersOf(numId) {
    const id = +numId;
    const map = (typeof opggMap !== 'undefined' && opggMap) ? opggMap : null;
    if (!map || !id || !map[id]) return null;
    const norm = v => (typeof normalizeChampId === 'function'
      ? normalizeChampId(v) : (+v >= 60000 ? +v - 60000 : +v));
    const rows = [];
    for (const pos of (map[id].positions || [])) {
      for (const ct of (pos.counters || [])) {
        rows.push({ championId: norm(ct && ct.champion_id), play: ct && ct.play, win: ct && ct.win });
      }
    }
    const out = splitCounters(rows, id);
    if (!out) return null;
    out.source = 'board';
    return out;
  }

  const _cntCache = new Map();

  // 1.6.72: 同一 (英雄,位置) 的胜率随地区/段位而变，缓存键必须带上这两个维度。
  function filterOpts() { return { region: _filters.region, tier: _filters.tier }; }
  function dimKey() { return _filters.region + '|' + _filters.tier; }

  // 全量对位（40+ 条）走 op.gg 的对位接口；同一 (英雄,位置,地区,段位) 10 分钟内只拉一次。
  async function loadCounters(numId, pos) {
    const id = +numId;
    const key = id + ':' + (pos || '-') + '|' + dimKey();
    const hit = _cntCache.get(key);
    if (hit) {
      if (Date.now() - hit.t <= CNT_CACHE_MS) return hit.data;
      _cntCache.delete(key);
    }
    const api = root.lolAPI;
    if (!pos || !api || typeof api.getOpggCounters !== 'function') return countersOf(id);
    try {
      const r = await api.getOpggCounters(id, pos, filterOpts());
      if (!r || r.__error || !Array.isArray(r.rows)) return countersOf(id);
      const data = splitCounters(r.rows, id);
      if (!data) return countersOf(id);
      data.source = 'full';
      _cntCache.set(key, { t: Date.now(), data });
      return data;
    } catch (e) { return countersOf(id); }
  }

  // 该英雄在该位置的强度数据（胜率/登场率/禁用率/梯队），来自首页榜 opggPosList。
  function statsOf(numId, pos) {
    const list = (typeof opggPosList !== 'undefined' && Array.isArray(opggPosList)) ? opggPosList : null;
    const id = +numId;
    if (!list || !id) return null;
    let first = null;
    for (const row of list) {
      if (+row.championId !== id) continue;
      if (!first) first = row;
      const k = RAW_TO_KEY[String(row.positionKey || '').toUpperCase()] || '';
      if (pos && k === pos) return row.stats || null;
    }
    return first ? (first.stats || null) : null;
  }

  // 1.6.72: 段位/地区变了，概要条的胜率/登场率/禁用率也要跟着换基准。
  // 用已有的 opgg:bench（同段位全英雄榜），不新开接口；版本也从它的 meta 拿。
  let _benchCache = null;
  async function benchOf() {
    const api = root.lolAPI;
    if (!api || typeof api.getOpggBench !== 'function') return null;
    const key = dimKey();
    if (_benchCache && _benchCache.key === key) return _benchCache.data;
    try {
      const b = await api.getOpggBench(_filters.tier, _filters.region);
      if (!b || b.__error || !b.champions) return null;
      _filterVersion = String(b.version || '').slice(0, 20);
      _benchCache = { key, data: b };
      return b;
    } catch (e) { return null; }
  }
  function benchStatsOf(b, numId, pos) {
    if (!b || !b.champions) return null;
    const row = b.champions[String(+numId)] || b.champions[+numId];
    if (!row) return null;
    const st = row[String(pos || '').toUpperCase()] || row[Object.keys(row)[0]];
    if (!st) return null;
    const rate = v => (Number.isFinite(+v) ? (+v) / 100 : null);
    return {
      win_rate: rate(st.winRate), pick_rate: rate(st.pickRate), ban_rate: rate(st.banRate),
      kda: st.kda, tier_data: { rank: st.rank || 0 }
    };
  }
  async function loadStats(numId, pos) {
    const b = await benchOf();
    // 首页榜自带 T 级梯队，默认口径优先用它；非默认段位/地区 bench 没有 T 级但有真实统计值。
    if (!b || (_filters.tier === 'all' && _filters.region === 'kr')) return statsOf(numId, pos);
    return benchStatsOf(b, numId, pos) || statsOf(numId, pos);
  }

  // 一格 = 头像 32px + 胜率 + 样本。密度照 League Akari 的 champion-data 网格
  // （46px 宽、gap 8px），一屏能扫完 40+ 个对位，而不是四列大卡片翻半天。
  function cntCells(rows) {
    return (rows || []).map(t => {
      const key = champKeyOf(t.id);
      if (!key) return '';
      const pct = (t.wr * 100).toFixed(2);
      return '<div class="cell" title="' + esc(champName(t.id) + ' · 对位 ' + pct + '% · 样本 ' + t.play) + '">'
        + '<b class="wr ' + (t.wr >= 0.5 ? 'good' : 'bad') + '">' + pct + '%</b>'
        + '<img src="' + (typeof champImg === 'function' ? champImg(key) : '') + '" loading="lazy" alt="">'
        + '<span class="p">' + t.play.toLocaleString() + '</span>'
        + '</div>';
    }).join('');
  }

  function tierOf(stats) {
    const t = stats && stats.tier_data ? stats.tier_data.tier : null;
    if (t == null || !Number.isFinite(+t)) return null;
    if (+t === 0) return { text: 'OP', cls: 't0' };
    const n = Math.min(5, Math.max(1, Math.round(+t)));
    return { text: 'T' + n, cls: 't' + n };
  }

  // 英雄数据页 = 概要条（梯队/位置/胜率/登场率/禁用率）+ 劣势/优势两段密集网格。
  function dataHtml(counters, myId, pos, stats) {
    const id = +myId;
    const key = id ? champKeyOf(id) : '';
    if (!key) return '';
    const st = stats || {};
    const tier = tierOf(st);
    const statCell = (label, v) => (v == null || !Number.isFinite(+v))
      ? '' : '<div><i>' + label + '</i><b>' + (+v * 100).toFixed(2) + '%</b></div>';
    const hero = '<div class="hero">'
      + '<img class="hero-img" src="' + (typeof champImg === 'function' ? champImg(key) : '') + '" alt="">'
      + '<div class="hero-main">'
      + '<div class="hero-name">' + esc(champName(id)) + '</div>'
      + '<div class="hero-sub">'
      + (tier ? '<span class="hero-tier ' + tier.cls + '">' + tier.text + '</span>' : '')
      + (pos ? '<span class="hero-pos">' + esc(KEY_CN[pos] || '') + '</span>' : '')
      + '</div></div>'
      + '<div class="hero-stats">'
      + statCell('胜率', st.win_rate)
      + statCell('登场率', st.pick_rate)
      + statCell('禁用率', st.ban_rate)
      + '</div></div>';

    const c = counters || { good: [], bad: [] };
    const sec = (title, tag, tagCls, rows, emptyText) => {
      const cells = cntCells(rows);
      const count = (rows || []).length;
      const head = '<div class="sec-head"><span>' + title + '</span>'
        + (count ? '<em>' + count + ' 个 · 样本 ≥' + CNT_MIN_PLAY + ' 场</em>'
          + '<em class="sec-tag ' + tagCls + '">' + tag + '</em>'
          : '<em>' + emptyText + '</em>')
        + '</div>';
      return '<div class="sec">' + head + (cells ? '<div class="grid">' + cells + '</div>' : '') + '</div>';
    };

    const note = (counters && counters.source === 'board')
      ? '<div class="hero-note">当前只拿到首页榜的稀疏对位（3 条），连上对位接口后会自动补全。</div>'
      : '';
    const foot = '<div class="bp-foot">胜率 = 你拿这个英雄对位他时的胜率（OP.GG 韩服排位，样本 ≥'
      + CNT_MIN_PLAY + ' 场）· 蓝色 ≥50%，红色 &lt;50% · 只做参考，不替你点</div>';
    return hero + note
      + sec('劣势对位', '打不过', 'bad', c.bad, '这一路没有明显打不过的对手')
      + sec('优势对位', '好打', 'good', c.good, '这一路没有明显优势对位')
      + foot;
  }



  // 1.6.68 阵容建议里每个候选的一句话依据（塞进 title，不占行宽）
  function tpWhy(item) {
    const bits = [];
    const best = item.edges && item.edges[0];
    if (best) bits.push('对位 ' + best.enemyName + (best.lane ? '' : '（非对线）') + ' ' + sign(best.delta));
    if (item.fit) bits.push('补位 +' + item.fit.toFixed(1));
    bits.push('本位置胜率 ' + (item.base * 100).toFixed(1) + '%');
    return bits.join(' · ');
  }

  function teamPicksHtml(rows) {
    if (!Array.isArray(rows) || !rows.length) return '';
    const lines = rows.map(row => {
      const chips = (row.picks || []).map(p => {
        const key = champKeyOf(p.id);
        if (!key) return '';
        const total = p.total != null ? p.total : p.score;
        return '<span class="bp-tp-chip" title="' + esc(tpWhy(p)) + '">'
          + '<img src="' + (typeof champImg === 'function' ? champImg(key) : '') + '" loading="lazy" alt="">'
          + '<span class="bp-tp-name">' + esc(champName(p.id)) + '</span>'
          + '<b class="bp-tp-score ' + (total >= 0 ? 'pos' : 'neg') + '">' + sign(total) + '</b></span>';
      }).join('');
      if (!chips) return '';
      return '<div class="bp-tp-row' + (row.mine ? ' bp-tp-mine' : '') + '">'
        + '<span class="bp-tp-pos">' + esc(row.posCn || '') + (row.mine ? '<i>你</i>' : '') + '</span>'
        + '<span class="bp-tp-list">' + chips + '</span>'
        + (row.mine ? '<span class="bp-tp-more">详情见下方 Pick</span>' : '')
        + '</div>';
    }).filter(Boolean).join('');
    if (!lines) return '';
    return '<div class="bp-team">'
      + '<div class="bp-team-head"><b>己方阵容</b><span>还空着的位置各给几个候选 · 同一个英雄只出现一次</span></div>'
      + lines
      + '</div>';
  }

  function buildHtml(state, picks, bans, extra) {
    const head = [];
    if (state.myPosition) head.push('你的位置：' + KEY_CN[state.myPosition]);
    head.push('敌方已亮 ' + state.enemy.length + ' 人');
    if (state.ally && state.ally.length) {
      const locked = state.ally.filter(a => a.locked).length;
      const intents = state.ally.filter(a => a.intent && !a.locked).length;
      head.push('我方已亮 ' + state.ally.length + ' 人' + (locked || intents ? '（选 ' + locked + ' / 预选 ' + intents + '）' : ''));
    }
    if (state.myAction) head.push(state.myAction === 'ban' ? '轮到你 ban' : '轮到你选');
    const ctx = {
      champNumMap: (typeof champNumMap !== 'undefined' ? champNumMap : null),
      allChampions: (typeof allChampions !== 'undefined' ? allChampions : null)
    };
    const pickHtml = picks.length
      ? picks.map(p => cardHtml(p, 'pick')).join('')
      : '<div class="bp-empty">没有可推荐的英雄（池子被 ban 完或对位数据缺失）</div>';
    const banHtml = bans.length
      ? bans.map(b => cardHtml(b, 'ban')).join('')
      : '<div class="bp-empty">暂无 ban 建议</div>';
    // 我方视角（1.6.32）：已亮英雄的结构 + 缺口。
    // 有 team 时用 bp-team 出结论 —— 补位分已经并进 picks 的 total，再走 bp-fusion 会重复计分。
    const team = extra && extra.team;
    const briefHtml = team && root.PoroBPTeam ? root.PoroBPTeam.briefHtml(team, ctx) : '';
    // 1.6.68: 己方阵容逐位候选。没给出（旧调用/测试）时整块不渲染。
    const posPicksHtml = teamPicksHtml(extra && extra.posPicks);
    let fusionHtml = '';
    if (team && root.PoroBPTeam && picks.length) {
      try { fusionHtml = root.PoroBPTeam.verdictHtml(picks[0], team, ctx); } catch (e) { fusionHtml = ''; }
    } else if (extra && root.PoroBPFusion && picks.length) {
      try {
        const model = root.PoroBPFusion.blend(picks, {
          ally: extra.ally, enemy: extra.enemy, mode: extra.mode, reviewHints: extra.reviewHints,
          champNumMap: (typeof champNumMap !== 'undefined' ? champNumMap : null),
          allChampions: (typeof allChampions !== 'undefined' ? allChampions : null)
        });
        fusionHtml = root.PoroBPFusion.render(model, {
          champNumMap: (typeof champNumMap !== 'undefined' ? champNumMap : null),
          allChampions: (typeof allChampions !== 'undefined' ? allChampions : null)
        });
      } catch (e) { fusionHtml = ''; }
    }
    return '<div class="bp-head"><b>BP 建议</b><span>' + esc(head.join(' · ')) + '</span></div>'
      + briefHtml
      + posPicksHtml
      + fusionHtml
      + '<div class="bp-cols">'
      + '<div class="bp-col"><div class="bp-col-title">推荐 Pick</div><div class="bp-list">' + pickHtml + '</div></div>'
      + '<div class="bp-col"><div class="bp-col-title">推荐 Ban</div><div class="bp-list">' + banHtml + '</div></div>'
      + '</div>'
      + '<div class="bp-foot">分数 = 0.6×自身强度 + Σ对位优势（同位置权重 1，其他位置 0.35，样本 &lt;50 场不计）'
      + (team ? ' + 补位分（我方缺口按英雄标签匹配，单条 0.8–1.5）' : '')
      + ' · 数据 OP.GG 韩服排位 · 只做建议，不替你点</div>';
  }

  // 浮窗分两页（阵容 BP / 克制关系），所以两块内容分别产出。
  function buildPanels(state, picks, bans, extra) {
    const e = extra || {};
    return {
      // 两页内容分开产出：html = 选人助手（阵容 BP），cnt = 英雄数据（概要条 + 对位网格）。
      html: buildHtml(state, picks, bans, Object.assign({}, e, { counters: null, counterHeroId: 0 })),
      cnt: dataHtml(e.counters, e.counterHeroId, e.counterPos, e.counterStats)
    };
  }

  // ---------- 运行时 ----------
  const _tables = new Map();
  // 失败也记时间戳: 网络抖一次就永久放弃这对英雄的话, 整局面板会静默变空。
  // 60 秒后允许重试, 轮询自然会把它补回来。
  const _failed = new Map();
  const FAIL_RETRY_MS = 60000;
  let _refreshing = false;
  let _pendingSession = null;
  let _lastKey = '';
  let _lastSession = null;

  function el(id) { return document.getElementById(id); }

  // ---------- 浮窗推送 ----------
  // 只推"算好的结果"，浮窗那边不做任何判断。开关由工具箱的 bpOverlayOn 决定:
  // 关掉时也照常推送（便宜），只是可见位传 false —— 这样再打开时不用等下一次选人事件。
  function overlayEnabled() {
    try { return typeof bpOverlayOn === 'undefined' ? true : !!bpOverlayOn; } catch (e) { return true; }
  }

  function subTextOf(state) {
    const bits = [];
    if (state && state.myPosition) bits.push(KEY_CN[state.myPosition] || '');
    if (state && state.enemy && state.enemy.length) bits.push('敌方已亮 ' + state.enemy.length);
    if (state && state.ally && state.ally.length) bits.push('我方已亮 ' + state.ally.length);
    if (state && state.myAction) bits.push(state.myAction === 'ban' ? '轮到你 ban' : '轮到你选');
    return bits.filter(Boolean).join(' · ');
  }

  // parts: { html, cnt } 或一段纯 HTML（说明文案用）
  function pushOverlay(parts, state) {
    const api = root.lolAPI;
    if (!api || typeof api.bpOverlayUpdate !== 'function') return;
    const obj = (parts && typeof parts === 'object') ? parts : { html: String(parts || ''), cnt: '' };
    const html = String(obj.html || '');
    const cnt = String(obj.cnt || '');
    try {
      const r = api.bpOverlayUpdate({
        html,
        cnt,
        sub: subTextOf(state),
        visible: !!(html || cnt) && overlayEnabled(),
        phase: (typeof root._gameflowPhase === 'string' ? root._gameflowPhase : ''),
        // 1.6.72: 筛选条件与数据版本跟着内容一起推，浮窗负责显示，不自己记状态
        filters: Object.assign({}, _filters),
        version: _filterVersion
      });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) {}
  }

  function clear() {
    const box = el('bpAdvisor');
    if (box) box.hidden = true;
    _lastKey = '';
    pushOverlay('', null);
  }

  function showNote(text) {
    const html = '<div class="bp-empty">' + esc(text) + '</div>';
    const box = el('bpAdvisor');
    const body = el('bpAdvisorBody');
    if (box && body) { box.hidden = false; body.innerHTML = html; }
    // 浮窗也要说清"为什么没内容"，否则玩家只看到一个空窗。
    pushOverlay(html, null);
    _lastKey = 'note:' + text;
  }

  async function ensureTables(state, extraNeeds) {
    const api = root.lolAPI;
    const out = {};
    const need = state.enemy.slice();
    const myId = state.myChampionId || state.myIntentId;
    if (myId && state.myPosition) need.push({ id: myId, pos: state.myPosition });
    // 1.6.32: 队友预选的英雄也要它们的对位表 —— "帮队友清路"的 ban 建议全靠这张表。
    // 只在还没轮到我锁人时取（那才是 ban 阶段），其余时候不白花请求。
    if (myId === 0) {
      for (const a of (Array.isArray(extraNeeds) ? extraNeeds : [])) {
        if (a && a.id && a.pos) need.push({ id: a.id, pos: a.pos });
      }
    }
    await Promise.all(need.map(async en => {
      if (!en.pos) return;
      const key = en.id + ':' + en.pos + '|' + dimKey();
      if (_tables.has(key)) { out[key] = _tables.get(key); return; }
      const failAt = _failed.get(key);
      if (failAt && Date.now() - failAt < FAIL_RETRY_MS) return;
      if (!api || typeof api.getOpggCounters !== 'function') return;
      try {
        const r = await api.getOpggCounters(en.id, en.pos, filterOpts());
        if (!r || r.__error || !Array.isArray(r.rows)) { _failed.set(key, Date.now()); return; }
        const map = {};
        for (const row of r.rows) {
          if (row && row.play > 0) map[String(row.championId)] = { play: row.play, wr: row.win / row.play };
        }
        _tables.set(key, map);
        _failed.delete(key);
        out[key] = map;
      } catch (e) { _failed.set(key, Date.now()); }
    }));
    // 已缓存的也要补进 out（上面命中缓存时并没有把整张表写进去的场景由这里兜住）
    for (const en of need) {
      if (!en.pos) continue;
      const key = en.id + ':' + en.pos + '|' + dimKey();
      if (!out[key] && _tables.has(key)) out[key] = _tables.get(key);
    }
    return out;
  }

  function stateKey(state) {
    return [state.myPosition, state.myChampionId, state.myIntentId, state.myAction,
      state.enemy.map(e => e.id + '@' + e.pos).join(','),
      (state.openPositions || []).map(s => s.pos + (s.mine ? '*' : '')).join(','),
      [...state.unavailable].sort((a, b) => a - b).join(',')].join('|');
  }

  // 从 hex.js 已维护的队列上下文推导模式族，交给融合层决定要不要谈"视野/前排承压"。
  // hex.js 在本文件之前加载，queueId 2400 = 海斗；450 = 大乱斗；其他按峡谷处理。
  function modeOfSession() {
    try {
      const ctx = (typeof hexRecommendContext !== 'undefined' && hexRecommendContext) || null;
      const q = ctx && +ctx.queueId;
      if (q === 2400) return 'mayhem';
      if (q === 450) return 'aram';
      return 'rift';
    } catch (e) { return 'rift'; }
  }

  async function refresh(session) {
    _lastSession = session;   // 筛选变化后拿它重算一帧，不必等下一次选人事件
    const state = readSession(session);
    if (!state.inChampSelect) { clear(); return; }
    // 大乱斗/海斗没有选位环节，克制与阵容建议都不成立；那两个模式有自己的备战区浮窗，
    // 这里再弹一个"没有分路分配"的空窗只是噪声。
    const mode = modeOfSession();
    if (mode === 'aram' || mode === 'mayhem') { clear(); return; }
    // 1.6.68: 自己那路没有候选池时不一定要收面板 —— 只要己方还有空位，阵容建议仍然有用
    // (例如数据里我这路刚好没条目，但队友三路都空着)。
    if (!state.myPosition && !state.openPositions.length) {
      showNote('盲选/无分路模式没有分路分配，BP 建议只在有选位环节的模式里可用');
      return;
    }
    const pools = poolFor(state.myPosition);
    if (!pools.length && !state.openPositions.length) { showNote('英雄强度数据未加载，稍后会自动重试'); return; }
    const key = stateKey(state);
    if (key === _lastKey) return;
    // 拉对位表是异步的。旧版遇到"刷新中又来新事件"直接 return，那一步状态就丢了 ——
    // 浮窗成了唯一出口后，丢一步就等于选人末尾停在上一版阵容。这里记下来，本轮结束后补跑。
    if (_refreshing) { _pendingSession = session; return; }
    _refreshing = true;
    try {
      // 我方视角：队友已锁/预选的结构（把自己排除 —— 我正在考虑的这手还没定，
      // 把自己的悬停算进"我方已有"会让缺口判断自我抵消）。
      const selfCell = (session && session.localPlayerCellId);
      let team = null;
      if (root.PoroBPTeam) {
        try {
          team = root.PoroBPTeam.analyze({
            ally: state.ally.filter(a => selfCell == null || a.cellId !== selfCell),
            enemy: state.enemy
          }, null, { rift: modeOfSession() === 'rift' });
        } catch (e) { team = null; }
      }
      const tables = await ensureTables(state, team ? team.intents : []);
      const fitOf = team ? (id => root.PoroBPTeam.fitOf(id, team.needs, null).fit) : null;
      const picks = recommend(state, tables, { fitOf });
      if (team) {
        for (const p of picks) {
          const f = root.PoroBPTeam.fitOf(p.id, team.needs, null);
          p.fitReasons = f.reasons;
        }
      }
      // 1.6.68: 己方阵容视角 —— 每个空位给几个候选。用同一套 fitOf，
      // 所以"补前排/缺物伤"这类缺口对每个位置都成立，不会只照顾我这一路。
      const posPicks = teamPicks(state, tables, { fitOf, perPos: 3 });
      const bans = recommendBans(state, tables, { intents: team ? team.intents : [] });
      // 复盘→BP：读取最近一局沉淀的「下局补位」信号，作为融合的第四源。
      let reviewHints = [];
      try {
        const bridge = root.PoroReviewBPBridge;
        if (bridge && typeof storeGet === 'function') {
          reviewHints = bridge.adopt(bridge.load({ get: k => storeGet(k) }));
        }
      } catch (e) { reviewHints = []; }
      // 1.6.71: 对位跟"我当前选/预选的英雄 + 我的分路"走，拉全量（40+ 条）。
      const counterHeroId = state.myChampionId || state.myIntentId || 0;
      // 1.6.72: 位置筛选可覆盖"自动跟随我的分路"，用来看同一英雄在别路的对位样本。
      const counterPos = _filters.position === 'auto' ? (state.myPosition || '') : _filters.position;
      const counters = counterHeroId ? await loadCounters(counterHeroId, counterPos) : null;
      const counterStats = counterHeroId ? await loadStats(counterHeroId, counterPos) : null;
      const panels = buildPanels(state, picks, bans, {
        ally: state.ally, enemy: state.enemy, mode: modeOfSession(), reviewHints, team, posPicks,
        counters, counterHeroId, counterPos, counterStats
      });
      // 主窗口面板若还在（旧布局/测试用的假 DOM）就照旧填，同时推一份给浮窗 ——
      // 两处用同一份 HTML，不会出现"面板和浮窗结论不一样"。
      const box = el('bpAdvisor');
      const body = el('bpAdvisorBody');
      if (box && body) { body.innerHTML = panels.html; box.hidden = false; }
      pushOverlay(panels, state);
      _lastKey = key;
    } finally {
      _refreshing = false;
      // 期间来过新事件就补跑一次（只补一次，避免在事件风暴里循环）
      if (_pendingSession) {
        const next = _pendingSession;
        _pendingSession = null;
        try { await refresh(next); } catch (e) {}
      }
    }
  }

  // 换版本/换会话时清缓存（英雄池与对位表都会变）。筛选选择本身跨会话保留。
  function reset() {
    _tables.clear(); _failed.clear(); _cntCache.clear();
    _benchCache = null; _lastKey = '';
  }

  // ---------- 1.6.72 浮窗筛选条 ----------
  function normalizeFilterLocal(f) {
    const o = f || {};
    const pick = (v, list, dflt) => list.includes(String(v || '')) ? String(v) : dflt;
    return {
      region: pick(o.region, FILTER_REGIONS, FILTER_DEFAULT.region),
      tier: pick(o.tier, FILTER_TIERS, FILTER_DEFAULT.tier),
      position: pick(o.position, FILTER_POSITIONS, FILTER_DEFAULT.position),
      version: 'auto'
    };
  }
  function applyFilters(f) {
    const next = normalizeFilterLocal(f);
    if (JSON.stringify(next) === JSON.stringify(_filters)) return;
    _filters = next;
    // 所有 table 都按地区/段位分过组，缓存键虽不冲突，但留着只是占内存。
    reset();
    if (_lastSession) {
      try { const p = refresh(_lastSession); if (p && typeof p.catch === 'function') p.catch(() => {}); }
      catch (e) {}
    }
  }
  try {
    const api = root.lolAPI;
    if (api && typeof api.onBpFilterChanged === 'function') api.onBpFilterChanged(applyFilters);
    if (api && typeof api.bpOverlayStatus === 'function') {
      const p = api.bpOverlayStatus();
      if (p && typeof p.then === 'function') {
        p.then(s => { if (s && s.filter) applyFilters(s.filter); }).catch(() => {});
      }
    }
  } catch (e) {}

  root.PoroBPAdvisor = {
    readSession, recommend, recommendFor, recommendBans, teamPicks, poolFor, buildHtml, buildPanels, cardHtml, teamPicksHtml,
    countersOf, loadCounters, splitCounters, dataHtml, statsOf, loadStats, whyText, pushOverlay, subTextOf,
    applyFilters, normalizeFilterLocal, filterOpts, refresh, clear, reset, showNote,
    MIN_PLAY, SAMPLE_FULL, LANE_WEIGHT, OFF_WEIGHT, BASE_WEIGHT,
    FILTER_DEFAULT, FILTER_REGIONS, FILTER_TIERS, FILTER_POSITIONS
  };
})(typeof window !== 'undefined' ? window : this);
