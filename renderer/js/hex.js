// 海克斯大乱斗强化 + 克制关系
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 海克斯大乱斗强化 (HexBox 式自采样本库) ==========
// 样本来源: SGP 战绩 SUMMARY 的 playerAugment1-6 (queueId 2400), 随战绩查询自动积累
// 名称/图标: CommunityDragon cherry-augments.json (zh_cn 优先)
let hexAugMeta = {};    // id -> { name, icon, rarity, key }
// v2 同时保留全局统计与按英雄统计。champSeen 与 seen 分开，旧库再次读到历史对局时
// 只补英雄维度，不会把已有的全局统计重复计算。
let hexDB = { version: 2, seen: [], champSeen: [], aug: {}, champs: {} };
let _hexCollectorTimer = null;
let hexRecommendContext = { isHex: false, champId: 0, queueId: 0, checkedAt: 0, checking: false };
let _hexContextToken = 0;
let hexDataScope = 'all';
let hexBrowseStage = 'all';
let hexWinStats = { championId: 0, scope: 'all', loading: false, data: null, error: '', requestId: 0 };

function setHexDataScope(scope) {
  hexDataScope = scope === 'high' ? 'high' : 'all';
  storeSet('hexDataScope', hexDataScope);
  const id = +hexRecommendContext.champId || 0;
  hexWinStats = { championId: 0, scope: hexDataScope, loading: false, data: null, error: '', requestId: hexWinStats.requestId + 1 };
  if (id) loadHexWinStats(id, true);
  renderHexList();
}

function setHexBrowseStage(stage) {
  hexBrowseStage = ['1', '2', '3', '4'].includes(String(stage)) ? String(stage) : 'all';
  renderHexList();
}
const HEX_RARITY_CN = { kSilver: '白银', kGold: '黄金', kPrismatic: '棱彩', kNone: '' };

async function loadHexWinStats(championId, force = false) {
  const id = Number(championId) || 0;
  if (!id || typeof lolAPI.getHexChampionAugments !== 'function') return;
  if (!force && hexWinStats.championId === id && hexWinStats.scope === hexDataScope && (hexWinStats.loading || hexWinStats.data || hexWinStats.error)) return;
  const requestId = ++hexWinStats.requestId;
  hexWinStats = { championId: id, scope: hexDataScope, loading: true, data: null, error: '', requestId };
  if (document.querySelector('.page.active')?.id === 'page-hex') renderHexList();
  try {
    const data = await lolAPI.getHexChampionAugments(id, hexDataScope);
    if (requestId !== hexWinStats.requestId || id !== hexWinStats.championId || hexDataScope !== hexWinStats.scope) return;
    if (!data || data.__error || !data.augments) throw new Error(data?.message || '暂时无法获取胜率数据');
    hexWinStats = { championId: id, scope: hexDataScope, loading: false, data, error: '', requestId };
  } catch (error) {
    if (requestId !== hexWinStats.requestId || id !== hexWinStats.championId) return;
    hexWinStats = { championId: id, scope: hexDataScope, loading: false, data: null, error: error.message, requestId };
  }
  if (document.querySelector('.page.active')?.id === 'page-hex') renderHexList();
}

async function loadHexAugments() {
  const base = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global';
  const urls = [base + '/zh_cn/v1/cherry-augments.json', base + '/default/v1/cherry-augments.json'];
  for (const u of urls) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const arr = await r.json();
      hexAugMeta = {};
      for (const a of arr) {
        if (!a || a.id == null || a.id < 0) continue;
        const small = (a.augmentSmallIconPath || '').replace(/^\/lol-game-data\/assets\//i, '').toLowerCase();
        hexAugMeta[a.id] = {
          name: a.nameTRA || a.augmentNameId || String(a.id),
          icon: small ? 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/' + small : '',
          rarity: HEX_RARITY_CN[a.rarity] || '',
          key: a.augmentNameId || ''
        };
      }
      if (Object.keys(hexAugMeta).length) return;
    } catch (e) {}
  }
}
function normalizeHexDB(db) {
  const d = db && typeof db === 'object' ? db : {};
  d.version = 2;
  d.seen = Array.isArray(d.seen) ? d.seen : [];
  d.champSeen = Array.isArray(d.champSeen) ? d.champSeen : [];
  d.aug = d.aug && typeof d.aug === 'object' ? d.aug : {};
  d.champs = d.champs && typeof d.champs === 'object' ? d.champs : {};
  return d;
}

function hexParticipantChampionId(p) {
  const raw = p?.championId ?? p?.stats?.championId ?? 0;
  const id = +raw || 0;
  return id >= 60000 ? id - 60000 : id;
}

// 从 SGP 原始战绩 JSON 中采集强化样本 (增量, 按 gameId 去重)
function collectHexAugments(rawGames) {
  try {
    hexDB = normalizeHexDB(hexDB);
    const globalSeen = new Set(hexDB.seen.map(String));
    const championSeen = new Set(hexDB.champSeen.map(String));
    let dirty = false;
    for (const g of (rawGames || [])) {
      if (!g || (+g.queueId !== 2400 && g.gameMode !== 'JADE')) continue;
      const gameKey = String(g.gameId || '');
      if (!gameKey) continue;
      const addGlobal = !globalSeen.has(gameKey);
      const addChampion = !championSeen.has(gameKey);
      if (!addGlobal && !addChampion) continue;
      if (addGlobal) { hexDB.seen.push(g.gameId); globalSeen.add(gameKey); }
      if (addChampion) { hexDB.champSeen.push(g.gameId); championSeen.add(gameKey); }
      const winTeam = (g.teams || []).find(t => t.win === true || t.win === 'Win');
      for (const p of (g.participants || [])) {
        const won = p.win === true || p.win === 'Win' || (winTeam && p.teamId === winTeam.teamId);
        const augs = [...new Set([p.playerAugment1, p.playerAugment2, p.playerAugment3, p.playerAugment4, p.playerAugment5, p.playerAugment6]
          .map(Number).filter(v => v > 0))];
        for (const id of augs) {
          if (addGlobal) {
            if (!hexDB.aug[id]) hexDB.aug[id] = { g: 0, w: 0 };
            hexDB.aug[id].g++;
            if (won) hexDB.aug[id].w++;
          }
        }
        if (addChampion && augs.length) {
          const championId = hexParticipantChampionId(p);
          if (championId > 0) {
            const cs = hexDB.champs[championId] || (hexDB.champs[championId] = { g: 0, w: 0, aug: {} });
            cs.g = (+cs.g || 0) + 1;
            if (won) cs.w = (+cs.w || 0) + 1;
            cs.aug = cs.aug || {};
            for (const id of augs) {
              const as = cs.aug[id] || (cs.aug[id] = { g: 0, w: 0 });
              as.g = (+as.g || 0) + 1;
              if (won) as.w = (+as.w || 0) + 1;
            }
          }
        }
      }
      dirty = true;
    }
    if (dirty) {
      if (hexDB.seen.length > 3000) hexDB.seen = hexDB.seen.slice(-3000);
      if (hexDB.champSeen.length > 3000) hexDB.champSeen = hexDB.champSeen.slice(-3000);
      clearTimeout(_hexCollectorTimer);
      _hexCollectorTimer = setTimeout(saveHexDB, 1500);
      if (document.querySelector('.page.active')?.id === 'page-hex') renderHexList();
    }
  } catch (e) {}
}
function hexDBPath() { return (window._userDataPath || '') + '/hexdata.json'; }
async function saveHexDB() {
  try { await lolAPI.writeFile(hexDBPath(), JSON.stringify(hexDB)); } catch (e) {}
}
async function loadHexDB() {
  try {
    const c = await lolAPI.readFile(hexDBPath());
    if (c) { const d = JSON.parse(c); if (d && d.aug) hexDB = normalizeHexDB(d); }
  } catch (e) {}
}

function hexAdjustedWinRate(winRate, games, baseline, stage) {
  if (!Number.isFinite(winRate)) return null;
  const sample = Math.max(0, Number(games) || 0);
  const prior = stage === 'all' ? 1000 : 400;
  const center = Number.isFinite(baseline) ? baseline : 0.5;
  return (winRate * sample + center * prior) / (sample + prior);
}

