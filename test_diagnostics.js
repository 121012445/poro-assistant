'use strict';
const assert = require('assert');
const fs = require('fs');
const main = fs.readFileSync('main/index.js', 'utf8');
const preload = fs.readFileSync('main/preload.js', 'utf8');
const renderer = fs.readFileSync('renderer/js/diagnostics.js', 'utf8');
assert(main.includes("ipcMain.handle('diag:recentLogs'"));
assert(main.includes("replaceAll(home, '<USER>')"));
assert(main.includes("ipcMain.handle('diag:export'"));
assert(main.includes("kind: 'poro-diagnostics'"));
assert(preload.includes("getRecentLogs: () => ipcRenderer.invoke('diag:recentLogs')"));
assert(preload.includes("exportDiagnostics: (report) => ipcRenderer.invoke('diag:export', report)"));
assert(renderer.includes('window.poroSession?.snapshot()'));
assert(renderer.includes('shortIdentity'));
assert(renderer.includes('async function exportDiagnostics()'));

// 提权状态必须能透出到界面。受限版(asInvoker)与正式版共用同一份代码，
// 用户否则无从知道自己装的是哪个包，只会看到一个 SendInput 报错。
assert(main.includes("ipcMain.handle('app:elevation'"), '主进程必须提供提权状态接口');
assert(preload.includes("getElevation: () => ipcRenderer.invoke('app:elevation')"), 'preload 必须暴露提权状态');
assert(renderer.includes('async function refreshElevationNotice()'), '诊断页必须有提权提示刷新函数');
assert(renderer.includes('permission: {'), '提权状态必须写进诊断报告');
const diagnosticsHtml = fs.readFileSync('renderer/index.html', 'utf8');
assert(diagnosticsHtml.includes('id="elevationNotice"'), '诊断页必须有提权提示的挂载点');
const appJsSource = fs.readFileSync('renderer/js/app.js', 'utf8');
assert(appJsSource.includes('refreshElevationNotice()'), '打开工具箱时必须刷新提权提示');
// 提权接口只能返回判定结果，不能顺带吐出路径/令牌之类的东西
assert(!/app:elevation[\s\S]{0,300}?(token|USER_DATA|process\.env)/i.test(main),
  '提权接口不得附带敏感信息');
console.log('脱敏诊断中心测试通过');
