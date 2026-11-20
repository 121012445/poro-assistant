'use strict';
// 1.6.30 其余新模块的纯函数断言: 熟练度 / 回放书签 / 遭遇库 / 账号漂移 / 强化反查 / i18n
const assert = require('assert');

// 这些模块里有 `window.xxx` 的读取, node 下先造一个最小 window
global.window = global.window || {};
global.window.PORO_AUG_META = {
  1: { name: '加速巫术', rarity: '棱彩', local: 'assets/aug/1.png' },
  2: { name: '尖端发明家', rarity: '黄金', local: 'assets/aug/2.png' },
  3: { name: '虚无强化符文', rarity: '白银', local: '' }
};
global.window.PORO_I18N = { en: { '首页': 'Home' } };
global.storeGet = (k) => (k === 'locale' ? 'en' : null);

const mastery = require('./renderer/js/mastery.js');
const marks = require('./renderer/js/replay-marks.js');
const recent = require('./renderer/js/recent-players.js');
const drift = require('./renderer/js/account-drift.js');
const hexCross = require('./renderer/js/hex-cross.js');
const i18n = require('./renderer/js/i18n.js');

// ---------- 熟练度 ----------
const rawMastery = [
  { championId: 103, championLevel: 7, championPoints: 320000, lastPlayTime: 1700000000000 },
  { championId: 64, championLevel: 5, championPoints: 90000 },
  { championId: 99, championLevel: 7, championPoints: 450000 },
  { championId: 0, championLevel: 9, championPoints: 1 }
];
const b = mastery.buckets(rawMastery);
assert.strictEqual(b.total, 3, '无效英雄 id 应被过滤');
assert.strictEqual(b.l7, 2);
assert.strictEqual(b.l5, 1);
assert.strictEqual(b.points, 860000);
assert.deepStrictEqual(mastery.top(rawMastery, 2).map(x => x.championId), [99, 103], '按点数排序');

// 挑战: 两种结构都要能读
assert.strictEqual(mastery.challengeSummary({ __error: true }), null);
const cs1 = mastery.challengeSummary({ categoryProgress: [{ category: '想象力', completedIds: [1, 2], totalIds: 5 }, { category: '专精', completedIds: [1], totalIds: 2 }] });
assert.deepStrictEqual([cs1.total, cs1.done], [7, 3]);
assert.strictEqual(cs1.categories.length, 2);
const cs2 = mastery.challengeSummary([{ completedIds: [1] }, { completedIds: [] }]);
assert.deepStrictEqual([cs2.total, cs2.done], [2, 1]);

// 渲染: 没有数据时给的是"没有返回"而不是假进度
assert.ok(mastery.html([], null).indexOf('没有返回') > 0);
const rawChallenge = { categoryProgress: [{ category: '想象力', completedIds: [1, 2], totalIds: 5 }, { category: '专精', completedIds: [1], totalIds: 2 }] };
const mHtml = mastery.html(rawMastery, rawChallenge, { champName: id => '英雄' + id, champImg: id => 'x.png' });
assert.ok(mHtml.indexOf('熟练度') > 0 && mHtml.indexOf('挑战') > 0);

// ---------- 回放书签 ----------
let list = marks.merge([], { gameId: 1001, minute: 12, note: '这波不该打' });
assert.strictEqual(list.length, 1);
assert.strictEqual(list[0].minute, 12);
// 同局同分钟覆盖而不是重复
list = marks.merge(list, { gameId: 1001, minute: 12, note: '改过' });
assert.strictEqual(list.length, 1);
assert.strictEqual(list[0].note, '改过');
// 同一局不同分钟是两条
list = marks.merge(list, { gameId: 1001, minute: 20, note: '' });
assert.strictEqual(list.length, 2);
// 新的一条排在最前
list = marks.merge(list, { gameId: 1002, minute: 0, note: '' });
assert.strictEqual(String(list[0].gameId), '1002');
// 没有 gameId 的记录直接丢弃
assert.strictEqual(marks.merge(list, { minute: 3 }).length, 3);
// 上限
let big = [];
for (let i = 0; i < marks.MAX + 10; i++) big = marks.merge(big, { gameId: i, minute: 0 });
assert.strictEqual(big.length, marks.MAX);

