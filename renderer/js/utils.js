'use strict';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[ch]);
}

// 兼容尚未迁移的内联事件；参数先 JSON 编码，再做 HTML 属性编码。
function inlineArg(value) {
  return escapeHtml(JSON.stringify(String(value ?? '')));
}

// Map 超过 max 条时删掉最早写入的 (Map 保持插入顺序)。用于按玩家累积、长时间运行会一直增长的缓存。
function limitMapSize(map, max) {
  if (!map || typeof map.size !== 'number' || !(max >= 0)) return 0;
  let removed = 0;
  for (const key of map.keys()) {
    if (map.size <= max) break;
    map.delete(key);
    removed++;
  }
  return removed;
}

async function mapWithConcurrency(items, limit, mapper) {
  const list = Array.from(items || []);
  const results = new Array(list.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const index = cursor++;
      results[index] = await mapper(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), list.length) }, worker));
  return results;
}

// 从近期对局的同队关系图中推断当前阵容的预组队分组。
function inferPremadeGroups(players, profiles, threshold = 3) {
  const result = {};
  let nextGroup = 1;
  for (const team of [100, 200]) {
    const roster = players.filter(p => p.team === team && p.puuid).map(p => p.puuid);
    if (roster.length < 2) continue;
    const rosterSet = new Set(roster);
    const pairGames = new Map();
    for (const profile of profiles) {
      for (const game of (profile?.teamGames || [])) {
        const members = [...new Set(game.players.filter(puuid => rosterSet.has(puuid)))];
        for (let i = 0; i < members.length - 1; i++) {
          for (let j = i + 1; j < members.length; j++) {
            const pair = [members[i], members[j]].sort();
            const key = pair.join('|');
            if (!pairGames.has(key)) pairGames.set(key, new Set());
            pairGames.get(key).add(game.id);
          }
        }
      }
    }
    const adjacency = new Map(roster.map(puuid => [puuid, new Set()]));
    for (const [pair, gameIds] of pairGames) {
      if (gameIds.size < threshold) continue;
      const [a, b] = pair.split('|');
      adjacency.get(a)?.add(b);
      adjacency.get(b)?.add(a);
    }
    const visited = new Set();
    for (const start of roster) {
      if (visited.has(start) || !adjacency.get(start)?.size) continue;
      const stack = [start], component = [];
      visited.add(start);
      while (stack.length) {
        const current = stack.pop();
        component.push(current);
        for (const neighbor of adjacency.get(current) || []) {
          if (!visited.has(neighbor)) { visited.add(neighbor); stack.push(neighbor); }
        }
      }
      if (component.length >= 2) {
        for (const puuid of component) result[puuid] = nextGroup;
        nextGroup++;
      }
    }
  }
  return result;
}

// 战绩详情的组队关系：优先采用对局数据自带的 party 标识；缺失时再用
// 近期共同对局推断。返回每名玩家的来源，界面必须把推断结果明确标注为“推测”。
function resolveMatchPremadeGroups(players, profiles = [], threshold = 3) {
  const list = Array.isArray(players) ? players : [];
  const groups = {};
  const sources = {};
  let nextGroup = 1;
  const invalidPartyIds = new Set(['', '0', '-1', 'none', 'null', 'undefined', 'unknown']);

  for (const team of [100, 200]) {
    const buckets = new Map();
    for (const player of list) {
      if ((+player.teamId || +player.team) !== team || !player.puuid) continue;
      const raw = player.partyId ?? player.premadeId ?? player.partyIdHash ?? player.playerPartyId ?? '';
      const partyId = String(raw).trim();
      if (invalidPartyIds.has(partyId.toLowerCase())) continue;
      if (!buckets.has(partyId)) buckets.set(partyId, []);
      buckets.get(partyId).push(player.puuid);
    }
    for (const members of buckets.values()) {
      const unique = [...new Set(members)];
      if (unique.length < 2) continue;
      for (const puuid of unique) {
        groups[puuid] = nextGroup;
        sources[puuid] = 'official';
      }
      nextGroup++;
    }
  }

  const inferred = inferPremadeGroups(
    list.map(player => ({ puuid: player.puuid, team: +player.teamId || +player.team })),
    profiles,
    threshold
  );
  const inferredComponents = new Map();
  for (const [puuid, groupId] of Object.entries(inferred)) {
    if (!inferredComponents.has(groupId)) inferredComponents.set(groupId, []);
    inferredComponents.get(groupId).push(puuid);
  }
  for (const members of inferredComponents.values()) {
    // 官方组员不再被推断结果重新编号；与官方组重叠的连通分量整体跳过，
    // 避免一个玩家同时显示两个互相矛盾的组队关系。
    if (members.some(puuid => groups[puuid])) continue;
    if (members.length < 2) continue;
    for (const puuid of members) {
      groups[puuid] = nextGroup;
      sources[puuid] = 'inferred';
    }
    nextGroup++;
  }

  return {
    groups,
    sources,
    officialCount: Object.values(sources).filter(source => source === 'official').length,
    inferredCount: Object.values(sources).filter(source => source === 'inferred').length,
    threshold
  };
}

