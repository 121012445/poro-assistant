'use strict';
(function () {
  const list = document.getElementById('list');
  const champion = document.getElementById('champion');
  const state = document.getElementById('state');
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  function compact(value) {
    const n = Number(value) || 0;
    return n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 1 : 2).replace(/\.0$/, '') + '万场' : n.toLocaleString('zh-CN') + '场';
  }
  function render(data) {
    const d = data || {};
    const items = Array.isArray(d.items) ? d.items : [];
    champion.textContent = d.champion || '';
    state.textContent = d.state || 'F6 重新识别 · 仅提示，不会自动选择';
    list.innerHTML = items.map((item, index) => {
      const rate = item.winRate != null && Number.isFinite(Number(item.winRate))
        ? (Number(item.winRate) * 100).toFixed(2) + '%'
        : '--';
      const adjusted = item.recommendationScore != null && Number.isFinite(Number(item.recommendationScore))
        ? (Number(item.recommendationScore) * 100).toFixed(1) + '%'
        : rate;
      const gain = item.gainReliable === true && item.gain != null && Number.isFinite(Number(item.gain))
        ? Number(item.gain) : null;
      const gainText = gain == null ? '参考不足' : ((gain >= 0 ? '+' : '') + (gain * 100).toFixed(1) + '%');
      const gainClass = gain == null ? 'unknown' : (gain > 0.001 ? 'positive' : (gain < -0.001 ? 'negative' : 'neutral'));
      const sample = Number(item.games) > 0 ? compact(item.games) : '暂无样本';
      return '<div class="item' + (index === 0 ? ' best' : '') + '">' +
        '<span class="rank">' + (index + 1) + '</span>' +
        '<img class="icon" src="' + esc(item.icon) + '">' +
        '<span class="copy"><span class="name">' + esc(item.name) + '</span><small>' + esc(item.reason || '英雄阶段胜率排序') + '</small></span>' +
        '<span class="meta"><b class="gain ' + gainClass + '">' + gainText + '</b><span>修正 ' + adjusted + ' · ' + sample + '</span><em class="confidence ' + esc(item.confidenceLevel || 'low') + '">' + esc(item.confidenceLabel || '') + '</em></span>' +
      '</div>';
    }).join('');
  }
  if (window.lolAPI?.onAugmentOverlayData) window.lolAPI.onAugmentOverlayData(render);
})();
