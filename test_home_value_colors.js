// 1.5.158: 首页数值语义配色 (§32) —— 数字不再一律近黑
// 断言目标: 渲染层给了语义类 + CSS 层做了令牌化 + 明暗双主题都能跟随
const fs = require('fs');
const path = require('path');

const R = __dirname;
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function stripComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }

const css = fs.readFileSync(path.join(R, 'renderer/css/v4.css'), 'utf8');
const js = fs.readFileSync(path.join(R, 'renderer/js/home.js'), 'utf8');
const cssNC = stripComments(css);

console.log('\n[1] §32 章节与四个语义令牌');
ok(/32\. 首页数值语义配色/.test(css), 'v4.css 含 §32 章节');
['--data-k', '--data-d', '--data-n', '--data-g'].forEach(t => {
  ok(new RegExp('\\' + t + '\\s*:').test(cssNC), `定义了 ${t}`);
});
ok(/--data-k:\s*var\(--pos\)/.test(cssNC), '--data-k 复用 --pos 令牌');
ok(/--data-d:\s*var\(--neg\)/.test(cssNC), '--data-d 复用 --neg 令牌');
ok(/--data-n:\s*var\(--brand\)/.test(cssNC), '--data-n 复用 --brand 令牌');
ok(/--data-g:\s*var\(--warn\)/.test(cssNC), '--data-g 复用 --warn 令牌');

console.log('\n[2] CSS 选择器: 明暗双主题 + 特异性前缀');
['v-k', 'v-d', 'v-n', 'v-g'].forEach(c => {
  ok(new RegExp('#page-home \\.' + c).test(cssNC), `#page-home .${c} 有 id 前缀(压过 .stat-split b)`);
});
// 深色必须在 body.dark 上重新解析 --data-*: :root 里的 var() 会提前固化成浅色值
const darkBlock = (cssNC.match(/body\.dark \{[^}]*--data-k[^}]*\}/) || [''])[0];
ok(!!darkBlock, 'body.dark 存在重定义 --data-* 的规则块');
['--data-k: var(--pos)', '--data-d: var(--neg)', '--data-n: var(--brand)', '--data-g: var(--warn)'].forEach(t => {
  ok(darkBlock.replace(/\s+/g, ' ').includes(t), `body.dark 重定义 ${t.split(':')[0]}`);
});
ok(!/(^|\n)body\.dark \.v-k/.test(cssNC), '不再用 body.dark .v-k 覆盖(会被 id 前缀压过, 无效)');
ok(/\.v-k, \.v-d, \.v-n, \.v-g \{[^}]*var\(--font-data\)/.test(cssNC), '语义类走 --font-data 等宽');
ok(!/\.v-k, \.v-d, \.v-n, \.v-g \{[^}]*font-size:/.test(cssNC), '语义类不覆盖宿主字号');

console.log('\n[3] 渲染层: KPI 六个数字卡');
ok(/function kdaClass\(v\)/.test(js), 'kdaClass() 分级函数存在');
ok(/n >= 3 \? 'v-k' : \(n < 2 \? 'v-d' : 'v-n'\)/.test(js), 'KDA 阈值: ≥3 绿 / <2 红 / 其余蓝');
ok(/<b class="v-k">\$\{totK\}<\/b><i>击杀<\/i>/.test(js), '总击杀 → 绿');
ok(/<b class="v-d">\$\{totD\}<\/b><i>死亡<\/i>/.test(js), '总死亡 → 红');
ok(/<b class="v-n">\$\{totA\}<\/b><i>助攻<\/i>/.test(js), '总助攻 → 蓝');
ok(/<b class="v-g">\$\{penta\}<\/b><i>五杀<\/i>/.test(js), '五杀 → 金');
ok(/<b class="v-k">\$\{fb\}<\/b><i>一血<\/i>/.test(js), '一血 → 绿');
ok(/stat-card-val \$\{kdaClass\(avgKda\)\}/.test(js), '场均 KDA 走分级着色');
// 1.5.159 起用户要求时长也上色: 走中性信息蓝 v-n (不是好/坏的绿红)
ok(/stat-card-val v-n">\$\{totalDurH\}:/.test(js), '总游戏时长上中性蓝 v-n');
ok(/stat-card-val v-n">\$\{fmtDur\}/.test(js), '场均用时上中性蓝 v-n');

console.log('\n[4] 渲染层: 段位卡 / 模式统计 / 概览条 / 好友');
ok(/<span class="v-k">\$\{q\.wins \|\| 0\}<\/span>胜 <span class="v-d">\$\{q\.losses \|\| 0\}<\/span>负/.test(js), '段位记录 胜绿/负红');
ok(/\$\{wr >= 50 \? 'v-k' : 'v-d'\}">\$\{wr\}%/.test(js), '段位胜率按 50% 阈值分色');
ok(/<td class="v-k">\$\{r\.w\}<\/td><td class="v-d">\$\{r\.n - r\.w\}<\/td>/.test(js), '排位表 胜场绿/负场红');
ok(/<td class="v-k">\$\{ms\.w\}<\/td><td class="v-d">\$\{ms\.n - ms\.w\}<\/td>/.test(js), '模式表 胜场绿/负场红');
ok(/场均 <span class="v-k">/.test(js), '概览条 场均击杀绿');
ok(/<span class="v-n">\$\{\(totA\/n\)\.toFixed\(1\)\}<\/span>/.test(js), '概览条 场均助攻蓝');
ok(/KDA <span class="\$\{kdaClass\(avgKda\)\}">/.test(js), '概览条 KDA 分级');
ok(/<div class="friend-row-count"><span class="v-k">\$\{f\.wins\}<\/span>胜<span class="v-d">\$\{f\.losses\}<\/span>负/.test(js), '好友胜负分色');

console.log('\n[5] 渲染层: 对局卡 K/D/A');
ok(/<span class="v-k">\$\{p\.k\}<\/span> <i>\/<\/i> <b class="v-d">\$\{p\.d\}<\/b> <i>\/<\/i> <span class="v-n">\$\{p\.a\}<\/span>/.test(js), 'K/D/A = 绿/红/蓝');
ok(/<span class="v-g">完美<\/span>/.test(js), '完美局 → 金');
ok(/<span class="\$\{kdaClass\(kda\)\}">\$\{kda\}<\/span>/.test(js), '单局 KDA 走分级着色');

console.log('\n[6] 版本与缓存戳');
const pkg = JSON.parse(fs.readFileSync(path.join(R, 'package.json'), 'utf8'));
const v = pkg.version.split('.').map(Number);
ok(v[0] === 1 && v[1] === 5 && v[2] >= 158, `version >= 1.5.158 (实际 ${pkg.version})`);
const html = fs.readFileSync(path.join(R, 'renderer/index.html'), 'utf8');
const m = html.match(/v4\.css\?v=(\d+)/);
ok(!!m && Number(m[1]) >= 2026111405, 'v4.css 缓存参数 >= 2026111405');
ok(!/\?v=2026111404/.test(html), '旧缓存戳 1404 已全部替换');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
