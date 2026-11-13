// 1.5.150: 玩家卡头部重排 (ID 两行全宽显示) + 战绩折叠态每页固定 6 场
// 根因: premium.css 把 lp-info 排成 [identity|inline-stats] 横排, ARAM 徽章
// (flex:0 0 auto 不压缩) + 胜率块远超 identity 列宽, 名字被 flex-shrink 压到 0 宽。
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, 'renderer');
const live = fs.readFileSync(path.join(ROOT, 'js', 'live.js'), 'utf8');
const v4 = fs.readFileSync(path.join(ROOT, 'css', 'v4.css'), 'utf8');

// ---- live.js: 每页 6 场 ----
assert.ok(live.includes('const LIVE_RECENT_PAGE = 6'), '应定义折叠态每页 6 场常量');
assert.ok(live.includes('cards.forEach((el, i) => { if (i >= visible) el.hidden = true; })'), '超出页容量的场次应隐藏');
assert.ok(live.includes('const visible = Math.min(LIVE_RECENT_PAGE, fitRows, cards.length)'), '可见场次 = min(每页6, 容量, 数据)');
assert.ok(live.includes("cards.forEach(el => { el.hidden = false; })"), '每次重算先复位隐藏 (展开态/窗口变化)');

// ---- live.js: 提示行可点展开, 文案随展开态切换 ----
assert.ok(live.includes('lp-recent-hint is-more'), '折叠态提示行应带 is-more 可点类');
assert.ok(live.includes("onclick=\"event.stopPropagation();toggleLiveRecentExpanded(true)\""), '提示行点击应展开全部战绩且不冒泡到抽屉');
assert.ok(live.includes("if (expanded) return `<div class=\"lp-recent-hint\">共 ${total} 场</div>`;"), '展开态提示行只交代总量');

// ---- live.js: 头部重排 ----
const head = live.slice(live.indexOf('1.5.150: 头部重排'), live.indexOf('lp-profile-line">${pills}'));
assert.ok(head.includes('<div class="lp-name-line"><span class="lp-name lp-name-link"'), '名字应独占 name-line (不与徽章同排)');
assert.ok(!head.includes('</span>${tag}${balanceHtml}${marksHtml}</div>\n            <div class="lp-rank">'), '名字行不应再携带徽章 (旧排版)');
assert.ok(head.includes('<div class="lp-rank">${inlineStats}${escapeHtml(p.rank'), '胜率/KDA 应下沉到段位行');
assert.ok(head.includes('${tag}${balanceHtml}${marksHtml}</div>'), '自己/平衡性/T级/标记徽章应挪到段位行尾部');

// ---- live.js: 展开切换后提示行重刷 ----
assert.ok(live.includes('syncLiveRecentHint(row, p);\n  });\n  scheduleLiveRowAlignment();'), '展开/收起后应按新态重刷各行提示');

// ---- v4.css: 名字两行 + 隐藏恢复 + 渐隐退役 ----
assert.ok(v4.includes('-webkit-line-clamp: 2;'), '名字应两行截断 (line-clamp 2)');
assert.ok(v4.includes('#page-live .ri-card[hidden] { display: none; }'), '作者样式 display:grid 会压过 UA [hidden], 必须显式恢复');
assert.ok(v4.includes('#page-live .lp-row:has(.ri-card:nth-child(9))::after { opacity: 0; }'), '分页模式下卡底渐隐应退役');
assert.ok(v4.includes('#page-live .lp-recent-hint.is-more { pointer-events: auto; cursor: pointer; }'), '可点提示行需恢复 pointer-events');
assert.ok(v4.includes('#page-live .lp-info { display: flex; flex-direction: column; gap: 0; }'), 'lp-info 应改纵排, identity 独占全宽');
assert.ok(v4.includes('#page-live .lp-rank .lp-inline-stats'), '段位行内的胜率块需单独排版覆盖');

console.log('test_live_id_display: all assertions passed');
