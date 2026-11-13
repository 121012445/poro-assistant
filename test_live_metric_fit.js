'use strict';
// 1.5.137 回归: 实时页在后台 (display:none) 渲染时 fitLiveMetricRows 曾把所有队内指标
// 标签当成"放不下"整排搬进隐藏容器, 用户切回页面就只剩一个「+N」——「标签全部隐藏」。
// 守卫: 不在文档流里的行 (rect 宽高全 0) 跳过测量; switchPage('live') 切回时补一次对齐。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const liveSrc = fs.readFileSync('renderer/js/live.js', 'utf8');
const appSrc = fs.readFileSync('renderer/js/app.js', 'utf8');

// ---------- 最小 DOM: 只够 fitLiveMetricRows 用; 胶囊 rect 按行内流位置动态算 ----------
const PILL_W = 80, PILL_STEP = 90, MORE_W = 30, LINE_RIGHT = 300;
// 与真实 DOM 一致: insertBefore 会把节点从原父容器摘出再挂到新位置
function detach(el) {
  if (el.__parent) {
    const arr = el.__parent.children;
    const i = arr.indexOf(el);
    if (i >= 0) arr.splice(i, 1);
  }
  el.__parent = null;
}
function makeLine({ hidden, flowCount, extraCount }) {
  const state = { line: null, extras: null };
  const flowRect = el => {
    if (hidden) return { left: 0, right: 0, width: 0, top: 0, height: 0 };
    const flow = state.line.children.filter(c => c.__flow);
    const i = flow.indexOf(el);
    return { left: 0, right: (i + 1) * PILL_STEP, width: PILL_W, top: 0, height: 17 };
  };
  const pill = label => ({ label, __flow: true, getBoundingClientRect() { return flowRect(this); } });
  const pills = Array.from({ length: flowCount }, (_, i) => pill('p' + i));
  const more = {
    __flow: true, offsetWidth: MORE_W, hidden: false, textContent: '+' + extraCount,
    dataset: { count: String(extraCount) },
    getBoundingClientRect() { return hidden ? { right: 0, width: 0 } : { right: LINE_RIGHT, width: MORE_W }; },
  };
  const extras = {
    __flow: false, children: Array.from({ length: extraCount }, (_, i) => pill('x' + i)),
  };
  Object.defineProperty(extras, 'firstElementChild', { get() { return this.children[0] || null; } });
  Object.defineProperty(extras, 'firstChild', { get() { return this.children[0] || null; } });
  extras.removeChild = el => { const i = extras.children.indexOf(el); if (i >= 0) extras.children.splice(i, 1); el.__parent = null; return el; };
  extras.insertBefore = (el, ref) => {
    detach(el);
    const i = ref ? extras.children.indexOf(ref) : -1;
    if (i < 0) extras.children.push(el); else extras.children.splice(i, 0, el);
    el.__parent = extras;
    return el;
  };
  const line = {
    children: [...pills, more, extras],
    querySelector: sel => sel === '.lp-tags-more' ? more : sel === '.lp-extra-metrics' ? extras : null,
    insertBefore(el, ref) {
      detach(el);
      const i = ref ? this.children.indexOf(ref) : this.children.length;
      this.children.splice(i < 0 ? this.children.length : i, 0, el);
      el.__parent = this;
      return el;
    },
    removeChild(el) { const i = this.children.indexOf(el); if (i >= 0) this.children.splice(i, 1); el.__parent = null; return el; },
    getBoundingClientRect: () => hidden ? { left: 0, right: 0, width: 0, top: 0, height: 0 } : { left: 0, right: LINE_RIGHT, width: LINE_RIGHT, top: 0, height: 17 },
  };
  state.line = line; state.extras = extras;
  line.children.forEach(c => { c.__parent = line; });
  extras.children.forEach(c => { c.__parent = extras; });
  return { line, pills, more, extras };
}

const context = vm.createContext({
  console,
  document: { querySelectorAll: () => [] },
  window: {},
});
vm.runInContext(liveSrc, context, { filename: 'renderer/js/live.js' });

(() => {
  // ---------- ① 隐藏态: rect 全 0, 必须整体跳过, 一枚标签都不能被搬走 ----------
  const h = makeLine({ hidden: true, flowCount: 3, extraCount: 4 });
  context.document.querySelectorAll = () => [h.line];
  context.fitLiveMetricRows();
  assert.strictEqual(h.extras.children.length, 4, '隐藏态下不得把可见标签搬进浮层容器');
  assert.strictEqual(h.more.textContent, '+4', '隐藏态下不得改写 +N 计数');
  assert.strictEqual(h.more.hidden, false, '隐藏态下不得隐藏 +N 入口');

  // ---------- ② 可见态 + 全部放得下: 不动任何标签 ----------
  // limit = 300 - 30(按钮) - 6 = 264; 三枚胶囊 right = 90/180/270?
  // 这里用 2 枚让布局确实放得下: right = 90/180, 均 <= 264
  const fit = makeLine({ hidden: false, flowCount: 2, extraCount: 4 });
  context.document.querySelectorAll = () => [fit.line];
  context.fitLiveMetricRows();
  assert.strictEqual(fit.extras.children.length, 4, '放得下时不得搬运标签 (含浮层原有项不回吐)');
  assert.strictEqual(fit.more.textContent, '+4', '计数保持不变');

  // ---------- ③ 可见态 + 溢出: 只搬放不下的那枚, 计数同步 +1 ----------
  // 三枚胶囊 right = 90/180/270, 最后一枚 270 > 264 → 搬进浮层;
  // 搬回尝试时它落在第 4 个流位置 right 仍 270 > 264 → 不回吐
  const over = makeLine({ hidden: false, flowCount: 3, extraCount: 4 });
  context.document.querySelectorAll = () => [over.line];
  context.fitLiveMetricRows();
  assert.strictEqual(over.extras.children.length, 5, '溢出的最后一枚应被收进浮层容器');
  assert.strictEqual(over.more.textContent, '+5', '+N 计数应随搬运同步更新');
  assert.strictEqual(over.line.children.filter(c => c.__flow && c !== over.more).length, 2, '行内只剩放得下的标签');

  // ---------- ④ 静态断言: 守卫存在且 switchPage('live') 会补对齐 ----------
  assert.match(liveSrc, /function fitLiveMetricRows[\s\S]{0,600}?getBoundingClientRect\(\)[\s\S]{0,200}?if \(!box\.width && !box\.height\) return;/,
    'fitLiveMetricRows 必须跳过不在文档流 (display:none) 的行');
  assert.ok(appSrc.includes('if (page === "live" && typeof scheduleLiveRowAlignment === "function") scheduleLiveRowAlignment();'),
    'switchPage 切回实时页必须立即补一次对齐, 不等下一轮轮询');
})();

console.log('队内指标标签隐藏态守卫测试通过');
