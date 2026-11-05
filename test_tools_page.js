'use strict';
// 工具箱页结构: 方框卡片网格 (auto-fill) + 顶部吸顶分类小标签。
// 1.5.62 曾把卡片改成「一行一个设置」的长条列表, 1.5.65 按用户反馈改回卡片。
// 这里既锁卡片外观, 也锁「不许再被 #page-tools 覆盖块压扁」这件事。
const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('renderer/index.html', 'utf8');
const styleCss = fs.readFileSync('renderer/css/style.css', 'utf8');
const premiumCss = fs.readFileSync('renderer/css/premium.css', 'utf8');

const start = html.indexOf('id="page-tools"');
const end = html.indexOf('<div class="page" id="page-blacklist">', start);
const page = html.slice(start, end > start ? end : html.length);

const cards = page.match(/class="tool-card"/g) || [];
const sections = page.match(/class="tools-section"/g) || [];
const wideCards = page.match(/class="tool-card span-all/g) || [];

assert.ok(cards.length >= 20, `工具箱应有 20 个以上的设置卡, 实际 ${cards.length}`);
assert.ok(sections.length >= 4, `应保留分区标题, 实际 ${sections.length}`);
assert.ok(wideCards.length >= 3, `跨列卡片 (热键/免责声明等) 要保留, 实际 ${wideCards.length}`);

// ---- 卡片外观: 用 style.css 里的基础卡片, 不再被行式布局覆盖 ----
assert.match(styleCss, /\.tools-grid\s*\{[^}]*display:\s*grid;/s, '卡片应铺成网格');
assert.match(styleCss, /\.tools-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill, minmax\(250px, 1fr\)\)/s, '网格要 auto-fill 自适应列数');
assert.match(styleCss, /\.tool-card\s*\{[^}]*background:\s*var\(--bg-card\)/s, '卡片要有底色 (不是透明)');
assert.match(styleCss, /\.tool-card\s*\{[^}]*border:\s*1px solid var\(--border\)/s, '卡片要有边框');
assert.match(styleCss, /\.tool-card\s*\{[^}]*border-radius:\s*12px/s, '卡片要圆角');
assert.match(styleCss, /\.tool-card\s*\{[^}]*padding:\s*12px 14px/s, '卡片要有内边距 (文字不能贴着边)');
assert.match(styleCss, /\.tools-section\s*\{[^}]*grid-column:\s*1 \/ -1/s, '分区标题要横跨整行');
assert.match(styleCss, /\.tools-section::after\s*\{[^}]*flex:\s*1/s, '分区标题右侧拖一条细线');
assert.match(styleCss, /\.tool-card > p\s*\{[^}]*margin-bottom:\s*6px/s, '卡片说明与控件之间要留空');

