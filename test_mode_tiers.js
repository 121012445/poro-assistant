'use strict';
// 英雄强度角标: main/opgg.js 的强度榜解析与缓存 + renderer/js/balance.js 的加载/渲染 + 实时页/备战区接线。
// 样例数据按 LeagueAkari 的 OP.GG 类型定义构造; 沙箱无法联网验证真实响应。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { createOpggClient, normalizeMayhemTiers, normalizeModeTiers } = require('./main/opgg');

const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const J = v => JSON.parse(JSON.stringify(v));
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

(async () => {
  // ---------- 1) 解析: 海斗 ----------
  const mayhem = J(normalizeMayhemTiers({ data: [
    { champion_id: 1, id: 1, tier: 1, rank: 3 },
    { champion_id: 2, id: 2, tier: 0, rank: 1 },          // OP
    { champion_id: 3, id: 3, tier: 5, rank: 160 },
    { champion_id: 4, tier: 6, rank: 5 },                 // 超范围
    { champion_id: 5, tier: -1, rank: 5 },
    { champion_id: 6, tier: 2.5, rank: 5 },               // 非整数
    { champion_id: 7, tier: '2', rank: 5 },               // 字符串数字: Number() 后合法
    { champion_id: 'x', tier: 1, rank: 1 },
    { champion_id: 0, tier: 1, rank: 1 },
    { champion_id: 99999, tier: 1, rank: 1 },
    { champion_id: 8, tier: null, rank: 1 },
    { champion_id: 9, tier: 3, rank: -4 },                // 排名非法 → 0, 角标仍可显示
    null, 'junk'
  ] }));
  assert.deepStrictEqual(Object.keys(mayhem).sort((a, b) => a - b), ['1', '2', '3', '7', '9']);
  assert.deepStrictEqual(mayhem[2], { tier: 0, rank: 1 }, 'OP(0) 要保留, 不能被当成"没有"');
  assert.deepStrictEqual(mayhem[9], { tier: 3, rank: 0 });
  assert.deepStrictEqual(J(normalizeMayhemTiers(null)), {});
  assert.deepStrictEqual(J(normalizeMayhemTiers({ data: 'x' })), {});

  // ---------- 2) 解析: 大乱斗 / 无限火力 ----------
  const aram = J(normalizeModeTiers({ data: [
    { id: 10, average_stats: { tier_data: { tier: 1, rank: 4 } } },
    { id: 11, average_stats: { tier_data: { tier: 0, rank: 1 } } },
    { id: 12, average_stats: null },
    { id: 13 },
    { id: 14, average_stats: { tier_data: { tier: 9, rank: 1 } } },
    { id: 15, average_stats: { tier_data: { rank: 1 } } },
    { average_stats: { tier_data: { tier: 1, rank: 1 } } }
  ] }));
  assert.deepStrictEqual(Object.keys(aram).sort(), ['10', '11']);
  assert.deepStrictEqual(aram[11], { tier: 0, rank: 1 });

  // ---------- 3) 客户端: 路径、缓存、合并、兜底、校验 ----------
  let clock = 0, fail = false;
  const calls = [];
  const resp = {
    '/api/contents/tiers?type=aram_mayhem': { data: [{ champion_id: 1, tier: 1, rank: 2 }] },
    '/api/global/champions/aram': { data: [{ id: 10, average_stats: { tier_data: { tier: 2, rank: 9 } } }] },
    '/api/global/champions/urf': { data: [{ id: 10, average_stats: { tier_data: { tier: 3, rank: 20 } } }] }
  };
  const client = createOpggClient({ now: () => clock, httpGet: async (host, p) => {
    calls.push(host + p);
    await new Promise(r => setImmediate(r));
    if (fail) throw new Error('HTTP 503');
    if (!(p in resp)) throw new Error('HTTP 404');
    return resp[p];
  } });
  const [m1, m2] = await Promise.all([client.getTiers('aram_mayhem'), client.getTiers('aram_mayhem')]);
  assert.strictEqual(calls.length, 1, '并发合并成一次请求');
  assert.strictEqual(calls[0], 'lol-api-champion.op.gg/api/contents/tiers?type=aram_mayhem', '海斗走 /api/contents/tiers');
  assert.strictEqual(m1, m2);
  assert.strictEqual(m1.source, 'OP.GG');
  await client.getTiers('aram');
  assert.strictEqual(calls[1], 'lol-api-champion.op.gg/api/global/champions/aram', '大乱斗走英雄榜');
  await client.getTiers('urf');
  assert.strictEqual(calls[2], 'lol-api-champion.op.gg/api/global/champions/urf');
  await client.getTiers('aram_mayhem'); await client.getTiers('aram');
  assert.strictEqual(calls.length, 3, '每个模式 1 小时内命中缓存, 互不影响');
  clock += 61 * 60 * 1000;
  fail = true;
  const stale = await client.getTiers('aram');
  assert.strictEqual(stale.stale, true, '刷新失败时沿用上一份并标记过期');
  assert.ok(stale.champions[10]);
  await assert.rejects(createOpggClient({ httpGet: async () => { throw new Error('HTTP 500'); } }).getTiers('aram'), /HTTP 500/, '从没成功过时抛出');
  fail = false;
  await assert.rejects(createOpggClient({ httpGet: async () => ({ data: [] }) }).getTiers('aram'), /为空/, '空榜单不缓存');
  for (const bad of ['ranked', 'cherry', '', '../x', 'aram/../../x', undefined]) {
    await assert.rejects(client.getTiers(bad), /不支持的模式/, '非法模式: ' + bad);
  }
  // 失败后再次请求不会卡在旧的 pending 上
  const flaky = (() => { let n = 0; return createOpggClient({ httpGet: async () => { if (n++ === 0) throw new Error('第一次失败'); return resp['/api/global/champions/aram']; } }); })();
  await assert.rejects(flaky.getTiers('aram'), /第一次失败/);
  assert.ok((await flaky.getTiers('aram')).champions[10], '失败不会让后续请求一直失败');

  // ---------- 4) 渲染层: balance.js ----------
  const src = read('renderer/js/balance.js');
  function load(api) {
    const logs = [];
    const ctx = vm.createContext({ console, Date, Object, Number, String, escapeHtml, lolAPI: Object.assign({ debugLog: m => logs.push(m) }, api), window: {} });
    ctx.window.lolAPI = ctx.lolAPI;
    vm.runInContext(src, ctx, { filename: 'balance.js' });
    return { ctx, logs, run: c => vm.runInContext(c, ctx) };
  }
  const sample = { champions: { 1: { tier: 1, rank: 3 }, 2: { tier: 0, rank: 1 }, 3: { tier: 3, rank: 80 }, 4: { tier: 5, rank: 160 }, 5: { tier: 7, rank: 1 } } };
  {
    assert.strictEqual(load({}).ctx.tierModeFor(450), 'aram');
    const { ctx } = load({});
    assert.strictEqual(ctx.tierModeFor(450), 'aram');
    assert.strictEqual(ctx.tierModeFor(2400), 'aram_mayhem');
    assert.strictEqual(ctx.tierModeFor(900), 'urf');
    assert.strictEqual(ctx.tierModeFor(1900), 'urf');
    assert.strictEqual(ctx.tierModeFor(420), null, '排位不显示 (英雄库页已有排位强度, 放到别的模式里是误导)');
    assert.strictEqual(ctx.tierModeFor(430), null);
    assert.strictEqual(ctx.tierModeFor(1700), null, '斗魂竞技场没有对应榜单');
    assert.strictEqual(ctx.tierModeFor(0, 'ARAM'), 'aram');
    assert.strictEqual(ctx.tierModeFor(0, 'kiwi'), 'aram_mayhem');
    assert.strictEqual(ctx.tierModeFor(undefined, undefined), null);
  }
  {
    // 模拟 IPC 的结构化克隆: 各次返回互不共享引用 (否则改一个模式的数据会串到另一个模式)
    let calls2 = 0;
    const { ctx, run, logs } = load({ getModeTiers: async mode => { calls2++; await new Promise(r => setImmediate(r)); return Object.assign({ mode }, J(sample)); } });
    const [a, b] = await Promise.all([ctx.loadModeTiers('aram'), ctx.loadModeTiers('aram')]);
    assert.strictEqual(calls2, 1, '并发合并');
    assert.strictEqual(a, b);
    await ctx.loadModeTiers('aram');
    assert.strictEqual(calls2, 1, '1 小时内不重复请求');
    await ctx.loadModeTiers('aram', true);
    assert.strictEqual(calls2, 2, 'force 重新请求');
    await ctx.loadModeTiers('urf');
    assert.strictEqual(calls2, 3, '不同模式各自加载');
    assert.strictEqual(await ctx.loadModeTiers(null), null);
    assert.strictEqual(await ctx.loadModeTiers('aram_mayhem') !== null, true);

    // 徽标
    const badge = id => ctx.modeTierBadgeHtml('aram', id);
    assert.ok(/class="lp-tier lp-tier-top"[^>]*>T1</.test(badge(1)), 'T1 用强调色');
    assert.ok(/class="lp-tier lp-tier-top"[^>]*>OP</.test(badge(2)), 'OP 直接显示 OP, 不是 "TOP"');
    assert.ok(!badge(2).includes('>TOP<'));
    assert.ok(/class="lp-tier lp-tier-mid"[^>]*>T3</.test(badge(3)));
    assert.ok(/class="lp-tier lp-tier-low"[^>]*>T5</.test(badge(4)), '低阶用弱化色');
    assert.strictEqual(badge(5), '', '范围外的数值不显示');
    assert.strictEqual(badge(999), '', '榜单里没有的英雄不显示');
    assert.strictEqual(ctx.modeTierBadgeHtml('urf', 1), ctx.modeTierBadgeHtml('urf', 1));
    assert.strictEqual(ctx.modeTierBadgeHtml('nope', 1), '', '没加载过的模式不显示');
    assert.ok(badge(1).includes('title="大乱斗强度 1 阶 · 排名 3 (OP.GG)"'), '悬停写清模式/排名/来源: ' + badge(1));
    assert.ok(ctx.modeTierBadgeHtml('aram_mayhem', 1).includes('海克斯大乱斗强度'));
    assert.ok(badge(2).includes('强度 OP 阶'));
    // 榜单是按模式分开存的: 同一个英雄在不同模式下等级不同
    run("modeTiers.urf.champions[1] = { tier: 4, rank: 50 }");
    assert.ok(ctx.modeTierBadgeHtml('urf', 1).includes('>T4<') && badge(1).includes('>T1<'));
    // 数据过期标注
    run("modeTiers.aram.stale = true");
    assert.ok(badge(1).includes('数据可能过期'));
    // 标签转义 (榜单数据来自网络)
    run("TIER_MODE_NAMES.aram = '<img onerror=1>'");
    assert.ok(!badge(1).includes('<img') && badge(1).includes('&lt;img'), '悬停文字必须转义');
  }
  {   // 失败: 不抛、记日志、保留旧数据
    let n = 0;
    const { ctx, logs } = load({ getModeTiers: async () => (n++ === 0 ? J(sample) : { __error: 'HTTP 503' }) });
    await ctx.loadModeTiers('aram');
    await assert.doesNotReject(ctx.loadModeTiers('aram', true));
    assert.ok(ctx.modeTierBadgeHtml('aram', 1).includes('T1'), '刷新失败应保留上一份');
    assert.ok(logs.some(l => l.includes('[TIER] aram 加载失败')));
    const { ctx: c2 } = load({ getModeTiers: async () => { throw new Error('IPC 断开'); } });
    await assert.doesNotReject(c2.loadModeTiers('aram'));
    assert.strictEqual(c2.modeTierBadgeHtml('aram', 1), '');
    const { ctx: c3 } = load({});
    assert.strictEqual(await c3.loadModeTiers('aram'), null, 'preload 没有该接口时不抛');
  }

  // ---------- 5) 实时页真实渲染 + 重绘不循环 ----------
  {
    const liveCtx = vm.createContext({
      console, Date, Map, Set, escapeHtml, window: { _gameflowPhase: 'InProgress' }, performance: { now: () => 0 },
      document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
      lolAPI: { lcuStatus: async () => ({ summoner: { puuid: 'me' } }), getAramBalance: async () => ({ champions: {} }), getModeTiers: async () => J(sample), debugLog: () => {},
        lcuRequest: async () => null },
      checkBlacklist: () => {}, isKnownPlayerName: () => false, addEncounter: () => {},
      deriveRiskProfile: () => ({ level: 'steady', label: '稳定', confidence: 80, evidence: [] }),
      getPlayerMarksHtml: () => '', inlineArg: v => JSON.stringify(String(v)), poroIcon: () => '', nameCache: {},
      champImg: () => '', placeholder: () => '', champIconAttrs: () => '', champNumMap: {}, allChampions: {}
    });
    liveCtx.window.lolAPI = liveCtx.lolAPI;
    for (const f of ['renderer/js/balance.js', 'renderer/js/behavior-tags.js', 'renderer/js/live.js']) vm.runInContext(read(f), liveCtx, { filename: f });
    await vm.runInContext("loadModeTiers('aram')", liveCtx);
    const body = { innerHTML: '' };
    const data = [{ puuid: 'a', name: 'A', team: 100, championId: 1, recent: [] }, { puuid: 'b', name: 'B', team: 200, championId: 4, recent: [] }];
    vm.runInContext("liveTierMode = 'aram'", liveCtx);
    await liveCtx.renderLiveTeams(body, data, null, null);
    assert.ok(body.innerHTML.includes('lp-tier-top') && body.innerHTML.includes('lp-tier-low'), '大乱斗: 玩家卡显示强度角标');
    vm.runInContext("liveTierMode = null", liveCtx);
    await liveCtx.renderLiveTeams(body, data, null, null);
    assert.ok(!body.innerHTML.includes('lp-tier'), '排位等模式不显示强度角标');
  }
  {   // 实时页: 强度榜加载完成触发一次重绘, 之后命中缓存不再触发
    const live = read('renderer/js/live.js');
    assert.ok(/liveTierMode = tierModeFor\(session\?\.gameData\?\.queue\?\.id/.test(live), '实时页按队列确定强度榜模式');
    assert.ok(/t\.loadedAt !== had/.test(live) && /updateLivePage\(window\._gameflowPhase\)/.test(live), '只在数据真的刚加载/刷新时重绘, 避免 renderLiveFromGameflow → 加载 → 重绘 → renderLiveFromGameflow 的循环');
    assert.ok(!/updateLivePlayerTiers/.test(live), '不得引用不存在的函数 (1.5.0 loadAramBalance 事故)');
  }
  {   // 备战区
    const bench = read('renderer/js/bench.js');
    assert.ok(/const benchTierMode = tierModeFor\(hexRecommendContext\?\.queueId, ''\)/.test(bench));
    assert.ok(/modeTierBadgeHtml\(benchTierMode, it\.id\)/.test(bench), '备战区按钮显示强度角标');
    assert.ok(/const key = [^\n]*modeTiers\[benchTierMode\]\?\.loadedAt/.test(bench), '强度榜加载完成后按钮要能重绘 (加载时间在重绘键里)');
    assert.ok(/_benchTierSeen\[benchTierMode\] = t\.loadedAt/.test(bench), '记录已据此重绘的版本, 避免反复重绘');
    assert.ok(/const _benchTierSeen = \{\}/.test(bench));
  }

  // ---------- 6) 主进程 / preload / 样式 ----------
  assert.ok(/ipcMain\.handle\('opgg:tiers'/.test(read('main/index.js')));
  assert.ok(read('main/preload.js').includes("getModeTiers: (mode) => ipcRenderer.invoke('opgg:tiers', mode)"));
  const css = read('renderer/css/premium.css');
  for (const c of ['.lp-tier-top', '.lp-tier-mid', '.lp-tier-low']) assert.ok(css.includes(c), '缺少样式 ' + c);

  console.log('英雄强度角标 (强度榜解析 / 缓存 / 渲染 / 接线) 测试通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
