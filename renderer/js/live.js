// 实时对局
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 实时对局 (Live Client Data + 倒计时) ==========
const TIMER_DEFS = { BARON_NASHOR: ["大龙Buff", 180], ELDER_DRAGON: ["远古龙Buff", 150], DRAGON: ["下一条小龙", 300] };
// 加载页/选人页: 从 gameflow session 拉取10名玩家的段位+最近战绩 (LeaguePrank/Seraphine 风格)
const livePlayersCache = { key: "", data: null };
// 选人阶段缓存的玩家列表 (加载页面/游戏开始时复用)
let champSelectParticipants = null;
let liveRenderToken = 0;
// 玩家近期战绩缓存 (puuid 维度, TTL 10 分钟): 实时页跨局/首页切账号共用, 避免每局重拉 100 场
const SGP_RECENT_CACHE_TTL = 10 * 60 * 1000;
const sgpRecentCache = new Map(); // key = `${platformId}|${puuid}`
async function sgpProfileFor(platformId, puuid, count = 30) {
  const key = platformId + '|' + puuid;
  const hit = sgpRecentCache.get(key);
  if (hit && Date.now() - hit.t < (hit.ttl || SGP_RECENT_CACHE_TTL)) return hit;
  const recent = [];
  const teamGames = [];
  const flashSamples = [];
  try {
    const resp = await lolAPI.sgpMatchHistory(platformId, puuid, 0, count);
    if (resp?.__error) throw new Error(resp.__error);
    if (resp) {
      const allGames = (resp.games && resp.games.games) || resp.games || resp || [];
      const games = Array.isArray(allGames) ? allGames : [];
      for (const g of games) {
        const gj = g && g.json ? g.json : (g || {});
        const gameMode = modeName(gj);
        if (isExcludedGame({ mode: gameMode, queueId: gj.queueId, gameMode: gj.gameMode, gameType: gj.gameType })) continue;
        const me = (gj.participants || []).find(x => x && x.puuid === puuid);
        if (!me) continue;
        const teammates = (gj.participants || [])
          .filter(x => x && x.puuid && x.teamId === me.teamId)
          .map(x => x.puuid);
        if (teammates.length > 1) teamGames.push({ id: String(gj.gameId || gj.gameCreation || teamGames.length), players: teammates });
        const stats = me.stats || me;
        flashSamples.push([
          me.spell1Id ?? stats.spell1Id ?? me.summoner1Id ?? stats.summoner1Id,
          me.spell2Id ?? stats.spell2Id ?? me.summoner2Id ?? stats.summoner2Id
        ]);
        const win = stats.win === true || stats.win === "Win" || me.win === true;
        if (recent.length < 10) recent.push({ champId: normalizeChampId(me.championId || stats.championId), win, k: stats.kills ?? me.kills ?? 0, d: stats.deaths ?? me.deaths ?? 0, a: stats.assists ?? me.assists ?? 0, mode: gameMode });
      }
    }
  } catch (e) { throw e; }
  // 成功但确实没有历史时只做短负缓存；网络/鉴权失败完全不缓存。
  const profile = { t: Date.now(), ttl: recent.length || teamGames.length ? SGP_RECENT_CACHE_TTL : 30000, recent, teamGames, flashPreference: summarizeFlashPreference(flashSamples) };
  sgpRecentCache.set(key, profile);
  return profile;
}
async function lcuProfileFor(platformId, puuid, count = 30) {
  const key = 'LCU|' + platformId + '|' + puuid;
  const hit = sgpRecentCache.get(key);
  if (hit && Date.now() - hit.t < (hit.ttl || SGP_RECENT_CACHE_TTL)) return hit;
  const response = await lolAPI.lcuRequest('GET', `/lol-match-history/v1/products/lol/${encodeURIComponent(puuid)}/matches?begIndex=0&endIndex=${Math.max(10, count)}`);
  if (!response || response.__error) throw new Error(response?.__error || 'LCU 战绩暂不可用');
  const recent = [];
  const teamGames = [];
  const flashSamples = [];
  for (const raw of (response?.games?.games || [])) {
    const game = normalizeGame(raw, false);
    if (isExcludedGame(game)) continue;
    const me = (game.participants || []).find(p => p.puuid === puuid);
    if (!me) continue;
    const teammates = (game.participants || []).filter(p => p.puuid && p.teamId === me.teamId).map(p => p.puuid);
    if (teammates.length > 1) teamGames.push({ id: String(game.gid || game.time || teamGames.length), players: teammates });
    flashSamples.push(me.spells || []);
    if (recent.length < 10) recent.push({ champId: me.championId, win: !!me.win, k: me.k || 0, d: me.d || 0, a: me.a || 0, mode: game.mode });
  }
  const profile = { t: Date.now(), ttl: recent.length || teamGames.length ? SGP_RECENT_CACHE_TTL : 30000, recent, teamGames, flashPreference: summarizeFlashPreference(flashSamples) };
  sgpRecentCache.set(key, profile);
  return profile;
}
function recentProfileFor(platformId, puuid, count = 30) {
  return isTencentPlatform(platformId) ? sgpProfileFor(platformId, puuid, count) : lcuProfileFor(platformId, puuid, count);
}
async function announceInferredPremades(players, groups) {
  if (!premadeNotifyOn) return;
  const grouped = new Map();
  for (const player of players) {
    const groupId = player.puuid ? groups[player.puuid] : null;
    if (!groupId) continue;
    if (!grouped.has(groupId)) grouped.set(groupId, []);
    grouped.get(groupId).push(player);
  }
  const valid = [...grouped.values()].filter(group => group.length >= 2);
  const stateEl = document.getElementById('premadeNotifyState');
  if (!valid.length) {
    if (stateEl) stateEl.textContent = '本局未发现开黑组';
    return;
  }
  const key = valid.map(group => group.map(p => p.puuid).sort().join('+')).sort().join('|');
  const label = valid.map(group => group.map(p => p.name || nameCache[p.puuid] || '未知').join(' & ')).join('；');
  if (stateEl) stateEl.textContent = '疑似开黑: ' + label;
  if (_premadeNotifiedFor === key) return;
  _premadeNotifiedFor = key;
  const text = '👥 疑似开黑组合（近30场同队≥3次）: ' + label;
  showToast(text, 'positive');
  if (window._gameflowPhase === 'ChampSelect' && !complianceOn) {
    const result = await sendGameChat(text);
    if (!result.ok) console.log('[premade] chat skip:', result.error);
  }
}
async function renderLiveFromGameflow(body, err, requestedPhase) {
  const renderToken = ++liveRenderToken;
  ensureChampMap();

  // 方式1: gameflow session (选人阶段有完整 puuid)
  const session = await lolAPI.lcuRequest("GET", "/lol-gameflow/v1/session");
  let parts = ((session ?? {}).gameData && (session ?? {}).gameData.participants) || [];
  // 海斗(ARAM)/部分模式用 playerChampionSelections 而非 participants — 结构相同 (puuid+championId+name)
  if (!parts.length) {
    const pcs = session?.gameData?.playerChampionSelections;
    if (Array.isArray(pcs)) parts = pcs;
  }
  const phase = requestedPhase || session?.phase || '';
  // 缓存键: 每局对局唯一标识 (gameId), 兜底用 phase+玩家数 — 避免跨局复用旧骨架
  let key = session?.gameData?.gameId ? String(session.gameData.gameId) : (phase + ':' + parts.length);
  // 遭遇计数用 key: gameId 优先, 兜底只用 puuid 集合 (不含 name, 避免名字解析进度影响)
  _currentGameKey = session?.gameData?.gameId
    ? 'g:' + session.gameData.gameId
    : 'p:' + parts.map(p => p.puuid).filter(Boolean).sort().join(',').slice(0, 200);

  // 选人阶段缓存玩家数据 (加载页面/游戏开始时复用)
  if (phase === 'ChampSelect') {
    // champ-select 事件是当前选人房间的权威数据，优先于可能仍指向上一局的 gameflow session。
    parts = champSelectParticipants || [];
  } else if (parts.length) {
    champSelectParticipants = parts;
  } else if (phase !== 'ChampSelect' && champSelectParticipants) {
    // 加载页面/游戏开始: 复用选人阶段数据
    parts = champSelectParticipants;
  }

  // 对局中优先用 Live Client Data: 它有完整 10 人 (含对手/BOT), 名字/英雄/位置均齐备
  // session 只在选人阶段有完整 puuid; 海斗 playerChampionSelections 只有已方 5 人, 不足以覆盖双方
  // 国服/海斗早期偶发 allPlayers 只返 1 人 → playerlist 兜底 + 重试最多 3 次 (每次 800ms)
  let livePlayers = null;
  if (phase === "InProgress") {
    for (let attempt = 0; attempt < 3 && (!livePlayers || livePlayers.length < 5); attempt++) {
      try {
        const pl = await lolAPI.livePlayerlist();
        const plInfo = Array.isArray(pl) ? ('len=' + pl.length + ' first=' + JSON.stringify(pl[0] || {}).substring(0, 200)) : 'type=' + typeof pl;
        console.log(`[livePage] playerlist attempt=${attempt} isArray=${Array.isArray(pl)} ${plInfo}`);
        if (Array.isArray(pl) && pl.length >= 5) { livePlayers = pl; break; }
      } catch (e) {}
      try {
        const gd = await lolAPI.liveGameData();
        if (gd && gd.allPlayers && gd.allPlayers.length >= 5) { livePlayers = gd.allPlayers; break; }
        if (gd && gd.allPlayers && gd.allPlayers.length) livePlayers = gd.allPlayers; // 1人版兜底
      } catch (e) {}
      if (!livePlayers || livePlayers.length < 5) await new Promise(r => setTimeout(r, 800));
    }
  }
  // 兜底: 历史兼容路径 (ChampSelect 等 live data 不可用的阶段)
  // 绝不能在选人阶段读取 Live Client Data：该服务常在下一局选人时仍保留上一局双方阵容。
  if (phase !== 'ChampSelect' && !livePlayers && !parts.length) {
    try {
      const gd = await lolAPI.liveGameData();
      if (gd && !gd.__error && gd.allPlayers && gd.allPlayers.length) {
        livePlayers = gd.allPlayers;
      }
    } catch (e) {}
  }

  if (!parts.length && !livePlayers) {
    body.innerHTML = `<div class="msg-error">${err || '未获取到对局玩家数据'}</div>`;
    return;
  }

  // 从 session 抽出 championId -> puuid 映射, 给 live data 玩家回填 puuid (用于黑名单/相识)
  const sessionByChamp = {};
  for (const sp of parts) {
    const cid = normalizeChampId(sp.championId);
    if (cid) sessionByChamp[cid] = sp;
  }
  const normTeam = (t) => {
    if (t == null || t === '') return 0;
    if (typeof t === 'number') return t === 100 ? 100 : t === 200 ? 200 : 0;
    const s = String(t).trim().toUpperCase();
    if (s === 'ORDER' || s === '100' || s === 'BLUE') return 100;
    if (s === 'CHAOS' || s === '200' || s === 'RED') return 200;
    return 0;
  };

  const applyLoadingTeamFallback = (list) => {
    if (!Array.isArray(list) || list.length !== 10) return list;
    const known = list.filter(p => p.team === 100 || p.team === 200).length;
    if (known) return list;
    // 国服加载页的 gameflow participants 真实返回 10 人，但每项只有
    // championId/puuid/skin/spells，没有 team/teamId。该数组仍按双方各 5 人排列；
    // 若不兜底，10 人会全部掉进“队伍识别中”，蓝红两栏就显示 0 人。
    return list.map((p, index) => ({ ...p, team: index < 5 ? 100 : 200 }));
  };

  let players;
  if (livePlayers && livePlayers.length) {
    // 对局中: 直接用 Live Client Data 构建 10 人 (含对手/BOT, 字段完整)
    players = livePlayers.map(lp => {
      let cid = lp.championId || 0;
      if (!cid && lp.championName && allChampions) {
        const found = Object.values(allChampions).find(c => c.name === lp.championName);
        if (found) cid = +found.key;
      }
      const sp = cid ? sessionByChamp[cid] : null;
      return {
        puuid: sp?.puuid || lp.riotId || '',
        championId: cid,
        team: normTeam(lp.team),
        position: lp.position || '',
        name: lp.riotIdGameName || lp.summonerName || sp?.summonerName || sp?.gameName || '',
        items: (lp.items || []).map(item => +(item?.itemID ?? item?.itemId ?? item) || 0).filter(Boolean),
        challengeId: sp?.challengeId ?? 0,
        isBot: !!lp.isBot
      };
    });
  } else if (parts.length) {
    // 选人/加载阶段: 仅有 session 数据, championId 用 session 的
    players = parts.map(p => ({
      puuid: p.puuid || "",
      championId: normalizeChampId(p.championId),
      team: normTeam(p.team ?? p.teamId ?? ''),
      position: p.position || "",
      name: p.summonerName || p.gameName || p.displayName || "",
      challengeId: p.challengeId ?? 0
    }));
  }
  if (phase !== 'ChampSelect') players = applyLoadingTeamFallback(players);
  // 缓存键同时包含当前阵容；即使 gameflow 暂时沿用旧 gameId，也不会命中上一局数据。
  const rosterKey = players.map(p => `${p.puuid || p.name || '?'}@${p.championId || 0}`).sort().join('|');
  key = `${session?.gameData?.gameId || phase}:${rosterKey}`;
  window.poroSession?.setGame(session?.gameData?.gameId || '', rosterKey);
  const sessionToken = window.poroSession?.token();
  const staleSession = () => renderToken !== liveRenderToken || (sessionToken && !window.poroSession?.isCurrent(sessionToken));
  _currentGameKey = session?.gameData?.gameId ? `g:${key}` : `p:${rosterKey.slice(0, 240)}`;
  // 诊断: 数据源路径 + 各边人数
  const blueN = players.filter(p => p.team === 100 || p.team === '100').length;
  const redN = players.filter(p => p.team === 200 || p.team === '200').length;
  const unknownN = players.length - blueN - redN;
  console.log(`[livePage] path=${livePlayers ? 'live('+livePlayers.length+')' : 'session('+parts.length+')'} players=${players.length} blue=${blueN} red=${redN} unknown=${unknownN} phase=${phase}`);

  // 训练模式/自定义局: LCU 只返回自己 1 人 (isCustomGame:true), 是平台限制而非 bug
  const isCustom = !!session?.gameData?.isCustomGame;
  const onlySelf = players.length <= 1;
  if (isCustom || onlySelf) {
    if (onlySelf && players.length === 1) players[0].team = 100; // 训练模式只有自己, 默认放蓝方
    const hint = document.createElement('div');
    hint.className = 'live-custom-hint';
    hint.innerHTML = onlySelf
      ? '当前为训练模式/自定义局，客户端仅返回你自己 1 名玩家。进入真实匹配对局后才会显示完整 10 人阵容、英雄头像与补刀/金币数据。'
      : '当前为自定义对局，实时数据可能不完整。';
    body.prepend(hint);
  }
  // premade detection based on challengeId, covering all 10 players
  let premadeGroups = null;
  if (phase === "ChampSelect" || phase === "InProgress" || phase === "GameStart") {
    try {
      const lobbyMembers = await lolAPI.lcuRequest("GET", "/lol-lobby/v2/lobby/members");
      const groupMap = {};
      for (const p of parts) {
        if (!p.puuid) continue;
        const cid = p.challengeId ?? 0;
        if (!groupMap[cid]) groupMap[cid] = [];
        groupMap[cid].push(p.puuid);
      }
      if (lobbyMembers && Array.isArray(lobbyMembers)) {
        for (const m of lobbyMembers) {
          if (!m.puuid) continue;
          const cid = m.challengeId ?? 0;
          if (!groupMap[cid]) groupMap[cid] = [];
          if (!groupMap[cid].includes(m.puuid)) groupMap[cid].push(m.puuid);
        }
      }
      premadeGroups = {};
      let gid = 1;
      for (const [cid, puids] of Object.entries(groupMap)) {
        if (puids.length >= 2 && +cid !== 0) {
          for (const pu of puids) premadeGroups[pu] = gid;
          gid++;
        }
      }
    } catch (e) {}
  }

  // 缓存命中: 只有从 Live Client Data 拿到完整双方(≥5人)才复用, 避免第一次 session 数据不完整导致后续永远错误
  if (livePlayersCache.key === key && livePlayersCache.data && livePlayers && livePlayers.length >= 5) {
    await renderLiveTeams(body, livePlayersCache.data, premadeGroups, renderToken);
    return;
  }

  // 先解析名字和段位 (快)
  await resolveNames(players.filter(p => p.puuid).map(p => p.puuid));
  await resolveRanks(players.filter(p => p.puuid).map(p => p.puuid));
  if (staleSession()) return;

  // 立即渲染基本阵容 (名字+英雄+段位), 不等 SGP
  const champOf = id => {
    const key = String(id);
    if (champNumMap && champNumMap[key]) return champNumMap[key];
    for (const k in allChampions) {
      if (allChampions[k].key === key) return { id: k, name: allChampions[k].name };
    }
    return null;
  };
  let selfPuuid = null;
  try { const st = await lolAPI.lcuStatus(); selfPuuid = st.summoner?.puuid; } catch(e) {}

  const quickData = players.map(p => {
    const solo = (rankCache[p.puuid] || {}).RANKED_SOLO_5x5;
    const rank = solo && solo.tier ? `${rankTierCN(solo.tier)} ${solo.division || ''} ${solo.leaguePoints || 0}LP` : '';
    return { ...p, recent: [], rank, flashPreference: null, isBot: !p.puuid };
  });
  const fullData = [...quickData];

  // 立即渲染骨架
  await renderLiveTeams(body, quickData, premadeGroups, renderToken);
  if (staleSession()) return;

  // 异步获取 SGP 数据, 逐人更新
  let platformId = "";
  try { platformId = await getPlatformId(); } catch (e) {}

  // 立即缓存骨架数据, 让 updateLivePage 不阻塞 — SGP 拉取改为后台并发填充, 渲染时已有 recent 的玩家立刻显示
  // 只缓存 Live Client Data 完整双方(≥5人), 防止 session-only 数据污染缓存
  if (livePlayers && livePlayers.length >= 5) {
    livePlayersCache.key = key;
    livePlayersCache.data = fullData;
  }

  const sgpLoad = mapWithConcurrency(fullData, 4, async (p, idx) => {
    if (p.isBot || !platformId || !p.puuid) return;
    // 走 10 分钟 TTL 缓存 + 30 场拉取; 命中缓存时是同步返回, 几乎无延迟
    try {
      let profile = await recentProfileFor(platformId, p.puuid, 30);
      const rememberedPlatform = typeof getRememberedPlayerPlatform === 'function' ? getRememberedPlayerPlatform(p.puuid) : '';
      if (isTencentPlatform(platformId) && !profile.recent.length && rememberedPlatform && rememberedPlatform !== platformId) {
        profile = await sgpProfileFor(rememberedPlatform, p.puuid, 30);
      }
      if (profile.recent.length) {
        p.recent = profile.recent;
      }
      p.flashPreference = profile.flashPreference || null;
      if (!staleSession()) updateLivePlayerRow(p, idx);  // 旧对局/旧账号的异步结果不得污染新阵容
      return profile;
    } catch (e) { return null; }
  });
  // 后台执行, 不阻塞骨架；战绩分批填充，全部到齐后按共同历史推断开黑组并刷新徽标。
  sgpLoad.then(async profiles => {
    if (staleSession()) return;
    const inferred = inferPremadeGroups(fullData, profiles.filter(Boolean), 3);
    const finalGroups = Object.keys(inferred).length ? inferred : premadeGroups;
    await renderLiveTeams(body, fullData, finalGroups, renderToken);
    if (!staleSession()) await announceInferredPremades(fullData, inferred);
  }).catch(() => {});
}

