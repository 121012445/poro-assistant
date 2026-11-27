// 1.6.82: 配置损坏恢复路径断言 (persist.js)
// 运行: node test_store_recovery.js
//
// 背景: 主配置解析失败时, 旧实现把损坏原文写进 .bak(毁掉唯一恢复副本),
// 再走 localStorage 迁移写回只剩十几个老键的空配置 —— 用户设置被整体清空。
// 修复: 主文件坏了先读 .bak 恢复; 两者都坏则另存带时间戳的现场并冻结自动写入。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('renderer/js/persist.js', 'utf8');
const START = source.indexOf('let _store = {};');
const END = source.indexOf('// ========== 对局看板增强');
assert(START >= 0 && END > START, '未能截取持久化存储片段');
const slice = source.slice(START, END);

function makeCtx(files) {
  const writes = [];
  const ctx = {
    window: { _userDataPath: 'UD', addEventListener: () => {} },
    localStorage: { getItem: () => null },
    lolAPI: {
      readFile: async p => (p in files ? files[p] : null),
      writeFile: async (p, c) => { writes.push({ path: p, content: c }); return true; }
    },
    toolMsg: () => {},
    clearTimeout: () => {},
    setTimeout: () => 0
  };
  vm.createContext(ctx);
  vm.runInContext(slice, ctx);
  return { ctx, writes };
}

let fail = 0;
async function ok(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '  → ' + e.message); }
}

(async () => {
  await ok('parseStoreContent: 合法对象通过', () => {
    const { ctx } = makeCtx({});
    const r = vm.runInContext("parseStoreContent('{\"a\":\"1\"}')", ctx);
    assert.strictEqual(JSON.stringify(r), '{"a":"1"}');
  });
  await ok('parseStoreContent: 全 NUL / 数组 / 空串一律判坏', () => {
    const { ctx } = makeCtx({});
    for (const s of ['\u0000\u0000', '[1,2]', '', 'null', '{bad']) {
      assert.strictEqual(vm.runInContext('parseStoreContent(' + JSON.stringify(s) + ')', ctx), null, s);
    }
  });
  await ok('主文件完好时直接加载, 不写任何文件', async () => {
    const { ctx, writes } = makeCtx({ 'UD/poro-config.json': '{"autoAccept":"1","blacklist":"[]"}' });
    await vm.runInContext('loadStore()', ctx);
    assert.strictEqual(vm.runInContext("storeGet('autoAccept')", ctx), '1');
    assert.strictEqual(writes.length, 0);
  });
  await ok('主文件损坏时从 .bak 恢复, 不覆盖 .bak', async () => {
    const good = JSON.stringify({ autoAccept: '1', playerMarks: '{"abc":{"note":"保留"}}' });
    const { ctx, writes } = makeCtx({
      'UD/poro-config.json': '\u0000\u0000\u0000',
      'UD/poro-config.json.bak': good
    });
    await vm.runInContext('loadStore()', ctx);
    assert.strictEqual(vm.runInContext("storeGet('autoAccept')", ctx), '1');
    assert.strictEqual(vm.runInContext("storeGet('playerMarks')", ctx), '{"abc":{"note":"保留"}}');
    assert.strictEqual(writes.length, 0, '恢复后不应立刻写回, 损坏现场要留着');
  });
  await ok('主文件与 .bak 都坏时另存现场并冻结写入', async () => {
    const { ctx, writes } = makeCtx({
      'UD/poro-config.json': '\u0000\u0000\u0000',
      'UD/poro-config.json.bak': '\u0000\u0000\u0000'
    });
    await vm.runInContext('loadStore()', ctx);
    assert.strictEqual(vm.runInContext('_storeWriteFrozen', ctx), true);
    assert.strictEqual(writes.length, 1, '只应写一份带时间戳的现场');
    assert.ok(/^\.corrupt-/.test(writes[0].path.replace('UD/poro-config.json', '')), writes[0].path);
    assert.strictEqual(writes[0].content, '\u0000\u0000\u0000', '现场内容必须原样保留');
  });
  await ok('冻结后 storeSet 不写盘(空配置不覆盖现场)', async () => {
    const { ctx, writes } = makeCtx({ 'UD/poro-config.json': 'bad', 'UD/poro-config.json.bak': 'bad' });
    await vm.runInContext('loadStore()', ctx);
    writes.length = 0;
    vm.runInContext("storeSet('theme','dark')", ctx);
    assert.strictEqual(writes.length, 0, '冻结期间不得有任何写盘');
    assert.strictEqual(vm.runInContext("storeGet('theme')", ctx), 'dark', '内存里仍可改, 保证本次会话可用');
  });
  await ok('主文件不存在时走 localStorage 迁移', async () => {
    const { ctx } = makeCtx({});
    ctx.localStorage.getItem = k => (k === 'autoAccept' ? '1' : null);
    await vm.runInContext('loadStore()', ctx);
    assert.strictEqual(vm.runInContext("storeGet('autoAccept')", ctx), '1');
    assert.strictEqual(vm.runInContext('_storeWriteFrozen', ctx), false);
  });
  console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
  process.exit(fail ? 1 : 0);
})();
