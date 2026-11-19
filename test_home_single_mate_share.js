// 1.6.13 回归: 日服/外服走 LCU 兜底, 战绩详情只返回自己 1 人。
// 旧逻辑把 "我的值/同队总和" 算成恒 100% (参团甚至 >100%) —— 假占比。
// 本测试锁定: 单人局占比类显示「—」而非 100%, 靠自己就能算的真指标保留;
// 同时训练模式 (日服 gameMode=PRACTICETOOL) 必须被过滤。
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const app = fs.readFileSync('renderer/js/app.js', 'utf8');
const home = fs.readFileSync('renderer/js/home.js', 'utf8');

// ---- ① isTrainingGame 静态 + 动态 ----
assert.ok(app.includes('"PRACTICETOOL"'), 'TRAINING_MODES 应包含 PRACTICETOOL');
assert.ok(/TRAINING_MODES\.has\(g\.gameMode\)/.test(app), '应按 gameMode 字段识别训练局');

// 抽取 isTrainingGame 函数体到 vm 执行 (app.js 无法直接 require)
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing fn ' + name);
  let depth = 0, began = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') { depth++; began = true; }
    else if (src[i] === '}') { depth--; if (began && depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced fn ' + name);
}
const trainingCtx = vm.createContext({});
vm.runInContext(
  'const TRAINING_MODES = new Set(["训练工具", "新手教程", "TUTORIAL", "PRACTICETOOL"]);\n'
  + extractFn(app, 'isTrainingGame'), trainingCtx
);
const isTrainingGame = trainingCtx.isTrainingGame;
assert.strictEqual(isTrainingGame({ gameMode: 'PRACTICETOOL', mode: 'PRACTICETOOL', queueId: 0 }), true,
  '日服训练局 gameMode=PRACTICETOOL 必须被识别');
assert.strictEqual(isTrainingGame({ gameMode: 'TUTORIAL', mode: '新手教程' }), true, 'TUTORIAL 仍识别');
assert.strictEqual(isTrainingGame({ queueId: 1090, mode: '训练工具' }), true, '国服 queueId=1090 仍识别');
assert.strictEqual(isTrainingGame({ gameMode: 'CLASSIC', mode: '海克斯大乱斗', queueId: 2400 }), false,
  '正常对局不能被误过滤');

// ---- ② buildHomeGameCard 单人假 100% ----
// 静态: 修复代码落位
assert.ok(home.includes('const soloOnly = myTeam.length < 2'), '应有「只有自己」的单人检测');
assert.ok(home.includes('const kp = soloOnly ? null'), '单人时参团应置 null');
assert.ok(home.includes('const dmgShare = soloOnly ? null'), '单人时伤害占比应置 null');
assert.ok(home.includes('const takenShare = soloOnly ? null'), '单人时承伤占比应置 null');
assert.ok(home.includes('shareText(dmgShare)') && home.includes('shareText(takenShare)'), '占比渲染应走 shareText');

// 动态: 提取 buildHomeGameCard 并注入最小 stub
// 1.6.23: 战绩卡的 MVP/ACE 判定改用 utils.js 的 championRatingOf, 这里注入真实实现
const utilsCtx = vm.createContext({ console, localStorage: { getItem: () => null, setItem: () => {} }, window: {} });
vm.runInContext(fs.readFileSync('renderer/js/utils.js', 'utf8'), utilsCtx, { filename: 'utils.js' });
const stubCtx = vm.createContext({
  champNumMap: {},
  version: '14.1.1',
  hexAugMeta: {},
  window: {},
  POS_MAP: {},
  spellMap: {},
  perkIconMap: {},
  styleIconMap: {},
  championRatingOf: utilsCtx.championRatingOf,
  findProfileParticipant: (g) => g.participants.find(p => p.isMe),
  derivePerformanceTags: () => [],
  escapeHtml: s => String(s == null ? '' : s),
  fmtNumLocal: n => Number(n || 0).toLocaleString('en-US'),
  fmtTime: () => '14:00',
  timeAgo: () => '1分钟前',
  retryImg: () => '', champImg: () => '', placeholder: () => '',
  inlineArg: v => JSON.stringify(v), getName: p => p.name || '',
  champIconAttrs: () => '', augFallback: () => '',
  hasRealPositions: () => false,
  kdaClass: () => 'v-n',
  buildPerformanceTags: () => '',
  damageCompositionBar: undefined,
  console
});
vm.runInContext(extractFn(home, 'buildHomeGameCard'), stubCtx);
const build = stubCtx.buildHomeGameCard;

function mkGame(nMates) {
  const me = { isMe: true, puuid: 'me', championId: 1, k: 10, d: 2, a: 5, win: true,
               teamId: 100, dmg: 30000, dmgTaken: 12000, gold: 15000, cs: 200, visionScore: 30,
               items: [], spells: [], perkPrimary: 0, perkSub: 0 };
  const mates = [];
  for (let i = 1; i < nMates; i++) mates.push({ puuid: 'm' + i, championId: 2, k: 2, d: 3, a: 1,
    win: true, teamId: 100, dmg: 10000, dmgTaken: 8000, gold: 9000, cs: 100, visionScore: 10,
    items: [], spells: [] });
  return { gid: 1, mode: '海克斯大乱斗', queueId: 2400, dur: 1200, time: Date.now(),
           participants: [me, ...mates] };
}

const soloHtml = build(mkGame(1), 'me');
assert.ok(soloHtml.includes('ako-na'), '单人局应渲染占位标记而不是假百分比');
assert.ok(!soloHtml.includes('>100%</div>'), '单人局不应再出现假的 100% 占比');
assert.ok(soloHtml.includes('30,000 伤害'), '单人局应保留真实伤害绝对值');
assert.ok(soloHtml.includes('12,000 承伤'), '单人局应保留真实承伤绝对值');
assert.ok(soloHtml.includes('200%'), '单人局应保留真实伤害转化率 30000/15000');

const teamHtml = build(mkGame(5), 'me');
// 全队伤害 30000 + 4*10000 = 70000, 自己占 30000/70000 = 43%
assert.ok(teamHtml.includes('43%'), '多人局伤害占比必须按全队计算 (43%), 不能是假的 100%');
assert.ok(!teamHtml.includes('ako-na'), '多人局不应显示占位标记');

console.log('test_home_single_mate_share: PASS');
