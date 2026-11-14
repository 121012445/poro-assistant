'use strict';
// 纯逻辑模块 live-insights.js 的单测（强化组合台账 / 战绩库检索 / 最该盯的人 / 简报）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..');
const sandbox = { module: undefined, self: undefined };
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
const code = fs.readFileSync(path.join(SRC, 'renderer/js/live-insights.js'), 'utf8');
// UMD 分支: 浏览器侧挂到 root.PoroInsights
vm.runInContext('var window = this;' + code, ctx);
const I = sandbox.PoroInsights;
assert.ok(I, 'PoroInsights 未挂到全局');

// ---------- 模式族 ----------
assert.strictEqual(I.queueFamily(2400), 'mayhem');
assert.strictEqual(I.queueFamily('450'), 'aram');
assert.strictEqual(I.queueFamily(1700), 'arena');
assert.strictEqual(I.queueFamily(420), 'rift');

// ---------- ① 强化组合 ----------
{
  const rows = [
    { aug: [11, 22, 33], w: 1 },
    { aug: [33, 22, 11], w: 1 },   // 顺序不同应合并
    { aug: [11, 22, 33], w: 0 },
    { aug: [44, 55], w: 1 },
    { aug: [66], w: 1 }            // 只有 1 个强化: 不算组合
  ];
  const combos = I.augmentCombos(rows, { minGames: 3 });
  assert.strictEqual(combos.length, 2, '组合应按不同强化集合聚合');
  const top = combos[0];
  assert.deepStrictEqual(top.ids, [11, 22, 33]);
  assert.strictEqual(top.games, 3);
  assert.strictEqual(top.wins, 2);
  assert.strictEqual(top.wr, 67);
  const small = combos[1];
  assert.strictEqual(small.games, 1);
  assert.strictEqual(small.wr, null, '样本 < minGames 不给胜率');

  const usage = I.augmentUsage(rows, { minGames: 3 });
  const u11 = usage.find(u => u.id === 11);
  assert.strictEqual(u11.games, 3);
  assert.strictEqual(u11.wr, 67);
  assert.strictEqual(usage.find(u => u.id === 66).wr, null);
}

// ---------- ② 战绩库检索 ----------
{
  const now = Date.UTC(2026, 10, 15);
  const day = 86400000;
  const rows = [
    { c: 64, q: 2400, w: 1, t: now - 1 * day },
    { c: 64, q: 450, w: 0, t: now - 2 * day },
    { c: 103, q: 2400, w: 1, t: now - 20 * day },
    { c: 64, q: 2400, w: 0, t: now - 40 * day }
  ];
  assert.strictEqual(I.filterLedger(rows, { now }).length, 4);
  assert.strictEqual(I.filterLedger(rows, { now, champId: 64 }).length, 3);
  assert.strictEqual(I.filterLedger(rows, { now, family: 'mayhem' }).length, 3);
  assert.strictEqual(I.filterLedger(rows, { now, champId: 64, family: 'mayhem' }).length, 2);
  assert.strictEqual(I.filterLedger(rows, { now, win: false }).length, 2);
  assert.strictEqual(I.filterLedger(rows, { now, days: 7 }).length, 2);
  // 结果按时间倒序
  const sorted = I.filterLedger(rows, { now });
  assert.ok(sorted[0].t >= sorted[1].t);
}

// ---------- ③ 台账统计: 无分母给 null ----------
{
  const rows = [
    { w: 1, k: 10, d: 5, a: 8, dur: 1200, dmg: 20, kp: 60, vis: 12 },
    { w: 0, k: 3, d: 9, a: 4, dur: 1000, dmg: 30, kp: 50, vis: 30 }
  ];
  const s = I.ledgerStats(rows);
  assert.strictEqual(s.n, 2);
  assert.strictEqual(s.wr, 50);
  assert.strictEqual(s.dAvg, 7);
  assert.strictEqual(s.dmgN, 2);
  assert.strictEqual(s.dmgAvg, 25);
  // 老台账没有 dmg/kp 字段: 分母为 0, 均值必须是 null 而不是 0
  const old = I.ledgerStats([{ w: 1, k: 1, d: 1, a: 1, dur: 600 }]);
  assert.strictEqual(old.dmgN, 0);
  assert.strictEqual(old.dmgAvg, null);
  assert.strictEqual(old.kpAvg, null);
  assert.strictEqual(I.ledgerStats([]).wr, null);
}

// ---------- ④ 最该盯的人 ----------
{
  const mk = (name, dmgList, deaths) => ({
    name, puuid: name, championId: 64,
    recent: dmgList.map((v, i) => ({ dmgPct: v, d: deaths, champId: 64, win: i % 2 === 0 }))
  });
  const players = [
    mk('样本不足', [30, 30]),                 // 只有 2 场, 不够门槛
    mk('中等', [18, 19, 20, 21, 22, 23]),
    mk('最猛', [30, 31, 32, 33, 34, 35], 6),
    { name: '无战绩', recent: [] }
  ];
  const target = I.watchTarget(players, { minGames: 6 });
  assert.ok(target, '应选出一个人');
  assert.strictEqual(target.name, '最猛');
  assert.strictEqual(target.dmg, 33);           // 30..35 的中位数
  assert.strictEqual(target.dmgGames, 6);
  assert.strictEqual(target.deaths, 6);
  // 跨 vm 上下文的对象原型不同, 用 JSON 比较
  assert.strictEqual(JSON.stringify(target.main), JSON.stringify({ championId: 64, games: 6 }));
  // 全都样本不足 -> null
  assert.strictEqual(I.watchTarget([mk('少', [30, 31])], { minGames: 6 }), null);
}

// ---------- ⑤ 简报 ----------
{
  const data = [
    { name: '雨未散', puuid: 'self', team: 100, championId: 64, rank: '翡翠 I 75LP', recent: [{ win: true, k: 10, d: 2, a: 8, champId: 64 }, { win: false, k: 2, d: 9, a: 3, champId: 64 }] },
    { name: '队友A', puuid: 'a', team: 100, championId: 103, rank: '', recent: [{ win: true, k: 5, d: 5, a: 5, champId: 103 }] },
    { name: '对手B', puuid: 'b', team: 200, championId: 99, rank: '黄金 II', recent: [] }
  ];
  const text = I.teamBrief(data, 'self', { mode: '海克斯大乱斗', championName: id => ({ 64: '盲僧', 103: '九尾妖狐' }[id] || '') });
  assert.ok(text.startsWith('【Poro 本局简报】海克斯大乱斗'), '简报标题不对: ' + text.split('\n')[0]);
  assert.ok(text.includes('蓝方 2人'), '缺少蓝方人数');
  assert.ok(text.includes('- 雨未散 · （我） · 翡翠 I 75LP'), '缺少自己那行: ' + text);
  assert.ok(text.includes('近2场 50%'), '自己近 2 场应为 50%');
  assert.ok(text.includes('盲僧 2场'), '应给出主玩英雄');
  assert.ok(text.includes('红方 1人'), '缺少红方');
  assert.ok(text.includes('- 对手B · 黄金 II · 无战绩'), '无战绩玩家应标"无战绩"');
  assert.ok(!text.includes('undefined'), '简报里不应出现 undefined');
  assert.strictEqual(I.teamBrief([], 'self'), '');
}

console.log('live-insights 纯逻辑测试通过');
