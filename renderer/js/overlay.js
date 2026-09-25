'use strict';
// 备战区浮窗渲染层。它刻意很笨: 不做任何 LCU 判断, 只把主窗口推来的按钮画出来、
// 把点击回传回去。所有门禁/重试/合规拦截都在主窗口的 bench.js 里完成, 避免两套逻辑走偏。
(function () {
  const listEl = document.getElementById('list');
  const stateEl = document.getElementById('state');
  const titleEl = document.getElementById('title');
  const dotEl = document.getElementById('dot');
  const api = window.lolAPI || null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  let lastKey = '';

  function render(data) {
    const d = data || {};
    const items = Array.isArray(d.items) ? d.items : [];
    const state = String(d.state || '');
    const stateClass = String(d.stateClass || '');

    titleEl.textContent = d.title || '备战区';
    dotEl.className = 'dot' + (items.length ? ' on' : '');

    // 只在内容真的变了才重绘, 否则每帧重建 DOM 会让按钮闪
    const key = items.map(it => it.id + ':' + it.tag + ':' + (it.winRate == null ? '-' : Number(it.winRate).toFixed(5))).join(',') + '|' + state + '|' + stateClass;
    if (key === lastKey) return;
    lastKey = key;

    if (!items.length) {
      listEl.innerHTML = '<div class="empty">' + esc(state || '当前没有可换的英雄') + '</div>';
      stateEl.textContent = '';
      stateEl.className = 'state';
      return;
    }

    listEl.innerHTML = items.map(it =>
      '<button class="item" data-id="' + it.id + '">' +
        '<span class="name">' + esc(it.name) + '</span>' +
        (it.winRate != null && Number.isFinite(Number(it.winRate)) ? '<span class="rate">' + (Number(it.winRate) * 100).toFixed(1) + '%</span>' : '') +
        (it.tag ? '<span class="tag' + (it.tag === '备选' ? ' subset' : '') + '">' + esc(it.tag) + '</span>' : '') +
      '</button>'
    ).join('');

    stateEl.textContent = state;
    stateEl.className = 'state' + (stateClass ? ' ' + stateClass : '');
  }

  listEl.addEventListener('click', e => {
    const btn = e.target && e.target.closest ? e.target.closest('.item') : null;
    if (!btn) return;
    const id = Number(btn.getAttribute('data-id'));
    if (!Number.isInteger(id) || id <= 0) return;
    if (api && api.overlaySwap) api.overlaySwap(id);
  });

  document.getElementById('hide').addEventListener('click', () => {
    if (api && api.overlayHide) api.overlayHide();
  });

  // 主进程在 did-finish-load 时会推第一帧; 页面脚本在 load 之前就跑完了, 不会漏。
  if (api && api.onOverlayData) api.onOverlayData(render);
  else render({ state: '浮窗未连接到主进程, 请重启 Poro' });
})();