function champOfLive(id) {
  const key = String(id);
  if (champNumMap && champNumMap[key]) return champNumMap[key];
  for (const k in allChampions) {
    if (allChampions[k].key === key) return { id: k, name: allChampions[k].name };
  }
  return null;
}

function champDataOfLive(id) {
  const key = String(id || '');
  for (const name in allChampions) if (String(allChampions[name]?.key) === key) return allChampions[name];
  return null;
}

function liveTeamComposition(list) {
  const tags = { Tank: 0, Fighter: 0, Mage: 0, Assassin: 0, Marksman: 0, Support: 0 };
  for (const player of list) for (const tag of (champDataOfLive(player.championId)?.tags || [])) if (tag in tags) tags[tag]++;
  const matches = list.reduce((sum, p) => sum + (p.recent?.length || 0), 0);
  const wins = list.reduce((sum, p) => sum + (p.recent || []).filter(r => r.win === true || r.win === 'Win').length, 0);
  const strengths = [];
  const weaknesses = [];
  const frontline = tags.Tank + tags.Fighter;
  if (frontline >= 3) strengths.push('前排充足');
  if (tags.Mage >= 2) strengths.push('魔法输出充足');
  if (tags.Marksman + tags.Assassin >= 2) strengths.push('物理收割能力强');
  if (tags.Support >= 2) strengths.push('保护与续航较强');
  if (!frontline) weaknesses.push('缺少前排');
  else if (frontline === 1) weaknesses.push('前排偏薄');
  if (!tags.Mage) weaknesses.push('魔法伤害不足');
  if (!tags.Marksman && !tags.Assassin) weaknesses.push('持续物理输出不足');
  if (!tags.Support) weaknesses.push('保护能力偏弱');
  const recentRate = matches ? wins / matches : 0.5;
  const balance = Math.min(1, frontline / 2) + Math.min(1, tags.Mage) + Math.min(1, tags.Marksman + tags.Assassin) + Math.min(1, tags.Support);
  const readiness = Math.round(50 + (recentRate - 0.5) * 32 + (balance - 2.6) * 3);
  return { tags, frontline, matches, wins, recentRate, readiness: Math.max(35, Math.min(65, readiness)), strengths, weaknesses };
}

