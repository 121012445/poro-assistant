'use strict';
// renderer/js/behavior-tags.js: 玩家行为标签 (投降倾向 / 信号习惯)。重点是口径: 样本不足不下结论、字段缺失是「未知」而不是 0。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const src = read('renderer/js/behavior-tags.js');
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ctx = vm.createContext({ Number, Math, Array, Object, String, escapeHtml });
vm.runInContext(src, ctx, { filename: 'behavior-tags.js' });
const J = v => JSON.parse(JSON.stringify(v));
// 跨 vm 上下文的数组/对象原型不同, deepStrictEqual 会因此误报: 统一把返回值拉回测试上下文
const derive = recent => J(ctx.deriveBehaviorTags(recent));

// 构造一场 SGP 参与者数据
const part = (o = {}) => Object.assign({ win: true, gameEndedInSurrender: false, teamEarlySurrendered: false,
  enemyMissingPings: 0, getBackPings: 0, dangerPings: 0, needVisionPings: 0 }, o);
const sample = (o) => ({ behavior: ctx.extractBehavior(part(o)) });
const samples = (n, o) => Array.from({ length: n }, () => sample(o));
const keys = tags => tags.map(t => t.key);

// ---------- extractBehavior: 字段缺失是未知 ----------
assert.deepStrictEqual(J(ctx.extractBehavior(part({ enemyMissingPings: 5, getBackPings: 2, dangerPings: 1, needVisionPings: 3 }))),
  { pings: { question: 5, retreat: 2, danger: 1, vision: 3 }, surrender: false });
assert.strictEqual(ctx.extractBehavior(null), null);
assert.strictEqual(ctx.extractBehavior('x'), null);
assert.strictEqual(ctx.extractBehavior({ kills: 3 }), null, '什么字段都没有 (外服 LCU 战绩) → 未知, 不是全 0');
{   // 只缺信号 → 只有投降; 只缺投降 → 只有信号
  const noPing = J(ctx.extractBehavior({ win: false, gameEndedInSurrender: true }));
  assert.strictEqual(noPing.pings, null);
  assert.strictEqual(noPing.surrender, true);
  const noSur = J(ctx.extractBehavior({ enemyMissingPings: 1, getBackPings: 1, dangerPings: 1, needVisionPings: 1 }));
  assert.strictEqual(noSur.surrender, null);
  assert.ok(noSur.pings);
}
// 部分信号字段缺失 → 整组信号记为未知 (不能把缺的当 0 拉低均值)
assert.strictEqual(J(ctx.extractBehavior({ win: true, gameEndedInSurrender: false, enemyMissingPings: 4 })).pings, null);
// 非法值 (负数 / NaN / 字符串 / 过大) 不算数
for (const bad of [-1, NaN, '5', 1e6, null, undefined, Infinity]) {
  assert.strictEqual(J(ctx.extractBehavior(part({ enemyMissingPings: bad }))).pings, null, '非法信号值 ' + String(bad));
}

// ---------- 投降口径: 以投降结束 且 本人输了 ----------
assert.strictEqual(J(ctx.extractBehavior(part({ win: false, gameEndedInSurrender: true }))).surrender, true, '输了且以投降结束 = 我这队投降');
assert.strictEqual(J(ctx.extractBehavior(part({ win: true, gameEndedInSurrender: true }))).surrender, false, '赢了且以投降结束 = 对手投降, 不算我');
assert.strictEqual(J(ctx.extractBehavior(part({ win: false, gameEndedInSurrender: false }))).surrender, false, '被推掉基地不算投降');
assert.strictEqual(ctx.extractBehavior({ gameEndedInSurrender: true }), null, '缺 win 又没有信号字段: 什么都不知道, 不生成样本');
assert.strictEqual(J(ctx.extractBehavior({ gameEndedInSurrender: true, enemyMissingPings: 1, getBackPings: 1, dangerPings: 1, needVisionPings: 1 })).surrender, null, '缺 win 无法判断是不是我这队投降 → 未知');

