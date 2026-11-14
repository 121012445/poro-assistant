'use strict';
// 「首页战绩卡强化偶尔不显示」回归:
//   hex.js 里对 hexAugMeta 只能合并, 不能整体替换 (替换会让"比内置表少的表"覆盖掉内置表,
//   首页查不到的 id 就被静默丢弃)。home.js 查表必须有内置表兜底。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..');
const hex = fs.readFileSync(path.join(SRC, 'renderer/js/hex.js'), 'utf8');
const home = fs.readFileSync(path.join(SRC, 'renderer/js/home.js'), 'utf8');

// 1) 合并函数存在, 且两处写入都走合并
assert.ok(/function mergeAugMeta\(/.test(hex), 'hex.js 缺 mergeAugMeta');
assert.ok(/hexAugMeta = mergeAugMeta\(meta\)/.test(hex), '网络路径必须合并而不是替换');
assert.ok(/hexAugMeta = mergeAugMeta\(cached\)/.test(hex), '缓存路径必须合并而不是替换');
assert.ok(!/hexAugMeta = meta;/.test(hex), '不允许再出现整体替换 hexAugMeta = meta');
assert.ok(!/hexAugMeta = cached;/.test(hex), '不允许再出现整体替换 hexAugMeta = cached');
// 缓存写回必须是合并后的表
assert.ok(/localStorage\.setItem\(HEX_AUG_META_CACHE_KEY, JSON\.stringify\(hexAugMeta\)\)/.test(hex),
  '缓存应写回合并后的表, 否则下次又读到小表');

// 2) 合并语义: 内置表打底, 新数据覆盖同 id 的**字段**（不是整条替换, 否则 local 会丢）
{
  const sandbox = {
    window: { PORO_AUG_META: {
      1: { name: '甲', icon: 'a.png', local: 'assets/aug/1.png', rarity: '棱彩' },
      2: { name: '乙', icon: 'b.png', local: 'assets/aug/2.png', rarity: '黄金' },
      3: { name: '丙', icon: 'c.png', local: 'assets/aug/3.png', rarity: '白银' }
    } },
    console
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  const m = hex.match(/function mergeAugMeta\(extra\) \{[\s\S]*?\n\}/);
  assert.ok(m, '抽不到 mergeAugMeta 实现');
  vm.runInContext(m[0], ctx);
  // 网络表里的条目**没有 local** —— 这正是真实情况
  const merged = vm.runInContext('mergeAugMeta({ 2: { name: "乙2", icon: "b2.png", rarity: "棱彩" } })', ctx);
  assert.strictEqual(Object.keys(merged).length, 3, '合并后应保留内置表的全部条目');
  assert.strictEqual(merged[1].name, '甲', '内置表独有的条目必须保留');
  assert.strictEqual(merged[2].name, '乙2', '同 id 的新字段应覆盖');
  assert.strictEqual(merged[2].icon, 'b2.png', '同 id 的 icon 应覆盖');
  assert.strictEqual(merged[2].local, 'assets/aug/2.png', '同 id 的 local 必须保住（不能因网络条目没有 local 就丢）');
  assert.strictEqual(merged[3].icon, 'c.png', '内置表独有的图标必须保留');
}

// 3) 首页查表兜底
assert.ok(/const m = \(hexAugMeta && hexAugMeta\[id\]\)/.test(home), '首页应先查运行时表');
assert.ok(/window\.PORO_AUG_META\[id\]/.test(home), '首页必须回退到内置表');

// 4) 首页渲染确实用了兜底后的 m
assert.ok(/if \(!m \|\| !m\.name \|\| !m\.icon\)/.test(home), '首页仍需在资料缺失时跳过该枚图标');
assert.ok(/bundledCount=/.test(home), '诊断行应带上内置表条目数');

// 5) 两条归一化分支都必须产出 augmentIds（LCU 那条以前是漏的）
assert.ok(/function augmentIdsOf\(p\)/.test(home), 'home.js 应把抠强化抽成 augmentIdsOf');
assert.strictEqual((home.match(/augmentIds: augmentIdsOf\(p\)/g) || []).length, 2,
  '两条归一化分支都要写 augmentIds（SGP 与 LCU/match-v5）');
{
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  const fn = home.match(/function augmentIdsOf\(p\) \{[\s\S]*?\n\}/);
  assert.ok(fn, '抽不到 augmentIdsOf 实现');
  vm.runInContext(fn[0], ctx);
  const run = expr => vm.runInContext(expr, ctx);
  // SGP 形状
  assert.strictEqual(JSON.stringify(run('augmentIdsOf({ playerAugment1: 101, playerAugment2: 202, playerAugment3: 0 })')), '[101,202]');
  // LCU/match-v5 形状: 强化放在 stats 下面
  assert.strictEqual(JSON.stringify(run('augmentIdsOf({ stats: { playerAugment1: 303, playerAugment2: 404 } })')), '[303,404]');
  // augments[] 数组（对象或纯 id）
  assert.strictEqual(JSON.stringify(run('augmentIdsOf({ augments: [{ id: 5 }, 6, { augmentId: 7 }] })')), '[5,6,7]');
  // 去重 + 空
  assert.strictEqual(JSON.stringify(run('augmentIdsOf({ playerAugment1: 9, augments: [9] })')), '[9]');
  assert.strictEqual(JSON.stringify(run('augmentIdsOf(null)')), '[]');
}

// 6) 图标包内优先: 596 张 png 打进包里, 外网只兜底
{
  const utils = fs.readFileSync(path.join(SRC, 'renderer/js/utils.js'), 'utf8');
  assert.ok(/function augFallback\(img\)/.test(utils), 'utils.js 缺 augFallback');
  assert.ok(/data-cdn/.test(home) && /augFallback\(this\)/.test(home), '首页图标应本地优先 + CDN 兜底');
  assert.ok(/const localSrc = m\.local \|\| \(bundled && bundled\.local\) \|\| ''/.test(home),
    '首页本地路径应双查 (运行时条目可能来自网络表, 没有 local)');
  assert.ok(/const augSrc = localSrc \|\| m\.icon/.test(home), '首页 src 应优先本地路径');
  // 三层兜底: 包内 -> CDN -> 主进程 dataURL
  assert.ok(/data-aug-id=/.test(home), '首页图标应带 data-aug-id');
  assert.ok(/_augDataUrlCache/.test(utils) && /augmentIconData/.test(utils), 'utils 应有主进程 dataURL 兜底');
  assert.ok(/img\.style\.background = 'transparent'/.test(utils), '全失败时应连底色一起收掉');

  const metaSrc = fs.readFileSync(path.join(SRC, 'renderer/assets/augments-meta.js'), 'utf8');
  const sandbox = { window: {} };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(metaSrc, ctx);
  const meta = vm.runInContext('window.PORO_AUG_META', ctx);
  const ids = Object.keys(meta);
  assert.ok(ids.length >= 590, '内置表条目异常: ' + ids.length);
  const noLocal = ids.filter(id => !meta[id].local);
  assert.strictEqual(noLocal.length, 0, '所有条目都应有 local 路径, 缺的: ' + noLocal.slice(0, 5).join(','));
  const missingFiles = ids.filter(id => !fs.existsSync(path.join(SRC, 'renderer', meta[id].local)));
  assert.strictEqual(missingFiles.length, 0, '本地图标文件缺失: ' + missingFiles.slice(0, 5).join(','));
  const augDir = path.join(SRC, 'renderer/assets/aug');
  const pngs = fs.readdirSync(augDir).filter(f => f.endsWith('.png'));
  assert.ok(pngs.length >= 590, 'assets/aug 里的图标数量异常: ' + pngs.length);
  // 抽查一张确实是 PNG
  const buf = fs.readFileSync(path.join(augDir, '1.png'));
  assert.strictEqual(buf.slice(1, 4).toString('ascii'), 'PNG', 'assets/aug/1.png 不是 PNG');
}

console.log('强化表合并 + 两条分支 + 本地图标（首页偶尔不显示）检查通过');