// 将单局数据转成简短、可解释的表现标签。相对队内均值判断可兼容
// 不同模式和对局时长；辅助位或高治疗贡献玩家不会被简单标记为输出乏力。
// 2026-11-20: 旧代码用 `position === 'SUPPORT'` 判辅助, 但 LCU/SGP 的分路枚举是
// UTILITY (live.js 也把 SUPPORT 归一成 UTILITY), 于是整个辅助位从来没被识别出来 ——
// 2/2/27 的辅助照样吃到「输出乏力 / 伤转偏低」。现在两种写法都认, 并把视野/排眼/
// 控制/保护类标签排在输出类之前, 输出类指标对辅助只作兜底。
function derivePerformanceTags(p, myTeam, kp, dmgShare, minutes = 0, mode = '') {
  const player = p || {};
  const team = Array.isArray(myTeam) ? myTeam.filter(Boolean) : [];
  const aramMode = /极地大乱斗|海克斯大乱斗|ARAM|KIWI|MAYHEM/i.test(String(mode || ''));
  const tags = [];
  const add = (label, tone, tip) => {
    if (!tags.some(tag => tag.label === label)) tags.push({ label, tone, tip });
  };
  const n = Math.max(1, team.length);
  const kda = ((+player.k || 0) + (+player.a || 0)) / Math.max(1, +player.d || 0);
  const share = Math.max(0, +dmgShare || 0);
  const participation = Math.max(0, +kp || 0);
  const mins = Math.max(0, +minutes || 0);
  const perMin = value => (mins > 0 ? value / mins : 0);

  if (player.win) {
    if ((+player.d || 0) === 0 && ((+player.k || 0) + (+player.a || 0)) >= 5) add('完美发挥', 'positive', '零阵亡并参与至少 5 次击杀');
    else if (kda >= 7 && (participation >= 65 || share >= 25)) add('势不可挡', 'positive', `KDA ${kda.toFixed(1)}，参团 ${participation}%`);
    else if (kda >= 4.5 && (participation >= 60 || share >= 24)) add('Carry', 'positive', `KDA ${kda.toFixed(1)}，伤害占比 ${share}%`);
    else if ((+player.k || 0) >= 8 && (+player.d || 0) >= 8) add('过山车', 'warning', '击杀和阵亡都较高，战局起伏明显');
    else add('稳健发挥', 'accent', `获胜，KDA ${kda.toFixed(1)}`);
  } else {
    if (kda >= 3.5 && (participation >= 60 || share >= 27)) add('尽力局', 'accent', `败方高贡献：KDA ${kda.toFixed(1)}，参团 ${participation}%`);
    else if ((+player.k || 0) >= 8 && (+player.d || 0) >= 8) add('过山车', 'warning', '击杀和阵亡都较高，战局起伏明显');
    else if ((+player.d || 0) >= 9 && kda < 1.2) add('承压局', 'muted', `承受较大压力，阵亡 ${+player.d || 0} 次`);
    else if (kda >= 2.2 || participation >= 55) add('不走运', 'muted', `有一定贡献但未能取胜，参团 ${participation}%`);
    else add('有待调整', 'muted', `本场 KDA ${kda.toFixed(1)}`);
  }

  if (!team.length) return tags.slice(0, 3);
  const sum = (key) => team.reduce((total, item) => total + Math.max(0, +item?.[key] || 0), 0);
  const avgDamage = sum('dmg') / n;
  const avgTaken = sum('dmgTaken') / n;
  const teamTaken = sum('dmgTaken');
  const takenShare = teamTaken ? Math.round((+player.dmgTaken || 0) / teamTaken * 100) : 0;
  const healingValue = item => {
    const teamUtility = Math.max(0, +item?.allyHeal || 0) + Math.max(0, +item?.shielding || 0);
    return teamUtility > 0 ? teamUtility : Math.max(0, +item?.healing || 0);
  };
  const healValues = team.map(healingValue);
  const myHealing = healingValue(player);
  const avgHealing = healValues.reduce((total, value) => total + value, 0) / n;
  const healingStrong = myHealing > 0
    && myHealing === Math.max(...healValues)
    && myHealing >= Math.max(2500, avgHealing * 1.35);
  const pos = String(player.position || player.teamPosition || player.individualPosition || '').toUpperCase();
  const isSupport = pos === 'UTILITY' || pos === 'SUPPORT';
  // 两桶候选: 视野/控制/保护 与 输出/伤转/承伤。最后按位置决定谁先占位 ——
  // 辅助先吃保护视野类, 其它位置先吃输出类, 都不会被对方的指标挤掉。
  const utility = [];
  const output = [];
  const push = (bucket, label, tone, tip) => {
    if (!bucket.some(tag => tag.label === label)) bucket.push({ label, tone, tip });
  };

  if (healingStrong) push(utility, '治疗给力', 'healing', `队内治疗/护盾最高：${Math.round(myHealing).toLocaleString()}`);

  const ownDmg = Math.max(0, +player.dmg || 0);
  const ownGold = Math.max(0, +player.gold || 0);
  const maxDamage = Math.max(...team.map(item => +item.dmg || 0));
  const maxVision = Math.max(...team.map(item => +item.visionScore || 0));
  const avgVision = sum('visionScore') / n;
  const vision = Math.max(0, +player.visionScore || 0);
  if (!aramMode) {
    if (vision === maxVision && vision >= Math.max(20, avgVision * 1.25)) {
      push(utility, '视野掌控', 'vision', `全队视野得分最高：${vision}`);
    } else if (isSupport && vision >= 25 && perMin(vision) >= 1.6) {
      // 不是全队第一但密度够 (>=1.6/分, 正常辅助水准), 也给一条, 别让视野贡献隐身
      push(utility, '视野扎实', 'vision', `视野得分 ${vision}，约 ${perMin(vision).toFixed(1)}/分钟`);
    }
    const wardsKilled = Math.max(0, +player.wardsKilled || 0);
    const maxWardsKilled = Math.max(...team.map(item => +item.wardsKilled || 0));
    // 视野掌控已经代表视野压制了, 再叠一条排眼等于占两个格子; 只在没有视野标签时
    // 才用排眼补位 —— 那种情况通常是"眼不多但反得多"的游走型辅助。
    if (!utility.some(tag => tag.tone === 'vision')
        && wardsKilled === maxWardsKilled && wardsKilled >= Math.max(5, mins * 0.3)) {
      push(utility, '排眼积极', 'vision', `排掉 ${wardsKilled} 个守卫，全队最多`);
    }
  }
  // 控制时长 (timeCCingOthers): SGP 摘要与大乱斗都有真实值, 不按模式屏蔽。
  // 只给"队内最长且每分钟 >= 1.8 秒"的人, 否则控制型英雄人人都是控制拉满。
  const ccTime = Math.max(0, +player.ccTime || 0);
  const maxCc = Math.max(...team.map(item => +item.ccTime || 0));
  if (ccTime > 0 && ccTime === maxCc && perMin(ccTime) >= 1.8) {
    push(utility, '控制拉满', 'accent', `控制时长 ${Math.round(ccTime)} 秒，全队最长`);
  }
  // 开团型辅助 (硬辅) 的另一个主要贡献是承伤: 分摊到全队 22% 以上才给,
  // 队均 20%, 低于这条线的辅助通常是真的没上前排。
  if (isSupport && mins >= 10 && takenShare >= 22) {
    push(utility, '前排承伤', 'team', `承伤占全队 ${takenShare}%，顶在最前面`);
  }

  if (ownDmg === maxDamage && share >= 25) {
    push(output, '输出核心', 'damage', `全队伤害最高，占比 ${share}%`);
  } else if (mins >= 10 && !isSupport && !healingStrong && share <= 12 && ownDmg <= avgDamage * 0.65) {
    push(output, '输出乏力', 'low', `伤害占比 ${share}%，低于队内平均`);
  }

  // 辅助在团战里本来就分摊得少, 阈值收到 6% 才提示, 免得正常辅助白吃一条"偏低"
  const takenLimit = isSupport ? 6 : 11;
  const takenRatio = isSupport ? 0.5 : 0.65;
  if (mins >= 10 && takenShare <= takenLimit && (+player.dmgTaken || 0) <= avgTaken * takenRatio) {
    push(output, '承伤偏少', 'low', `承伤占比 ${takenShare}%；仅描述本局分摊，不代表负面评价`);
  }

  const ownGoldRate = ownGold > 0 ? ownDmg / ownGold * 100 : 0;
  const teamGoldRates = team
    .filter(item => (+item.gold || 0) >= 1000)
    .map(item => (+item.dmg || 0) / Math.max(1, +item.gold || 0) * 100);
  const avgGoldRate = teamGoldRates.length
    ? teamGoldRates.reduce((total, value) => total + value, 0) / teamGoldRates.length
    : 0;
  if (mins >= 10 && ownGold >= 3000 && avgGoldRate > 0
      && ownGoldRate >= avgGoldRate * 1.3 && share >= 20) {
    push(output, '伤转高', 'efficiency', `伤害转化 ${Math.round(ownGoldRate)}%，显著高于队内平均`);
  } else if (mins >= 10 && !isSupport && !healingStrong && ownGold >= 3000
      && avgGoldRate > 0 && ownGoldRate <= avgGoldRate * 0.72 && share <= 16) {
    push(output, '伤转偏低', 'low', `伤害转化 ${Math.round(ownGoldRate)}%，低于队内平均`);
  }

  if (participation >= 75) push(utility, '团队核心', 'team', `击杀参与率 ${participation}%`);

  // 辅助侧的展示优先级: 视野 > 控制 > 承伤 > 排眼 > 治疗 > 团队。谁更"辅助"谁先占位,
  // 避免治疗给力把控制/视野挤掉 (用户诉求就是这两类要能看见)。
  const UTILITY_ORDER = ['视野掌控', '视野扎实', '控制拉满', '排眼积极', '前排承伤', '治疗给力', '团队核心'];
  utility.sort((a, b) => UTILITY_ORDER.indexOf(a.label) - UTILITY_ORDER.indexOf(b.label));

  const ordered = isSupport ? utility.concat(output) : output.concat(utility);
  // 辅助的多维贡献 (视野+控制+保护) 一屏放得下 4 条, 输出位维持 3 条不变
  const limit = isSupport ? 4 : 3;
  for (const tag of ordered) {
    if (tags.length >= limit) break;
    add(tag.label, tag.tone, tag.tip);
  }
  return tags.slice(0, limit);
}

