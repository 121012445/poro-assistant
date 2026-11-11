'use strict';

// 工具箱的轻量状态层：只读取界面当前值，帮助用户确认哪些自动化正在运行。
(function () {
  const tracked = [
    ['autoAcceptToggle', '自动接受'], ['autoBPToggle', '自动 BP'],
    ['autoRuneToggle', '自动符文'], ['autoHonorToggle', '自动点赞'],
    ['autoReconnectToggle', '自动重连'], ['autoReturnLobbyToggle', '自动回房'],
    ['benchAlertToggle', '备战提醒'], ['pickGuardToggle', '选人保底'],
    ['gameTranslateToggle', '聊天翻译'], ['liveTipsMaster', '对局提示'],
    ['friendNotifyToggle', '好友提醒'], ['gsLockToggle', '锁定设置']
  ];
  const trackedIds = tracked.map(([id]) => id);

  function getElements() {
    return tracked.map(([id, label]) => ({ input: document.getElementById(id), label }))
      .filter(({ input }) => input);
  }

  function escapeText(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function render() {
    const chips = document.getElementById('toolsOverviewChips');
    const summary = document.getElementById('toolsOverviewSummary');
    const dot = document.getElementById('toolsOverviewDot');
    if (!chips || !summary || !dot) return;
    const checked = getElements().filter(({ input }) => input.checked);
    const effectiveIds = new Set((window.getEffectiveAutomationFeatures?.() || []).map(feature => feature.id));
    const active = checked.filter(({ input }) => !window.automationModeAllows || effectiveIds.has(input.id));
    const compliance = document.getElementById('complianceToggle')?.checked;
    chips.innerHTML = active.length
      ? active.map(({ label }) => '<span class="tools-overview-chip">' + escapeText(label) + '</span>').join('')
      : '<span class="tools-overview-empty">暂无自动化运行</span>';
    const mode = window.getAutomationModeContext?.();
    summary.textContent = compliance
      ? '合规模式已开启，写入类功能已停用'
      : `${active.length} 项在${mode?.known ? mode.label : '当前模式'}运行${checked.length > active.length ? `，${checked.length - active.length} 项按模式暂停` : ''}`;
    dot.classList.toggle('is-active', active.length > 0 && !compliance);
    dot.classList.toggle('is-safe', !!compliance);
  }

  window.refreshToolsOverview = render;
  window.getActiveAutomationCount = () => {
    const checked = getElements().filter(({ input }) => input.checked);
    return window.automationModeAllows
      ? checked.filter(({ input }) => window.automationModeAllows(input.id)).length
      : checked.length;
  };
  window.getTrackedAutomationIds = () => trackedIds.slice();
  window.addEventListener('DOMContentLoaded', () => {
    render();
    trackedIds.forEach(id => document.getElementById(id)?.addEventListener('change', render));
    document.getElementById('complianceToggle')?.addEventListener('change', render);
    // Settings and automation modules restore persisted checkboxes after this script's
    // DOMContentLoaded callback, so render again once startup restoration has settled.
    setTimeout(render, 0);
    setTimeout(render, 250);
    setInterval(render, 1000);
  });
})();
