'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const home = fs.readFileSync('renderer/js/home.js', 'utf8');
const live = fs.readFileSync('renderer/js/live.js', 'utf8');
const review = fs.readFileSync('renderer/js/review.js', 'utf8');
const main = fs.readFileSync('main/index.js', 'utf8');
const diagnostics = fs.readFileSync('renderer/js/diagnostics.js', 'utf8');
const css = fs.readFileSync('renderer/css/extras.css', 'utf8');

assert(home.includes('function buildHomeCoach('), '首页应包含持续训练目标');
assert(home.includes('英雄池教练'), '首页应包含英雄池建议');
assert(home.includes('版本影响提示'), '首页应包含版本影响观察');
assert(home.includes('非官方匹配强度'), '匹配强度必须明确标注为非官方');
assert(live.includes('function buildLiveDecisionPanel('), '实时对局应包含阵容决策中心');
assert(live.includes('综合态势不是官方胜率'), '阵容评分必须避免冒充精确胜率');
assert(live.includes('function liveItemAdvice('), '实时对局应给出装备方向');
assert(live.includes('ownedNames'), '装备建议应避开已持有装备');
assert(review.includes('function buildAutomaticReview('), '赛后应自动生成关键复盘');
assert(review.includes('最大转折段'), '赛后复盘应识别经济转折');
assert(main.includes('function augmentOverlayMetrics('), '强化悬浮层应按显示环境自适应');
assert(main.includes('setZoomFactor(metrics.scale)'), '强化悬浮层内容应随窗口缩放');
assert(diagnostics.includes('augmentOverlayStatus()'), '诊断中心应检查强化悬浮层');
assert(css.includes('.home-coach'), '持续提升中心应有独立样式');
assert(css.includes('.rv-auto-review'), '自动复盘应有独立样式');

const utilContext = vm.createContext({ console, Math, Number, Array, Set, Map, String, Object });
vm.runInContext(fs.readFileSync('renderer/js/utils.js', 'utf8'), utilContext, { filename: 'utils.js' });
const tenSteady = Array.from({ length: 10 }, (_, index) => ({ win: index < 6, k: 8 + index % 3, d: 4 + index % 2, a: 9 }));
const tenWatch = Array.from({ length: 10 }, (_, index) => ({ win: index < 3, k: 3, d: 8 + index % 4, a: 5 }));
utilContext.__steady = tenSteady;
utilContext.__watch = tenWatch;
const steadyProfile = vm.runInContext('deriveRiskProfile(__steady)', utilContext);
const watchProfile = vm.runInContext('deriveRiskProfile(__watch)', utilContext);
assert.ok(steadyProfile.confidence < 100 && watchProfile.confidence < 100, '取满 10 场不能再机械显示 100% 置信度');
assert.notStrictEqual(steadyProfile.confidence, watchProfile.confidence, '画像置信度应随表现一致性和阈值距离变化');
assert.ok(steadyProfile.confidence >= 50 && watchProfile.confidence >= 50, '完整 10 场仍应提供中等以上可信度');

console.log('产品教练与悬浮层自适应测试通过');
