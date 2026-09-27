'use strict';
// 「我的画像」独立页接线测试。
//
// 背景：2026-09-27 把「我的擅长与提升」与「玩家趣味档案」从首页拆到 #page-profile，
// 首页只留一行 .home-profile-entry 入口。这个拆分的价值全在"接线"上 ——
// 少接一根线（导航项、页面容器、切页分支、深链白名单、刷新钩子）就会表现为
// "点了没反应"或"进去是空的"，而 npm test 里没有任何别的脚本会碰这些。
//
// 所以这里断言的都是**跨文件的一致性**，而不是单个文件的字面量：
//   1. index.html 的导航项 data-page 与页面容器 id 必须一一对应（两个不同属性族，
//      不是自证：写错任何一个都会红）。
//   2. app.js 的切页分支 + 深链白名单必须都认得 profile。
//   3. home.js 的首页模板必须**不再**内联两块内容（否则首页又会变拥挤），
//      但必须保留入口；两个 refresh* 必须收敛到 #profilePanel 作用域。
//   4. CSS 必须给出入口样式与新页的放宽栅格。
const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('renderer/index.html', 'utf8');
const app = fs.readFileSync('renderer/js/app.js', 'utf8');
const home = fs.readFileSync('renderer/js/home.js', 'utf8');
const extras = fs.readFileSync('renderer/css/extras.css', 'utf8');

// ── 1. 导航项 ↔ 页面容器 一一对应 ────────────────────────────────────────────
const navPages = [...html.matchAll(/class="nav-item[^"]*"\s+data-page="([a-z-]+)"/g)].map(m => m[1]);
const pageIds = [...html.matchAll(/<div class="page[^"]*" id="page-([a-z-]+)"/g)].map(m => m[1]);
assert.ok(navPages.length >= 8, '应解析出至少 8 个导航项, 实际 ' + navPages.length);
assert.ok(pageIds.length >= 8, '应解析出至少 8 个页面容器, 实际 ' + pageIds.length);
assert.ok(navPages.includes('profile'), '侧边栏必须有 data-page="profile" 的导航项');
assert.ok(pageIds.includes('profile'), '必须有 id="page-profile" 的页面容器');
const noContainer = navPages.filter(p => !pageIds.includes(p));
const noNav = pageIds.filter(p => !navPages.includes(p));
assert.deepStrictEqual(noContainer, [], '这些导航项没有对应的页面容器: ' + noContainer.join(', '));
assert.deepStrictEqual(noNav, [], '这些页面容器没有对应的导航项(点不进去): ' + noNav.join(', '));

// 导航标签与宿主容器
assert.ok(/data-page="profile"[\s\S]{0,300}?<span>我的画像<\/span>/.test(html),
  '侧边栏 profile 项的标签应为「我的画像」');
assert.ok(html.includes('id="profilePanel"'), '画像页必须有 #profilePanel 宿主容器');
assert.ok(/id="page-profile"[\s\S]*?id="profilePanel"/.test(html),
  '#profilePanel 必须在 #page-profile 内部，否则 renderProfilePage 找不到它');
// 导航项要排在首页之后（画像由首页数据派生，放第一位会让人以为是首页）
assert.ok(navPages.indexOf('home') < navPages.indexOf('profile'),
  'profile 导航项应排在首页之后');
// 默认激活页仍应是首页
assert.ok(/<div class="page active" id="page-home">/.test(html), '默认激活页仍应为首页');

// ── 2. 缓存戳 ────────────────────────────────────────────────────────────────
// file:// 下 ?v= 是渲染层唯一的缓存失效手段。改了 js/css 不升戳 = 用户装完还跑旧代码。
const stamps = [
  ...html.matchAll(/<script src="(js\/[^"?]+)(?:\?v=([0-9]+))?"/g),
  ...html.matchAll(/<link[^>]*href="(css\/[^"?]+)(?:\?v=([0-9]+))?"/g)
].map(m => ({ path: m[1], stamp: m[2] }));
assert.ok(stamps.length >= 27, '应解析出至少 27 个渲染层资源, 实际 ' + stamps.length);
const unstamped = stamps.filter(s => !s.stamp).map(s => s.path);
assert.deepStrictEqual(unstamped, [], '这些渲染层资源缺少 ?v= 缓存戳: ' + unstamped.join(', '));
const staleStamp = stamps.filter(s => String(s.stamp).slice(0, 8) < '20260928')
  .map(s => s.path + '?v=' + s.stamp);
assert.deepStrictEqual(staleStamp, [], '这些资源的缓存戳早于本次改动日期: ' + staleStamp.join(', '));
// 本次改动的三个文件必须带最新戳（改了却不升戳 = 用户拿到旧代码）
const stampOf = p => (stamps.find(s => s.path === p) || {}).stamp;
for (const p of ['js/home.js', 'js/app.js', 'css/extras.css']) {
  assert.strictEqual(stampOf(p), '2026092801', p + ' 的缓存戳未升到 2026092801');
}

