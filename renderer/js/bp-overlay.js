'use strict';
// 选人助手浮窗渲染层。和备战区浮窗一样刻意很笨：不算分、不读 LCU，
// 只把主窗口算好的两块 HTML 贴进来 —— 打分/排序/去重全在 bp-advisor.js 一处，
// 浮窗和主窗口面板不会各算一套导致结论不一致。
(function () {
  const api = window.lolAPI || null;
  const subEl = document.getElementById('sub');
  const paneData = document.getElementById('paneData');
  const paneBp = document.getElementById('paneBp');
  const tabData = document.getElementById('tabData');
  const tabBp = document.getElementById('tabBp');
  const pinBtn = document.getElementById('pin');

  const EMPTY_DATA = '<div class="empty">进入选人并亮出英雄后，这里给出你这一路的对位数据：胜率、选禁率，以及能打谁、打不过谁。</div>';
  const EMPTY_BP = '<div class="empty">己方每个空位的候选，加上推荐 Pick / Ban。</div>';

  let lastBp = null;
  let lastCnt = null;
  let lastSub = null;
  let active = 'data';

  function setTab(name) {
    active = name === 'bp' ? 'bp' : 'data';
    tabData.className = active === 'data' ? 'on' : '';
    tabBp.className = active === 'bp' ? 'on' : '';
    paneData.hidden = active !== 'data';
    paneBp.hidden = active !== 'bp';
  }
  tabData.addEventListener('click', () => setTab('data'));
  tabBp.addEventListener('click', () => setTab('bp'));

  function render(data) {
    const d = data || {};
    const bp = String(d.html || '');
    const cnt = String(d.cnt || '');
    const sub = String(d.sub || '');

    // 副标题可能单独变（阶段文案），正文没变就不重排 DOM
    if (sub !== lastSub) { lastSub = sub; subEl.textContent = sub || '选人助手'; }
    if (bp !== lastBp) {
      lastBp = bp;
      paneBp.innerHTML = bp || EMPTY_BP;
      paneBp.scrollTop = 0;
    }
    if (cnt !== lastCnt) {
      lastCnt = cnt;
      paneData.innerHTML = cnt || EMPTY_DATA;
      paneData.scrollTop = 0;
    }
    // 数据页没内容（还没亮英雄）时自动落到阵容页，别停在一页空白上
    if (!cnt && bp && active === 'data') setTab('bp');
  }

  document.getElementById('hide').addEventListener('click', () => {
    if (api && api.bpOverlayHide) api.bpOverlayHide();
  });

  // 图钉 = 是否始终盖在客户端之上。主进程创建时默认置顶，这里只负责切换。
  let pinned = true;
  if (pinBtn) {
    pinBtn.addEventListener('click', () => {
      pinned = !pinned;
      pinBtn.className = 'tbb' + (pinned ? ' on' : '');
      pinBtn.title = pinned ? '钉住：始终盖在客户端之上' : '未钉住：可被客户端盖住';
      if (api && api.bpOverlayPin) {
        try {
          const r = api.bpOverlayPin(pinned);
          if (r && typeof r.catch === 'function') r.catch(() => {});
        } catch (e) {}
      }
    });
  }

  // 主进程在 did-finish-load 时推第一帧，页面脚本在此之前已跑完，不会漏。
  if (api && api.onBpOverlayData) api.onBpOverlayData(render);
  else render({ html: '<div class="empty">浮窗未连接到主进程，请重启 Poro</div>' });
})();
