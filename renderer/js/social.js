// 观战 / 玩家标记 / 遭遇记录
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 观战功能 ==========
// 国服客户端的 /lol-spectator 查询类接口 (availability / game-info / active-games) 全部返回
// 404 "Invalid URI format", 客户端无法自行解析目标对局, 因此直接 launch 必定失败:
//   "Cannot spectate game because spectator key is missing"
// 实测可用链路: /lol-chat/v1/friends 的 lol 对象自带 gameId / spectatorKey / gameStatus /
// isObservable, 组装 { gameId, platformId, spectatorKey } 直接调 /lol-gameflow/v2/spectate/launch。
// 代价: 国服只能观战好友列表中 gameStatus=inGame 且 spectatorKey 非空的好友。
const SPECTATE_BUSY_PHASES = ['Lobby', 'Matchmaking', 'ReadyCheck', 'ChampSelect', 'GameStart', 'InProgress', 'WaitingForStats', 'EndOfGame'];

// 从好友列表提取观战凭证 (puuid 优先, 缺失时按 名字#Tag 匹配)
function spectateFriendInfo(friends, puuid, nameTag) {
  if (!Array.isArray(friends)) return null;
  const raw = (nameTag || '').trim().toLowerCase();
  const f = friends.find(x => x && x.lol && (puuid
    ? x.puuid === puuid
    : ((x.gameName || '') + '#' + (x.gameTag || '')).toLowerCase() === raw));
  if (!f || !f.lol) return null;
  return {
    puuid: f.puuid,
    gameId: Number(f.lol.gameId) || 0,
    platformId: f.platformId || '',
    spectatorKey: f.lol.spectatorKey || '',
    gameStatus: f.lol.gameStatus || '',
    gameQueueType: f.lol.gameQueueType || '',
    isObservable: f.lol.isObservable || ''
  };
}

// 当前处于对局中且可观的候选好友 (失败提示里给出可点的名字)
function spectateHintList(friends) {
  if (!Array.isArray(friends)) return '';
  const live = friends.filter(f => f && f.lol && f.lol.gameStatus === 'inGame' && f.lol.spectatorKey);
  if (!live.length) return '';
  const names = live.slice(0, 5).map(f => escapeHtml((f.gameName || '?') + '#' + (f.gameTag || ''))).join('、');
  return '<div style="margin-top:6px;font-size:12px;opacity:.75">当前可观的局内好友: ' + names + '</div>';
}

// 外服兜底: 客户端自行解析对局 (国服会返回 spectator key is missing)
async function spectateLaunchLegacy(puuid) {
  const r = await lolAPI.lcuRequest('POST', '/lol-spectator/v1/spectate/launch', { puuid })
    .catch(e => ({ __error: e.message }));
  return { ok: !(r && (r.__error || r.errorCode)), error: (r && (r.message || r.__error)) || '' };
}

// 启动前检查客户端是否占用, 需要时先退出房间
async function spectateEnsureIdle() {
  const phase = await lolAPI.lcuRequest('GET', '/lol-gameflow/v1/gameflow-phase');
  if (!SPECTATE_BUSY_PHASES.includes(phase)) return { ok: true };
  const phaseName = PHASE_TEXT[phase] || phase || '未知';
  if (!confirm('客户端当前处于「' + phaseName + '」状态，观战前需要退出。\n\n是否自动退出房间并启动观战?')) {
    return { ok: false, cancelled: true, phaseName };
  }
  await lolAPI.lcuRequest('DELETE', '/lol-lobby/v2/lobby');
  await new Promise(r => setTimeout(r, 1500));
  return { ok: true };
}

