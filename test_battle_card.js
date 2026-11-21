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
  assert.ok(html.includes('<span class="k-k">11</span><i>/</i><span class="k-d">3</span><i>/</i><span class="k-a">9</span>'),
    'KDA 三个数字要各自包 span (击杀绿/死亡红/助攻蓝, 与首页战绩卡同款式)');
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
  // 11/3/9 = 6.67 KDA -> 高于 3, 比值那行打 k-hi (绿)
  assert.ok(/class="bc-kda-num"/.test(html), '大字号 KDA 必须是纯主色 (不带分级 class)');
  assert.ok(/<strong class="k-hi">6\.7<\/strong> KDA/.test(html), 'KDA>=3 时比值要打 k-hi (与首页同口径)');
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
  assert.ok(/<strong class="k-lo">/.test(Card.build(lo, 'p0', {})), 'KDA<2 比值要打 k-lo (红)');
  const mid = norm({ participants: [
    { puuid: 'p0', teamId: 100, championId: '86', k: 2, d: 2, a: 2, win: true, dmg: 1, gold: 1, cs: 1, items: [], position: 'TOP' },
    { puuid: 'p1', teamId: 200, championId: '64', k: 5, d: 2, a: 3, win: false, dmg: 1, gold: 1, cs: 1, items: [], position: 'TOP' }
  ] });
  assert.ok(/<strong class="k-mid">/.test(Card.build(mid, 'p0', {})), '2<=KDA<3 比值要打 k-mid (蓝)');
  // 大字不许出现任何分级 class —— 这是"每次点卡颜色不一样"的根因
  for (const h of [Card.build(lo, 'p0', {}), Card.build(mid, 'p0', {})]) {
    assert.ok(!/bc-kda-num k-(hi|mid|lo)/.test(h), '11/3/9 大字不能随 KDA 变色');
  }
}

