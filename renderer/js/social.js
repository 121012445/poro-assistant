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
function markPlayer(puuid, name, tag) {
  if (!puuid) return;
  if (!playerMarks[puuid]) playerMarks[puuid] = { name, marks: [] };
  if (!playerMarks[puuid].marks.includes(tag)) {
    playerMarks[puuid].marks.push(tag);
  }
}
function unmarkPlayer(puuid, tag) {
  if (!playerMarks[puuid]) return;
  playerMarks[puuid].marks = playerMarks[puuid].marks.filter(m => m !== tag);
}
function getPlayerMarks(puuid) {
  return playerMarks[puuid]?.marks || [];
}


// ========== 对局历史遭遇标记 ==========
let encounterMap = {};
let _encounterTrackedFor = '';
let _currentGameKey = '';
function addEncounter(puuid, name) {
  if (!puuid || !name) return;
  if (!encounterMap[puuid]) encounterMap[puuid] = { name, count: 0, lastTime: 0 };
  encounterMap[puuid].count++;
  encounterMap[puuid].lastTime = Date.now();
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


// ========== 历史遭遇持久化 ==========
// v2: 修复同局重复计数后的格式升级; 旧格式数据已虚增污染, 直接作废重新累计
const ENCOUNTERS_VER = 2;
function loadEncounters() {
  try {
    const data = storeGet('encounters');
    if (!data) return;
    const parsed = JSON.parse(data);
    if (parsed && parsed.__v === ENCOUNTERS_VER && parsed.map) Object.assign(encounterMap, parsed.map);
  } catch (e) {}
}
function saveEncounters() {
  try { storeSet('encounters', JSON.stringify({ __v: ENCOUNTERS_VER, map: encounterMap })); } catch (e) {}
}
const _origAddEncounter = addEncounter;
addEncounter = function(puuid, name) {
  _origAddEncounter(puuid, name);
  saveEncounters();
};

// ========== 玩家标记 UI ==========
function showMarkModal(puuid, name) {
  const tags = ['高手', '坑货', '开黑', '代练', '演员', '绝活哥', '大神', '萌新'];
  const existing = getPlayerMarks(puuid);
  let html = `<div style="margin-bottom:8px;font-size:13px;">标记 <b>${escapeHtml(name)}</b></div>`;
  html += `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">`;
  for (const tag of tags) {
    const active = existing.includes(tag);
    html += `<button class="btn-secondary${active ? ' is-selected' : ''}" style="font-size:11px;" onclick="togglePlayerMark(${inlineArg(puuid)},${inlineArg(name)},${inlineArg(tag)})">${active ? '✓ ' : ''}${escapeHtml(tag)}</button>`;
  }
  html += `</div>`;
  html += `<div style="display:flex;gap:4px;"><input id="customMarkInput" placeholder="自定义标签" class="tool-input" style="flex:1;font-size:11px;"><button class="btn-secondary" style="font-size:11px;" onclick="addCustomMark(${inlineArg(puuid)},${inlineArg(name)})">添加</button></div>`;
  document.getElementById('toolMsg').innerHTML = html;
}
function togglePlayerMark(puuid, name, tag) {
  const marks = getPlayerMarks(puuid);
  if (marks.includes(tag)) unmarkPlayer(puuid, tag);
  else markPlayer(puuid, name, tag);
  showMarkModal(puuid, name);
}
function addCustomMark(puuid, name) {
  const input = document.getElementById('customMarkInput');
  if (!input || !input.value.trim()) return;
  markPlayer(puuid, name, input.value.trim());
  showMarkModal(puuid, name);
}
function getPlayerMarksHtml(puuid) {
  const marks = getPlayerMarks(puuid);
  if (!marks.length) return '';
  return marks.map(m => `<span style="display:inline-block;font-size:9px;padding:1px 4px;border-radius:3px;background:#3a2a5a;color:#c9a0ff;margin-left:2px;">${escapeHtml(m)}</span>`).join('');
}
