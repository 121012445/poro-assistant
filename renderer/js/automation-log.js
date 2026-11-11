'use strict';

// Lightweight in-memory activity log shared by automation modules and the
// status center. It intentionally keeps only short, non-sensitive summaries.
const poroAutomationLogEntries = [];
function automationLog(label, state, detail) {
  poroAutomationLogEntries.unshift({
    at: Date.now(), label: String(label || '自动化'), state: String(state || 'info'),
    detail: String(detail || '').slice(0, 160)
  });
  if (poroAutomationLogEntries.length > 20) poroAutomationLogEntries.length = 20;
  if (typeof refreshAutomationLog === 'function') refreshAutomationLog();
}
function automationLogText() {
  const item = poroAutomationLogEntries[0];
  if (!item) return '暂无自动化记录';
  const age = Math.max(0, Math.round((Date.now() - item.at) / 1000));
  return `${item.label} · ${item.state}${item.detail ? ' · ' + item.detail : ''} · ${age}s 前`;
}
function stopPoroAutomation() {
  try { if (typeof cancelAutoReturn === 'function') cancelAutoReturn(); } catch (e) {}
  const calls = [
    ['toggleAutoAccept', false], ['toggleAutoBP', false], ['toggleAutoRune', false],
    ['toggleAutoHonor', false], ['toggleAutoReconnect', false],
    ['toggleAutoReturnLobby', false], ['toggleAutoReturnQueue', false],
    ['togglePickGuard', false], ['toggleGameTranslate', false]
  ];
  for (const [fn, value] of calls) {
    try { if (typeof window[fn] === 'function') window[fn](value); } catch (e) {}
  }
  try { if (typeof liveTipsStopPolling === 'function') liveTipsStopPolling(); } catch (e) {}
  automationLog('全部自动化', '已停止', '用户手动停止');
  if (typeof showToast === 'function') showToast('已停止全部自动化功能', 'positive');
}
function refreshAutomationLog() {
  const node = document.getElementById('automationLogSummary');
  if (node) node.textContent = automationLogText();
}
window.refreshAutomationLog = refreshAutomationLog;
window.automationLog = automationLog;
window.stopPoroAutomation = stopPoroAutomation;
window.addEventListener('DOMContentLoaded', refreshAutomationLog);