function hexAugList(championId = 0, stage = 'all') {
  hexDB = normalizeHexDB(hexDB);
  const champ = championId > 0 ? hexDB.champs[String(championId)] : null;
  const publishedData = hexWinStats.championId === +championId ? hexWinStats.data : null;
  const stageKey = ['1', '2', '3', '4'].includes(String(stage)) ? String(stage) : 'all';
  const stageAugments = publishedData?.augmentStages?.[stageKey] || {};
  const publicAugments = stageKey === 'all' || !Object.keys(stageAugments).length
    ? (publishedData?.augments || {})
    : stageAugments;
  const ids = new Set([...Object.keys(hexAugMeta), ...Object.keys(hexDB.aug), ...Object.keys(champ?.aug || {}), ...Object.keys(publicAugments)]);
  const rows = [...ids].map(id => {
    const meta = hexAugMeta[id] || { name: '未知 #' + id, icon: '', rarity: '' };
    const s = hexDB.aug[id] || {};
    const globalGames = +s.g || 0;
    const own = champ?.aug?.[id];
    const heroGames = +own?.g || 0;
    const published = publicAugments[id] || null;
    return {
      id: +id, name: meta.name, icon: meta.icon, rarity: meta.rarity,
      key: meta.key || '', games: globalGames, heroGames,
      winRate: published && Number.isFinite(+published.winRate) ? +published.winRate : null,
      publicGames: published ? (+published.games || 0) : 0,
      pickRate: published ? (+published.pickRate || 0) : 0,
      sourceRank: published ? (+published.rank || 0) : 0,
      tier: published ? String(published.tier || '') : '',
      globalWinRate: published && Number.isFinite(+published.globalWinRate) ? +published.globalWinRate : null,
      availableStages: Array.isArray(published?.availableStages) ? published.availableStages : [],
      lift: published && Number.isFinite(+published.lift) ? +published.lift : null,
      adjustedWinRate: published ? hexAdjustedWinRate(+published.winRate, +published.games, publishedData?.baseline, stageKey) : null,
      stage: stageKey
    };
  });

  // CommunityDragon 可能同时提供通用版与 ARAM 版 ID；同名项合并成一张卡片。
  const merged = new Map();
  for (const row of rows) {
    const groupKey = String(row.name || '').trim().toLocaleLowerCase('zh-CN') || String(row.id);
    const previous = merged.get(groupKey);
    if (!previous) {
      merged.set(groupKey, Object.assign({}, row, { sourceIds: [row.id] }));
      continue;
    }
    previous.games += row.games;
    previous.heroGames += row.heroGames;
    previous.sourceIds.push(row.id);
    // 海克斯大乱斗优先使用 ARAM 专用元数据与图标。
    const preferRow = String(row.key).startsWith('ARAM_') && !String(previous.key).startsWith('ARAM_');
    if (preferRow) Object.assign(previous, {
      id: row.id, icon: row.icon, rarity: row.rarity, key: row.key
    });
    if (Number.isFinite(row.winRate) && (!Number.isFinite(previous.winRate) || row.publicGames >= previous.publicGames)) {
      previous.winRate = row.winRate;
      previous.publicGames = row.publicGames;
      previous.pickRate = row.pickRate;
      previous.sourceRank = row.sourceRank;
      previous.tier = row.tier;
      previous.globalWinRate = row.globalWinRate;
      previous.availableStages = row.availableStages;
      previous.lift = row.lift;
      previous.adjustedWinRate = row.adjustedWinRate;
    }
  }
  return [...merged.values()].sort((a, b) =>
    Number.isFinite(b.adjustedWinRate) - Number.isFinite(a.adjustedWinRate)
      || (Number.isFinite(b.adjustedWinRate) && Number.isFinite(a.adjustedWinRate) ? b.adjustedWinRate - a.adjustedWinRate : 0)
      || (Number.isFinite(b.winRate) && Number.isFinite(a.winRate) ? b.winRate - a.winRate : 0)
      || b.publicGames - a.publicGames
      || b.heroGames - a.heroGames
      || b.games - a.games
      || a.name.localeCompare(b.name, 'zh-CN'));
}

function hexSelectedChampion(session) {
  if (!session) return 0;
  const mine = (session.myTeam || []).find(p => p && (p.cellId === session.localPlayerCellId || (window._myPuuid && p.puuid === window._myPuuid)));
  let id = +(mine?.championId || mine?.championPickIntent || 0);
  if (!id && Array.isArray(session.actions)) {
    const actions = session.actions.flat().filter(a => a && a.type === 'pick' && a.actorCellId === session.localPlayerCellId && +a.championId > 0);
    if (actions.length) id = +actions[actions.length - 1].championId;
  }
  return id >= 60000 ? id - 60000 : id;
}

function hexFlowChampion(flow) {
  const gameData = flow?.gameData || {};
  const rows = [
    ...(Array.isArray(gameData.playerChampionSelections) ? gameData.playerChampionSelections : []),
    ...(Array.isArray(gameData.teamOne) ? gameData.teamOne : []),
    ...(Array.isArray(gameData.teamTwo) ? gameData.teamTwo : [])
  ];
  const mine = rows.find(p => p && window._myPuuid && String(p.puuid || p.playerPuuid || '') === String(window._myPuuid));
  let id = +(mine?.championId || mine?.championPickIntent || mine?.selectedChampionId || 0);
  // 部分客户端只在 gameflow 根节点保留本地玩家选择。
  if (!id) id = +(flow?.playerChampionId || gameData.playerChampionId || 0);
  return id >= 60000 ? id - 60000 : id;
}

async function updateHexRecommendationContext(session, force = false) {
  // GameStart 后 champ-select session 会被删除，此时不能用空 session 清掉刚选定的英雄。
  const sessionChampionId = session ? hexSelectedChampion(session) : 0;
  if (session && sessionChampionId !== hexRecommendContext.champId) {
    hexRecommendContext.champId = sessionChampionId;
    if (document.querySelector('.page.active')?.id === 'page-hex') renderHexList();
  }
  const now = Date.now();
  if (!force && (hexRecommendContext.checking || now - hexRecommendContext.checkedAt < 1800)) return;
  hexRecommendContext.checking = true;
  const token = ++_hexContextToken;
  try {
    const flow = await lolAPI.lcuRequest('GET', '/lol-gameflow/v1/session');
    if (token !== _hexContextToken) return;
    const queue = flow?.gameData?.queue || {};
    const queueId = +(queue.id || flow?.gameData?.queueId || 0);
    const mode = String(queue.gameMode || flow?.gameData?.gameMode || '').toUpperCase();
    const detail = String(queue.detailedDescription || '').toUpperCase();
    const queueText = [mode, detail, queue.name, queue.shortName, flow?.gameData?.gameMode]
      .filter(Boolean).join(' ').toUpperCase();
    hexRecommendContext.queueId = queueId;
    hexRecommendContext.isHex = queueId === 2400 || /(^|[^A-Z])(KIWI_JADE|JADE|ARAM MAYHEM|MAYHEM)([^A-Z]|$)/.test(queueText)
      || queueText.includes('海克斯') || queueText.includes('海斗');
    const flowChampionId = hexFlowChampion(flow);
    if (flowChampionId && flowChampionId !== hexRecommendContext.champId) hexRecommendContext.champId = flowChampionId;
    const gameRows = [
      ...(Array.isArray(flow?.gameData?.playerChampionSelections) ? flow.gameData.playerChampionSelections : []),
      ...(Array.isArray(flow?.gameData?.teamOne) ? flow.gameData.teamOne : []),
      ...(Array.isArray(flow?.gameData?.teamTwo) ? flow.gameData.teamTwo : [])
    ];
    const localRow = gameRows.find(row => row && window._myPuuid && String(row.puuid || row.playerPuuid || '') === String(window._myPuuid));
    const flowAugments = augmentIdsFromPlayer(localRow);
    if (flowAugments.length) {
      _augmentKnownSelectedIds = flowAugments;
      _augmentCurrentStage = Math.min(4, flowAugments.length + 1);
    }
  } catch (e) {
    // 短暂读取失败时保留本局已确认状态，避免推荐卡片闪烁。
  } finally {
    if (token === _hexContextToken) {
      hexRecommendContext.checkedAt = Date.now();
      hexRecommendContext.checking = false;
      if (document.querySelector('.page.active')?.id === 'page-hex') renderHexList();
    }
  }
}

function resetHexRecommendationContext() {
  _hexContextToken++;
  hexRecommendContext = { isHex: false, champId: 0, queueId: 0, checkedAt: 0, checking: false };
  hexWinStats = { championId: 0, scope: hexDataScope, loading: false, data: null, error: '', requestId: hexWinStats.requestId + 1 };
  _augmentCurrentStage = 1;
  _augmentKnownSelectedIds = [];
  _augmentLiveProbe = { checkedAt: 0, pending: null, state: null };
  if (document.querySelector('.page.active')?.id === 'page-hex') renderHexList();
  stopAugmentRecognition();
}

