// 对局指标计算 (纯函数, 无 DOM / 无 IO / 无定时器)
//
// 为什么单独成文件: 这些逻辑决定了"播报什么数字", 一旦算错就是给用户错误信息。
// 拆成纯函数后可以直接在 node 里跑断言, 不必开 Electron、不必真的打一局。
//
// 数据源: Live Client Data /liveclientdata/allgamedata 的 allPlayers[]
//   · items[] 自带 price / consumable / count —— 装备价值直接读, 不依赖 ddragon 表
//     (ddragon 表只作为老版本或特殊模式缺 price 时的回退)
//   · scores.creepScore —— 补刀
//   · position —— 可能为空串 (国服常见), 空则视为未知, 不做对位推断
//
// 原则: 拿不准就不输出。宁可少一条提示, 也不给一个错的数字。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  if (root) root.PoroMetrics = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // 补刀折金: 只用于双方相对比较, 不作为"经济"绝对值展示
  const CREEP_GOLD = 18;
  // 成装门槛: 传说装备最低 2200, 鞋子/多兰/药剂都在 1100 以下
  const FINISHED_ITEM_MIN_GOLD = 2000;
  // 10 分钟补刀基准 (按位置). jungle/utility 天然低, 用各自的基准, 不与线上位横向比
  const CREEP_BASE_10MIN = { top: 70, jungle: 45, mid: 75, bottom: 80, utility: 18, '': 65 };

  // Live Client Data 的 position 取值不统一 (大小写/别名都有), 统一成小写标准名
  function normalizePosition(raw) {
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!s) return '';
    if (s === 'top' || s === 'upper' || s === '上路') return 'top';
    if (s === 'jungle' || s === 'jungler' || s === '打野') return 'jungle';
    if (s === 'middle' || s === 'mid' || s === '中路') return 'mid';
    if (s === 'bottom' || s === 'bot' || s === 'adc' || s === '下路') return 'bottom';
    if (s === 'utility' || s === 'support' || s === '辅助') return 'utility';
    return '';
  }

  function positionLabel(pos) {
    const p = normalizePosition(pos);
    return { top: '上路', jungle: '打野', mid: '中路', bottom: '下路', utility: '辅助' }[p] || '';
  }

  // 单件装备单价: live data 的 price 优先, ddragon 表兜底
  function itemUnitPrice(item, prices) {
    if (item && typeof item === 'object') {
      const raw = Number(item.price);
      if (Number.isFinite(raw) && raw > 0) return raw;
    }
    const id = String(item && typeof item === 'object' ? (item.itemID ?? item.itemId ?? '') : (item ?? ''));
    if (!id) return 0;
    const fb = prices && typeof prices.get === 'function' ? prices.get(id) : undefined;
    return Number.isFinite(fb) ? fb : 0;
  }

  // 装备总价值. consumable=true (药剂/真眼) 不计入战力
  function itemsValue(p, prices) {
    let value = 0;
    const items = Array.isArray(p && p.items) ? p.items : [];
    for (const item of items) {
      if (item && typeof item === 'object' && item.consumable === true) continue;
      // itemID 为 0 表示空槽
      const id = item && typeof item === 'object' ? Number(item.itemID ?? item.itemId ?? 0) : Number(item);
      if (!id) continue;
      const count = Number(item && item.count) || 1;
      value += itemUnitPrice(item, prices) * (count > 0 ? count : 1);
    }
    return value;
  }

  // 成装件数: 只数单价达标的非消耗品, 一个 itemID 只算一次 (重复装备不影响"件数"语义)
  function finishedItemCount(p, prices, minGold) {
    const min = Number.isFinite(minGold) ? minGold : FINISHED_ITEM_MIN_GOLD;
    const seen = new Set();
    let count = 0;
    const items = Array.isArray(p && p.items) ? p.items : [];
    for (const item of items) {
      if (item && typeof item === 'object' && item.consumable === true) continue;
      const id = item && typeof item === 'object' ? Number(item.itemID ?? item.itemId ?? 0) : Number(item);
      if (!id || seen.has(id)) continue;
      if (itemUnitPrice(item, prices) >= min) { seen.add(id); count++; }
    }
    return count;
  }

  function creepScore(p) {
    const cs = Number(p && p.scores && p.scores.creepScore);
    return Number.isFinite(cs) && cs > 0 ? cs : 0;
  }

  // 单名玩家的可比"战力值" = 装备 + 补刀折金
  function playerValue(p, prices) {
    return itemsValue(p, prices) + creepScore(p) * CREEP_GOLD;
  }

  // 归一化队伍字段: live data 是 100/200, LCU session 可能是 ORDER/CHAOS
  function normTeam(t) {
    if (t == null || t === '') return 0;
    if (typeof t === 'number') return t === 100 || t === 200 ? t : 0;
    const s = String(t).trim().toUpperCase();
    if (s === 'ORDER' || s === '100' || s === 'BLUE') return 100;
    if (s === 'CHAOS' || s === '200' || s === 'RED') return 200;
    const n = Number(s);
    return n === 100 || n === 200 ? n : 0;
  }

  function playerName(p) {
    return String((p && (p.riotIdGameName || p.summonerName || p.riotId)) || '').trim();
  }

  // 找出"我": 名字大小写不敏感; 找不到再看 activePlayer 的 riotId
  function findSelf(players, gd) {
    const list = Array.isArray(players) ? players : [];
    const cands = [
      gd && gd.activePlayer && gd.activePlayer.summonerName,
      gd && gd.activePlayer && gd.activePlayer.riotIdGameName
    ].map(v => String(v || '').trim().toLowerCase()).filter(Boolean);
    if (!cands.length) return null;
    return list.find(p => {
      const names = [p && p.summonerName, p && p.riotIdGameName, p && p.riotId].map(v => String(v || '').trim().toLowerCase());
      return names.some(n => n && cands.includes(n));
    }) || null;
  }

  // 队伍拆分. myTeam 未知时返回 null —— 不知道谁是自己人就不要算
  function splitTeams(players, gd) {
    const list = Array.isArray(players) ? players : [];
    if (!list.length) return null;
    const self = findSelf(list, gd);
    const myTeam = self ? normTeam(self.team) : 0;
    if (!myTeam) return null;
    const ally = [], enemy = [], unknown = [];
    for (const p of list) {
      const t = normTeam(p && p.team);
      if (!t) unknown.push(p);
      else if (t === myTeam) ally.push(p);
      else enemy.push(p);
    }
    return { self, myTeam, ally, enemy, unknown };
  }

  // 双方战力汇总. leadPct > 0 表示我方领先 (占总量的百分比)
  function teamTotals(players, prices, gd) {
    const split = splitTeams(players, gd);
    if (!split || !split.ally.length || !split.enemy.length) return null;
    let allyValue = 0, enemyValue = 0;
    for (const p of split.ally) allyValue += playerValue(p, prices);
    for (const p of split.enemy) enemyValue += playerValue(p, prices);
    const total = allyValue + enemyValue;
    if (!(total > 0)) return null;
    const leadPct = Math.round((allyValue - enemyValue) / total * 100);
    return {
      myTeam: split.myTeam,
      allyValue: Math.round(allyValue),
      enemyValue: Math.round(enemyValue),
      leadPct,
      allyCount: split.ally.length,
      enemyCount: split.enemy.length
    };
  }

  // 敌方成装进度. 返回达到阈值的玩家, 由调用方按 key 去重 (同一人同一档只播一次)
  function detectSpikes(enemyPlayers, prices, thresholds, minGold) {
    const steps = Array.isArray(thresholds) && thresholds.length ? thresholds : [2, 3, 4];
    const out = [];
    for (const p of (Array.isArray(enemyPlayers) ? enemyPlayers : [])) {
      const count = finishedItemCount(p, prices, minGold);
      if (!count) continue;
      // 只取"本次刚好达到"的最高一档, 避免 2 件和 3 件同时刷两条
      let hit = 0;
      for (const s of steps) if (count >= s && s > hit) hit = s;
      if (!hit) continue;
      out.push({ key: playerKey(p) + ':' + hit, player: p, count, step: hit });
    }
    return out;
  }

  // 玩家稳定标识: 名字为主 (BOT 可能没有 puuid), 都缺时退到英雄名+队伍
  function playerKey(p) {
    const name = playerName(p).toLowerCase();
    if (name) return name;
    const puuid = String((p && p.puuid) || '').toLowerCase();
    if (puuid) return puuid;
    return 'champ:' + String((p && p.championName) || '') + ':' + normTeam(p && p.team);
  }

  // 对位匹配. 位置来源优先级: 玩家自带 position > 选人阶段缓存的位置表
  // 拿不到位置时返回 null —— 不猜, 猜错就是误导
  function findMatchup(players, gd, positionByName) {
    const split = splitTeams(players, gd);
    if (!split || !split.self) return null;
    const selfPos = normalizePosition(split.self.position)
      || normalizePosition(lookupPos(split.self, positionByName));
    if (!selfPos) return null;
    let opp = null;
    for (const p of split.enemy) {
      const pos = normalizePosition(p.position) || normalizePosition(lookupPos(p, positionByName));
      if (pos === selfPos) { opp = p; break; }
    }
    if (!opp) return null;
    return { self: split.self, opp, position: selfPos };
  }

  function lookupPos(p, table) {
    if (!table || typeof table !== 'object') return '';
    return table[playerKey(p)] || '';
  }

  // 10 分钟补刀对照: 返回 { cs, expected, diff, hit }
  // "是否到了 10 分钟"由调用方判断 (只有那时 cs 才等于十分钟补刀数)
  function creepMilestone(p, position) {
    const pos = normalizePosition(position || (p && p.position));
    const base = CREEP_BASE_10MIN[pos] ?? CREEP_BASE_10MIN[''];
    const cs = creepScore(p);
    return {
      cs,
      position: pos,
      expected: base,
      diff: cs - base,
      hit: cs >= base * 0.75
    };
  }

  // 经济数值展示: 1.2k / 12.3k, 避免浮窗里出现 6 位数挤爆布局
  function formatGold(n) {
    const v = Math.round(Number(n) || 0);
    if (Math.abs(v) < 1000) return String(v);
    return (v / 1000).toFixed(1) + 'k';
  }

  return {
    CREEP_GOLD,
    FINISHED_ITEM_MIN_GOLD,
    CREEP_BASE_10MIN,
    normalizePosition,
    positionLabel,
    itemUnitPrice,
    itemsValue,
    finishedItemCount,
    creepScore,
    playerValue,
    normTeam,
    playerName,
    playerKey,
    findSelf,
    splitTeams,
    teamTotals,
    detectSpikes,
    findMatchup,
    creepMilestone,
    formatGold
  };
});
