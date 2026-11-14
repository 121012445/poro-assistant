'use strict';
// 实时对局页的整局时间线测试 (1.6.0): 组队标签稳定性 + 习惯卡渲染。
//
// 直接驱动真实的 renderLiveFromGameflow, 模拟一次对局里所有会让"分组/战绩"变空的帧:
//   选人(有 challengeId) → 加载页(session 无 challengeId) → 对局中(缓存建立)
//   → SGP 全部 503 → Live Client Data 只返回己方 5 人 → SGP 恢复
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..');

function makeEl() {
  const el = {
    innerHTML: '', textContent: '', hidden: false, dataset: {}, id: '', className: '', style: {},
    clientHeight: 250, offsetWidth: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild(c) { return c; },
    prepend(c) { return c; },
    remove() {},
    addEventListener() {},
    setAttribute() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 24 }; }
  };
  return el;
}

const body = makeEl();
const elements = { liveHeadSlot: makeEl(), globalToast: makeEl() };
const document = {
  body: makeEl(),
  getElementById(id) { return elements[id] || null; },
  createElement() { return makeEl(); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {}
};

const SELF = 'p1';
const BLUE = ['p1', 'p2', 'p3', 'p4', 'p5'];
const RED = ['e1', 'e2', 'e3', 'e4', 'e5'];
const PAIRS = [['p1', 'p2'], ['e1', 'e2']];
// 每人 12 场: 前 8 场同队 (满足推断阈值 3 场) + 位置/阵亡/一血样本 (满足习惯卡 8 场门槛)
const GAME_COUNT = 12;
const TEAM_GAMES = {};
for (const pair of PAIRS) {
  for (const puuid of pair) {
    TEAM_GAMES[puuid] = Array.from({ length: GAME_COUNT }, (_, i) => ({
      id: `g${i}-${pair[0]}`, players: pair.slice()
    }));
  }
}

const state = {
  phase: 'ChampSelect',
  participants: [],
  livePlayers: null,
  sgpDown: false
};

const sessionOf = () => ({
  phase: state.phase,
  gameData: {
    gameId: 880001,
    queue: { id: 420, gameMode: 'CLASSIC' },
    map: { gameMode: 'CLASSIC' },
    participants: state.participants
  }
});

const lolAPI = {
  async lcuRequest(method, p) {
    if (p === '/lol-gameflow/v1/session') return sessionOf();
    if (p === '/lol-lobby/v2/lobby/members') return [];
    if (p.startsWith('/lol-match-history')) return null;
    return null;
  },
  async lcuStatus() { return { connected: true, summoner: { puuid: SELF } }; },
  async livePlayerlist() { return state.livePlayers || []; },
  async liveGameData() { return { allPlayers: state.livePlayers || [] }; },
  async sgpMatchHistory(platformId, puuid) {
    if (state.sgpDown) throw new Error('SGP 503');
    const games = TEAM_GAMES[puuid] || [];
    return { games: { games: games.map((g, i) => ({
      json: {
        gameId: g.id, queueId: 420, gameMode: 'CLASSIC', gameType: 'MATCHED_GAME', gameCreation: 1700000000000,
        participants: g.players.map(x => ({
          puuid: x, teamId: 100, championId: 64,
          teamPosition: 'JUNGLE',
          stats: {
            kills: 3, deaths: 7, assists: 5, win: true,
            firstBloodKill: i < 8, firstBloodAssist: false,
            totalMinionsKilled: 200, neutralMinionsKilled: 20
          }
        }))
      }
    })) } };
  },
  gameLivePush() {}, debugLog() {}
};

const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  document,
  lolAPI,
  window: { addEventListener() {}, _gameflowPhase: 'ChampSelect' },
  performance: { now: () => Date.now() },
  setTimeout, clearTimeout, Promise, JSON, Date, Math, Object, Array, String, Number, Set, Map, RegExp, Error,
  nameCache: {}, rankCache: {},
  version: '15.1.1',
  allChampions: {}, allItems: {},
  ensureChampMap() {},
  poroIcon: () => '<svg></svg>',
  champImg: () => 'img.png',
  placeholder: () => 'placeholder.png',
  champIconAttrs: () => '',
  rankTierCN: t => t,
  async resolveNames() {}, async resolveRanks() {},
  checkBlacklist() {}, isKnownPlayerName: n => !!n, addEncounter() {},
  getPlayerMarksHtml: () => '', encounterTagHtml: () => '', showMarkModal() {},
  deriveRiskProfile: () => ({ level: 'low', label: '稳', confidence: 50, evidence: [] }),
  balanceBadgeHtml: () => '', modeTierBadgeHtml: () => '',
  isBalanceMode: () => false, loadAramBalance: async () => null,
  tierModeFor: () => null, loadModeTiers: async () => null, modeTiers: {},
  async getPlatformId() { return 'TENCENT'; },
  isTencentPlatform: () => true, getRememberedPlayerPlatform: () => '',
  normalizeChampId: x => +x || 0,
  modeName: () => 'CLASSIC', isExcludedGame: () => false,
  QUEUE_NAMES: { 420: '单双排' }, MODE_NAMES: { CLASSIC: '召唤师峡谷' },
  extractBehavior: () => null, summarizeFlashPreference: () => null,
  behaviorTagsHtml: () => '', premadeNotifyOn: false, complianceOn: false,
  async sendGameChat() { return { ok: true }; },
  hasBrokenText: () => false,
  _currentGameKey: ''
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.window.poroSession = { setGame() {}, token() { return ''; }, isCurrent() { return true; }, transition() { return {}; } };
const context = vm.createContext(sandbox);
const load = f => vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), context, { filename: f });
load('renderer/js/utils.js');
load('renderer/js/player-habits.js');   // 习惯卡判定 (UMD: 挂到 window.PoroHabits)
load('renderer/js/live.js');
assert.ok(vm.runInContext('!!window.PoroHabits', context), 'player-habits.js 必须挂在 window.PoroHabits 上');