// ========== 对局内三选一强化识别 ==========
let _augmentScanTimer = null;
let _augmentScanBusy = false;
let _augmentScanFailures = 0;
let _augmentLastOfferKey = '';
let _augmentLayoutMisses = 0;
let _augmentShownAt = 0;
let _augmentManualPending = false;
let _augmentOfferMemory = new Map();
let _augmentVisionMemory = new Map();
let _augmentLastPayload = null;
let _augmentOverlayHeartbeatAt = 0;
const AUGMENT_OFFER_MEMORY_MS = 6500;
const AUGMENT_LAYOUT_MISSES_TO_HIDE = 3;
const AUGMENT_MIN_VISIBLE_MS = 1800;
let _augmentCurrentStage = 1;
let _augmentKnownSelectedIds = [];
let _augmentShownSelectedCount = null;
let _augmentLiveProbe = { checkedAt: 0, pending: null, state: null };

function augmentIdsFromPlayer(player) {
  if (!player || typeof player !== 'object') return [];
  const values = [];
  for (let i = 1; i <= 6; i++) values.push(player['playerAugment' + i], player['augment' + i]);
  for (const key of ['augments', 'augmentIds', 'playerAugments']) {
    const rows = player[key];
    if (Array.isArray(rows)) for (const row of rows) values.push(typeof row === 'object' ? (row.id ?? row.augmentId) : row);
  }
  return [...new Set(values.map(Number).filter(id => Number.isInteger(id) && id > 0))];
}

function augmentStageFromLevel(level) {
  const value = Number(level) || 0;
  if (!value || value < 7) return 1;
  if (value < 11) return 2;
  if (value < 15) return 3;
  return 4;
}

async function probeLiveAugmentState(force = false) {
  const now = Date.now();
  if (!force && now - _augmentLiveProbe.checkedAt < 1200) return _augmentLiveProbe.pending || _augmentLiveProbe.state;
  if (_augmentLiveProbe.pending) return _augmentLiveProbe.pending;
  _augmentLiveProbe.pending = (async () => {
    let itemIds = [];
    try {
      const data = await lolAPI.liveGameData();
      if (data && !data.__error) {
        _augmentCurrentStage = augmentStageFromLevel(data.activePlayer?.level);
        const localName = String(data.activePlayer?.summonerName || data.activePlayer?.riotIdGameName || '');
        const player = (data.allPlayers || []).find(row => row?.isActivePlayer || (localName && String(row?.summonerName || row?.riotIdGameName || '') === localName));
        const ids = augmentIdsFromPlayer(player || data.activePlayer);
        itemIds = (player?.items || data.activePlayer?.items || [])
          .map(item => Number(item?.itemID ?? item?.itemId ?? item?.id ?? item))
          .filter(id => Number.isInteger(id) && id > 0 && id !== 3340);
        if (ids.length) {
          _augmentKnownSelectedIds = ids;
          _augmentCurrentStage = Math.max(_augmentCurrentStage, Math.min(4, ids.length + 1));
        }
      }
    } catch (e) {}
    _augmentLiveProbe.checkedAt = Date.now();
    _augmentLiveProbe.state = { stage: _augmentCurrentStage, selectedIds: _augmentKnownSelectedIds.slice(), itemIds };
    _augmentLiveProbe.pending = null;
    return _augmentLiveProbe.state;
  })();
  return _augmentLiveProbe.pending;
}

function bestAugmentCombination(candidateId, selectedIds, published) {
  const selected = (selectedIds || []).filter(id => id !== candidateId);
  if (!selected.length) return null;
  return (published?.augmentCombinations || [])
    .filter(combo => combo.augmentIds?.includes(candidateId) && selected.some(id => combo.augmentIds.includes(id)))
    .sort((a, b) => {
      const overlapA = selected.filter(id => a.augmentIds.includes(id)).length;
      const overlapB = selected.filter(id => b.augmentIds.includes(id)).length;
      const aa = hexAdjustedWinRate(+a.winRate, +a.games, published?.baseline, 'combo') || 0;
      const bb = hexAdjustedWinRate(+b.winRate, +b.games, published?.baseline, 'combo') || 0;
      return overlapB - overlapA || bb - aa || (+b.games || 0) - (+a.games || 0);
    })[0] || null;
}

function augmentSampleConfidence(games, comboGames = 0) {
  const sample = Math.max(Number(games) || 0, Number(comboGames) || 0);
  if (sample >= 20000) return { level: 'high', label: '高可信' };
  if (sample >= 3000) return { level: 'medium', label: '中可信' };
  return { level: 'low', label: '低样本' };
}

function normalizedHexText(value) {
  return String(value || '').toLocaleLowerCase('zh-CN').replace(/[\s·:：\-—_（）()【】\[\]]+/g, '');
}

// 只有强化明确点名当前装备时才增加装备协同，避免主观职业标签覆盖真实胜率。
function augmentOwnedItemSynergy(augment, itemIds) {
  const augmentText = normalizedHexText((augment?.name || '') + (augment?.key || ''));
  if (!augmentText || !Array.isArray(itemIds) || !itemIds.length) return null;
  for (const id of itemIds) {
    const item = allItems?.[String(id)] || allItems?.[id];
    const itemName = normalizedHexText(item?.name);
    if (itemName.length >= 3 && augmentText.includes(itemName)) return { id, name: item.name };
  }
  return null;
}

function scoreAugmentRecommendation(stat, combo, context, baseline) {
  const base = Number.isFinite(stat?.adjustedWinRate)
    ? stat.adjustedWinRate
    : (Number.isFinite(stat?.winRate) ? stat.winRate : (Number.isFinite(baseline) ? baseline : 0.5));
  const comboAdjusted = combo ? hexAdjustedWinRate(+combo.winRate, +combo.games, baseline, 'combo') : null;
  // 组合样本越多权重越高，但最多只占一半，避免小样本组合推翻稳定的英雄/轮次数据。
  const comboWeight = Number.isFinite(comboAdjusted)
    ? Math.min(0.5, Math.max(0.12, (Number(combo.games) || 0) / ((Number(combo.games) || 0) + 5000) * 0.5))
    : 0;
  let score = Number.isFinite(comboAdjusted) ? base * (1 - comboWeight) + comboAdjusted * comboWeight : base;
  const itemSynergy = augmentOwnedItemSynergy(stat, context?.itemIds);
  if (itemSynergy) score += 0.008;
  const confidence = augmentSampleConfidence(stat?.publicGames, combo?.games);
  const reasons = [];
  if (combo && Number.isFinite(+combo.winRate)) {
    reasons.push(`与已选强化联动 ${(Number(combo.winRate) * 100).toFixed(1)}% / ${hexCompactNumber(combo.games)}场`);
  } else if (Number.isFinite(stat?.winRate)) {
    reasons.push(`第${context?.stage || stat?.stage || 1}轮英雄数据`);
  } else {
    reasons.push('暂无可靠胜率样本');
  }
  if (itemSynergy) reasons.push(`适配已装备${itemSynergy.name}`);
  if (confidence.level === 'low' && Number.isFinite(stat?.winRate)) reasons.push('已做低样本保守修正');
  return { score, comboAdjusted, comboWeight, itemSynergy, confidence, reason: reasons.join(' · ') };
}

function augmentCandidateRows(championId) {
  const rows = hexAugList(championId);
  // 所有当前 CommunityDragon 强化都交给 OCR 做名称确认。公开胜率只影响图标冲突时的优先级，
  // 不能充当白名单，否则刚上线或样本不足的强化会永远无法被识别。
  return rows.filter(row => row.icon).map(row => ({
    id: row.id,
    name: row.name,
    icon: row.icon,
    priority: row.publicGames || 0
  }));
}

function hideAugmentRecommendation() {
  _augmentLastOfferKey = '';
  _augmentLayoutMisses = 0;
  _augmentShownAt = 0;
  _augmentOfferMemory.clear();
  _augmentVisionMemory.clear();
  _augmentLastPayload = null;
  _augmentShownSelectedCount = null;
  if (window.lolAPI?.augmentOverlayUpdate) {
    lolAPI.augmentOverlayUpdate({ visible: false, items: [] }).catch(() => {});
  }
}

async function restoreAugmentOverlayIfNeeded() {
  if (!_augmentLastPayload || Date.now() - _augmentOverlayHeartbeatAt < 1500) return;
  _augmentOverlayHeartbeatAt = Date.now();
  try {
    const status = window.lolAPI?.augmentOverlayStatus ? await lolAPI.augmentOverlayStatus() : null;
    if (!status?.visible) await lolAPI.augmentOverlayUpdate(_augmentLastPayload);
  } catch (e) {}
}

