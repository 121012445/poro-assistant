'use strict';
// renderer/js/autoflow.js: 自动点赞 / 掉线重连。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const src = read('renderer/js/autoflow.js');

function makeEnv(o = {}) {
  const calls = [], toasts = [], store = Object.assign({}, o.store || {});
  const lcuState = o.lcuState || (o.lcuState = { gameId: 555 });
  const lcu = Object.assign({
    'GET /lol-honor-v2/v1/ballot': () => ({ gameId: lcuState.gameId, honoredPlayers: [], votePool: { votes: 1 }, eligibleAllies: [
      { puuid: 'me', summonerId: 1, summonerName: '我', botPlayer: false },
      { puuid: 'a', summonerId: 2, summonerName: '队友A', botPlayer: false },
      { puuid: 'bot', summonerId: 3, summonerName: '人机', botPlayer: true },
      { puuid: 'b', summonerId: 4, summonerName: '队友B', botPlayer: false }
    ], eligibleOpponents: [{ puuid: 'enemy', summonerId: 9, summonerName: '对手', botPlayer: false }] }),
    'POST /lol-honor-v2/v1/honor-player': null,
    'POST /lol-gameflow/v1/reconnect': null
  }, o.lcu || {});
  const ctx = vm.createContext({
    console, Date, Math, Number, String, Array, Set, Promise, JSON, Object,
    setTimeout: fn => { fn(); return 1; },                      // 延迟与重试间隔不真等
    window: { _myPuuid: 'me', _gameflowPhase: o.phase || 'PreEndOfGame' },
    document: { getElementById: () => ({ checked: false }) },
    complianceOn: !!o.compliance,
    storeGet: k => (k in store ? store[k] : null), storeSet: (k, v) => { store[k] = v; },
    showToast: (m, t) => toasts.push([m, t]), toolMsg: () => {}, guardAutomation: () => !o.compliance,
    lolAPI: {
      debugLog: () => {},
      lcuRequest: async (method, url, body) => {
        calls.push({ method, url, body });
        const v = lcu[method + ' ' + url];
        if (v === undefined) return { __error: 'HTTP 404' };
        return typeof v === 'function' ? v(body, calls) : (v === null ? null : JSON.parse(JSON.stringify(v)));
      }
    }
  });
  vm.runInContext(src, ctx, { filename: 'autoflow.js' });
  return { ctx, calls, toasts, store, lcuState, run: c => vm.runInContext(c, ctx) };
}

// autoflow / _autoHonoredGames 是脚本顶层的 let/const, 不会成为上下文对象的属性, 必须经 runInContext 读写
const flag = (ctx, k, v) => vm.runInContext(`autoflow.${k} = ${v}`, ctx);
const flagOf = (ctx, k) => vm.runInContext(`autoflow.${k}`, ctx);
const honors = calls => calls.filter(c => c.method === 'POST' && c.url === '/lol-honor-v2/v1/honor-player');
const settle = () => new Promise(r => setImmediate(r));
const seq = (...vals) => { let i = 0; return () => vals[Math.min(i++, vals.length - 1)]; };

