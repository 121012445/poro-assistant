'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('renderer/js/home.js', 'utf8');
const start = source.indexOf('function eogStat');
const end = source.indexOf('function buildHomeMmr', start);
assert(start >= 0 && end > start, 'EOG ledger helpers must exist');
const context = vm.createContext({
  Date, console,
  window: { _myPuuid: 'self' },
  cachedSummoner: { puuid: 'self' }, cachedPlatformId: 'HN1', profileOverride: null,
  homeGamesOwner: null, homeGamesData: null,
  normalizeChampId: id => Number(id) >= 60000 ? Number(id) - 60000 : Number(id),
  localStorage: { getItem: () => null, setItem: () => {} },
  lolAPI: { debugLog: () => {} },
  renderHomeModeFilter: () => {}, renderHomeGameList: () => {},
  findProfileParticipant: (game, summoner) => game.participants.find(p => p.puuid === summoner.puuid)
});
vm.runInContext(source.slice(start, end), context);
context.block = {
  gameId: 9988, gameLength: 1234, endOfGameTimestamp: Date.now(), gameMode: 'JADE', gameType: 'MATCHED_GAME',
  teams: [{ teamId: 100, isWinningTeam: true, players: [{
    puuid: 'self', isLocalPlayer: true, championId: 60081, riotIdGameName: 'Me', riotIdTagLine: '001', teamId: 100,
    spell1Id: 4, spell2Id: 7, items: [3001, 3002],
    stats: { CHAMPIONS_KILLED: 12, NUM_DEATHS: 3, ASSISTS: 18, GOLD_EARNED: 15000, TOTAL_DAMAGE_DEALT_TO_CHAMPIONS: 42000 }
  }] }, { teamId: 200, isWinningTeam: false, players: [{ puuid: 'enemy', championId: 22, teamId: 200, stats: {} }] }]
};
const game = JSON.parse(vm.runInContext("JSON.stringify(normalizeEogGame(block, 'self', 'HN1'))", context));
assert.strictEqual(game.gid, 9988);
assert.strictEqual(game.mode, '海克斯大乱斗');
assert.strictEqual(game.pendingSettlement, true);
assert.strictEqual(game.participants[0].championId, 81);
assert.deepStrictEqual([game.participants[0].k, game.participants[0].d, game.participants[0].a], [12, 3, 18]);
assert.strictEqual(game.participants[0].win, true);
console.log('本地结算流水账标准化测试通过');