async function scanCurrentAugmentOffers(manual = false) {
  if (!window.lolAPI?.recognizeAugments) return false;
  if (_augmentScanBusy) {
    if (manual) _augmentManualPending = true;
    return false;
  }
  _augmentScanBusy = true;
  try {
    await updateHexRecommendationContext(null, false);
    const championId = +hexRecommendContext.champId || 0;
    if (!hexRecommendContext.isHex || !championId) {
      if (manual) lolAPI.notify?.('Poro 海斗强化', '尚未识别到海克斯大乱斗或当前英雄');
      // Gameflow 在加载/重连时可能短暂返回旧队列；保持监听，下一轮自动恢复，不能永久停扫。
      return false;
    }
    if (hexWinStats.championId !== championId || (!hexWinStats.data && !hexWinStats.loading)) {
      await loadHexWinStats(championId);
    }
    const liveState = await probeLiveAugmentState(manual);
    const stage = liveState?.stage || _augmentCurrentStage || 1;
    // Live Client Data 一旦确认已选强化数量增加，说明点击已经落地，不需要再等
    // 画面识别超时；连续视觉判定只作为没有强化字段时的兜底。
    const selectedCount = Array.isArray(liveState?.selectedIds) ? liveState.selectedIds.length : 0;
    if (_augmentLastPayload && _augmentShownSelectedCount !== null && selectedCount > _augmentShownSelectedCount) {
      hideAugmentRecommendation();
      lolAPI.debugLog?.(`[AUGMENT OVERLAY] hidden after selection count ${_augmentShownSelectedCount}->${selectedCount}`);
      return true;
    }
    const all = hexAugList(championId, String(stage));
    const result = await lolAPI.recognizeAugments(augmentCandidateRows(championId));
    if (!result || result.__error) {
      _augmentScanFailures++;
      if (manual) lolAPI.notify?.('Poro 海斗强化', result?.__error || '未能识别当前强化选项');
      return false;
    }
    // 只有卡片布局连续消失，才能判断玩家已经选完。OCR 临时失败、卡片动画和光效
    // 都不能清掉上一轮正确推荐，否则会出现“还没选完提示就消失”。
    // 旧版主进程的成功结果没有携带 layoutDetected 字段；只有明确返回 false
    // 才能判定卡片布局已经消失，不能把“字段缺失”误当成未检测到。
    if (result.layoutDetected === false) {
      _augmentLayoutMisses++;
      if (_augmentLastOfferKey && _augmentLayoutMisses >= AUGMENT_LAYOUT_MISSES_TO_HIDE && Date.now() - _augmentShownAt >= AUGMENT_MIN_VISIBLE_MS) {
        hideAugmentRecommendation();
      }
      if (manual) lolAPI.notify?.('Poro 海斗强化', '画面中未检测到三张强化卡');
      return false;
    }
    _augmentLayoutMisses = 0;
    const now = Date.now();
    // 后期棱彩光效会让单次 OCR 偶尔漏掉一张。OCR 命中立即采信；图标识别必须
    // 同一槽位连续两帧同名才作为兜底，既提升第三/四轮成功率，也避免单帧误判。
    for (const offer of (result.offers || [])) {
      const slot = Number(offer?.slot);
      if (!offer?.accepted || !offer?.name || slot < 0 || slot > 2) continue;
      if (offer.confirmedBy === 'ocr' || !offer.confirmedBy) {
        _augmentOfferMemory.set(slot, Object.assign({}, offer, { seenAt: now }));
        _augmentVisionMemory.delete(slot);
      } else if (String(offer.confirmedBy || '').startsWith('vision')) {
        const previous = _augmentVisionMemory.get(slot);
        const hits = previous && previous.name === offer.name && now - previous.seenAt <= AUGMENT_OFFER_MEMORY_MS ? previous.hits + 1 : 1;
        _augmentVisionMemory.set(slot, { name: offer.name, hits, seenAt: now });
        if (hits >= 2) _augmentOfferMemory.set(slot, Object.assign({}, offer, { seenAt: now, confirmedBy: 'vision-repeat' }));
      }
    }
    for (const [slot, offer] of _augmentOfferMemory) {
      if (now - offer.seenAt > AUGMENT_OFFER_MEMORY_MS) _augmentOfferMemory.delete(slot);
    }
    const detected = [0, 1, 2].map(slot => _augmentOfferMemory.get(slot)).filter(Boolean);
    const uniqueNames = new Set(detected.map(x => x.name));
    const seenTimes = detected.map(x => x.seenAt);
    const sameRound = seenTimes.length === 3 && Math.max(...seenTimes) - Math.min(...seenTimes) <= AUGMENT_OFFER_MEMORY_MS;
    if (detected.length !== 3 || uniqueNames.size !== 3 || !sameRound) {
      _augmentScanFailures++;
      await restoreAugmentOverlayIfNeeded();
      if (manual) {
        const found = detected.map(x => x.name).filter(Boolean).join('、');
        lolAPI.notify?.('Poro 海斗强化', found ? '只识别到：' + found + '，请保持强化选择画面后重试' : '画面中未检测到三张强化卡');
      }
      return false;
    }
    _augmentScanFailures = 0;
    const rows = detected.map(offer => {
      const stat = all.find(row => row.id === offer.id || row.name === offer.name) || {};
      const combo = bestAugmentCombination(stat.id || offer.id, liveState?.selectedIds, hexWinStats.data);
      const scored = scoreAugmentRecommendation(stat, combo, {
        stage,
        itemIds: liveState?.itemIds || []
      }, hexWinStats.data?.baseline);
      return {
        slot: offer.slot,
        name: offer.name,
        icon: offer.icon || stat.icon || '',
        winRate: Number.isFinite(stat.winRate) ? stat.winRate : null,
        adjustedWinRate: Number.isFinite(stat.adjustedWinRate) ? stat.adjustedWinRate : null,
        games: stat.publicGames || 0,
        tier: stat.tier || '',
        lift: Number.isFinite(stat.lift) ? stat.lift : null,
        comboWinRate: combo?.winRate ?? null,
        comboGames: combo?.games || 0,
        recommendationScore: scored.score,
        confidenceLevel: scored.confidence.level,
        confidenceLabel: scored.confidence.label,
        reason: scored.reason,
        itemSynergy: scored.itemSynergy?.name || '',
        confidence: offer.score || 0
      };
    }).sort((a, b) =>
      Number.isFinite(b.recommendationScore) - Number.isFinite(a.recommendationScore)
        || (Number.isFinite(a.recommendationScore) && Number.isFinite(b.recommendationScore) ? b.recommendationScore - a.recommendationScore : 0)
        || (Number.isFinite(a.winRate) && Number.isFinite(b.winRate) ? b.winRate - a.winRate : 0)
        || b.games - a.games
        || a.slot - b.slot);
    const key = championId + ':' + rows.map(row => row.slot + '-' + row.name).join('|');
    const isNewOffer = key !== _augmentLastOfferKey;
    _augmentLastOfferKey = key;
    if (isNewOffer || !_augmentShownAt) {
      _augmentShownAt = Date.now();
      _augmentShownSelectedCount = selectedCount;
    }
    ensureChampMap();
    const champion = champNumMap?.[String(championId)];
    const overlayPayload = {
      visible: true,
      champion: champion?.name || ('英雄 #' + championId),
      state: rows.some(row => !Number.isFinite(row.winRate))
        ? `第${stage}轮 · 部分选项暂无样本 · F6 重扫`
        : `第${stage}轮 · 阶段胜率${liveState?.selectedIds?.length ? ' + 已选组合' : ''} · F6 重扫`,
      items: rows
    };
    _augmentLastPayload = overlayPayload;
    _augmentOverlayHeartbeatAt = Date.now();
    const overlayResult = await lolAPI.augmentOverlayUpdate(overlayPayload);
    try {
      const status = window.lolAPI?.augmentOverlayStatus ? await lolAPI.augmentOverlayStatus() : overlayResult;
      lolAPI.debugLog?.('[AUGMENT OVERLAY] update result=' + JSON.stringify(overlayResult) + ' status=' + JSON.stringify(status));
    } catch (e) {
      lolAPI.debugLog?.('[AUGMENT OVERLAY] status failed: ' + e.message);
    }
    if (manual || isNewOffer) {
      lolAPI.notify?.('Poro 海斗强化', '推荐：' + rows.map((row, i) => (i + 1) + '.' + row.name).join('  '));
    }
    return true;
  } catch (error) {
    _augmentScanFailures++;
    lolAPI.debugLog?.('[AUGMENT SCAN] failed: ' + (error?.stack || error?.message || String(error)));
    if (manual) lolAPI.notify?.('Poro 海斗强化', error.message || '识别失败');
    return false;
  } finally {
    _augmentScanBusy = false;
    if (_augmentManualPending) {
      _augmentManualPending = false;
      setTimeout(() => scanCurrentAugmentOffers(true), 0);
    }
  }
}

function startAugmentRecognition() {
  if (_augmentScanTimer) return;
  _augmentScanFailures = 0;
  setTimeout(() => scanCurrentAugmentOffers(false), 100);
  _augmentScanTimer = setInterval(() => scanCurrentAugmentOffers(false), 500);
}

