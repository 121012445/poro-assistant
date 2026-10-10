// 战绩服务故障退避 / 错误归类的回归测试。
//
// 背景（实测 2026-10-09、10-10 的日志）：国服 SGP 战绩网关在深夜会连续 20~30 分钟返回
// 500/503，而 Poro 的轮询每 12 秒重试一次、没有任何退避，整个窗口打出上千次请求。
// 同时 `findSgpPlatform` 在"大区已确认、只是战绩接口挂了"时会把已拿到的大区丢掉，
// 导致界面显示"大区: 待识别"，把"服务暂时不可用"误报成"这个人查不到"。
//
// 这个测试锁住三件事：
//   1. 5xx/超时 才算"服务不可用"（可退避）；"未找到该召唤师"绝不能算。
//   2. 退避阶梯单调递增且有上限，成功后复位。
//   3. findSgpPlatform 在战绩接口失败时把 platformId/summoner 挂在错误上抛出。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = __dirname;
const home = fs.readFileSync(path.join(ROOT, 'renderer/js/home.js'), 'utf8');
const bench = fs.readFileSync(path.join(ROOT, 'renderer/js/bench.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');

// ---- 1. 从源码里取出退避相关实现，在沙箱里真跑 ----
function sliceBetween(src, startMark, endMark) {
  const i = src.indexOf(startMark);
  assert(i >= 0, '找不到起点: ' + startMark);
  const j = src.indexOf(endMark, i);
  assert(j >= 0, '找不到终点: ' + endMark);
  return src.slice(i, j);
}

const stepsSrc = sliceBetween(home, 'const SGP_BACKOFF_STEPS_MS', ';');
const transientSrc = sliceBetween(home, 'function isTransientSgpError', '\n}') + '\n}';

const ctx = {
  Date,
  console: { log() {} },
  lolAPI: { debugLog() {} }
};
vm.createContext(ctx);
// 注意: vm 里顶层 const/let 只进全局词法环境, 不会挂到 context 对象上,
// 只有 function 声明会。所以 const/let 必须用求值读取 (与 probe_renderer.js 同一坑)。
const ev = expr => vm.runInContext(expr, ctx);
vm.runInContext(stepsSrc + '\n' + transientSrc, ctx);

const steps = ev('SGP_BACKOFF_STEPS_MS');
assert(Array.isArray(steps), 'SGP_BACKOFF_STEPS_MS 必须是数组');
assert(steps.length >= 3, '退避阶梯至少 3 级');
for (let i = 1; i < steps.length; i++) {
  assert(steps[i] > steps[i - 1], `退避阶梯必须严格递增: ${steps[i - 1]} -> ${steps[i]}`);
}
assert(steps[steps.length - 1] >= 60000, '退避上限至少 60s，否则整段故障窗口仍会打出大量请求');
assert(steps[0] >= 12000, '第一级退避必须大于 12s 轮询间隔，否则等于没退避');

// 服务端故障：必须判为可退避
for (const msg of [
  'SGP HTTP 500', 'SGP HTTP 503', 'SGP HTTP 502', 'SGP HTTP 504',
  'SGP 请求超时', 'SGP 连接失败: read ECONNRESET', 'SGP 凭证过期',
  '所有大区召唤师服务暂不可用'
]) {
  assert(ctx.isTransientSgpError(msg) === true, `应判为服务不可用: ${msg}`);
}
// 非服务端故障：绝不能退避，否则"查不到的人"会被一直挡住
for (const msg of [
  '未找到该召唤师，请检查名字与 Tag 是否完全一致',
  '未找到: 张三 (国服需完整 名字#Tag, 如 召唤师#0000)',
  '暂不支持该大区: XX9',
  '',
  null
]) {
  assert(ctx.isTransientSgpError(msg) === false, `不应判为服务不可用: ${String(msg)}`);
}

// ---- 2. 退避状态机：递增 + 上限 + 复位 ----
const stateSrc = sliceBetween(home, 'let sgpFailureStreak', 'function sgpBackoffActive');
vm.runInContext(stateSrc + '\nfunction sgpBackoffActive(){ return Date.now() < sgpBackoffUntil; }', ctx);

const seen = [];
for (let i = 0; i < steps.length + 3; i++) {
  ctx.noteSgpFailure();
  seen.push(ev('sgpBackoffUntil') - Date.now());
}
for (let i = 1; i < steps.length; i++) {
  assert(seen[i] > seen[i - 1], `第 ${i} 次失败的退避应大于上一次: ${seen[i - 1]} -> ${seen[i]}`);
}
assert(seen[seen.length - 1] <= steps[steps.length - 1] + 50, '退避不得超过上限');
assert(ctx.sgpBackoffActive() === true, '失败后应处于退避中');
ctx.noteSgpSuccess();
assert(ev('sgpFailureStreak') === 0, '成功后连续失败计数必须清零');
assert(ev('sgpBackoffUntil') === 0, '成功后必须立刻解除退避');
assert(ctx.sgpBackoffActive() === false, '成功后退避应为非激活');

// ---- 3. findSgpPlatform 必须保留已确认的大区 ----
assert(home.includes('err.platformId = hit.platformId'), 'findSgpPlatform 必须把已确认的大区挂到错误上');
assert(home.includes('err.summoner = hit.summoner'), 'findSgpPlatform 必须把已查到的召唤师档案挂到错误上');
assert(home.includes('if (e.platformId) {'), 'catch 分支必须消费 e.platformId，否则界面仍会显示"大区: 待识别"');
assert(home.includes('targetPlatformId = e.platformId'), 'catch 分支必须用已确认的大区覆盖 targetPlatformId');

// ---- 4. 轮询必须真的尊重退避 ----
assert(bench.includes('sgpBackoffActive()'), 'bench.js 轮询必须检查退避状态');
assert(/sgpBackoffActive\(\)\)\s*\)\s*\{/.test(bench) || bench.includes('!(typeof sgpBackoffActive'), 'bench.js 必须用退避条件短路补刷');
assert(home.includes('if(sgpBackoffActive()) return;'), 'refreshViewedProfile 必须在退避期间直接返回');

// ---- 5. 用户可手动绕过退避 ----
assert(home.includes('function retryHomeStatsNow'), '必须提供手动重试入口');
assert(home.includes('sgpBackoffUntil = 0;'), '手动重试必须清掉退避');
assert(home.includes('retryHomeStatsNow()'), '空状态页必须挂上"立即重试"按钮');

// ---- 6. 提示文案必须说明是"国服战绩服务不可用"，而不是"暂无记录" ----
assert(home.includes('国服战绩服务暂时不可用'), '必须给出明确的服务不可用提示，不能只说"暂无记录"');

// ---- 7. 缓存戳必须已推进（file:// 下唯一的失效手段） ----
const stamps = [...html.matchAll(/\?v=(\d{10})/g)].map(m => m[1]);
assert(stamps.length >= 30, '缓存戳数量异常: ' + stamps.length);
const newest = stamps.reduce((a, b) => (a > b ? a : b));
assert(newest >= '2026101102', '改了 home.js/bench.js 必须推进缓存戳，否则渲染层仍用旧代码: ' + newest);

console.log('sgp backoff tests passed');
