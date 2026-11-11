// 图标兜底：Node 测试 require 本文件时 icons.js 不在作用域（同 home.js 的守卫）。
if (typeof poroIcon !== 'function') { globalThis.poroIcon = () => '<svg class="pi"></svg>'; }

// 实时对局
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 实时对局 (Live Client Data + 倒计时) ==========
const TIMER_DEFS = { BARON_NASHOR: ["大龙Buff", 180], ELDER_DRAGON: ["远古龙Buff", 150], DRAGON: ["下一条小龙", 300] };
// 加载页/选人页: 从 gameflow session 拉取10名玩家的段位+最近战绩 (LeaguePrank/Seraphine 风格)
const livePlayersCache = { key: "", data: null, premadeGroups: null };
// 选人阶段缓存的玩家列表 (加载页面/游戏开始时复用)
let champSelectParticipants = null;
let liveRenderToken = 0;
// 当前对局是否为大乱斗类模式 (决定玩家卡上显示平衡性调整); 由 renderLiveFromGameflow 按 gameflow 队列更新
let liveBalanceMode = false;
// 当前对局的强度榜模式 (aram / aram_mayhem / urf / null), 用于英雄强度角标
let liveTierMode = null;
// 玩家近期战绩缓存 (puuid 维度, TTL 10 分钟): 实时页跨局/首页切账号共用, 避免每局重拉 100 场
const SGP_RECENT_CACHE_TTL = 10 * 60 * 1000;
const sgpRecentCache = new Map(); // key = `${platformId}|${puuid}`

