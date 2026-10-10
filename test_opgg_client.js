'use strict';
// main/opgg.js: 平衡性数据与单英雄推荐配置的解析、校验、缓存。
// 样例数据按 OP.GG 接口的字段结构构造 (字段定义参考 LeagueAkari 的 OP.GG 类型); 沙箱无法联网验证真实响应。
const assert = require('assert');
const { createOpggClient, normalizeBalance, normalizeBuild } = require('./main/opgg');

// ---------- 平衡性 ----------
const neutral = { attack_speed: 100, damage_dealt: 100, damage_taken: 100, cooldown_reduction: 0, healing: 100, tenacity: 0, shield_amount: 100, energy_regen: 100, area_of_effect_damage: 100, default: true };
const bal = normalizeBalance({ data: [
  Object.assign({}, neutral, { champion_id: 1 }),                                                        // 无调整 → 不出现
  Object.assign({}, neutral, { champion_id: 2, damage_dealt: 105, damage_taken: 95, cooldown_reduction: 10, default: false }),
  Object.assign({}, neutral, { champion_id: 3, damage_dealt: 90, damage_taken: 110, healing: 80, default: false }),
  Object.assign({}, neutral, { champion_id: 4, attack_speed: 102.5, tenacity: -10 }),
  { champion_id: 'x', damage_dealt: 120 }, { champion_id: -1, damage_dealt: 120 }, null,                // 非法行
  Object.assign({}, neutral, { champion_id: 5, damage_dealt: 'abc', healing: 1e9 })                     // 非法值 → 忽略
] });
assert.strictEqual(bal.count, 3);
assert.ok(!bal.champions[1] && !bal.champions[5], '无调整/全是非法值的英雄不应出现');
assert.deepStrictEqual(bal.champions[2].map(c => [c.key, c.delta, c.effect]), [['dmgDealt', 5, 'buff'], ['dmgTaken', -5, 'buff'], ['abilityHaste', 10, 'buff']],
  '造成伤害 +5% 增强, 承受伤害 -5% 也是增强, 技能急速 +10 增强');
assert.deepStrictEqual(bal.champions[3].map(c => [c.key, c.delta, c.effect]), [['dmgDealt', -10, 'nerf'], ['dmgTaken', 10, 'nerf'], ['healing', -20, 'nerf']]);
assert.deepStrictEqual(bal.champions[4].map(c => [c.key, c.delta, c.effect]), [['attackSpeed', 2.5, 'buff'], ['tenacity', -10, 'nerf']]);
assert.strictEqual(bal.champions[2][0].unit, 'pct');
assert.strictEqual(bal.champions[2][2].unit, 'flat');
assert.deepStrictEqual(normalizeBalance(null), { champions: {}, count: 0 });

// ---------- 单英雄配置 ----------
const runeBuild = (o = {}) => Object.assign({ id: 1, primary_page_id: 8100, secondary_page_id: 8300, primary_rune_ids: [8112, 8139, 8138, 8135], secondary_rune_ids: [8345, 8347], stat_mod_ids: [5008, 5008, 5011], play: 1000, win: 520, pick_rate: 0.4 }, o);
const raw = {
  data: {
    summary: { id: 266 },
    runes: [
      runeBuild({ primary_rune_ids: [8112, 8139, 8138] }),                       // 不完整 → 跳过
      runeBuild({ secondary_page_id: 8100 }),                                     // 主副系相同 → 跳过
      runeBuild()
    ],
    summoner_spells: [{ ids: [4, 4], pick_rate: 0.9 }, { ids: [4, 14], play: 900, win: 470, pick_rate: 0.8 }],
    starter_items: [{ ids: [1055, 2003], pick_rate: 0.7 }, { ids: [1055, 2003, 2003], pick_rate: 0.2 }],
    boots: [{ ids: [3047] }, { ids: [3111] }, { ids: [3047] }],
    core_items: [{ ids: [6692, 3071, 3053], pick_rate: 0.123 }, { ids: [6630, 3071], pick_rate: 0.05 }, { ids: ['x', 3053] }, { ids: [1] }],
    last_items: [{ ids: [3026] }, { ids: [3156] }, { ids: [3026] }],
    prism_items: []
  },
  meta: { version: '16.19' }
};
const b = normalizeBuild(raw);
assert.strictEqual(b.championId, 266);
assert.strictEqual(b.version, '16.19');
assert.deepStrictEqual(b.runes.perkIds, [8112, 8139, 8138, 8135, 8345, 8347, 5008, 5008, 5011], '符文必须是 4 主 + 2 副 + 3 属性, 属性碎片可以重复');
assert.strictEqual(b.runes.primaryStyleId, 8100);
assert.strictEqual(b.runes.subStyleId, 8300);
assert.deepStrictEqual(b.spells.ids, [4, 14], '两个相同技能的组合应跳过');
assert.deepStrictEqual(b.itemBlocks.map(x => x.title), ['出门装', '鞋子', '核心出装 1 (12.3%)', '核心出装 2 (5.0%)', '核心出装 3', '后期可选']);
assert.deepStrictEqual(b.itemBlocks[0].items, [1055, 2003], '出门装去重');
assert.deepStrictEqual(b.itemBlocks[1].items, [3047, 3111]);
assert.deepStrictEqual(b.itemBlocks[4].items, [3053], '非法装备 ID 应过滤');
assert.ok(!b.itemBlocks.some(x => x.title === '棱彩装备'), '空分组不输出');
// rune_pages 结构 (另一种返回格式)
const b2 = normalizeBuild({ data: { summary: { id: 1 }, rune_pages: [{ builds: [runeBuild({ primary_page_id: 8200 })] }] } });
assert.strictEqual(b2.runes.primaryStyleId, 8200, '也应支持 rune_pages[].builds');
assert.strictEqual(normalizeBuild({}), null);
assert.strictEqual(normalizeBuild({ data: { summary: { id: 1 } } }).runes, null);

