'use strict';
// 复盘→BP 闭环：review-bp-bridge.js 的提取/存取/适配 + bp-fusion 消费 + home.js 接线。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const NOW = 1700000000000;
function loadBridge(opts) {
  const o = opts || {};
  const win = {};
  const sandbox = { console, Date, Map, Set, JSON, Number, String, Array, Object, Math, window: win };
  if (o.storeGet !== undefined) sandbox.storeGet = o.storeGet;
  if (o.storeSet !== undefined) sandbox.storeSet = o.storeSet;
  if (o.localStorage !== undefined) sandbox.localStorage = o.localStorage;
  vm.runInContext(read('renderer/js/review-bp-bridge.js'), vm.createContext(sandbox));
  return win.PoroReviewBPBridge;
}
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// --- extract：按严重度取短板，过滤 mode 与无映射项 ---
const B = loadBridge();
const issues = [
  { key: 'cs', severity: 1, mode: 'rift' },
  { key: 'vision', severity: 2, mode: 'rift' },
  { key: 'deaths', severity: 3, mode: 'rift' },
  { key: 'kp', severity: 2, mode: 'rift' },
  { key: 'dmg', severity: 2, mode: 'rift' }
];
const ex = B.extract(issues, 12345, 'rift', NOW);
ok(ex.v === 1 && ex.ts === NOW && ex.mode === 'rift', 'payload 元信息');
ok(ex.hints.length === 3, '最多取 3 条（deaths/vision/kp，severity 降序，dmg 被截断）');
ok(ex.hints[0].key === 'deaths', '最严重的 deaths 排第一');
ok(!ex.hints.some(h => h.key === 'cs'), 'cs 不映射到选人');
ok(ex.hints.find(h => h.key === 'vision').tags[0] === 'Support', 'vision → Support');
ok(ex.hints.find(h => h.key === 'deaths').tags.indexOf('Tank') >= 0, 'deaths → Tank/Fighter');
// 海斗模式不产生 vision（riftOnly）
const exHex = B.extract(issues, 1, 'mayhem', NOW);
ok(!exHex.hints.some(h => h.key === 'vision'), '海斗不提示视野短板');
ok(B.extract([], 1, 'rift', NOW).hints.length === 0, '无失误无信号');

// --- save/load：通过 storeSet/storeGet 往返 ---
let stored = null;
const setter = (k, v) => { stored = { k, v }; };
const getter = k => (stored && stored.k === k ? stored.v : null);
const B2 = loadBridge({ storeGet: getter, storeSet: setter });
ok(B2.save(ex, setter) === true, 'save 成功');
ok(stored.k === 'poro.reviewBpHint', 'store key 正确');
const loaded = B2.load({ get: getter }, NOW);
ok(loaded && loaded.hints.length === 3, 'load 往返一致');
ok(B2.load({ get: () => 'not json' }, NOW) === null, '坏 JSON 返回 null');
ok(B2.load({ get: () => null }, NOW) === null, '空值返回 null');
ok(B2.load({ get: () => JSON.stringify(ex) }, NOW + B.MAX_AGE_MS + 1) === null, '过期信号被忽略');

// --- adopt：转成 fusion needs 条目 ---
const adopted = B.adopt(ex);
ok(adopted.length === 3 && adopted[0].source === 'review', 'adopt 带来源标记');
ok(adopted[0].weight === 0.8, '复盘信号权重 0.8');
ok(B.adopt(null).length === 0, '空 payload 无信号');

// --- bp-fusion 消费 reviewHints ---
const champNumMap = { 1:{id:'Annie',name:'安妮'}, 6:{id:'Leona',name:'蕾欧娜'}, 8:{id:'Galio',name:'加里奥'} };
const allChampions = { Annie:{tags:['Mage']}, Leona:{tags:['Tank','Support']}, Galio:{tags:['Tank','Mage']} };
function fusionApi() {
  const win = {};
  vm.runInContext(read('renderer/js/bp-fusion.js'), vm.createContext({
    console, Math, Number, String, Object, Array, escapeHtml: esc, window: win
  }));
  return win.PoroBPFusion;
}
const F = fusionApi();
const hints = B.adopt(ex); // deaths(Tank/Fighter) + vision(Support) + kp(Tank/Support)
const noHints = F.blend([{ id: 1, score: 1, edges: [{}] }, { id: 6, score: 1, edges: [{}] }],
  { ally: [], enemy: [], mode: 'rift', champNumMap, allChampions });
const withHints = F.blend([{ id: 1, score: 1, edges: [{}] }, { id: 6, score: 1, edges: [{}] }],
  { ally: [], enemy: [], mode: 'rift', reviewHints: hints, champNumMap, allChampions });
// 无己方阵容时，needs 本就有「缺前排/缺AP/缺视野」，review 的 Tank/Support 多半重复被跳过；
// 关键验证：带 hints 不报错、且 Leona(补前排+保护) 仍稳定胜出
ok(withHints.rows.length === 2, '带 reviewHints 正常融合');
ok(withHints.rows[0].id === 6, 'Leona 综合分仍最高');
const html = F.render(withHints, { champNumMap, allChampions });
ok(html.indexOf('上局') >= 0 || html.indexOf('补') >= 0, '理由链含补位说明');

// --- home.js 接线：复盘里确实调用了 extract/save ---
const home = read('renderer/js/home.js');
ok(home.indexOf('PoroReviewBPBridge.extract') >= 0, 'home.js 调用 extract');
ok(home.indexOf('PoroReviewBPBridge.save(payload, storeSet)') >= 0, 'home.js 调用 save');
const adv = read('renderer/js/bp-advisor.js');
ok(adv.indexOf('bridge.adopt(bridge.load') >= 0, 'bp-advisor.js 读取并 adopt');
ok(adv.indexOf('reviewHints: extra.reviewHints') >= 0, 'bp-advisor.js 传 reviewHints 给融合');
const idx = read('renderer/index.html');
ok(idx.indexOf('review-bp-bridge.js') >= 0, '桥接模块已加载');

console.log('PASS ' + pass + ' assertions (review→bp bridge)');