// ---------- 样本量门槛 ----------
assert.deepStrictEqual(derive(samples(7, { win: false, gameEndedInSurrender: true })), [], '7 场不够 8 场, 不下结论');
assert.deepStrictEqual(keys(derive(samples(8, { win: false, gameEndedInSurrender: true }))), ['surrender-high'], '刚好 8 场可以');
assert.deepStrictEqual(derive([]), []);
assert.deepStrictEqual(derive(null), []);
assert.deepStrictEqual(derive([null, undefined, {}, { behavior: null }]), []);
{   // 只统计「带有该字段」的场次: 20 场里只有 5 场有数据 → 不够
  const mixed = samples(5, { win: false, gameEndedInSurrender: true }).concat(Array.from({ length: 15 }, () => ({ behavior: null })));
  assert.deepStrictEqual(derive(mixed), [], '有数据的场次不足 8 场不给标签 (没数据的场次不当成「没投降」)');
}

// ---------- 投降阈值 ----------
{
  const mk = (surr, total) => samples(surr, { win: false, gameEndedInSurrender: true }).concat(samples(total - surr, { win: false }));
  assert.deepStrictEqual(keys(derive(mk(8, 20))), ['surrender-high'], '40% → 常投降');
  assert.deepStrictEqual(keys(derive(mk(7, 20))), ['surrender-mid'], '35% → 易投降');
  assert.deepStrictEqual(keys(derive(mk(6, 20))), ['surrender-mid'], '30%');
  assert.deepStrictEqual(derive(mk(5, 20)), [], '25% 低于阈值');
  assert.deepStrictEqual(derive(mk(0, 20)), []);
  const t = derive(mk(8, 20))[0];
  assert.ok(t.detail.includes('近 20 场里 8 场以投降结束 (40%)'), '说明里要写清统计口径: ' + t.detail);
  // 赢的局里对手投降不能算进来
  const wins = samples(10, { win: true, gameEndedInSurrender: true });
  assert.deepStrictEqual(derive(wins), [], '全是对手投降的胜场 → 没有标签');
}

// 混合数据: 12 场里只有 4 场有投降字段 (其余只有信号字段), 且这 4 场全是投降 → 有投降数据的场次不足 8, 不能给「常投降」,
// 更不能把 8 场「未知」当作「没投降」算进分母
{
  const onlyPings = { behavior: { pings: { question: 0, retreat: 0, danger: 0, vision: 0 }, surrender: null } };
  const surr = samples(4, { win: false, gameEndedInSurrender: true });
  assert.deepStrictEqual(derive(surr.concat(Array.from({ length: 8 }, () => onlyPings))), [], '有投降字段的场次不足 8 场不下结论');
  // 反过来: 8 场有投降字段且全是投降, 另 12 场只有信号字段 → 投降比例应按 8 场算 (100%), 不是 8/20
  const eight = samples(8, { win: false, gameEndedInSurrender: true });
  const t = derive(eight.concat(Array.from({ length: 12 }, () => onlyPings)));
  assert.deepStrictEqual(t.map(x => x.key), ['surrender-high']);
  assert.ok(t[0].detail.includes('近 8 场里 8 场以投降结束 (100%)'), '分母只算有数据的场次: ' + t[0].detail);
}

// 悬停说明要转义: 用带特殊字符的描述直接验证
{
  const ctx2 = vm.createContext({ Number, Math, Array, Object, String, escapeHtml });
  vm.runInContext(src.replace("tags.push({ key: 'ping-danger', label: '爱发危险'", "tags.push({ key: 'ping-danger', label: '<b>\"x\"</b>'"), ctx2);
  const html = ctx2.behaviorTagsHtml(samples(10, { dangerPings: 3 }));
  assert.ok(html.includes('&lt;b&gt;&quot;x&quot;&lt;/b&gt;') && !html.includes('<b>'), '标签文字必须转义: ' + html);
}

