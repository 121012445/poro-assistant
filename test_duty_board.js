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

// ---- 1. 五档加权 KDA 阈值 ----
// 1.6.66: 分档口径从胜率改成"近 5 场加权 KDA"(K + 0.5A)/D, 五档
// 上等马 ≥3.5 / 中等马 ≥2.5 / 下等马 ≥1.8 / 牛马 ≥1.0 / 没有马 <1.0。
// 助攻只算半个是用户明确要求的("助攻权重得下降"), 与大腿标签同口径。
{
  const { M } = load();
  eq(M.tierOf(null, 20).key, 'unknown', '没有样本 = 待定');
  eq(M.tierOf(undefined, 20).key, 'unknown', 'undefined 也不崩');
  eq(M.tierOf('', 20).key, 'unknown', '空串当作没有样本');
  eq(M.tierOf(6.2, 5).key, 'top', '6.2 = 上等马');
  eq(M.tierOf(3.5, 5).key, 'top', '3.5 是上等马下界 (含)');
  eq(M.tierOf(3.49, 5).key, 'mid', '3.49 掉到中等马');
  eq(M.tierOf(2.5, 5).key, 'mid', '2.5 是中等马下界');
  eq(M.tierOf(2.49, 5).key, 'low', '2.49 = 下等马');
  eq(M.tierOf(1.8, 5).key, 'low', '1.8 是下等马下界');
  eq(M.tierOf(1.79, 5).key, 'ox', '1.79 = 牛马');
  eq(M.tierOf(1.0, 5).key, 'ox', '1.0 是牛马下界');
  eq(M.tierOf(0.99, 5).key, 'zero', '0.99 = 没有马');
  eq(M.tierOf(0, 5).key, 'zero', 'KDA 0 也是没有马, 不是待定');
  eq(M.tierOf(9, 4).key, 'unknown', '样本 4 场不足 = 待定 (不能 1 场 10/0 就封上等马)');
  eq(M.tierOf(9, 5).key, 'top', '5 场够最低可读样本');
  eq(M.tierOf(9, null).key, 'unknown', '没有样本数也归待定');
  eq(M.TIERS.length, 5, '一共五档');
  eq(M.TIERS.map(t => t.key).join(','), 'top,mid,low,ox,zero', '档位顺序从强到弱');
}

