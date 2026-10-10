const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

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

// 国服 /riotclient/region-locale 返回 {region:"TENCENT", webRegion:"staging.na"}。
// 不把它映射成 HN1 的话归一化结果为空 → isTencentPlatform('') 为 false → 国服玩家
// 被当成"Riot 外服"路由到 LCU 战绩接口，而国服该接口返回 HTTP 500
// "Error getting match list for summoner" → 点击他人 ID 查看战绩必然失败。
assert(home.includes('function normalizePlatformId'), '平台标识归一化函数缺失');
assert(/TENCENT\s*:\s*'HN1'/.test(home), '国服 region=TENCENT 必须映射到 HN1');
assert(!home.includes('endIndex=${MAX_FETCH}'), '外服分支的 LCU endIndex 仍可能超过单次 100 场上限');
assert(home.includes("matches?begIndex=0&endIndex=100"), '外服分支应按 LCU 单页上限 100 请求战绩');

// ---------- 真跑一遍 normalizePlatformId（不能只查字面量） ----------
// 只断言"文件里出现了 TENCENT: 'HN1'"是自证式的：把映射写错方向、或让函数整体
// 返回 ''，字面量断言照样绿。这里把函数体抽出来在独立 vm 里实际求值。
const aliasesSrc = /const PLATFORM_ALIASES = (\{[\s\S]*?\});/.exec(home);
assert.ok(aliasesSrc, '未能从 home.js 提取 PLATFORM_ALIASES');
const fnSrc = /function normalizePlatformId\(raw\) \{[\s\S]*?\n\}/.exec(home);
assert.ok(fnSrc, '未能从 home.js 提取 normalizePlatformId');
const riotIds = eval('[' + /const RIOT_PLATFORM_IDS = \[([\s\S]*?)\];/.exec(app)[1] + ']');
const sgpIds = eval('[' + /const SGP_PLATFORM_IDS = \[([\s\S]*?)\];/.exec(app)[1] + ']');
const ctx2 = { RIOT_PLATFORM_IDS: riotIds, SGP_PLATFORM_IDS: sgpIds, String };
vm.createContext(ctx2);
vm.runInContext('const PLATFORM_ALIASES = ' + aliasesSrc[1] + ';\n' + fnSrc[0], ctx2);
const norm = ctx2.normalizePlatformId;
assert.strictEqual(typeof norm, 'function', 'normalizePlatformId 未在 vm 中定义');
assert.strictEqual(norm('TENCENT'), 'HN1', '国服 region=TENCENT 应归一化为 HN1');
assert.strictEqual(norm('tencent'), 'HN1', 'TENCENT 应大小写不敏感');
assert.strictEqual(norm('CN'), 'HN1', 'CN 应归一化为 HN1');
assert.strictEqual(norm('hn10'), 'HN10', '国服平台 ID 应原样保留');
assert.strictEqual(norm('NA'), 'NA1', '外服别名 NA 应归一化为 NA1');
assert.strictEqual(norm('euw1'), 'EUW1', '外服 platformId 应大小写不敏感');
assert.strictEqual(norm('staging.na'), '', '未知值不得被当成平台');
assert.strictEqual(norm(''), '', '空值应返回空');
assert.strictEqual(norm(undefined), '', 'undefined 应返回空');
assert(live.includes('function recentProfileFor') && live.includes('isTencentPlatform(platformId)'), 'live profile routing missing');
assert(chat.includes('recentProfileFor(platformId'), 'KDA briefing does not use platform routing');
assert(lcu.includes('Riot Games\\\\League of Legends'), 'standard Riot install root is not scanned');

console.log('foreign platform routing tests passed');
