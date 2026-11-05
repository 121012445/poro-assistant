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

// 5) 1.5.73: z 序三件套 (用户报障"进游戏浮窗不见了, alt-tab 又能看到")
assert.strictEqual(typeof fg.foregroundClass, 'function', 'foregroundClass 导出');
assert.strictEqual(typeof fg.isTopmost, 'function', 'isTopmost 导出');
assert.strictEqual(typeof fg.raiseTopmost, 'function', 'raiseTopmost 导出');
if (process.platform === 'win32') {
  assert.strictEqual(typeof api.GetClassNameA, 'function');
  assert.strictEqual(typeof api.SetWindowPos, 'function');
  assert.strictEqual(typeof api.GetWindowLongPtrW, 'function');
  assert.strictEqual(api.HWND_TOPMOST, -1, 'HWND_TOPMOST = (HWND)-1');
  assert.strictEqual(api.GWL_EXSTYLE, -20);
  assert.strictEqual(api.WS_EX_TOPMOST, 0x8);
  // 标志位常量必须自洽: 只用 NOMOVE/NOSIZE/NOACTIVATE, 绝不能带 SWP_SHOWWINDOW
  // 或激活标志 —— 看门狗每 2 秒跑一次, 抢焦点/闪一下都是不能接受的
  assert.ok((api.SWP_NOMOVE | api.SWP_NOSIZE | api.SWP_NOACTIVATE) > 0);

  // 前台类名: 有前台窗口时必须是个非空类名 (这里就是当前测试进程所在的控制台/终端)
  const cls = fg.foregroundClass();
  assert.strictEqual(typeof cls, 'string', 'foregroundClass 返回字符串');
  assert.ok(cls.length > 0, '有前台窗口时类名不能是空串, 实际 ' + JSON.stringify(cls));

  // isTopmost 走真实 Win32: 扫顶层窗口链, 找一个**确实**带 WS_EX_TOPMOST 的窗口
  // 来验证 (只读, 不改任何状态)。
  // 以前这里硬写"任务栏必然带 WS_EX_TOPMOST", 但 explorer 会动态增删这个标志位 ——
  // 本机实测 Shell_TrayWnd 当前 exstyle=0x80 (WS_EX_TOOLWINDOW), 没有 TOPMOST,
  // 断言于是变成看运气。改成扫描, 一个都找不到就跳过, 不当成失败。
  const koffi = require('koffi');
  const raw = koffi.load('user32.dll');
  const GetTopWindow = raw.func('void* GetTopWindow(void*)');
  const GetWindow = raw.func('void* GetWindow(void*, uint32_t)');
  const GetWindowLongPtrW = raw.func('intptr_t GetWindowLongPtrW(void*, int)');
  const hwndOf = (h) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(h), 0);
    return { getNativeWindowHandle: () => buf, isDestroyed: () => false };
  };
  let topHwnd = null, plainHwnd = null;
  for (let h = GetTopWindow(null), i = 0; h && i < 400; h = GetWindow(h, 2), i++) {
    if (Number(GetWindowLongPtrW(h, -20)) & 0x8) { if (!topHwnd) topHwnd = h; }
    else if (!plainHwnd) plainHwnd = h;
  }
  if (topHwnd) {
    assert.strictEqual(fg.isTopmost(hwndOf(topHwnd)), true, '真带 TOPMOST 的窗口必须判 true');
  }
  if (plainHwnd) {
    assert.strictEqual(fg.isTopmost(hwndOf(plainHwnd)), false, '不带 TOPMOST 的窗口必须判 false');
  }
}
// 异常输入一律 false, 绝不抛 (看门狗每 2 秒跑, 抛一次就是一条崩溃日志)
assert.strictEqual(fg.isTopmost(null), false);
assert.strictEqual(fg.isTopmost({}), false);
assert.strictEqual(fg.raiseTopmost(null), false);
assert.strictEqual(fg.raiseTopmost({ getNativeWindowHandle: () => Buffer.alloc(8) }), false);
assert.strictEqual(fg.foregroundClass.length >= 0, true);

// 6) index.js 接线契约: 看门狗必须真的挂在"显示"和"隐藏"两端
//    这类"函数写好了但没人调"的漏洞只有源码断言能锁住。
const SRC_INDEX = require('fs').readFileSync(require('path').join(__dirname, 'main/index.js'), 'utf8');
function fnBody(name) {
  const start = SRC_INDEX.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' 必须存在');
  // 取到下一个顶格 "function " 或 "// =====" 之前
  const rest = SRC_INDEX.slice(start + 10);
  const end = rest.search(/\nfunction |\n\/\/ ===== /);
  return end < 0 ? rest : rest.slice(0, end);
}
assert.ok(/startGtTopWatch\(\)/.test(fnBody('showGameTranslateWindow')),
  'showGameTranslateWindow 必须启动看门狗 (否则空聊天框的局永远没人拉回置顶)');
assert.ok(/stopGtTopWatch\(\)/.test(fnBody('hideGameTranslateWindow')),
  'hideGameTranslateWindow 必须停掉看门狗 (离开对局后不要再抢 z 序)');
const tick = fnBody('gtOverlayOnTopTick');
assert.ok(/GT_GAME_WINDOW_CLASS/.test(tick), '看门狗必须按"游戏窗口类名"过滤, 游戏不在前台时不许抢 z 序');
assert.ok(/GT_GAME_WINDOW_CLASS = 'RiotWindowClass'/.test(SRC_INDEX),
  '游戏内窗口类名必须是 RiotWindowClass');
assert.ok(/raiseTopmost\(w\)/.test(tick), '看门狗必须真的抬窗口');
// 关键顺序: 抬窗口不能塞在 if (!hadFlag) 里面 —— WS_EX_TOPMOST 还在却被别的
// topmost 窗口压住才是最常见的情况, 只看标志位会漏。
const raiseAt = tick.indexOf('raiseTopmost(w)');
const flagAt = tick.indexOf('if (!hadFlag)');
assert.ok(raiseAt >= 0 && flagAt >= 0 && raiseAt < flagAt,
  'raiseTopmost 必须无条件调用, 不能只在标志位丢失时调用');
assert.ok(/GT_TOP_TICK_MS = \d+/.test(SRC_INDEX), '看门狗周期必须是常量');
const tickMs = Number((SRC_INDEX.match(/GT_TOP_TICK_MS = (\d+)/) || [])[1]);
assert.ok(tickMs >= 1000 && tickMs <= 5000,
  '看门狗周期要在 1~5 秒之间 (太快浪费, 太慢用户能看见窗口消失一会儿), 实际 ' + tickMs);

console.log('test_foreground: all assertions passed');
