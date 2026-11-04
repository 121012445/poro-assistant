'use strict';
/**
 * 前台焦点抢夺 —— 输入浮窗"呼出后还得点一下才能打字"的修复。
 *
 * 现象: 游戏在前台时按热键呼出输入浮窗, 主进程调 win.focus() 被 Windows 前台锁
 * (SetForegroundWindow 限制) 静默拒绝 —— 只有用户真实点击才授予激活权,
 * 所以键盘焦点还留在游戏上, 继续打字就操作了游戏。
 *
 * 解法 (Win32 生态的经典做法): 先合成一次 ALT 按下/抬起。系统规则是
 * "最近一次输入事件由本进程发出的进程"有权设置前台窗口, 合成 ALT 之后
 * SetForegroundWindow 就会被放行。用 koffi 直调 user32, 无需任何编译链。
 *
 * 设计原则与 win-rect.js 一致: **任何环节失败都返回 false, 绝不抛异常**,
 * 调用方退化为普通 win.focus(), 最坏情况回到修复前的行为。
 */

let api = null;         // user32 函数集 | null (koffi 加载失败)
let tried = false;

function _load() {
  if (tried) return api;
  tried = true;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    api = {
      GetForegroundWindow: user32.func('uintptr_t GetForegroundWindow()'),
      SetForegroundWindow: user32.func('bool SetForegroundWindow(uintptr_t hWnd)'),
      keybd_event: user32.func('void keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo)'),
      FindWindowA: user32.func('uintptr_t FindWindowA(string lpClassName, string lpWindowName)'),
      VK_MENU: 0x12,
      KEYEVENTF_KEYUP: 0x0002
    };
  } catch (e) { api = null; }
  return api;
}

// Electron 的 getNativeWindowHandle() 返回装着 HWND 值的 Buffer (x64 上 8 字节)
function hwndOf(win) {
  try {
    const buf = win.getNativeWindowHandle();
    if (!buf || !buf.length) return null;
    return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  } catch (e) { return null; }
}

// 合成 ALT + SetForegroundWindow; 返回是否确认拿到前台
function activate(hwnd) {
  const a = api;
  if (!a || !hwnd) return false;
  try {
    if (a.GetForegroundWindow() === hwnd) return true;
    a.keybd_event(a.VK_MENU, 0, 0, 0);
    a.keybd_event(a.VK_MENU, 0, a.KEYEVENTF_KEYUP, 0);
    a.SetForegroundWindow(hwnd);
    return a.GetForegroundWindow() === hwnd;
  } catch (e) { return false; }
}

// 激活本应用的 BrowserWindow 并确保拿到键盘焦点。
// 返回 false 时调用方应已先做过普通 win.focus(), 无需额外兜底。
function stealFocus(win) {
  if (tried && !api) return false;
  const a = _load();
  if (!a) return false;
  if (!win || win.isDestroyed()) return false;
  return activate(hwndOf(win));
}

// 当前前台窗口是否还是本窗口 (用于决定退出输入态时是否要"把焦点还给游戏")
function isForeground(win) {
  const a = _load();
  if (!a) return false;
  if (!win || win.isDestroyed()) return false;
  try { return a.GetForegroundWindow() === hwndOf(win); } catch (e) { return false; }
}

// 按窗口类名激活 ( RiotWindowClass=游戏内, RCLIENT=客户端 ), 用于显式归还焦点
function focusWindowClass(className) {
  const a = _load();
  if (!a) return false;
  let hwnd = null;
  try { hwnd = a.FindWindowA(String(className), null) || null; } catch (e) { hwnd = null; }
  if (!hwnd) return false;
  return activate(hwnd);
}

module.exports = { stealFocus, isForeground, focusWindowClass, _load };
