// 1.6.23 回归: 对局详情显示完整符文页
// - normalizeGame 之前只留 "主系第一个符文 + 副系 id", 召唤师峡谷里看不到每个人带了什么
// - 现在保留 主系 4 + 副系 2 + 属性碎片 3, 详情页显示 6 个图标, 名称写进 title
// - SGP (perks 在顶层) 与 LCU match-v5 (perks 在 stats 下) 两种结构都要认
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const home = fs.readFileSync('renderer/js/home.js', 'utf8');
const hex = fs.readFileSync('renderer/js/hex.js', 'utf8');
const utils = fs.readFileSync('renderer/js/utils.js', 'utf8');
const app = fs.readFileSync('renderer/js/app.js', 'utf8');
const css = fs.readFileSync('renderer/css/style.css', 'utf8');

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('ok ' + pass + ' - ' + name); };

// ---------- 静态 ----------
ok('normalizeGame 两条分支都映射完整符文', () => {
  const hits = home.split('...perkPageFields(p),').length - 1;
  assert.ok(hits >= 2, 'SGP 与 LCU 分支都要调用 perkPageFields, 实际 ' + hits + ' 处');
  assert.ok(home.includes('function perkPageOf('), '缺少 perkPageOf');
  assert.ok(!/perkPrimary: p\.perks\?\.styles\?\.\[0\]\?\.selections\?\.\[0\]\?\.perk \|\| 0,/.test(home),
    'SGP 分支不应再手写只取第一个符文的映射');
});

ok('详情页渲染完整符文 + title', () => {
  assert.ok(hex.includes('p.perkIds'), '详情页应读 perkIds');
  assert.ok(hex.includes('runePageText(p)'), '详情页应把符文名称写进 title');
  assert.ok(hex.includes('ak-runecol'), '沿用 ak-runecol 容器');
  assert.ok(hex.includes('legacyRune'), '老缓存只有 perkPrimary 时要能退回单图标');
});

ok('战绩卡 title 也写完整符文页', () => {
  assert.ok(home.includes('const runeTip = typeof runePageText') && home.includes('ako-runecol"${runeTip'),
    '战绩卡符文列应带 title');
});

ok('符文名称表随图标一起加载', () => {
  assert.ok(app.includes('perkNameMap') && app.includes('styleNameMap'), 'app.js 应有名称表');
  assert.ok(app.includes("poro.perkMaps.v2"), '缓存 key 应升级, 否则老缓存没有名称');
  assert.ok(app.includes('perkNameMap[rune.id] = rune.name'), '加载时应写入符文名');
});

