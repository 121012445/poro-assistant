'use strict';
// 选人浮窗的"贴客户端边缘"位置计算测试。
//
// 被测对象是 main/overlay-position.js —— 刻意做成纯函数 (不 require electron),
// 所以这里可以直接 require 进来跑, 不需要 Electron 环境。
const assert = require('assert');
const { OVERLAY_SIZE, isUsableClientRect, defaultOverlayBounds, computeOverlayBounds } =
  require('./main/overlay-position');

const W = 244, H = 336;
assert.strictEqual(OVERLAY_SIZE.width, W, '浮窗宽度应与页面设计一致');
assert.strictEqual(OVERLAY_SIZE.height, H, '浮窗高度应与页面设计一致');

// ---- 1. 哨兵矩形必须判掉 (否则浮窗会被甩到屏幕外) ----
// 实测国服客户端最小化时 Windows 给出的就是这种坐标
assert.strictEqual(isUsableClientRect({ x: -21333, y: -21333, width: 158, height: 26 }), false,
  '最小化哨兵矩形 (-21333 + 塌缩尺寸) 必须判为不可用');
assert.strictEqual(isUsableClientRect({ x: -32000, y: -32000, width: 237, height: 39 }), false,
  '移出桌面的哨兵矩形必须判为不可用');
assert.strictEqual(isUsableClientRect(null), false, 'null 必须判为不可用');
assert.strictEqual(isUsableClientRect({ x: 0, y: 0, width: NaN, height: 700 }), false,
  'NaN 必须判为不可用');
assert.strictEqual(isUsableClientRect({ x: 0, y: 0, width: 100, height: 700 }), false,
  '宽度塌缩 (100px) 必须判为不可用');
assert.strictEqual(isUsableClientRect({ x: 213, y: 101, width: 1280, height: 720 }), true,
  '正常窗口矩形应判为可用');

// ---- 2. 拿不到客户端矩形 -> 退回贴屏幕右缘、垂直居中 ----
const wa = { x: 0, y: 0, width: 1920, height: 1080 };
const fallback = computeOverlayBounds({ clientRect: null, workArea: wa, size: OVERLAY_SIZE, saved: null });
const expectFallback = defaultOverlayBounds(wa, OVERLAY_SIZE);
assert.deepStrictEqual(fallback, expectFallback, '没有客户端矩形时应退回默认位置');
assert.strictEqual(fallback.x + W <= wa.x + wa.width, true, '默认位置必须完整落在工作区内');
assert.strictEqual(fallback.y, Math.round((1080 - H) / 2), '默认位置应垂直居中');

// ---- 3. 右侧放得下 -> 贴客户端右外侧, 留 8px 缝 ----
const wide = { x: 0, y: 0, width: 2560, height: 1440 };
const right = computeOverlayBounds({
  clientRect: { x: 300, y: 200, width: 1280, height: 720 }, workArea: wide, size: OVERLAY_SIZE, saved: null
});
assert.strictEqual(right.x, 300 + 1280 + 8, '右侧有地方时应贴客户端右外侧 (间隔 8px)');
assert.strictEqual(right.y, 200, '垂直方向应与客户端顶部对齐');
assert.ok(right.x + W <= wide.width, '结果必须完整落在工作区内');

// ---- 4. 右边放不下但左边放得下 -> 贴左外侧 ----
const left = computeOverlayBounds({
  clientRect: { x: 700, y: 100, width: 1280, height: 720 },
  workArea: { x: 0, y: 0, width: 2000, height: 1080 }, size: OVERLAY_SIZE, saved: null
});
assert.strictEqual(left.x, 700 - W - 8, '右侧不够时应改贴客户端左外侧');
assert.strictEqual(left.y, 100, '垂直方向仍与客户端顶部对齐');

// ---- 5. 两侧都放不下 (客户端最大化/占满屏) -> 压回客户端右缘, 且不越界 ----
// 这是 Akari 的行为, 也是玩家看到"浮窗就在客户端上"的来源
const maximized = computeOverlayBounds({
  clientRect: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1080 }, size: OVERLAY_SIZE, saved: null
});
assert.strictEqual(maximized.x, 1920 - W, '客户端占满屏时应压在右缘, 且不超出工作区');
assert.strictEqual(maximized.x + W, 1920, '右边界应正好齐平工作区右缘');
assert.strictEqual(maximized.y, 0, '垂直方向被夹在工作区顶部');

