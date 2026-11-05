// 对局提示 (live-tips.js) 行为测试
// 1.5.82 删掉解说模式后, 这个模块只剩"对面成装 / 对位经济 / 十分钟补刀"三条播报,
// 但它复用的是原来那套语音通道 —— 删代码最容易删坏的就是这种"看起来没人用"的接线,
// 所以这里把"开关 → 检测 → 播报 → 语音合成"整条链跑一遍。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
}

const SRC = fs.readFileSync(path.join(__dirname, 'renderer/js/live-tips.js'), 'utf8');

function makeEnv(opts = {}) {
  const store = Object.assign({}, opts.store || {});
  const spoken = [];       // ttsSynthesize 收到的文本
  const stores = [];       // storeSet 调用记录
  const timers = [];
  const els = {};
  const ctx = {
    console, Promise, Number, String, Array, Set, Map, JSON, Math, Object, Uint8Array, Error,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    setInterval: (fn, ms) => { timers.push({ fn, ms, repeat: true }); return timers.length; },
    clearInterval: () => {},
    Date: { now: () => 1700000000000, parse: Date.parse },
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    Audio: function () {},
    storeGet: k => (store[k] === undefined ? '' : store[k]),
    storeSet: (k, v) => { store[k] = v; stores.push([k, v]); },
    safeParseStore: (k, dflt, check) => {
      const raw = store[k];
      if (raw === undefined || raw === '') return dflt;
      try { const v = JSON.parse(raw); return check(v) ? v : dflt; } catch (e) { return dflt; }
    },
    escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    toolMsg: () => {},
    document: {
      readyState: 'complete',
      getElementById: id => (els[id] === undefined ? null : els[id])
    },
    window: Object.assign({ _gameflowPhase: 'InProgress' }, opts.window || {}),
    lolAPI: {
      // 合成成功的桩。必须返回 ok:true —— 返回失败会触发"整局回退本机音色",
    // 后面的用例就再也走不到在线通道了 (这正是本文件长期失效的原因之一)。
    ttsSynthesize: async (text) => {
      spoken.push(text);
      return { ok: true, dataUrl: 'data:audio/mpeg;base64,//uQxAAA', source: 'edge' };
    },
    ttsVoices: async () => ([
      { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔女声', desc: 't' },
      { id: 'zh-CN-YunyangNeural', label: '云扬 · 沉稳男声', desc: 't' }
    ]),
      liveGameData: async () => opts.gameData || null,
      liveBoardPush: () => {},
      getVersion: async () => '14.1.1',
      getItems: async () => ({ data: {} }),
      lcuRequest: async () => ({ myTeam: [], theirTeam: [] })
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, store, spoken, stores, timers, els, get: n => vm.runInContext(n, ctx), run: f => vm.runInContext(f, ctx) };
}

// 极简 PoroMetrics 替身: 只提供对局提示用到的 5 个方法
function makeMetrics(opts = {}) {
  return {
    teamTotals: () => ({ leadPct: 8, allyValue: 40000, enemyValue: 37000 }),
    splitTeams: () => ({ ally: [{ championName: 'Yasuo' }], enemy: [{ championName: 'Annie' }], self: { championName: 'Yasuo', position: 'MIDDLE' } }),
    detectSpikes: opts.spikes || (() => []),
    findMatchup: () => null,
    playerValue: () => 0,
    formatGold: g => Math.round(g / 100) / 10 + 'k',
    positionLabel: p => (p === 'MIDDLE' ? '中单' : ''),
    creepScore: p => Number(p?.scores?.creepScore) || 0,
    creepMilestone: () => ({ hit: true, cs: 88 }),
    normalizePosition: p => p || ''
  };
}

function gameData() {
  const players = [];
  for (let i = 0; i < 10; i++) {
    players.push({
      championName: 'Champ' + i,
      team: i < 5 ? 'ORDER' : 'CHAOS',
      position: i === 0 ? 'MIDDLE' : '',
      scores: { kills: 1, deaths: 1, creepScore: 80 },
      items: []
    });
  }
  return { allPlayers: players, activePlayer: { summonerName: 'me' }, gameData: { gameTime: 660 } };
}

(async () => {
  // ---- 默认值 ----
  {
    const e = makeEnv();
    e.run('liveTipsLoadConfig()');
    ok('默认三条提示全关', e.get('liveTips').itemSpike === false && e.get('liveTips').matchup === false
      && e.get('liveTips').creep10 === false, e.get('liveTips'));
    ok('默认语音走在线通道', e.get('commentaryEngine') === 'online', e.get('commentaryEngine'));
    ok('默认音色柔和', e.get('commentaryStyle') === 'soft', e.get('commentaryStyle'));
    ok('默认浮窗本局区块开着', e.get('liveBoardOn') === true, e.get('liveBoardOn'));
  }
  {
    // 旧的 storage key 必须还能读出来, 否则删解说模式会把用户调好的音色重置
    const e = makeEnv({ store: { commentaryStyle: 'deep', commentaryRate: '1.15', commentaryVolume: '0.6', commentaryEngine: 'local' } });
    e.run('liveTipsLoadConfig()');
    ok('沿用旧的音色设置', e.get('commentaryStyle') === 'deep', e.get('commentaryStyle'));
    ok('沿用旧的语速设置', e.get('commentaryRate') === 1.15, e.get('commentaryRate'));
    ok('沿用旧的音量设置', Math.abs(e.get('commentaryVolume') - 0.6) < 1e-9, e.get('commentaryVolume'));
    ok('沿用旧的引擎设置', e.get('commentaryEngine') === 'local', e.get('commentaryEngine'));
  }

  // ---- 开关 ----
  {
    const e = makeEnv();
    e.run('liveTipsLoadConfig()');
    e.run("setLiveTip('itemSpike', true)");
    ok('单项开关写进 store', e.store.liveTips && JSON.parse(e.store.liveTips).itemSpike === true, e.store.liveTips);
    e.run("setLiveTip('itemSpike', false)");
    ok('关掉后回到全关', JSON.parse(e.store.liveTips).itemSpike === false, e.store.liveTips);
    ok('未知键不写入', (e.run("setLiveTip('nope', true)"), JSON.parse(e.store.liveTips).nope === undefined),
      e.store.liveTips);
  }

  // ---- 成装提示: 开关开着才会播 ----
  {
    const e = makeEnv({ gameData: gameData() });
    e.ctx.window.PoroMetrics = makeMetrics({
      spikes: () => [{ key: 'k1', player: { championName: 'Annie' }, step: 3 }]
    });
    e.run('liveTipsLoadConfig()');
    e.run("setLiveTip('itemSpike', true)");
    e.spoken.length = 0;
    await e.run('liveTipsPoll()');
    await new Promise(r => setImmediate(r));
    ok('成装提示会念出来', e.spoken.some(t => /三件套|3件套/.test(t)), e.spoken);
    ok('念的是中文提示', e.spoken.every(t => /[\u4e00-\u9fff]/.test(t)), e.spoken);

    // 同一档位不重复播
    const before = e.spoken.length;
    await e.run('liveTipsPoll()');
    await new Promise(r => setImmediate(r));
    ok('同一档位不重复播', e.spoken.length === before, { before, after: e.spoken.length });
  }
  {
    const e = makeEnv({ gameData: gameData() });
    e.ctx.window.PoroMetrics = makeMetrics({
      spikes: () => [{ key: 'k1', player: { championName: 'Annie' }, step: 3 }]
    });
    e.run('liveTipsLoadConfig()');
    await e.run('liveTipsPoll()');
    await new Promise(r => setImmediate(r));
    ok('开关关着就不出声', e.spoken.length === 0, e.spoken);
  }

  // ---- 十分钟补刀 ----
  {
    const e = makeEnv({ gameData: gameData() });
    e.ctx.window.PoroMetrics = makeMetrics();
    e.run('liveTipsLoadConfig()');
    e.run("setLiveTip('creep10', true)");
    e.spoken.length = 0;
    await e.run('liveTipsPoll()');
    await new Promise(r => setImmediate(r));
    ok('十分钟补刀会念出来', e.spoken.some(t => /刀/.test(t)), e.spoken);
    const before = e.spoken.length;
    await e.run('liveTipsPoll()');
    await new Promise(r => setImmediate(r));
    ok('补刀只播一次', e.spoken.length === before, { before, after: e.spoken.length });
  }

  // ---- 阶段: 结算时要停掉轮询 ----
  {
    const e = makeEnv();
    e.run('liveTipsLoadConfig()');
    e.run("setLiveTip('matchup', true)");
    e.run("liveTipsOnPhase('InProgress')");
    ok('进对局开始轮询', e.get('_cmtPollTimer') !== null, e.get('_cmtPollTimer'));
    e.run("liveTipsOnPhase('WaitingForStats')");
    ok('结算停掉轮询', e.get('_cmtPollTimer') === null, e.get('_cmtPollTimer'));
    ok('选人阶段缓存位置不清空轮询之外的状态', (e.run("liveTipsOnPhase('ChampSelect')"), true));
  }
  {
    const e = makeEnv();
    e.run('liveTipsLoadConfig()');
    e.run("liveTipsOnPhase('InProgress')");
    ok('三项提示全关且浮窗关掉时不轮询', e.get('liveTipsAnyActive')() === true,
      e.get('liveTipsAnyActive')());
    e.run('toggleLiveBoard(false)');
    ok('浮窗关掉 + 提示全关 = 不轮询', e.get('liveTipsAnyActive')() === false,
      e.get('liveTipsAnyActive')());
  }

  // ---- 试听 ----
  {
    const e = makeEnv();
    e.run('liveTipsLoadConfig()');
    e.spoken.length = 0;
    e.run('testVoice()');
    await new Promise(r => setImmediate(r));
    ok('试听不需要打开任何开关', e.spoken.length === 1, e.spoken);
    ok('试听念的是一句提示语', /[\u4e00-\u9fff]/.test(e.spoken[0] || ''), e.spoken);
  }

  // ---- 神经语音 (1.5.82) ----
  {
    const e = makeEnv();
    const sel = { innerHTML: '', value: '', disabled: true };
    e.els.voiceVoice = sel;
    e.run('liveTipsLoadConfig()');
    // 旧版在线通道只有一句置灰的"音色: 在线女声", 现在必须能真选
    ok('在线通道列出神经音色', /晓晓/.test(sel.innerHTML), sel.innerHTML.slice(0, 60));
    ok('音色下拉可选', sel.disabled === false, sel.disabled);
    ok('默认选中晓晓', sel.value === 'zh-CN-XiaoxiaoNeural', sel.value);

    const opts = e.get('commentaryOnlineOpts')(false);
    ok('合成参数带音色', opts.voice === 'zh-CN-XiaoxiaoNeural', opts);
    ok('默认语速略快于朗读', opts.rate > 0, opts.rate);
    ok('试听参数带 reset', e.get('commentaryOnlineOpts')(true).reset === true);

    // 换音色: 写在线专用键, 不能污染本机音色键 (两者值域不同, 混存会互相覆盖)
    e.spoken.length = 0;
    e.run("setVoiceOption('voice', 'zh-CN-YunyangNeural')");
    await new Promise(r => setImmediate(r));
    ok('换音色写在线专用键', e.store.commentaryNeuralVoice === 'zh-CN-YunyangNeural', e.store.commentaryNeuralVoice);
    ok('不污染本机音色键', !e.store.commentaryVoice, e.store.commentaryVoice);
    ok('换音色后立即试听', e.spoken.length > 0, e.spoken);
    ok('换音色后参数跟着变', e.get('commentaryOnlineOpts')().voice === 'zh-CN-YunyangNeural',
      e.get('commentaryOnlineOpts')().voice);

    // 神经档不该压共鸣峰: 那是给旧接口机械音硬凑柔和用的, 压真人的声音只会变闷
    const softN = e.get('cmtStyleCfg')('soft', true);
    const softL = e.get('cmtStyleCfg')('soft', false);
    ok('神经档不做共鸣峰压制', softN.peak === 0 && softL.peak < 0, { neural: softN.peak, legacy: softL.peak });
    ok('神经档保留原声高频', softN.lp > softL.lp, { neural: softN.lp, legacy: softL.lp });
  }
  {
    // 切回本机: 下拉应换成系统音色, 不再列出神经音色
    const e = makeEnv();
    const sel = { innerHTML: '', value: '', disabled: true };
    e.els.voiceVoice = sel;
    e.run('liveTipsLoadConfig()');
    e.run("setVoiceOption('engine', 'local')");
    ok('本机通道不列神经音色', !/晓晓/.test(sel.innerHTML), sel.innerHTML.slice(0, 80));
  }

  // ---- 解说模式的东西必须彻底消失 ----
  {
    const e = makeEnv();
    for (const gone of ['toggleCommentary', 'setCommentaryOption', 'setCommentaryEvent',
      'testCommentaryVoice', 'commentaryOnPhase', 'commentaryPoll', 'commentaryHandleEvents',
      'CMT_TEXT', 'commentaryOn']) {
      ok('解说模式残留已删除: ' + gone, typeof e0(e, gone) === 'undefined' || e0(e, gone) === null, gone);
    }
  }

  console.log(`对局提示: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();

function e0(e, name) {
  try { return e.get(name); } catch (err) { return undefined; }
}
