// 1.6.25 回归: 对局详情页多标签 (对齐 Akari 的 match-card)
// - 概览 / 数据 / 符文 三页常驻; 事件 / 曲线 只在国服 SGP (withTimeline) 下出现
// - 切标签只切 class, 不重渲染; 点击必须 stopPropagation (详情挂在卡片 onclick 上)
// - 数据页是 指标 × 10 玩家 矩阵, 每行标最优 (死亡越低越好), 全 0 行不标
// - 符文页直接铺开 10 人完整符文卡, 不再依赖 hover
// - 事件页来自 SGP 时间线, 只渲染 击杀/野怪/建筑, 文案必须中文
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const hex = fs.readFileSync('renderer/js/hex.js', 'utf8');
const review = fs.readFileSync('renderer/js/review.js', 'utf8');
const home = fs.readFileSync('renderer/js/home.js', 'utf8');
const live = fs.readFileSync('renderer/js/live.js', 'utf8');
const css = fs.readFileSync('renderer/css/style.css', 'utf8');

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('ok ' + pass + ' - ' + name); };

// ---------- 静态: 结构接得上 ----------
ok('详情容器带标签栏与五种 pane', () => {
  assert.ok(hex.includes("const tabs = [['summary', '概览'], ['data', '数据'], ['runes', '符文']]"), '三个常驻标签');
  assert.ok(hex.includes("if (withTimeline) tabs.push(['events', '事件'], ['curve', '曲线'])"), '时间线两页按开关追加');
  for (const k of ['summary', 'data', 'runes', 'events', 'curve']) {
    assert.ok(hex.includes(`data-pane="${k}"`), '缺少 pane: ' + k);
  }
});

