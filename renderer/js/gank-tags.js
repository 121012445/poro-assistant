// 「好抓」标签：判断对面某个人值不值得去 gank (纯函数, 无 DOM / 无 IO / 无定时器)
//
// 为什么单独成文件: 这是给人下行动指令的标签, 判错就是把人往死路带 ——
// 比如把对面 carry 型上单标成"好抓", 玩家一头撞上去送双杀。抽成纯函数后可以在
// node 里直接跑断言 (同 player-habits.js / live-metrics.js 的做法), 也方便日后单独调阈值。
//
// 数据边界 (必须说清, 否则就是编数据):
//   · 只有历史战绩, 没有本局的实时位置/兵线/召唤师技能冷却 —— Live Client Data 不提供
//     这些。所以这里判的是「他平时是不是经常死、有没有做视野、打哪条线」的倾向,
//     不是"这一波他一定在河岸草丛"的预测。
//   · 因此标签文案用「好抓」而不是「必杀」, tooltip 里必须写清依据的是近 N 场历史。
//
// 输入: 实时页已经拉下来的 recent[] (最多 20 场), 字段:
//   d         阵亡数 (核心信号: 死得多 = 经常被抓到)
//   vision    视野得分 (不插眼 = 绕后不会被发现)
//   kp        参团率 (低 = 常在边线单带, 落单机会多)
//   position  该场位置 (国服常为空; 空不进分母)
//   mode/queueId  用于筛出峡谷样本 —— 大乱斗场均死 8~10 次, 混进来会把全员判成好抓
//   solo      单杀次数 (能反杀的人不该被叫"好抓")
//
// 原则 (与全项目一致): 拿不准就不输出。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  if (root) root.PoroGank = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // 样本门槛: 少于 8 场不下结论; 阵亡是核心信号, 缺它的场次还要单独凑够 8 场
  const MIN_GAMES = 8;
  const MIN_VISION_GAMES = 5;     // 视野是辅助信号, 5 场就够看趋势
  const MIN_KP_GAMES = 5;
  const MIN_POS_GAMES = 6;        // 历史主位置至少 6 场
  const POS_SHARE = 0.6;          // 且占 60% 以上才算"主玩这条线"
  const THRESHOLD = 56;           // 总分 >= 56 才挂标签

  // 峡谷队列: 与 player-habits.js 的 modeFamilyOf 同口径 (排位/匹配/快速对局/自定义)
  const RIFT_QUEUES = [400, 420, 430, 440, 490];
  const RIFT_MODE_RE = /召唤师峡谷|CLASSIC|排位|匹配|单双排|灵活组排|快速对局/i;

  function isRiftGame(r) {
    if (!r || typeof r !== 'object') return false;
    const q = Number(r.queueId) || 0;
    if (RIFT_QUEUES.includes(q)) return true;
    const text = String(r.mode == null ? '' : r.mode);
    if (RIFT_MODE_RE.test(text)) return true;
    // 队列号和模式名都对不上时, 用"有没有分路"兜底: 大乱斗/斗魂没有 position 字段。
    // 这条只做正向兜底, 反向不做 —— 峡谷对局里位置也可能为空 (国服常见)。
    return false;
  }

  const POSITION_ALIASES = {
    TOP: 'TOP', 上路: 'TOP', 上单: 'TOP',
    JUNGLE: 'JUNGLE', 打野: 'JUNGLE', 野区: 'JUNGLE',
    MIDDLE: 'MIDDLE', MID: 'MIDDLE', 中路: 'MIDDLE', 中单: 'MIDDLE',
    BOTTOM: 'BOTTOM', ADC: 'BOTTOM', 下路: 'BOTTOM', 射手: 'BOTTOM',
    UTILITY: 'UTILITY', SUPPORT: 'UTILITY', 辅助: 'UTILITY', 支持: 'UTILITY'
  };

  function normalizePosition(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    return POSITION_ALIASES[raw.toUpperCase()] || POSITION_ALIASES[raw] || '';
  }

  const POSITION_LABELS = {
    TOP: '上路', JUNGLE: '打野', MIDDLE: '中路', BOTTOM: '下路', UTILITY: '辅助'
  };

  function avg(list, f) {
    const vals = list.filter(r => r[f] != null && Number.isFinite(Number(r[f]))).map(r => Number(r[f]));
    if (!vals.length) return null;
    return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 10) / 10;
  }

  // 历史主位置: 最近样本里出现最多的那条线, 占比不够就不认 (补位玩家没有"主玩线")
  function mainPositionOf(list) {
    const count = {};
    let total = 0;
    for (const r of list) {
      const pos = normalizePosition(r.position);
      if (!pos) continue;
      count[pos] = (count[pos] || 0) + 1;
      total++;
    }
    let best = null;
    for (const [pos, n] of Object.entries(count)) if (!best || n > best.n) best = { pos, n };
    if (!best || total < MIN_POS_GAMES) return null;
    const share = best.n / total;
    if (share < POS_SHARE) return null;
    return { pos: best.pos, games: best.n, total, share };
  }

  // 逐项打分。每一项都是可解释的事实 + 一个权重, 不做黑箱加权。
  // 返回 { score, reasons[], notes[] } —— notes 记的是"减分理由", 用于 tooltip 说明为什么没标。
  function scoreOf(recent, opts) {
    const o = opts || {};
    const all = Array.isArray(recent) ? recent.filter(r => r && typeof r === 'object') : [];
    const rift = all.filter(isRiftGame);
    if (rift.length < MIN_GAMES) return null;

    const dVals = rift.filter(r => Number.isFinite(Number(r.d)) && Number(r.d) >= 0);
    if (dVals.length < MIN_GAMES) return null;      // 没有阵亡样本就没有核心依据
    const d = avg(dVals, 'd');
    if (d == null) return null;

    const vGames = rift.filter(r => r.vision != null && Number.isFinite(Number(r.vision))).length;
    const vision = vGames >= MIN_VISION_GAMES ? avg(rift, 'vision') : null;
    const kpGames = rift.filter(r => r.kp != null && Number.isFinite(Number(r.kp))).length;
    const kp = kpGames >= MIN_KP_GAMES ? Math.round(avg(rift, 'kp')) : null;
    const soloGames = rift.filter(r => r.solo != null && Number.isFinite(Number(r.solo))).length;
    const solo = soloGames >= MIN_VISION_GAMES ? avg(rift, 'solo') : null;
    const wins = rift.filter(r => r.win === true || r.win === 'Win').length;
    const winRate = Math.round(wins / rift.length * 100);

    // 位置: 本局位置优先 (最准), 拿不到看历史主玩线
    const livePos = normalizePosition(o.position || o.teamPosition);
    const hist = mainPositionOf(rift);
    const pos = livePos || (hist ? hist.pos : '');
    const posSrc = livePos ? 'live' : (hist ? 'history' : '');

    let score = 0;
    const reasons = [];
    const notes = [];

    // 1) 阵亡 —— 越常死越容易被抓。这是唯一直接对应"被抓到"的证据。
    if (d >= 6.8) { score += 36; reasons.push(`场均阵亡 ${d}`); }
    else if (d >= 5.8) { score += 28; reasons.push(`场均阵亡 ${d}`); }
    else if (d >= 5.0) { score += 18; }
    else if (d >= 4.2) { score += 8; }
    else if (d < 3.5) { score -= 14; notes.push(`场均只死 ${d}`); }

    // 2) 视野 —— 不插眼, 河道/三角草空着, 绕后不会被提前发现
    if (vision != null) {
      if (vision <= 13) { score += 26; reasons.push(`视野 ${vision}`); }
      else if (vision <= 19) { score += 17; reasons.push(`视野 ${vision}`); }
      else if (vision <= 27) { score += 7; }
      else if (vision >= 36) { score -= 13; notes.push(`视野 ${vision} 眼睛很多`); }
    }

    // 3) 分路 —— 单人线兵线长、绕后路线多; 打野自己会动, 基本抓不到;
    //    双人路多数时候抱团, 单抓收益低 (越塔是另一回事, 不在这里判)
    if (pos === 'TOP' || pos === 'MIDDLE') { score += 16; reasons.push(`${POSITION_LABELS[pos]}单人线`); }
    else if (pos === 'JUNGLE') { score -= 22; notes.push('打野位置不固定'); }
    else if (pos === 'BOTTOM' || pos === 'UTILITY') { score -= 2; }

    // 4) 参团 —— 参团率很低说明他常在边线单带, 落单的时间窗口更多
    if (kp != null) {
      if (kp <= 45) { score += 11; reasons.push(`参团 ${kp}%`); }
      else if (kp <= 55) { score += 4; }
      else if (kp >= 68) { score -= 7; notes.push(`参团 ${kp}% 总跟团`); }
    }

    // 5) 反向修正: 能反杀/会玩的人不能标成提款机 (这是最伤人的误报)
    if (solo != null && solo >= 2.5 && d <= 4.6) { score -= 12; notes.push(`场均单杀 ${solo}`); }
    if (winRate >= 62 && d <= 5.2) { score -= 10; notes.push(`近 ${rift.length} 场 ${winRate}% 胜率`); }

    return {
      score,
      level: score >= THRESHOLD ? 'good' : 'none',
      games: rift.length,
      deathGames: dVals.length,
      d,
      vision,
      visionGames: vGames,
      kp,
      kpGames,
      solo,
      pos,
      posSrc,
      posLabel: pos ? (POSITION_LABELS[pos] || '') : '',
      winRate,
      reasons,
      notes
    };
  }

  // 卡片标签: 只给敌方、只在峡谷对局、只给达到阈值的玩家。
  // 返回 null 表示不挂; 返回对象由渲染层拼成 span。
  function tagInfo(recent, opts) {
    const o = opts || {};
    if (!o.enemy) return null;                  // 我方/未知阵营不判
    // 明确是别的家族 (大乱斗/斗魂/娱乐) 就不出 —— 那些模式没有"抓"这回事。
    // 但 'other' 表示模式识别失败 (队列号不在表里 / 对局上下文还没推上来), 这时不一律
    // 打死: 下面的 isRiftGame 已经按队列号和模式名把样本筛过一遍, 拿不到峡谷样本
    // 自然出不来标签 —— 两层保护, 比"识别失败就整批不显示"更不容易漏掉匹配局。
    if (o.family && o.family !== 'rift' && o.family !== 'other') return null;
    const r = scoreOf(recent, o);
    if (!r || r.level !== 'good') return null;
    const parts = [];
    if (r.d != null) parts.push(`场均阵亡 ${r.d}`);
    if (r.vision != null) parts.push(`视野 ${r.vision}`);
    if (r.posLabel) parts.push(`${r.posLabel}${r.posSrc === 'history' ? '(主玩)' : ''}`);
    if (r.kp != null) parts.push(`参团 ${r.kp}%`);
    return {
      label: '好抓',
      score: r.score,
      tip: `近 ${r.games} 场峡谷: ${parts.join('、')} —— 死得多、视野少，绕后容易得手。` +
           '按历史习惯判断，不是本局位置预测',
      detail: r
    };
  }

  return {
    MIN_GAMES,
    THRESHOLD,
    RIFT_QUEUES,
    isRiftGame,
    normalizePosition,
    mainPositionOf,
    scoreOf,
    tagInfo
  };
});