// 队内占比: 伤害 / 承伤 / 经济 / 参团。
// 玩家卡上的彩色数据标签靠它 —— 只看胜率和 KDA 分不出"被带飞"和"carry 赢", 占比能。
// 取不到字段时整块返回空对象 (而不是写 0), 渲染层据此整排不显示,
// 避免国服某些模式缺字段时出现一排毫无意义的 0%。
function teamShareOf(participants, me, k, a, keys) {
  const K = keys || { dmg: 'totalDamageDealtToChampions', tank: 'totalDamageTaken', gold: 'goldEarned', kills: 'kills', vision: 'visionScore' };
  const mates = (participants || []).filter(x => x && x.teamId === me.teamId);
  if (!mates.length) return {};
  const num = (o, key) => Number(o && o[key]) || 0;
  const total = key => mates.reduce((n, x) => n + num(x, key), 0);
  const pct = (v, all) => (all > 0 ? Math.round((v / all) * 100) : null);
  const dmg = num(me, K.dmg), gold = num(me, K.gold);
  const dmgPct = pct(dmg, total(K.dmg));
  if (dmgPct == null) return {};
  const teamKills = total(K.kills);
  return {
    dmgPct,
    tankPct: pct(num(me, K.tank), total(K.tank)),
    goldPct: pct(gold, total(K.gold)),
    kp: teamKills > 0 ? Math.round(((k + a) / teamKills) * 100) : null,
    // 伤转率 = 伤害 / 经济。同样是 20% 经济占比, 打出 180% 伤转和 90% 伤转是两种人。
    dmgGold: gold > 0 ? Math.round((dmg / gold) * 100) : null,
    vision: num(me, K.vision) || null
  };
}
// 每局 10 人、每条约十几 KB (近 10 场 + 30 场同队记录); 长时间挂着会一直累积, 只保留最近的
const SGP_RECENT_CACHE_MAX = 300;
async function sgpProfileFor(platformId, puuid, count = 30) {
  const key = platformId + '|' + puuid;
  const hit = sgpRecentCache.get(key);
  if (hit && Date.now() - hit.t < (hit.ttl || SGP_RECENT_CACHE_TTL)) return hit;
  const recent = [];
  const teamGames = [];
  const flashSamples = [];
  const behaviorSamples = [];      // 投降/信号统计需要比战绩列表更多的场次 (≥8 场), 单独收集, 见 behavior-tags.js
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
        if (recent.length < 10) {
          const k = stats.kills ?? me.kills ?? 0, d = stats.deaths ?? me.deaths ?? 0, a = stats.assists ?? me.assists ?? 0;
          recent.push({
            // 1.5.76: 带上 gameId, 实时页点这张卡才能按需拉这一局的完整详情
            gameId: gj.gameId || gj.gameID || gj.gameUuid || gj.gameUUID || 0,
            champId: normalizeChampId(me.championId || stats.championId), win, k, d, a,
            mode: gameMode, ts: gj.gameCreation || gj.gameEndTimestamp || 0,
            position: me.teamPosition || me.individualPosition || me.position || me.lane || stats.teamPosition || stats.lane || '',
            ...teamShareOf(gj.participants, me, k, a)
          });
        }
        const behavior = extractBehavior(Object.assign({}, me, { win }));
        if (behavior && behaviorSamples.length < 30) behaviorSamples.push({ behavior });
      }
    }
  } catch (e) { throw e; }
  // 成功但确实没有历史时只做短负缓存；网络/鉴权失败完全不缓存。
  const profile = { t: Date.now(), ttl: recent.length || teamGames.length ? SGP_RECENT_CACHE_TTL : 30000, recent, teamGames, behaviorSamples, flashPreference: summarizeFlashPreference(flashSamples) };
  sgpRecentCache.delete(key);          // 重新写入放到末尾 (最新)
  sgpRecentCache.set(key, profile);
  limitMapSize(sgpRecentCache, SGP_RECENT_CACHE_MAX);
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
    if (recent.length < 10) recent.push({
      // 1.5.76: LCU 兜底路径同样带上 gameId (raw 是原始 game 对象, normalizeGame 只留了 gid)
      gameId: raw.gameId || raw.gameIdString || game.gameId || game.gid || 0,
      champId: me.championId, win: !!me.win, k: me.k || 0, d: me.d || 0, a: me.a || 0,
      mode: game.mode, ts: game.time || 0,
      position: me.position || me.teamPosition || me.individualPosition || me.lane || '',
      ...teamShareOf(game.participants, me, me.k || 0, me.a || 0, { dmg: 'dmg', tank: 'dmgTaken', gold: 'gold', kills: 'k' })
    });
  }
  const profile = { t: Date.now(), ttl: recent.length || teamGames.length ? SGP_RECENT_CACHE_TTL : 30000, recent, teamGames, flashPreference: summarizeFlashPreference(flashSamples) };
  sgpRecentCache.delete(key);          // 重新写入放到末尾 (最新)
  sgpRecentCache.set(key, profile);
  limitMapSize(sgpRecentCache, SGP_RECENT_CACHE_MAX);
  return profile;
}
async function recentProfileFor(platformId, puuid, count = 30) {
  if (!isTencentPlatform(platformId)) return lcuProfileFor(platformId, puuid, count);
  // SGP 网关故障 (如 HTTP 503, 一故障就是几分钟) 期间组队推断/闪现偏好会整体失明:
  // SGP 失败或空数据时回退 LCU 战绩接口, 场次可能少一些但功能不至于整体失效。
  let sgpProfile = null;
  try {
    sgpProfile = await sgpProfileFor(platformId, puuid, count);
    if (sgpProfile.recent.length || sgpProfile.teamGames.length) return sgpProfile;
  } catch (e) { /* SGP 故障, 走 LCU 兜底 */ }
  try {
    const lcu = await lcuProfileFor(platformId, puuid, count);
    if (lcu.recent.length || lcu.teamGames.length) return lcu;
  } catch (e) { /* LCU 也不可用 */ }
  return sgpProfile || { t: Date.now(), ttl: 30000, recent: [], teamGames: [], flashPreference: null };
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
// 取 Live Client Data 的双方玩家。
//
// 2026-09-27 从 renderLiveFromGameflow 抽出：这一段是「问主进程要 live data」的
// 纯取数逻辑 —— 只依赖 phase 和 session 给的 parts, 只返回玩家数组 (或 null),
// 不碰 DOM、不写模块状态。主流程里紧跟着的「一个都没有就报错返回」仍留在调用点,
// 因为那要动 body/err。
//
// parts 在这里只用来判断"session 到底给没给数据": 兜底路径只在 session 为空时才走。
async function fetchLivePlayers(phase, parts) {
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
  return livePlayers;
}

// 把 live data / session 两路数据统一成内部 players 结构。
//
// 2026-09-27 从 renderLiveFromGameflow 抽出。原来这段散在主流程中间: 先建
// championId→puuid 映射, 再定义两个纯工具函数, 然后两个分支各拼一次对象 ——
// 读的时候得在主流程里来回跳。整块搬进来后, 只依赖入参和全局量。
//
// 注意: 两路都取不到时返回 undefined (不是空数组) —— 原实现就是这样,
// applyLoadingTeamFallback 对非数组原样返回, 调用方也没有判空分支。
function buildLivePlayers(livePlayers, parts, phase) {
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
        // Live Client Data 的 championName 是英文皮肤名 (如 "Yasuo"),
        // allChampions[].name 是中文, 先按英文 id 匹配, 中文名仅作兜底。
        const found = Object.values(allChampions).find(c =>
          (c.id || '').toLowerCase() === lp.championName?.toLowerCase() || c.name === lp.championName);
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
  return players;
}

// 作战计划条渲染到页头槽位; 没有阵容 (加载中/出错/不在对局) 时清空, 不留上一局的残留。
// 轮询每 4/12s 重入一次, 计划条内容通常不变 —— 无条件 innerHTML 会造成肉眼可见的闪烁,
// 所以内容相同时直接跳过写入。
let _liveHeadPanelHtml = '';
function setLiveHeadPanel(html) {
  const slot = document.getElementById('liveHeadSlot');
  if (!slot) return;
  const next = html || '';
  if (next === _liveHeadPanelHtml) return;
  _liveHeadPanelHtml = next;
  slot.innerHTML = next;
}

async function renderLiveFromGameflow(body, err, requestedPhase) {
  const renderToken = ++liveRenderToken;
  // 注意: 这里不再无条件清空页头计划条。轮询每 4/12s 重入一次, 先清空再等几百毫秒
  // 网络请求后重建, 计划条就会周期性消失又出现 —— 是"页面一直闪烁"的一半来源。
  // 清空点收敛到: 查不到对局数据 (下方 error 分支) 和 离开对局 (updateLivePage)。
  ensureChampMap();

  // 方式1: gameflow session (选人阶段有完整 puuid)
  const session = await lolAPI.lcuRequest("GET", "/lol-gameflow/v1/session");
  const queueId = session?.gameData?.queue?.id || session?.gameData?.queueId || 0;
  const queueMode = session?.gameData?.queue?.gameMode || session?.map?.gameMode || '';
  window.updateAutomationModeContext?.(queueId, queueMode);
  window._poroLiveModeContext = {
    queueId: Number(queueId) || 0,
    gameMode: String(queueMode || ''),
    label: QUEUE_NAMES?.[queueId] || MODE_NAMES?.[queueMode] || queueMode || '当前模式'
  };
  liveBalanceMode = isBalanceMode(session?.gameData?.queue?.id, session?.gameData?.queue?.gameMode || session?.map?.gameMode);
  if (liveBalanceMode) loadAramBalance().catch(() => {});
  liveTierMode = tierModeFor(session?.gameData?.queue?.id, session?.gameData?.queue?.gameMode || session?.map?.gameMode);
  if (liveTierMode) {
    // 强度榜加载完(首次或过期刷新)后重绘一次, 补上角标; 已加载时 loadModeTiers 直接命中缓存, 不会循环触发
    const tierMode = liveTierMode, had = modeTiers[tierMode]?.loadedAt || 0;
    loadModeTiers(tierMode).then(t => {
      if (t && t.loadedAt !== had && liveTierMode === tierMode && window._gameflowPhase) updateLivePage(window._gameflowPhase);
    }).catch(() => {});
  }
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

  // 取数见前面的 fetchLivePlayers()
  const livePlayers = await fetchLivePlayers(phase, parts);

  if (!parts.length && !livePlayers) {
    if (renderToken !== liveRenderToken) return;
    setLiveHeadPanel('');
    body.innerHTML = `<div class="msg-error">${err || '未获取到对局玩家数据'}</div>`;
    return;
  }

  // 组装见前面的 buildLivePlayers()
  const players = buildLivePlayers(livePlayers, parts, phase);
  // 缓存键同时包含当前阵容；即使 gameflow 暂时沿用旧 gameId，也不会命中上一局数据。
  const rosterKey = players.map(p => `${p.puuid || p.name || '?'}@${p.championId || 0}`).sort().join('|');
  key = `${session?.gameData?.gameId || phase}:${rosterKey}`;
  window.poroSession?.setGame(session?.gameData?.gameId || '', rosterKey);
  const sessionToken = window.poroSession?.token();
  const staleSession = () => renderToken !== liveRenderToken || (sessionToken && !window.poroSession?.isCurrent(sessionToken));
  // 遭遇统计键不能包含英雄或名字：英雄锁定、姓名补全、阶段切换都会刷新 rosterKey，
  // 若用它计数，同一局会被误算多次。gameId 缺失时仅退到稳定的 puuid 集合。
  const encounterRoster = players.map(p => p.puuid).filter(Boolean).sort().join(',');
  _currentGameKey = session?.gameData?.gameId
    ? `g:${session.gameData.gameId}`
    : `p:${encounterRoster.slice(0, 240)}`;
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
    // 定时刷新命中阵容缓存时也必须重建共同历史分组。旧实现只带 challengeId
    // 临时结果重绘，导致后台刚显示的“组1/组2”在下一轮刷新时立刻消失。
    const cachedProfiles = livePlayersCache.data.map(player => ({ teamGames: player.premadeTeamGames || [] }));
    const cachedInferred = inferPremadeGroups(livePlayersCache.data, cachedProfiles, 3);
    const cachedGroups = Object.keys(cachedInferred).length
      ? cachedInferred
      : (livePlayersCache.premadeGroups || premadeGroups);
    await renderLiveTeams(body, livePlayersCache.data, cachedGroups, renderToken);
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
  // 1.5.76: 记到玩家对象上 —— 详情浮窗要知道去哪台服务器拉这一局 (SGP 按 platformId 分片)
  if (platformId) for (const p of fullData) { if (!p.platformId) p.platformId = platformId; }

  // 立即缓存骨架数据, 让 updateLivePage 不阻塞 — SGP 拉取改为后台并发填充, 渲染时已有 recent 的玩家立刻显示
  // 只缓存 Live Client Data 完整双方(≥5人), 防止 session-only 数据污染缓存
  if (livePlayers && livePlayers.length >= 5) {
    livePlayersCache.key = key;
    livePlayersCache.data = fullData;
    livePlayersCache.premadeGroups = premadeGroups;
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
      // 与近期摘要一起留在阵容缓存中；即使本轮渲染令牌被下一次轮询取代，
      // 下一帧也能从已完成的共同历史继续推断，不必等十个人重新请求完。
      p.premadeTeamGames = Array.isArray(profile.teamGames) ? profile.teamGames : [];
      p.flashPreference = profile.flashPreference || null;
      p.behaviorSamples = Array.isArray(profile.behaviorSamples) ? profile.behaviorSamples : [];
      if (!staleSession()) updateLivePlayerRow(p, idx);  // 旧对局/旧账号的异步结果不得污染新阵容
      return profile;
    } catch (e) { return null; }
  });
  // 后台执行, 不阻塞骨架；战绩分批填充，全部到齐后按共同历史推断开黑组并刷新徽标。
  sgpLoad.then(async profiles => {
    const inferred = inferPremadeGroups(fullData, profiles.filter(Boolean), 3);
    const finalGroups = Object.keys(inferred).length ? inferred : premadeGroups;
    if (livePlayersCache.key === key) livePlayersCache.premadeGroups = finalGroups;
    if (staleSession()) return;
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

function liveThreatProfile(list) {
  const profile = { physical: 0, magic: 0, dive: 0, control: 0, sustain: 0, tanks: 0 };
  const sustainIds = new Set([16, 37, 40, 44, 117, 147, 201, 267, 350, 497, 526]);
  for (const player of list || []) {
    const data = champDataOfLive(player.championId) || {};
    const tags = data.tags || [];
    if (tags.includes('Marksman') || tags.includes('Assassin')) profile.physical += 2;
    if (tags.includes('Fighter')) profile.physical += 1;
    if (tags.includes('Mage')) profile.magic += 2;
    if (tags.includes('Support')) profile.magic += 1;
    if (tags.includes('Assassin') || tags.includes('Fighter')) profile.dive += 1;
    if (tags.includes('Tank') || tags.includes('Support') || tags.includes('Mage')) profile.control += 1;
    if (tags.includes('Tank')) profile.tanks += 1;
    if (tags.includes('Support') || sustainIds.has(Number(player.championId))) profile.sustain += 1;
  }
  return profile;
}

function liveContextAdvice(self, ownComp, enemyComp, enemyTeam) {
  if (!self) return { items: [], alternatives: [], runes: [], reasons: [], role: '未知位置', mode: window._poroLiveModeContext?.label || '当前模式' };
  const ownTags = champDataOfLive(self.championId)?.tags || [];
  const threat = liveThreatProfile(enemyTeam);
  const advice = [], alternatives = [], runes = [], reasons = [];
  const isMage = ownTags.includes('Mage'), isMarksman = ownTags.includes('Marksman'), isTank = ownTags.includes('Tank');
  if (threat.magic >= threat.physical + 2) {
    advice.push(isMage ? '女妖面纱' : isMarksman ? '玛莫提乌斯之噬' : '自然之力');
    alternatives.push(isTank ? '振奋盔甲' : '水银饰带');
    reasons.push('敌方魔法威胁明显更高');
    runes.push('抗性碎片优先魔抗');
  } else if (threat.physical >= threat.magic + 2) {
    advice.push(isMarksman ? '守护天使' : isMage ? '中娅沙漏' : '兰顿之兆');
    alternatives.push(isTank ? '冰霜之心' : '铁板靴');
    reasons.push('敌方物理与普攻威胁偏高');
    runes.push('抗性碎片优先护甲');
  }
  if (threat.control >= 3) {
    alternatives.push(isTank ? '水银之靴' : '水银饰带');
    runes.push('韧性 / 坚定优先');
    reasons.push('敌方控制链较长');
  }
  if (threat.dive >= 3) {
    alternatives.push(isMage ? '中娅沙漏' : isMarksman ? '守护天使' : '斯特拉克的挑战护手');
    runes.push('保命小符文优先于纯输出');
    reasons.push('敌方突进点较多');
  }
  if (threat.tanks >= 2 || enemyComp.frontline >= 3) {
    advice.push(isMage ? '虚空之杖' : isMarksman ? '多米尼克领主的致意' : '黑色切割者');
    reasons.push('敌方前排厚，需要提前准备穿透');
  }
  if (threat.sustain >= 2) {
    advice.push(isMage ? '莫雷洛秘典' : isTank ? '荆棘之甲' : '凡性的提醒');
    reasons.push('敌方回复与保护较多');
  }
  if (ownComp.frontline <= 1 && (isTank || ownTags.includes('Fighter'))) {
    alternatives.unshift('优先成型一件生存装');
    reasons.push('己方前排不足，你需要承担更多承伤');
  }
  const queueId = Number(window._poroLiveModeContext?.queueId) || 0;
  if ([450, 2400].includes(queueId)) {
    runes.push('大乱斗优先持续作战与续航');
    reasons.push('当前为单线团战模式，成装速度与持续作战权重更高');
  } else if (String(self.position || '').toUpperCase() === 'JUNGLE') {
    runes.push('打野优先第一轮资源节奏与移速');
    reasons.push('当前位置为打野，需要兼顾第一轮资源与支援效率');
  }
  const ownedNames = new Set((self.items || []).map(id => allItems?.[String(id)]?.name).filter(Boolean));
  return {
    items: [...new Set(advice)].filter(name => !ownedNames.has(name)).slice(0, 3),
    alternatives: [...new Set(alternatives)].filter(name => !ownedNames.has(name)).slice(0, 3),
    runes: [...new Set(runes)].slice(0, 3),
    reasons: [...new Set(reasons)].slice(0, 4),
    role: String(self.position || '未知位置').toUpperCase(),
    mode: window._poroLiveModeContext?.label || '当前模式'
  };
}

function liveItemAdvice(self, enemyComp, ownComp, enemyTeam) {
  return liveContextAdvice(self, ownComp || { frontline: 0 }, enemyComp, enemyTeam || []).items;
}

function buildLiveDecisionPanel(data, selfPuuid) {
  const blue = data.filter(p => p.team === 100 || p.team === '100');
  const red = data.filter(p => p.team === 200 || p.team === '200');
  if (!blue.length || !red.length) {
    window._poroCurrentDecision = '';
    return '';
  }
  const blueComp = liveTeamComposition(blue), redComp = liveTeamComposition(red);
  const total = Math.max(1, blueComp.readiness + redComp.readiness);
  const blueEdge = Math.round(blueComp.readiness / total * 100);
  const redEdge = 100 - blueEdge;
  const self = data.find(p => selfPuuid && p.puuid === selfPuuid) || data.find(p => p.name && window._myPuuid && p.puuid === window._myPuuid);
  const ownComp = self && (self.team === 200 || self.team === '200') ? redComp : blueComp;
  const enemyComp = ownComp === blueComp ? redComp : blueComp;
  const enemyTeam = ownComp === blueComp ? red : blue;
  const draft = window.PoroDraftCoach ? window.PoroDraftCoach.build(data, {
    selfTeam: self && +self.team === 200 ? 200 : 100,
    champOf: champOfLive
  }) : null;
  const contextAdvice = liveContextAdvice(self, ownComp, enemyComp, enemyTeam);
  const itemAdvice = contextAdvice.items;
  const phase = window._gameflowPhase || 'ChampSelect';
  const plan = phase === 'ChampSelect'
    ? (draft?.winCondition || '先确认阵容缺口，再围绕资源安排英雄选择。')
    : ownComp.frontline < enemyComp.frontline
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
  window._poroCurrentDecision = plan;
  const draftHtml = window.PoroDraftCoach ? window.PoroDraftCoach.render(draft) : '';
  window._poroLiveSnapshot = { data, selfPuuid, ownComp, enemyComp, phase };
  return `<details class="live-decision">
    <summary><b>本局作战计划</b><span class="ld-score blue">蓝 ${blueEdge}</span><span class="ld-score red">红 ${redEdge}</span><span class="ld-summary-plan">${escapeHtml(plan)}</span>${itemAdvice.length ? `<em>${escapeHtml(itemAdvice.join(' / '))}</em>` : ''}<i>展开</i></summary>
    <div class="ld-body">
      <div class="ld-head"><div><span>综合态势不是官方胜率，由阵容结构与玩家近期表现生成</span></div></div>
      ${draftHtml}
      <div class="ld-grid">${teamCard('蓝方', blueComp, blueEdge, 'blue')}${teamCard('红方', redComp, redEdge, 'red')}</div>
      <div class="ld-plan"><b>己方建议</b><span>${escapeHtml(plan)}</span>
        <div class="ld-context-grid">
          <section><small>${escapeHtml(contextAdvice.mode)} · ${escapeHtml(contextAdvice.role)}</small><strong>装备偏离</strong><p>${escapeHtml(itemAdvice.join(' / ') || '保持英雄常规核心装')}</p>${contextAdvice.alternatives.length ? `<em>备选：${escapeHtml(contextAdvice.alternatives.join(' / '))}</em>` : ''}</section>
          <section><small>按阵容调整</small><strong>符文方向</strong><p>${escapeHtml(contextAdvice.runes.join(' / ') || '保持熟悉的通用符文')}</p>${contextAdvice.reasons.length ? `<em>${escapeHtml(contextAdvice.reasons.join('；'))}</em>` : ''}</section>
        </div>
      </div>
      <div class="ld-ask"><label>问本局 <select onchange="answerLiveQuestion(this.value)"><option value="">选择一个问题…</option><option value="danger">谁最危险？</option><option value="fight">这波该不该打？</option><option value="win">我们怎么赢？</option><option value="weak">阵容短板是什么？</option></select></label><span id="liveQuestionAnswer"></span></div>
    </div>
  </details>`;
}

function answerLiveQuestion(question) {
  const out = document.getElementById('liveQuestionAnswer');
  const snap = window._poroLiveSnapshot;
  if (!out) return;
  if (!question || !snap) { out.textContent = ''; return; }
  const e = snap.enemyComp || { tags: {}, frontline: 0 };
  const o = snap.ownComp || { tags: {}, frontline: 0 };
  if (question === 'danger') {
    const p = snap.data.filter(x => +x.team && +x.team !== +((snap.data.find(y => y.puuid === snap.selfPuuid) || {}).team || 100)).sort((a, b) => (b.recent?.length || 0) - (a.recent?.length || 0))[0];
    out.textContent = p ? `优先关注 ${p.name || '对方核心'}：先看其装备和闪现，再决定是否接团。` : '敌方数据还不完整，先不要主动接战。';
  } else if (question === 'fight') {
    out.textContent = o.frontline >= e.frontline ? '可以在有视野和关键技能齐全时接团。' : '不建议正面先手，先清线、消耗并等对手犯错。';
  } else if (question === 'win') {
    out.textContent = window._poroCurrentDecision || '围绕兵线和下一条资源做准备，不要无视野接战。';
  } else {
    out.textContent = e.frontline >= 2 && e.tags?.Marksman + e.tags?.Mage >= 2 ? '对方前排和后排都完整，己方需要先处理突进或避免被长时间正面消耗。' : '对方阵容结构尚未完整，继续观察关键英雄和资源节奏。';
  }
}

// 加载最近 10 场；玩家卡高度固定，超出部分在卡片内部滚动，不挤出另一支队伍。
function recentLimit() {
  return 10;
}

// 战绩摘要文案: "近10场 6胜4负"。原先"近 N 场"单独占一行，并进来后玩家卡少一行，战绩区更高。
function liveRecordText(total, wins, emptyText) {
  return total ? `近${total}场 ${wins}胜${total - wins}负` : emptyText;
}

// 「展开全部战绩」: 默认两队挤在一屏内、战绩在卡片里滚动；展开后每人完整显示最近 10 场，页面整体滚动。
// 只切换 #page-live 上的样式类，不重绘，所以和实时刷新互不影响。
let liveRecentExpanded = false;
function syncLiveExpandButton(show) {
  const btn = document.getElementById('liveExpandBtn');
  if (!btn) return;
  if (typeof show === 'boolean') btn.hidden = !show;
  btn.textContent = liveRecentExpanded ? '收起战绩' : '展开全部战绩';
  btn.classList.toggle('is-selected', liveRecentExpanded);
  btn.setAttribute('aria-pressed', String(liveRecentExpanded));
}
function toggleLiveRecentExpanded(force) {
  liveRecentExpanded = typeof force === 'boolean' ? force : !liveRecentExpanded;
  document.getElementById('page-live')?.classList.toggle('live-expanded', liveRecentExpanded);
  syncLiveExpandButton();
  scheduleLiveRowAlignment();
}

// 战绩时间: "01-18 19:31"。SGP 给毫秒时间戳, LCU 也是; 缺失时返回空串, 不占位。
function formatMatchTime(ts) {
  const n = Number(ts);
  if (!n || !Number.isFinite(n)) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  const p2 = v => String(v).padStart(2, '0');
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// 单场战绩: 两行 —— 上「模式」、下「日期 + 胜/负」, 右侧独立一列放 KDA。
// 单行塞不下日期, 而日期是判断"最近状态是不是当前的"的关键 (连跪 3 场和 3 个月前连跪 3 场完全不同);
// 两行后 KDA 能单独成列右对齐, 竖着扫一遍就是一串等宽数字, 比夹在文字后面好读。
// 胜负靠整行微染 + 胜/负字标出, 颜色只做辅助, 不靠它单独承载信息。
function recentIcon(r, p) {
  const rc = champOfLive(r.champId);
  const isWin = r.win === true || r.win === 'Win';
  const mode = r.mode || '对局';
  const when = formatMatchTime(r.ts);
  // 1.5.76: 有 gameId 的卡可点 —— 点开显示这一局的完整详情浮窗。
  // 没 gameId (老缓存 / 某些模式) 就保持原来的静态卡片, 不给一个点了没反应的假按钮。
  const gid = r.gameId ? String(r.gameId) : '';
  const clickable = gid
    ? ` data-game-id="${escapeHtml(gid)}" data-puuid="${escapeHtml(p?.puuid || '')}"`
      + ` data-platform="${escapeHtml(p?.platformId || '')}"`
      + ` data-label="${escapeHtml(`${mode}${when ? ' ' + when : ''} · ${r.k}/${r.d}/${r.a} · ${isWin ? '胜' : '负'}`)}"`
      + ` onclick="openLiveMatchDetail(this)"`
    : '';
  return `<div class="ri-card ${isWin ? 'ri-win' : 'ri-loss'}${gid ? ' ri-clickable' : ''}"${clickable} title="${escapeHtml(mode)}${when ? ' ' + when : ''} ${r.k}/${r.d}/${r.a} ${isWin ? '胜' : '负'}${gid ? ' · 点击查看这一局详情' : ''}">
    <img src="${rc ? champImg(rc.id) : placeholder('?')}" ${rc ? champIconAttrs(rc.id, rc.name) : `onerror="this.src='${placeholder('?')}'"`}>
    <span class="ri-body">
      <span class="ri-mode">${escapeHtml(mode)}</span>
      <span class="ri-sub">${when ? `<span class="ri-date">${when}</span>` : ''}<span class="ri-result">${isWin ? '胜' : '负'}</span></span>
    </span>
    <span class="ri-kda">${r.k}/${r.d}/${r.a}</span>
  </div>`;
}

function livePlayerKey(p) {
  return String(p?.puuid || p?.name || `${p?.team || 0}:${p?.championId || 0}`);
}

const LIVE_ROLE_LABELS = { TOP: '上路', JUNGLE: '打野', MIDDLE: '中路', MID: '中路', BOTTOM: '下路', ADC: '下路', UTILITY: '辅助', SUPPORT: '辅助', NONE: '未识别' };
let liveDrawerFilters = { champion: 'all', role: 'all' };

function normalizeLiveRole(value) {
  const key = String(value || '').toUpperCase();
  return key === 'MID' ? 'MIDDLE' : key === 'ADC' ? 'BOTTOM' : key === 'SUPPORT' ? 'UTILITY' : (key || 'NONE');
}

function liveDrawerRecent(player) {
  return (player?.recent || []).filter(row => {
    if (liveDrawerFilters.champion !== 'all' && String(row.champId) !== liveDrawerFilters.champion) return false;
    if (liveDrawerFilters.role !== 'all' && normalizeLiveRole(row.position) !== liveDrawerFilters.role) return false;
    return true;
  });
}

function renderLivePlayerDrawer(player) {
  const body = document.getElementById('livePlayerDrawerBody');
  if (!body || !player) return;
  const recent = liveDrawerRecent(player);
  const allRecent = player.recent || [];
  const wins = recent.filter(row => row.win === true || row.win === 'Win').length;
  const kills = recent.reduce((sum, row) => sum + Number(row.k || 0), 0);
  const deaths = recent.reduce((sum, row) => sum + Number(row.d || 0), 0);
  const assists = recent.reduce((sum, row) => sum + Number(row.a || 0), 0);
  const kda = recent.length ? ((kills + assists) / Math.max(1, deaths)).toFixed(1) : '--';
  const champIds = [...new Set(allRecent.map(row => String(row.champId || '')).filter(Boolean))];
  const roles = [...new Set(allRecent.map(row => normalizeLiveRole(row.position)).filter(role => role !== 'NONE'))];
  const behavior = typeof deriveBehaviorTags === 'function' ? deriveBehaviorTags(player.behaviorSamples || []) : [];
  const currentChamp = champOfLive(player.championId);
  const heroCounts = allRecent.reduce((map, row) => map.set(String(row.champId), (map.get(String(row.champId)) || 0) + 1), new Map());
  const heroPool = [...heroCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, count]) => `${champOfLive(id)?.name || '未知英雄'} ${count}场`).join(' · ');
  const premade = player.premadeGroupId ? `本局识别为开黑组 ${player.premadeGroupId}；依据挑战组或近 30 场共同出场记录推断。` : '本局未发现达到阈值的共同出场证据。';
  const jungleText = normalizeLiveRole(player.position) === 'JUNGLE' || roles.includes('JUNGLE')
    ? `近期英雄池：${heroPool || '样本不足'}。打野样本 ${allRecent.filter(row => normalizeLiveRole(row.position) === 'JUNGLE').length} 场。`
    : `当前识别位置：${LIVE_ROLE_LABELS[normalizeLiveRole(player.position)] || player.position || '未知'}。近期英雄池：${heroPool || '样本不足'}。`;
  body.innerHTML = `<header class="lpd-head">
      <img src="${currentChamp ? champImg(currentChamp.id) : placeholder('?')}" ${currentChamp ? champIconAttrs(currentChamp.id, currentChamp.name) : ''}>
      <div><h2 id="livePlayerDrawerTitle">${escapeHtml(player.name || '未知玩家')}</h2><p>${escapeHtml(player.rank || '无段位')} · ${escapeHtml(currentChamp?.name || '英雄未识别')}</p></div>
      ${player.puuid ? `<button type="button" class="btn-secondary" onclick="searchPlayerByPuuid(${inlineArg(player.puuid)},${inlineArg(player.name || '')},null,{platformId:${inlineArg(player.platformId || '')}})">打开主页</button>` : ''}
    </header>
    <div class="lpd-stats"><span><b>${recent.length ? Math.round(wins / recent.length * 100) + '%' : '--'}</b><small>筛选胜率</small></span><span><b>${kda}</b><small>KDA</small></span><span><b>${recent.length}</b><small>有效样本</small></span><span><b>${player.flashPreference?.preferred || '--'}</b><small>闪现位置</small></span></div>
    <div class="lpd-filters">
      <label>英雄<select onchange="setLiveDrawerFilter('champion',this.value)"><option value="all">全部英雄</option>${champIds.map(id => `<option value="${escapeHtml(id)}"${liveDrawerFilters.champion === id ? ' selected' : ''}>${escapeHtml(champOfLive(id)?.name || id)}</option>`).join('')}</select></label>
      <label>位置<select onchange="setLiveDrawerFilter('role',this.value)"><option value="all">全部位置</option>${roles.map(role => `<option value="${role}"${liveDrawerFilters.role === role ? ' selected' : ''}>${escapeHtml(LIVE_ROLE_LABELS[role] || role)}</option>`).join('')}</select></label>
    </div>
    <section class="lpd-section"><h3>近期对局</h3><div class="lpd-recent">${recent.length ? recent.map(row => recentIcon(row, player)).join('') : '<p class="lpd-empty">当前筛选没有对局</p>'}</div></section>
    <div class="lpd-two-col">
      <section class="lpd-section"><h3>行为画像</h3>${behavior.length ? behavior.map(tag => `<div class="lpd-evidence"><b>${escapeHtml(tag.label)}</b><span>${escapeHtml(tag.detail)}</span></div>`).join('') : '<p class="lpd-empty">样本不足，暂不下结论</p>'}</section>
      <section class="lpd-section"><h3>组队证据</h3><p>${escapeHtml(premade)}</p></section>
    </div>
    <section class="lpd-section"><h3>英雄与位置倾向</h3><p>${escapeHtml(jungleText)}</p></section>`;
}

function openLivePlayerDrawer(event, key) {
  if (event?.target?.closest('button,select,a,.lp-name-link,.lp-mark,.ri-card,input,label')) return;
  const player = window._poroLivePlayerMap?.get(String(key));
  if (!player) return;
  window._poroLiveDrawerPlayer = player;
  liveDrawerFilters = { champion: 'all', role: 'all' };
  renderLivePlayerDrawer(player);
  const backdrop = document.getElementById('livePlayerDrawerBackdrop');
  if (backdrop) { backdrop.hidden = false; requestAnimationFrame(() => backdrop.classList.add('show')); }
  document.body.classList.add('live-drawer-open');
}

function closeLivePlayerDrawer() {
  const backdrop = document.getElementById('livePlayerDrawerBackdrop');
  if (!backdrop) return;
  backdrop.classList.remove('show');
  setTimeout(() => { if (!backdrop.classList.contains('show')) backdrop.hidden = true; }, 180);
  document.body.classList.remove('live-drawer-open');
}

function setLiveDrawerFilter(type, value) {
  if (type !== 'champion' && type !== 'role') return;
  liveDrawerFilters[type] = String(value || 'all');
  renderLivePlayerDrawer(window._poroLiveDrawerPlayer);
}

if (typeof window?.addEventListener === 'function') {
  window.addEventListener('keydown', event => { if (event.key === 'Escape') closeLivePlayerDrawer(); });
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

// 近 10 场「队内占比」标签: 伤害 / 承伤 / 经济 / 参团。
// 这排标签是玩家卡里唯一能说明"他是怎么赢的"的信息 —— 70% 胜率可能是被带飞,
// 也可能是每场打 30% 伤害 carry 出来的, 光看胜率和 KDA 分不开。
// 数据缺失时整排不渲染 (不占位), 所以国服某些模式取不到字段时卡片会自然收紧。
// 连胜 / 连败: 只看最近一段连续同结果, 2 场起才显示 (1 场不值得占一个标签位)。
// 这是 Poro 自己算的「势头」——胜率 60% 但正在 4 连败的人, 和刚 3 连胜的人不是一回事。
function liveStreak(recent) {
  const list = (recent || []).filter(r => r && typeof r.win === 'boolean');
  if (list.length < 2) return null;
  const first = list[0].win;
  let n = 0;
  for (const r of list) { if (r.win === first) n++; else break; }
  return n >= 2 ? { win: first, n } : null;
}

function liveMetricPills(recent, reservedSlots = 0) {
  const rs = (recent || []).filter(r => r && r.dmgPct != null);
  if (!rs.length) return '';
  const avg = f => {
    const v = rs.filter(r => r[f] != null);
    return v.length ? Math.round(v.reduce((s, r) => s + Number(r[f]), 0) / v.length) : null;
  };
  const items = [
    ['dmg', '伤害', avg('dmgPct'), '%', '队内伤害占比'],
    ['tank', '承伤', avg('tankPct'), '%', '队内承伤占比'],
    ['kp', '参团', avg('kp'), '%', '击杀参与率'],
    ['dmgGold', '伤转', avg('dmgGold'), '%', '伤害 / 经济, 越高说明钱花得越值'],
    ['gold', '经济', avg('goldPct'), '%', '队内经济占比'],
    ['vision', '视野', avg('vision'), '', '场均视野得分']
  ].filter(it => it[2] != null);
  if (!items.length) return '';
  const streak = liveStreak(recent);
  const streakHtml = streak
    ? `<span class="lp-metric lp-metric-${streak.win ? 'winstreak' : 'lossstreak'}" title="最近 ${streak.n} 场${streak.win ? '全胜' : '全负'}">${streak.n}${streak.win ? '连胜' : '连败'}</span>`
    : '';
  // 实时卡片优先给战绩留空间：默认只放 3 个最有辨识度的指标，
  // 其余指标仍保留在卡片里，通过“+更多”查看，避免标签换行吞掉战绩。
  const visibleCount = reservedSlots > 0 ? 2 : 3;
  const visible = items.slice(0, visibleCount);
  const hidden = items.slice(visibleCount);
  const visibleHtml = visible.map(([cls, label, val, unit, tip]) =>
    `<span class="lp-metric lp-metric-${cls}" title="近 ${rs.length} 场平均${tip}">${label}<b>${val}${unit}</b></span>`
  ).join('');
  const hiddenHtml = hidden.map(([cls, label, val, unit, tip]) =>
    `<span class="lp-metric lp-metric-${cls} lp-extra-metric" title="近 ${rs.length} 场平均${tip}">${label}<b>${val}${unit}</b></span>`
  ).join('');
  const moreHtml = hidden.length
    ? `<button class="lp-tags-more" type="button" title="展开其余队内指标" aria-label="展开其余队内指标" onclick="this.closest('.lp-row').classList.toggle('lp-tags-open'); this.textContent=this.closest('.lp-row').classList.contains('lp-tags-open')?'收起':'+' + this.dataset.count; scheduleLiveRowAlignment()" data-count="${hidden.length}">+${hidden.length}</button>`
    : '';
  return streakHtml + visibleHtml + moreHtml + `<span class="lp-extra-metrics">${hiddenHtml}</span>`;
}

// 概览行的 KDA 用「大数字 + 小标签」，与胜率形成一对主指标。
// 首次渲染与局部刷新 (updateLivePlayerRow) 必须共用这一个结构，否则刷新会把排版冲掉。
function liveKdaHtml(kda) {
  return `<b>${escapeHtml(String(kda))}</b><em>KDA</em>`;
}
function updateLivePlayerRow(p, idx) {
  const key = livePlayerKey(p);
  window._poroLivePlayerMap?.set(key, p);
  const rows = [...document.querySelectorAll('.lp-row')];
  // idx 兜底仅对没有 puuid 的条目 (BOT/名字未补全) 开放: 有 puuid 时按下标写
  // 可能在队伍分组变化后把战绩写到别的玩家卡上, 宁可等下一次全量重绘。
  const row = rows.find(el => el.dataset.playerKey === key)
    || (!p?.puuid && rows[idx] ? rows[idx] : null);
  if (!row) return;
  const c = champOfLive(p.championId);
  const recentHtml = p.recent.length ? p.recent.slice(0, recentLimit()).map(r => recentIcon(r, p)).join('') : '<span class="ri-empty">无数据</span>';
  const wins = p.recent.filter(r => r.win === true || r.win === "Win").length;
  const totK = p.recent.reduce((s, r) => s + r.k, 0), totD = p.recent.reduce((s, r) => s + r.d, 0), totA = p.recent.reduce((s, r) => s + r.a, 0);
  const kda = p.recent.length ? ((totK + totA) / Math.max(1, totD)).toFixed(1) : '--';
  const recentEl = row.querySelector('.lp-recent');
  const flashEl = row.querySelector('.lp-flash-slot');
  const winRateEl = row.querySelector('.lp-winrate');
  const kdaEl = row.querySelector('.lp-kda');
  if (recentEl) recentEl.innerHTML = recentHtml;
  if (flashEl) flashEl.innerHTML = flashPreferenceHtml(p.flashPreference);
  if (winRateEl) {
    const winRate = p.recent.length ? Math.round(wins / p.recent.length * 100) : null;
    winRateEl.textContent = winRate == null ? '--' : `${winRate}%`;
    winRateEl.classList.toggle('positive', winRate != null && winRate >= 50);
  }
  if (kdaEl) kdaEl.innerHTML = liveKdaHtml(kda);
  scheduleLiveRowAlignment();
}

// 卡片可用高度经常不是战绩行高的整数倍。把滚动区收敛到完整行，
// 避免底部露出半条记录；10 场数据、滚动与展开模式都保持不变。
function scheduleLiveRowAlignment() {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(alignLiveRecentRows);
  else alignLiveRecentRows();
}
function alignLiveRecentRows() {
  const page = document.getElementById('page-live');
  document.querySelectorAll('#page-live .lp-recent').forEach(list => {
    list.style.removeProperty('height');
    list.style.removeProperty('flex');
    list.style.removeProperty('margin-bottom');
    if (page?.classList.contains('live-expanded')) return;
    const first = list.querySelector('.ri-card');
    if (!first) return;
    const available = list.clientHeight;
    const rowHeight = first.getBoundingClientRect().height;
    const computed = getComputedStyle(list);
    const gap = parseFloat(computed.rowGap || computed.gap) || 0;
    const step = rowHeight + gap;
    const visible = Math.max(1, Math.floor((available + gap) / step));
    const exact = visible * step - gap;
    if (exact > 0 && exact < available - 0.5) {
      list.style.flex = '0 1 auto';
      list.style.height = `${exact}px`;
      list.style.marginBottom = `${Math.max(0, available - exact)}px`;
    }
  });
}

// 选人期对手情报: 复用已拉到的近期战绩, 聚合出"对手在玩什么"和一条 ban 建议。
// 只在选人阶段显示 —— 那时 ban 还有意义; 进对局后再看只是噪音。
function enemyIntelHtml(data, selfPuuid) {
  if (!window.PoroEnemyIntel) return '';
  if (window._gameflowPhase !== 'ChampSelect') return '';
  const norm = t => (t === 100 || t === '100') ? 100 : (t === 200 || t === '200') ? 200 : 0;
  const self = (selfPuuid && data.find(p => p.puuid === selfPuuid)) || null;
  const selfTeam = self ? norm(self.team) : 0;
  if (!selfTeam) return '';
  try {
    const intel = window.PoroEnemyIntel.build(data, {
      selfTeam,
      champName: id => (champOfLive(id) || {}).name || ''
    });
    return window.PoroEnemyIntel.render(intel);
  } catch (e) {
    console.warn('[enemy-intel]', e && e.message);
    return '';
  }
}

async function renderLiveTeams(body, data, premadeGroups, expectedToken) {
  checkBlacklist(data);
  let selfPuuid = null;
  try { const st = await lolAPI.lcuStatus(); selfPuuid = st.summoner?.puuid; } catch(e) {}
  if (expectedToken != null && expectedToken !== liveRenderToken) return;
  window._poroLivePlayerMap = new Map(data.map(player => {
    player.premadeGroupId = premadeGroups && player.puuid ? premadeGroups[player.puuid] : null;
    return [livePlayerKey(player), player];
  }));
  // 每次姓名补全后都允许重试；addEncounter 内部按 gameKey 持久去重，既不会漏记
  // 首次为空、稍后才解析出的姓名，也不会因实时页重复刷新而虚增次数。
  const seen = new Set();
  for (const p of data) {
    if (!p.puuid || !isKnownPlayerName(p.name) || seen.has(p.puuid)) continue;
    if (selfPuuid && p.puuid === selfPuuid) continue;
    seen.add(p.puuid);
    addEncounter(p.puuid, p.name, _currentGameKey);
  }
  const playerRow = p => {
    const c = champOfLive(p.championId);
    const recentHtml = p.recent.length ? p.recent.slice(0, recentLimit()).map(r => recentIcon(r, p)).join('') : '<span class="ri-loading">加载中...</span>';
    const wins = p.recent.filter(r => r.win === true || r.win === "Win").length;
    const totK = p.recent.reduce((s, r) => s + r.k, 0), totD = p.recent.reduce((s, r) => s + r.d, 0), totA = p.recent.reduce((s, r) => s + r.a, 0);
    const kda = p.recent.length ? ((totK + totA) / Math.max(1, totD)).toFixed(1) : '--';
    const name = p.name || nameCache[p.puuid] || '未知';
    const isSelf = selfPuuid && p.puuid === selfPuuid;
    const tag = isSelf ? '<span class="lp-self-tag">自己</span>' : '';
    const premadeGroupId = premadeGroups && p.puuid ? premadeGroups[p.puuid] : null;
    const premadeTag = premadeGroupId ? `<span class="lp-premade" title="该玩家与本队其他成员有共同对局，推断为开黑组 ${premadeGroupId}">组${premadeGroupId}</span>` : '';
    const marksHtml = !isSelf && p.puuid ? `<span class="lp-mark" onclick="showMarkModal(${inlineArg(p.puuid)},${inlineArg(name)})" title="标记该玩家">${poroIcon('pin')}</span>${getPlayerMarksHtml(p.puuid)}` : '';
    const winRate = p.recent.length ? Math.round(wins / p.recent.length * 100) : null;
    const risk = deriveRiskProfile(p.recent);
    // 实时卡片不显示“近期稳定 / 需要观察”画像标签，避免和队内指标标签争夺空间。
    const riskHtml = '';
    // 大乱斗/海斗: 英雄平衡性调整徽标 (balance.js; 1.5.0 的半成品已补全)
    const balanceHtml = (liveBalanceMode ? balanceBadgeHtml(p.championId) : '') + (liveTierMode ? modeTierBadgeHtml(liveTierMode, p.championId) : '');
    const behaviorHtml = behaviorTagsHtml(p.behaviorSamples);
    const reservedSlots = (premadeTag ? 1 : 0) + (behaviorHtml ? 1 : 0);
    const pills = `${premadeTag}${riskHtml}${liveMetricPills(p.recent, reservedSlots)}${behaviorHtml}`;
    const recordSummary = liveRecordText(p.recent.length, wins, '近期战绩加载中');
    const inlineStats = `<span class="lp-inline-stats" title="${escapeHtml(recordSummary)}"><span class="lp-winrate${winRate != null && winRate >= 50 ? ' positive' : ''}">${winRate == null ? '--' : winRate + '%'}</span><span class="lp-kda">${liveKdaHtml(kda)}</span></span>`;
    const profileClick = p.puuid
      ? ` onclick="event.stopPropagation();searchPlayerByPuuid(${inlineArg(p.puuid)},${inlineArg(name)},null,{platformId:${inlineArg(p.platformId || '')}})" role="button" tabindex="0"`
      : '';
    const drawerKey = livePlayerKey(p);
    return `<div class="lp-row${isSelf ? ' lp-self' : ''}" data-player-key="${escapeHtml(drawerKey)}" onclick="openLivePlayerDrawer(event,${inlineArg(drawerKey)})" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openLivePlayerDrawer(event,${inlineArg(drawerKey)})}">
      <div class="lp-card-head">
        <img class="lp-champ" src="${c ? champImg(c.id) : placeholder('?')}" ${c ? champIconAttrs(c.id, c.name) : `onerror="this.src='${placeholder('?')}'"`}>
        <div class="lp-info">
          <div class="lp-identity">
            <div class="lp-name-line"><span class="lp-name lp-name-link" title="点击查看 ${escapeHtml(name)} 的主页"${profileClick}>${escapeHtml(name)}</span>${tag}${balanceHtml}${marksHtml}</div>
            <div class="lp-rank">${escapeHtml(p.rank || '无段位')} <span class="lp-flash-slot">${flashPreferenceHtml(p.flashPreference)}</span></div>
          </div>
          ${inlineStats}
        </div>
      </div>
      <div class="lp-profile-line">${pills}</div>
      <div class="lp-recent">${recentHtml}</div>
    </div>`;
  };
  const isBlue = p => p.team === 100 || p.team === "100";
  const isRed = p => p.team === 200 || p.team === "200";
  const blue = data.filter(isBlue), red = data.filter(isRed), unknown = data.filter(p => !isBlue(p) && !isRed(p));
  // 空位占位: 数据没到 / 人数不足时也保持 5 列形状，避免半屏空白看起来像页面坏了
  const emptySlot = () => '<div class="lp-row lp-empty"><span>等待数据</span></div>';
  const teamPanel = (list, label, cls, withExpand) => {
    const matches = list.reduce((sum, p) => sum + p.recent.length, 0);
    const wins = list.reduce((sum, p) => sum + p.recent.filter(r => r.win === true || r.win === 'Win').length, 0);
    const kills = list.reduce((sum, p) => sum + p.recent.reduce((n, r) => n + r.k, 0), 0);
    const deaths = list.reduce((sum, p) => sum + p.recent.reduce((n, r) => n + r.d, 0), 0);
    const assists = list.reduce((sum, p) => sum + p.recent.reduce((n, r) => n + r.a, 0), 0);
    const rate = matches ? Math.round(wins / matches * 100) : null;
    const kda = matches ? ((kills + assists) / Math.max(1, deaths)).toFixed(2) : null;
    const summary = matches
      ? `<span class="lp-team-rate${rate >= 50 ? ' positive' : ''}">${rate}%</span><span class="lp-team-kda">KDA <b>${kda}</b></span>`
      : '<span class="lp-team-kda">战绩加载中</span>';
    const slots = Math.max(0, 5 - list.length);
    // 「展开全部战绩」放在队伍标题栏最右端: 页头那一行已经去掉 (标题纯占高度),
    // 而这个开关只管战绩列表的展开, 贴在列表上方的队伍栏里正好, 且不额外占一行高度。
    const expandBtn = withExpand
      ? '<button type="button" class="lp-expand-btn" id="liveExpandBtn" onclick="toggleLiveRecentExpanded()"' +
        ' title="默认让两队挤在一屏内，每人只露出几场；展开后每人完整显示最近 10 场，页面可滚动">展开全部战绩</button>'
      : '';
    return `<section class="lp-team ${cls}">
      <div class="lp-team-head"><i class="lp-team-dot"></i><strong>${label}</strong>${summary}<span class="lp-team-count">${list.length} 名玩家</span>${expandBtn}</div>
      <div class="lp-team-grid">${list.map(playerRow).join('')}${Array.from({ length: slots }, emptySlot).join('')}</div>
    </section>`;
  };
  // 数据不完整时 buildLiveDecisionPanel 返回空串，避免“对局准备”占用顶部整行。
  // 双方阵容齐全时仍保留作战计划入口。
  setLiveHeadPanel(buildLiveDecisionPanel(data, selfPuuid));
  const pageHtml = `
    ${enemyIntelHtml(data, selfPuuid)}
    <div class="lp-wrap">${teamPanel(blue, '蓝方', 'lp-blue', true)}${teamPanel(red, '红方', 'lp-red')}${unknown.length ? teamPanel(unknown, '队伍识别中', 'lp-unknown') : ''}</div>`;
  // 轮询每 4/12s 带着同样一份数据重入: 生成的 HTML 与当前页面一致时直接跳过,
  // 不再拆掉整个 DOM 重建 (重建会让全部头像重载、滚动位置归零 —— 表现为整页闪烁)。
  // 渲染是纯确定性的 (无时间戳/随机值), 字符串比对可靠; 数据真变了自然不相等。
  if (body.innerHTML !== pageHtml) body.innerHTML = pageHtml;
  scheduleLiveRowAlignment();
  // F9 战报浮窗: 选人阶段为浮窗准备数据 (进对局后浮窗随时可呼出)
  pushGameLiveBoard(data, premadeGroups);
  updateChampSelectCounterHint(data);
  syncLiveExpandButton(true);
}

if (typeof window?.addEventListener === 'function') {
  window.addEventListener('resize', scheduleLiveRowAlignment);
}
// ---------- F9 对局战报浮窗: 数据准备 (推送紧凑版 10 人摘要) ----------
let _gameLiveBoardKey = '';
function pushGameLiveBoard(data, premadeGroups) {
  if (window._gameflowPhase !== 'InProgress' && window._gameflowPhase !== 'GameStart' && window._gameflowPhase !== 'ChampSelect') return;
  if (!lolAPI.gameLivePush || !Array.isArray(data) || !data.length) return;
  try {
    // premadeGroups 是 puuid -> gid (gid 形态不定), 按首次出现顺序编成 开黑1/开黑2
    const groupLabel = {};
    let gi = 0;
    for (const p of data) {
      const gid = premadeGroups && p.puuid ? premadeGroups[p.puuid] : null;
      if (!gid) continue;
      if (!groupLabel[gid]) groupLabel[gid] = '开黑' + (++gi);
    }
    ensureChampMap();
    const players = data.map(p => {
      const c = champOfLive(p.championId);
      const wins = p.recent.filter(r => r.win === true || r.win === 'Win').length;
      const flash = p.flashPreference
        ? (p.flashPreference.inconsistent ? '闪现混乱' : (p.flashPreference.preferred || (p.flashPreference.d ? 'D' : 'F') || '') + '闪')
        : '';
      return {
        team: p.team === 200 || p.team === '200' ? 200 : 100,
        name: p.name || nameCache[p.puuid] || '未知',
        champKey: c ? c.id : '',
        champName: c ? c.name : '',
        isSelf: !!(p.puuid && p.puuid === (window._myPuuid || '')),
        isBot: !!p.isBot,
        games: p.recent.length,
        wins,
        k: p.recent.reduce((s, r) => s + r.k, 0),
        d: p.recent.reduce((s, r) => s + r.d, 0),
        a: p.recent.reduce((s, r) => s + r.a, 0),
        flash, rank: p.rank || '',
        premade: p.puuid && groupLabel[premadeGroups && premadeGroups[p.puuid]] || ''
      };
    });
    const key = players.map(p => [p.name, p.champKey, p.games, p.wins, p.premade].join(':')).join('|');
    if (key === _gameLiveBoardKey) return;   // 数据没变不重复推
    _gameLiveBoardKey = key;
    lolAPI.gameLivePush({ players, ddragonVersion: (typeof version !== 'undefined' && version) || '' });
  } catch (e) { try { lolAPI.debugLog('[GAME LIVE] push error: ' + (e?.message || e)); } catch (e2) {} }
}

// ---------- 选人克制提醒: 我的锁定英雄 vs 敌方已锁定英雄 ----------
let _counterHintKey = '';
function updateChampSelectCounterHint(data) {
  if (window._gameflowPhase !== 'ChampSelect') return;
  const area = document.getElementById('liveGameArea');
  if (!area || typeof calcCounterData !== 'function') return;
  let strip = document.getElementById('csCounterHint');
  try {
    const me = data.find(p => p.puuid && p.puuid === window._myPuuid);
    const myChampId = me && me.championId ? +me.championId : 0;
    const enemies = data
      .filter(p => p.championId && p.team !== (me ? me.team : null))
      .map(p => +p.championId);
    if (!myChampId || !enemies.length) {
      if (strip) strip.remove();
      _counterHintKey = '';
      return;
    }
    const key = myChampId + ':' + enemies.slice().sort((a, b) => a - b).join(',');
    if (key === _counterHintKey && strip) return;
    _counterHintKey = key;
    ensureChampMap();
    const cData = calcCounterData(myChampId);
    const pick = list => (list || [])
      .filter(t => enemies.includes(+t.id))
      .slice(0, 4)
      .map(t => {
        const ck = champNumMap?.[String(t.id)];
        return ck ? '<span class="ch-champ">' + escapeHtml(ck.name) + ' <i>' + (t.wr * 100).toFixed(0) + '%</i></span>' : '';
      })
      .filter(Boolean);
    const threats = pick(cData ? cData.threats : []);
    const preys = pick(cData ? cData.preys : []);
    const myName = champNumMap?.[String(myChampId)]?.name || '';
    const html = (threats.length ? '<span class="ch-sec danger">⚠ 克制 ' + escapeHtml(myName) + ':</span>' + threats.join('')
      + (preys.length ? '<span class="ch-sec sep"></span>' : '') : '')
      + (preys.length ? '<span class="ch-sec good">✦ 你克制:</span>' + preys.join('') : '');
    if (!html) { if (strip) strip.remove(); return; }
    if (!strip) {
      strip = document.createElement('div');
      strip.id = 'csCounterHint';
      strip.className = 'counter-hint';
      area.prepend(strip);
    }
    strip.innerHTML = html;
  } catch (e) { try { lolAPI.debugLog('[COUNTER HINT] ' + (e?.message || e)); } catch (e2) {} }
}

async function updateLivePage(phase) {  const startedAt = performance.now();
  const body = document.getElementById("liveGameArea");
  if (!body) return;
  const gpEl = document.getElementById("gameflowPhase"); if (gpEl) gpEl.textContent = PHASE_TEXT[phase] || phase || "未知";
  if (phase !== "InProgress" && phase !== "ChampSelect" && phase !== "PRACTICETOOL" && phase !== "GameStart") {
    // 离开对局, 清除选人缓存
    champSelectParticipants = null;
    livePlayersCache.key = '';
    livePlayersCache.data = null;
    livePlayersCache.premadeGroups = null;
    liveRenderToken++;
    setLiveHeadPanel('');
    window._poroLiveSnapshot = null;
    window._poroCurrentDecision = '';
    body.innerHTML = '<div class="meta-loading">当前不在对局中。进入游戏后此处显示: 双方阵容、玩家战绩/段位、游戏时间、大龙/小龙/Buff 倒计时</div>';
    syncLiveExpandButton(false);
    return;
  }
  // 所有阶段都显示玩家战绩; 加载界面数据未就绪时给出等待提示 (轮询会持续重试)
  try {
    await renderLiveFromGameflow(body, phase === "GameStart" ? "对局加载中, 玩家数据拉取中..." : null, phase);
  } finally {
    // 没有阵容 (加载中/出错/训练模式提示) 时不显示「展开全部战绩」，避免一个不起作用的按钮
    syncLiveExpandButton(!!body.querySelector('.lp-wrap'));
    window.poroPerf?.record('live.render', performance.now() - startedAt, { phase: phase || '' });
  }
}
const PHASE_TEXT = { None: "无", Lobby: "房间中", Matchmaking: "匹配中", ReadyCheck: "匹配确认", ChampSelect: "选人中", GameStart: "对局开始", InProgress: "对局进行中", WaitingForStats: "对局结束统计", EndOfGame: "对局结束", TerminatedInError: "异常退出" };

// ===== 1.5.76: 实时页「单场战绩详情」浮窗 =====
// 以前实时页的近期战绩卡只是"看着有信息": 想知道那局到底怎么赢/怎么输的, 只能等打完
// 再去战绩页一局一局翻。这里给每张卡挂一个详情浮窗 —— 点哪局看哪局, 不用离开当前页。
//
// 数据链复用战绩页那一套, 不另写一份渲染:
//   sgpGameSummary(platformId, gameId) → normalizeGame → resolveNames/Ranks
//   → renderOpggGameDetail (hex.js)
// 国服走 SGP, 其他服/失败回退 LCU /lol-match-history/v1/games/{gameId}。
// 渲染结果按 gameId 缓存: 同一局反复点不再打接口 (详情页一局 10 人, 请求不便宜)。
let liveMatchPopEl = null;
let _lmpSeq = 0;                          // 连续点不同卡时, 只让最后一次的结果落地
let _lmpDismissBound = false;
const liveMatchDetailCache = new Map();   // gameId -> 渲染好的 HTML
const LMP_CACHE_MAX = 40;

function ensureLiveMatchPop() {
  if (liveMatchPopEl && document.body.contains(liveMatchPopEl)) return liveMatchPopEl;
  const el = document.createElement('div');
  el.id = 'liveMatchPop';
  el.className = 'lmp';
  el.hidden = true;
  el.innerHTML = '<div class="lmp-head">'
    + '<span class="lmp-title">对局详情</span>'
    + '<span class="lmp-hint">Esc 关闭</span>'
    + '<button type="button" class="lmp-close" title="关闭">×</button>'
    + '</div><div class="lmp-body"></div>';
  el.querySelector('.lmp-close').addEventListener('click', closeLiveMatchPop);
  document.body.appendChild(el);
  liveMatchPopEl = el;
  bindLiveMatchPopDismiss();
  return el;
}

function closeLiveMatchPop() {
  if (!liveMatchPopEl) return;
  liveMatchPopEl.hidden = true;
  liveMatchPopEl.classList.remove('lmp-open');
}

// 浮窗跟着被点的那张卡: 优先放右边, 右边放不下放左边, 再不行就压着卡片对齐。
// 竖向夹在视口内 —— 战绩卡可能在页面底部, 直接往下弹会被切掉一半。
function placeLiveMatchPop(el, rect) {
  const pad = 10;
  const w = el.offsetWidth || 880;
  const h = el.offsetHeight || 420;
  let left = rect.right + pad;
  if (left + w > window.innerWidth - pad) left = rect.left - w - pad;
  if (left < pad) left = Math.max(pad, window.innerWidth - w - pad);
  let top = rect.top - 40;
  if (top + h > window.innerHeight - pad) top = window.innerHeight - h - pad;
  if (top < pad) top = pad;
  el.style.left = Math.round(left) + 'px';
  el.style.top = Math.round(top) + 'px';
}

// 取一局的完整数据 (10 人统计), 统一成 normalizeGame 的结构
async function fetchLiveMatchNorm(gameId, platformId) {
  let pid = platformId;
  if (!pid) { try { pid = await getPlatformId(); } catch (e) { pid = ''; } }
  if (pid && isTencentPlatform(pid)) {
    try {
      const resp = await lolAPI.sgpGameSummary(pid, gameId);
      if (resp && !resp.__error) {
        const g = resp.json || resp;
        if (g && Array.isArray(g.participants) && g.participants.length) return normalizeGame(g, true);
      }
    } catch (e) { /* SGP 挂了走 LCU */ }
  }
  try {
    const d = await lolAPI.lcuRequest('GET', `/lol-match-history/v1/games/${gameId}`);
    const g = (d && d.games && d.games.games && d.games.games[0]) || d;
    if (g && Array.isArray(g.participants) && g.participants.length) return normalizeGame(g, false);
  } catch (e) { /* 两个源都没拿到 */ }
  return null;
}

async function openLiveMatchDetail(cardEl) {
  if (!cardEl) return;
  const gameId = cardEl.getAttribute('data-game-id') || '';
  if (!gameId) return;
  const platformId = cardEl.getAttribute('data-platform') || '';
  const label = cardEl.getAttribute('data-label') || '对局详情';

  const pop = ensureLiveMatchPop();
  const bodyEl = pop.querySelector('.lmp-body');
  const titleEl = pop.querySelector('.lmp-title');
  titleEl.textContent = label;
  pop.hidden = false;
  pop.classList.add('lmp-open');

  // 缓存命中: 直接贴, 不闪加载态
  const cached = liveMatchDetailCache.get(gameId);
  if (cached) {
    bodyEl.innerHTML = cached;
    placeLiveMatchPop(pop, cardEl.getBoundingClientRect());
    return;
  }

  bodyEl.innerHTML = '<div class="lmp-loading">正在拉取这一局的详情…</div>';
  placeLiveMatchPop(pop, cardEl.getBoundingClientRect());
  const seq = ++_lmpSeq;
  try {
    const norm = await fetchLiveMatchNorm(gameId, platformId);
    if (seq !== _lmpSeq) return;                       // 用户已经点了别的卡
    if (!norm) { bodyEl.innerHTML = '<div class="lmp-error">这一局的详情暂时取不到（对局记录可能已过期）</div>'; return; }
    // 名字/段位: 与战绩页同源。空名字不补的话详情里会出现一排空白
    try {
      const all = (norm.participants || []).map(p => p.puuid).filter(Boolean);
      const emptyNames = (norm.participants || [])
        .filter(p => p.puuid && (!p.name || hasBrokenText(p.name))).map(p => p.puuid);
      if (emptyNames.length) {
        await resolveNames(emptyNames);
        for (const p of norm.participants) {
          if ((!p.name || hasBrokenText(p.name)) && nameCache[p.puuid]) p.name = nameCache[p.puuid];
        }
      }
      await resolveRanks(all);
    } catch (e) { /* 名字/段位缺失不影响主体统计 */ }
    if (seq !== _lmpSeq) return;
    const holder = document.createElement('div');
    renderOpggGameDetail(norm, holder);
    // 详情里有两块在浮窗场景下没意义:
    //  · 「保存战报卡」按钮 —— 它的点击是在 renderOpggGameDetail 里绑到 holder 上的,
    //    我们只取 innerHTML, 拿出来的按钮没有监听器, 点了没反应;
    //  · 「组队关系识别中…」占位 —— 它靠 applyMatchPremadeBadges 收尾, 这里没算组队,
    //    留着就是一句永远不消失的"识别中"。
    holder.querySelector('.ogd-actions')?.remove();
    holder.querySelector('[data-party-summary]')?.remove();
    const html = holder.innerHTML || '<div class="lmp-error">这一局没有可展示的数据</div>';
    liveMatchDetailCache.set(gameId, html);
    if (liveMatchDetailCache.size > LMP_CACHE_MAX) {
      liveMatchDetailCache.delete(liveMatchDetailCache.keys().next().value);
    }
    bodyEl.innerHTML = html;
    placeLiveMatchPop(pop, cardEl.getBoundingClientRect());
  } catch (e) {
    if (seq !== _lmpSeq) return;
    bodyEl.innerHTML = '<div class="lmp-error">详情渲染失败: ' + escapeHtml(e && e.message ? e.message : String(e)) + '</div>';
  }
}

// Esc 关闭 + 点空白处关闭。点另一张战绩卡不算"空白" —— 那是要换一局看。
// 挂在**首次打开浮窗时**, 不做顶层副作用: 这个功能没用过就一个监听器都不该占,
// 单测里也不会因为 document 没有 addEventListener 就整个文件加载失败。
function bindLiveMatchPopDismiss() {
  if (_lmpDismissBound) return;
  _lmpDismissBound = true;
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && liveMatchPopEl && !liveMatchPopEl.hidden) closeLiveMatchPop();
  });
  document.addEventListener('mousedown', e => {
    if (!liveMatchPopEl || liveMatchPopEl.hidden) return;
    if (liveMatchPopEl.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.ri-card[data-game-id]')) return;
    closeLiveMatchPop();
  });
  window.addEventListener('resize', () => closeLiveMatchPop());
}

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
