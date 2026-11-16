'use strict';
// 成长页 30/90 天口径：验证分窗计算正确，且渲染层对"两栏相同"给出明确说明。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// 加载 growth-model（IIFE 暴露到 global root）
function loadModel() {
  const root = {};
  vm.runInNewContext(read('renderer/js/growth-model.js'),
    { console, Date, Math, Number, String, Object, Array, Map, Set, JSON, parseInt, parseFloat, root,
      window: root, module: { exports: {} } });
  return root.PoroGrowth || (typeof module !== 'undefined' && module.exports);
}
// 该模块用 (typeof module !== 'undefined' && module.exports) 导出，node 里直接 require 更简单
const G = require('./renderer/js/growth-model.js');
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const DAY = 86400000;
const NOW = 1700000000000;
// 构造：近 20 天全是英雄 1；31-60 天全是英雄 2；61-90 天全是英雄 3
const recs = [];
const mk = (t, c, w) => ({ t, c, w: w || false, k: 5, d: 3, a: 7, cs: 150, dur: 1800 });
for (let i = 0; i < 9; i++) recs.push(mk(NOW - (5 + i * 2) * DAY, 1, true));       // 5~21 天前
for (let i = 0; i < 7; i++) recs.push(mk(NOW - (35 + i * 3) * DAY, 2, i % 2 === 0)); // 35~53 天前
for (let i = 0; i < 6; i++) recs.push(mk(NOW - (65 + i * 4) * DAY, 3, false));      // 65~85 天前

const tr = G.buildTrend(recs, NOW);
ok(tr.d30.n === 9, '近 30 天 9 局');
ok(tr.d90.n === 22, '近 90 天 22 局（含全部）');
ok(tr.prev30.n === 7, '31-60 天 7 局');
const c30 = tr.champs30.map(x => x.id), c90 = tr.champs90.map(x => x.id);
ok(c30.length === 1 && c30[0] === 1, '30 天 top = 英雄1');
ok(JSON.stringify(c90) === JSON.stringify([1, 2, 3]), '90 天 top 含三个英雄，按场次排序');
ok(JSON.stringify(c30) !== JSON.stringify(c90), '两窗数据不同，确实能区分');
ok(G.statsOf(G.buildTrend(recs.slice(0, 9), NOW).d90.records || []).n >= 0, '边界：少量记录不崩');

// 与 DESIGN 债描述一致的场景：所有记录都在 30 天内时，两栏本就相同
const recentOnly = G.buildTrend(recs.slice(0, 9), NOW);
ok(JSON.stringify(recentOnly.champs30.map(x => x.id)) === JSON.stringify(recentOnly.champs90.map(x => x.id)),
  '数据全在近 30 天时，两栏应相同（数据事实，不是 bug）');

// --- 渲染层：growth.js 对两栏做区分说明 + 传 total ---
const growth = read('renderer/js/growth.js');
ok(growth.indexOf("champLine(tr.champs30, tr.d30.n)") >= 0, '30 天栏传 d30.n 作分母');
ok(growth.indexOf("champLine(tr.champs90, tr.d90.n)") >= 0, '90 天栏传 d90.n 作分母');
ok(growth.indexOf('与近 90 天一致') >= 0 && growth.indexOf('较近 90 天有变化') >= 0, '渲染层对两栏是否相同给出说明');
ok(growth.indexOf('const sameTop =') >= 0, 'sameTop 判定存在');
ok(growth.indexOf('局 · ${share}%') >= 0, '每个英雄显示场次与占比');

console.log('PASS ' + pass + ' assertions (growth 30/90 window)');
