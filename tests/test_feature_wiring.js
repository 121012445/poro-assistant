'use strict';
// 接线检查: ②习惯卡 / ③重复失误 是否真的接进了产品 (不是只写了模块不用)。
// 这类"写了但没接"的漏洞在本项目历史上出现过多次 (voice.js / skeleton.css), 所以单独立一条。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(SRC, rel), 'utf8');

const html = read('renderer/index.html');
const live = read('renderer/js/live.js');
const review = read('renderer/js/review.js');
const growth = read('renderer/js/growth.js');
const css = read('renderer/css/v4.css');
const habits = read('renderer/js/player-habits.js');
const mistakes = read('renderer/js/repeat-mistakes.js');

// ---- 脚本都加载了, 且 live.js 在 player-habits.js 之后 ----
for (const f of ['js/player-habits.js', 'js/repeat-mistakes.js']) {
  assert.ok(html.includes(f), 'index.html 必须加载 ' + f);
}
assert.ok(/js\/player-habits\.js\?v=[^"]+"><\/script>\s*<script src="js\/live\.js/.test(html),
  'player-habits.js 必须在 live.js 之前加载 (live.js 在渲染时读 window.PoroHabits)');

// ---- ② 习惯卡 ----
assert.ok(habits.includes('root.PoroHabits = api'), 'player-habits.js 必须挂到 window.PoroHabits');
for (const [name, why] of [
  ['habitLineHtml(p)', '实时页要把习惯行拼进卡片'],
  ['syncLiveHabits(row, p)', '局部刷新要同步习惯行, 否则数据回来了不显示'],
  ['${habitLineHtml(p)}', 'playerRow 模板里要插入习惯行'],
  ['habitDrawerHtml(player)', '玩家详情抽屉也要有习惯清单'],
  ['lp-habit-line', '习惯行需要样式类']
]) {
  assert.ok(live.includes(name) || css.includes(name), '缺少 ' + name + ' (' + why + ')');
}
// 数据链路: recent 里必须有一血字段, 否则"一血"习惯永远不显示
assert.ok(/fb: \(\(\) => \{/.test(live), 'SGP 战绩回填必须带 fb 字段');
assert.ok(/fb: typeof me\.fb === 'boolean'/.test(live), 'LCU 兜底路径也必须带 fb 字段');
assert.ok(css.includes('.lp-habit-line'), 'v4.css 缺 .lp-habit-line');
assert.ok(css.includes('.lp-habit-warn'), 'v4.css 缺 .lp-habit-warn');

// ---- ③ 重复失误 ----
assert.ok(mistakes.includes('root.PoroMistakes = api'), 'repeat-mistakes.js 必须挂到 window.PoroMistakes');
assert.ok(growth.includes('window.PoroMistakes.recordGames(games, puuid)'), '首页落账时必须顺手记重复失误');
assert.ok(growth.includes('function growthMistakesHtml'), '成长页缺重复失误卡片');
assert.ok(growth.includes('${growthMistakesHtml()}'), '成长页模板必须插入重复失误卡片');
assert.ok(review.includes('function buildMistakeCard'), '复盘缺「本局最该改的一件事」');
assert.ok(review.includes('buildMistakeCard(norm, gameId)'), '复盘必须调用 buildMistakeCard');
assert.ok(css.includes('.rv-mistake'), 'v4.css 缺 .rv-mistake');
assert.ok(css.includes('.gw-mistake'), 'v4.css 缺 .gw-mistake');

// ---- 两条产品原则: 样本门槛 / 不打分不预测 ----
assert.ok(habits.includes('MIN_GAMES = 8') && habits.includes('if (!p.games || p.games < MIN_GAMES) return out'),
  '习惯卡必须有 8 场门槛');
assert.ok(mistakes.includes('MIN_DURATION = 600'), '重复失误必须排除 10 分钟以下的局');
assert.ok(!/胜率预测|预计胜率|大概率(赢|输)|上分概率/.test(habits + mistakes), '不得出现胜负预测话术');

// ---- 按模式分流 (2026-11 用户反馈: 大乱斗里不能谈视野/补刀/带线) ----
assert.ok(mistakes.includes('function classifyMode'), '重复失误必须按模式分流');
for (const mode of ['rift', 'aram', 'mayhem', 'arena', 'fun', 'unknown']) {
  assert.ok(mistakes.includes(mode + ':'), '缺少模式 ' + mode + ' 的配置');
}
// 大乱斗/海斗/斗魂不得判视野、补刀、野区资源
assert.ok(/aram: \{ label: '大乱斗', rules: \['deaths', 'kp', 'dmg'\] \}/.test(mistakes), '大乱斗规则集不应包含视野/补刀/资源');
assert.ok(/mayhem: \{ label: '海斗', rules: \['deaths', 'kp', 'dmg'\] \}/.test(mistakes), '海斗规则集不应包含视野/补刀/资源');
assert.ok(/arena: \{ label: '斗魂', rules: \['deaths'\] \}/.test(mistakes), '斗魂只判阵亡');
// 文案: 大乱斗的参团/阵亡提示不得出现"带线""视野"
assert.ok(!/aram: '.*(带线|视野)/.test(mistakes), '大乱斗文案不得出现"带线/视野"');
// 阈值按模式: 大乱斗阵亡门槛必须高于峡谷
assert.ok(/threshold: \{ rift: 8, aram: 12/.test(mistakes), '大乱斗阵亡阈值应高于峡谷');
// 复盘卡片要展示模式, 且"第 N 次"限定同模式
assert.ok(review.includes('primary.modeLabel'), '复盘卡片必须标明模式');
assert.ok(review.includes('{ mode: primary.mode }'), '「第 N 次」必须限定同一模式统计');
assert.ok(growth.includes('r.modeLabel'), '成长页要标出模式');
// 习惯卡也要按模式家族筛样本
assert.ok(habits.includes('function modeFamilyOf'), '习惯卡需要模式家族判定');
assert.ok(habits.includes('buildHabitProfile(recent, family)'), '习惯卡要按模式家族取样本');
assert.ok(live.includes('liveModeFamily'), 'live.js 要按当前对局模式传家族');
assert.ok(mistakes.includes("aram: { label: '大乱斗'") && mistakes.includes("tipOf(key, mode)"), '重复失误文案要按模式取');

console.log('习惯卡 / 重复失误 接线检查通过 (含按模式分流)');
