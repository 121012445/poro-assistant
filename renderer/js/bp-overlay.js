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
  // 1.6.72 筛选条：浮窗只发选择，重算仍由主窗口做（这里不碰 OP.GG 也不算分）。
  const fRegion = document.getElementById('fRegion');
  const fTier = document.getElementById('fTier');
  const fPos = document.getElementById('fPos');
  const fVer = document.getElementById('fVer');
  const fltNote = document.getElementById('fltNote');
  const REGION_CN = { kr: '韩服 KR', global: '全球', na: '美服 NA', euw: '欧服 EUW', eune: '欧东 EUNE',
    jp: '日服 JP', tw: '台服 TW', vn: '越南 VN', br: '巴西 BR', lan: '拉美 LAN' };
  const TIER_CN = {
    all: '全部段位', iron: '黑铁', bronze: '青铜', silver: '白银', gold: '黄金', gold_plus: '黄金以上',
    platinum: '铂金', platinum_plus: '铂金以上', emerald: '翡翠', emerald_plus: '翡翠以上',
    diamond: '钻石', diamond_plus: '钻石以上', master: '大师', master_plus: '大师以上',
    grandmaster: '宗师', challenger: '王者'
  };

  const EMPTY_DATA = '<div class="empty">进入选人并亮出英雄后，这里给出你这一路的对位数据：胜率、选禁率，以及能打谁、打不过谁。</div>';
  const EMPTY_BP = '<div class="empty">己方每个空位的候选，加上推荐 Pick / Ban。</div>';

  // 1.6.77: 版本下拉显示真实版本号（如 16.23），不再只写"当前"。
  // 来源优先级：主进程推送的 OP.GG meta.version > ddragon 当前版本。
  // bench 在默认 KR/all 口径下不会加载，meta.version 常常为空，所以用 ddragon 兜底。
  let shownVersion = '';
  function showVersion(ver) {
    if (!ver || !fVer) return;
    const v = String(ver).slice(0, 20);
    shownVersion = v;
    let opt = [...fVer.options].find(o => o.value === v || o.textContent === v);
    if (!opt) {
      opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      fVer.insertBefore(opt, fVer.firstChild);
    }
    fVer.value = v;
    // 说明行也要跟着显示版本号，而不是停在"当前版本加载中"
    filterNote(currentFilters(), v);
  }

  let lastBp = null;
  let lastCnt = null;
  let lastSub = null;
  let active = 'data';

  // 1.6.76: 选人助手页只属于排位（有选位环节）。训练/盲选时整个页签藏起来，
  // 玩家看到的就是一个纯英雄数据窗，不再冒出一个讲 BP 的空页。
  let bpAvailable = true;
  // 1.6.76: 筛选条只属于「英雄数据」页（它是 OP.GG 对位数据的查询条件）。
  // 「选人助手」是纯 BP 页，按当前选人会话出 pick/ban，不吃这些筛选，
  // 所以切页时连筛选条和说明行一起收起，别让 BP 页挂着一组无效的控件。
  const filtersEl = document.getElementById('filters');
  function setTab(name) {
    active = name === 'bp' && bpAvailable ? 'bp' : 'data';
    tabData.className = active === 'data' ? 'on' : '';
    tabBp.className = active === 'bp' ? 'on' : '';
    paneData.hidden = active !== 'data';
    paneBp.hidden = active !== 'bp';
    if (filtersEl) filtersEl.hidden = active !== 'data';
    if (fltNote) fltNote.hidden = active !== 'data';
  }
  function applyBpAvailability(on) {
    bpAvailable = !!on;
    tabBp.hidden = !bpAvailable;
    if (!bpAvailable && active === 'bp') setTab('data');
  }
  tabData.addEventListener('click', () => setTab('data'));
  tabBp.addEventListener('click', () => setTab('bp'));

  function currentFilters() {
    return {
      region: fRegion ? fRegion.value : 'kr',
      tier: fTier ? fTier.value : 'all',
      position: fPos ? fPos.value : 'auto',
      version: 'auto'
    };
  }
  function setSelect(el, v) {
    if (el && v && el.value !== v && [...el.options].some(o => o.value === v)) el.value = v;
  }
  function filterNote(f, ver) {
    if (!fltNote) return;
    const region = REGION_CN[f.region] || String(f.region || '').toUpperCase();
    const tier = TIER_CN[f.tier] || String(f.tier || '全部段位');
    const pos = f.position === 'auto' ? '跟随我的位置' :
      ({ top: '上路', jungle: '打野', mid: '中路', adc: '下路', support: '辅助' }[f.position] || f.position);
    fltNote.textContent = 'OP.GG · ' + region + ' · ' + tier + ' · ' + pos
      + (ver ? ' · 版本 ' + ver : '');
  }
  function syncFilters(f, ver) {
    if (!f || !fRegion || !fTier || !fPos) return;
    setSelect(fRegion, f.region);
    setSelect(fTier, f.tier);
    setSelect(fPos, f.position);
    // 1.6.77: 有外部版本就用它，否则沿用已显示的（ddragon 兜底异步先前到）。
    if (ver) showVersion(ver);
    else if (shownVersion) showVersion(shownVersion);
    else filterNote(currentFilters(), '');
  }
  function sendFilters() {
    const f = currentFilters();
    filterNote(f, fVer && fVer.value !== 'auto' ? fVer.value : '');
    if (api && typeof api.bpOverlayFilter === 'function') {
      try {
        const r = api.bpOverlayFilter(f);
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch (e) {}
    }
  }
  for (const el of [fRegion, fTier, fPos]) {
    if (el) el.addEventListener('change', sendFilters);
  }
  // 1.6.77: 版本下拉要显示真实版本号。主进程推的 OP.GG meta.version 优先，
  // 但它常常为空（默认 KR/all 口径不拉 bench），所以这里主动拉一次 ddragon 当前版本兜底。
  if (api && typeof api.getVersion === 'function') {
    try {
      const p = api.getVersion();
      if (p && typeof p.then === 'function') {
        p.then(v => { if (v && !shownVersion) showVersion(v); }).catch(() => {});
      }
    } catch (e) {}
  }
  // 浮窗重建时先恢复已保存的选择；主进程推送的第一帧还会再同步一次。
  if (api && typeof api.bpOverlayStatus === 'function') {
    try {
      const p = api.bpOverlayStatus();
      if (p && typeof p.then === 'function') {
        p.then(s => { if (s && s.filter) syncFilters(s.filter, s.version); }).catch(() => {});
      }
    } catch (e) {}
  }

  function render(data) {
    const d = data || {};
    const bp = String(d.html || '');
    const cnt = String(d.cnt || '');
    const sub = String(d.sub || '');
    if (d.filters || d.version) syncFilters(d.filters, d.version);

    // 1.6.76: 有 BP 才显示"选人助手"页签。缺省 true —— 兼容还没带这个字段的旧帧。
    applyBpAvailability(d.bpAvailable !== false);
    // 副标题可能单独变（阶段文案），正文没变就不重排 DOM
    if (sub !== lastSub) { lastSub = sub; subEl.textContent = sub || (bpAvailable ? '选人助手' : '英雄数据'); }
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
    // 1.6.76: 默认且始终停在「英雄数据」页。旧版在这里写了一条
    // "数据页没内容就自动落到 BP 页"，结果一进选人、还没亮英雄时就被弹到选人助手，
    // 与"英雄数据是默认页"相悖。现在只有用户手动点页签才切换，推送不再改页。
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
