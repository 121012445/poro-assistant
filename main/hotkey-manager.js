'use strict';

// 自定义热键解析: 把 "Ctrl+F10" 这类组合串解析成
//   · vk/mods  → Win32 轮询用 (GetAsyncKeyState)
//   · accelerator → Electron globalShortcut 用
// 解析失败返回 null, 调用方据此拒绝保存。设计目标: 只允许"游戏用不到"的键位。

const VK = Object.freeze({
  control: 0x11, alt: 0x12, shift: 0x10, meta: 0x5B,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  insert: 0x2D, delete: 0x2E, space: 0x20,
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47, h: 0x48,
  i: 0x49, j: 0x4A, k: 0x4B, l: 0x4C, m: 0x4D, n: 0x4E, o: 0x4F, p: 0x50,
  q: 0x51, r: 0x52, s: 0x53, t: 0x54, u: 0x55, v: 0x56, w: 0x57, x: 0x58,
  y: 0x59, z: 0x5A,
  n0: 0x30, n1: 0x31, n2: 0x32, n3: 0x33, n4: 0x34,
  n5: 0x35, n6: 0x36, n7: 0x37, n8: 0x38, n9: 0x39
});

// 单独按也不影响游戏的安全键 (F 区 / 光标区); 字母数字必须带修饰键
const SOLO_OK = new Set(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  'home', 'end', 'pageup', 'pagedown', 'insert', 'delete']);

const MOD_NAMES = Object.freeze({ ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', win: 'meta', meta: 'meta', cmd: 'meta' });

// 多词键的规范显示名 (VK 表里是小写键名, 展示/accelerator 不能全大写)
const KEY_DISPLAY = Object.freeze({ home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert', delete: 'Delete', space: 'Space' });
const MOD_VK = Object.freeze({ ctrl: VK.control, alt: VK.alt, shift: VK.shift, meta: VK.meta });

function displayName(base) {
  if (/^n[0-9]$/.test(base)) return base.slice(1);
  if (/^[a-z]$/.test(base) || /^f\d+$/.test(base)) return base.toUpperCase();
  return KEY_DISPLAY[base] || base.toUpperCase();
}

// "Ctrl + F10" / "alt+f7" → 标准显示 "Ctrl+F10"
function normalize(combo) {
  const parsed = parse(combo);
  return parsed ? parsed.display : null;
}

function parse(combo) {
  const parts = String(combo || '').split('+').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length < 1 || parts.length > 4) return null;
  const mods = [];
  let base = null;
  for (const part of parts) {
    if (MOD_NAMES[part]) {
      const name = MOD_NAMES[part];
      if (mods.includes(name)) return null;          // Ctrl+Ctrl
      mods.push(name);
      continue;
    }
    if (base) return null;                            // 两个主键
    if (VK[part]) base = part;
    else if (/^[a-z]$/.test(part)) base = part;       // 字母
    else if (/^[0-9]$/.test(part)) base = 'n' + part; // 数字
    else return null;
  }
  if (!base) return null;
  if (!SOLO_OK.has(base) && !mods.length) return null; // 裸字母/数字不许绑
  const display = mods.map(m => ({ ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' }[m]))
    .concat([displayName(base)]).join('+');
  return {
    display,
    vk: VK[base],
    mods: mods.map(m => MOD_VK[m]),
    accelerator: mods.map(m => ({ ctrl: 'Control', alt: 'Alt', shift: 'Shift', meta: 'Super' }[m]))
      .concat([displayName(base)]).join('+')
  };
}

// 键盘事件 (渲染层录制) → 组合串; '' = 缺修饰键 (提示用户); null = 无法表达的键
function fromKeyboardEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const code = String(ev.code || '');
  let base = null;
  if (/^F(1[0-2]?|[1-9])$/.test(code)) base = code.toLowerCase();
  else if (/^Key([A-Z])$/.test(code)) base = RegExp.$1.toLowerCase();
  else if (/^Digit([0-9])$/.test(code)) base = RegExp.$1;
  else if (['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Space'].includes(code)) base = code.toLowerCase();
  if (!base) return null;
  const mods = [];
  if (ev.ctrlKey) mods.push('Ctrl');
  if (ev.altKey) mods.push('Alt');
  if (ev.shiftKey) mods.push('Shift');
  if (ev.metaKey) mods.push('Win');
  if (!SOLO_OK.has(base) && !mods.length) return '';   // 裸字母数字: 让用户加修饰键
  return mods.concat([displayName(base)]).join('+');
}

module.exports = { VK, SOLO_OK, normalize, parse, fromKeyboardEvent };
