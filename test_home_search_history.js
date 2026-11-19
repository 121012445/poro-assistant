'use strict';
// 1.6.27 回归: 首页 ID 搜索的「搜索记录」必须跨重启还在
//
// 事故背景: 这块原先注释写着「仅保存在当前进程内：退出程序后自动清空」,
// 结果用户每次重开程序, 下拉里的「最近查询」都是空的 —— 连着提过两次
// 「以前就要搜索记录，现在还是没有」。搜索记录的意义就是复用上次结果,
// 每次重开都清空等于没有这个功能。
//
// 这里守三件事:
//   1. rememberHomeSearch 必须落盘; homeSearchCardHtml 必须先 load ——
//      少任一头, 重启后记录就不可见。
//   2. 恢复时要能容错: 坏 JSON / 非字符串 / 空串 / 重复 (忽略大小写) / 超长,
//      一条脏数据不能把整个下拉打成空表。
//   3. 清空要真的清空并落盘, 否则下次打开又回来。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('renderer/js/home.js', 'utf8');

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('ok ' + pass + ' - ' + name); };

// 精确抠出 function name(...) { ... } 的函数体 (按大括号配对, 不靠缩进)
function grabFunction(name) {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at >= 0, 'home.js 里找不到函数: ' + name);
  let i = src.indexOf('{', at);
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  throw new Error('函数体不闭合: ' + name);
}

// 每个用例都给一份全新的沙箱, 模拟「一次程序启动」
function makeSandbox(storeInit) {
  const store = Object.assign({}, storeInit || {});
  const ctx = vm.createContext({
    console,
    JSON,
    document: { getElementById: () => ({ focus() {} }) },
    renderHomeSearchCards: () => {},
    storeGet: k => (store[k] === undefined ? null : store[k]),
    storeSet: (k, v) => { store[k] = String(v); }
  });
  const script = [
    'const HOME_SEARCH_HISTORY_LIMIT = 10;',
    "const HOME_SEARCH_HISTORY_STORE = 'homeSearchHistory.v1';",
    'let homeSearchHistory = [];',
    'let homeSearchHistoryLoaded = false;',
    grabFunction('loadHomeSearchHistory'),
    grabFunction('saveHomeSearchHistory'),
    grabFunction('clearHomeSearchHistory'),
    grabFunction('rememberHomeSearch'),
    // 供外部读写
    'this.getHistory = () => homeSearchHistory;'
  ].join('\n');
  vm.runInContext(script, ctx, { filename: 'home.search-history.js' });
  return { ctx, store, read: () => ctx.getHistory(), stored: () => (store['homeSearchHistory.v1'] === undefined ? null : store['homeSearchHistory.v1']) };
}

ok('没存过记录时恢复为空表, 不抛错', () => {
  const box = makeSandbox();
  const list = box.ctx.loadHomeSearchHistory();
  assert.deepStrictEqual(Array.from(list), [], '首次运行应为空');
  assert.strictEqual(box.stored(), null, '不该凭空写盘');
});

ok('查询一次就落盘, 记录能跨重启读回来', () => {
  const first = makeSandbox();
  first.ctx.rememberHomeSearch('星未眠#12345');
  assert.strictEqual(first.stored(), '["星未眠#12345"]', '应写入 store, 实际 ' + first.stored());
  // 模拟重启: 同一个 store 交给新沙箱
  const second = makeSandbox({ 'homeSearchHistory.v1': first.stored() });
  const list = Array.from(second.ctx.loadHomeSearchHistory());
  assert.deepStrictEqual(list, ['星未眠#12345'], '重启后应能看到上次查过的人');
});

ok('重复查询置顶而不是堆两条', () => {
  const box = makeSandbox({ 'homeSearchHistory.v1': '["A#1","B#2","C#3"]' });
  box.ctx.loadHomeSearchHistory();
  box.ctx.rememberHomeSearch('b#2');
  assert.deepStrictEqual(Array.from(box.read()), ['b#2', 'A#1', 'C#3'], '应去重并置顶');
  assert.ok(box.stored().indexOf('b#2') >= 0, '应已落盘');
});

ok('最多保留 10 条, 新的在前', () => {
  const box = makeSandbox();
  for (let i = 1; i <= 13; i++) box.ctx.rememberHomeSearch('玩家' + i + '#1');
  const list = Array.from(box.read());
  assert.strictEqual(list.length, 10, '上限应为 10, 实际 ' + list.length);
  assert.strictEqual(list[0], '玩家13#1', '最新一条应排最前');
  assert.strictEqual(list[9], '玩家4#1', '最老的应被挤掉');
});

