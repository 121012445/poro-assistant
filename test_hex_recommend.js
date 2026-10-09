'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('renderer/js/hex.js', 'utf8');
assert.ok(source.includes("phase === 'GameStart' || phase === 'InProgress'"), '加载页开始就应自动监听强化弹窗');
// 自动检测不再是固定 500ms 的 setInterval: 有卡片/浮窗时 500ms, 空闲时放慢 (见文件末尾的行为测试)。
assert.ok(source.includes('const AUGMENT_SCAN_ACTIVE_MS = 500;'), '强化弹窗活跃期应保持 500ms 自动检测，快捷键只能作为兜底');
assert.ok(!source.includes('setInterval(() => scanCurrentAugmentOffers'), '强化扫描不应退回固定频率的 setInterval');
let flowResponse = { gameData: { queue: { id: 2400, gameMode: 'JADE' } } };
let overlayPayload = null;
const context = vm.createContext({
  console,
  window: { _myPuuid: 'mine' },
  document: {
    querySelector: () => null,
    getElementById: () => null
  },
  lolAPI: {
    writeFile: async () => {},
    readFile: async () => null,
    lcuRequest: async () => flowResponse,
    getHexChampionAugments: async () => ({ augments: {} }),
    // 模拟旧主进程的成功响应：有三张已确认卡，但缺少 layoutDetected=true。
    // 渲染层必须兼容它，只有显式 false 才表示三选一界面消失。
    recognizeAugments: async () => ({
      offers: [
        { slot: 0, id: 2095, name: '掷骰狂人', icon: 'roller', score: 0.99, accepted: true },
        { slot: 1, id: 1092, name: '易损', icon: 'v', score: 0.99, accepted: true },
        { slot: 2, id: 1048, name: '珠光护手', icon: 'jg', score: 0.99, accepted: true }
      ]
    }),
    augmentOverlayUpdate: async payload => { overlayPayload = payload; return { ok: true, visible: true }; },
    augmentOverlayStatus: async () => ({ visible: true }),
    debugLog: () => {},
    notify: () => {}
  },
  setTimeout: fn => { fn(); return 1; },
  clearTimeout: () => {},
  fetch: async () => ({ ok: false }),
  escapeHtml: String,
  ensureChampMap: () => {},
  champNumMap: {},
  champImg: String
});
context.window.lolAPI = context.lolAPI;
vm.runInContext(source, context, { filename: 'renderer/js/hex.js' });

// 旧库的 gameId 已做过全局统计；升级后再次遇到同一局，只补英雄维度。
vm.runInContext(`hexDB = {
  seen: [1], aug: {1205:{g:10,w:5}}
}`, context);
const games = [{
  gameId: 1, queueId: 2400, participants: [{
    championId: 60081, win: true, playerAugment1: 1205, playerAugment2: 1205
  }]
}, {
  gameId: 2, queueId: 2400, participants: [{
    championId: 81, win: false, playerAugment1: 1205, playerAugment2: 1300
  }]
}];
context.__games = games;
vm.runInContext('collectHexAugments(__games)', context);
const db = JSON.parse(vm.runInContext('JSON.stringify(hexDB)', context));
assert.strictEqual(db.aug['1205'].g, 11, '旧局不得重复增加全局统计');
assert.strictEqual(db.champs['81'].g, 2, '旧局应补录英雄统计');
assert.strictEqual(db.champs['81'].aug['1205'].g, 2, '同局重复强化 ID 只能计算一次');
assert.deepStrictEqual(db.champSeen.map(Number), [1, 2]);

const personal = JSON.parse(vm.runInContext('JSON.stringify(hexAugList(81))', context));
assert.strictEqual(personal[0].id, 1205);
assert.strictEqual(personal[0].heroGames, 2);
assert.strictEqual(personal[0].heroWins, 1);

