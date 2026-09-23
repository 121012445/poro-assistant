'use strict';
/**
 * 用 koffi(预编译 N-API 原生桥, 无需编译器) 枚举顶层窗口, 找出英雄联盟客户端/游戏窗口的
 * 类名与屏幕矩形 —— 这是"浮窗贴客户端边缘"的前置数据。
 *
 * 只读, 不发送任何输入, 不影响游戏。
 *
 *   node _debug_archive/probe_client_window.js
 *
 * 输出同时写到 _debug_archive/probe_client_window.txt:
 * 本环境的 shell 重定向偶尔会吞掉 stdout, 落盘才靠得住。
 */
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');

const lines = [];
function log(s) { lines.push(s); console.log(s); }

const user32 = koffi.load('user32.dll');

const RECT = koffi.struct('RECT', {
  left: 'long', top: 'long', right: 'long', bottom: 'long'
});

const EnumWindowsProc = koffi.proto('bool EnumWindowsProc(void *hwnd, intptr_t lParam)');
const EnumWindows = user32.func('bool EnumWindows(EnumWindowsProc *lpEnumFunc, intptr_t lParam)');
const IsWindowVisible = user32.func('bool IsWindowVisible(void *hwnd)');
const GetClassNameA = user32.func('int GetClassNameA(void *hwnd, _Out_ char *buf, int nMaxCount)');
const GetWindowTextA = user32.func('int GetWindowTextA(void *hwnd, _Out_ char *buf, int nMaxCount)');
const GetWindowRect = user32.func('bool GetWindowRect(void *hwnd, _Out_ RECT *rect)');
const IsIconic = user32.func('bool IsIconic(void *hwnd)');

function readStr(fn, hwnd) {
  const buf = koffi.alloc('char', 512);
  const n = fn(hwnd, buf, 512);
  if (!n) return '';
  return koffi.decode(buf, 'char', n).split('\0')[0];
}

const all = [];
const interesting = [];

EnumWindows(function (hwnd, lParam) {
  if (!IsWindowVisible(hwnd)) return true;
  const cls = readStr(GetClassNameA, hwnd);
  const title = readStr(GetWindowTextA, hwnd);
  const r = {};
  const ok = GetWindowRect(hwnd, r);
  const rect = ok ? { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top } : null;
  const rec = { cls: cls, title: title, rect: rect, iconic: IsIconic(hwnd) };
  all.push(rec);
  if (/riot|league|rclient/i.test(cls) || /league|英雄联盟/i.test(title)) interesting.push(rec);
  return true;
}, 0);

log('可见顶层窗口总数: ' + all.length);
log('');
log('=== 英雄联盟相关窗口 (类名或标题命中) ===');
if (!interesting.length) log('  (无) —— 客户端/游戏可能没在运行');
for (const r of interesting) {
  log('  类名=' + JSON.stringify(r.cls) + '  标题=' + JSON.stringify(r.title) +
    '  rect=' + (r.rect ? JSON.stringify(r.rect) : '(读取失败)') +
    (r.iconic ? '  [已最小化]' : ''));
  if (r.rect && r.rect.w < 200 && r.rect.h < 50) log('    ^ 注意: 这是最小化时的哨兵坐标, 必须判掉');
}
log('');
log('提示: 选人界面属于 RCLIENT 主窗; RiotWindowClass 是游戏内窗口(只在进游戏后出现, 且通常是全屏)。');

log('');
log('=== 带标题的可见窗口 (前 25 个, 便于人工辨认) ===');
let shown = 0;
for (const r of all) {
  if (!r.title) continue;
  log('  ' + JSON.stringify(r.cls) + '  ' + JSON.stringify(r.title.slice(0, 60)) +
    '  ' + (r.rect ? JSON.stringify(r.rect) : '?'));
  if (++shown >= 25) break;
}

// win-rect.js 的结论也要一并记下: 它才是产品实际用的那条路径
try {
  const winRect = require('../main/win-rect');
  log('');
  log('=== win-rect.js 实际选中的窗口 ===');
  log('  ' + JSON.stringify(winRect.getLeagueClientRect()));
} catch (e) {
  log('win-rect.js 读取失败: ' + e.message);
}

fs.writeFileSync(path.join(__dirname, 'probe_client_window.txt'), lines.join('\n') + '\n', 'utf8');
