'use strict';
// renderer/js/chat-status.js: 在线状态 / 个性签名 / 锁定状态。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const src = read('renderer/js/chat-status.js');

function makeEnv(o = {}) {
  const calls = [], msgs = [], store = Object.assign({}, o.store || {});
  const els = { chatAvailability: { value: o.selected || 'chat', options: [{}], innerHTML: '' }, chatLockToggle: { checked: false }, chatStatusMessage: { value: o.message || '', maxLength: 0 } };
  let me = { availability: 'chat' };
  const ctx = vm.createContext({
    console, Date, Math, Number, String, Promise, JSON, Object, Array,
    document: { getElementById: id => els[id] || null },
    complianceOn: !!o.compliance,
    guardWrite: () => !o.compliance, guardAutomation: () => !o.compliance,
    storeGet: k => (k in store ? store[k] : null), storeSet: (k, v) => { store[k] = v; },
    toolMsg: h => msgs.push(String(h)),
    escapeHtml: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    lolAPI: {
      lcuRequest: async (method, url, body) => {
        calls.push({ method, url, body });
        if (o.fail && method === 'PUT') return { __error: 'HTTP 400', message: '签名过长' };
        if (method === 'GET') return o.getMe ? o.getMe() : me;
        if (method === 'PUT' && body && body.availability) me = Object.assign({}, me, { availability: body.availability });
        return me;
      }
    }
  });
  vm.runInContext(src, ctx, { filename: 'chat-status.js' });
  return { ctx, calls, msgs, store, els, setMe: v => { me = v; }, run: c => vm.runInContext(c, ctx) };
}
const puts = calls => calls.filter(c => c.method === 'PUT');

