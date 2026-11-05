'use strict';
// 实时对局紧凑布局: ① 标题条已去掉 ② "近N场"并进概览行 ③ 「展开全部战绩」切换 ④ CSS 尺寸预算
// 其中 ①②③ 是真实执行 live.js 的渲染/切换函数后检查产出; ④ 从样式表读数值推算战绩区高度,防止以后被改回去。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const liveSrc = fs.readFileSync('renderer/js/live.js', 'utf8');
const html = fs.readFileSync('renderer/index.html', 'utf8');
const style = fs.readFileSync('renderer/css/style.css', 'utf8');
const premium = fs.readFileSync('renderer/css/premium.css', 'utf8');

// ---------- 最小 DOM: 够 renderLiveTeams / toggle / sync 用 ----------
function makeEl(id) {
  const cls = new Set();
  return {
    id, hidden: false, textContent: '', innerHTML: '', attrs: {},
    classList: {
      toggle(name, force) { const on = force === undefined ? !cls.has(name) : !!force; on ? cls.add(name) : cls.delete(name); return on; },
      contains: name => cls.has(name), add: n => cls.add(n), remove: n => cls.delete(n)
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelector(sel) { return sel === '.lp-wrap' && /class="lp-wrap"/.test(this.innerHTML) ? {} : null; }
  };
}
const els = { liveExpandBtn: makeEl('liveExpandBtn'), 'page-live': makeEl('page-live') };
els.liveExpandBtn.hidden = true;

const context = vm.createContext({
  console, performance: { now: () => 0 }, window: {},
  document: { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [] },
  lolAPI: { lcuStatus: async () => ({ summoner: { puuid: 'me' } }) },
  // renderLiveTeams 的外部依赖 (来自 blacklist/social/utils/home/champions 等模块)
  checkBlacklist: () => {}, isKnownPlayerName: () => false, addEncounter: () => {},
  deriveRiskProfile: () => ({ level: 'steady', label: '稳定', confidence: 80, evidence: ['样本充足'] }),
  getPlayerMarksHtml: () => '', inlineArg: v => JSON.stringify(String(v)), poroIcon: () => '<i></i>',
  showMarkModal: () => {}, nameCache: {}, _currentGameKey: 'g:1',
  escapeHtml: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  champImg: id => `/img/${id}.png`, placeholder: () => 'data:,', champIconAttrs: () => '', ensureChampMap: () => {},
  allChampions: {}, champNumMap: { '266': { id: 'Aatrox', name: '亚托克斯' } }, rankTierCN: t => t,
  mapWithConcurrency: async () => [], resolveNames: async () => {}, resolveRanks: async () => {}, rankCache: {}
});
vm.runInContext(fs.readFileSync('renderer/js/behavior-tags.js', 'utf8'), context, { filename: 'renderer/js/behavior-tags.js' });   // renderLiveTeams 依赖它
vm.runInContext(liveSrc, context, { filename: 'renderer/js/live.js' });
const run = code => vm.runInContext(code, context);

const win = (w, k = 5, d = 2, a = 7) => ({ win: w, k, d, a, champId: 266, mode: '单双排' });
const player = (n, team, recent) => ({ puuid: 'p' + n, name: '玩家' + n, team, championId: 266, rank: '钻石 IV 45LP', recent, flashPreference: null });
const recent10 = Array.from({ length: 10 }, (_, i) => win(i < 6));          // 6 胜 4 负
const body = makeEl('liveGameArea');

(async () => {
  // ---------- ① ② 渲染产出 ----------
  const data = [
    ...[1, 2, 3, 4, 5].map(n => player(n, 100, recent10)),
    ...[6, 7, 8, 9, 10].map(n => player(n, 200, n === 10 ? [] : recent10))   // 玩家10: 战绩尚未加载
  ];
  await context.renderLiveTeams(body, data, null, null);
  const out = body.innerHTML;

  assert.ok(!out.includes('live-time'), '独占一行的「对局玩家信息」标题条应已去掉');
  assert.ok(!out.includes('对局玩家信息'), '标题条文案不应再出现');
  assert.ok(!out.includes('lp-stats'), '单独一行的「近 N 场」应已并进概览行');
  assert.ok(!/class="lp-wrap" style=/.test(out), '队伍容器不应再带内联上边距 (间距统一由样式表控制)');
  assert.strictEqual((out.match(/class="lp-row/g) || []).length, 10, '10 个玩家卡都应渲染');
  assert.strictEqual((out.match(/class="lp-overview"/g) || []).length, 10, '每张卡仍有概览行');
  assert.strictEqual((out.match(/class="lp-profile-line"/g) || []).length, 10, '系统画像应保留');
  assert.strictEqual((out.match(/class="ri-card /g) || []).length, 90, '9 个有战绩的玩家各 10 场 (玩家10 尚无战绩)');
  assert.ok(out.includes('<span class="lp-record">近10场 6胜4负</span>'), '概览行应显示「近10场 6胜4负」: ' + (out.match(/<span class="lp-record">[^<]*/) || [''])[0]);
  assert.ok(out.includes('<span class="lp-record">近期战绩加载中</span>'), '战绩未加载时的占位文案应保留');
  // 1.5.61 起作战计划条并进页头: 它不再出现在实时区 (否则白占 54px), 但必须仍然渲染
  assert.ok(!out.includes('class="live-decision"'), '作战计划不应再占实时区一整行');
  assert.ok(liveSrc.includes('setLiveHeadPanel(buildLiveDecisionPanel'), '作战计划应渲染进页头槽位');
  assert.ok(html.includes('id="liveHeadSlot"'), '页头应有作战计划槽位');

  // 概览行里的三项顺序: 胜率 → 战绩摘要 → KDA, 且「近10场」只在概览行出现一次 (没有重复标签)
  const firstCard = out.slice(out.indexOf('class="lp-row'), out.indexOf('class="lp-row', out.indexOf('class="lp-row') + 5));
  const iw = firstCard.indexOf('lp-winrate'), ir = firstCard.indexOf('lp-record'), ik = firstCard.indexOf('lp-kda');
  assert.ok(iw > 0 && iw < ir && ir < ik, '概览行顺序应为 胜率 / 战绩摘要 / KDA');
  assert.strictEqual((firstCard.match(/近\d+场/g) || []).length, 1, '「近N场」只应出现一次');

  // 局部刷新 (updateLivePlayerRow) 也要用同样的文案, 否则首次渲染与后续更新不一致
  assert.strictEqual(run("liveRecordText(10, 6, 'x')"), '近10场 6胜4负');
  assert.strictEqual(run("liveRecordText(0, 0, '暂无近期战绩')"), '暂无近期战绩');
  assert.strictEqual(run("liveRecordText(7, 7, 'x')"), '近7场 7胜0负', '不足 10 场时按实际场数显示');
  assert.ok(/recordEl\.textContent = liveRecordText\(/.test(liveSrc), '局部刷新应复用 liveRecordText');
  // KDA 是「大数字 + 小标签」两段结构, 首次渲染与局部刷新必须共用 liveKdaHtml, 否则刷新会把排版冲掉
  assert.ok(/<span class="lp-kda"><b>[^<]*<\/b><em>KDA<\/em><\/span>/.test(out), '概览行的 KDA 应为 数字+标签 结构');
  assert.ok(/kdaEl\.innerHTML = liveKdaHtml\(kda\)/.test(liveSrc), '局部刷新应复用 liveKdaHtml');
  assert.strictEqual((liveSrc.match(/liveKdaHtml\(/g) || []).length, 3, 'liveKdaHtml 应只有 1 处定义 + 2 处调用');
  assert.ok(!/row\.querySelector\('\.lp-stats'\)/.test(liveSrc), '局部刷新不应再查找已删除的 .lp-stats');

  // ---------- ③ 展开/收起 ----------
  const btn = els.liveExpandBtn, page = els['page-live'];
  assert.strictEqual(btn.hidden, false, '渲染出阵容后应显示「展开全部战绩」按钮');
  assert.strictEqual(btn.textContent, '展开全部战绩');
  assert.strictEqual(page.classList.contains('live-expanded'), false, '默认不展开');
  assert.strictEqual(btn.attrs['aria-pressed'], 'false');

  context.toggleLiveRecentExpanded();
  assert.strictEqual(page.classList.contains('live-expanded'), true, '点击后页面应进入展开模式');
  assert.strictEqual(btn.textContent, '收起战绩');
  assert.strictEqual(btn.classList.contains('is-selected'), true, '展开时按钮应为选中态');
  assert.strictEqual(btn.attrs['aria-pressed'], 'true');

  // 实时刷新会整块重绘 #liveGameArea: 展开状态是挂在 #page-live 上的, 必须不受影响
  await context.renderLiveTeams(body, data, null, null);
  assert.strictEqual(page.classList.contains('live-expanded'), true, '实时重绘不得把展开状态冲掉');
  assert.strictEqual(btn.textContent, '收起战绩', '重绘后按钮文案应与状态一致');

  context.toggleLiveRecentExpanded();
  assert.strictEqual(page.classList.contains('live-expanded'), false, '再次点击应收起');
  assert.strictEqual(btn.textContent, '展开全部战绩');
  context.toggleLiveRecentExpanded(true);
  context.toggleLiveRecentExpanded(true);
  assert.strictEqual(page.classList.contains('live-expanded'), true, '显式传 true 应幂等，不是翻转');

  // 离开对局 / 没有阵容: 按钮隐藏, 但展开偏好保留 (下一局进来仍是展开)
  context.syncLiveExpandButton(false);
  assert.strictEqual(btn.hidden, true, '没有阵容时应隐藏按钮');
  assert.strictEqual(page.classList.contains('live-expanded'), true, '隐藏按钮不应改变展开偏好');
  assert.strictEqual(run('syncLiveExpandButton()'), undefined);
  assert.strictEqual(btn.hidden, true, '不传参数只同步文案，不改变显隐');
  context.toggleLiveRecentExpanded(false);
  assert.doesNotThrow(() => { els.liveExpandBtn = null; context.syncLiveExpandButton(true); }, '按钮缺失时不得抛错');
  els.liveExpandBtn = btn;

  // 接线: 按钮由 live.js 渲染进蓝方队伍栏 (页头那行已经删掉, 不能再占一行高度);
  // 默认隐藏的属性不再需要 —— 没有阵容时按钮根本不存在。
  assert.ok(/<button[^>]*class="lp-expand-btn"[^>]*id="liveExpandBtn"[^>]*onclick="toggleLiveRecentExpanded\(\)"/.test(liveSrc), '「展开全部战绩」应由 live.js 渲染进队伍栏');
  assert.ok(!/id="liveExpandBtn"/.test(html), 'index.html 里不应再有展开按钮 (否则会重新占一行高度)');
  assert.ok(!/id="page-live"[\s\S]{0,400}<h2>实时对局<\/h2>/.test(html), '实时对局页不应再有重复的页面标题');
  assert.ok(/withExpand/.test(liveSrc) && /teamPanel\(blue, '蓝方', 'lp-blue', true\)/.test(liveSrc), '展开按钮只挂在第一个队伍栏上');
  assert.ok(liveSrc.includes('syncLiveExpandButton(false);'), '离开对局时应隐藏按钮');
  assert.ok(/syncLiveExpandButton\(!!body\.querySelector\('\.lp-wrap'\)\)/.test(liveSrc), '渲染结束后应按是否有阵容校准按钮');

  // ---------- ④ CSS 尺寸预算 ----------
  // 与浏览器层叠一致: 同一选择器的多条规则要合并, 后面的只覆盖它自己写了的属性。
  // (原先只取最后一条, 后面追加的无关规则 —— 例如别的功能给同一选择器加了 flex-wrap —— 会把前面的 margin 等"挡住"。)
  const rule = (css, sel) => {
    const re = new RegExp('(?:^|\\n)' + sel.replace(/[.#[\]()]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
    const props = new Map();
    let any = false, m;
    while ((m = re.exec(css))) {
      any = true;
      for (const decl of m[1].split(';')) {
        const i = decl.indexOf(':');
        if (i > 0) props.set(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
      }
    }
    return any ? [...props].map(([k, v]) => k + ': ' + v).join('; ') : null;
  };
  const px = (decl, prop) => { const m = new RegExp('(?:^|[;\\s])' + prop + '\\s*:\\s*([^;]+)').exec(decl || ''); return m ? m[1].trim() : null; };
  const compact = rule(premium.slice(premium.indexOf('实时对局：紧凑布局')), '#liveExpandBtn');
  assert.ok(compact, '应有实时对局的页头按钮样式块');
  // 1.5.57 起实时对局的尺寸/配色由 style.css 的「实时对局」区块统一负责 (按 Akari 版式重排),
  // premium.css 只保留作战计划面板与展开按钮 —— 两处同时定义尺寸会互相覆盖, 这里守住这个分工。
  const block = style.slice(style.indexOf('============================ 实时对局 ============================'));
  assert.ok(block.length > 1000, 'style.css 应有实时对局样式块');
  assert.strictEqual(px(rule(block, '.lp-team-head'), 'min-height'), '28px', '队伍标题栏应为 28px');
  assert.strictEqual(px(rule(block, '.lp-row'), 'padding'), '6px 8px');
  assert.strictEqual(px(rule(block, '.lp-champ'), 'width'), '38px');
  const btnBlock = premium.slice(premium.indexOf('实时对局：紧凑布局'));
  assert.strictEqual(px(rule(btnBlock, '#liveExpandBtn'), 'min-height'), '0', '按钮必须覆盖全局 38px 最小高度，否则会撑高队伍栏');
  assert.strictEqual(px(rule(btnBlock, '#liveExpandBtn'), 'height'), '18px', '按钮要压到 18px 才塞得进 28px 的队伍栏');
  assert.ok(/#liveExpandBtn\[hidden\]\s*\{\s*display:\s*none/.test(btnBlock), '[hidden] 必须真的隐藏 (btn-secondary 可能设置了 display)');
  assert.ok(/body\.dark #liveExpandBtn:hover/.test(premium), '深色下按钮 hover 要单独提亮');

  // 展开模式: 去掉"一屏内"的约束
  for (const [sel, prop, val] of [['.lp-wrap', 'overflow', 'visible'], ['.lp-recent', 'overflow', 'visible'], ['.lp-row', 'height', 'auto'], ['.lp-recent', 'flex', '0 0 auto']]) {
    assert.strictEqual(px(rule(btnBlock, '#page-live.live-expanded ' + sel), prop), val, `展开模式 ${sel} 的 ${prop} 应为 ${val}`);
  }
  // 默认模式的"一屏内 + 卡内滚动"原有约定不能被破坏
  assert.match(style, /\.lp-wrap\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(style, /\.lp-recent\s*\{[^}]*overflow-y:\s*auto;/s);

  // 用样式表里解析出的数值推算 1200x800 下的战绩区高度 (不使用手写常量, 否则 CSS 被改回去也测不出来)。
  // 取值规则同浏览器的层叠: premium.css 最后加载, 其紧凑块优先于 style.css/extras.css 的同名规则。
  const extras = fs.readFileSync('renderer/css/extras.css', 'utf8');
  const val = (sel, prop) => {
    for (const css of [block, premium, extras, style]) {          // 优先级: 紧凑块 > premium > extras > style
      const v = px(rule(css, sel), prop);
      if (v != null) return v;
    }
    throw new Error(`样式表里找不到 ${sel} 的 ${prop}`);
  };
  const n = v => { const t = String(v).trim(); if (t === '0') return 0; const m = /^(-?[\d.]+)px$/.exec(t); assert.ok(m, '期望 px 数值: ' + v); return parseFloat(m[1]); };
  const box = v => { const t = String(v).trim().split(/\s+/).map(n); return t.length === 1 ? [t[0], t[0]] : [t[0], t[1] ?? t[0]]; };   // [上下, 左右]

  const barH = 44, mainPadTop = 24, mainPadBottom = 32;
  // 1.5.66 起实时对局页头整行删除 (标题与左侧导航重复), 只剩作战计划槽位;
  // 没有作战计划时 :has(.live-head-slot:empty) 直接 display:none, 高度为 0。
  assert.match(premium, /#page-live \.page-header:has\(\.live-head-slot:empty\)\s*\{\s*display:\s*none/, '没有作战计划时页头整行要隐藏');
  const headerH = 0;
  const decisionH = 0;
  const [wrapPadTop, , wrapPadBottom] = val('.lp-wrap', 'padding').split(/\s+/).map(n);
  const wrapGap = n(val('.lp-wrap', 'gap'));
  const teamPad = box(val('.lp-team', 'padding'))[0];
  const teamHead = n(val('.lp-team-head', 'min-height'));
  const gridPt = n(val('.lp-team-grid', 'padding-top'));
  const rowPad = box(val('.lp-row', 'padding'))[0];
  const [ovTop, , ovBottom] = val('.lp-overview', 'margin').split(/\s+/).map(n);
  const ovPadV = box(val('.lp-overview', 'padding'))[0];
  const ovLine = parseFloat(val('.lp-overview', 'line-height')) * n(val('.lp-winrate', 'font-size'));
  const overviewH = ovTop + ovBottom + 2 * ovPadV + ovLine;        // 1.5.57 起概览行改为无边框平铺
  const headRowH = n(val('.lp-champ', 'width'));
  // 1.5.58 起标签行多了「伤害/承伤/经济/参团」, 六枚在 1200 宽下必然折成两行,
  // 所以预算按两行算 (两行 = 2 * 标签行高 + 行间距 + 下外边距), 不再按 min-height 单行算。
  const metricLine = n(val('.lp-metric', 'line-height'));
  const pillGap = n(val('.lp-profile-line', 'gap').split(/\s+/)[0]);
  const profileH = 2 * metricLine + pillGap + n(val('.lp-profile-line', 'margin-bottom'));
  const rowGap = n(val('.lp-recent', 'gap'));
  const rowPitch = n(val('.ri-card', 'flex').split(/\s+/)[2]) + rowGap;   // 每场战绩的行距 (行高 + 行间间隙)

  const budget = winH => {
    const avail = winH - barH - mainPadTop - mainPadBottom - headerH - decisionH - (wrapPadTop + wrapPadBottom);
    const teamH = (avail - wrapGap) / 2;
    const cardH = teamH - (2 + 2 * teamPad) - teamHead - gridPt;
    const cardInner = cardH - (2 + 2 * rowPad);                    // 左右各 1px 边框 + 上下内边距
    const recentH = cardInner - headRowH - overviewH - profileH;
    // 最后一行后面不需要间隙, 所以分子补一个 gap
    return { recentH, visible: Math.floor((recentH + rowGap) / rowPitch) };
  };

  // 1200x800 是压力档 (老笔记本全屏); 1440x900 才是实际常用尺寸, 两档都要保住基本可读性。
  const small = budget(800), normal = budget(900);
  assert.ok(small.visible >= 6, `1200x800 下 10 场至少应露出 6 场, 实际 ${small.visible} 场`);
  assert.ok(normal.visible >= 8, `1440x900 下 10 场至少应露出 8 场, 实际 ${normal.visible} 场`);
  // Akari 在 1511x937 下露 8 场; 我们把页头压成一行后同尺寸应露出 9 场 (行高 24 + 间隙 1 = 25)
  assert.ok(budget(940).visible >= 9, `1500x940 下应露出 9 场, 实际 ${budget(940).visible} 场`);

  // ---------- ⑤ 1.5.76 单场战绩详情浮窗 ----------
  // 纯函数层: 有 gameId 的卡才可点, 没 gameId 的必须保持静态 (否则就是个点了没反应的假按钮)
  const cardWithId = run('recentIcon({ gameId: 123456789, win: true, k: 3, d: 1, a: 9, champId: 266, mode: "单双排", ts: 0 }, { puuid: "p1", platformId: "HN1" })');
  assert.ok(/data-game-id="123456789"/.test(cardWithId), '带 gameId 的战绩卡应挂 data-game-id: ' + cardWithId.slice(0, 120));
  assert.ok(/onclick="openLiveMatchDetail\(this\)"/.test(cardWithId), '战绩卡应能点开详情');
  assert.ok(/data-platform="HN1"/.test(cardWithId), '浮窗要知道去哪个平台拉这一局');
  assert.ok(/data-puuid="p1"/.test(cardWithId), '浮窗要知道是哪个玩家');
  assert.ok(/ri-clickable/.test(cardWithId), '可点的卡要有 cursor:pointer 的类');
  assert.ok(/点击查看这一局详情/.test(cardWithId), '可点的卡要在 title 里说清楚能点');
  const cardNoId = run('recentIcon({ win: true, k: 1, d: 2, a: 3, champId: 266, mode: "单双排", ts: 0 }, { puuid: "p1" })');
  assert.ok(!/data-game-id/.test(cardNoId), '没有 gameId 的卡不应带 data-game-id');
  assert.ok(!/ri-clickable/.test(cardNoId), '没有 gameId 的卡不应变成假按钮');
  assert.ok(!/onclick=/.test(cardNoId), '没有 gameId 的卡不应挂 onclick');

  // 两条取数路径都必须把 gameId 写进 recent, 否则上面这段永远拿不到 ID
  assert.ok(/gameId: gj\.gameId/.test(liveSrc), 'SGP 路径要把 gameId 写进 recent');
  assert.ok(/gameId: raw\.gameId/.test(liveSrc), 'LCU 兜底路径也要把 gameId 写进 recent');
  // 详情链复用战绩页同一套渲染 —— 另写一份就会和战绩页慢慢分叉
  assert.ok(/renderOpggGameDetail\(norm, holder\)/.test(liveSrc), '浮窗应复用 renderOpggGameDetail');
  assert.ok(/sgpGameSummary/.test(liveSrc), '国服走 SGP 详情');
  assert.ok(/lol-match-history\/v1\/games\/\$\{gameId\}/.test(liveSrc), '非国服/失败要回退 LCU 详情');
  // 只取 innerHTML 的话「保存战报卡」按钮没有监听器, 必须摘掉
  assert.ok(/holder\.querySelector\('\.ogd-actions'\)\?\.remove\(\)/.test(liveSrc), '浮窗里要摘掉没有监听器的「保存战报卡」');
  // 同一局反复点不该反复打接口
  assert.ok(/liveMatchDetailCache/.test(liveSrc) && /liveMatchDetailCache\.get\(gameId\)/.test(liveSrc), '详情应按 gameId 缓存');
  // 浮窗样式: 没有 fixed 定位就会变成一个普通 div 掉在页面最底下
  assert.match(style, /\.lmp\s*\{[^}]*position:\s*fixed/, '浮窗必须 fixed 定位');
  assert.match(style, /\.lmp\s*\{[^}]*max-height:\s*78vh/, '浮窗要有高度上限, 否则长详情会超出屏幕');
  assert.match(style, /\.ri-card\.ri-clickable\s*\{[^}]*cursor:\s*pointer/, '可点的战绩卡要有手型光标');
  // 全局监听必须延迟到首次打开浮窗才挂, 不能做成顶层副作用
  // (顶层 document.addEventListener 会让所有用 vm 加载 live.js 的单测直接炸)
  assert.ok(/function bindLiveMatchPopDismiss\(\)/.test(liveSrc), '关闭逻辑要收进函数');
  assert.ok(/^  document\.addEventListener\('keydown'/m.test(liveSrc), 'keydown 监听应在函数体内 (缩进 2 格), 不是顶层');
  assert.ok(/bindLiveMatchPopDismiss\(\);/.test(liveSrc), 'ensureLiveMatchPop 里要真的调用绑定');

  console.log(`实时对局紧凑布局测试通过 (1200x800 露出 ${small.visible} 场 / 1440x900 露出 ${normal.visible} 场)`);
})().catch(e => { console.error(e); process.exitCode = 1; });
