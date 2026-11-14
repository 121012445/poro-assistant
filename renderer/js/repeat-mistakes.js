// 重复失误：把"这一局做错的同一类事"数成跨局习惯 (纯函数 + 一个很薄的本机台账)
//
// 为什么这么做: 单局 AI 复盘每次说十条, 用户看完就忘; 真正能改变行为的是"同一件事你做了第 4 次"。
// 判定完全不依赖 AI —— 数字全在本地算, AI 只负责(可选)挑重点措辞, 避免幻觉。
//
// 数据来源: normalizeGame 的 norm (participants 里含 k/d/a/kp/dur/visionScore/cs/dmg/teamId),
// 不发任何新请求。只国服 SGP 有 teamsObj(目标物), LCU 路径没有就不出那一条。
//
// **按模式分流** (2026-11 用户反馈: 大乱斗里谈"带线/视野/补刀"是错的):
//   峡谷 rift      阵亡 / 资源 / 参团 / 视野 / 补刀
//   大乱斗 aram    阵亡 / 参团 / 伤害占比      (没有野区资源, 没有兵线, 视野几乎无意义)
//   海斗   mayhem  阵亡 / 参团 / 伤害占比
//   斗魂   arena   阵亡                        (轮次制, 不谈参团与补刀)
//   娱乐   fun     阵亡 / 参团
//   其他   unknown 阵亡                        (判定不了模式就只报最通用的一条)
// 阈值也按模式分开: 大乱斗一场普遍死得更多, 峡谷的 8 次门槛在那边等于误报。
//
// 口径 (与全项目一致: 拿不准就不输出):
//   · 时长 < 10 分钟的局不判定 (重开/挂机局);
//   · 每条都写清数字与分母, 不打分、不排名、不预测胜负;
//   · 台账只存 {gid, at, m, keys} —— 不含玩家名/PUUID, 60 局后滚动丢弃。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  if (root) root.PoroMistakes = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const STORE_KEY = 'repeatMistakes';
  const MAX_GAMES = 60;
  const WINDOW = 10;
  const HABIT_AT = 3;
  const CLEAN_GAMES = 3;
  const MIN_DURATION = 600;    // 10 分钟以下不判定

  // 模式分组: rules 决定这个模式允许哪些判定
  const MODES = {
    rift: { label: '峡谷', rules: ['deaths', 'objectives', 'kp', 'vision', 'cs'] },
    aram: { label: '大乱斗', rules: ['deaths', 'kp', 'dmg'] },
    mayhem: { label: '海斗', rules: ['deaths', 'kp', 'dmg'] },
    arena: { label: '斗魂', rules: ['deaths'] },
    fun: { label: '娱乐', rules: ['deaths', 'kp'] },
    unknown: { label: '其他', rules: ['deaths'] }
  };

  const RULES = {
    deaths: {
      label: '高阵亡',
      severity: 3,
      // 每个模式单独设阈值: 大乱斗节奏快、复活时间短, 一场 10 次阵亡很常见
      threshold: { rift: 8, aram: 12, mayhem: 12, arena: 10, fun: 11, unknown: 8 },
      tip: {
        rift: '阵亡偏多: 留意别在没有视野时单独带线',
        aram: '大乱斗一直在打团, 死这么多通常是站位太靠前、没等队友先手',
        mayhem: '海斗的强化差距会被死亡放大: 强化没成型时别硬开团',
        arena: '斗魂是轮次制, 早死直接丢一轮经济',
        fun: '娱乐模式也别一直送: 站位与退场时机是通用的',
        unknown: '阵亡偏多: 留意站位与进退时机'
      }
    },
    objectives: {
      label: '资源全丢',
      severity: 3,
      tip: { rift: '小龙/大龙被对面拿完, 打野与中下路的节奏断了' }
    },
    kp: {
      label: '参团偏低',
      severity: 2,
      tip: {
        rift: '团战参与少: 要么在带线, 要么节奏没跟上队友',
        aram: '大乱斗几乎一直在打团, 参团低说明你常在被抓或单独行动',
        mayhem: '海斗也是持续团战, 参团低说明你没跟上队伍节奏',
        fun: '团战参与少, 多半是在自己刷野/带线'
      }
    },
    vision: {
      label: '视野不足',
      severity: 2,
      tip: { rift: '视野得分很低, 关键区域等于瞎走' }
    },
    cs: {
      label: '补刀偏低',
      severity: 1,
      tip: { rift: '分均补刀偏低, 经济来源不足' }
    },
    dmg: {
      label: '伤害占比低',
      severity: 2,
      tip: {
        aram: '大乱斗是纯团战模式, 伤害占比这么低说明站位离团战太远或强化选偏了',
        mayhem: '海斗伤害占比过低, 多半是强化与出装没跟上这一局'
      }
    }
  };

  // 模式判定: 先看队列 ID (最准), 再看模式名 (中文/英文), 都认不出就 unknown
  function classifyMode(game) {
    const queueId = Number(game && game.queueId) || 0;
    const text = String((game && (game.mode || game.gameMode)) || '').toUpperCase();
    if (queueId === 2400 || /海克斯大乱斗|KIWI_JADE|MAYHEM/.test(text)) return 'mayhem';
    if (queueId === 450 || /极地大乱斗|ARAM|KIWI/.test(text)) return 'aram';
    if ([1700, 1710, 1750].includes(queueId) || /斗魂|CHERRY|SKIRMISH|ARENA/.test(text)) return 'arena';
    if ([900, 1020, 1300].includes(queueId) || /无限火力|克隆|极限闪击|URF|ONEFORALL|NEXUSBLITZ|JADE|飞升/.test(text)) return 'fun';
    if ([400, 420, 430, 440, 490].includes(queueId) || /召唤师峡谷|CLASSIC|排位|匹配|单双排|灵活组排|快速对局/.test(text)) return 'rift';
    return 'unknown';
  }

  function modeLabelOf(mode) { return (MODES[mode] || MODES.unknown).label; }
  function rulesOf(mode) { return (MODES[mode] || MODES.unknown).rules; }
  function tipOf(key, mode) {
    const rule = RULES[key] || {};
    return (rule.tip && (rule.tip[mode] || rule.tip.rift)) || '';
  }

  // 找出"我"这一局的关键失误 (最多 3 条), 全部带数字; 只报该模式成立的判定
  function detect(game, puuid, opts) {
    const out = [];
    if (!game || !puuid) return out;
    const list = Array.isArray(game.participants) ? game.participants : [];
    const me = list.find(p => p && p.puuid === puuid);
    if (!me) return out;
    const dur = Number(game.dur) || 0;
    const needDur = !(opts && opts.requireDuration === false);
    if (needDur && dur > 0 && dur < MIN_DURATION) return out;   // 重开/挂机局不判定

    const mode = classifyMode(game);
    const allowed = rulesOf(mode);
    const mates = list.filter(p => p && p.teamId === me.teamId);
    const teamKills = mates.reduce((s, p) => s + (Number(p.k) || 0), 0);
    const kp = teamKills ? (Number(me.k) + Number(me.a)) / teamKills : null;
    const teamDmg = mates.reduce((s, p) => s + (Number(p.dmg) || 0), 0);
    const dmgShare = teamDmg ? (Number(me.dmg) || 0) / teamDmg : null;
    const position = String(me.position || '').toUpperCase();

    const push = (key, evidence) => {
      if (!allowed.includes(key)) return;
      out.push({ key, label: RULES[key].label, evidence, severity: RULES[key].severity, mode, modeLabel: modeLabelOf(mode) });
    };

    // 1) 阵亡: 阈值随模式走
    const deathLimit = (RULES.deaths.threshold[mode] || 8);
    if (Number(me.d) >= deathLimit) {
      const most = Math.max(...list.map(p => Number(p.d) || 0));
      push('deaths', `阵亡 ${Number(me.d)} 次${most > Number(me.d) ? `（全场最多 ${most} 次）` : '（全场最多）'}`);
    }

    // 2) 视野: 只有峡谷有野区/眼位可言
    if (allowed.includes('vision') && dur >= MIN_DURATION && Number(me.visionScore) < 15) {
      const lowest = mates.every(p => (Number(p.visionScore) || 0) >= (Number(me.visionScore) || 0));
      push('vision', `视野得分 ${Number(me.visionScore) || 0}${lowest ? '（队内最低）' : ''}，时长 ${Math.round(dur / 60)} 分钟`);
    }

    // 3) 参团: 至少 8 个人头才有统计意义; 斗魂 2v2 不谈参团
    if (allowed.includes('kp') && kp != null && teamKills >= 8 && kp < 0.4 && dur >= MIN_DURATION) {
      push('kp', `参团率 ${Math.round(kp * 100)}%（全队 ${teamKills} 杀，你参与 ${Number(me.k) + Number(me.a)}）`);
    }

    // 4) 资源: 只有峡谷有小龙/大龙/先锋; 大乱斗与斗魂没有这套目标物
    const teams = game.teamsObj || null;
    if (allowed.includes('objectives') && teams && Object.keys(teams).length) {
      const mine = teams[me.teamId] || {};
      const foe = Object.entries(teams).find(([id]) => Number(id) !== Number(me.teamId));
      const foeObj = foe ? foe[1] : null;
      if (foeObj) {
        const countObj = o => (Number(o.dragon) || 0) + (Number(o.baron) || 0) + (Number(o.herald) || 0);
        const mineObj = countObj(mine);
        const foeObjN = countObj(foeObj);
        if (mineObj === 0 && foeObjN >= 3) push('objectives', `己方 0 条龙/大龙，对面 ${foeObjN} 条`);
      }
    }

    // 5) 补刀: 只有峡谷有对线期; 辅助不判
    if (allowed.includes('cs') && dur >= 900 && Number(me.cs) > 0 && position !== 'UTILITY') {
      const csm = Number(me.cs) / (dur / 60);
      if (csm < 4) push('cs', `分均补刀 ${Math.round(csm * 10) / 10}（${Number(me.cs)} 刀 / ${Math.round(dur / 60)} 分钟）`);
    }

    // 6) 伤害占比: 团战模式 (大乱斗/海斗) 用这个替代"视野/补刀"; 辅助与坦克不判
    if (allowed.includes('dmg') && dmgShare != null && dur >= MIN_DURATION
        && position !== 'UTILITY' && Number(me.dmg) > 0) {
      const share = Math.round(dmgShare * 100);
      const isTank = Number(me.dmgTaken) > 0 && Number(me.dmgTaken) > Number(me.dmg) * 1.6;
      if (share < 10 && !isTank) push('dmg', `伤害占比 ${share}%（全队 ${Math.round(teamDmg / 1000)}k 输出）`);
    }

    out.sort((a, b) => b.severity - a.severity);
    return out.slice(0, 3);
  }

  // 一局记录一条: { gid, at, m, keys }。按时间倒序存放 —— 调用方 (首页) 是按新→旧遍历的,
  // 不能依赖插入顺序, 否则"近 10 局"会变成"最早 10 局"。
  function mergeLedger(ledger, gid, keys, at, max, mode) {
    const list = Array.isArray(ledger) ? ledger.filter(e => e && e.gid) : [];
    const id = String(gid || '');
    if (!id) return list;
    const rest = list.filter(e => String(e.gid) !== id);
    rest.push({
      gid: id,
      at: Number(at) || Date.now(),
      m: mode || 'unknown',
      keys: Array.isArray(keys) ? [...new Set(keys)] : []
    });
    rest.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
    return rest.slice(0, Math.max(1, Number(max) || MAX_GAMES));
  }

  // 跨局汇总。opts.mode 给定时只统计同一模式 (赛后"第 N 次"必须同模式才算数:
  // 峡谷死 8 次和海斗死 12 次不是同一件事)。
  function summarize(ledger, opts) {
    const only = opts && opts.mode ? String(opts.mode) : '';
    const list = (Array.isArray(ledger) ? ledger : [])
      .filter(e => e && e.gid)
      .filter(e => !only || String(e.m || 'unknown') === only)
      .slice(0, MAX_GAMES);
    const recent = list.slice(0, WINDOW);
    const older = list.slice(WINDOW);

    const count = arr => {
      const map = new Map();       // `${mode}:${key}` -> n
      for (const e of arr) {
        const mode = String(e.m || 'unknown');
        for (const k of (e.keys || [])) {
          const id = mode + ':' + k;
          map.set(id, (map.get(id) || 0) + 1);
        }
      }
      return map;
    };
    const recentCount = count(recent);
    const olderCount = count(older);

    const rows = [];
    for (const [id, n] of recentCount) {
      const [mode, key] = id.split(':');
      if (!RULES[key]) continue;
      const past = olderCount.get(id) || 0;
      const status = n >= HABIT_AT ? 'habit' : 'watch';
      rows.push({
        key, mode, modeLabel: modeLabelOf(mode), label: RULES[key].label, tip: tipOf(key, mode),
        count: n, window: recent.length, past, status,
        lastAt: (list.find(e => String(e.m || 'unknown') === mode && (e.keys || []).includes(key)) || {}).at || 0
      });
    }
    // 曾经是习惯、最近窗口里没再出现 -> 已改掉
    for (const [id, past] of olderCount) {
      if (recentCount.has(id) || past < HABIT_AT) continue;
      const [mode, key] = id.split(':');
      if (!RULES[key]) continue;
      rows.push({
        key, mode, modeLabel: modeLabelOf(mode), label: RULES[key].label, tip: tipOf(key, mode),
        count: 0, window: recent.length, past, status: 'fixed',
        lastAt: (list.find(e => String(e.m || 'unknown') === mode && (e.keys || []).includes(key)) || {}).at || 0
      });
    }
    const order = { habit: 0, watch: 1, fixed: 2 };
    rows.sort((a, b) => (order[a.status] - order[b.status]) || (b.count - a.count) || a.mode.localeCompare(b.mode));
    return rows;
  }

  function primaryOf(mistakes) {
    return Array.isArray(mistakes) && mistakes.length ? mistakes[0] : null;
  }

  // 本机台账 (storeGet/storeSet 来自 persist.js; Node 单测里不存在则退化为内存)
  let memoryLedger = [];
  function readLedger() {
    try {
      if (typeof storeGet === 'function') {
        const raw = storeGet(STORE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      }
    } catch (e) { /* 坏数据当空 */ }
    return memoryLedger;
  }
  function writeLedger(rows) {
    memoryLedger = rows;
    try { if (typeof storeSet === 'function') storeSet(STORE_KEY, JSON.stringify(rows)); } catch (e) {}
  }

  // 批量记账 (首页每次加载战绩后调用): 只记自己的局, 已记过的 gid 覆盖但不重复计数
  function recordGames(games, puuid) {
    if (!puuid || !Array.isArray(games) || !games.length) return { added: 0, rows: readLedger() };
    let rows = readLedger();
    let added = 0;
    for (const g of games) {
      if (!g) continue;
      const gid = g.gid || g.gameId || 0;
      if (!gid) continue;
      const found = detect(g, puuid);
      if (!found.length) continue;
      const next = mergeLedger(rows, gid, found.map(x => x.key), Number(g.time) || Date.now(), MAX_GAMES, found[0].mode);
      const prevTop = rows[0];
      if (!prevTop || String(prevTop.gid) !== String(gid) || (prevTop.keys || []).join() !== (next[0].keys || []).join()) added++;
      rows = next;
    }
    writeLedger(rows);
    return { added, rows };
  }

  return {
    STORE_KEY, MAX_GAMES, WINDOW, HABIT_AT, CLEAN_GAMES, MIN_DURATION, MODES, RULES,
    classifyMode, modeLabelOf, rulesOf, tipOf,
    detect, mergeLedger, summarize, primaryOf, readLedger, writeLedger, recordGames
  };
});
