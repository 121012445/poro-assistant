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

// 结构重排不能丢控件: 抽查各分区的关键开关仍在页内
for (const id of ['autoAcceptToggle', 'autoBPToggle', 'autoRuneToggle', 'autoHonorToggle', 'autoReconnectToggle',
  'benchAlertToggle', 'pickGuardToggle', 'commentaryToggle', 'gameTranslateToggle', 'friendNotifyToggle',
  'translateSendInput', 'commentaryVolume', 'pickGuardLock']) {
  assert.ok(page.includes(`id="${id}"`), `控件 ${id} 不能在重排中丢失`);
}

console.log(`工具箱行式布局测试通过 (${cards.length} 个设置行 · ${sections.length} 个分区 · 左文右控件)`);
