'use strict';
/**
 * 选人浮窗的位置计算 —— 刻意做成**纯函数**, 不依赖 electron, 便于单测。
 *
 * 坐标全部是 Electron 的 DIP 空间 (与 screen.workArea / BrowserWindow.setBounds 一致)。
 * 读取客户端窗口矩形的活由 win-rect.js 负责, 这里只管"拿到矩形之后摆哪儿"。
 */

const OVERLAY_SIZE = { width: 244, height: 336 };
const OVERLAY_GAP = 8;   // 与客户端边缘留一点缝, 免得视觉上糊在一起

// 客户端最小化/被隐藏时, Windows 会给出这类哨兵矩形:
//   {x:-21333, y:-21333, w:158, h:26}   (实测国服客户端最小化)
//   {x:-32000, y:-32000, ...}           (系统托盘类)
// 拿它去摆浮窗会把窗甩到屏幕外, 所以必须先判掉。
function isUsableClientRect(r) {
  if (!r) return false;
  if (!['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k]))) return false;
  if (r.width < 200 || r.height < 50) return false;   // 塌缩成小条 = 最小化
  if (r.x < -10000 || r.y < -10000) return false;     // 负得离谱 = 已移出桌面
  if (r.width > 20000 || r.height > 20000) return false;
  return true;
}

// 没有可用客户端矩形时的兜底: 贴主屏工作区右侧、垂直居中 (客户端通常居中/靠左, 这样不挡画面)
function defaultOverlayBounds(workArea, size) {
  const wa = workArea || { x: 0, y: 0, width: 1280, height: 720 };
  const s = size || OVERLAY_SIZE;
  return {
    x: Math.round(wa.x + wa.width - s.width - 16),
    y: Math.round(wa.y + Math.max(0, (wa.height - s.height) / 2)),
    width: s.width,
    height: s.height
  };
}

/**
 * @param {object} req
 * @param {object|null} req.clientRect  客户端窗口矩形 (DIP)
 * @param {object} req.workArea         该显示器的可用区 (DIP)
 * @param {object} [req.size]           浮窗尺寸
 * @param {object|null} [req.saved]     用户拖拽后保存的位置; 有则原样沿用
 */
function computeOverlayBounds(req) {
  const r = req || {};
  const size = r.size || OVERLAY_SIZE;
  const wa = r.workArea || { x: 0, y: 0, width: 1280, height: 720 };

  // 用户手动摆过就以用户为准 —— 自动吸附不该覆盖用户的明确意图
  if (r.saved) return r.saved;
  if (!isUsableClientRect(r.clientRect)) return defaultOverlayBounds(wa, size);

  const c = r.clientRect;
  const maxX = wa.x + wa.width - size.width;
  const rightX = c.x + c.width + OVERLAY_GAP;
  const leftX = c.x - size.width - OVERLAY_GAP;

  let x;
  if (rightX <= maxX) {
    x = rightX;                                    // 贴客户端右外侧 (最常见)
  } else if (leftX >= wa.x) {
    x = leftX;                                     // 右边放不下就贴左外侧
  } else {
    // 两侧都放不下 (客户端最大化/占满屏幕): 压回客户端右缘 ——
    // 这正是 Akari 的行为, 也是玩家看到"它就贴在客户端上"的来源。
    x = Math.max(wa.x, Math.min(c.x + c.width - size.width, maxX));
  }

  // 垂直方向与客户端顶部对齐, 再夹进工作区, 保证整个窗都在屏幕内
  const y = Math.max(wa.y, Math.min(c.y, wa.y + wa.height - size.height));

  return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height };
}

module.exports = { OVERLAY_SIZE, OVERLAY_GAP, isUsableClientRect, defaultOverlayBounds, computeOverlayBounds };