function liveItemAdvice(self, enemyComp) {
  if (!self) return [];
  const ownTags = champDataOfLive(self.championId)?.tags || [];
  const physical = enemyComp.tags.Marksman + enemyComp.tags.Assassin + enemyComp.tags.Fighter;
  const magic = enemyComp.tags.Mage + enemyComp.tags.Support;
  const tanky = enemyComp.tags.Tank + enemyComp.tags.Fighter;
  const advice = [];
  if (magic >= 3) advice.push(ownTags.includes('Mage') ? '女妖面纱' : ownTags.includes('Marksman') ? '玛莫提乌斯之噬' : '自然之力');
  if (physical >= 3) advice.push(ownTags.includes('Marksman') ? '守护天使' : ownTags.includes('Mage') ? '中娅沙漏' : '兰顿之兆');
  if (tanky >= 3) advice.push(ownTags.includes('Mage') ? '虚空之杖' : ownTags.includes('Marksman') ? '多米尼克领主的致意' : '黑色切割者');
  if (enemyComp.tags.Support >= 2) advice.push(ownTags.includes('Mage') ? '莫雷洛秘典' : ownTags.includes('Tank') ? '荆棘之甲' : '凡性的提醒');
  const ownedNames = new Set((self.items || []).map(id => allItems?.[String(id)]?.name).filter(Boolean));
  return [...new Set(advice)].filter(name => !ownedNames.has(name)).slice(0, 3);
}