async function startSpectate() {
  if (!guardWrite('观战')) return;
  const name = document.getElementById('spectateName').value.trim();
  if (!name) return toolMsg('<span style="color:var(--negative)">请输入召唤师名称 (完整 名字#Tag)</span>');
  try {
    const sum = await resolveSummonerByName(name);
    if (!sum || sum.__error || sum.errorCode) {
      return toolMsg('<span style="color:var(--negative)">' + (sum?.__error || '未找到: ' + name) + '</span>');
    }
    const nickname = name.split('#')[0];
    const friends = await lolAPI.lcuRequest('GET', '/lol-chat/v1/friends').catch(() => null);
    const info = spectateFriendInfo(friends, sum.puuid, name);

    // 主路径: 好友 + 观战密钥 (国服唯一可行链路)
    if (info && info.spectatorKey) {
      if (info.gameStatus && info.gameStatus !== 'inGame') {
        return toolMsg('<span style="color:var(--negative)">' + nickname + ' 当前不在对局中 (状态: ' + info.gameStatus + ')</span>' + spectateHintList(friends));
      }
      const idle = await spectateEnsureIdle();
      if (!idle.ok) {
        return toolMsg('<span style="color:var(--negative)">已取消: 客户端处于「' + idle.phaseName + '」状态, 需先退出房间再观战</span>');
      }
      // 实测: 仅 {gameId, platformId, spectatorKey} 会 404, 必须带全 puuid/gameQueueType/
      // allowObserveMode(字符串)/dropInSpectateGameId, 204 即成功
      const r = await lolAPI.lcuRequest('POST', '/lol-gameflow/v2/spectate/launch', {
        gameId: info.gameId, platformId: info.platformId, spectatorKey: info.spectatorKey,
        puuid: info.puuid, gameQueueType: info.gameQueueType,
        allowObserveMode: 'false', dropInSpectateGameId: ''
      }).catch(e => ({ __error: e.message }));
      if (r && (r.__error || r.errorCode)) {
        const detail = (r.message || r.__error || '未知错误').replace(/^Failed to set launch spectator mode: /, '');
        // 404: 对局不存在或已结束; 官方规则: 开局约 3 分钟后才开放接入
        const extra = /Not Found|404/i.test(detail)
          ? '<div style="margin-top:6px;font-size:12px;opacity:.75">对局可能刚开始尚未开放接入，或已经结束，请稍后重试</div>'
          : '';
        return toolMsg('<span style="color:var(--negative)">观战启动失败: ' + detail + '</span>' + extra);
      }
      return toolMsg('<span style="color:var(--positive)">正在启动观战: ' + nickname + (info.gameQueueType ? ' (' + info.gameQueueType + ')' : '') + '</span>');
    }

    // 非好友 / 好友但无密钥: 退到外服链路, 失败再给出国服说明
    const legacy = await spectateLaunchLegacy(sum.puuid);
    if (legacy.ok) return toolMsg('<span style="color:var(--positive)">正在启动观战: ' + nickname + '</span>');
    toolMsg('<span style="color:var(--negative)">' + nickname + ' 当前无法被观战: 国服只能观战好友列表中正在对局的好友，且对局开始数分钟后才开放接入</span>' + spectateHintList(friends));
  } catch (e) {
    console.log("[Spectate] error:", e);
    toolMsg('<span style="color:var(--negative)">观战失败: ' + e.message + '</span>');
  }
}

// ========== 玩家标记系统 ==========
let playerMarks = {};
const PLAYER_MEMORY_COLORS = ['#35b7a6', '#4b8fe2', '#8d6bd1', '#e2a43b', '#dc6672', '#7b8b9b'];
const PLAYER_MEMORY_TAGS = ['配合良好', '实力稳定', '需要观察', '消极记录', '绝活玩家', '疑似补位'];

function isKnownPlayerName(name) {
  const value = String(name || '').trim();
  if (!value) return false;
  return !/^(未知|未知玩家|unknown|player|\?|-)$/i.test(value) && !hasBrokenText(value);
}

