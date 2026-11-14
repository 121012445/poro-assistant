'use strict';
// 战报卡「本局强化」的渲染测试。
// 数据链: SGP SUMMARY 的 playerAugment1-6 → normalizeGame.augmentIds → battle-card 的强化行。
// 这里直接跑 battle-card 的 build()，断言: 有强化才出这一行 / 名称与图标正确 / 斗魂改标题 / 无资料时不糊弄。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..');

const sandbox = {
  console,
  window: {},
  champNumMap: { '64': { id: 'LeeSin', name: '盲僧' } },
  champImg: id => 'https://ddragon.leagueoflegends.com/cdn/15.1.1/img/champion/' + id + '.png',
  placeholder: () => 'placeholder.png',
  escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  version: '15.1.1',
  hexAugMeta: {
    101: { name: '质变：棱彩阶', icon: 'https://raw.communitydragon.org/latest/aug/101.png' },
    102: { name: '泰坦的坚决', icon: 'https://raw.communitydragon.org/latest/aug/102.png' },
    103: { name: '双刀流', icon: '' }
  },
  loadHexAugments: async () => true
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.window = sandbox;
const context = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(SRC, 'renderer/js/battle-card.js'), 'utf8'), context);
const build = vm.runInContext('window.PoroBattleCard.build', context);

function game(over) {
  const me = {
    puuid: 'me', teamId: 100, championId: 64, championName: '盲僧', position: 'JUNGLE',
    k: 9, d: 3, a: 11, cs: 180, gold: 12000, dmg: 24000, dmgTaken: 20000, visionScore: 22,
    win: true, items: [3031, 3006], augmentIds: over.augmentIds || [], level: 13
  };
  const mates = [me, { puuid: 'a', teamId: 100, championId: 1, k: 3, d: 5, a: 6 }, { puuid: 'b', teamId: 100, championId: 2, k: 2, d: 4, a: 9 }];
  const foes = [{ puuid: 'x', teamId: 200, championId: 3, k: 4, d: 6, a: 3 }];
  return { mode: over.mode || '海克斯大乱斗', dur: 1500, time: 1700000000000, participants: [...mates, ...foes] };
}

// 1) 有强化 -> 出海克斯标题 + 名称 + CommunityDragon 图标
{
  const html = build(game({ augmentIds: [101, 102, 103] }), 'me');
  assert.ok(html.includes('bc-augs'), '应渲染强化行');
  assert.ok(html.includes('海克斯强化'), '海斗应标「海克斯强化」');
  assert.ok(html.includes('质变：棱彩阶') && html.includes('泰坦的坚决'), '应显示强化名称');
  assert.ok(html.includes('https://raw.communitydragon.org/latest/aug/101.png'), '应使用 CommunityDragon 图标');
  assert.ok(html.includes('bc-aug-icon'), '应带图标样式类');
  // 第 3 个没有图标 -> 只出名称, 不能出现空 img
  assert.ok(!/<img class="bc-aug-icon" src="" alt=""/.test(html), '没有图标的强化不应输出空 img');
}

// 2) 斗魂 -> 标题改「斗魂强化」
{
  const html = build(game({ mode: '斗魂竞技场', augmentIds: [101] }), 'me');
  assert.ok(html.includes('斗魂强化'), '斗魂应标「斗魂强化」');
}

// 3) 没有强化 (峡谷/普通对局) -> 整行不出现
{
  const html = build(game({ mode: '召唤师峡谷', augmentIds: [] }), 'me');
  assert.ok(!html.includes('bc-augs'), '没有强化数据时不得出现强化行');
}

// 4) 强化 id 存在但元数据没加载 -> 不显示 #123 这种占位
{
  const saved = sandbox.hexAugMeta;
  sandbox.hexAugMeta = {};
  const html = build(game({ augmentIds: [101] }), 'me');
  assert.ok(!html.includes('bc-augs'), '元数据缺失时应整行不显示');
  assert.ok(!html.includes('#101'), '不得把 id 当名称显示');
  sandbox.hexAugMeta = saved;
}