// ========== 对局评分 (1.6.23: 按位置归一化) ==========
// 旧公式 k + a*0.7 - d*0.5 + dmg/4000 + gold/6000 完全偏向输出位:
// 辅助把视野/参团/保护拉满也几乎不可能成为队内第一 (国服样本实测 0%)。
// 现在每一项先除以"该位置的典型值"再乘权重 —— 各位置正常发挥都约等于同一分数,
// 跨位置比较才公平; 位置缺失 (低段位/部分模式不分配位置) 时用全场平均基线,
// 相当于退回"大家都用同一把尺"的老行为, 不会因缺字段崩掉。
const CHAMPION_RATING_BASELINE = {
  TOP:     { k: 5.5, a: 6.5,  d: 5.0, dmg: 19000, gold: 11000, vision: 22, taken: 24000, gain: 500,  kp: 0.55 },
  JUNGLE:  { k: 6.0, a: 9.0,  d: 4.8, dmg: 16000, gold: 11000, vision: 26, taken: 22000, gain: 800,  kp: 0.62 },
  MIDDLE:  { k: 6.5, a: 7.0,  d: 5.0, dmg: 23000, gold: 12000, vision: 26, taken: 18000, gain: 700,  kp: 0.60 },
  BOTTOM:  { k: 7.5, a: 6.5,  d: 4.8, dmg: 25000, gold: 12500, vision: 24, taken: 16000, gain: 600,  kp: 0.60 },
  UTILITY: { k: 2.5, a: 15.0, d: 5.5, dmg: 8000,  gold: 7500,  vision: 55, taken: 17000, gain: 6000, kp: 0.65 },
  DEFAULT: { k: 6.0, a: 8.0,  d: 5.0, dmg: 20000, gold: 11500, vision: 27, taken: 21000, gain: 2500, kp: 0.60 }
};
function championRatingNum(...vals) {
  for (const v of vals) if (v != null && Number.isFinite(Number(v))) return Number(v);
  return 0;
}
// 兼容两种入参: normalizeGame 压平后的 (k/d/a/dmg/gold/dmgTaken/allyHeal/shielding)
// 与 SGP 原始结构 (kills/deaths/assists/totalDamageDealtToChampions/goldEarned/…)。
// mates 传同队参与者数组, 用来算参团率; 不传就只按个人数据算。
function championRatingOf(p, mates) {
  if (!p) return 0;
  const s = (p.stats && typeof p.stats === 'object') ? p.stats : p;
  const k = championRatingNum(s.kills, p.kills, p.k);
  const d = championRatingNum(s.deaths, p.deaths, p.d);
  const a = championRatingNum(s.assists, p.assists, p.a);
  const dmg = championRatingNum(s.totalDamageDealtToChampions, p.totalDamageDealtToChampions, p.dmg);
  const gold = championRatingNum(s.goldEarned, p.goldEarned, p.gold);
  const vis = championRatingNum(s.visionScore, p.visionScore);
  const taken = championRatingNum(s.totalDamageTaken, p.totalDamageTaken, p.dmgTaken);
  // 团队增益只看"给到队友的": 队友治疗 + 护盾。自身回复不参与, 否则吸血装备会虚高。
  const gain = championRatingNum(s.totalHealsOnTeammates, p.allyHeal)
    + championRatingNum(s.totalDamageShieldedOnTeammates, p.shielding);
  const team = Array.isArray(mates) && mates.length ? mates : [p];
  const teamKills = team.reduce((n, x) => n + championRatingNum((x.stats || x).kills, x.kills, x.k), 0);
  const kp = teamKills > 0 ? (k + a) / teamKills : 0;
  // 位置字段三种来源: normalizeGame 的 p.position / SGP 原始的 teamPosition|individualPosition
  const pos = String(p.position || p.teamPosition || p.individualPosition || '').toUpperCase();
  const b = CHAMPION_RATING_BASELINE[pos] || CHAMPION_RATING_BASELINE.DEFAULT;
  // 每项先除以基线, 再夹到 [0, 2.5] (死亡到 4): 防止单个异常值(比如带治疗装刷出的
  // 超高团队治疗、超长局的补刀)把整行分数带跑偏 —— 评分要看全面, 不能被一项绑架。
  const ratio = (v, base) => {
    const r = base > 0 ? (Number(v) || 0) / base : 0;
    return Math.max(0, Math.min(2.5, r));
  };
  return ratio(k, b.k) * 1.0
    + ratio(a, b.a) * 1.2
    - Math.min(4, (Number(d) || 0) / b.d) * 1.0
    + ratio(dmg, b.dmg) * 1.2
    + ratio(gold, b.gold) * 0.8
    + ratio(vis, b.vision) * 0.6
    + ratio(taken, b.taken) * 0.4
    + ratio(gain, b.gain) * 0.4
    + ratio(kp, b.kp) * 0.6;
}