function normalizePlayerMemory(entry, name) {
  const value = entry && typeof entry === 'object' ? entry : {};
  const resolvedName = isKnownPlayerName(name)
    ? String(name).trim()
    : (isKnownPlayerName(value.name) ? String(value.name).trim() : '未知玩家');
  return {
    name: resolvedName,
    marks: Array.isArray(value.marks) ? [...new Set(value.marks.map(String).filter(Boolean))] : [],
    note: String(value.note || ''),
    color: PLAYER_MEMORY_COLORS.includes(value.color) ? value.color : PLAYER_MEMORY_COLORS[0],
    updatedAt: Number(value.updatedAt) || 0
  };
}

function getPlayerMemory(puuid, name) {
  const encounter = encounterMap[puuid] || {};
  const memory = normalizePlayerMemory(playerMarks[puuid], name || encounter.name);
  return { ...memory, encounterCount: Number(encounter.count) || 0, lastSeen: Number(encounter.lastTime) || 0,
    lastResult: encounter.lastResult === 'win' || encounter.lastResult === 'loss' ? encounter.lastResult : '',
    lastSameTeam: typeof encounter.lastSameTeam === 'boolean' ? encounter.lastSameTeam : null,
    lastGameTs: Number(encounter.lastGameTs) || 0 };
}

function savePlayerMemory() {
  try { storeSet('playerMarks', JSON.stringify(playerMarks)); } catch (e) {}
}

function markPlayer(puuid, name, tag) {
  if (!puuid) return;
  playerMarks[puuid] = normalizePlayerMemory(playerMarks[puuid], name);
  if (!playerMarks[puuid].marks.includes(tag)) {
    playerMarks[puuid].marks.push(tag);
  }
  playerMarks[puuid].updatedAt = Date.now();
  savePlayerMemory();
}
function unmarkPlayer(puuid, tag) {
  if (!playerMarks[puuid]) return;
  playerMarks[puuid].marks = playerMarks[puuid].marks.filter(m => m !== tag);
  playerMarks[puuid].updatedAt = Date.now();
  savePlayerMemory();
}
function getPlayerMarks(puuid) {
  return playerMarks[puuid]?.marks || [];
}


