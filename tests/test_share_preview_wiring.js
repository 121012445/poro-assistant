'use strict';
// 「保存战报卡」流程回归: 必须是"先预览, 再选位置", 而不是点一下直接弹保存框。
// 这条流程没法在 node 里跑真 Electron, 所以钉住三处接线 + 一处行为特征:
//   1) 主进程有 render / save / copy 三个 IPC, 且 save 只吃 dataUrl (不再自己截图);
//   2) preload 暴露 renderShareCard / saveShareCardImage / copyShareCardImage;
//   3) 渲染层按钮走 renderShareCard 并打开预览层, 保存按钮才调 saveShareCardImage;
//   4) 旧的"点按钮 → showSaveDialog"的一步式写法不能回来。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(SRC, rel), 'utf8');

const main = read('main/index.js');
const preload = read('main/preload.js');
const battle = read('renderer/js/battle-card.js');
const weekly = read('renderer/js/weekly.js');
const css = read('renderer/css/v4.css');

// ---- 1. 主进程三个 IPC ----
assert.ok(main.includes("ipcMain.handle('share-card:render'"), '缺 share-card:render');
assert.ok(main.includes("ipcMain.handle('share-card:save'"), '缺 share-card:save');
assert.ok(main.includes("ipcMain.handle('share-card:copy'"), '缺 share-card:copy');
assert.ok(main.includes('async function renderShareCardPng'), '缺离屏渲染函数');
assert.ok(main.includes('shareCardBufferOf('), '缺 dataUrl 解析');
// save 必须收 dataUrl, 不能收 html 自己截图
assert.ok(/ipcMain\.handle\('share-card:save', async \(e, dataUrl, opts\)/.test(main),
  'share-card:save 的参数必须是 dataUrl (不能还是 html)');
// 渲染函数里必须还有 capturePage (离屏截图这条链路没被拆坏)
const renderBlock = main.slice(main.indexOf('async function renderShareCardPng'), main.indexOf("ipcMain.handle('share-card:render'"));
assert.ok(renderBlock.includes('capturePage'), '离屏渲染应调用 capturePage');
assert.ok(renderBlock.includes('toPNG()'), '离屏渲染应返回 PNG');
// 默认保存位置改到"图片"目录 (原来是桌面, 用户体感像跳到文件夹)
assert.ok(main.includes("app.getPath('pictures') || app.getPath('desktop')"), '默认保存目录应是"图片", 桌面兜底');

// ---- 2. preload ----
for (const fn of ['renderShareCard:', 'saveShareCardImage:', 'copyShareCardImage:']) {
  assert.ok(preload.includes(fn), 'preload 缺 ' + fn);
}
assert.ok(!preload.includes("ipcRenderer.invoke('share-card:save', html"),
  'preload 不得再把 html 直接发给 save');

// ---- 3. 渲染层 ----
assert.ok(battle.includes('renderShareCard(html'), '战报卡要调 renderShareCard');
assert.ok(battle.includes('preview(r.dataUrl'), '拿到 dataUrl 后要打开预览层');
assert.ok(battle.includes('saveShareCardImage(dataUrl'), '预览层的「保存到…」要调 saveShareCardImage');
assert.ok(battle.includes('copyShareCardImage(dataUrl'), '预览层应有「复制图片」');
assert.ok(battle.includes("id = 'shareCardPreview'") || battle.includes('shareCardPreview'), '缺预览层容器');
assert.ok(battle.includes("ev.key === 'Escape'"), '预览层应支持 Esc 关闭');
assert.ok(/PoroBattleCard = \{[^}]*\bpreview\b/.test(battle), '要导出 preview 供周报复用');
// 旧的"点一下直接 saveShareCard"必须没有了
assert.ok(!/lolAPI\.saveShareCard\(html/.test(battle), '战报卡不得再一步式调 saveShareCard');
assert.ok(weekly.includes('renderShareCard'), '周报也要先预览');
assert.ok(!/lolAPI\.saveShareCard\(/.test(weekly), '周报不得再一步式保存');

// ---- 4. 样式 ----
assert.ok(css.includes('.scp-dialog'), 'v4.css 缺预览层样式');
assert.ok(css.includes('.scp-img'), 'v4.css 缺预览图样式');

console.log('保存战报卡「先预览再选位置」接线检查通过');
