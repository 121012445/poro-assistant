// ============================================================
// 渲染层「未定义全局调用」静态守卫
// ============================================================
// 为什么需要这条: 渲染层是多个 <script> 共享一个全局作用域, 浏览器没有编译期检查。
// 调用一个谁都没定义的名字不会在加载期报错, 只在**运行时**炸 ReferenceError;
// 而 init() 之类的回调里, 一行抛错会静默掐断后面全部初始化 —— 界面照画、日志无异常,
// 看起来像"功能没做出来"而不是"代码写错了"。(1.5.0/1.5.1 的 loadAramBalance 就是这类)
//
// 现有守卫的盲区:
//   test_dangling.js  —— 只查 HTML 内联事件 -> 函数, 不查 JS -> JS 全局调用
//   test_split_order.js — 只查加载期 TDZ, 而 init() 是回调, 加载期不跑
//
// 本测试**按页面分组**校验: index.html 的脚本共享一个作用域, 独立窗口页面
// (overlay.html / augment-overlay.html) 各自独立 —— 只做全库并集会把
// "独立页面调用了它没加载的函数"这类真问题掩盖掉。
//
// 误报逃生口: 某行确属合法可选依赖时, 在该行或上一行写
//   // undef-ok: 原因
// (与 test_test_wiring.js 的 opt-out 同理: 就地声明, 不用集中白名单)
// ============================================================
const fs = require('fs');
const path = require('path');

const root = __dirname;
const rendererDir = path.join(root, 'renderer');

// ---------- 1. 复用 test_split_order.js 的词法器 ----------
// 绝对不能自己再写一版: 正则字面量里的引号 (如 utils.js 的 /[&<>'"]/g)
// 会把自制词法器带偏, 导致整个文件的定义被判成"未定义"。
function loadBlankLiterals() {
  const sos = fs.readFileSync(path.join(root, 'test_split_order.js'), 'utf8');
  const a = sos.indexOf('const REGEX_OK_AFTER');
  const b = sos.indexOf('\n// ---------- 3.');
  if (a < 0 || b < 0 || b <= a) {
    console.error('[FAIL] 无法从 test_split_order.js 抽取 blankLiterals');
    console.error('       该文件的区块标记已变动, 请同步更新本测试的抽取边界。');
    process.exit(1);
  }
  return new Function(sos.slice(a, b) + '\nreturn blankLiterals;')();
}
const blankLiterals = loadBlankLiterals();

// ---------- 2. 收集所有页面及其脚本 ----------
const pages = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.html?$/i.test(e.name)) continue;
    const html = fs.readFileSync(p, 'utf8');
    const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)]
      .map(m => m[1].split('?')[0])
      .filter(s => !/^(https?:)?\/\//.test(s))
      .map(s => path.resolve(path.dirname(p), s));
    pages.push({ name: path.relative(root, p), scripts });
  }
})(rendererDir);

if (!pages.length) { console.error('[FAIL] renderer/ 下没找到任何 HTML 页面'); process.exit(1); }