function stopAugmentRecognition() {
  if (_augmentScanTimer) clearInterval(_augmentScanTimer);
  _augmentScanTimer = null;
  _augmentScanBusy = false;
  _augmentScanFailures = 0;
  _augmentManualPending = false;
  _augmentOfferMemory.clear();
  _augmentVisionMemory.clear();
  hideAugmentRecommendation();
}

function syncAugmentRecognitionForPhase(phase) {
  if (phase === 'GameStart' || phase === 'InProgress') startAugmentRecognition();
  else stopAugmentRecognition();
}

if (window.lolAPI?.onAugmentShortcut) lolAPI.onAugmentShortcut(() => scanCurrentAugmentOffers(true));

function hexCompactNumber(value) {
  const n = Number(value) || 0;
  if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 1 : 2).replace(/\.0$/, '') + '万';
  return n.toLocaleString('zh-CN');
}

function hexPercent(value, digits = 1) {
  return Number.isFinite(Number(value)) ? (Number(value) * 100).toFixed(digits) + '%' : '--';
}

function hexSpellMeta(id) {
  return Object.values(allSpells || {}).find(spell => Number(spell?.key) === Number(id)) || null;
}

function hexGuideIcon(url, title) {
  return url ? `<img src="${escapeHtml(url)}" title="${escapeHtml(title || '')}" onerror="this.style.display='none'">` : '';
}

function renderHexGuides(published) {
  const el = document.getElementById('hexGuides');
  if (!el) return;
  if (!published) {
    el.innerHTML = hexWinStats.loading ? '<div class="hex-guide-loading">正在加载出装、召唤师技能和加点数据…</div>' : '';
    return;
  }
  const champion = published.champion || {};
  const scopeLabel = published.scope === 'high' ? '高分段' : '全分段';
  const spells = (published.summoners || []).slice(0, 3).map(row => {
    const icons = row.spellIds.map(id => {
      const spell = hexSpellMeta(id);
      const url = spell ? `https://ddragon.leagueoflegends.com/cdn/${version}/img/spell/${spell.image?.full || ''}` : '';
      return hexGuideIcon(url, spell?.name || ('技能 ' + id));
    }).join('');
    return `<div class="hex-guide-row"><span class="hex-guide-icons">${icons}</span><b>${hexPercent(row.winRate)}</b><small>${hexCompactNumber(row.games)}场</small></div>`;
  }).join('') || '<span class="hex-guide-muted">暂无召唤师技能样本</span>';
  const skills = (published.skills || []).slice(0, 3).map(row =>
    `<div class="hex-guide-row"><strong>${escapeHtml(row.order.replaceAll('>', ' → '))}</strong><b>${hexPercent(row.winRate)}</b><small>${hexCompactNumber(row.games)}场</small></div>`
  ).join('') || '<span class="hex-guide-muted">暂无加点样本</span>';
  const archetypeNames = { crit: '暴击', lethality: '穿甲', ap: '法强', tank: '坦克', bruiser: '战士', onhit: '攻击特效', support: '辅助', marksman: '射手', assassin: '刺客', fighter: '战士', mage: '法师' };
  const builds = (published.builds?.filtered || []).slice(0, 4).map(row => {
    const buildIcons = (row.itemIds || []).map(id => hexGuideIcon(`https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${id}.png`, allItems?.[String(id)]?.name || '')).join('');
    return `<div class="hex-build-row"><span><strong>${escapeHtml(archetypeNames[row.key] || row.key)}</strong><i>${buildIcons}</i></span><b>${hexPercent(row.winRate)}</b><small>${hexCompactNumber(row.games)}场</small></div>`;
  }).join('') || '<span class="hex-guide-muted">暂无流派样本</span>';
  const items = (published.items?.filtered?.all || []).slice(0, 8).map(row => {
    const item = allItems?.[String(row.id)] || allItems?.[row.id];
    const url = `https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${row.id}.png`;
    return `<div class="hex-item" title="${escapeHtml(item?.name || ('装备 ' + row.id))} · 胜率 ${hexPercent(row.winRate)} · ${hexCompactNumber(row.games)}场">${hexGuideIcon(url, item?.name || '')}<span>${hexPercent(row.winRate)}</span></div>`;
  }).join('') || '<span class="hex-guide-muted">暂无装备样本</span>';
  const combos = (published.augmentCombinations || []).slice().sort((a, b) => {
    const aa = hexAdjustedWinRate(+a.winRate, +a.games, published.baseline, 'combo') || 0;
    const bb = hexAdjustedWinRate(+b.winRate, +b.games, published.baseline, 'combo') || 0;
    return bb - aa || b.games - a.games;
  }).slice(0, 3).map(row => {
    const names = row.augmentIds.map(id => hexAugMeta[id]?.name || ('#' + id)).join(' + ');
    return `<div class="hex-combo"><span>${escapeHtml(names)}</span><b>${hexPercent(row.winRate)}</b><small>${hexCompactNumber(row.games)}场</small></div>`;
  }).join('') || '<span class="hex-guide-muted">暂无组合样本</span>';
  el.innerHTML = `<div class="hex-guide-card hex-guide-summary"><h4>${scopeLabel}英雄表现</h4><div class="hex-summary-value">${hexPercent(champion.winRate)} <small>胜率</small></div><p>${escapeHtml(champion.tier || '--')}级 · 排名 ${champion.rank || '--'} · KDA ${Number.isFinite(champion.kda) ? champion.kda.toFixed(2) : '--'} · ${hexCompactNumber(published.championGames)}场</p></div>
    <div class="hex-guide-card"><h4>推荐召唤师技能</h4>${spells}</div>
    <div class="hex-guide-card"><h4>技能加点顺序</h4>${skills}</div>
    <div class="hex-guide-card"><h4>海斗出装流派</h4>${builds}</div>
    <div class="hex-guide-card hex-guide-wide"><h4>高胜率装备</h4><div class="hex-items">${items}</div></div>
    <div class="hex-guide-card hex-guide-wide"><h4>高胜率强化组合</h4>${combos}</div>`;
}

function renderHexList(filter = "") {
  const el = document.getElementById('hexList');
  if (!el) return;
  const context = document.getElementById('hexContext');
  const isHex = !!hexRecommendContext.isHex;
  const championId = isHex ? +hexRecommendContext.champId || 0 : 0;
  ensureChampMap();
  const champion = championId ? champNumMap?.[String(championId)] : null;
  const champStats = championId ? hexDB.champs?.[String(championId)] : null;
  if (championId && hexWinStats.championId !== championId) loadHexWinStats(championId);
  const published = hexWinStats.championId === championId ? hexWinStats.data : null;
  if (context) {
    if (!isHex) {
      context.className = 'hex-context waiting';
      context.innerHTML = '<div class="hex-context-mark">⌛</div><div><b>等待海克斯大乱斗选人</b><span>进入模式后会自动识别当前所选英雄，并按英雄适配数据排序。</span></div>';
    } else if (!championId) {
      context.className = 'hex-context active';
      context.innerHTML = '<div class="hex-context-mark">✦</div><div><b>已识别海克斯大乱斗</b><span>选择或悬停英雄后，这里会立即切换为英雄专属推荐。</span></div>';
    } else {
      const name = champion?.name || ('英雄 #' + championId);
      const image = champion ? '<img src="' + escapeHtml(champImg(champion.id)) + '" onerror="this.style.display=\'none\'">' : '<div class="hex-context-mark">✦</div>';
      const sampleText = champStats?.g ? `你的个人历史 ${champStats.g} 场` : '尚无该英雄的个人强化记录';
      context.className = 'hex-context active';
      let sourceText = '真实对局胜率加载中…';
      if (published) sourceText = `ARAMKit ${published.version || ''} · 英雄样本 ${hexCompactNumber(published.championGames)}${published.stale ? ' · 离线缓存' : ''}`;
      else if (hexWinStats.championId === championId && hexWinStats.error) sourceText = '胜率数据暂时不可用，已回退个人记录';
      context.innerHTML = image + '<div><b>' + escapeHtml(name) + ' · 强化胜率排序</b><span>' + escapeHtml(sourceText) + '；' + escapeHtml(sampleText) + '。</span></div>';
    }
  }
  const all = hexAugList(championId, hexBrowseStage);
  renderHexGuides(championId ? published : null);
  const stats = document.getElementById('hexStats');
  if (stats) {
    const tg = all.reduce((s, a) => s + a.games, 0);
    const publicCount = all.filter(row => Number.isFinite(row.winRate)).length;
    const stageLabel = hexBrowseStage === 'all' ? '综合' : `第 ${hexBrowseStage} 轮`;
    const scopeLabel = hexDataScope === 'high' ? '高分段' : '全分段';
    stats.textContent = published
      ? `${scopeLabel} · ${stageLabel}真实胜率 ${publicCount} 个 · 版本 ${published.version || '--'} · 数据日期 ${published.dataDate || '--'} · 数据源 ARAMKit`
      : (hexWinStats.loading ? '正在加载真实对局胜率…' : `个人总使用 ${tg} 次`);
  }
  if (!isHex) {
    el.innerHTML = '<div class="hex-empty"><b>等待海克斯大乱斗</b><span>进入选人后显示官方静态强化资料及你的个人使用记录。</span></div>';
    return;
  }
  if (!championId) {
    el.innerHTML = '<div class="hex-empty"><b>请选择英雄</b><span>锁定或悬停英雄后，推荐列表会自动出现。</span></div>';
    return;
  }
  const f = filter.trim().toLowerCase();
  let list = all;
  if (hexAugMeta && Object.keys(hexAugMeta).length) list = list.filter(a => a.name.toLowerCase().includes(f));
  if (!list.length) {
    el.innerHTML = '<div class="meta-loading">没有匹配的强化</div>';
    return;
  }
  el.innerHTML = list.map((a, index) => {
    const heroLabel = a.heroGames ? `该英雄用过 ${a.heroGames} 次` : '该英雄未记录';
    const hasWinRate = Number.isFinite(a.winRate);
    const winLabel = hasWinRate ? (a.winRate * 100).toFixed(2) + '%' : '--';
    const adjustedLabel = Number.isFinite(a.adjustedWinRate) ? `可信度修正 ${(a.adjustedWinRate * 100).toFixed(2)}%` : heroLabel;
    const sampleLabel = a.publicGames ? `${hexCompactNumber(a.publicGames)}场 · 选取 ${(a.pickRate * 100).toFixed(2)}%` : heroLabel;
    return `<div class="hex-row" title="${escapeHtml(a.name)} · ${escapeHtml(heroLabel)}">
      <div class="hex-rank">${index + 1}</div>
      <img class="hex-icon" src="${escapeHtml(a.icon)}" onerror="this.style.visibility='hidden'">
      <div class="hex-name">${escapeHtml(a.name)}<span class="hex-rarity">${escapeHtml(a.rarity)}</span><span class="hex-fit">${escapeHtml(adjustedLabel)}</span></div>
      <div class="hex-tier t-${escapeHtml(a.tier || '')}">${escapeHtml(a.tier || '--')}</div>
      <div class="hex-wr${hasWinRate ? '' : ' unavailable'}">${escapeHtml(winLabel)}<small>胜率</small></div>
      <div class="hex-sample">${escapeHtml(sampleLabel)}</div>
    </div>`;
  }).join('');
}
function filterHexList() { renderHexList(document.getElementById('hexSearch')?.value || ''); }

