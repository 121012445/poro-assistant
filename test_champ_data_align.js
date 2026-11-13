// 1.5.156: 英雄库数据列等宽补全 + 浅色次要数据色阶归位 (§30)
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
const seg = raw.slice(raw.indexOf('/* A. 英雄库数据列'));

console.log('[A] §30 段存在且未被注释吞掉');
{
  ok(raw.includes('30. 数字等宽补全'), '§30 标题存在');
  ok(css.includes('.champ-rank'), '规则存活 (注释已剥离仍可见选择器)');
  ok(css.includes('.champ-pr'), 'champ-pr 存活');
  ok(css.includes('.champ-br'), 'champ-br 存活');
}

console.log('[B] 英雄库数据列全部等宽');
{
  const segA = stripComments(seg.slice(0, seg.indexOf('/* B.')));
  ['.champ-rank', '.champ-pr', '.champ-br', '.champ-wr', '.champ-tier'].forEach(cls => {
    ok(segA.includes(cls), `${cls} 在等宽清单中`);
  });
  ok(/font-family: var\(--font-data\)/.test(segA), 'A 段使用 --font-data');
  ok(/font-variant-numeric: tabular-nums/.test(segA), 'A 段 tabular-nums');
}

console.log('[C] 浅色数据值提到 text2, 深色保持 text3');
{
  const segB = raw.slice(raw.indexOf('/* B. 浅色'), raw.indexOf('/* C. T5'));
  ok(/:root \.champ-rank/.test(segB), '浅色选择器 :root .champ-rank');
  ok(/color: var\(--ink-2\)/.test(segB), '浅色用 --ink-2');
  ok(/body\.dark \.champ-rank/.test(segB), '深色选择器 body.dark .champ-rank');
  ok(/color: var\(--ink-3\)/.test(segB), '深色用 --ink-3');
  // 浅色必须带字重 600 (BinanceGUI 数据值不超过 600)
  ok(/font-weight: 600/.test(segB), '浅色数据值字重 600');
  ok(!/font-weight: 7\d\d/.test(segB), '无超过 700 的字重');
}

console.log('[D] T5 不再用 opacity 稀释文字');
{
  const segC = raw.slice(raw.indexOf('/* C. T5'), raw.indexOf('/* D. 英雄库表头'));
  ok(/\.champ-tier\.t-5 \{[^}]*opacity: 1/.test(segC), 'T5 opacity 复位为 1');
  ok(/color-mix\(in srgb, var\(--ink-3\)/.test(segC), 'T5 用色阶表达弱化');
  // 旧规则仍可能在文件中, 但 §30 的 opacity:1 必须排在其后 (同特异性后写覆盖)
  const oldOp = css.indexOf('opacity: .7');
  const newOp = css.lastIndexOf('.champ-tier.t-5');
  ok(oldOp > -1 && newOp > oldOp, '§30 的 T5 规则排在旧规则之后 (层叠覆盖)');
}

console.log('[E] 与 §29 字体体系一致, 不与既有规则打架');
{
  ok(css.includes('--font-data: var(--mono);'), '--font-data 仍是 --mono');
  // champ 规则不能改 font-size (版式不变)
  ok(!/\.champ-rank[^{]*\{[^}]*font-size/.test(seg), 'A 段不改字号');
  ok(!/\.champ-pr[^{]*\{[^}]*font-size/.test(seg), 'champ-pr 不改字号');
  ok(!/letter-spacing: -\.0[3-9]em/.test(seg), '无过度字距收紧');
}

console.log('[F] 版本与缓存参数已 bump');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(R, 'package.json'), 'utf8'));
  const v = pkg.version.split('.').map(Number);
  ok(v[0] === 1 && v[1] === 5 && v[2] >= 156, 'version >= 1.5.156');
  const html = fs.readFileSync(path.join(R, 'renderer/index.html'), 'utf8');
  const m = html.match(/v4\.css\?v=(\d+)/);
  ok(!!m && Number(m[1]) >= 2026111400, 'v4.css 缓存参数已更新');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
