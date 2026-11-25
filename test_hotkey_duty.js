'use strict';
// 1.6.67: 分工表一键发送热键 (duty)。
// 覆盖三件事:
//   1) 默认键位 Ctrl+Shift+D 能被 hotkey-manager 解析成 vk/mods/accelerator, 且与既有 6 个默认键不冲突
//   2) 主进程按阶段分组注册: 对局键只在 InProgress, duty 只在 ChampSelect (桌面/大厅不注册)
//   3) 渲染层能列出 duty 这一行、能改键、能接住 shortcut:duty 并调 sendDutyChat
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parse } = require('./main/hotkey-manager');

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---------------- 1. 键位解析 ----------------
const parsed = parse('Ctrl+Shift+D');
assert.ok(parsed, 'Ctrl+Shift+D 必须能解析');
assert.strictEqual(parsed.display, 'Ctrl+Shift+D', '显示名统一成 Ctrl+Shift+D');
assert.strictEqual(parsed.vk, 0x44, 'D 的 VK 是 0x44');
assert.deepStrictEqual(parsed.mods.slice().sort(), [0x10, 0x11].sort(), 'mods 必须同时含 Ctrl(0x11) 与 Shift(0x10)');
assert.strictEqual(parsed.accelerator, 'Control+Shift+D', 'Electron accelerator 用 Control 而不是 Ctrl');

// 宽松输入也能归一 (录制时按键顺序不固定)
assert.strictEqual(parse('shift+ctrl+d').display, 'Ctrl+Shift+D');
assert.strictEqual(parse('D'), null, '裸字母不许绑');

// ---------------- 2. 主进程: 默认键位 + 阶段分组 ----------------
const mainSrc = read('main/index.js');
const defaultsBlock = mainSrc.match(/const HOTKEY_DEFAULTS = Object\.freeze\(\{([^}]*)\}\)/);
assert.ok(defaultsBlock, 'HOTKEY_DEFAULTS 必须存在');
const defaults = {};
for (const m of defaultsBlock[1].matchAll(/(\w+):\s*'([^']+)'/g)) defaults[m[1]] = m[2];
assert.strictEqual(defaults.duty, 'Ctrl+Shift+D', 'duty 默认键位是 Ctrl+Shift+D');
assert.ok(Object.prototype.hasOwnProperty.call(defaults, 'f11'), 'f11 默认键位不能被漏掉');

// 默认键两两不重复 (否则一进去就撞车)
const combos = Object.entries(defaults).map(([k, v]) => [k, parse(v)]);
for (const [k, p] of combos) assert.ok(p, k + ' 的默认键位必须可解析');
for (let i = 0; i < combos.length; i++) {
  for (let j = i + 1; j < combos.length; j++) {
    assert.notStrictEqual(combos[i][1].display, combos[j][1].display,
      combos[i][0] + ' 与 ' + combos[j][0] + ' 默认键位重复');
  }
}
assert.ok(mainSrc.includes("duty: '分工表 · 一键发到选人聊天'"), '工具栏要能给这个动作起说明名');

// 阶段表: 六个对局键绑 InProgress, duty 只绑 ChampSelect
const phasesBlock = mainSrc.match(/const HOTKEY_PHASES = Object\.freeze\(\{([\s\S]*?)\}\)/);
assert.ok(phasesBlock, 'HOTKEY_PHASES 必须存在');
const phases = {};
for (const m of phasesBlock[1].matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
  phases[m[1]] = m[2].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean);
}
for (const act of ['f6', 'f7', 'f8', 'f9', 'f10', 'f11']) {
  assert.deepStrictEqual(phases[act], ['InProgress'], act + ' 只在对局内生效');
}
assert.deepStrictEqual(phases.duty, ['ChampSelect'], '分工表只发选人聊天, 只能在 ChampSelect 生效');

// 旧的全量开关必须清干净, 否则阶段分组形同虚设
assert.ok(!mainSrc.includes('inProgressHotkeysActive'), '旧的 inProgressHotkeysActive 开关必须删掉');

