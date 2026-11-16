// 自动接受对局: ready-check 状态判定回归测试
//
// 背景 (2026-11-16): 1.6.3 之前 compliance.js / bench.js 两处都写成
//   hasPopup = state !== 'None' && state !== 'InProgress'
// 把判断取反了 —— 排除了唯一该接受的 InProgress, 反而把 Error / Invalid 当成
// 有待接受弹窗。crash.log 实测 GET 侧 415 次 Error + 6 次 Invalid + 2 次
// InProgress, 那 421 次失效状态全部触发了 POST accept, 每次 500, 且每 12 秒重试,
// 累计 438 次 POST / 433 次 500。本测试同时锁住"规则本身"和"两处实现落地"。
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let ok = 0, bad = 0;
const check = (cond, msg) => { if (cond) { ok++; } else { bad++; console.log('  FAIL ' + msg); } };

// ---- 1. 规则本身 ----
// 复刻两处实现的判定: 只有 InProgress + 玩家未响应才该接受。
const pendingOf = rc => String((rc && rc.state) || '') === 'InProgress';
const notRespondedOf = rc => !rc || !rc.playerResponse || rc.playerResponse === 'None' || rc.playerResponse === '';
const shouldAccept = rc => pendingOf(rc) && notRespondedOf(rc);

console.log('[1] 触发判定');
const acceptCases = [
  ['InProgress + None', { state: 'InProgress', playerResponse: 'None' }, true],
  ['InProgress + 缺 playerResponse', { state: 'InProgress' }, true],
  ['InProgress + Accepted', { state: 'InProgress', playerResponse: 'Accepted' }, false],
  ['InProgress + Declined', { state: 'InProgress', playerResponse: 'Declined' }, false],
  ['None + None', { state: 'None', playerResponse: 'None' }, false],
  ['Error + None', { state: 'Error', playerResponse: 'None' }, false],
  ['Invalid + None', { state: 'Invalid', playerResponse: 'None' }, false],
  ['Expired + None', { state: 'Expired', playerResponse: 'None' }, false],
  ['Accepted + Accepted', { state: 'Accepted', playerResponse: 'Accepted' }, false],
  ['EveryoneReady + None (WS)', { state: 'EveryoneReady', playerResponse: 'None' }, false],
  ['StrangerNotReady + None (WS)', { state: 'StrangerNotReady', playerResponse: 'None' }, false],
  ['Abandoned + None', { state: 'Abandoned', playerResponse: 'None' }, false],
  ['空对象', {}, false],
  ['null', null, false],
  ['undefined', undefined, false],
  ['state 全小写 inprogress', { state: 'inprogress', playerResponse: 'None' }, false]
];
for (const [name, rc, want] of acceptCases) {
  const got = shouldAccept(rc);
  check(got === want, `${name} → 期望 ${want} 实际 ${got}`);
}

// ---- 2. 状态文案 ----
// 已接受时应当明确指出"已接受", 而不是继续显示"监听中"。
console.log('[2] 状态文案');
const statusOf = rc => {
  if (pendingOf(rc) && notRespondedOf(rc)) return 'accepting';
  if (rc && rc.playerResponse === 'Accepted') return 'accepted';
  return 'listening';
};
check(statusOf({ state: 'InProgress', playerResponse: 'None' }) === 'accepting', 'InProgress+None 应显示自动接受中');
check(statusOf({ state: 'Accepted', playerResponse: 'Accepted' }) === 'accepted', 'Accepted 应显示已接受');
check(statusOf({ state: 'Error', playerResponse: 'Accepted' }) === 'accepted', 'Error 但已响应 Accepted 也应显示已接受');
check(statusOf({ state: 'Error', playerResponse: 'None' }) === 'listening', 'Error 应回到监听中');
check(statusOf({ state: 'None', playerResponse: 'None' }) === 'listening', 'None 应监听中');

// ---- 3. 两处实现落地 ----
console.log('[3] 源码实现');
const compliance = read('renderer/js/compliance.js');
const bench = read('renderer/js/bench.js');
const lcuEvents = read('renderer/js/lcu-events.js');

// 取反写法必须彻底消失 (两处都不能再有)
for (const [name, src] of [['compliance.js', compliance], ['bench.js', bench]]) {
  check(!/!==\s*'InProgress'/.test(src), `${name} 不应再有 state !== 'InProgress' 取反判定`);
  check(!/state\s*!==\s*'None'\s*&&\s*\w*\.?state\s*!==\s*'InProgress'/.test(src), `${name} 不应再有 hasPopup 取反组合`);
}
// 正向判定必须在位
check(/String\(rc\.state \|\| ''\) === 'InProgress'/.test(compliance), 'compliance.js 应有 state === InProgress 判定');
check(/String\(rc\?\.state \|\| ''\) === 'InProgress'/.test(bench), 'bench.js 应有 state === InProgress 判定');
// 两处都要保留"未响应"条件, 避免玩家已拒绝还去 accept
check(/'None'/.test(compliance) && /playerResponse === 'None'/.test(compliance), 'compliance.js 应保留未响应判定');
check(/playerResponse === 'None'/.test(bench), 'bench.js 应保留未响应判定');
// 可靠的阶段触发通道不能被顺手删掉
check(/phase === 'ReadyCheck'/.test(lcuEvents), "lcu-events.js 应保留 phase === 'ReadyCheck' 触发");
check(/acceptReadyCheckNow\(\)/.test(lcuEvents), 'lcu-events.js 阶段触发应调用 acceptReadyCheckNow');
// 接受端点必须走 matchmaking 而不是已废弃的 team-builder 路径
check(/\/lol-matchmaking\/v1\/ready-check\/accept/.test(compliance), 'POST 端点应为 /lol-matchmaking/v1/ready-check/accept');
check(!/lol-lobby-team-builder\/v1\/ready-check\/accept/.test(compliance + bench), '不应使用 team-builder 的 accept 端点');

console.log('');
console.log(`共 ${ok + bad} 项 | PASS ${ok} | FAIL ${bad}`);
process.exit(bad ? 1 : 0);
