'use strict';

const assert = require('assert');
const fs = require('fs');

const live = fs.readFileSync('renderer/js/live.js', 'utf8');
const css = fs.readFileSync('renderer/css/premium.css', 'utf8');
const html = fs.readFileSync('renderer/index.html', 'utf8');

assert.ok(html.includes('id="livePlayerDrawerBackdrop"') && html.includes('id="livePlayerDrawerBody"'), '实时页应提供玩家详情抽屉容器');
assert.ok(live.includes('function openLivePlayerDrawer') && live.includes('function renderLivePlayerDrawer'), '卡片背景应能打开玩家详情抽屉');
assert.ok(live.includes('liveDrawerFilters') && live.includes("setLiveDrawerFilter('champion'") && live.includes("setLiveDrawerFilter('role'"), '抽屉应支持英雄和位置筛选');
assert.ok(live.includes('premadeGroupId') && live.includes('行为画像') && live.includes('组队证据'), '抽屉应展示行为画像和组队证据');
assert.ok(/position:\s*me\.teamPosition/.test(live) && /position:\s*me\.position/.test(live), 'SGP 与 LCU 战绩来源都应保留位置信息');
assert.ok(live.includes('window._poroLivePlayerMap?.set(key, p)'), '分批回填战绩时应同步抽屉数据源');
assert.ok(css.includes('.live-player-drawer-backdrop') && css.includes('.live-player-drawer'), '抽屉应有完整的遮罩和侧滑布局');
assert.ok(live.includes('function liveThreatProfile') && live.includes('function liveContextAdvice'), '作战计划应分析敌方威胁和本局上下文');
assert.ok(live.includes('装备偏离') && live.includes('符文方向') && live.includes('contextAdvice.reasons'), '作战计划应解释装备/符文为何偏离通用方案');
assert.ok(live.includes('[450, 2400].includes(queueId)') && live.includes("self.position || '').toUpperCase() === 'JUNGLE'"), '建议应区分游戏模式与分路');

console.log('实时玩家抽屉与上下文建议测试通过');
