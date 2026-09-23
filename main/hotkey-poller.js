'use strict';

// Electron globalShortcut can register successfully while a fullscreen game still
// consumes the key before Chromium receives it.  This fallback reads only the four
// keys used by Poro and emits a rising-edge event; it is not a keyboard logger.
const VK = Object.freeze({ f6: 0x75, f7: 0x76, f8: 0x77 });
const ACTION_KEYS = Object.freeze({ f6: VK.f6, f7: VK.f7, f8: VK.f8 });

function createPoller(readKey, onHotkey, options) {
  const opts = options || {};
  const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : 25;
  const debounceMs = Number(opts.debounceMs) >= 0 ? Number(opts.debounceMs) : 250;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const setTimer = typeof opts.setIntervalFn === 'function' ? opts.setIntervalFn : setInterval;
  const clearTimer = typeof opts.clearIntervalFn === 'function' ? opts.clearIntervalFn : clearInterval;
  const previous = { f6: false, f7: false, f8: false };
  const lastFiredAt = { f6: -Infinity, f7: -Infinity, f8: -Infinity };
  let timer = null;

  function isDown(vk) {
    try { return (Number(readKey(vk)) & 0x8000) !== 0; }
    catch (e) { return false; }
  }

  function tick() {
    for (const action of Object.keys(ACTION_KEYS)) {
      const pressed = isDown(ACTION_KEYS[action]);
      if (pressed && !previous[action]) {
        const timestamp = now();
        if (timestamp - lastFiredAt[action] >= debounceMs) {
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
    previous.f6 = previous.f7 = previous.f8 = false;
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
