'use strict';
// 1.6.68: BP 建议的「己方阵容」视角 —— 不只给我那一路出候选，
// 而是把己方还空着的位置逐个列出候选（对位 + 补位 + 本位置强度）。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const src = read('renderer/js/bp-advisor.js');
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 数字 id → 名字；字母 id → 头像
const CHAMPS = {
  1: { id: 'Annie', name: '安妮' },
  2: { id: 'Viktor', name: '维克托' },
  3: { id: 'Ahri', name: '阿狸' },
  4: { id: 'Garen', name: '盖伦' },
  5: { id: 'Zed', name: '劫' },
  6: { id: 'Amumu', name: '阿木木' },
  7: { id: 'Leona', name: '蕾欧娜' },
  8: { id: 'Jinx', name: '金克丝' },
  10: { id: 'Kaisa', name: '卡莎' },
  11: { id: 'LeeSin', name: '盲僧' },
  12: { id: 'Graves', name: '男枪' },
  13: { id: 'Senna', name: '赛娜' }
};
const champNumMap = Object.assign({}, CHAMPS);
const statsOf = (wr, play) => ({ win_rate: wr, play, pick_rate: 0.05, ban_rate: 0.1, tier_data: { tier: 2 } });
const opggPosList = [
  { championId: 1, positionKey: 'MID', stats: statsOf(0.50, 5000) },
  { championId: 2, positionKey: 'MID', stats: statsOf(0.50, 5000) },
  { championId: 4, positionKey: 'TOP', stats: statsOf(0.54, 8000) },
  { championId: 5, positionKey: 'TOP', stats: statsOf(0.50, 5000) },
  { championId: 11, positionKey: 'JUNGLE', stats: statsOf(0.52, 5000) },
  { championId: 12, positionKey: 'JUNGLE', stats: statsOf(0.49, 3000) },
  { championId: 8, positionKey: 'ADC', stats: statsOf(0.51, 9000) },
  { championId: 10, positionKey: 'ADC', stats: statsOf(0.51, 9000) },
  { championId: 7, positionKey: 'SUPPORT', stats: statsOf(0.50, 7000) },
  { championId: 13, positionKey: 'SUPPORT', stats: statsOf(0.49, 2000) },
  { championId: 13, positionKey: 'ADC', stats: statsOf(0.50, 4000) }
];
const opggMap = {};

function load() {
  const nodes = {};
  const document = { getElementById(id) { return nodes[id] || (nodes[id] = { id, hidden: true, innerHTML: '' }); } };
  const win = {};
  const sandbox = {
    console, Date, Map, Set, Promise, JSON, Number, String, Array, Object, Math,
    escapeHtml, champNumMap, champImg: id => '/img/' + id + '.png',
    opggPosList, opggMap, document, window: win
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: 'bp-advisor.js' });
  return { ctx, nodes, api: win.PoroBPAdvisor };
}

const { api } = load();
const byId = (rows, id) => rows.find(r => r.id === id);
const num = (v, d) => Number(v.toFixed(d == null ? 2 : d));

// ---------- 1. 会话: 己方空缺位置 ----------
// 排位典型场面: 我(2) 中单没选, 1 楼锁了上单, 3 楼打野预选, 4/5 还没定
const session = {
  localPlayerCellId: 2,
  myTeam: [
    { cellId: 1, championId: 4, assignedPosition: 'TOP' },
    { cellId: 2, championId: 0, assignedPosition: 'MIDDLE' },
    { cellId: 3, championId: 0, championPickIntent: 6, assignedPosition: 'JUNGLE' },
    { cellId: 4, championId: 0, assignedPosition: 'BOTTOM' },
    { cellId: 5, championId: 0, assignedPosition: 'UTILITY' }
  ],
  theirTeam: [
    { cellId: 6, championId: 3, assignedPosition: 'MIDDLE' },
    { cellId: 7, championId: 8, assignedPosition: 'BOTTOM' }
  ],
  actions: [], bans: { myTeamBans: [], theirTeamBans: [] }
};
const st = api.readSession(session);
assert.strictEqual(st.myPosition, 'mid', '自己的位置仍要正确解析');
assert.strictEqual(st.openPositions.length, 3, '只剩中单/下路/辅助三个空位 (上单已锁, 打野已预选)');
assert.deepStrictEqual(Array.from(st.openPositions).map(s => s.pos), ['mid', 'adc', 'support'], '自己在最前, 其余按选人顺位');
assert.strictEqual(st.openPositions[0].mine, true, '第一行必须是我自己那路');
assert.ok(st.openPositions.slice(1).every(s => !s.mine), '队友的空位不能标成我');

