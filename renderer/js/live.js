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
  const dmgAll = total(K.dmg);
  const dmgPct = pct(dmg, dmgAll);
  if (dmgPct == null) return {};
  const teamKills = total(K.kills);
  // 1.5.139: 击杀伤害效率 (Akari 同款公式) = 击杀占比 ÷ 伤害占比。
  // 1.0 = 我的击杀份额和伤害份额持平; >1 说明拿头效率高于输出贡献 (收头型),
  // <1 说明输出打了不少但人头被队友收走 (工具人/补伤位)。纯 summary 可算, 零额外请求。
  const kde = teamKills > 0 && dmg > 0 && dmgAll > 0
    ? Math.round(((k / teamKills) / (dmg / dmgAll)) * 100) / 100
    : null;
  return {
    dmgPct,
    tankPct: pct(num(me, K.tank), total(K.tank)),
    goldPct: pct(gold, total(K.gold)),
    kp: teamKills > 0 ? Math.round(((k + a) / teamKills) * 100) : null,
    // 伤转率 = 伤害 / 经济。同样是 20% 经济占比, 打出 180% 伤转和 90% 伤转是两种人。
    dmgGold: gold > 0 ? Math.round((dmg / gold) * 100) : null,
    vision: num(me, K.vision) || null,
    kde
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
        if (recent.length < 20) {
          const k = stats.kills ?? me.kills ?? 0, d = stats.deaths ?? me.deaths ?? 0, a = stats.assists ?? me.assists ?? 0;
          // 1.5.139: 单杀次数 (Akari 同源字段 challenges.soloKills); 字段缺失记 null 而不是 0,
          // 否则少数没有该字段的模式会把场均单杀拉低成假数据。
          const soloRaw = stats.challenges?.soloKills ?? me.challenges?.soloKills;
          recent.push({
            // 1.5.76: 带上 gameId, 实时页点这张卡才能按需拉这一局的完整详情
            gameId: gj.gameId || gj.gameID || gj.gameUuid || gj.gameUUID || 0,
            champId: normalizeChampId(me.championId || stats.championId), win, k, d, a,
            mode: gameMode, ts: gj.gameCreation || gj.gameEndTimestamp || 0,
            position: me.teamPosition || me.individualPosition || me.position || me.lane || stats.teamPosition || stats.lane || '',
            // 1.5.136: 分均CS 数据源 (补刀含野怪)
            cs: (Number(stats.totalMinionsKilled) || 0) + (Number(stats.neutralMinionsKilled) || 0),
            dur: Number(gj.gameDuration) || 0,
            solo: soloRaw == null ? null : (Number(soloRaw) || 0),
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
    if (recent.length < 20) recent.push({
      // 1.5.76: LCU 兜底路径同样带上 gameId (raw 是原始 game 对象, normalizeGame 只留了 gid)
      gameId: raw.gameId || raw.gameIdString || game.gameId || game.gid || 0,
      champId: me.championId, win: !!me.win, k: me.k || 0, d: me.d || 0, a: me.a || 0,
      mode: game.mode, ts: game.time || 0,
      position: me.position || me.teamPosition || me.individualPosition || me.lane || '',
      // 1.5.136: 分均CS 数据源 (normalizeGame 已把两债合并进 cs)
      cs: me.cs || 0, dur: game.dur || 0,
      // 1.5.139: LCU 战绩接口没有 soloKills 记录 (Akari 同款结论), 只有 challenges 才给
      solo: me.challenges?.soloKills != null ? (Number(me.challenges.soloKills) || 0) : null,
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
    // 地图号用于「队列号不认识时」的模式兜底 (12 = 嚎哭深渊, 11 = 召唤师峡谷)
    mapId: Number(session?.map?.id) || 0,
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
    delete body.dataset.liveKey;   // 1.5.146: 骨架 key 守卫的失效点, 换局必须重画
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

  // 缓存命中: 只要阵容 key 匹配就复用。data 的写入侧已保证只缓存 Live Client Data
  // 完整双方(≥5人)的结果, rosterKey 含 puuid+英雄防串局, 读侧无需再要求本轮
  // livePlayers 也完整 —— 否则国服 Live Client Data 时好时坏: 偶尔拿不到 ≥5 人的
  // 那一轮会跌进全量路径, 把已填好的战绩重绘成「加载中」骨架再异步补回,
  // 表现为整页闪一下、每张卡的战绩数量跳变 (1.5.144 修复的闪屏根因)。
  if (livePlayersCache.key === key && livePlayersCache.data) {
    // 定时刷新命中阵容缓存时也必须重建共同历史分组。旧实现只带 challengeId
    // 临时结果重绘，导致后台刚显示的“组1/组2”在下一轮刷新时立刻消失。
    const cachedProfiles = livePlayersCache.data.map(player => ({ teamGames: player.premadeTeamGames || [] }));
    const cachedInferred = inferPremadeGroups(livePlayersCache.data, cachedProfiles, 3);
    const cachedGroups = Object.keys(cachedInferred).length
      ? cachedInferred
      : (livePlayersCache.premadeGroups || premadeGroups);
    await renderLiveTeams(body, livePlayersCache.data, cachedGroups, renderToken);
    body.dataset.liveKey = key;   // 1.5.146: 与骨架路径同步维护, 保证守卫语义一致
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

  // 1.5.145 防御: 骨架渲染前把缓存里同 puuid 玩家的已填数据带回去。缓存命中条件是
  // 阵容 key 全等, 但 rosterKey 会在数据源切换 (Live Client Data ↔ session) 时漂移 ——
  // 漂移的那一轮走全量路径, 骨架若带空数据, 标签 (指标/组队/常用英雄全部派生自
  // recent) 会整排消失几秒再补回, 表现就是"卡片闪一下、标签没了又出现"。
  // 带上缓存数据后骨架渲染结果与当前 DOM 一致, renderLiveTeams 的 innerHTML 比对
  // 直接跳过重建, 标签永不无故消失。sgpLoad 照常跑, TTL 内命中缓存零请求。
  const cachedProfileByPuuid = livePlayersCache.data && Array.isArray(livePlayersCache.data)
    ? new Map(livePlayersCache.data.filter(p => p && p.puuid).map(p => [p.puuid, p]))
    : null;
  const quickData = players.map(p => {
    const solo = (rankCache[p.puuid] || {}).RANKED_SOLO_5x5;
    const rank = solo && solo.tier ? `${rankTierCN(solo.tier)} ${solo.division || ''} ${solo.leaguePoints || 0}LP` : '';
    const c = p.puuid ? cachedProfileByPuuid?.get(p.puuid) : null;
    return {
      ...p,
      recent: c?.recent || [],
      rank,
      flashPreference: c?.flashPreference ?? null,
      behaviorSamples: c?.behaviorSamples || [],
      premadeTeamGames: c?.premadeTeamGames || [],
      isBot: !p.puuid
    };
  });
  const fullData = [...quickData];

  // 1.5.146: 骨架只在「当前 DOM 还不是本局渲染结果」时画。轮询每 12s 重入一次,
  // 之前每轮都重画骨架 (标签数据为空) —— GameStart/加载页阶段 livePlayers=null,
  // 缓存写入侧要求 >=5 人导致缓存永远建立不起来, 1.5.144/145 的读侧修复在这条
  // 路径上没有数据可合并, 表现为标签每隔十几秒整排消失、等 SGP 全部返回才补回。
  // key 含 rosterKey: 玩家集合真变了 (加载页 2 人 → 对局 10 人) key 自然变, 会
  // 正常重绘; 没变就跳过骨架, 增量数据交给 updateLivePlayerRow (1.5.146 起连
  // 标签行也局部同步)。组队徽标变化由 sgpLoad.then 的全量渲染兜底 (带比对)。
  if (body.dataset.liveKey !== key || !body.querySelector('.lp-row')) {
    await renderLiveTeams(body, quickData, premadeGroups, renderToken);
    body.dataset.liveKey = key;
  }
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

// 用出装引擎按双方阵容生成三套方案; 引擎未就绪时返回 null, 由 liveContextAdvice 兜底
function liveBuildPlans(self, ownSide, enemySide) {
  if (!self || typeof poroBuildEngine === 'undefined' || !poroBuildEngine.itemDatabase) return null;
  const myId = Number(self.championId);
  if (!Number.isFinite(myId) || myId <= 0) return null;
  try {
    const toList = list => (Array.isArray(list) ? list : [])
      .map(p => ({ championId: Number(p && p.championId) }))
      .filter(p => p.championId > 0);
    const result = poroBuildEngine.recommend(myId, toList(ownSide), toList(enemySide));
    return result && result.builds ? result : null;
  } catch (e) {
    console.warn('[Live] 出装推荐生成失败:', e && e.message);
    return null;
  }
}

// 三套出装并排展示: 图标 + 总价 + 装备名, 主推那套加高亮边框
// 数据来源有两套: OP.GG 真实对局 (plans.real) 和本地按阵容推算 (兜底)。
// 前者用 labels 覆盖「激进/平衡/保守」, 因为真实数据的排序是选取率, 不是风格。
const LIVE_OPGG_POS_CN = { top: '上单', jungle: '打野', mid: '中单', adc: '下路', support: '辅助' };

function renderLiveBuildPlans(plans, opts) {
  const ver = typeof version !== 'undefined' ? version : '';
  const order = [['aggressive', '激进'], ['balanced', '平衡'], ['defensive', '保守']];
  const labels = plans.labels || {};
  const activeKey = plans.activeKey || 'balanced';
  const cards = order.map(([key, fallback]) => {
    const build = plans.builds[key];
    if (!build || !build.items.length) return '';
    const label = labels[key] || fallback;
    const icons = build.items.map(it =>
      `<img src="https://ddragon.leagueoflegends.com/cdn/${ver}/img/item/${it.id}.png" title="${escapeHtml(it.name)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
    ).join('');
    return `<div class="ld-build${key === activeKey ? ' active' : ''}">
      <div class="ld-build-title"><b>${escapeHtml(label)}</b><span>${build.totalCost}g</span></div>
      <div class="ld-build-items">${icons}</div>
      <p>${escapeHtml(build.items.map(it => it.name).join(' · '))}</p>
    </div>`;
  }).join('');
  if (!cards) return '';
  // 浮窗标题已经写了「推荐出装 · 英雄 · 定位」, 卡组自己的头再重复一遍就成了两行标题。
  const head = opts && opts.hideHead ? '' :
    `<div class="ld-builds-head"><b>推荐出装</b><span>${escapeHtml(plans.champion || '')} · ${escapeHtml(liveRoleCn(plans.role))} · ${plans.real ? 'OP.GG 真实数据' : '按敌方阵容生成'}</span></div>`;

  // 来源与备注: 真实数据要标明出处和分路, 本地推算要标明"这是推的", 不能让用户以为一样可靠
  const notes = (plans.notes || []).filter(Boolean);
  const srcText = plans.real
    ? `数据来源：OP.GG ${plans.version || ''}${LIVE_OPGG_POS_CN[plans.position] ? ' · ' + LIVE_OPGG_POS_CN[plans.position] : ''} · 按真实对局选取率排序`
    : 'OP.GG 数据未取到，以下按敌方阵容本地推算';
  const foot = `<p class="ld-builds-src${plans.real ? '' : ' local'}">${escapeHtml(srcText)}</p>`
    + (notes.length ? `<p class="ld-builds-note">${escapeHtml(notes.join('　｜　'))}</p>` : '');

  return `<div class="ld-builds">
    ${head}
    <div class="ld-builds-grid">${cards}</div>
    ${foot}
  </div>`;
}

// ===== 1.5.122: 出装浮窗 =====
// 三套出装曾经塞在页头那个「本局作战计划」浮层里。那个浮层贴在页头, 展开是绝对定位,
// 高度只有 225px (见 extras.css), 出装卡永远在滚动区外面 —— 表现为"打开也看不到"。
// 往页面主体里铺又会从两列战绩里抢高度 (两列 .lp-recent 本来就是靠压缩才挤进一屏的)。
// 这里改成独立浮窗: fixed 定位 + 遮罩, 完全不参与文档流, 战绩区高度分毫不动。
//
// 1.5.121 上线后出现"点按钮没反应"。排查结论: 代码本身能跑, 但这个函数有静默失败分支
// (拿不到上下文就直接 return), 用户看到的就是"什么都没发生"。所以这里改成:
//   1) 先把浮窗显示出来, 再填内容 —— 任何一步失败都留下可见反馈;
//   2) 入口改用事件委托, 不依赖内联 onclick;
//   3) 上下文支持三级回退, 不再只认 _poroLiveSnapshot。
const LIVE_ROLE_CN = { tank: '坦克', fighter: '战士', assassin: '刺客', mage: '法师', marksman: '射手', support: '辅助' };
function liveRoleCn(role) { return LIVE_ROLE_CN[role] || ''; }

let liveBuildPopEl = null, liveBuildBackdropEl = null;
// 打开浮窗的那一次点击, 会在遮罩插入之后继续派发 (Electron 下同一次按下/抬起可能产生两次
// click), 第二次就落在刚盖满全屏的遮罩上 -> 立刻被当成"点空白处"关掉。
// 表现正是"点了按钮毫无反应"(浮窗闪一下就没了)。这里给一个很短的免疫期。
let _lbpOpenedAt = 0;
const LBP_OPEN_GUARD = 350;

function ensureLiveBuildPop() {
  if (liveBuildPopEl && document.body.contains(liveBuildPopEl)) return liveBuildPopEl;
  const bd = document.createElement('div');
  bd.className = 'lbp-backdrop';
  bd.hidden = true;
  bd.addEventListener('click', () => {
    if (Date.now() - _lbpOpenedAt < LBP_OPEN_GUARD) return;
    closeLiveBuildPop();
  });
  document.body.appendChild(bd);
  liveBuildBackdropEl = bd;

  const el = document.createElement('div');
  el.id = 'liveBuildPop';
  el.className = 'lmp lbp';
  el.hidden = true;
  el.innerHTML = '<div class="lmp-head">'
    + '<span class="lmp-title">推荐出装</span>'
    + '<span class="lmp-hint">Esc 或点空白处关闭</span>'
    + '<button type="button" class="lmp-close" title="关闭">×</button>'
    + '</div><div class="lmp-body lbp-body"></div>';
  el.querySelector('.lmp-close').addEventListener('click', closeLiveBuildPop);
  document.body.appendChild(el);
  liveBuildPopEl = el;
  return el;
}

// 诊断日志: 只有 [RENDERER] 前缀会被转到 crash.log, debugLog 会补这个前缀
function lbpLog(msg) {
  try { if (window.lolAPI && lolAPI.debugLog) lolAPI.debugLog('[BUILD POP] ' + msg); } catch (e) {}
  try { console.log('[BUILD POP]', msg); } catch (e) {}
}

// 本局上下文: 三级回退。_poroLiveSnapshot 在数据不全时整个为 null,
// _poroLiveCtx 在 renderLiveTeams 里无条件落地, 最后兜到玩家缓存。
function liveBuildContext() {
  const c = window._poroLiveCtx;
  if (c && Array.isArray(c.data) && c.data.length) return c;
  const s = window._poroLiveSnapshot;
  if (s && Array.isArray(s.data) && s.data.length) return s;
  try {
    if (typeof livePlayersCache !== 'undefined' && livePlayersCache
      && Array.isArray(livePlayersCache.data) && livePlayersCache.data.length) {
      return { data: livePlayersCache.data, selfPuuid: window._myPuuid || null };
    }
  } catch (e) {}
  return null;
}

// ===== 真实出装数据 (OP.GG) =====
// 为什么必须走这里: 本地引擎按「角色 + 伤害类型」组装备池, 分不清剑魔和剑姬 ——
// 两者 Data Dragon tags 都是 Fighter, 但真实对局里剑魔是星蚀/朔极之矛/死亡之舞,
// 剑姬才是破败/三相。这类差别只能来自统计数据, 规则写得再细也是猜。
// OP.GG 已在选人阶段用于写符文和装备方案 (见 opgg-loadout.js), 这里复用同一个 IPC。
const LBP_OPGG_TIMEOUT = 6000;

function lbpWithTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('请求超时')), ms);
    Promise.resolve(promise).then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); }
    );
  });
}

// 分路解析: 实战数据里 position 经常是 'NONE' —— 训练模式 (PRACTICETOOL)、自定义、
// 以及部分加载阶段的 allPlayers 都不带分路。排位接口必须带分路, 之前遇到这种情况
// 直接放弃真实数据退回本地推算, 等于剑魔又被按战士池算一遍。
// 这里补一层: 用 OP.GG 该英雄各分路的选取率 (role_rate) 挑最高的一条。
// 数据来自已有的 lolAPI.getOpgg() (主进程缓存 10 分钟), 不是猜。
let _lbpPositionCache = null;      // championId -> position key
let _lbpPositionFetching = null;   // 并发去重: 连点两次只发一次请求

async function lbpPositionFromRanking(champId) {
  if (_lbpPositionCache) return _lbpPositionCache[champId] || null;
  if (!_lbpPositionFetching) {
    _lbpPositionFetching = (async () => {
      const map = {};
      try {
        if (!window.lolAPI || typeof lolAPI.getOpgg !== 'function') return map;
        const r = await lbpWithTimeout(lolAPI.getOpgg(), LBP_OPGG_TIMEOUT * 2);
        for (const c of ((r && r.data) || [])) {
          let best = null;
          for (const p of (c.positions || [])) {
            const key = OPGG_POSITION_ALIASES[String((p && p.name) || '').toUpperCase()];
            const rate = Number(p && p.stats && p.stats.role_rate) || 0;
            if (key && (!best || rate > best.rate)) best = { key, rate };
          }
          if (best) map[c.id] = best.key;
        }
        lbpLog('pos ranking loaded=' + Object.keys(map).length);
      } catch (e) {
        lbpLog('pos ranking fail ' + (e && e.message));
      } finally {
        _lbpPositionFetching = null;
      }
      _lbpPositionCache = map;
      return map;
    })();
  }
  const map = await _lbpPositionFetching;
  return map[champId] || null;
}

// 拿不到就返回 null, 由本地推算兜底。失败原因写进 lbpLog, 便于从 crash.log 定位。
async function liveRealBuildPlans(self) {
  try {
    // 合规模式关闭一切 OP.GG 相关能力, 出装也要跟着停, 不能绕过
    if (typeof complianceOn !== 'undefined' && complianceOn) { lbpLog('opgg skip=compliance'); return null; }
    if (!window.lolAPI || typeof lolAPI.getOpggBuild !== 'function') { lbpLog('opgg skip=noIpc'); return null; }
    const champId = Number(self && self.championId);
    if (!champId) return null;
    if (typeof poroBuildEngine === 'undefined' || !poroBuildEngine.recommendFromReal) return null;

    const mc = window._poroLiveModeContext || {};
    let mode = typeof opggModeForQueue === 'function' ? opggModeForQueue(mc.queueId, mc.gameMode) : null;
    if (!mode) {
      // 国服有些队列号 (例如 3140) 既不在映射表里, gameMode 也认不出来。
      // 之前这里直接返回 null, 结果就是这些队列永远只能看到本地推算。
      // 按地图兜底: 12 = 嚎哭深渊(乱斗系), 11 = 召唤师峡谷(用 ranked 数据, 覆盖匹配/自定义)。
      const mapId = Number(mc.mapId) || 0;
      if (mapId === 12) mode = 'aram';
      else if (mapId === 11) mode = 'ranked';
    }
    if (!mode) { lbpLog('opgg skip=mode queue=' + (mc.queueId || 0) + ' gm=' + (mc.gameMode || '') + ' map=' + (mc.mapId || 0)); return null; }

    // 非排位系 (大乱斗/无限火力) 主进程一律按 position='none' 取, 不需要分路
    let position = mode === 'ranked'
      ? (typeof opggPositionFor === 'function' ? opggPositionFor(self.position, champId) : null)
      : 'none';
    if (!position && mode === 'ranked') {
      // 训练模式/自定义的 position 是 'NONE', 拿不到分路。按 OP.GG 榜单里
      // 该英雄选取率最高的分路取, 而不是直接退回本地推算。
      position = await lbpPositionFromRanking(champId);
      if (position) lbpLog('pos fallback=' + position + ' raw=' + (self.position || '空'));
    }
    if (!position) { lbpLog('opgg skip=position pos=' + (self.position || '空') + ' mode=' + mode); return null; }

    const raw = await lbpWithTimeout(lolAPI.getOpggBuild(mode, champId, position), LBP_OPGG_TIMEOUT);
    if (!raw || raw.__error || !Array.isArray(raw.itemBlocks) || !raw.itemBlocks.length) {
      lbpLog('opgg empty mode=' + mode + ' pos=' + position + ' err=' + ((raw && raw.__error) || 'none'));
      return null;
    }
    // 主进程的 getBuild 会带上 mode/position, 但缓存命中或字段缺失时可能没有, 这里补齐
    raw.mode = raw.mode || mode;
    raw.position = raw.position || position;
    const plans = poroBuildEngine.recommendFromReal(raw, {
      champion: poroBuildEngine._championName(champId),
      role: poroBuildEngine._getRole(champId),
      damageType: poroBuildEngine._getDamageType(champId),
    });
    if (!plans) { lbpLog('opgg parse=null blocks=' + raw.itemBlocks.length); return null; }
    lbpLog('opgg ok mode=' + mode + ' pos=' + position + ' blocks=' + raw.itemBlocks.length);
    return plans;
  } catch (e) {
    lbpLog('opgg FAIL ' + (e && e.message));
    return null;
  }
}

async function openLiveBuildPop() {
  const el = ensureLiveBuildPop();
  const body = el.querySelector('.lbp-body');
  const title = el.querySelector('.lmp-title');
  // 先显示再填内容: 后续任何异常都不会变成"点了没反应"
  el.hidden = false;
  if (liveBuildBackdropEl) liveBuildBackdropEl.hidden = false;
  el.classList.add('lmp-open');
  _lbpOpenedAt = Date.now();
  try {
    const ctx = liveBuildContext();
    const self = ctx && ctx.selfPuuid ? ctx.data.find(p => p.puuid === ctx.selfPuuid) : null;
    lbpLog('open ctx=' + (ctx ? 'ok/' + ctx.data.length : 'NULL')
      + ' self=' + (self ? (self.championId || 'noChamp') : 'none')
      + ' engine=' + (typeof poroBuildEngine !== 'undefined' && poroBuildEngine && poroBuildEngine.itemDatabase ? 'ready' : 'notReady'));
    if (!self || !Number(self.championId)) {
      title.textContent = '推荐出装';
      body.innerHTML = '<p class="lbp-empty">还没识别到你本局的英雄。等阵容数据到位后再点一次。</p>';
      return;
    }
    title.textContent = '推荐出装 · ' + (typeof poroBuildEngine !== 'undefined'
      ? (poroBuildEngine._championName(Number(self.championId)) || '') : '');

    // 先给"正在读取", 再等真实数据。不先渲染本地版, 是因为本地版可能就是错的
    // (上一版把破败塞给剑魔), 让用户看到一版错的再替换, 比等两秒更糟。
    body.innerHTML = '<p class="lbp-empty lbp-loading">正在读取本局真实出装（OP.GG）…</p>';

    const own = ctx.data.filter(p => p && Number(p.team) === Number(self.team));
    const enemy = ctx.data.filter(p => p && Number(p.team) !== Number(self.team));

    let plans = await liveRealBuildPlans(self);
    if (el.hidden) return;   // 等待期间用户已经关掉了
    if (!plans) plans = liveBuildPlans(self, own, enemy);   // 兜底: 本地推算

    if (!plans) {
      title.textContent = '推荐出装';
      body.innerHTML = '<p class="lbp-empty">装备库还没加载完（Data Dragon 首次拉取需要几秒），稍后再点一次。</p>';
      lbpLog('plans=null own=' + own.length + ' enemy=' + enemy.length);
      return;
    }
    const roleCn = liveRoleCn(plans.role);
    title.textContent = '推荐出装 · ' + (plans.champion || '') + (roleCn ? ' · ' + roleCn : '');
    body.innerHTML = renderLiveBuildPlans(plans, { hideHead: true });
    lbpLog('ok champ=' + (plans.champion || '') + ' role=' + (plans.role || '') + ' src=' + (plans.real ? 'opgg' : 'local'));
  } catch (e) {
    lbpLog('ERROR ' + (e && e.message));
    title.textContent = '推荐出装';
    body.innerHTML = '<p class="lbp-empty">生成失败：' + escapeHtml((e && e.message) || '未知错误') + '</p>';
  }
}

function closeLiveBuildPop() {
  if (!liveBuildPopEl || liveBuildPopEl.hidden) return;
  liveBuildPopEl.hidden = true;
  liveBuildPopEl.classList.remove('lmp-open');
  if (liveBuildBackdropEl) liveBuildBackdropEl.hidden = true;
}

// 入口用事件委托, 不用内联 onclick: 页面主体每轮轮询都会整体重建 innerHTML,
// 内联属性只要被任一环节拦掉 (CSP / 属性清理 / 提前 return), 表现就是"点了完全没反应"。
// 委托挂在 document 上并在脚本加载时立即绑定, 不依赖浮窗是否已创建。
// 用 typeof 判断而不是直接调用: 有几个单元测试用 vm + 假 document 跑 live.js,
// 假对象没有 addEventListener, 直接调用会在加载期抛错把整个测试带崩。
if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
  document.addEventListener('click', e => {
    const btn = e.target && e.target.closest ? e.target.closest('#liveBuildBtn') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    // openLiveBuildPop 是 async (要等 OP.GG), 兜住 promise 免得失败时没有痕迹
    openLiveBuildPop().catch(err => lbpLog('open fail ' + (err && err.message)));
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && liveBuildPopEl && !liveBuildPopEl.hidden) closeLiveBuildPop();
  });
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
  // 出装卡不再放在这个浮层里: 浮层高度有限, 塞进去要么被裁掉、要么顶开页面压缩战绩。
  // 现在由队伍标题栏的「推荐出装」按钮唤起独立浮窗 (openLiveBuildPop), 见下方实现。
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

// 加载最近 20 场 (SGP 单次请求 30 场, 多存 10 场零成本); 卡片高度固定, 超出部分在卡内滚动。
// Akari 的战绩区也是"加载多少显示多少", 10 场的卡在高度上比不过它 —— 20 场先补齐信息量。
function recentLimit() {
  return 20;
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
      <section class="lpd-section"><h3>组队证据</h3><p>${escapeHtml(premade)}</p>${encounterDetailHtml(player.puuid)}</section>
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

// 1.5.136: 抽屉「组队证据」下的相遇详情 (Akari MET 口径): 次数 + 上次同队/对手 + 胜负 + 日期
function encounterDetailHtml(puuid) {
  if (!puuid || typeof getEncounterInfo !== 'function') return '';
  const enc = getEncounterInfo(puuid);
  if (!enc.count && !enc.lastResult) return '';
  const parts = [`遇见 ${enc.count} 次`];
  if (enc.lastResult) {
    parts.push(`上次${enc.lastSameTeam === true ? '同队' : enc.lastSameTeam === false ? '对手' : ''}${enc.lastResult === 'win' ? '胜' : '负'}`
      + (enc.lastGameTs ? `（${new Date(enc.lastGameTs).toLocaleDateString()}）` : ''));
  }
  return `<div class="lpd-evidence"><b>历史相遇</b><span>${escapeHtml(parts.join(' · '))}</span></div>`;
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
  // 1.5.136: 分均CS —— 逐局 cs/时长 再平均, 保留 1 位小数 (整数会抹平 7.2 和 7.8 的差距)
  const csmVals = rs.filter(r => Number(r.cs) > 0 && Number(r.dur) > 0).map(r => Number(r.cs) / (Number(r.dur) / 60));
  const csmAvg = csmVals.length ? Math.round(csmVals.reduce((s, v) => s + v, 0) / csmVals.length * 10) / 10 : null;
  // 1.5.139: 单杀 / 击杀伤害效率 (Akari 同款, 字段缺失的局不计入分母, avgIfAllNonNull 口径)
  const soloVals = rs.filter(r => r.solo != null);
  const soloAvg = soloVals.length ? Math.round(soloVals.reduce((s, r) => s + (Number(r.solo) || 0), 0) / soloVals.length * 10) / 10 : null;
  const kdeVals = rs.filter(r => r.kde != null);
  const kdeAvg = kdeVals.length ? Math.round(kdeVals.reduce((s, r) => s + Number(r.kde), 0) / kdeVals.length * 100) / 100 : null;
  const items = [
    ['dmg', '伤害', avg('dmgPct'), '%', '队内伤害占比'],
    ['tank', '承伤', avg('tankPct'), '%', '队内承伤占比'],
    ['kp', '参团', avg('kp'), '%', '击杀参与率'],
    ['dmgGold', '伤转', avg('dmgGold'), '%', '伤害 / 经济, 越高说明钱花得越值'],
    ['gold', '经济', avg('goldPct'), '%', '队内经济占比'],
    ['csm', '分均CS', csmAvg, '', '分均补刀(含野怪)'],
    ['vision', '视野', avg('vision'), '', '场均视野得分'],
    // 单杀: 场均 >0 才占位 (0 单杀的人不值得一个标签位, Akari 同口径)
    ...(soloAvg != null && soloAvg > 0 ? [['solo', '单杀', soloAvg, '', '场均单杀次数']] : []),
    // 击杀伤害效率: 只在极端值出现 (>1.35 拿头快 / <0.65 输出转化差), 正常区间不占位
    ...(kdeAvg != null && (kdeAvg > 1.35 || kdeAvg < 0.65)
      ? [[kdeAvg > 1.35 ? 'kdehi' : 'kdelo', '拿头', kdeAvg.toFixed(2), '',
          kdeAvg > 1.35 ? '击杀伤害效率高: 击杀占比远超伤害占比, 收头能力强' : '击杀伤害效率低: 输出打了不少但击杀转化差, 常见补伤/工具位']]
      : []),
  ].filter(it => it[2] != null);
  if (!items.length) return '';
  const streak = liveStreak(recent);
  const streakHtml = streak
    ? `<span class="lp-metric lp-metric-${streak.win ? 'winstreak' : 'lossstreak'}" title="最近 ${streak.n} 场${streak.win ? '全胜' : '全负'}">${streak.n}${streak.win ? '连胜' : '连败'}</span>`
    : '';
  // 1.5.142: 全部指标直接展示 (Akari 式), 指标行自动折行 (§24 CSS 两行封顶 36px),
  // 「+N」收纳入口整体退役 —— 收纳判定正是 1.5.137「标签全部隐藏」bug 的根源,
  // 也不再占 reservedSlots; reservedSlots 参数保留以兼容调用方签名。
  const allHtml = items.map(([cls, label, val, unit, tip]) =>
    `<span class="lp-metric lp-metric-${cls}" title="近 ${rs.length} 场平均${tip}">${label}<b>${val}${unit}</b></span>`
  ).join('');
  return streakHtml + allHtml;
}

// 概览行的 KDA 用「大数字 + 小标签」，与胜率形成一对主指标。
// 首次渲染与局部刷新 (updateLivePlayerRow) 必须共用这一个结构，否则刷新会把排版冲掉。
function liveKdaHtml(kda) {
  // 1.5.134: KDA 分档上色 —— ≥4 好 / <2.5 差 / 中间与未知中性 (Akari 同款阈值思路)
  const v = parseFloat(kda);
  const cls = isNaN(v) ? '' : v >= 4 ? ' is-good' : v < 2.5 ? ' is-poor' : '';
  return `<b class="${cls.trim()}">${escapeHtml(String(kda))}</b><em>KDA</em>`;
}

// 1.5.134: 战绩尾部提示 —— 加载到的场次多于展示行数时, 卡底留一行小字:
// 消除"行数少的卡底部一大块空白"的观感, 同时交代数据量 (Akari/OP.GG 均有同款交代)。
// 放在 .lp-recent 兄弟节点 (不进列表内部), 不干扰 alignLiveRecentRows 的行距分摊。
function liveRecentHint(p) {
  const total = (p && (p.games || p.recent?.length)) || 0;
  const shown = Math.min((p?.recent?.length || 0), recentLimit());
  if (!total || total <= shown) return '';
  return `<div class="lp-recent-hint">共 ${total} 场 · 展示最近 ${shown} 场</div>`;
}

function syncLiveRecentHint(row, p) {
  if (!row) return;
  const prev = row.querySelector(':scope > .lp-recent-hint');
  const hint = liveRecentHint(p);
  if (hint) {
    if (prev) { if (prev.outerHTML !== hint) prev.outerHTML = hint; }
    else row.querySelector('.lp-recent')?.insertAdjacentHTML('afterend', hint);
  } else if (prev) prev.remove();
}

// 最近常用英雄 (Akari 同款模块): 聚合近 20 场的英雄使用, 按场次降序取前 9 枚 20px 图标。
// ring 颜色跟这个英雄自己的胜率走 —— 同一个人, 玩亚索 60% 胜率和玩亚索 30% 胜率是两种人,
// 这排图标回答的是"他最近在玩什么、玩得怎么样", 而不是整体胜率。
// 数据复用已加载的 recent, 不发任何新请求; 总使用 ≤1 个英雄时没有"常用"可言, 整行不出。
function championUsageHtml(recent) {
  const rs = (recent || []).filter(r => r && r.champId);
  if (!rs.length) return '';
  const byChamp = new Map();
  for (const r of rs) {
    const e = byChamp.get(r.champId) || { id: r.champId, n: 0, w: 0 };
    e.n++;
    if (r.win === true || r.win === 'Win') e.w++;
    byChamp.set(r.champId, e);
  }
  const list = [...byChamp.values()].sort((a, b) => b.n - a.n).slice(0, 9);
  if (list.length < 2) return '';
  const dots = list.map(e => {
    const c = champOfLive(e.id);
    const wr = Math.round(e.w / e.n * 100);
    const cls = e.n >= 2 && wr >= 50 ? ' is-pos' : e.n >= 2 && wr < 50 ? ' is-neg' : '';
    const tip = `${c ? c.name : ''} ${e.n}场 ${wr}%胜率`;
    return `<img class="lp-usage-champ${cls}" src="${c ? champImg(c.id) : placeholder('?')}" ${c ? champIconAttrs(c.id, c.name) : `onerror="this.src='${placeholder('?')}'"`} title="${escapeHtml(tip)}">`;
  }).join('');
  return `<div class="lp-champ-usage">${dots}</div>`;
}
function syncLiveChampUsage(row, p) {
  if (!row) return;
  const prev = row.querySelector(':scope > .lp-champ-usage');
  const usage = championUsageHtml(p.recent);
  if (usage) {
    if (prev) { if (prev.outerHTML !== usage) prev.outerHTML = usage; }
    else row.querySelector('.lp-profile-line')?.insertAdjacentHTML('afterend', usage);
  } else if (prev) prev.remove();
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
  // 差异守卫 (1.5.144): 内容没变就不动 DOM。无脑重写 innerHTML 会把战绩图标/英雄
  // 图标节点全部重建, 图片重新解码 → 行内闪一下。轮询 12s 一次, 数据未变时必须零 DOM 写。
  if (recentEl && recentEl.innerHTML !== recentHtml) recentEl.innerHTML = recentHtml;
  syncLiveRecentHint(row, p);
  syncLiveChampUsage(row, p);
  const flashHtml = flashPreferenceHtml(p.flashPreference);
  if (flashEl && flashEl.innerHTML !== flashHtml) flashEl.innerHTML = flashHtml;
  if (winRateEl) {
    const winRate = p.recent.length ? Math.round(wins / p.recent.length * 100) : null;
    winRateEl.textContent = winRate == null ? '--' : `${winRate}%`;
    // 与全量渲染同口径的三档: ≥55 绿 / ≤45 红 / 中间中性
    winRateEl.classList.toggle('positive', winRate != null && winRate >= 55);
    winRateEl.classList.toggle('negative', winRate != null && winRate <= 45);
    winRateEl.classList.toggle('neutral', winRate != null && winRate > 45 && winRate < 55);
  }
  if (kdaEl) { const kdaHtml = liveKdaHtml(kda); if (kdaEl.innerHTML !== kdaHtml) kdaEl.innerHTML = kdaHtml; }
  // 1.5.146: 标签行局部同步 (组队/大腿/本命/指标/行为)。之前只更新战绩区,
  // 标签要等全量重绘才出现; 全量重绘又被骨架周期性重置打断 → 标签间歇消失。
  const pillsEl = row.querySelector('.lp-profile-line');
  if (pillsEl) {
    const pgid = p.premadeGroupId ?? window._poroLivePlayerMap?.get(key)?.premadeGroupId ?? null;
    const pillsHtml = buildLivePills(p, pgid);
    if (pillsEl.innerHTML !== pillsHtml) pillsEl.innerHTML = pillsHtml;
  }
  scheduleLiveRowAlignment();
}

// 卡片可用高度经常不是战绩行高的整数倍。把滚动区收敛到完整行，
// 避免底部露出半条记录；10 场数据、滚动与展开模式都保持不变。
function scheduleLiveRowAlignment() {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { fitLiveMetricRows(); alignLiveRecentRows(); });
  else { fitLiveMetricRows(); alignLiveRecentRows(); }
}

// 指标行标签收纳已退役 (1.5.142): 全部直接展示, 折行由 §24 CSS 控制。
function fitLiveMetricRows() {
  // 1.5.142: 标签收纳逻辑整体退役 —— 指标全部直接展示 (§24 指标行自动折行,
  // 两行封顶), 「+N」入口不再渲染。保留空函数: 轮询与 switchPage 的调用点不动,
  // 1.5.137 修的「隐藏页 rect 全 0 误判溢出」随收纳一起消失。
}

function alignLiveRecentRows() {
  const page = document.getElementById('page-live');
  document.querySelectorAll('#page-live .lp-recent').forEach(list => {
    list.style.removeProperty('height');
    list.style.removeProperty('flex');
    list.style.removeProperty('gap');
    list.style.removeProperty('margin-bottom');
    if (page?.classList.contains('live-expanded')) return;
    const first = list.querySelector('.ri-card');
    if (!first) return;
    const available = list.clientHeight;
    const rowHeight = first.getBoundingClientRect().height;
    if (available < rowHeight) return;
    // 旧逻辑按整行数裁列表高度 (height=exact + marginBottom 补零头), 零头最多能剩
    // 一行高-2px。滚动条又是隐藏的 (scrollbar-width:none), 底部渐隐提示也禁用了 ——
    // 卡底那块空白看起来就像"最后一场被什么东西挡住了"(用户 1.5.131 反馈「有遮挡」)。
    // 现在不再裁高度: 列表 flex:1 本来就占满, 行高不动, 把零头分摊进行间距,
    // 行间最多放宽到 10px, 卡底不再有残余空白; 放不下的场次仍在列表内滚动。
    const rows = list.querySelectorAll('.ri-card').length;
    const baseGap = parseFloat(getComputedStyle(list).rowGap) || 2;
    const step = rowHeight + baseGap;
    const visible = Math.max(1, Math.floor((available + baseGap) / step));
    const n = Math.min(visible, rows);
    if (n >= 2) {
      const gap = Math.min((available - n * rowHeight) / (n - 1), 10);
      if (gap > baseGap + 0.25) list.style.gap = `${gap.toFixed(2)}px`;
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

// 1.5.146: 卡片标签行 (组队/大腿/本命/指标/行为) 构建抽出来, 首次渲染与局部刷新
// (updateLivePlayerRow) 共用同一结构, 否则刷新会把排版冲掉或标签迟迟不出。
// 1.5.141: 组队标签按组号着色 (Akari 小队 A-G 各一色), 同组的人在两张卡上一眼对上;
// 特色标签: 大腿 = 近 14 场以上胜率 ≥65%; 本命 = 同一个英雄玩了 ≥5 场。样本不够不贴。
function buildLivePills(p, premadeGroupId) {
  const premadeTag = premadeGroupId ? `<span class="lp-premade lp-pg-${((premadeGroupId - 1) % 6) + 1}" title="该玩家与本队其他成员有共同对局，推断为开黑组 ${premadeGroupId}">组${premadeGroupId}</span>` : '';
  const wins = p.recent.filter(r => r.win === true || r.win === "Win").length;
  const winRate = p.recent.length ? Math.round(wins / p.recent.length * 100) : null;
  const games = p.recent.length;
  const specialTags = [];
  if (winRate != null && winRate >= 65 && games >= 14) {
    specialTags.push(`<span class="lp-metric lp-tag-hiwr" title="近 ${games} 场 ${wins} 胜，胜率 ${winRate}% — 高胜率玩家，前期多照顾他一路">大腿</span>`);
  }
  const champCounts = {};
  for (const r of p.recent) champCounts[r.champId] = (champCounts[r.champId] || 0) + 1;
  let mainChampId = 0, mainChampN = 0;
  for (const [cid, n] of Object.entries(champCounts)) if (n > mainChampN) { mainChampN = n; mainChampId = Number(cid); }
  const mainChamp = mainChampN >= 5 ? champOfLive(mainChampId) : null;
  if (mainChamp) {
    specialTags.push(`<span class="lp-metric lp-tag-main" title="${escapeHtml(mainChamp.name)} 近 ${games} 场玩了 ${mainChampN} 场 — 本命英雄，熟练度大概率不低">本命</span>`);
  }
  const behaviorHtml = behaviorTagsHtml(p.behaviorSamples);
  const reservedSlots = (premadeTag ? 1 : 0) + (behaviorHtml ? 1 : 0) + specialTags.length;
  // 实时卡片不显示"近期稳定 / 需要观察"画像标签，避免和队内指标标签争夺空间。
  return `${premadeTag}${specialTags.join('')}${liveMetricPills(p.recent, reservedSlots)}${behaviorHtml}`;
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
    const marksHtml = !isSelf && p.puuid ? `<span class="lp-mark" onclick="showMarkModal(${inlineArg(p.puuid)},${inlineArg(name)})" title="标记该玩家">${poroIcon('pin')}</span>${getPlayerMarksHtml(p.puuid)}${encounterTagHtml(p.puuid)}` : '';
    const winRate = p.recent.length ? Math.round(wins / p.recent.length * 100) : null;
    // 大乱斗/海斗: 英雄平衡性调整徽标 (balance.js; 1.5.0 的半成品已补全)
    const balanceHtml = (liveBalanceMode ? balanceBadgeHtml(p.championId) : '') + (liveTierMode ? modeTierBadgeHtml(liveTierMode, p.championId) : '');
    // 1.5.146: 标签行构建抽成 buildLivePills, 首次渲染与局部刷新 (updateLivePlayerRow)
    // 共用同一结构 —— 之前局部刷新只更新战绩区不更新标签, 标签要等全量重绘才出现。
    const pills = buildLivePills(p, premadeGroupId);
    const recordSummary = liveRecordText(p.recent.length, wins, '近期战绩加载中');
    // 1.5.134: 胜率三档 (Akari 口径) —— ≥55 绿 / ≤45 红 / 中间中性, 50% 的红绿抖动不再误导
    const wrCls = winRate == null ? '' : winRate >= 55 ? ' positive' : winRate <= 45 ? ' negative' : ' neutral';
    const inlineStats = `<span class="lp-inline-stats" title="${escapeHtml(recordSummary)}"><span class="lp-winrate${wrCls}">${winRate == null ? '--' : winRate + '%'}</span><span class="lp-kda">${liveKdaHtml(kda)}</span></span>`;
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
      ${championUsageHtml(p.recent)}
      <div class="lp-recent">${recentHtml}</div>
      ${liveRecentHint(p)}
    </div>`;
  };
  const isBlue = p => p.team === 100 || p.team === "100";
  const isRed = p => p.team === 200 || p.team === "200";
  const blue = data.filter(isBlue), red = data.filter(isRed), unknown = data.filter(p => !isBlue(p) && !isRed(p));
  // 空位占位: 数据没到 / 人数不足时也保持 5 列形状，避免半屏空白看起来像页面坏了
  const emptySlot = () => '<div class="lp-row lp-empty"><span>等待数据</span></div>';
  const teamPanel = (list, label, cls, withExpand, withBuild) => {
    const matches = list.reduce((sum, p) => sum + p.recent.length, 0);
    const wins = list.reduce((sum, p) => sum + p.recent.filter(r => r.win === true || r.win === 'Win').length, 0);
    const kills = list.reduce((sum, p) => sum + p.recent.reduce((n, r) => n + r.k, 0), 0);
    const deaths = list.reduce((sum, p) => sum + p.recent.reduce((n, r) => n + r.d, 0), 0);
    const assists = list.reduce((sum, p) => sum + p.recent.reduce((n, r) => n + r.a, 0), 0);
    const rate = matches ? Math.round(wins / matches * 100) : null;
    const kda = matches ? ((kills + assists) / Math.max(1, deaths)).toFixed(2) : null;
    // 与玩家卡胜率同口径三档 (≥55 绿 / ≤45 红 / 中性), 队伍样本更足, 阈值更稳
    const rateCls = rate >= 55 ? ' positive' : rate <= 45 ? ' negative' : ' neutral';
    const summary = matches
      ? `<span class="lp-team-rate${rateCls}">${rate}%</span><span class="lp-team-kda">KDA <b>${kda}</b></span>`
      : '<span class="lp-team-kda">战绩加载中</span>';
    const slots = Math.max(0, 5 - list.length);
    // 「展开全部战绩」放在队伍标题栏最右端: 页头那一行已经去掉 (标题纯占高度),
    // 而这个开关只管战绩列表的展开, 贴在列表上方的队伍栏里正好, 且不额外占一行高度。
    const expandBtn = withExpand
      ? '<button type="button" class="lp-expand-btn" id="liveExpandBtn" onclick="toggleLiveRecentExpanded()"' +
        ' title="默认让两队挤在一屏内，每人只露出几场；展开后每人完整显示最近 10 场，页面可滚动">展开全部战绩</button>'
      : '';
    // 「推荐出装」和「展开全部战绩」共用队伍标题栏这一行: 页头那行已经去掉了,
    // 而这一行本来就只放了名字+人数, 右边是空的, 塞两个按钮不额外占任何高度。
    const buildBtn = withBuild
      ? '<button type="button" class="lp-build-btn" id="liveBuildBtn"' +
        ' title="按本局双方阵容推荐三套出装: 激进 / 平衡 / 保守">推荐出装</button>'
      : '';
    return `<section class="lp-team ${cls}">
      <div class="lp-team-head"><i class="lp-team-dot"></i><strong>${label}</strong>${summary}<span class="lp-team-count">${list.length} 名玩家</span>${buildBtn}${expandBtn}</div>
      <div class="lp-team-grid">${list.map(playerRow).join('')}${Array.from({ length: slots }, emptySlot).join('')}</div>
    </section>`;
  };
  // 数据不完整时 buildLiveDecisionPanel 返回空串，避免“对局准备”占用顶部整行。
  // 双方阵容齐全时仍保留作战计划入口。
  setLiveHeadPanel(buildLiveDecisionPanel(data, selfPuuid));
  // 「推荐出装」只挂在自己那一队的标题栏: 挂对面没有意义, 而且两边都挂会让两个面板宽度不一致。
  const selfPlayer = selfPuuid ? data.find(p => p.puuid === selfPuuid) : null;
  const selfTeamNum = selfPlayer ? Number(selfPlayer.team) : 0;
  // 装备库没就绪时不出按钮, 避免点开是个空壳 (Data Dragon 首次加载有延迟)
  const canBuild = !!(selfPlayer && Number(selfPlayer.championId) > 0
    && typeof poroBuildEngine !== 'undefined' && poroBuildEngine && poroBuildEngine.itemDatabase);
  // 出装浮窗的上下文在这里无条件落地: 这里的 data/selfPuuid 就是刚渲染出按钮的那一份,
  // 不依赖 buildLiveDecisionPanel —— 那个函数在数据不全时会提前 return, 快照就是空的,
  // 而空快照正是"点按钮毫无反应"的来源。
  window._poroLiveCtx = { data, selfPuuid };
  const pageHtml = `
    ${enemyIntelHtml(data, selfPuuid)}
    <div class="lp-wrap">${teamPanel(blue, '蓝方', 'lp-blue', true, canBuild && selfTeamNum === 100)}${teamPanel(red, '红方', 'lp-red', false, canBuild && selfTeamNum === 200)}${unknown.length ? teamPanel(unknown, '队伍识别中', 'lp-unknown') : ''}</div>`;
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
    closeLiveBuildPop();
    body.innerHTML = '<div class="meta-loading">当前不在对局中。进入游戏后此处显示: 双方阵容、玩家战绩/段位、游戏时间、大龙/小龙/Buff 倒计时</div>';
    delete body.dataset.liveKey;   // 1.5.146: 骨架 key 守卫的失效点, 新对局必须重画
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