// 卢锡安必须按英雄维度的真实胜率排序，不能被个人使用次数干扰。
vm.runInContext(`hexAugMeta = {
  2095:{name:'掷骰狂人',icon:'roller',rarity:'棱彩',key:'HighRoller'},
  1048:{name:'珠光护手',icon:'jg',rarity:'棱彩',key:'ARAM_JeweledGauntlet'},
  48:{name:'珠光护手',icon:'old-jg',rarity:'棱彩',key:'JeweledGauntlet'},
  1092:{name:'易损',icon:'v',rarity:'黄金',key:'ARAM_Vulnerability'},
  1336:{name:'升级：无尽之刃',icon:'ie',rarity:'黄金',key:'ARAM_Upgrade_IE'},
  1329:{name:'史上最大雪球',icon:'snow',rarity:'棱彩',key:'BiggestSnowballEver'}
};
hexDB.champs['236'] = {g:8,w:4,aug:{1329:{g:8,w:4},1048:{g:1,w:1}}};
hexWinStats = {championId:236,loading:false,error:'',requestId:1,data:{version:'16.18',baseline:0.4977,augments:{
  2095:{winRate:0.6164,games:81818,pickRate:0.0209,rank:1,lift:0.1187},
  1092:{winRate:0.5573,games:948100,pickRate:0.2422,rank:2,lift:0.0596},
  1048:{winRate:0.5529,games:525410,pickRate:0.1342,rank:3,lift:0.0552},
  1336:{winRate:0.5100,games:700000,pickRate:0.18,rank:20,lift:0.0123},
  1329:{winRate:0.4900,games:900000,pickRate:0.20,rank:40,lift:-0.0077}
}}};`, context);
const lucian = JSON.parse(vm.runInContext('JSON.stringify(hexAugList(236))', context));
assert.deepStrictEqual(lucian.slice(0, 3).map(x => x.name), ['掷骰狂人', '易损', '珠光护手']);
assert.strictEqual(lucian[0].winRate, 0.6164);
assert.strictEqual(lucian[1].publicGames, 948100);
assert.strictEqual(lucian.filter(x => x.name === '珠光护手').length, 1, '同名 ARAM/通用强化应合并');
assert.ok(lucian.findIndex(x => x.name.includes('雪球')) > 2, '个人用过更多次不得改变真实胜率顺序');

// 无公开胜率的新强化也必须进入 OCR 候选，否则三选一里出现它时整组提示都会消失。
vm.runInContext(`hexAugMeta[1136] = {name:'扇巴掌',icon:'slap',rarity:'黄金',key:'ARAM_Slap'};`, context);
const candidates = JSON.parse(vm.runInContext('JSON.stringify(augmentCandidateRows(236))', context));
assert.ok(candidates.some(x => x.name === '扇巴掌'), '无胜率样本的当前强化仍应参与名称识别');
assert.ok(candidates.find(x => x.name === '易损').priority > 0, '有公开样本的强化应保留图标冲突优先级');

// 条件化推荐：组合小样本只能按可信度加权，不能直接覆盖稳定英雄胜率；明确点名的已持有装备可小幅加分。
context.allItems = { '3031': { name: '无尽之刃' } };
vm.runInContext(`allItems = globalThis.allItems`, context);
const weighted = JSON.parse(vm.runInContext(`JSON.stringify(scoreAugmentRecommendation(
  {name:'易损',key:'ARAM_Vulnerability',winRate:0.56,adjustedWinRate:0.555,publicGames:900000},
  {winRate:0.80,games:40},
  {stage:3,itemIds:[]},
  0.50
))`, context));
assert.ok(Math.abs(weighted.score - 0.555) < 0.01 && weighted.score < 0.60, '40场组合不得把80%小样本胜率直接当成推荐分');
assert.strictEqual(weighted.confidence.level, 'high');
const itemFit = JSON.parse(vm.runInContext(`JSON.stringify(scoreAugmentRecommendation(
  {name:'升级：无尽之刃',key:'ARAM_Upgrade_IE',winRate:0.51,adjustedWinRate:0.51,publicGames:8000},
  null,
  {stage:4,itemIds:[3031]},
  0.50
))`, context));
assert.strictEqual(itemFit.itemSynergy.name, '无尽之刃');
assert.ok(itemFit.reason.includes('适配已装备无尽之刃'));
const locallyAdjusted = JSON.parse(vm.runInContext(`JSON.stringify(scoreAugmentRecommendation(
  {name:'测试强化',winRate:0.52,adjustedWinRate:0.52,publicGames:8000,heroGames:8,heroWins:7},
  null, {stage:2,itemIds:[]}, 0.50
))`, context));
assert.ok(locallyAdjusted.localWeight > 0 && locallyAdjusted.localWeight <= 0.12, '本机样本只能轻量校准');
assert.ok(locallyAdjusted.reason.includes('本机8场同英雄样本'));

