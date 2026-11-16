'use strict';
// renderer/js/bp-fusion.js + bp-advisor.js 三合一接入：
// 把「对位 + 阵容补位 + 敌方结构」三套信号揉成一条综合首选。
// 合成数据，无 LCU / 无网络，验算融合规则与渲染安全。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 数字 id -> DDragon 字母 id
const champNumMap = {
  1: { id: 'Annie', name: '安妮' },       // Mage
  2: { id: 'Viktor', name: '维克托' },    // Mage
  3: { id: 'Ahri', name: '阿狸' },        // Mage
  4: { id: 'Garen', name: '盖伦' },       // Tank,Fighter
  5: { id: 'Zed', name: '劫' },            // Assassin
  6: { id: 'Leona', name: '蕾欧娜' },     // Tank,Support
  7: { id: 'Jinx', name: '金克丝' },      // Marksman
  9: { id: 'Evil', name: '<img onerror=alert(1)>' } // XSS 用例
};
const allChampions = {
  Annie: { tags: ['Mage'] }, Viktor: { tags: ['Mage'] }, Ahri: { tags: ['Mage'] },
  Garen: { tags: ['Tank', 'Fighter'] }, Zed: { tags: ['Assassin'] },
  Leona: { tags: ['Tank', 'Support'] }, Jinx: { tags: ['Marksman'] }, Evil: { tags: ['Mage'] }
};

function loadFusion() {
  const win = {};
  const ctx = vm.createContext({
    console, Date, Map, Set, Promise, JSON, Number, String, Array, Object, Math,
    escapeHtml, champNumMap, allChampions, window: win
  });
  vm.runInContext(read('renderer/js/bp-fusion.js'), ctx, { filename: 'bp-fusion.js' });
  return { ctx, api: win.PoroBPFusion };
}

const { api: F } = loadFusion();
const ctx = { champNumMap, allChampions };
let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; }

// --- tagsOf / countTags ---
ok(JSON.stringify(F.tagsOf(4, ctx)) === '["Tank","Fighter"]', '盖伦 tags');
ok(F.tagsOf(999, ctx).length === 0, '未知英雄无 tags');
ok(F.tagsOf(5, { champNumMap: {}, allChampions: {} }).length === 0, '空映射表时返回空');
const cnt = F.countTags([4, 6, 7], ctx);
ok(cnt.Tank === 2 && cnt.Fighter === 1 && cnt.Support === 1 && cnt.Marksman === 1, '多英雄 tags 统计');

// --- needs：己方缺口 ---
const needRift = F.needs({ Tank: 0, Fighter: 0, Mage: 0, Support: 0, Assassin: 0, Marksman: 1 }, {}, true);
const reasons = needRift.map(n => n.reason);
ok(reasons.some(r => r.indexOf('前排') >= 0), '缺前排要识别');
ok(reasons.some(r => r.indexOf('法术') >= 0), '缺 AP 要识别');
ok(reasons.some(r => r.indexOf('视野') >= 0), '峡谷模式 Support=0 应提示缺保护/视野');
ok(F.needs({ Tank: 2, Fighter: 0, Mage: 1, Support: 1 }, {}, true).length === 0, '阵容完整时无需求');
const needHex = F.needs({ Tank: 0, Fighter: 0, Mage: 0, Support: 0 }, {}, false);
ok(!needHex.some(n => n.reason.indexOf('视野') >= 0), '海斗/大乱斗不谈视野');
const needAssassin = F.needs({ Tank: 2, Fighter: 0, Mage: 1, Support: 1 }, { Assassin: 2 }, true);
ok(needAssassin.some(n => n.reason.indexOf('刺客') >= 0), '敌方双刺客要提示');

// --- fitFor：候选补位 ---
const fit = F.fitFor(6, [{ tags: ['Tank', 'Fighter'], reason: '缺前排', weight: 1.5 }], ctx);
ok(fit.score === 1.5 && fit.reasons[0] === '缺前排', '蕾欧娜补前排命中');
ok(F.fitFor(5, [{ tags: ['Tank'], reason: '缺前排', weight: 1.5 }], ctx).score === 0, '劫不补前排');

