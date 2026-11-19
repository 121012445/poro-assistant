// 1.6.18: 外服聊天翻译的前置条件提示。
// 背景: 新用户不知道浮窗要求游戏是「无边框」或「窗口」模式。独占全屏时 Windows 不合成
//   其它窗口, topmost 也压不上去 —— 浮窗永远不显示, 用户只会觉得"这功能坏了"。
// 本测试锁定三处提示都在, 且浮窗空态的提示会在读到第一条聊天后回到快捷键说明:
//   ① 翻译卡片里常驻的步骤提示 (无边框 / 窗口模式)
//   ② 浮窗空态底栏文案 (看不到内容 → 改无边框)
//   ③ 首次开启开关时的一次性 toast
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync('renderer/index.html', 'utf8');
const overlayHtml = fs.readFileSync('renderer/game-translate.html', 'utf8');
const overlayJs = fs.readFileSync('renderer/js/game-translate.js', 'utf8');
const translateJs = fs.readFileSync('renderer/js/translate.js', 'utf8');

// ---- ① 翻译卡片: 步骤提示必须在开关之前, 且说清"无边框" ----
const tipAt = html.indexOf('id="gtSetupTip"');
const toggleAt = html.indexOf('id="gameTranslateToggle"');
assert.ok(tipAt > 0, '翻译卡片里必须有 id=gtSetupTip 的提示块');
assert.ok(toggleAt > 0, '找不到 gameTranslateToggle');
assert.ok(tipAt < toggleAt, '提示块必须排在开关之前 —— 用户是"先看到提示再打开开关"');
const tipStart = html.lastIndexOf('<div class="gt-setup-tip"', tipAt);
assert.ok(tipStart > 0, '提示块必须用 gt-setup-tip 类名');
const tipBlock = html.slice(tipStart, toggleAt);
assert.ok(/无边框/.test(tipBlock), '提示必须明确写出「无边框」');
assert.ok(/窗口模式/.test(tipBlock), '提示必须指出设置项叫「窗口模式」');
assert.ok(/独占全屏/.test(tipBlock), '提示要说明原因(独占全屏), 否则用户会以为是功能没生效');
assert.ok(/class="gt-setup-tip"/.test(tipBlock), '提示块要带 gt-setup-tip 样式类');

// ---- ② 浮窗空态底栏: 文案常量 + 读取到聊天后回落到快捷键说明 ----
const readyMatch = /const HINT_READY = '([^']*)'/.exec(overlayJs);
const idleMatch = /const HINT_IDLE = '([^']*)'/.exec(overlayJs);
assert.ok(readyMatch, 'game-translate.js 缺少 HINT_READY 常量');
assert.ok(idleMatch, 'game-translate.js 缺少 HINT_IDLE 常量');
assert.ok(/Ctrl\+F10/.test(readyMatch[1]), 'HINT_READY 应是原来的 Ctrl+F10 说明');
assert.ok(/无边框/.test(idleMatch[1]), '空态提示必须指向「无边框」, 这是唯一的排查方向');
assert.ok(/gt-hint-idle/.test(overlayJs), '空态要切到 gt-hint-idle 样式(琥珀色), 视觉上与正常态区分');
assert.ok(/syncHint\(\)/.test(overlayJs), 'render 里必须调用 syncHint(), 否则底栏不会随数据变化');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing fn ' + name);
  let depth = 0, began = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') { depth++; began = true; }
    else if (src[i] === '}') { depth--; if (began && depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced fn ' + name);
}

// 动态跑一遍 syncHint: 空 -> 有数据 -> 空, 三态文案与样式类都要对
const hintSrc = extractFn(overlayJs, 'syncHint');
const harness = `
  let lines = [];
  let hintShown = '';
  let cls = 'gt-hint';
  const hintEl = {
    textContent: '',
    title: '',
    set className(v) { cls = v; },
    get className() { return cls; },
    classList: {
      toggle(name, on) {
        const set = new Set(cls.split(/\\s+/).filter(Boolean));
        if (on) set.add(name); else set.delete(name);
        cls = Array.from(set).join(' ');
      }
    }
  };
  const HINT_READY = ${JSON.stringify(readyMatch[1])};
  const HINT_IDLE = ${JSON.stringify(idleMatch[1])};
  ${hintSrc}
  const snap = () => ({ text: hintEl.textContent, title: hintEl.title, cls: hintEl.className });
  syncHint();
  const empty = snap();
  lines = [{ name: '队友', translated: '你好' }];
  syncHint();
  const filled = snap();
  lines = [];
  syncHint();
  const backToEmpty = snap();
  result({ empty, filled, backToEmpty });
`;
let out = null;
vm.runInNewContext(harness, { result: v => { out = v; } });
assert.ok(out, 'syncHint 没有被执行到');
assert.strictEqual(out.empty.text, idleMatch[1], '没有聊天时底栏应显示空态提示');
assert.ok(/gt-hint-idle/.test(out.empty.cls), '空态必须带 gt-hint-idle 类名');
assert.ok(/画面/.test(out.empty.title), '空态 title 要给出设置路径(画面)');
assert.strictEqual(out.filled.text, readyMatch[1], '读到聊天后底栏要回到 Ctrl+F10 说明');
assert.ok(!/gt-hint-idle/.test(out.filled.cls), '有内容时不能再显示琥珀色空态样式');
assert.strictEqual(out.filled.title, '', '有内容时不该再挂设置提示的 title');
assert.strictEqual(out.backToEmpty.text, idleMatch[1], '聊天清空后要能回到空态提示');

// ---- ③ 浮窗样式: 空态琥珀色规则必须存在 ----
assert.ok(/\.gt-hint\.gt-hint-idle/.test(overlayHtml), 'game-translate.html 缺少 .gt-hint-idle 样式');

// ---- ④ 首次开启开关: 一次性 toast, 且不能每次都弹 ----
assert.ok(/gtBorderlessTip/.test(translateJs), '开关里缺少"已提示过"的存储键, 会每次开启都弹');
assert.ok(/storeGet\('gtBorderlessTip'\) !== '1'/.test(translateJs), 'toast 必须只在首次开启时弹');
assert.ok(/无边框/.test(translateJs.slice(translateJs.indexOf('function toggleGameTranslate'), translateJs.indexOf('function setTranslateTarget'))),
  '首次开启的 toast 文案要提到「无边框」');

console.log('test_translate_borderless_tip: ok');
