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
    const keys = ['autoAccept', 'autoBPEnabled', 'autoBPHeroes', 'autoBPRules', 'autoRune', 'blacklist', 'encounters', 'playerMarks', 'gsLockOn', 'premadeNotify', 'theme'];
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

async function flushStoreSave() {
  clearTimeout(_storeTimer);
  try { return await lolAPI.writeFile(storePath(), JSON.stringify(_store)); } catch (e) { return false; }
}

async function exportPoroBackup() {
  const result = await lolAPI.exportBackup({ kind: 'poro-backup', version: 1, exportedAt: new Date().toISOString(), store: { ..._store } });
  if (result?.ok) toolMsg('<span style="color:var(--positive)">备份已导出</span>');
  else if (!result?.canceled) toolMsg('<span style="color:var(--negative)">导出失败: ' + escapeHtml(result?.__error || '未知错误') + '</span>');
}

async function importPoroBackup() {
  const result = await lolAPI.importBackup();
  if (result?.canceled) return;
  if (!result?.ok) return toolMsg('<span style="color:var(--negative)">' + escapeHtml(result?.__error || '导入失败') + '</span>');
  const incoming = result.payload?.store;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return toolMsg('<span style="color:var(--negative)">备份内容无效</span>');
  const allowed = new Set(['autoAccept', 'autoBPEnabled', 'autoBPHeroes', 'autoBPRules', 'autoRune', 'blacklist', 'encounters', 'playerMarks', 'gsLockOn', 'premadeNotify', 'theme', 'benchAlert', 'benchOverlay', 'compliance', 'hexDataScope']);
  const sanitized = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!(allowed.has(key) || /^aiReview:[\w.-]{1,80}$/.test(key))) continue;
    if (typeof value !== 'string' || value.length > 500000) continue;
    sanitized[key] = value;
  }
  _store = { ..._store, ...sanitized };
  const saved = await flushStoreSave();
  if (!saved) return toolMsg('<span style="color:var(--negative)">无法写入本地配置</span>');
  toolMsg('<span style="color:var(--positive)">备份已恢复，正在重新载入界面…</span>');
  setTimeout(() => location.reload(), 500);
}

// ========== 配置同步 - 扩展持久化 ==========
function saveConfig() {
  try {
    storeSet('autoAccept', autoAcceptOn ? '1' : '');
    storeSet('autoBPEnabled', autoBPEnabled ? '1' : '');
    storeSet('autoBPHeroes', JSON.stringify(autoBPHeroes));
    storeSet('autoBPRules', JSON.stringify(autoBPRules));
    storeSet('autoRune', autoRuneEnabled ? '1' : '');
    storeSet('blacklist', JSON.stringify(blacklist));
    saveEncounters();
    storeSet('playerMarks', JSON.stringify(playerMarks));
  } catch (e) {}
}
function loadConfig() {
  try {
    if (storeGet('autoAccept') === '1') { autoAcceptOn = true; document.getElementById('autoAcceptToggle').checked = true; }
    if (storeGet('autoBPEnabled') === '1') { autoBPEnabled = true; document.getElementById('autoBPToggle').checked = true; document.getElementById('autoBPStatus').textContent = '已开启'; document.getElementById('autoBPStatus').style.color = 'var(--positive)'; }
    const bpHeroes = storeGet('autoBPHeroes');
    if (bpHeroes) autoBPHeroes = JSON.parse(bpHeroes);
    const bpRules = storeGet('autoBPRules');
    if (bpRules) autoBPRules = { ...autoBPRules, ...JSON.parse(bpRules) };
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
    // 遭遇记录由 loadEncounters 统一迁移和校验，避免这里先按旧格式重复载入。
    const pm = storeGet('playerMarks');
    if (pm) {
      const parsedMarks = JSON.parse(pm);
      playerMarks = Object.fromEntries(Object.entries(parsedMarks || {}).map(([puuid, value]) => [puuid, normalizePlayerMemory(value)]));
    }
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