// 5) 最多 6 个 (接口上限), 多余的忽略
{
  const html = build(game({ augmentIds: [101, 102, 103, 101, 102, 101, 103] }), 'me');
  const icons = (html.match(/class="bc-aug"/g) || []).length;
  assert.ok(icons <= 6, '强化最多展示 6 个, 实际 ' + icons);
}

// 6) normalizeGame 必须把 playerAugment1-6 映射成 augmentIds (静态检查: home.js 里那条链路)
{
  const homeSrc = fs.readFileSync(path.join(SRC, 'renderer/js/home.js'), 'utf8');
  assert.ok(/playerAugment/.test(homeSrc), 'normalizeGame 必须读取 playerAugment1-6');
  // 1.5.162: 抠强化抽成了 augmentIdsOf(p), 两条归一化分支共用 (LCU 那条以前是漏的)
  assert.ok(/function augmentIdsOf\(p\)/.test(homeSrc), 'normalizeGame 需要 augmentIdsOf 帮手');
  assert.strictEqual((homeSrc.match(/augmentIds: augmentIdsOf\(p\)/g) || []).length, 2,
    'SGP 与 LCU/match-v5 两条分支都必须产出 augmentIds');
}

// 7) 离屏渲染的 CSP 必须放行 CommunityDragon, 否则导出图里强化图标全空
{
  const mainSrc = fs.readFileSync(path.join(SRC, 'main/index.js'), 'utf8');
  assert.ok(/img-src data: https:\/\/ddragon\.leagueoflegends\.com https:\/\/raw\.communitydragon\.org/.test(mainSrc),
    'share card 的 CSP 需放行 raw.communitydragon.org');
}

