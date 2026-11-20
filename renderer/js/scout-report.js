// 载入期侦察报告 —— 把实时对局页已有的 5 个零件合成一张纸。
//
// 零件 (都已存在, 本模块不发请求):
//   p.recent      近 20 场 (胜率 / KDA / 连败连胜 / 分均补刀 / 伤害占比 / 位置)
//   p.rank        段位字符串 (来自 SGP/LCU)
//   p.premadeGroupId 开黑分组 (live.js 已算)
//   champNameOf() 英雄中文名
//   smurf-tags.js 的小代判定 (这里只做"样本+胜率"的轻量提示, 不重复它的阈值)
//
// 设计原则 (与 enemy-intel 一致):
//   1. 只给"能由数据直接算出来的结论", 不做心理战/胜率预测;
//   2. 每个分数都带理由 (reason), 用户能反推;
//   3. 样本不足就不给分 (返回 null), 不拿一局巧合当证据;
//   4. 输出"强度差"而不是"胜率预估" —— 后者会被人当成概率信。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  // window.X 形式既是浏览器里的真实赋值, 也让静态检查 (test_undef_globals) 认得出这个名字
  if (typeof window !== 'undefined') window.PoroScout = api;
  else if (root) root.PoroScout = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const MIN_GAMES = 5;
  const TIER_SCORE = [
    [/王者|CHALLENGER/i, 3.0], [/宗师|GRANDMASTER/i, 2.6], [/大师|MASTER/i, 2.2],
    [/钻石|DIAMOND/i, 1.6], [/翡翠|EMERALD/i, 1.2], [/铂金|PLATINUM/i, 0.8],
    [/黄金|GOLD/i, 0.4], [/白银|SILVER/i, 0.1], [/青铜|BRONZE/i, -0.2], [/黑铁|IRON/i, -0.4]
  ];

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function tierScore(rank) {
    const s = String(rank || '');
    for (const [re, v] of TIER_SCORE) if (re.test(s)) return v;
    return 0;
  }

  // 连胜/连败: recent 新局在前
  function streakOf(recent) {
    if (!Array.isArray(recent) || !recent.length) return { type: '', n: 0 };
    const first = recent[0].win === true || recent[0].win === 'Win';
    let n = 0;
    for (const r of recent) {
      const w = r.win === true || r.win === 'Win';
      if (w !== first) break;
      n += 1;
    }
    return { type: n >= 2 ? (first ? 'win' : 'loss') : '', n };
  }

  function poolOf(recent, limit) {
    const map = new Map();
    for (const r of (Array.isArray(recent) ? recent : [])) {
      const id = +r.champId || 0;
      if (!id) continue;
      const cur = map.get(id) || { id, games: 0, wins: 0 };
      cur.games += 1;
      if (r.win === true || r.win === 'Win') cur.wins += 1;
      map.set(id, cur);
    }
    return [...map.values()].sort((a, b) => b.games - a.games || b.wins - a.wins).slice(0, limit || 2);
  }

  /**
   * 单名玩家的强度评估。
   * @returns {{score:number|null, threat:number|null, reasons:string[], games:number, wr:number|null, kda:number|null, streak:object, smurfHint:boolean}}
   */
  function evalPlayer(p, opts) {
    const recent = Array.isArray(p && p.recent) ? p.recent : [];
    const games = recent.length;
    const k = recent.reduce((s, r) => s + (num(r.k) || 0), 0);
    const d = recent.reduce((s, r) => s + (num(r.d) || 0), 0);
    const a = recent.reduce((s, r) => s + (num(r.a) || 0), 0);
    const wins = recent.filter(r => r.win === true || r.win === 'Win').length;
    const wr = games ? Math.round(wins / games * 100) : null;
    const kda = games ? (k + a) / Math.max(1, d) : null;
    const streak = streakOf(recent);
    const reasons = [];
    let score = 3.0;   // 中性起点
    if (games >= MIN_GAMES) {
      if (wr != null) {
        if (wr >= 65) { score += 2.4; reasons.push(`近 ${games} 场胜率 ${wr}%`); }
        else if (wr >= 55) { score += 1.4; reasons.push(`近 ${games} 场胜率 ${wr}%`); }
        else if (wr <= 35) { score -= 1.4; reasons.push(`近 ${games} 场胜率仅 ${wr}%`); }
        else if (wr <= 45) { score -= 0.7; reasons.push(`近 ${games} 场胜率 ${wr}%`); }
      }
      if (kda != null) {
        if (kda >= 4) { score += 1.6; reasons.push(`KDA ${kda.toFixed(1)}`); }
        else if (kda >= 3) { score += 0.8; reasons.push(`KDA ${kda.toFixed(1)}`); }
        else if (kda <= 1.6) { score -= 0.8; reasons.push(`KDA ${kda.toFixed(1)} 偏低`); }
      }
      if (streak.type === 'win' && streak.n >= 3) { score += 0.8; reasons.push(`${streak.n} 连胜`); }
      if (streak.type === 'loss' && streak.n >= 3) { score -= 0.6; reasons.push(`${streak.n} 连败`); }
    } else {
      reasons.push(`样本不足 (${games} 场)`);
    }
    const ts = tierScore(p && p.rank);
    if (ts) { score += ts; reasons.push(`当前段位 ${p.rank}`); }
    // 小代只是"提示", 不下结论 (正式判定在 smurf-tags.js)
    const smurfHint = games >= 10 && wr != null && wr >= 70 && kda != null && kda >= 4;
    if (smurfHint) reasons.push('胜率与 KDA 同时偏高，建议按强点处理');
    const clamped = Math.max(1, Math.min(10, Math.round(score * 10) / 10));
    return {
      score: games >= MIN_GAMES ? Math.round(score * 100) / 100 : null,
      threat: games >= MIN_GAMES ? Math.max(1, Math.min(10, Math.round(clamped))) : null,
      reasons: reasons.slice(0, 4),
      games, wr, kda: kda == null ? null : Math.round(kda * 10) / 10,
      streak, smurfHint
    };
  }

  function teamScore(list) {
    const scored = list.map(x => (x && x.score != null ? x.score : (x && x.eval ? x.eval.score : null))).filter(v => v != null);
    if (!scored.length) return null;
    return Math.round(scored.reduce((s, v) => s + v, 0) / scored.length * 100) / 100;
  }

  /**
   * @param {Array} players live.js 的 10 人数组
   * @param {object} opts { selfPuuid, champName(id) }
   */
  function build(players, opts) {
    const o = opts || {};
    const list = Array.isArray(players) ? players.filter(p => p && !p.isBot) : [];
    const self = o.selfPuuid ? list.find(p => p.puuid === o.selfPuuid) : null;
    const selfTeam = self ? Number(self.team) : 0;
    if (!list.length || !selfTeam) return { ready: false, reason: selfTeam ? '没有可评估的玩家' : '还没识别到自己所在的队伍' };
    const nameOf = id => {
      try { return o.champName ? (o.champName(id) || '') : ''; } catch (e) { return ''; }
    };
    const wrap = p => {
      const e = evalPlayer(p, o);
      return Object.assign({
        name: p.name || '未知',
        puuid: p.puuid || '',
        team: Number(p.team),
        championId: +p.championId || 0,
        champName: nameOf(p.championId),
        rank: p.rank || '',
        premadeGroupId: p.premadeGroupId || null,
        pool: poolOf(p.recent, 2).map(c => ({ id: c.id, name: nameOf(c.id), games: c.games, wins: c.wins }))
      }, e);
    };
    const mates = list.filter(p => Number(p.team) === selfTeam).map(wrap);
    const enemies = list.filter(p => Number(p.team) !== selfTeam).map(wrap);
    const allyScore = teamScore(mates), enemyScore = teamScore(enemies);
    const diff = allyScore != null && enemyScore != null ? Math.round((allyScore - enemyScore) * 100) / 100 : null;
    let verdict = '';
    if (diff != null) {
      if (diff >= 1.2) verdict = '明显占优';
      else if (diff >= 0.4) verdict = '略占优';
      else if (diff <= -1.2) verdict = '明显吃亏';
      else if (diff <= -0.4) verdict = '略吃亏';
      else verdict = '基本持平';
    }
    // 敌方最该盯: 威胁分最高, 同分看样本
    const ranked = enemies.filter(e => e.threat != null).sort((a, b) => b.threat - a.threat || b.games - a.games);
    const watch = ranked[0] || null;
    // 我方最稳: 强度分最高
    const allyRanked = mates.filter(m => m.score != null).sort((a, b) => b.score - a.score);
    const protect = allyRanked[0] || null;
    return {
      ready: true,
      allyScore, enemyScore, diff, verdict,
      mates, enemies,
      watch: watch ? { name: watch.name, threat: watch.threat, reasons: watch.reasons, champName: watch.champName } : null,
      protect: protect ? { name: protect.name, score: protect.score, reasons: protect.reasons } : null,
      bans: ranked.slice(0, 2).map(e => ({
        name: e.pool.length ? e.pool[0].name : '',
        reason: `${e.name} ${e.wr == null ? '' : e.wr + '% '}威胁 ${e.threat}/10`
      })).filter(b => b.name)
    };
  }

  function html(report, opts) {
    if (!report || !report.ready) return '';
    const o = opts || {};
    const collapsed = o.collapsed ? ' collapsed' : '';
    const diffText = report.diff == null ? '样本不足' : (report.diff > 0 ? '+' : '') + report.diff.toFixed(2);
    const diffCls = report.diff == null ? 'flat' : report.diff >= 0.4 ? 'up' : report.diff <= -0.4 ? 'down' : 'flat';
    const rows = report.enemies
      .slice().sort((a, b) => (b.threat || 0) - (a.threat || 0))
      .map(e => `<div class="sr-enemy">
        ${e.champName ? `<span class="sr-champ">${esc(e.champName)}</span>` : ''}
        <b class="sr-name">${esc(e.name)}</b>
        <span class="sr-threat t${e.threat == null ? 'x' : Math.min(10, Math.max(1, Math.round(e.threat / 2)))}">${e.threat == null ? '样本少' : '威胁 ' + e.threat + '/10'}</span>
        <span class="sr-why">${esc(e.reasons.join(' · '))}</span>
      </div>`).join('');
    const watch = report.watch
      ? `<div class="sr-focus"><span class="sr-focus-l">最该盯</span><b>${esc(report.watch.name)}</b>${report.watch.champName ? `<i>${esc(report.watch.champName)}</i>` : ''}<span class="sr-why">${esc(report.watch.reasons.join(' · '))}</span></div>`
      : '';
    const protect = report.protect
      ? `<div class="sr-focus safe"><span class="sr-focus-l">我方最稳</span><b>${esc(report.protect.name)}</b><span class="sr-why">${esc(report.protect.reasons.join(' · '))}</span></div>`
      : '';
    const bans = report.bans.length
      ? `<div class="sr-bans">${report.bans.map(b => `<span class="sr-ban"><b>${esc(b.name)}</b><i>${esc(b.reason)}</i></span>`).join('')}</div>`
      : '';
    return `<section class="sr-card${collapsed}">
      <div class="sr-head" onclick="toggleScoutReport(this)" role="button" tabindex="0" onkeydown="if(event.key==='Enter'){toggleScoutReport(this)}">
        <b>载入侦察</b>
        <span class="sr-diff ${diffCls}">强度差 ${diffText}</span>
        <span class="sr-verdict">${esc(report.verdict)}</span>
        <span class="sr-toggle">收起</span>
      </div>
      <div class="sr-body">${watch}${protect}${bans}<div class="sr-list">${rows}</div>
        <p class="sr-foot">分数由近 ${MIN_GAMES}+ 场的胜率 / KDA / 连胜连败 / 段位加权得出，只说明“这人近期打得怎样”，不是胜率预测。</p>
      </div>
    </section>`;
  }

  return { build, html, evalPlayer, poolOf, streakOf, tierScore, MIN_GAMES };
});
