// 1.6.24 回归: 符文悬浮卡片 (参照 LeagueAkari 的符文页: 图标 + 名称 + 本局结算文案)
// - 描述来源只有客户端 perks.json 是中文; ddragon 只有名称/图标 -> 拉不到时不能编造描述
// - 客户端给的结算是模板 ("总治疗量: @eogvar1@"), 数值来自该局 selection.var1..3
// - 老缓存战绩行没有 perkPage (只有 perkIds/perkStyles), 仍要能出卡片
// - 数据全缺时返回空串, 调用方据此不挂 hover, 而不是弹一个空壳
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync('renderer/js/utils.js', 'utf8');
const home = fs.readFileSync('renderer/js/home.js', 'utf8');
const hex = fs.readFileSync('renderer/js/hex.js', 'utf8');

// ---------- 静态断言 ----------
assert.ok(hex.includes('runePageCardHtml(p)'), '对局详情应渲染符文卡片');
assert.ok(hex.includes('runeHoverBind()'), '详情渲染后应绑定悬停事件');
assert.ok(src.includes('loadRuneMeta'), 'utils.js 应提供 loadRuneMeta');
assert.ok(src.includes("'/lol-game-data/assets/v1/perks.json'"), '描述应取自客户端 perks.json');
assert.ok(!/endOfGameStatDescs[^;]*\.replace\(\/\[<\]/.test(src), '不要用正则硬删尖括号内容');

// ---------- vm 沙箱: 注入图标/名称表后执行 utils.js ----------
const ctx = vm.createContext({
  console,
  localStorage: { getItem: () => null, setItem: () => {} },
  window: {},
  perkIconMap: {
    8010: 'perk-images/Styles/Precision/Conqueror/Conqueror.png',
    9111: 'perk-images/Styles/Resolve/Triumph/Triumph.png',
    8226: 'perk-images/Styles/Sorcery/ManaflowBand/ManaflowBand.png',
    8304: 'perk-images/Styles/Inspiration/MagicalFootwear/MagicalFootwear.png'
  },
  styleIconMap: {
    8000: 'perk-images/Styles/7201_Precision.png',
    8400: 'perk-images/Styles/7204_Resolve.png'
  },
  perkNameMap: { 8010: '征服者', 9111: '凯旋', 8226: '法力流系带', 8304: '神奇之鞋' },
  styleNameMap: { 8000: '精密', 8400: '坚决' }
});
vm.runInContext(src, ctx, { filename: 'utils.js' });
// 顶层 const 不会自动挂到 context 上, 显式导出 (拿到的是同一个对象, 改属性有效)
vm.runInContext('this.RUNE_META = RUNE_META;', ctx);

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('ok ' + pass + ' - ' + name); };

// ---------- 标签清洗 ----------
ok('stripLolTags 去标签保文字', () => {
  const raw = 'Gain <lol-uikit-tooltipped-keyword key=\'LinkTooltip_Desc\'>2 stacks</lol-uikit-tooltipped-keyword> for 5s<br>then heal &amp; shield';
  assert.strictEqual(ctx.stripLolTags(raw), 'Gain 2 stacks for 5s then heal & shield');
});
ok('stripLolTags 空值安全', () => {
  assert.strictEqual(ctx.stripLolTags(''), '');
  assert.strictEqual(ctx.stripLolTags(null), '');
  assert.strictEqual(ctx.stripLolTags(123), '');
});

// ---------- 本局结算文案 ----------
ctx.RUNE_META.perks = {
  8010: { name: '征服者', desc: '攻击敌方英雄叠加适应之力。', eog: ['总治疗量: @eogvar1@'] },
  9111: { name: '凯旋', desc: '参与击杀回复 5% 已损失生命。', eog: ['回复生命: @eogvar1@', '额外金币: @eogvar2@'] },
  8226: { name: '法力流系带', desc: '命中英雄永久提升最大法力值。', eog: [] }
};
ctx.RUNE_META.styles = { 8000: { name: '精密' }, 8400: { name: '坚决' } };
ctx.RUNE_META.ready = true;

ok('EOG 模板替换成实际数值', () => {
  assert.strictEqual(ctx.runeDescOf(8010, { v1: 1234 }), '总治疗量: 1,234');
});
ok('两个 var 都替换, 千分位分隔', () => {
  assert.strictEqual(ctx.runeDescOf(9111, { v1: 850, v2: 60 }), '回复生命: 850 · 额外金币: 60');
});
ok('缺失的 var 显示破折号而不是 NaN', () => {
  assert.strictEqual(ctx.runeDescOf(9111, { v1: 850 }), '回复生命: 850 · 额外金币: —');
});
ok('一个 var 都没有 (老缓存) 退回通用描述, 不显示一排破折号', () => {
  assert.strictEqual(ctx.runeDescOf(8010, null), '攻击敌方英雄叠加适应之力。');
  assert.strictEqual(ctx.runeDescOf(8010, { v1: null, v2: null, v3: null }), '攻击敌方英雄叠加适应之力。');
});
ok('没有 EOG 模板时退回一句话描述', () => {
  assert.strictEqual(ctx.runeDescOf(8226, { v1: 1 }), '命中英雄永久提升最大法力值。');
});
ok('完全没有元数据时返回空串, 不编造', () => {
  assert.strictEqual(ctx.runeDescOf(99999, { v1: 1 }), '');
});

