'use strict';

const assert = require('assert');
const fs = require('fs');

const live = fs.readFileSync('renderer/js/live.js', 'utf8');
const css = fs.readFileSync('renderer/css/style.css', 'utf8');
const html = fs.readFileSync('renderer/index.html', 'utf8');

assert.ok(live.includes('class="lp-team-grid"'), '实时页应使用队伍卡片网格');
assert.ok(live.includes('class="lp-card-head"'), '玩家卡应有大头像信息头');
assert.ok(live.includes('class="lp-overview"'), '玩家卡应显示近期胜率与 KDA 摘要');
assert.ok(live.includes('<details class="live-decision">'), '本局作战计划应默认收起，避免压缩双方战绩');
assert.ok(live.includes('class="ld-summary-plan"'), '收起状态仍应显示一句核心打法');
assert.match(css, /\.lp-team-grid\s*\{[^}]*grid-template-columns:\s*repeat\(5,/s, '宽屏每队应横排 5 张玩家卡');
assert.match(css, /\.lp-champ\s*\{[^}]*width:\s*38px;[^}]*height:\s*38px;/s, '玩家英雄头像应为 38px (再大就挤掉战绩行)');
assert.match(css, /\.ri-card img\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px;/s, '近期战绩英雄图标应为 18px (随行高 24px 一起压缩)');
// 逐场战绩: 两行 (模式 / 日期+胜负) + 右侧独立 KDA 列。单行放不下日期, 而日期是判断
// "这波连败是不是当前的" 的关键; KDA 单独成列才能竖着扫等宽数字。
assert.ok(live.includes('class="ri-body"') && live.includes('class="ri-sub"'), '逐场战绩应为两行结构');
assert.ok(live.includes('class="ri-date"') && live.includes('function formatMatchTime'), '逐场战绩应显示对局日期');
assert.ok(/ts:\s*gj\.gameCreation/.test(live) && /ts:\s*game\.time/.test(live), '两条战绩来源都必须带上对局时间戳');
assert.match(css, /\.ri-sub\s*\{[^}]*font-size:\s*9px;/s, '日期行字号不得低于 9px');
// 队内占比标签: 伤害/承伤/经济/参团。没有它, 70% 胜率分不出"被带飞"还是"carry 赢"。
assert.ok(live.includes('function liveMetricPills') && live.includes('function teamShareOf'), '玩家卡应显示近 10 场队内占比');
assert.ok(live.includes("'dmg'") && live.includes("'tank'") && live.includes("'gold'") && live.includes("'kp'"), '占比应覆盖伤害/承伤/经济/参团四项');
assert.ok(/teamShareOf\(gj\.participants/.test(live) && /teamShareOf\(game\.participants/.test(live), 'SGP 与 LCU 两条战绩来源都要算占比');
assert.match(css, /\.lp-metric\s*\{[^}]*flex-shrink:\s*0;/s, '占比标签不得被压缩 (压扁后文字会溢出胶囊)');
assert.match(css, /\.lp-profile-line\s*\{[^}]*flex-wrap:\s*wrap;/s, '标签行必须允许折行, 否则窄窗口下会被卡片右边裁掉');
assert.ok(css.includes('.lp-metric-dmg') && css.includes('.lp-metric-kp'), '四类占比应各有一个色相');
// 伤转率 / 视野 / 连胜连败: 前两个补齐 Akari 的信息面, 后一个是 Poro 自己算的势头
assert.ok(live.includes("'dmgGold'") && live.includes("'vision'"), '应显示伤转率与场均视野');
assert.ok(live.includes('function liveStreak') && /连胜|连败/.test(live), '应显示连胜/连败');
assert.ok(css.includes('.lp-metric-dmgGold') && css.includes('.lp-metric-vision'), '伤转/视野应有独立色相');
assert.ok(css.includes('.lp-metric-winstreak') && css.includes('.lp-metric-lossstreak'), '连胜连败应用实心色块与数据标签区分');
// 作战计划条并进页头, 顶部只占一行 —— 它原来单独占 54px
assert.ok(html.includes('id="liveHeadSlot"'), '页头应留出作战计划槽位');
assert.ok(live.includes('function setLiveHeadPanel') && live.includes('setLiveHeadPanel(buildLiveDecisionPanel'), '作战计划应渲染进页头槽位');
assert.ok(!/body\.innerHTML = `\s*\$\{buildLiveDecisionPanel/.test(live), '作战计划不应再占实时区一整行');
// 行高 24px + 1px 间隙 = 每场 25px, 与 Akari 的 25px 无缝行等价 —— 这是"同尺寸也露 8 场"的唯一来源。
assert.match(css, /\.ri-card\s*\{[^}]*flex:\s*0 0 24px;/s, '战绩行高必须锁在 24px');
assert.match(css, /\.lp-recent\s*\{[^}]*gap:\s*1px;/s, '战绩行间隙必须为 1px');
// 队头 = 阵营色点 + 队名 + 近期胜率 + 全队 KDA; 人数不足时用占位卡撑住 5 列, 不留半屏空白
assert.ok(live.includes('class="lp-team-dot"') && live.includes('class="lp-team-rate'), '队头应显示阵营色点与近期胜率');
assert.ok(live.includes('lp-empty') && live.includes('Array.from({ length: slots }, emptySlot)'), '人数不足时应用占位卡补齐 5 列');
assert.match(css, /\.lp-row:has\(\.ri-card:nth-child\(9\)\)::after/, '战绩溢出时底部应有渐隐提示, 而不是露出被裁断的半行');
assert.match(css, /\.ri-win\s*\{[^}]*background:[^}]*\}/s, '胜局行应整行染色');
assert.match(css, /\.ri-loss\s*\{[^}]*background:[^}]*\}/s, '败局行应整行染色');
assert.match(live, /function recentLimit\(\)\s*\{\s*return 10;\s*\}/,
  '每张玩家卡应提供最近 10 场战绩');
assert.match(css, /\.lp-wrap\s*\{[^}]*flex:\s*1;[^}]*overflow:\s*hidden;/s, '两支队伍应共同压缩在实时页可视高度内');
assert.match(css, /\.lp-team\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;/s, '两支队伍应各占实时页一半高度');
assert.match(css, /\.lp-recent\s*\{[^}]*overflow-y:\s*auto;/s, '最近 10 场应在玩家卡内部独立滚动');
assert.match(css, /\.ri-card\s*\{[^}]*flex:\s*0 0 24px;/s, '滚动区内每场战绩应保持稳定高度');
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
