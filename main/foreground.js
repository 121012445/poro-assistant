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

// 1.5.73: 除了抢焦点, 这里还要能"看"和"抬"窗口 —— 浮窗被游戏压在下面
// (进游戏后不见了, alt-tab 出来又能看见) 只能靠 z 序操作解决, 而 Electron 的
// setAlwaysOnTop 只在**状态变化**时可靠, 游戏自己 SetWindowPos 之后需要重新抬。
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
      GetClassNameA: user32.func('int GetClassNameA(uintptr_t hWnd, _Out_ char *buf, int nMaxCount)'),
      // HWND_TOPMOST 是 (HWND)-1, 用 intptr_t 传 -1 最省事 (不用凑 0xFFFFFFFFFFFFFFFF)
      SetWindowPos: user32.func('bool SetWindowPos(uintptr_t hWnd, intptr_t hWndInsertAfter, int x, int y, int cx, int cy, uint32 flags)'),
      GetWindowLongPtrW: user32.func('intptr_t GetWindowLongPtrW(uintptr_t hWnd, int nIndex)'),
      VK_MENU: 0x12,
      KEYEVENTF_KEYUP: 0x0002,
      HWND_TOPMOST: -1,
      SWP_NOSIZE: 0x0001,
      SWP_NOMOVE: 0x0002,
      SWP_NOACTIVATE: 0x0010,
      GWL_EXSTYLE: -20,
      WS_EX_TOPMOST: 0x00000008,
      _koffi: koffi
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

// ===== 1.5.73: 浮窗 z 序 =====
// 用户报障: "进游戏后悬浮窗不见了, 切出游戏又能看到"。窗口一直在, 只是被游戏
// 压在下面 —— Electron 的 alwaysOnTop 在游戏自己调 SetWindowPos 之后会被顶掉,
// 而原先只在 show() 那一刻设过一次, 之后就再没人管了 (聊天框空着时更是连
// showGameTranslateWindow 都不会被调)。所以需要能随时"看一眼 + 抬一手"。

// 当前前台窗口的类名 (拿不到返回 '')。用来判断"游戏是不是在前台" ——
// 游戏不在前台时不要抢 z 序, 否则用户切去浏览器, 浮窗还赖在最上面。
function foregroundClass() {
  const a = _load();
  if (!a) return '';
  try {
    const hwnd = a.GetForegroundWindow();
    if (!hwnd) return '';
    const buf = a._koffi.alloc('char', 256);
    const n = a.GetClassNameA(hwnd, buf, 256);
    return n > 0 ? String(a._koffi.decode(buf, 'char', n)).split('\0')[0] : '';
  } catch (e) { return ''; }
}

// 窗口当前是否真的带 WS_EX_TOPMOST (Electron 的 isAlwaysOnTop 只反映它自己记的
// 状态, 不反映系统里的真实值 —— 被别的进程顶掉时它会说谎)。
function isTopmost(win) {
  const a = _load();
  if (!a) return false;
  const hwnd = hwndOf(win);
  if (!hwnd) return false;
  try {
    return (Number(a.GetWindowLongPtrW(hwnd, a.GWL_EXSTYLE)) & a.WS_EX_TOPMOST) !== 0;
  } catch (e) { return false; }
}

// 把窗口重新插到 topmost 带的最前面 (不移动/不改尺寸/不抢焦点)。
// 这是"游戏把浮窗压下去"之后唯一能拉回来的动作。
function raiseTopmost(win) {
  const a = _load();
  if (!a) return false;
  const hwnd = hwndOf(win);
  if (!hwnd) return false;
  try {
    return a.SetWindowPos(hwnd, a.HWND_TOPMOST, 0, 0, 0, 0,
      a.SWP_NOMOVE | a.SWP_NOSIZE | a.SWP_NOACTIVATE);
  } catch (e) { return false; }
}

module.exports = { stealFocus, isForeground, focusWindowClass, foregroundClass, isTopmost, raiseTopmost, _load };
