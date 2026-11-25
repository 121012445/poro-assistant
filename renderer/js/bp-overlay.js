'use strict';
// 选人助手浮窗渲染层。和备战区浮窗一样刻意很笨：不算分、不读 LCU，
// 只把主窗口算好的两块 HTML 贴进来 —— 打分/排序/去重全在 bp-advisor.js 一处，
// 浮窗和主窗口面板不会各算一套导致结论不一致。
(function () {
  const api = window.lolAPI || null;
  const subEl = document.getElementById('sub');
  const dotEl = document.getElementById('dot');
  const paneBp = document.getElementById('paneBp');
  const paneCnt = document.getElementById('paneCnt');
  const tabBp = document.getElementById('tabBp');
  const tabCnt = document.getElementById('tabCnt');

  const EMPTY_BP = '<div class="empty">进入排位/征召选人后自动出现：己方每个空位给几个候选，外加推荐 Pick / Ban。</div>';
  const EMPTY_CNT = '<div class="empty">这里显示你当前选/预选英雄的被克制与克制对位（需要先亮出英雄）。</div>';

  let lastBp = null;
  let lastCnt = null;
  let lastSub = null;

  function setTab(name) {
    const isBp = name !== 'cnt';
    tabBp.className = isBp ? 'on' : '';
    tabCnt.className = isBp ? '' : 'on';
    paneBp.hidden = !isBp;
    paneCnt.hidden = isBp;
  }
  tabBp.addEventListener('click', () => setTab('bp'));
  tabCnt.addEventListener('click', () => setTab('cnt'));

  // 克制页是"看英雄"的，还没亮英雄时自动停在阵容页，别给一个空页。
  function render(data) {
    const d = data || {};
    const bp = String(d.html || '');
    const cnt = String(d.cnt || '');
    const sub = String(d.sub || '');

    // 副标题可能单独变（阶段文案），正文没变就不重排 DOM
    if (sub !== lastSub) { lastSub = sub; subEl.textContent = sub || '等待选人…'; }
    if (bp !== lastBp) {
      lastBp = bp;
      paneBp.innerHTML = bp || EMPTY_BP;
      paneBp.scrollTop = 0;
    }
    if (cnt !== lastCnt) {
      lastCnt = cnt;
      paneCnt.innerHTML = cnt || EMPTY_CNT;
      paneCnt.scrollTop = 0;
    }
    dotEl.className = 'dot' + ((bp || cnt) ? ' on' : '');
  }

  document.getElementById('hide').addEventListener('click', () => {
    if (api && api.bpOverlayHide) api.bpOverlayHide();
  });

  // 主进程在 did-finish-load 时推第一帧，页面脚本在此之前已跑完，不会漏。
  if (api && api.onBpOverlayData) api.onBpOverlayData(render);
  else render({ html: '<div class="empty">浮窗未连接到主进程，请重启 Poro</div>' });
})();
