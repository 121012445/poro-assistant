// 小代标签 (排位赛专属): 近期战绩与当前段位明显不符 —— 疑似小号 / 代练
//
// 为什么只在排位出现:
//   匹配、大乱斗、斗魂没有"段位参照物", 打得好可能只是英雄强势/模式熟练/车队带飞。
//   只有单双排(420)与灵活组排(440)才有段位这个基准, 才谈得上"不符合"。
//
// 判定思路 (阈值全是经验值, 原样写进 title, 不做黑箱打分):
//   · 样本: 近 10 场以上排位才判定 —— 少于 10 场随机性太大, 8 场 7 胜可能只是运气
//   · 段位分层:
//       黑铁 ~ 黄金   = 强信号区 (这里的正常水平是 KDA 2~3, 胜率 50%)
//       铂金 / 翡翠   = 需更严 (高胜率在高段位不算罕见, 但 82% + KDA 5.5 仍然异常)
//       钻石及以上    = 不出 (高段位高胜率是实力, 不是异常)
//       未定级        = 不出 (没有基准可比, 新号也可能只是刚打完定级)
//   · 两条路径, 任一成立即出:
//       战绩路径 = 胜率达标 + 基础个人能力证据 ≥ 2 条
//       数据路径 = 队内最佳占比 / 伤害占比 / 爆炸局 这类"碾压型"证据 ≥ 2 条
//                  + 基础证据 ≥ 2 条 + 胜率仍有 45% (低于这个不是碾压, 是送)
//     只看胜率会漏掉"个人碾压但队友拖后腿"的号 (五成出头胜率却是队内最佳常客),
//     只看数据又会把"只会打线不赢比赛"的本地高手误判, 所以两条都要有下限。
//   · 基础证据 = KDA ≥ 4.5 / 伤转 ≥ 140% / 分均CS ≥ 8.0 / 场均单杀 ≥ 1.5
//     碾压证据 = 队内最佳 ≥ 50% / 伤害占比 ≥ 30% / 单局 KDA ≥ 8 的场次 ≥ 30%
//   · 铂金/翡翠的数据路径额外要求"队内最佳 ≥ 70%"与 KDA ≥ 5.5 —— 高段位不做弱信号推断
//
// 这些是推测性结论, 只在 Poro 本地界面显示, 不上传、不发送聊天。
// 标签文字用「小代」, title 里写清是"疑似", 并注明仅供参考、不代表对该玩家的评价。

const SMURF_RANKED_QUEUES = [420, 440];        // 单双排 / 灵活组排
const SMURF_MIN_GAMES = 10;
const SMURF_LOW_TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD'];
const SMURF_MID_TIERS = ['PLATINUM', 'EMERALD'];
const SMURF_WR_LOW = 0.72;                     // 低段位: 战绩路径的胜率门槛
const SMURF_WR_MID = 0.82;                     // 中段位: 提高门槛
const SMURF_KDA = 4.5;                         // 基础证据 1
const SMURF_KDA_STRICT = 5.5;                  // 中段位额外要求
const SMURF_DMG_GOLD = 140;                    // 基础证据 2: 伤转 (伤害/经济)
const SMURF_CSPM = 8.0;                        // 基础证据 3: 分均补刀
const SMURF_SOLO = 1.5;                        // 基础证据 4: 场均单杀
const SMURF_BEST_RATE = 0.5;                   // 碾压证据 1: 队内最佳占比
const SMURF_BEST_RATE_STRONG = 0.7;            // 中段位数据路径的硬要求
const SMURF_BEST_MIN_KNOWN = 6;                // 至少 6 场拿得到队友数据才用它
const SMURF_DMG_PCT = 30;                      // 碾压证据 2: 场均伤害占比
const SMURF_STOMP_KDA = 8;                     // 碾压证据 3: 单局 KDA 达到这个数算一局爆炸局
const SMURF_STOMP_RATE = 0.3;                  // 爆炸局占样本的比例
const SMURF_DATA_MIN_WR = 0.45;                // 数据路径仍要的最低胜率
const SMURF_NOTE = '；阈值是经验值，仅供参考，不代表对该玩家的评价';

function isSmurfRankedQueue(queueId) {
  return SMURF_RANKED_QUEUES.includes(Number(queueId));
}

