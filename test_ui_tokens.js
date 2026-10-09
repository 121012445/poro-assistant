'use strict';
// UI 设计令牌门禁 —— 把"看得舒服"变成可回归的硬指标。
//
// 为什么需要它：2026-10-02 的 UI 重构里，没有任何一条现有测试能发现这两个问题，
// 而它们恰恰是"界面看着不舒服"的直接原因：
//   1. 首页 6 张统计卡用 `:nth-child(6n+1..6)` **按位置**轮换 6 种文字色。
//      "总游戏时长"是青、"场均用时"是蓝，仅仅因为它排在第几张 —— 位置不表达语义，
//      6 张相邻卡片 6 种色就是纯噪音。
//   2. `--text-muted` 用 #8a9bad，在白底上只有 2.85:1、页面底上 2.63:1，
//      全站 129 处小字低于 WCAG AA 4.5:1 —— 屏幕上就是"发灰看不清"。
//
// 两者都不会报错、npm test 全绿，只能靠人眼看，所以必须写成门禁。
// 逃生口：`// ui-tokens-ok: 原因`

const fs = require('fs');
const path = require('path');

const CSS_DIR = path.join(__dirname, 'renderer', 'css');
const FILES = ['style.css', 'premium.css', 'extras.css', 'dark.css'];
const read = f => fs.readFileSync(path.join(CSS_DIR, f), 'utf8');

