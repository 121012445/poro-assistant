'use strict';
// getGameConfigDir 的目录结构解析: 兼容国服 WeGame 与官方/外服(日服)两种结构。
// 回归点: 日服 exe 直接在游戏根, Config 在 clientDir 同层 —— 旧逻辑只找父级导致"锁定游戏设置失败"。
const assert = require('assert');
const childProcess = require('child_process');
// regInstallPaths 会起 reg 子进程; 加载 lcu.js 前替换, 与 test_lcu_probe.js 同法
childProcess.exec = (cmd, opts, cb) => { process.nextTick(() => cb(null, Buffer.from(''))); return {}; };
const lcu = require('./main/lcu.js');
const { resolveGameConfigDir } = lcu._internals;

const P = (...parts) => parts.join('\\');
let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  PASS ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
}

// exists: 给定 PersistedSettings.json 绝对路径, 判断"存在"的模拟函数
const existing = set => p => set.has(p);

ok('国服 WeGame: clientDir 是子目录, Config 在父级', () => {
  // clientDir = D:\WeGameApps\英雄联盟\LeagueClient ; Config = D:\WeGameApps\英雄联盟\Config
  const cands = [{ port: 1, token: 'x', clientDir: P('D:', 'WeGameApps', '英雄联盟', 'LeagueClient') }];
  const cfg = P('D:', 'WeGameApps', '英雄联盟', 'Config', 'PersistedSettings.json');
  assert.strictEqual(resolveGameConfigDir(cands, null, existing(new Set([cfg]))), P('D:', 'WeGameApps', '英雄联盟', 'Config'));
});

ok('外服/日服: clientDir 就是游戏根, Config 在同层', () => {
  // clientDir = D:\lol\Riot Games\League of Legends ; Config = 同层\Config
  const gameRoot = P('D:', 'lol', 'Riot Games', 'League of Legends');
  const cands = [{ port: 51651, token: 'x', clientDir: gameRoot }];
  const cfg = P(gameRoot, 'Config', 'PersistedSettings.json');
  assert.strictEqual(resolveGameConfigDir(cands, null, existing(new Set([cfg]))), P(gameRoot, 'Config'));
});

ok('日服候选里夹杂 WeGame 旧日志: 命中日服自身同层, 不误落国服父级', () => {
  const jpRoot = P('D:', 'lol', 'Riot Games', 'League of Legends');
  const weRoot = P('D:', 'WeGameApps', '英雄联盟', 'LeagueClient');
  // 顺序: 日服(进程凭证)在前, WeGame 旧日志在后
  const cands = [
    { port: 51651, token: 'a', clientDir: jpRoot },
    { port: 57365, token: 'b', clientDir: weRoot }
  ];
  const jpCfg = P(jpRoot, 'Config', 'PersistedSettings.json');
  const weCfg = P('D:', 'WeGameApps', '英雄联盟', 'Config', 'PersistedSettings.json');
  const result = resolveGameConfigDir(cands, cands[0], existing(new Set([jpCfg, weCfg])));
  assert.strictEqual(result, P(jpRoot, 'Config'), '必须返回日服同层 Config, 而非 WeGame 旧日志的父级');
});

ok('Game\\Config 变体也支持(父级)', () => {
  const cands = [{ port: 1, token: 'x', clientDir: P('C:', 'Games', 'LeagueClient') }];
  const cfg = P('C:', 'Games', 'Game', 'Config', 'PersistedSettings.json');
  assert.strictEqual(resolveGameConfigDir(cands, null, existing(new Set([cfg]))), P('C:', 'Games', 'Game', 'Config'));
});

ok('父级与同层都有 Config 时: 父级优先(保持国服行为不变)', () => {
  const gameRoot = P('D:', 'lol', 'Riot Games', 'League of Legends', 'LeagueClient');
  const cands = [{ port: 1, token: 'x', clientDir: gameRoot }];
  const parentCfg = P('D:', 'lol', 'Riot Games', 'League of Legends', 'Config', 'PersistedSettings.json');
  const sameCfg = P(gameRoot, 'Config', 'PersistedSettings.json');
  assert.strictEqual(
    resolveGameConfigDir(cands, null, existing(new Set([parentCfg, sameCfg]))),
    P('D:', 'lol', 'Riot Games', 'League of Legends', 'Config')
  );
});

ok('都找不到返回 null (由 getGameConfigDir 抛错)', () => {
  const cands = [{ port: 1, token: 'x', clientDir: P('D:', 'whatever') }];
  assert.strictEqual(resolveGameConfigDir(cands, null, existing(new Set())), null);
});

ok('无 clientDir 的候选被跳过', () => {
  const cands = [{ port: 1, token: 'x' }, { port: 2, token: 'y', clientDir: P('E:', 'Game') }];
  const cfg = P('E:', 'Config', 'PersistedSettings.json');
  assert.strictEqual(resolveGameConfigDir(cands, null, existing(new Set([cfg]))), P('E:', 'Config'));
});

console.log(`游戏设置 Config 目录解析测试通过 (${passed}/${passed})`);