// ---------- 卡片结构 ----------
const fullPage = {
  perkPage: {
    main: { styleId: 8000, sels: [{ id: 8010, v1: 1234 }, { id: 9111, v1: 850, v2: 60 }] },
    sub: { styleId: 8400, sels: [{ id: 8304 }] },
    stats: [5008, 5005, 5002]
  },
  perkIds: [8010, 9111, 8304],
  perkStyles: [8000, 8400],
  statPerks: [5008, 5005, 5002]
};

ok('卡片含主系名/副系名/属性', () => {
  const html = ctx.runePageCardHtml(fullPage);
  assert.ok(html.includes('征服者'), '缺少主系第一个符文名');
  assert.ok(html.includes('副系 坚决'), '缺少副系名');
  assert.ok(html.includes('自适应之力') && html.includes('攻击速度') && html.includes('护甲'), '缺少属性碎片名');
});
ok('卡片含本局数值文案', () => {
  const html = ctx.runePageCardHtml(fullPage);
  assert.ok(html.includes('总治疗量: 1,234'), '缺少本局治疗量');
  assert.ok(html.includes('额外金币: 60'), '缺少本局金币');
});
ok('卡片图标走 ddragon, 属性碎片有 StatMods 图标', () => {
  const html = ctx.runePageCardHtml(fullPage);
  assert.ok(html.includes('cdn/img/perk-images/Styles/Precision/Conqueror/Conqueror.png'), '符文图标缺失');
  assert.ok(html.includes('perk-images/StatMods/StatModsAdaptiveForceIcon.png'), '属性碎片图标缺失');
});
ok('主系 4 个 / 副系 2 个的层级区分', () => {
  const html = ctx.runePageCardHtml(fullPage);
  assert.ok(html.includes('rune-pop-item is-main'), '主系行缺少 class');
  assert.ok(html.includes('rune-pop-item is-sub'), '副系行缺少 class');
  assert.ok(html.includes('rune-pop-sep'), '主副系之间应有分隔');
});

// 老缓存: 没有 perkPage, 只有 perkIds/perkStyles
ok('老缓存 (无 perkPage) 仍能出卡片, 只是没有本局数值', () => {
  const html = ctx.runePageCardHtml({
    perkIds: [8010, 9111, 8304], perkStyles: [8000, 8400], statPerks: [5008]
  });
  assert.ok(html.includes('征服者'), '缺名称');
  assert.ok(html.includes('rune-pop-stats'), '缺属性碎片');
  assert.ok(!html.includes('总治疗量'), '没有 var 时不应出现数值文案');
});
ok('完全没有符文数据时返回空串', () => {
  assert.strictEqual(ctx.runePageCardHtml({}), '');
  assert.strictEqual(ctx.runePageCardHtml(null), '');
});

// ---------- 数据层: var 提取 (home.js 的 perkPageOf) ----------
const pgSrc = home.match(/function perkPageOf\(p\) \{[\s\S]*?\n\}/)[0];
const pgCtx = vm.createContext({});
vm.runInContext(pgSrc + '\nthis.perkPageOf = perkPageOf;', pgCtx);
const pageOf = pgCtx.perkPageOf;

ok('perkPageOf 提取 var1/var2/var3', () => {
  const p = {
    perks: {
      styles: [
        { style: 8000, selections: [{ perk: 8010, var1: 1234, var2: 0, var3: 0 }] },
        { style: 8400, selections: [{ perk: 8304 }] }
      ],
      statPerks: { offense: 5008, flex: 5005, defense: 5002 }
    }
  };
  const pg = pageOf(p);
  assert.strictEqual(pg.main.sels[0].v1, 1234);
  assert.strictEqual(pg.main.sels[0].v2, 0);
  assert.strictEqual(pg.sub.sels[0].v1, null, '缺 var 应为 null 而不是 0');
  assert.strictEqual(pg.statPerks.join(","), "5008,5005,5002");
});
ok('perkPageOf 兼容 LCU 的 stats.perks 结构', () => {
  const p = {
    stats: { perks: { styles: [{ style: 8000, selections: [{ perk: 8010, var1: 99 }] }], statPerks: { offense: 5008, flex: 5008, defense: 5001 } } }
  };
  const pg = pageOf(p);
  assert.strictEqual(pg.main.styleId, 8000);
  assert.strictEqual(pg.main.sels[0].v1, 99);
});
ok('perkPageOf 无数据时 main/sub 为 null', () => {
  const pg = pageOf({});
  assert.strictEqual(pg.main, null);
  assert.strictEqual(pg.sub, null);
  assert.strictEqual(pg.statPerks.length, 0);
});

console.log('\nPASS ' + pass + ' cases');