// ========== 对局历史遭遇标记 ==========
let encounterMap = {};
let _currentGameKey = '';
// 同一局可能先后拿到两个键：先 p:<puuid集合>（gameId 还没就绪），几秒后变成
// g:<gameId>。若各算一局，只碰过一次的人会显示"遇见 2 次"（实测本机 230 人）。
// 换键只可能发生在同一局内，所以留一个时间窗做兜底，超过窗口就按新的一局算。
const ENCOUNTER_SAME_GAME_MS = 90 * 60 * 1000;
function normalizeEncounterEntry(entry, migrateLegacyCount = false) {
  const value = entry && typeof entry === 'object' ? entry : {};
  const knownName = isKnownPlayerName(value.name) ? String(value.name).trim() : '';
  const oldCount = Math.max(0, Number(value.count) || 0);
  const lastTime = Math.max(0, Number(value.lastTime) || 0);
  return {
    name: knownName,
    // v1-v3 可能因阵容/阶段刷新把同一局累计很多次，旧数值不可还原；只保留
    // “曾遇见过”的事实。v4 起由 seenGames 精确累计。
    count: migrateLegacyCount ? (knownName && oldCount ? 1 : 0) : oldCount,
    lastTime,
    // 最后一次“算成新的一局”的时刻。lastTime 会被同局内的重复刷新顶掉，
    // 不能拿来判断换键是否发生在同一局。
    keyAt: Math.max(0, Number(value.keyAt) || lastTime),
    seenGames: Array.isArray(value.seenGames) ? [...new Set(value.seenGames.map(String).filter(Boolean))].slice(-80) : [],
    // 1.5.136: 上次相遇结果 (Akari MET 手法)。只在浏览自己战绩首页时由
    // recordEncounterResults 回写 —— 那些对局已经结束, 胜负是既成事实;
    // count 仍由实时页 addEncounter 维护, 两套口径不混。
    lastResult: value.lastResult === 'win' || value.lastResult === 'loss' ? value.lastResult : '',
    lastSameTeam: typeof value.lastSameTeam === 'boolean' ? value.lastSameTeam : null,
    lastGameTs: Math.max(0, Number(value.lastGameTs) || 0)
  };
}
function setEncounterName(puuid, name) {
  if (!puuid || !isKnownPlayerName(name)) return false;
  const entry = normalizeEncounterEntry(encounterMap[puuid]);
  const cleanName = String(name).trim();
  const changed = entry.name !== cleanName;
  entry.name = cleanName;
  encounterMap[puuid] = entry;
  if (playerMarks[puuid] && !isKnownPlayerName(playerMarks[puuid].name)) {
    playerMarks[puuid] = normalizePlayerMemory(playerMarks[puuid], cleanName);
    savePlayerMemory();
  }
  return changed;
}
function addEncounter(puuid, name, gameKey = _currentGameKey) {
  if (!puuid || !isKnownPlayerName(name) || !gameKey) return false;
  const entry = normalizeEncounterEntry(encounterMap[puuid]);
  const nameChanged = !entry.name || entry.name !== String(name).trim();
  entry.name = String(name).trim();
  const key = String(gameKey);
  const isNewGame = !entry.seenGames.includes(key);
  if (isNewGame) {
    const prev = entry.seenGames[entry.seenGames.length - 1] || '';
    // 同一局换了标识：把上一条 p: 键直接改成 g: 键，不新增一局。
    // 反向（g:→p:）多半是下一局 gameId 还没就绪，不能归一，否则会漏记。
    const sameGame = prev.startsWith('p:') && key.startsWith('g:')
      && Date.now() - entry.keyAt < ENCOUNTER_SAME_GAME_MS;
    if (sameGame) {
      entry.seenGames[entry.seenGames.length - 1] = key;
    } else {
      entry.count++;
      entry.seenGames.push(key);
      if (entry.seenGames.length > 80) entry.seenGames.splice(0, entry.seenGames.length - 80);
      entry.keyAt = Date.now();
    }
  }
  entry.lastTime = Date.now();
  encounterMap[puuid] = entry;
  if (playerMarks[puuid] && !isKnownPlayerName(playerMarks[puuid].name)) {
    playerMarks[puuid] = normalizePlayerMemory(playerMarks[puuid], entry.name);
    savePlayerMemory();
  }
  if (isNewGame || nameChanged) saveEncounters();
  return isNewGame || nameChanged;
}

// 遭遇次数(详情页用): 直接从已加载的战绩样本 (近100场) 统计同场次数, 精确且排除档案主人自身。
// 旧的实时页累计口径依赖"对局期间打开过实时页", 数据不完整且把自己也计了进去
function sampleEncounterCount(puuid, ownerPuuid) {
  if (!puuid || !ownerPuuid || puuid === ownerPuuid) return 0;
  if (!homeGamesData || homeGamesOwner !== ownerPuuid || !homeGamesData.length) return 0;
  let n = 0;
  for (const g of homeGamesData) {
    if (g.participants.some(p => p.puuid === puuid)) n++;
  }
  return n;
}

// 1.5.136: 浏览自己的战绩首页时, 把每局的「上次相遇结果」回写到 encounterMap。
// games 是 normalizeGame 后的列表 (participants 带 puuid/win/teamId, g.time/g.gid)。
// 只更新 lastResult/lastSameTeam/lastGameTs —— count 仍归实时页 addEncounter 管,
// 避免同一局被实时页 (g:<id>) 和首页 (h:<gid>) 两条口径重复计数。
function recordEncounterResults(games, selfPuuid) {
  if (!Array.isArray(games) || !selfPuuid) return 0;
  let changed = 0;
  for (const g of games) {
    const ts = Number(g.time) || 0;
    const me = (g.participants || []).find(p => p.puuid === selfPuuid);
    if (!me) continue;                       // 别人的战绩页不回写
    for (const p of (g.participants || [])) {
      if (!p.puuid || p.puuid === selfPuuid) continue;
      const entry = normalizeEncounterEntry(encounterMap[p.puuid]);
      // 只接受更新的对局 (乱序/补刷的旧数据不覆盖新结果)
      if (ts && entry.lastGameTs && ts <= entry.lastGameTs) continue;
      entry.lastResult = p.win === true ? 'win' : p.win === false ? 'loss' : '';
      entry.lastSameTeam = p.teamId != null && me.teamId != null ? p.teamId === me.teamId : null;
      entry.lastGameTs = ts || entry.lastGameTs;
      encounterMap[p.puuid] = entry;
      changed++;
    }
  }
  if (changed) saveEncounters();
  return changed;
}