// ========== 符文页文字 (1.6.23) ==========
// 对局详情只有 12px 图标, 认不出是哪个符文; 完整名称放进 title。
// 名称表来自 app.js 的 loadPerkIcons (ddragon runesReforged), 取不到就退回 #id。
const STAT_PERK_NAMES = {
  5001: '生命值成长', 5002: '护甲', 5003: '魔法抗性', 5005: '攻击速度',
  5007: '技能急速', 5008: '自适应之力', 5011: '生命值', 5013: '韧性'
};
function runeNameOf(id) {
  try { if (typeof perkNameMap !== 'undefined' && perkNameMap && perkNameMap[id]) return perkNameMap[id]; } catch (e) { /* TDZ / 未加载 */ }
  return '#' + id;
}
function runeStyleNameOf(id) {
  try { if (typeof styleNameMap !== 'undefined' && styleNameMap && styleNameMap[id]) return styleNameMap[id]; } catch (e) { /* TDZ / 未加载 */ }
  return '';
}
// 返回 "精密：征服者 / 凯旋 / 传说：欢欣 / 致命一击 · 副系 坚决：坚定 / 骸骨镀层 · 属性 攻击速度 / 自适应之力 / 护甲"
// 没有 perkIds 的老缓存返回 '' (调用方不给 title, 不显示半截信息)。
function runePageText(p) {
  const ids = (p && Array.isArray(p.perkIds)) ? p.perkIds.filter(x => Number(x) > 0) : [];
  if (!ids.length) return '';
  const styles = (p && Array.isArray(p.perkStyles)) ? p.perkStyles : [];
  const main = ids.slice(0, 4);
  const sub = ids.slice(4, 6);
  const mainStyle = runeStyleNameOf(styles[0]);
  const subStyle = runeStyleNameOf(styles[1]);
  const parts = [];
  parts.push((mainStyle ? mainStyle + '：' : '主系：') + main.map(runeNameOf).join(' / '));
  if (sub.length) parts.push((subStyle ? '副系 ' + subStyle + '：' : '副系：') + sub.map(runeNameOf).join(' / '));
  const stats = (p && Array.isArray(p.statPerks)) ? p.statPerks : [];
  if (stats.length) parts.push('属性 ' + stats.map(id => STAT_PERK_NAMES[id] || ('#' + id)).join(' / '));
  return parts.join(' · ');
}

