'use strict';
// 聊天弹幕浮窗 (renderer/js/game-translate.js) 行为门禁。
// 1.5.35 起浮窗带输入模式 (F10 呼出, 回车翻译发送): 这里锁住
//   · 弹幕渲染: 自己的消息标色 / 原文小字 / HTML 转义
//   · 16 秒后变暗保留 (10 条上限), 输入模式期间冻结且可滚轮回看
//   · 输入模式: 目标语言生效 / Enter 发送 / Esc 取消 / 失败时保留原文报错
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, 'renderer/js/game-translate.js'), 'utf8');

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function makeEnv(opts = {}) {
  const clock = { t: 1700000000000 };
  const calls = { send: [], exit: 0, focused: 0, blurred: 0 };
  const dataCbs = [];
  const inputCbs = [];
  const intervalFns = [];

  function makeEl() {
    const el = {
      textContent: '', _html: '', value: '', disabled: false,
      _classes: new Set(),
      children: [], _parent: null,
      classList: {
        toggle(c, on) { on ? el._classes.add(c) : el._classes.delete(c); },
        add(c) { el._classes.add(c); },
        remove(c) { el._classes.delete(c); },
        contains(c) { return el._classes.has(c); }
      },
      handlers: {},
      addEventListener(ev, fn) { el.handlers[ev] = fn; },
      focus() { calls.focused++; },
      blur() { calls.blurred++; },
      appendChild(c) { c._parent = el; el.children.push(c); },
      remove() {
        if (el._parent) {
          const i = el._parent.children.indexOf(el);
          if (i >= 0) el._parent.children.splice(i, 1);
        }
        el._parent = null;
      }
    };
    Object.defineProperty(el, 'innerHTML', {
      configurable: true,
      get() { return el._html; },
      set(v) { el._html = String(v); }
    });
    Object.defineProperty(el, 'textContent', {
      configurable: true,
      get() { return el._t == null ? '' : el._t; },
      set(v) { el._t = String(v == null ? '' : v); }
    });
    return el;
  }

  // 增量渲染后内容在子节点里


  const els = {
    gtWrap: makeEl(), gtLines: makeEl(), gtHint: makeEl(), gtDrag: makeEl(),
    gtInputRow: makeEl(), gtInput: makeEl(), gtSend: makeEl(), gtErr: makeEl()
  };

  const lolAPI = {
    onGameTranslateData: cb => dataCbs.push(cb),
    onGameTranslateInput: cb => inputCbs.push(cb),
    gameTranslateSend: async (text, target) => {
      calls.send.push({ text, target });
      return opts.sendResult ? opts.sendResult(text) : { ok: true, translated: 'EN:' + text };
    },
    gameTranslateExitInput: () => { calls.exit++; return true; },
    gameTranslateResetPos: () => { calls.reset = (calls.reset || 0) + 1; return true; }
  };

  const winListeners = [];   // 捕获 window.addEventListener 注册 (前台聚焦兜底)
  const ctx = {
    console,
    Date: { now: () => clock.t },
    setInterval: fn => { intervalFns.push(fn); return intervalFns.length; },
    clearInterval: () => {},
    lolAPI,
    document: {
      getElementById: id => els[id] || null,
      createElement: () => {
        const el = makeEl();
        Object.defineProperty(el, 'innerHTML', {
          configurable: true,
          get() { return el._html || escHtml(el._t || ''); },
          set(v) { el._html = String(v); }
        });
        return el;
      }
    },
    window: {
      lolAPI,
      // 真实 window 有 addEventListener (输入浮窗用它在前台激活后补聚焦输入框)
      addEventListener: (type, fn) => { winListeners.push({ type, fn }); },
      listeners: winListeners
    }
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);

  const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve().then(() => {}); };
  return { ctx, els, calls, clock, dataCbs, inputCbs, intervalFns, flush };
}

// 增量渲染后内容在子节点里 (模块级, 供各用例读取)
const renderedText = e => e.els.gtLines.children.map(c => c.innerHTML).join('§');

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail !== undefined ? ' | ' + JSON.stringify(detail) : '')); }
}

