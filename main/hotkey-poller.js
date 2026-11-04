'use strict';

// Electron globalShortcut can register successfully while a fullscreen game still
// consumes the key before Chromium receives it.  This fallback reads only the keys
// used by Poro and emits a rising-edge event; it is not a keyboard logger.
// 键位定义: 纯数字 = 单键; { vk, mods } = 组合键 (mods 全部按下才算, 用来躲开游戏占用)。
// F10 是国服客户端的举报键, 聊天输入呼出必须带修饰键 (Ctrl+F10)。
const VK = Object.freeze({ f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, control: 0x11 });
const ACTION_KEYS = Object.freeze({
  f6: VK.f6, f7: VK.f7, f8: VK.f8, f9: VK.f9,
  f10: { vk: VK.f10, mods: [VK.control] }
});

function keyDown(def, isDown) {
  if (typeof def === 'number') return isDown(def);
  if (!def || !isDown(def.vk)) return false;
  return (def.mods || []).every(m => isDown(m));
}

function createPoller(readKey, onHotkey, options) {
  const opts = options || {};
  const keys = opts.keys || ACTION_KEYS;   // 自定义热键时传入 {action: {vk, mods}|vk}
  const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : 25;
  const debounceMs = Number(opts.debounceMs) >= 0 ? Number(opts.debounceMs) : 250;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const setTimer = typeof opts.setIntervalFn === 'function' ? opts.setIntervalFn : setInterval;
  const clearTimer = typeof opts.clearIntervalFn === 'function' ? opts.clearIntervalFn : clearInterval;
  const previous = { f6: false, f7: false, f8: false, f9: false, f10: false };
  const lastFiredAt = { f6: -Infinity, f7: -Infinity, f8: -Infinity, f9: -Infinity, f10: -Infinity };
  let timer = null;

  function isDown(vk) {
    try { return (Number(readKey(vk)) & 0x8000) !== 0; }
    catch (e) { return false; }
  }

  function tick() {
    for (const action of Object.keys(keys)) {
      const pressed = keyDown(keys[action], isDown);
      if (pressed && !previous[action]) {
        const timestamp = now();
        if (timestamp - (lastFiredAt[action] || -Infinity) >= debounceMs) {
          lastFiredAt[action] = timestamp;
          onHotkey(action);
        }
      }
      previous[action] = pressed;
    }
  }

  function start() {
    if (timer !== null) return false;
    timer = setTimer(tick, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (timer === null) return false;
    clearTimer(timer);
    timer = null;
    previous.f6 = previous.f7 = previous.f8 = previous.f9 = previous.f10 = false;
    return true;
  }

  return { start, stop, tick, isRunning: () => timer !== null };
}

function createNativePoller(onHotkey, logger, options) {
  try {
    if (process.platform !== 'win32') throw new Error('Win32 only');
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const getAsyncKeyState = user32.func('short GetAsyncKeyState(int vKey)');
    const poller = createPoller(getAsyncKeyState, onHotkey, options);
    return Object.assign(poller, { available: true, error: null });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (typeof logger === 'function') logger('[HOTKEY POLL] unavailable: ' + message);
    return {
      available: false,
      error: message,
      start: () => false,
      stop: () => false,
      isRunning: () => false
    };
  }
}

module.exports = { VK, createPoller, createNativePoller };
