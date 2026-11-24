// 生涯海报 (1.6.52) 统计与排版单测
//
// 这张图是「发出去给别人看」的，算错一个数没人能当场发现 —— 所以口径必须钉住：
//   · 按模式分组只数本人参与的局（标签数字 = 点开后的内容）
//   · 阵营未知的人既不进同队榜也不进对手榜（不能张冠李戴）
//   · 多杀优先用原始四项，没有才退回「本局最高」那个字符串
//   · 空数据不出图（宁可提示，也不出一张全是 0 的图）
const assert = require('assert');
const path = require('path');

const ME = 'puuid-me';

// 海报模块依赖的全局（应用里由 utils/app/home/hex 提供）
global.escapeHtml = v => String(v == null ? '' : v)
  .replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
global.champNumMap = {
  '1': { id: 'Annie', name: '黑暗之女' },
  '2': { id: 'Olaf', name: '狂战士' },
  '3': { id: 'Galio', name: '正义巨像' }
};
global.hexAugMeta = {
  11: { name: '加速巫术', icon: 'https://x/a.png', rarity: '棱彩' },
  12: { name: '大力', icon: 'https://x/b.png', rarity: '白银' },
  13: { name: '号令之旗', icon: 'https://x/c.png', rarity: '黄金' }
};
global.isKnownPlayerName = n => !!n && !/^(未知|未知玩家|unknown|player|\?|-)$/i.test(String(n).trim());
global.isExcludedGame = () => false;

const M = require('./renderer/js/profile-poster.js').PoroProfilePoster;
assert.ok(M && typeof M.collect === 'function', '模块要导出 collect');

// ---------- 造数据 ----------
function person(puuid, name, teamId, extra) {
  return Object.assign({
    puuid, name, tagLine: '',
    championId: 1, k: 5, d: 2, a: 7, win: true, teamId,
    dmg: 20000, dmgTaken: 15000, healing: 1000, physDmg: 12000, magicDmg: 7000, trueDmg: 1000,
    gold: 12000, cs: 100, visionScore: 20, items: [3006, 3009, 0],
    augmentIds: [11, 12], multi: '', fb: false
  }, extra || {});
}

function game(i, mode, opt) {
  const o = opt || {};
  const ps = [
    person(ME, '雨未散', o.myTeam == null ? 100 : o.myTeam, {
      win: o.win !== false,
      k: o.k == null ? 5 : o.k, d: o.d == null ? 2 : o.d, a: o.a == null ? 7 : o.a,
      dmg: o.dmg == null ? 20000 : o.dmg,
      multi: o.multi || '', multis: o.multis,
      items: o.items || [3006, 3009], augmentIds: o.augmentIds || [11],
      championId: o.champId || 1
    }),
    person('ally-a', '队友甲', 100),
    person('ally-b', '队友乙', 100),
    person('foe-a', '对手甲', 200),
    person('foe-b', '对手乙', 200),
    person('unknown-side', '阵营未知', 0)
  ];
  return { gid: 900 + i, mode, queueId: mode === '海克斯大乱斗' ? 2400 : 430, dur: 1200 + i * 60, time: 1700000000000 + i * 86400000, participants: ps };
}

// 6 局大乱斗（4 胜 2 负，第 3 局阵营未知），4 局匹配（全胜）
const games = [];
for (let i = 0; i < 6; i++) {
  games.push(game(i, '海克斯大乱斗', {
    win: i < 4,
    myTeam: i === 2 ? 0 : 100,
    k: 10, d: 4, a: 20,
    dmg: 30000 + i * 1000,
    champId: i < 4 ? 1 : 2,
    multis: i === 0 ? { d: 2, t: 1, q: 0, p: 1 } : undefined,
    multi: i === 0 ? '五杀' : (i === 1 ? '四杀' : ''),
    augmentIds: i % 2 ? [11, 13] : [11, 12],
    items: i % 2 ? [3006, 6672] : [3006, 3009]
  }));
}
for (let i = 0; i < 4; i++) {
  games.push(game(10 + i, '匹配模式', { win: true, k: 3, d: 5, a: 9, dmg: 12000, champId: 3, items: [6672] }));
}
// 时间打乱一点，确认排序依赖 time 而不是数组顺序
games.sort((a, b) => b.time - a.time);