// 全员已定 -> 没有空位
const full = api.readSession({
  localPlayerCellId: 2,
  myTeam: [
    { cellId: 1, championId: 4, assignedPosition: 'TOP' },
    { cellId: 2, championId: 2, assignedPosition: 'MIDDLE' }
  ],
  theirTeam: [], actions: [], bans: {}
});
assert.strictEqual(full.openPositions.length, 0, '都选完了就不该再有候选位');

// 没分路（盲选） -> 空数组，不能瞎猜
const blind = api.readSession({
  localPlayerCellId: 1,
  myTeam: [{ cellId: 1, championId: 0 }, { cellId: 2, championId: 0 }],
  theirTeam: [], actions: [], bans: {}
});
assert.strictEqual(blind.openPositions.length, 0, '没有 assignedPosition 时不能给阵容建议');

// 两个人抢同一路（乱选位）只算一个空位
const dup = api.readSession({
  localPlayerCellId: 1,
  myTeam: [
    { cellId: 1, championId: 0, assignedPosition: 'MIDDLE' },
    { cellId: 2, championId: 0, assignedPosition: 'MIDDLE' }
  ],
  theirTeam: [], actions: [], bans: {}
});
assert.strictEqual(dup.openPositions.length, 1, '同一位置出现两次只保留一个候选位');

// ---------- 2. recommendFor: 换位置就换池子、换对线权重 ----------
const tables = {
  // 敌方中单阿狸(3) 对位表: 维克托 56% 打她, 盖伦 44% 被她打
  '3:mid': { '2': { play: 800, wr: 0.56 }, '4': { play: 800, wr: 0.44 }, '6': { play: 800, wr: 0.58 } },
  // 敌方下路金克丝(8) 对位表: 阿木木(6) 打她 55%, 维克托 52%
  '8:adc': { '11': { play: 900, wr: 0.55 }, '2': { play: 900, wr: 0.52 } }
};

const midRows = api.recommendFor(st, tables, 'mid');
assert.deepStrictEqual(Array.from(midRows).map(r => r.id), [2, 1], '中单池只有安妮/维克托 (金克丝在敌方已被排除)');
// 维克托: 打阿狸 +6 (同位置权重 1) + 打金克丝 +2×0.35 = 6.7
assert.strictEqual(num(byId(midRows, 2).score), 6.7, '同位置权重 1, 跨位置权重 0.35 都要算进去');
assert.ok(byId(midRows, 2).edges.some(e => e.lane === true), '打阿狸那条是同位置对位');
assert.ok(byId(midRows, 2).edges.some(e => e.lane === false), '打金克丝那条要标成非对线');

// 打野池: 阿木木 52% 本位置 + 对敌方下路 55%(跨位置 0.35); 盖伦 49% 无对位数据
const jungleRows = api.recommendFor(st, tables, 'jungle');
assert.deepStrictEqual(Array.from(jungleRows).map(r => r.id).sort((a, b) => a - b), [11, 12], '打野池是盲僧/男枪 (己方已亮的上单/打野预选被排除)');
const lee = byId(jungleRows, 11);
assert.strictEqual(num(lee.score), 1.2 + 5 * 0.35, '打野给盲僧: 自身 +1.2, 跨位置对位 +5×0.35');
assert.ok(lee.edges.some(e => e.enemyId === 8 && e.lane === false), '对敌方下路的优势要标成非对线');

