// 自动接受延迟: 规则 + 源码接线回归测试
//
// 背景 (2026-11-25): 用户要"自动接受延迟" —— 匹配弹窗出现后等 N 秒再点接受,
// 避免秒接受暴露排位意图。默认 0 秒 = 立即 (保持旧行为), 范围 0–10 秒。
// 三处触发通道 (phase=ReadyCheck / WS ready-check / GET 轮询) 都汇入共享函数
// acceptReadyCheckNow(), 延迟必须在此统一处理, 并保持 busy 锁防重入;
// 延迟结束必须复查弹窗仍是 InProgress+未响应才 POST, 否则重演历史 bug
// (失效弹窗被反复 accept → 433 次 500)。
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let ok = 0, bad = 0;
const check = (cond, msg) => { if (cond) { ok++; } else { bad++; console.log('  FAIL ' + msg); } };

// ---- 1. 延迟值钳位规则 ----
// 与 setAutoAcceptDelay / loadConfig 里的实现一致: 四舍五入 + 钳到 0–10, 非法值归 0
const clampDelay = sec => Math.max(0, Math.min(10, Math.round(Number(sec) || 0)));
console.log('[1] 延迟值钳位');
const clampCases = [
  [0, 0], [5, 5], [10, 10],
  ['0', 0], ['7', 7], ['10', 10],
  [-3, 0], ['-2', 0], [15, 10], ['99', 10],
  [2.4, 2], [2.6, 3], ['3.5', 4],
  ['', 0], [null, 0], [undefined, 0], ['abc', 0], [NaN, 0]
];
for (const [input, want] of clampCases) {
  const got = clampDelay(input);
  check(got === want, `clampDelay(${JSON.stringify(input)}) → 期望 ${want} 实际 ${got}`);
}

// ---- 2. 延迟后复查规则: 只有仍 InProgress 且未响应才 POST ----
const pendingOf = rc => String((rc && rc.state) || '') === 'InProgress';
const notRespondedOf = rc => !rc || !rc.playerResponse || rc.playerResponse === 'None' || rc.playerResponse === '';
const shouldPostAfterDelay = rc => pendingOf(rc) && notRespondedOf(rc);
console.log('[2] 延迟后复查');
const recheckCases = [
  ['仍弹窗未响应', { state: 'InProgress', playerResponse: 'None' }, true],
  ['期间被手动接受', { state: 'InProgress', playerResponse: 'Accepted' }, false],
  ['期间被手动拒绝', { state: 'InProgress', playerResponse: 'Declined' }, false],
  ['弹窗已失效', { state: 'Expired', playerResponse: 'None' }, false],
  ['弹窗已关闭', { state: 'None', playerResponse: 'None' }, false],
  ['复查报错(404)', { __error: 1, httpStatus: 404 }, false],
  ['复查为 null', null, false]
];
for (const [name, rc, want] of recheckCases) {
  const got = shouldPostAfterDelay(rc);
  check(got === want, `${name} → 期望 ${want} 实际 ${got}`);
}

// ---- 3. 源码接线 ----
console.log('[3] 源码接线');
const compliance = read('renderer/js/compliance.js');
const app = read('renderer/js/app.js');
const persist = read('renderer/js/persist.js');
const html = read('renderer/index.html');

// 变量声明
check(/let autoAcceptDelaySec = 0/.test(app), 'app.js 应声明 autoAcceptDelaySec 且默认 0');
// setter 存在且钳位
check(/function setAutoAcceptDelay\(sec\)/.test(compliance), 'compliance.js 应有 setAutoAcceptDelay');
check(/Math\.max\(0, Math\.min\(10, Math\.round\(Number\(sec\) \|\| 0\)\)\)/.test(compliance), 'setAutoAcceptDelay 应做 0–10 钳位');
check(/autoAcceptDelayValue/.test(compliance), 'setAutoAcceptDelay 应更新状态文案元素');

// 延迟逻辑在共享函数内 (三通道统一), busy 锁在延迟前设置、finally 释放
const fnStart = compliance.indexOf('async function acceptReadyCheckNow()');
const fnEnd = compliance.indexOf('\n}', fnStart);
const acceptFn = compliance.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
check(/autoAcceptDelaySec \* 1000/.test(acceptFn), '共享接受函数内应有延迟等待');
check(/_readyCheckAccepting = true/.test(acceptFn) && /_readyCheckAccepting = false/.test(acceptFn), '共享接受函数应保持 busy 锁');
check(acceptFn.indexOf('_readyCheckAccepting = true') < acceptFn.indexOf('setTimeout'), 'busy 锁应在延迟等待之前设置');
check(/await lolAPI\.lcuRequest\('GET', '\/lol-matchmaking\/v1\/ready-check'\)/.test(acceptFn), '延迟后应复查 ready-check 状态');
check(/!pending \|\| !notResponded/.test(acceptFn), '复查不通过时应跳过 POST');
check(/!autoAcceptOn \|\| complianceOn/.test(acceptFn), '延迟后应复查开关/合规模式仍允许');
// 0 秒时不引入延迟 (保持旧行为)
check(/if \(autoAcceptDelaySec > 0\)/.test(acceptFn), '延迟为 0 时应跳过等待分支');

// UI: 滑条接线
check(/id="autoAcceptDelay"/.test(html), 'index.html 应有 autoAcceptDelay 滑条');
check(/min="0" max="10" step="1"/.test(html), '滑条范围应为 0–10 整数');
check(/oninput="setAutoAcceptDelay\(this\.value\)"/.test(html), '滑条应调用 setAutoAcceptDelay');
check(/id="autoAcceptDelayValue"/.test(html), 'index.html 应有延迟文案元素');

// 持久化: 保存 / 恢复 / 导入白名单
check(/storeSet\('autoAcceptDelaySec'/.test(persist), 'saveConfig 应保存 autoAcceptDelaySec');
check(/storeGet\('autoAcceptDelaySec'\)/.test(persist), 'loadConfig 应读取 autoAcceptDelaySec');
check(/'autoAcceptDelaySec'/.test(persist), '备份导入白名单应包含 autoAcceptDelaySec');

console.log('');
console.log(`共 ${ok + bad} 项 | PASS ${ok} | FAIL ${bad}`);
process.exit(bad ? 1 : 0);