// ---- 2. 文案确定性: 同一玩家刷新不跳字 ----
{
  const { M } = load();
  eq(M.copyOf('puuid-abc', 'top'), M.copyOf('puuid-abc', 'top'), '同一 puuid 同一档, 文案固定');
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(M.copyOf('p' + i, 'zero'));
  ok(seen.size >= 3, '不同玩家会分到不同文案 (实际 ' + seen.size + ' 种)');
  ['top', 'mid', 'low', 'ox', 'zero', 'unknown'].forEach(k => {
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

// ---- 4. build: 五人按加权 KDA 分档 + 总结 + 聊天文案 ----
{
  const { M, sandbox } = load();
  // 五档各一人, 单场固定 K/D/A 五场一样, 加权 KDA = (K + 0.5A) / D:
  //   TOP 10/3/6 → 4.33 · MID 8/4/6 → 2.75 · LOW 6/5/6 → 1.8 · OX 4/7/6 → 1.0 · ZERO 2/9/5 → 0.5
  const TOP = [10, 3, 6], MID = [8, 4, 6], LOW = [6, 5, 6], OX = [4, 7, 6], ZERO = [2, 9, 5];
  // games 同时决定 recent 的长度 —— s5.n 是从 recent 数出来的, 只改 _games 骗不过样本门槛
  const mk = (name, puuid, team, wr, st, games) => ({
    name, puuid, team, championId: 1, rank: '钻石',
    recent: st ? recentOf(wr, games == null ? 18 : games, st[0], st[1], st[2]) : [],
    _wr: wr, _games: games == null ? 18 : games
  });
  const players = [
    mk('我', 'me', 100, 72, TOP),
    mk('队友A', 'a', 100, 68, MID),
    mk('队友B', 'b', 100, 55, LOW),
    mk('队友C', 'c', 100, 45, OX),
    mk('队友D', 'd', 100, 32, ZERO),
    mk('敌人1', 'e1', 200, 76), mk('敌人2', 'e2', 200, 58),
    mk('敌人3', 'e3', 200, 50), mk('敌人4', 'e4', 200, 42), mk('敌人5', 'e5', 200, 30)
  ];
  const evalPlayer = p => ({ score: 3.5, games: p._games, wr: p._wr, kda: 3.2, reasons: [] });
  const rank = M.build(players, { selfPuuid: 'me', champName: id => '英雄' + id, evalPlayer });
  ok(rank.ready, '数据齐全时 ready');
  eq(rank.mates.length, 5, '我方 5 人');
  eq(rank.enemies.length, 5, '敌方 5 人');
  eq(rank.counts.top, 1, '上等马 1 人 (KDA 4.3)');
  eq(rank.counts.mid, 1, '中等马 1 人 (2.75)');
  eq(rank.counts.low, 1, '下等马 1 人 (1.8)');
  eq(rank.counts.ox, 1, '牛马 1 人 (1.0)');
  eq(rank.counts.zero, 1, '没有马 1 人 (0.5)');
  eq(rank.counts.unknown, 0, '都有样本, 没有待定');
  ok(rank.mates.find(m => m.isSelf).name === '我', '自己能被标出来');
  ok(rank.summary.length > 0, '有整队一句话总结');
  ok(rank.cross.plan.length === 5, '错位对阵给出 5 组');
  ok(rank.chatText.includes('【Poro·分工表】'), '聊天文案带前缀');
  ok(rank.chatText.includes('最能带 我'), '最能带按 KDA 最高选');
  ok(rank.chatText.includes('最需照看 队友D'), '最需照看按 KDA 最低选');
  ok(rank.chatText.includes('上等马1') && rank.chatText.includes('没有马1'), '聊天文案带各档人数');
  ok(rank.chatText.includes('非胜率预测'), '聊天文案明确不是胜率预测');
  // 沙盘强度仍然按胜率 (跨位置比 KDA 没意义), 与分档口径故意不同源
  const top = rank.mates.find(m => m.name === '我');
  eq(top.s, 72, '沙盘强度是胜率百分点, 分档改 KDA 后沙盘没跟着换口径');
  eq(top.tier.key, 'top', '但分档看的是 KDA');

  // 整体偏弱: 错位不该比硬碰硬更差
  const worse = M.build([
    mk('我', 'me', 100, 50, MID), mk('B', 'b', 100, 45, LOW), mk('C', 'c', 100, 40, OX),
    mk('E1', 'e1', 200, 60), mk('E2', 'e2', 200, 55), mk('E3', 'e3', 200, 50)
  ], { selfPuuid: 'me', evalPlayer });
  ok(worse.cross.wins >= worse.direct.wins, '错位不会比硬碰硬更差');

  // 样本不足的人进「待定」而不是照着 1-2 场硬判
  const thin = M.build([
    mk('我', 'me', 100, 100, TOP, 4), mk('B', 'b', 100, 50, TOP, 4)
  ], { selfPuuid: 'me', evalPlayer });
  eq(thin.counts.unknown, 2, '不足 5 场一律待定 (KDA 再高也不封上等马)');

  // html 渲染 + 缓存给聊天按钮用
  const html = M.html(rank, {});
  ok(html.includes('fd-card'), '渲染出卡片');
  ok(html.includes('分工表'), '标题在');
  ok(html.includes('发到聊天') && html.includes('复制文案'), '两个按钮都在');
  ok(html.includes('fd-badge fd-top') && html.includes('>上等马<'), '上等马徽章与文案都对');
  ok(html.includes('>中等马<') && html.includes('>下等马<') && html.includes('>牛马<') && html.includes('>没有马<'),
    '五档名称按最终定稿渲染');
  ok(html.includes('18 场 72% 胜率'), '悬停说明保留胜率与样本数');
  ok(html.includes('加权 KDA'), '页脚写清分档看加权 KDA');
  ok(sandbox.window._poroDutyRank === rank, '渲染时把本次评级缓存给发送按钮');
  ok(M.html(Object.assign({}, rank), { collapsed: true }).includes('collapsed'), '折叠态生效');
  ok(!/大神|正常人|人机|大腿|小腿|腿毛|带飞|稳住|划水/.test(html), '旧一轮被否掉的叫法不再出现');
}

// ---- 4b. 聊天消息格式: 一人两行, 5 把逐场列出 (1.6.65/1.6.66) ----
// 用户先要"大神 xx + 最近 5 把战绩 + 总 kd", 又明确"把这 5 局战绩列出来"、"按 kd 排,
// 但助攻权重得下降" —— 所以头行是档位+加权 KDA, 次行逐场摆 K/D/A。
// 守的是: 每人两行、按加权 KDA 降序、没样本的垫底、样本不足不硬判、单行兜底可用。
{
  const { M } = load();
  const TOP = [10, 3, 6], MID = [8, 4, 6], LOW = [6, 5, 6], OX = [4, 7, 6];
  const mk = (name, puuid, team, wr, st) => ({
    name, puuid, team, championId: 1,
    recent: st ? recentOf(wr, 5, st[0], st[1], st[2]) : []
  });
  const players = [
    mk('我', 'me', 100, 72, TOP),
    mk('队友A', 'a', 100, 68, MID),
    mk('队友B', 'b', 100, 55, LOW),
    mk('队友C', 'c', 100, 45, OX),
    mk('队友D', 'd', 100, 32),                    // 没有近期记录 → 待定, 只占一行
    mk('敌人1', 'e1', 200, 76), mk('敌人2', 'e2', 200, 58), mk('敌人3', 'e3', 200, 50),
    mk('敌人4', 'e4', 200, 42), mk('敌人5', 'e5', 200, 30)
  ];
  const evalPlayer = p => ({ wr: 50, games: p.recent.length, score: 3 });
  const rank = M.build(players, { selfPuuid: 'me', champName: () => '', evalPlayer });

  const lines = rank.chatLines;
  // 表头 1 + 4 人各 2 行 + 无样本 1 行 + 分隔线 1 + 脚注 1 = 12
  eq(lines.length, 12, '表头 + 4 人各 2 行 + 无样本 1 行 + 分隔线 + 脚注 = 12 行');
  ok(lines[0].startsWith('【Poro·分工表】我方'), '第一行是表头统计');
  ok(lines[0].includes('★上等马1') && lines[0].includes('●牛马1') && !lines[0].includes('待定'), '表头用符号标档位, 待定不进统计');
  eq(rank.chatText.split('\n').length, 12, 'chatText 就是这 12 行');
  eq(rank.chatFlat.indexOf('\n'), -1, '单行兜底版没有换行');
  ok(rank.chatFlat.includes(' ｜ '), '单行兜底版用竖线分隔');

  eq(lines[1], '★上等马 我 加权KDA 4.3', '头行: 符号 + 档位 + 名字 + 加权 KDA');
  eq(lines[2], '  胜 10/3/6 ｜ 胜 10/3/6 ｜ 胜 10/3/6 ｜ 胜 10/3/6 ｜ 负 10/3/6',
    '次行把 5 把逐场列出来 (每场 K/D/A + 胜负)');
  eq((lines[2].match(/胜/g) || []).length, 5 - 1, '5 场里 4 胜逐场标出');
  eq((lines[2].match(/负/g) || []).length, 1, '5 场里 1 负逐场标出');
  eq(lines[2].split('｜').length, 5, '次行固定 5 段, 一场一段');
  ok(lines[3].startsWith('◆中等马 队友A'), '排序: 4.3 / 2.8 / 1.8 / 1.0 / 无样本');
  ok(lines[5].startsWith('▼下等马 队友B'), '第三位是下等马');
  ok(lines[7].startsWith('●牛马 队友C'), '第四位是牛马');
  ok(lines[9].includes('无样本') && lines[9].startsWith('·待定'), '没有任何近期记录的人写无样本、档位待定');
  eq(lines[10], '━━━━━━━━', '名单与结论之间有分隔线');
  ok(lines[11].includes('★最能带') && lines[11].includes('⚠最需照看'), '重点人用符号标出');
  ok(lines[11].includes('硬碰硬赢') && lines[11].includes('非胜率预测'), '脚注保留沙盘与免责');

  // 单行兜底: 一场一个 胜10/3/6, 不能把明细丢掉
  ok(rank.chatFlat.includes('胜10/3/6'), '单行兜底版也保留逐场明细');
  eq(rank.chatFlat.indexOf('近5局'), -1, '不再出现"近5局 4胜1负"这种只有汇总的写法');

  // 加权口径: (K + 0.5A) / max(1,D), 助攻只算半个; 死 0 场不炸 Infinity
  const s5 = M.recent5Of({ recent: [{ win: true, k: 10, d: 0, a: 5 }, { win: false, k: 0, d: 0, a: 0 }] });
  eq(s5.n, 2, '按场次统计');
  eq(s5.wins, 1, '胜场统计');
  eq(s5.kda, 12.5, '助攻算半个: (10 + 0.5×5) / max(1,0) = 12.5, 不是 15');
  eq(M.recent5Of({ recent: [{ win: true, k: 6, d: 4, a: 10 }] }).kda, 2.8,
    '纯助攻型 6/4/10 只算 2.8 (旧口径是 4.0)');
  eq(s5.games.length, 2, '逐场明细跟着一起返回');
  eq(s5.games[0].k, 10, '逐场保留 K');
  eq(s5.games[1].win, false, '逐场保留胜负');
  eq(M.recent5Of({ recent: recentOf(60, 30) }).n, 5, '只取最近 5 把, 不是近 30 把');
  eq(M.recent5Of({ recent: recentOf(60, 30) }).games.length, 5, '逐场明细同样只取 5 把');
  eq(M.recent5Of({}).n, 0, '没有 recent 字段时记 0 场');

  // 3 场样本: 照实列 3 场, 分档走待定
  const thin = M.build([
    { name: '我', puuid: 'me', team: 100, championId: 1, recent: recentOf(50, 3, 10, 3, 6) },
    { name: 'E', puuid: 'e1', team: 200, championId: 1, recent: recentOf(50, 5, 4, 6, 4) }
  ], { selfPuuid: 'me', evalPlayer });
  ok(thin.ready, '3 场样本也能出表');
  ok(thin.chatLines[1].startsWith('·待定 我'), '样本不足 4 场进待定(待定用 · 标记)');
  eq(thin.chatLines[2].split('｜').length, 3, '只有 3 场就只列 3 段, 不补假数据');

  // 预览必须和聊天消息同源, 否则"预览看到的"和"发出去的"对不上
  const pv = M.previewHtml(rank);
  ok(pv.includes('加权KDA 4.3'), '工具箱预览头行显示加权 KDA');
  ok(pv.includes('胜 10/3/6'), '工具箱预览逐场列出 5 把');
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

// ---- 6. 档位名自定义 (1.6.62/1.6.66) ----
// 用户要求: 工具箱里能看见等级文案, 且这套文案能自己改。
// 守的边界: 改名只换叫法, 阈值/样本门槛一分不动; 脏输入(空/超长/换行)要能兜住,
// 因为这段字符串最终会进选人聊天消息体。
{
  const { M } = load();
  eq(M.labelOf('top'), '上等马', '默认一档名');
  eq(M.labelOf('mid'), '中等马', '默认二档名');
  eq(M.labelOf('low'), '下等马', '默认三档名');
  eq(M.labelOf('ox'), '牛马', '默认四档名');
  eq(M.labelOf('zero'), '没有马', '默认五档名');
  eq(M.labelOf('unknown'), '待定', '默认待定名');
  ok(M.labelsAreDefault(), '初始就是默认名');

  // 改名后 getter 立即跟上 —— 已缓存的 rank / 已渲染的 DOM 不用重建
  M.setLabels({ top: '汗血宝马', mid: '路人', low: '瘸腿马', ox: '工具人', zero: '空气', unknown: '新人' });
  eq(M.TIERS[0].label, '汗血宝马', 'TIERS getter 跟随自定义名');
  eq(M.tierOf(4.3, 5).label, '汗血宝马', 'tierOf 返回的档位带新名字');
  eq(M.tierOf(2.8, 5).label, '路人', '二档新名字');
  eq(M.tierOf(1.8, 5).label, '瘸腿马', '三档新名字');
  eq(M.tierOf(1.0, 5).label, '工具人', '四档新名字');
  eq(M.tierOf(0.2, 5).label, '空气', '五档新名字');
  eq(M.tierOf(4.3, 2).label, '新人', '待定新名字');
  // 改名字不能动摇阈值
  eq(M.tierOf(3.49, 5).key, 'mid', '改名后 3.49 仍是二档');
  eq(M.tierOf(0.99, 5).key, 'zero', '改名后低 KDA 仍判五档');
  eq(M.tierOf(9, 4).key, 'unknown', '改名后样本门槛不变');

  // 清洗: 连续空白压成一个
  M.setLabels({ top: '  猛   男  ' });
  eq(M.labelOf('top'), '猛 男', '两端 trim, 中间连续空白压成一个');
  // 超长按字符截断 (6 字上限, 免得聊天消息被撑爆)
  M.setLabels({ top: '一二三四五六七八' });
  eq(M.labelOf('top'), '一二三四五六', '超过 6 字截断');
  eq(Array.from(M.labelOf('top')).length, 6, '截断后正好 6 字');
  // 换行/制表会切断聊天消息体
  M.setLabels({ top: '换\n行\t制表' });
  eq(M.labelOf('top'), '换 行 制表', '换行/制表压成空格');
  // 空值回默认, 不能出现没有名字的档位
  M.setLabels({ top: '   ' });
  eq(M.labelOf('top'), '上等马', '纯空白回退默认');
  M.setLabels({ top: '' });
  eq(M.labelOf('top'), '上等马', '空串回退默认');
  // 只认六个档位键
  M.setLabels({ nope: 'x' });
  eq(M.labelOf('nope'), '', '不认识的档位键不会被写入');
  eq(Object.keys(M.getLabels()).length, 6, '只维护 6 个档位 (五档 + 待定)');
  // 局部修改不影响其他档位
  M.setLabels({ mid: '中坚' });
  eq(M.labelOf('top'), '上等马', '只改二档时一档保持原值');
  eq(M.labelOf('mid'), '中坚', '二档生效');
  M.resetLabels();
  ok(M.labelsAreDefault(), 'resetLabels 恢复默认');
  eq(M.TIERS[4].label, '没有马', 'reset 后 TIERS getter 也回来');

  // 全链路: 聊天文案 / 卡片 / 预览都要跟着改名
  M.setLabels({ top: '猛男', mid: '路人', low: '瘸腿', ox: '工具人', zero: '空气', unknown: '新人' });
  const TOP = [10, 3, 6], MID = [8, 4, 6], LOW = [6, 5, 6], OX = [4, 7, 6], ZERO = [2, 9, 5];
  const mk = (name, puuid, team, wr, st) => ({
    name, puuid, team, championId: 1, rank: '钻石',
    recent: st ? recentOf(wr, 5, st[0], st[1], st[2]) : []
  });
  const evalPlayer = p => ({ score: 3.5, games: p.recent.length, wr: 50, kda: 3.2, reasons: [] });
  const rank = M.build([
    mk('我', 'me', 100, 72, TOP), mk('队友A', 'a', 100, 55, MID), mk('队友B', 'b', 100, 50, LOW),
    mk('队友C', 'c', 100, 45, OX), mk('队友D', 'd', 100, 32, ZERO),
    mk('敌人1', 'e1', 200, 76), mk('敌人2', 'e2', 200, 58)
  ], { selfPuuid: 'me', evalPlayer });
  ok(rank.chatText.includes('猛男1'), '聊天文案用自定义一档名');
  ok(rank.chatText.includes('空气1'), '聊天文案用自定义五档名');
  ok(rank.summary.includes('猛男'), '总结句跟着改名');
  ok(!rank.chatText.includes('上等马'), '聊天文案里不再残留默认名');
  const cardHtml = M.html(rank, {});
  ok(cardHtml.includes('>猛男<') && cardHtml.includes('>路人<'), '卡片徽章用自定义名');

  const pv = M.previewHtml(rank);
  ok(pv.includes('fd-pv'), '预览有容器');
  ok(pv.includes('>猛男<') && pv.includes('>空气<'), '预览徽章用自定义名');
  eq((pv.match(/fd-pv-row/g) || []).length, 5, '预览列出我方 5 人');
  ok(pv.includes('硬碰硬') && pv.includes('错位'), '预览带对阵摘要');
  ok(pv.includes(rank.summary), '预览带整队一句话');
  // 图例写的是 KDA 阈值, 不是胜率 —— 换口径时这里最容易漏改
  ok(pv.includes('KDA ≥3.5') && pv.includes('≥2.5') && pv.includes('≥1.8') && pv.includes('≥1.0'), '图例写五档 KDA 阈值');
  ok(pv.includes('&lt;1.0'), '最小的那档阈值按 HTML 转义输出');
  const chipText = pv.slice(pv.indexOf('fd-pv-legend'), pv.indexOf('fd-pv-list'));
  ok(!chipText.includes('<1.0'), '图例里没有裸不等号 (会把标签打断)');
  eq(chipText.indexOf('胜率'), -1, '图例不再提胜率');
  // 没有数据时也要能看见"档位定义", 否则改完名字毫无反馈
  const pvEmpty = M.previewHtml(null);
  ok(pvEmpty.includes('fd-pv-legend'), '空态显示档位图例');
  ok(pvEmpty.includes('进入选人阶段'), '空态说明什么时候有数据');
  ok(M.previewHtml(null, { empty: '自定义提示' }).includes('自定义提示'), '空态文案可覆盖');
  ok(M.legendHtml().includes('fd-pv-chip'), '图例可单独取用 (给工具箱标题行)');
  M.resetLabels();
}

// ---- 6c. 总结句的人数必须与分档对得上 (1.6.63/1.6.66) ----
// 1.6.62 之前的写法是 c.carry >= 2 一条吃掉 2 和 3, 而且兜底句固定是「有大神有人机」:
// 三个上等马会写成"有两个", 0 个上等马 + 有未知样本时会说出一个根本不存在的上等马。
// 这种自相矛盾出现在工具箱预览的第一行, 比句式单调难看得多。
{
  const { M } = load();
  const ST = { top: [10, 3, 6], mid: [8, 4, 6], low: [6, 5, 6], ox: [4, 7, 6], zero: [2, 9, 5] };
  const mkP = (name, team, lv) => ({
    name, puuid: name, team, championId: 1,
    recent: lv ? recentOf(50, 5, ST[lv][0], ST[lv][1], ST[lv][2]) : []
  });
  const buildWith = lvList => {
    const players = lvList.map((lv, i) => mkP('A' + i, 100, lv));
    for (let i = 0; i < 5; i++) players.push(mkP('E' + i, 200, 'mid'));
    return M.build(players, {
      selfPuuid: 'A0',
      evalPlayer: p => ({ wr: 50, games: p.recent.length, score: 3 })
    });
  };

  const threeTop = buildWith(['mid', 'top', 'top', 'top', 'zero']);
  eq(threeTop.counts.top, 3, '三个上等马的分档');
  ok(threeTop.summary.startsWith('三个'), '三个上等马要说"三个"');
  ok(!threeTop.summary.includes('两个'), '三个上等马不能说成"有两个"');

  const noTop = buildWith(['mid', 'mid', 'low', 'zero', 'zero']);
  eq(noTop.counts.top, 0, '这一队没有上等马');
  ok(!noTop.summary.includes('上等马'), '0 个上等马时不能出现"上等马"字样');
  ok(noTop.summary.includes('两个没有马'), '两个没有马要按人数说');

  const twoUnknown = buildWith(['mid', 'low', 'ox', null, null]);
  eq(twoUnknown.counts.unknown, 2, '两个待定');
  ok(twoUnknown.summary.includes('2个') && twoUnknown.summary.includes('还没看透'), '未知样本按人数点名');
  ok(!twoUnknown.summary.includes('牛马'), '有未知样本时不再硬报牛马人数');

  const allMid = buildWith(['mid', 'mid', 'mid', 'mid', 'mid']);
  ok(allMid.summary.includes('整齐得像军训'), '全员中等马走整队句');

  const allTop = buildWith(['top', 'top', 'top', 'top', 'top']);
  ok(allTop.summary.startsWith('全员'), '五个上等马走全员句, 不说"四个"');

  const allZero = buildWith(['zero', 'zero', 'zero', 'zero', 'zero']);
  ok(allZero.summary.includes('送温暖'), '全员没有马走全员句, 不说"三个"');

  // 改名之后, 人数句里的档位名同样要跟着换
  M.setLabels({ top: '猛男' });
  ok(buildWith(['mid', 'top', 'top', 'top', 'zero']).summary.startsWith('三个猛男'), '人数句跟着改名');
  M.resetLabels();
  ok(!fs.readFileSync(SRC, 'utf8').includes("'有' + T('carry') + '有'"), '那条会自相矛盾的兜底句已删除');
  ok(!/carry|hold|slack/.test(fs.readFileSync(SRC, 'utf8')), '旧三档的键名已清干净');
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
  ok(css.includes('.fd-card') && css.includes('.fd-badge.fd-top'), '卡片与一档徽章样式已落地');
  ['top', 'mid', 'low', 'ox', 'zero', 'unknown'].forEach(k => {
    ok(css.includes('.fd-badge.fd-' + k + ' {'), k + ' 档徽章有独立配色');
  });
  // 1.6.62: 工具箱里能看见等级文案, 而且这套文案能自己改
  ok(idx.includes('id="dutyPreview"'), '工具箱里有预览容器');
  eq((idx.match(/dutyLabel(?:Top|Mid|Low|Ox|Zero|Unknown)"/g) || []).length, 6, '五档 + 待定各一个输入框');
  ok(idx.includes('KDA ≥3.5') && idx.includes('&lt;1.0'), '输入框旁写的是 KDA 阈值');
  ok(idx.includes('助攻算半个'), '工具箱说明写清助攻权重');
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
  ok(!/大腿|小腿|腿毛|带飞|稳住|划水|大神|正常人|人机/.test(mod + css + dutyBlock), '分工表全链路没有已废弃的叫法');
  ok(/上等马/.test(mod) && /没有马/.test(mod), '五档叫法落在模块里');
}

console.log('分工表: ' + n + ' 组断言全部通过');