// ============ 对比度（WCAG 2.x） ============
function toRgb(v) {
  v = String(v || '').trim();
  let m = v.match(/^#([0-9a-f]{3})$/i);
  if (m) return [0, 1, 2].map(i => parseInt(m[1][i] + m[1][i], 16));
  m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  m = v.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}
function luminance(rgb) {
  const c = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(fg, bg) {
  const a = toRgb(fg), b = toRgb(bg);
  if (!a || !b) return null;
  const l1 = luminance(a), l2 = luminance(b);
  return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
}

// 剥掉注释（/* … */），避免注释里的选择器/数字造成误判
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function extractBlock(css, headerRe) {
  const m = css.match(headerRe);
  if (!m) return null;
  return m[1];
}

function extractVars(body) {
  const vars = {};
  for (const seg of String(body).split(/[;\n]/)) {
    const m = seg.match(/^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/);
    if (m && !m[2].startsWith('/*')) vars[m[1]] = m[2].trim();
  }
  return vars;
}

// ============ 门禁 1：灰阶对比度（浅色 + 深色） ============
function checkGrayContrast(css, darkCss, out) {
  const root = extractVars(extractBlock(stripComments(css), /:root\s*\{([\s\S]*?)\}/) || '');
  const req = ['--bg-card', '--bg-primary', '--text-primary', '--text-secondary', '--text-muted'];
  const missing = req.filter(k => !root[k]);
  if (missing.length) { out.push(['FAIL', ':root 缺少 ' + missing.join(' / ')]); return; }

  for (const fg of ['--text-primary', '--text-secondary', '--text-muted']) {
    for (const bg of ['--bg-card', '--bg-primary']) {
      const r = contrast(root[fg], root[bg]);
      if (r === null) { out.push(['FAIL', `${fg}=${root[fg]} 颜色无法解析`]); continue; }
      if (r < 4.5) out.push(['FAIL', `浅色 ${fg} (${root[fg]}) 在 ${bg} 上仅 ${r}:1，低于 WCAG AA 4.5:1`]);
      else out.push(['PASS', `浅色 ${fg} / ${bg} = ${r}:1`]);
    }
  }

  // 深色主题同样要达标（注意：变量定义在 body.dark 上，不在 :root）
  const dBody = extractBlock(stripComments(darkCss), /body\.dark\s*\{([\s\S]*?)\}/);
  if (!dBody) { out.push(['FAIL', 'dark.css 缺少 body.dark 变量块']); return; }
  const dv = extractVars(dBody);
  const dMissing = ['--bg-card', '--bg-primary', '--text-muted'].filter(k => !dv[k]);
  if (dMissing.length) { out.push(['FAIL', 'body.dark 缺少 ' + dMissing.join(' / ')]); return; }
  for (const bg of ['--bg-card', '--bg-primary']) {
    const r = contrast(dv['--text-muted'], dv[bg]);
    if (r === null) { out.push(['FAIL', `深色 --text-muted (${dv['--text-muted']}) 解析失败`]); continue; }
    if (r < 4.5) out.push(['FAIL', `深色 --text-muted (${dv['--text-muted']}) 在 ${bg} 上仅 ${r}:1`]);
    else out.push(['PASS', `深色 --text-muted / ${bg} = ${r}:1`]);
  }
}

// ============ 门禁 2：禁止"按位置轮换配色" ============
function checkNoPositionalPalette(css, out, file) {
  const src = stripComments(css);
  // 逃生口：`ui-tokens-ok(选择器[,选择器]): 原因` **只豁免列出的选择器**；
  // 写成不带括号的 `ui-tokens-ok: 原因` 则退化为整文件豁免（旧写法，保留兼容）。
  // 2026-10-02：原先只有整文件豁免，等于一处知情保留就让整份 CSS 失去保护
  // （premium.css 加了统计卡豁免后，"其余规则无位置配色"这条正面证据就没了）。
  // 提升到选择器级后，豁免范围与知情决策的范围一致。
  // 一个文件里可以写多条标记，逐条收集（`exec` 只取第一条会漏）。
  const exemptSels = new Set();
  const exemptReasons = [];
  let exemptAll = false;
  for (const e of css.matchAll(/ui-tokens-ok\s*(?:\(([^)]+)\))?\s*:\s*([^\n*]+)/g)) {
    if (e[1]) e[1].split(',').forEach(s => exemptSels.add(s.trim()));
    else exemptAll = true;
    exemptReasons.push(e[2].trim());
  }
  const exemptReason = [...new Set(exemptReasons)].join('; ');
  const isExempt = sel => exemptAll || exemptSels.has(sel);
  const byBase = new Map();
  // 2026-10-02 修正：原正则要求 `:nth-child(...)` 后**紧跟** `{`，只能抓
  // `.a:nth-child(1){color:x}` 那一种写法。而 `.a:nth-child(1) b{color:x}`
  //（给后代元素设色）整类逃逸 —— extras.css 那套六色轮换正是这个形状，
  // 当天是靠人工看出来的、不是门禁抓到的，说明门禁当时形同虚设。
  // 这里把 `:nth-child(...)` 与 `{` 之间的选择器片段一并纳入匹配。
  const re = /([.#][\w-]+):nth-child\([^)]*\)[^{}]*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const cm = m[2].match(/(?:^|;|\s)color\s*:\s*([^;]+)/);
    if (!cm) continue;                       // 只管设置"文字色"的规则
    if (!byBase.has(m[1])) byBase.set(m[1], new Set());
    byBase.get(m[1]).add(cm[1].trim());
  }
  let found = 0;
  const excused = [];
  for (const [base, colors] of byBase) {
    if (colors.size >= 3) {
      if (isExempt(base)) { excused.push(`${base}(${colors.size}色)`); continue; }
      found++;
      out.push(['FAIL', `${file}: ${base}:nth-child() 按位置分配了 ${colors.size} 种文字色（${[...colors].join(' / ')}）` +
        ' —— 位置不表达语义，相邻同族卡片多色即视觉噪音。改成统一色，语义色只给真有含义的值']);
    }
  }
  if (excused.length) {
    out.push(['PASS', `${file}: 位置配色已豁免 ${excused.join(', ')} —— ${exemptReason}` +
      (found ? '' : '（该文件其余规则没有按位置配色）')]);
  }
  if (!found && !excused.length && file === 'premium.css') out.push(['PASS', '没有按位置轮换文字色']);
}

// ============ 门禁 3：字号下限 ============
function checkFontFloor(css, out, file) {
  const src = stripComments(css);
  const tooSmall = [];
  for (const m of src.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/g)) {
    if (parseFloat(m[1]) < 9) tooSmall.push(m[0]);
  }
  if (tooSmall.length) out.push(['FAIL', `${file} 出现 ${tooSmall.length} 处 < 9px 字号（${tooSmall.slice(0, 3).join(', ')}）—— 小于 9px 在 Windows 高 DPI 下无法辨认`]);
}

// ============ 门禁 4：排版档位令牌齐全 ============
function checkTypeScale(css, out) {
  const root = extractVars(extractBlock(stripComments(css), /:root\s*\{([\s\S]*?)\}/) || '');
  const need = ['--fs-xs', '--fs-sm', '--fs-md', '--fs-base', '--fs-lg', '--fs-xl', '--fs-2xl', '--fs-3xl'];
  const missing = need.filter(k => !root[k]);
  if (missing.length) out.push(['FAIL', ':root 缺少排版档位令牌 ' + missing.join(' / ') + ' —— 字号必须收敛到固定几档']);
  else out.push(['PASS', '排版档位令牌齐全（' + need.length + ' 档）']);
}

// ============ 门禁 5：焦点环统一 ============
function checkFocusRing(css, out) {
  const root = extractVars(extractBlock(stripComments(css), /:root\s*\{([\s\S]*?)\}/) || '');
  if (!root['--focus-ring']) out.push(['FAIL', ':root 缺少 --focus-ring（键盘焦点态应全站统一一处）']);
  else out.push(['PASS', '焦点环令牌存在']);
}

// ============ 运行 ============
function runAll(cssMap) {
  const out = [];
  const premium = cssMap['premium.css'];
  const dark = cssMap['dark.css'];
  checkGrayContrast(premium, dark, out);
  // 位置配色检查覆盖全部 4 个文件。2026-10-02 的教训：上一轮只查 premium.css，
  // 结果 extras.css 里那套 `.home-fun-card:nth-child(6n+1..6)` 六色轮换整轮逃逸，
  // 修完统计卡、画像页照样花花绿绿。
  for (const f of FILES) checkNoPositionalPalette(cssMap[f] || '', out, f);
  for (const f of FILES) checkFontFloor(cssMap[f], out, f);
  checkTypeScale(premium, out);
  checkFocusRing(premium, out);
  return out;
}

const cssMap = {};
for (const f of FILES) cssMap[f] = read(f);

// ---- 自检：合成样本必须先被自己的规则抓到，否则门禁形同虚设 ----
const SELFTEST = [
  {
    name: '低对比度灰阶',
    expect: 'FAIL',
    css: ':root{--bg-card:#ffffff;--bg-primary:#f3f6fa;--text-primary:#21384f;--text-secondary:#5b7289;--text-muted:#8a9bad;}',
    dark: 'body.dark{--bg-card:#1e222c;--bg-primary:#14161c;--text-muted:#76809a;}',
  },
  {
    name: '按位置轮换文字色',
    expect: 'FAIL',
    css: ':root{--bg-card:#fff;--bg-primary:#fff;--text-primary:#111;--text-secondary:#222;--text-muted:#333;--fs-xs:1px;--fs-sm:1px;--fs-md:1px;--fs-base:1px;--fs-lg:1px;--fs-xl:1px;--fs-2xl:1px;--fs-3xl:1px;--focus-ring:0;}' +
      '.a:nth-child(6n+1){color:#111;}.a:nth-child(6n+2){color:#222;}.a:nth-child(6n+3){color:#333;}',
    dark: 'body.dark{--bg-card:#000;--bg-primary:#000;--text-muted:#fff;}',
  },
  {
    name: '缺排版档位',
    expect: 'FAIL',
    css: ':root{--bg-card:#fff;--bg-primary:#fff;--text-primary:#111;--text-secondary:#222;--text-muted:#333;}',
    dark: 'body.dark{--bg-card:#000;--bg-primary:#000;--text-muted:#fff;}',
  },
];

let selfFailed = 0;
for (const t of SELFTEST) {
  const res = runAll({ 'premium.css': t.css, 'dark.css': t.dark, 'style.css': '', 'extras.css': '' });
  const got = res.some(([s]) => s === 'FAIL') ? 'FAIL' : 'PASS';
  if (got !== t.expect) {
    selfFailed++;
    console.log(`  [自检失败] ${t.name}: 期望被拒绝，实际 ${got}`);
    res.filter(([s]) => s === 'FAIL').slice(0, 2).forEach(([, m]) => console.log('      ' + m));
  } else {
    console.log(`  [自检通过] ${t.name} -> 被正确拦截`);
  }
}

const results = runAll(cssMap);
const fails = results.filter(([s]) => s === 'FAIL');
console.log('');
console.log('=== UI 令牌门禁 ===');
results.forEach(([s, m]) => console.log(`  ${s === 'FAIL' ? '[FAIL]' : ' ok  '} ${m}`));
console.log('');
if (selfFailed) {
  console.log(`自检 ${selfFailed} 项未通过 —— 门禁自身失效，先修门禁。`);
  process.exit(1);
}
if (fails.length) {
  console.log(`UI 令牌检查未通过：${fails.length} 项（自检 ${SELFTEST.length} 项正常）。`);
  process.exit(1);
}
console.log(`UI 令牌检查通过（${results.length} 项断言，自检 ${SELFTEST.length} 项均能拦截）。`);
