// 1.5.157: 洞察标签收敛 BinanceGUI 四色 + 剩余数字等宽 (§31)
const fs = require('fs');
const path = require('path');
const R = __dirname;
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ok', n); } else { fail++; console.error('  FAIL', n); } };
// 1.6.0: 版本断言改成元组比较 —— 旧写法写死 minor===5, 跨大版本会被误判失败
const atLeastVer = (v, m) => v[0] > m[0] || (v[0] === m[0] && (v[1] > m[1] || (v[1] === m[1] && v[2] >= m[2])));

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
// §31 段落 = 从 A 段起, 到下一个章节 (§32) 的注释块开始为止。
// 1.5.158/1.5.159 在文件尾追加了 §32/§33, 若切到文件尾会把它们的色值算进来。
const _p32 = raw.indexOf('32. 首页数值语义配色');
const seg31 = raw.slice(raw.indexOf('/* A. 正向类'), _p32 > 0 ? raw.lastIndexOf('/*', _p32) : raw.length);
const seg31css = stripComments(seg31);

console.log('[A] §31 段存在');
{
  ok(raw.includes('31. 洞察标签收敛四色'), '§31 标题存在');
  ok(seg31css.includes('.ako-insight-positive'), '规则存活 (注释未吞)');
}

console.log('[B] 十个洞察标签全部收敛到语义令牌');
{
  const groups = {
    '正向(绿)': ['.ako-insight-positive', '.ako-insight-efficiency', '.ako-insight-healing', '--pos'],
    '提示(黄)': ['.ako-insight-warning', '.ako-insight-low', '--warn'],
    '负向(红)': ['.ako-insight-damage', '--neg'],
    '强调(蓝)': ['.ako-insight-accent', '.ako-insight-vision', '.ako-insight-team', '--brand'],
    '弱化': ['.ako-insight-muted', '--text-secondary']
  };
  for (const [name, arr] of Object.entries(groups)) {
    const token = arr[arr.length - 1];
    const sels = arr.slice(0, -1);
    const all = sels.every(s => seg31css.includes(s));
    ok(all, `${name}: 覆盖 ${sels.join(' / ')}`);
    ok(seg31css.includes(`var(${token})`), `${name}: 走 ${token}`);
  }
}

console.log('[C] 深色主题同样被接管 (不是只改浅色)');
{
  ['body.dark .ako-insight-positive', 'body.dark .ako-insight-warning',
    'body.dark .ako-insight-damage', 'body.dark .ako-insight-accent',
    'body.dark .ako-insight-muted'].forEach(sel => {
    ok(seg31css.includes(sel), `${sel} 已覆盖`);
  });
}

console.log('[D] §31 不再引入新的硬编码色值');
{
  const hexes = seg31css.match(/#[0-9a-fA-F]{3,8}/g) || [];
  ok(hexes.length === 0, `段落内无十六进制字面量 (实际 ${hexes.length})`);
  const rgba = seg31css.match(/rgba?\(/g) || [];
  ok(rgba.length === 0, `段落内无 rgb/rgba 字面量 (实际 ${rgba.length})`);
  ok(seg31css.includes('color-mix(in srgb'), '软底/描边由 color-mix 派生');
}

console.log('[E] 剩余数字等宽');
{
  ['.hex-stats-bar', '.duo-chip', '#page-tools .btn-secondary'].forEach(s => ok(seg31css.includes(s), `${s} 已纳入`));
  // 用首个选择器定位 F 段 (注释已剥离, 不能按注释锚点切)
  const segF = seg31css.slice(seg31css.indexOf('.hex-stats-bar'));
  ok(/font-family: var\(--font-data\)/.test(segF), 'F 段使用 --font-data');
  ok(/font-variant-numeric: tabular-nums/.test(segF), 'F 段 tabular-nums');
}

console.log('[F] 版本与缓存');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(R, 'package.json'), 'utf8'));
  const v = pkg.version.split('.').map(Number);
  ok(atLeastVer(v, [1, 5, 157]), `version >= 1.5.157 (实际 ${pkg.version})`);
  const lock = JSON.parse(fs.readFileSync(path.join(R, 'package-lock.json'), 'utf8'));
  ok(lock.version === pkg.version, 'package-lock 同步');
  const html = fs.readFileSync(path.join(R, 'renderer/index.html'), 'utf8');
  const m = html.match(/v4\.css\?v=(\d+)/);
  ok(!!m && Number(m[1]) >= 2026111404, 'v4.css 缓存参数 >= 1404');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