function smurfAvg(list) {
  const v = list.filter(x => x != null && Number.isFinite(Number(x))).map(Number);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

// 只统计当前排位队列的对局。老缓存里的战绩行没有 queueId 字段,
// 这时退回全量 (口径变宽, 但不会漏判), 有字段时严格按队列过滤。
function smurfSampleRows(recent, queueId) {
  const rows = (Array.isArray(recent) ? recent : []).filter(r => r && typeof r === 'object');
  if (!rows.length) return [];
  const withQueue = rows.filter(r => Number(r.queueId) > 0);
  if (!withQueue.length) return rows;
  const q = Number(queueId) || 0;
  return q ? rows.filter(r => Number(r.queueId) === q) : withQueue;
}

function smurfStats(rows) {
  const games = rows.length;
  if (games < SMURF_MIN_GAMES) return null;
  const win = r => r.win === true || r.win === 'Win';
  const wins = rows.filter(win).length;
  const kdaVals = rows.map(r => ((Number(r.k) || 0) + (Number(r.a) || 0)) / Math.max(1, Number(r.d) || 0));
  const cspm = rows
    .filter(r => Number(r.cs) > 0 && Number(r.dur) > 0)
    .map(r => Number(r.cs) / (Number(r.dur) / 60));
  const solo = rows.filter(r => r.solo != null).map(r => Number(r.solo) || 0);
  const dmgGold = rows.filter(r => r.dmgGold != null).map(r => Number(r.dmgGold) || 0);
  // 队内最佳: 只统计"拿得到队友数据"的场次 (best 为 null 的场次不计入分母),
  // 否则外服单人返回的接口会把最佳率算成 0 或 100。
  const bestRows = rows.filter(r => r.best === true || r.best === false);
  const bestGames = bestRows.filter(r => r.best === true).length;
  const dmgPct = rows.filter(r => r.dmgPct != null).map(r => Number(r.dmgPct) || 0);
  const stomp = kdaVals.filter(v => v >= SMURF_STOMP_KDA).length;
  return {
    games,
    wins,
    winRate: wins / games,
    kda: smurfAvg(kdaVals),
    dmgGold: smurfAvg(dmgGold),
    cspm: smurfAvg(cspm),
    solo: smurfAvg(solo),
    bestKnown: bestRows.length,
    bestGames,
    bestRate: bestRows.length >= SMURF_BEST_MIN_KNOWN ? bestGames / bestRows.length : null,
    dmgPct: smurfAvg(dmgPct),
    stompRate: games ? stomp / games : null
  };
}

function smurfTierText(tier, division) {
  const cn = typeof rankTierCN === 'function' ? rankTierCN(tier) : tier;
  return String(cn || '') + (division ? ' ' + division : '');
}

// 返回 { label, detail, games, winRate, mode, personal, carry } 或 null
function deriveSmurfTag(player, opts) {
  const o = opts || {};
  if (o.isSelf) return null;                       // 自己不需要这个标签
  const queueId = Number(o.queueId) || 0;
  if (!isSmurfRankedQueue(queueId)) return null;   // 排位专属

  const tier = String(o.tier || (player && player.tier) || '').toUpperCase();
  const isLow = SMURF_LOW_TIERS.includes(tier);
  const isMid = SMURF_MID_TIERS.includes(tier);
  if (!isLow && !isMid) return null;               // 未定级 / 钻石以上 不判定

  const s = smurfStats(smurfSampleRows(player && player.recent, queueId));
  if (!s) return null;

  // 基础个人能力证据
  const personal = [];
  if (s.kda != null && s.kda >= SMURF_KDA) personal.push('KDA ' + (Math.round(s.kda * 10) / 10));
  if (s.dmgGold != null && s.dmgGold >= SMURF_DMG_GOLD) personal.push('伤转 ' + Math.round(s.dmgGold) + '%');
  if (s.cspm != null && s.cspm >= SMURF_CSPM) personal.push('分均CS ' + (Math.round(s.cspm * 10) / 10));
  if (s.solo != null && s.solo >= SMURF_SOLO) personal.push('场均单杀 ' + (Math.round(s.solo * 10) / 10));

  // 碾压型证据: 这些是"这个人在自己队里是绝对核心"的表现, 与胜率无关, 单独计数
  const carry = [];
  if (s.bestRate != null && s.bestRate >= SMURF_BEST_RATE) {
    carry.push('队内最佳 ' + s.bestGames + '/' + s.bestKnown + ' 场');
  }
  if (s.dmgPct != null && s.dmgPct >= SMURF_DMG_PCT) carry.push('伤害占比 ' + Math.round(s.dmgPct) + '%');
  if (s.stompRate != null && s.stompRate >= SMURF_STOMP_RATE) carry.push('爆炸局 ' + Math.round(s.stompRate * 100) + '%');

  const winPath = isLow
    ? (s.winRate >= SMURF_WR_LOW && personal.length >= 2)
    : (s.winRate >= SMURF_WR_MID && s.kda != null && s.kda >= SMURF_KDA_STRICT && personal.length >= 3);

  // 数据路径: 胜率可以不到战绩路径的门槛, 但个人数据必须明显不像这个段位。
  // 中段位额外要求"队内最佳 ≥ 70%" —— 铂金/翡翠只靠伤害占比这种弱信号不足以判定。
  const strongCarry = s.bestRate != null && s.bestRate >= SMURF_BEST_RATE_STRONG;
  const dataPath = s.winRate >= SMURF_DATA_MIN_WR
    && personal.length >= 2
    && carry.length >= 2
    && s.kda != null && s.kda >= SMURF_KDA
    && (isLow || (strongCarry && s.kda >= SMURF_KDA_STRICT));

  if (!winPath && !dataPath) return null;

  const wr = Math.round(s.winRate * 100);
  const tierText = smurfTierText(tier, o.division || (player && player.division) || '');
  const evidence = carry.concat(personal);
  return {
    label: '小代',
    games: s.games,
    wins: s.wins,
    winRate: wr,
    mode: winPath ? 'win' : 'data',
    personal,
    carry,
    detail: '疑似小号/代练 · 近 ' + s.games + ' 场排位 ' + wr + '% 胜率'
      + (winPath ? '' : '但个人数据碾压')
      + ' · ' + evidence.join(' · ')
      + (tierText ? ' · 当前' + tierText + '（这组数据通常出现在钻石以上）' : '')
  };
}

function smurfTagHtml(player, opts) {
  let t = null;
  try { t = deriveSmurfTag(player, opts); } catch (e) { t = null; }
  if (!t) return '';
  const esc = typeof escapeHtml === 'function' ? escapeHtml : (x => String(x));
  return `<span class="lp-metric lp-tag-smurf" title="${esc(t.detail + SMURF_NOTE)}">${t.label}</span>`;
}
