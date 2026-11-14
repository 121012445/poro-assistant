// 玩家习惯卡：把近 20 场战绩聚合成"他一般怎么打"的计数型结论 (纯函数, 无 DOM / 无 IO / 无定时器)
//
// 为什么单独成文件: 这些判定决定"给用户的结论对不对", 算错就是误导。抽成纯函数后可以在
// node 里直接跑断言, 不必开 Electron、不必真打一局 (同 live-metrics.js 的做法)。
//
// 数据来源: 实时页已经为每个玩家拉下来的 recent[] (最多 20 场), 字段:
//   position  每场位置 (国服常为空, 空就不计入分母)
//   champId   英雄
//   d         阵亡
//   fb        是否拿一血 (SGP 有 firstBloodKill/Assist; LCU 兜底只有 Kill)
//   mode      该局模式名 —— 用来按"当前对局的模式家族"筛样本 (大乱斗一场死得更多,
//             拿峡谷样本去judge大乱斗的阵亡数就是误报)
//
// 原则 (与全项目一致): 拿不准就不输出。
//   · 少于 MIN_GAMES 场(同模式家族)不给任何结论;
//   · 每条结论都带分母 (「打野 14/18」「一血 7/20」), 不带分母的"评分"一律不做;
//   · 位置缺失的局不进位置分母, 不能把"字段没给"当成"补位";
//   · 只描述事实, 不预测输赢、不打分。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  if (root) root.PoroHabits = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const MIN_GAMES = 8;               // 少于 8 场不下结论
  const POSITION_MIN_SHARE = 0.7;    // 某个位置占 70% 以上才算"主玩"
  const POSITION_SPREAD = 3;         // 横跨 3 个位置以上算"补位型"
  // 场均阵亡阈值按模式家族走: 大乱斗/海斗一场死 8~10 次很常见, 用峡谷的 6.5 会全员误报
  const DEATH_HIGH = { rift: 6.5, aram: 9.5, arena: 8, fun: 8.5, other: 6.5 };
  const DEATH_LOW = 3.2;             // 场均阵亡低
  const FB_MIN_SHARE = 0.4;          // 一血参与率够高才占位
  const POOL_WIDE = 10;              // 近 20 场玩过 10 个以上英雄算池子宽

  const POSITION_LABELS = {
    TOP: '上路', JUNGLE: '打野', MIDDLE: '中路', MID: '中路',
    BOTTOM: '下路', ADC: '下路', UTILITY: '辅助', SUPPORT: '辅助'
  };
  // 国服/不同接口可能直接给中文或小写, 统一归一
  const POSITION_ALIASES = {
    上路: 'TOP', 上单: 'TOP', 打野: 'JUNGLE', 中路: 'MIDDLE', 中单: 'MIDDLE',
    下路: 'BOTTOM', 下路双人组: 'BOTTOM', 射手: 'BOTTOM', 辅助: 'UTILITY', 支持: 'UTILITY'
  };
  // 同义写法要归到同一个 key, 否则「MID 6 场 + MIDDLE 6 场」会被当成两个位置
  const POSITION_CANON = { MID: 'MIDDLE', ADC: 'BOTTOM', SUPPORT: 'UTILITY' };

  function normalizePosition(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    const upper = raw.toUpperCase();
    if (POSITION_LABELS[upper]) return POSITION_CANON[upper] || upper;
    if (POSITION_ALIASES[raw]) return POSITION_ALIASES[raw];
    return '';
  }

  // 一局是否拿了一血: true 算, false 不算, null/undefined 记为"没有该字段"
  function firstBloodOf(game) {
    if (!game) return null;
    const v = game.fb;
    if (v === true) return true;
    if (v === false) return false;
    return null;
  }

  // 模式家族: 与 repeat-mistakes.js 同一套口径 (队列 ID 优先, 其次模式名)
  function modeFamilyOf(value, queueId) {
    const q = Number(queueId) || 0;
    const text = String(value == null ? '' : value).toUpperCase();
    if (q === 2400 || /海克斯大乱斗|KIWI_JADE|MAYHEM/.test(text)) return 'aram';
    if (q === 450 || /极地大乱斗|ARAM|KIWI/.test(text)) return 'aram';
    if ([1700, 1710, 1750].includes(q) || /斗魂|CHERRY|SKIRMISH|ARENA/.test(text)) return 'arena';
    if ([900, 1020, 1300].includes(q) || /无限火力|克隆|极限闪击|URF|ONEFORALL|NEXUSBLITZ|JADE|飞升/.test(text)) return 'fun';
    if ([400, 420, 430, 440, 490].includes(q) || /召唤师峡谷|CLASSIC|排位|匹配|单双排|灵活组排|快速对局/.test(text)) return 'rift';
    return 'other';
  }

  // family 给定时只用同一模式家族的样本 —— 拿峡谷样本去判定大乱斗的阵亡数就是误报。
  function buildHabitProfile(recent, family) {
    const all = Array.isArray(recent) ? recent.filter(r => r && typeof r === 'object') : [];
    const fam = (family && family !== 'other' && DEATH_HIGH[family]) ? family : '';   // 'other' 表示判定不出模式, 此时不筛样本
    const list = fam
      ? all.filter(r => modeFamilyOf(r.mode, r.queueId) === fam)
      : all;
    const positions = {};
    let positioned = 0;
    const champs = new Map();
    let deaths = 0;
    let deathGames = 0;
    let fbHit = 0;
    let fbTotal = 0;

    for (const r of list) {
      const pos = normalizePosition(r.position);
      if (pos) { positions[pos] = (positions[pos] || 0) + 1; positioned++; }
      const cid = Number(r.champId) || 0;
      if (cid > 0) champs.set(cid, (champs.get(cid) || 0) + 1);
      const d = Number(r.d);
      if (Number.isFinite(d) && d >= 0) { deaths += d; deathGames++; }
      const fb = firstBloodOf(r);
      if (fb !== null) { fbTotal++; if (fb) fbHit++; }
    }

    let topPos = null;
    for (const [key, n] of Object.entries(positions)) {
      if (!topPos || n > topPos.n) topPos = { key, n };
    }
    let topChamp = null;
    for (const [id, n] of champs) {
      if (!topChamp || n > topChamp.n) topChamp = { id, n };
    }

    const games = list.length;
    return {
      games,
      family: fam || 'other',
      positions,
      positioned,
      positionCount: Object.keys(positions).length,
      topPos: topPos ? { ...topPos, share: positioned ? topPos.n / positioned : 0 } : null,
      champCount: champs.size,
      topChamp: topChamp ? { ...topChamp, share: games ? topChamp.n / games : 0 } : null,
      avgDeaths: deathGames ? Math.round((deaths / deathGames) * 10) / 10 : null,
      deathGames,
      fbHit,
      fbTotal,
      fbShare: fbTotal ? fbHit / fbTotal : 0
    };
  }

  // 全部结论 (玩家详情抽屉用), 按可信度/信息量排序
  function habitItems(profile) {
    const p = profile || {};
    const out = [];
    if (!p.games || p.games < MIN_GAMES) return out;

    if (p.topPos && p.positioned >= MIN_GAMES) {
      if (p.topPos.share >= POSITION_MIN_SHARE) {
        out.push({
          key: 'position',
          label: '主玩',
          value: `${POSITION_LABELS[p.topPos.key] || p.topPos.key} ${p.topPos.n}/${p.positioned}`,
          tip: `近 ${p.positioned} 场里 ${p.topPos.n} 场打${POSITION_LABELS[p.topPos.key] || p.topPos.key}，位置比较固定`,
          tone: 'info'
        });
      } else if (p.positionCount >= POSITION_SPREAD) {
        out.push({
          key: 'position',
          label: '补位型',
          value: `${p.positionCount} 个位置 / ${p.positioned} 场`,
          tip: `近 ${p.positioned} 场横跨 ${p.positionCount} 个位置，不要按固定分路预判他`,
          tone: 'info'
        });
      }
    }

    if (p.avgDeaths != null && p.deathGames >= MIN_GAMES) {
      const high = DEATH_HIGH[p.family] || DEATH_HIGH.other;
      if (p.avgDeaths >= high) {
        out.push({ key: 'deaths', label: '场均阵亡', value: String(p.avgDeaths), tip: `近 ${p.deathGames} 场场均阵亡 ${p.avgDeaths} 次，高于${p.family === 'aram' ? '大乱斗' : p.family === 'arena' ? '斗魂' : '同模式'}常见水平`, tone: 'warn' });
      } else if (p.avgDeaths <= DEATH_LOW) {
        out.push({ key: 'deaths', label: '少死', value: String(p.avgDeaths), tip: `近 ${p.deathGames} 场场均阵亡 ${p.avgDeaths} 次，比较稳`, tone: 'good' });
      }
    }

    if (p.fbTotal >= MIN_GAMES && p.fbShare >= FB_MIN_SHARE) {
      out.push({
        key: 'firstBlood',
        label: '一血',
        value: `${p.fbHit}/${p.fbTotal}`,
        tip: `近 ${p.fbTotal} 场有 ${p.fbHit} 场拿到一血，开局偏主动`,
        tone: 'good'
      });
    }

    if (p.games >= 12 && p.champCount >= POOL_WIDE) {
      out.push({
        key: 'pool',
        label: '英雄池',
        value: `${p.champCount} 个 / ${p.games} 场`,
        tip: `近 ${p.games} 场用了 ${p.champCount} 个不同英雄，池子很宽`,
        tone: 'info'
      });
    }

    return out;
  }

  // 卡片上最多两条: 位置 > 阵亡 > 一血 > 池宽 (habitItems 已按这个顺序排)
  function habitPills(profile, limit) {
    const max = Math.max(0, Number(limit) || 2);
    return habitItems(profile).slice(0, max);
  }

  return {
    MIN_GAMES,
    POSITION_LABELS,
    DEATH_HIGH,
    normalizePosition,
    modeFamilyOf,
    buildHabitProfile,
    habitItems,
    habitPills
  };
});
