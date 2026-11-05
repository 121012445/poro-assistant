'use strict';
// player-index.js 行为测试: 本地玩家索引的模糊匹配与去重。
// 背景: 国服客户端没有 --riotclient-app-port, Akari 用的 Riot Client 别名模糊
// 接口不可用, 只能靠本地攒的玩家库做模糊搜索 —— 匹配优先级错了就会把名字相近的
// 另一个人排到前面, 查战绩直接查错人。
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, 'renderer/js/player-index.js'), 'utf8');

function makeEnv() {
  const box = new Map();
  const ctx = {
    console, Promise, String, Array, Object, JSON, Number, Math, Date,
    localStorage: {
      getItem: k => (box.has(k) ? box.get(k) : null),
      setItem: (k, v) => box.set(k, String(v)),
      removeItem: k => box.delete(k)
    }
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return {
    run: (expr, ...args) => vm.runInContext(`(${expr})`, ctx)(...args),
    fn: expr => vm.runInContext(`(${expr})`, ctx),
    raw: box
  };
}

let passed = 0;
const fails = [];
function ok(title, cond, extra) {
  if (cond) { passed++; return; }
  fails.push(title + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
}

const SAMPLE = [
  { name: '雨未散', tag: '1234', puuid: 'p-yu' },
  { name: '雨未散', tag: '5678', puuid: 'p-yu2' },
  { name: '雨未散的影子', tag: '0001', puuid: 'p-shadow' },
  { name: 'Rain', tag: 'na1', puuid: 'p-rain' },
  { name: 'rainbow', tag: '9999', puuid: 'p-rainbow' },
  { name: '大魔王', tag: '8888', puuid: 'p-dmw' }
];

(async () => {
  // ---------- 归一化 ----------
  {
    const e = makeEnv();
    const norm = e.fn('piNorm');
    ok('全角井号归一', norm('雨未散＃1234') === '雨未散#1234', norm('雨未散＃1234'));
    ok('大小写归一', norm('Rain') === 'rain');
    ok('连续空白压缩', norm('  雨  未散 ') === '雨 未散', norm('  雨  未散 '));
    const split = e.fn('piSplitName');
    ok('名字#tag 拆分', split('雨未散#1234').name === '雨未散' && split('雨未散#1234').tag === '1234');
    ok('无 tag 时不拆分', split('雨未散').tag === '', split('雨未散'));
  }

  // ---------- 匹配优先级 ----------
  {
    const e = makeEnv();
    e.run('playerIndexUpsert', SAMPLE, 'test');

    const r1 = e.run('playerIndexSearch', '雨未散#1234', 8);
    ok('全名完全一致排第一', r1[0] && r1[0].label === '雨未散#1234', r1.map(x => x.label));

    const r2 = e.run('playerIndexSearch', '雨未散', 8);
    ok('名字完全一致优先于子串', r2[0] && (r2[0].tag === '1234' || r2[0].tag === '5678'), r2.map(x => x.label));
    ok('名字完全一致的都在子串候选之前',
      r2.slice(0, 2).every(x => x.name === '雨未散') && r2.slice(2).some(x => x.name === '雨未散的影子'),
      r2.map(x => x.label));

    const r3 = e.run('playerIndexSearch', '雨未', 8);
    ok('中文前缀命中', r3.length >= 3 && r3[0].name.startsWith('雨未'), r3.map(x => x.label));

    const r4 = e.run('playerIndexSearch', '未散', 8);
    ok('中文子串命中', r4.length >= 3, r4.map(x => x.label));

    const r5 = e.run('playerIndexSearch', 'rain', 8);
    ok('大小写不敏感', r5.length === 2, r5.map(x => x.label));
    ok('名字完全一致 (Rain) 排在 rainbow 前面', r5[0] && r5[0].name === 'Rain', r5.map(x => x.label));

    const r6 = e.run('playerIndexSearch', 'n#', 8);
    ok('带 # 时名字部分仍可匹配', r6.length >= 1 && r6.every(x => x.name.toLowerCase().includes('n')), r6.map(x => x.label));

    ok('空查询返回空', e.run('playerIndexSearch', '   ', 8).length === 0);
    ok('只打一个 # 不列全库', e.run('playerIndexSearch', '#', 8).length === 0);
    ok('查不到返回空', e.run('playerIndexSearch', 'zzzz不存在', 8).length === 0);
    ok('limit 生效', e.run('playerIndexSearch', '雨', 1).length === 1);
  }

  // ---------- 去重与补全 ----------
  {
    const e = makeEnv();
    e.run('playerIndexUpsert', [{ name: '小明', tag: '', puuid: 'p-xm' }], 'friend');
    ok('首次写入', e.run('playerIndexSize') === 1, e.run('playerIndexSize'));
    // 同 puuid 后续带来 tag, 应补全而不是新增
    const changed = e.run('playerIndexUpsert', [{ name: '小明', tag: '9527', puuid: 'p-xm' }], 'match');
    ok('同 puuid 补全 tag 视为变更', changed === 0 || changed === 1, changed);
    ok('同 puuid 不新增重复记录', e.run('playerIndexSize') === 1, e.run('playerIndexSize'));
    const r = e.run('playerIndexSearch', '小明', 4);
    ok('补全后能按 名字#tag 搜到', r[0] && r[0].tag === '9527', r);
    ok('补全后 label 含 tag', r[0] && r[0].label === '小明#9527', r[0] && r[0].label);

    // 无 puuid 时按 名字#tag 去重
    e.run('playerIndexUpsert', [{ name: '无号人', tag: '1111' }], 'search');
    e.run('playerIndexUpsert', [{ name: '无号人', tag: '1111' }], 'search');
    ok('无 puuid 按名字#tag 去重', e.run('playerIndexSize') === 2, e.run('playerIndexSize'));

    // 同名不同 tag 必须并存
    e.run('playerIndexUpsert', [{ name: '小明', tag: '0000', puuid: 'p-xm2' }], 'match');
    ok('同名不同 tag 并存', e.run('playerIndexSearch', '小明', 8).length === 2);
  }

  // ---------- resolve (回车但没输 tag) ----------
  {
    const e = makeEnv();
    e.run('playerIndexUpsert', [{ name: '唯一人', tag: '4321', puuid: 'p-uniq' }], 'match');
    const r1 = e.run('playerIndexResolve', '唯一人');
    ok('唯一同名 → exact', r1.type === 'exact' && r1.entry.tag === '4321', r1);

    e.run('playerIndexUpsert', [{ name: '重名人', tag: '1', puuid: 'p-a' }, { name: '重名人', tag: '2', puuid: 'p-b' }], 'match');
    const r2 = e.run('playerIndexResolve', '重名人');
    ok('多个同名 → ambiguous', r2.type === 'ambiguous' && r2.candidates.length === 2, r2.type);

    const r3 = e.run('playerIndexResolve', '唯一人#4321');
    ok('带 tag 精确命中', r3.type === 'exact', r3.type);

    const r4 = e.run('playerIndexResolve', '唯一');
    ok('只输前缀 → candidates (不自动跳)', r4.type === 'candidates' && r4.candidates.length >= 1, r4.type);

    const r5 = e.run('playerIndexResolve', '查无此人xx');
    ok('查不到 → none', r5.type === 'none', r5.type);
  }

  // ---------- 数据来源适配 ----------
  {
    const e = makeEnv();
    const games = [{
      participants: [
        // level 在战绩数据里是英雄等级, 召唤师等级只有 summonerLevel 才是
        { riotIdGameName: '阿狸', riotIdTagline: '7777', puuid: 'p-ahri', profileIconId: 4568, level: 18, summonerLevel: 210 },
        { name: '泰隆', tagLine: '6666', puuid: 'p-talon' },
        { summonerName: '老名字' }   // 只有旧字段, 无 tag
      ]
    }];
    const n = e.run('playerIndexFromGames', games);
    ok('战绩参与者入索引', n === 3, n);
    const r = e.run('playerIndexSearch', '阿狸', 4);
    ok('战绩玩家带图标等级 (取自 summonerLevel)', r[0] && r[0].icon === 4568 && r[0].level === 210, r[0]);
    ok('无 tag 的旧字段玩家也收录', e.run('playerIndexSearch', '老名字', 4).length === 1);

    const e2 = makeEnv();
    e2.run('playerIndexFromFriends', [
      { name: '好友甲#1111', puuid: 'p-f1', gameTag: '' },
      { gameName: '好友乙', gameTag: '2222', puuid: 'p-f2' },
      { name: '' }
    ]);
    ok('好友入索引 (名字自带#tag 会拆开)', e2.run('playerIndexSearch', '好友甲', 4)[0]?.tag === '1111', e2.run('playerIndexSearch', '好友甲', 4));
    ok('好友 gameName+gameTag 组合正确', e2.run('playerIndexSearch', '好友乙', 4)[0]?.label === '好友乙#2222', e2.run('playerIndexSearch', '好友乙', 4));
    ok('空名字好友被跳过', e2.run('playerIndexSize') === 2, e2.run('playerIndexSize'));
  }

  // ---------- 持久化与裁剪 ----------
  {
    const e = makeEnv();
    e.run('playerIndexUpsert', [{ name: '持久化', tag: '1', puuid: 'p-keep' }], 'match');
    ok('写入 localStorage', e.raw.has('poroPlayerIndex.v1'));
    // 重新加载 (新上下文读同一个 localStorage)
    const raw = e.raw.get('poroPlayerIndex.v1');
    ok('存储结构是数组', Array.isArray(JSON.parse(raw)));

    const e2 = makeEnv();
    e2.raw.set('poroPlayerIndex.v1', '{ 坏掉的 json');
    ok('索引损坏不影响查询', e2.run('playerIndexSearch', '任意', 4).length === 0);
    e2.run('playerIndexUpsert', [{ name: '重建', tag: '1' }], 'match');
    ok('损坏后可重建', e2.run('playerIndexSize') === 1, e2.run('playerIndexSize'));
  }

  {
    const e = makeEnv();
    // 超限裁剪: 塞 PI_MAX+50 条, 只应保留 PI_MAX
    const many = [];
    for (let i = 0; i < 1550; i++) many.push({ name: '玩家' + i, tag: String(i), puuid: 'p-' + i });
    e.run('playerIndexUpsert', many, 'match');
    const size = e.run('playerIndexSize');
    ok('超过上限会裁剪到 ' + 1500, size === 1500, size);
    // 最新的必须还在
    ok('裁剪保留最新写入', e.run('playerIndexSearch', '玩家1549', 4).length === 1);
    // 最旧的被淘汰
    ok('裁剪淘汰最旧', e.run('playerIndexSearch', '玩家0', 4).length === 0);
  }

  {
    const e = makeEnv();
    e.run('playerIndexUpsert', [{ name: '清空我', tag: '1' }], 'match');
    e.run('playerIndexClear');
    ok('清空索引', e.run('playerIndexSize') === 0 && !e.raw.has('poroPlayerIndex.v1'));
  }

  // ---------- 名字# 之后按 Tag 前缀收窄 (对齐 Akari 的手感) ----------
  {
    const e = makeEnv();
    e.run('playerIndexUpsert', [
      { name: '雨未散', tag: '1234', puuid: 'p-a' },
      { name: '雨未散', tag: '1299', puuid: 'p-b' },
      { name: '雨未散', tag: '5678', puuid: 'p-c' },
      { name: '雨未散的影子', tag: '1234', puuid: 'p-d' },
      { name: '大魔王', tag: '1234', puuid: 'p-e' }
    ], 'test');

    const all = e.run('playerIndexSearch', '雨未散#', 10);
    ok('输 名字# 列出这个人的所有 Tag', all.filter(x => x.name === '雨未散').length === 3, all.map(x => x.label));

    const one = e.run('playerIndexSearch', '雨未散#1', 10);
    ok('名字#1 只留 Tag 前缀为 1 的', one.every(x => x.tag.startsWith('1')), one.map(x => x.label));
    ok('名字#1 命中同名的两个 Tag', one.filter(x => x.name === '雨未散').length === 2, one.map(x => x.label));
    ok('名字#1 不再带出 5678', !one.some(x => x.tag === '5678'), one.map(x => x.label));

    const two = e.run('playerIndexSearch', '雨未散#12', 10);
    ok('再输一位继续收窄', two.filter(x => x.name === '雨未散').length === 2 && two.every(x => x.tag.startsWith('12')), two.map(x => x.label));

    const exactTag = e.run('playerIndexSearch', '雨未散#1234', 10);
    ok('完整 Tag 精确命中排第一', exactTag[0] && exactTag[0].label === '雨未散#1234', exactTag.map(x => x.label));

    ok('全角井号同样能筛 Tag', e.run('playerIndexSearch', '雨未散＃12', 10).filter(x => x.name === '雨未散').length === 2);

    // 关键: 筛不到就必须是空, 不能退化成"全都返回"把 5678 又放进来
    ok('Tag 前缀无匹配返回空', e.run('playerIndexSearch', '雨未散#9', 10).length === 0);

    const byTag = e.run('playerIndexSearch', '#1234', 10);
    ok('只输 #Tag 时全库按 Tag 筛', byTag.length === 3 && byTag.every(x => x.tag === '1234'), byTag.map(x => x.label));

    // 回车决策
    const d1 = e.run('playerIndexDecide', '雨未散#');
    ok('名字# 有多个 Tag → 让用户选', d1.action === 'choose' && d1.candidates.filter(x => x.name === '雨未散').length === 3, d1.action);
    const d2 = e.run('playerIndexDecide', '雨未散#1');
    ok('名字#1 仍有多个 → 让用户选', d2.action === 'choose' && d2.candidates.filter(x => x.name === '雨未散').length === 2, d2.action);
    const d3 = e.run('playerIndexDecide', '雨未散#1234');
    ok('完整名字#Tag → 直接查', d3.action === 'exact' && d3.label === '雨未散#1234', d3);
    const d4 = e.run('playerIndexDecide', '雨未散#9');
    ok('筛不到 → 退回原精确查询', d4.action === 'passthrough' && d4.label === '雨未散#9', d4);
    const d5 = e.run('playerIndexDecide', '大魔王#');
    ok('只有一个 Tag 时 名字# 直接查', d5.action === 'exact' && d5.label === '大魔王#1234', d5);
  }

  // ---------- Riot 别名结果入索引 (陌生玩家不用输 Tag 的来源) ----------
  {
    const e = makeEnv();
    e.run('playerIndexUpsert', [{ name: '老友', tag: '1111', puuid: 'p-old' }], 'friend');
    const n = e.run('playerIndexFromAliases', [
      { gameName: '雨未散', tagLine: '16127', puuid: 'p1' },
      { gameName: '雨未散', tagLine: '22894', puuid: 'p2' },
      { gameName: '老友', tagLine: '1111', puuid: 'p-old' },   // 已有同 puuid
      { gameName: '', tagLine: 'x', puuid: 'p3' }              // 空名字应丢弃
    ]);
    ok('别名结果入索引', e.run('playerIndexSize') === 3, e.run('playerIndexSize'));
    ok('同 puuid 不重复新增', n === 2, n);
    const hits = e.run('playerIndexSearch', '雨未散', 8);
    ok('陌生名字能列出全部 Tag', hits.length === 2, hits.map(x => x.label));
    ok('别名来源标记为 alias', hits[0] && hits[0].src === 'alias', hits[0] && hits[0].src);
    ok('别名结果带 puuid 可直接跳档案', hits[0] && hits[0].puuid, hits[0]);
  }

  // ---------- 跨大区归属: 别名服务返回全服同名账号 ----------
  {
    const e = makeEnv();
    const list = [
      { gameName: '同名', tagLine: '1111', puuid: 'p-here' },
      { gameName: '同名', tagLine: '2222', puuid: 'p-far1' },
      { gameName: '同名', tagLine: '3333', puuid: 'p-far2' }
    ];
    e.run('playerIndexFromAliases', list, {
      'p-here': { inRegion: true, level: 321, icon: 99 },
      'p-far1': { inRegion: false, platform: 'TJ101' },
      'p-far2': { inRegion: false, platform: 'HN10' }
    });
    const hits = e.run('playerIndexSearch', '同名', 8);
    ok('同名的本区账号排第一', hits[0] && hits[0].label === '同名#1111' && !hits[0].foreign, hits.map(x => x.label));
    ok('本区账号带等级/头像', hits[0] && hits[0].level === 321 && hits[0].icon === 99, hits[0]);
    ok('其它大区排在后面', hits.slice(1).every(x => x.foreign), hits.map(x => x.label));

    const d = e.run('playerIndexDecide', '同名');
    ok('只有本区一个账号 → 自动补全', d.action === 'exact' && d.label === '同名#1111', d);
    ok('其它大区可按 label 判定', e.run('playerIndexFind', '同名#2222').foreign === true);
    ok('记录保存所属大区 (用于显示区名)', e.run('playerIndexFind', '同名#2222').platform === 'TJ101', e.run('playerIndexFind', '同名#2222').platform);
    ok('playerIndexFind 优先本区', e.run('playerIndexFind', '同名#1111').foreign === false);

    // 全在别的区: 不能自动跳, 只能列出来让用户看到"其它大区"
    const e2 = makeEnv();
    e2.run('playerIndexFromAliases', [
      { gameName: '全是外区', tagLine: '1', puuid: 'p-f1' },
      { gameName: '全是外区', tagLine: '2', puuid: 'p-f2' }
    ], { 'p-f1': { inRegion: false }, 'p-f2': { inRegion: false } });
    const d2 = e2.run('playerIndexDecide', '全是外区');
    ok('全是其它大区 → 列出候选不自动跳', d2.action === 'choose' && d2.candidates.length === 2, d2.action);
    const d3 = e2.run('playerIndexDecide', '全是外区#1');
    ok('带 Tag 命中其它大区也不自动跳', d3.action === 'choose', d3.action);

    // 归属未知阶段 (刚拿到别名结果, 还没逐个问 LCU): 不能自动补全, 但候选可见
    const e3 = makeEnv();
    e3.run('playerIndexFromAliases', [{ gameName: '待解析', tagLine: '77', puuid: 'p-u1' }]);
    const u1 = e3.run('playerIndexSearch', '待解析', 4);
    ok('归属未知仍可列出候选', u1.length === 1 && u1[0].regionUnknown === true, u1[0]);
    ok('归属未知不自动补全', e3.run('playerIndexDecide', '待解析').action === 'choose', e3.run('playerIndexDecide', '待解析').action);
    ok('需要解析的 puuid 会被列出', JSON.stringify(e3.run('playerIndexNeedRegion', [{ gameName: '待解析', tagLine: '77', puuid: 'p-u1' }])) === JSON.stringify(['p-u1']));
    e3.run('playerIndexFromAliases', [{ gameName: '待解析', tagLine: '77', puuid: 'p-u1' }], { 'p-u1': { inRegion: true, level: 88, icon: 7 } });
    ok('解析完清掉未知标记', e3.run('playerIndexSearch', '待解析', 4)[0].regionUnknown === false);
    ok('解析完可自动补全', e3.run('playerIndexDecide', '待解析').action === 'exact', e3.run('playerIndexDecide', '待解析').action);
    ok('已解析的不再重复问', e3.run('playerIndexNeedRegion', [{ gameName: '待解析', tagLine: '77', puuid: 'p-u1' }]).length === 0);
    // 战绩/好友里出现 = 本区确认存在: 之前的"其它大区/未知"标记作废
    e3.run('playerIndexFromAliases', [{ gameName: '回本区', tagLine: '5', puuid: 'p-back' }], { 'p-back': { inRegion: false } });
    ok('先标成其它大区', e3.run('playerIndexFind', '回本区#5').foreign === true);
    e3.run('playerIndexUpsert', [{ name: '回本区', tag: '5', puuid: 'p-back' }], 'match');
    ok('战绩里出现后标记作废', e3.run('playerIndexFind', '回本区#5').foreign === false);

    // 转区: 归属会随最新一次解析更新
    e2.run('playerIndexFromAliases', [{ gameName: '迁区', tagLine: '9', puuid: 'p-mv' }], { 'p-mv': { inRegion: false } });
    ok('标记为其它大区', e2.run('playerIndexFind', '迁区#9').foreign === true);
    e2.run('playerIndexFromAliases', [{ gameName: '迁区', tagLine: '9', puuid: 'p-mv' }], { 'p-mv': { inRegion: true, level: 10, icon: 5 } });
    ok('转到本区后标记会更新', e2.run('playerIndexFind', '迁区#9').foreign === false);
  }

  // ---------- 大区下拉的范围过滤 ----------
  {
    const e = makeEnv();
    e.run('playerIndexFromAliases', [
      { gameName: '同名', tagLine: '1111', puuid: 'p-here' },
      { gameName: '同名', tagLine: '2222', puuid: 'p-far' }
    ], {
      'p-here': { inRegion: true, level: 30, icon: 1 },
      'p-far': { inRegion: false, platform: 'TJ101' }
    });
    e.run('playerIndexUpsert', [{ name: '老友', tag: '0001' }], 'friend');
    const here = e.run('playerIndexFind', '同名#1111');
    const far = e.run('playerIndexFind', '同名#2222');
    const buddy = e.run('playerIndexFind', '老友#0001');
    const inR = e.fn('playerIndexInRegion');
    ok('本区账号落在本区', inR(here, 'HN1', 'HN1') === true);
    ok('外区账号不在本区', inR(far, 'HN1', 'HN1') === false);
    ok('外区账号落在它自己的区', inR(far, 'TJ101', 'HN1') === true);
    ok('全部大区不过滤', inR(far, '', 'HN1') === true);
    ok('好友/对局里的人在无 platform 时算本区', inR(buddy, 'HN1', 'HN1') === true);
    ok('这类条目不算在别的大区', inR(buddy, 'TJ101', 'HN1') === false);
    // 归属未知的别名条目: 选定具体大区时不显示 (宁缺勿错), 全部大区才可见
    const e2 = makeEnv();
    e2.run('playerIndexFromAliases', [{ gameName: '待解析', tagLine: '1', puuid: 'p-u' }]);
    const u = e2.run('playerIndexFind', '待解析#1');
    ok('归属未知不进具体大区', inR(u, 'HN1', 'HN1') === false);
    ok('归属未知在全部大区可见', inR(u, '', 'HN1') === true);
    ok('空条目直接排除', inR(null, 'HN1', 'HN1') === false);
    // 切到「全部大区」时, 只判过"不在本区"但缺区名的条目要重新问一遍,
    // 否则下拉里只能看到一排"其它大区"
    const need = e.fn('playerIndexNeedRegion');
    const list2 = [
      { gameName: '同名', tagLine: '1111', puuid: 'p-here' },
      { gameName: '同名', tagLine: '2222', puuid: 'p-far' }
    ];
    ok('本区模式不必重问已知归属', need(list2).length === 0, need(list2));
    // 只知道"不在本区"、没有区名的那种 (只查过本区网关时的产物)
    const e3 = makeEnv();
    const list3 = [{ gameName: '缺区名', tagLine: '9', puuid: 'p-nopf' }];
    e3.run('playerIndexFromAliases', list3, { 'p-nopf': { inRegion: false } });
    ok('缺区名的外区账号在本区模式不重问', e3.fn('playerIndexNeedRegion')(list3).length === 0);
    ok('全部大区模式补问缺区名的', JSON.stringify(e3.fn('playerIndexNeedRegion')(list3, { needPlatform: true })) === JSON.stringify(['p-nopf']), e3.fn('playerIndexNeedRegion')(list3, { needPlatform: true }));
  }

  // ---------- 候选数量不设隐性上限 ----------
  {
    // 实测一个名字下有 16~23 个同名账号。搜索框候选一旦压到 8 条, 就会出现
    // "提示匹配 23 个、下拉只露 8 个"——剩下的既看不见也点不到。
    const e = makeEnv();
    const list = [];
    for (let i = 0; i < 26; i++) list.push({ gameName: '同名', tagLine: String(10000 + i), puuid: 'q' + i });
    e.run('playerIndexFromAliases', list);
    ok('26 个同名全部入索引', e.run('playerIndexSize') === 26, e.run('playerIndexSize'));
    ok('大 limit 能取到全部 26 条', e.run('playerIndexSearch', '同名', 60).length === 26, e.run('playerIndexSearch', '同名', 60).length);
    ok('不传 limit 时仍有默认上限 (防意外全量渲染)', e.run('playerIndexSearch', '同名').length <= 8, e.run('playerIndexSearch', '同名').length);
    ok('26 条都有 label', e.run('playerIndexSearch', '同名', 60).every(x => /同名#1\d{4}/.test(x.label)));
  }

  // ---------- 完整 Tag 不再被候选列表拦住 ----------
  {
    const e = makeEnv();
    const full = e.fn('playerIndexFullTag');
    ok('名字#5位数 = 完整 Tag', full('Cherry#41147') === true);
    ok('名字#3位数也算完整', full('Cherry#123') === true);
    ok('名字#2位数 = 半截', full('Cherry#12') === false);
    ok('只有名字不是完整 Tag', full('Cherry') === false);
    ok('光一个 # 不是完整 Tag', full('Cherry#') === false);

    // 本地完全没这个人: 直接交给客户端查, 不能退回"弹候选让他挑"
    const d = e.run('playerIndexDecide', 'Cherry#41147');
    ok('本地没收录的完整 Tag → 直接查', d.action === 'passthrough' && d.label === 'Cherry#41147', d);

    // 本地有好几个同名, 但用户已经输到完整 Tag: 仍然不能弹候选
    e.run('playerIndexFromAliases', [
      { gameName: 'Cherry', tagLine: '0520', puuid: 'c1' },
      { gameName: 'Cherry', tagLine: '10100', puuid: 'c2' },
      { gameName: 'Cherry', tagLine: '41147', puuid: 'c3' }
    ], {
      'c1': { inRegion: false, platform: 'HN10' },
      'c2': { inRegion: false, platform: 'NJ100' },
      'c3': { inRegion: true, level: 1367 }
    });
    const d2 = e.run('playerIndexDecide', 'Cherry#41147');
    ok('本地有精确命中 → 补全后查', d2.action === 'exact' && d2.label === 'Cherry#41147', d2);
    ok('命中条目带真实等级', e.run('playerIndexFind', 'Cherry#41147').level === 1367, e.run('playerIndexFind', 'Cherry#41147'));
    // 被标成其它大区也不该拦: 归属可能是过期的, 让客户端真查一次
    const d4 = e.run('playerIndexDecide', 'Cherry#0520');
    ok('判为其它大区的完整 Tag 仍会去查', d4.action === 'passthrough' || d4.action === 'exact', d4.action);
    // 半截 Tag 继续走候选筛选
    const d3 = e.run('playerIndexDecide', 'Cherry#10');
    ok('半截 Tag 仍弹候选', d3.action === 'choose' && d3.candidates.length >= 1, d3.action);
  }

  // ---------- 等级: 只认召唤师等级, 不把英雄等级当等级 ----------
  {
    const e = makeEnv();
    e.run('playerIndexFromGames', [{
      participants: [
        { riotIdGameName: '甲', riotIdTagline: '1111', puuid: 'g1', level: 18 },
        { riotIdGameName: '乙', riotIdTagline: '2222', puuid: 'g2', level: 18, summonerLevel: 640 },
        { riotIdGameName: '丙', riotIdTagline: '3333', puuid: 'g3', level: 5 }
      ]
    }]);
    ok('英雄等级不写进索引', e.run('playerIndexFind', '甲#1111').level === 0, e.run('playerIndexFind', '甲#1111'));
    ok('有 summonerLevel 才写', e.run('playerIndexFind', '乙#2222').level === 640, e.run('playerIndexFind', '乙#2222'));
    ok('只有 level 不瞎猜', e.run('playerIndexFind', '丙#3333').level === 0, e.run('playerIndexFind', '丙#3333'));
  }

  // ---------- 存量脏等级迁移 ----------
  {
    const e = makeEnv();
    // 早期版本把英雄等级写进去了, 打开时应该自动清掉 (宁可不显示, 不能显示错的)
    e.raw.set('poroPlayerIndex.v1', JSON.stringify([
      { n: '老数据', t: '1111', p: 'old1', l: 18, s: 'match', ts: Date.now() },
      { n: '老好友', t: '2222', p: 'old2', l: 12, s: 'friend', ts: Date.now() },
      { n: '真实等级', t: '3333', p: 'old3', l: 512, s: 'match', ts: Date.now() },
      { n: '别名真实', t: '4444', p: 'old4', l: 18, s: 'alias', ts: Date.now() }
    ]));
    ok('迁移后条目数不变', e.run('playerIndexSize') === 4, e.run('playerIndexSize'));
    ok('战绩里的英雄等级被清掉', e.run('playerIndexFind', '老数据#1111').level === 0, e.run('playerIndexFind', '老数据#1111').level);
    ok('好友里的英雄等级被清掉', e.run('playerIndexFind', '老好友#2222').level === 0, e.run('playerIndexFind', '老好友#2222').level);
    ok('真实等级不动', e.run('playerIndexFind', '真实等级#3333').level === 512);
    ok('别名来源的 18 级保留 (可能是真新号)', e.run('playerIndexFind', '别名真实#4444').level === 18);
  }

  // ---------- 同一个人两条记录要去重 ----------
  {
    const e = makeEnv();
    // 搜索记录 (无 puuid) + 战绩记录 (有 puuid): 指向同一个人, 不能显示成两个
    e.run('playerIndexUpsert', [{ name: '重复', tag: '1234' }], 'search');
    e.run('playerIndexFromGames', [{ participants: [{ riotIdGameName: '重复', riotIdTagline: '1234', puuid: 'dup1', profileIconId: 5 }] }]);
    const hits = e.run('playerIndexSearch', '重复', 10);
    ok('同名同 Tag 只出现一次', hits.length === 1, hits.map(x => x.label));
    ok('保留有 puuid 的那条', hits[0] && hits[0].puuid === 'dup1', hits[0]);
    const d = e.run('playerIndexDecide', '重复');
    ok('去重后只剩一人 → 直接查', d.action === 'exact' && d.label === '重复#1234', d);
    // 真正的同名不同 Tag 仍然要弹候选
    e.run('playerIndexFromAliases', [{ gameName: '重复', tagLine: '5678', puuid: 'dup2' }], { 'dup2': { inRegion: true, level: 100 } });
    const d2 = e.run('playerIndexDecide', '重复');
    ok('不同 Tag 仍弹候选', d2.action === 'choose' && d2.candidates.length === 2, d2.action);
  }

  // ---------- 查过的人用 LCU 权威等级覆盖 ----------
  {
    const e = makeEnv();
    e.run('playerIndexFromGames', [{ participants: [{ riotIdGameName: '丙', riotIdTagline: '3333', puuid: 'g3' }] }]);
    ok('战绩来源初始没有等级', e.run('playerIndexFind', '丙#3333').level === 0);
    e.run('playerIndexUpsert', [{ name: '丙', tag: '3333', puuid: 'g3', level: 1367, icon: 99 }], 'search');
    ok('查过之后补上真实等级', e.run('playerIndexFind', '丙#3333').level === 1367, e.run('playerIndexFind', '丙#3333'));
    ok('头像也一起补', e.run('playerIndexFind', '丙#3333').icon === 99);
    // 之后首页再刷一次战绩, 不能把权威等级冲成 0
    e.run('playerIndexFromGames', [{ participants: [{ riotIdGameName: '丙', riotIdTagline: '3333', puuid: 'g3' }] }]);
    ok('后续战绩写入不冲掉权威等级', e.run('playerIndexFind', '丙#3333').level === 1367);
    // 别名来源拿到的等级也应当能覆盖
    e.run('playerIndexUpsert', [{ name: '丙', tag: '3333', puuid: 'g3', level: 1400 }], 'match');
    ok('非权威来源不覆盖已有等级', e.run('playerIndexFind', '丙#3333').level === 1367, e.run('playerIndexFind', '丙#3333'));
  }

  // ---------- 别名结果写入限流 (服务端同名上限 500 条) ----------
  {
    const e = makeEnv();
    const big = [];
    for (let i = 0; i < 500; i++) big.push({ gameName: 'Cherry', tagLine: String(10000 + i), puuid: 'x' + i });
    e.run('playerIndexFromAliases', big);
    ok('一次 500 条只写 60 条', e.run('playerIndexSize') === 60, e.run('playerIndexSize'));

    const e2 = makeEnv();
    const big2 = [];
    for (let i = 0; i < 499; i++) big2.push({ gameName: 'Cherry', tagLine: String(40000 + i), puuid: 'y' + i });
    big2.push({ gameName: 'Cherry', tagLine: '41147', puuid: 'y-target' });   // 排在最后
    e2.run('playerIndexFromAliases', big2, null, { tagPrefix: '41147' });
    ok('优先保留与输入前缀一致的 Tag', !!e2.run('playerIndexFind', 'Cherry#41147'), e2.run('playerIndexSize'));
    ok('限流后总量仍是 60', e2.run('playerIndexSize') === 60, e2.run('playerIndexSize'));
  }

  // ---------- 满库时先淘汰外区别名, 不挤掉一起打过的人 ----------
  {
    const e = makeEnv();
    const seed = [];
    for (let i = 0; i < 1500; i++) seed.push({ n: '队友' + i, t: String(10000 + i), p: 'm' + i, l: 0, s: 'match', ts: Date.now() - 86400000 });
    e.raw.set('poroPlayerIndex.v1', JSON.stringify(seed));
    const names = [];
    for (let i = 0; i < 60; i++) names.push({ gameName: '路人', tagLine: String(20000 + i), puuid: 'a' + i });
    e.run('playerIndexFromAliases', names);
    // 2026-11-05: 待定池(别名带回、无等级、归属未知)与真实记录分开算配额,
    // 否则索引满是查一次人就顶掉几个一起打过的人
    ok('总量不超 真实1500+待定300', e.run('playerIndexSize') <= 1500 + 300, e.run('playerIndexSize'));
    ok('新查到的别名留在索引里', !!e.run('playerIndexFind', '路人#20000') || e.run('playerIndexSize') > 1500, e.run('playerIndexSize'));
    ok('原本的队友还在', !!e.run('playerIndexFind', '队友0#10000'), '队友0 被挤掉了');
    ok('最早那个队友也还在', !!e.run('playerIndexFind', '队友10#10010'));
  }

  // ---------- 回车决策 (homeSearch 的分支判断) ----------
  {
    const e = makeEnv();
    e.run('playerIndexUpsert', [
      { name: '唯一人', tag: '4321', puuid: 'p-uniq' },
      { name: '重名人', tag: '1', puuid: 'p-a' },
      { name: '重名人', tag: '2', puuid: 'p-b' }
    ], 'match');

    ok('空输入 → empty', e.run('playerIndexDecide', '  ').action === 'empty');
    ok('带 #Tag → 直接精确查', (() => { const d = e.run('playerIndexDecide', '随便#0000'); return d.action === 'passthrough' && d.label === '随便#0000'; })());
    ok('索引里唯一同名 → 自动补全', (() => { const d = e.run('playerIndexDecide', '唯一人'); return d.action === 'exact' && d.label === '唯一人#4321'; })());
    ok('同名多个 → 让用户选', (() => { const d = e.run('playerIndexDecide', '重名人'); return d.action === 'choose' && d.candidates.length === 2; })());
    ok('索引里没有 → 交给精确查询', (() => { const d = e.run('playerIndexDecide', '陌生人'); return d.action === 'passthrough' && d.label === '陌生人'; })());
  }

  // ---------- 先输名字, 再补 Tag: 第二轮要能按新前缀补进索引 ----------
  // 真实场景 (2026-11-05 实测 "黑皮体育生" 同名 500 条): 用户先打名字, 索引里只躺
  // 着按空前缀截下来的 60 条; 接着补 #80428 时别名走的是 5 分钟缓存, 旧代码直接
  // return, 于是精确那一条永远进不来, 下拉一直显示"本地未收录", 只能回车查。
  {
    const e = makeEnv();
    const big = [];
    for (let i = 0; i < 499; i++) big.push({ gameName: '黑皮体育生', tagLine: String(10000 + i), puuid: 'z' + i });
    big.push({ gameName: '黑皮体育生', tagLine: '80428', puuid: 'z-target' });
    e.run('playerIndexFromAliases', big);                       // 第一轮: 只有名字
    ok('只输名字时精确那条还没进来', !e.run('playerIndexFind', '黑皮体育生#80428'), e.run('playerIndexSize'));
    e.run('playerIndexFromAliases', big, null, { tagPrefix: '80428' });   // 第二轮: 补 #80428
    ok('补 Tag 后精确命中进索引', !!e.run('playerIndexFind', '黑皮体育生#80428'), e.run('playerIndexSize'));
    ok('补 Tag 后仍不超过限流', e.run('playerIndexSize') <= 120, e.run('playerIndexSize'));
    const hits = e.run('playerIndexSearch', '黑皮体育生#80428', 1200);
    ok('下拉能筛出这一条', hits.length === 1 && hits[0].label === '黑皮体育生#80428', hits.map(h => h.label));
  }

  // ---------- 完整 #Tag 的自动查询判定 (不打回车也能查) ----------
  {
    const e = makeEnv();
    e.run('playerIndexUpsert', [
      { name: '自动人', tag: '80428', puuid: 'p-auto' },
      { name: '外区人', tag: '77777', puuid: 'p-out' }
    ], 'match');
    e.run('playerIndexFromAliases', [{ gameName: '外区人', tagLine: '77777', puuid: 'p-out' }], { 'p-out': { inRegion: false } });
    const auto = e.fn('playerIndexAutoGoTarget');
    ok('完整 ID + 本区 → 自动查', auto('自动人#80428') === '自动人#80428', auto('自动人#80428'));
    ok('全角井号也算完整 ID', auto('自动人＃80428') === '自动人#80428', auto('自动人＃80428'));
    ok('半截 Tag 不自动查', auto('自动人#80') === '', auto('自动人#80'));
    ok('只输名字不自动查', auto('自动人') === '', auto('自动人'));
    ok('本地没收录不自动查 (打错字会弹报错)', auto('陌生人#12345') === '', auto('陌生人#12345'));
    ok('明确在其它大区不自动查', auto('外区人#77777') === '', auto('外区人#77777'));
  }

  // 只做字面匹配: 2026-11-05 起候选层只对"完整名字"负责 (对齐 LeagueAkari)。
  // Riot 别名接口本来就只认完整名字, 本地再用编辑距离"猜相近的名字"只会把
  // 「巧克力」「巧遇記」这种无关账号推到「巧丝绒」的搜索里。
  {
    const e = makeEnv();
    e.run('playerIndexFromGames', [{ participants: [
      { riotIdGameName: '小慕冰', riotIdTagline: '73066', puuid: 'p-xmb', summonerLevel: 18 },
      { riotIdGameName: '雨未散', riotIdTagline: '1234', puuid: 'p-yu', summonerLevel: 200 }
    ] }]);
    ok('多打一个字不再猜命中', e.run('playerIndexSearch', '小慕冰糖', 10).length === 0);
    ok('首字不同不命中', e.run('playerIndexSearch', '大慕冰', 10).length === 0);
    const exact = e.run('playerIndexSearch', '小慕冰', 10);
    ok('完整名字精确命中', exact.length === 1 && exact[0].score === 92, exact.map(x => x.score));
    ok('前缀仍能匹配本地记录', e.run('playerIndexSearch', '小慕', 10).length === 1);
    ok('子串命中不受影响', e.run('playerIndexSearch', '未散', 10).some(x => x.name === '雨未散'));
    ok('候选不再带 approx 字段', exact[0] && exact[0].approx === undefined, exact[0] && exact[0].approx);
  }

  // 2026-11-05 实测事故: 用户搜「巧丝绒」(国服别名接口确有 3 个账号) 时, 界面
  // 给出的是编辑距离凑出来的「巧克力」「巧遇記」。3 字名差 2 个字就是两个人了。
  {
    const e = makeEnv();
    e.run('playerIndexFromGames', [{ participants: [
      { riotIdGameName: '巧克力', riotIdTagline: '25183', puuid: 'p-qkl', summonerLevel: 300 },
      { riotIdGameName: '巧遇記', riotIdTagline: '45041', puuid: 'p-qyj', summonerLevel: 200 },
      { riotIdGameName: '巧丝绒', riotIdTagline: '28970', puuid: 'p-qsr', summonerLevel: 100 }
    ] }]);
    const hit = e.run('playerIndexSearch', '巧丝绒', 10);
    ok('精确命中时只出本人', hit.length === 1 && hit[0].name === '巧丝绒', hit.map(x => x.label));

    const e2 = makeEnv();
    e2.run('playerIndexFromGames', [{ participants: [
      { riotIdGameName: '巧克力', riotIdTagline: '25183', puuid: 'p-qkl2', summonerLevel: 300 },
      { riotIdGameName: '巧遇記', riotIdTagline: '45041', puuid: 'p-qyj2', summonerLevel: 200 }
    ] }]);
    ok('3 字名差 2 个字不再硬凑', e2.run('playerIndexSearch', '巧丝绒', 10).length === 0);

    const e3 = makeEnv();
    e3.run('playerIndexFromGames', [{ participants: [
      { riotIdGameName: '巧丝线', riotIdTagline: '11111', puuid: 'p-qsx', summonerLevel: 50 }
    ] }]);
    ok('3 字名差 1 个字也不再凑', e3.run('playerIndexSearch', '巧丝绒', 10).length === 0);

    // 满索引 (1500 条真实记录) 时, 别名带回来的"无等级 + 归属未知"条目过去会被
    // 当场当垃圾淘汰, 用户搜完永远看不到 —— 这正是「巧丝绒」在 1.5.94 上搜不到的
    // 第二层原因
    const e4 = makeEnv();
    const seed = [];
    for (let i = 0; i < 1500; i++) seed.push({ n: '队友' + i, t: String(10000 + i), p: 'm' + i, l: 0, s: 'match', ts: Date.now() - i * 1000 });
    e4.raw.set('poroPlayerIndex.v1', JSON.stringify(seed));
    e4.run('playerIndexFromAliases', [{ gameName: '巧丝绒', tagLine: '28970', puuid: 'p-q-full' }], null, { tagPrefix: '' });
    ok('索引满时新查到的别名仍然可搜', e4.run('playerIndexSearch', '巧丝绒', 10).length === 1);
    ok('索引满时也没顶掉老队友', !!e4.run('playerIndexFind', '队友0#10000'));
  }

  console.log(`— 玩家索引 (player-index) —`);
  if (fails.length) {
    for (const f of fails) console.log('✗ ' + f);
    console.log(`失败: ${fails.length} / ${passed + fails.length}`);
    process.exit(1);
  }
  console.log(`全部通过: ${passed}/${passed}`);
})();
