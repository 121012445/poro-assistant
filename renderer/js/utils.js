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

// 赛前风险画像只根据近期样本给出可解释提示，不把低样本结论包装成事实。
function deriveRiskProfile(recent) {
  const games = Array.isArray(recent) ? recent.filter(Boolean) : [];
  if (!games.length) return { level: 'unknown', label: '数据不足', confidence: 0, evidence: ['暂无近期有效对局'] };
  const wins = games.filter(g => g.win === true || g.win === 'Win').length;
  const deaths = games.reduce((sum, g) => sum + Math.max(0, +g.d || 0), 0);
  const kills = games.reduce((sum, g) => sum + Math.max(0, +g.k || 0), 0);
  const assists = games.reduce((sum, g) => sum + Math.max(0, +g.a || 0), 0);
  const winRate = Math.round(wins / games.length * 100);
  const kda = (kills + assists) / Math.max(1, deaths);
  const avgDeaths = deaths / games.length;
  const evidence = [`近 ${games.length} 场 ${wins}胜${games.length - wins}负`, `KDA ${kda.toFixed(1)} · 场均死亡 ${avgDeaths.toFixed(1)}`];
  if (games.length < 4) return { level: 'unknown', label: '样本较少', confidence: 15 + games.length * 10, evidence };

  let level = 'normal';
  let label = '状态一般';
  if (winRate >= 60 && kda >= 3.2) { level = 'steady'; label = '近期稳定'; }
  else if (avgDeaths >= 8 || (winRate <= 35 && kda < 1.8)) { level = 'watch'; label = '需要观察'; }

  // 置信度不再等同于“是否拿满 10 场”。它同时考虑：
  // 1) 最多 20 场的样本覆盖；2) 各局 KDA 是否一致；3) 指标离画像阈值有多远。
  // 因为这仍是近期行为提示而非概率模型，最高封顶 95%，避免制造“100%确定”的错觉。
  const perGameKda = games.map(g => (Math.max(0, +g.k || 0) + Math.max(0, +g.a || 0)) / Math.max(1, Math.max(0, +g.d || 0)));
  const mean = perGameKda.reduce((sum, value) => sum + value, 0) / perGameKda.length;
  const deviation = Math.sqrt(perGameKda.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / perGameKda.length);
  const consistency = 1 - Math.min(1, deviation / Math.max(1, mean));
  const clamp01 = value => Math.max(0, Math.min(1, value));
  let decisiveness = 0.25;
  if (level === 'steady') {
    decisiveness = (clamp01((winRate - 55) / 25) + clamp01((kda - 2.7) / 2.5)) / 2;
  } else if (level === 'watch') {
    const deathSignal = clamp01((avgDeaths - 6.5) / 4.5);
    const weakSignal = clamp01((40 - winRate) / 25) * 0.55 + clamp01((2.2 - kda) / 1.8) * 0.45;
    decisiveness = Math.max(deathSignal, weakSignal);
  }
  const sampleScore = 35 + Math.min(1, games.length / 20) * 40;
  const confidence = Math.min(95, Math.round(sampleScore + consistency * 8 + decisiveness * 12));
  return { level, label, confidence, evidence };
}