// 下路池: 金克丝已经被敌方选走, 只剩卡莎/赛娜
const adcRows = api.recommendFor(st, tables, 'adc');
assert.deepStrictEqual(Array.from(adcRows).map(r => r.id), [10, 13], '敌方已亮的英雄不能再出现在己方候选里');
assert.strictEqual(num(byId(adcRows, 10).score), 0.6, '卡莎 51% 自身强度 = +0.6');

// 老接口行为不变: recommend == 我这路
const legacy = api.recommend(st, tables);
assert.deepStrictEqual(Array.from(legacy).map(r => r.id), ['2', '1'].map(Number), 'recommend 仍只给我那一路');
assert.strictEqual(legacy.length, midRows.length, 'recommend 与 recommendFor(mid) 条数一致');

// limit 生效
assert.strictEqual(api.recommendFor(st, tables, 'mid', { limit: 1 }).length, 1, 'limit 要能限条数');

// ---------- 3. teamPicks: 逐位候选 + 跨位置去重 ----------
const rows = api.teamPicks(st, tables, { perPos: 2 });
assert.deepStrictEqual(Array.from(rows).map(r => r.pos), ['mid', 'adc', 'support'], '每个空位一行, 顺序同 openPositions');
assert.strictEqual(rows[0].mine, true, '第一行是我');
assert.strictEqual(rows[0].picks.length, 1, '我这行只给首选 —— 下面已有详细 Pick 栏, 不重复铺三个');
assert.strictEqual(rows[0].posCn, '中单', '位置要有中文名');

const allIds = rows.flatMap(r => Array.from(r.picks).map(p => p.id));
assert.strictEqual(new Set(allIds).size, allIds.length, '同一个英雄不能出现在两个位置');

// 赛娜同时在 ADC 与 SUPPORT 池里: 下路行先拿到它, 辅助行只能给别的
const adcRow = rows.find(r => r.pos === 'adc');
const supportRow = rows.find(r => r.pos === 'support');
assert.ok(Array.from(adcRow.picks).some(p => p.id === 13), '下路行应给出赛娜(ADC 池里有它)');
assert.ok(!Array.from(supportRow.picks).some(p => p.id === 13), '辅助行不能再出赛娜, 否则面板上重复');
assert.ok(Array.from(supportRow.picks).some(p => p.id === 7), '辅助行应给出蕾欧娜');

// perPos 上限
for (const r of rows) assert.ok(r.picks.length <= 2, '每个位置最多 perPos 条');

// 没有空位 -> 空数组, 不报错
assert.strictEqual(api.teamPicks({ openPositions: [], enemy: [], unavailable: new Set() }, {}, {}).length, 0);

// ---------- 4. 渲染 ----------
const html = api.buildHtml(st, legacy, [], { posPicks: rows });
assert.ok(html.includes('己方阵容'), '面板要有己方阵容区块');
assert.ok(html.includes('同一个英雄只出现一次'), '去重口径要写清楚');
assert.ok(html.includes('中单') && html.includes('下路') && html.includes('辅助'), '每个空位都要出现');
assert.ok(html.includes('bp-tp-chip'), '候选用胶囊样式');
assert.ok(html.includes('bp-tp-mine'), '我这行要高亮');
assert.ok(html.includes('>你<'), '我这行要标"你"');
assert.ok(html.includes('详情见下方 Pick'), '我这行要指路到详细 Pick 栏');
assert.ok(html.includes('bp-tp-score pos') || html.includes('bp-tp-score neg'), '候选带分数与正负配色');
assert.ok(html.includes('/img/Kaisa.png'), '候选要带头像');
assert.ok(html.includes('本位置胜率'), 'title 里要写依据');

// 不传 posPicks（旧调用）时整块不渲染
const plain = api.buildHtml(st, legacy, []);
assert.ok(!plain.includes('bp-team'), '旧调用不应凭空多出阵容区块');

