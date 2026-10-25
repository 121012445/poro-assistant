// 游戏内聊天翻译浮窗页面 (主进程 game-translate:push 推数据; 窗口点击穿透)
// 行在 16 秒后淡出, 全部淡出后窗口视觉上为空 (透明), 不需要主进程隐藏窗口。
(function () {
  'use strict';
  const MAX_AGE_MS = 16000;
  let lines = [];
  const wrap = document.getElementById('gtWrap');

  function esc(value) {
    const div = document.createElement('div');
    div.textContent = String(value == null ? '' : value);
    return div.innerHTML;
  }

  function render() {
    if (!wrap) return;
    const now = Date.now();
    lines = lines.filter(l => now - (Number(l.ts) || 0) < MAX_AGE_MS);
    if (!lines.length) {
      if (wrap.style.display !== 'none') { wrap.style.display = 'none'; wrap.innerHTML = ''; }
      return;
    }
    wrap.style.display = 'flex';
    wrap.innerHTML = lines.map(l =>
      '<div class="gt-line">'
      + '<span class="gt-name">' + esc(l.name) + '</span>'
      + '<span class="gt-body">' + esc(l.translated) + '</span>'
      + (l.body && l.body !== l.translated ? '<span class="gt-orig">' + esc(l.body) + '</span>' : '')
      + '</div>'
    ).join('');
  }

  if (window.lolAPI && window.lolAPI.onGameTranslateData) {
    lolAPI.onGameTranslateData(d => {
      if (!d || !Array.isArray(d.lines)) return;
      lines = d.lines.slice();
      render();
    });
  }
  setInterval(render, 1000);
})();