const renderGameflow = vm.runInContext('renderLiveFromGameflow', context);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const KNOWN_GROUP_MEMBERS = ['p1', 'p2', 'e1', 'e2'];
let lastTags = null;

function check(name, expectGroupedOnScreen) {
  const html = body.innerHTML;
  const keys = [...html.matchAll(/data-player-key="([^"]*)"/g)].map(m => m[1]);
  const rows = html.split('<div class="lp-row').slice(1);
  const rowHtmlOf = key => rows.find(r => r.includes(`data-player-key="${key}"`)) || '';
  const shown = new Set(keys);
  const missing = [];
  const shownTags = [];
  const tagByPuuid = {};
  for (const puuid of KNOWN_GROUP_MEMBERS) {
    if (!shown.has(puuid)) continue;
    const m = /class="lp-premade[^"]*"[^>]*>(组\d)</.exec(rowHtmlOf(puuid));
    if (!m) missing.push(puuid);
    else { shownTags.push(m[1]); tagByPuuid[puuid] = m[1]; }
  }
  const ok = missing.length === 0 && (expectGroupedOnScreen == null || shownTags.length === expectGroupedOnScreen);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}: 在场开黑成员 ${shownTags.length} 个 [${shownTags.join(',')}]${missing.length ? ' 缺标签: ' + missing.join(',') : ''}`);
  if (!ok) throw new assert.AssertionError({ message: `${name}: 已渲染的开黑成员丢了组队标签 -> ${missing.join(',')}`, actual: shownTags });
  for (const [puuid, tag] of Object.entries(tagByPuuid)) {
    if (lastTags && lastTags[puuid] && lastTags[puuid] !== tag) {
      throw new assert.AssertionError({ message: `${name}: ${puuid} 的组号跳变 ${lastTags[puuid]} -> ${tag}`, actual: tagByPuuid });
    }
  }
  if (Object.keys(tagByPuuid).length) lastTags = { ...(lastTags || {}), ...tagByPuuid };
  return html;
}

async function poll(phase, label) {
  state.phase = phase;
  vm.runInContext(`window._gameflowPhase = ${JSON.stringify(phase)}`, context);
  if (phase === 'ChampSelect') {
    vm.runInContext(`champSelectParticipants = ${JSON.stringify(state.participants)}`, context);
  }
  await renderGameflow(body, null, phase);
  await sleep(40);
  return check(label);
}

function buildParticipants(withChallengeId) {
  return [...BLUE, ...RED].map((puuid, i) => ({
    puuid, championId: 100 + i, team: i < 5 ? 100 : 200, summonerName: 'P' + i,
    ...(withChallengeId ? { challengeId: i < 2 ? 11 : (i >= 5 && i < 7 ? 22 : 100 + i) } : {})
  }));
}
function buildLive(all) {
  const list = all ? [...BLUE, ...RED] : BLUE;
  return list.map((puuid, i) => ({
    riotId: puuid, riotIdGameName: 'P' + i, championId: 100 + i,
    team: i < 5 ? 'ORDER' : 'CHAOS', position: '', items: [], isBot: false
  }));
}

(async () => {
  console.log('实时页时间线 (组队标签 + 习惯卡):');
  state.participants = buildParticipants(true);
  await poll('ChampSelect', '选人期 (challengeId 分组)');

  state.participants = buildParticipants(false);
  await poll('GameStart', '加载页 (session 无 challengeId)');

  state.livePlayers = buildLive(true);
  const html1 = await poll('InProgress', '对局中第 1 帧');

  // 习惯卡: 12 场打野 + 场均 7 阵亡 + 一血 8/12 -> 应有 2 条胶囊 (主玩/场均阵亡)
  const habitCount = (html1.match(/class="lp-habit lp-habit-/g) || []).length;
  assert.ok(habitCount >= 2, `习惯卡应至少渲染 2 条 (实际 ${habitCount})`);
  assert.ok(/主玩/.test(html1) && /打野 12\/12/.test(html1), '应给出「主玩 打野 12/12」');
  assert.ok(/场均阵亡/.test(html1), '应给出「场均阵亡」');
  console.log(`  OK   习惯卡: ${habitCount} 条胶囊, 含主玩位置与场均阵亡`);

  state.sgpDown = true;
  vm.runInContext('sgpRecentCache.clear()', context);
  await poll('InProgress', 'SGP 全部 503');

  state.livePlayers = buildLive(false);
  await poll('InProgress', 'Live Data 只有己方 5 人');

  state.sgpDown = false;
  state.livePlayers = buildLive(true);
  vm.runInContext('sgpRecentCache.clear()', context);
  await poll('InProgress', 'SGP 恢复 + 10 人');

  // 数据不变 -> 不整页重建
  const before = body.innerHTML;
  await renderGameflow(body, null, 'InProgress');
  await sleep(40);
  assert.strictEqual(body.innerHTML, before, '数据没变时不应改写页面');
  console.log('  OK   数据不变的第 2 帧: 没有整页重建');

  console.log('组队标签在整局时间线上始终存在, 习惯卡正常渲染');
})().catch(e => { console.error(e.message || e); process.exit(1); });