(async () => {
  console.log('— 弹幕渲染 (增量) —');
  {
    const e = makeEnv();
    e.dataCbs[0]({ lines: [
      { name: '我（已发送）', body: '打野来抓我', translated: 'jungle is coming for me', ts: e.clock.t },
      { name: 'Teemo', body: 'top diff', translated: '上路差距', ts: e.clock.t }
    ] });
    const html = renderedText(e);
    ok(html.includes('jungle is coming for me'), '译文正常渲染', html);
    ok(e.els.gtLines.children.some(c => c._classes.has('gt-self')), '自己的消息带 gt-self 标记');
    ok(html.includes('top diff'), '原文以小字保留', html);
    ok(html.includes('上路差距'), '他人译文渲染', html);
    e.dataCbs[0]({ lines: [{ name: '<b>x</b>', body: '', translated: '<img onerror=1>', ts: e.clock.t }] });
    const html2 = renderedText(e);
    ok(!html2.includes('<img') && html2.includes('&lt;img'), '弹幕内容经过 HTML 转义', html2);
  }

  console.log('— 防闪烁: 重复渲染不得重建节点 —');
  {
    const e = makeEnv();
    e.dataCbs[0]({ lines: [{ name: 'A', body: '', translated: 'hello', ts: e.clock.t }] });
    const first = e.els.gtLines.children[0];
    e.dataCbs[0]({ lines: [{ name: 'A', body: '', translated: 'hello', ts: e.clock.t }] });
    e.intervalFns.forEach(fn => fn());
    e.dataCbs[0]({ lines: [{ name: 'A', body: '', translated: 'hello', ts: e.clock.t }] });
    e.intervalFns.forEach(fn => fn());
    ok(e.els.gtLines.children[0] === first, '同一条消息重复推送时 DOM 节点保持不变');
    ok(e.els.gtLines.children.length === 1, '节点没有成倍增加');
  }

  console.log('— 同一条消息读到更完整的版本: 原地换字, 不新增行 —');
  {
    // OCR 每 4 秒重读聊天框, 同一句会读出不同版本 ("h eryone" / "hello everyone")。
    // 后端用稳定键 k 标记"这是同一条消息", 浮窗必须原地更新而不是多出一行。
    const e = makeEnv();
    const line = { name: '聊天', body: 'h eryone', translated: '大家好', ts: e.clock.t, k: '队伍|02:38' };
    e.dataCbs[0]({ lines: [line] });
    const first = e.els.gtLines.children[0];
    ok(renderedText(e).includes('h eryone'), '先渲染残缺版', renderedText(e));
    // 关键: 重新翻译后译文也可能变 (旧实现按"时间戳+正文+译文"做键, 一变就当成新行)
    e.dataCbs[0]({ lines: [Object.assign({}, line, { body: 'hello everyone', translated: '大家好呀' })] });
    ok(e.els.gtLines.children.length === 1, '仍然只有一行', e.els.gtLines.children.length);
    ok(e.els.gtLines.children[0] === first, '复用同一个 DOM 节点 (不跳位、不重播入场动画)');
    ok(renderedText(e).includes('hello everyone'), '文字原地换成完整版', renderedText(e));
    ok(renderedText(e).includes('大家好呀'), '译文也原地换掉', renderedText(e));
    ok(!renderedText(e).includes('h eryone'), '旧正文已被替换', renderedText(e));
  }

  console.log('— 16 秒变暗保留 (历史) + 输入模式冻结 —');
  {
    const e = makeEnv();
    e.dataCbs[0]({ lines: [{ name: 'A', body: '', translated: 'hello', ts: e.clock.t }] });
    ok(renderedText(e).includes('hello'), '新行在列表里');
    e.clock.t += 15500;
    e.intervalFns.forEach(fn => fn());
    ok(e.els.gtLines.children[0]._classes.has('gt-old'), '接近过期先加变暗类');
    e.clock.t += 2500;
    e.intervalFns.forEach(fn => fn());
    ok(e.els.gtLines.children.length === 1 && renderedText(e).includes('hello'),
      '过期后行保留 (变暗不删除, 1.5.39 历史)');
    // 超出上限: 最老的被挤掉
    const many = [];
    for (let i = 0; i < 12; i++) many.push({ name: 'P' + i, body: '', translated: 'msg' + String(i).padStart(2, '0'), ts: e.clock.t + i });
    e.dataCbs[0]({ lines: many });
    ok(e.els.gtLines.children.length === 10, '最多保留 10 条历史', e.els.gtLines.children.length);
    ok(!renderedText(e).includes('msg00') && !renderedText(e).includes('msg01'), '最老的先被挤掉');
    ok(renderedText(e).includes('msg11'), '最新的一条在');
    // 输入模式期间不清理
    e.inputCbs[0]({ on: true, target: 'en' });
    e.dataCbs[0]({ lines: many.concat([{ name: 'B', body: '', translated: 'nice', ts: e.clock.t + 99 }]) });
    e.clock.t += 17000;
    e.intervalFns.forEach(fn => fn());
    ok(renderedText(e).includes('nice'), '输入模式期间冻结淡出');
  }

  console.log('— 拖动条复位 —');
  {
    const e = makeEnv();
    ok(typeof e.els.gtDrag.handlers.dblclick === 'function', '拖动条挂了双击事件');
    e.els.gtDrag.handlers.dblclick();
    ok(e.calls.reset === 1, '双击调用复位', e.calls);
  }

  console.log('— 输入模式与发送 —');
  {
    const e = makeEnv();
    e.inputCbs[0]({ on: true, target: 'ja' });
    ok(e.els.gtInputRow._classes.has('gt-active'), '输入条进入高亮态');
    ok(e.calls.focused >= 1, '输入框获得焦点');
    e.els.gtInput.value = '打野来抓我';
    await e.els.gtInput.handlers.keydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
    await e.flush();
    ok(e.calls.send.length === 1 && e.calls.send[0].target === 'ja', 'Enter 触发发送且带上目标语言', e.calls.send);
    ok(e.calls.send[0].text === '打野来抓我', '发送的是原文');
    ok(e.els.gtInput.value === '', '发送成功后清空输入框');
    ok(renderedText(e).includes('EN:打野来抓我'), '本地补一条已发送确认');
    // Esc 取消
    await e.els.gtInput.handlers.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    ok(e.calls.exit === 1, 'Esc 调用退出输入模式');
  }

  console.log('— 发送失败与空内容 —');
  {
    const e = makeEnv({ sendResult: () => ({ ok: false, error: '翻译失败' }) });
    e.inputCbs[0]({ on: true, target: 'en' });
    e.els.gtInput.value = '帮我一下';
    await e.els.gtInput.handlers.keydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
    await e.flush();
    ok(e.els.gtErr.textContent === '翻译失败', '失败原因显示在输入条下方', e.els.gtErr.textContent);
    ok(e.els.gtInput.value === '帮我一下', '失败时保留原文不让用户重打');
    // 空内容不触发
    e.els.gtInput.value = '   ';
    await e.els.gtInput.handlers.keydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
    await e.flush();
    ok(e.calls.send.length === 1, '空白输入不触发发送');
  }

  console.log('— 前台激活后补聚焦 (呼出即打字) —');
  {
    const e = makeEnv();
    const winFns = e.ctx.window.listeners.filter(l => l.type === 'focus');
    ok(winFns.length === 1, '注册了 window focus 监听', e.ctx.window.listeners.map(l => l.type));
    // 未进输入模式时, 拿到前台不抢输入框焦点
    const before = e.calls.focused;
    winFns[0].fn();
    ok(e.calls.focused === before, '非输入模式时不聚焦输入框');
    // 输入模式下拿到前台 → 立即补聚焦 (OS 激活与 IPC 时序竞争的兜底)
    e.inputCbs[0]({ on: true, target: 'en' });
    const afterInput = e.calls.focused;
    winFns[0].fn();
    ok(e.calls.focused > afterInput, '输入模式下 window focus 触发输入框补聚焦');
  }

  console.log(`\n${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
