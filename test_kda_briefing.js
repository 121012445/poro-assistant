'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('renderer/js/chat.js', 'utf8');
const context = vm.createContext({ console, window: {}, lolAPI: {}, encodeURIComponent, setTimeout, clearTimeout });
vm.runInContext(source, context, { filename: 'renderer/js/chat.js' });

const self = { puuid: 'self', teamId: 100, summonerName: '自己' };
const selected = [self,
  ...[1, 2, 3, 4].map(i => ({ puuid: 'a' + i, team: 100 })),
  ...[1, 2, 3, 4, 5].map(i => ({ puuid: 'e' + i, team: 200 }))
];
context.__session = [self];
context.__selected = selected;
context.__cached = selected.slice(0, 5);
const roster = JSON.parse(vm.runInContext('JSON.stringify(kdaBestRoster(__session, __selected, __cached))', context));
assert.strictEqual(roster.length, 10, 'gameflow 仅返回自己时应使用选人阶段完整阵容');
context.__roster = roster;
const ally = JSON.parse(vm.runInContext("JSON.stringify(kdaTargetRoster(__roster, 'self', true))", context));
const enemy = JSON.parse(vm.runInContext("JSON.stringify(kdaTargetRoster(__roster, 'self', false))", context));
assert.strictEqual(ally.target.length, 5, '己方简报应包含自己和四名队友');
assert.ok(ally.target.some(player => player.puuid === 'self'), '己方简报不能错误排除自己');
assert.strictEqual(enemy.target.length, 5, '敌方简报应包含五名敌人');
assert.ok(enemy.target.every(player => player.teamId === 200));
assert.ok(source.indexOf("window._gameflowPhase === 'InProgress'") < source.indexOf('const cid = await getGameChatCid()'),
  '对局中必须先预填游戏聊天，不能被失效的 LCU 选人会话截获');
assert.ok(source.includes('mapWithConcurrency(target, 4, buildLine)'), '多名玩家战绩必须并发读取，不能逐个串行等待');
assert.ok(source.includes("const message = '/all '"), 'KDA 简报必须明确发送到所有人频道');
assert.ok(source.includes('lolAPI.sendGameChatNow(message, true)'), 'KDA 快捷键必须自动完成发送，不能停在聊天框等待确认');
const mainSource = fs.readFileSync('main/index.js', 'utf8');
assert.ok(mainSource.includes("require('./hotkey-poller')"), '游戏吞掉 Electron 快捷键时必须启用 Win32 轮询兜底');
assert.ok(mainSource.includes("dispatchInGameHotkey(action, 'win32-poll')"), 'Win32 轮询结果必须接入统一快捷键分发');
assert.ok(mainSource.includes('hotkeyPoller.stop()'), '离开对局或退出时必须停止按键轮询');
assert.ok(mainSource.includes("encoding: 'buffer'") && mainSource.includes("new TextDecoder('gbk')"),
  '原生输入错误输出必须兼容 UTF-8 与 Windows 中文代码页，不能在界面显示乱码');
const nativeInputSource = fs.readFileSync('main/native/PoroInput.cs', 'utf8');
assert.ok(nativeInputSource.includes('[FieldOffset(0)] public MOUSEINPUT mi;'),
  'Win64 INPUT 联合体必须包含 MOUSEINPUT，确保 SendInput 的 cbSize 为 40 字节');
assert.ok(nativeInputSource.includes('Marshal.GetLastWin32Error()'), 'SendInput 失败必须返回 Win32 错误码');
const packageJson = require('./package.json');
assert.strictEqual(packageJson.build?.win?.requestedExecutionLevel, 'requireAdministrator',
  '正式版必须与 WeGame 启动的游戏处于同一权限级别，否则 SendInput 会被 UIPI 拦截');
console.log('KDA 简报阵容回退、并发生成与游戏预填测试通过');