// 有空隙但一行都没候选（数据缺失）时也不渲染空壳
const hollow = api.buildHtml(st, legacy, [], { posPicks: [{ pos: 'top', posCn: '上单', picks: [] }] });
assert.ok(!hollow.includes('bp-team'), '没有候选时不要渲染空区块');

// 阵容建议里的英雄名同样要转义
const evil = load();
evil.ctx.champNumMap[9] = { id: 'Evil', name: '<img onerror=alert(1)>' };
const evilHtml = evil.api.teamPicksHtml([{ pos: 'mid', posCn: '中单', mines: false, picks: [{ id: 9, score: 1, total: 1, base: 0.5, edges: [] }] }]);
assert.ok(!evilHtml.includes('<img onerror'), '阵容候选名必须转义');
assert.ok(evilHtml.includes('&lt;img'), '转义后保留为文本');

// ---------- 5. refresh 全链路 ----------
const lcNodes = {};
const lcDoc = { getElementById(id) { return lcNodes[id] || (lcNodes[id] = { id, hidden: true, innerHTML: '' }); } };
const lcWin = {};
const lcCtx = vm.createContext({
  console, Date, Map, Set, Promise, JSON, Number, String, Array, Object, Math,
  escapeHtml, champNumMap, champImg: id => '/img/' + id + '.png',
  opggPosList, opggMap, document: lcDoc, window: lcWin,
  lolAPI: {
    getOpggCounters: async (id, pos) => {
      if (id === 3) return { championId: 3, position: pos, rows: [{ championId: 2, play: 800, win: 448 }, { championId: 1, play: 800, win: 400 }] };
      if (id === 8) return { championId: 8, position: pos, rows: [{ championId: 6, play: 900, win: 495 }, { championId: 2, play: 900, win: 468 }] };
      return { __error: 'HTTP 500' };
    }
  }
});
vm.runInContext(src, lcCtx, { filename: 'bp-advisor.js' });
const lcApi = lcWin.PoroBPAdvisor;
const box = lcDoc.getElementById('bpAdvisor');
const body = lcDoc.getElementById('bpAdvisorBody');

Promise.resolve()
  .then(() => lcApi.refresh(session))
  .then(() => {
    assert.strictEqual(box.hidden, false, '选人阶段应显示面板');
    assert.ok(body.innerHTML.includes('己方阵容'), '面板里要有阵容区块');
    assert.ok(body.innerHTML.includes('中单') && body.innerHTML.includes('下路'), '要覆盖到队友的位置');
    assert.ok(body.innerHTML.includes('推荐 Pick') && body.innerHTML.includes('推荐 Ban'), '原有两栏不能丢');
    // 盲选会话 -> 仍然给说明而不是空白
    return lcApi.refresh({ localPlayerCellId: 1, myTeam: [{ cellId: 1, championId: 5 }], theirTeam: [{ cellId: 6, championId: 3 }], bans: {} });
  })
  .then(() => {
    assert.strictEqual(box.hidden, false, '无分路时也应有说明');
    assert.ok(body.innerHTML.includes('只在有选位环节的模式里可用'), '无分路应说明原因');
  })
  .then(() => {
    // ---------- 6. 只读守卫 + 接线 ----------
    for (const bad of ['lcuRequest', "'PATCH'", '"PATCH"', 'doAutoBP']) {
      assert.ok(!src.includes(bad), 'BP 建议必须只读, 不应出现 ' + bad);
    }
    const idx = read('renderer/index.html');
    assert.ok(/bp-advisor\.js\?v=\d+/.test(idx), 'bp-advisor.js 要有版本串, 避免缓存旧逻辑');
    const css = read('renderer/css/poro-1630.css');
    for (const cls of ['.bp-team', '.bp-tp-row', '.bp-tp-chip', '.bp-tp-score']) {
      assert.ok(css.includes(cls), '缺少样式 ' + cls);
    }
    console.log('BP 己方阵容逐位候选测试通过');
  })
  .catch(e => { console.error(e); process.exitCode = 1; });
