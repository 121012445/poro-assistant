const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = __dirname;
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const main = read('main/index.js');
const sgp = read('main/sgp.js');
const preload = read('main/preload.js');
const html = read('renderer/index.html');
const persist = read('renderer/js/persist.js');
// 渲染层已拆成多个脚本: 静态检查必须按 index.html 的加载顺序拼接全部文件,
// 只看 app.js 会漏掉抽出去的那部分 (安全检查漏看比看错更危险)。
const scriptSrcs = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1].split('?')[0]);
const renderer = scriptSrcs.map(s => read('renderer/' + s)).join('\n');
const premiumCss = read('renderer/css/premium.css');

assert.match(sgp, /rejectUnauthorized:\s*true/, 'SGP 必须校验远程 TLS 证书');
assert.doesNotMatch(sgp, /rejectUnauthorized:\s*false/, 'SGP 不得关闭远程 TLS 证书校验');
assert.match(main, /safeStorage\.encryptString/, 'AI API Key 必须使用 Electron safeStorage');
assert.match(persist, /complianceOn\s*=\s*complianceStored\s*===\s*['"]1['"]/, '合规模式首次安装必须默认关闭，同时保留已开启偏好');
assert.match(html, /合规模式（默认关闭）/, '界面必须明确显示合规模式默认关闭');
assert.doesNotMatch(renderer, /JSON\.stringify\(\{\s*baseUrl,\s*apiKey/, '渲染层不得明文持久化 AI API Key');
assert.match(main, /ALLOWED_USER_DATA_FILES/, '文件 IPC 必须使用文件名白名单');
assert.doesNotMatch(preload, /openExternal/, '未使用的外部链接 IPC 不应暴露');
assert.ok(html.indexOf('js/utils.js') < html.indexOf('js/app.js'), 'utils.js 必须先于 app.js 加载');
// 拆分成多模块后最容易出的问题: index.html 里漏写某个 <script>, 或顺序放错。
// 两者都会让页面在真实环境里静默失效, 所以在这里硬性拦住。
for (const s of scriptSrcs) {
  assert.ok(fs.existsSync(path.join(root, 'renderer', s)), 'index.html 引用的渲染层脚本不存在: ' + s);
}
assert.ok(scriptSrcs.length >= 2, '渲染层应至少有 utils.js 与 app.js');
assert.strictEqual(scriptSrcs[scriptSrcs.length - 1], 'js/app.js', 'app.js 必须最后加载 (它依赖前面所有模块)');
assert.strictEqual(scriptSrcs[0], 'js/utils.js', 'utils.js 必须最先加载 (纯工具函数, 无依赖)');
assert.ok(premiumCss.includes('body.dark .stat-card-val'), '暗色主题必须覆盖首页统计数字颜色');
assert.ok(premiumCss.includes('body.dark .home-champs h4'), '暗色主题必须覆盖首页区块标题颜色');
assert.ok(premiumCss.includes('button:not(.win-btn):not(.item)'), '普通操作按钮必须使用统一 Poro 按钮基础样式');
assert.ok(premiumCss.includes('.btn-secondary, .role-btn'), '次要按钮和筛选按钮必须共用统一描边风格');
assert.ok(premiumCss.includes('Unified transparent Poro action buttons'), '所有页面操作按钮必须使用统一透明风格');

const context = vm.createContext({ Promise, Array, String, JSON, Math, setTimeout });
vm.runInContext(read('renderer/js/utils.js'), context);
assert.strictEqual(context.escapeHtml(`<img src=x onerror="x">&'`), '&lt;img src=x onerror=&quot;x&quot;&gt;&amp;&#39;');

const controls = Object.fromEntries(['autoAcceptToggle', 'autoBPToggle', 'autoRuneToggle', 'gsLockToggle',
  'readyCheckState', 'autoBPStatus', 'autoRuneStatus', 'gsLockStatus', 'complianceState'].map(id => [id, { id, checked: false, disabled: false, textContent: '', style: {} }]));
const complianceContext = vm.createContext({
  document: { getElementById: id => controls[id] || null },
  autoAcceptOn: false,
  autoBPEnabled: true,
  autoRuneEnabled: true,
  storeGet: key => key === 'gsLockOn' ? '1' : null,
  storeSet: () => {}, toolMsg: () => {}, showToast: () => {},
  lolAPI: {}, console
});
vm.runInContext(read('renderer/js/compliance.js'), complianceContext);
vm.runInContext('toggleCompliance(true)', complianceContext);
assert.strictEqual(controls.autoRuneToggle.checked, false, '合规模式下自动符文必须呈现为未生效');
assert.strictEqual(controls.autoRuneToggle.disabled, true);
assert.strictEqual(controls.autoRuneStatus.textContent, '合规模式停用', '文字不得与开关相反');
vm.runInContext('toggleCompliance(false)', complianceContext);
assert.strictEqual(controls.autoRuneToggle.checked, true, '关闭合规模式后应恢复保存的自动符文偏好');
assert.strictEqual(controls.autoRuneStatus.textContent, '已开启');
assert.strictEqual(controls.gsLockToggle.checked, true, '关闭合规模式后应恢复设置锁定偏好');

(async () => {
  let active = 0;
  let peak = 0;
  const values = await context.mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async value => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return value * 2;
  });
  assert.deepStrictEqual(Array.from(values), [2, 4, 6, 8, 10, 12]);
  assert.ok(peak <= 3, `并发峰值 ${peak} 超过限制 3`);
  const inferred = context.inferPremadeGroups(
    [
      { puuid: 'a', team: 100 }, { puuid: 'b', team: 100 }, { puuid: 'c', team: 100 },
      { puuid: 'd', team: 200 }, { puuid: 'e', team: 200 }
    ],
    [{ teamGames: [
      { id: 'g1', players: ['a', 'b'] }, { id: 'g2', players: ['a', 'b'] }, { id: 'g3', players: ['a', 'b'] },
      { id: 'g4', players: ['a', 'c'] },
      { id: 'g5', players: ['d', 'e'] }, { id: 'g6', players: ['d', 'e'] }, { id: 'g7', players: ['d', 'e'] }
    ] }],
    3
  );
  assert.strictEqual(inferred.a, inferred.b, '同队共同出现达到阈值的玩家应归为一组');
  assert.strictEqual(inferred.d, inferred.e, '另一队的开黑组合应独立成组');
  assert.notStrictEqual(inferred.a, inferred.d, '不同当前队伍不得合并为同一开黑组');
  assert.strictEqual(inferred.c, undefined, '未达到阈值的玩家不应误判为开黑');
  console.log('安全与并发测试通过');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
