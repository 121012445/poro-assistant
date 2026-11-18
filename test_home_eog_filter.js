// 1.6.15 回归: EOG(对局结束) 两条路径绕过训练局过滤 + 外服 LCU 单人数据补全。
// 背景:
//   ① capturePendingEogGame 打完一局直接 homeGamesData = [game].concat(...) 插到最前,
//      从不看 isExcludedGame —— 训练局打完立刻上卡。
//   ② mergePendingEogGames 每次加载把 localStorage poro.pendingEog.* 里的记录 concat
//      回列表, 也不过滤 —— 于是"修好 isExcludedGame 了却依然有训练局"。
//   ③ 日服 LCU 战绩详情只返回自己 1 人(participants=1), 但 EOG 块有全 10 人,
//      以前没拿来补, 卡片上就只看到自己。
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const app = fs.readFileSync('renderer/js/app.js', 'utf8');
const home = fs.readFileSync('renderer/js/home.js', 'utf8');

// ---- ① 静态: 两条路径都要有过滤/补全代码 ----
assert.ok(home.includes('eogHidden'),
  'capturePendingEogGame 必须判定训练局(eogHidden)后再决定是否插入列表');
assert.ok(home.includes('mergedWithPending'),
  '合并 pendingEog 后必须统一走 includePractice 过滤(mergedWithPending)');
assert.ok(/offN < 2/.test(home),
  'mergePendingEogGames 应有"官方缺人(<2)才用 EOG 补全"的条件');

// ---- ② 动态: 真实 isExcludedGame ----
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing fn ' + name);
  let depth = 0, began = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') { depth++; began = true; }
    else if (src[i] === '}') { depth--; if (began && depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced fn ' + name);
}

const exCtx = vm.createContext({});
vm.runInContext(
  'const TRAINING_MODES = new Set(["训练工具", "新手教程", "TUTORIAL", "PRACTICETOOL"]);\n'
  + extractFn(app, 'isTrainingGame') + '\n'
  + extractFn(app, 'isCustomGame') + '\n'
  + extractFn(app, 'isExcludedGame'),
  exCtx
);
const isExcludedGame = exCtx.isExcludedGame;

// ---- ③ 动态: mergePendingEogGames 的补全与去重行为 ----
const me = { puuid: 'me-puuid', name: '哈土奇', championId: 84, k: 5, d: 2, a: 7, dmg: 20000 };
const t1 = { puuid: 't1', name: '队友1', championId: 1, dmg: 12000 };
const t2 = { puuid: 't2', name: '队友2', championId: 2, dmg: 9000 };

let storedPending = [];
const mergeCtx = vm.createContext({
  readPendingEogGames: () => storedPending,
  writePendingEogGames: (puuid, rows) => { storedPending = rows; },
  findProfileParticipant: (g, s) => (g.participants || []).find(p => p && p.puuid === s.puuid) || null,
});
vm.runInContext(extractFn(home, 'mergePendingEogGames'), mergeCtx);
const mergePendingEogGames = mergeCtx.mergePendingEogGames;
const sum = { puuid: 'me-puuid' };

// A. 官方只有自己 1 人 → 用 EOG 的 10 人补全, 且不重复 concat
storedPending = [{ gid: 1, participants: [me, t1, t2], teamsObj: { 100: {} } }];
let official = [{ gid: 1, participants: [Object.assign({}, me)], teamsObj: {} }];
let merged = mergePendingEogGames(official, sum, 'JP1');
assert.strictEqual(merged.length, 1, '同 gid 不得重复 concat');
assert.strictEqual(merged[0].participants.length, 3, '官方缺人(<2)时必须用 EOG 补全到 3 人');
assert.strictEqual(merged[0].participants[0].puuid, 'me-puuid', '自己那条必须保留(含 LCU 独有字段)');
assert.deepStrictEqual(merged[0].teamsObj, { 100: {} }, 'teamsObj 为空时应由 EOG 补齐');

// B. 官方已有 >=2 人 → 不补, 保持原样
storedPending = [{ gid: 2, participants: [me, t1, t2] }];
official = [{ gid: 2, participants: [Object.assign({}, me), Object.assign({}, t1)] }];
merged = mergePendingEogGames(official, sum, 'JP1');
assert.strictEqual(merged[0].participants.length, 2, '官方已有 >=2 人时不得覆盖');

// C. 官方完全没有的 gid → 补到最前面
storedPending = [{ gid: 3, participants: [me, t1] }];
official = [{ gid: 4, participants: [me, t1] }];
merged = mergePendingEogGames(official, sum, 'JP1');
assert.strictEqual(merged.length, 2, '官方没有的 pending 对局要补进来');
assert.strictEqual(String(merged[0].gid), '3', '补进来的待同步对局排在最前');

// ---- ④ 动态: 2923 的过滤口径 (合并结果再过滤) ----
storedPending = [
  { gid: 10, mode: 'PRACTICETOOL', queueId: 0, gameType: '', participants: [Object.assign({}, me)] },
  { gid: 11, mode: '海克斯大乱斗', queueId: 2400, gameType: 'MATCHED_GAME', participants: [Object.assign({}, me)] },
];
const mergedForFilter = mergePendingEogGames([], sum, 'JP1');
const filtered = mergedForFilter.filter(g => !isExcludedGame(g));
assert.strictEqual(filtered.map(g => String(g.gid)).join(','), '11',
  '合并后的列表里训练局(gid=10)必须被剔除, 只留正常局');
const keptAll = mergedForFilter.filter(() => true);
assert.strictEqual(keptAll.length, 2, 'includePractice=true 时不得过滤');

console.log('OK test_home_eog_filter: EOG 两条路径过滤 + 队友补全 + 勾选计入保留');
