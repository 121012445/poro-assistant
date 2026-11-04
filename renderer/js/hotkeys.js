// 工具箱 · 自定义热键: 录制组合键 → 存 poro-config.json → 下发给主进程即时生效。
// 键位数据只有一份真源: main/hotkey-manager.js 负责校验/去重/归一化, 这里只负责采集与展示。
let _hkRecording = null;   // 正在录制的 action

function hkActionList() { return ['f6', 'f7', 'f8', 'f9', 'f10']; }

function hkCurrentCombo(action) {
  const stored = storeGet('hotkey_' + action);
  return stored || { f6: 'F6', f7: 'F7', f8: 'F8', f9: 'F9', f10: 'Ctrl+F10' }[action] || '';
}

function hkRender() {
  for (const action of hkActionList()) {
    const btn = document.getElementById('hk_' + action);
    if (btn && _hkRecording !== action) btn.textContent = hkCurrentCombo(action);
  }
}

// 键盘事件 → "Ctrl+F10" 形式 (与 main/hotkey-manager.fromKeyboardEvent 同规则)
function hkComboFromEvent(ev) {
  const code = String(ev.code || '');
  let base = null;
  if (/^F(1[0-2]?|[1-9])$/.test(code)) base = code;
  else if (/^Key([A-Z])$/.test(code)) base = RegExp.$1;
  else if (/^Digit([0-9])$/.test(code)) base = RegExp.$1;
  else if (['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Space'].includes(code)) base = code;
  if (!base) return null;
  const mods = [];
  if (ev.ctrlKey) mods.push('Ctrl');
  if (ev.altKey) mods.push('Alt');
  if (ev.shiftKey) mods.push('Shift');
  if (ev.metaKey) mods.push('Win');
  const soloOk = /^F\d+$/.test(base) || ['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete'].includes(base);
  if (!soloOk && !mods.length) return '';   // 裸字母/数字: 提示需要修饰键
  return mods.concat([base]).join('+');
}

function hkStartRecord(action) {
  if (_hkRecording) hkCancelRecord();
  _hkRecording = action;
  const btn = document.getElementById('hk_' + action);
  if (btn) { btn.textContent = '按组合键…'; btn.classList.add('hk-recording'); }
  document.addEventListener('keydown', hkCaptureKeydown, true);
}

function hkCancelRecord() {
  if (!_hkRecording) return;
  const btn = document.getElementById('hk_' + _hkRecording);
  if (btn) { btn.classList.remove('hk-recording'); }
  document.removeEventListener('keydown', hkCaptureKeydown, true);
  _hkRecording = null;
  hkRender();
}

async function hkCaptureKeydown(ev) {
  if (!_hkRecording) return;
  ev.preventDefault();
  ev.stopPropagation();
  const action = _hkRecording;
  if (ev.key === 'Escape') { hkCancelRecord(); return; }
  const combo = hkComboFromEvent(ev);
  if (combo === null) return;            // 修饰键单独按 / 不支持的键, 继续等
  if (combo === '') {
    const st = document.getElementById('hkState');
    if (st) st.textContent = '字母和数字必须搭配 Ctrl / Alt / Shift 使用';
    return;
  }
  hkCancelRecord();
  const r = await lolAPI.hotkeySet(action, combo);
  const st = document.getElementById('hkState');
  if (r && r.ok) {
    storeSet('hotkey_' + action, r.display);
    if (st) st.textContent = '已生效: ' + (hkActionLabel(action)) + ' → ' + r.display + ' (下次进对局的热键注册同步更新)';
    hkRender();
  } else {
    if (st) st.textContent = (r && r.error) || '设置失败';
    hkRender();
  }
}

function hkActionLabel(action) {
  const el = document.getElementById('hkLabel_' + action);
  return el ? el.textContent : action;
}

// 启动时把 poro-config.json 里的键位下发给主进程 (loadStore 完成后由 app.js 调用)
async function syncHotkeysToMain() {
  if (!window.lolAPI || !lolAPI.hotkeySet) return;
  for (const action of hkActionList()) {
    const combo = storeGet('hotkey_' + action);
    if (combo) await lolAPI.hotkeySet(action, combo);
  }
  hkRender();
}
