'use strict';

let lastDiagnosticsText = '';

function shortIdentity(value) {
  const text = String(value || '');
  return text ? text.slice(0, 6) + '…' + text.slice(-4) : '';
}

// 提权状态提示。
// 正式版(requireAdministrator)与受限版(asInvoker)共用同一份代码，用户从界面上
// 分不出自己装的是哪个；而受限版会让「游戏内热键」和「聊天预填」失效。
// 不主动说明的话，用户只会看到一个 SendInput 报错，不知道该换包。
function renderElevationNotice(info) {
  const node = document.getElementById('elevationNotice');
  if (!node) return;
  // 判定不了（非 Windows / koffi 不可用）就不显示，不编造状态
  if (!info || info.elevated === null || info.elevated === undefined) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.textContent = info.elevated
    ? '权限：已以管理员身份运行，游戏内热键与聊天预填可用。'
    : '权限：当前未以管理员身份运行（受限版）。游戏内热键与聊天预填不可用 —— '
      + '国服客户端以管理员身份运行，未提权的进程无法向更高权限的进程注入按键。'
      + '需要这两个功能请改用正式版安装包；战绩、档案、实时对局、强化推荐、悬浮层与设置锁定不受影响。';
}

async function refreshElevationNotice() {
  let info = null;
  try { info = await lolAPI.getElevation(); } catch (error) { info = null; }
  renderElevationNotice(info);
  return info;
}

async function refreshDiagnostics() {
  const output = document.getElementById('diagnosticsOutput');
  if (output) output.textContent = '诊断中...';
  let lcu = null, logs = [], augmentOverlay = null, elevation = null;
  try { lcu = await lolAPI.lcuStatus(); } catch (error) { lcu = { connected: false, error: error.message }; }
  try { logs = await lolAPI.getRecentLogs(); } catch (error) { logs = ['日志接口失败: ' + error.message]; }
  try { augmentOverlay = await lolAPI.augmentOverlayStatus(); } catch (error) { augmentOverlay = { error: error.message }; }
  try { elevation = await lolAPI.getElevation(); } catch (error) { elevation = null; }
  renderElevationNotice(elevation);
  const session = window.poroSession?.snapshot() || {};
  const report = {
    generatedAt: new Date().toISOString(),
    appVersion: window.__appVersion || 'unknown',
    ddragonVersion: typeof version === 'string' ? version : '',
    client: {
      connected: !!lcu?.connected,
      websocketConnected: typeof lcuWsConnected === 'function' ? lcuWsConnected() : false,
      error: lcu?.error || '',
      account: shortIdentity(lcu?.summoner?.puuid),
      platformId: session.platformId || (typeof cachedPlatformId === 'string' ? cachedPlatformId : '')
    },
    game: {
      phase: session.phase || window._gameflowPhase || '',
      generation: session.generation ?? '',
      gameId: shortIdentity(session.gameId),
      rosterKnown: !!session.rosterKey,
      championId: session.championId || 0
    },
    home: {
      loaded: typeof homeStatsLoaded === 'boolean' ? homeStatsLoaded : false,
      loading: typeof homeStatsLoading === 'boolean' ? homeStatsLoading : false,
      games: Array.isArray(homeGamesData) ? homeGamesData.length : 0
    },
    performance: window.poroPerf?.summary() || {},
    // elevated=false 说明跑的是受限版：游戏内热键/聊天预填不可用（UIPI 限制），其余功能正常。
    // 排查"热键按了没反应"先看这里，别去翻渲染层代码。
    permission: {
      elevated: elevation ? elevation.elevated : null,
      inputInjectionAvailable: elevation ? elevation.inputInjectionAvailable : null,
      note: 'elevated=false 时游戏内热键与聊天预填不可用（UIPI），其余功能不受影响'
    },
    augmentOverlay: {
      exists: !!augmentOverlay?.exists,
      visible: !!augmentOverlay?.visible,
      candidates: augmentOverlay?.items || 0,
      scale: augmentOverlay?.scale || 1,
      gameRectAvailable: !!augmentOverlay?.gameRectAvailable,
      bounds: augmentOverlay?.bounds || null
    },
    recentLogs: Array.isArray(logs) ? logs : []
  };
  lastDiagnosticsText = JSON.stringify(report, null, 2);
  if (output) output.textContent = lastDiagnosticsText;
  return report;
}

async function copyDiagnostics() {
  if (!lastDiagnosticsText) await refreshDiagnostics();
  const result = await lolAPI.copyText(lastDiagnosticsText);
  showToast(result?.ok === false ? '复制失败' : '诊断信息已复制', result?.ok === false ? 'negative' : 'positive');
}

async function exportDiagnostics() {
  const report = await refreshDiagnostics();
  const result = await lolAPI.exportDiagnostics(report);
  if (result?.canceled) return;
  if (!result || result.__error) {
    showToast(result?.__error || '诊断包导出失败', 'negative');
    return;
  }
  showToast(`诊断包已导出${result.attachments ? `（含 ${result.attachments} 张识别裁图）` : ''}`, 'positive');
}