// ── 3. app.js 切页接线 ───────────────────────────────────────────────────────
assert.ok(/if \(page === "profile"[^\n]*renderProfilePage/.test(app),
  'switchPage 必须在 page === "profile" 时调用 renderProfilePage');
assert.ok(/\[\s*"profile",\s*"champions"/.test(app),
  '#hash 深链白名单必须包含 profile，否则 #profile 打开后停在首页');

// ── 4. home.js：首页不再内联两块内容，但保留入口 ─────────────────────────────
const tplStart = home.indexOf('function buildHomeTemplate(');
assert.ok(tplStart > 0, '找不到 buildHomeTemplate');
const tplEnd = home.indexOf('async function loadHomeStats', tplStart);
assert.ok(tplEnd > tplStart, '找不到 buildHomeTemplate 的结尾');
const template = home.slice(tplStart, tplEnd);
assert.ok(!template.includes('buildHomeFunStats('),
  '首页模板不应再内联 buildHomeFunStats —— 玩家趣味档案已拆到 #page-profile');
assert.ok(!template.includes('buildHomeCoach('),
  '首页模板不应再内联 buildHomeCoach —— 我的擅长与提升已拆到 #page-profile');
assert.ok(template.includes('home-profile-entry'), '首页必须保留 .home-profile-entry 入口行');
assert.ok(/home-profile-entry[\s\S]{0,400}?switchPage\('profile'\)/.test(template),
  '首页入口必须能跳到 profile 页');

// renderProfilePage 必须同时渲染两块内容，且复用首页那份数据
const rpStart = home.indexOf('function renderProfilePage(');
assert.ok(rpStart > 0, '找不到 renderProfilePage');
const rpEnd = home.indexOf('function refreshProfilePageIfMounted(', rpStart);
assert.ok(rpEnd > rpStart, '找不到 renderProfilePage 的结尾');
const renderer = home.slice(rpStart, rpEnd);
assert.ok(renderer.includes('buildHomeFunStats(homeGamesData'),
  'renderProfilePage 应把首页已加载的 homeGamesData 交给 buildHomeFunStats');
assert.ok(renderer.includes('buildHomeCoach(homeGamesData'),
  'renderProfilePage 应把首页已加载的 homeGamesData 交给 buildHomeCoach');
assert.ok(renderer.includes('profileHost()'), 'renderProfilePage 应渲染进 #profilePanel 宿主');
assert.ok(/homeGamesData\?\.length/.test(renderer) && /homeGamesOwner/.test(renderer),
  '数据未加载时 renderProfilePage 必须走空状态分支，而不是抛错');

// 两个 refresh* 必须收敛到画像页作用域 —— 不能再满文档找 .home-coach / .home-fun。
// 否则将来别的页面出现同名 class 就会被误改。
assert.ok(!/document\.querySelector\('\.home-coach'\)/.test(home),
  'refreshHomeCoach 不应再满文档查询 .home-coach，应收敛到 #profilePanel');
assert.ok(!/document\.querySelector\('\.home-fun'\)/.test(home),
  'refreshHomeFunStats 不应再满文档查询 .home-fun，应收敛到 #profilePanel');

// 首页数据更新后必须能补渲染画像页（否则停在画像页等数据时永远空白）
assert.ok(/homeGamesOwner = s\.puuid;[\s\S]{0,400}?refreshProfilePageIfMounted\(\)/.test(home),
  'loadHomeStats 拿到数据后必须调用 refreshProfilePageIfMounted()');
assert.ok(/function refreshProfilePageIfMounted\(\)[\s\S]{0,600}?dataset\.owner/.test(home),
  'refreshProfilePageIfMounted 应只在画像页已挂载或正激活时重算，避免每次刷首页白算');

// ── 5. CSS ───────────────────────────────────────────────────────────────────
assert.ok(/\.home-profile-entry\s*\{/.test(extras), '首页入口 .home-profile-entry 必须有样式');
assert.ok(/#page-profile \.page-header\s*\{[^}]*flex-direction:\s*column/.test(extras),
  '画像页页头必须纵向排列，否则副标题会挤在 h2 右边');
assert.ok(/#page-profile \.home-fun-grid\s*\{[^}]*grid-template-columns:\s*repeat\(8/.test(extras),
  '画像页横向空间更宽，趣味档案栅格应放宽（沿用首页 6 列会显得稀疏）');
assert.ok(/#page-profile \.hc-profile-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4/.test(extras),
  '画像页擅长卡片栅格应放宽到 4 列');
// 两块内容自身的卡片样式必须继续存在（拆分不该顺手删掉它们）
assert.ok(extras.includes('.home-coach'), '擅长与提升的样式必须保留');
assert.ok(/\.home-fun\s*\{/.test(extras), '趣味档案的样式必须保留');

console.log('我的画像独立页接线测试通过 (导航/页面容器一一对应 · 缓存戳 · 切页与深链 · 首页不再内联 · 刷新钩子 · 样式)');
