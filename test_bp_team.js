'use strict';
// renderer/js/bp-team.js: 己方预选视角的 BP 分析（阵容缺口 / 补位分 / 帮队友清路的 ban）。
// 全部用合成英雄数据 —— 不读 LCU、不联网，只验规则。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('renderer/js/bp-team.js', 'utf8').replace(/\r\n/g, '\n');
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// champNumMap: 数字 id → { id: DDragon 字母 id, name }
// allChampions: 字母 id → { tags, info: { attack, magic } }
const champNumMap = {
  1: { id: 'Malphite', name: '墨菲特' },
  2: { id: 'Zed', name: '劫' },
  3: { id: 'Ahri', name: '阿狸' },
  4: { id: 'Jinx', name: '金克丝' },
  5: { id: 'Lulu', name: '璐璐' },
  6: { id: 'Garen', name: '盖伦' },
  7: { id: 'Viktor', name: '维克托' },
  8: { id: 'Kaisa', name: '卡莎' }   // 混伤：attack 与 magic 差 1
};
const allChampions = {
  Malphite: { tags: ['Tank'], info: { attack: 2, magic: 6 } },
  Zed: { tags: ['Assassin'], info: { attack: 9, magic: 2 } },
  Ahri: { tags: ['Mage', 'Assassin'], info: { attack: 3, magic: 9 } },
  Jinx: { tags: ['Marksman'], info: { attack: 9, magic: 1 } },
  Lulu: { tags: ['Support', 'Mage'], info: { attack: 3, magic: 8 } },
  Garen: { tags: ['Fighter', 'Tank'], info: { attack: 8, magic: 1 } },
  Viktor: { tags: ['Mage'], info: { attack: 2, magic: 9 } },
  Kaisa: { tags: ['Marksman', 'Mage'], info: { attack: 6, magic: 5 } }
};

const win = {};
const sandbox = { console, Number, String, Array, Object, Math, Set, Map, escapeHtml, champNumMap, allChampions, window: win };
vm.runInContext(src, vm.createContext(sandbox), { filename: 'bp-team.js' });
const api = win.PoroBPTeam;
assert.ok(api, '模块应挂到 window.PoroBPTeam');

// ---------- 1. 伤害类型用 info 权重判，不是按标签猜 ----------
assert.strictEqual(api.dmgOf(2, null), 'AD', '劫 attack 9 / magic 2 应判物伤');
assert.strictEqual(api.dmgOf(3, null), 'AP', '阿狸 magic 9 应判法伤');
assert.strictEqual(api.dmgOf(8, null), 'MIX', '卡莎 6/5 差异小于阈值应判混伤');
assert.strictEqual(api.dmgOf(999, null), '', '查不到的英雄不给伤害类型，而不是默认 AD');

// ---------- 2. 队伍结构画像 ----------
const p = api.profileOf([1, 2, 4, 5, 999], null);
assert.strictEqual(p.total, 5);
assert.strictEqual(p.Tank, 1, '墨菲特是前排');
assert.strictEqual(p.Assassin, 1);
assert.strictEqual(p.Marksman, 1);
assert.strictEqual(p.Support, 1);
assert.strictEqual(p.AD, 2, '只有劫与金克丝是 AD（墨菲特 2/6 判法伤）');
assert.strictEqual(p.AP, 2, '阿狸(不进这支队伍)不算；墨菲特与璐璐是法伤');
assert.strictEqual(p.unknown, 1, '999 查不到要单独计数，不能算成 AD 也不能悄悄丢掉');
// 重复 id 只算一次
assert.strictEqual(api.profileOf([1, 1, 1], null).total, 1, '重复英雄只计一次');

// ---------- 3. 缺口规则 ----------
const twoAdOnly = api.profileOf([4, 2], null);      // 金克丝 + 劫：全部物伤
let needs = api.needsOf(twoAdOnly, api.profileOf([], null), { rift: true });
assert.ok(needs.some(n => n.key === 'front'), '两个人没有前排 → 报前排不足');
assert.ok(needs.some(n => n.key === 'ap'), '全物伤 → 报缺法术输出');
assert.ok(!needs.some(n => n.key === 'ad'), '不应同时报缺物理');

const twoApOnly = api.profileOf([3, 7], null);      // 阿狸 + 维克托
needs = api.needsOf(twoApOnly, api.profileOf([], null), { rift: true });
assert.ok(needs.some(n => n.key === 'ad'), '全法伤 → 报缺物理输出');
assert.ok(!needs.some(n => n.key === 'ap'), '不应同时报缺法术');

// 只有一个人亮的时候不下结论（样本太少，谈阵容结构没意义）
assert.strictEqual(api.needsOf(api.profileOf([4], null), api.profileOf([], null), {}).length, 0,
  '只有一个人亮了不谈阵容缺口');

