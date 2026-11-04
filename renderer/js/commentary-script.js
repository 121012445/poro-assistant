// 解说文案生成 (纯函数, 无 DOM / 无 IO / 无定时器)
//
// 为什么单独成文件: 这里决定"听到什么内容", 是解说模式的主体。
// 拆出来之后可以在 node 里跑断言, 不必真的打一局去听。
//
// 输入全部是普通对象/数组, 不依赖 window / PoroMetrics, 便于单测。
//
// 设计原则:
//   1. 只说能确定的事 —— 塔的编号(一塔/二塔)在 Live Client Data 里不可靠, 就只报路;
//   2. 不念召唤师名 —— 名字里常有生僻字和符号, 合成语音念出来是噪音, 一律换成英雄名;
//   3. 句子短 —— 一条播报控制在 20 字内, 念完不拖住下一个事件;
//   4. 同一句式轮换 —— 反复念同一句话比不说话更像机器人。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  if (root) root.PoroScript = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // ---------- 数字口语化 ----------
  // TTS 念 "4339" 是"四千三百三十九", 四个音节单位拖沓; 口语只要"四千三"。
  // 播报要的是量级而不是精确值, 所以三位以上一律只念"最高位 + 次一位"。
  const DIG = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九'];
  // 十位上的 2 读"二十"不读"两十"; 百位/千位才用"两百/两千"
  const DIG_TENS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const UNITS = ['', '十', '百', '千'];

  function sayUnder10000(v) {
    if (v < 10) return DIG[v];
    if (v < 20) return '十' + (v % 10 ? DIG[v % 10] : '');
    if (v < 100) {
      const t = Math.floor(v / 10);
      const g = v % 10;
      return DIG_TENS[t] + '十' + (g ? DIG[g] : '');
    }
    const unitIdx = v >= 1000 ? 3 : 2;
    const base = Math.pow(10, unitIdx);
    const hi = Math.floor(v / base);
    const rest = v - hi * base;
    const out = DIG[hi] + UNITS[unitIdx];
    if (rest === 0) return out;
    const next = Math.floor(rest / Math.pow(10, unitIdx - 1));
    // 尾数用"二"(八千二) 而不是"两"(八千两) —— 后者听起来像重量
    if (next > 0) return out + DIG_TENS[next];
    // 次一位是 0 但更低位有数 (1050 / 1008): 补个"零"再说, 否则会听成别的数字
    if (rest >= 10) return out + '零' + DIG_TENS[Math.floor(rest / 10)] + '十' + (rest % 10 ? DIG[rest % 10] : '');
    return out + '零' + DIG[rest];
  }

  // 播报用的数字读法. 负数只念绝对值, "领先/落后"由调用方决定
  function sayNum(n) {
    const v = Math.round(Math.abs(Number(n) || 0));
    if (v < 10000) return sayUnder10000(v);
    if (v < 100000000) {
      const w = Math.floor(v / 10000);
      const rest = v % 10000;
      const head = sayUnder10000(w) + '万';
      if (rest === 0) return head;
      const next = Math.floor(rest / 1000);
      // 万位后面直接跟千位, 例如 23000 → "两万三"
      if (next > 0) return head + DIG_TENS[next];
      return head + '零' + sayUnder10000(rest);
    }
    return sayUnder10000(Math.floor(v / 100000000)) + '亿';
  }

  // 比赛时间: 780 秒 → "十三分钟"
  function sayMinute(sec) {
    const m = Math.floor(Math.max(0, Number(sec) || 0) / 60);
    return sayNum(m) + '分钟';
  }

  // ---------- 英雄名 / 阵营 ----------
  // 把 live data 的 allPlayers 压成 召唤师名(小写) → { champ, team } 查表
  function buildRoster(players, champNameOf) {
    const map = new Map();
    for (const p of (Array.isArray(players) ? players : [])) {
      const champ = champNameOf ? champNameOf(p) : (p && p.championName) || '';
      const entry = { champ: String(champ || '').trim(), team: String((p && p.team) || '') };
      if (!entry.champ) continue;
      for (const n of [p && p.summonerName, p && p.riotId, p && p.riotIdGameName]) {
        const key = String(n || '').trim().toLowerCase();
        if (key) map.set(key, entry);
      }
    }
    return map;
  }

  // 事件里的名字 → 该参与者的 { champ, team }
  function lookupRoster(roster, name) {
    if (!roster || !name) return null;
    return roster.get(String(name).trim().toLowerCase()) || null;
  }

  // 从事件名里拿英雄名, 拿不到就返回空串 (调用方会跳过整条播报)
  function nameOf(roster, name) {
    const hit = lookupRoster(roster, name);
    return hit ? hit.champ : '';
  }

  function sideOf(roster, name, myTeam) {
    const hit = lookupRoster(roster, name);
    if (!hit || !hit.team || !myTeam) return '';
    return hit.team === myTeam ? 'ally' : 'enemy';
  }

  // ---------- 龙 / 塔 ----------
  const DRAGON_CN = {
    fire: '火', water: '水', earth: '土', air: '风',
    hextech: '海克斯', chemtech: '炼金', elder: '远古'
  };

  // "Turret_T1_C_05_A" → { team: 'T1', lane: 'C' }
  function parseTurret(name) {
    const m = /^Turret_(T\d)_([LCBR])\d*_?/i.exec(String(name || ''));
    if (!m) return null;
    return { teamNum: m[1].toUpperCase(), lane: m[2].toUpperCase() };
  }
  const LANE_CN = { L: '上路', C: '中路', R: '下路', B: '基地' };

  // ---------- 文案模板 ----------
  // 每个事件 2-3 个变体, 按次数轮换。{k}=击杀者英雄名 {v}=被击杀者英雄名
  //
  // 三种风格的区别不是"用词凶狠程度", 而是**说话的人是谁**:
  //   caster —— 转播席上的解说: 只描述发生了什么 + 情绪 + 预判, 不对观众下指令
  //   coach  —— 坐在旁边的教练: 给结论和下一步该怎么做
  //   tough  —— 一起打的朋友: 吐槽为主
  // 之前只有后两种, 所以听起来像有人在耳边指挥, 不像在解说比赛。
  const T = {
    caster: {
      killAlly: ['{k} 一套打满，{v} 直接倒地', '{k} 卡住视野先手，{v} 走不掉了', '{k} 单吃 {v}，这波赚了'],
      killAllySpree: ['{k} 又收一个，这已经是第 {n} 个', '{k} 手感起来了，{v} 拦不住'],
      killDeath: ['{v} 被 {k} 抓到了，这波很难受', '{v} 走位偏了，{k} 顺手收下', '{v} 倒下，{k} 这个位置太阴了'],
      multiAlly: ['{k} 打出 {x}，团战彻底打开了', '{k} 一个接一个，{x} 到手'],
      multiEnemy: ['对面 {k} 打出 {x}，这波得退了', '{k} 收下 {x}，我们这边站得太密'],
      turretDown: ['对面的{lane}塔，推平了', '{lane}塔拿下，兵线压过去了'],
      turretLost: ['我们的{lane}塔没了，得回防', '{lane}塔被拆，那边视野丢了'],
      inhibDown: ['对面{lane}水晶被拆开，超级兵来了', '{lane}水晶破了，推进空间打开了'],
      inhibLost: ['我们的{lane}水晶破了，超级兵压过来了', '{lane}水晶被拆，这边得赶紧清线'],
      dragon: ['{d}龙被拿下，节奏转到我们手里', '{d}龙到手，看接下来怎么用'],
      dragonLost: ['对面收下{d}龙，这条龙有点疼', '{d}龙被对面拿了，得找机会换点东西'],
      baron: ['大龙拿下来了，这下可以推了', '大龙到手，全场节奏都变了'],
      baronLost: ['大龙被对面拿走，这段时间要缩回来', '对面拿下大龙，接下来很难受'],
      herald: ['先锋拿到，中路可以撞了', '峡谷先锋到手，那边有得打了'],
      heraldLost: ['先锋被对面拿走，中路要留意', '对面拿到先锋，注意那条线'],
      atakhan: ['厄塔汗拿下，这波加成很实在', '厄塔汗到手，可以打得更凶'],
      atakhanLost: ['厄塔汗被对面拿了，别硬开'],
      firstBrick: ['首塔拿下，一血塔的钱到手', '首塔是我们的，节奏先起来了'],
      aceAlly: ['对面全倒了，这波能推过去', '团灭对面，趁着复活时间往前压'],
      aceEnemy: ['我们全倒了，只能等复活', '被对面团灭，先守住高地'],
      leadLight: ['我们小领先一点，节奏在这边', '稍稍领先，还没到能松的时候'],
      leadBig: ['领先{m}了，主动权在我们手里', '经济差{m}，优势已经很明显'],
      behindLight: ['落后一点，还有得打', '稍微被压，稳住就能追'],
      behindBig: ['落后{m}，得想办法找回节奏', '差了{m}，这时候最怕乱开'],
      even: ['双方咬得很紧，谁都没拉开', '现在还是均势，看下一波'],
      half: ['{t}，{s}', '{t}打完，{s}'],
      end: ['对局结束', '比赛结束'],
      endStat: ['本局{k}杀{d}死，{r}', '打完了，{k}杀{d}死，{r}']
    },
    coach: {
      killAlly: ['{k} 拿下 {v}', '{k} 收掉 {v}', '{k} 做掉 {v}'],
      killAllySpree: ['{k} 拿下 {v}，已经连拿 {n} 个', '{k} 又收一个，{v} 倒下'],
      killDeath: ['我方 {v} 被 {k} 做掉', '{v} 被抓，{k} 拿人头', '我方 {v} 阵亡'],
      multiAlly: ['{k} 拿到 {x}', '{k} 打出 {x}'],
      multiEnemy: ['对面 {k} 拿到 {x}，注意站位', '{k} 打出 {x}，别挤在一起'],
      turretDown: ['对方{lane}塔被推掉', '推掉对方{lane}塔'],
      turretLost: ['我方{lane}塔掉了', '{lane}塔丢掉，注意退守'],
      inhibDown: ['对方{lane}水晶被拆', '打掉对方{lane}水晶'],
      inhibLost: ['我方{lane}水晶被拆，注意超兵'],
      dragon: ['拿下{d}龙', '{d}龙到手'],
      dragonLost: ['对面拿了{d}龙', '{d}龙丢了'],
      baron: ['大龙到手，可以推了', '拿下大龙，抱团推进'],
      baronLost: ['大龙丢了，收缩防守', '对面拿了大龙，先守'],
      herald: ['拿到峡谷先锋', '先锋到手'],
      heraldLost: ['先锋丢了'],
      atakhan: ['拿到厄塔汗', '厄塔汗到手'],
      atakhanLost: ['对面拿到厄塔汗'],
      firstBrick: ['拿到首塔，先手优势', '首塔到手'],
      aceAlly: ['团灭对面，跟上', '对面全灭，推进'],
      aceEnemy: ['我方被团灭，先守', '被团灭，稳住等复活'],
      leadLight: ['我方小幅领先', '我们领先一点'],
      leadBig: ['我方领先{m}，优势明显', '领先{m}了，可以扩大'],
      behindLight: ['现在有点落后', '稍微落后，先稳'],
      behindBig: ['落后{m}，局势告急', '落后{m}，先别开团'],
      even: ['双方基本持平', '局面打平'],
      half: ['{t}过去，{s}', '{t}，{s}'],
      end: ['对局结束', '本局结束'],
      endStat: ['本局{k}杀{d}死，{r}', '打完了，{k}杀{d}死，{r}']
    },
    tough: {
      killAlly: ['{k} 把 {v} 做了', '{k} 收下 {v}', '{k} 干掉 {v}'],
      killAllySpree: ['{k} 又杀了，{v} 白给', '{k} 收掉 {v}，{n} 个了'],
      killDeath: ['{v} 白给了', '我方 {v} 被 {k} 做掉，走位呢', '{v} 被抓，这波亏'],
      multiAlly: ['{k} {x}，对面懵了', '{k} 打出 {x}'],
      multiEnemy: ['对面 {k} {x}，站那么密干嘛', '{k} 拿 {x}，别送了'],
      turretDown: ['推掉对面{lane}塔', '对面{lane}塔没了'],
      turretLost: ['{lane}塔没了，守一下吧', '{lane}塔被拆'],
      inhibDown: ['对面{lane}水晶破了', '打穿{lane}水晶'],
      inhibLost: ['{lane}水晶破了，超兵要来了'],
      dragon: ['{d}龙到手', '{d}龙拿了'],
      dragonLost: ['{d}龙没了', '对面拿了{d}龙'],
      baron: ['大龙拿了，推起来', '大龙到手，别浪'],
      baronLost: ['大龙没了，笑不出来', '对面大龙，先缩'],
      herald: ['先锋到手', '先锋拿了'],
      heraldLost: ['先锋没了'],
      atakhan: ['厄塔汗到手'],
      atakhanLost: ['厄塔汗丢了'],
      firstBrick: ['首塔到手', '先拆一个'],
      aceAlly: ['团灭对面，推塔去', '对面全躺，走'],
      aceEnemy: ['被团灭，这下难受了', '全躺了，等复活'],
      leadLight: ['小领先，别飘', '领先一点'],
      leadBig: ['领先{m}了，稳住别浪', '{m}优势，别送回去'],
      behindLight: ['落后了，先苟', '小崩，稳住'],
      behindBig: ['落后{m}，崩得有点快', '落后{m}，先别打团'],
      even: ['五五开', '打平了'],
      half: ['{t}了，{s}', '{t}，{s}'],
      end: ['打完收工', '结束了'],
      endStat: ['{k}杀{d}死，{r}', '本局{k}杀{d}死，{r}']
    }
  };

  // 风格名收敛: 认不出来的值一律按解说腔处理 (它是默认风格)
  function toneOf(t) {
    return t === 'coach' || t === 'tough' ? t : 'caster';
  }

  function pick(list, seq) {
    if (!Array.isArray(list) || !list.length) return '';
    const i = Math.abs(Number(seq) || 0) % list.length;
    return list[i];
  }

  function fill(tpl, vars) {
    return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (
      vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] == null ? '' : vars[k]) : ''
    ));
  }

  // ---------- 事件 → 播报 ----------
  // 返回 null 表示这条事件不该播 (阵营不明 / 与自己无关 / 拿不到英雄名)
  //   text   播报文本
  //   key    去重键 (同一事件只播一次)
  //   cd     冷却毫秒 (0 表示不额外限流)
  //   kind   事件类别, 便于上层做"同类压制"
  function buildEventLine(ev, ctx) {
    if (!ev || typeof ev !== 'object') return null;
    const c = ctx || {};
    const tone = toneOf(c.tone);
    const lines = T[tone];
    const roster = c.roster;
    const myTeam = c.myTeam;
    const seq = Number(c.seq) || 0;
    const name = String(ev.EventName || '');
    const killer = ev.KillerName;
    const kSide = sideOf(roster, killer, myTeam);
    const kName = nameOf(roster, killer);

    if (name === 'ChampionKill') {
      const vSide = sideOf(roster, ev.VictimName, myTeam);
      const vName = nameOf(roster, ev.VictimName);
      // 缺任何一边的英雄名就不播: 半截播报比不播更糟
      if (!vName || !vSide) return null;
      if (kSide === 'ally' && vSide === 'enemy') {
        const spree = Number(c.allyKills) || 0;
        // 连拿 3 个以上换成"又收一个"的句式, 手感上能听出在压着打
        const tpl = spree >= 3 ? pick(lines.killAllySpree, seq) : pick(lines.killAlly, seq);
        return { text: fill(tpl, { k: kName, v: vName, n: spree }), key: 'kill:' + ev.EventID, cd: 0, kind: 'kill' };
      }
      if (vSide === 'ally' && kSide === 'enemy') {
        return { text: fill(pick(lines.killDeath, seq), { k: kName, v: vName }), key: 'death:' + ev.EventID, cd: 0, kind: 'death' };
      }
      return null;
    }

    if (name === 'Multikill') {
      const streak = Number(ev.KillStreak) || 0;
      if (streak < 2) return null;
      const label = { 2: '双杀', 3: '三杀', 4: '四杀', 5: '五杀' }[Math.min(streak, 5)] || '多杀';
      if (kSide === 'ally') return { text: fill(pick(lines.multiAlly, seq), { k: kName, x: label }), key: 'multi:' + ev.EventID, cd: 0, kind: 'multi' };
      if (kSide === 'enemy') return { text: fill(pick(lines.multiEnemy, seq), { k: kName, x: label }), key: 'multi:' + ev.EventID, cd: 0, kind: 'multi' };
      return null;
    }

    if (name === 'TurretKilled') {
      const info = parseTurret(ev.TurretKilled);
      if (!info || !myTeam) return null;
      const lane = LANE_CN[info.lane] || '一路';
      // T1/T2 是客户端固定的队伍编号, 与 myTeam 的 ORDER/CHAOS 需先对齐
      const ownerTeam = info.teamNum === 'T1' ? 'ORDER' : 'CHAOS';
      const mine = ownerTeam === String(myTeam).toUpperCase();
      const tpl = mine ? pick(lines.turretLost, seq) : pick(lines.turretDown, seq);
      return { text: fill(tpl, { lane }), key: 'turret:' + ev.EventID, cd: 0, kind: 'turret' };
    }

    if (name === 'InhibKilled') {
      const m = /^Inhib_(T\d)_([LCB])/i.exec(String(ev.InhibKilled || ''));
      if (!m || !myTeam) return null;
      const lane = LANE_CN[String(m[2]).toUpperCase()] || '一路';
      const ownerTeam = String(m[1]).toUpperCase() === 'T1' ? 'ORDER' : 'CHAOS';
      const mine = ownerTeam === String(myTeam).toUpperCase();
      const tpl = mine ? pick(lines.inhibLost, seq) : pick(lines.inhibDown, seq);
      return { text: fill(tpl, { lane }), key: 'inhib:' + ev.EventID, cd: 0, kind: 'inhib' };
    }

    if (name === 'DragonKill') {
      if (!kSide) return null;
      const raw = String(ev.DragonType || ev.DragonTypeKilled || '').toLowerCase();
      const d = DRAGON_CN[raw] || '';
      if (!d) return { text: kSide === 'ally' ? pick(lines.dragon, seq).replace('{d}', '小') : pick(lines.dragonLost, seq).replace('{d}', '小'), key: 'dragon:' + ev.EventID, cd: 0, kind: 'dragon' };
      const tpl = kSide === 'ally' ? pick(lines.dragon, seq) : pick(lines.dragonLost, seq);
      return { text: fill(tpl, { d }), key: 'dragon:' + ev.EventID, cd: 0, kind: 'dragon' };
    }

    if (name === 'BaronKill') {
      if (!kSide) return null;
      const tpl = kSide === 'ally' ? pick(lines.baron, seq) : pick(lines.baronLost, seq);
      return { text: tpl, key: 'baron:' + ev.EventID, cd: 0, kind: 'baron' };
    }

    if (name === 'HeraldKill') {
      if (!kSide) return null;
      const tpl = kSide === 'ally' ? pick(lines.herald, seq) : pick(lines.heraldLost, seq);
      return { text: tpl, key: 'herald:' + ev.EventID, cd: 0, kind: 'herald' };
    }

    if (name === 'AtakhanKill') {
      if (!kSide) return null;
      const tpl = kSide === 'ally' ? pick(lines.atakhan, seq) : pick(lines.atakhanLost, seq);
      return { text: tpl, key: 'atakhan:' + ev.EventID, cd: 0, kind: 'atakhan' };
    }

    if (name === 'FirstBrick') {
      if (!kSide) return null;
      return { text: pick(lines.firstBrick, seq), key: 'brick:' + ev.EventID, cd: 0, kind: 'brick' };
    }

    if (name === 'Ace') {
      if (!myTeam || !ev.AcingTeam) return null;
      const allyAce = String(ev.AcingTeam) === String(myTeam);
      return { text: pick(allyAce ? lines.aceAlly : lines.aceEnemy, seq), key: 'ace:' + ev.EventID, cd: 0, kind: 'ace' };
    }

    return null;
  }

  // ---------- 局势小结 ----------
  // 每 5 分钟播一次。只讲"能算出来的": 经济差 + 击杀比分。
  // 塔数/龙数在 live data 里没有直接字段, 不做推断。
  function buildSituation(ctx) {
    const c = ctx || {};
    const tone = toneOf(c.tone);
    const lines = T[tone];
    const leadPct = Number(c.leadPct) || 0;
    const gold = Math.round(Math.abs(Number(c.goldDiff) || 0));
    const t = sayMinute(c.gameTime);
    let core;
    if (leadPct >= 20) core = fill(pick(lines.leadBig, c.seq), { m: sayNum(gold) });
    else if (leadPct >= 10) core = pick(lines.leadLight, c.seq);
    else if (leadPct <= -20) core = fill(pick(lines.behindBig, c.seq), { m: sayNum(gold) });
    else if (leadPct <= -10) core = pick(lines.behindLight, c.seq);
    else core = pick(lines.even, c.seq);
    let text = fill(pick(lines.half, c.seq), { t, s: core });
    const k = Number(c.kills), d = Number(c.deaths);
    if (Number.isFinite(k) && Number.isFinite(d) && c.withScore) {
      text += '，' + k + '比' + d;
    }
    return { text, key: 'half:' + Math.floor((Number(c.gameTime) || 0) / 300) };
  }

  // ---------- 结束总结 ----------
  function buildEndSummary(ctx) {
    const c = ctx || {};
    const tone = toneOf(c.tone);
    const lines = T[tone];
    const k = Number(c.kills) || 0;
    const d = Number(c.deaths) || 0;
    const leadPct = Number(c.leadPct) || 0;
    let r;
    if (leadPct >= 10) r = '领先到最后';
    else if (leadPct <= -10) r = '后半程没追回来';
    else r = '一直咬得很紧';
    return { text: fill(pick(lines.endStat, c.seq), { k, d, r }), key: 'end:sum' };
  }

  // 塔名编号说明: Live Client Data 里的 _05_ / _03_ 与"一塔/二塔"的对应关系
  // 在不同地图上并不一致, 因此这里刻意只报路, 不报几塔 —— 报错比不报更糟。

  return {
    sayNum,
    sayMinute,
    buildRoster,
    lookupRoster,
    nameOf,
    sideOf,
    parseTurret,
    DRAGON_CN,
    LANE_CN,
    buildEventLine,
    buildSituation,
    buildEndSummary,
    fill,
    pick,
    TEMPLATES: T
  };
});
