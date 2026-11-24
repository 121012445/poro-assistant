// 分工表 —— 选人阶段的趣味三档评级 (大神 / 正常人 / 人机)
//
// 数据来源: live.js 已经为 10 名玩家拉过近期战绩 (p.recent) 与段位 (p.rank),
// 评分直接复用 scout-report.js 的 PoroScout.evalPlayer(), 本模块**不发任何请求**。
//
// 设计原则:
//   1. 分档只看"近期状态", 不做人身评价 —— 文案是玩梗, 不是判词;
//   2. 同一玩家同一档的文案由 puuid 哈希固定, 刷新不跳字;
//   3. 错位对阵只是"如果按状态硬碰硬会怎样"的沙盘推演, 明确标注不是胜率预测;
//   4. 纯函数, 无 DOM / 无 IO, 可在 node 里断言。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  // window.X 形式既是浏览器里的真实赋值, 也让静态检查 (test_undef_globals) 认得出这个名字
  if (typeof window !== 'undefined') window.PoroDuty = api;
  else if (root) root.PoroDuty = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // 1.6.60: 分档口径改成"近期胜率"(用户定的): >70 大神, 40~70 正常人, <40 人机。
  // 原来的 PoroScout 状态分 (段位+KDA+连胜加权) 不再参与分档, 但仍随 detail 保留备查。
  // 样本不足一律「待定」—— 1 场赢就封神没有意义, 5 场是最低可读样本。
  const MIN_GAMES = 5;

  // 1.6.62: 档位「名字」可自定义, 阈值不可动 —— 名字只是玩梗外壳, 分档口径必须稳定,
  // 否则同一份战绩今天叫大神明天叫别的, 沙盘和聊天文案全跟着飘。
  // 存的是用户改过的名字; 拿到空串/纯空白就退回默认, 免得出现"没有名字的档位"。
  const DEFAULT_LABELS = { carry: '大神', hold: '正常人', slack: '人机', unknown: '待定' };
  const LABEL_KEYS = ['carry', 'hold', 'slack', 'unknown'];
  const LABEL_MAX = 6;                      // 中文 6 字够用, 再长发到选人聊天会撑爆一行
  let labels = Object.assign({}, DEFAULT_LABELS);

  // 控制字符 / 换行会把聊天消息切断, 先压成空格再 trim; 超长按"字符"截 (不拆 emoji)
  function cleanLabel(v, fallback) {
    let s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return fallback;
    const chars = Array.from(s);
    if (chars.length > LABEL_MAX) s = chars.slice(0, LABEL_MAX).join('').trim();
    return s;
  }
  function labelOf(key) {
    const v = labels[key];
    return (v == null || v === '') ? (DEFAULT_LABELS[key] || '') : v;
  }
  function getLabels() { return Object.assign({}, labels); }
  // 只接受认识的档位键; 传 null/undefined 当"没改"
  function setLabels(obj) {
    const next = Object.assign({}, labels);
    for (const k of LABEL_KEYS) {
      if (obj && Object.prototype.hasOwnProperty.call(obj, k)) {
        next[k] = cleanLabel(obj[k], DEFAULT_LABELS[k]);
      }
    }
    labels = next;
    return getLabels();
  }
  function resetLabels() {
    labels = Object.assign({}, DEFAULT_LABELS);
    return getLabels();
  }
  function labelsAreDefault() {
    return LABEL_KEYS.every(k => labelOf(k) === DEFAULT_LABELS[k]);
  }

  // label 走 getter: 改名字后连已经 build 好的 rank / 已缓存的 DOM 一起跟上, 不用重建
  const TIERS = [
    { key: 'carry', cls: 'carry', test: n => n > 70, get label() { return labelOf('carry'); } },
    { key: 'hold', cls: 'hold', test: n => n >= 40, get label() { return labelOf('hold'); } },
    { key: 'slack', cls: 'slack', test: () => true, get label() { return labelOf('slack'); } }
  ];
  const UNKNOWN_TIER = { key: 'unknown', cls: 'unknown', get label() { return labelOf('unknown'); } };

  // 同一档多条文案, 用 puuid 哈希取一条 —— 刷新时不变, 换人时才换
  const COPY = {
    carry: [
      '这局看它就够了',
      '跟着大神走，别抢戏',
      '它去哪你跟哪，别犟',
      '把线让给它，安稳吃分',
      '它开团你就上，别犹豫',
      '能打能带，少说话多跟上',
      '胜负手就在它身上',
      '状态在线，后背交给它'
    ],
    hold: [
      '不求有功，但求无过',
      '正常发挥，够用',
      '把线守住，别送就行',
      '打不过就缩，别硬刚',
      '它守得住，这局就有底',
      '中规中矩，别指望惊喜',
      '能跟上节奏，就看心情',
      '不拖后腿就是满分'
    ],
    slack: [
      '和训练模式的人机一个水平',
      '它会走路，但不会拐弯',
      '指望它不如指望自己',
      '它负责存在，你负责赢',
      '给它个安全的位置，别让它送',
      '人机模式它都没打赢过',
      '会补刀，已经很努力了',
      '少送两个，这局还有救'
    ],
    unknown: [
      '还没看出它是人是机',
      '数据太少，先观察',
      '新面孔，成分待定',
      '样本不足，打着看',
      '开盲盒，看命'
    ]
  };

  // 注意: Number(null) === 0, 直接转会把"没有样本"误判成 0 分, 必须先挡空值
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function hashOf(str) {
    const s = String(str || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  // winRate 是百分数 (65 = 65%), games 是样本局数
  function tierOf(winRate, games) {
    const n = num(winRate);
    const g = num(games);
    if (n == null) return UNKNOWN_TIER;
    if (g == null || g < MIN_GAMES) return UNKNOWN_TIER;
    for (const t of TIERS) if (t.test(n)) return t;
    return TIERS[TIERS.length - 1];
  }

  function copyOf(seed, tierKey) {
    const list = COPY[tierKey] || COPY.unknown;
    return list[hashOf(seed) % list.length];
  }

  // 对阵: 胜率差 8 个百分点以上才算占优/吃亏, 中间算五五开。
  // 1.6.60: 强度口径与分档统一为胜率 (原来用 0-10 的状态分, 会出现
  // "胜率 75% 判大神、沙盘却说这条路吃亏"的自相矛盾)。
  const EDGE = 8;
  const NEUTRAL_RATE = 50;   // 没有样本时沙盘按 50% 中性参与, 不参与"谁强谁弱"的宣称
  function outcomeOf(a, b) {
    const d = a - b;
    if (d >= EDGE) return 'win';
    if (d <= -EDGE) return 'lose';
    return 'even';
  }

  // 硬碰硬: 双方按状态从强到弱依次对位
  function pairDirect(allies, enemies) {
    const a = allies.slice().sort((x, y) => y.s - x.s);
    const e = enemies.slice().sort((x, y) => y.s - x.s);
    const n = Math.min(a.length, e.length);
    let wins = 0, losses = 0, evens = 0;
    const plan = [];
    for (let i = 0; i < n; i++) {
      const result = outcomeOf(a[i].s, e[i].s);
      if (result === 'win') wins++; else if (result === 'lose') losses++; else evens++;
      plan.push({ ally: a[i], enemy: e[i], result });
    }
    return { wins, losses, evens, n, plan };
  }

  // 错位: 我方最强能压过对方最强就直接对掉; 否则我方最弱能压过对方最弱就先吃这一路;
  // 两头都压不住就派最弱的那条去撞对方最强 (弃一路), 把中段留给自己 ——
  // 整体偏弱时也能最大化"能赢的路数"。
  function pairCross(allies, enemies) {
    const a = allies.slice().sort((x, y) => x.s - y.s);   // 由弱到强
    const e = enemies.slice().sort((x, y) => x.s - y.s);
    let lo = 0, hi = a.length - 1, elo = 0, ehi = e.length - 1;
    let wins = 0, losses = 0, evens = 0;
    const plan = [];
    const push = (x, y, result) => {
      if (result === 'win') wins++; else if (result === 'lose') losses++; else evens++;
      plan.push({ ally: x, enemy: y, result });
    };
    while (lo <= hi && elo <= ehi) {
      if (a[hi].s - e[ehi].s >= EDGE) {
        push(a[hi], e[ehi], outcomeOf(a[hi].s, e[ehi].s)); hi--; ehi--;
      } else if (a[lo].s - e[elo].s >= EDGE) {
        push(a[lo], e[elo], outcomeOf(a[lo].s, e[elo].s)); lo++; elo++;
      } else {
        push(a[lo], e[ehi], outcomeOf(a[lo].s, e[ehi].s)); lo++; ehi--;
      }
    }
    plan.sort((x, y) => y.ally.s - x.ally.s);
    return { wins, losses, evens, n: plan.length, plan };
  }

  function summaryOf(mates, selfPuuid) {
    const c = { carry: 0, hold: 0, slack: 0, unknown: 0 };
    for (const m of mates) c[m.tier.key] = (c[m.tier.key] || 0) + 1;
    const known = mates.length - c.unknown;
    // 1.6.62: 句子里的档位名一律走 labelOf —— 用户改了名字, 梗句也得跟着改名,
    // 否则会出现"四个猛男, 这局不好输"上面却写着"大神"的自相矛盾。
    const T = k => labelOf(k);
    // 1.6.63: 分支收紧到"人数必须对得上"。原来 c.carry >= 2 一条吃掉 2 和 3,
    // 三个大神会写成"有两个"; 又因为兜底是"有大神有人机", 0 大神 + 有未知样本时
    // 会说出一个根本不存在的大神 —— 这类自相矛盾比句式单调难看得多。
    let line;
    if (!known) line = '全员' + T('unknown') + '，边打边看';
    else if (c.carry === mates.length) line = '全员' + T('carry') + '，这局不好输';
    else if (c.carry >= 4) line = '四个' + T('carry') + '，这局不好输';
    else if (c.carry === 3) line = '三个' + T('carry') + '，这局不好输';
    else if (c.carry === 2) line = '有两个' + T('carry') + '，剩下看配合';
    else if (c.carry === 1) line = '就一个' + T('carry') + '，全靠它撑场';
    else if (c.slack === mates.length) line = '全员' + T('slack') + '，这把是来送温暖的';
    else if (c.slack >= 4) line = '四个' + T('slack') + '，就看剩下那个能不能扛';
    else if (c.slack === 3) line = '三个' + T('slack') + '，就看剩下两个扛不扛得住';
    else if (c.slack === 2) line = '没有' + T('carry') + '，全靠配合硬顶';
    else if (c.slack === 1) line = '没有' + T('carry') + '，' + T('slack') + '那路多照看';
    else if (c.unknown > 0) line = '没有' + T('carry') + '，' + c.unknown + '个' + T('unknown') + '还没看透';
    else line = '全员' + T('hold') + '，整齐得像军训';
    const self = mates.find(m => m && m.isSelf);
    if (self && self.tier.key === 'carry' && c.carry <= 1) {
      line = '这局只有你一个' + T('carry') + '，别掉链子';
    } else if (self && self.tier.key === 'slack') {
      line += '（你自己也在' + T('slack') + '名单里，别笑）';
    }
    return line;
  }

  /**
   * @param {Array} players live.js 的 10 人数组 {puuid,name,team,championId,rank,recent,isBot}
   * @param {object} opts { selfPuuid, champName(id), evalPlayer(p) }
   */
  function build(players, opts) {
    const o = opts || {};
    const list = Array.isArray(players) ? players.filter(p => p && !p.isBot) : [];
    const self = o.selfPuuid ? list.find(p => p.puuid === o.selfPuuid) : null;
    const selfTeam = self ? Number(self.team) : 0;
    if (!list.length || !selfTeam) return { ready: false, reason: selfTeam ? '没有可评估的玩家' : '还没识别到自己所在的队伍' };
    const evalPlayer = typeof o.evalPlayer === 'function'
      ? o.evalPlayer
      : (typeof PoroScout !== 'undefined' && PoroScout && typeof PoroScout.evalPlayer === 'function'
        ? PoroScout.evalPlayer.bind(PoroScout)
        : null);
    if (!evalPlayer) return { ready: false, reason: '评分模块未加载' };
    const nameOf = id => {
      try { return o.champName ? (o.champName(id) || '') : ''; } catch (e) { return ''; }
    };
    const wrap = p => {
      const e = evalPlayer(p, o) || {};
      const games = num(e.games) || 0;
      const wr = num(e.wr);
      const tier = tierOf(wr, games);
      const isSelf = !!(o.selfPuuid && p.puuid === o.selfPuuid);
      return {
        name: p.name || '未知',
        puuid: p.puuid || '',
        championId: +p.championId || 0,
        champName: nameOf(p.championId),
        rank: p.rank || '',
        isSelf,
        score: e.score == null ? null : Math.round(Number(e.score) * 10) / 10,
        games: num(e.games) || 0,
        wr: num(e.wr),
        kda: e.kda == null ? null : e.kda,
        s: num(e.wr),          // 沙盘强度 = 胜率百分点, 与分档同源
        tier,
        s5: recent5Of(p),      // 最近 5 把的胜负数与总 KDA (聊天消息里的逐人数据)
        copy: copyOf(p.puuid || p.name || '', tier.key),
        reasons: Array.isArray(e.reasons) ? e.reasons.slice(0, 3) : []
      };
    };
    const mates = list.filter(p => Number(p.team) === selfTeam).map(wrap);
    const enemies = list.filter(p => Number(p.team) !== selfTeam).map(wrap);
    // 沙盘里没有样本的人按 50% 中性参与
    const asPawns = rows => rows.map(r => ({ ref: r, s: r.s == null ? NEUTRAL_RATE : r.s }));
    const allyPawns = asPawns(mates), enemyPawns = asPawns(enemies);

    const direct = pairDirect(allyPawns, enemyPawns);
    const cross = pairCross(allyPawns, enemyPawns);
    const strip = r => ({ name: r.ally.ref.name, tier: r.ally.ref.tier.key, enemy: r.enemy.ref.name, enemyTier: r.enemy.ref.tier.key, result: r.result });

    const counts = { carry: 0, hold: 0, slack: 0, unknown: 0 };
    for (const m of mates) counts[m.tier.key] = (counts[m.tier.key] || 0) + 1;

    const rank = {
      ready: true,
      mates, enemies, counts,
      summary: summaryOf(mates, o.selfPuuid),
      direct: { wins: direct.wins, losses: direct.losses, evens: direct.evens, n: direct.n, plan: direct.plan.map(strip) },
      cross: { wins: cross.wins, losses: cross.losses, evens: cross.evens, n: cross.n, plan: cross.plan.map(strip) },
      gain: cross.wins - direct.wins
    };
    rank.chatLines = chatLinesOf(rank);
    rank.chatText = rank.chatLines.join('\n');
    rank.chatFlat = rank.chatLines.join(' ｜ ');
    return rank;
  }

  // 1.6.64: 选人消息改成"每人一行" —— 档位 + 名字 + 最近 5 把战绩 + 总 KDA,
  // 对齐 Sona 助手那种"逐人摆数据"的写法。原来的单行统计只有各档人数,
  // 收到消息的人看不出"这个大神到底怎么个大神法"。
  const RECENT_N = 5;
  function recent5Of(p) {
    const src = Array.isArray(p && p.recent) ? p.recent : [];
    const rows = src.slice(0, RECENT_N);
    const s = { n: rows.length, wins: 0, k: 0, d: 0, a: 0 };
    for (const r of rows) {
      if (!r) continue;
      if (r.win === true || r.win === 'Win') s.wins++;
      s.k += num(r.k) || 0;
      s.d += num(r.d) || 0;
      s.a += num(r.a) || 0;
    }
    s.losses = s.n - s.wins;
    // KDA 口径与评分模块一致: (K+A)/max(1,D), 死 0 场不会炸成 Infinity
    s.kda = s.n ? Math.round((s.k + s.a) / Math.max(1, s.d) * 10) / 10 : null;
    return s;
  }

  // 一行一个人: "大神 风会停 近5局 4胜1负 KDA 3.5"
  function lineOf(m) {
    const s = m && m.s5;
    const head = `${m.tier.label} ${m.name}`;
    if (!s || !s.n) return `${head} 近${RECENT_N}局 无样本`;
    return `${head} 近${s.n}局 ${s.wins}胜${s.losses}负 KDA ${s.kda == null ? '-' : s.kda.toFixed(1)}`;
  }

  function chatLinesOf(rank) {
    if (!rank || !rank.ready) return [];
    const c = rank.counts || {};
    const parts = [];
    for (const key of ['carry', 'hold', 'slack']) {
      if (!c[key]) continue;
      parts.push(`${labelOf(key)}${c[key]}`);
    }
    const best = rank.mates.filter(m => m.s != null).sort((a, b) => b.s - a.s)[0];
    const worst = rank.mates.filter(m => m.s != null).sort((a, b) => a.s - b.s)[0];
    const head = `【Poro·分工表】我方 ${parts.join(' ')}`;
    const tail = [];
    if (best) tail.push(`最能带 ${best.name}`);
    if (worst && worst !== best) tail.push(`最需照看 ${worst.name}`);
    const cmp = `硬碰硬赢 ${rank.direct.wins}/${rank.direct.n}，错位能赢 ${rank.cross.wins}/${rank.cross.n}（玩梗，非胜率预测）`;
    // 逐人按胜率从高到低, 没样本的垫底 —— 收到消息的人第一眼看到最能指望的那个
    const rows = rank.mates.slice()
      .sort((a, b) => (b.s == null ? -1 : b.s) - (a.s == null ? -1 : a.s))
      .map(lineOf);
    return [head].concat(rows, `${tail.join(' · ')}｜${cmp}`);
  }

  // 多行是首选 (聊天窗口里一人一行最像 Sona 那套), 但 LCU 万一不收换行,
  // live.js 会退回 chatFlat 的单行版, 不至于整条发不出去。
  function chatTextOf(rank) {
    return chatLinesOf(rank).join('\n');
  }

  // 对阵表里"占优/五五开/弃路"的措辞
  const RESULT_TEXT = { win: '占优', even: '五五开', lose: '弃路' };

  // ---------- 工具箱预览 (1.6.62) ----------
  // 页面里不铺卡, 但用户得能在工具箱看见"现在是谁什么档、配的哪句文案",
  // 顺便验证自己改的档位名有没有生效。这里只出 HTML, DOM 落地交给 live.js。
  const TIER_HINT = { carry: '&gt;70%', hold: '40–70%', slack: '&lt;40%' };

  function legendHtml() {
    const chips = LABEL_KEYS.map(k => {
      const hint = k === 'unknown' ? `不足 ${MIN_GAMES} 场` : TIER_HINT[k];
      return `<span class="fd-pv-chip"><b class="fd-badge fd-${k}">${esc(labelOf(k))}</b><i>${hint}</i></span>`;
    }).join('');
    return `<div class="fd-pv-legend">${chips}</div>`;
  }

  function previewHtml(rank, opts) {
    const o = opts || {};
    const head = legendHtml();
    if (!rank || !rank.ready) {
      return `<div class="fd-pv">${head}<div class="fd-pv-empty">${esc(o.empty || '进入选人阶段后自动显示本局分工')}</div></div>`;
    }
    const rows = rank.mates.map(m => {
      const why = (m.wr == null || m.games < MIN_GAMES)
        ? `近期样本 ${m.games} 场，不足 ${MIN_GAMES} 场`
        : `近 ${m.games} 场 ${m.wr}% 胜率${m.kda == null ? '' : ` · KDA ${m.kda}`}`;
      // 第三列跟聊天消息里那行完全同源, 免得"预览看到的"和"发出去的"对不上
      const s5 = m.s5 || {};
      const detail = !s5.n
        ? `近${RECENT_N}局 无样本`
        : `近${s5.n}局 ${s5.wins}胜${s5.losses}负 · KDA ${s5.kda == null ? '-' : s5.kda.toFixed(1)}`;
      return `<div class="fd-pv-row" title="${esc(why)}">
        <b class="fd-badge fd-${m.tier.cls}">${esc(m.tier.label)}</b>
        <span class="fd-pv-name">${esc(m.name)}${m.isSelf ? '<i class="fd-you">自己</i>' : ''}</span>
        <span class="fd-pv-copy">${esc(detail)}</span>
      </div>`;
    }).join('');
    return `<div class="fd-pv">${head}
      <div class="fd-pv-list">${rows}</div>
      <div class="fd-pv-foot">${esc(rank.summary)}｜硬碰硬 ${rank.direct.wins}/${rank.direct.n} · 错位 ${rank.cross.wins}/${rank.cross.n}</div>
    </div>`;
  }

  function html(rank, opts) {
    if (!rank || !rank.ready) return '';
    if (typeof window !== 'undefined') window._poroDutyRank = rank;
    const o = opts || {};
    const collapsed = o.collapsed ? ' collapsed' : '';
    const c = rank.counts || {};
    const dist = ['carry', 'hold', 'slack', 'unknown']
      .filter(k => c[k])
      .map(k => {
        const t = k === 'unknown' ? UNKNOWN_TIER : TIERS.find(x => x.key === k);
        return `<span class="fd-dist-item" title="${t.label} ${c[k]} 人"><i class="fd-dot fd-${t.cls}"></i>${t.label}${c[k]}</span>`;
      }).join('');
    const rows = rank.mates.map(m => {
      const why = (m.wr == null || m.games < MIN_GAMES)
        ? `近期样本 ${m.games} 场，不足 ${MIN_GAMES} 场`
        : `近 ${m.games} 场 ${m.wr}% 胜率${m.kda == null ? '' : ` · KDA ${m.kda}`}${m.score == null ? '' : ` · 状态分 ${m.score.toFixed(1)}`}`;
      return `<div class="fd-row">
        <span class="fd-badge fd-${m.tier.cls}">${m.tier.label}</span>
        <span class="fd-name" title="${esc(why)}">${esc(m.name)}${m.isSelf ? '<i class="fd-you">自己</i>' : ''}</span>
        <span class="fd-champ">${esc(m.champName || '未选')}</span>
        <span class="fd-copy">${esc(m.copy)}</span>
      </div>`;
    }).join('');
    const pairs = rank.cross.plan.map(p => `<span class="fd-pair fd-${p.result}">
      <b>${esc(p.name)}</b><i>${esc(p.enemy)}</i><em>${RESULT_TEXT[p.result] || ''}</em>
    </span>`).join('');
    const gainText = rank.gain > 0 ? `错位多赢 ${rank.gain} 路` : (rank.gain < 0 ? '错位反而更差' : '错位与硬碰硬持平');
    return `<section class="fd-card${collapsed}">
      <div class="fd-head" onclick="toggleDutyCard(this)" role="button" tabindex="0" onkeydown="if(event.key==='Enter'){toggleDutyCard(this)}">
        <b>分工表</b>
        <span class="fd-dist">${dist}</span>
        <span class="fd-cross">错位可赢 ${rank.cross.wins}/${rank.cross.n}</span>
        <span class="fd-toggle">收起</span>
      </div>
      <div class="fd-body">
        <p class="fd-summary">${esc(rank.summary)}</p>
        <div class="fd-list">${rows}</div>
        <div class="fd-plan">
          <div class="fd-plan-head">按状态错位对阵 <b>${rank.cross.wins}/${rank.cross.n}</b><span>硬碰硬 ${rank.direct.wins}/${rank.direct.n} · ${esc(gainText)}</span></div>
          <div class="fd-pairs">${pairs}</div>
        </div>
        <div class="fd-foot">
          <span>分档只看近期胜率（不足 ${MIN_GAMES} 场记待定），纯玩梗，不是胜率预测。</span>
          <button type="button" class="fd-btn" onclick="event.stopPropagation();sendDutyChat()">发到聊天</button>
          <button type="button" class="fd-btn ghost" onclick="event.stopPropagation();copyDutyText()">复制文案</button>
        </div>
      </div>
    </section>`;
  }

  return {
    build, html, tierOf, copyOf, pairDirect, pairCross, summaryOf, chatTextOf, chatLinesOf, lineOf, recent5Of,
    previewHtml, legendHtml, RECENT_N,
    labelOf, setLabels, getLabels, resetLabels, labelsAreDefault,
    TIERS, UNKNOWN_TIER, DEFAULT_LABELS, LABEL_KEYS, LABEL_MAX, EDGE
  };
});