// 敌方结构：两刺客 → 要求前排/保护
needs = api.needsOf(api.profileOf([1, 6, 5], null), api.profileOf([2, 3], null), { rift: true });
assert.ok(needs.some(n => n.key === 'antiAssassin'), '敌方两名刺客 → 提醒补前排/保护');
// 非峡谷模式不谈视野/保护
assert.ok(!api.needsOf(api.profileOf([1, 6, 4], null), api.profileOf([], null), { rift: false })
  .some(n => n.key === 'prot'), '海斗/大乱斗不该出现「缺保护/视野」');

// ---------- 4. 补位分 ----------
const frontNeed = [{ key: 'front', label: '己方前排不足', tags: ['Tank', 'Fighter'], weight: 1.5 }];
assert.strictEqual(api.fitOf(1, frontNeed, null).fit, 1.5, '墨菲特能补前排');
assert.strictEqual(api.fitOf(1, frontNeed, null).reasons.join('|'), '己方前排不足');
assert.strictEqual(api.fitOf(4, frontNeed, null).fit, 0, '金克丝补不了前排');
assert.strictEqual(api.fitOf(6, frontNeed, null).fit, 1.5, '盖伦（战士）也算前排');
// 同一条缺口只计一次
assert.strictEqual(api.fitOf(1, [{ tags: ['Tank'], weight: 1 }, { tags: ['Tank'], weight: 1 }], null).fit, 2,
  '两条独立需求各自计数');

// ---------- 5. analyse ----------
const model = api.analyze({
  ally: [{ id: 4, locked: true }, { id: 2, intent: true }],
  enemy: [{ id: 3, pos: 'mid' }]
}, null, { rift: true });
assert.strictEqual(model.intents.length, 2);
assert.strictEqual(model.lockedCount, 1);
assert.strictEqual(model.intentCount, 1);
assert.strictEqual(model.foe.total, 1);

// ---------- 6. 帮队友清路的 ban ----------
// tables[队友id:位置][敌人id] = { play, wr }，与 bp-advisor 同方向：wr 是敌人的胜率
const tables = {
  '3:mid': { '2': { play: 900, wr: 0.56 }, '1': { play: 500, wr: 0.53 }, '7': { play: 30, wr: 0.60 } },
  '4:adc': { '8': { play: 800, wr: 0.54 }, '2': { play: 700, wr: 0.52 } }
};
const bans = api.banAgainstIntents([{ id: 3, pos: 'mid' }, { id: 4, pos: 'adc' }], tables, {});
assert.strictEqual(bans[0].id, 2, '两个队友都被劫克制，劫应排第一');
assert.ok(bans[0].score > bans[1].score, '分高的在前');
assert.ok(!bans.some(b => b.id === 7), '样本 30 场低于下限，不该进建议');
assert.ok(bans.every(b => b.wr !== undefined || b.hits.length > 0), '每条都要带命中依据');
const hitIds = bans[0].hits.map(h => h.forId).sort();
assert.strictEqual(hitIds.join(','), '3,4', '劫同时克制两名队友的预选');

// 已被 ban 掉的敌人不再建议
const excluded = api.banAgainstIntents([{ id: 3, pos: 'mid' }], tables, { exclude: new Set([2]) });
assert.ok(!excluded.some(b => b.id === 2), '已被 ban 的英雄不该再推荐');

// 没有对位表时安静返回空数组，不抛错
assert.strictEqual(api.banAgainstIntents([{ id: 3, pos: 'mid' }], {}, {}).length, 0, '没有数据就返回空');
assert.strictEqual(api.banAgainstIntents(null, tables, {}).length, 0, 'null 输入不抛错');

// ---------- 7. 渲染 ----------
const brief = api.briefHtml(model, null);
assert.ok(brief.includes('金克丝') && brief.includes('劫'), '摘要要列出我方已亮英雄');
assert.ok(brief.includes('前排不足'), '摘要要带缺口');
assert.ok(brief.includes('bpt-chip-lock'), '已锁的英雄要有单独标记');
assert.ok(!brief.includes('undefined'), '摘要里不能漏出 undefined');

const verdict = api.verdictHtml({ id: 1, score: 2.5, total: 4, edges: [{ enemyName: '劫', delta: 2, lane: true }], fitReasons: ['己方前排不足'] }, model, null);
assert.ok(verdict.includes('综合首选') && verdict.includes('墨菲特'), '结论要给出首选英雄');
assert.ok(verdict.includes('+4.0'), '有 total 时显示总分');
assert.ok(verdict.includes('对位 劫 +2.0'), '要带对位依据');
assert.ok(verdict.includes('己方前排不足'), '要带补位依据');

// 名字里的尖括号要转义
const evil = { 88: { id: 'X', name: '<b>x</b>' } };
assert.ok(!api.briefHtml({ intents: [{ id: 88 }], needs: [] }, { champNumMap: evil, allChampions: {} }).includes('<b>x</b>'),
  '英雄名必须转义');

console.log('BP 己方预选分析测试通过');
