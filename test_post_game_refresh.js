const fs = require('fs');
const assert = require('assert');

const main = fs.readFileSync('main/index.js', 'utf8');
const preload = fs.readFileSync('main/preload.js', 'utf8');
const events = fs.readFileSync('renderer/js/lcu-events.js', 'utf8');
const bench = fs.readFileSync('renderer/js/bench.js', 'utf8');

assert(main.includes("ipcMain.handle('sgp:invalidateMatchHistory'"), 'main process must expose SGP history invalidation');
assert(main.includes('parts[1] === target'), 'SGP invalidation must be scoped to the requested PUUID');
assert(preload.includes('sgpInvalidateMatchHistory:'), 'preload must expose SGP history invalidation');
assert(events.includes("['ChampSelect', 'GameStart', 'InProgress'].includes(window._gameflowPhase)"), 'retry loop must stop when a new game starts');
assert(events.includes("loadHomeStats(true, { skipCache: true })"), 'post-game refresh must bypass the persistent home cache');
assert(bench.includes("uri === '/lol-end-of-game/v1/eog-stats-block'"), 'EOG stats event must trigger refresh');
assert(bench.includes('await lolAPI.sgpInvalidateMatchHistory(st.summoner.puuid)'), 'poll fallback must also invalidate SGP history cache');
assert(events.includes('latestGameId !== baselineGameId'), 'retry loop must wait for a genuinely new game id');

console.log('Post-game refresh contract tests passed.');
