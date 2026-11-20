'use strict';
// 同段位基准线: 用 OP.GG 分段数据算加权分位数当 KDA 参考带。
// 重点验证三件事: 加权分位不被冷门英雄带偏 / 段位映射 / 数据不足时不硬给参考带。
const assert = require('assert');
const rb = require('./renderer/js/rank-bench.js');

// 造一份基准: 中单 8 个有效英雄 (play>=200) + 2 个冷门英雄。
// 有效英雄 KDA 升序: 2.0 2.2 2.4 2.6 3.0 3.2 3.6 (各 200 场) + 4.0 (880 场)
//   总场次 2280, 中位点 = 1140 → 落在 KDA 3.2 那一档;
//   若按"英雄个数"取中位会是 (2.6+3.0)/2 = 2.8 —— 两者不同, 才能验证是按场次加权。
//   75 分位点 = 1710 → 落在 4.0 那一档。
function bench(over) {
  const champions = {
    // 冷门: 20 / 100 场, 应被 MIN_PLAY 过滤
    1: { MID: { play: 20, kda: 1.0, winRate: 44, pickRate: 0.2, banRate: 0.1, rank: 9 } },
    2: { MID: { play: 100, kda: 1.5, winRate: 46, pickRate: 0.4, banRate: 0.2, rank: 8 } },
    // 主力: 880 场
    3: { MID: { play: 880, kda: 4.0, winRate: 53, pickRate: 9, banRate: 3, rank: 5 } },
    // 长尾但够场次
    4: { MID: { play: 200, kda: 2.0, winRate: 48, pickRate: 2, banRate: 1, rank: 1 } },
    5: { MID: { play: 200, kda: 2.2, winRate: 48, pickRate: 2, banRate: 1, rank: 2 } },
    6: { MID: { play: 200, kda: 2.4, winRate: 49, pickRate: 2, banRate: 1, rank: 3 } },
    7: { MID: { play: 200, kda: 2.6, winRate: 49, pickRate: 2, banRate: 1, rank: 4 } },
    8: { MID: { play: 200, kda: 3.0, winRate: 50, pickRate: 2, banRate: 1, rank: 6 } },
    9: { MID: { play: 200, kda: 3.2, winRate: 51, pickRate: 2, banRate: 1, rank: 7 } },
    10: { MID: { play: 200, kda: 3.6, winRate: 52, pickRate: 2, banRate: 1, rank: 10 } },
    // 辅助只有一个英雄 → 数据不足
    11: { SUPPORT: { play: 500, kda: 2.5, winRate: 51, pickRate: 4, banRate: 2, rank: 1 } }
  };
  return Object.assign({
    tier: 'platinum', region: 'global', version: '16.23', champions
  }, over || {});
}

// ① 段位映射: LCU 枚举 → OP.GG 参数; 认不出来一律 all
assert.strictEqual(rb.tierParamOf('PLATINUM'), 'platinum');
assert.strictEqual(rb.tierParamOf('grandmaster'), 'grandmaster');
assert.strictEqual(rb.tierParamOf(''), 'all');
assert.strictEqual(rb.tierParamOf('UNRANKED'), 'all');

// ② 位置映射: LCU 的 MIDDLE/BOTTOM/UTILITY 要换成 OP.GG 的 MID/ADC/SUPPORT
assert.strictEqual(rb.posKeyOf('MIDDLE'), 'MID');
assert.strictEqual(rb.posKeyOf('BOTTOM'), 'ADC');
assert.strictEqual(rb.posKeyOf('UTILITY'), 'SUPPORT');
assert.strictEqual(rb.posKeyOf(''), '');

// ③ 加权分位: 880 场的那一档决定中位数, 按英雄个数取中位会得到 2.8
const mid = rb.positionRef(bench(), 'MID');
assert.ok(mid, '中单应有参考带');
assert.strictEqual(mid.mid, 3.2, '中位数应按场次加权');
assert.strictEqual(mid.low, 3.04, '下沿 = 中位 ×0.95');
assert.strictEqual(mid.high, 3.68, '上沿 = 中位 ×1.15');
assert.strictEqual(mid.play, 2280, '样本场次只算有效英雄');
assert.strictEqual(mid.champs, 8);