const overlaySource = fs.readFileSync('renderer/js/augment-overlay.js', 'utf8');
const mainSource = fs.readFileSync('main/index.js', 'utf8');
const preloadSource = fs.readFileSync('main/preload.js', 'utf8');
const htmlSource = fs.readFileSync('renderer/index.html', 'utf8');
assert.ok(overlaySource.includes('item.reason') && overlaySource.includes('confidenceLevel'), '浮窗应展示推荐依据与可信度');
assert.ok(overlaySource.includes('gainText') && overlaySource.includes('参考不足') && overlaySource.includes('百分点') && overlaySource.includes('胜率 '), '浮窗应区分原始胜率差与推荐分，并保留低样本提示');
assert.ok(mainSource.includes("reason: String(item?.reason") && mainSource.includes('recommendationScore:') && mainSource.includes('gainReliable:'), '主进程不得丢弃条件化推荐字段');
assert.ok(mainSource.includes("ipcMain.handle('augment-overlay:layout:set'") && mainSource.includes("anchor.endsWith('right')"), '强化浮窗应支持四角布局持久化');
assert.ok(preloadSource.includes('setAugmentOverlayLayout:') && htmlSource.includes('augmentOverlayAnchor'), '强化页应提供布局控制入口');

context.__session = {
  localPlayerCellId: 3,
  myTeam: [{ cellId: 3, puuid: 'mine', championId: 0, championPickIntent: 0 }],
  actions: [[{ actorCellId: 3, type: 'pick', championId: 60081, completed: false }]]
};
assert.strictEqual(vm.runInContext('hexSelectedChampion(__session)', context), 81, '应识别当前悬停英雄并归一化国服 60000+ ID');
context.__flow = {
  gameData: {
    queue: { id: 2400, gameMode: 'KIWI' },
    teamOne: [{ puuid: 'mine', championId: 60081 }]
  }
};
assert.strictEqual(vm.runInContext('hexFlowChampion(__flow)', context), 81, '加载页应从 gameflow 恢复本地玩家英雄');

