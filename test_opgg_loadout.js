'use strict';
// renderer/js/opgg-loadout.js + settings.js doAutoRune: 选人锁定后按 OP.GG 设置符文 / 召唤师技能 / 装备方案。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const loadoutSrc = read('renderer/js/opgg-loadout.js');
const settingsSrc = read('renderer/js/settings.js');
const autoRuneSrc = settingsSrc.slice(settingsSrc.indexOf('// ========== 自动符文 =========='));

const BUILD = {
  championId: 266, version: '16.19', mode: 'aram', position: 'none',
  runes: { primaryStyleId: 8100, subStyleId: 8300, perkIds: [8112, 8139, 8138, 8135, 8345, 8347, 5008, 5008, 5011] },
  spells: { ids: [32, 4] },
  itemBlocks: [{ title: '出门装', items: [1055, 2003] }, { title: '核心出装 1', items: [6692, 3071] }]
};

function makeEnv(o = {}) {
  const calls = [];
  const store = Object.assign({}, o.store || {});
  const toasts = [];
  const lcu = Object.assign({
    'GET /lol-gameflow/v1/session': { gameData: { queue: { id: 450, gameMode: 'ARAM' } } },
    'GET /lol-perks/v1/pages': [{ id: 11, name: '我的页', isEditable: true }, { id: 12, name: '官方', isEditable: false }],
    'GET /lol-perks/v1/inventory': { canAddCustomPage: true },
    'POST /lol-perks/v1/pages': { id: 99 },
    'GET /lol-champ-select/v1/session/my-selection': { spell1Id: 4, spell2Id: 7 },
    'PATCH /lol-champ-select/v1/session/my-selection': null,
    'GET /lol-summoner/v1/current-summoner': { summonerId: 777 },
    'GET /lol-item-sets/v1/item-sets/777/sets': { accountId: 1, itemSets: [{ uid: 'user-1', title: '我自己的方案' }, { uid: 'poro-1-aram-none', title: '旧 Poro 方案' }] },
    'PUT /lol-item-sets/v1/item-sets/777/sets': null
  }, o.lcu || {});
  const ctx = vm.createContext({
    console, Date, JSON, Math, Number, String, Array, Object, Promise, Set,
    window: { _myPuuid: 'me' },
    document: { getElementById: () => null },
    complianceOn: !!o.compliance, lcuConnected: true, version: '16.19.1',
    champNumMap: { 266: { id: 'Aatrox', name: '亚托克斯' } },
    opggMap: o.opggMap || {},
    storeGet: k => (k in store ? store[k] : null), storeSet: (k, v) => { store[k] = v; },
    showToast: (m, t) => toasts.push([m, t]), guardAutomation: () => true,
    fetch: async () => ({ ok: true, json: async () => [{ id: 8000, slots: [{ runes: [{ id: 1 }] }] }, { id: 8100, slots: [{ runes: [{ id: 2 }] }] }] }),
    lolAPI: {
      debugLog: () => {},
      lcuRequest: async (method, url, body) => {
        calls.push({ method, url, body });
        const key = method + ' ' + url;
        if (!(key in lcu)) return { __error: 'HTTP 404' };
        const v = lcu[key];
        return typeof v === 'function' ? v(body) : JSON.parse(JSON.stringify(v));
      },
      getOpggBuild: async (mode, id, pos) => { calls.push({ method: 'OPGG', url: `${mode}/${id}/${pos}` }); return o.build === undefined ? JSON.parse(JSON.stringify(BUILD)) : o.build; }
    }
  });
  ctx.window.lolAPI = ctx.lolAPI;
  vm.runInContext(loadoutSrc, ctx, { filename: 'opgg-loadout.js' });
  vm.runInContext(autoRuneSrc, ctx, { filename: 'settings.js' });
  vm.runInContext('autoRuneEnabled = true', ctx);
  if (o.remembered) ctx.applyRememberedRune = async () => true;
  return { ctx, calls, store, toasts, run: c => vm.runInContext(c, ctx) };
}
const session = (pos = '') => ({ myTeam: [{ puuid: 'me', championId: 266, assignedPosition: pos }] });
const writes = calls => calls.filter(c => c.method !== 'GET' && c.method !== 'OPGG');