ok('切标签只切 class 且阻止冒泡', () => {
  assert.ok(hex.includes("pane.classList.toggle('is-on', pane.dataset.pane === key)"), '按 data-pane 切显示');
  assert.ok(hex.includes("b.classList.toggle('active', b === btn)"), '按钮态跟随');
  assert.ok(/tabbar\.addEventListener\('click',[\s\S]{0,400}ev\.stopPropagation\(\)/.test(hex), '切标签必须 stopPropagation');
});

ok('只有战绩页传 withTimeline, 实时浮窗不出现空标签', () => {
  assert.ok(home.includes('renderOpggGameDetail(norm, detail, { withTimeline: true })'), '战绩页应开启时间线两页');
  assert.ok(live.includes('renderOpggGameDetail(norm, holder)'), '实时浮窗保持两参调用');
});

ok('复盘填曲线页, 事件页单独填', () => {
  assert.ok(review.includes("detail.querySelector('[data-pane=\"curve\"]')"), '应定位曲线 pane');
  assert.ok(review.includes("detail.querySelector('[data-pane=\"events\"]')"), '应定位事件 pane');
  assert.ok(review.includes('if (curvePane) { curvePane.innerHTML = \'\'; curvePane.appendChild(box); }'), '曲线页应清空后放复盘块');
  assert.ok(review.includes('else detail.appendChild(box)'), '没有 pane 时退回老行为');
});

// ---------- 运行时: 数据页矩阵 ----------
const matrixSrc = hex.slice(hex.indexOf('const OGD_POS_ORDER'), hex.indexOf('function renderOpggGameDetail'));
const mctx = vm.createContext({
  console,
  cachedSummoner: { puuid: 'me' },
  champNumMap: { 1: { id: 'Annie', name: '黑暗之女' }, 2: { id: 'Olaf', name: '狂战士' }, 3: { id: 'Galio', name: '正义巨像' } },
  champImg: id => 'champ/' + id + '.png',
  placeholder: () => 'ph.png',
  POS_MAP: { TOP: '上单', JUNGLE: '打野', MIDDLE: '中单', BOTTOM: '下路', UTILITY: '辅助' },
  getName: p => p.name,
  escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  runePageCardHtml: p => (p.perkIds && p.perkIds.length ? '<div class="rune-pop-card">card</div>' : '')
});
vm.runInContext(matrixSrc, mctx, { filename: 'hex.tabs.js' });

const mk = (name, teamId, position, o) => Object.assign({
  puuid: name, name, teamId, position, championId: 1, k: 1, d: 1, a: 1, dmg: 1000, gold: 1000,
  cs: 100, level: 10, visionScore: 10, wardsPlaced: 1, wardsKilled: 0, dmgTaken: 1000,
  physDmg: 500, magicDmg: 500, trueDmg: 0, mitigated: 0, healing: 0, allyHeal: 0, shielding: 0, win: teamId === 100
}, o);

const buildNorm = () => {
  const blue = [
    mk('b-top', 100, 'TOP', { k: 5, d: 2, a: 3 }),
    mk('b-jug', 100, 'JUNGLE', { k: 3, d: 6, a: 8 }),
    mk('b-mid', 100, 'MIDDLE', { k: 9, d: 1, a: 4 }),
    mk('b-adc', 100, 'BOTTOM', { k: 7, d: 3, a: 5 }),
    mk('b-sup', 100, 'UTILITY', { k: 1, d: 4, a: 12, visionScore: 55, wardsPlaced: 18, wardsKilled: 5, allyHeal: 3000 })
  ];
  const red = [
    mk('r-top', 200, 'TOP', { k: 2, d: 5, a: 2, win: false }),
    mk('r-jug', 200, 'JUNGLE', { k: 1, d: 7, a: 3, win: false }),
    mk('r-mid', 200, 'MIDDLE', { k: 3, d: 6, a: 4, win: false }),
    mk('r-adc', 200, 'BOTTOM', { k: 2, d: 8, a: 2, win: false }),
    mk('r-sup', 200, 'UTILITY', { k: 0, d: 9, a: 6, visionScore: 30, win: false })
  ];
  const participants = blue.concat(red);
  const teams = { 100: blue, 200: red };
  return { norm: { participants, dur: 1800, teamsObj: {} }, teams, tids: ['100', '200'] };
};
const rating = () => 5;

ok('矩阵列出 10 个玩家列 + 五组指标', () => {
  const { norm, teams, tids } = buildNorm();
  const html = mctx.ogdMatrixHtml(norm, { teams, tids, rating });
  assert.strictEqual((html.match(/class="ogd-mx-col/g) || []).length, 10, '应有 10 列');
  for (const g of ['基础', '输出', '生存', '经济', '视野']) assert.ok(html.includes('>' + g + '<'), '缺少分组: ' + g);
  for (const label of ['评分', 'KDA', '参团率', '总伤害', '队内伤害占比', '视野得分', '分均补刀']) {
    assert.ok(html.includes('>' + label + '<'), '缺少指标: ' + label);
  }
});

ok('死亡行按"越低越好"标最优', () => {
  const { norm, teams, tids } = buildNorm();
  const html = mctx.ogdMatrixHtml(norm, { teams, tids, rating });
  const row = html.split('<tr>').find(r => r.includes('>死亡<'));
  assert.ok(row, '应能找到死亡行');
  const cells = row.match(/<td class="ogd-mx-cell[^"]*">\d+<\/td>/g);
  assert.ok(cells, '死亡行应有单元格');
  // 蓝色中单 1 死最少 → 高亮; 红色辅助 9 死最多 → 不高亮
  const topCells = cells.filter(c => c.includes('is-top'));
  assert.strictEqual(topCells.length, 1, '死亡行只应有一个最优');
  assert.ok(topCells[0].includes('>1<'), '最优应是 1 死的玩家, 实际 ' + topCells[0]);
});

ok('全 0 的行不标最优 (没有"0 排眼最佳")', () => {
  const { norm, teams, tids } = buildNorm();
  // 除辅助外所有人的 wardsKilled 置 0, 但排眼行仍有一人非 0 → 正常; 这里把所有人置 0
  for (const p of norm.participants) p.wardsKilled = 0;
  htmlless: {
    const html = mctx.ogdMatrixHtml(norm, { teams, tids, rating });
    const row = html.split('<tr>').find(r => r.includes('>排眼<'));
    assert.ok(!row.includes('is-top'), '全 0 行不应有最优标记');
  }
});

ok('参团率按本队击杀数算', () => {
  const { norm, teams, tids } = buildNorm();
  const html = mctx.ogdMatrixHtml(norm, { teams, tids, rating });
  // 蓝队击杀 5+3+9+7+1=25, 中单 9+4=13 → 52%
  const row = html.split('<tr>').find(r => r.includes('>参团率<'));
  assert.ok(row.includes('52%'), '中单参团率应为 52%, 行内容: ' + row.slice(0, 200));
});

ok('自己的列有 is-me', () => {
  const { norm, teams, tids } = buildNorm();
  norm.participants[0].puuid = 'me';
  const html = mctx.ogdMatrixHtml(norm, { teams, tids, rating });
  assert.strictEqual((html.match(/ogd-mx-col is-me/g) || []).length, 1, '应只有一列标自己');
});

// ---------- 运行时: 符文页 ----------
ok('符文页铺开 10 人, 缺数据的人给明确提示', () => {
  const { norm, teams, tids } = buildNorm();
  norm.participants.forEach((p, i) => { if (i < 8) p.perkIds = [8010, 9111]; });
  const html = mctx.ogdRunesHtml(norm, { teams, tids });
  assert.strictEqual((html.match(/class="ogd-rune-cell/g) || []).length, 10, '应有 10 个符文格');
  assert.strictEqual((html.match(/rune-pop-card/g) || []).length, 8, '8 人应有符文卡');
  assert.strictEqual((html.match(/该局没有符文数据/g) || []).length, 2, '2 人应提示无数据');
  assert.ok(html.includes('蓝队') && html.includes('红队'), '应按队伍分组');
});

// ---------- 运行时: 事件页 ----------
const evSrc = review.slice(review.indexOf('const OGD_MONSTER_CN'), review.indexOf('async function renderGameReview'));
const ectx = vm.createContext({
  console,
  champNumMap: { 1: { id: 'Annie', name: '黑暗之女' }, 2: { id: 'Olaf', name: '狂战士' } },
  champImg: id => 'champ/' + id + '.png',
  poroIcon: n => '<svg class="pi pi-' + n + '"></svg>',
  escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
});
vm.runInContext(evSrc, ectx, { filename: 'review.events.js' });

const makeP = (name, teamId, championId, puuid) => ({ name, teamId, championId, puuid });
const norms = {
  participants: [makeP('甲', 100, 1, 'p1'), makeP('乙', 100, 2, 'p2'), makeP('丙', 200, 2, 'p3')]
};
const pidPuuid = { 1: 'p1', 2: 'p2', 3: 'p3' };

ok('击杀事件写中文, 首次击杀带一血角标', () => {
  const first = { t: 3.5, kind: 'kill', team: 100, killer: 1, victim: 3, assists: [] };
  const chart = { evts: [first], firstKill: first };
  const html = ectx.ogdEventTimelineHtml(norms, chart, pidPuuid);
  assert.ok(html.includes('03:30'), '应有 03:30 时间戳, 实际: ' + html.slice(0, 200));
  assert.ok(html.includes('<b>甲</b>') && html.includes('击杀') && html.includes('<span>丙</span>'), '击杀文案应含双方玩家');
  assert.ok(html.includes('一血'), '首杀应带一血角标');
  assert.ok(!html.includes('undefined'), '不能出现 undefined');
});

ok('龙/塔/水晶换成中文 + 顶部统计', () => {
  const chart = {
    evts: [
      { t: 9, kind: 'monster', team: 100, monster: 'DRAGON', sub: 'FIRE_DRAGON', killer: 2 },
      { t: 12, kind: 'monster', team: 200, monster: 'BARON_NASHOR', sub: '', killer: 3 },
      { t: 15, kind: 'building', team: 100, building: 'TOWER_BUILDING', tower: 'OUTER_TURRET', killer: 1 },
      { t: 18, kind: 'building', team: 200, building: 'INHIBITOR_BUILDING', tower: '', killer: 3 }
    ],
    firstKill: null
  };
  const html = ectx.ogdEventTimelineHtml(norms, chart, pidPuuid);
  assert.ok(html.includes('小龙(火)'), '龙应带属性');
  assert.ok(html.includes('大龙'), '大龙应中文');
  assert.ok(html.includes('一塔') && html.includes('水晶'), '建筑应中文');
  assert.ok(/小龙\(火\)/.test(html) && html.includes('蓝方') && html.includes('红方'), '应标阵营');
  // 统计: 塔 1:0, 龙 1:0, 大龙 0:1
  assert.ok(html.includes('关键事件'), '应有头部');
  assert.ok(/ogd-ev-sum/.test(html), '应有统计项');
});

ok('没有事件时给空态而不是空白', () => {
  const html = ectx.ogdEventTimelineHtml(norms, { evts: [] }, pidPuuid);
  assert.ok(html.includes('ogd-empty'), '应返回空态');
});

ok('CSS 补齐了标签/矩阵/符文/事件四组样式', () => {
  for (const sel of ['.ogd-tabs', '.ogd-pane.is-on', '.ogd-matrix', '.ogd-mx-cell.is-top', '.ogd-rune-grid', '.ogd-ev-list']) {
    assert.ok(css.includes(sel), '缺少样式: ' + sel);
  }
});

console.log('\nPASS ' + pass + ' cases');
