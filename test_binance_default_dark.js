// 1.5.154: §28 注释终止 bug 修复 + 默认深色主题 + 胜负语义色 token 化
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname);
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('  ok', name); } else { fail++; console.error('  FAIL', name); } }

// ---- 通用注释剥离器 (状态机, 模拟 CSS/JS 解析) ----
function stripComments(src) {
  let out = '', i = 0, n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) { i = n; break; } // 未闭合注释: 到文件尾
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") { // 跳过字符串里的 /* */
      const q = c; out += c; i++;
      while (i < n) { out += src[i]; if (src[i] === '\\') { out += src[i + 1] || ''; i += 2; continue; } if (src[i] === q) { i++; break; } i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

const cssV4 = fs.readFileSync(path.join(R, 'renderer/css/v4.css'), 'utf8');
const cssStyle = fs.readFileSync(path.join(R, 'renderer/css/style.css'), 'utf8');
const cssPremium = fs.readFileSync(path.join(R, 'renderer/css/premium.css'), 'utf8');
const cssPolish = fs.readFileSync(path.join(R, 'renderer/css/ui-polish.css'), 'utf8');
const cssDark = fs.readFileSync(path.join(R, 'renderer/css/dark.css'), 'utf8');
const jsApp = fs.readFileSync(path.join(R, 'renderer/js/app.js'), 'utf8');

console.log('[A] §28 注释终止 bug 修复');
{
  // 修复前: 注释里 "--bg-*/--text-*" 含 "*/" 提前终止, 垃圾文本吞掉 :root 规则
  const v4NoComments = stripComments(cssV4);
  ok(v4NoComments.includes('--ink-1: #111823'), '剥注释后 §28 浅色 --ink-1 #111823 存活');
  ok(v4NoComments.includes('--brand: #2065D6'), '剥注释后 §28 浅色 --brand #2065D6 存活');
  ok(v4NoComments.includes('--surface-canvas: #0A0D12'), '剥注释后 §28 暗色 --surface-canvas 存活');
  ok(v4NoComments.includes('--ink-1: #E6EDF5'), '剥注释后 §28 暗色 --ink-1 存活');
  // 统计顶层 :root 规则中带 --ink-1 的应有 2 条 (旧头 + §28)
  const rootInk1 = (v4NoComments.match(/--ink-1:/g) || []).length;
  ok(rootInk1 >= 4, `--ink-1 声明数 ≥4 (浅旧/浅新/暗旧/暗新), 实际 ${rootInk1}`);
  ok(!cssV4.includes('--bg-*/--text-*'), '注释内不再含 "--bg-*/" 模式');
}

console.log('[B] 默认深色主题');
{
  ok(jsApp.includes("c: { mode: 'dark', accent: 'blue' },"), '预设 c(默认) = 深色');
  ok(jsApp.includes("if (st && st.mode === 'light') st = { mode: 'dark', accent: st.accent };"), '存量浅色偏好迁移为深色');
  ok(jsApp.includes("applyThemeState(st || { mode: 'dark', accent: 'blue' }, persist);"), '兜底默认 = 深色');
  // 迁移必须发生在 applyUiTheme 内 (st 定义之后)
  const idxSt = jsApp.indexOf('let st = LEGACY_UI_THEME[v];');
  const idxMig = jsApp.indexOf("if (st && st.mode === 'light')");
  ok(idxSt > 0 && idxMig > idxSt, '迁移逻辑位于 st 赋值之后');
}

console.log('[C] 胜负语义色 token 化');
{
  ok(!cssStyle.includes('#2a5fa8') && !cssStyle.includes('#a82a2a'), 'style.css 旧蓝红字退役');
  ok(!cssStyle.includes('#3479d1') && !cssStyle.includes('#d13a3a'), 'style.css 旧蓝红边退役');
  ok(cssStyle.includes('.ako-win .ako-result { color: var(--data-blue); }'), 'ako 胜 = --data-blue');
  ok(cssStyle.includes('.ako-loss .ako-result { color: var(--negative); }'), 'ako 负 = --negative');
  ok(cssStyle.includes('.ako-card.ako-win { border-color: color-mix(in srgb, var(--data-blue) 45%, transparent); }'), 'ako 胜边框 color-mix');
  ok(cssStyle.includes('.lv-blue .lv-team-head { color: var(--data-blue); }'), 'lv 蓝队 = --data-blue');
  ok(cssPremium.includes('body.dark .ako-loss .ako-result, body.dark .ak-loss .ak-result { color: var(--negative); }'), 'dark ako 负字 = --negative');
  ok(!cssPolish.includes('#8fa1bd'), 'dark 导航旧字退役');
  ok(cssPolish.includes('body.dark .nav-item { color: var(--text-secondary); }'), 'dark 导航 = --text-secondary');
  ok(cssPolish.includes('linear-gradient(135deg, #7AA9F9, #2065D6)'), '主题点 t-c = BinanceGUI 双蓝');
  ok(!cssDark.includes('color: #e2e6ee;'), 'dark body 旧字面字色退役');
  ok(cssDark.includes('background: var(--bg-primary);') && cssDark.includes('color: var(--text-primary);'), 'dark body 走令牌');
}

console.log('[D] 版本与缓存');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(R, 'package.json'), 'utf8'));
  ok(pkg.version === '1.5.154', 'package.json = 1.5.154');
  const html = fs.readFileSync(path.join(R, 'renderer/index.html'), 'utf8');
  ok(html.includes('v4.css?v=2026111334'), 'v4.css 缓存参数 1334');
  ok(html.includes('js/app.js?v=2026111334'), 'app.js 缓存参数 1334');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