function buildLiveDecisionPanel(data, selfPuuid) {
  const blue = data.filter(p => p.team === 100 || p.team === '100');
  const red = data.filter(p => p.team === 200 || p.team === '200');
  if (!blue.length || !red.length) return '';
  const blueComp = liveTeamComposition(blue), redComp = liveTeamComposition(red);
  const total = Math.max(1, blueComp.readiness + redComp.readiness);
  const blueEdge = Math.round(blueComp.readiness / total * 100);
  const redEdge = 100 - blueEdge;
  const self = data.find(p => selfPuuid && p.puuid === selfPuuid) || data.find(p => p.name && window._myPuuid && p.puuid === window._myPuuid);
  const ownComp = self && (self.team === 200 || self.team === '200') ? redComp : blueComp;
  const enemyComp = ownComp === blueComp ? redComp : blueComp;
  const itemAdvice = liveItemAdvice(self, enemyComp);
  const plan = ownComp.frontline < enemyComp.frontline
    ? '避免正面先手，先消耗并保护后排，等敌方关键技能交出后反打。'
    : ownComp.tags.Mage + ownComp.tags.Marksman >= 3
      ? '围绕后排持续输出，前排只需限制突进，不必追击过深。'
      : '利用前排主动逼团，优先压缩敌方后排输出空间。';
  const teamCard = (name, comp, edge, cls) => `<div class="ld-team ${cls}">
    <div class="ld-team-title"><b>${name}</b><strong>${edge}</strong><span>综合态势</span></div>
    <div class="ld-tags"><i>前排 ${comp.frontline}</i><i>法系 ${comp.tags.Mage}</i><i>物理 ${comp.tags.Marksman + comp.tags.Assassin}</i><i>保护 ${comp.tags.Support}</i></div>
    <p><b>优势：</b>${escapeHtml(comp.strengths.join('、') || '阵容较均衡')}</p>
    <p><b>短板：</b>${escapeHtml(comp.weaknesses.join('、') || '暂无明显结构短板')}</p>
  </div>`;
  return `<details class="live-decision">
    <summary><b>本局作战计划</b><span class="ld-score blue">蓝 ${blueEdge}</span><span class="ld-score red">红 ${redEdge}</span><span class="ld-summary-plan">${escapeHtml(plan)}</span>${itemAdvice.length ? `<em>${escapeHtml(itemAdvice.join(' / '))}</em>` : ''}<i>展开</i></summary>
    <div class="ld-body">
      <div class="ld-head"><div><span>综合态势不是官方胜率，由阵容结构与玩家近期表现生成</span></div></div>
      <div class="ld-grid">${teamCard('蓝方', blueComp, blueEdge, 'blue')}${teamCard('红方', redComp, redEdge, 'red')}</div>
      <div class="ld-plan"><b>己方建议</b><span>${escapeHtml(plan)}</span>${itemAdvice.length ? `<em>装备方向：${escapeHtml(itemAdvice.join(' / '))}</em>` : ''}</div>
    </div>
  </details>`;
}