// ---------- 客户端: 缓存、合并请求、失败兜底、参数校验 ----------
(async () => {
  let clock = 0;
  const calls = [];
  let fail = false;
  const responses = {
    '/api/contents/aram-balance': { data: [Object.assign({}, neutral, { champion_id: 2, damage_dealt: 105 })] },
    '/api/global/champions/aram/266/none': raw,
    '/api/global/champions/ranked/266/top': raw,
    '/api/global/champions/aram_mayhem/266/none': raw
  };
  const client = createOpggClient({
    now: () => clock,
    httpGet: async (host, path) => {
      calls.push(host + path);
      await new Promise(r => setImmediate(r));
      if (fail) throw new Error('HTTP 503');
      if (!(path in responses)) throw new Error('HTTP 404');
      return responses[path];
    }
  });
  const [x1, x2] = await Promise.all([client.getAramBalance(), client.getAramBalance()]);
  assert.strictEqual(calls.length, 1, '并发请求应合并成一次');
  assert.strictEqual(calls[0], 'lol-api-champion.op.gg/api/contents/aram-balance');
  assert.strictEqual(x1, x2);
  assert.strictEqual(x1.source, 'OP.GG');
  await client.getAramBalance();
  assert.strictEqual(calls.length, 1, '30 分钟内命中缓存');
  clock += 31 * 60 * 1000;
  fail = true;
  const stale = await client.getAramBalance();
  assert.strictEqual(stale.stale, true, '刷新失败时返回上一份并标记过期');
  assert.ok(stale.champions[2]);
  const empty = createOpggClient({ httpGet: async () => ({ data: [] }) });
  await assert.rejects(empty.getAramBalance(), /为空/, '空数据应报错而不是缓存一份空表');
  fail = false;

  calls.length = 0;
  const aram = await client.getBuild('aram', 266, 'mid');
  assert.strictEqual(calls[0], 'lol-api-champion.op.gg/api/global/champions/aram/266/none', '大乱斗不分路, position 固定 none');
  assert.strictEqual(aram.mode, 'aram');
  await client.getBuild('aram', 266);
  assert.strictEqual(calls.length, 1, '同一英雄同一模式命中缓存');
  await client.getBuild('ranked', 266, 'top');
  assert.strictEqual(calls[1], 'lol-api-champion.op.gg/api/global/champions/ranked/266/top');
  await client.getBuild('aram_mayhem', 266, '');
  await assert.rejects(client.getBuild('ranked', 266, ''), /需要分路/);
  await assert.rejects(client.getBuild('ranked', 266, '../x'), /需要分路/, '分路必须在白名单内');
  await assert.rejects(client.getBuild('cherry', 266, 'none'), /不支持的模式/);
  await assert.rejects(client.getBuild('aram', '266/../../x'), /英雄 ID 无效/, '英雄 ID 不得拼进路径');
  await assert.rejects(client.getBuild('aram', 99999), /英雄 ID 无效/);
  responses['/api/global/champions/aram/1/none'] = { data: { summary: { id: 1 } } };
  await assert.rejects(client.getBuild('aram', 1), /暂无/, '没有任何可用配置时报错');

  console.log('OP.GG 平衡性与推荐配置解析测试通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
