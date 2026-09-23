// 锁定游戏设置 + 自动符文
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 锁定游戏设置 (Seraphine 风格) ==========
let gsAppliedPhase = null;
let gsApplyInFlight = false;
let gsVerifyTimers = [];
function gsLockPath() { return (window._userDataPath || '') + '/gs_lock.json'; }
function getGsCameraMode() {
  const value = storeGet('gsCameraMode');
  return value === '0' || value === '1' ? Number(value) : null;
}

function gsFieldCount(gs) {
  return Object.values(gs || {}).reduce((count, group) => count + (group && typeof group === 'object' ? Object.keys(group).length : 0), 0);
}

async function setGsCameraMode(value) {
  const normalized = value === '0' || value === '1' ? value : '';
  storeSet('gsCameraMode', normalized);
  const lockOn = document.getElementById('gsLockToggle')?.checked;
  if (!lockOn) return;
  try {
    const content = await lolAPI.readFile(gsLockPath());
    const gs = content ? JSON.parse(content) : {};
    if (!gs.General || typeof gs.General !== 'object') gs.General = {};
    if (normalized === '') delete gs.General.CameraMode;
    else gs.General.CameraMode = Number(normalized);
    if (!await lolAPI.writeFile(gsLockPath(), JSON.stringify(gs, null, 2))) throw new Error('设置快照写入失败');
    gsAppliedPhase = null;
    const count = gsFieldCount(gs);
    document.getElementById('gsLockStatus').textContent = `已锁定 ${count} 项`;
    if (normalized !== '' && lcuConnected) await applyLockedGameSettings(window._gameflowPhase || 'manual');
  } catch (e) {
    toolMsg(`<span style="color:var(--negative)">镜头模式保存失败: ${escapeHtml(e.message)}</span>`);
  }
}

async function toggleGsLock(on) {
  if (on && !guardAutomation('锁定游戏设置')) { document.getElementById('gsLockToggle').checked = false; return; }
  document.getElementById("gsLockToggle").checked = on;
  if (on) {
    document.getElementById("gsLockStatus").textContent = "正在保存...";
    try {
      const r = await lolAPI.lcuRequest("GET", "/lol-game-settings/v1/game-settings");
      if (!r || r.__error || !Object.keys(r).length) throw new Error(r?.__error || '客户端未返回游戏设置');
      const gs = { ...r };
      delete gs.HUD;
      const cameraMode = getGsCameraMode();
      if (cameraMode !== null) gs.General = { ...(gs.General || {}), CameraMode: cameraMode };
      const full = await lolAPI.captureFullGameSettings();
      if (!full?.ok) throw new Error(full?.error || '完整游戏设置读取失败');
      const saved = await lolAPI.writeFile(gsLockPath(), JSON.stringify(gs, null, 2));
      if (!saved) throw new Error('设置快照写入失败');
      const fieldCount = gsFieldCount(gs);
      storeSet("gsLockOn", "1");
      gsAppliedPhase = null;
      document.getElementById("gsLockStatus").textContent = `完整锁定 · ${full.fileCount} 文件`;
      toolMsg(`<span style="color:var(--positive)">已保存客户端 ${fieldCount} 项及完整 ${full.fileCount} 个配置文件（约 ${full.settingCount} 个字段）</span>`);
    } catch (e) {
      console.error("保存游戏设置失败:", e);
      storeSet("gsLockOn", "");
      document.getElementById('gsLockToggle').checked = false;
      document.getElementById("gsLockStatus").textContent = "保存失败";
      toolMsg(`<span style="color:var(--negative)">锁定失败: ${escapeHtml(e.message)}</span>`);
    }
  } else {
    gsVerifyTimers.forEach(clearTimeout);
    gsVerifyTimers = [];
    storeSet("gsLockOn", "");
    gsAppliedPhase = null;
    document.getElementById("gsLockStatus").textContent = "未锁定";
    try { await lolAPI.writeFile(gsLockPath(), ""); } catch (e) {}
    try { await lolAPI.clearFullGameSettings(); } catch (e) {}
    toolMsg("已取消锁定");
  }
}

function scheduleLockedGameSettingsVerification(phase) {
  gsVerifyTimers.forEach(clearTimeout);
  gsVerifyTimers = [1800, 6500].map(delay => setTimeout(async () => {
    if (complianceOn || storeGet('gsLockOn') !== '1' || !['ChampSelect', 'GameStart', 'InProgress'].includes(window._gameflowPhase)) return;
    try {
      const check = await lolAPI.verifyFullGameSettings();
      if (check?.mismatchCount > 0) {
        gsAppliedPhase = null;
        try { lolAPI.debugLog(`[GS LOCK] drift=${check.mismatchCount} phase=${phase || ''}; reapplying`); } catch (e) {}
        await applyLockedGameSettings((phase || window._gameflowPhase || 'verify') + ':校验恢复');
      }
    } catch (e) {}
  }, delay));
}

