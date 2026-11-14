// 1.5.159: 时长/场次上色 + 段位专属色阶 (§33)
// 断言目标: 十段位各有独立色 → 渲染层打了 data-tier → 明暗双主题都能解析
const fs = require('fs');
const path = require('path');

const R = __dirname;
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function stripComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }
// 1.6.0: 版本断言改成元组比较 —— 旧写法写死 minor===5, 跨大版本会被误判失败
const atLeastVer = (v, m) => v[0] > m[0] || (v[0] === m[0] && (v[1] > m[1] || (v[1] === m[1] && v[2] >= m[2])));

const raw = fs.readFileSync(path.join(R, 'renderer/css/v4.css'), 'utf8');
const cssNC = stripComments(raw);
const home = fs.readFileSync(path.join(R, 'renderer/js/home.js'), 'utf8');
const live = fs.readFileSync(path.join(R, 'renderer/js/live.js'), 'utf8');

const TIERS = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'master', 'grandmaster', 'challenger'];

console.log('\n[1] §33 章节与十个段位令牌');
ok(/33\. 时长\/场次上色 \+ 段位专属色阶/.test(raw), 'v4.css 含 §33 章节');
TIERS.forEach(t => {
  ok(new RegExp('\\-\\-tier\\-' + t + '\\s*:').test(cssNC), `定义了 --tier-${t}`);
});

console.log('\n[2] 明暗双主题各一套值 (深色必须另给提亮版)');
const lightBlock = (cssNC.match(/:root \{[^}]*--tier-iron[^}]*\}/) || [''])[0];
const darkBlock = (cssNC.match(/body\.dark \{[^}]*--tier-iron[^}]*\}/) || [''])[0];
ok(!!lightBlock, ':root 定义了浅色段位色');
ok(!!darkBlock, 'body.dark 定义了深色段位色');
const lightVals = (lightBlock.match(/#[0-9A-Fa-f]{6}/g) || []);
const darkVals = (darkBlock.match(/#[0-9A-Fa-f]{6}/g) || []);
ok(lightVals.length === 10, `浅色 10 个色值 (实际 ${lightVals.length})`);
ok(darkVals.length === 10, `深色 10 个色值 (实际 ${darkVals.length})`);
ok(lightVals.every((v, i) => v.toUpperCase() !== darkVals[i].toUpperCase()), '明暗两套无重复色值 (不是一套复制)');

console.log('\n[3] 段位 → 局部变量映射');
['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'].forEach(T => {
  ok(new RegExp('\\[data-tier="' + T + '"\\]\\s*\\{\\s*--tier-c:\\s*var\\(--tier-' + T.toLowerCase() + '\\)').test(cssNC), `[data-tier="${T}"] 映射 --tier-${T.toLowerCase()}`);
});
ok(/\[data-tier=""\]\s*\{\s*--tier-c:\s*var\(--ink-3\)/.test(cssNC), '空段位回落 --ink-3 (不继承上一个段位色)');

console.log('\n[4] 选择器特异性: 必须压过 #page-home .rank-card-tier');
ok(/#page-home \.rank-card-tier\[data-tier\]/.test(cssNC), '段位卡用 id+属性选择器');
ok(/#page-home \.td-rank\[data-tier\]/.test(cssNC), '模式表段位列有选择器');
ok(/#page-live \.lp-tier\[data-tier\]/.test(cssNC), '实时页段位有选择器');
ok(/color:\s*var\(--tier-c,\s*var\(--ink-1\)\)/.test(cssNC), '有兜底色 (变量缺失时不至于无色)');

console.log('\n[5] 渲染层: 四处段位落点都带 data-tier');
ok(/<div class="rank-card-tier" data-tier="\$\{q\.tier\}">/.test(home), '段位大卡带 data-tier');
ok((home.match(/<div class="rank-card-tier" data-tier=/g) || []).length === 2, '两处段位卡渲染都改了');
ok(/return \{ name: label \+ " \(当前赛段\)", n: total, w: r\.wins, rank, lp, tier: r\.tier/.test(home), 'rankRows 携带原始 tier');
ok(/<td class="td-rank" data-tier="\$\{r\.tier \|\| ''\}">/.test(home), '模式表段位列带 data-tier');
ok(/<div class="ogd-rank" data-tier="\$\{q\.tier\}">/.test(home), '对局卡玩家段位带 data-tier');
ok(/lp-tier" data-tier="\$\{p\.tier \|\| ''\}"/.test(live), '实时页玩家行段位带 data-tier');
ok(/tier: \(solo && solo\.tier\) \|\| ''/.test(live), '实时页 quickData 携带 tier');

console.log('\n[6] 时长 / 场次上色');
ok(/<div class="stat-card-val v-n">\$\{totalDurH\}/.test(home), '总游戏时长上蓝');
ok(/<div class="stat-card-val v-n">\$\{fmtDur\}/.test(home), '场均用时上蓝');
ok((home.match(/<td class="v-n">\$\{r\.n\}<\/td>/g) || []).length === 1, '模式表总场次(当前赛段)上蓝');
ok((home.match(/<td class="v-n">\$\{ms\.n\}<\/td>/g) || []).length === 1, '模式表总场次(模式统计)上蓝');
ok(/<span>近 <span class="v-n">\$\{n\}<\/span> 场<\/span>/.test(home), '概览条近 N 场数字上蓝');
ok(/#page-home \.stat-card-val\.v-n/.test(cssNC), 'CSS 兜底: stat-card-val.v-n 上色');
ok(/\.v-n[\s\S]{0,40}color:\s*var\(--data-n\)/.test(cssNC), '场次色复用 --data-n (与 1.5.158 同一语义层)');

console.log('\n[7] 无遗留未上色段位 / 版本');
// 裸 rank-card-tier 只允许是「无排位」占位 (它本来就该保持中性灰, 不该套段位色)
const bare = home.match(/<div class="rank-card-tier">[^<]*</g) || [];
ok(bare.length > 0 && bare.every(m => m.includes('无排位')), `裸 rank-card-tier 仅「无排位」占位 (${bare.length} 处)`);
const pkg = JSON.parse(fs.readFileSync(path.join(R, 'package.json'), 'utf8'));
const v = pkg.version.split('.').map(Number);
ok(atLeastVer(v, [1, 5, 159]), `version >= 1.5.159 (实际 ${pkg.version})`);
const html = fs.readFileSync(path.join(R, 'renderer/index.html'), 'utf8');
const m = html.match(/v4\.css\?v=(\d+)/);
ok(!!m && Number(m[1]) >= 2026111406, 'v4.css 缓存参数 >= 2026111406');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
