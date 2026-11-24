// 分工表 (选人趣味三档评级) 测试。
// 守的是: 三档胜率阈值、文案确定性(刷新不跳字)、对阵沙盘口径, 以及
// "整体偏弱时错位确实能多赢" —— 这是这个玩法的核心卖点, 算错就成了纯噪音。
//
// 1.6.60 口径变更: 分档与沙盘强度统一改成"近期胜率"(>70 大神 / 40~70 正常人 / <40 人机),
// 不再用 PoroScout 的 0-10 状态分 —— 否则会出现"胜率 75% 判大神、沙盘却说这条路吃亏"。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'renderer/js/duty-board.js');
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); n++; };

function load(extra) {
  const sandbox = Object.assign({ console, window: {} }, extra || {});
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);
  return { M: sandbox.window.PoroDuty, sandbox };
}

// ---- 1. 三档胜率阈值 ----
{
  const { M } = load();
  eq(M.tierOf(null, 20).key, 'unknown', '没有样本 = 待定');
  eq(M.tierOf(undefined, 20).key, 'unknown', 'undefined 也不崩');
  eq(M.tierOf('', 20).key, 'unknown', '空串当作没有样本');
  eq(M.tierOf(80, 20).key, 'carry', '80% = 大神');
  eq(M.tierOf(71, 20).key, 'carry', '71% 刚过线 = 大神');
  eq(M.tierOf(70, 20).key, 'hold', '正好 70% 还是正常人 (口径是"超过 70")');
  eq(M.tierOf(55, 20).key, 'hold', '55% = 正常人');
  eq(M.tierOf(40, 20).key, 'hold', '40% 是正常人下界');
  eq(M.tierOf(39, 20).key, 'slack', '39% = 人机');
  eq(M.tierOf(0, 20).key, 'slack', '0% 也是人机, 不是待定');
  eq(M.tierOf(80, 4).key, 'unknown', '样本 4 场不足 = 待定 (不能 1 场 100% 就封神)');
  eq(M.tierOf(80, 5).key, 'carry', '5 场够最低可读样本');
  eq(M.tierOf(80, null).key, 'unknown', '没有样本数也归待定');
}

// ---- 2. 文案确定性: 同一玩家刷新不跳字 ----
{
  const { M } = load();
  eq(M.copyOf('puuid-abc', 'carry'), M.copyOf('puuid-abc', 'carry'), '同一 puuid 同一档, 文案固定');
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(M.copyOf('p' + i, 'slack'));
  ok(seen.size >= 3, '不同玩家会分到不同文案 (实际 ' + seen.size + ' 种)');
  ['carry', 'hold', 'slack', 'unknown'].forEach(k => {
    ok(M.copyOf('seed', k) && M.copyOf('seed', k).length >= 4, k + ' 档文案不为空');
  });
}

// ---- 3. 对阵沙盘: 硬碰硬 vs 错位 (强度单位 = 胜率百分点, 阈值 8) ----
{
  const { M } = load();
  const pawn = (s) => ({ s, ref: { name: 'p' + s, tier: { key: 'hold' } } });
  // 三路同胜率: 硬碰硬全五五开, 错位能吃两路
  const allies = [pawn(60), pawn(50), pawn(40)];
  const enemies = [pawn(60), pawn(50), pawn(40)];
  eq(M.pairDirect(allies, enemies).wins, 0, '同胜率硬碰硬赢不了');
  eq(M.pairCross(allies, enemies).wins, 2, '错位能吃两路');
  // 整体碾压: 怎么排都全赢
  const strong = [pawn(80), pawn(70), pawn(60)];
  const weak = [pawn(40), pawn(30), pawn(20)];
  eq(M.pairDirect(strong, weak).wins, 3, '全面占优时硬碰硬全赢');
  eq(M.pairCross(strong, weak).wins, 3, '全面占优时错位也是全赢');
  // 阈值: 差 10 个百分点算占优, 差 5 个百分点算五五开
  eq(M.pairDirect([pawn(60)], [pawn(50)]).wins, 1, '差 10 个百分点 = 占优');
  eq(M.pairDirect([pawn(55)], [pawn(50)]).evens, 1, '差 5 个百分点 = 五五开');
}

