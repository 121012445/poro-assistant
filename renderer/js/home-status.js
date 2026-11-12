'use strict';

(function () {
  let panelOriginalParent = null;

  const phaseText = { None: '大厅', Lobby: '组队房间', Matchmaking: '匹配中', ReadyCheck: '准备确认', ChampSelect: '选人阶段', GameStart: '游戏启动', InProgress: '对局进行中', Reconnect: '重新连接', EndOfGame: '结算中', WaitingForStats: '等待战绩' };
  const workflow = {
    None: { next: '可以查看战绩、工具和玩家记忆', action: '打开工具箱', page: 'tools' },
    Lobby: { next: '队伍已创建，可继续准备对局', action: '查看实时页', page: 'live' },
    Matchmaking: { next: '等待匹配确认', action: '查看工具箱', page: 'tools' },
    ReadyCheck: { next: '确认弹窗出现后检查自动接受状态', action: '查看工具箱', page: 'tools' },
    ChampSelect: { next: '检查阵容、克制关系和符文配置', action: '打开对局准备', page: 'live' },
    GameStart: { next: '等待进入游戏，准备摘要仍可查看', action: '打开实时对局', page: 'live' },
    InProgress: { next: '查看双方阵容、经济和关键提醒', action: '打开实时对局', page: 'live' },
    Reconnect: { next: '客户端正在尝试恢复对局', action: '查看实时对局', page: 'live' },
    EndOfGame: { next: '等待结算数据写入', action: '查看首页战绩', page: 'home' },
    WaitingForStats: { next: '结算数据生成后会自动补刷首页', action: '查看首页战绩', page: 'home' }
  };
  function render() {
    const client = document.getElementById('homeStatusClient');
    const phase = document.getElementById('homeStatusPhase');
    const automation = document.getElementById('homeStatusAutomation');
    const mode = document.getElementById('homeStatusMode');
    const next = document.getElementById('homeStatusNext');
    const primary = document.getElementById('homeStatusPrimary');
    const title = document.getElementById('homeStatusTitle');
    const pill = document.getElementById('homeStatusPill');
    if (!client || !phase || !automation || !mode || !next || !primary || !title || !pill) return;
    // lcu-events.js 使用模块内状态变量，不会把它挂到 window。
    // 直接复用侧栏已经展示的状态，避免出现“顶部已连接、面板未连接”。
    const clientText = document.getElementById('lcuStatusText')?.textContent || '';
    const connected = clientText.includes('已连接');
    const currentPhase = window._gameflowPhase || '';
    const active = typeof window.getActiveAutomationCount === 'function'
      ? window.getActiveAutomationCount()
      : 0;
    client.textContent = connected ? '已连接' : (clientText.includes('检测中') ? '检测中…' : '未连接');
    phase.textContent = phaseText[currentPhase] || (currentPhase || '未进入对局');
    const modeContext = window.getAutomationModeContext?.();
    automation.textContent = active ? `${active} 项运行中 · ${modeContext?.known ? modeContext.label : '当前模式'}` : '未开启';
    mode.textContent = typeof complianceOn !== 'undefined' && complianceOn ? '合规只读' : '标准模式';
    const step = workflow[currentPhase] || workflow.None;
    next.textContent = currentPhase === 'InProgress' && window._poroCurrentDecision
      ? window._poroCurrentDecision
      : step.next;
    primary.textContent = step.action;
    primary.onclick = () => switchPage(step.page);
    title.textContent = currentPhase === 'InProgress' ? '对局进行中' : (connected ? '客户端已就绪' : '等待客户端连接');
    pill.textContent = currentPhase === 'InProgress' ? '进行中' : (connected ? '已连接' : '离线');
    pill.classList.toggle('is-live', currentPhase === 'InProgress');
    pill.classList.toggle('is-online', connected && currentPhase !== 'InProgress');
  }
  window.refreshStatusCenter = render;

  window.toggleStatusCenter = function toggleStatusCenter(force) {
    const panel = document.getElementById('sidebarStatusPanel');
    const toggle = document.getElementById('statusCenterToggle');
    if (!panel || !toggle) return;
    const open = typeof force === 'boolean' ? force : panel.hidden;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.classList.toggle('is-open', open);
    syncPanelPlacement();
    try { localStorage.setItem('poro.statusCenterOpen', open ? '1' : '0'); } catch (e) {}
  };

  function syncPanelPlacement() {
    const panel = document.getElementById('sidebarStatusPanel');
    const toggle = document.getElementById('statusCenterToggle');
    if (!panel || !toggle || panel.hidden) return;
    // 侧栏实际只有 196px 宽, 而面板内容是 11 块 (4 行状态 + 标题 + 提示 + 徽标 +
    // 2 个动作按钮 + 自动化记录 + 2 个 reconnect), 约需 250px 宽 / 450px 高。
    // 内联摆放必然被侧栏裁掉: 文字断在半句, 按钮只露半截 (2026-11-12 用户报障)。
    // 因此两种侧栏状态统一按浮层处理: portal 到 body, 贴侧栏右侧展开,
    // 高度可用整个视口, 不再受 176px 内容宽和底栏剩余空间限制。
    if (panel.parentElement !== document.body) document.body.appendChild(panel);
    panel.classList.add('is-popover');
    const W = 252;
    const r = toggle.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.left = Math.max(8, Math.min(r.right + 8, window.innerWidth - W - 8)) + 'px';
    panel.style.width = W + 'px';
    panel.style.zIndex = '10000';
    panel.style.bottom = Math.max(8, window.innerHeight - r.top + 6) + 'px';
    panel.style.top = 'auto';
    panel.style.maxHeight = Math.max(160, r.top - 16) + 'px';
    panel.style.overflowY = 'auto';
  }

  window.addEventListener('DOMContentLoaded', () => {
    const panel = document.getElementById('sidebarStatusPanel');
    panelOriginalParent = panel?.parentElement || null;
    render();
    setInterval(render, 1000);
    (window.getTrackedAutomationIds?.() || []).forEach(id => document.getElementById(id)?.addEventListener('change', render));
    window.addEventListener('resize', syncPanelPlacement);
    new MutationObserver(syncPanelPlacement).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    try { if (localStorage.getItem('poro.statusCenterOpen') === '1') toggleStatusCenter(true); } catch (e) {}
  });
})();
