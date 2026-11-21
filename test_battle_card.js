// 战报卡构建测试: 卡片是发到外部社群的成品图, 图上写错一个字都没法撤回。
// 这里守三件事: 玩家名能上卡、不传名字时不硬塞占位、名字里的 HTML 必须转义。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'renderer/js/battle-card.js');
const css = fs.readFileSync(path.join(__dirname, 'renderer/css/premium.css'), 'utf8');
const hexSrc = fs.readFileSync(path.join(__dirname, 'renderer/js/hex.js'), 'utf8');

// --- 最小沙箱: build() 只用到几个全局工具函数, 没有 DOM ---
const sandbox = {
  console,
  window: {},
  escapeHtml: s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  champImg: id => 'champ/' + id + '.png',
  placeholder: () => 'ph.png',
  champNumMap: { '86': { id: '86', name: '盖伦' }, '64': { id: '64', name: '李青' } },
  version: '16.17.1',
  hexAugMeta: {},
  // app.js 里的实现按队列判断"这局有没有真实分路", 沙箱里保持同一语义
  hasRealPositions: g => [400, 420, 430, 440, 490].includes(Number(g && g.queueId) || 0)
};
sandbox.champNumMap = sandbox.champNumMap;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);
const Card = sandbox.window.PoroBattleCard;

function norm(over) {
  const P = (puuid, teamId, cid, k, d, a, win) => ({
    puuid, teamId, championId: String(cid), k, d, a, win,
    dmg: 20000, dmgTaken: 15000, gold: 12000, cs: 200, visionScore: 20,
    items: [3153, 3006], position: 'TOP', level: 16, fb: false, multi: ''
  });
  return Object.assign({
    mode: '单双排', queueId: 420, dur: 1980, time: Date.UTC(2026, 10, 22, 10, 0, 0),
    participants: [
      P('p0', 100, 86, 11, 3, 9, true), P('p1', 100, 64, 6, 5, 14, true),
      P('p2', 200, 86, 5, 8, 6, false), P('p3', 200, 64, 4, 9, 10, false)
    ]
  }, over || {});
}

// 1. 传了名字就要出现在卡上, 且在头部
{
  const html = Card.build(norm(), 'p0', { name: '雨未眠#0417' });
  assert.ok(html.includes('bc-owner'), '有名字时必须渲染 .bc-owner');
  assert.ok(html.includes('雨未眠#0417'), '名字要原样上卡');
  // 1.6.45 改版后头部是 bc-top → bc-kda (原 bc-hero 已并入左侧原画条)
  const top = html.slice(html.indexOf('bc-top'), html.indexOf('bc-kda'));
  assert.ok(top.includes('bc-owner'), '名字必须在卡片头部 (bc-top) 里, 不能落到别处');
  assert.ok(top.includes('胜利'), '头部胜负标题不能被名字挤掉');
}

// 2. 不传名字: 整块不渲染, 不留空占位、不写"未知召唤师"
{
  for (const opts of [undefined, null, {}, { name: '' }, { name: '   ' }]) {
    const html = Card.build(norm(), 'p0', opts);
    assert.ok(!html.includes('bc-owner'), '没名字时不应渲染 .bc-owner');
    assert.ok(!/未知召唤师|匿名/.test(html), '不能编一个占位名字');
  }
}

// 3. 名字里的 HTML 必须转义 —— Riot ID 允许尖括号/引号, 直接拼会破坏卡片结构
{
  const evil = '<img src=x onerror=alert(1)>#1234';
  const html = Card.build(norm(), 'p0', { name: evil });
  assert.ok(!html.includes('<img src=x'), '名字里的标签必须被转义');
  assert.ok(html.includes('&lt;img'), '转义后应保留可见字符');
}

// 4. 归属玩家不存在时退回胜方第一个, 但名字仍然显示 (卡住的是"谁的战报", 不是数据)
{
  const html = Card.build(norm(), 'not-exist', { name: '路人甲#0001' });
  assert.ok(html.includes('路人甲#0001'), '找不到 puuid 时也应显示传入的名字');
}

// 5. 基础内容没被这次改动破坏
{
  const html = Card.build(norm(), 'p0', { name: 'A#1' });
  assert.ok(html.includes('11<i>/</i>3<i>/</i>9'), 'KDA 要按 k/d/a 渲染');
  assert.ok(!/<em>\d+<\/em>/.test(html), '死亡数不再单独标红 —— 整串同色才和首页战绩卡一致');
  assert.ok(html.includes('盖伦'), '英雄名要在卡上');
  assert.ok(/bc-grid/.test(html) && /bc-mates/.test(html), '数据格与双方阵容都还在');
  assert.ok(html.includes('Poro'), '品牌脚注还在');
}