// ---- 6. 真机数据回归 (2026-09-17 国服实测) ----
// 客户端 RCLIENT {213,101,1280x720} 在 1707x960 的工作区里:
//   贴右需 x=1501 但最大允许 1463; 贴左需 x=-39 但工作区从 0 开始 —— 两侧都放不下,
//   于是压回客户端右缘 = min(213+1280-244, 1463) = 1249。
const real = computeOverlayBounds({
  clientRect: { x: 213, y: 101, width: 1280, height: 720 },
  workArea: { x: 0, y: 0, width: 1707, height: 960 }, size: OVERLAY_SIZE, saved: null
});
assert.strictEqual(real.x, 1249, '真机场景应压在客户端右缘 (两侧外侧都放不下)');
assert.strictEqual(real.y, 101, '真机场景垂直方向与客户端顶部对齐 (未触发夹边界)');
assert.ok(real.x >= 0 && real.x + W <= 1707, '真机场景结果必须完整落在工作区内');

// ---- 7. 垂直方向夹边界: 客户端贴底时浮窗不能掉出屏幕 ----
const bottom = computeOverlayBounds({
  clientRect: { x: 400, y: 1300, width: 800, height: 140 },
  workArea: { x: 0, y: 0, width: 2560, height: 1440 }, size: OVERLAY_SIZE, saved: null
});
assert.ok(bottom.y + H <= 1440, `浮窗底部不得超出工作区 (实际 y=${bottom.y}, 底=${bottom.y + H})`);
assert.strictEqual(bottom.y, 1440 - H, '贴底时应被夹到"刚好放得下"的位置');
// 反过来: 客户端靠上但没到顶部时, 应保持与客户端顶部对齐而不被夹
const notClamped = computeOverlayBounds({
  clientRect: { x: 400, y: 800, width: 800, height: 600 },
  workArea: { x: 0, y: 0, width: 2560, height: 1440 }, size: OVERLAY_SIZE, saved: null
});
assert.strictEqual(notClamped.y, 800, '放得下时不该夹, 否则浮窗会莫名往上跳');
assert.strictEqual(notClamped.x, 400 + 800 + 8, '同场景下水平方向应贴右外侧');

// ---- 8. 用户拖过的位置优先于一切 ----
const saved = { x: 42, y: 43, width: W, height: H };
const withSaved = computeOverlayBounds({
  clientRect: { x: 300, y: 200, width: 1280, height: 720 }, workArea: wide, size: OVERLAY_SIZE, saved: saved
});
assert.deepStrictEqual(withSaved, saved, '用户手动摆过的位置必须原样沿用, 自动吸附不得覆盖');
const savedNoClient = computeOverlayBounds({ clientRect: null, workArea: wa, size: OVERLAY_SIZE, saved: saved });
assert.deepStrictEqual(savedNoClient, saved, '没有客户端矩形时也应沿用用户位置');

// ---- 9. 多屏/副屏: workArea 非零原点时也要正确夹边界 ----
const sec = computeOverlayBounds({
  clientRect: { x: 2000, y: 100, width: 600, height: 500 },
  workArea: { x: 1920, y: 0, width: 1280, height: 1024 }, size: OVERLAY_SIZE, saved: null
});
assert.ok(sec.x >= 1920 && sec.x + W <= 1920 + 1280, '副屏上不得越过该屏工作区左缘');
assert.ok(sec.y >= 0 && sec.y + H <= 1024, '副屏上不得超出该屏工作区高度');

console.log('选人浮窗位置计算测试通过 (9 组断言: 哨兵矩形判据 / 兜底位置 / 贴右外侧 / 改贴左外侧 / 占满屏压回右缘 / 真机数据回归 / 垂直夹边界与不误夹 / 用户位置优先 / 副屏边界)');
