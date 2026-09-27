'use strict';
const assert = require('assert');
const { createChangeLog } = require('./main/log-change');

// 1. 首次一定落盘
const log = createChangeLog();
assert.strictEqual(log.shouldLog('a', '第一行'), true, '首次出现必须记录');

// 2. 核心诉求：相同内容重复不再写
for (let i = 0; i < 1000; i++) assert.strictEqual(log.shouldLog('a', '第一行'), false, '内容未变不应重复记录');

// 3. 内容一变立刻写（不丢信息）
assert.strictEqual(log.shouldLog('a', '第二行'), true, '内容变化必须立刻记录');
assert.strictEqual(log.shouldLog('a', '第二行'), false);

// 4. 键之间互不影响：模拟 3 个 OCR 槽位各自独立
const slots = createChangeLog();
assert.strictEqual(slots.shouldLog('ocr-0', '左'), true);
assert.strictEqual(slots.shouldLog('ocr-1', '中'), true);
assert.strictEqual(slots.shouldLog('ocr-2', '右'), true);
assert.strictEqual(slots.shouldLog('ocr-1', '中'), false, '别的槽位写过不应影响本槽位');

// 5. 真实场景收益：3 槽位 × 100 轮完全相同的识别结果
//    改前 300 行，改后 3 行
const real = createChangeLog();
let written = 0;
for (let round = 0; round < 100; round++) {
  for (let slot = 0; slot < 3; slot++) {
    if (real.shouldLog('ocr-' + slot, 'slot=' + (slot + 1) + ' match=捐赠')) written++;
  }
}
assert.strictEqual(written, 3, '100 轮 3 槽位相同结果应只写 3 行，实际 ' + written);

// 6. reset(key) 只清指定键
const one = createChangeLog();
one.shouldLog('x', 'v');
one.shouldLog('y', 'v');
one.reset('x');
assert.strictEqual(one.shouldLog('x', 'v'), true, 'reset 后同内容应重新记录');
assert.strictEqual(one.shouldLog('y', 'v'), false, 'reset(key) 不应影响其他键');

// 7. reset() 清空全部
const all = createChangeLog();
all.shouldLog('x', 'v');
all.shouldLog('y', 'v');
all.reset();
assert.strictEqual(all.shouldLog('x', 'v'), true);
assert.strictEqual(all.shouldLog('y', 'v'), true);

// 8. 键数量不随重复增长（内存不涨）
assert.strictEqual(real.size(), 3, '键数应固定为槽位数，不随轮次增长');
const bounded = createChangeLog();
for (let i = 0; i < 500; i++) bounded.shouldLog('overlay-hide', 'items=0 visible=false');
assert.strictEqual(bounded.size(), 1, '同一键重复写入不应增长记忆');

// 9. 浮窗场景：状态真的翻转时要能写出来
const overlay = createChangeLog();
assert.strictEqual(overlay.shouldLog('overlay-hide', 'items=0 visible=false'), true);
assert.strictEqual(overlay.shouldLog('overlay-hide', 'items=0 visible=false'), false);
assert.strictEqual(overlay.shouldLog('overlay-hide', 'items=3 visible=true'), true, '状态翻转必须记录');

console.log('日志去重：首次落盘、重复抑制、变化即写、键隔离、reset 与内存有界测试通过');