// ---- 4. build: 五人按胜率分档 + 总结 + 聊天文案 ----
{
  const { M, sandbox } = load();
  const mk = (name, puuid, team, wr, games) => ({
    name, puuid, team, championId: 1, rank: '钻石', recent: [],
    _wr: wr, _games: games == null ? 18 : games
  });
  const players = [
    mk('我', 'me', 100, 72),
    mk('队友A', 'a', 100, 68),
    mk('队友B', 'b', 100, 55),
    mk('队友C', 'c', 100, 45),
    mk('队友D', 'd', 100, 32),
    mk('敌人1', 'e1', 200, 76),
    mk('敌人2', 'e2', 200, 58),
    mk('敌人3', 'e3', 200, 50),
    mk('敌人4', 'e4', 200, 42),
    mk('敌人5', 'e5', 200, 30)
  ];
  const evalPlayer = p => ({ score: 3.5, games: p._games, wr: p._wr, kda: 3.2, reasons: [] });
  const rank = M.build(players, { selfPuuid: 'me', champName: id => '英雄' + id, evalPlayer });
  ok(rank.ready, '数据齐全时 ready');
  eq(rank.mates.length, 5, '我方 5 人');
  eq(rank.enemies.length, 5, '敌方 5 人');
  eq(rank.counts.carry, 1, '大神 1 人 (72%)');
  eq(rank.counts.hold, 3, '正常人 3 人 (68 / 55 / 45)');
  eq(rank.counts.slack, 1, '人机 1 人 (32%)');
  eq(rank.counts.unknown, 0, '都有样本, 没有待定');
  ok(rank.mates.find(m => m.isSelf).name === '我', '自己能被标出来');
  ok(rank.summary.length > 0, '有整队一句话总结');
  ok(rank.cross.plan.length === 5, '错位对阵给出 5 组');
  ok(rank.chatText.includes('【Poro·分工表】'), '聊天文案带前缀');
  ok(rank.chatText.includes('最能带 我'), '聊天文案点出胜率最高的人');
  ok(rank.chatText.includes('最需照看 队友D'), '聊天文案点出胜率最低的人');
  ok(rank.chatText.includes('大神1') && rank.chatText.includes('人机1'), '聊天文案带各档人数');
  ok(rank.chatText.includes('非胜率预测'), '聊天文案明确不是胜率预测');
  // 沙盘强度必须与分档同源: 80% 不该在同一张卡里被判"吃亏"
  const top = rank.mates.find(m => m.name === '我');
  eq(top.s, 72, '沙盘强度就是胜率百分点, 不再换一套口径');

  // 整体偏弱: 错位不该比硬碰硬更差
  const worse = M.build([
    mk('我', 'me', 100, 50), mk('B', 'b', 100, 45), mk('C', 'c', 100, 40),
    mk('E1', 'e1', 200, 60), mk('E2', 'e2', 200, 55), mk('E3', 'e3', 200, 50)
  ], { selfPuuid: 'me', evalPlayer });
  ok(worse.cross.wins >= worse.direct.wins, '错位不会比硬碰硬更差');

  // 样本不足的人进「待定」而不是照胜率硬判
  const thin = M.build([
    mk('我', 'me', 100, 100, 3), mk('B', 'b', 100, 50, 3)
  ], { selfPuuid: 'me', evalPlayer });
  eq(thin.counts.unknown, 2, '不足 5 场一律待定 (100% 也不封神)');

  // html 渲染 + 缓存给聊天按钮用
  const html = M.html(rank, {});
  ok(html.includes('fd-card'), '渲染出卡片');
  ok(html.includes('分工表'), '标题在');
  ok(html.includes('发到聊天') && html.includes('复制文案'), '两个按钮都在');
  ok(html.includes('fd-badge fd-carry') && html.includes('>大神<'), '大神徽章与文案都对');
  ok(html.includes('>正常人<') && html.includes('>人机<'), '三档名称按最终定稿渲染');
  ok(html.includes('18 场 72% 胜率'), '悬停说明用胜率口径, 不再是状态分');
  ok(sandbox.window._poroDutyRank === rank, '渲染时把本次评级缓存给发送按钮');
  ok(M.html(Object.assign({}, rank), { collapsed: true }).includes('collapsed'), '折叠态生效');
  ok(!/上等马|中等马|下等马|劣马|大腿|小腿|腿毛|带飞|稳住|划水/.test(html), '文案里不再出现被否掉的叫法');
}

// ---- 5. 边界: 没有自己 / 没评分模块 ----
{
  const { M } = load();
  eq(M.build([], { selfPuuid: 'me' }).ready, false, '空名单不渲染');
  eq(M.build([{ name: 'x', puuid: 'x', team: 100, recent: [] }], { selfPuuid: 'zzz' }).ready, false, '认不出自己所在队伍就不渲染');
  eq(M.build([{ name: 'x', puuid: 'me', team: 100 }], { selfPuuid: 'me' }).ready, false, '评分模块缺失时不硬编分数');
}

// ---- 6. 接线检查 ----
{
  const idx = fs.readFileSync(path.join(__dirname, 'renderer/index.html'), 'utf8');
  const live = fs.readFileSync(path.join(__dirname, 'renderer/js/live.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'renderer/css/poro-1630.css'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const mod = fs.readFileSync(SRC, 'utf8');
  ok(idx.includes('js/duty-board.js'), 'index.html 引了模块');
  ok(live.includes('PoroDuty.html(PoroDuty.build('), '对局页会渲染分工表');
  ok(live.includes('function toggleDutyCard') && live.includes('function sendDutyChat'), '折叠与发送入口存在');
  ok(live.includes("storeSet('dutyCollapsed'"), '折叠状态持久化');
  ok(live.includes('activeChampSelectConversation'), '复用 chat.js 的选人房间识别');
  ok(css.includes('.fd-card') && css.includes('.fd-badge.fd-carry'), '样式已落地');
  ok(String(pkg.scripts.test).includes('test_duty_board.js'), 'npm test 里登记了本测试');
  // 注意: live.js 里另有一个既有的「大腿」标签 (现在改成加权 KDA 判定),
  // 所以这里只检查分工表自己的代码段, 不能整份文件扫。
  const dutyBlock = live.slice(live.indexOf('// ---------- 分工表'), live.indexOf('// ---------- 浮窗技能计时'));
  ok(dutyBlock.length > 200, '能定位到分工表代码段');
  ok(!/上等马|中等马|下等马|大腿|小腿|腿毛|带飞|稳住|划水/.test(mod + css + dutyBlock + idx), '分工表全链路没有没被采用的叫法');
}

console.log('分工表: ' + n + ' 组断言全部通过');
