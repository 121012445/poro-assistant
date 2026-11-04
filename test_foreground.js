'use strict';
// foreground.js 冒烟测试: koffi/user32 可加载、导出齐全、异常输入不抛错。
// 真实抢前台行为依赖有前台窗口的交互环境, 这里只验证契约与健壮性。
const assert = require('assert');
const fg = require('./main/foreground');

// 1) 导出契约
assert.strictEqual(typeof fg.stealFocus, 'function', 'stealFocus 导出');
assert.strictEqual(typeof fg.isForeground, 'function', 'isForeground 导出');
assert.strictEqual(typeof fg.focusWindowClass, 'function', 'focusWindowClass 导出');
assert.strictEqual(typeof fg._load, 'function', '_load 导出');

// 2) 在本机 (Windows + koffi) 上 user32 应能加载; 加载失败也不该抛异常
const api = fg._load();
if (process.platform === 'win32') {
  assert.ok(api, 'win32 上 koffi/user32 必须加载成功');
  assert.strictEqual(typeof api.GetForegroundWindow, 'function');
  assert.strictEqual(typeof api.SetForegroundWindow, 'function');
  assert.strictEqual(typeof api.keybd_event, 'function');
  assert.strictEqual(typeof api.FindWindowA, 'function');
  assert.strictEqual(api.VK_MENU, 0x12);
  assert.strictEqual(api.KEYEVENTF_KEYUP, 0x0002);
}

// 3) 异常输入不抛错, 一律返回 false
assert.strictEqual(fg.stealFocus(null), false, 'stealFocus(null)=false');
assert.strictEqual(fg.stealFocus({ isDestroyed: () => true }), false, '已销毁窗口=false');
assert.strictEqual(fg.isForeground(null), false, 'isForeground(null)=false');
assert.strictEqual(fg.focusWindowClass('PoroNoSuchWindowClass__'), false, '不存在的类名=false');
assert.strictEqual(fg.focusWindowClass(''), false, '空类名=false');

// 4) 二次调用走缓存路径仍然安全
assert.strictEqual(fg._load(), api, '_load 幂等');
assert.strictEqual(fg.stealFocus(null), false, '缓存后仍不抛错');

console.log('test_foreground: all assertions passed');
