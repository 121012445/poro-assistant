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
  const isSupport = String(player.position || '').toUpperCase() === 'SUPPORT';

  if (healingStrong) add('治疗给力', 'healing', `队内治疗/护盾最高：${Math.round(myHealing).toLocaleString()}`);

  const maxDamage = Math.max(...team.map(item => +item.dmg || 0));
  const maxVision = Math.max(...team.map(item => +item.visionScore || 0));
  const avgVision = sum('visionScore') / n;
  if ((+player.dmg || 0) === maxDamage && share >= 25) {
    add('输出核心', 'damage', `全队伤害最高，占比 ${share}%`);
  } else if (+minutes >= 10 && !isSupport && !healingStrong && share <= 12 && (+player.dmg || 0) <= avgDamage * 0.65) {
    add('输出乏力', 'low', `伤害占比 ${share}%，低于队内平均`);
  }

  if (+minutes >= 10 && takenShare <= 11 && (+player.dmgTaken || 0) <= avgTaken * 0.65) {
    add('承伤偏少', 'low', `承伤占比 ${takenShare}%；仅描述本局分摊，不代表负面评价`);
  }

  const ownGoldRate = (+player.gold || 0) > 0 ? (+player.dmg || 0) / (+player.gold || 1) * 100 : 0;
  const teamGoldRates = team
    .filter(item => (+item.gold || 0) >= 1000)
    .map(item => (+item.dmg || 0) / Math.max(1, +item.gold || 0) * 100);
  const avgGoldRate = teamGoldRates.length
    ? teamGoldRates.reduce((total, value) => total + value, 0) / teamGoldRates.length
    : 0;
  if (+minutes >= 10 && (+player.gold || 0) >= 3000 && avgGoldRate > 0
      && ownGoldRate >= avgGoldRate * 1.3 && share >= 20) {
    add('伤转高', 'efficiency', `伤害转化 ${Math.round(ownGoldRate)}%，显著高于队内平均`);
  } else if (+minutes >= 10 && !isSupport && !healingStrong && (+player.gold || 0) >= 3000
      && avgGoldRate > 0 && ownGoldRate <= avgGoldRate * 0.72 && share <= 16) {
    add('伤转偏低', 'low', `伤害转化 ${Math.round(ownGoldRate)}%，低于队内平均`);
  }

  if (!aramMode && (+player.visionScore || 0) === maxVision && (+player.visionScore || 0) >= Math.max(20, avgVision * 1.25)) {
    add('视野掌控', 'vision', `全队视野得分最高：${+player.visionScore || 0}`);
  } else if (participation >= 75) {
    add('团队核心', 'team', `击杀参与率 ${participation}%`);
  }
  return tags.slice(0, 3);
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