// 1.5.136: 抽屉等处用的只读相遇信息 (归一化后, 无副作用)
function getEncounterInfo(puuid) {
  return normalizeEncounterEntry(encounterMap[puuid]);
}

// 1.5.136: 实时页玩家卡上的「相遇」小标签。遇过 ≥2 次才显示 (只碰过一次没有参考价值),
// 内容 = 遇见次数 + 上次相遇结果, 悬停出完整说明。
function encounterTagHtml(puuid) {
  if (!puuid) return '';
  const entry = normalizeEncounterEntry(encounterMap[puuid]);
  if (entry.count < 2 && !entry.lastResult) return '';
  if (entry.count < 2) return '';            // 只有结果没次数: 说明 count 口径尚未建立, 不亮标签
  const parts = [`遇见 ${entry.count} 次`];
  if (entry.lastResult) {
    parts.push(`上次${entry.lastSameTeam === true ? '同队' : entry.lastSameTeam === false ? '对手' : ''}${entry.lastResult === 'win' ? '胜' : '负'}`);
  }
  const title = parts.join(' · ')
    + (entry.lastGameTs ? ` · ${new Date(entry.lastGameTs).toLocaleDateString()}` : '');
  const cls = entry.lastResult === 'win' ? ' is-win' : entry.lastResult === 'loss' ? ' is-loss' : '';
  return `<span class="lp-enc${cls}" title="${escapeHtml(title)}">遇${entry.count}</span>`;
}


// ========== 历史遭遇持久化 ==========
// v4: 每名玩家保存近期对局 key，页面重复刷新不会再次累计；旧版次数已经被动态
// roster key 污染，迁移时折算为“至少遇见 1 次”，之后从可信基线准确累计。
// v5: 合并同一局的两把键（p:<puuid集合> 与 g:<gameId>），修 v4 遗留的重复计数。
const ENCOUNTERS_VER = 5;

// v4 末期同一局先记了 p: 键、gameId 就绪后又记了 g: 键，两个 key 各算一局。
// 判据不靠猜：这两个键在多名玩家的记录里相邻出现（同局 10 人都会留下这个模式），
// 且每个 p: 键只配对一个 g: 键。满足才合并，其余原样保留。
function migrateEncounterGameKeys(map) {
  const pairs = new Map();      // "p\0g" -> 共现人数
  for (const entry of Object.values(map)) {
    const ks = (entry && entry.seenGames) || [];
    for (let i = 0; i < ks.length - 1; i++) {
      if (String(ks[i]).startsWith('p:') && String(ks[i + 1]).startsWith('g:')) {
        const k = ks[i] + '\u0000' + ks[i + 1];
        pairs.set(k, (pairs.get(k) || 0) + 1);
      }
    }
  }
  const byP = new Map();        // p 键 -> Map(g 键 -> 人数)
  for (const [k, n] of pairs) {
    const sep = k.indexOf('\u0000');
    const p = k.slice(0, sep), g = k.slice(sep + 1);
    if (!byP.has(p)) byP.set(p, new Map());
    byP.get(p).set(g, n);
  }
  const pairsToDrop = [];       // [p, g]
  for (const [p, gs] of byP) {
    if (gs.size !== 1) continue;
    const [[g, people]] = [...gs];
    if (people < 2) continue;
    pairsToDrop.push([p, g]);
  }
  if (!pairsToDrop.length) return 0;
  let merged = 0;
  for (const entry of Object.values(map)) {
    const ks = (entry && entry.seenGames) || [];
    for (const [p, g] of pairsToDrop) {
      const i = ks.indexOf(p);
      if (i === -1 || !ks.includes(g)) continue;
      ks.splice(i, 1);
      entry.count = Math.max(0, (Number(entry.count) || 0) - 1);
      merged++;
    }
  }
  return merged;
}

