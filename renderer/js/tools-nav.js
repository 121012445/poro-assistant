'use strict';
// 工具箱分类小标签 (1.5.63)
// 工具箱一页里平铺了 26 个设置, 分 5 个分区。只有分区大标题的话, 想找一个
// 「好像见过但不知道在哪」的功能只能一路滚到底。这里在页头下面贴一排分类
// 小标签: 点一下跳到对应分区, 滚动时高亮当前分区。
// 标签是运行时按 .tools-section 现算的, 增删设置行/分区都不用回来改 HTML。

(function () {
  let bound = false;
  let rafId = 0;
  let chips = [];       // [{ btn, sec }]
  let navEl = null;
  let mainEl = null;

  function build() {
    navEl = document.getElementById('toolsNav');
    mainEl = document.querySelector('.main-content');
    if (!navEl || !mainEl) return false;

    const sections = Array.from(document.querySelectorAll('#page-tools .tools-section'));
    if (!sections.length) return false;

    // 每个分区的设置条数 = 从本分区标题数到下一个分区标题之前的 .tool-card
    // (页尾的免责声明 .legal-card 不算设置, 别把条数撑大)
    navEl.innerHTML = sections.map((sec, i) => {
      const label = sec.dataset.cat || sec.textContent.trim();
      const stop = sections[i + 1];
      let n = 0;
      for (let el = sec.nextElementSibling; el && el !== stop; el = el.nextElementSibling) {
        if (el.classList.contains('tool-card') && !el.classList.contains('legal-card')) n++;
      }
      return `<button type="button" class="tools-nav-chip" data-target="${sec.id}">` +
        `<span class="tnc-label">${label}</span>` +
        `<span class="tnc-count">${n}</span></button>`;
    }).join('');

    chips = Array.from(navEl.querySelectorAll('.tools-nav-chip')).map(btn => ({
      btn,
      sec: document.getElementById(btn.dataset.target)
    })).filter(c => c.sec);
    return chips.length > 0;
  }

  // 跳到某个分区。
  // 不用 behavior:'smooth': .main-content 上写了 scroll-behavior:auto, 平滑滚动
  // 在这套页面里不可靠 (异步换页 + 滚动锚定会把位置带跑)。先算一个大概位置跳过去,
  // 再用「分区标题 vs 标签条底边」的实际差值补一次 —— 这样不依赖容器的 padding /
  // 吸顶偏移具体是多少, 也不会被跳转途中的布局抖动带偏。
  function jumpTo(sec) {
    if (!sec || !mainEl) return;
    if (sec === chips[0].sec) { mainEl.scrollTop = 0; return; }
    const navH = navEl.offsetHeight;
    const rough = sec.getBoundingClientRect().top - mainEl.getBoundingClientRect().top +
      mainEl.scrollTop - navH - 10;
    mainEl.scrollTop = Math.max(0, rough);
    const delta = sec.getBoundingClientRect().top - navEl.getBoundingClientRect().bottom - 8;
    if (Math.abs(delta) > 1) mainEl.scrollTop += delta;
  }

  function sync() {
    if (!chips.length) return;
    // 探针 = 标签条底边: 谁的标题越过了标签条, 谁就是"当前分区"
    const probe = navEl.getBoundingClientRect().bottom + 8;
    let current = chips[0];
    for (const c of chips) {
      if (c.sec.getBoundingClientRect().top <= probe) current = c;
    }
    // 滚到底时最后一屏可能压不到探针线, 直接把最后一个点亮
    if (mainEl.scrollTop + mainEl.clientHeight >= mainEl.scrollHeight - 4) current = chips[chips.length - 1];
    for (const c of chips) c.btn.classList.toggle('active', c === current);
    // "吸顶"要按实际位置判断, 不能只看 scrollTop > 0:
    // 标签条本身在页头下面一段距离, 前几十像素的滚动它还没贴上去。
    // 贴着时再亮分隔线 + 盖住容器 padding 缝的垫片, 否则会盖到页头标题。
    const cs = getComputedStyle(mainEl);
    const line = mainEl.getBoundingClientRect().top + (parseFloat(cs.paddingTop) || 0);
    navEl.classList.toggle('is-stuck', navEl.getBoundingClientRect().top <= line + 0.5);
  }

  function onScroll() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; sync(); });
  }

  function bind() {
    if (bound) return;
    bound = true;
    navEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.tools-nav-chip');
      if (!btn) return;
      const sec = document.getElementById(btn.dataset.target);
      if (!sec) return;
      for (const c of chips) c.btn.classList.toggle('active', c.btn === btn);
      jumpTo(sec);
      sync();
    });
    mainEl.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
  }

  // switchPage('tools') 每次进页都会调到这里: 第一次建标签 + 绑事件, 之后只重算条数
  window.initToolsNav = function initToolsNav(opts) {
    if (!build()) return;
    bind();
    if (!opts || opts.reset !== false) mainEl.scrollTop = 0;
    sync();
  };
})();
