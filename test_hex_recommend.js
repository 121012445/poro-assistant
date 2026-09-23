'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('renderer/js/hex.js', 'utf8');
assert.ok(source.includes("phase === 'GameStart' || phase === 'InProgress'"), '加载页开始就应自动监听强化弹窗');
assert.ok(source.includes('setInterval(() => scanCurrentAugmentOffers(false), 500)'), '强化弹窗应每 500ms 自动检测，快捷键只能作为兜底');
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
hexWinStats = {championId:236,loading:false,error:'',requestId:1,data:{version:'16.18',augments:{
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

const overlaySource = fs.readFileSync('renderer/js/augment-overlay.js', 'utf8');
const mainSource = fs.readFileSync('main/index.js', 'utf8');
assert.ok(overlaySource.includes('item.reason') && overlaySource.includes('confidenceLevel'), '浮窗应展示推荐依据与可信度');
assert.ok(mainSource.includes("reason: String(item?.reason") && mainSource.includes('recommendationScore:'), '主进程不得丢弃条件化推荐字段');

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
  const scanOk = await vm.runInContext('scanCurrentAugmentOffers(false)', context);
  assert.strictEqual(scanOk, true, '完整识别三张卡后应成功推送浮窗');
  assert.ok(overlayPayload?.visible, '强化推荐浮窗应为可见');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(overlayPayload.items.map(x => x.name))), ['掷骰狂人', '易损', '珠光护手']);

  // 后两轮光效较强时，OCR 常连续出现“先识别两张、下一帧补齐第三张”。
  // 三个卡槽在短时间窗口内都确认后仍必须弹出推荐。
  vm.runInContext('hideAugmentRecommendation()', context);
  overlayPayload = null;
  let partialCall = 0;
  context.lolAPI.recognizeAugments = async () => (++partialCall === 1 ? {
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
  assert.strictEqual(await vm.runInContext('scanCurrentAugmentOffers(false)', context), false, '只确认两张时不应过早显示');
  assert.strictEqual(await vm.runInContext('scanCurrentAugmentOffers(false)', context), true, '下一帧补齐第三张后应合并显示');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(overlayPayload.items.map(x => x.name))), ['掷骰狂人', '易损', '珠光护手']);
  console.log('海斗强化真实胜率排序测试通过');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