// 5b. 1.6.45「竖幅原画 · 档案式」: 原画条 + 分级 KDA + 对位经济
{
  const html = Card.build(norm(), 'p0', { name: 'A#1' });
  assert.ok(/class="bc-art"/.test(html), '必须有左侧原画条');
  assert.ok(/class="bc-art-img"[^>]*loading\//.test(html), '原画条里要放 ddragon 竖幅 loading 图');
  // 11/3/9 = 6.67 KDA -> 高于 3, 走 k-hi (绿)
  assert.ok(/class="bc-kda-num k-hi"/.test(html), 'KDA>=3 要打 k-hi (与首页同口径)');
  // 对位经济: 同分路敌人 12000 vs 自己 12000 -> +0
  assert.ok(/对位经济/.test(html), '数据格要有对位经济');
  // 沙箱没有 rankCache, 段位必须整块不出 —— 不许编一个段位出来
  assert.ok(!/bc-rank/.test(html), '拿不到段位时不渲染徽章, 不能编');
  // 乱斗没有真实分路: 对位经济拿不到 -> 显示 —, 不能顶一个别的口径的数值
  const aram = Card.build(norm({ queueId: 450 }), 'p0', {});
  assert.ok(/<b>—<\/b><span>对位经济<\/span>/.test(aram), '无分路时对位经济显示 —');
}

// 5c. KDA 分级三档齐全 (>=3 / <2 / 中间)
{
  const lo = norm({ participants: [
    { puuid: 'p0', teamId: 100, championId: '86', k: 1, d: 9, a: 2, win: false, dmg: 1, gold: 1, cs: 1, items: [], position: 'TOP' },
    { puuid: 'p1', teamId: 200, championId: '64', k: 5, d: 2, a: 3, win: true, dmg: 1, gold: 1, cs: 1, items: [], position: 'TOP' }
  ] });
  assert.ok(/bc-kda-num k-lo/.test(Card.build(lo, 'p0', {})), 'KDA<2 要打 k-lo (红)');
  const mid = norm({ participants: [
    { puuid: 'p0', teamId: 100, championId: '86', k: 2, d: 2, a: 2, win: true, dmg: 1, gold: 1, cs: 1, items: [], position: 'TOP' },
    { puuid: 'p1', teamId: 200, championId: '64', k: 5, d: 2, a: 3, win: false, dmg: 1, gold: 1, cs: 1, items: [], position: 'TOP' }
  ] });
  assert.ok(/bc-kda-num k-mid/.test(Card.build(mid, 'p0', {})), '2<=KDA<3 要打 k-mid (蓝)');
}

// 5d. 样式: 三档色必须落在 premium.css (导出只注入 style/extras/dark/premium/ui-polish,
//     v4.css 的 --data-* 在离屏窗口里不存在, 写那边等于没上色)
{
  const i = css.indexOf('.bc-kda-num.k-hi');
  assert.ok(i > 0, 'premium.css 里必须有 KDA 分级色');
  for (const [cls, tok] of [['k-hi', '--positive'], ['k-lo', '--negative'], ['k-mid', '--accent']]) {
    const at = css.indexOf('.bc-kda-num.' + cls);
    const block = css.slice(at, css.indexOf('}', at) + 1);
    assert.ok(block.includes('var(' + tok + ')'), cls + ' 要用 ' + tok);
  }
  const art = css.slice(css.indexOf('.bc-art {'), css.indexOf('}', css.indexOf('.bc-art {')) + 1);
  assert.ok(/width:\s*138px/.test(art), '原画条宽 138px');
  assert.ok(!/height:\s*\d+px/.test(art), '原画条高度必须由 flex 撑开, 写死会在内容变长时露底色');
}

// 6. 样式: 名字要右对齐、能收缩、超长省略
{
  const i = css.indexOf('.bc-owner');
  assert.ok(i > 0, '.bc-owner 样式必须存在');
  const block = css.slice(i, css.indexOf('}', i) + 1);
  assert.ok(/margin-left:\s*auto/.test(block), '名字要推到右边');
  assert.ok(/text-overflow:\s*ellipsis/.test(block), '长 Riot ID 要省略号, 不能溢出卡片');
  assert.ok(/min-width:\s*0/.test(block), 'flex 子项必须允许收缩, 否则省略号不生效');
  assert.ok(/max-width:\s*\d+%/.test(block), '要限宽, 否则长名字会挤走胜负标题');
}

// 7. 接线: 调用处必须把名字传进来, save 必须透传给 build
{
  assert.ok(/PoroBattleCard\.save\(norm, ownerPuuid, \{ name: ownerName \}\)/.test(hexSrc),
    'hex.js 调用 save 时要带 name');
  assert.ok(/profileOverride && profileOverride\.name/.test(hexSrc), '名字优先取当前查看的档案主人');
  assert.ok(/cachedSummoner && \(cachedSummoner\.displayName \|\| cachedSummoner\.gameName\)/.test(hexSrc),
    '其次取本机召唤师名');
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(/function save\(norm, ownerPuuid, opts\)/.test(src), 'save 要接受第三个参数');
  assert.ok(/build\(norm, ownerPuuid, o\)/.test(src), 'save 必须把 opts 透传给 build');
}

// 5e. 队伍行必须用 grid 均分 —— 5 组「头像+6/5/12」在 307px 里用 flex+gap 会溢出,
//     实测会把最后一个玩家的数据裁掉半截 (第一版就是这样)
{
  const at = css.indexOf('.bc-mates {');
  assert.ok(at > 0, '.bc-mates 样式必须存在');
  const block = css.slice(at, css.indexOf('}', at) + 1);
  assert.ok(/display:\s*grid/.test(block), '.bc-mates 要用 grid 均分, flex 会溢出裁字');
  assert.ok(/grid-auto-columns:\s*1fr/.test(block), '每列等宽');
  const art = css.slice(css.indexOf('.bc-art-img {'), css.indexOf('}', css.indexOf('.bc-art-img {')) + 1);
  assert.ok(/object-fit:\s*cover/.test(art) && /object-position/.test(art),
    '原画要 cover + 指定焦点, 否则竖图铺进竖条会糊或空');
}

// 5f. 离屏导出只等 600ms: 卡片上的图必须提前内联, 否则装备格是空白方块、头像缺一半
{
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(/IMG_CACHE/.test(src), '要有统一的图片 dataURL 缓存');
  assert.ok(/async function warmImages\(norm, ownerPuuid\)/.test(src), 'warmImages 要一次预热全部图片');
  assert.ok(/await warmImages\(norm, ownerPuuid\)/.test(src), 'save 里必须在 renderShareCard 前 await warmImages');
  // 三处图源都要过 inline()
  assert.ok(/return inline\(headUrl\(c\.id\)\)/.test(src), '头像要过 inline()');
  assert.ok(/inline\(SPLASH_CDN/.test(src), '原画要过 inline()');
  assert.ok(/inline\(itemUrl\(id\)\)/.test(src), '装备图要过 inline()');
  // 预热范围要覆盖 10 个头像 + 装备, 不能只顾主角原画
  const warm = src.slice(src.indexOf('async function warmImages'), src.indexOf('const warmSplash = warmImages'));
  assert.ok(/urls\.add\(headUrl/.test(warm), 'warmImages 要收全员头像');
  assert.ok(/urls\.add\(itemUrl/.test(warm), 'warmImages 要收装备图');
}

// 5g. 段位色与 v4.css §33 的深色档必须一致 —— 两边各存一份色值, 最容易悄悄跑偏
{
  const src = fs.readFileSync(SRC, 'utf8');
  const v4 = fs.readFileSync(path.join(__dirname, 'renderer/css/v4.css'), 'utf8');
  const darkBlock = (v4.match(/body\.dark \{[^}]*--tier-iron[^}]*\}/) || [''])[0];
  assert.ok(!!darkBlock, 'v4.css 里应有 body.dark 的段位色阶');
  const TIERS = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'master', 'grandmaster', 'challenger'];
  for (const t of TIERS) {
    const m = darkBlock.match(new RegExp('--tier-' + t + ':\\s*(#[0-9A-Fa-f]{6})'));
    assert.ok(!!m, 'v4.css 缺 --tier-' + t);
    const inJs = src.match(new RegExp('["\']?' + t.toUpperCase() + '["\']?:\\s*\'(#[0-9A-Fa-f]{6})\''));
    assert.ok(!!inJs, 'battle-card.js 的 TIER_HEX 缺 ' + t.toUpperCase());
    assert.strictEqual(inJs[1].toUpperCase(), m[1].toUpperCase(),
      t + ' 段位色两边不一致 (v4 ' + m[1] + ' / js ' + inJs[1] + ')');
  }
}

console.log('test_battle_card: all assertions passed');
