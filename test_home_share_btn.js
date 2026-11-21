// 首页战绩行「战报卡」按钮测试 (1.6.44)
//
// 这个按钮的作用是把「点开这局 → 等详情 → 滚到底 → 点保存」三步压成一步。
// 它有两个容易坏的地方，测试就守这两点:
//   1. 点击必须 stopPropagation —— 整张卡上挂着 expandOpggGame, 冒泡会把详情一并展开/折叠;
//   2. 出图用的是列表缓存里的 norm, 找不到数据时要给出提示而不是静默失败。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const homeSrc = fs.readFileSync(path.join(__dirname, 'renderer/js/home.js'), 'utf8');
const p1632 = fs.readFileSync(path.join(__dirname, 'renderer/css/poro-1632.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'renderer/index.html'), 'utf8');

// ---------- 1. 卡片 HTML: 按钮在右侧竖条里, 且箭头没被顶掉 ----------
{
  const i = homeSrc.indexOf('class="ako-side"');
  assert.ok(i > 0, '卡片右侧必须有 .ako-side 容器');
  const block = homeSrc.slice(i, homeSrc.indexOf('og-game-detail', i));
  assert.ok(/class="ako-share"/.test(block), '竖条里要有分享按钮');
  assert.ok(/class="ako-expand">‹</.test(block), '展开箭头必须留在竖条里 (不能为了按钮把它挤掉)');
  assert.ok(/shareHomeGameCard\(/.test(block), '按钮要调用 shareHomeGameCard');
  // 没有 stopPropagation 的话点分享会顺带展开详情 —— 玩家会以为按钮点错了
  assert.ok(/event\.stopPropagation\(\);\s*shareHomeGameCard\(/.test(block),
    '点击必须先 stopPropagation, 否则冒泡触发整卡的 expandOpggGame');
  assert.ok(/\$\{inlineArg\(g\.gid\)\}/.test(block), 'gid 要经 inlineArg 转义后再拼进 onclick');
  // 26px 宽的竖条里放不下能认出来的图标: poroIcon 的 cards 在 14px 下就是一个空心小方框
  assert.ok(/<button class="ako-share"[^>]*><span>卡<\/span><\/button>/.test(block),
    '按钮用中文单字「卡」, 不要退回 14px 图标 (实测认不出是"卡片")');
  // 卡片本身的展开入口不能丢
  assert.ok(/onclick="expandOpggGame\(this, '\$\{g\.gid\}'\)"/.test(homeSrc), '整卡点击展开仍要保留');
}

// ---------- 2. shareHomeGameCard: 用缓存数据直接出图 ----------
{
  const start = homeSrc.indexOf('async function shareHomeGameCard(gid) {');
  assert.ok(start > 0, 'shareHomeGameCard 必须存在');
  const end = homeSrc.indexOf('// 展开对局详情', start);
  const fnSrc = homeSrc.slice(start, end);

  const calls = [];
  const toasts = [];
  const sandbox = {
    console,
    window: { PoroBattleCard: { save: (...a) => { calls.push(a); return Promise.resolve(); } } },
    showToast: (msg, tone) => toasts.push([msg, tone]),
    profileOverride: { name: '雨未眠', tagLine: '0417' },
    homeGamesOwnerLabel: '雨未眠0417',
    cachedSummoner: { displayName: '本机名' },
    homeGamesOwner: 'p0',
    homeGamesData: [
      { gid: '6001', mode: '单双排', participants: [] },
      { gid: '6002', mode: '灵活组排', participants: [] }
    ]
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc, sandbox);
  const run = gid => Promise.resolve(sandbox.shareHomeGameCard(gid));

  (async () => {
    // 正常路径: 拿到那一局, 名字带 tag, 主角 puuid 是首页主人
    await run('6001');
    assert.strictEqual(calls.length, 1, '应调用一次保存');
    assert.strictEqual(calls[0][0].gid, '6001', '要出点击那一局的卡, 不能出成第一局');
    assert.strictEqual(calls[0][1], 'p0', '主角 puuid 用首页归属玩家');
    assert.strictEqual(calls[0][2].name, '雨未眠#0417', '名字要拼成 Riot ID 形式');
    assert.strictEqual(toasts.length, 0, '正常路径不该弹提示');

    // 数字 gid 与字符串混用 (LCU 给 number, 缓存里可能是 string) 也要能对上
    calls.length = 0;
    await run(6002);
    assert.strictEqual(calls.length, 1, 'gid 类型不一致时也要能命中');
    assert.strictEqual(calls[0][0].gid, '6002', '命中的应是 6002');

    // 名字已含 # : 不能再拼一遍 tagLine 变成 "名#0417#0417"
    calls.length = 0;
    sandbox.profileOverride = { name: '雨未眠#0417', tagLine: '0417' };
    await run('6001');
    assert.strictEqual(calls[0][2].name, '雨未眠#0417', '名字已含 # 时不得重复拼接');

    // 找不到这一局: 给提示, 不静默失败
    calls.length = 0;
    toasts.length = 0;
    await run('9999');
    assert.strictEqual(calls.length, 0, '找不到数据时不能瞎出一张别的卡');
    assert.strictEqual(toasts.length, 1, '要给出一条提示');
    assert.strictEqual(toasts[0][1], 'negative', '提示要走负面样式');

    // 模块缺失 / 保存抛错: 不能把异常抛给 inline onclick(会在控制台留未捕获错误)
    sandbox.window.PoroBattleCard = undefined;
    toasts.length = 0;
    await run('6001');
    assert.strictEqual(toasts.length, 1, '模块缺失要提示');
    sandbox.window.PoroBattleCard = { save: () => { throw new Error('boom'); } };
    toasts.length = 0;
    await run('6001');
    assert.strictEqual(toasts.length, 1, '保存抛错要兜住并提示');
    assert.ok(/boom/.test(toasts[0][0]), '提示里要带出原因');

    // ---------- 3. 样式: 写在最后一张表里, 且不撑高卡片 ----------
    const i = p1632.indexOf('#homeGamesList .ako-card .ako-side {');
    assert.ok(i > 0, '.ako-side 样式必须在最后加载的 poro-1632.css 里 (否则被 style.css 的 .ako-expand 盖掉)');
    const sideBlock = p1632.slice(i, p1632.indexOf('}', i) + 1);
    assert.ok(/flex-direction:\s*column/.test(sideBlock), '竖条是上下两格');
    assert.ok(/width:\s*26px/.test(sideBlock), '宽度沿用原来的 26px, 不额外占横向空间');

    const j = p1632.indexOf('#homeGamesList .ako-card .ako-side .ako-expand {');
    assert.ok(j > 0, '必须覆盖 .ako-expand 的 width/border-left, 否则双边框');
    const expBlock = p1632.slice(j, p1632.indexOf('}', j) + 1);
    assert.ok(/border-left:\s*0/.test(expBlock), '箭头不再自己画左边框');

    const k = p1632.indexOf('#homeGamesList .ako-card .ako-share {');
    assert.ok(k > 0, '按钮样式必须存在');
    const btnBlock = p1632.slice(k, p1632.indexOf('}', k) + 1);
    assert.strictEqual(/min-height:\s*([^;]+);/.exec(btnBlock)[1].trim(), '0',
      '必须覆盖全局 button 的最小高度, 否则把卡片撑高');
    assert.strictEqual(/[{;\s]height:\s*([^;]+);/.exec(btnBlock)[1].trim(), '26px',
      '按钮高度要和上格对齐, 让箭头占满剩下的空间');
    assert.ok(/border:\s*0/.test(btnBlock), '全局 button 的边框要去掉');

    // 样式表顺序: poro-1632.css 必须仍是最后一张, 否则以上覆盖全部失效
    const cssOrder = [...html.matchAll(/css\/([\w.-]+\.css)/g)].map(m => m[1]);
    assert.strictEqual(cssOrder[cssOrder.length - 1], 'poro-1632.css',
      'poro-1632.css 必须最后加载');

    console.log('test_home_share_btn: all assertions passed');
  })().catch(e => { console.error(e); process.exit(1); });
}
