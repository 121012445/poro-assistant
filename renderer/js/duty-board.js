// 分工表 —— 选人阶段的五档趣味评级 (上等马 / 中等马 / 下等马 / 牛马 / 没有马)
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

  // 1.6.66: 五档「赛马场」评级, 分档口径从胜率改成 **近 5 场加权 KDA** (用户定的:
  // "排序不按胜率 按 kd", 分别是 上等马 / 中等马 / 下等马 / 牛马 / 没有马)。
  // 为什么口径能换: 胜率只说明"队伍赢没赢", 5 场里跟着躺赢和被人拖着都算一胜一负;
  // KDA 才是"这个人自己在干什么"。用户在 1.6.60 就抱怨过"胜率高但战绩差的也拿高评价",
  // 这次等于把分档整体挪到个人数据上。
  // 注意: 沙盘 (硬碰硬/错位) 仍然用胜率 —— 跨位置比 KDA 没有意义 (辅助天然高),
  // 那种对位推演本来就该看"谁的队伍更能赢"。两者不同源是故意的, 不是没统一。
  const MIN_GAMES = 5;

  // 1.6.62: 档位「名字」可自定义, 阈值不可动 —— 名字只是玩梗外壳, 分档口径必须稳定,
  // 否则同一份战绩今天叫上等马明天叫别的, 沙盘和聊天文案全跟着飘。
  // 存的是用户改过的名字; 拿到空串/纯空白就退回默认, 免得出现"没有名字的档位"。
  const DEFAULT_LABELS = {
    top: '上等马', mid: '中等马', low: '下等马', ox: '牛马', zero: '没有马', unknown: '待定'
  };
  const LABEL_KEYS = ['top', 'mid', 'low', 'ox', 'zero', 'unknown'];
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
  // 阈值 (近 5 场**加权** KDA): 3.5 / 2.5 / 1.8 / 1.0 —— 写死, 不给改。
  // 用加权口径是因为"助攻算全分"会把辅助和打野整体抬上去 (10 助攻的辅助 KDA 天然比
  // 中单高), 用户明确要求"助攻权重得下降"。权重 0.5 与 thigh-tag.js 的实时标签同一套,
  // 免得同一个客户端里两个功能对"这人 KDA 多少"给出两个答案。
  const ASSIST_WEIGHT = 0.5;
  const TIERS = [
    { key: 'top', cls: 'top', test: n => n >= 3.5, get label() { return labelOf('top'); } },
    { key: 'mid', cls: 'mid', test: n => n >= 2.5, get label() { return labelOf('mid'); } },
    { key: 'low', cls: 'low', test: n => n >= 1.8, get label() { return labelOf('low'); } },
    { key: 'ox', cls: 'ox', test: n => n >= 1.0, get label() { return labelOf('ox'); } },
    { key: 'zero', cls: 'zero', test: () => true, get label() { return labelOf('zero'); } }
  ];
  const UNKNOWN_TIER = { key: 'unknown', cls: 'unknown', get label() { return labelOf('unknown'); } };

  // 同一档多条文案, 用 puuid 哈希取一条 —— 刷新时不变, 换人时才换
  const COPY = {
    top: [
      '这局看它就够了',
      '跟着它走，别抢戏',
      '它去哪你跟哪，别犟',
      '把线让给它，安稳吃分',
      '它开团你就上，别犹豫',
      '上等马，少说话多跟上',
      '胜负手就在它身上',
      '状态在线，后背交给它'
    ],
    mid: [
      '不求有功，但求无过',
      '正常发挥，够用',
      '把线守住，别送就行',
      '打不过就缩，别硬刚',
      '它守得住，这局就有底',
      '中规中矩，别指望惊喜',
      '能跟上节奏，就看心情',
      '不拖后腿就是满分'
    ],
    low: [
      '能跑，但跑不快',
      '别让它单带，它扛不住',
      '给它个不容易死的位置',
      '下等马也有下等马的跑法',
      '别指望它发力，指望它别送',
      '打不过会跑，这点还行',
      '节奏慢半拍，跟紧点',
      '能不送就已经谢天谢地'
    ],
    ox: [
      '标准的干活力气活担当',
      '让它去插眼、去抗塔，正好',
      '牛马本马，脏活全给它',
      '它负责挨打，你负责赢',
      '别叫它上，叫它去挡',
      '拉车的好手，打架的苦手',
      '能吃线能挨刀，就是不会赢',
      '把它当工具人用，物尽其用'
    ],
    zero: [
      '连马都不是，是空气',
      '它会走路，但不会拐弯',
      '指望它不如指望自己',
      '它负责存在，你负责赢',
      '给它个安全的位置，别让它送',
      '这场它在不在，区别不大',
      '会补刀，已经很努力了',
      '少送两个，这局还有救'
    ],
    unknown: [
      '还没看出它是马还是牛',
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

  // kda 是近 5 场的 (K+A)/max(1,D), games 是这 5 场里真正有数据的那几场
  function tierOf(kda, games) {
    const n = num(kda);
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
  // "胜率 75% 判最强档、沙盘却说这条路吃亏"的自相矛盾)。
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
    const c = {};
    for (const k of LABEL_KEYS) c[k] = 0;
    for (const m of mates) c[m.tier.key] = (c[m.tier.key] || 0) + 1;
    const known = mates.length - c.unknown;
    // 1.6.62: 句子里的档位名一律走 labelOf —— 用户改了名字, 梗句也得跟着改名,
    // 否则会出现"四个猛男, 这局不好输"上面却写着别的名字的自相矛盾。
    const T = k => labelOf(k);
    const top = c.top, zero = c.zero, ox = c.ox, mid = c.mid;
    // 1.6.63 的教训保留: 每个分支的人数必须和句子对得上, 不能出现"明明没有上等马
    // 却说有两个"这种自相矛盾 —— 五档以后分支更多, 更容易写错。
    let line;
    if (!known) line = '全员' + T('unknown') + '，边打边看';
    else if (top === mates.length) line = '全员' + T('top') + '，这局不好输';
    else if (top >= 4) line = '四个' + T('top') + '，这局不好输';
    else if (top === 3) line = '三个' + T('top') + '，这局不好输';
    else if (top === 2) line = '两个' + T('top') + '，剩下看配合';
    else if (top === 1) line = '就一个' + T('top') + '，全靠它撑场';
    else if (zero === mates.length) line = '全员' + T('zero') + '，这把是来送温暖的';
    else if (zero >= 3) line = zero + '个' + T('zero') + '，就看剩下两个能不能扛';
    else if (zero === 2) line = '两个' + T('zero') + '，全靠剩下三个硬顶';
    else if (zero === 1) line = '一个' + T('zero') + '，那路多照看';
    else if (c.unknown > 0) line = '没有' + T('top') + '，' + c.unknown + '个' + T('unknown') + '还没看透';
    else if (ox >= 2) line = '没有' + T('top') + '，还带' + ox + '个' + T('ox') + '，硬顶吧';
    else if (ox === 1) line = '没有' + T('top') + '，全靠' + T('mid') + '撑场面';
    else if (mid === mates.length) line = '全员' + T('mid') + '，整齐得像军训';
    else line = '没有' + T('top') + '，看谁先掉线';
    const self = mates.find(m => m && m.isSelf);
    if (self && self.tier.key === 'top' && top <= 1) {
      line = '这局只有你一个' + T('top') + '，别掉链子';
    } else if (self && self.tier.key === 'zero') {
      line += '（你自己也在' + T('zero') + '名单里，别笑）';
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
      // 1.6.66: 先算近 5 场明细, 分档吃它的 KDA —— 与聊天消息里印出来的那个数字同源,
      // 否则会出现"消息写着 KDA 5.7, 却只是中等马"这种没法自证的分档。
      const s5 = recent5Of(p);
      const tier = tierOf(s5.kda, s5.n);
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
        s: num(e.wr),          // 沙盘强度 = 胜率百分点 (分档改看 KDA 后, 沙盘仍按胜率)
        tier,
        s5,                    // 最近 5 把的逐场明细与总 KDA (聊天消息 / 预览同源)
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

    const counts = {};
    for (const k of LABEL_KEYS) counts[k] = 0;
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
    rank.chatFlat = chatFlatOf(rank);
    return rank;
  }

  // 1.6.65: 一人两行 —— 头行给"档位 + 名字 + 总 KDA", 次行把这 5 把逐场摆出来。
  // 1.6.64 只写了"近5局 4胜1负", 用户原话是"我不是要 4胜1负, 我是让你把这5局战绩列出来" ——
  // 汇总数字看不出队友是"稳定 4 胜"还是"1 胜 4 负里混了一把 20 杀的", 逐场才有信息量。
  const RECENT_N = 5;
  function recent5Of(p) {
    const src = Array.isArray(p && p.recent) ? p.recent : [];
    const rows = src.slice(0, RECENT_N);
    const s = { n: 0, wins: 0, k: 0, d: 0, a: 0, games: [] };
    for (const r of rows) {
      if (!r) continue;
      const win = r.win === true || r.win === 'Win';
      const k = num(r.k) || 0, d = num(r.d) || 0, a = num(r.a) || 0;
      if (win) s.wins++;
      s.k += k; s.d += d; s.a += a;
      s.games.push({ win, k, d, a });
    }
    s.n = s.games.length;
    s.losses = s.n - s.wins;
    // 加权 KDA: (K + 0.5A) / max(1,D) —— 助攻权重压到半个, 与 thigh-tag.js 同口径。
    // 死 0 场按 1 算, 不会炸成 Infinity; 消息里印的就是这个数, 分档也吃这个数,
    // 所以"我 KDA 3.6 为什么只是中等马"能被用户自己对出来。
    s.kda = s.n ? Math.round((s.k + ASSIST_WEIGHT * s.a) / Math.max(1, s.d) * 10) / 10 : null;
    return s;
  }

  // "胜 9/2/7" —— 胜/负 用一个字, 后面的 K/D/A 保持原样, 一行能塞下 5 把
  const gameText = g => `${g.win ? '胜' : '负'} ${g.k}/${g.d}/${g.a}`;
  const kdaText = s => (s && s.kda == null ? '-' : s.kda.toFixed(1));

  // 头行: "上等马 风会停 加权KDA 3.5"
  function lineOf(m) {
    const s = m && m.s5;
    const head = `${m.tier.label} ${m.name}`;
    if (!s || !s.n) return `${head} 无样本`;
    return `${head} 加权KDA ${kdaText(s)}`;
  }

  // 一个玩家可能占 1~2 行: 头行 + 逐场明细
  function linesOf(m) {
    const s = m && m.s5;
    if (!s || !s.n) return [lineOf(m)];
    return [lineOf(m), `· ${s.games.map(gameText).join(' ｜ ')}`];
  }

  // 单行兜底 (LCU 不收换行时用): 档位 名字 加权KDA 逐场, 全压一行
  function flatLineOf(m) {
    const s = m && m.s5;
    const head = `${m.tier.label} ${m.name}`;
    if (!s || !s.n) return `${head} 无样本`;
    return `${head} 加权KDA ${kdaText(s)} ${s.games.map(g => `${g.win ? '胜' : '负'}${g.k}/${g.d}/${g.a}`).join(' ')}`;
  }

  function chatParts(rank) {
    const c = rank.counts || {};
    const parts = [];
    // 五档顺序写死, 从强到弱; 待定只统计不排进这条统计里
    for (const key of ['top', 'mid', 'low', 'ox', 'zero']) {
      if (!c[key]) continue;
      parts.push(`${labelOf(key)}${c[key]}`);
    }
    // 1.6.66: 排序与"最能带/最需照看"都改看近 5 场 KDA —— 分档既然按 KD,
    // 名单却按胜率排, 会出现"上等马排在第四位"的错位观感。
    const kdaOf = m => (m.s5 && m.s5.kda != null ? m.s5.kda : null);
    const rated = rank.mates.filter(m => kdaOf(m) != null);
    const best = rated.slice().sort((a, b) => kdaOf(b) - kdaOf(a))[0];
    const worst = rated.slice().sort((a, b) => kdaOf(a) - kdaOf(b))[0];
    const tail = [];
    if (best) tail.push(`最能带 ${best.name}`);
    if (worst && worst !== best) tail.push(`最需照看 ${worst.name}`);
    const cmp = `硬碰硬赢 ${rank.direct.wins}/${rank.direct.n}，错位能赢 ${rank.cross.wins}/${rank.cross.n}（玩梗，非胜率预测）`;
    return {
      head: `【Poro·分工表】我方 ${parts.join(' ')}`,
      tail: `${tail.join(' · ')}｜${cmp}`,
      // 逐人按 KDA 从高到低, 没样本的垫底 —— 收到消息的人第一眼看到最能指望的那个
      mates: rank.mates.slice().sort((a, b) => (kdaOf(b) == null ? -1 : kdaOf(b)) - (kdaOf(a) == null ? -1 : kdaOf(a)))
    };
  }

  function chatLinesOf(rank) {
    if (!rank || !rank.ready) return [];
    const p = chatParts(rank);
    const rows = [];
    for (const m of p.mates) rows.push.apply(rows, linesOf(m));
    return [p.head].concat(rows, p.tail);
  }

  // 单行兜底版 (LCU 万一不收换行): 每个人压成一行, 逐场用 胜9/2/7 这种紧凑写法
  function chatFlatOf(rank) {
    if (!rank || !rank.ready) return '';
    const p = chatParts(rank);
    return [p.head].concat(p.mates.map(flatLineOf), p.tail).join(' ｜ ');
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
  // 图例上写的是分档阈值 (近 5 场加权 KDA), 不是胜率 —— 改口径以后这里最容易漏改
  const TIER_HINT = { top: 'KDA ≥3.5', mid: '≥2.5', low: '≥1.8', ox: '≥1.0', zero: '&lt;1.0' };

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
      // 预览与聊天消息同源: 头行"档位 名字 加权KDA", 次行把这 5 把逐场摆开
      const s5 = m.s5 || {};
      const head = s5.n ? `${m.name} 加权KDA ${kdaText(s5)}` : `${m.name} 无样本`;
      const detail = s5.n ? s5.games.map(gameText).join(' ｜ ') : `近${RECENT_N}局没有可用的战绩`;
      return `<div class="fd-pv-row" title="${esc(why)}">
        <b class="fd-badge fd-${m.tier.cls}">${esc(m.tier.label)}</b>
        <span class="fd-pv-name">${esc(head)}${m.isSelf ? '<i class="fd-you">自己</i>' : ''}</span>
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
    const dist = LABEL_KEYS
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
          <span>分档看近 ${RECENT_N} 场加权 KDA（不足 ${MIN_GAMES} 场记待定），沙盘看胜率，纯玩梗。</span>
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
    TIERS, UNKNOWN_TIER, DEFAULT_LABELS, LABEL_KEYS, LABEL_MAX, EDGE, ASSIST_WEIGHT, TIER_HINT
  };
});