// ---------- 1. 模式分组 ----------
{
  const modes = M.modesOf(games, ME);
  assert.strictEqual(modes[0].key, 'all', '第一项必须是「全部」');
  assert.strictEqual(modes[0].n, 10, '全部 = 本人参与的 10 局');
  const sr = modes.find(m => m.key === '海克斯大乱斗');
  const nrm = modes.find(m => m.key === '匹配模式');
  assert.strictEqual(sr.n, 6, '大乱斗 6 局');
  assert.strictEqual(nrm.n, 4, '匹配 4 局');
  assert.ok(modes.indexOf(sr) < modes.indexOf(nrm), '按场次降序');
}

// ---------- 2. 总览数字 ----------
{
  const s = M.collect(games, ME);
  assert.strictEqual(s.n, 10);
  assert.strictEqual(s.wins, 8, '4 胜 + 4 胜 = 8 胜');
  assert.strictEqual(s.wr, 80, '胜率 80%');
  assert.strictEqual(s.k, 6 * 10 + 4 * 3, '总击杀');
  assert.strictEqual(s.d, 6 * 4 + 4 * 5, '总死亡');
  assert.strictEqual(s.a, 6 * 20 + 4 * 9, '总助攻');
  assert.strictEqual(s.kda.toFixed(3), ((72 + 156) / 44).toFixed(3), 'KDA 口径 = (K+A)/D');
  assert.strictEqual(s.bestK, 10, '单场最高击杀');
  const dmgSum = games.reduce((t, g) => t + (+(g.participants.find(p => p.puuid === ME).dmg) || 0), 0);
  assert.ok(Math.abs(s.avgDmg - dmgSum / 10) < 1, '场均伤害');
  assert.ok(s.dur > 0 && s.longest >= s.shortest, '时长区间');
  assert.ok(s.medianDur >= s.shortest && s.medianDur <= s.longest, '中位必须落在区间内');
  assert.ok(s.goldPerMin > 0 && s.dmgPerMin > 0, '分均伤害/分均金币');
}

// ---------- 3. 多杀：原始字段优先，字符串兜底且不重复计 ----------
{
  const s = M.collect(games, ME);
  // 第 1 局原始 {d:2,t:1,p:1}，第 2 局只有 '四杀' 字符串，其余为空
  assert.strictEqual(s.multi.p, 1, '五杀 1 次（只来自原始字段，不被字符串重复计）');
  assert.strictEqual(s.multi.q, 1, '四杀 1 次（字符串兜底）');
  assert.strictEqual(s.multi.t, 1, '三杀 1 次');
  assert.strictEqual(s.multi.d, 2, '双杀 2 次');
  assert.strictEqual(s.fb, 0, '一血');
}

// ---------- 4. 同队/对手：阵营未知的人两边都不进 ----------
{
  const s = M.collect(games, ME);
  const allyNames = s.allyList.map(p => p.name);
  const foeNames = s.foeList.map(p => p.name);
  assert.deepStrictEqual(allyNames.sort(), ['队友乙', '队友甲'], '同队只有两个人');
  assert.deepStrictEqual(foeNames.sort(), ['对手乙', '对手甲'], '对手只有两个人');
  assert.ok(!allyNames.includes('阵营未知') && !foeNames.includes('阵营未知'), '阵营未知不进任何榜');
  const ally = s.allyList.find(p => p.name === '队友甲');
  // 第 3 局本人阵营未知, 该局的队友同样判不出来 —— 双边都不计, 不是只丢对手
  assert.strictEqual(ally.n, 9, '队友甲 9 次（阵营未知那局不计）');
  const foe = s.foeList.find(p => p.name === '对手甲');
  // 第 3 局本人阵营未知，该局对手也判不出来 —— 不能算进"对手 10 次"
  assert.strictEqual(foe.n, 9, '对手甲 9 次（阵营未知那局不计）');
}

