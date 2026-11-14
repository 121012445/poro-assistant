'use strict';
// 实时页卡头布局回归（Akari 对局面板的信息层级）：
//   头像 → 名字一行（自己/平衡性/标记徽章同行）→ 段位+闪现一行 → 胜率/KDA 一行。
// 锁住三件事：
//   1) 胜率/KDA 是 .lp-identity 里段位行下面的独立一行（不放右侧抢宽度，也不塞进段位行）；
//   2) 段位行只剩段位 + 闪现，徽章已经并在名字行；
//   3) 局部刷新依赖的 .lp-winrate / .lp-kda / .lp-flash-slot 选择器仍然存在；
//   4) 所有资源 ?v= 戳一致（改了 css/js 不换戳 = 应用还在跑旧文件，这个坑踩过一次）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const live = fs.readFileSync(path.join(SRC, 'renderer/js/live.js'), 'utf8');
const css = fs.readFileSync(path.join(SRC, 'renderer/css/v4.css'), 'utf8');
const html = fs.readFileSync(path.join(SRC, 'renderer/index.html'), 'utf8');

// 1) 结构: inlineStats 在 .lp-identity 内、.lp-rank 之后
assert.ok(/\$\{inlineStats\}/.test(live), '卡头必须有 inlineStats 插槽');
const identityBlock = (live.match(/<div class="lp-identity">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/) || [])[1] || '';
assert.ok(identityBlock.includes('lp-name-line') && identityBlock.includes('lp-rank'), '找不到身份区结构');
assert.ok(identityBlock.includes('${inlineStats}'), 'inlineStats 必须在 .lp-identity 内（段位行下面一行）');
assert.ok(identityBlock.indexOf('${inlineStats}') > identityBlock.indexOf('lp-rank'), 'inlineStats 必须排在段位行之后');

// 2) 段位行不再包含胜率；徽章并入名字行
const rankLine = (live.match(/<div class="lp-rank">([^\n]*)<\/div>/) || [])[1] || '';
assert.ok(rankLine, '找不到 .lp-rank 行');
assert.ok(!rankLine.includes('inlineStats'), '.lp-rank 里不应再有 inlineStats');
assert.ok(rankLine.includes('lp-flash-slot'), '段位行应保留闪现');
assert.ok(rankLine.includes('lp-tier'), '段位行应保留段位');

const nameLine = (live.match(/<div class="lp-name-line">([^\n]*)<\/div>/) || [])[1] || '';
assert.ok(nameLine.includes('lp-name'), '名字行丢了名字');
assert.ok(nameLine.includes('${tag}'), '「自己」徽章应在名字行');
assert.ok(nameLine.includes('${balanceHtml}') && nameLine.includes('${marksHtml}'), '平衡性/标记徽章应在名字行');

// 3) 局部刷新依赖的选择器仍在
assert.ok(/querySelector\('\.lp-winrate'\)/.test(live), 'updateLivePlayerRow 要用 .lp-winrate 局部更新');
assert.ok(/querySelector\('\.lp-kda'\)/.test(live), 'updateLivePlayerRow 要用 .lp-kda 局部更新');
assert.ok(/querySelector\('\.lp-flash-slot'\)/.test(live), 'updateLivePlayerRow 要用 .lp-flash-slot 局部更新');

// 4) 样式
assert.ok(css.includes('27. 卡头对齐 Akari 对局面板'), 'v4.css 缺第 27 节（Akari 式卡头）');
assert.ok(/#page-live \.lp-identity > \.lp-inline-stats \{ display: flex; flex-direction: row/.test(css),
  '胜率/KDA 应为段位行下面的横向一行');
