const fs = require('fs');
const path = require('path');
const assert = require('assert');

const read = p => fs.readFileSync(path.join(__dirname, p), 'utf8');
const app = read('renderer/js/app.js');
const home = read('renderer/js/home.js');
const live = read('renderer/js/live.js');
const chat = read('renderer/js/chat.js');
const lcu = read('main/lcu.js');

for (const platform of ['NA1', 'EUW1', 'EUN1', 'KR', 'JP1', 'TW2', 'VN2', 'OC1']) {
  assert(app.includes(`'${platform}'`), `missing Riot platform ${platform}`);
}
assert(app.includes('function isTencentPlatform'), 'platform routing helper missing');
assert(home.includes('if (!isTencentPlatform(selfPlatformId))'), 'home does not route foreign platforms to LCU');
assert(home.includes('/lol-platform-config/v1/namespaces/PlayerPlatformEdgeService'), 'platform auto-detection fallback missing');
assert(home.includes('const foreignTarget = 100'), 'foreign history is not prepared up to 100 matches');
assert(live.includes('function recentProfileFor') && live.includes('isTencentPlatform(platformId)'), 'live profile routing missing');
assert(chat.includes('recentProfileFor(platformId'), 'KDA briefing does not use platform routing');
assert(lcu.includes('Riot Games\\\\League of Legends'), 'standard Riot install root is not scanned');

console.log('foreign platform routing tests passed');