// 注册/注销都按动作集合走
assert.ok(/function hotkeyActionsForPhase\(phase\)/.test(mainSrc));
assert.ok(/function syncHotkeys\(phase\)/.test(mainSrc));
assert.ok(/activeHotkeyActions = new Set\(wanted\)/.test(mainSrc), '当前生效动作集合要随阶段重建');
assert.ok(/const reg = registerHotkeys\(wanted\)/.test(mainSrc), '只注册当前阶段需要的键');
assert.ok(/unregisterHotkeys\(\)/.test(mainSrc), '切换阶段先全量注销');
assert.ok(mainSrc.includes('hotkeyPoller.stop()'), '切阶段必须停掉旧轮询器');

// 分发: 只认当前阶段注册过的动作, duty 落到渲染层
assert.ok(/if \(!activeHotkeyActions\.has\(action\)\) return;/.test(mainSrc), '未注册的动作即使误报也不能执行');
assert.ok(mainSrc.includes("sendToWindow('shortcut:duty', true)"), 'duty 发给渲染层执行');
assert.ok(mainSrc.includes("dispatchHotkey(action, 'win32-poll')"), 'Win32 轮询结果接入统一分发');
assert.ok(mainSrc.includes("dispatchHotkey(action, 'electron')"), 'Electron 全局快捷键接入统一分发');

// 阶段联动: ChampSelect 也要注册 (不能只有 InProgress 分支)
assert.ok(/phase === 'InProgress' \|\| phase === 'ChampSelect'\) \? phase : null/.test(mainSrc),
  'phase=ChampSelect 时要按 duty 注册热键');

// ---------------- 3. preload / 渲染层 ----------------
const preloadSrc = read('main/preload.js');
assert.ok(preloadSrc.includes("ipcRenderer.on('shortcut:duty'"), 'preload 要转发 shortcut:duty');
assert.ok(/onDutyShortcut:/.test(preloadSrc));

// hotkeys.js 在沙箱里真跑一遍, 验证动作列表与默认显示
const hotkeyCtx = {
  storeGet: () => null, storeSet: () => {}, document: { getElementById: () => null },
  window: {}, console
};
vm.createContext(hotkeyCtx);
vm.runInContext(read('renderer/js/hotkeys.js'), hotkeyCtx, { filename: 'hotkeys.js' });
assert.deepStrictEqual(Array.from(hotkeyCtx.hkActionList()), ['f6', 'f7', 'f8', 'f9', 'f10', 'duty'],
  '工具箱热键列表要含 duty');
assert.strictEqual(hotkeyCtx.hkCurrentCombo('duty'), 'Ctrl+Shift+D', '未改键时显示默认组合');

// index.html: 要有这一行 (按钮 + 文案 id 与 hkStartRecord 的参数对齐)
const html = read('renderer/index.html');
assert.ok(html.includes('id="hk_duty"'), '工具箱要有 duty 改键按钮');
assert.ok(html.includes('id="hkLabel_duty"'), 'duty 按钮的说明文字 id 要能被 hkActionLabel 读到');
assert.ok(html.includes("hkStartRecord('duty')"), '按钮点击要进入录制');
assert.ok(html.includes('分工表 · 一键发到选人聊天'), '界面文案要说清这个键干什么');
assert.ok(html.includes('js/hotkeys.js?v=2026112611'), 'hotkeys.js 版本串要 bump');

// live.js: 接住事件 → 缺缓存先补拉 → 发送
const liveSrc = read('renderer/js/live.js');
assert.ok(liveSrc.includes('onDutyShortcut'), '实时页要监听快捷键事件');
assert.ok(/function sendDutyChatByHotkey\(\)/.test(liveSrc));
assert.ok(liveSrc.includes("sendDutyChatByHotkey();"), '事件回调要真的调用发送');
assert.ok(/if \(!cached \|\| !cached\.ready\)/.test(liveSrc), '缓存没算好时要先补拉一次');
assert.ok(/await updateLivePage\('ChampSelect'\)/.test(liveSrc), '补拉走实时页刷新, 复用同一份 10 人数据');
assert.ok(liveSrc.includes("window._gameflowPhase !== 'ChampSelect'"), '渲染层仍要自己判阶段');

// 分工表发送只在选人阶段: 这条底层约束不能被热键绕过
assert.ok(/if \(window\._gameflowPhase !== 'ChampSelect'\) \{ if \(typeof showToast === 'function'\) showToast\('只在选人阶段可用'/.test(liveSrc),
  'sendDutyChat 自身仍保留阶段校验');

console.log('分工表热键 (duty) 键位/阶段分组/渲染层接线测试通过');
