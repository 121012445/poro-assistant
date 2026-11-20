// 对局浮窗里的"技能计时"条 (渲染 + 点击开始倒计时)
// 状态 (marks) 只活在这个窗口里: 主窗口只负责把 5 名敌人的技能与基础 CD 推过来。
// 主进程通过 game-live:cd-interactive 控制是否可点 (默认点击穿透, 按 F11 才可点)。
(function () {
  'use strict';
  const Cd = window.PoroCd;
  if (!Cd) return;
  const listEl = document.getElementById('cdList');
  const tipEl = document.getElementById('cdTip');
  if (!listEl) return;

  let rows = [];
  let marks = {};        // key -> { D: ts, F: ts, R: ts }
  let interactive = false;
  let idleTimer = null;
  let tick = null;
  let dirty = true;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function slotCell(row, slot, label, cd) {
    const m = marks[row.key] || {};
    const st = Cd.stateOf(m[slot], cd, Date.now());
    const cls = !cd ? 'na' : st.ready ? 'ready' : 'cooling';
    const txt = !cd ? '—' : st.ready ? '就绪' : st.text;
    return '<button type="button" class="cd-slot ' + cls + '" data-key="' + esc(row.key) + '" data-slot="' + slot + '"'
      + ' title="' + esc(label + (cd ? ' · 基础 ' + Cd.fmt(cd) : '')) + '">'
      + '<i>' + esc(label) + '</i><b>' + esc(txt) + '</b></button>';
  }

  function render(force) {
    if (!listEl) return;
    if (!force && !dirty) return;
    dirty = false;
    if (!rows.length) {
      listEl.innerHTML = '<div class="cd-empty">进入对局后自动列出敌方技能</div>';
      return;
    }
    listEl.innerHTML = rows.map(r => {
      const spells = r.spells || [];
      return '<div class="cd-row">'
        + '<span class="cd-champ" title="' + esc(r.name) + '">' + esc(r.champName || r.name) + '</span>'
        + slotCell(r, 'D', spells[0] ? spells[0].name : 'D', spells[0] ? spells[0].cd : null)
        + slotCell(r, 'F', spells[1] ? spells[1].name : 'F', spells[1] ? spells[1].cd : null)
        + slotCell(r, 'R', 'R', r.ult ? r.ult.cd : null)
        + '</div>';
    }).join('');
  }

  // 每 500ms 只更新"正在冷却"的那些格子的文字, 不重建 DOM (点了不会闪)
  function tickOnce() {
    if (!rows.length) return;
    const now = Date.now();
    listEl.querySelectorAll('button.cd-slot').forEach(btn => {
      const key = btn.dataset.key, slot = btn.dataset.slot;
      const row = rows.find(r => r.key === key);
      if (!row) return;
      const cd = slot === 'R' ? (row.ult && row.ult.cd) : ((row.spells || []).find(s => s.slot === slot) || {}).cd;
      const st = Cd.stateOf((marks[key] || {})[slot], cd, now);
      const b = btn.querySelector('b');
      const next = !cd ? '—' : st.ready ? '就绪' : st.text;
      if (b && b.textContent !== next) b.textContent = next;
      const cls = !cd ? 'na' : st.ready ? 'ready' : 'cooling';
      if (btn.className.indexOf(cls) < 0) btn.className = 'cd-slot ' + cls;
    });
  }

  function setIdle() {
    if (!interactive) return;
    idleTimer = setTimeout(() => goInteractive(false), 12000);
  }

  function goInteractive(on) {
    interactive = !!on;
    clearTimeout(idleTimer);
    if (listEl) listEl.classList.toggle('armed', interactive);
    if (tipEl) tipEl.textContent = interactive ? '可点：点技能开始计时 · 右键清除' : 'F11 可点';
    if (interactive) setIdle();
    try { if (window.lolAPI && window.lolAPI.gameLiveCdInteractive) window.lolAPI.gameLiveCdInteractive(true); } catch (e) {}
  }

  function onPick(key, slot) {
    const row = rows.find(r => r.key === key);
    if (!row) return;
    const cd = slot === 'R' ? (row.ult && row.ult.cd) : ((row.spells || []).find(s => s.slot === slot) || {}).cd;
    if (!cd) return;
    marks[key] = marks[key] || {};
    const now = Date.now();
    // 再点一次 = 提前结束 (技能已好/记错了)
    if (marks[key][slot] && !Cd.stateOf(marks[key][slot], cd, now).ready) delete marks[key][slot];
    else marks[key][slot] = now;
    dirty = true;
    render(true);
    setIdle();
  }

  if (listEl) {
    listEl.addEventListener('click', e => {
      if (!interactive) return;
      const btn = e.target.closest('button.cd-slot');
      if (!btn) return;
      e.preventDefault();
      onPick(btn.dataset.key, btn.dataset.slot);
    });
    listEl.addEventListener('contextmenu', e => {
      if (!interactive) return;
      const btn = e.target.closest('button.cd-slot');
      if (!btn) return;
      e.preventDefault();
      marks[btn.dataset.key] = marks[btn.dataset.key] || {};
      delete marks[btn.dataset.key][btn.dataset.slot];
      dirty = true;
      render(true);
    });
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && interactive) goInteractive(false);
  });

  if (window.lolAPI) {
    if (window.lolAPI.onGameLiveCd) {
      window.lolAPI.onGameLiveCd(d => {
        rows = (d && Array.isArray(d.rows)) ? d.rows : [];
        dirty = true;
        render(true);
      });
    }
    if (window.lolAPI.onGameLiveCdInteractive) {
      window.lolAPI.onGameLiveCdInteractive(on => goInteractive(on));
    }
  }

  render(true);
  tick = setInterval(tickOnce, 500);
  window.addEventListener('beforeunload', () => { clearInterval(tick); clearTimeout(idleTimer); });
})();