function loadEncounters() {
  try {
    const data = storeGet('encounters');
    if (!data) return;
    const parsed = JSON.parse(data);
    const source = parsed?.map || parsed || {};
    const ver = Number(parsed?.__v) || 0;
    // 只有 v1-v3 的次数不可信；v4 之后的 count 是可信基线，升级版本号时不能再折算
    const migrateLegacyCount = ver < 4;
    encounterMap = Object.fromEntries(Object.entries(source)
      .filter(([puuid, value]) => puuid && value && typeof value === 'object')
      .map(([puuid, value]) => [puuid, normalizeEncounterEntry(value, migrateLegacyCount)]));
    if (ver === 4) migrateEncounterGameKeys(encounterMap);
    saveEncounters();
  } catch (e) {}
}
function saveEncounters() {
  try { storeSet('encounters', JSON.stringify({ __v: ENCOUNTERS_VER, map: encounterMap })); } catch (e) {}
}

let _encounterHydrateBusy = false;
const _encounterHydrateTried = new Set();
async function hydrateEncounterNames(limit = 24) {
  if (_encounterHydrateBusy || typeof resolveSummonerByPuuid !== 'function') return;
  const pending = Object.entries(encounterMap)
    .filter(([puuid, entry]) => puuid && !isKnownPlayerName(entry?.name) && !_encounterHydrateTried.has(puuid))
    .sort((a, b) => Number(b[1]?.lastTime || 0) - Number(a[1]?.lastTime || 0))
    .slice(0, limit);
  if (!pending.length) return;
  _encounterHydrateBusy = true;
  let changed = false;
  try {
    await mapWithConcurrency(pending, 4, async ([puuid]) => {
      _encounterHydrateTried.add(puuid);
      try {
        const summoner = await resolveSummonerByPuuid(puuid);
        const name = summoner?.gameName || summoner?.displayName || summoner?.name || '';
        if (setEncounterName(puuid, name)) changed = true;
      } catch (e) {}
    });
    if (changed) {
      saveEncounters();
      if (document.getElementById('page-blacklist')?.classList.contains('active')) renderBlacklistPage();
    }
  } finally {
    _encounterHydrateBusy = false;
  }
}

