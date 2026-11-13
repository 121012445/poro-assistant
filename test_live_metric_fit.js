'use strict';
// 1.5.142: 标签收纳整体退役 —— 指标全部直接展示 (指标行折行, §24 两行封顶),
// 「+N」入口不再渲染。1.5.137 的「标签全部隐藏」bug 根源 (溢出收纳误判) 随之消失。
// 本文件从「收纳逻辑回归测试」改为「退役断言」: 保证收纳代码不再回潮。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const liveSrc = fs.readFileSync('renderer/js/live.js', 'utf8');
const appSrc = fs.readFileSync('renderer/js/app.js', 'utf8');
const cssV4 = fs.readFileSync('renderer/css/v4.css', 'utf8');
const cssPremium = fs.readFileSync('renderer/css/premium.css', 'utf8');

// ---------- 1. 渲染层: liveMetricPills 不再输出收纳入口 ----------
assert.ok(!liveSrc.includes('lp-tags-more'), 'liveMetricPills 不应再输出「+N」按钮 (收纳退役)');
assert.ok(!liveSrc.includes('lp-extra-metrics'), 'liveMetricPills 不应再输出隐藏容器 (收纳退役)');
assert.ok(!liveSrc.includes('lp-extra-metric'), '不应再有 lp-extra-metric 收纳标记');
assert.ok(liveSrc.includes('const allHtml = items.map'), '全部指标应直接渲染 (allHtml)');

// ---------- 2. fitLiveMetricRows 退役为 no-op, 调用点保留 ----------
assert.match(liveSrc, /function fitLiveMetricRows\(\)\s*\{\s*\/\/[\s\S]*?\n\}/,
  'fitLiveMetricRows 应为空函数 (保留签名兼容轮询/切页调用点)');
assert.ok(liveSrc.includes('fitLiveMetricRows();'), '轮询/切页调用点应保留, 空函数兼容');

// ---------- 3. CSS: 指标行折行 + 1.5.143 三行压实 (回收 22px 预留 + 胶囊 padding 4px) ----------
assert.match(cssV4, /24\. 指标标签全展示[\s\S]*?#page-live \.lp-profile-line \{[^}]*flex-wrap: wrap;[^}]*max-height: 80px;/s,
  'v4.css §24 应恢复指标行折行并保留 80px 安全网');
assert.match(cssV4, /24\. 指标标签全展示[\s\S]*?#page-live \.lp-profile-line \{[^}]*padding: 0 1px;[^}]*gap: 1px;/s,
  '§24 应回收 premium.css 为「+N」预留的 padding-right: 22px 并收 gap 至 1px (1.5.143)');
assert.match(cssV4, /#page-live \.lp-profile-line \.lp-metric \{[^}]*padding: 0 4px;/s,
  '指标胶囊横向 padding 应为 4px (1.5.143 三行压实)');
assert.match(cssV4, /\.lp-behavior \{[^}]*padding: 0 4px;/s,
  '行为胶囊横向 padding 应为 4px (1.5.143 三行压实)');
// premium.css 的单行锁定 (nowrap + height 17px) 必须被 §24 覆盖: v4.css 最后加载, 同特异性按源顺序胜出
assert.match(cssPremium, /#page-live \.lp-profile-line \{[^}]*flex-wrap: nowrap;/s,
  'premium.css 单行锁定规则应仍在 (由 §24 覆盖, 防误删基准)');
assert.ok(cssV4.indexOf('24. 指标标签全展示') > cssV4.indexOf('22. 玩家卡密度对齐'),
  '§24 应位于 §22 之后 (源顺序覆盖更早的密度规则)');

// ---------- 4. app.js: switchPage('live') 补对齐的钩子仍在 (切页立即对齐战绩行) ----------
assert.ok(appSrc.includes('if (page === "live" && typeof scheduleLiveRowAlignment === "function") scheduleLiveRowAlignment();'),
  'switchPage 切回实时页应立即补一次对齐 (1.5.137 行为不回退)');

// ---------- 5. 动态验证: vm 执行 live.js, fitLiveMetricRows 可调用且不改 DOM ----------
const ctx = vm.createContext({
  console,
  window: {},
  document: {
    querySelectorAll: () => { throw new Error('fitLiveMetricRows 退役后不应再查询任何行'); },
  },
});
vm.runInContext(liveSrc, ctx, { filename: 'live.js' });
ctx.fitLiveMetricRows(); // 不抛错 = no-op 确认 (查询 DOM 会立即抛错)

console.log('test_live_metric_fit: 收纳退役断言全部通过');
