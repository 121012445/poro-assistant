// 持久化存储 + 配置同步 + 对局看板增强
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 持久化存储 (userData/poro-config.json, 首次运行自动从 localStorage 迁移) ==========
let _store = {};
let _storeTimer = null;
let _storeWriteFailedNotified = false;
function storePath() { return (window._userDataPath || '') + '/poro-config.json'; }
async function loadStore() {
  let content = null;
  try { content = await lolAPI.readFile(storePath()); } catch (e) {}
  if (content) {
    let parsed = null;
    try { parsed = JSON.parse(content); } catch (e) {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { _store = parsed; return; }
    // 解析失败/结构不对: 先把原始内容备份, 再降级为空 —— 否则随后的任何一次
    // 保存都会把用户的黑名单、玩家档案、符文记忆整体覆盖掉且不可恢复。
    try { await lolAPI.writeFile(storePath() + '.bak', content); } catch (e) {}
    if (typeof toolMsg === 'function') {
      toolMsg('<span style="color:var(--warning)">配置文件损坏，已备份为 poro-config.json.bak 并重置。</span>');
    }
  }
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
function showStoreWriteError() {
  if (_storeWriteFailedNotified || typeof toolMsg !== 'function') return;
  _storeWriteFailedNotified = true;
  toolMsg('<span style="color:var(--negative)">配置写入失败，本次设置在重启后可能丢失。</span>');
}
function scheduleStoreSave() {
  clearTimeout(_storeTimer);
  _storeTimer = setTimeout(async () => {
    try { await lolAPI.writeFile(storePath(), JSON.stringify(_store)); }
    catch (e) { showStoreWriteError(); }
  }, 400);
}

async function flushStoreSave() {
  clearTimeout(_storeTimer);
  try { return await lolAPI.writeFile(storePath(), JSON.stringify(_store)); }
  catch (e) { showStoreWriteError(); return false; }
}

// 关窗前若还有未落盘的防抖保存, 立即补发一次 (fire-and-forget, 不阻塞卸载)。
window.addEventListener('beforeunload', () => {
  if (!_storeTimer) return;
  clearTimeout(_storeTimer);
  try { lolAPI.writeFile(storePath(), JSON.stringify(_store)); } catch (e) {}
});

// 单键安全解析: 一个键损坏只回退到默认值, 不再中断其后所有设置的恢复。
function safeParseStore(key, fallback, validate) {
  const raw = storeGet(key);
  if (raw == null) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (validate && !validate(parsed)) return fallback;
    return parsed;
  } catch (e) { return fallback; }
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
  // 导出侧是整个 _store, 导入白名单必须与实际写入的键保持一致,
  // 否则换机导入后这些设置会静默回默认。
  const allowed = new Set([
    'autoAccept', 'autoBPEnabled', 'autoBPHeroes', 'autoBPRules', 'autoRune',
    'blacklist', 'encounters', 'playerMarks', 'gsLockOn', 'premadeNotify', 'theme',
    'augmentJournal', 'autoHonor', 'autoReconnect', 'autoReturnLobby', 'autoReturnQueue',
    'benchAlert', 'benchOverlay', 'chatLock', 'chatLockValue', 'chatStatusMessage',
    'compliance', 'gsCameraMode', 'hexDataScope', 'includePractice', 'opggLoadout',
    'sideAnnounce', 'uiTheme', 'navCollapsed'
  ]);
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
    autoBPHeroes = safeParseStore('autoBPHeroes', autoBPHeroes, v => v && typeof v === 'object' && Array.isArray(v.ban) && Array.isArray(v.pick));
    autoBPRules = { ...autoBPRules, ...safeParseStore('autoBPRules', {}, v => v && typeof v === 'object' && !Array.isArray(v)) };
    if (storeGet('autoRune') === '1') { autoRuneEnabled = true; document.getElementById('autoRuneToggle').checked = true; document.getElementById('autoRuneStatus').textContent = '已开启'; document.getElementById('autoRuneStatus').style.color = 'var(--positive)'; }
    if (typeof restoreOpggLoadoutOptions === 'function') restoreOpggLoadoutOptions();
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
    blacklist = safeParseStore('blacklist', blacklist, Array.isArray);
    // 遭遇记录由 loadEncounters 统一迁移和校验，避免这里先按旧格式重复载入。
    const parsedMarks = safeParseStore('playerMarks', null, v => v && typeof v === 'object' && !Array.isArray(v));
    if (parsedMarks) {
      playerMarks = Object.fromEntries(Object.entries(parsedMarks).map(([puuid, value]) => [puuid, normalizePlayerMemory(value)]));
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