(async () => {
  // ---------- 1) 纯函数 ----------
  {
    const { ctx } = makeEnv({ opggMap: { 266: { positions: [{ name: 'MID', stats: { role_rate: 0.2 } }, { name: 'TOP', stats: { role_rate: 0.7 } }, { name: 'WEIRD', stats: { role_rate: 0.9 } }] } } });
    assert.strictEqual(ctx.opggModeForQueue(450), 'aram');
    assert.strictEqual(ctx.opggModeForQueue(2400), 'aram_mayhem');
    assert.strictEqual(ctx.opggModeForQueue(900), 'urf');
    assert.strictEqual(ctx.opggModeForQueue(420), 'ranked');
    assert.strictEqual(ctx.opggModeForQueue(430), 'ranked');
    assert.strictEqual(ctx.opggModeForQueue(1700), null, '斗魂竞技场等模式不处理');
    assert.strictEqual(ctx.opggModeForQueue(0, 'KIWI'), 'aram_mayhem', '队列未知时按 gameMode');
    assert.strictEqual(ctx.opggPositionFor('UTILITY', 266), 'support');
    assert.strictEqual(ctx.opggPositionFor('BOTTOM', 266), 'adc');
    assert.strictEqual(ctx.opggPositionFor('', 266), 'top', '没有分配位置时取该英雄最常走的分路 (忽略不认识的分路名)');
    assert.strictEqual(ctx.opggPositionFor('', 1), null, '没有数据时不猜');
    // 召唤师技能顺序: 闪现保持原来那一格
    assert.deepStrictEqual([...ctx.orderSpells([4, 14], { spell1Id: 7, spell2Id: 4 })], [14, 4], '闪现原在 F, 保持在 F');
    assert.deepStrictEqual([...ctx.orderSpells([14, 4], { spell1Id: 4, spell2Id: 7 })], [4, 14], '闪现原在 D, 保持在 D');
    assert.deepStrictEqual([...ctx.orderSpells([4, 14], { spell1Id: 4, spell2Id: 7 })], [4, 14]);
    assert.deepStrictEqual([...ctx.orderSpells([32, 4], null)], [32, 4], '没有当前选择时照搬推荐');
    assert.deepStrictEqual([...ctx.orderSpells([7, 32], { spell1Id: 32, spell2Id: 12 })], [32, 7], '无闪现时尽量少换位置');
    // 装备方案合并
    const merged = ctx.mergeItemSets(
      { accountId: 5, itemSets: [{ uid: 'user-1' }, { uid: 'poro-266-aram-none', title: '旧' }, { uid: 'poro-1-aram-none' }, null] },
      BUILD, 266, '亚托克斯');
    const uids = JSON.parse(JSON.stringify(merged.itemSets.map(s => s.uid)));
    assert.deepStrictEqual(uids, ['poro-266-aram-none', 'poro-1-aram-none', 'user-1'], '新方案在前, 同英雄同模式的旧方案被替换, 用户方案保留');
    assert.strictEqual(merged.accountId, 5);
    const set = merged.itemSets[0];
    assert.strictEqual(set.title, 'Poro OP.GG 亚托克斯 · 大乱斗');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(set.associatedChampions)), [266]);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(set.blocks[0])), { type: '出门装', items: [{ id: '1055', count: 1 }, { id: '2003', count: 1 }] }, '装备 ID 是字符串 (LCU 定义)');
    const many = { itemSets: Array.from({ length: 30 }, (_, i) => ({ uid: 'poro-' + i + '-aram-none' })).concat([{ uid: 'mine' }]) };
    const capped = ctx.mergeItemSets(many, BUILD, 266, 'x').itemSets;
    assert.strictEqual(capped.filter(s => s.uid.startsWith('poro-')).length, 20, 'Poro 写入的方案最多 20 份');
    assert.ok(capped.some(s => s.uid === 'mine'), '用户方案不受上限影响');
    // 选项默认值与保存
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.opggLoadoutOptions())), { runes: true, spells: false, items: true }, '默认: 符文开、召唤师技能关、装备方案开');
    ctx.setOpggLoadoutOption('spells', true);
    ctx.setOpggLoadoutOption('bogus', true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.opggLoadoutOptions())), { runes: true, spells: true, items: true });
  }

  // ---------- 2) 完整流程 (大乱斗, 默认选项) ----------
  {
    const { ctx, calls, toasts } = makeEnv();
    await ctx.doAutoRune(266, session());
    assert.ok(calls.some(c => c.method === 'OPGG' && c.url === 'aram/266/none'), '大乱斗请求 none 分路');
    const w = writes(calls);
    const created = w.find(c => c.method === 'POST' && c.url === '/lol-perks/v1/pages');
    assert.ok(created, '没有 Poro 页且有空位时应新建');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(created.body)), { name: 'Poro', primaryStyleId: 8100, subStyleId: 8300, selectedPerkIds: BUILD.runes.perkIds, current: true });
    assert.ok(!w.some(c => c.url === '/lol-champ-select/v1/session/my-selection'), '召唤师技能默认关闭, 不应修改');
    const putSets = w.find(c => c.method === 'PUT' && c.url === '/lol-item-sets/v1/item-sets/777/sets');
    assert.ok(putSets, '应写入装备方案');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(putSets.body.itemSets.map(s => s.uid))), ['poro-266-aram-none', 'poro-1-aram-none', 'user-1']);
    assert.ok(!w.some(c => c.url.startsWith('/lol-perks/v1/pages/')), 'OP.GG 符文成功后不应再走轮换规则');
    assert.ok(toasts.some(([m]) => m.includes('OP.GG 符文') && m.includes('OP.GG 装备方案')), '应提示设置了哪些');
    // 同一英雄再来一次事件: 不重复写入
    const before = calls.length;
    await ctx.doAutoRune(266, session());
    assert.strictEqual(calls.length, before, '同一英雄只配置一次');
  }
  // 已有名为 Poro 的页: 覆盖它, 不新建
  {
    const { ctx, calls } = makeEnv({ lcu: { 'GET /lol-perks/v1/pages': [{ id: 5, name: 'Poro', isEditable: true }, { id: 6, name: 'x', isEditable: true }] } });
    await ctx.doAutoRune(266, session());
    const w = writes(calls);
    assert.ok(w.some(c => c.method === 'PUT' && c.url === '/lol-perks/v1/pages/5'), '应覆盖已有的 Poro 页');
    assert.ok(!w.some(c => c.method === 'POST' && c.url === '/lol-perks/v1/pages'), '不应再新建');
  }
  // 没有空位: 覆盖 Auto 页或第一个可编辑页
  {
    const { ctx, calls } = makeEnv({ lcu: { 'GET /lol-perks/v1/inventory': { canAddCustomPage: false } } });
    await ctx.doAutoRune(266, session());
    assert.ok(writes(calls).some(c => c.method === 'PUT' && c.url === '/lol-perks/v1/pages/11'), '没有空位时覆盖第一个可编辑页');
  }
  // 打开召唤师技能: 闪现位置保持
  {
    const { ctx, calls } = makeEnv({ store: { opggLoadout: JSON.stringify({ runes: true, spells: true, items: false }) } });
    await ctx.doAutoRune(266, session());
    const patch = writes(calls).find(c => c.method === 'PATCH');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(patch.body)), { spell1Id: 4, spell2Id: 32 }, '闪现原在 D, 推荐 [雪球, 闪现] 应换成 [闪现, 雪球]');
    assert.ok(!writes(calls).some(c => c.url.includes('item-sets')), '装备方案关闭时不写');
  }
  // 峡谷: 按分配的分路请求
  {
    const { ctx, calls } = makeEnv({ lcu: { 'GET /lol-gameflow/v1/session': { gameData: { queue: { id: 420 } } } } });
    await ctx.doAutoRune(266, session('JUNGLE'));
    assert.ok(calls.some(c => c.method === 'OPGG' && c.url === 'ranked/266/jungle'));
  }

  // ---------- 3) 不该写入的情况 ----------
  {
    const { ctx, calls } = makeEnv({ compliance: true });
    await ctx.doAutoRune(266, session());
    assert.strictEqual(writes(calls).length, 0, '合规模式下不做任何写入');
    const r = await ctx.applyOpggLoadout(266, session());
    assert.strictEqual(r.done.length, 0);
  }
  {
    const { ctx, calls } = makeEnv({ lcu: { 'GET /lol-gameflow/v1/session': { gameData: { queue: { id: 420 } } } } });
    const r = await ctx.applyOpggLoadout(266, session(''));
    assert.ok(!calls.some(c => c.method === 'OPGG'), '峡谷没有分路数据时不请求 OP.GG (不乱猜)');
    assert.strictEqual(r.done.length, 0);
  }
  {
    const { ctx, calls } = makeEnv({ store: { opggLoadout: JSON.stringify({ runes: false, spells: false, items: false }) } });
    const r = await ctx.applyOpggLoadout(266, session());
    assert.ok(!calls.some(c => c.method === 'OPGG'), '三项都关时不请求');
    assert.strictEqual(r.done.length, 0);
  }

  // ---------- 4) 兜底 ----------
  // OP.GG 失败 → 退回原轮换规则
  {
    const { ctx, calls } = makeEnv({ build: { __error: 'HTTP 503' } });
    await ctx.doAutoRune(266, session());
    const w = writes(calls);
    assert.ok(!w.some(c => c.url.includes('item-sets')), 'OP.GG 失败时不写装备方案');
    assert.ok(w.some(c => c.method === 'PUT' && /^\/lol-perks\/v1\/pages\/\d+$/.test(c.url) && c.body.name === 'Auto'), 'OP.GG 不可用时退回原来的轮换规则');
  }
  // 有符文记忆: 不覆盖记忆的符文, 但装备方案照写
  {
    const { ctx, calls, toasts } = makeEnv({ remembered: true });
    await ctx.doAutoRune(266, session());
    const w = writes(calls);
    assert.ok(!w.some(c => c.url.startsWith('/lol-perks')), '有符文记忆时不动符文页');
    assert.ok(w.some(c => c.url.includes('item-sets')), '装备方案照常写入');
    assert.ok(toasts.some(([m]) => m.includes('记忆符文页') && m.includes('OP.GG 装备方案')));
  }
  // 部分失败: 符文成功、装备方案失败 → 提示失败项, 但不重复执行
  {
    const { ctx, toasts, calls } = makeEnv({ lcu: { 'PUT /lol-item-sets/v1/item-sets/777/sets': { __error: 'HTTP 500' } } });
    await ctx.doAutoRune(266, session());
    assert.ok(toasts.some(([m, t]) => m.includes('失败: 装备方案') && t === 'negative'));
    const n = calls.length;
    await ctx.doAutoRune(266, session());
    assert.strictEqual(calls.length, n, '部分成功也算已配置, 不反复重试');
  }
  // 并发事件: 只执行一次
  {
    const { ctx, calls } = makeEnv();
    await Promise.all([ctx.doAutoRune(266, session()), ctx.doAutoRune(266, session()), ctx.doAutoRune(266, session())]);
    assert.strictEqual(calls.filter(c => c.method === 'OPGG').length, 1, '密集的选人事件只应触发一次');
  }

  // ---------- 5) 接线 ----------
  const html = read('renderer/index.html');
  for (const k of ['runes', 'spells', 'items']) assert.ok(html.includes(`id="opggLoadout_${k}"`) && html.includes(`setOpggLoadoutOption('${k}', this.checked)`), '缺少选项 ' + k);
  const scripts = [...html.matchAll(/<script src="js\/([^"?]+)/g)].map(m => m[1]);
  assert.ok(scripts.indexOf('opgg-loadout.js') >= 0 && scripts.indexOf('opgg-loadout.js') < scripts.indexOf('settings.js'));
  assert.ok(read('renderer/js/bench.js').includes('doAutoRune(mySlot.championId, session)'), '选人事件应把会话传给 doAutoRune (取分配的分路)');
  assert.ok(read('renderer/js/persist.js').includes('restoreOpggLoadoutOptions()'), '启动时恢复选项');

  console.log('OP.GG 符文 / 召唤师技能 / 装备方案测试通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