// ========== 符文详情卡片 (1.6.24, 参照 LeagueAkari 的 PerkDisplay/RunesTab) ==========
// Akari 的符文页是三层的: 图标 + 名称 + "本局结算"那句话 (endOfGameStatDescs 里的
// @eogvar1@ 用 selection.var1 替换, 例如"总治疗量: 1,234"), 而不是只给一个图标网格。
//
// 名称和描述只有客户端自己那份 perks.json 是中文 —— ddragon 的 runesReforged 只有
// 名称和图标, 一句描述都没有; communitydragon 的 zh_cn 目录里 perks.json 实测没本地化
// (name/longDesc 全是英文)。所以以 LCU 为主源, 拉不到就退到"中文名 + 图标", 描述留空,
// 不编造英文文案糊在中文界面上。
const STAT_PERK_ICONS = {
  5001: 'StatModsHealthScalingIcon', 5002: 'StatModsArmorIcon', 5003: 'StatModsMagicResIcon',
  5005: 'StatModsAttackSpeedIcon', 5007: 'StatModsCDRScalingIcon', 5008: 'StatModsAdaptiveForceIcon',
  5010: 'StatModsMovementSpeedIcon', 5011: 'StatModsHealthIcon', 5013: 'StatModsTenacityIcon'
};
const STAT_PERK_FALLBACK_NAME = { 5001: '生命值成长', 5003: '魔法抗性', 5007: '技能急速', 5010: '移动速度' };
const RUNE_META = { perks: {}, styles: {}, ready: false };
const RUNE_META_CACHE_KEY = 'poro.runeMeta.v1';