// ---- 回归守卫: 1.5.62 那套覆盖块必须彻底消失 ----
// 它把 .tool-card 的 border/background/radius/padding 全清零、tools-grid 改成单列 block,
// 只要有一条回来, 卡片就会退化成"左边像被削掉一块"的长条。
for (const [re, why] of [
  [/#page-tools \.tool-card\s*\{/, '#page-tools .tool-card 覆盖块必须删除, 否则卡片被压成长条'],
  [/#page-tools \.tools-grid\s*\{/, '#page-tools .tools-grid 覆盖块必须删除, 否则网格变单列'],
  [/#page-tools \.tools-section\s*\{/, '#page-tools .tools-section 覆盖块必须删除, 否则分区标题变形'],
  [/#page-tools \.tool-info/, '#page-tools .tool-info 是行式布局遗留, 不应存在'],
  [/#page-tools \.tool-ctl/, '#page-tools .tool-ctl 是行式布局遗留, 不应存在'],
]) {
  assert.doesNotMatch(premiumCss, re, why);
}

// 行式布局的包装层也不该留在 HTML 里
assert.ok(!page.includes('class="tool-info"'), 'HTML 里不应再有 .tool-info 包装层');
assert.ok(!page.includes('class="tool-ctl"'), 'HTML 里不应再有 .tool-ctl 包装层');
assert.ok(!page.includes('class="tool-wide"'), 'HTML 里不应再有 .tool-wide 包装层');

// ---- 分类小标签 (1.5.63 起保留) ----
const navJs = fs.readFileSync('renderer/js/tools-nav.js', 'utf8');
const appJs = fs.readFileSync('renderer/js/app.js', 'utf8');

assert.ok(page.includes('id="toolsNav"'), '页头下要有分类标签容器 #toolsNav');
assert.ok(page.indexOf('id="toolsNav"') < page.indexOf('class="tools-grid"'), '分类标签要排在设置列表之前');

const sectionTags = page.match(/<div class="tools-section"[^>]*>/g) || [];
assert.strictEqual(sectionTags.length, sections.length, '每个分区标题都要带属性');
for (const tag of sectionTags) {
  assert.match(tag, /id="tools-sec-[\w-]+"/, `分区缺少锚点 id: ${tag}`);
  assert.match(tag, /data-cat="[^"]+"/, `分区缺少标签文字: ${tag}`);
}

assert.match(navJs, /querySelectorAll\('#page-tools \.tools-section'\)/, '标签要按分区现算, 不写死');
assert.match(navJs, /tools-nav-chip/, '要生成分类小标签');
assert.match(navJs, /data-target/, '标签要带跳转目标');
assert.match(navJs, /mainEl\.scrollTop\s*=/, '点标签要能跳到对应分区');
assert.match(navJs, /getBoundingClientRect\(\)\.top <= probe/, '滚动时要高亮当前分区');
assert.match(navJs, /window\.initToolsNav/, '要暴露 initToolsNav 给 switchPage 调用');
assert.match(appJs, /page === "tools"[\s\S]{0,400}initToolsNav\(\)/, '进工具箱页时要初始化分类标签');
assert.ok(html.includes('js/tools-nav.js?v='), 'tools-nav.js 要引入页面');

assert.match(premiumCss, /#page-tools \.tools-nav\s*\{[^}]*position:\s*sticky;/s, '分类标签要吸顶');
assert.match(premiumCss, /#page-tools \.tools-nav\s*\{[^}]*top:\s*0;/s, '吸在内容区顶部');
assert.match(premiumCss, /\.tools-nav-chip\s*\{[^}]*border-radius:\s*999px;/s, '标签要是胶囊形');
assert.match(premiumCss, /\.tools-nav-chip\.active\s*\{/, '当前分区的标签要有高亮态');
assert.match(premiumCss, /#page-tools \.tools-nav\.is-stuck\s*\{/, '滚动后标签条要出现分隔线');
assert.match(premiumCss, /body\.dark [^{]*\.tools-nav-chip\s*\{[^}]*border-color/s, '深色下标签描边要单独调');
// 全局 `button:not(...)` 有 6 个类选择器, 标签规则必须带 #page-tools 才压得住,
// 否则 min-height:38px / font-size:13px 会把"小标签"撑成普通按钮
assert.match(premiumCss, /#page-tools \.tools-nav \.tools-nav-chip\s*\{[^}]*min-height:\s*0;/s, '标签要显式清掉全局按钮的最小高度');

// ---- 结构重排不能丢控件 ----
for (const id of ['autoAcceptToggle', 'autoBPToggle', 'autoRuneToggle', 'autoHonorToggle', 'autoReconnectToggle',
  'benchAlertToggle', 'pickGuardToggle', 'gameTranslateToggle', 'friendNotifyToggle',
  'translateSendInput', 'voiceVolume', 'liveTipsState', 'pickGuardLock']) {
  assert.ok(page.includes(`id="${id}"`), `控件 ${id} 不能丢失`);
}

console.log(`工具箱测试通过 (${cards.length} 张卡片 + ${wideCards.length} 张跨列 · ${sections.length} 个分区 · 分类标签吸顶)`);