function renderOpggGameDetail(norm, container) {
  const rating = p => p.k + p.a * 0.7 - p.d * 0.5 + (p.dmg || 0) / 4000 + (p.gold || 0) / 6000;
  const teams = {};
  for (const p of norm.participants) (teams[p.teamId] = teams[p.teamId] || []).push(p);
  const tids = Object.keys(teams);
  const fmtNum = n => Number(n).toLocaleString('en-US');
  const teamLabel = tid => tid == '100' ? '蓝队' : '红队';
  const teamKills = tid => (teams[tid] || []).reduce((s, p) => s + p.k, 0);
  const itemIcon = id => id ? `https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${id}.png` : '';
  // 全场操作分数排名 + MVP(胜方最佳)/ACE(败方最佳)
  const allSorted = norm.participants.slice().sort((a, b) => rating(b) - rating(a));
  const rankMap = {}, mvpSet = {}, aceSet = {};
  const pkey = p => `${p.puuid || ''}_${p.name || ''}`;
  allSorted.forEach((p, i) => { rankMap[pkey(p)] = i + 1; });
  for (const tid of tids) {
    const list = teams[tid];
    const won = list.some(p => p.win);
    const best = list.slice().sort((a, b) => rating(b) - rating(a))[0];
    if (won) mvpSet[pkey(best)] = true; else aceSet[pkey(best)] = true;
  }
  const ordinal = n => n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n] || 'th');
  // 按位置排序 (op.gg: 上单→打野→中单→下路→辅助)
  const POS_ORDER = { TOP: 0, JUNGLE: 1, MIDDLE: 2, BOTTOM: 3, UTILITY: 4 };
  const posSort = (a, b) => (POS_ORDER[a.position] ?? 9) - (POS_ORDER[b.position] ?? 9);
  // 全场最大伤害/承伤 baseline (Akari: teams.allTeamStats)
  const maxDmg = Math.max(...norm.participants.map(p => p.dmg), 1);
  const maxTaken = Math.max(...norm.participants.map(p => p.dmgTaken), 1);
  const myPuuid = cachedSummoner && cachedSummoner.puuid;
  // 档案主人 (查看他人档案时遭遇次数以其为基准)
  const ownerPuuid = (profileOverride && profileOverride.puuid) || myPuuid || null;

  // Akari DamageBar: 三态伤害分段条 (物理#e07856/魔法#5b9fd7/真实#a8a8a8, 按宽度降序堆叠)
  const dmgBar = (total, phys, magic, truth, baseline) => {
    const W = 52;
    const segs = [
      { w: (phys / (baseline || 1)) * W, c: '#e07856' },
      { w: (magic / (baseline || 1)) * W, c: '#5b9fd7' },
      { w: (truth / (baseline || 1)) * W, c: '#a8a8a8' }
    ].sort((a, b) => b.w - a.w);
    let x = 0;
    const rects = segs.filter(s => s.w > 0.5).map(s => { const r = `<i style="left:${x.toFixed(1)}px;width:${s.w.toFixed(1)}px;background:${s.c}"></i>`; x += s.w; return r; }).join('');
    return `<div class="ak-db"><span>${fmtNum(total)}</span><div class="ak-dbar"><i class="ak-dbar-bg"></i>${rects}</div></div>`;
  };

  const playerRow = (p, tid) => {
    const c = champNumMap[String(p.championId)];
    const teamK = teamKills(tid);
    const kp = teamK ? Math.round((p.k + p.a) / teamK * 100) : 0;
    const kdaRatio = ((p.k + p.a) / Math.max(p.d, 1)).toFixed(2);
    const mins = norm.dur > 0 ? norm.dur / 60 : 1;
    const csMin = ((p.cs || 0) / mins).toFixed(1);
    const goldMin = ((p.gold || 0) / mins).toFixed(1);
    const spellHtml = (p.spells || []).map(id => `<img class="ak-spell" src="https://ddragon.leagueoflegends.com/cdn/${version}/img/spell/${(spellMap[String(id)] || id).replace(/\.png$/, "")}.png" onerror="this.style.visibility='hidden'">`).join('');
    const runeIcon = (map, id) => id && map[id] ? `https://ddragon.leagueoflegends.com/cdn/img/${map[id]}` : null;
    const rk1 = runeIcon(perkIconMap, p.perkPrimary), rk2 = runeIcon(styleIconMap, p.perkSub);
    const runesExist = p.perkPrimary || p.perkSub;
    const runeHtml = runesExist ? `<div class="ak-runecol">${rk1 ? `<img class="ak-rune" src="${rk1}" onerror="this.style.visibility='hidden'">` : ''}${rk2 ? `<img class="ak-rune" src="${rk2}" onerror="this.style.visibility='hidden'">` : ''}</div>` : '';
    const itemHtml = (p.items || []).slice(0, 7).map((id, i) => `<img class="ak-item${i === (p.items || []).length - 1 ? ' ak-trinket' : ''}" src="${itemIcon(id)}" onerror="this.style.visibility='hidden'">`).join('');
    const posText = POS_MAP[p.position] || '';
    const score = rating(p).toFixed(1);
    const badge = mvpSet[pkey(p)] ? '<span class="ak-badge ak-mvp">MVP</span>'
      : aceSet[pkey(p)] ? '<span class="ak-badge ak-ace">ACE</span>'
      : `<span class="ak-badge ak-rk">${ordinal(rankMap[pkey(p)] || 10)}</span>`;
    const pIconId = p.profileIconId || 0;
    return `<div class="ak-row${p.puuid === myPuuid ? ' ak-me' : ''}">
      <div class="ak-champwrap">
        <img class="ak-champ" src="${c ? champImg(c.id) : placeholder('?')}" onerror="this.src='${placeholder('?')}'">
        <span class="ak-level">${p.level}</span>
      </div>
      <div class="ak-namecol">
        <div class="ak-name-row">
          ${pIconId ? `<img class="ak-picon" src="${profileIcon(pIconId)}" onerror="this.style.display='none'">` : ''}
          <div class="ak-name" onclick="event.stopPropagation();searchPlayerByPuuid(${inlineArg(p.puuid)}, ${inlineArg(getName(p))})">${escapeHtml(getName(p))}</div>
          ${(() => { const n = sampleEncounterCount(p.puuid, ownerPuuid); return n >= 2 ? `<span class="ak-enc" title="战绩样本(${homeGamesData ? homeGamesData.length : 0}场)中同场${n}次">同场${n}次</span>` : ''; })()}
          ${p.puuid !== myPuuid ? (() => {
            const bl = isBlacklisted(getName(p));
            return bl
              ? `<span class="ak-bl-btn ak-bl-active" title="已在黑名单中" onclick="event.stopPropagation();removeBlacklistByName(${inlineArg(getName(p))})">🚫</span>`
              : `<span class="ak-bl-btn" title="加入黑名单" onclick="event.stopPropagation();addToBlacklist(${inlineArg(p.puuid)},${inlineArg(getName(p))})">🚫</span>`;
          })() : ''}
        </div>
        ${rankLineOf(p) || (posText ? `<div class="ak-pos">${posText}</div>` : '')}
      </div>
      <div class="ak-opsc"><b>${score}</b>${badge}</div>
      <div class="ak-kda">
        <span>${p.k}/${p.d}/${p.a} (${kp}%)</span>
        <em>${kdaRatio} KDA</em>
      </div>
      <div class="ak-damage">
        ${dmgBar(p.dmg, p.physDmg, p.magicDmg, p.trueDmg, maxDmg)}
        ${dmgBar(p.dmgTaken || 0, p.physTaken || 0, p.magicTaken || 0, p.trueTaken || 0, maxTaken)}
      </div>
      <div class="ak-gold">
        <span>${(p.gold / 1000).toFixed(2)} k</span>
        <em>${goldMin} / 分钟</em>
      </div>
      <div class="ak-icongrp">
        ${spellHtml ? `<div class="ak-spellcol">${spellHtml}</div>` : ''}
        ${runeHtml}
      </div>
      <div class="ak-items">${itemHtml}</div>
    </div>`;
  };

  const teamBlock = (tid) => {
    const list = (teams[tid] || []).slice().sort(posSort);
    const won = list.some(p => p.win);
    const tk = list.reduce((s, p) => s + p.k, 0), td = list.reduce((s, p) => s + p.d, 0), ta = list.reduce((s, p) => s + p.a, 0);
    const tg = list.reduce((s, p) => s + p.gold, 0);
    const obj = (norm.teamsObj || {})[tid] || {};
    const objIcons = [['🏰', obj.tower], ['💎', obj.inhibitor], ['🐉', obj.dragon], ['🦅', obj.baron], ['🐛', obj.horde], ['🌊', obj.herald]]
      .map(([ic, n]) => `<span>${ic} ${n || 0}</span>`).join('');
    return `<div class="ak-team ${won ? 'ak-win' : 'ak-loss'}">
      <div class="ak-thead">
        <span class="ak-result">${won ? '胜利' : '失败'}</span>
        <span>${teamLabel(tid)}</span>
        <span class="ak-tkda">${tk}/${td}/${ta}</span>
        <span class="ak-tgold">${(tg / 1000).toFixed(2)} k</span>
        <span class="ak-tobj">${objIcons}</span>
      </div>
      <div style="display:flex;gap:4px;padding:4px 8px;font-size:10px;color:#888;border-bottom:1px solid #333;">
        <div style="width:32px;"></div>
        <div style="flex:1;">玩家</div>
        <div style="min-width:60px;text-align:center;">评分</div>
        <div style="min-width:104px;text-align:center;">KDA</div>
        <div style="min-width:140px;text-align:center;">伤害/承伤</div>
        <div style="min-width:80px;text-align:center;">金币</div>
        <div style="flex-shrink:0;">技能</div>
        <div style="min-width:160px;text-align:center;">装备</div>
      </div>
      ${list.map(p => playerRow(p, tid)).join('')}
    </div>`;
  };

  container.innerHTML = `
    <div class="ogd-wrap">
      ${teamBlock(tids[0])}
      ${tids[1] ? teamBlock(tids[1]) : ''}
    </div>`;
}
function homeSearch() {
  const v = (document.getElementById("homeSearchInput") || {}).value || '';
  homeSearchDraft = v.trim();
  const msg = document.getElementById("homeSearchMsg");
  if (!v.trim()) { if (msg) msg.textContent = '请输入 名字#Tag'; return; }
  if (msg) msg.textContent = '';
  searchPlayerByName(v.trim());
}
// 国服 LCU 召唤师查询: name 参数要求完整 Riot ID (名字#Tag), 只传名字会 422
const summonerLookupCache = new Map();
const SUMMONER_LOOKUP_TTL = 10 * 60 * 1000;
const summonerPuuidLookupCache = new Map();
function hasSummonerLevel(summoner) {
  return validSummonerLevel(summoner?.summonerLevel);
}
function mergeSummonerProfile(base, incoming) {
  return mergePlayerProfile(base, incoming, { source: 'LCU' });
}
async function resolveSummonerByPuuid(puuid, seed) {
  if (!puuid) return seed || null;
  const hit = summonerPuuidLookupCache.get(puuid);
  if (hit && Date.now() - hit.ts < SUMMONER_LOOKUP_TTL && hasSummonerLevel(hit.data)) {
    return mergeSummonerProfile(seed, hit.data);
  }
  // v2 会主动解析任意 PUUID；v1 cached 只保证返回客户端已经见过的玩家，因此作为回退。
  const directProfile = await lolAPI.lcuRequest(
    'GET',
    '/lol-summoner/v2/summoners/puuid/' + encodeURIComponent(puuid)
  ).catch(() => null);
  let profile = directProfile && !directProfile.__error ? directProfile : null;
  if (!profile || profile.__error || !hasSummonerLevel(profile)) {
    const cachedProfile = await lolAPI.lcuRequest(
      'GET',
      '/lol-summoner/v1/summoners-by-puuid-cached/' + encodeURIComponent(puuid)
    ).catch(() => null);
    if (cachedProfile && !cachedProfile.__error) profile = mergeSummonerProfile(profile, cachedProfile);
  }
  const resolved = mergeSummonerProfile(seed, profile);
  resolved.puuid = puuid;
  // 完整档案才进入长缓存，防止一次瞬时空响应导致等级持续缺失。
  if (hasSummonerLevel(resolved)) summonerPuuidLookupCache.set(puuid, { ts: Date.now(), data: resolved });
  return resolved;
}
async function resolveSummonerByName(input) {
  const raw = (input || '').trim().replace(/＃/g, '#');
  if (!raw) return { __error: '请输入召唤师名称 (需完整 名字#Tag)' };
  const lookupKey = raw.toLocaleLowerCase();
  const lookupHit = summonerLookupCache.get(lookupKey);
  if (lookupHit && Date.now() - lookupHit.ts < SUMMONER_LOOKUP_TTL) return lookupHit.data;

  // 新版国服客户端中，旧 summoners?name 接口可能对有效 Riot ID 返回 404。
  // 名字#Tag 优先走 alias/lookup，它直接返回可靠的 PUUID；档案其余字段由战绩样本补齐。
  const splitAt = raw.lastIndexOf('#');
  if (splitAt > 0 && splitAt < raw.length - 1) {
    const gameName = raw.slice(0, splitAt).trim();
    const tagLine = raw.slice(splitAt + 1).trim();
    if (gameName && tagLine) {
      const aliasResult = await lolAPI.lcuRequest(
        'GET',
        '/lol-summoner/v1/alias/lookup?gameName=' + encodeURIComponent(gameName) + '&tagLine=' + encodeURIComponent(tagLine)
      );
      if (aliasResult && !aliasResult.__error && aliasResult.puuid) {
        const alias = aliasResult.alias || {};
        // alias/lookup 只返回 PUUID 与 Riot ID；统一走 PUUID 档案解析以获得真实等级和头像。
        const resolved = await resolveSummonerByPuuid(aliasResult.puuid, {
          puuid: aliasResult.puuid,
          profileIconId: -1,
          summonerLevel: ''
        });
        resolved.gameName = resolved.gameName || alias.gameName || gameName;
        resolved.tagLine = resolved.tagLine || alias.tagLine || tagLine;
        // 等级缺失时只缓存基础 Riot ID 15 秒，下一次查询仍会重新尝试完整档案。
        summonerLookupCache.set(lookupKey, { ts: hasSummonerLevel(resolved) ? Date.now() : Date.now() - SUMMONER_LOOKUP_TTL + 15000, data: resolved });
        return resolved;
      }
    }
  }

  // 兼容旧客户端及不带 Tag 的历史名称查询。
  const r = await lolAPI.lcuRequest('GET', '/lol-summoner/v1/summoners?name=' + encodeURIComponent(raw));
  if (r && !r.__error && r.puuid) {
    summonerLookupCache.set(lookupKey, { ts: Date.now(), data: r });
    return r;
  }
  if (!raw.includes('#')) return { __error: '未找到: ' + raw + ' (国服需完整 名字#Tag, 如 召唤师#0000)' };
  return { __error: '未找到该召唤师，请检查名字与 Tag 是否完全一致' };
}
async function searchPlayerByName(name) {
  if (!name) return;
  // 通过LCU按名字查puuid, 然后在首页档案页显示
  const msg = document.getElementById("homeSearchMsg");
  if (msg) msg.textContent = '查询中...';
  try {
    const sum = await resolveSummonerByName(name);
    if (sum && !sum.__error && sum.puuid) {
      if (msg) msg.textContent = '';
      // 携带 名字#Tag (输入含#时 LCU 可能不回 tagLine, 需补全用于档案头显示)
      const displayName = sum.gameName || sum.displayName || sum.name || '';
      const fullTag = (displayName.includes('#') ? displayName : displayName + '#' + (sum.tagLine || (name.includes('#') ? name.split('#')[1] : '')));
      rememberHomeSearch(fullTag);
      // 查询成功后清空输入框；失败时保留原值，便于用户修正后重试。
      homeSearchDraft = '';
      const input = document.getElementById('homeSearchInput');
      if (input) input.value = '';
      searchPlayerByPuuid(sum.puuid, fullTag, sum);
    } else {
      if (msg) msg.textContent = sum?.__error || `未找到召唤师: ${name}`;
    }
  } catch (e) { if (msg) msg.textContent = '查询失败, 请确认客户端正在运行'; }
}
// 点击玩家 → 首页档案页显示该玩家 (右上角"回到我的"返回)
async function searchPlayerByPuuid(puuid, name, summoner) {
  if (!puuid) return;
  // 必须在替换旧档案为“查询中”之前保存滚动位置，否则页面高度收缩会先把
  // 外层滚动条夹回顶部，等新档案渲染完成时已经无法恢复。
  preserveHomeScroll(puuid);
  // 先同步设置目标: 消除 await 期间的竞态窗口 (轮询此时插入读到的也是正确目标, 不会闪回自己)
  profileOverride = { puuid, name: name || '', summoner: summoner || null };
  const selfPuuid = window._myPuuid || cachedSummoner?.puuid || null;
  if (selfPuuid && puuid === selfPuuid) { backToMe(); return; }
  switchPage("home");
  const panel = document.getElementById("playerPanel");
  if (panel) panel.innerHTML = '<div class="meta-loading">正在查询该召唤师战绩...</div>';
  if (!hasSummonerLevel(summoner) || !summoner?.profileIconId) {
    const resolved = await resolveSummonerByPuuid(puuid, summoner).catch(() => summoner || null);
    // 用户可能在请求期间又点了另一名玩家；迟到结果不能覆盖新目标。
    if (!profileOverride || profileOverride.puuid !== puuid) return;
    profileOverride.summoner = resolved;
  }
  homeStatsLoaded = false;
  loadHomeStats(true);
}

