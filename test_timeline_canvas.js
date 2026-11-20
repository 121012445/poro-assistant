'use strict';
// 1.6.30 复盘经济曲线"被拉长"。
// 三个原因叠在一起, 单看任何一个都只是"有点扁":
//   ① 高度写死 cssW*150/760 (1:5.07), 940 宽只有 185 高, 二十多分钟的曲线压成一条横线;
//   ② y 轴按 ±maxAbs 对称铺开, 经济差全程同向时另一半空间全空, 有效高度再砍一半;
//   ③ 曲线页默认 display:none, canvas.clientWidth 读到 0 就退回 760 兜底; 等用户切到曲线页,
//      位图还是 760 宽, 被 .rv-canvas{width:100%} 拉到 940 (实测 1.24 倍), 线宽/字号一起发虚。
// 这一版: 高度随宽度自适应 (180~300px), y 轴贴合数据但强制最小跨度 5000,
//         paint 挂 canvas 上, tab 切过来时补画一次。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('renderer/js/review.js', 'utf8').replace(/\r\n/g, '\n');
const hex = fs.readFileSync('renderer/js/hex.js', 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync('renderer/css/extras.css', 'utf8').replace(/\r\n/g, '\n');

const a = src.indexOf('function drawTimelineChart(chart) {');
assert.ok(a > 0, '应能定位 drawTimelineChart');
const b = src.indexOf('\n', src.indexOf('function fmtGoldShort(v)') + 1);
assert.ok(b > a, '应能定位 drawTimelineChart 结尾');
const chartSrc = src.slice(a, b);

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('ok ' + pass + ' - ' + name); };

// ---- 静态检查: 曾经出问题的写法不能再回来 ----
ok('不再用 clientWidth || 760 兜底(隐藏时读到 0 会把位图钉死在 760)', () => {
  assert.ok(!/clientWidth\s*\|\|\s*760/.test(chartSrc), '还会退回 760 兜底');
  assert.ok(/if \(!cssW \|\| cssW === lastW\) return false/.test(chartSrc), '应改成量不到宽度就不画');
});

ok('位图尺寸每次按容器实测宽度重算, 并同步写 style.height', () => {
  assert.ok(/canvas\.width = Math\.round\(cssW \* dpr\)/.test(chartSrc));
  assert.ok(/canvas\.height = Math\.round\(cssH \* dpr\)/.test(chartSrc));
  assert.ok(/canvas\.style\.height = cssH \+ 'px'/.test(chartSrc));
});

ok('高度不再写死 150/760, 高宽比收敛到 ~1:3.4 且夹在 180~300', () => {
  assert.ok(!/150 \/ 760/.test(chartSrc), '旧的 1:5.07 比例还在');
  assert.ok(/Math\.max\(180, Math\.min\(300, Math\.round\(cssW \* 0\.29\)\)\)/.test(chartSrc),
    '高度应按 0.29 自适应并夹在 180~300');
});

ok('y 轴贴合数据(扫 lo/hi), 但强制最小跨度 5000 防止夸大细微波动', () => {
  assert.ok(/if \(d\.diff < lo\) lo = d\.diff; if \(d\.diff > hi\) hi = d\.diff;/.test(chartSrc));
  assert.ok(/Math\.max\(5000, \(hi - lo\) \* 1\.16\)/.test(chartSrc), '应有最小跨度兜底');
  assert.ok(!/maxAbs/.test(chartSrc), '旧的对称 maxAbs 逻辑应已移除');
});

ok('零轴越界时不画(贴合数据后 0 可能落在图外)', () => {
  assert.ok(/if \(yLo < 0 && yHi > 0\)/.test(chartSrc));
});

ok('paint 挂到 canvas 上, 供 tab 切换与窗口缩放补画', () => {
  assert.ok(/canvas\.__poroTlPaint = paint/.test(chartSrc));
  assert.ok(/window\.__poroTlResizeBound/.test(chartSrc), '窗口缩放应只绑一次监听');
  assert.ok(/requestAnimationFrame/.test(chartSrc), 'resize 应节流');
});

