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

// 造 n 场近战: 胜场数按胜率四舍五入, 每场固定 8/4/6 —— 5 场就是 40/20/30,
// KDA = (40+30)/20 = 3.5, 断言里可以直接算得出来。
function recentOf(wr, n, k, d, a) {
  const total = n == null ? 5 : n;
  const wins = Math.max(0, Math.min(total, Math.round(total * (wr || 0) / 100)));
  return Array.from({ length: total }, (_, i) => ({
    win: i < wins, k: k == null ? 8 : k, d: d == null ? 4 : d, a: a == null ? 6 : a
  }));
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
    name, puuid, team, championId: 1, rank: '钻石', recent: recentOf(wr),
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

// ---- 4b. 聊天消息格式: 一人两行, 5 把逐场列出 (1.6.65) ----
// 用户原话: "大神 xx 然后 显示最近5把战绩 总kd多少", 随后明确
// "我不是要近5局 4胜1负 我是让你把这5局战绩列出来" —— 汇总数字过不了关, 必须逐场。
// 守的是: 每人两行(头行总KDA / 次行逐场)、按胜率降序、没样本的垫底、
//        KDA 口径与评分模块一致、单行兜底可用。
{
  const { M } = load();
  const wrMap = { me: 72, a: 68, b: null, c: 45, d: 32, e1: 76, e2: 58, e3: 50, e4: 42, e5: 30 };
  const mk = (name, puuid) => ({
    name, puuid, team: puuid[0] === 'e' ? 200 : 100, championId: 1,
    recent: puuid === 'b' ? [] : (puuid === 'c' ? recentOf(45, 3) : recentOf(wrMap[puuid]))
  });
  const players = ['me:我', 'a:队友A', 'b:队友B', 'c:队友C', 'd:队友D',
    'e1:敌人1', 'e2:敌人2', 'e3:敌人3', 'e4:敌人4', 'e5:敌人5'].map(x => mk(x.split(':')[1], x.split(':')[0]));
  const rank = M.build(players, {
    selfPuuid: 'me', champName: () => '',
    evalPlayer: p => ({ wr: wrMap[p.puuid], games: p.puuid === 'b' ? 0 : p.recent.length, score: 3 })
  });

  const lines = rank.chatLines;
  // 表头 1 + 4 个有样本的 2 行 + 无样本的 1 行 + 脚注 1 = 11
  eq(lines.length, 11, '表头 + 4 人各 2 行 + 无样本 1 行 + 脚注 = 11 行');
  ok(lines[0].startsWith('【Poro·分工表】我方'), '第一行是表头统计');
  eq(rank.chatText.split('\n').length, 11, 'chatText 就是这 11 行');
  eq(rank.chatFlat.indexOf('\n'), -1, '单行兜底版没有换行');
  ok(rank.chatFlat.includes(' ｜ '), '单行兜底版用竖线分隔');

  eq(lines[1], '大神 我 总KDA 3.5', '头行: 档位 + 名字 + 总 KDA');
  eq(lines[2], '· 胜 8/4/6 ｜ 胜 8/4/6 ｜ 胜 8/4/6 ｜ 胜 8/4/6 ｜ 负 8/4/6',
    '次行把 5 把逐场列出来 (每场 K/D/A + 胜负)');
  eq((lines[2].match(/胜/g) || []).length, 4, '5 场里 4 胜逐场标出');
  eq((lines[2].match(/负/g) || []).length, 1, '5 场里 1 负逐场标出');
  ok(lines[3].indexOf('队友A') > 0, '第三行起是第二个队友 (按胜率降序)');
  ok(lines[4].split('｜').length === 5, '次行固定 5 段, 一场一段');

  ok(lines[5].startsWith('待定 队友C'), '排序: 72 / 68 / 45 / 32 / 无样本 (不足 5 场记待定)');
  eq((lines[6].match(/｜/g) || []).length, 2, '只有 3 场样本的队友就只列 3 场, 不补假数据');
  ok(lines[6].indexOf('胜 8/4/6') === 2, '3 场样本同样逐场列');

  ok(lines[9].includes('无样本'), '没有任何近期记录的人写无样本');
  ok(lines[9].startsWith('待定'), '无样本的人档位是待定');
  eq(lines[9].indexOf('·'), -1, '无样本不占第二行');
  ok(lines[10].includes('硬碰硬赢') && lines[10].includes('非胜率预测'), '脚注保留沙盘与免责');

  // 单行兜底: 一场一个 胜9/2/7, 不能把明细丢掉
  ok(rank.chatFlat.includes('胜8/4/6'), '单行兜底版也保留逐场明细');
  eq(rank.chatFlat.indexOf('近5局'), -1, '不再出现"近5局 4胜1负"这种只有汇总的写法');

  // KDA 口径: (K+A)/D, 死 0 场不能炸成 Infinity
  const s5 = M.recent5Of({ recent: [{ win: true, k: 10, d: 0, a: 5 }, { win: false, k: 0, d: 0, a: 0 }] });
  eq(s5.n, 2, '按场次统计');
  eq(s5.wins, 1, '胜场统计');
  ok(s5.kda === 15, '死 0 场时按 max(1,D) 兜底, 不出 Infinity');
  eq(s5.games.length, 2, '逐场明细跟着一起返回');
  eq(s5.games[0].k, 10, '逐场保留 K');
  eq(s5.games[1].win, false, '逐场保留胜负');
  eq(M.recent5Of({ recent: recentOf(60, 30) }).n, 5, '只取最近 5 把, 不是近 30 把');
  eq(M.recent5Of({ recent: recentOf(60, 30) }).games.length, 5, '逐场明细同样只取 5 把');
  eq(M.recent5Of({}).n, 0, '没有 recent 字段时记 0 场');

  // 预览必须和聊天消息同源, 否则"预览看到的"和"发出去的"对不上
  const pv = M.previewHtml(rank);
  ok(pv.includes('总KDA 3.5'), '工具箱预览头行显示总 KDA');
  ok(pv.includes('胜 8/4/6'), '工具箱预览逐场列出 5 把');
  ok(pv.includes('无样本'), '预览里无样本同样标注');
  eq(pv.indexOf('4胜1负'), -1, '预览也不再只给汇总数字');
}

// ---- 5. 边界: 没有自己 / 没评分模块 ----
{
  const { M } = load();
  eq(M.build([], { selfPuuid: 'me' }).ready, false, '空名单不渲染');
  eq(M.build([{ name: 'x', puuid: 'x', team: 100, recent: [] }], { selfPuuid: 'zzz' }).ready, false, '认不出自己所在队伍就不渲染');
  eq(M.build([{ name: 'x', puuid: 'me', team: 100 }], { selfPuuid: 'me' }).ready, false, '评分模块缺失时不硬编分数');
}

// ---- 6. 档位名自定义 (1.6.62) ----
// 用户要求: 工具箱里能看见等级文案, 且这套文案能自己改。
// 守的边界: 改名只换叫法, 阈值/样本门槛一分不动; 脏输入(空/超长/换行)要能兜住,
// 因为这段字符串最终会进选人聊天消息体。
{
  const { M } = load();
  eq(M.labelOf('carry'), '大神', '默认高档名');
  eq(M.labelOf('hold'), '正常人', '默认中档名');
  eq(M.labelOf('slack'), '人机', '默认低档名');
  eq(M.labelOf('unknown'), '待定', '默认待定名');
  ok(M.labelsAreDefault(), '初始就是默认名');

  // 改名后 getter 立即跟上 —— 已缓存的 rank / 已渲染的 DOM 不用重建
  M.setLabels({ carry: '猛男', hold: '路人', slack: '菜鸡', unknown: '新人' });
  eq(M.TIERS[0].label, '猛男', 'TIERS getter 跟随自定义名');
  eq(M.tierOf(80, 20).label, '猛男', 'tierOf 返回的档位带新名字');
  eq(M.tierOf(50, 20).label, '路人', '中档新名字');
  eq(M.tierOf(10, 20).label, '菜鸡', '低档新名字');
  eq(M.tierOf(50, 2).label, '新人', '待定新名字');
  // 改名字不能动摇阈值
  eq(M.tierOf(70, 20).key, 'hold', '改名后 70% 仍是中档 (口径是"超过 70")');
  eq(M.tierOf(4, 20).key, 'slack', '改名后低胜率仍判低档');
  eq(M.tierOf(80, 4).key, 'unknown', '改名后样本门槛不变');

  // 清洗: 连续空白压成一个
  M.setLabels({ carry: '  猛   男  ' });
  eq(M.labelOf('carry'), '猛 男', '两端 trim, 中间连续空白压成一个');
  // 超长按字符截断 (6 字上限, 免得聊天消息被撑爆)
  M.setLabels({ carry: '一二三四五六七八' });
  eq(M.labelOf('carry'), '一二三四五六', '超过 6 字截断');
  eq(Array.from(M.labelOf('carry')).length, 6, '截断后正好 6 字');
  // 换行/制表会切断聊天消息体
  M.setLabels({ carry: '换\n行\t制表' });
  eq(M.labelOf('carry'), '换 行 制表', '换行/制表压成空格');
  // 空值回默认, 不能出现没有名字的档位
  M.setLabels({ carry: '   ' });
  eq(M.labelOf('carry'), '大神', '纯空白回退默认');
  M.setLabels({ carry: '' });
  eq(M.labelOf('carry'), '大神', '空串回退默认');
  // 只认四个档位键
  M.setLabels({ nope: 'x' });
  eq(M.labelOf('nope'), '', '不认识的档位键不会被写入');
  eq(Object.keys(M.getLabels()).length, 4, '只维护 4 个档位');
  // 局部修改不影响其他档位
  M.setLabels({ hold: '中坚' });
  eq(M.labelOf('carry'), '大神', '只改中档时高档保持原值');
  eq(M.labelOf('hold'), '中坚', '中档生效');
  M.resetLabels();
  ok(M.labelsAreDefault(), 'resetLabels 恢复默认');
  eq(M.TIERS[2].label, '人机', 'reset 后 TIERS getter 也回来');

  // 全链路: 聊天文案 / 卡片 / 预览都要跟着改名
  M.setLabels({ carry: '猛男', hold: '路人', slack: '菜鸡', unknown: '新人' });
  const mk = (name, puuid, team, wr, games) => ({
    name, puuid, team, championId: 1, rank: '钻石', recent: recentOf(wr),
    _wr: wr, _games: games == null ? 18 : games
  });
  const evalPlayer = p => ({ score: 3.5, games: p._games, wr: p._wr, kda: 3.2, reasons: [] });
  const rank = M.build([
    mk('我', 'me', 100, 72), mk('队友A', 'a', 100, 55), mk('队友B', 'b', 100, 50),
    mk('队友C', 'c', 100, 45), mk('队友D', 'd', 100, 32),
    mk('敌人1', 'e1', 200, 76), mk('敌人2', 'e2', 200, 58)
  ], { selfPuuid: 'me', evalPlayer });
  ok(rank.chatText.includes('猛男1'), '聊天文案用自定义高档名');
  ok(rank.chatText.includes('菜鸡1'), '聊天文案用自定义低档名');
  ok(rank.summary.includes('猛男'), '总结句跟着改名');
  ok(!rank.chatText.includes('大神'), '聊天文案里不再残留默认名');
  const cardHtml = M.html(rank, {});
  ok(cardHtml.includes('>猛男<') && cardHtml.includes('>路人<'), '卡片徽章用自定义名');

  const pv = M.previewHtml(rank);
  ok(pv.includes('fd-pv'), '预览有容器');
  ok(pv.includes('>猛男<') && pv.includes('>菜鸡<'), '预览徽章用自定义名');
  eq((pv.match(/fd-pv-row/g) || []).length, 5, '预览列出我方 5 人');
  ok(pv.includes('硬碰硬') && pv.includes('错位'), '预览带对阵摘要');
  ok(pv.includes(rank.summary), '预览带整队一句话');
  ok(pv.includes('&gt;70%') && pv.includes('&lt;40%'), '档位阈值按 HTML 转义输出');
  const chipText = pv.slice(pv.indexOf('fd-pv-legend'), pv.indexOf('fd-pv-list'));
  ok(!chipText.includes('<40%') && !chipText.includes('>70%'), '图例里没有裸不等号 (会把标签打断)');
  // 没有数据时也要能看见"档位定义", 否则改完名字毫无反馈
  const pvEmpty = M.previewHtml(null);
  ok(pvEmpty.includes('fd-pv-legend'), '空态显示档位图例');
  ok(pvEmpty.includes('进入选人阶段'), '空态说明什么时候有数据');
  ok(M.previewHtml(null, { empty: '自定义提示' }).includes('自定义提示'), '空态文案可覆盖');
  ok(M.legendHtml().includes('fd-pv-chip'), '图例可单独取用 (给工具箱标题行)');
  M.resetLabels();
}

// ---- 6c. 总结句的人数必须与分档对得上 (1.6.63) ----
// 1.6.62 之前的写法是 c.carry >= 2 一条吃掉 2 和 3, 而且兜底句固定是「有大神有人机」:
// 三个大神会写成"有两个", 0 大神 + 有未知样本时会说出一个根本不存在的大神。
// 这种自相矛盾出现在工具箱预览的第一行, 比句式单调难看得多。
{
  const { M } = load();
  const mkP = (name, team, wr) => ({ name, puuid: name, team, championId: 1, _wr: wr, _games: 18 });
  const buildWith = wrList => {
    const players = wrList.map((wr, i) => mkP('A' + i, 100, wr));
    for (let i = 0; i < 5; i++) players.push(mkP('E' + i, 200, 55));
    return M.build(players, {
      selfPuuid: 'A0',
      evalPlayer: p => ({ wr: p._wr, games: p._games, score: 3 })
    });
  };

  const threeCarry = buildWith([55, 80, 75, 72, 30]);
  eq(threeCarry.counts.carry, 3, '三个大神的分档');
  ok(threeCarry.summary.startsWith('三个'), '三个大神要说"三个"');
  ok(!threeCarry.summary.includes('两个'), '三个大神不能说成"有两个"');

  const noCarryUnknown = buildWith([55, 50, 45, 30, null]);
  eq(noCarryUnknown.counts.carry, 0, '这一队没有大神');
  ok(noCarryUnknown.summary.includes('没有'), '0 大神要明说没有');
  ok(!noCarryUnknown.summary.startsWith('有大神'), '0 大神时不能开口就说"有大神"');

  const twoUnknown = buildWith([55, 50, 45, null, null]);
  eq(twoUnknown.counts.unknown, 2, '两个待定');
  ok(twoUnknown.summary.includes('2个') && twoUnknown.summary.includes('还没看透'), '未知样本按人数点名');
  ok(!twoUnknown.summary.includes('人机'), '没有样本时不能凭空说来人机');

  const allHold = buildWith([60, 55, 52, 48, 45]);
  ok(allHold.summary.includes('整齐得像军训'), '全员正常人走整队句');

  const allCarry = buildWith([80, 78, 76, 74, 72]);
  ok(allCarry.summary.startsWith('全员'), '五个大神走全员句, 不说"四个"');

  const allSlack = buildWith([30, 25, 20, 15, 10]);
  ok(allSlack.summary.includes('送温暖'), '全员人机走全员句, 不说"三个"');

  // 改名之后, 人数句里的档位名同样要跟着换
  M.setLabels({ carry: '猛男' });
  ok(buildWith([55, 80, 75, 72, 30]).summary.startsWith('三个猛男'), '人数句跟着改名');
  M.resetLabels();
  ok(!fs.readFileSync(SRC, 'utf8').includes("'有' + T('carry') + '有'"), '那条会自相矛盾的兜底句已删除');
}

// ---- 7. 接线检查 ----
{
  const idx = fs.readFileSync(path.join(__dirname, 'renderer/index.html'), 'utf8');
  const live = fs.readFileSync(path.join(__dirname, 'renderer/js/live.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'renderer/css/poro-1630.css'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const mod = fs.readFileSync(SRC, 'utf8');
  ok(idx.includes('js/duty-board.js'), 'index.html 引了模块');
  // 1.6.61: 页面里不再铺卡 (会挤压战绩区, 进对局后也发不了选人聊天),
  // 只在选人阶段、自己那一队的标题栏留一个「发分工表」按钮。
  ok(live.includes('PoroDuty.build(data'), '评级仍在后台算好供发送用');
  ok(!live.includes('PoroDuty.html('), '页面里不再渲染分工表卡片');
  ok(!live.includes('toggleDutyCard') && !live.includes('dutyCollapsed'), '折叠相关死代码已清掉');
  ok(!live.includes('copyDutyText('), '复制按钮一并移除, 只留发送');
  ok(live.includes('function sendDutyChat') && live.includes('sendDutyChat()'), '保留发到选人聊天的入口');
  ok(live.includes('function sendDutyChat'), '保留发送实现');
  ok(idx.includes('sendDutyChat()'), '工具箱里有发送按钮 (唯一入口)');
  ok(live.includes("_gameflowPhase !== 'ChampSelect'"), '发送前校验选人阶段');
  ok(!live.includes('dutyBtn'), '对局页不再挂任何分工表按钮');
  ok(!live.includes('isChampSelect && selfTeamNum'), '队伍标题栏没被改动');
  ok(live.includes('activeChampSelectConversation'), '复用 chat.js 的选人房间识别');
  ok(!/PoroDuty\.html/.test(live), 'PoroDuty.html 彻底不再被调用');
  ok(css.includes('.fd-card') && css.includes('.fd-badge.fd-carry'), '样式已落地');
  // 1.6.62: 工具箱里能看见等级文案, 而且这套文案能自己改
  ok(idx.includes('id="dutyPreview"'), '工具箱里有预览容器');
  eq((idx.match(/dutyLabel(?:Carry|Hold|Slack|Unknown)"/g) || []).length, 4, '四个档位各一个输入框');
  ok(idx.includes('applyDutyLabels()') && idx.includes('saveDutyLabels()'), '输入框接上实时生效与落盘');
  ok(live.includes('function initDutyLabels') && live.includes('function refreshDutyPreview'), '载入与重画都有实现');
  ok(live.includes('function applyDutyLabels') && live.includes('function saveDutyLabels')
    && live.includes('function resetDutyLabels'), '改名的三个动作都有实现');
  ok(live.includes("storeSet('dutyLabels'"), '自定义名字会落盘');
  ok(live.includes('refreshDutyPreview();'), '选人渲染后顺手刷预览');
  ok(live.includes('PoroDuty.previewHtml('), '预览复用模块里的纯函数');
  const persistSrc = fs.readFileSync(path.join(__dirname, 'renderer/js/persist.js'), 'utf8');
  ok(persistSrc.includes("'dutyLabels'"), '备份导入白名单含 dutyLabels');
  ok(persistSrc.includes('initDutyLabels()'), '启动时恢复自定义名字');
  ok(css.includes('.fd-pv-row') && css.includes('.duty-label-input'), '预览与输入框样式已落地');
  ok(String(pkg.scripts.test).includes('test_duty_board.js'), 'npm test 里登记了本测试');
  // 注意: live.js 里另有一个既有的「大腿」标签 (现在改成加权 KDA 判定),
  // 所以这里只检查分工表自己的代码段, 不能整份文件扫。
  const dutyBlock = live.slice(live.indexOf('// ---------- 分工表'), live.indexOf('// ---------- 浮窗技能计时'));
  ok(dutyBlock.length > 200, '能定位到分工表代码段');
  ok(!/上等马|中等马|下等马|大腿|小腿|腿毛|带飞|稳住|划水/.test(mod + css + dutyBlock + idx), '分工表全链路没有没被采用的叫法');
}

console.log('分工表: ' + n + ' 组断言全部通过');
