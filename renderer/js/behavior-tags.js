// 玩家行为标签: 投降倾向 / 信号习惯 (问号、撤退、危险、提醒)
//
// 数据: 国服战绩服务 (SGP) 的参与者对象上直接有 gameEndedInSurrender 与 enemyMissingPings / getBackPings /
//   dangerPings / needVisionPings 等字段 (字段名取自 LeagueAkari 的 SGP 类型定义)。
//   外服走客户端自带的战绩接口, 不保证有这些字段 —— 字段缺失就是「未知」, 绝不当成 0 去下结论。
//
// 口径 (写在这里, 标签的 title 里也会原样显示, 不做"孤儿指数"之类没有依据的打分):
//   · 至少 MIN_GAMES 场「带有该字段」的对局才给标签, 否则不显示
//   · 信号取「场均次数」; 同时要求被统计场次里至少 PING_MIN_ACTIVE_RATIO 的场次确实发过信号, 防止一场刷屏拉高均值
//   · 投降取「本人所在队伍以投降结束」的比例
//   · 阈值是经验值, 只作提示, 不是官方判定; 不能用来给人下定论
// 这些是对玩家的负面描述, 只在实时对局页对队友/对手显示, 不上传、不发送聊天 (发送聊天另有开关, 本模块不涉及)。

const BEHAVIOR_MIN_GAMES = 8;
const BEHAVIOR_SURRENDER_HIGH = 0.4;      // ≥40% 的对局以投降结束
const BEHAVIOR_SURRENDER_MID = 0.28;
const BEHAVIOR_PING_QUESTION = 3.5;       // 场均问号 ≥ 3.5
const BEHAVIOR_PING_RETREAT = 4.0;        // 场均撤退 ≥ 4.0
const BEHAVIOR_PING_DANGER = 2.8;
const BEHAVIOR_PING_TOTAL_HIGH = 12;      // 场均各类信号合计 ≥ 12 (只统计这四类)
const PING_MIN_ACTIVE_RATIO = 0.5;
const PING_FIELDS = ['enemyMissingPings', 'getBackPings', 'dangerPings', 'needVisionPings'];

const isCount = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1000;

// 从 SGP 参与者对象里取出这些字段; 任一字段缺失/非法则该局的信号数据记为 null (未知)
function extractBehavior(me) {
  if (!me || typeof me !== 'object') return null;
  const pings = PING_FIELDS.every(k => isCount(me[k]))
    ? { question: me.enemyMissingPings, retreat: me.getBackPings, danger: me.dangerPings, vision: me.needVisionPings }
    : null;
  // gameEndedInSurrender 是「这局以投降结束」, 赢的一方也是 true。投降只能由输的一方发起,
  // 所以「以投降结束且本人输了」才是「我所在的队伍投降了」; 缺 win 字段时无法判断, 记为未知
  const surrender = typeof me.gameEndedInSurrender === 'boolean' && typeof me.win === 'boolean'
    ? (me.gameEndedInSurrender === true && me.win === false)
    : null;
  if (!pings && surrender === null) return null;
  return { pings, surrender };
}

function averagePings(rows) {
  const withPings = rows.filter(r => r && r.pings);
  if (withPings.length < BEHAVIOR_MIN_GAMES) return null;
  const sum = k => withPings.reduce((s, r) => s + r.pings[k], 0);
  const n = withPings.length;
  const avg = { question: sum('question') / n, retreat: sum('retreat') / n, danger: sum('danger') / n, vision: sum('vision') / n, games: n };
  avg.total = avg.question + avg.retreat + avg.danger + avg.vision;
  const active = k => withPings.filter(r => r.pings[k] > 0).length / n;
  avg.activeRatio = { question: active('question'), retreat: active('retreat'), danger: active('danger') };
  return avg;
}

// 返回 [{ key, label, level: 'bad'|'warn'|'info', detail }]; 数据不足返回 []
function deriveBehaviorTags(recent) {
  const rows = (Array.isArray(recent) ? recent : []).map(g => g && g.behavior).filter(Boolean);
  const tags = [];

  const surrenderRows = rows.filter(r => r.surrender !== null);
  if (surrenderRows.length >= BEHAVIOR_MIN_GAMES) {
    const rate = surrenderRows.filter(r => r.surrender).length / surrenderRows.length;
    const pct = Math.round(rate * 100);
    const detail = `近 ${surrenderRows.length} 场里 ${surrenderRows.filter(r => r.surrender).length} 场以投降结束 (${pct}%)`;
    if (rate >= BEHAVIOR_SURRENDER_HIGH) tags.push({ key: 'surrender-high', label: '常投降', level: 'bad', detail });
    else if (rate >= BEHAVIOR_SURRENDER_MID) tags.push({ key: 'surrender-mid', label: '易投降', level: 'warn', detail });
  }

  const avg = averagePings(rows);
  if (avg) {
    const f = v => v.toFixed(1);
    const base = `近 ${avg.games} 场场均`;
    // 总量最高的优先, 且互斥: 同一个人不会同时挂「爱抱怨」和「爱发问号」两个意思相近的
    if (avg.total >= BEHAVIOR_PING_TOTAL_HIGH && avg.activeRatio.retreat >= PING_MIN_ACTIVE_RATIO) {
      tags.push({ key: 'ping-heavy', label: '信号多', level: 'warn', detail: `${base}信号 ${f(avg.total)} 次 (问号 ${f(avg.question)} / 撤退 ${f(avg.retreat)} / 危险 ${f(avg.danger)} / 提醒 ${f(avg.vision)})` });
    } else if (avg.question >= BEHAVIOR_PING_QUESTION && avg.activeRatio.question >= PING_MIN_ACTIVE_RATIO) {
      tags.push({ key: 'ping-question', label: '爱发问号', level: 'warn', detail: `${base}问号 ${f(avg.question)} 次` });
    } else if (avg.retreat >= BEHAVIOR_PING_RETREAT && avg.activeRatio.retreat >= PING_MIN_ACTIVE_RATIO) {
      tags.push({ key: 'ping-retreat', label: '爱发撤退', level: 'warn', detail: `${base}撤退 ${f(avg.retreat)} 次` });
    } else if (avg.danger >= BEHAVIOR_PING_DANGER && avg.activeRatio.danger >= PING_MIN_ACTIVE_RATIO) {
      tags.push({ key: 'ping-danger', label: '爱发危险', level: 'info', detail: `${base}危险 ${f(avg.danger)} 次` });
    }
  }
  return tags;
}

function behaviorTagsHtml(recent) {
  const tags = deriveBehaviorTags(recent);
  if (!tags.length) return '';
  const note = '行为提示: 依据近期战绩里的投降与信号统计，阈值为经验值，仅供参考，不代表对该玩家的评价';
  return tags.map(t => `<span class="lp-behavior lp-behavior-${t.level}" title="${escapeHtml(t.detail + '。' + note)}">${escapeHtml(t.label)}</span>`).join('');
}