(async () => {
  // ---------- 清洗 ----------
  {
    const { ctx, run } = makeEnv();
    assert.strictEqual(ctx.sanitizeStatusMessage('  你好  '), '你好');
    assert.strictEqual(ctx.sanitizeStatusMessage('a\nb\tc\u0000d'), 'a b c d', '控制字符换成空格');
    assert.strictEqual(ctx.sanitizeStatusMessage('今天   上分\n\n\n加油'), '今天 上分 加油', '连续空白折叠成一个');
    assert.strictEqual(ctx.sanitizeStatusMessage('x'.repeat(500)).length, 250, '限长');
    assert.strictEqual(ctx.sanitizeStatusMessage(null), '');
    assert.strictEqual(ctx.sanitizeStatusMessage(undefined), '');
    assert.strictEqual(ctx.chatStatusKnown('offline'), true);
    assert.strictEqual(ctx.chatStatusKnown('online'), false, 'online 由客户端自己设置, 不提供手选');
    assert.strictEqual(ctx.chatStatusKnown('spectating'), false);
    assert.strictEqual(ctx.chatStatusKnown('../x'), false);
    assert.deepStrictEqual(JSON.parse(run('JSON.stringify(CHAT_AVAILABILITY.map(x => x.value))')), ['chat', 'mobile', 'away', 'dnd', 'offline']);
  }

  // ---------- 修改在线状态: 只发 availability ----------
  {
    const { ctx, calls, run } = makeEnv();
    assert.strictEqual(await ctx.setChatAvailability('offline'), true);
    const p = puts(calls);
    assert.strictEqual(p.length, 1);
    assert.strictEqual(p[0].url, '/lol-chat/v1/me');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p[0].body)), { availability: 'offline' }, '只传要改的字段, 不带其他字段以免覆盖');
    assert.strictEqual(await ctx.setChatAvailability('not-a-status'), false);
    assert.strictEqual(puts(calls).length, 1, '非法状态不发请求');
  }
  {   // 合规模式: 不写
    const { ctx, calls, run } = makeEnv({ compliance: true });
    assert.strictEqual(await ctx.setChatAvailability('offline'), false);
    assert.strictEqual(await ctx.applyChatStatusMessage(), false);
    assert.strictEqual(calls.length, 0);
  }
  {   // 失败: 提示原因, 下拉框还原
    const { ctx, msgs, els, run } = makeEnv({ fail: true });
    run("_chatShownValue = 'chat'");
    els.chatAvailability.value = 'offline';
    ctx.onChatAvailabilityChange(els.chatAvailability);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    assert.ok(msgs.some(m => m.includes('修改失败') && m.includes('签名过长')));
    assert.strictEqual(els.chatAvailability.value, 'chat', '失败后下拉框要还原成当前真实状态');
  }
  {   // 成功: 下拉框保留, 且更新锁定值
    const { ctx, els, store, run } = makeEnv();
    run("_chatLock = { on: true, value: 'chat' }");
    els.chatAvailability.value = 'away';
    ctx.onChatAvailabilityChange(els.chatAvailability);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    assert.strictEqual(els.chatAvailability.value, 'away');
    assert.strictEqual(store.chatLockValue, 'away', '锁定开着时, 手动改状态要同步锁定值, 否则会被改回去');
  }

  // ---------- 个性签名 ----------
  {
    const { ctx, calls, store, msgs, run } = makeEnv({ message: '  今天  \n  上分  ' });
    assert.strictEqual(await ctx.applyChatStatusMessage(), true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(puts(calls)[0].body)), { statusMessage: '今天 上分' }, '清洗后发送, 且只传 statusMessage');
    assert.strictEqual(store.chatStatusMessage, '今天 上分', '记住上次的签名');
    assert.ok(msgs[0].includes('已更新'));
    const e = makeEnv({ message: '   ' });
    assert.strictEqual(await e.ctx.applyChatStatusMessage(), true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(puts(e.calls)[0].body)), { statusMessage: '' });
    assert.ok(e.msgs[0].includes('已清空'));
    const f = makeEnv({ fail: true, message: 'x' });
    assert.strictEqual(await f.ctx.applyChatStatusMessage(), false);
    assert.strictEqual(f.store.chatStatusMessage, undefined, '失败时不记住');
  }

  // ---------- 锁定 ----------
  {
    const { ctx, calls, store, els, run } = makeEnv({ selected: 'offline' });
    ctx.toggleChatLock(true);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    assert.strictEqual(store.chatLock, '1');
    assert.strictEqual(store.chatLockValue, 'offline');
    assert.deepStrictEqual(puts(calls).map(c => c.body.availability), ['offline'], '锁定时立即改成锁定值 (当前是 chat)');
    // 状态一致时不再写
    const n = puts(calls).length;
    run('_chatLockLastApplyAt = 0');
    await ctx.chatLockEnforce();
    assert.strictEqual(puts(calls).length, n, '状态已是锁定值就不写');
  }
  {   // 被客户端改回去 → 改回来; 限速; 并发保护
    const env = makeEnv();
    const { ctx, calls, setMe, run } = env;
    run("_chatLock = { on: true, value: 'offline' }; _chatLockLastApplyAt = 0");
    setMe({ availability: 'chat' });
    assert.strictEqual(await ctx.chatLockEnforce(), true);
    assert.strictEqual(puts(calls).length, 1);
    setMe({ availability: 'chat' });                       // 马上又被改回
    assert.strictEqual(await ctx.chatLockEnforce(), false, '15 秒内不重复写');
    assert.strictEqual(puts(calls).length, 1);
    run('_chatLockLastApplyAt = Date.now() - 16000');
    const results = await Promise.all([ctx.chatLockEnforce(), ctx.chatLockEnforce(), ctx.chatLockEnforce()]);
    assert.strictEqual(puts(calls).length, 2, '并发只改一次');
    assert.strictEqual(results.filter(Boolean).length, 1);
  }
  {   // 未锁定 / 合规 / 读不到状态: 不动
    const a = makeEnv(); a.run("_chatLock = { on: false, value: 'offline' }");
    assert.strictEqual(await a.ctx.chatLockEnforce(), false);
    assert.strictEqual(a.calls.length, 0);
    const b = makeEnv({ compliance: true }); b.run("_chatLock = { on: true, value: 'offline' }");
    assert.strictEqual(await b.ctx.chatLockEnforce(), false);
    assert.strictEqual(b.calls.length, 0, '合规模式下不读也不写');
    const c = makeEnv({ getMe: () => ({ __error: 'HTTP 500' }) }); c.run("_chatLock = { on: true, value: 'offline' }");
    assert.strictEqual(await c.ctx.chatLockEnforce(), false);
    assert.strictEqual(puts(c.calls).length, 0, '读不到当前状态时不盲写');
    const d = makeEnv(); d.run("_chatLock = { on: true, value: 'hacked' }");
    assert.strictEqual(await d.ctx.chatLockEnforce(), false, '锁定值被篡改成非法值时不写');
  }
  {   // 合规模式下不能开启锁定
    const { ctx, store, els, run } = makeEnv({ compliance: true });
    ctx.toggleChatLock(true);
    assert.notStrictEqual(store.chatLock, '1');
    assert.strictEqual(els.chatLockToggle.checked, false);
  }

  // ---------- 启动恢复 ----------
  {
    const { ctx, els, run } = makeEnv({ store: { chatLock: '1', chatLockValue: 'offline', chatStatusMessage: '我的签名' } });
    els.chatAvailability.options = [];
    ctx.chatStatusLoad();
    assert.strictEqual(els.chatAvailability.innerHTML.match(/<option/g).length, 5, '填充 5 个状态选项');
    assert.strictEqual(els.chatAvailability.value, 'offline');
    assert.strictEqual(els.chatLockToggle.checked, true);
    assert.strictEqual(els.chatStatusMessage.value, '我的签名');
    assert.strictEqual(els.chatStatusMessage.maxLength, 250);
    const bad = makeEnv({ store: { chatLock: '1', chatLockValue: 'bogus' } });
    bad.ctx.chatStatusLoad();
    assert.strictEqual(bad.run('_chatLock.on'), false, '存储的锁定值非法时不启用');
    const cp = makeEnv({ compliance: true, store: { chatLock: '1', chatLockValue: 'offline' } });
    cp.ctx.chatStatusLoad();
    assert.strictEqual(cp.els.chatLockToggle.checked, false, '合规模式下启动恢复也不勾选');
  }

  // ---------- 接线 ----------
  const html = read('renderer/index.html');
  for (const id of ['chatAvailability', 'chatLockToggle', 'chatStatusMessage']) assert.ok(html.includes(`id="${id}"`), '缺少 ' + id);
  assert.ok(html.includes('onchange="onChatAvailabilityChange(this)"') && html.includes('onchange="toggleChatLock(this.checked)"') && html.includes('onclick="applyChatStatusMessage()"'));
  assert.ok([...html.matchAll(/<script src="js\/([^"?]+)/g)].some(m => m[1] === 'chat-status.js'));
  assert.ok(read('renderer/js/app.js').includes('chatStatusLoad();'));
  const ev = read('renderer/js/lcu-events.js');
  assert.ok(ev.includes('chatLockEnforce()') && ev.includes('phase !== previousPhase'), '阶段变化后应检查锁定状态');
  assert.ok(/'\/lol-chat'/.test(read('main/index.js')), '/lol-chat 必须在白名单内');

  console.log('在线状态 / 个性签名 / 锁定测试通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
