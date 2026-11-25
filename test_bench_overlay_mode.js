'use strict';
// 备战区浮窗的模式门禁: 只有大乱斗(450)/海斗(2400)才允许出现。
// 旧实现只看 session 有没有 benchChampions 字段, 其他模式也可能带这个键(哪怕是空数组),
// 于是排位里会浮一个没用的窗。这里用最小 vm 上下文直接驱动渲染层 + 检查主进程门禁。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = __dirname;
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const pushes = [];
const nodes = {};
const el = id => nodes[id] || (nodes[id] = {
  id, innerHTML: '', textContent: '', className: '', value: '', checked: false,
  style: {}, hidden: false, addEventListener() {}, querySelectorAll: () => []
});
let modeCtx = { queueId: 0, gameMode: '', key: 'rift', known: false };

function load(opts) {
  const o = opts || {};
  pushes.length = 0;
  modeCtx = o.ctx || { queueId: 0, gameMode: '', key: 'rift', known: false };
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    Date, JSON, Math, Promise, Object, Array, String, Number, Boolean, Set, Map, RegExp, Error,
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: {
      getElementById: el,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => el('tmp'),
      body: el('body')
    },
    addEventListener() {}, removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    lolAPI: {
      lcuRequest: () => Promise.resolve({}),
      overlayUpdate: p => { pushes.push(p); return Promise.resolve(true); }
    },
    getAutomationModeContext: () => ({ ...modeCtx }),
    champNumMap: { 1: { id: 'Annie', name: '安妮' }, 7: { id: 'LeBlanc', name: '乐芙兰' } },
    hexRecommendContext: o.hex || { isHex: false, queueId: 0 },
    aramBalance: { loadedAt: 0 },
    modeTiers: {},
    tierModeFor: () => null,
    guardWrite: () => true,
    storeGet: () => null,
    storeSet() {},
    toolMsg() {},
    logDebug() {},
    logErr() {},
    navigator: { userAgent: 'node' }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('renderer/js/bench.js'), sandbox, { filename: 'renderer/js/bench.js' });
  vm.runInContext(`
    window._gameflowPhase = 'ChampSelect';
    benchOverlayOn = true;
    _benchLastSession = ${JSON.stringify(o.session || { benchChampions: [{ championId: 1 }, { championId: 7 }] })};
    _benchOverlayItems = [{ id: 1, name: '安妮', tag: '备战席' }];
    _benchOverlayKey = '';
    _benchOverlaySync();
  `, sandbox);
  return {
    sandbox,
    run: expr => vm.runInContext(expr, sandbox),
    last: () => pushes[pushes.length - 1]
  };
}

(async () => {
  // ---------- 1. 大乱斗 / 海斗：正常显示 ----------
  for (const ctx of [
    { queueId: 450, gameMode: 'KIWI', key: 'aram', known: true },
    { queueId: 2400, gameMode: 'KIWI_JADE', key: 'aram', known: true }
  ]) {
    const h = load({ ctx });
    assert.strictEqual(h.last().visible, true, '大乱斗/海斗选人应显示备战区浮窗');
    assert.strictEqual(h.last().mode, 'aram', '推送要带 aram 模式标记给主进程兜底');
  }

  // ---------- 2. 排位等峡谷模式：即便 session 带 benchChampions 也不显示 ----------
  const ranked = load({ ctx: { queueId: 420, gameMode: 'CLASSIC', key: 'rift', known: true } });
  assert.strictEqual(ranked.last().visible, false, '排位带 benchChampions 字段也不得弹出备战区浮窗');
  assert.strictEqual(ranked.last().mode, '', '非 aram 必须推空模式，主进程据此拒绝开窗');
  assert.strictEqual(ranked.last().items.length, 0, '隐藏时不能把按钮一起推出去');

  // ---------- 3. 上下文未就绪时，退回 hex 队列识别 / session 字段 ----------
  const unknown = { queueId: 0, gameMode: '', key: 'rift', known: false };
  assert.strictEqual(load({ ctx: unknown, hex: { isHex: true, queueId: 2400 } }).last().visible, true,
    '海斗异步识别完成时应显示');
  assert.strictEqual(load({ ctx: unknown, hex: { isHex: false, queueId: 450 } }).last().visible, true,
    '大乱斗队列号应显示');
  assert.strictEqual(load({ ctx: unknown, session: { benchChampions: [], queueId: 430, gameMode: 'CLASSIC' } }).last().visible, false,
    'session 明确是峡谷队列时不显示');

  // ---------- 4. 真正没有备战区字段的模式仍隐藏 ----------
  const noBench = load({ ctx: { queueId: 450, gameMode: 'KIWI', key: 'aram', known: true }, session: { myTeam: [] } });
  assert.strictEqual(noBench.last().visible, false, 'ARAM 但没有备战区字段也不显示');

  // ---------- 5. 主进程最终门禁：非 aram 一律拒绝 ----------
  const mainSrc = read('main/index.js');
  const handler = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('overlay:update'"),
    mainSrc.indexOf("ipcMain.handle('overlay:swap'"));
  assert.ok(/payloadMode === 'aram'/.test(handler), '主进程必须只认 aram 模式才开备战区窗');
  assert.ok(/const payloadMode = String\(p\.mode \|\| ''\)/.test(handler), '主进程要读渲染层推来的模式标记');
  assert.ok(lastPushesHaveMode(), '每次推送都要带模式标记，避免主进程把旧帧当成可显示');

  console.log('备战区浮窗模式门禁测试通过');
})().catch(e => { console.error(e); process.exitCode = 1; });

function lastPushesHaveMode() {
  return pushes.every(p => Object.prototype.hasOwnProperty.call(p, 'mode'));
}
