'use strict';

const assert = require('assert');
const fs = require('fs');

const live = fs.readFileSync('renderer/js/live.js', 'utf8');
const css = fs.readFileSync('renderer/css/style.css', 'utf8');

assert.ok(live.includes('class="lp-team-grid"'), '实时页应使用队伍卡片网格');
assert.ok(live.includes('class="lp-card-head"'), '玩家卡应有大头像信息头');
assert.ok(live.includes('class="lp-overview"'), '玩家卡应显示近期胜率与 KDA 摘要');
assert.ok(live.includes('<details class="live-decision">'), '本局作战计划应默认收起，避免压缩双方战绩');
assert.ok(live.includes('class="ld-summary-plan"'), '收起状态仍应显示一句核心打法');
assert.match(css, /\.lp-team-grid\s*\{[^}]*grid-template-columns:\s*repeat\(5,/s, '宽屏每队应横排 5 张玩家卡');
assert.match(css, /\.lp-champ\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;/s, '玩家英雄头像应压缩到 36px');
assert.match(css, /\.ri-card img\s*\{[^}]*width:\s*22px;[^}]*height:\s*22px;/s, '近期战绩英雄图标应压缩到 22px');
assert.match(live, /function recentLimit\(\)\s*\{\s*return 10;\s*\}/,
  '每张玩家卡应提供最近 10 场战绩');
assert.match(css, /\.lp-wrap\s*\{[^}]*flex:\s*1;[^}]*overflow:\s*hidden;/s, '两支队伍应共同压缩在实时页可视高度内');
assert.match(css, /\.lp-team\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;/s, '两支队伍应各占实时页一半高度');
assert.match(css, /\.lp-recent\s*\{[^}]*overflow-y:\s*auto;/s, '最近 10 场应在玩家卡内部独立滚动');
assert.match(css, /\.ri-card\s*\{[^}]*flex:\s*0 0 26px;/s, '滚动区内每场战绩应保持稳定高度');
assert.match(css, /\.lp-row\s*\{[^}]*background:\s*var\(--bg-card\)/s, '玩家卡应沿用 Poro 的主题卡片色');
assert.ok(css.includes('var(--shadow-soft)'), '实时队伍面板应沿用 Poro 的柔和阴影');
assert.ok(!/grid-template-columns:\s*repeat\([1234],/.test(css.slice(css.indexOf('/* 实时对局：双方上下排列'))), '实时页不得在窄窗口把五人拆成多行');
assert.ok(live.includes('list.length !== 10'), '加载页队伍兜底只能处理完整 10 人，不能误分不完整阵容');
assert.ok(live.includes('index < 5 ? 100 : 200'), '国服加载页缺少 team 字段时应按原始 5/5 顺序分队');
assert.ok(live.includes("phase !== 'ChampSelect'"), '选人阶段必须保留客户端提供的队伍数据，不应用加载页兜底');
assert.ok(live.includes('player.premadeTeamGames || []'), '阵容缓存刷新必须保留共同对局历史，不能清掉组队徽标');
assert.ok(live.includes('livePlayersCache.premadeGroups = finalGroups'), '后台推断完成后必须缓存组队分组');
assert.ok(live.includes('const cachedInferred = inferPremadeGroups'), '命中阵容缓存时必须重新推断组队关系');

console.log('实时对局大卡片布局测试通过');