ok('坏数据/脏数据只丢坏条目, 不把整张表清空', () => {
  const broken = makeSandbox({ 'homeSearchHistory.v1': 'not-json{' });
  assert.deepStrictEqual(Array.from(broken.ctx.loadHomeSearchHistory()), [], '坏 JSON 应降级为空表而不是抛错');

  const object = makeSandbox({ 'homeSearchHistory.v1': '{"a":1}' });
  assert.deepStrictEqual(Array.from(object.ctx.loadHomeSearchHistory()), [], '不是数组应降级为空表');

  const dirty = makeSandbox({ 'homeSearchHistory.v1': '[1,"  ","A#1",null,"a#1","  真名#2  "]' });
  const list = Array.from(dirty.ctx.loadHomeSearchHistory());
  assert.deepStrictEqual(list, ['A#1', '真名#2'], '应过滤非字符串/空串/大小写重复并 trim, 实际 ' + JSON.stringify(list));
});

ok('读取是幂等的, 不会每次重渲染都覆盖内存里的新记录', () => {
  const box = makeSandbox({ 'homeSearchHistory.v1': '["旧#1"]' });
  box.ctx.loadHomeSearchHistory();
  box.ctx.rememberHomeSearch('新#2');
  // 再读一次 (下拉每次展开都会调) 不该把刚加的记录读回旧值
  const again = Array.from(box.ctx.loadHomeSearchHistory());
  assert.deepStrictEqual(again, ['新#2', '旧#1'], '二次读取应保留内存中的最新顺序');
});

ok('清空会落盘, 下次打开不会复活', () => {
  const box = makeSandbox({ 'homeSearchHistory.v1': '["A#1","B#2"]' });
  box.ctx.loadHomeSearchHistory();
  box.ctx.clearHomeSearchHistory();
  assert.deepStrictEqual(Array.from(box.read()), [], '内存应清空');
  assert.strictEqual(box.stored(), '[]', '应把空表写进 store');
  const next = makeSandbox({ 'homeSearchHistory.v1': box.stored() });
  assert.deepStrictEqual(Array.from(next.ctx.loadHomeSearchHistory()), [], '重启后不该复活');
});

// ---------- 静态: 接线不能只做一半 ----------
ok('rememberHomeSearch 落盘, homeSearchCardHtml 先读', () => {
  const remember = grabFunction('rememberHomeSearch');
  assert.ok(/saveHomeSearchHistory\(\)/.test(remember), '记住一条后必须落盘');
  assert.ok(/loadHomeSearchHistory\(\)/.test(remember), '写入前要先加载, 否则会覆盖掉已存的记录');
  const card = grabFunction('homeSearchCardHtml');
  assert.ok(/loadHomeSearchHistory\(\)/.test(card), '下拉首次展开必须先加载, 否则重启后看不到记录');
});

ok('不再有"仅保存在当前进程内"的旧约定', () => {
  assert.ok(!/仅保存在当前进程内/.test(src), '旧注释仍在, 说明落盘没做完');
  assert.ok(/落盘到 poro-config\.json/.test(src), '应写明已落盘');
});

ok('空输入时搜索记录排在最上面, 不被候选压到最底', () => {
  const card = grabFunction('homeSearchCardHtml');
  const atHist = card.indexOf('if (!q) html += histHtml;');
  const atCands = card.indexOf('if (cands.length)');
  assert.ok(atHist > 0, '缺少"空输入把记录放前面"的分支');
  assert.ok(atCands > 0, '找不到候选分支');
  assert.ok(atHist < atCands, '记录块必须插在候选之前 —— 否则空输入时被几十条候选压到最底, 等于没有');
  assert.ok(/if \(q\) html \+= histHtml;/.test(card), '有输入时记录仍留在候选后面当补充');
});

ok('清空入口挂在最近查询标题行, 且不让输入框失焦', () => {
  assert.ok(/clearHomeSearchHistory\(\)/.test(src), '缺少清空入口');
  // mousedown + preventDefault: 失焦会让下拉在 120ms 后自动收起, 点下去像没反应
  const at = src.indexOf('hs-clear');
  assert.ok(at > 0, '缺少 .hs-clear 按钮');
  const snippet = src.slice(at, at + 260);
  assert.ok(/onmousedown="event\.preventDefault\(\)/.test(snippet), '清空按钮必须 preventDefault, 否则下拉先收起');
});

console.log('\nPASS ' + pass + ' cases');
