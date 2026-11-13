// 1.5.155: BinanceGUI 数字字体体系全软件化 (§29)
const fs = require('fs');
const path = require('path');
const R = __dirname;
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ok', n); } else { fail++; console.error('  FAIL', n); } };

function stripComments(src) {
  let out = '', i = 0; const n = src.length;
  while (i < n) {
    if (src[i] === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (src[i] === '"' || src[i] === "'") { const q = src[i]; out += src[i++]; while (i < n) { out += src[i]; if (src[i] === '\\') { out += src[i + 1] || ''; i += 2; continue; } if (src[i] === q) { i++; break; } i++; } continue; }
    out += src[i++];
  }
  return out;
}

const raw = fs.readFileSync(path.join(R, 'renderer/css/v4.css'), 'utf8');
const css = stripComments(raw);

console.log('[A] §29 存在且未被注释吞掉');
{
  ok(css.includes('--font-ui:'), ':root --font-ui 存活');
  ok(css.includes('--font-data: var(--mono);'), ':root --font-data = var(--mono)');
  ok(css.includes('body { font-family: var(--font-ui); }'), 'body 走 --font-ui');
  ok(raw.includes('29. BinanceGUI 数字字体体系'), '§29 标题存在');
}

console.log('[B] 已知数值元素等宽');
{
  const must = ['.stat-card-val', '.home-winrate-val', '.rank-card-record', '.mmr-chip',
    '.friend-row-count', '.home-champ-row-rank', '.home-champ-row-count', '.stat-split',
    '.ako-big', '.ako-sub', '.ako-stat', '.ako-info', '.home-name', '.friend-row-name',
    '.lp-winrate', '.lp-kda', '.ri-kda', '.ri-date'];
  must.forEach(cls => ok(css.includes(cls), `${cls} 在 §29 清单中`));
  // B 段必须整块设置 font-family: var(--font-data)
  const segB = stripComments(raw.slice(raw.indexOf('/* B. 已知数值元素'), raw.indexOf('/* C. 通用模式')));
  ok(/font-family: var\(--font-data\)/.test(segB), 'B 段使用 --font-data');
  ok(/font-variant-numeric: tabular-nums/.test(segB), 'B 段 tabular-nums');
}

console.log('[C] 通用数值类模式');
{
  ['[class*="-val"]', '[class*="-count"]', '[class*="-kda"]', '[class*="-rate"]',
    '[class*="-score"]', '[class*="-record"]', '[class*="-winrate"]'].forEach(sel => ok(css.includes(sel), `${sel} 存在`));
  // 必须带上 font-family 而不是只 tabular
  const segC = stripComments(raw.slice(raw.indexOf('/* C. 通用模式'), raw.indexOf('/* D. 数据表格')));
  ok(/font-family: var\(--font-data\)/.test(segC), 'C 段设 font-family');
}

console.log('[D] 数据表格 + 字重封顶');
{
  ok(/table td \{[^}]*font-family: var\(--font-data\)/.test(css), 'table td 等宽');
  ok(/table td, table th \{ font-variant-numeric: tabular-nums; \}/.test(css), '表头表格数字对齐');
  const segE = stripComments(raw.slice(raw.indexOf('/* E. 大数字排版')));
  ok(/font-weight: 600/.test(segE), '大数字字重 600 封顶');
  ok(/letter-spacing: -\.02em/.test(segE), '大数字负字距');
  ok(!/font-weight: 680/.test(segE), '不再产出 680 重量');
}

console.log('[E] 版本与缓存');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(R, 'package.json'), 'utf8'));
  const vv = pkg.version.split('.').map(Number);
  ok(vv[0] === 1 && vv[1] === 5 && vv[2] >= 155, 'version >= 1.5.155');
  const html = fs.readFileSync(path.join(R, 'renderer/index.html'), 'utf8');
  const mm = html.match(/v4\.css\?v=(\d+)/);
  ok(!!mm && Number(mm[1]) >= 2026111335, 'v4.css 缓存参数 >= 1335');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