// --- blend：三套信号叠加并排序 ---
// 场景：我方已亮 Jinx(射手)/Zed(刺客) → 缺前排(1.5)/缺AP(1.2)/缺保护(1.0)；
// 敌方已亮 Ahri(法师) → 不触发针对项。候选池不含已选英雄（advisor 层 unavailable 已过滤）。
const picks = [
  { id: 1, score: 2.0, edges: [{ enemyId: 3 }] },  // 安妮：对位 +2，补 AP(+1.2) => 3.2
  { id: 6, score: 0.5, edges: [{ enemyId: 3 }] },  // 蕾欧娜：对位 +0.5，补前排+保护(+2.5) => 3.0
  { id: 4, score: 5.0, edges: [] },                  // 盖伦：只有自身强度 +5，补前排(+1.5) => 6.5
];
const blended = F.blend(picks, {
  ally: [{ id: 7 }, { id: 5 }], enemy: [{ id: 3 }], mode: 'rift',
  champNumMap, allChampions
});
ok(blended.rows.length === 3, '融合保留全部候选');
ok(blended.rows[0].id === 4, '盖伦自身强度 +5 仍居首');
ok(Math.abs(blended.rows.find(r => r.id === 1).total - 3.2) < 1e-9, '安妮对位2 + 补AP1.2 = 3.2');
ok(Math.abs(blended.rows.find(r => r.id === 6).total - 3.0) < 1e-9, '蕾欧娜对位0.5 + 补前排1.5 + 补保护1.0 = 3.0');
ok(blended.rows.find(r => r.id === 6).reasons.some(x => x.indexOf('前排') >= 0), '蕾欧娜带补前排理由');
ok(blended.rows.find(r => r.id === 1).hasCounter === true && blended.rows.find(r => r.id === 4).hasCounter === false,
  'hasCounter 只在有对位样本时为真');

// 场景2：对位分接近时，补位决定首选
const close = F.blend([
  { id: 1, score: 1.0, edges: [{ delta: 1 }] },   // 安妮 1.0 + 补AP1.2 = 2.2
  { id: 6, score: 1.0, edges: [{ delta: 1 }] }    // 蕾欧娜 1.0 + 补前排1.5+保护1.0 = 3.5
], { ally: [{ id: 7 }, { id: 5 }], enemy: [], mode: 'rift', champNumMap, allChampions });
ok(close.rows[0].id === 6, '对位持平时补前排更多的蕾欧娜胜出');

// --- render：结构 + XSS ---
const html = F.render(blended, ctx);
ok(html.indexOf('bp-fusion') >= 0 && html.indexOf('综合首选') >= 0, '渲染融合块');
ok(html.indexOf('安妮') >= 0 && html.indexOf('蕾欧娜') >= 0, '渲染首选与次选');
const evilBlend = F.blend([{ id: 9, score: 1, edges: [{}] }], { ally: [], enemy: [], mode: 'rift', champNumMap, allChampions });
const evilHtml = F.render(evilBlend, ctx);
ok(evilHtml.indexOf('<img onerror') < 0 && evilHtml.indexOf('&lt;img') >= 0, '恶意英雄名被转义');
ok(F.render({ rows: [] }, ctx) === '', '空结果不渲染');

// --- 接入层：bp-advisor.js buildHtml 带 extra 时插入融合块，三参数调用不插入 ---
function loadAdvisor() {
  const nodes = {};
  const document = { getElementById(id) { return nodes[id] || (nodes[id] = { id, hidden: true, innerHTML: '' }); } };
  const win = {};
  const opggPosList = [
    { championId: 1, positionKey: 'MID', stats: { win_rate: 0.5, play: 5000, pick_rate: .05, ban_rate: .1 } },
    { championId: 4, positionKey: 'MID', stats: { win_rate: 0.5, play: 5000, pick_rate: .05, ban_rate: .1 } }
  ];
  const sandbox = {
    console, Date, Map, Set, Promise, JSON, Number, String, Array, Object, Math,
    escapeHtml, champNumMap, allChampions, champImg: id => '/img/' + id + '.png',
    opggPosList, opggMap: {}, document, window: win
  };
  const ctx2 = vm.createContext(sandbox);
  // 两个模块共享同一个 win：bp-advisor 的 buildHtml 通过 window.PoroBPFusion 调用
  vm.runInContext(read('renderer/js/bp-fusion.js'), ctx2);
  vm.runInContext(read('renderer/js/bp-advisor.js'), ctx2);
  return { api: win.PoroBPAdvisor, fusion: win.PoroBPFusion };
}
const A = loadAdvisor();
const st = {
  inChampSelect: true, myPosition: 'mid', myChampionId: 0, myIntentId: 0,
  enemy: [{ id: 3, pos: 'mid' }], ally: [{ id: 7, pos: 'adc' }, { id: 5, pos: 'mid' }],
  unavailable: new Set(), bannedMy: [], bannedTheir: [], myAction: 'pick'
};
const adPicks = [{ id: 1, score: 3.2, edges: [{ enemyId: 3, enemyName: '阿狸', delta: 2, play: 500, lane: true }], base: .5, missing: 0, tier: 1, banRate: .1 }];
ok(A.api.buildHtml(st, adPicks, []).indexOf('bp-fusion') < 0, '三参数调用不渲染融合块（兼容旧测试）');
ok(A.api.buildHtml(st, adPicks, [], { ally: st.ally, enemy: st.enemy, mode: 'rift' }).indexOf('bp-fusion') >= 0,
  '带 extra 时渲染融合块');

console.log('PASS ' + pass + ' assertions (bp-fusion + advisor 接入)');
