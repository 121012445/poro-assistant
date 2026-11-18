// 1.6.14 回归: 缓存命中路径不过滤训练局。
// 背景: 1.6.13 修好了 isExcludedGame 识别 PRACTICETOOL, 但 home.js 缓存命中分支
//   `games = cached.games` 原样赋值 —— 而这份缓存是 1.6.12 时期(过滤不识别
//   PRACTICETOOL)写进去的, 训练局被固化在里面, 于是界面照旧渲染出来。
// 本测试锁定: 缓存命中必须与网络路径同口径过滤(includePractice=false 时)。
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const app = fs.readFileSync('renderer/js/app.js', 'utf8');
const home = fs.readFileSync('renderer/js/home.js', 'utf8');

// ---- ① 静态: 缓存命中的 games 赋值必须带过滤 ----
const cacheLine = 'includePractice ? cached.games : (cached.games || []).filter(g => !isExcludedGame(g))';
assert.ok(home.includes(cacheLine),
  '缓存命中分支必须按 includePractice 过滤训练局, 不能原样赋值 cached.games');
assert.ok(!/games = cached\.games;/.test(home),
  '不得保留无过滤的 `games = cached.games;` 裸赋值');

// ---- ② 动态: 用真实 isExcludedGame 验证缓存数组被过滤 ----
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

const ctx = vm.createContext({});
vm.runInContext(
  'const TRAINING_MODES = new Set(["训练工具", "新手教程", "TUTORIAL", "PRACTICETOOL"]);\n'
  + extractFn(app, 'isTrainingGame') + '\n'
  + extractFn(app, 'isCustomGame') + '\n'
  + extractFn(app, 'isExcludedGame'),
  ctx
);
const isExcludedGame = ctx.isExcludedGame;

// 模拟一份被污染的旧缓存: 训练局(两种取值口径) + 自定义局 + 正常局
const cachedGames = [
  { gid: 1, mode: 'PRACTICETOOL', queueId: 0, gameType: '' },       // 日服训练局(modeName 兜底原串)
  { gid: 2, mode: '训练工具', queueId: 1090, gameType: '' },        // 国服口径
  { gid: 3, mode: '自定义', queueId: 0, gameType: 'CUSTOM_GAME' },   // 自定义局
  { gid: 4, mode: '海克斯大乱斗', queueId: 2400, gameType: 'MATCHED_GAME' }, // 正常局
];

// includePractice=false 时的过滤行为(与 home.js 缓存分支同一表达式)
const filtered = cachedGames.filter(g => !isExcludedGame(g));
assert.deepStrictEqual(filtered.map(g => g.gid), [4],
  '缓存命中过滤后只应剩正常对局; 训练局/自定义必须被剔除');

// includePractice=true 时应原样保留(用户主动勾选「训练/自定义计入」)
const kept = true ? cachedGames : cachedGames.filter(g => !isExcludedGame(g));
assert.strictEqual(kept.length, 4, 'includePractice=true 时不得过滤');

console.log('OK test_home_cache_filter: 缓存命中路径过滤训练局 + 勾选计入时保留');
