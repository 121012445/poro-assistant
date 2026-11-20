// 页面背景原画：用「我最近一局玩的英雄」的加载原画做一层极慢推镜的背景。
//
// 为什么不是视频: Sona 那种循环视频每个英雄 3–8MB, 9 个英雄就是几十 MB, 还要处理
// 素材来源与解码开销。这里用同一张官方 splash（DDragon CDN 上本来就有, 200–400KB）,
// 靠 CSS 的 40 秒缓推 + 低透明度做出"活着"的感觉。要换真视频时只改这一层的
// background 容器, 上层页面不用动。
//
// 只在首页/我的画像生效: 这两页是"看自己"的地方, 背景原画不抢内容。
// 实际效果由 poro-1632.css 里的 body.splash-on 规则承担, 这里只负责:
//   1) 决定用哪个英雄 2) 把 URL 写进 CSS 变量 3) 记住开关
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  if (typeof window !== 'undefined') window.PoroSplash = api; else if (root) root.PoroSplash = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const KEY = 'splashBg';
  const PAGES = ['home', 'profile'];   // 只有这两页显示背景
  let currentId = 0;
  let currentUrl = '';

  // storeSet 一律 String(v) 落盘, 读回来是 "true"/"false" 字符串。
  // 早先这里写 !!v: !!"false" === true, 于是关掉之后仍被判成开启 —— 表现在
  // 就是"点了开关按钮变灰, 背景却一点没变"。字符串必须按字面解析。
  function enabled() {
    try {
      if (typeof storeGet === 'function') {
        const v = storeGet(KEY);
        if (v === undefined || v === null || v === '') return true;
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v !== 0;
        return !/^(false|0|off|no)$/i.test(String(v).trim());
      }
    } catch (e) { /* 存储不可用就默认开 */ }
    return true;
  }

  function setEnabled(on) {
    try { if (typeof storeSet === 'function') storeSet(KEY, !!on); } catch (e) {}
    apply(currentId);
    return !!on;
  }

  // 数字 id → DDragon 字母 key（splashUrl 要的是字母 key）
  function keyOf(championId) {
    const id = Number(championId) || 0;
    if (!id) return '';
    const map = (typeof champNumMap !== 'undefined') ? champNumMap : null;
    const ref = map && map[String(id)];
    return (ref && ref.id) || '';
  }

  function urlOf(championId) {
    const key = keyOf(championId);
    if (!key || typeof splashUrl !== 'function') return '';
    try { return splashUrl(key, 0) || ''; } catch (e) { return ''; }
  }

  // 从首页战绩里找"我"最近一局用的英雄
  function pickChampion(games, selfPuuid) {
    const list = Array.isArray(games) ? games : [];
    for (const g of list) {
      const parts = (g && Array.isArray(g.participants)) ? g.participants : [];
      if (!parts.length) continue;
      const me = selfPuuid ? parts.find(p => p && p.puuid === selfPuuid) : null;
      // 只有拿不到自己 puuid 时才退化成单人参与者; 有 puuid 却匹配不上就是没数据,
      // 不能把别人的英雄当自己的背景。
      const target = me || ((!selfPuuid && parts.length === 1) ? parts[0] : null);
      if (target && Number(target.championId) > 0) return Number(target.championId);
      if (!selfPuuid) return 0;
    }
    return 0;
  }

  function apply(championId) {
    const body = document.body;
    if (!body) return;
    const id = Number(championId) || currentId;
    if (id) {
      const url = urlOf(id);
      if (url) { currentId = id; currentUrl = url; }
    }
    // 没有图也要如实反映开关状态: 否则按钮灰了但 body 上还挂着 splash-on,
    // 下一轮 onPage 又按旧状态把背景挂回去。
    if (currentUrl) body.style.setProperty('--poro-splash', 'url("' + currentUrl + '")');
    body.classList.toggle('splash-on', enabled());
  }

  function activePage() {
    try {
      const el = document.querySelector('.page.active');
      return el && el.id ? el.id.replace('page-', '') : '';
    } catch (e) { return ''; }
  }

  function applyFromGames(games, selfPuuid) {
    const puuid = selfPuuid !== undefined ? selfPuuid
      : (typeof homeGamesOwner !== 'undefined' ? homeGamesOwner : '');
    const id = pickChampion(games, puuid);
    if (id) apply(id);
    // 数据到达时可能已经停在首页/画像页, 立刻补一次页面级开关
    onPage(activePage());
    return id;
  }

  // 页面切换时只在白名单页面挂，其余页面摘掉（避免半透明背景透到表格里）
  function onPage(page) {
    const body = document.body;
    if (!body) return;
    body.classList.toggle('splash-page', PAGES.indexOf(String(page)) >= 0 && !!currentUrl && enabled());
  }

  function toggle() {
    const next = !enabled();
    setEnabled(next);
    // 早先这里用 classList.contains('splash-page') 反推当前页: 关掉时该 class 被摘掉,
    // 再点开就反推成"不在白名单页", onPage('') 又把背景按了回去 —— 关掉后打不开。
    // 页面归属只问 activePage(), 不再从自己的副产物里猜。
    const page = activePage();
    if (page) onPage(page);
    return next;
  }

  function state() {
    return { enabled: enabled(), championId: currentId, url: currentUrl };
  }

  return { KEY, PAGES, enabled, setEnabled, keyOf, urlOf, pickChampion, apply, applyFromGames, onPage, toggle, state };
});