// ========== 玩家标记 UI ==========
function showMarkModal(puuid, name) {
  if (!puuid) return;
  const memory = getPlayerMemory(puuid, name);
  playerMarks[puuid] = normalizePlayerMemory(playerMarks[puuid], name);
  const modal = document.getElementById('playerMemoryModal');
  const body = document.getElementById('playerMemoryModalBody');
  if (!modal || !body) return;
  body.innerHTML = `<div class="pm-head"><div><span class="pm-dot" style="background:${memory.color}"></span><h3>${escapeHtml(memory.name)}</h3></div><button class="pm-close" onclick="closePlayerMemoryModal()">×</button></div>
    <div class="pm-meta">遇见 ${memory.encounterCount} 次${memory.lastSeen ? ` · 最近 ${new Date(memory.lastSeen).toLocaleDateString()}` : ''}${memory.lastResult ? ` · 上次${memory.lastSameTeam === true ? '同队' : memory.lastSameTeam === false ? '对手' : ''}${memory.lastResult === 'win' ? '胜' : '负'}` : ''}</div>
    <label class="pm-label">人工标签</label><div class="pm-tags">${PLAYER_MEMORY_TAGS.map(tag => `<button class="btn-secondary${memory.marks.includes(tag) ? ' is-selected' : ''}" onclick="togglePlayerMark(${inlineArg(puuid)},${inlineArg(name)},${inlineArg(tag)})">${memory.marks.includes(tag) ? '✓ ' : ''}${tag}</button>`).join('')}</div>
    <div class="pm-custom"><input id="customMarkInput" placeholder="自定义标签" class="tool-input"><button class="btn-secondary" onclick="addCustomMark(${inlineArg(puuid)},${inlineArg(name)})">添加</button></div>
    <label class="pm-label" for="playerMemoryNote">私人备注（仅保存在本机）</label><textarea id="playerMemoryNote" class="pm-note" maxlength="300" placeholder="例如：上次配合默契、擅长开团……">${escapeHtml(memory.note)}</textarea>
    <label class="pm-label">标记颜色</label><div class="pm-colors">${PLAYER_MEMORY_COLORS.map(color => `<button class="pm-color${memory.color === color ? ' active' : ''}" style="--memory-color:${color}" onclick="setPlayerMemoryColor(${inlineArg(puuid)},${inlineArg(name)},${inlineArg(color)})" aria-label="选择颜色"></button>`).join('')}</div>
    <div class="pm-actions"><button class="btn-primary" onclick="savePlayerMemoryEditor(${inlineArg(puuid)},${inlineArg(name)})">保存档案</button></div>`;
  modal.classList.add('show');
}
function closePlayerMemoryModal() { document.getElementById('playerMemoryModal')?.classList.remove('show'); }
function capturePlayerMemoryDraft(puuid, name) {
  const note = document.getElementById('playerMemoryNote');
  if (!note || !puuid) return;
  playerMarks[puuid] = normalizePlayerMemory(playerMarks[puuid], name);
  playerMarks[puuid].note = String(note.value || '').trim().slice(0, 300);
}
function togglePlayerMark(puuid, name, tag) {
  capturePlayerMemoryDraft(puuid, name);
  const marks = getPlayerMarks(puuid);
  if (marks.includes(tag)) unmarkPlayer(puuid, tag);
  else markPlayer(puuid, name, tag);
  showMarkModal(puuid, name);
}
function addCustomMark(puuid, name) {
  const input = document.getElementById('customMarkInput');
  if (!input || !input.value.trim()) return;
  capturePlayerMemoryDraft(puuid, name);
  markPlayer(puuid, name, input.value.trim());
  showMarkModal(puuid, name);
}
function setPlayerMemoryColor(puuid, name, color) {
  capturePlayerMemoryDraft(puuid, name);
  playerMarks[puuid] = normalizePlayerMemory(playerMarks[puuid], name);
  playerMarks[puuid].color = PLAYER_MEMORY_COLORS.includes(color) ? color : PLAYER_MEMORY_COLORS[0];
  playerMarks[puuid].updatedAt = Date.now();
  savePlayerMemory();
  showMarkModal(puuid, name);
}
function savePlayerMemoryEditor(puuid, name) {
  playerMarks[puuid] = normalizePlayerMemory(playerMarks[puuid], name);
  playerMarks[puuid].note = String(document.getElementById('playerMemoryNote')?.value || '').trim().slice(0, 300);
  playerMarks[puuid].updatedAt = Date.now();
  savePlayerMemory();
  closePlayerMemoryModal();
  renderBlacklistPage();
  showToast('玩家档案已保存', 'positive');
}
function getPlayerMarksHtml(puuid) {
  const memory = getPlayerMemory(puuid);
  const note = memory.note ? ' · 有备注' : '';
  if (!memory.marks.length && !memory.note) return '';
  return `<span class="pm-inline" style="--memory-color:${memory.color}" title="人工标记${note}">${memory.marks.slice(0, 2).map(escapeHtml).join(' · ') || '有备注'}</span>`;
}