(async () => {
  // ---------- 选人: 只选真人队友 ----------
  {
    const { ctx } = makeEnv();
    const ballot = { eligibleAllies: [{ puuid: 'me' }, { puuid: 'bot', botPlayer: true }, { puuid: 'a' }, { puuid: 'b' }, { botPlayer: false }] };
    const seen = new Set();
    for (let i = 0; i < 200; i++) { const p = ctx.pickHonorTarget(ballot, 'me'); seen.add(p.player.puuid); }
    assert.deepStrictEqual([...seen].sort(), ['a', 'b'], '只会选到真人队友: 不含自己、人机、没有 puuid 的条目');
    assert.strictEqual(ctx.pickHonorTarget({ eligibleAllies: [{ puuid: 'me' }, { puuid: 'bot', botPlayer: true }] }, 'me'), null, '没有可选队友返回 null');
    assert.strictEqual(ctx.pickHonorTarget({}, 'me'), null);
    assert.strictEqual(ctx.pickHonorTarget(null, 'me'), null);
    assert.strictEqual(ctx.pickHonorTarget({ eligibleOpponents: [{ puuid: 'enemy' }] }, 'me'), null, '对手不在候选内');
    assert.deepStrictEqual(ctx.pickHonorTarget({ eligibleAllies: [{ puuid: 'a' }, { puuid: 'b' }] }, 'me', seq(0.99, 0.99)).category, 'HEART', '随机数边界不越界');
    assert.strictEqual(ctx.pickHonorTarget({ eligibleAllies: [{ puuid: 'a' }, { puuid: 'b' }] }, 'me', seq(0, 0)).player.puuid, 'a');
    const cats = new Set();
    for (let i = 0; i < 200; i++) cats.add(ctx.pickHonorTarget({ eligibleAllies: [{ puuid: 'a' }] }, 'me').category);
    assert.deepStrictEqual([...cats].sort(), ['COOL', 'HEART', 'SHOTCALLER'], '三种称赞都可能被选到');
  }

  // ---------- 点赞流程 ----------
  {   // 正常
    const { ctx, calls, toasts } = makeEnv();
    flag(ctx, 'honor', true);
    await ctx.autoHonorRun();
    const h = honors(calls);
    assert.strictEqual(h.length, 1);
    const b = JSON.parse(JSON.stringify(h[0].body));
    assert.strictEqual(b.gameId, 555);
    assert.ok(['a', 'b'].includes(b.puuid), '只点真人队友: ' + b.puuid);
    assert.strictEqual(b.honorCategory, b.honorType, '两个字段取值一致 (接口定义与同类项目写法不同, 无法实测哪个生效)');
    assert.ok(AUTO_OK(b.honorCategory));
    assert.ok(toasts.some(([m]) => m.includes('已自动给队友点赞')));
    await ctx.autoHonorRun();
    assert.strictEqual(honors(calls).length, 1, '同一局只点一次');
  }
  function AUTO_OK(c) { return ['COOL', 'SHOTCALLER', 'HEART'].includes(c); }
  {   // 已手动点过 / 没票 / 没有队友: 不动作
    for (const [name, ballot] of [
      ['已手动点过', { gameId: 1, honoredPlayers: [{ honorType: 'COOL' }], votePool: { votes: 1 }, eligibleAllies: [{ puuid: 'a' }] }],
      ['没有票数', { gameId: 2, honoredPlayers: [], votePool: { votes: 0 }, eligibleAllies: [{ puuid: 'a' }] }],
      ['没有真人队友', { gameId: 3, honoredPlayers: [], votePool: { votes: 1 }, eligibleAllies: [{ puuid: 'bot', botPlayer: true }] }]
    ]) {
      const { ctx, calls } = makeEnv({ lcu: { 'GET /lol-honor-v2/v1/ballot': ballot } });
      flag(ctx, 'honor', true);
      await ctx.autoHonorRun();
      assert.strictEqual(honors(calls).length, 0, name + ': 不应点赞');
      assert.strictEqual(calls.filter(c => c.method === 'GET').length, 1, name + ': 不应反复轮询');
    }
  }
  {   // 选票还没生成 → 等待重试 → 出现后点赞
    let n = 0;
    const { ctx, calls } = makeEnv({ lcu: { 'GET /lol-honor-v2/v1/ballot': () => (++n < 3 ? { __error: 'HTTP 404' } : { gameId: 7, honoredPlayers: [], votePool: { votes: 1 }, eligibleAllies: [{ puuid: 'a', summonerId: 2 }] }) } });
    flag(ctx, 'honor', true);
    await ctx.autoHonorRun();
    assert.strictEqual(honors(calls).length, 1, '选票出现后应点赞');
    assert.strictEqual(n, 3);
  }
  {   // 一直没有选票: 有限次后放弃
    const { ctx, calls } = makeEnv({ lcu: { 'GET /lol-honor-v2/v1/ballot': { __error: 'HTTP 404' } } });
    flag(ctx, 'honor', true);
    await ctx.autoHonorRun();
    assert.strictEqual(calls.filter(c => c.method === 'GET').length, 4, '最多尝试 4 次');
    assert.strictEqual(honors(calls).length, 0);
  }
  {   // 点赞请求失败: 重试; 全部失败不崩
    const { ctx, calls } = makeEnv({ lcu: { 'POST /lol-honor-v2/v1/honor-player': { __error: 'HTTP 400' } } });
    flag(ctx, 'honor', true);
    await ctx.autoHonorRun();
    assert.strictEqual(honors(calls).length, 4, '失败后重试, 最多 4 次');
  }
  {   // 重入保护 + 开关/合规
    const { ctx, calls } = makeEnv();
    flag(ctx, 'honor', true);
    await Promise.all([ctx.autoHonorRun(), ctx.autoHonorRun(), ctx.autoHonorRun()]);
    assert.strictEqual(honors(calls).length, 1, '并发触发只执行一次');
    const off = makeEnv(); flag(off.ctx, 'honor', false);
    await off.ctx.autoHonorRun();
    assert.strictEqual(off.calls.length, 0, '开关关闭时不请求');
    const cp = makeEnv({ compliance: true }); flag(cp.ctx, 'honor', true);
    await cp.ctx.autoHonorRun();
    assert.strictEqual(cp.calls.length, 0, '合规模式下不请求');
  }

  // ---------- 阶段挂接: 只在进入阶段时触发一次 ----------
  {
    const { ctx, calls, lcuState } = makeEnv();
    flag(ctx, 'honor', true);
    for (const p of ['InProgress', 'WaitingForStats']) ctx.autoflowOnPhase(p);
    await settle();
    assert.strictEqual(calls.length, 0, 'WaitingForStats 时选票还没生成, 不应提前触发');
    for (let i = 0; i < 5; i++) ctx.autoflowOnPhase('PreEndOfGame');          // 轮询会重复上报同一阶段
    await settle(); await settle();
    assert.strictEqual(honors(calls).length, 1, 'PreEndOfGame 重复上报只触发一次');
    ctx.autoflowOnPhase('EndOfGame');
    await settle(); await settle();
    assert.strictEqual(honors(calls).length, 1, 'EndOfGame 兜底时同一局已点过, 不重复');
    // 下一局: gameId 不同 (不手动清空去重表, 验证真实行为)
    lcuState.gameId = 556;
    ctx.autoflowOnPhase('ChampSelect');
    ctx.autoflowOnPhase('PreEndOfGame');
    await settle(); await settle();
    assert.strictEqual(honors(calls).length, 2, '下一局应重新触发');
  }
  {   // 开关关闭时, 进入阶段不触发; 之后打开再进入也不会补触发同一阶段
    const { ctx, calls } = makeEnv();
    flag(ctx, 'honor', false);
    ctx.autoflowOnPhase('PreEndOfGame');
    await settle(); await settle();
    assert.strictEqual(calls.length, 0);
  }

  // ---------- 掉线重连 ----------
  {
    const { ctx, calls, toasts } = makeEnv({ phase: 'Reconnect' });
    flag(ctx, 'reconnect', true);
    await ctx.autoReconnectRun();
    assert.strictEqual(calls.filter(c => c.url === '/lol-gameflow/v1/reconnect').length, 1);
    assert.ok(toasts.some(([m]) => m.includes('已自动重新连接')));
  }
  {   // 重连失败: 重试 4 次后提示手动
    const { ctx, calls, toasts } = makeEnv({ phase: 'Reconnect', lcu: { 'POST /lol-gameflow/v1/reconnect': { __error: 'HTTP 500' } } });
    flag(ctx, 'reconnect', true);
    await ctx.autoReconnectRun();
    assert.strictEqual(calls.filter(c => c.url === '/lol-gameflow/v1/reconnect').length, 4);
    assert.ok(toasts.some(([m, t]) => m.includes('手动') && t === 'negative'));
  }
  {   // 重试期间已经连上了 (阶段变了): 不再请求
    let n = 0;
    const { ctx, calls } = makeEnv({ phase: 'Reconnect', lcu: { 'POST /lol-gameflow/v1/reconnect': () => { if (++n === 1) ctx.window._gameflowPhase = 'InProgress'; return { __error: 'HTTP 500' }; } } });
    flag(ctx, 'reconnect', true);
    await ctx.autoReconnectRun();
    assert.strictEqual(calls.filter(c => c.url === '/lol-gameflow/v1/reconnect').length, 1, '阶段已离开 Reconnect 就停止重试');
  }
  {   // 不在 Reconnect 阶段 / 关闭 / 合规: 不请求
    const a = makeEnv({ phase: 'InProgress' }); flag(a.ctx, 'reconnect', true);
    await a.ctx.autoReconnectRun();
    assert.strictEqual(a.calls.length, 0);
    const b = makeEnv({ phase: 'Reconnect' }); flag(b.ctx, 'reconnect', false);
    await b.ctx.autoReconnectRun();
    assert.strictEqual(b.calls.length, 0);
    const c = makeEnv({ phase: 'Reconnect', compliance: true }); flag(c.ctx, 'reconnect', true);
    await c.ctx.autoReconnectRun();
    assert.strictEqual(c.calls.length, 0);
    const d = makeEnv({ phase: 'Reconnect' }); flag(d.ctx, 'reconnect', true);
    await Promise.all([d.ctx.autoReconnectRun(), d.ctx.autoReconnectRun()]);
    assert.strictEqual(d.calls.filter(x => x.url.endsWith('/reconnect')).length, 1, '并发只执行一次');
  }
  {   // 阶段挂接: 进入 Reconnect 触发一次, 离开后再次掉线可再次触发
    const { ctx, calls } = makeEnv({ phase: 'Reconnect' });
    flag(ctx, 'reconnect', true);
    for (let i = 0; i < 4; i++) ctx.autoflowOnPhase('Reconnect');
    await settle(); await settle();
    assert.strictEqual(calls.filter(c => c.url.endsWith('/reconnect')).length, 1, '重复上报只触发一次');
    ctx.autoflowOnPhase('InProgress');
    ctx.autoflowOnPhase('Reconnect');
    await settle(); await settle();
    assert.strictEqual(calls.filter(c => c.url.endsWith('/reconnect')).length, 2, '再次掉线应再次触发');
  }

  // ---------- 开关保存 / 恢复 ----------
  {
    const { ctx, store } = makeEnv({ store: { autoHonor: '1', autoReconnect: '' } });
    ctx.autoflowLoad();
    assert.strictEqual(flagOf(ctx, 'honor'), true);
    assert.strictEqual(flagOf(ctx, 'reconnect'), false);
    ctx.toggleAutoReconnect(true);
    assert.strictEqual(store.autoReconnect, '1');
    ctx.toggleAutoHonor(false);
    assert.strictEqual(store.autoHonor, '');
    const cp = makeEnv({ compliance: true });
    cp.ctx.toggleAutoHonor(true);
    assert.strictEqual(flagOf(cp.ctx, 'honor'), false, '合规模式下无法开启');
  }

  // ---------- 合规模式: 界面上两个开关要被统一禁用并取消勾选, 关闭后恢复原偏好 ----------
  {
    const comp = read('renderer/js/compliance.js');
    const start = comp.indexOf('function applyComplianceState()');
    const fn = comp.slice(start, comp.indexOf('\nfunction guardAutomation', start));
    const els = {};
    const el = id => (els[id] = els[id] || { checked: false, disabled: false, textContent: '', style: {} });
    const ctx = vm.createContext({
      document: { getElementById: el }, storeGet: () => '', autoAcceptOn: false, updateReadyCheck: () => {},
      autoflow: { honor: true, reconnect: true }, complianceOn: false
    });
    vm.runInContext(fn, ctx);
    vm.runInContext('complianceOn = false; applyComplianceState()', ctx);
    assert.strictEqual(el('autoHonorToggle').checked, true, '合规模式关闭: 保持用户偏好');
    assert.strictEqual(el('autoReconnectToggle').disabled, false);
    vm.runInContext('complianceOn = true; applyComplianceState()', ctx);
    for (const id of ['autoHonorToggle', 'autoReconnectToggle']) {
      assert.strictEqual(el(id).disabled, true, id + ' 在合规模式下应被禁用');
      assert.strictEqual(el(id).checked, false, id + ' 在合规模式下应取消勾选');
    }
    vm.runInContext('complianceOn = false; applyComplianceState()', ctx);
    assert.strictEqual(el('autoHonorToggle').checked, true, '关闭合规模式后恢复原偏好');
    assert.strictEqual(el('autoHonorToggle').disabled, false);
  }

  // ---------- 接线 ----------
  const html = read('renderer/index.html');
  assert.ok(html.includes('id="autoHonorToggle"') && html.includes('toggleAutoHonor(this.checked)'));
  assert.ok(html.includes('id="autoReconnectToggle"') && html.includes('toggleAutoReconnect(this.checked)'));
  const scripts = [...html.matchAll(/<script src="js\/([^"?]+)/g)].map(m => m[1]);
  assert.ok(scripts.includes('autoflow.js'));
  assert.ok(read('renderer/js/lcu-events.js').includes("if (typeof autoflowOnPhase === 'function') autoflowOnPhase(phase);"));
  assert.ok(read('renderer/js/app.js').includes('autoflowLoad();'));
  assert.ok(read('renderer/js/compliance.js').includes('autoHonorToggle:') && read('renderer/js/compliance.js').includes('autoReconnectToggle:'), '合规模式要能统一关闭');
  assert.ok(/'\/lol-honor-v2'/.test(read('main/index.js')), '点赞接口前缀必须在主进程白名单内');

  console.log('自动点赞与掉线重连测试通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