(async () => {
  await vm.runInContext('updateHexRecommendationContext(__session, true)', context);
  const state = JSON.parse(vm.runInContext('JSON.stringify(hexRecommendContext)', context));
  assert.strictEqual(state.isHex, true);
  assert.strictEqual(state.champId, 81);
  flowResponse = context.__flow;
  vm.runInContext('hexRecommendContext.isHex = false; hexRecommendContext.champId = 0', context);
  await vm.runInContext('updateHexRecommendationContext(null, true)', context);
  const loadingState = JSON.parse(vm.runInContext('JSON.stringify(hexRecommendContext)', context));
  assert.strictEqual(loadingState.isHex, true, '加载页应从 gameflow 恢复海斗模式');
  assert.strictEqual(loadingState.champId, 81, '加载页应从 gameflow 恢复所选英雄');

  // OCR 已确认三张卡后，必须真正推送透明浮窗，不能在排序或英雄映射阶段静默失败。
  flowResponse = { gameData: { queue: { id: 2400, gameMode: 'JADE' }, playerChampionId: 236 } };
  vm.runInContext('hexRecommendContext = {isHex:true,champId:236,queueId:2400,checkedAt:Date.now(),checking:false}', context);
  assert.strictEqual(await vm.runInContext('scanCurrentAugmentOffers(false)', context), false, '单帧 OCR 不得直接显示，避免相似标题误识');
  const scanOk = await vm.runInContext('scanCurrentAugmentOffers(false)', context);
  assert.strictEqual(scanOk, true, '完整识别三张卡后应成功推送浮窗');
  assert.ok(overlayPayload?.visible, '强化推荐浮窗应为可见');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(overlayPayload.items.map(x => x.name))), ['掷骰狂人', '易损', '珠光护手']);
  assert.ok(overlayPayload.items.every(x => Number.isFinite(x.gain)), '可靠样本应携带相对英雄基准的正负收益');

  // 后两轮光效较强时，OCR 常连续出现“先识别两张、下一帧补齐第三张”。
  // 三个卡槽在短时间窗口内都确认后仍必须弹出推荐。
  vm.runInContext('hideAugmentRecommendation()', context);
  overlayPayload = null;
  let partialCall = 0;
  context.lolAPI.recognizeAugments = async () => (partialCall++ < 2 ? {
    layoutDetected: true,
    offers: [
      { slot: 0, id: 2095, name: '掷骰狂人', icon: 'roller', score: 0.99, accepted: true, confirmedBy: 'ocr' },
      { slot: 1, id: 1092, name: '易损', icon: 'v', score: 0.99, accepted: true, confirmedBy: 'ocr' },
      { slot: 2, accepted: false, confirmedBy: 'vision' }
    ]
  } : {
    layoutDetected: true,
    offers: [
      { slot: 0, accepted: false, confirmedBy: 'vision' },
      { slot: 1, accepted: false, confirmedBy: 'vision' },
      { slot: 2, id: 1048, name: '珠光护手', icon: 'jg', score: 0.99, accepted: true, confirmedBy: 'ocr' }
    ]
  });
  assert.strictEqual(await vm.runInContext('scanCurrentAugmentOffers(false)', context), false, '第一帧只观察，不应过早显示');
  assert.strictEqual(await vm.runInContext('scanCurrentAugmentOffers(false)', context), false, '两张卡完成跨帧确认时仍不应过早显示');
  assert.strictEqual(await vm.runInContext('scanCurrentAugmentOffers(false)', context), false, '第三张第一帧仍需等待共识');
  assert.strictEqual(await vm.runInContext('scanCurrentAugmentOffers(false)', context), true, '第三张跨帧确认后应合并显示');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(overlayPayload.items.map(x => x.name))), ['掷骰狂人', '易损', '珠光护手']);
  console.log('海斗强化真实胜率排序测试通过');

  // A delayed OCR completion must never revive an overlay after leaving the game.
  let finishRecognition;
  let recognitionStarted;
  const started = new Promise(resolve => { recognitionStarted = resolve; });
  context.lolAPI.recognizeAugments = () => {
    recognitionStarted();
    return new Promise(resolve => { finishRecognition = resolve; });
  };
  const pendingScan = vm.runInContext('scanCurrentAugmentOffers(false)', context);
  await started;
  vm.runInContext('stopAugmentRecognition()', context);
  finishRecognition({ layoutDetected: true, offers: [] });
  await pendingScan;
  assert.strictEqual(overlayPayload.visible, false, '过期识别不能重新显示浮窗');
  assert.strictEqual(vm.runInContext('_augmentScanBusy', context), false);

  const store = {};
  context.storeGet = key => store[key];
  context.storeSet = (key, value) => { store[key] = value; };
  vm.runInContext(`
    hexAugMeta[1048] = { name: '珠光护手' };
    recordAugmentJournal(236, 3, [{ name:'珠光护手',slot:2,games:100,reason:'样本' }], []);
    confirmAugmentJournal([]);
  `, context);
  assert.strictEqual(JSON.parse(store.augmentJournal)[0].selected, null, '不能根据视觉消失猜测选择');
  vm.runInContext('confirmAugmentJournal([1048])', context);
  assert.strictEqual(JSON.parse(store.augmentJournal)[0].selected, '珠光护手');
  assert.strictEqual(JSON.parse(store.augmentJournal)[0].stage, 3);
  for (const stage of [1, 2, 3, 4]) {
    context.testStage = stage;
    vm.runInContext(`recordAugmentJournal(236, testStage, [{ name:'珠光护手',slot:2,games:100,reason:'样本' }], [])`, context);
    assert.strictEqual(JSON.parse(store.augmentJournal)[0].stage, stage);
  }

  // ===== 2026-09-28 强化列表三层防御 (重连窗口启动导致整会话"资料尚未加载") =====
  // VM 里补齐 loadHexAugments 需要的全局
  context.AbortController = class { constructor() { this.signal = {}; } abort() {} };
  const augStore = {};
  context.localStorage = {
    getItem: k => (k in augStore ? augStore[k] : null),
    setItem: (k, v) => { augStore[k] = String(v); }
  };
  // a) 网络失败时回退 localStorage 缓存, 不能把空列表留到下一局
  vm.runInContext('hexAugMeta = {};', context);   // 模拟"启动时拉取失败后的空列表"
  augStore['poro.hexAugMeta.v1'] = JSON.stringify({ 7001: { name: '缓存强化', icon: 'cached', rarity: '', key: 'K' } });
  assert.strictEqual(await vm.runInContext('loadHexAugments(true)', context), true,
    '网络失败时必须回退上次成功的缓存');
  assert.strictEqual(JSON.parse(vm.runInContext('JSON.stringify(hexAugMeta[7001])', context)).name, '缓存强化');
  // b) 成功路径: fetch 拿到数据要写入 hexAugMeta 并回写 localStorage
  context.fetch = async () => ({ ok: true, json: async () => [
    { id: 7002, nameTRA: '网拉强化', augmentSmallIconPath: '/lol-game-data/assets/ASSETS/Characters/X.PNG', rarity: 'Chromatic', augmentNameId: 'NET_AUG' }
  ] });
  assert.strictEqual(await vm.runInContext('loadHexAugments(true)', context), true, '正常拉取应返回成功');
  const netMeta = JSON.parse(vm.runInContext('JSON.stringify(hexAugMeta[7002])', context));
  assert.strictEqual(netMeta.name, '网拉强化');
  assert.strictEqual(netMeta.icon, 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/assets/characters/x.png',
    '图标路径必须剥掉 /lol-game-data/assets/ 前缀并转小写');
  assert.ok(augStore['poro.hexAugMeta.v1'].includes('7002'), '成功结果必须写回 localStorage 供下次兜底');
  // c) 空列表 + 补拉也失败: 扫描必须跳过本轮, 空候选不进主进程
  vm.runInContext(`hexAugMeta = {}; localStorage.setItem('poro.hexAugMeta.v1', '{}'); _hexAugLastTryAt = 0;`, context);
  context.fetch = async () => ({ ok: false });
  let recognized = 0;
  context.lolAPI.recognizeAugments = async () => { recognized++; return { offers: [] }; };
  assert.strictEqual(await vm.runInContext('scanCurrentAugmentOffers(false)', context), false,
    '列表为空且补拉失败时本轮扫描应跳过');
  assert.strictEqual(recognized, 0, '空列表不得触发识别调用 (主进程只会白报一次"资料尚未加载")');
  // d) 列表在扫描入口自动补拉成功后, 同一轮就能继续正常识别 (自愈路径)
  context.fetch = async () => ({ ok: true, json: async () => [
    { id: 7003, nameTRA: '自愈强化', augmentSmallIconPath: '/lol-game-data/assets/heal.png', rarity: 'Chromatic', augmentNameId: 'HEAL' }
  ] });
  vm.runInContext('_hexAugLastTryAt = 0;', context);   // 越过 20s 冷却, 模拟"下一轮扫描"
  await vm.runInContext('scanCurrentAugmentOffers(false)', context);
  assert.strictEqual(JSON.parse(vm.runInContext('JSON.stringify(hexAugMeta[7003])', context)).name, '自愈强化',
    '扫描入口的补拉必须真的把列表填上');
  assert.strictEqual(recognized, 1, '补拉成功后同一轮扫描应继续走到识别');

  console.log('识别取消竞态与本地选择档案测试通过');

  // ---------- 自适应扫描频率 + 非海斗暂停 ----------
  const timers = [];
  context.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  context.clearTimeout = () => {};
  const run = code => vm.runInContext(code, context);
  const fire = async () => { const t = timers.shift(); await t.fn(); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 3));   // 保证两次 gameflow 刷新的 checkedAt 不同

  run('stopAugmentRecognition(); _augmentLastPayload = null;');
  timers.length = 0;
  assert.strictEqual(run('augmentNextScanDelay()'), 1200, '没有卡片、没有浮窗时应放慢到空闲频率');
  run('_augmentActiveUntil = Date.now() + 1000');
  assert.strictEqual(run('augmentNextScanDelay()'), 500, '刚见过卡片版面时应保持高频');
  run('_augmentActiveUntil = 0; _augmentLastPayload = { visible: true }');
  assert.strictEqual(run('augmentNextScanDelay()'), 500, '浮窗显示期间需高频以便及时判定消失');
  run('_augmentLastPayload = null');

  // 非海斗: 连续 5 次确认后暂停, 且重复上报同一阶段不能把它拉起来
  flowResponse = { gameData: { queue: { id: 420, gameMode: 'CLASSIC' } } };
  run("window._gameflowPhase = 'InProgress'; syncAugmentRecognitionForPhase('InProgress')");
  assert.strictEqual(timers.length, 1, '进入对局应启动识别循环');
  assert.strictEqual(timers[0].ms, 100, '首轮 100ms 后立即扫描');
  for (let i = 1; i <= 4; i++) {
    await tick(); run('hexRecommendContext.checkedAt = 0'); await fire();
    assert.strictEqual(timers.length, 1, `第 ${i} 次确认非海斗后仍应继续`);
    assert.strictEqual(timers[0].ms, 1200, '空闲期应使用 1200ms 间隔');
  }
  await tick(); run('hexRecommendContext.checkedAt = 0'); await fire();
  assert.strictEqual(timers.length, 0, '连续 5 次确认非海斗后应暂停，不再排下一轮');
  assert.strictEqual(run('_augmentPausedNonHex'), true);
  run("syncAugmentRecognitionForPhase('InProgress')");
  assert.strictEqual(timers.length, 0, '暂停后轮询重复上报同一阶段，不得重新启动循环');
  run("syncAugmentRecognitionForPhase('None')");
  assert.strictEqual(run('_augmentPausedNonHex'), false, '离开对局阶段应清除暂停');
  run("syncAugmentRecognitionForPhase('GameStart')");
  assert.strictEqual(timers.length, 1, '下一局应重新评估并启动');

  // 海斗: 连续计数被清零, 循环不暂停
  timers.length = 0; run('stopAugmentRecognition()');
  flowResponse = { gameData: { queue: { id: 2400, gameMode: 'KIWI_JADE' } } };
  run("syncAugmentRecognitionForPhase('InProgress')");
  for (let i = 0; i < 7; i++) { await tick(); run('hexRecommendContext.checkedAt = 0'); await fire(); }
  assert.strictEqual(timers.length, 1, '海斗对局不得被暂停');
  assert.strictEqual(run('_augmentPausedNonHex'), false);

  // 队列 ID 未知 (gameflow 读取失败/加载期空数据) 不能算作"非海斗"
  timers.length = 0; run('stopAugmentRecognition()');
  flowResponse = { gameData: {} };
  run("syncAugmentRecognitionForPhase('GameStart')");
  for (let i = 0; i < 7; i++) { await tick(); run('hexRecommendContext.checkedAt = 0'); await fire(); }
  assert.strictEqual(run('_augmentPausedNonHex'), false, '队列未知时不得下结论');
  assert.strictEqual(timers.length, 1);

  // 已作废的旧循环 (stop 之后才返回) 不得继续排程，否则重启后会出现两条并行循环
  timers.length = 0; run('stopAugmentRecognition()');
  run("syncAugmentRecognitionForPhase('InProgress')");
  const staleTimer = timers.shift();
  run('stopAugmentRecognition()');
  await staleTimer.fn();
  assert.strictEqual(timers.length, 0, 'stop 之后触发的旧定时器不得再排下一轮');
  run('stopAugmentRecognition()');

  // 扫描进行到一半时被 stop (例如离开对局): 扫描返回后同样不得续排
  timers.length = 0;
  flowResponse = { gameData: { queue: { id: 2400, gameMode: 'KIWI_JADE' } } };
  const originalLcuRequest = context.lolAPI.lcuRequest;
  run("syncAugmentRecognitionForPhase('InProgress')");
  context.lolAPI.lcuRequest = async () => { run('stopAugmentRecognition()'); return flowResponse; };
  run('hexRecommendContext.checkedAt = 0');
  await fire();
  context.lolAPI.lcuRequest = originalLcuRequest;
  assert.strictEqual(timers.length, 0, '扫描途中被 stop 后，返回时不得再排下一轮 (否则离开对局后循环仍在跑)');
  run('stopAugmentRecognition()');

  console.log('强化扫描自适应频率与非海斗暂停测试通过');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