// 客户端 longDesc/shortDesc 里混着 <lol-uikit-tooltipped-keyword> 之类的界面标签,
// 直接塞进浮层会变成一行行尖括号。这里只去标签、保留文字和数字。
function stripLolTags(html) {
  if (typeof html !== 'string' || !html) return '';
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadRuneMeta() {
  try {
    const cached = localStorage.getItem(RUNE_META_CACHE_KEY);
    if (cached) {
      const o = JSON.parse(cached);
      RUNE_META.perks = (o && o.perks) || {};
      RUNE_META.styles = (o && o.styles) || {};
      RUNE_META.ready = Object.keys(RUNE_META.perks).length > 0;
    }
  } catch (e) { /* 缓存损坏就走网络 */ }

  try {
    const api = (typeof window !== 'undefined' && window.lolAPI) ? window.lolAPI : null;
    if (!api || typeof api.lcuRequest !== 'function') return false;
    const [rawPerks, rawStyles] = await Promise.all([
      api.lcuRequest('GET', '/lol-game-data/assets/v1/perks.json'),
      api.lcuRequest('GET', '/lol-game-data/assets/v1/perkstyles.json')
    ]);
    const perkList = Array.isArray(rawPerks) ? rawPerks : (rawPerks && Array.isArray(rawPerks.perks) ? rawPerks.perks : null);
    if (!perkList || !perkList.length) return false;
    const perks = {};
    for (const item of perkList) {
      const id = Number(item && item.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const eog = Array.isArray(item.endOfGameStatDescs) ? item.endOfGameStatDescs.map(stripLolTags).filter(Boolean) : [];
      perks[id] = {
        name: stripLolTags(item.name || ''),
        desc: stripLolTags(item.shortDesc || '') || stripLolTags(item.longDesc || ''),
        eog
      };
    }
    const styles = {};
    const styleList = rawStyles && Array.isArray(rawStyles.styles) ? rawStyles.styles : (Array.isArray(rawStyles) ? rawStyles : []);
    for (const st of styleList) {
      const id = Number(st && st.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      styles[id] = { name: stripLolTags(st.name || ''), tip: stripLolTags(st.tooltip || '') };
    }
    if (!Object.keys(perks).length) return false;
    RUNE_META.perks = perks;
    RUNE_META.styles = styles;
    RUNE_META.ready = true;
    try { localStorage.setItem(RUNE_META_CACHE_KEY, JSON.stringify({ perks, styles })); } catch (e) { /* 配额满不影响使用 */ }
    return true;
  } catch (e) {
    return false;
  }
}

function runeMetaName(id) {
  const m = RUNE_META.perks[id];
  return (m && m.name) || (STAT_PERK_FALLBACK_NAME[id] || '') || runeNameOf(id);
}
function runeStyleMetaName(id) {
  const m = RUNE_META.styles[id];
  return (m && m.name) || runeStyleNameOf(id) || '';
}
function runeIconUrl(id) {
  try {
    const p = (typeof perkIconMap !== 'undefined' && perkIconMap) ? perkIconMap[id] : null;
    if (p) return `https://ddragon.leagueoflegends.com/cdn/img/${p}`;
  } catch (e) { /* TDZ */ }
  return '';
}
function statPerkIconUrl(id) {
  const name = STAT_PERK_ICONS[id];
  return name ? `https://ddragon.leagueoflegends.com/cdn/img/perk-images/StatMods/${name}.png` : '';
}
function statPerkName(id) {
  return STAT_PERK_NAMES[id] || STAT_PERK_FALLBACK_NAME[id] || ('属性 ' + id);
}
// 本局结算文案: 客户端给的是模板 (含 @eogvar1@), 数值来自该局的 selection.var1..3。
// 没有 EOG 模板的符文退回一句话描述 —— 两者都没有就返回 '', 卡片只显示名称。
function runeDescOf(perkId, sel) {
  const meta = RUNE_META.perks[perkId];
  if (!meta) return '';
  const vals = [sel && sel.v1, sel && sel.v2, sel && sel.v3];
  const hasAny = vals.some(v => v != null && Number.isFinite(Number(v)));
  // 老缓存战绩行没有 var1..3: 没有"本局"可言, 显示通用描述比一排"—"有用
  if (!hasAny) return meta.desc || '';
  const out = [];
  for (const tpl of (meta.eog || [])) {
    const text = tpl.replace(/@eogvar(\d+)@/gi, (whole, n) => {
      const v = vals[Number(n) - 1];
      if (v == null || !Number.isFinite(Number(v))) return '—';
      return Number(v).toLocaleString('en-US');
    });
    if (text) out.push(text);
  }
  if (out.length) return out.join(' · ');
  return meta.desc || '';
}

// 悬停卡片: 主系 4 个 (图标 + 名称 + 本局文案) + 副系 2 个 + 属性 3 个。
// 数据不全时返回 '' —— 调用方据此不给 hover, 而不是弹一个空卡片。
function runePageCardHtml(p) {
  const page = (p && p.perkPage) || null;
  const ids = (p && Array.isArray(p.perkIds)) ? p.perkIds.filter(x => Number(x) > 0) : [];
  const styles = (p && Array.isArray(p.perkStyles)) ? p.perkStyles : [];
  const stats = (p && Array.isArray(p.statPerks) && p.statPerks.length)
    ? p.statPerks.filter(x => Number(x) > 0)
    : ((page && Array.isArray(page.stats)) ? page.stats.filter(x => Number(x) > 0) : []);
  const mainSels = (page && page.main && Array.isArray(page.main.sels) && page.main.sels.length)
    ? page.main.sels
    : ids.slice(0, 4).map(id => ({ id, v1: null, v2: null, v3: null }));
  if (!mainSels.length && !stats.length) return '';
  const mainStyleId = (page && page.main && page.main.styleId) || styles[0] || 0;
  const subSels = (page && page.sub && Array.isArray(page.sub.sels) && page.sub.sels.length)
    ? page.sub.sels
    : ids.slice(4, 6).map(id => ({ id, v1: null, v2: null, v3: null }));
  const subStyleId = (page && page.sub && page.sub.styleId) || styles[1] || 0;

  const mainStyleName = runeStyleMetaName(mainStyleId);
  const subStyleName = runeStyleMetaName(subStyleId);
  const styleIcon = (id) => {
    try {
      const v = (typeof styleIconMap !== 'undefined' && styleIconMap) ? styleIconMap[id] : null;
      return v ? `https://ddragon.leagueoflegends.com/cdn/img/${v}` : '';
    } catch (e) { return ''; }
  };

  const itemHtml = (sel, cls) => {
    const icon = runeIconUrl(sel.id);
    const name = runeMetaName(sel.id);
    const desc = runeDescOf(sel.id, sel);
    if (!icon && !name) return '';
    return `<div class="rune-pop-item ${cls}">`
      + (icon ? `<img class="${cls === 'is-sub' ? 'rune-pop-ic-sm' : 'rune-pop-ic'}" src="${icon}" onerror="retryImg(this)">` : '<i class="rune-pop-ic rune-pop-ic-empty"></i>')
      + `<div class="rune-pop-txt"><b>${escapeHtml(name)}</b>`
      + (desc ? `<em>${escapeHtml(desc)}</em>` : '')
      + '</div></div>';
  };

  const head = `<div class="rune-pop-head">`
    + (styleIcon(mainStyleId) ? `<img class="rune-pop-style-ic" src="${styleIcon(mainStyleId)}" onerror="retryImg(this)">` : '')
    + `<b>${escapeHtml(mainStyleName || '主系')}</b>`
    + (subStyleName ? `<span class="rune-pop-substyle">副系 ${escapeHtml(subStyleName)}</span>` : '')
    + '</div>';

  const body = mainSels.map(s => itemHtml(s, 'is-main')).join('')
    + (subSels.length ? `<div class="rune-pop-sep"></div>` + subSels.map(s => itemHtml(s, 'is-sub')).join('') : '');

  const statHtml = stats.length
    ? `<div class="rune-pop-stats">${stats.map(id => {
      const ic = statPerkIconUrl(id);
      return `<span title="${escapeHtml(STAT_PERK_NAMES[id] || statPerkName(id))}">`
        + (ic ? `<img src="${ic}" onerror="retryImg(this)">` : '')
        + escapeHtml(statPerkName(id)) + '</span>';
    }).join('')}</div>`
    : '';

  return `<div class="rune-pop-card">${head}<div class="rune-pop-body">${body}</div>${statHtml}</div>`;
}

// 悬停卡片的事件绑定: 全局委托一次 (详情页会反复重渲染, 逐个绑会越绑越多)。
// 卡片内容内嵌在行里 (display:none), 悬停时**克隆**一份挂到 body 再定位 ——
// 详情弹窗有 overflow/transform, 就地弹会被裁掉或算错坐标; 克隆也避免了
// "挪走节点后原行再也弹不出卡片"的问题。鼠标移出后延迟 120ms 关闭。
let _runeHoverBound = false;
function runeHoverBind() {
  if (_runeHoverBound || typeof document === 'undefined') return;
  _runeHoverBound = true;
  let hideTimer = null;
  let active = null;
  let activeWrap = null;
  const closeActive = () => {
    if (active) { active.remove(); active = null; }
    activeWrap = null;
  };
  const open = (wrap, ev) => {
    const src = wrap.querySelector('.rune-pop');
    if (!src) return;
    closeActive();
    activeWrap = wrap;
    const pop = src.cloneNode(true);
    pop.classList.add('is-open');
    pop.style.left = '0px';
    pop.style.top = '0px';
    document.body.appendChild(pop);
    // 先落地才能量到真实尺寸, 再夹在视口内; 右侧放不下就翻到左边
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let x = ev.clientX + 18;
    let y = ev.clientY - h / 2;
    if (x + w > window.innerWidth - 8) x = Math.max(8, ev.clientX - w - 18);
    if (y < 8) y = 8;
    if (y + h > window.innerHeight - 8) y = Math.max(8, window.innerHeight - h - 8);
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
    active = pop;
  };
  document.addEventListener('mouseover', (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    clearTimeout(hideTimer);
    const wrap = t.closest('.ak-rune-hoverable');
    if (wrap) {
      if (wrap === activeWrap) return;
      open(wrap, e);
      return;
    }
    if (active && active.contains(t)) return;
    hideTimer = setTimeout(closeActive, 120);
  });
  // 滚动 / 点击 / 切换页面时立刻收起, 否则卡片会留在原地
  window.addEventListener('scroll', closeActive, true);
  document.addEventListener('click', closeActive, true);
}

// 图片一次性重试 (2026-09-28): 头像/装备/符文/技能图标都是 ddragon/communitydragon
// 的直连 <img>, 首屏网络被游戏重连挤占时可能瞬时加载失败 —— 原先 onerror 直接
// visibility='hidden', 之后哪怕网络恢复也不再有人重试 (要等下一次整块重渲染)。
// 这里延迟几秒带 cache-buster 重试一次; 重试也失败(真 404)就维持隐藏, 不无限循环。
// 内联 onerror 用: onerror="retryImg(this)"
function retryImg(el) {
  try {
    if (!el) return;
    if (el.dataset.imgRetry) { el.style.visibility = 'hidden'; return; }
    const src = el.getAttribute('src');
    if (!src) return;
    el.dataset.imgRetry = '1';
    setTimeout(() => {
      el.style.visibility = '';
      el.src = src + (src.indexOf('?') >= 0 ? '&' : '?') + 'poroRetry=1';
    }, 5000);
  } catch (e) {}
}

// 1.5.136: 三态伤害分段条 (Akari DamageBar 手法, 颜色同源):
// 物理 #e07856 / 魔法 #5b9bd7 / 真实 #a8a8a8。flex 分段实现 (hex.js 详情表用的是
// 绝对定位版, 那份不动), 供首页折叠卡等无 baseline 场景复用。
// total=0 时输出空底条, 不输出 0% 假分段。
function damageCompositionBar(total, phys, magic, truth) {
  const fmt = v => Number(v) >= 10000 ? (Number(v) / 1000).toFixed(1) + 'k' : String(Math.round(Number(v) || 0));
  const P = Number(phys) || 0, M = Number(magic) || 0, T = Number(truth) || 0;
  const sum = P + M + T;
  if (sum <= 0) return '';                 // EOG 兜底局等没有三态数据: 不渲染空条
  const seg = (v, color, name) => {
    if (v <= 0) return '';
    const pct = sum > 0 ? (v / sum * 100) : 0;
    return `<i style="width:${pct.toFixed(1)}%;background:${color}" title="${name} ${fmt(v)} (${pct.toFixed(0)}%)"></i>`;
  };
  const tip = sum > 0 ? `物理 ${fmt(P)} · 魔法 ${fmt(M)} · 真实 ${fmt(T)}` : '无伤害数据';
  return `<span class="dmg-comp-bar" title="${escapeHtml(tip)}">${seg(P, '#e07856', '物理')}${seg(M, '#5b9bd7', '魔法')}${seg(T, '#a8a8a8', '真实')}</span>`;
}

// 强化图标加载兜底: 包内 png 优先 (离线可用) -> 失败才试 CommunityDragon -> 都失败才隐藏。
// 之前只有 retryImg (直接重试同一个外网地址), 弱网下重试也失败, 于是首页卡片上
// 只剩一排稀有度色块 —— 也就是"图案偶尔不显示"。
const _augDataUrlCache = new Map();
function augFallback(img) {
  try {
    // 每个 img 只记一行: 排查"哪一层挂了"时不用猜 (用户把 crash.log 发来即可)
    if (!img.dataset.augLog) {
      img.dataset.augLog = '1';
      try {
        if (typeof lolAPI !== 'undefined' && lolAPI && lolAPI.debugLog) {
          lolAPI.debugLog('[AUG] fallback id=' + (img.getAttribute('data-aug-id') || '')
            + ' src=' + String(img.getAttribute('src') || '').slice(0, 60));
        }
      } catch (e2) {}
    }
    // ① 包内 png 失败 -> ② CommunityDragon
    const cdn = img.getAttribute('data-cdn');
    if (cdn && !img.dataset.augTried) {
      img.dataset.augTried = '1';
      img.src = cdn;
      return;
    }
    // ③ 还失败 -> 让主进程直接读 asar 里的 png 转 dataURL (同步可读, 不依赖网络/相对路径)
    const id = Number(img.getAttribute('data-aug-id'));
    if (id > 0 && typeof lolAPI !== 'undefined' && lolAPI && typeof lolAPI.augmentIconData === 'function') {
      if (_augDataUrlCache.has(id)) {
        const cached = _augDataUrlCache.get(id);
        if (cached) { img.src = cached; return; }
      } else if (!img.dataset.augIpcTried) {
        img.dataset.augIpcTried = '1';
        lolAPI.augmentIconData([id]).then(map => {
          const url = map && map[id];
          _augDataUrlCache.set(id, url || '');
          if (url) { img.src = url; return; }
          img.style.visibility = 'hidden';
          img.style.background = 'transparent';
        }).catch(() => {
          img.style.visibility = 'hidden';
          img.style.background = 'transparent';
        });
        return;
      }
    }
    // 全失败: 不留纯色空块 —— 交给 CSS 画成"虚线空位", 一眼看出是图缺了
    img.classList.add('is-missing');
    img.style.background = 'transparent';
    img.removeAttribute('src');
  } catch (e) {}
}

// 判断一个 item id 是不是「真装备」——用于装备统计榜（如生涯海报的「装备购买」）。
// 对局里的 items 数组混着三类非装备：
//   - 消耗品：魄罗佳肴(220013, consumed=true)、各种药水/合剂/骰子
//   - 守卫饰品：侦察守卫/神谕透镜(tags 含 Trinket 或 Consumable)
// 注意不能按 Vision 标签剔——黯影阔剑、窃法之刃这些辅助真装也带 Vision。
// allItems 是 ddragon item.json 的 data，所以判据用 consumed / tags / gold.purchasable。
function isRealEquipment(id) {
  const n = +id;
  if (!n || n <= 0) return false;
  const cat = (typeof allItems === 'object' && allItems) ? allItems[String(n)] : null;
  if (!cat) return true; // 没目录数据时不过滤，宁可多算也不误删真装备
  const tags = Array.isArray(cat.tags) ? cat.tags : [];
  if (cat.consumed === true) return false;
  if (tags.indexOf('Trinket') >= 0 || tags.indexOf('Consumable') >= 0) return false;
  if (cat.gold && cat.gold.purchasable === false && !tags.length) return false;
  return true;
}

// 统一的应用内日志出口: 旧代码里的 console.log 统一走这里, 只写 crash.log,
// 不打到 DevTools 控制台 (开发时想看的话下面 console 分支也可以放开)。
function logDebug(...args) {
  try {
    const text = args.map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    }).join(' ');
    if (typeof lolAPI !== 'undefined' && lolAPI && typeof lolAPI.debugLog === 'function') lolAPI.debugLog(text);
  } catch (e) {}
}
