// 悬空引用核查
const fs = require('fs');
const html = fs.readFileSync('D:/lol-assistant/renderer/index.html', 'utf8');
// 渲染层是多文件: 必须按 index.html 的加载顺序拼接后再查, 否则拆出去的函数会被误判成"未定义"
const scriptSrcs = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1].split('?')[0]);
const app = scriptSrcs.map(s => fs.readFileSync('D:/lol-assistant/renderer/' + s, 'utf8')).join('\n');
const pre = fs.readFileSync('D:/lol-assistant/main/preload.js', 'utf8');

console.log('== HTML 调用但 app.js 未定义的函数 ==');
const defined = new Set();
for (const m of app.matchAll(/^(?:async )?function ([a-zA-Z_$][\w$]*)/gm)) defined.add(m[1]);
const missing = [];
for (const m of html.matchAll(/on(?:click|change|input|blur|focus|keydown)="([a-zA-Z_$][\w$]*)\(/g)) {
  const f = m[1];
  if (!defined.has(f)) missing.push(f);
}
console.log(missing.length ? missing.join(', ') : '无');

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