// ---------- 5. 英雄/装备/强化频次 ----------
{
  const s = M.collect(games, ME);
  // 英雄 1 与 3 各 4 场 (同胜率), 榜首是谁都合法 —— 要钉的是"按场次降序", 不是某个人
  assert.strictEqual(s.champList[0].n, 4, '榜首 4 场');
  const byCid = Object.fromEntries(s.champList.map(c => [c.cid, c.n]));
  assert.deepStrictEqual([byCid[1], byCid[3]], [4, 4], '两个英雄各 4 场');
  for (let i = 1; i < s.champList.length; i++) {
    assert.ok(s.champList[i - 1].n >= s.champList[i].n, '英雄按场次降序');
  }
  const items = s.itemList.map(i => i.id);
  assert.ok(items.includes(3006), '常见装备含 3006');
  assert.strictEqual(s.itemList.find(i => i.id === 3006).n, 6, '大乱斗 6 局都出 3006');
  assert.ok(s.itemList.find(i => i.id === 6672).n >= 4, '6672 出现在匹配局里');
  assert.ok(!items.includes(0), '空装备位不能被统计');
  const augs = s.augList.map(a => a.id);
  assert.ok(augs.includes(11) && augs.includes(12) && augs.includes(13), '强化三种都进榜');
  assert.strictEqual(s.augList.find(a => a.id === 11).n, 6 + 4, '11 号每局都有');
  assert.ok(s.augList[0].n >= s.augList[1].n, '强化按次数降序');
}

// ---------- 6. 最近 N 场：新局在前 ----------
{
  const s = M.collect(games, ME);
  assert.ok(s.recent.length <= 12, '最近场次上限');
  assert.strictEqual(s.recent[0].cid, games[0].participants[0].championId, '第一条是时间最新的那局');
}

// ---------- 7. 出图：关键区块都在，且没有 NaN/undefined ----------
{
  const s = M.collect(games, ME);
  const html = M.build(s, { name: '雨未散', tag: '36393', puuid: ME, modeLabel: '全部模式', level: 2696 });
  assert.ok(html.length > 2000, '正常数据必须出图');
  for (const label of ['高光时刻', '战绩总览', '击杀数据', '伤害数据', '英雄使用', '常见装备', '最常同队', '最常对手', '海克斯强化']) {
    assert.ok(html.includes(label), '缺少区块: ' + label);
  }
  assert.ok(html.includes('全部模式'), '模式标签要印在图上');
  assert.ok(!/NaN|undefined|Infinity/.test(html), '图上不能出现 NaN/undefined');
  assert.ok(!/src=""/.test(html), '不能出空 src（会显示成破图）');
}

// ---------- 8. 空数据不出图 ----------
{
  const empty = M.collect([], ME);
  assert.strictEqual(empty.n, 0);
  assert.strictEqual(M.build(empty, { name: 'x' }), '', '没有对局时不出图（调用方给提示）');
  assert.strictEqual(M.collect(games, 'nobody').n, 0, '查不到本人参与的对局');
}

// ---------- 9. 转义：名字里的 HTML 不能进属性 ----------
{
  const evil = games.slice(0, 1).map(g => {
    const copy = JSON.parse(JSON.stringify(g));
    copy.participants[1].name = '<img src=x onerror=alert(1)>';
    return copy;
  });
  const s = M.collect(evil, ME);
  const html = M.build(s, { name: '<b>坏</b>', tag: '1"><script>', puuid: ME, modeLabel: '全部模式' });
  assert.ok(!html.includes('<script>'), '模式/名字必须转义');
  assert.ok(!/<img src=x/.test(html), '玩家名必须转义');
  assert.ok(html.includes('&lt;img src=x'), '转义后以文本形式出现');
}

// ---------- 10. 格式化 ----------
{
  assert.strictEqual(M._format.bigNum(30180000), '3018.0 万');
  assert.strictEqual(M._format.bigNum(5793000), '579.3 万');
  assert.strictEqual(M._format.bigNum(999), '999');
  assert.strictEqual(M._format.durText(6318), '1 小时 45 分');
  assert.strictEqual(M._format.durShort(1861), '31:01');
  assert.strictEqual(M._format.median([1, 2, 3, 4]), 3);
  assert.strictEqual(M._format.median([1, 2, 3]), 2);
}

console.log('生涯海报: 10 组用例全部通过');