assert.ok(/#page-live \.lp-inline-stats \.lp-winrate \{ font-size: 16px/.test(css), '胜率字号应为 16px');
assert.ok(/#page-live \.lp-rank \{ width: auto; padding: 0; background: none; border: 0; border-radius: 0; \}/.test(css),
  '段位行必须复位成普通文字行（去掉 §20.5 的胶囊）');
assert.ok(/#page-live \.lp-rank \.lp-tier \{ background: none/.test(css), '段位应去掉胶囊底色');
// 旧的"右侧一列"规则必须清理干净, 否则会和新的横向一行打架
assert.ok(!/#page-live \.lp-card-head > \.lp-inline-stats/.test(css), '旧的"右侧数字列"规则应已删除');

// 5) 缓存戳一致
{
  const stamps = [...html.matchAll(/\?v=(\d+)/g)].map(m => m[1]);
  assert.ok(stamps.length > 30, 'index.html 资源戳数量异常');
  const unique = [...new Set(stamps)];
  assert.strictEqual(unique.length, 1, '所有资源戳必须一致（同一次构建），实际: ' + unique.join(','));
}

// 6) 卡片视觉 v2: 标签必须是低饱和同色底（高饱和实底是"不如 Akari 好看"的主因）
assert.ok(css.includes('28. 卡片视觉 v2'), 'v4.css 缺第 28 节（卡片视觉 v2）');
assert.ok(/\.lp-metric,[\s\S]{0,420}?background: color-mix\(in srgb, var\(--pill-c\) 12%, transparent\)/.test(css),
  '指标标签应为低饱和同色底');
assert.ok(/#page-live \.ri-card \{[\s\S]{0,160}?flex: 0 0 28px/.test(css), '战绩行应统一 28px');
assert.ok(/#page-live \.lp-habit \{[\s\S]{0,160}?border: 0/.test(css), '习惯标签应去掉虚线边框');

// 7) 空位占位卡: 必须是"透明+虚线+无阴影", 且规则排在 .lp-row 白底之后（顺序决定谁生效）
{
  const iRowBg = css.indexOf('#page-live .lp-row {');
  const iEmpty = css.indexOf('#page-live .lp-row.lp-empty {');
  assert.ok(iRowBg > 0 && iEmpty > 0, '找不到 .lp-row / .lp-empty 规则');
  assert.ok(iEmpty > iRowBg, '.lp-empty 规则必须排在 .lp-row 白底之后，否则空位会被刷成白卡片');
  const block = css.slice(iEmpty, css.indexOf('}', iEmpty));
  assert.ok(/background: transparent/.test(block), '空位必须是透明底');
  assert.ok(/box-shadow: none/.test(block), '空位不能有阴影');
  assert.ok(/dashed/.test(block), '空位应为虚线边');
}

// 8) 玻璃质感: 卡面必须是"半透明 + 模糊 + 高光边", 但空位不能跟着变玻璃
{
  assert.ok(css.includes('29. 卡片玻璃质感'), 'v4.css 缺第 29 节（玻璃质感）');
  const iGlass = css.indexOf('29. 卡片玻璃质感');
  const glassBlock = css.slice(iGlass, iGlass + 1600);
  assert.ok(/backdrop-filter: blur\(\d+px\) saturate\(/.test(glassBlock), '卡面应有 backdrop-filter 模糊');
  assert.ok(/inset 0 1px 0 rgba\(255, 255, 255/.test(glassBlock), '卡面应有顶部内高光（玻璃厚边）');
  assert.ok(/border-radius: 14px/.test(glassBlock), '玻璃卡圆角应为 14px');
  // 空位必须显式取消玻璃, 否则空位会变成一张"磨砂实体卡"
  const iEmptyGlass = css.indexOf('#page-live .lp-row.lp-empty {', iGlass);
  assert.ok(iEmptyGlass > iGlass, '第 29 节里必须有空位的玻璃覆盖规则');
  const emptyGlassBlock = css.slice(iEmptyGlass, css.indexOf('}', iEmptyGlass));
  assert.ok(/backdrop-filter: none/.test(emptyGlassBlock), '空位必须取消 backdrop-filter');
  assert.ok(/background: transparent/.test(emptyGlassBlock), '空位必须透明');
}

// 9) 战绩列表卡内滚动: 不再按容量隐藏行, 溢出交给 overflow-y
{
  assert.ok(css.includes('30. 战绩列表卡内滚动'), 'v4.css 缺第 30 节（卡内滚动）');
  const iScroll = css.indexOf('30. 战绩列表卡内滚动');
  const block = css.slice(iScroll, iScroll + 900);
  assert.ok(/overflow-y: auto/.test(block), '.lp-recent 必须可纵向滚动');
  assert.ok(/min-height: 0/.test(block), '.lp-recent 必须写 min-height:0（否则 flex 子项撑破卡片, 滚不动）');
  assert.ok(/::-webkit-scrollbar \{ width: 6px/.test(block), '滚动条必须可见（style.css 里原本把它设成 0 宽）');
  // 只看 alignLiveRecentRows 函数体, 别处（浮窗）还有合法的 hidden = true
  const fnMatch = live.match(/function alignLiveRecentRows\(\) \{[\s\S]*?\n\}/);
  assert.ok(fnMatch, '找不到 alignLiveRecentRows');
  assert.ok(!/hidden = true/.test(fnMatch[0]), 'alignLiveRecentRows 不能再隐藏超出容量的行');
  assert.ok(!/is-more" onclick/.test(live), '提示行不应再是"点击展开"的入口');
}

// 10) ID 可见性: 名字不许被压成 0 宽; 内容再多也只能在列表内滚动
{
  assert.ok(css.includes('31. 玩家 ID 必须可见'), 'v4.css 缺第 31 节（ID 可见性）');
  const i = css.indexOf('31. 玩家 ID 必须可见');
  const block = css.slice(i, i + 1400);
  assert.ok(/\.lp-name \{\n  flex: 1 1 auto;/.test(block), '名字必须 flex:1 1 auto（不能被压成 0 宽）');
  assert.ok(/min-width: 44px;/.test(block), '名字必须有最小宽度兜底');
  assert.ok(/display: block;/.test(block), '名字应用 block + ellipsis（不依赖 -webkit-box）');
  assert.ok(/\.lp-recent \{ flex: 1 1 0; min-height: 0; \}/.test(block), '列表必须 flex:1 1 0，严格吃掉剩余高度');
  // 提示行已去掉: liveRecentHint 必须返回空串（注释里提到文案不算）
  assert.ok(/function liveRecentHint\(\) \{\s*\n\s*return '';\s*\n\}/.test(live),
    'liveRecentHint 应返回空串（底部提示行已移除）');
}

console.log('实时页卡头（Akari 式 + 玻璃 + 空位 + 卡内滚动 + ID 可见）检查通过');
