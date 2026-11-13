// 1.5.153 —— BinanceGUI 全软件接管断言（v4.css §28）
// §27 之后, v4 头部的旧令牌层 (--surface-*/--line-*/--ink-*/--brand/--pos/neg/warn) 也换成 BinanceGUI 原值。
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, 'renderer/css/v4.css'), 'utf8');
const s28 = css.slice(css.indexOf('28. BinanceGUI 全软件接管'));
let fail = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) fail++; };

// 浅色旧层令牌
const lightVals = [
  '--surface-canvas: #EFF3F8', '--surface-1: #FFFFFF', '--surface-3: #EDF1F6',
  '--line: rgba(0, 0, 0, .10)', '--ink-1: #111823', '--ink-2: #48566A', '--ink-3: #7C8CA0',
  '--brand: #2065D6', '--brand-deep: #1A56B8',
  '--pos: #0E8A4F', '--neg: #D02F27', '--warn: #A9740B',
];
for (const v of lightVals) ok('浅色 ' + v, s28.includes(v));

// 暗色旧层令牌
const darkVals = [
  '--surface-canvas: #0A0D12', '--surface-1: #12171F', '--surface-3: #1A202A', '--surface-inset: #0F141B',
  '--line: rgba(255, 255, 255, .09)', '--ink-1: #E6EDF5', '--ink-2: #8B97A8', '--ink-3: #5A6675',
  '--brand: #4F8FF7', '--brand-deep: #7AA9F9',
  '--pos: #26C281', '--neg: #EF5350', '--warn: #E5A03C',
  '--e3: 0 10px 30px rgba(0, 0, 0, .35)',
];
for (const v of darkVals) ok('暗色 ' + v, s28.includes(v));

// 旧青蓝已退役（§28 后文件里 :root 的 --brand 不应再是 #1f7ba6 生效值——头部定义被 §28 覆盖）
ok('全站过渡规则', s28.includes('button, .nav-item, input, select, textarea {'));
ok('theme-a 保留', css.includes('body.theme-a { --brand: #6d55c9'));
ok('§28 无渐变', !s28.includes('linear-gradient'));
ok('§28 无 750/800 字重', !/font-weight:\s*(750|800)/.test(s28));

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
