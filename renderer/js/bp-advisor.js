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
    for (const p of myTeam) {
      if (+p.championId > 0) { state.ally.push({ id: +p.championId, pos: posKeyOf(p) }); state.unavailable.add(+p.championId); }
      if (+p.championPickIntent > 0) { state.ally.push({ id: +p.championPickIntent, pos: posKeyOf(p) }); state.unavailable.add(+p.championPickIntent); }
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
  function recommend(state, tables) {
    const t = tables || {};
    const rows = [];
    for (const c of poolFor(state.myPosition)) {
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
        const w = (en.pos === state.myPosition ? LANE_WEIGHT : OFF_WEIGHT) * Math.min(1, row.play / SAMPLE_FULL);
        score += delta * w;
        edges.push({ enemyId: en.id, enemyName: champName(en.id), delta, play: row.play, lane: en.pos === state.myPosition });
      }
      edges.sort((a, b) => b.delta * b.play - a.delta * a.play);
      rows.push({ id: c.id, score, base: c.winRate, edges, missing, tier: c.tier, banRate: c.banRate });
    }
    rows.sort((a, b) => b.score - a.score || b.base - a.base);
    return rows.slice(0, PICK_COUNT);
  }

  // ban 建议：我已选/预选 → 优先 ban 掉最克制我的；还没选 → 退化成版本强势（胜率 + ban 率）
  function recommendBans(state, tables) {
    const t = tables || {};
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
  function cardHtml(item, kind) {
    const key = champKeyOf(item.id);
    if (!key) return '';
    const name = esc(champName(item.id));
    let why = '';
    let scoreText = sign(item.score);
    if (kind === 'pick') {
      const best = item.edges[0];
      const bits = [];
      if (best) {
        bits.push('对位 ' + esc(best.enemyName) + (best.lane ? '' : '（非对线）') + ' ' + sign(best.delta));
      }
      bits.push('自身 ' + (item.base * 100).toFixed(1) + '%');
      if (item.missing) bits.push(item.missing + ' 人无对位样本');
      why = bits.join(' · ');
      if (!best && !item.edges.length) scoreText = '无对位样本';
    } else if (item.basis === 'counter') {
      // ban 的分数是" ban 优先级", 不是胜率差 —— 不带正负号, 免得看成 +7% 优势
      scoreText = item.score.toFixed(1);
      why = '克制你 ' + (50 + item.delta).toFixed(1) + '% · 样本 ' + item.play;
    } else {
      scoreText = item.score.toFixed(1);
      why = '版本强势 ' + (50 + item.delta).toFixed(1) + '% · ban ' + ((item.banRate || 0) * 100).toFixed(1) + '%';
    }
    const cls = kind === 'pick' ? (item.score >= 0 ? 'pos' : 'neg') : 'ban';
    return '<div class="bp-card" title="' + esc(why) + '">'
      + '<img class="bp-icon" src="' + (typeof champImg === 'function' ? champImg(key) : '') + '" loading="lazy" alt="">'
      + '<div class="bp-body">'
      + '<div class="bp-name"><span>' + name + '</span><b class="bp-score ' + cls + '">' + esc(scoreText) + '</b></div>'
      + '<div class="bp-why">' + why + '</div>'
      + '</div></div>';
  }

  function buildHtml(state, picks, bans, extra) {
    const head = [];
    if (state.myPosition) head.push('你的位置：' + KEY_CN[state.myPosition]);
    head.push('敌方已亮 ' + state.enemy.length + ' 人');
    if (state.myAction) head.push(state.myAction === 'ban' ? '轮到你 ban' : '轮到你选');
    const pickHtml = picks.length
      ? picks.map(p => cardHtml(p, 'pick')).join('')
      : '<div class="bp-empty">没有可推荐的英雄（池子被 ban 完或对位数据缺失）</div>';
    const banHtml = bans.length
      ? bans.map(b => cardHtml(b, 'ban')).join('')
      : '<div class="bp-empty">暂无 ban 建议</div>';
    // 三合一融合结论：三套信号（对位/阵容/敌方结构）叠加，给一条「这一手拿谁」。
    // extra 由 refresh 注入；旧的三参数调用（含测试）没有 extra 时不渲染，保持兼容。
    let fusionHtml = '';
    if (extra && root.PoroBPFusion && picks.length) {
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
      + fusionHtml
      + '<div class="bp-cols">'
      + '<div class="bp-col"><div class="bp-col-title">推荐 Pick</div><div class="bp-list">' + pickHtml + '</div></div>'
      + '<div class="bp-col"><div class="bp-col-title">推荐 Ban</div><div class="bp-list">' + banHtml + '</div></div>'
      + '</div>'
      + '<div class="bp-foot">分数 = 0.6×自身强度 + Σ对位优势（同位置权重 1，其他位置 0.35，样本 &lt;50 场不计）'
      + ' · 数据 OP.GG 韩服排位 · 只做建议，不替你点</div>';
  }

  // ---------- 运行时 ----------
  const _tables = new Map();
  // 失败也记时间戳: 网络抖一次就永久放弃这对英雄的话, 整局面板会静默变空。
  // 60 秒后允许重试, 轮询自然会把它补回来。
  const _failed = new Map();
  const FAIL_RETRY_MS = 60000;
  let _refreshing = false;
  let _lastKey = '';

  function el(id) { return document.getElementById(id); }

  function clear() {
    const box = el('bpAdvisor');
    if (box) box.hidden = true;
    _lastKey = '';
  }

  function showNote(text) {
    const box = el('bpAdvisor');
    const body = el('bpAdvisorBody');
    if (!box || !body) return;
    box.hidden = false;
    body.innerHTML = '<div class="bp-empty">' + esc(text) + '</div>';
    _lastKey = 'note:' + text;
  }

  async function ensureTables(state) {
    const api = root.lolAPI;
    const out = {};
    const need = state.enemy.slice();
    const myId = state.myChampionId || state.myIntentId;
    if (myId && state.myPosition) need.push({ id: myId, pos: state.myPosition });
    await Promise.all(need.map(async en => {
      if (!en.pos) return;
      const key = en.id + ':' + en.pos;
      if (_tables.has(key)) { out[key] = _tables.get(key); return; }
      const failAt = _failed.get(key);
      if (failAt && Date.now() - failAt < FAIL_RETRY_MS) return;
      if (!api || typeof api.getOpggCounters !== 'function') return;
      try {
        const r = await api.getOpggCounters(en.id, en.pos);
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
      const key = en.id + ':' + en.pos;
      if (!out[key] && _tables.has(key)) out[key] = _tables.get(key);
    }
    return out;
  }

  function stateKey(state) {
    return [state.myPosition, state.myChampionId, state.myIntentId, state.myAction,
      state.enemy.map(e => e.id + '@' + e.pos).join(','),
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
    const state = readSession(session);
    if (!state.inChampSelect) { clear(); return; }
    if (!state.myPosition) { showNote('盲选/无分路模式没有分路分配，BP 建议只在有选位环节的模式里可用'); return; }
    const pools = poolFor(state.myPosition);
    if (!pools.length) { showNote('英雄强度数据未加载，稍后会自动重试'); return; }
    const key = stateKey(state);
    if (key === _lastKey) return;
    if (_refreshing) return;
    _refreshing = true;
    try {
      const tables = await ensureTables(state);
      const picks = recommend(state, tables);
      const bans = recommendBans(state, tables);
      const box = el('bpAdvisor');
      const body = el('bpAdvisorBody');
      if (!box || !body) return;
      // 复盘→BP：读取最近一局沉淀的「下局补位」信号，作为融合的第四源。
      let reviewHints = [];
      try {
        const bridge = root.PoroReviewBPBridge;
        if (bridge && typeof storeGet === 'function') {
          reviewHints = bridge.adopt(bridge.load({ get: k => storeGet(k) }));
        }
      } catch (e) { reviewHints = []; }
      body.innerHTML = buildHtml(state, picks, bans, {
        ally: state.ally, enemy: state.enemy, mode: modeOfSession(), reviewHints
      });
      box.hidden = false;
      _lastKey = key;
    } finally { _refreshing = false; }
  }

  // 换版本/换会话时清缓存（英雄池与对位表都会变）
  function reset() { _tables.clear(); _failed.clear(); _lastKey = ''; }

  root.PoroBPAdvisor = {
    readSession, recommend, recommendBans, poolFor, buildHtml, cardHtml,
    refresh, clear, reset, showNote,
    MIN_PLAY, SAMPLE_FULL, LANE_WEIGHT, OFF_WEIGHT, BASE_WEIGHT
  };
})(typeof window !== 'undefined' ? window : this);