// ④ play < MIN_PLAY 的冷门英雄不参与
const ids = rb.rowsOf(bench(), 'MID').map(r => r.championId).sort((a, b) => a - b);
assert.deepStrictEqual(ids, [3, 4, 5, 6, 7, 8, 9, 10], '20 / 100 场的那两位应被过滤');

// ⑤ 位置数据不足 (只有 1 个英雄) → 不给参考带, 免得拿一个英雄的数据冒充全位置
assert.strictEqual(rb.positionRef(bench(), 'SUPPORT'), null, '有效英雄 < 8 个时返回 null');
assert.strictEqual(rb.refFor(bench(), 'UTILITY'), null);

// ⑥ refFor 只覆盖 KDA, 形状是 { kda: [中位, 优秀] }
const ref = rb.refFor(bench(), 'MIDDLE');
assert.ok(ref && Array.isArray(ref.kda) && ref.kda.length === 2, 'refFor 应给 { kda: [mid, high] }');
assert.deepStrictEqual(ref.kda, [3.04, 3.68]);
assert.deepStrictEqual(Object.keys(ref), ['kda'], '不要顺手给别的指标编参考带');

// ⑦ 单英雄查询与最强榜
const row = rb.championRow(bench(), 3, 'MID');
assert.strictEqual(row.kda, 4);
assert.strictEqual(row.position, 'MID');
assert.strictEqual(row.winRate, 53);
assert.strictEqual(rb.championRow(bench(), 999, 'MID'), null, '没有的英雄返回 null');
const top = rb.strongest(bench(), 'MID', 2);
assert.deepStrictEqual(top.map(x => x.championId), [4, 5], '按名次升序, rank 1 在前');

// ⑧ 加权分位边界: 空数组 / 全零场次
assert.strictEqual(rb.weightedQuantile([], 0.5), null);
assert.strictEqual(rb.weightedQuantile([{ kda: 0, play: 10 }], 0.5), null);

// ⑨ 渲染: 含表格与免责说明; 失败态给"取不到数据"且不崩
const html = rb.html(bench(), { champName: id => ({ 3: '维克托', 4: '劫', 5: '阿狸' }[id] || '') });
assert.ok(html.indexOf('rbk-table') > 0, '应渲染表格');
assert.ok(html.indexOf('铂金') > 0, '应写明段位');
assert.ok(html.indexOf('国服') > 0, '必须写明国服无覆盖');
assert.ok(html.indexOf('劫') > 0 && html.indexOf('阿狸') > 0, '最强榜应带英雄名');
assert.ok(html.indexOf('16.23') > 0, '应带 OP.GG 版本号');
const fail = rb.html({ __error: 'Timeout' }, {});
assert.ok(fail.indexOf('取不到数据') > 0 && fail.indexOf('Timeout') > 0, '失败态要同时给出原因');
assert.ok(rb.html(null, {}).indexOf('取不到数据') > 0, 'null 也不能崩');

// ⑩ 接入 position-kpi: 传入 ref 就顶掉经验值, 不传保持原样
const kpi = require('./renderer/js/position-kpi.js');
const rows = Array.from({ length: 5 }, () => ({ win: true, k: 3, d: 5, a: 8, cs: 120, dur: 1800, kp: 50, dmgPct: 30, tankPct: 20, goldPct: 20, vision: 20, dmgGold: 100 }));
// 场均 KDA = (3+8)/5 = 2.2; 经验带 [2.0, 3.4] → ok; 换成 [2.4, 3.0] → weak
const def = kpi.kpis(rows, 'MIDDLE').find(x => x.key === 'kda');
assert.strictEqual(def.tone, 'ok');
assert.strictEqual(def.refSrc, 'local');
const withRef = kpi.kpis(rows, 'MIDDLE', { ref: { kda: [2.4, 3.0] } }).find(x => x.key === 'kda');
assert.strictEqual(withRef.tone, 'weak', '自定义参考带应生效');
assert.strictEqual(withRef.refSrc, 'opgg');
// 其它指标不受影响
const cspm = kpi.kpis(rows, 'MIDDLE', { ref: { kda: [2.4, 3.0] } }).find(x => x.key === 'cspm');
assert.strictEqual(cspm.refSrc, 'local', '没给参考带的指标仍走本地经验值');

console.log('test_rank_bench: OK');