// 8) 卡片样式必须随导出一同注入 (premium.css 在 shareCardCss 的白名单里)
{
  const css = fs.readFileSync(path.join(SRC, 'renderer/css/premium.css'), 'utf8');
  assert.ok(css.includes('.bc-aug-icon') && css.includes('.bc-augs-label'), 'premium.css 缺强化行样式');
  const mainSrc = fs.readFileSync(path.join(SRC, 'main/index.js'), 'utf8');
  assert.ok(/for \(const f of \['style\.css', 'extras\.css', 'dark\.css', 'premium\.css'/.test(mainSrc),
    'shareCardCss 必须注入 premium.css (卡片样式所在)');
}

// 8.5) 内置强化元数据 (随包分发): 启动即可用, 不依赖网络/localStorage
{
  const metaPath = path.join(SRC, 'renderer/assets/augments-meta.js');
  assert.ok(fs.existsSync(metaPath), '缺 renderer/assets/augments-meta.js (内置强化表)');
  const metaSandbox = { window: {} };
  metaSandbox.globalThis = metaSandbox;
  const metaCtx = vm.createContext(metaSandbox);
  vm.runInContext(fs.readFileSync(metaPath, 'utf8'), metaCtx);
  const bundled = vm.runInContext('window.PORO_AUG_META', metaCtx);
  const ids = Object.keys(bundled || {});
  assert.ok(ids.length >= 500, '内置强化表条目过少: ' + ids.length);
  const noIcon = ids.filter(id => !bundled[id].icon);
  assert.deepStrictEqual(noIcon, [], '内置表里这些强化没有图标地址: ' + noIcon.slice(0, 5).join(','));
  const noName = ids.filter(id => !bundled[id].name);
  assert.deepStrictEqual(noName, [], '内置表里这些强化没有名称');

  const html = fs.readFileSync(path.join(SRC, 'renderer/index.html'), 'utf8');
  const iMeta = html.indexOf('assets/augments-meta.js');
  const iHex = html.indexOf('js/hex.js?v=');
  assert.ok(iMeta > 0, 'index.html 没有加载内置强化表');
  assert.ok(iMeta < iHex, '内置强化表必须在 hex.js 之前加载');
  const hexSrc = fs.readFileSync(path.join(SRC, 'renderer/js/hex.js'), 'utf8');
  assert.ok(/let hexAugMeta = \(typeof window !== 'undefined' && window\.PORO_AUG_META\)/.test(hexSrc),
    'hex.js 的 hexAugMeta 必须用内置表初始化');
  const homeSrc = fs.readFileSync(path.join(SRC, 'renderer/js/home.js'), 'utf8');
  assert.ok(homeSrc.includes('function homeEnsureAugMeta'), '首页缺强化表兜底函数');
}

// 9) 图标要内联成 dataURL: 离屏窗口只等 600ms, 外链来不及下载就是"有名字没图标"
//    (异步部分放在 IIFE 里, 避免整份文件被 Node 当成 ESM)
(async () => {
  const warmAugmentIcons = vm.runInContext('window.PoroBattleCard.warmAugmentIcons', context);
  const fetched = [];
  sandbox.fetch = async (url) => {
    fetched.push(url);
    return { ok: true, blob: async () => ({ type: 'image/png' }) };
  };
  sandbox.FileReader = class {
    readAsDataURL() { this.result = 'data:image/png;base64,AAAA'; setTimeout(() => this.onload && this.onload(), 0); }
  };
  const norm = game({ augmentIds: [101, 102] });
  await warmAugmentIcons(norm);
  assert.ok(fetched.length >= 1, '应真的去抓图标');
  const html = build(norm, 'me');
  assert.ok(html.includes('src="data:image/png;base64,AAAA"'), 'warm 之后卡片应内联 dataURL 图标');
  assert.ok(!html.includes('src="https://raw.communitydragon.org/latest/aug/101.png"'), '不应再引外链');
  delete sandbox.fetch;
  delete sandbox.FileReader;

  // 10) 首页战绩卡片也要展示强化图标
  const homeSrc = fs.readFileSync(path.join(SRC, 'renderer/js/home.js'), 'utf8');
  assert.ok(homeSrc.includes('ako-augs'), '首页战绩卡片缺强化图标容器');
  assert.ok(/augmentIds/.test(homeSrc) && /class="ako-aug"/.test(homeSrc), '首页卡片要读 augmentIds 并渲染 ako-aug');
  const css = fs.readFileSync(path.join(SRC, 'renderer/css/premium.css'), 'utf8');
  assert.ok(css.includes('.ako-aug {'), 'premium.css 缺首页强化图标样式');

  // 11) 强化小图标是纯白剪影: 必须垫稀有度底色, 否则白底卡片上完全看不见
  {
    const battleSrc = fs.readFileSync(path.join(SRC, 'renderer/js/battle-card.js'), 'utf8');
    assert.ok(battleSrc.includes('AUG_RARITY_BG'), '战报卡缺稀有度色表');
    assert.ok(/const bgStyle = augBg\(m\.rarity\)/.test(battleSrc), '战报卡图标必须带稀有度底色');
    assert.ok(homeSrc.includes("'棱彩': 'linear-gradient"), '首页图标必须带稀有度底色 (棱彩用渐变)');
    // 真实渲染一次: 图标必须带 background 样式
    const norm = game({ augmentIds: [101, 102] });
    const out = build(norm, 'me');
    assert.ok(/class="bc-aug-icon" style="background:#[0-9a-f]{6};"/.test(out),
      '渲染结果里图标应带 background 样式, 实际: ' + (out.match(/class="bc-aug-icon"[^>]*/) || [''])[0].slice(0, 120));
    // 棱彩要用渐变
    sandbox.hexAugMeta = Object.assign({}, sandbox.hexAugMeta, { 103: { name: '双刀流', icon: 'https://x/y.png', rarity: '棱彩' } });
    const prism = build(game({ augmentIds: [103] }), 'me');
    assert.ok(/style="background:linear-gradient\(135deg/.test(prism), '棱彩强化应使用渐变底色');
  }

  console.log('战报卡「本局强化」测试通过');
})().catch(e => { console.error(e); process.exit(1); });