// ---------- 信号阈值 ----------
{
  const pings = (n, o) => samples(n, o);
  assert.deepStrictEqual(keys(derive(pings(10, { enemyMissingPings: 4 }))), ['ping-question'], '场均 4 个问号');
  assert.deepStrictEqual(derive(pings(10, { enemyMissingPings: 3 })), [], '场均 3 个问号 < 3.5');
  assert.deepStrictEqual(keys(derive(pings(10, { getBackPings: 4 }))), ['ping-retreat']);
  assert.deepStrictEqual(derive(pings(10, { getBackPings: 3 })), []);
  const d = derive(pings(10, { dangerPings: 3 }));
  assert.deepStrictEqual(keys(d), ['ping-danger']);
  assert.strictEqual(d[0].level, 'info', '危险信号偏向正面, 不算警告色');
  // 合计很高 → 「信号多」, 与单项标签互斥 (不会同时出现意思相近的两个)
  const heavy = derive(pings(10, { enemyMissingPings: 5, getBackPings: 5, dangerPings: 3, needVisionPings: 2 }));
  assert.deepStrictEqual(keys(heavy), ['ping-heavy'], '合计 15 → 信号多, 不再叠加爱发问号/爱发撤退');
  assert.ok(heavy[0].detail.includes('问号 5.0') && heavy[0].detail.includes('撤退 5.0'));
  // 防刷屏: 一场发 40 个问号、其余场次 0 个 → 均值 4 但只有 1/10 的场次发过, 不下结论
  const spam = [sample({ enemyMissingPings: 40 })].concat(samples(9, {}));
  assert.deepStrictEqual(derive(spam), [], '一场刷屏拉高均值不应被当成习惯');
  // 过半场次发过才算
  const half = samples(5, { enemyMissingPings: 8 }).concat(samples(5, {}));
  assert.deepStrictEqual(keys(derive(half)), ['ping-question'], '一半场次发过、均值 4 → 算习惯');
  // 信号样本不足 8 场不给
  assert.deepStrictEqual(derive(pings(7, { enemyMissingPings: 9 })), []);
  // 投降与信号可同时出现
  const both = samples(10, { win: false, gameEndedInSurrender: true, enemyMissingPings: 5 });
  assert.deepStrictEqual(keys(derive(both)).sort(), ['ping-question', 'surrender-high']);
}

// ---------- 展示 ----------
{
  assert.strictEqual(ctx.behaviorTagsHtml([]), '');
  assert.strictEqual(ctx.behaviorTagsHtml(null), '');
  const html = ctx.behaviorTagsHtml(samples(10, { win: false, gameEndedInSurrender: true }));
  assert.ok(/class="lp-behavior lp-behavior-bad"/.test(html) && html.includes('>常投降<'));
  assert.ok(html.includes('阈值为经验值，仅供参考，不代表对该玩家的评价'), '悬停说明里要有免责与口径');
  assert.ok(html.includes('近 10 场里 10 场以投降结束 (100%)'));
  // 说明文字会进 title 属性, 必须转义
  const evil = ctx.behaviorTagsHtml(samples(10, { enemyMissingPings: 5 }));
  assert.ok(!/title="[^"]*"[^>]*"/.test(evil.replace(/title="[^"]*"/, '')), '属性不应被截断');
}

// ---------- 数据流接线 ----------
const live = read('renderer/js/live.js');
assert.ok(live.includes('const behaviorSamples = [];'), 'sgpProfileFor 应单独收集行为样本');
assert.ok(live.includes('extractBehavior(Object.assign({}, me, { win }))'), '把已解析的 win 一并传入 (me.win 可能在 stats 里)');
assert.ok(live.includes('behaviorSamples.length < 30'), '行为样本最多 30 场, 不无限增长');
assert.ok(/recent, teamGames, behaviorSamples,/.test(live), '行为样本应进入缓存的 profile');
assert.ok(live.includes('p.behaviorSamples = Array.isArray(profile.behaviorSamples) ? profile.behaviorSamples : [];'));
assert.ok(live.includes('${riskHtml}${behaviorTagsHtml(p.behaviorSamples)}'), '标签渲染在系统画像后面');
assert.ok(!/lcuProfileFor[\s\S]{0,2500}extractBehavior/.test(live.slice(live.indexOf('async function lcuProfileFor'), live.indexOf('function recentProfileFor'))), '外服 LCU 路径不应编造行为数据');
const html = read('renderer/index.html');
const scripts = [...html.matchAll(/<script src="js\/([^"?]+)/g)].map(m => m[1]);
assert.ok(scripts.indexOf('behavior-tags.js') >= 0 && scripts.indexOf('behavior-tags.js') < scripts.indexOf('live.js'), 'behavior-tags.js 必须在 live.js 之前加载');
const css = read('renderer/css/premium.css');
for (const c of ['.lp-behavior-bad', '.lp-behavior-warn', '.lp-behavior-info']) assert.ok(css.includes(c), '缺少样式 ' + c);
assert.ok(/\.lp-profile-line\s*\{\s*flex-wrap:\s*nowrap;\s*overflow:\s*hidden;/.test(css), '画像行不得折行 (行高是战绩区高度预算的一部分)');

console.log('玩家行为标签测试通过');