// ---------- 遭遇库 ----------
const enc = {
  a: { name: '小王', count: 5, lastSeen: 3000 },
  b: { name: '老李', count: 2, lastSeen: 5000 },
  c: { name: '未知玩家', count: 1, lastSeen: 9000 },
  d: { name: '阿飞', count: 8, lastSeen: 1000 }
};
const mk = { a: { tags: ['送'], note: '喜欢偷塔' }, d: { tags: [], note: '' } };
const v1 = recent.build(enc, mk, { sort: 'recent' });
assert.strictEqual(v1.total, 3, '未知玩家默认不显示');
assert.strictEqual(v1.rows[0].name, '老李', '按最近遇到排序');
assert.strictEqual(v1.repeat, 2, '再见 3 次以上 2 人 (5/8)');
assert.strictEqual(v1.tagged, 1);
assert.strictEqual(recent.build(enc, mk, { sort: 'count' }).rows[0].name, '阿飞');
assert.strictEqual(recent.build(enc, mk, { query: '偷塔' }).total, 1, '备注可搜');
assert.strictEqual(recent.build(enc, mk, { query: '送' }).total, 1, '标签可搜');
assert.strictEqual(recent.build(enc, mk, { includeUnknown: true }).total, 4);

// ---------- 账号漂移 ----------
const rows = (wins, n) => Array.from({ length: n }, (_, i) => ({ win: i < wins, k: 6, d: 4, a: 8 }));
const st = drift.summarize(rows(12, 20));
assert.strictEqual(st.games, 20);
assert.strictEqual(st.wr, 60);
assert.strictEqual(st.recentWr, 100, '最近 10 场全胜 (新局在前)');
assert.strictEqual(st.kda, 3.5);
const st2 = drift.summarize([...rows(9, 10), ...rows(1, 10)]);   // 近 10 场 90%, 更早 10 场 10%
assert.strictEqual(st2.recentWr, 90);
assert.strictEqual(st2.beforeWr, 10);
assert.strictEqual(drift.driftOf(st2).wr, 80);
assert.strictEqual(drift.driftOf(drift.summarize([{ win: true }])), null, '样本不足不给漂移');
assert.strictEqual(drift.summarize([]), null);

let snaps = drift.record([], { puuid: 'p1', platform: 'HN1', name: '主号', stats: st });
snaps = drift.record(snaps, { puuid: 'p2', platform: 'JP1', name: '小号', stats: st2 });
assert.strictEqual(snaps.length, 2);
snaps = drift.record(snaps, { puuid: 'p1', platform: 'HN1', name: '主号', stats: st2 });
assert.strictEqual(snaps.length, 2, '同账号应覆盖');
assert.strictEqual(drift.sorted(snaps)[0].puuid, 'p2', '按场次排序');
assert.ok(drift.html(snaps, 'p1').indexOf('current') > 0, '当前账号要标出来');

// ---------- 强化反查 ----------
assert.strictEqual(hexCross.searchAugments('').length, 0);
assert.deepStrictEqual(hexCross.searchAugments('巫术').map(x => x.id), [1]);
assert.strictEqual(hexCross.searchAugments('不存在的强化').length, 0);
const fit = hexCross.fitHtml({ ok: true, scanned: 2, champions: [{ championId: 103, winRate: 0.55, lift: 0.04, rank: 2, games: 900 }] }, '加速巫术');
assert.ok(fit.indexOf('+4pt') > 0, 'lift 应换算成百分点');
assert.ok(fit.indexOf('不是全服榜单') > 0, '必须说明样本范围');
assert.ok(hexCross.fitHtml({ ok: true, scanned: 0, champions: [] }, 'x').indexOf('还没有缓存') > 0);
assert.ok(hexCross.fitHtml({ ok: false, error: 'boom' }, 'x').indexOf('boom') > 0);

// ---------- i18n ----------
assert.strictEqual(i18n.t('首页'), 'Home', '按词典翻译');
assert.strictEqual(i18n.t('没有收录的文案'), '没有收录的文案', '未收录回落中文');
assert.strictEqual(i18n.current(), 'en');
assert.strictEqual(i18n.t('胜率 {v}%', { v: 55 }), '胜率 55%');

console.log('test_poro_1630_misc: OK');
