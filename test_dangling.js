// 悬空引用核查
const fs = require('fs');
const nodePath = require('path');
const ROOT = __dirname;   // 不写死作者本机路径
const html = fs.readFileSync(nodePath.join(ROOT, 'renderer/index.html'), 'utf8');
// 渲染层是多文件: 必须按 index.html 的加载顺序拼接后再查, 否则拆出去的函数会被误判成"未定义"
const scriptSrcs = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1].split('?')[0]);
const app = scriptSrcs.map(s => fs.readFileSync(nodePath.join(ROOT, 'renderer', s), 'utf8')).join('\n');
const pre = fs.readFileSync(nodePath.join(ROOT, 'main/preload.js'), 'utf8');

console.log('== HTML 调用但 app.js 未定义的函数 ==');
const defined = new Set();
for (const m of app.matchAll(/^(?:async )?function ([a-zA-Z_$][\w$]*)/gm)) defined.add(m[1]);
// 也收集箭头函数 / 函数表达式 / window 挂载的写法, 否则它们会被误判成"未定义"
for (const m of app.matchAll(/^(?:const|let|var) ([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\()/gm)) defined.add(m[1]);
for (const m of app.matchAll(/^window\.([a-zA-Z_$][\w$]*)\s*=/gm)) defined.add(m[1]);

// 内联处理器不一定以函数名开头: `onclick="if (event.target===this)closeModal()"` 很常见。
// 旧写法只取 =" 后面的**第一个**标识符, 于是:
//   · 把 if / setTimeout 当成函数名报出来  → 假阳性 (常年挂着的噪音)
//   · 真正被调用的 closeModal 完全看不到     → 漏报
// 既是噪音又是盲的。现在改成扫整个处理器体, 取所有非方法调用的标识符,
// 再排掉 JS 关键字与宿主内置函数。
const JS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return',
  'var', 'let', 'const', 'function', 'class', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of',
  'void', 'this', 'try', 'catch', 'finally', 'throw', 'await', 'async', 'yield', 'super',
  'null', 'true', 'false', 'undefined'
]);
const HOST_GLOBALS = new Set([
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'queueMicrotask',
  'alert', 'confirm', 'prompt', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'structuredClone',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'RegExp', 'Error',
  'Promise', 'Map', 'Set', 'Event', 'CustomEvent', 'console', 'fetch'
]);

const missing = [];
for (const m of html.matchAll(/on(?:click|change|input|blur|focus|keydown|submit|mouseover|mouseleave)="([^"]*)"/g)) {
  // 前置字符不能是 `.`(方法调用, 如 lolAPI.close) 或标识符字符, 否则会把 obj.foo() 的 foo 算进来
  for (const c of m[1].matchAll(/(^|[^.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)) {
    const f = c[2];
    if (JS_KEYWORDS.has(f) || HOST_GLOBALS.has(f)) continue;
    if (!defined.has(f) && !missing.includes(f)) missing.push(f);
  }
}
console.log(missing.length ? missing.join(', ') : '无');
// 悬空引用必须判死: HTML 与渲染层之间没有类型系统保护, 改函数名忘了改 HTML 时
// 用户看到的只是"按钮点了没反应", 控制台静默无报错 —— 靠人肉发现成本极高。
if (missing.length) {
  console.error('  悬空引用! 以上函数在渲染层没有定义, 对应按钮会点了没反应: ' + missing.join(', '));
  process.exit(1);
}

console.log('== app.js 调用但 preload 未暴露的 API ==');
const apis = new Set();
for (const m of pre.matchAll(/^  ([a-zA-Z_$][\w$]*):/gm)) apis.add(m[1]);
const missApi = [];
for (const m of app.matchAll(/lolAPI\.([a-zA-Z_$][\w$]*)/g)) {
  if (!apis.has(m[1]) && !missApi.includes(m[1])) missApi.push(m[1]);
}
console.log(missApi.length ? missApi.join(', ') : '无');

console.log('== 悬浮窗/图鉴/出装 状态 ==');
console.log('悬浮窗卡片:', html.includes('id="overlayToggle"') ? '存在(调用' + (defined.has('toggleOverlay') ? 'toggleOverlay 定义✓)' : 'toggleOverlay 已删✗)') : '不存在');
console.log('hexList 元素:', html.includes('id="hexList"') ? '存在' : '不存在');
console.log('出装卡片:', html.includes('id="isChamp"') ? '存在' : '不存在');
console.log('isChampFilter:', defined.has('isChampFilter') ? '定义✓' : '已删✗', '| isSave:', defined.has('isSave') ? '定义✓' : '已删✗', '| renderHexList:', defined.has('renderHexList') ? '定义✓' : '已删✗');
console.log('AI 测试按钮:', html.includes('testAiConfig') ? '存在' : '不存在');
console.log('overlayHint 残留调用:', (app.match(/lolAPI\.overlayHint/g) || []).length, '| setOverlayEnabled 残留:', (app.match(/lolAPI\.setOverlayEnabled/g) || []).length);
console.log('sendGameChat 保留:', app.includes('sendGameChat') ? '✓' : '✗', '| spectateFriendInfo 新观战:', app.includes('spectateFriendInfo') ? '✓' : '✗');