// 5d. 样式: KDA 三色必须落在 premium.css, 且色值要与首页战绩卡逐值一致。
//     导出只注入 style/extras/dark/premium/ui-polish —— 首页用的 --pos/--neg/--brand
//     定义在 v4.css 里, 离屏窗口根本拿不到; 而 premium 的 --positive 是 #16a34a,
//     与首页的 #0E8A4F 不是一个绿。所以必须写死 hex, 这里连"来源正确"一起守。
{
  const v4 = fs.readFileSync(path.join(__dirname, 'renderer/css/v4.css'), 'utf8');
  const WANT = {
    'k-k': { light: '#0E8A4F', dark: '#26C281', tok: '--pos' },
    'k-d': { light: '#D02F27', dark: '#EF5350', tok: '--neg' },
    'k-a': { light: '#2065D6', dark: '#4F8FF7', tok: '--brand' }
  };
  for (const [cls, w] of Object.entries(WANT)) {
    const at = css.indexOf('.bc-kda-num .' + cls);
    assert.ok(at > 0, 'premium.css 缺 .bc-kda-num .' + cls + ' (大写 KDA 要按位着色)');
    const block = css.slice(at, css.indexOf('}', at) + 1);
    assert.ok(block.includes(w.light), cls + ' 浅色应为 ' + w.light + ' (与首页同色)');
    assert.ok(!/var\(--(positive|negative|accent)\)/.test(block),
      cls + ' 不能引 --positive/--accent: 导出窗口里与首页不是同一种绿');

    const dAt = css.indexOf('body.dark .bc-kda-num .' + cls);
    assert.ok(dAt > 0, 'premium.css 缺深色 .bc-kda-num .' + cls);
    const dBlock = css.slice(dAt, css.indexOf('}', dAt) + 1);
    assert.ok(dBlock.includes(w.dark), cls + ' 深色应为 ' + w.dark);

    // 这两个 hex 必须真的能在 v4.css 里找到对应的语义令牌, 防止随手编色值
    assert.ok(new RegExp(w.tok + ':\\s*' + w.light).test(v4), w.light + ' 必须等于 v4.css 浅色 ' + w.tok);
    assert.ok(new RegExp(w.tok + ':\\s*' + w.dark).test(v4), w.dark + ' 必须等于 v4.css 深色 ' + w.tok);
  }
  // 比值那行小字与大字共用同一组色值 (截图里 "14.50 显示绿" 就是这里)
  for (const cls of ['k-hi', 'k-lo', 'k-mid']) {
    const at = css.indexOf('.bc-kda-sub strong.' + cls);
    assert.ok(at > 0, 'premium.css 缺比值分级色 .bc-kda-sub strong.' + cls);
    const block = css.slice(at, css.indexOf('}', at) + 1);
    assert.ok(!/var\(--(positive|negative|accent)\)/.test(block),
      '比值分级色也必须写死, 与大字同源');
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
  assert.ok(/urls\.set\(headUrl/.test(warm), 'warmImages 要收全员头像');
  assert.ok(/urls\.set\(itemUrl/.test(warm), 'warmImages 要收装备图');
  // 每张图都按卡上的实际显示尺寸重编码: 120px 头像原样内联会把 HTML 撑到 520KB,
  // 撞破主进程上限后表现为"有的局生成失败"。原画走 jpeg, 头像/装备必须留 png (透明)。
  assert.ok(/maxW:\s*276[^}]*image\/jpeg/.test(warm), '原画要按 276px 重编码成 jpeg');
  assert.ok(/urls\.set\(headUrl\(c\.id\),\s*\{[^}]*maxW:\s*\d+[^}]*image\/png/.test(warm),
    '头像要按显示尺寸重编码且保留 png 透明通道');
  assert.ok(/urls\.set\(itemUrl\(id\),\s*\{[^}]*image\/png/.test(warm), '装备同理保留 png');
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

// 5h. 1.6.46 修的两个真实故障, 都要留门禁防止退回去
{
  const src = fs.readFileSync(SRC, 'utf8');
  // (a) 大字 KDA 不许整体随局变档 —— 用户报告的"每次点卡 kd 颜色不一样"。
  //     正解是按位固定色 (击杀绿/死亡红/助攻蓝), 所以容器不能挂 k-hi/k-mid/k-lo 这类
  //     整串分级 class; 但只要按位着色落地了, 三个数字必然各自有 span。
  const card = Card.build(norm(), 'p0', {});
  const m = card.match(/<b class="([^"]*)"><span class="k-k">11<\/span>/);
  assert.ok(!!m, 'KDA 大字要能定位到 (且击杀必须是 k-k)');
  assert.ok(!/k-(hi|mid|lo)/.test(m[1]), 'KDA 大字容器不能带整串分级 class (会随局整体变色)');
  assert.ok(/<span class="k-d">3<\/span><i>\/<\/i><span class="k-a">9<\/span>/.test(card),
    '死亡/助攻必须各自独立 span —— 否则做不到和首页一样的三位分色');

  // (b) 内联图必须按显示尺寸重编码 —— 原样内联时单卡 520KB, 撞破主进程上限
  assert.ok(/shrinkAsDataUrl/.test(src), '必须按显示尺寸重编码图片');
  assert.ok(/function readAsDataUrl/.test(src), '重编码失败时要有原图 base64 兜底');

  // (c) 渲染入口互斥: 连点不能并发发两次导出
  assert.ok(/let saving = false/.test(src), 'save 要有互斥锁');
  assert.ok(/if \(saving\)/.test(src), '重复点击要直接挡掉');

  // (d) 主进程: HTML 上限必须远大于实测 520KB, 且导出要串行
  const mainSrc = fs.readFileSync(path.join(__dirname, 'main/index.js'), 'utf8');
  const cap = mainSrc.match(/SHARE_CARD_MAX_HTML = (\d+)\s*\*\s*1024\s*\*\s*1024/);
  assert.ok(!!cap, '主进程要有明确的 HTML 体积上限常量');
  assert.ok(Number(cap[1]) >= 2, 'HTML 上限至少 2MB (旧值 500KB 会让图多的局随机失败)');
  assert.ok(!/html\.length > 500000/.test(mainSrc), '旧的 500KB 硬限制必须去掉');
  assert.ok(/enqueueShareCard/.test(mainSrc), '离屏导出要串行排队 (并发开窗口会 ERR_FAILED)');
  // (e) 离屏窗口必须复用: 「新建 → destroy → 再新建」第 2 次 loadURL 必报 ERR_FAILED
  //     且进程随后退出, 这是"第一张卡能出、之后全失败"的根因 (实测复现)。
  assert.ok(/function acquireShareCardWin/.test(mainSrc), '离屏窗口要复用, 不能每次新建');
  const rsc = mainSrc.slice(mainSrc.indexOf('async function renderShareCardPng'),
    mainSrc.indexOf('// 所有战报卡导出串行排队'));
  assert.ok(!/finally\s*\{[^}]*win\.destroy\(\)/.test(rsc), '渲染完不许销毁窗口 (会踩 ERR_FAILED)');
  assert.ok(!/shareCardDark/.test(mainSrc), '主题切换不许重建窗口 (页面自带背景)');
}

console.log('test_battle_card: all assertions passed');
