'use strict';
// 工具箱页结构: 一行一个设置 (左标题+说明 / 右控件), 而不是瀑布流卡片。
// 1.5.62 之前是 26 张卡片铺 4 列, 高度参差、说明 5~6 行, 扫不出重点。
const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('renderer/index.html', 'utf8');
const css = fs.readFileSync('renderer/css/premium.css', 'utf8');

const start = html.indexOf('id="page-tools"');
const end = html.indexOf('<!-- 海斗强化资料 -->', start);
const page = html.slice(start, end > start ? end : html.length);

const cards = page.match(/class="tool-card"/g) || [];
const infos = page.match(/class="tool-info"/g) || [];
const ctls = page.match(/class="tool-ctl"/g) || [];
const sections = page.match(/class="tools-section"/g) || [];

assert.ok(cards.length >= 20, `工具箱应有 20 个以上的设置行, 实际 ${cards.length}`);
assert.strictEqual(infos.length, cards.length, '每个设置行都要有 .tool-info (左栏标题+说明)');
assert.strictEqual(ctls.length, cards.length, '每个设置行都要有 .tool-ctl (右栏控件)');
assert.ok(sections.length >= 4, `应保留分区标题, 实际 ${sections.length}`);

// 行式布局: 卡片本身不再是独立卡片 (无边框/背景), 而是靠下细线分隔
assert.match(css, /#page-tools \.tool-card\s*\{[^}]*display:\s*grid;/s, '设置行应为两列网格');
assert.match(css, /#page-tools \.tool-card\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(/s, '左栏自适应 + 右栏固定宽度');
assert.match(css, /#page-tools \.tool-card\s*\{[^}]*border:\s*0;/s, '设置行不应再画卡片边框');
assert.match(css, /#page-tools \.tool-card\s*\{[^}]*border-bottom:\s*1px solid/s, '设置行之间用细线分隔');
assert.match(css, /#page-tools \.tools-grid\s*\{[^}]*display:\s*block;/s, '分区列表应为单列, 不再是 auto-fill 网格');
assert.match(css, /#page-tools \.tool-info p\s*\{[^}]*max-height:\s*34px;/s, '说明默认压两行 (悬停展开)');

// 深色下细线要单独提亮, 否则整页糊成一块
assert.match(css, /body\.dark #page-tools \.tool-card\s*\{[^}]*border-bottom-color/s, '深色下需单独提亮行分隔线');
assert.match(css, /body\.dark #page-tools \.tools-section\s*\{[^}]*border-bottom-color/s, '深色下需单独提亮分区线');

// ---- 分类小标签 (1.5.63) ----
// 26 个设置平铺一页, 没有分类标签就只能靠滚轮瞎找。
const navJs = fs.readFileSync('renderer/js/tools-nav.js', 'utf8');
const appJs = fs.readFileSync('renderer/js/app.js', 'utf8');

assert.ok(page.includes('id="toolsNav"'), '页头下要有分类标签容器 #toolsNav');
assert.ok(page.indexOf('id="toolsNav"') < page.indexOf('class="tools-grid"'), '分类标签要排在设置列表之前');

// 每个分区都要能被标签定位: 有 id 给锚点、有 data-cat 给标签文字
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

// 标签贴在滚动容器顶部, 否则一滚就跟着走了
assert.match(css, /#page-tools \.tools-nav\s*\{[^}]*position:\s*sticky;/s, '分类标签要吸顶');
assert.match(css, /#page-tools \.tools-nav\s*\{[^}]*top:\s*0;/s, '吸在内容区顶部');
assert.match(css, /\.tools-nav-chip\s*\{[^}]*border-radius:\s*999px;/s, '标签要是胶囊形');
assert.match(css, /\.tools-nav-chip\.active\s*\{/, '当前分区的标签要有高亮态');
assert.match(css, /\.tools-nav\.is-stuck\s*\{|#page-tools \.tools-nav\.is-stuck\s*\{/, '滚动后标签条要出现分隔线');
assert.match(css, /body\.dark [^{]*\.tools-nav-chip\s*\{[^}]*border-color/s, '深色下标签描边要单独调');
// 全局 `button:not(...)` 有 6 个类选择器, 标签规则必须带 #page-tools 才压得住,
// 否则 min-height:38px / font-size:13px 会把"小标签"撑成普通按钮
assert.match(css, /#page-tools \.tools-nav \.tools-nav-chip\s*\{[^}]*min-height:\s*0;/s, '标签要显式清掉全局按钮的最小高度');

// 结构重排不能丢控件: 抽查各分区的关键开关仍在页内
for (const id of ['autoAcceptToggle', 'autoBPToggle', 'autoRuneToggle', 'autoHonorToggle', 'autoReconnectToggle',
  'benchAlertToggle', 'pickGuardToggle', 'commentaryToggle', 'gameTranslateToggle', 'friendNotifyToggle',
  'translateSendInput', 'commentaryVolume', 'pickGuardLock']) {
  assert.ok(page.includes(`id="${id}"`), `控件 ${id} 不能在重排中丢失`);
}

console.log(`工具箱行式布局测试通过 (${cards.length} 个设置行 · ${sections.length} 个分区 · 左文右控件 · 分类标签吸顶)`);
