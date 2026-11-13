// 1.5.151 —— BinanceGUI 级质感层断言（v4.css §26）
// 对标 BinanceGUI 四条质感来源: mono 数字 / 微过渡 / 低饱和胶囊 / 负字距。
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, 'renderer/css/v4.css'), 'utf8');
const style = fs.readFileSync(path.join(__dirname, 'renderer/css/style.css'), 'utf8');
let fail = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) fail++; };

// A. 全局质感
ok('body antialiased', css.includes('-webkit-font-smoothing: antialiased'));
ok('body tabular-nums 全局', /body\s*{[^}]*font-variant-numeric:\s*tabular-nums/.test(css));
ok('nav-item 微过渡', css.includes('.nav-item { transition: background-color .12s ease'));
ok('滚动条半透明化', css.includes('::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--text-muted) 30%'));

// B. mono 数字系统
ok('mono 令牌定义', css.includes('--data-mono: ui-monospace'));
for (const sel of ['.lp-winrate', '.lp-kda', '.ri-kda', '.ri-date', '.lp-team-rate']) {
  ok('mono 覆盖 ' + sel, new RegExp('#page-live \\.' + sel.slice(1).replace(/[-/]/g, '\\$&') + ',').test(css) || css.includes('#page-live ' + sel + ','));
}
ok('胜率负字距', css.includes('#page-live .lp-winrate { letter-spacing: -.02em; }'));

// C. 胜/负 胶囊
ok('ri-result 胶囊化', css.includes('#page-live .ri-result {') && css.includes('min-width: 17px'));
ok('胜胶囊 14% 底', css.includes('.ri-win .ri-result { color: var(--data-blue); background: color-mix(in srgb, var(--data-blue) 14%'));
ok('负胶囊 13% 底', css.includes('.ri-loss .ri-result { color: var(--negative); background: color-mix(in srgb, var(--negative) 13%'));

// D. 行底减淡
ok('胜行 4% 大底', css.includes('.ri-win { background: color-mix(in srgb, var(--data-blue) 4%'));
ok('负行 4% 大底', css.includes('.ri-loss { background: color-mix(in srgb, var(--negative) 4%'));

// E. 微过渡 + hover
ok('lp-row 过渡含背景', css.includes('#page-live .lp-row { transition: border-color .14s ease, background-color .14s ease; }'));
ok('lp-row hover 抬升', css.includes('#page-live .lp-row:hover { background: color-mix(in srgb, var(--text-primary) 3%, var(--bg-card)); }'));
ok('ri-card hover', css.includes('#page-live .ri-card:hover { background-color: color-mix(in srgb, var(--accent) 6%'));

// 门禁: 不引入渐变、不加粗超 600 (§26 新增段落内)
const s26 = css.slice(css.indexOf('26. BinanceGUI 级质感层'));
ok('§26 无渐变', !s26.includes('linear-gradient') && !s26.includes('radial-gradient'));
ok('§26 字重 ≤600', !/font-weight:\s*(7|8)\d\d/.test(s26));
// style.css 既有 750/800 不在本次范围, 但确认我们没把它们加回来
ok('无新增 750/800 于 v4', !/(font-weight:\s*(750|800))/.test(s26));

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
