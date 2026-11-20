// 阵容缺口提示 —— 一行, 不独立成卡片。
//
// 1.6.30 曾把它做成"车队视角"面板: 分组标签 + 团队合并胜率 + 五人明细 + 阵容缺口。
// 1.6.36 砍掉前三个, 理由:
//   · 分组: 十人卡已有 组1/组2 标签与同色左竖条, 再列一遍是重复信息;
//   · 五人明细 (每人胜率/KDA): 十人卡上每个人都有, 而且是同一批数字;
//   · 团队合并胜率: 同队五人的近 20 场高度相关, 相加再除出来的百分比不是独立样本,
//     容易被读成"这队 55% 胜率"这种并不存在的置信度 —— 干脆不给。
// 真正不重复的只有"这队的阵容结构缺什么", 所以只剩这一行 (约 18px)。
//
// 阵容判定用 DDragon 的英雄 tags (Fighter/Tank/Mage/Assassin/Marksman/Support) 粗判,
// 是标签比对, 不是模型结论 —— title 里如实写这句。
// 纯函数, 无 DOM/IO, 可在 node 里断言。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  // window.X 形式既是浏览器里的真实赋值, 也让静态检查 (test_undef_globals) 认得出这个名字
  if (typeof window !== 'undefined') window.PoroFleet = api;
  else if (root) root.PoroFleet = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /**
   * @param {Array} players live.js 的 10 人 (或 5 人) 数组
   * @param {object} opts { selfTeam, tags(id) -> string[] }
   */
  function build(players, opts) {
    const o = opts || {};
    const list = (Array.isArray(players) ? players : []).filter(p => p && !p.isBot);
    const teamNo = Number(o.selfTeam || 0);
    const team = teamNo ? list.filter(p => Number(p.team) === teamNo) : list;
    // 不足 2 人说明队伍还没识别出来, 这时候谈阵容缺口没有意义
    if (team.length < 2) return { ready: false, reason: '还没识别到己方队伍' };

    const tagsOf = id => {
      try { const t = o.tags ? o.tags(id) : null; return Array.isArray(t) ? t : []; } catch (e) { return []; }
    };
    const all = team.flatMap(p => tagsOf(p.championId));
    const has = t => all.includes(t);
    const gaps = [];       // 短标签, 一行排得下
    const warnings = [];   // 完整句子, 放 title
    const note = (short, full) => { gaps.push(short); warnings.push(full); };
    if (!has('Tank') && !has('Fighter')) note('没有前排', '没有前排，开团靠先手失误');
    if (!has('Mage') && has('Marksman')) note('伤害单一', '伤害类型偏单一 (物理为主)');
    if (!has('Support') && !has('Tank')) note('缺硬辅', '缺少硬辅/开团位');
    if (!has('Marksman') && !has('Assassin')) note('缺输出', '缺少持续输出点');

    return { ready: true, size: team.length, gaps, warnings };
  }

  /**
   * @param {object} view build() 的返回值
   * @param {object} opts { mode } 只有 'rift' 显示 —— 大乱斗/斗魂/无限火力的阵容是系统随机的,
   *                        谈"缺前排"是废话, 不值得占那一行
   */
  function gapLine(view, opts) {
    if (!view || !view.ready) return '';
    const o = opts || {};
    if (o.mode && o.mode !== 'rift') return '';
    if (!view.gaps.length) return '';   // 没缺口就不占地方
    const title = view.warnings.join('；') + '。按英雄标签粗判，不替代你自己的判断。';
    return `<div class="ft-gap-line" title="${esc(title)}"><b>阵容缺口</b><span>${view.gaps.map(esc).join(' · ')}</span></div>`;
  }

  return { build, gapLine };
});