// ---------- 3. 定义名 / 调用名 收集 ----------
const DEF_PATTERNS = [
  /(?:^|[\s{;(,])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /(?:^|[\s{;,(])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  /(?:^|[\s{;,])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[,;]/g,
  /(?:^|[\s{;,])([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)/g,
  /class\s+([A-Za-z_$][\w$]*)/g,
  /window\.([A-Za-z_$][\w$]*)\s*=/g,
  /(?:^|[\s{;,])([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g
];

function collect(file) {
  const src = blankLiterals(fs.readFileSync(file, 'utf8'));
  const defs = new Set();
  for (const re of DEF_PATTERNS) {
    for (const m of src.matchAll(re)) defs.add(m[1]);
  }
  // 形参 / 解构形参 / catch 参数
  for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    m[1].split(',').forEach(a => {
      a = a.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(a)) defs.add(a);
    });
  }
  for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) defs.add(m[1]);
  // 函数/对象方法的短写法 (含 async)
  for (const m of src.matchAll(/(?:^|[\n{;,])\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g)) defs.add(m[1]);
  return { src, defs };
}

const KEYWORDS = new Set(('if else for while do switch case return typeof instanceof in of new delete void this try catch finally throw '
  + 'function class const let var true false null undefined await async yield super import export default break continue').split(' '));
const BUILTIN = new Set(('Object Array String Number Boolean Math JSON Date RegExp Error TypeError RangeError Promise Map Set WeakMap WeakSet Symbol Proxy Reflect BigInt '
  + 'parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI eval structuredClone queueMicrotask '
  + 'setTimeout setInterval clearTimeout clearInterval requestAnimationFrame cancelAnimationFrame fetch console alert confirm prompt '
  + 'document window navigator location localStorage sessionStorage history screen performance matchMedia getComputedStyle '
  + 'AbortController URL URLSearchParams Blob File FileReader FormData Headers Request Response TextEncoder TextDecoder Event CustomEvent '
  + 'MutationObserver IntersectionObserver ResizeObserver Image Audio Worker BroadcastChannel Intl require module exports '
  + 'atob btoa webkitRequestAnimationFrame').split(' '));

const OPT_OUT = /\/\/\s*undef-ok\b/;

function lineHasOptOut(lines, idx) {
  return OPT_OUT.test(lines[idx] || '') || OPT_OUT.test(lines[idx - 1] || '');
}

// ---------- 4. 检查逻辑 ----------
// 注意: 传入的 line 必须是 blankLiterals 之后的"语法骨架", 字符串字面量已被清成空格。
// 所以 typeof 那条**不能**写成 /typeof X === 'function'/ —— 带引号的 'function'
// 已经被清空了, 那样写永远不会命中 (第一版就栽在这)。只认 `typeof X ===` 这个前缀。
const CALL_RE = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
const TYPEOF_RE = /\btypeof\s+([A-Za-z_$][\w$]*)\s*===/;

// 成员表达式 (typeof p.rank === ...) 不会命中: 捕获名后面是 '.' 而非 '==='
function analyze(loaded, defs) {
  const hits = [];
  let callSites = 0;
  for (const [file, { lines }] of loaded) {
    lines.forEach((line, i) => {
      if (lineHasOptOut(lines, i)) return;
      for (const m of line.matchAll(CALL_RE)) {
        const nm = m[2];
        callSites++;
        if (KEYWORDS.has(nm) || BUILTIN.has(nm) || defs.has(nm)) continue;
        hits.push({ kind: 'undef-call', name: nm, file, line: i + 1, text: line.trim().slice(0, 110) });
      }
      const t = TYPEOF_RE.exec(line);
      if (t && !BUILTIN.has(t[1]) && !defs.has(t[1])) {
        hits.push({ kind: 'dead-guard', name: t[1], file, line: i + 1, text: line.trim().slice(0, 110) });
      }
    });
  }
  return { hits, callSites };
}

// ---------- 5. 自检: 守卫必须真的抓得住它要防的那类错误 ----------
// 没有这段, "测试通过"可能只是因为它什么也没检查。
(function selfTest() {
  const synthetic = blankLiterals([
    'function realHelper() { return 1; }',
    'async function boot() {',
    '  realHelper();',
    '  loadAramBalance();',
    "  const t = typeof balanceTipFor === 'function' ? 1 : 0;",
    '}'
  ].join('\n'));
  const r = analyze(new Map([['synthetic.js', { lines: synthetic.split('\n') }]]), new Set(['realHelper', 'boot']));
  const kinds = r.hits.map(h => h.kind).sort().join(',');
  if (kinds !== 'dead-guard,undef-call') {
    console.error('[FAIL] 守卫自检未通过 —— 检测逻辑退化, 抓不住目标错误。');
    console.error('       期望 dead-guard,undef-call, 实际: ' + (kinds || '(什么都没抓到)'));
    console.error('       已定义名不会被误报: realHelper/boot 均应被放行');
    process.exit(1);
  }
})();

// ---------- 6. 按页面断言 ----------
const fail = [];
let pagesChecked = 0, filesChecked = 0, callSites = 0, hitsTotal = 0;

for (const page of pages) {
  const defs = new Set();
  const files = page.scripts.filter(p => {
    const ok = fs.existsSync(p);
    if (!ok) fail.push(`${page.name}: 引用的脚本不存在 -> ${path.relative(root, p)}`);
    return ok;
  });
  if (!files.length) continue;

  const loaded = new Map();
  for (const f of files) {
    const { src, defs: d } = collect(f);
    loaded.set(f, { lines: src.split('\n') });
    for (const n of d) defs.add(n);
    filesChecked++;
  }
  pagesChecked++;

  const { hits, callSites: cs } = analyze(loaded, defs);
  callSites += cs;
  hitsTotal += hits.length;
  for (const h of hits) {
    const rel = path.relative(root, h.file);
    fail.push(h.kind === 'undef-call'
      ? `${rel}:${h.line} 调用了未定义的 ${h.name}()  [${page.name}]\n        ${h.text}`
      : `${rel}:${h.line} typeof ${h.name} 守卫恒为假 -> 该分支永远不会执行 (静默死功能)  [${page.name}]\n        ${h.text}`);
  }
}

if (fail.length) {
  console.error('渲染层存在 ' + fail.length + ' 处未定义全局调用:');
  fail.forEach(f => console.error('  [FAIL] ' + f));
  console.error('');
  console.error('修法: 补函数体, 或摘除调用; 确属可选依赖就就地写 // undef-ok: 原因');
  process.exit(1);
}

console.log('渲染层未定义全局调用测试通过 (守卫自检 OK ・ ' + pagesChecked + ' 个页面 / ' + filesChecked + ' 个脚本 / ' + callSites + ' 个调用点, 全部有定义)');