// ========== 克制关系: 识别客户端当前选择, 基于 op.gg 真实克制数据 ==========
// 计算某英雄的克制/被克制数据 (renderCounterLists 共用)
function calcCounterData(numId) {
  const raw = opggMap[numId];
  if (!raw || !raw.positions) return null;
  const threatMap = {};
  for (const pos of (raw.positions || [])) {
    for (const ct of (pos.counters || [])) {
      const id = normalizeChampId(ct.champion_id);
      if (id === numId) continue;
      if (!threatMap[id]) threatMap[id] = { id, play: 0, win: 0 };
      threatMap[id].play += ct.play;
      threatMap[id].win += ct.win;
    }
  }
  const threats = Object.values(threatMap).filter(t => t.play >= 50)
    .map(t => ({ ...t, wr: t.win / t.play }))
    .sort((a, b) => b.wr - a.wr || b.play - a.play).slice(0, 8);
  const preyMap = {};
  for (const ch of Object.values(opggMap)) {
    if (+ch.id === numId) continue;
    for (const pos of (ch.positions || [])) {
      for (const ct of (pos.counters || [])) {
        if (normalizeChampId(ct.champion_id) === numId) {
          const id = +ch.id;
          if (!preyMap[id]) preyMap[id] = { id, play: 0, win: 0 };
          preyMap[id].play += ct.play;
          preyMap[id].win += ct.win;
        }
      }
    }
  }
  const preys = Object.values(preyMap).filter(t => t.play >= 50)
    .map(t => ({ ...t, wr: t.win / t.play }))
    .sort((a, b) => b.wr - a.wr || b.play - a.play).slice(0, 8);
  return { threats, preys };
}
function renderCounterLists(key) {
  const c = allChampions[key];
  if (!c) return;
  ensureChampMap();
  const numId = +(c.key || key);
  const data = calcCounterData(numId);
  const threats = data ? data.threats : [];
  const preys = data ? data.preys : [];
  const cardOf = t => {
    const ck = champNumMap[String(t.id)];
    if (!ck) return '';
    const wrCls = t.wr >= 0.5 ? 'pos' : 'neg';
    const sample = t.play >= 1000 ? '样本充足' : '小样本(' + t.play + ')';
    const ph = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23f3ecdf" width="100" height="100"/><text x="50" y="55" text-anchor="middle" fill="%23a37b2c" font-size="36">' + allChampions[ck.id].name[0] + '</text></svg>');
    return '<div class="cl-card" title="样本 ' + t.play + ' 场 · ' + sample + '" onclick="showChampionDetail(\'' + ck.id + '\')">' +
      '<img src="' + champImg(ck.id) + '" onerror="this.src=\'' + ph + '\">' +
      '<div class="cl-name">' + allChampions[ck.id].name + '</div>' +
      '<div class="cl-wr ' + wrCls + '">' + (t.wr*100).toFixed(1) + '%</div>' +
      (t.play >= 1000 ? '<div class="cl-sample">稳定</div>' : '<div class="cl-sample low">小样本</div>') +
    '</div>';
  };
  const elC = document.getElementById('counterChampLeft');
  const elW = document.getElementById('counterWeakLeft');
  const elS = document.getElementById('counterStrongLeft');
  if (elC) elC.innerHTML = data
    ? '<img src="' + champImg(c.id) + '" style="width:64px;height:64px;border-radius:8px;">'
    : '<div class="meta-loading">暂无数据</div>';
  if (elW) elW.innerHTML = threats.length
    ? threats.map(cardOf).join('')
    : '<div class="meta-loading">无数据</div>';
  if (elS) elS.innerHTML = preys.length
    ? preys.map(cardOf).join('')
    : '<div class="meta-loading">无数据</div>';
}
let lastClientPickId = "";
async function updateCounterClientPick() {
  const banner = document.getElementById("clientPickBanner");
  try {
    const session = await lolAPI.lcuRequest("GET", "/lol-champ-select/v1/session");
    if (!session) { banner.innerHTML = "当前不在选人阶段"; banner.className = "client-pick-banner"; return; }
    // 404 = 不在选人阶段(正常状态); 仅真正的 5xx/网络错误才算"数据异常"
    if (session.__error) {
      if (session.httpStatus === 404) {
        banner.innerHTML = "当前不在选人阶段";
        banner.className = "client-pick-banner";
        return;
      }
      banner.innerHTML = "LCU 数据异常";
      banner.className = "client-pick-banner";
      return;
    }
    let champId = null;
    if (session && session.myTeam) {
      const me = (session.myTeam || []).find(p => p.cellId === session.localPlayerCellId);
      if (me && me.championId) champId = normalizeChampId(me.championId);
    }
    if (!champId) {
      lastClientPickId = "";
      banner.innerHTML = "进入选人阶段后自动识别英雄";
      banner.className = "client-pick-banner";
      const elC = document.getElementById("counterChampLeft");
      const elW = document.getElementById("counterWeakLeft");
      const elS = document.getElementById("counterStrongLeft");
      if (elC) elC.innerHTML = "--";
      if (elW) elW.innerHTML = "";
      if (elS) elS.innerHTML = "";
      return;
    }
    ensureChampMap();
    const c = champNumMap[String(champId)];
    if (!c) return;
    lastClientPickId = champId;
    if (!opggMap[champId]) {
      banner.innerHTML = "检测到 " + c.name + " - 加载克制数据...";
      try { await loadOpgg(); } catch(e) { console.error("op.gg reload failed:", e); }
    }
    banner.innerHTML = "检测到当前选择: " + c.name + " (" + c.id + ")";
    banner.className = "client-pick-banner active";
    renderCounterLists(c.id);
  } catch(e) {
    console.error("error:", e);
    banner.innerHTML = "LCU 连接失败: " + e.message;
  }
}