ok('CSS: 符文列改网格, 放得下 6 个', () => {
  assert.ok(/\.ak-runecol \{[^}]*grid-template-columns: repeat\(2, 12px\)/.test(css), '.ak-runecol 应为 2 列 12px 网格');
  assert.ok(/\.ak-rune \{[^}]*width: 12px/.test(css), '.ak-rune 应缩到 12px');
  assert.ok(!/\.ak-spell, \.ak-rune \{ width: 16px/.test(css), '技能图标与符文图标尺寸已分开, 不应再共用 16px 规则');
});

// ---------- vm: perkPageOf / perkPageFields ----------
const srcOf = (name, file) => {
  // 源码是 CRLF, 行尾一律写成 \r?\n
  const re = new RegExp('function ' + name + '\\(p\\) \\{[\\s\\S]*?\\r?\\n\\}\\r?\\n');
  const m = file.match(re);
  assert.ok(m, '没能从源码里取出 ' + name);
  return m[0];
};
const ctx = vm.createContext({ console });
vm.runInContext(srcOf('perkPageOf', home) + srcOf('perkPageFields', home), ctx, { filename: 'home.perks.js' });

// 一份真实的 match-v5 符文结构
const SGP_PERKS = {
  statPerks: { defense: 5002, flex: 5008, offense: 5005 },
  styles: [
    { description: 'primaryStyle', style: 8000, selections: [{ perk: 8005 }, { perk: 9111 }, { perk: 8009 }, { perk: 8014 }] },
    { description: 'subStyle', style: 8300, selections: [{ perk: 8306 }, { perk: 8347 }] }
  ]
};

ok('SGP 顶层 perks 解析出 6 符文 + 2 系 + 3 属性', () => {
  const pg = ctx.perkPageOf({ perks: SGP_PERKS });
  assert.deepStrictEqual(Array.from(pg.ids), [8005, 9111, 8009, 8014, 8306, 8347]);
  assert.deepStrictEqual(Array.from(pg.styleIds), [8000, 8300]);
  assert.deepStrictEqual(Array.from(pg.statPerks), [5005, 5008, 5002]);
});

ok('LCU match-v5 的 stats.perks 同样能解析', () => {
  const pg = ctx.perkPageOf({ stats: { perks: SGP_PERKS } });
  assert.strictEqual(pg.ids.length, 6, '应解析出 6 个符文, 实际 ' + pg.ids.length);
  assert.deepStrictEqual(Array.from(pg.styleIds), [8000, 8300]);
});

ok('字段 (perkPrimary / perkSub) 向后兼容', () => {
  const f = ctx.perkPageFields({ perks: SGP_PERKS });
  assert.strictEqual(f.perkPrimary, 8005, '主系基石仍是第一个符文');
  assert.strictEqual(f.perkSub, 8300, 'perkSub 仍是副系 id');
  assert.strictEqual(f.perkIds.length, 6);
});

ok('没有符文数据时不炸, 字段为 0 / 空数组', () => {
  const f = ctx.perkPageFields({ k: 1, d: 2, a: 3 });
  assert.deepStrictEqual(Array.from(f.perkIds), []);
  assert.strictEqual(f.perkPrimary, 0);
  assert.strictEqual(f.perkSub, 0);
  assert.deepStrictEqual(Array.from(f.statPerks), []);
});

ok('selections 是纯数字数组也能解析', () => {
  const pg = ctx.perkPageOf({ perks: { styles: [{ style: 8000, selections: [8005, 9111, 8009, 8014] }] } });
  assert.deepStrictEqual(Array.from(pg.ids), [8005, 9111, 8009, 8014]);
});

// ---------- vm: runePageText ----------
const uctx = vm.createContext({
  console,
  localStorage: { getItem: () => null, setItem: () => {} },
  window: {},
  perkNameMap: { 8005: '征服者', 9111: '凯旋', 8009: '传说：欢欣', 8014: '致命一击', 8306: '坚定', 8347: '骸骨镀层' },
  styleNameMap: { 8000: '精密', 8300: '坚决' }
});
vm.runInContext(utils, uctx, { filename: 'utils.js' });

ok('runePageText 输出主副系与属性名称', () => {
  const t = uctx.runePageText({ perkIds: [8005, 9111, 8009, 8014, 8306, 8347], perkStyles: [8000, 8300], statPerks: [5005, 5008, 5002] });
  assert.ok(t.includes('精密：征服者 / 凯旋 / 传说：欢欣 / 致命一击'), t);
  assert.ok(t.includes('副系 坚决：坚定 / 骸骨镀层'), t);
  assert.ok(t.includes('属性 攻击速度 / 自适应之力 / 护甲'), t);
});

ok('没有 perkIds 时返回空串 (不显示半截信息)', () => {
  assert.strictEqual(uctx.runePageText({ perkPrimary: 8005, perkSub: 8300 }), '');
  assert.strictEqual(uctx.runePageText(null), '');
});

ok('名称表缺失时退回 #id, 不崩', () => {
  const bare = vm.createContext({ console, localStorage: { getItem: () => null, setItem: () => {} }, window: {} });
  vm.runInContext(utils, bare, { filename: 'utils.bare.js' });
  const t = bare.runePageText({ perkIds: [8005, 9111, 8009, 8014], perkStyles: [8000, 8300], statPerks: [5008] });
  assert.ok(t.includes('#8005'), t);
  assert.ok(t.includes('自适应之力'), '属性碎片名称是本地常量, 不依赖网络表: ' + t);
});

console.log('\nPASS ' + pass + ' cases');
