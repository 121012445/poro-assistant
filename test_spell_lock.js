// 召唤师技能锁定测试。LCU 没有"锁定"接口, 只能靠比对 + PATCH 纠正,
// 所以这里守的是: 组合校验、顺序敏感(闪现在 D 还是 F)、无效值不写、写入只在必要时发生。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'renderer/js/spell-lock.js');
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); n++; };

// --- 最小沙箱: 用内存 map 模拟 storeGet/storeSet ---
function make(store) {
  const sandbox = {
    console,
    window: {},
    Date,
    storeGet: k => (store[k] !== undefined ? store[k] : null),
    storeSet: (k, v) => { store[k] = String(v); },
    showToast: () => {},
    allSpells: {
      SummonerFlash: { key: '4', name: '闪现' },
      SummonerDot: { key: '14', name: '引燃' },
      SummonerSmite: { key: '11', name: '惩戒' }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);
  return sandbox.window.PoroSpellLock;
}

// ---- 1. 目标组合校验 ----
{
  const s = {}; const M = make(s);
  s.spellLockIds = '[4,14]'; s.spellLockOn = '1';
  eq(M.enabled(), true, '有效组合 + 开关 = 启用');
  eq(JSON.stringify(M.target()), '[4,14]', 'target 原样返回顺序');
  s.spellLockOn = '0';
  eq(M.enabled(), false, '开关关掉就不启用');
  s.spellLockOn = '1';
  for (const bad of ['[4,4]', '[0,14]', '[4,0]', '["4","abc"]', '[]', 'garbage']) {
    s.spellLockIds = bad;
    eq(M.target(), null, '无效组合 ' + bad + ' 被拒绝');
    eq(M.enabled(), false, '无效组合 ' + bad + ' 不启用');
  }
  // 对象形式 (直接从备份导入时可能是 {ids:[...]})
  s.spellLockIds = JSON.stringify({ ids: [4, 14] });
  eq(JSON.stringify(M.target()), '[4,14]', '兼容 {ids:[...]} 形式');
}

// ---- 2. 顺序敏感: 闪现在 D 和闪现在 F 是两套组合 ----
{
  const M = make({ spellLockIds: '[4,14]', spellLockOn: '1' });
  eq(M.matches({ spell1Id: 4, spell2Id: 14 }, [4, 14]), true, '完全一致');
  eq(M.matches({ spell1Id: 14, spell2Id: 4 }, [4, 14]), false, '位置互换算不一致');
  eq(M.matches({ spell1Id: 4, spell2Id: 4 }, [4, 14]), false, '两个相同不算一致');
  eq(M.matches({ __error: 'not in champ select' }, [4, 14]), false, 'LCU 报错不算一致');
  eq(M.matches({ httpStatus: 404, message: 'No active delegate' }, [4, 14]), false, '404 不算一致 (由 enforceOnce 短路)');
  eq(M.matches(null, [4, 14]), false, '空响应不算一致');
  // 字符串 id 也算 (LCU 有时回字符串)
  eq(M.matches({ spell1Id: '4', spell2Id: '14' }, [4, 14]), true, '字符串 id 能正确比对');
}

// ---- 3. enforceOnce: 一致不写, 不一致才 PATCH 目标值 ----
(async () => {
  const M = make({ spellLockIds: '[4,14]', spellLockOn: '1' });
  let getCalls = 0, patches = [];
  let cur = { spell1Id: 4, spell2Id: 14 };
  let r = await M.enforceOnce(
    async () => { getCalls++; return cur; },
    async body => { patches.push(body); return { ok: true }; }
  );
  eq(r.unchanged, true, '一致时标记 unchanged');
  eq(patches.length, 0, '一致时不发 PATCH');
  eq(getCalls, 1, '一致时读了一次');

  cur = { spell1Id: 14, spell2Id: 4 }; // 被人换了位置
  r = await M.enforceOnce(
    async () => cur,
    async body => { patches.push(body); return { ok: true }; }
  );
  eq(r.changed, true, '不一致时标记 changed');
  eq(JSON.stringify(patches[0]), '{"spell1Id":4,"spell2Id":14}', 'PATCH 写回的是锁定值');

  // 不在选人阶段: 404 必须短路, 绝不 PATCH
  const before = patches.length;
  r = await M.enforceOnce(
    async () => ({ httpStatus: 404, message: 'No active delegate' }),
    async body => { patches.push(body); return { ok: true }; }
  );
  eq(r.skipped, true, '404 被跳过');
  eq(r.reason, 'no-champ-select', '跳过原因正确');
  eq(patches.length, before, '404 时不发 PATCH');
})().catch(e => { console.error(e); process.exitCode = 1; });

// ---- 4. set: 拒绝非法组合且不破坏已有配置 ----
{
  const s = { spellLockIds: '[4,14]', spellLockOn: '1' }; const M = make(s);
  let r = M.set(true, '4', '4');
  eq(r.ok, false, '两个相同 id 被拒绝');
  eq(s.spellLockIds, '[4,14]', '拒绝时不覆盖原配置');
  r = M.set(false, '4', '14');
  eq(r.ok, true, '关闭成功');
  eq(s.spellLockOn, '', '关闭写入空值');
  eq(JSON.stringify(M.target()), '[4,14]', '关闭不删组合');
  r = M.set(true, '11', '4');
  eq(JSON.stringify(M.target()), '[11,4]', '重新开启按新组合');
}

// ---- 5. spellOptions 只列数字 id, 按 id 升序 ----
{
  const sandbox = {
    console, window: {}, Date, storeGet: () => null, storeSet: () => {}, showToast: () => {},
    allSpells: {
      Bad: { key: 'abc', name: '坏数据' },
      C: { key: '14', name: '引燃' },
      A: { key: '4', name: '闪现' },
      NoName: { key: '11' }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);
  const opts = sandbox.window.PoroSpellLock.spellOptions();
  eq(opts.length, 2, '过滤掉非数字 id 和无名字的');
  eq(JSON.stringify(opts.map(x => x.id)), '[4,14]', '按 id 升序');
}

// ---- 6. 接线检查: 避免只写了模块却没接上 ----
{
  const idx = fs.readFileSync(path.join(__dirname, 'renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, 'renderer/js/app.js'), 'utf8');
  const bench = fs.readFileSync(path.join(__dirname, 'renderer/js/bench.js'), 'utf8');
  const opgg = fs.readFileSync(path.join(__dirname, 'renderer/js/opgg-loadout.js'), 'utf8');
  const persist = fs.readFileSync(path.join(__dirname, 'renderer/js/persist.js'), 'utf8');
  ok(idx.includes('js/spell-lock.js'), '模块已引入页面');
  ok(idx.includes('id="spellLockBox"'), '工具箱卡片已加');
  // 用户要求: 合进「锁定游戏设置」卡片, 不能是独立卡片
  const lockCard = idx.slice(idx.indexOf('<h3>锁定游戏设置</h3>'), idx.indexOf('<h3>', idx.indexOf('<h3>锁定游戏设置</h3>') + 5));
  ok(lockCard.includes('id="spellLockBox"'), '技能锁定嵌在「锁定游戏设置」卡片内');
  ok(!/<h3>召唤师技能锁定<\/h3>/.test(idx), '不再是独立卡片标题');
  ok(app.includes('function toggleSpellLock') && app.includes('function saveSpellLock'), '入口函数已接线');
  ok(app.includes('PoroSpellLock.html()'), '打开工具箱会渲染卡片');
  ok(bench.includes('PoroSpellLock.enabled()'), '选人事件里会校验');
  ok(opgg.includes('spellLocked') && opgg.includes('!spellLocked'), 'OP.GG 技能写入与锁定互斥');
  ok(persist.includes('spellLockOn') && persist.includes('spellLockIds'), '设置已持久化');
}

console.log('召唤师技能锁定: ' + n + ' 组断言全部通过');
