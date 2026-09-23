'use strict';

let lastDiagnosticsText = '';

function shortIdentity(value) {
  const text = String(value || '');
  return text ? text.slice(0, 6) + '…' + text.slice(-4) : '';
}

async function refreshDiagnostics() {
  const output = document.getElementById('diagnosticsOutput');
  if (output) output.textContent = '诊断中...';
  let lcu = null, logs = [], augmentOverlay = null;
  try { lcu = await lolAPI.lcuStatus(); } catch (error) { lcu = { connected: false, error: error.message }; }
  try { logs = await lolAPI.getRecentLogs(); } catch (error) { logs = ['日志接口失败: ' + error.message]; }
  try { augmentOverlay = await lolAPI.augmentOverlayStatus(); } catch (error) { augmentOverlay = { error: error.message }; }
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
