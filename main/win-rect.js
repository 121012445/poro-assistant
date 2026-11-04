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

// 多显示器且缩放比例不同时的坐标换算 (由 index.js 在 app ready 后注入 Electron screen)。
//
// 原做法把线程切成 DPI UNAWARE, 让 Windows 按"系统 DPI" (登录时主显示器的缩放) 虚拟化坐标。单显示器、
// 或各显示器缩放一致时, 这正好等于 Electron 的 DIP。但缩放不一致时 (例如主屏 150%、副屏 100%),
// 副屏上的窗口也会按 150% 缩小: 1920 宽的游戏窗口读成 1280 —— 强化卡截图按它裁剪就裁错位置、
// 浮窗也贴不到游戏边上。此时改为直接读物理像素 (Electron 主进程是 per-monitor aware),
// 再用 screen.screenToDipRect 按窗口所在显示器换算。缩放一致时仍走原路径, 行为不变。
let dpiCfg = null;      // { mixedDpi: () => boolean, screenToDip: rect => rect }
function configureDpi(cfg) {
  dpiCfg = cfg && typeof cfg.mixedDpi === 'function' && typeof cfg.screenToDip === 'function' ? cfg : null;
}
function usePhysicalPath() {
  if (!dpiCfg) return false;
  try { return !!dpiCfg.mixedDpi(); } catch (e) { return false; }
}
// 物理像素矩形 → DIP; 换算失败返回 null, 调用方退回原路径
function physicalToDip(rect) {
  try {
    const r = dpiCfg && dpiCfg.screenToDip({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) return null;
    return Object.assign({}, rect, { x: r.x, y: r.y, width: r.width, height: r.height });
  } catch (e) { return null; }
}

function load() {
  if (loaded) return kernel;
  loaded = true;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const GetLastError = kernel32.func('uint32 GetLastError()');
    // SetWindowPos 前清零: 它失败时 GetLastError 才有意义, 否则可能读到上一次的脏值
    const SetLastError = kernel32.func('void SetLastError(uint32 code)');

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
    // 窗口修复用 (复活/居中). 只在 setClientBounds 里调用, 读矩形路径不碰它们。
    const SetWindowPos = user32.func('bool SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, unsigned int flags)');
    const ShowWindow = user32.func('bool ShowWindow(void *hwnd, int cmd)');
    const IsZoomed = user32.func('bool IsZoomed(void *hwnd)');
    const SW_RESTORE = 9;
    const SWP_NOZORDER = 0x0004;
    const SWP_NOACTIVATE = 0x0010;

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

    // 找客户端窗口: 类名匹配 (可选标题兜底), 多个时"可见优先、面积其次"。
    // 同时把命中的类名/标题带出来 —— 排查"贴错窗口"时这是唯一能一眼看出问题的信息。
    //
    // relaxed=true 用于"修复窗口": 窗口被最小化或拖到别的显示器时也要能抓到,
    // 所以不筛可见性/最小化。135x37 那种辅助窗靠面积下限排除, 这条不能放宽。
    //
    // titleRe: 类名找不到时的兜底 (客户端有时被某些插件改了窗口类名)。
    // 只用于修复, 且调用方必须给**精确**标题正则 —— 游戏内窗口叫
    // "League of Legends (TM) Client", 用 /League of Legends/ 会误抓全屏游戏窗。
    function findWindow(classNames, relaxed, titleRe) {
      let best = null, bestRank = -1;
      EnumWindows(function (hwnd) {
        const cls = readStr(GetClassNameA, hwnd);
        let title = null;
        let match = classNames.indexOf(cls) !== -1;
        if (!match) {
          if (!titleRe) return true;
          title = readStr(GetWindowTextA, hwnd);
          match = titleRe.test(title);
          if (!match) return true;
        }
        if (!relaxed && !IsWindowVisible(hwnd)) return true;
        const r = {};
        if (!GetWindowRect(hwnd, r)) return true;
        const w = r.right - r.left, h = r.bottom - r.top;
        const iconic = !!IsIconic(hwnd);
        // 最小化窗口的 rect 常被系统改成 -32000 或 0 尺寸, 修复时同样要收下 ——
        // 反正后面会先 SW_RESTORE, 尺寸由调用方重新指定。
        const tiny = w < 200 || h < 50;
        if (tiny && !(relaxed && iconic)) return true;
        if (!relaxed && iconic) return true;
        const visible = !!IsWindowVisible(hwnd);
        const rank = (visible ? 1e12 : 0) + Math.max(0, w) * Math.max(0, h);
        if (rank > bestRank) {
          bestRank = rank;
          best = {
            hwnd,
            left: r.left, top: r.top, right: r.right, bottom: r.bottom,
            className: cls, title: title === null ? readStr(GetWindowTextA, hwnd) : title
          };
        }
        return true;
      }, 0);
      return best;
    }

    // 自查用: 把当前所有"像客户端"的窗口列出来 (类名/标题命中即可, 不限尺寸)。
    // 只在修复失败时调用, 平时不跑 —— 对每个顶层窗口读标题是有成本的。
    const CLIENT_TITLE_RE = /^League of Legends$/i;
    function enumerateCandidates() {
      const out = [];
      EnumWindows(function (hwnd) {
        const cls = readStr(GetClassNameA, hwnd);
        const title = readStr(GetWindowTextA, hwnd);
        const byClass = cls === 'RCLIENT' || cls === 'RiotWindowClass';
        if (!byClass && !CLIENT_TITLE_RE.test(title)) return true;
        const r = {};
        const got = !!GetWindowRect(hwnd, r);
        out.push({
          className: cls,
          title,
          x: got ? r.left : 0,
          y: got ? r.top : 0,
          width: got ? r.right - r.left : 0,
          height: got ? r.bottom - r.top : 0,
          visible: !!IsWindowVisible(hwnd),
          iconic: !!IsIconic(hwnd)
        });
        return true;
      }, 0);
      return out;
    }

    function getRectFor(classNames) {
      if (usePhysicalPath()) {
        const raw = readRect(classNames);
        const dip = raw && physicalToDip(raw);
        if (dip) return dip;
        // 换算失败: 落到下面的原路径
      }
      let saved = null, switched = false;
      if (SetDpi) {
        // 失败也无所谓, 只是退回物理像素 (再由调用方按工作区做边界校正)
        try { saved = SetDpi(UNAWARE); switched = true; } catch (e) { switched = false; }
      }
      try {
        return readRect(classNames);
      } finally {
        if (switched) { try { SetDpi(saved); } catch (e) {} }
      }
    }

    // 优先 RCLIENT —— 选人界面就在这个窗口里。
    // 绝不能把两个类名混在一起按面积挑: 游戏内窗口是全屏的, 一定比客户端大,
    // 实测(用户正在对局时)会把浮窗贴到全屏游戏窗口上, 读到 1707x960 整屏而不是客户端的 1280x720。
    function readRect(classNames) {
      const r = findWindow(classNames);
      if (!r) return null;
      return {
        x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top,
        className: r.className, title: r.title
      };
    }

    function getRect() { return getRectFor(['RCLIENT']) || getRectFor(['RiotWindowClass']); }
    function getGameRect() { return getRectFor(['RiotWindowClass']); }

    // 修复客户端窗口: 恢复到指定 DIP 矩形 (居中 + 指定尺寸)。
    //
    // 类名顺序必须与读取一致: 国服客户端主窗的类名是 **RCLIENT**, 而 RiotWindowClass
    // 只在进游戏后才存在。旧实现 (lcu.fixLCUWindow) 用 PowerShell FindWindow 只查
    // RiotWindowClass, 于是对局外永远返回 NOT_FOUND —— 就是"未找到客户端窗口"的来源。
    //
    // 坐标按 DIP 处理: 与 readRect 一样把线程切成 UNAWARE, 让 SetWindowPos 与
    // GetWindowRect 处在同一坐标系 (否则缩放 150% 时会偏一倍)。
    function setClientBounds(rect) {
      const x = Math.round(Number(rect && rect.x));
      const y = Math.round(Number(rect && rect.y));
      const w = Math.round(Number(rect && rect.width));
      const h = Math.round(Number(rect && rect.height));
      if (![x, y, w, h].every(Number.isFinite) || w < 200 || h < 150) return null;

      let saved = null, switched = false;
      if (SetDpi) { try { saved = SetDpi(UNAWARE); switched = true; } catch (e) { switched = false; } }
      try {
        const hit = findWindow(['RCLIENT'], true)
          || findWindow(['RiotWindowClass'], true)
          || findWindow([], true, CLIENT_TITLE_RE);
        if (!hit) {
          return { ok: false, reason: 'not-found', candidates: enumerateCandidates() };
        }
        const before = { x: hit.left, y: hit.top, width: hit.right - hit.left, height: hit.bottom - hit.top };
        // 最大化/最小化状态下 SetWindowPos 改不动尺寸, 先还原成普通窗口
        try { if (IsZoomed(hit.hwnd) || IsIconic(hit.hwnd)) ShowWindow(hit.hwnd, SW_RESTORE); } catch (e) {}
        try { SetLastError(0); } catch (e) {}
        const ok = SetWindowPos(hit.hwnd, null, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
        if (!ok) {
          // 客户端进程是 High 完整性 (管理员启动), Poro 也必须是管理员才能改它的窗口,
          // 否则这里拿到 5=拒绝访问。把错误码带出去, 上层才能说实话而不是"找不到窗口"。
          let err = 0;
          try { err = GetLastError(); } catch (e) {}
          return { ok: false, reason: 'denied', err, className: hit.className, title: hit.title, before };
        }
        const r = {};
        const after = GetWindowRect(hit.hwnd, r)
          ? { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }
          : null;
        return { ok: true, className: hit.className, title: hit.title, before, after };
      } finally {
        if (switched) { try { SetDpi(saved); } catch (e) {} }
      }
    }

    // 自查: 当前枚举到的候选窗口 (失败时上报给前端, 免去"到底为什么找不到"的瞎猜)
    function diagnose() { return { candidates: enumerateCandidates() }; }

    kernel = { available: true, getRect, getGameRect, setClientBounds, diagnose };
  } catch (e) {
    // koffi 没装/不是 Windows/被 EDR 拦了 —— 都走这条路, 静默降级
    kernel = {
      available: false,
      getRect: () => null,
      getGameRect: () => null,
      setClientBounds: () => ({ ok: false, reason: 'unavailable', error: e && e.message }),
      diagnose: () => ({ candidates: [] }),
      error: e && e.message
    };
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

/**
 * 把客户端窗口恢复到指定 DIP 矩形 (居中修复)。
 * @returns {{ok:boolean,reason?:string,err?:number,className?:string,before?:object,after?:object}|null}
 *   null 只在入参非法 (矩形不完整) 时返回; 找不到窗口返回 {ok:false,reason:'not-found',candidates}
 */
function setClientBounds(rect) {
  try { return load().setClientBounds(rect); } catch (e) { return { ok: false, reason: 'error', error: String((e && e.message) || e) }; }
}

/** 自查: 当前系统里枚举到的"像客户端"的窗口 */
function diagnose() {
  try { return load().diagnose(); } catch (e) { return { candidates: [], error: String((e && e.message) || e) }; }
}

module.exports = {
  getLeagueClientRect, getLeagueGameRect, isAvailable, setClientBounds, diagnose, configureDpi,
  loadError: () => load().error || null,
  _internals: { usePhysicalPath, physicalToDip }
};
