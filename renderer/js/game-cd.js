// 对局内技能计时 —— 数据与口径层 (主窗口侧)
//
// 为什么需要它: 对局战报浮窗 (F9) 只"展示"不"计时"。实际对局里最值钱的信息是
// "对面闪现还有多久" —— Akari 为此单独做了 cd-timer 窗口, DraftCoach 把它当核心卖点。
//
// 数据来源:
//   1. 敌方 5 人的召唤师技能/英雄: live.js 已拉到的 allgamedata (allPlayers)
//   2. 大招基础冷却: DDragon champion.json 的 spells[3].cooldown[0] (秒)
//   3. 召唤师技能基础冷却: 下面这张表 (zh_CN 名称 → 秒)
//   4. 标记: 用户在浮窗上点一下图标即开始倒计时, 状态只存在浮窗进程内
//
// 刻意不做"自动推断敌人是否用了技能": Live Client Data 不提供技能施放事件,
// 想拿到只能读内存/注入 —— 那与"只读、不碰游戏进程"的定位冲突。点一下是成本,
// 但换来的是数据一定真实。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  // window.X 形式既是浏览器里的真实赋值, 也让静态检查 (test_undef_globals) 认得出这个名字
  if (typeof window !== 'undefined') window.PoroCd = api;
  else if (root) root.PoroCd = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // 召唤师技能基础冷却 (秒)。国服/外服名称都收, 名称来自 DDragon 对应语言包。
  const SPELL_CD = {
    '闪现': 300, 'Flash': 300,
    '传送': 360, 'Teleport': 360,
    '引燃': 180, 'Ignite': 180,
    '治疗术': 240, 'Heal': 240,
    '屏障': 180, 'Barrier': 180,
    '疾跑': 210, 'Ghost': 210,
    '净化': 210, 'Cleanse': 210,
    '虚弱': 210, 'Exhaust': 210,
    '清晰术': 240, 'Clarity': 240,
    '惩戒': 15, 'Smite': 15,
    '标记': 80, 'Mark': 80, 'Snowball': 80
  };

  const SPELL_ALIAS = [
    [/闪现|Flash/i, '闪现'], [/传送|Teleport/i, '传送'], [/引燃|点燃|Ignite/i, '引燃'],
    [/治疗|Heal/i, '治疗术'], [/屏障|Barrier/i, '屏障'], [/疾跑|Ghost/i, '疾跑'],
    [/净化|Cleanse/i, '净化'], [/虚弱|Exhaust/i, '虚弱'], [/清晰|Clarity/i, '清晰术'],
    [/惩戒|Smite/i, '惩戒'], [/标记|雪球|Mark/i, '标记']
  ];

  // 选人/加载阶段的 participants 只给数字 id (Live Client Data 给的是名字)
  const SPELL_ID_CN = {
    1: '净化', 3: '虚弱', 4: '闪现', 6: '疾跑', 7: '治疗术', 11: '惩戒',
    12: '传送', 13: '清晰术', 14: '引燃', 21: '屏障', 32: '标记'
  };
  function spellById(id) { return SPELL_ID_CN[Number(id)] || ''; }

  function spellCd(name) {
    const raw = String(name || '');
    if (!raw) return null;
    if (SPELL_CD[raw]) return SPELL_CD[raw];
    for (const [re, key] of SPELL_ALIAS) if (re.test(raw)) return SPELL_CD[key];
    return null;
  }

  // 技能急速换算: 冷却 = 基础 × 100 / (100 + 急速)
  function applyHaste(baseSec, haste) {
    const base = Number(baseSec);
    if (!Number.isFinite(base) || base <= 0) return null;
    const h = Math.max(0, Number(haste) || 0);
    return Math.round(base * 100 / (100 + h));
  }

  function ultCdOf(champion, haste) {
    try {
      const spells = champion && champion.spells;
      if (!spells || !spells[3]) return null;
      const cd = spells[3].cooldown;
      const base = Array.isArray(cd) ? Number(cd[0]) : Number(cd);
      if (!base) return null;
      return applyHaste(base, haste);
    } catch (e) { return null; }
  }

  /**
   * 组装浮窗需要的计时行 (不含已用时间, 已用时间在浮窗里按 marks 算)
   * @param {Array} players live.js 的 10 人
   * @param {object} opts { selfTeam, champOf(id)->{name, key, champion}, spellHaste, ultHaste }
   */
  function rowsFor(players, opts) {
    const o = opts || {};
    const list = (Array.isArray(players) ? players : []).filter(p => p && !p.isBot);
    const teamNo = Number(o.selfTeam || 0);
    const enemies = teamNo ? list.filter(p => Number(p.team) !== teamNo) : [];
    return enemies.slice(0, 5).map((p, i) => {
      const champ = (() => { try { return o.champOf ? o.champOf(p.championId) : null; } catch (e) { return null; } })();
      const cdata = champ && champ.champion ? champ.champion : champ;
      const spells = (Array.isArray(p.spells) && p.spells.length ? p.spells
        : (Array.isArray(p.spellIds) ? p.spellIds.map(spellById) : [])).slice(0, 2);
      return {
        key: String(p.puuid || ('enemy' + i)),
        name: p.name || '未知',
        champName: (cdata && cdata.name) || (champ && champ.name) || '',
        champKey: (cdata && cdata.id) || (champ && champ.id) || '',
        spells: spells.map((s, idx) => {
          const nm = typeof s === 'string' ? s : (s && (s.displayName || s.name || s.rawDisplayName)) || '';
          return { slot: idx === 0 ? 'D' : 'F', name: nm, cd: spellCd(nm) };
        }),
        ult: { name: 'R', cd: ultCdOf(cdata, o.ultHaste) }
      };
    });
  }

  // 倒计时文本: 只显示到秒; 到 0 之后返回 ready=true
  function stateOf(mark, cdSec, now) {
    if (!mark || !cdSec) return { remaining: 0, ready: true, text: '' };
    const left = Math.max(0, Math.ceil((mark + cdSec * 1000 - now) / 1000));
    return { remaining: left, ready: left <= 0, text: left >= 60 ? Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') : String(left) };
  }

  function fmt(sec) {
    if (sec == null) return '—';
    if (sec < 60) return sec + 's';
    return Math.floor(sec / 60) + 'm' + (sec % 60 ? String(sec % 60).padStart(2, '0') + 's' : '');
  }

  return { SPELL_CD, SPELL_ID_CN, spellById, spellCd, applyHaste, ultCdOf, rowsFor, stateOf, fmt };
});