// 加载最近 10 场；玩家卡高度固定，超出部分在卡片内部滚动，不挤出另一支队伍。
function recentLimit() {
  return 10;
}

function recentIcon(r) {
  const rc = champOfLive(r.champId);
  const isWin = r.win === true || r.win === 'Win';
  const modeLabel = r.mode ? `<span class="ri-mode">${escapeHtml(r.mode)}</span>` : '';
  return `<div class="ri-card ${isWin ? 'ri-win' : 'ri-loss'}" title="${escapeHtml(r.mode || '')} ${r.k}/${r.d}/${r.a} ${isWin ? '胜' : '负'}">
    <img src="${rc ? champImg(rc.id) : placeholder('?')}" onerror="this.src='${placeholder('?')}'">
    <span class="ri-copy">${modeLabel}<span class="ri-result">${isWin ? '胜' : '负'}</span></span>
    <span class="ri-kda">${r.k} / ${r.d} / ${r.a}</span>
  </div>`;
}

function livePlayerKey(p) {
  return String(p?.puuid || p?.name || `${p?.team || 0}:${p?.championId || 0}`);
}

function flashPreferenceHtml(pref) {
  if (!pref || !pref.total) return '';
  const label = pref.inconsistent
    ? `闪 D${pref.d}/F${pref.f}`
    : `${pref.preferred || (pref.d ? 'D' : 'F')}闪`;
  const title = pref.inconsistent
    ? `该玩家放置闪现的位置不一致。在最近的对局中，D位置${pref.d}次，F位置${pref.f}次`
    : `最近${pref.total}场使用闪现的对局中，闪现均放在${pref.d ? 'D' : 'F'}位置`;
  return `<span class="lp-flash${pref.inconsistent ? ' mixed' : ''}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
}

function updateLivePlayerRow(p, idx) {
  const key = livePlayerKey(p);
  const row = [...document.querySelectorAll('.lp-row')].find(el => el.dataset.playerKey === key)
    || document.querySelectorAll('.lp-row')[idx];
  if (!row) return;
  const c = champOfLive(p.championId);
  const recentHtml = p.recent.length ? p.recent.slice(0, recentLimit()).map(recentIcon).join('') : '<span class="ri-empty">无数据</span>';
  const wins = p.recent.filter(r => r.win === true || r.win === "Win").length;
  const totK = p.recent.reduce((s, r) => s + r.k, 0), totD = p.recent.reduce((s, r) => s + r.d, 0), totA = p.recent.reduce((s, r) => s + r.a, 0);
  const kda = p.recent.length ? ((totK + totA) / Math.max(1, totD)).toFixed(1) : '--';
  const recentEl = row.querySelector('.lp-recent');
  const statsEl = row.querySelector('.lp-stats');
  const flashEl = row.querySelector('.lp-flash-slot');
  const winRateEl = row.querySelector('.lp-winrate');
  const recordEl = row.querySelector('.lp-record');
  const kdaEl = row.querySelector('.lp-kda');
  if (recentEl) recentEl.innerHTML = recentHtml;
  if (statsEl) statsEl.textContent = p.recent.length ? `近 ${p.recent.length} 场` : '';
  if (flashEl) flashEl.innerHTML = flashPreferenceHtml(p.flashPreference);
  if (winRateEl) {
    const winRate = p.recent.length ? Math.round(wins / p.recent.length * 100) : null;
    winRateEl.textContent = winRate == null ? '--' : `${winRate}%`;
    winRateEl.classList.toggle('positive', winRate != null && winRate >= 50);
  }
  if (recordEl) recordEl.textContent = p.recent.length ? `${wins}胜${p.recent.length - wins}负` : '暂无近期战绩';
  if (kdaEl) kdaEl.textContent = `KDA ${kda}`;
}

async function renderLiveTeams(body, data, premadeGroups, expectedToken) {
  checkBlacklist(data);
  let selfPuuid = null;
  try { const st = await lolAPI.lcuStatus(); selfPuuid = st.summoner?.puuid; } catch(e) {}
  if (expectedToken != null && expectedToken !== liveRenderToken) return;
  // 遭遇计数: 按对局唯一 key 去重 (gameId 优先), 排除自己 (自己不能"遇过"自己)。
  // 旧实现用"玩家集合"做 key, 同一局内 puuid/name 分批解析到位会生成不同 key, 导致同局重复计数虚高
  if (_encounterTrackedFor !== _currentGameKey) {
    _encounterTrackedFor = _currentGameKey;
    const seen = new Set();
    for (const p of data) {
      if (!p.puuid || !p.name || seen.has(p.puuid)) continue;
      if (selfPuuid && p.puuid === selfPuuid) continue;
      seen.add(p.puuid);
      addEncounter(p.puuid, p.name);
    }
  }
  const playerRow = p => {
    const c = champOfLive(p.championId);
    const recentHtml = p.recent.length ? p.recent.slice(0, recentLimit()).map(recentIcon).join('') : '<span class="ri-loading">加载中...</span>';
    const wins = p.recent.filter(r => r.win === true || r.win === "Win").length;
    const totK = p.recent.reduce((s, r) => s + r.k, 0), totD = p.recent.reduce((s, r) => s + r.d, 0), totA = p.recent.reduce((s, r) => s + r.a, 0);
    const kda = p.recent.length ? ((totK + totA) / Math.max(1, totD)).toFixed(1) : '--';
    const name = p.name || nameCache[p.puuid] || '未知';
    const isSelf = selfPuuid && p.puuid === selfPuuid;
    const tag = isSelf ? ' <span style="color:#ffd700;font-size:10px">★ 自己</span>' : '';
    const premadeGroupId = premadeGroups && p.puuid ? premadeGroups[p.puuid] : null;
    const premadeTag = premadeGroupId ? `<span class="lp-premade" title="开黑组 ${premadeGroupId}">👥组${premadeGroupId}</span>` : '';
    const marksHtml = !isSelf && p.puuid ? `<span style="cursor:pointer;font-size:9px;color:#888;margin-left:4px;" onclick="showMarkModal(${inlineArg(p.puuid)},${inlineArg(name)})">📌</span>${getPlayerMarksHtml(p.puuid)}` : '';
    const winRate = p.recent.length ? Math.round(wins / p.recent.length * 100) : null;
    return `<div class="lp-row${isSelf ? ' lp-self' : ''}" data-player-key="${escapeHtml(livePlayerKey(p))}">
      <div class="lp-card-head">
        <img class="lp-champ" src="${c ? champImg(c.id) : placeholder('?')}" onerror="this.src='${placeholder('?')}'">
        <div class="lp-info">
          <div class="lp-name-line"><span class="lp-name">${escapeHtml(name)}</span>${tag}${premadeTag}${marksHtml}</div>
          <div class="lp-rank">${escapeHtml(p.rank || '无段位')} <span class="lp-flash-slot">${flashPreferenceHtml(p.flashPreference)}</span></div>
        </div>
      </div>
      <div class="lp-overview">
        <span class="lp-winrate${winRate != null && winRate >= 50 ? ' positive' : ''}">${winRate == null ? '--' : winRate + '%'}</span>
        <span class="lp-record">${p.recent.length ? `${wins}胜${p.recent.length - wins}负` : '近期战绩加载中'}</span>
        <span class="lp-kda">KDA ${kda}</span>
      </div>
      <div class="lp-recent">${recentHtml}</div>
      <div class="lp-stats">${p.recent.length ? `近 ${p.recent.length} 场` : ''}</div>
    </div>`;
  };
  const isBlue = p => p.team === 100 || p.team === "100";
  const isRed = p => p.team === 200 || p.team === "200";
  const blue = data.filter(isBlue), red = data.filter(isRed), unknown = data.filter(p => !isBlue(p) && !isRed(p));
  const teamPanel = (list, label, cls) => {
    const matches = list.reduce((sum, p) => sum + p.recent.length, 0);
    const wins = list.reduce((sum, p) => sum + p.recent.filter(r => r.win === true || r.win === 'Win').length, 0);
    const kills = list.reduce((sum, p) => sum + p.recent.reduce((n, r) => n + r.k, 0), 0);
    const deaths = list.reduce((sum, p) => sum + p.recent.reduce((n, r) => n + r.d, 0), 0);
    const assists = list.reduce((sum, p) => sum + p.recent.reduce((n, r) => n + r.a, 0), 0);
    const summary = matches ? `<span>近期胜率 ${Math.round(wins / matches * 100)}% · KDA ${((kills + assists) / Math.max(1, deaths)).toFixed(2)}</span>` : '<span>战绩加载中</span>';
    return `<section class="lp-team ${cls}">
      <div class="lp-team-head"><strong>${label}</strong><span>${list.length} 名玩家</span>${summary}</div>
      <div class="lp-team-grid">${list.map(playerRow).join('')}</div>
    </section>`;
  };
  body.innerHTML = `
    <div class="live-time">⏱ 对局玩家信息</div>
    ${buildLiveDecisionPanel(data, selfPuuid)}
    <div class="lp-wrap" style="margin-top:6px">${teamPanel(blue, '蓝方', 'lp-blue')}${teamPanel(red, '红方', 'lp-red')}${unknown.length ? teamPanel(unknown, '队伍识别中', 'lp-unknown') : ''}</div>`;
}
async function updateLivePage(phase) {
  const startedAt = performance.now();
  const body = document.getElementById("liveGameArea");
  if (!body) return;
  const gpEl = document.getElementById("gameflowPhase"); if (gpEl) gpEl.textContent = PHASE_TEXT[phase] || phase || "未知";
  if (phase !== "InProgress" && phase !== "ChampSelect" && phase !== "PRACTICETOOL" && phase !== "GameStart") {
    // 离开对局, 清除选人缓存
    champSelectParticipants = null;
    livePlayersCache.key = '';
    livePlayersCache.data = null;
    liveRenderToken++;
    body.innerHTML = '<div class="meta-loading">当前不在对局中。进入游戏后此处显示: 双方阵容、玩家战绩/段位、游戏时间、大龙/小龙/Buff 倒计时</div>';
    return;
  }
  // 所有阶段都显示玩家战绩; 加载界面数据未就绪时给出等待提示 (轮询会持续重试)
  try {
    await renderLiveFromGameflow(body, phase === "GameStart" ? "对局加载中, 玩家数据拉取中..." : null, phase);
  } finally {
    window.poroPerf?.record('live.render', performance.now() - startedAt, { phase: phase || '' });
  }
}
const PHASE_TEXT = { None: "无", Lobby: "房间中", Matchmaking: "匹配中", ReadyCheck: "匹配确认", ChampSelect: "选人中", GameStart: "对局开始", InProgress: "对局进行中", WaitingForStats: "对局结束统计", EndOfGame: "对局结束", TerminatedInError: "异常退出" };
let champNumMap = null;
function toolMsg(html) { document.getElementById("toolMsg").innerHTML = html; setTimeout(() => { document.getElementById("toolMsg").innerHTML = ""; }, 6000); }
function showToast(text, type) {
  const el = document.getElementById('globalToast');
  if (!el) return;
  el.textContent = text;
  el.className = 'global-toast show ' + (type || 'positive');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = 'global-toast'; }, 3000);
}
