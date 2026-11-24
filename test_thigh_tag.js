// 大腿标签判定测试 (thigh-tag.js)。
//
// 守的核心: 胜率高但个人战绩烂的人不能再拿到「大腿」—— 这正是用户反馈的问题:
// "很多胜率高但是战绩很差的人也会获得大腿标签"。
// 另外守助攻权重: 压到半次 (0.5), 不能与击杀等权。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'renderer/js/thigh-tag.js');
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); n++; };

const sandbox = { console, window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);
const M = sandbox.window.PoroThigh;

// 把总 K/D/A 平均摊到各局, 余数补给前几局 —— 保证总和精确, 便于算断言
function spread(total, games) {
  const base = Math.floor(total / games), rem = total - base * games;
  return Array.from({ length: games }, (_, i) => base + (i < rem ? 1 : 0));
}
function mkRecent(games, wins, K, D, A) {
  const ks = spread(K, games), ds = spread(D, games), as = spread(A, games);
  return Array.from({ length: games }, (_, i) => ({ win: i < wins, k: ks[i], d: ds[i], a: as[i], champId: 1 }));
}

// ---- 1. 用户反馈的原始场景: 胜率高但战绩差 ----
{
  // 18 场 13 胜 (72%), 场均 3/6/9 —— 被队友带赢的典型号
  const r = M.judge(mkRecent(18, 13, 54, 108, 162));
  eq(r.hit, false, '胜率 72% 但场均死 6 次, 不该贴大腿');
  ok(r.wkda < 1.5, '加权 KDA ' + r.wkda + ' 低, 判定确实拦住了');
  ok(/加权 KDA/.test(r.reason), '给出不贴的原因: ' + r.reason);
}
{
  // 18 场 10 胜 (56%), 场均 9/4/5 —— 胜率一般但战绩硬
  const r = M.judge(mkRecent(18, 10, 162, 72, 90));
  eq(r.hit, true, '胜率 56% + 加权 KDA 2.9, 该贴大腿');
  eq(r.wkda, 2.9, '加权 KDA 计算正确 (207/72 ≈ 2.875)');
  ok(r.tip.includes('助攻按半次计'), '悬停说明写明助攻权重');
}

// ---- 2. 助攻权重: 压到 0.5, 不等于击杀 ----
{
  // 同样 20 场, 助攻从 0 涨到 100, 加权 KDA 的增量应为 击杀增量的 0.5 倍
  const noAssist = M.judge(mkRecent(20, 12, 200, 100, 0));
  const manyAssist = M.judge(mkRecent(20, 12, 200, 100, 100));
  const dW = manyAssist.wkda - noAssist.wkda;
  eq(dW, 0.5, '100 助攻只值 50 击杀的权重 (100 × 0.5 / 100 死 = +0.5)');
  // 标准 KDA 口径下同样条件下应涨 1.0 —— 加权口径必须更保守
  const dKda = manyAssist.kda - noAssist.kda;
  eq(dKda, 1, '标准 KDA 口径涨 1.0, 对照用');
  ok(dW < dKda, '加权口径确实把助攻压住了');
  // 纯刷助攻不击杀的人, 标准 KDA 好看, 加权后掉下来
  const farm = M.judge(mkRecent(20, 12, 0, 100, 200));   // 标准 2.0, 加权 1.0
  eq(farm.kda, 2, '标准 KDA 2.0 (看着不差)');
  eq(farm.wkda, 1, '加权 KDA 只有 1.0');
  eq(farm.hit, false, '光刷助攻拿不到大腿');
}

// ---- 3. 阈值边界 ----
{
  const hit = M.judge(mkRecent(20, 12, 20, 20, 56));    // (20 + 28) / 20 = 2.4
  eq(hit.wkda, 2.4, '加权 KDA 正好 2.4');
  eq(hit.hit, true, '2.4 命中 (含等于)');
  const miss = M.judge(mkRecent(20, 12, 20, 20, 52));   // (20 + 26) / 20 = 2.3
  eq(miss.wkda, 2.3, '加权 KDA 2.3');
  eq(miss.hit, false, '2.3 不命中');
}

// ---- 4. 胜率兜底: 杀得多一直输也不贴 ----
{
  const r = M.judge(mkRecent(18, 6, 180, 72, 54));      // 33% 胜率, 加权 KDA 2.9
  ok(r.wkda >= M.MIN_WKDA, '战绩本身达标');
  eq(r.hit, false, '胜率 33% 仍然不贴 —— 人头换不来胜势');
  ok(/胜率/.test(r.reason), '原因指向胜率');
}

// ---- 5. 样本不足 / 数据缺失 ----
{
  eq(M.judge([]).hit, false, '空样本不贴');
  eq(M.judge(null).hit, false, 'null 不崩');
  eq(M.judge(mkRecent(13, 10, 117, 52, 65)).hit, false, '13 场不足 14 场');
  eq(M.judge(mkRecent(14, 10, 126, 56, 70)).hit, true, '14 场刚够');
  // 只有胜率没有 k/d/a: 不能因为 D=0 而把 KDA 除成几十
  const noStats = M.judge(Array.from({ length: 18 }, () => ({ win: true })));
  eq(noStats.hit, false, '缺击杀/死亡字段时不贴');
  ok(/缺少/.test(noStats.reason), '原因说明缺字段: ' + noStats.reason);
}

// ---- 6. 字段兼容: SGP 长名 ----
{
  const long = Array.from({ length: 18 }, (_, i) => ({
    win: i < 10, kills: 9, deaths: 4, assists: 5, champId: 1
  }));
  const r = M.judge(long);
  eq(r.hit, true, 'kills/deaths/assists 长字段同样能判定');
  eq(r.wkda, 2.9, '长字段算出的加权 KDA 与短字段一致');
}

// ---- 7. tip 文案 ----
{
  const r = M.judge(mkRecent(18, 10, 162, 72, 90));
  ok(r.tip.includes('18 场'), 'tip 带样本局数');
  ok(r.tip.includes('10 胜'), 'tip 带胜场');
  ok(r.tip.includes('56%'), 'tip 带胜率');
  ok(r.tip.includes('2.9'), 'tip 带加权 KDA');
  ok(r.tip.includes('9/4/5'), 'tip 带场均 K/D/A, 让人能自己复核');
}

// ---- 8. 接线检查 ----
{
  const live = fs.readFileSync(path.join(__dirname, 'renderer/js/live.js'), 'utf8');
  const idx = fs.readFileSync(path.join(__dirname, 'renderer/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'renderer/css/v4.css'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  ok(live.includes('window.PoroThigh') && live.includes('PoroThigh.judge(p.recent)'), 'live.js 用新判定');
  ok(!/winRate >= 65/.test(live), '旧的"胜率 ≥65"口径已移除');
  ok(!live.includes('lp-tag-hiwr'), '旧的高胜率类名不再出现');
  ok(live.includes('lp-tag-thigh') && live.includes('>大腿</span>'), '标签仍叫大腿, 换用新类名');
  ok(idx.includes('js/thigh-tag.js'), 'index.html 引了模块, 且在 live.js 之前');
  ok(idx.indexOf('js/thigh-tag.js') < idx.indexOf('js/live.js'), '模块必须先于 live.js 加载');
  ok(css.includes('.lp-tag-thigh'), '新类名的配色已落地');
  ok(String(pkg.scripts.test).includes('test_thigh_tag.js'), 'npm test 里登记了本测试');
}

console.log('大腿标签: ' + n + ' 组断言全部通过');
