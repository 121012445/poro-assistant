'use strict';

// 自动化模式策略：总开关仍归各功能自己管理，本模块只回答“当前模式是否生效”。
// 工具箱、状态中心和实际执行入口共用同一份配置，避免 UI 显示运行但功能被另一套规则拦截。
(function () {
  const MODES = [
    { key: 'rift', label: '峡谷' },
    { key: 'aram', label: '大乱斗 / 海斗' },
    { key: 'fun', label: '娱乐模式' },
    { key: 'training', label: '人机 / 训练' }
  ];
  const FEATURES = [
    { id: 'autoAcceptToggle', label: '自动接受' },
    { id: 'autoBPToggle', label: '自动 BP' },
    { id: 'autoRuneToggle', label: '符文与出装' },
    { id: 'pickGuardToggle', label: '选人保底' },
    { id: 'autoHonorToggle', label: '自动点赞' },
    { id: 'autoReconnectToggle', label: '自动重连' },
    { id: 'autoReturnLobbyToggle', label: '自动回房' },
    { id: 'liveTipsMaster', label: '对局提示' }
  ];
  const DEFAULTS = Object.fromEntries(FEATURES.map(feature => [feature.id, Object.fromEntries(MODES.map(mode => [mode.key, true]))]));
  let rules = DEFAULTS;
  let context = { queueId: 0, gameMode: '', key: 'rift', label: '峡谷', known: false };

  function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }

  function classify(queueId, gameMode) {
    const queue = Number(queueId) || 0;
    const mode = String(gameMode || '').toUpperCase();
    if ([450, 2400].includes(queue) || /ARAM|KIWI|JADE|MAYHEM/.test(mode)) return 'aram';
    if ([830, 840, 850, 870, 880, 890, 1090, 4320].includes(queue) || /PRACTICE|TUTORIAL|BOT/.test(mode)) return 'training';
    if ([0, 400, 420, 430, 440, 490].includes(queue) || /CLASSIC/.test(mode)) return 'rift';
    return queue || mode ? 'fun' : 'rift';
  }

  function load() {
    const base = cloneDefaults();
    try {
      const raw = typeof storeGet === 'function' ? storeGet('automationModeMatrix') : localStorage.getItem('automationModeMatrix');
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === 'object') {
        for (const feature of FEATURES) for (const mode of MODES) {
          if (typeof saved?.[feature.id]?.[mode.key] === 'boolean') base[feature.id][mode.key] = saved[feature.id][mode.key];
        }
      }
    } catch (e) {}
    rules = base;
  }

  function save() {
    const value = JSON.stringify(rules);
    if (typeof storeSet === 'function') storeSet('automationModeMatrix', value);
    else try { localStorage.setItem('automationModeMatrix', value); } catch (e) {}
  }

  function allows(featureId, queueId, gameMode) {
    const key = queueId != null || gameMode != null ? classify(queueId, gameMode) : context.key;
    return rules?.[featureId]?.[key] !== false;
  }

  function updateContext(queueId, gameMode) {
    const key = classify(queueId, gameMode);
    context = {
      queueId: Number(queueId) || 0,
      gameMode: String(gameMode || ''),
      key,
      label: MODES.find(mode => mode.key === key)?.label || '未知模式',
      known: !!(Number(queueId) || gameMode)
    };
    render();
    window.refreshToolsOverview?.();
    window.refreshStatusCenter?.();
  }

  let contextRefreshAt = 0;
  async function refreshContext() {
    if (Date.now() - contextRefreshAt < 1500) return context;
    contextRefreshAt = Date.now();
    try {
      const flow = await lolAPI.lcuRequest('GET', '/lol-gameflow/v1/session');
      const queueId = flow?.gameData?.queue?.id || flow?.gameData?.queueId || 0;
      const gameMode = flow?.gameData?.queue?.gameMode || flow?.map?.gameMode || '';
      if (queueId || gameMode) updateContext(queueId, gameMode);
    } catch (e) {}
    return context;
  }

  function effectiveFeatures() {
    return FEATURES.filter(feature => document.getElementById(feature.id)?.checked && allows(feature.id));
  }

  function render() {
    const root = document.getElementById('automationModeMatrix');
    const summary = document.getElementById('automationModeSummary');
    if (!root) return;
    if (summary) {
      const active = effectiveFeatures().length;
      summary.textContent = `${context.known ? context.label : '尚未识别模式'} · ${active} 项在当前模式生效`;
    }
    root.innerHTML = `<div class="automation-matrix-head"><span>功能</span>${MODES.map(mode => `<span class="${mode.key === context.key ? 'is-current' : ''}">${mode.label}</span>`).join('')}</div>` +
      FEATURES.map(feature => `<div class="automation-matrix-row"><b>${feature.label}</b>${MODES.map(mode => `<label class="${mode.key === context.key ? 'is-current' : ''}" title="${feature.label}在${mode.label}中生效"><input type="checkbox" data-feature="${feature.id}" data-mode="${mode.key}"${rules[feature.id][mode.key] ? ' checked' : ''}><span></span></label>`).join('')}</div>`).join('');
    root.querySelectorAll('input[data-feature]').forEach(input => input.addEventListener('change', () => {
      rules[input.dataset.feature][input.dataset.mode] = input.checked;
      save();
      render();
      window.refreshToolsOverview?.();
      window.refreshStatusCenter?.();
    }));
  }

  window.automationModeAllows = allows;
  window.updateAutomationModeContext = updateContext;
  window.refreshAutomationModeContext = refreshContext;
  window.getAutomationModeContext = () => ({ ...context });
  window.getEffectiveAutomationFeatures = effectiveFeatures;
  window.renderAutomationModeMatrix = render;
  window.reloadAutomationModeMatrix = () => { load(); render(); };
  if (typeof window?.addEventListener === 'function') {
    window.addEventListener('DOMContentLoaded', () => {
      load();
      render();
      FEATURES.forEach(feature => document.getElementById(feature.id)?.addEventListener('change', render));
    });
  }
})();
