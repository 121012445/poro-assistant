// 持久化存储 + 配置同步 + 对局看板增强
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 持久化存储 (userData/poro-config.json, 首次运行自动从 localStorage 迁移) ==========
let _store = {};
let _storeTimer = null;
function storePath() { return (window._userDataPath || '') + '/poro-config.json'; }
async function loadStore() {
  try {
    const c = await lolAPI.readFile(storePath());
    if (c) { _store = JSON.parse(c) || {}; return; }
  } catch (e) {}
  // 迁移: 读取 localStorage 旧数据
  try {
    const keys = ['autoAccept', 'autoBPEnabled', 'autoBPHeroes', 'autoRune', 'blacklist', 'encounters', 'playerMarks', 'gsLockOn', 'premadeNotify', 'theme'];
    for (const k of keys) {
      const v = localStorage.getItem(k);
      if (v !== null && v !== '') _store[k] = v;
    }
    scheduleStoreSave();
  } catch (e) {}
}
function storeGet(k) { return _store[k] !== undefined ? _store[k] : null; }
function storeSet(k, v) { _store[k] = String(v); scheduleStoreSave(); }
function scheduleStoreSave() {
  clearTimeout(_storeTimer);
  _storeTimer = setTimeout(async () => {
    try { await lolAPI.writeFile(storePath(), JSON.stringify(_store)); } catch (e) {}
  }, 400);
}

// ========== 配置同步 - 扩展持久化 ==========
function saveConfig() {
  try {
    storeSet('autoAccept', autoAcceptOn ? '1' : '');
    storeSet('autoBPEnabled', autoBPEnabled ? '1' : '');
    storeSet('autoBPHeroes', JSON.stringify(autoBPHeroes));
    storeSet('autoRune', autoRuneEnabled ? '1' : '');
    storeSet('blacklist', JSON.stringify(blacklist));
    storeSet('encounters', JSON.stringify(encounterMap));
    storeSet('playerMarks', JSON.stringify(playerMarks));
  } catch (e) {}
}
function loadConfig() {
  try {
    if (storeGet('autoAccept') === '1') { autoAcceptOn = true; document.getElementById('autoAcceptToggle').checked = true; }
    if (storeGet('autoBPEnabled') === '1') { autoBPEnabled = true; document.getElementById('autoBPToggle').checked = true; document.getElementById('autoBPStatus').textContent = '已开启'; document.getElementById('autoBPStatus').style.color = 'var(--positive)'; }
    const bpHeroes = storeGet('autoBPHeroes');
    if (bpHeroes) autoBPHeroes = JSON.parse(bpHeroes);
    if (storeGet('autoRune') === '1') { autoRuneEnabled = true; document.getElementById('autoRuneToggle').checked = true; document.getElementById('autoRuneStatus').textContent = '已开启'; document.getElementById('autoRuneStatus').style.color = 'var(--positive)'; }
    if (storeGet('premadeNotify') === '0') { premadeNotifyOn = false; document.getElementById('premadeNotifyToggle').checked = false; document.getElementById('premadeNotifyState').textContent = '已关闭'; }
    if (storeGet('benchAlert') === '1') {
      benchAlertOn = true;
      const bt = document.getElementById('benchAlertToggle');
      if (bt) bt.checked = true;
      const bs = document.getElementById('benchAlertState');
      if (bs) { bs.textContent = '已开启'; bs.style.color = 'var(--positive)'; }
    }
    if (storeGet('benchOverlay') === '1') {
      benchOverlayOn = true;
      const bo = document.getElementById('benchOverlayToggle');
      if (bo) bo.checked = true;
    }
    const bl = storeGet('blacklist');
    if (bl) blacklist = JSON.parse(bl);
    const enc = storeGet('encounters');
    if (enc) Object.assign(encounterMap, JSON.parse(enc));
    const pm = storeGet('playerMarks');
    if (pm) playerMarks = JSON.parse(pm);
    // 新安装默认关闭；保留用户此前明确开启或关闭的选择。
    const complianceStored = storeGet('compliance');
    complianceOn = complianceStored === '1';
    if (complianceStored == null) storeSet('compliance', '0');
    const complianceToggle = document.getElementById('complianceToggle');
    if (complianceToggle) complianceToggle.checked = complianceOn;
    applyComplianceState();
    if (typeof hexDataScope !== 'undefined') {
      hexDataScope = storeGet('hexDataScope') === 'high' ? 'high' : 'all';
      const scopeSelect = document.getElementById('hexScope');
      if (scopeSelect) scopeSelect.value = hexDataScope;
    }
  } catch (e) {}
}

// ========== 对局看板增强 - 连胜连败 + 宿敌 ==========
