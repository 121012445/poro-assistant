// 代码库静态体检: 重复定义 / 死代码 / 残留 / 一致性
const fs = require('fs');
const path = 'D:/lol-assistant/';
const html = fs.readFileSync(path + 'renderer/index.html', 'utf8');
// 渲染层是多文件: 按 index.html 的加载顺序全部拼接后再体检。
// 必须跨文件, 否则"重复定义"会漏掉跨文件的同名冲突, "死代码"会把拆出去、
// 只被 app.js 引用的函数误报成"全文仅出现一次"。
const scriptSrcs = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1].split('?')[0]);
const appjs = scriptSrcs.map(s => fs.readFileSync(path + 'renderer/' + s, 'utf8')).join('\n');
const preload = fs.readFileSync(path + 'main/preload.js', 'utf8');
const mainjs = ['main/index.js', 'main/lcu.js', 'main/lcu-ws.js', 'main/sgp.js'].map(f => fs.readFileSync(path + f, 'utf8')).join('\n');

console.log('== 1. 函数重复定义 ==');
const defs = {};
for (const m of appjs.matchAll(/^(?:async )?function ([a-zA-Z_$][\w$]*)/gm)) {
  (defs[m[1]] = defs[m[1]] || []).push('function');
}
for (const m of appjs.matchAll(/^let ([a-zA-Z_$][\w$]*)/gm)) {
  (defs[m[1]] = defs[m[1]] || []).push('let');
}
const dups = Object.entries(defs).filter(([k, v]) => v.length > 1);
console.log(dups.length ? '  重复: ' + dups.map(([k, v]) => k + '(' + v.join('+') + ')').join(', ') : '  无');

console.log('== 2. 死代码候选 (定义但全文仅出现一次) ==');
const dead = [];
for (const name of Object.keys(defs)) {
  const uses = (appjs.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;
  const inHtml = new RegExp('\\b' + name + '\\b').test(html);
  const inMain = new RegExp('\\b' + name + '\\b').test(mainjs) || new RegExp('\\b' + name + '\\b').test(preload);
  if (uses <= 1 && !inHtml && !inMain) dead.push(name);
}
console.log(dead.length ? '  ' + dead.join(', ') : '  无');

console.log('== 3. 残留检查 ==');
console.log('  craftbukkit 残留:', /craftbukkit/.test(appjs) ? '有!' : '无');
const lsUses = (appjs.match(/localStorage\.\w+/g) || []);
console.log('  localStorage 调用:', lsUses.length, lsUses.length ? '(' + [...new Set(lsUses)].join(' ') + ')' : '');
console.log('  GS_LOCK 旧路径残留:', /D:\/lol-assistant\/gs_lock/.test(appjs) ? '有!' : '无');

console.log('== 4. 版本一致性 ==');
const pkg = JSON.parse(fs.readFileSync(path + 'package.json', 'utf8'));
console.log('  package.json:', pkg.version, '| deps:', JSON.stringify(pkg.dependencies), '| asar:', pkg.build.asar, '| prebuild:', !!pkg.scripts.prebuild);
// 版本号唯一来源 = package.json。渲染层若残留硬编码版本号, UI 就会显示旧号,
// 极易被误判成"部署没生效" —— 这类假象排查成本很高, 所以这里直接判死。
const verTag = (html.match(/id="versionText"[^>]*>([^<]*)</) || [])[1] || '';
const verAssign = (appjs.match(/versionText"\)\.textContent\s*=\s*(["'`])[^\n]*/) || [])[0] || '';
const hardVer = [];
if (/\d+\.\d+\.\d+/.test(verTag)) hardVer.push('index.html: ' + verTag.trim());
if (/textContent\s*=\s*["'`]v?\d+\.\d+\.\d+/.test(verAssign)) hardVer.push('app.js: ' + verAssign.trim());
const verIpc = /ipcMain\.handle\(\s*'app:version'/.test(mainjs) && /getAppVersion\s*:/.test(preload) && /getAppVersion/.test(appjs);
console.log('  渲染层硬编码版本号:', hardVer.length ? '有! ' + hardVer.join(' | ') : '无 (正确, 走 app:version IPC)');
console.log('  app:version 链路 (main.handle / preload / app.js):', verIpc ? '完整' : '不完整!');
if (hardVer.length || !verIpc) { console.error('  版本号来源检查失败: 版本号必须且只能来自 package.json'); process.exit(1); }

console.log('== 5. 文件清单 (根目录杂物) ==');
for (const f of fs.readdirSync(path)) {
  const st = fs.statSync(path + f);
  if (st.isFile()) console.log('  ' + f + ' (' + Math.round(st.size / 1024) + 'KB)');
}

console.log('== 6. IPC 通道对账 ==');
const inv = new Set(), on = new Set();
for (const m of preload.matchAll(/invoke\('([^']+)'/g)) inv.add(m[1]);
for (const m of preload.matchAll(/send\('([^']+)'/g)) on.add('on:' + m[1]);
for (const m of preload.matchAll(/on\('([^']+)'/g)) on.add('on:' + m[1]);
const reg = new Set(), sent = new Set();
for (const m of mainjs.matchAll(/ipcMain\.handle\('([^']+)'/g)) reg.add(m[1]);
for (const m of mainjs.matchAll(/ipcMain\.on\('([^']+)'/g)) reg.add('on:' + m[1]);
for (const m of mainjs.matchAll(/sendTo(Renderer|Window)\('([^']+)'/g)) sent.add('on:' + m[2]);
for (const m of mainjs.matchAll(/webContents\.send\('([^']+)'/g)) sent.add('on:' + m[1]);
const missInv = [...inv].filter(c => !reg.has(c));
const missOn = [...on].filter(c => !reg.has(c) && !sent.has(c));
console.log('  invoke 未注册:', missInv.length ? missInv.join(',') : '无');
console.log('  send/on 通道缺发送或接收方:', missOn.length ? missOn.join(',') : '无');

console.log('== 7. 行数统计 ==');
for (const f of [...scriptSrcs.map(s => 'renderer/' + s), 'renderer/index.html', 'renderer/css/style.css', 'renderer/css/extras.css', 'renderer/css/dark.css', 'main/index.js', 'main/lcu.js', 'main/lcu-ws.js', 'main/sgp.js']) {
  const c = fs.readFileSync(path + f, 'utf8');
  console.log('  ' + f + ': ' + (c.split('\n').length) + ' 行 / ' + Math.round(c.length / 1024) + 'KB');
}