ok('hex.js 的 tab 切换会补画曲线 canvas', () => {
  assert.ok(/canvas\.rv-canvas/.test(hex), 'tab 切换应查找曲线 canvas');
  assert.ok(/__poroTlPaint/.test(hex), 'tab 切换应调用 paint');
});

// ---- 行为检查: 在假 canvas 上真跑一遍 paint ----
function makeEnv(clientWidth) {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : (...args) => { calls.push(String(k)); return undefined; }),
    set: (t, k, v) => { t[k] = v; return true; }
  });
  const canvas = {
    clientWidth,
    width: 760,
    height: 150,
    style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: clientWidth, height: 0 })
  };
  const sandbox = {
    console,
    Math, JSON, Number, String, Object, Array,
    document: { body: {}, querySelectorAll: () => [] },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: fn => fn(),
    window: {
      devicePixelRatio: 2,
      addEventListener: () => {}
    }
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(chartSrc.replace(/function drawTimelineChart\(/, 'function drawTimelineChart('), context);
  const diffs = [];
  for (let m = 0; m <= 24; m += 0.5) diffs.push({ t: m, diff: Math.round(m < 18 ? m * 20 : m * 900) });
  diffs.push({ t: 24.7, diff: 13200 });
  return { canvas, calls, context, chart: { diffs, kills: [] } };
}

ok('隐藏状态(clientWidth=0)不画, 位图尺寸保持不动', () => {
  const { canvas, calls, context, chart } = makeEnv(0);
  vm.runInContext('drawTimelineChart', context)(chart)(canvas);
  assert.strictEqual(canvas.width, 760, '隐藏时不该改位图宽度');
  assert.strictEqual(canvas.height, 150, '隐藏时不该改位图高度');
  assert.strictEqual(calls.length, 0, '隐藏时不该有任何绘制调用');
  assert.strictEqual(typeof canvas.__poroTlPaint, 'function', 'paint 仍应挂在 canvas 上等补画');
});

ok('可见时位图尺寸 == 显示尺寸, 高度按 0.29 算(940 -> 273)', () => {
  const { canvas, context, chart } = makeEnv(940);
  vm.runInContext('drawTimelineChart', context)(chart)(canvas);
  assert.strictEqual(canvas.width, 1880, '位图宽应为 940 * dpr(2)');
  assert.strictEqual(canvas.height, 546, '位图高应为 273 * dpr(2)');
  assert.strictEqual(canvas.style.height, '273px', 'CSS 高度应与位图逻辑高度一致');
});

ok('宽度没变时重复调用不重画(避免 resize 抖动)', () => {
  const { canvas, calls, context, chart } = makeEnv(940);
  vm.runInContext('drawTimelineChart', context)(chart)(canvas);
  const n1 = calls.length;
  assert.ok(n1 > 0, '第一次应绘制');
  // tab 切回曲线页 / 窗口 resize 走的就是这个入口
  canvas.__poroTlPaint();
  assert.strictEqual(calls.length, n1, '宽度未变不应重复绘制');
  // 容器变宽后必须重画, 否则位图又会被 width:100% 拉伸
  canvas.clientWidth = 1200;
  canvas.__poroTlPaint();
  assert.ok(calls.length > n1, '宽度变化后应重画');
});

ok('窄窗口仍保底 180px 高, 宽窗口封顶 300px', () => {
  const narrow = makeEnv(500);
  vm.runInContext('drawTimelineChart', narrow.context)(narrow.chart)(narrow.canvas);
  assert.strictEqual(narrow.canvas.style.height, '180px', '500*0.29=145 应被抬到 180');

  const wide = makeEnv(1600);
  vm.runInContext('drawTimelineChart', wide.context)(wide.chart)(wide.canvas);
  assert.strictEqual(wide.canvas.style.height, '300px', '1600*0.29=464 应被压到 300');
});

ok('canvas 仍是 .rv-canvas(宽度 100%), 不改成固定像素', () => {
  assert.ok(/\.rv-canvas\s*\{[^}]*width:\s*100%/.test(css), '宽度仍由容器决定');
});

console.log('\n' + pass + ' passed');
