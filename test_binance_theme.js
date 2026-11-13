// 1.5.152 —— BinanceGUI 令牌接管断言（v4.css §27）
// 令牌名不变、值整体换成 BinanceGUI 原版；明暗双主题 + 字体栈。
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, 'renderer/css/v4.css'), 'utf8');
const s27 = css.slice(css.indexOf('27. BinanceGUI 令牌接管'));
let fail = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) fail++; };

// 暗色主题（BinanceGUI 默认深色原值）
const darkVals = [
  ['--bg-primary: #0A0D12', 'bg0'],
  ['--bg-secondary: #0D1117', 'bg1'],
  ['--bg-card: #12171F', 'bg2'],
  ['--bg-hover: #1A202A', 'bg3'],
  ['--border: rgba(255, 255, 255, .09)', 'l1'],
  ['--border-hover: rgba(255, 255, 255, .17)', 'l3'],
  ['--text-primary: #E6EDF5', 'text1'],
  ['--text-secondary: #8B97A8', 'text2'],
  ['--text-muted: #5A6675', 'text3'],
  ['--accent: #4F8FF7', 'blue'],
  ['--positive: #26C281', 'green/up'],
  ['--negative: #EF5350', 'red/down'],
  ['--warning: #E5A03C', 'yellow'],
  ['--data-gold: #E5A03C', 'gold'],
];
for (const [v, label] of darkVals) ok('暗色 ' + label + ' ' + v, s27.includes(v));

// 浅色主题（BinanceGUI light 原值）
const lightVals = [
  ['--bg-primary: #EFF3F8', 'bg0'],
  ['--bg-card: #FFFFFF', 'bg1'],
  ['--border: rgba(0, 0, 0, .10)', 'l1'],
  ['--text-primary: #111823', 'text1'],
  ['--text-secondary: #48566A', 'text2'],
  ['--text-muted: #7C8CA0', 'text3'],
  ['--accent: #2065D6', 'blue'],
  ['--positive: #0E8A4F', 'green'],
  ['--negative: #D02F27', 'red'],
  ['--warning: #A9740B', 'yellow'],
];
for (const [v, label] of lightVals) ok('浅色 ' + label + ' ' + v, s27.includes(v));

// 字体栈
ok('body BinanceGUI 字体栈', s27.includes('font-family: -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif'));
ok('mono 栈 Cascadia', s27.includes('--mono: ui-monospace, "Cascadia Mono", Consolas, monospace'));
ok('#page-live mono 指向全局', s27.includes('--data-mono: var(--mono)'));
ok('阵营色对齐语义色', s27.includes('--live-blue: var(--data-blue)') && s27.includes('--live-red: var(--negative)'));
// 结构: body.dark 块存在且在 §27 内
ok('body.dark 块在 §27', /\/\* ---- 暗色主题[^]*?body\.dark \{/.test(s27));
// 令牌未被重命名: §27 只赋值原令牌名
ok('未引入新令牌名(除 --mono)', !/--binance|--bg0:|--l1:/.test(s27));

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
