'use strict';
// 英雄头像两级兜底 (ddragon → CommunityDragon → 占位图) 与战绩卡片图片的懒加载。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const champSrc = fs.readFileSync('renderer/js/champions.js', 'utf8');
const homeSrc = fs.readFileSync('renderer/js/home.js', 'utf8');
const liveSrc = fs.readFileSync('renderer/js/live.js', 'utf8');
const utilsSrc = fs.readFileSync('renderer/js/utils.js', 'utf8');

const sliceBetween = (src, from, to) => {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `定位失败: ${from} → ${to}`);
  return src.slice(a, b);
};

const context = vm.createContext({
  console,
  CDG: 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default',
  allChampions: {
    Aatrox: { key: '266', name: '亚托克斯', image: { full: 'Aatrox.png' } },
    Weird: { key: 'abc', name: '怪', image: { full: 'Weird.png' } },
    NoKey: { name: '无键', image: { full: 'NoKey.png' } }
  }
});
vm.runInContext(sliceBetween(utilsSrc, 'function escapeHtml', '\n}\n') + '\n}', context);
vm.runInContext(sliceBetween(champSrc, 'function champIconAlt', 'function filterChampions'), context);
const run = code => vm.runInContext(code, context);

// 模拟 <img>: dataset + src + onerror
const makeImg = (cdg, src = 'https://ddragon.leagueoflegends.com/cdn/x/img/champion/Aatrox.png') =>
  ({ dataset: cdg === undefined ? {} : { cdg }, src, onerror: () => {} });
const PH = 'data:image/svg+xml,PLACEHOLDER';

// 1) 兜底地址: 只对有纯数字 key 的英雄生成
assert.strictEqual(run("champIconAlt('Aatrox')"),
  'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/266.png');
assert.strictEqual(run("champIconAlt('Weird')"), '', 'key 不是纯数字时不得拼地址');
assert.strictEqual(run("champIconAlt('NoKey')"), '', '没有 key 时不得拼出 .../undefined.png');
assert.strictEqual(run("champIconAlt('Unknown')"), '', '未知英雄不得抛错');

// 2) 失败流程: 第一次 → CommunityDragon; 第二次 → 占位图并解除 onerror (不会无限循环)
const alt = run("champIconAlt('Aatrox')");
const img = makeImg(alt);
context.champIconError(img, PH);
assert.strictEqual(img.src, alt, 'ddragon 失败后应先试 CommunityDragon');
assert.strictEqual(img.dataset.cdgTried, '1');
assert.ok(img.onerror, '兜底地址还没试完，onerror 仍应保留');
context.champIconError(img, PH);
assert.strictEqual(img.src, PH, '兜底地址也失败后应回到占位图');
assert.strictEqual(img.onerror, null, '最终必须解除 onerror，占位图是 data URI，再失败会死循环');

// 3) 没有兜底地址 (data-cdg 为空/缺失): 直接占位图，与改动前行为一致
for (const cdg of ['', undefined]) {
  const bare = makeImg(cdg);
  context.champIconError(bare, PH);
  assert.strictEqual(bare.src, PH, '没有兜底地址时应直接用占位图');
  assert.strictEqual(bare.onerror, null);
}
assert.doesNotThrow(() => context.champIconError(null, PH), '元素为空不得抛错');

// 4) 生成的属性: 双引号属性里嵌单引号字符串，英雄名里的特殊字符不得突破属性
const attrs = run("champIconAttrs('Aatrox', '亚托克斯')");
assert.ok(attrs.includes('data-cdg="https://raw.communitydragon.org/'), '应携带兜底地址');
assert.ok(/onerror="champIconError\(this,'data:image\/svg\+xml,[^"']*'\)"/.test(attrs), '占位图 URI 不得含能突破引号的字符: ' + attrs);
const hostile = run(`champIconAttrs('Aatrox', '"><script>alert(1)</script>')`);
assert.ok(!/<script|"\s*>/.test(hostile.replace(/data-cdg="[^"]*"/, '').replace(/onerror="[^"]*"/, '')), '恶意英雄名不得注入标签: ' + hostile);
assert.strictEqual((hostile.match(/"/g) || []).length, 4, '属性只应有 data-cdg 与 onerror 两对引号');

// 5) 懒加载: 英雄列表与首页战绩卡片的图片必须带 loading="lazy" decoding="async"
const gridImg = champSrc.match(/<img class="champ-icon"[^>]*>/)[0];
assert.ok(gridImg.includes('loading="lazy"') && gridImg.includes('decoding="async"'), '英雄列表图片应懒加载: ' + gridImg);
const cardBlock = sliceBetween(homeSrc, 'const spellHtml =', 'const posText =');
const cardImgs = cardBlock.match(/<img [^>]*>/g) || [];
assert.ok(cardImgs.length >= 5, '应找到战绩卡片里的技能/符文/装备图片');
for (const tag of cardImgs) assert.ok(tag.includes('loading="lazy"') && tag.includes('decoding="async"'), '战绩卡片图片应懒加载: ' + tag);
const rosterImg = homeSrc.match(/<img src="\$\{xc \? champImg[^>]*>/)[0];
assert.ok(rosterImg.includes('loading="lazy"'), '展开详情里的队伍头像应懒加载');
const akoChamp = homeSrc.match(/<img class="ako-champ"[^\n]*/)[0];
assert.ok(akoChamp.includes('loading="lazy"') && akoChamp.includes('champIconAttrs'), '战绩卡片主头像应懒加载并带兜底');

// 6) 实时页: 只有 10 行，用户一进页面就要看到 → 不懒加载，但要有兜底
for (const re of [/<img src="\$\{rc \? champImg[^\n]*/, /<img class="lp-champ"[^\n]*/]) {
  const tag = liveSrc.match(re)[0];
  assert.ok(tag.includes('champIconAttrs'), '实时页头像应带兜底: ' + tag);
  assert.ok(!tag.includes('loading="lazy"'), '实时页头像不应懒加载: ' + tag);
}

// 7) 装备/技能/符文仍走 retryImg (它们在 CommunityDragon 上没有简单的按 ID 映射，不能乱猜地址)
assert.ok(cardImgs.every(t => t.includes('retryImg(this)') || t.includes('champIconAttrs')), '装备/技能/符文应保持原有 retryImg');

console.log('英雄头像兜底与图片懒加载测试通过');