async function applyLockedGameSettings(phase) {
  if (complianceOn) return;
  if (gsApplyInFlight) return;
  gsApplyInFlight = true;
  try {
    const content = await lolAPI.readFile(gsLockPath());
    if (!content) throw new Error('没有找到设置快照，请关闭后重新开启锁定');
    const gs = JSON.parse(content);
    if (!gs || !Object.keys(gs).length) throw new Error('设置快照为空，请重新锁定');
    delete gs.HUD;
    let fullStatus = await lolAPI.fullGameSettingsStatus();
    if (!fullStatus?.exists) {
      fullStatus = await lolAPI.captureFullGameSettings();
      if (!fullStatus?.ok) throw new Error(fullStatus?.error || '完整设置快照创建失败');
    }
    const fullResult = await lolAPI.applyFullGameSettings();
    if (!fullResult?.ok || fullResult.mismatchCount > 0) throw new Error(fullResult?.error || `完整配置仍有 ${fullResult.mismatchCount} 项未恢复`);
    const result = await lolAPI.lcuRequest("PATCH", "/lol-game-settings/v1/game-settings", gs);
    if (!result || result.__error) throw new Error(result?.__error || '客户端未确认设置更新');
    const mismatches = [];
    for (const [group, values] of Object.entries(gs)) {
      if (!values || typeof values !== 'object') continue;
      for (const [key, value] of Object.entries(values)) {
        if (JSON.stringify(result?.[group]?.[key]) !== JSON.stringify(value)) mismatches.push(group + '.' + key);
      }
    }
    if (mismatches.length) throw new Error(`客户端有 ${mismatches.length} 项设置未接受`);
    gsAppliedPhase = phase || window._gameflowPhase || 'manual';
    const status = document.getElementById('gsLockStatus');
    if (status) status.textContent = `完整已应用 · ${PHASE_TEXT[phase] || phase || '当前阶段'}`;
    try { lolAPI.debugLog(`[GS LOCK] applied phase=${phase || ''} apiFields=${gsFieldCount(gs)} files=${fullResult.fileCount} fullFields=${fullResult.settingCount}`); } catch (e) {}
    scheduleLockedGameSettingsVerification(phase);
  } catch (e) {
    console.error("应用锁定设置失败:", e);
    gsAppliedPhase = null;
    const status = document.getElementById('gsLockStatus');
    if (status) status.textContent = "应用失败";
    try { lolAPI.debugLog('[GS LOCK] failed: ' + e.message); } catch (ignored) {}
  } finally {
    gsApplyInFlight = false;
  }
}

async function gsRestore() {
  try {
    const el = document.getElementById("gsLockToggle");
    const status = document.getElementById("gsLockStatus");
    const on = storeGet("gsLockOn") === "1";
    if (el && status) {
      el.checked = on;
      status.textContent = on ? "完整锁定 · 等待触发" : "未锁定";
    }
    const camera = document.getElementById('gsCameraMode');
    let cameraValue = storeGet('gsCameraMode') || '';
    if (!cameraValue && on) {
      const content = await lolAPI.readFile(gsLockPath());
      const saved = content ? JSON.parse(content) : null;
      if (saved?.General?.CameraMode === 0 || saved?.General?.CameraMode === 1) {
        cameraValue = String(saved.General.CameraMode);
        storeSet('gsCameraMode', cameraValue);
      }
    }
    if (camera) camera.value = cameraValue;
  } catch (e) {}
}

// ========== 自动符文 ==========
let autoRuneEnabled = false;
function toggleAutoRune(on) {
  if (on && !guardAutomation('自动符文')) { document.getElementById('autoRuneToggle').checked = false; return; }
  autoRuneEnabled = on;
  storeSet('autoRune', on ? '1' : '');
  document.getElementById('autoRuneStatus').textContent = on ? '已开启' : '未开启';
  document.getElementById('autoRuneStatus').style.color = on ? 'var(--positive)' : '';
}
let _autoRuneAppliedFor = 0;
async function doAutoRune(championId) {
  if (!autoRuneEnabled || !lcuConnected || !championId || complianceOn) return;
  if (_autoRuneAppliedFor === championId) return;
  try {
    const pages = await lolAPI.lcuRequest('GET', '/lol-perks/v1/pages');
    if (!pages || pages.__error || !Array.isArray(pages)) { showToast('自动符文: 获取符文页失败', 'negative'); return; }
    let autoPage = pages.find(p => p.name === 'Auto' && p.isEditable);
    if (!autoPage) autoPage = pages.find(p => p.isEditable);
    if (!autoPage) { showToast('自动符文: 无可用符文页 (请解锁一个符文页)', 'negative'); return; }
    const resp = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/zh_CN/runesReforged.json`);
    if (!resp.ok) { showToast('自动符文: 获取符文数据失败', 'negative'); return; }
    const runes = await resp.json();
    if (!Array.isArray(runes) || !runes.length) { showToast('自动符文: 符文数据异常', 'negative'); return; }
    const styles = runes.map(r => r.id);
    const mainStyleId = styles[championId % styles.length];
    const mainTree = runes.find(r => r.id === mainStyleId);
    if (!mainTree) return;
    const selectedPerks = mainTree.slots.map(slot => slot.runes[0].id);
    const subIdx = (championId + 1) % runes.length;
    const putRes = await lolAPI.lcuRequest('PUT', `/lol-perks/v1/pages/${autoPage.id}`, {
      name: 'Auto',
      primaryStyleId: mainStyleId,
      subStyleId: runes[subIdx].id,
      selectedPerkIds: selectedPerks,
      current: true
    });
    if (putRes && putRes.__error) { showToast('自动符文: 应用失败 ' + putRes.__error, 'negative'); return; }
    _autoRuneAppliedFor = championId;
    const champName = champNumMap[String(championId)]?.name || championId;
    showToast('自动符文已应用: ' + champName, 'positive');
  } catch (e) {
    showToast('自动符文异常: ' + e.message, 'negative');
  }
}
