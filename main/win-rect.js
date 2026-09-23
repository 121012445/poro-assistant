'use strict';
/**
 * 读英雄联盟客户端窗口的屏幕矩形 —— 浮窗"贴边"的数据来源。
 *
 * 用 koffi (预编译的 N-API 原生桥) 直调 user32.dll, **不需要任何 C/C# 编译工具链**。
 * 之前想给 PoroInput.cs 加 GetWindowRect, 但本环境把 csc.exe 安全拦掉了; koffi 绕开了这个问题。
 *
 * 窗口类名实测 (2026-09-17 国服):
 *   RCLIENT        = 客户端主窗 (选人界面就在这里), 标题 "League of Legends"
 *   RiotWindowClass= 游戏内窗口 (PoroInput.cs 用的是这个, 只在进游戏后存在)
 * 选人阶段要贴的是 RCLIENT。
 *
 * 设计原则: **任何环节失败都返回 null, 绝不抛异常**。贴边只是体验优化,
 * 绝不能因为它让主进程起不来 —— 拿不到矩形就退回"贴屏幕边缘"。
 */

let kernel = null;      // { getRect, available:true } | { available:false, error }
let loaded = false;

function load() {
  if (loaded) return kernel;
  loaded = true;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');

    const RECT = koffi.struct('PORO_RECT', {
      left: 'long', top: 'long', right: 'long', bottom: 'long'
    });
    const EnumWindowsProc = koffi.proto('bool PoroEnumWindowsProc(void *hwnd, intptr_t lParam)');

    const EnumWindows = user32.func('bool EnumWindows(PoroEnumWindowsProc *lpEnumFunc, intptr_t lParam)');
    const IsWindowVisible = user32.func('bool IsWindowVisible(void *hwnd)');
    const IsIconic = user32.func('bool IsIconic(void *hwnd)');
    const GetClassNameA = user32.func('int GetClassNameA(void *hwnd, _Out_ char *buf, int nMaxCount)');
    const GetWindowTextA = user32.func('int GetWindowTextA(void *hwnd, _Out_ char *buf, int nMaxCount)');
    const GetWindowRect = user32.func('bool GetWindowRect(void *hwnd, _Out_ PORO_RECT *rect)');

    // DPI 校准: Electron 主进程是 per-monitor DPI aware, 直接 GetWindowRect 拿到的是**物理像素**,
    // 而 BrowserWindow.setBounds 吃的是 DIP —— 两者在缩放 != 100% 时会差一个倍数。
    // 把当前线程临时切成 UNAWARE, Windows 就会按主屏缩放返回虚拟化坐标, 正好与 Electron 的 DIP 对齐。
    let SetDpi = null, UNAWARE = null;
    try {
      SetDpi = user32.func('void *SetThreadDpiAwarenessContext(void *dpiContext)');
      UNAWARE = -1;   // DPI_AWARENESS_CONTEXT_UNAWARE
    } catch (e) { SetDpi = null; }

    function readStr(fn, hwnd) {
      const buf = koffi.alloc('char', 512);
      const n = fn(hwnd, buf, 512);
      return n ? koffi.decode(buf, 'char', n).split('\0')[0] : '';
    }

    // 找客户端窗口: 可见 + 未最小化 + 类名匹配, 多个时取面积最大的那个。
    // 同时把命中的类名/标题带出来 —— 排查"贴错窗口"时这是唯一能一眼看出问题的信息。
    function findWindow(classNames) {
      let best = null, bestArea = -1;
      EnumWindows(function (hwnd) {
        if (!IsWindowVisible(hwnd)) return true;
        const cls = readStr(GetClassNameA, hwnd);
        if (classNames.indexOf(cls) === -1) return true;
        const r = {};
        if (!GetWindowRect(hwnd, r)) return true;
        const w = r.right - r.left, h = r.bottom - r.top;
        if (w < 200 || h < 50) return true;          // 塌缩/哨兵, 不是真的窗口
        if (IsIconic(hwnd)) return true;             // 最小化: 坐标不可用
        if (w * h > bestArea) {
          bestArea = w * h;
          best = {
            left: r.left, top: r.top, right: r.right, bottom: r.bottom,
            className: cls, title: readStr(GetWindowTextA, hwnd)
          };
        }
        return true;
      }, 0);
      return best;
    }

    function getRectFor(classNames) {
      let saved = null, switched = false;
      if (SetDpi) {
        // 失败也无所谓, 只是退回物理像素 (再由调用方按工作区做边界校正)
        try { saved = SetDpi(UNAWARE); switched = true; } catch (e) { switched = false; }
      }
      try {
        // 优先 RCLIENT —— 选人界面就在这个窗口里。
        // 绝不能把两个类名混在一起按面积挑: 游戏内窗口是全屏的, 一定比客户端大,
        // 实测(用户正在对局时)会把浮窗贴到全屏游戏窗口上, 读到 1707x960 整屏而不是客户端的 1280x720。
        const r = findWindow(classNames);
        if (!r) return null;
        return {
          x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top,
          className: r.className, title: r.title
        };
      } finally {
        if (switched) { try { SetDpi(saved); } catch (e) {} }
      }
    }

    function getRect() { return getRectFor(['RCLIENT']) || getRectFor(['RiotWindowClass']); }
    function getGameRect() { return getRectFor(['RiotWindowClass']); }

    kernel = { available: true, getRect, getGameRect };
  } catch (e) {
    // koffi 没装/不是 Windows/被 EDR 拦了 —— 都走这条路, 静默降级
    kernel = { available: false, getRect: () => null, getGameRect: () => null, error: e && e.message };
  }
  return kernel;
}

/** @returns {{x:number,y:number,width:number,height:number}|null} DIP 坐标; 拿不到返回 null */
function getLeagueClientRect() {
  try { return load().getRect(); } catch (e) { return null; }
}

/** @returns {{x:number,y:number,width:number,height:number}|null} 游戏内窗口 DIP 坐标 */
function getLeagueGameRect() {
  try { return load().getGameRect(); } catch (e) { return null; }
}

function isAvailable() { return !!load().available; }

module.exports = { getLeagueClientRect, getLeagueGameRect, isAvailable, loadError: () => load().error || null };
