'use strict';
const assert = require('assert');
const { VK, createPoller } = require('./main/hotkey-poller');

const down = new Set();
const events = [];
let clock = 1000;
let scheduled = null;
let cleared = false;
const poller = createPoller(
  (vk) => down.has(vk) ? 0x8000 : 0,
  (action) => events.push(action),
  {
    debounceMs: 250,
    now: () => clock,
    setIntervalFn: (fn) => { scheduled = fn; return { unref() {} }; },
    clearIntervalFn: () => { cleared = true; }
  }
);

assert.strictEqual(poller.start(), true);
assert.strictEqual(poller.start(), false, '重复启动不能创建第二个轮询器');
assert.ok(scheduled, '启动后应安装轮询回调');

down.add(VK.f7); scheduled();
assert.deepStrictEqual(events, ['f7'], 'F7 单键应在按下沿触发');
scheduled(); scheduled();
assert.deepStrictEqual(events, ['f7'], '按住按键不能连续触发');

down.delete(VK.f7); scheduled();
clock += 300;
down.add(VK.f7); scheduled();
assert.deepStrictEqual(events, ['f7', 'f7'], '松开再按应再次触发');

down.delete(VK.f7); down.add(VK.f8); scheduled();
down.delete(VK.f8); down.add(VK.f6); scheduled();
assert.deepStrictEqual(events, ['f7', 'f7', 'f8', 'f6'], 'F6/F7/F8 应映射到各自动作');

// F10 = Ctrl+F10 组合键 (F10 本身是国服客户端举报键, 单按绝不能触发)
down.delete(VK.f6);
down.add(VK.f10); scheduled();
assert.deepStrictEqual(events, ['f7', 'f7', 'f8', 'f6'], '单按 F10 不应触发');
down.add(VK.control); scheduled();
assert.deepStrictEqual(events, ['f7', 'f7', 'f8', 'f6', 'f10'], 'Ctrl+F10 应触发');
scheduled(); scheduled();
assert.deepStrictEqual(events.length, 5, '按住组合键不能连续触发');
down.delete(VK.f10); down.delete(VK.control); scheduled();
clock += 300;
// Ctrl 先按住, 再按 F10 (实际游戏里的按键顺序)
down.add(VK.control); scheduled();
assert.deepStrictEqual(events.length, 5, '只按住 Ctrl 不触发');
down.add(VK.f10); scheduled();
assert.deepStrictEqual(events, ['f7', 'f7', 'f8', 'f6', 'f10', 'f10'], 'Ctrl 先按住再按 F10 应触发');
down.delete(VK.f10); down.delete(VK.control); scheduled();

assert.strictEqual(poller.stop(), true);
assert.strictEqual(cleared, true);
assert.strictEqual(poller.stop(), false, '重复停止应安全无副作用');
console.log('Win32 单键快捷键轮询按下沿与去重测试通过');
