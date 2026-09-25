// 首页: 段位 / 海斗自校准 / 玩家数据统计 / op.gg 风格渲染
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 召唤师段位 (合并到首页) ==========
const TIER_CN = { IRON: "坚韧黑铁", BRONZE: "英勇黄铜", SILVER: "不屈白银", GOLD: "荣耀黄金", PLATINUM: "华贵铂金", EMERALD: "翡翠", DIAMOND: "璀璨钻石", MASTER: "超凡大师", GRANDMASTER: "傲世宗师", CHALLENGER: "最强王者" };
const RANK_QUEUE_LABELS = [["RANKED_SOLO_5x5", "排位 单双排"], ["RANKED_FLEX_SR", "灵活组排"], ["RANKED_FLEX_TT", "极地大乱斗排位"]];
function rankTierCN(tier) { return TIER_CN[tier] || tier || ""; }
// 隐藏分估算 (校准至主流工具量级): 段位基准 + 分区 + LP + 该模式胜率修正 (非官方, 仅供参考)
const MMR_BASE = { IRON: 1500, BRONZE: 1700, SILVER: 1900, GOLD: 2100, PLATINUM: 2300, EMERALD: 2500, DIAMOND: 2700, MASTER: 2750, GRANDMASTER: 2900, CHALLENGER: 3050 };
const MMR_DIV = { I: 100, II: 66, III: 33, IV: 0 };
function mmrFromRanked(tier, division, lp, modeWr) {
  const base = MMR_BASE[tier];
  if (!base) return null;
  let v = base + (MMR_DIV[division] || 0) + (((lp || 0) - 50) * 0.5);
  if (modeWr !== undefined && modeWr !== null) v += (modeWr - 50) * 4;
  return Math.round(v);
}
// 大乱斗/海斗独立估算: 独立低基数 ELO (均值~1500), 与单双排无关。
// 不能只看胜率: 加 KDA 因子反映个人表现, 避免"被带赢的混子虚高 / 带不动的败方被低估"。
// 基准假设: 平均胜率 50%; 大乱斗阵亡多, 参考 KDA ≈ 2.2。
//   mmr = 1500 + (胜率-50)*24 + (KDA-2.2)*60   (钳位 1000~3000, 非官方仅供参考)
// agg = { n, w, k, d, a } (该模式近 N 场聚合), n<5 时不估算
function mmrAram(agg) {
  if (!agg || !agg.n || agg.n < 5) return null;
  const wr = agg.w / agg.n * 100;
  const kda = (agg.k + agg.a) / Math.max(1, agg.d);
  const v = 1500 + (wr - 50) * 24 + (kda - 2.2) * 60;
  return Math.max(1000, Math.min(3000, Math.round(v)));
}
// ========== 海斗估算自校准 ==========
// 常数基准 1500 源自大乱斗社区口径, 对海斗玩家池系统性偏低 (海斗玩家池 = 峡谷玩家, 平均远高于黑铁)。
// 方案: 收集"有海斗排位段位"玩家的 (海斗表现分, 排位推算MMR) 样本对, 样本>=8 时用中位数偏移作为学习基准。
// 过渡期: 基准退化为玩家自己的单双排锚点 (保守 -600 反映跨模式差距), 仍无则 1500。
let jadeCalib = { samples: {} };
let _jadeCalibTimer = null;
function jadeCalibPath() { return (window._userDataPath || '') + '/jade-calib.json'; }
async function loadJadeCalib() {
  try {
    const c = await lolAPI.readFile(jadeCalibPath());
    if (c) { const d = JSON.parse(c); if (d && d.samples) jadeCalib = d; }
    jadeCalib.samples = jadeCalib.samples || {};
  } catch (e) {}
}
function jadeCalibPerf(wr, kda) { return (wr - 50) * 24 + (kda - 2.2) * 60; }
function jadeCalibBase() {
  const arr = Object.values(jadeCalib.samples);
  if (arr.length < 8) return null;
  const offsets = arr.map(s => s.mmr - jadeCalibPerf(s.wr, s.kda)).sort((a, b) => a - b);
  return Math.round(offsets[Math.floor(offsets.length / 2)]);
}
function addJadeCalibSample(puuid, wr, kda, mmr) {
  if (!(wr > 0) || !(mmr > 0)) return;
  jadeCalib.samples[puuid] = { wr: Math.round(wr * 10) / 10, kda: Math.round(kda * 100) / 100, mmr, t: Date.now() };
  clearTimeout(_jadeCalibTimer);
  _jadeCalibTimer = setTimeout(async () => { try { await lolAPI.writeFile(jadeCalibPath(), JSON.stringify(jadeCalib)); } catch (e) {} }, 1500);
}
// 海斗估算: 基准优先级 = 校准学习值 > 单双排锚点 > 默认1500; 表现分公式与 mmrAram 一致
function mmrJadeEstimate(agg, soloMmr) {
  if (!agg || !agg.n || agg.n < 5) return null;
  const wr = agg.w / agg.n * 100;
  const kda = (agg.k + agg.a) / Math.max(1, agg.d);
  const perf = jadeCalibPerf(wr, kda);
  let base = jadeCalibBase(), basis = '校准基准';
  if (base == null) {
    if (soloMmr) { base = Math.max(1500, soloMmr - 600); basis = '单双排锚点-600'; }
    else { base = 1500; basis = '默认基准'; }
  }
  return { v: Math.max(1000, Math.min(3000, Math.round(base + perf))), basis };
}
function renderRankCards(queues) {
  return RANK_QUEUE_LABELS.map(([q, label]) => {
    const r = queues[q];
    if (!r || !r.tier) return "";
    const total = (r.wins || 0) + (r.losses || 0);
    const wr = total ? Math.round(r.wins / total * 100) : 0;
    const div = r.division ? " " + r.division : (r.rank ? " " + r.rank : "");
    const lp = (r.leaguePoints !== undefined && r.leaguePoints !== null) ? ` · ${r.leaguePoints}LP` : "";
    return `<div class="rank-mini"><div class="rm-label">${label}</div><div class="rm-tier">${rankTierCN(r.tier)}${div}</div><div class="rm-wr">${r.wins}胜${r.losses}负 · ${wr}%${lp}</div></div>`;
  }).join("");
}

// ========== 首页: 玩家数据统计 (SGP 完整战绩优先, LCU 回退) ==========
let homeStatsLoaded = false;
// 并发控制: homeStatsLoading=正在加载(轮询需跳过), homeStatsToken=请求代际(过期实例放弃渲染)
let homeStatsLoading = false;
let homeStatsToken = 0;
let cachedPlatformId = null;
let cachedSummonerName = null;
let cachedSummoner = null;
// 首页档案查看目标: null=自己, 否则为其他玩家 {puuid, name}
let profileOverride = null;
// 首页搜索历史仅保存在当前进程内：退出程序后自动清空。
const HOME_SEARCH_HISTORY_LIMIT = 10;
let homeSearchHistory = [];
let homeSearchDraft = '';
let homeScrollSnapshot = null;

function homeScrollContainer() {
  return document.querySelector('.main-content');
}

function setHomeScrollPosition(scroller, top) {
  if (!scroller) return;
  const target = Math.max(0, Number(top) || 0);
  // premium.css 曾给主内容区启用 smooth。DOM 整页替换期间平滑动画会与 Chromium
  // 的滚动锚定竞争，最终停在模式统计附近。以内联 auto 临时覆盖，确保一次性落位。
  const previousBehavior = scroller.style.scrollBehavior;
  scroller.style.scrollBehavior = 'auto';
  scroller.scrollTop = target;
  scroller.scrollTo({ top: target, left: 0, behavior: 'auto' });
  requestAnimationFrame(() => {
    scroller.scrollTop = target;
    scroller.style.scrollBehavior = previousBehavior;
  });
}

// 整页档案异步重绘前保留滚动位置。查询跨区玩家时，旧实现会先把数千像素高的
// 档案替换成一行“查询中”，浏览器因此把 scrollTop 强制夹到 0，最终表现为自动
// 跳回首页顶部。加载期间维持旧高度，结果挂载两帧后再恢复坐标。
function preserveHomeScroll(targetPuuid) {
  const scroller = homeScrollContainer();
  const panel = document.getElementById('playerPanel');
  if (!scroller || !panel) return;
  const currentPuuid = String(profileOverride?.puuid || cachedSummoner?.puuid || '');
  const nextPuuid = String(targetPuuid || '');
  const sameTarget = !!currentPuuid && currentPuuid === nextPuuid;
  const oldHeight = Math.ceil(panel.getBoundingClientRect().height);
  homeScrollSnapshot = {
    // 换人查询必须从新档案顶部开始，不能把上一位玩家的“模式统计/战绩”像素位置
    // 套给新页面；只有同一档案的后台补全和刷新才保持当前位置。
    top: sameTarget ? Math.max(0, scroller.scrollTop || 0) : 0,
    targetPuuid: nextPuuid,
    sameTarget,
    createdAt: Date.now()
  };
  if (oldHeight > 0) panel.style.minHeight = `${Math.max(oldHeight, scroller.clientHeight || 0)}px`;
  if (!sameTarget) setHomeScrollPosition(scroller, 0);
}

function restoreHomeScroll(targetPuuid) {
  const snapshot = homeScrollSnapshot;
  if (!snapshot || snapshot.targetPuuid !== String(targetPuuid || '')) return;
  homeScrollSnapshot = null;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const scroller = homeScrollContainer();
    const panel = document.getElementById('playerPanel');
    if (panel) panel.style.minHeight = '';
    if (!scroller || Date.now() - snapshot.createdAt > 30000) return;
    setHomeScrollPosition(scroller, Math.min(snapshot.top, Math.max(0, scroller.scrollHeight - scroller.clientHeight)));
  }));
}

function buildHomeCoach(games, summoner) {
  const rows = (games || []).map(game => ({ game, me: findProfileParticipant(game, summoner) })).filter(row => row.me);
  if (!rows.length) return '';
  const recent = rows.slice(0, 10);
  const previous = rows.slice(10, 20);
  const avg = (list, field) => list.length ? list.reduce((sum, row) => sum + (+row.me[field] || 0), 0) / list.length : 0;
  const rate = list => list.length ? list.filter(row => row.me.win).length / list.length : 0;
  const recentDeaths = avg(recent, 'd');
  const recentKda = (avg(recent, 'k') + avg(recent, 'a')) / Math.max(1, recentDeaths);
  const recentWinRate = rate(recent);
  let goal;
  if (recentDeaths >= 8.5) goal = { title: '减少无效阵亡', detail: '下一阶段目标：单局死亡不超过 8 次', pass: row => (+row.me.d || 0) <= 8 };
  else if (recentKda < 2.8) goal = { title: '提高稳定参战', detail: '下一阶段目标：单局 KDA 达到 3.0', pass: row => ((+row.me.k || 0) + (+row.me.a || 0)) / Math.max(1, +row.me.d || 0) >= 3 };
  else if (recentWinRate < 0.5) goal = { title: '把优势转成胜场', detail: '下一阶段目标：最近 5 场至少赢 3 场', pass: row => !!row.me.win };
  else goal = { title: '保持高质量发挥', detail: '下一阶段目标：单局 KDA 达到 4.0', pass: row => ((+row.me.k || 0) + (+row.me.a || 0)) / Math.max(1, +row.me.d || 0) >= 4 };
  const progressRows = recent.slice(0, 5);
  const completed = progressRows.filter(goal.pass).length;
  const trend = previous.length ? Math.round((recentWinRate - rate(previous)) * 100) : null;

  const pool = new Map();
  for (const row of rows.slice(0, 30)) {
    const id = String(row.me.championId || '');
    if (!id) continue;
    const item = pool.get(id) || { id, games: 0, wins: 0, k: 0, d: 0, a: 0 };
    item.games++; item.wins += row.me.win ? 1 : 0;
    item.k += +row.me.k || 0; item.d += +row.me.d || 0; item.a += +row.me.a || 0;
    pool.set(id, item);
  }
  const champions = [...pool.values()].filter(item => item.games >= 2).sort((a, b) => b.games - a.games || b.wins - a.wins).slice(0, 4);
  const poolRows = champions.map(item => {
    const champ = champNumMap?.[item.id] || Object.values(allChampions || {}).find(c => String(c.key) === item.id);
    const name = champ?.name || champ?.id || '未知英雄';
    const imageId = champ?.id || Object.keys(allChampions || {}).find(key => String(allChampions[key]?.key) === item.id);
    const wr = Math.round(item.wins / item.games * 100);
    const kda = ((item.k + item.a) / Math.max(1, item.d)).toFixed(1);
    const advice = wr < 50 ? '需要复盘' : item.games >= 5 ? '核心英雄' : '继续观察';
    return `<div class="hc-champ"><img src="${imageId ? champImg(imageId) : placeholder('?')}" onerror="this.src='${placeholder('?')}'"><span><b>${escapeHtml(name)}</b><small>${item.games}场 · ${wr}% · KDA ${kda}</small></span><em class="${wr >= 50 ? 'pos' : 'neg'}">${advice}</em></div>`;
  }).join('');
  const reviewNames = champions.filter(item => item.wins / item.games < 0.5).map(item => {
    const champ = champNumMap?.[item.id] || Object.values(allChampions || {}).find(c => String(c.key) === item.id);
    return champ?.name || champ?.id || '未知英雄';
  });
  return `<section class="home-coach">
    <div class="hc-head"><b>持续提升中心</b><span>根据最近战绩自动更新，不使用虚构段位或胜率</span></div>
    <div class="hc-grid">
      <div class="hc-card"><label>本阶段训练目标</label><strong>${goal.title}</strong><p>${goal.detail}</p><div class="hc-progress"><i style="width:${progressRows.length ? completed / progressRows.length * 100 : 0}%"></i></div><small>最近 ${progressRows.length} 场完成 ${completed} 场${trend == null ? '' : ` · 胜率趋势 ${trend >= 0 ? '+' : ''}${trend}%`}</small></div>
      <div class="hc-card hc-pool"><label>英雄池教练</label>${poolRows || '<p>至少使用同一英雄完成 2 场后生成建议。</p>'}</div>
      <div class="hc-card"><label>版本影响提示</label><strong>数据版本 ${escapeHtml(typeof version === 'string' ? version : '未知')}</strong><p>${reviewNames.length ? `优先复盘：${escapeHtml(reviewNames.join('、'))}` : '当前核心英雄近期表现稳定，版本更新后继续观察前 5 场。'}</p><small>仅基于你的近期实战变化，不冒充官方改动结论</small></div>
    </div>
  </section>`;
}

// 趣味数据只描述本次首页已加载的近期对局，不包装成“生涯纪录”。保持为纯计算函数，
// 便于用固定样本回归最长连胜、活跃时段和幸运英雄等边界。
function deriveHomeFunStats(rows) {
  const list = Array.isArray(rows) ? rows.filter(row => row?.game && row?.me) : [];
  const periods = [
    { key: 'late', label: '深夜档', icon: '🌙', from: 0, to: 5 },
    { key: 'morning', label: '上午档', icon: '☀️', from: 6, to: 11 },
    { key: 'afternoon', label: '下午档', icon: '🌤️', from: 12, to: 17 },
    { key: 'evening', label: '晚间档', icon: '🌆', from: 18, to: 23 }
  ].map(period => ({ ...period, games: 0 }));
  let longestWinStreak = 0, runningWins = 0, zeroDeaths = 0;
  let maxDamage = { value: 0, championId: 0 };
  let bestKda = { value: 0, championId: 0, k: 0, d: 0, a: 0 };
  let longestGame = { seconds: 0, championId: 0 };
  let totalKills = 0, totalDeaths = 0, totalAssists = 0;
  let totalDamage = 0, damageGames = 0, timedDamage = 0, timedSeconds = 0;
  let totalDamageTaken = 0, damageTakenGames = 0;
  let conversionDamage = 0, conversionGold = 0;
  let participationTotal = 0, participationGames = 0;
  const champions = new Map();
  // 历史通常按新→旧返回；反转后按真实时间方向计算连续胜场。
  for (const row of list.slice().reverse()) {
    const { game, me } = row;
    if (me.win) { runningWins++; longestWinStreak = Math.max(longestWinStreak, runningWins); }
    else runningWins = 0;
    if ((+me.d || 0) === 0) zeroDeaths++;
    const damage = +me.dmg || 0;
    const kills = +me.k || 0, deaths = +me.d || 0, assists = +me.a || 0;
    totalKills += kills; totalDeaths += deaths; totalAssists += assists;
    if (Number.isFinite(+me.dmg)) { totalDamage += damage; damageGames++; }
    if ((+game.dur || 0) > 0 && Number.isFinite(+me.dmg)) {
      timedDamage += damage;
      timedSeconds += +game.dur;
    }
    if (Number.isFinite(+me.dmgTaken)) {
      totalDamageTaken += +me.dmgTaken || 0;
      damageTakenGames++;
    }
    if ((+me.gold || 0) > 0 && Number.isFinite(+me.dmg)) {
      conversionDamage += damage;
      conversionGold += +me.gold;
    }
    const teammates = Array.isArray(game.participants)
      ? game.participants.filter(player => String(player?.teamId) === String(me.teamId))
      : [];
    const teamKills = teammates.reduce((sum, player) => sum + (+player?.k || 0), 0);
    if (teamKills > 0) {
      participationTotal += Math.min(1, (kills + assists) / teamKills);
      participationGames++;
    }
    if (damage > maxDamage.value) maxDamage = { value: damage, championId: +me.championId || 0 };
    const kda = (kills + assists) / Math.max(1, deaths);
    if (kda > bestKda.value) bestKda = { value: kda, championId: +me.championId || 0, k: kills, d: deaths, a: assists };
    const seconds = +game.dur || 0;
    if (seconds > longestGame.seconds) longestGame = { seconds, championId: +me.championId || 0 };
    const championId = String(+me.championId || 0);
    if (championId !== '0') {
      const stat = champions.get(championId) || { id: +championId, games: 0, wins: 0 };
      stat.games++; if (me.win) stat.wins++;
      champions.set(championId, stat);
    }
    let timestamp = +game.time || 0;
    if (timestamp > 0 && timestamp < 1e12) timestamp *= 1000;
    if (timestamp > 0) {
      const hour = new Date(timestamp).getHours();
      const period = periods.find(item => hour >= item.from && hour <= item.to);
      if (period) period.games++;
    }
  }
  const favoritePeriod = periods.slice().sort((a, b) => b.games - a.games || periods.indexOf(a) - periods.indexOf(b))[0];
  const luckyChampion = [...champions.values()].filter(item => item.games >= 2).sort((a, b) =>
    b.wins / b.games - a.wins / a.games || b.games - a.games || a.id - b.id)[0] || null;
  const performance = {
    averageKda: (totalKills + totalAssists) / Math.max(1, totalDeaths),
    averageKills: list.length ? totalKills / list.length : 0,
    averageDeaths: list.length ? totalDeaths / list.length : 0,
    averageAssists: list.length ? totalAssists / list.length : 0,
    damageConversion: conversionGold > 0 ? conversionDamage / conversionGold * 100 : null,
    damagePerMinute: timedSeconds > 0 ? timedDamage / (timedSeconds / 60) : null,
    averageDamage: damageGames ? totalDamage / damageGames : null,
    averageDamageTaken: damageTakenGames ? totalDamageTaken / damageTakenGames : null,
    averageParticipation: participationGames ? participationTotal / participationGames * 100 : null,
    participationGames
  };
  return { sampleSize: list.length, longestWinStreak, zeroDeaths, uniqueChampions: champions.size, favoritePeriod, maxDamage, bestKda, longestGame, luckyChampion, performance };
}

function homeFunChampionName(championId) {
  const champion = champNumMap?.[String(championId)] || Object.values(allChampions || {}).find(row => +row?.key === +championId);
  return champion?.name || champion?.id || `英雄 #${championId || '?'}`;
}

function buildHomeFunStats(games, summoner) {
  const rows = (games || []).map(game => ({ game, me: findProfileParticipant(game, summoner) })).filter(row => row.me);
  const stats = deriveHomeFunStats(rows);
  if (!stats.sampleSize) return '';
  const lucky = stats.luckyChampion;
  const period = stats.favoritePeriod;
  const performance = stats.performance;
  const longestMinutes = Math.round(stats.longestGame.seconds / 60);
  const oneDecimal = value => Number(value || 0).toFixed(1);
  const cards = [
    ['🔥', '最长连胜', `${stats.longestWinStreak} 连胜`, `近 ${stats.sampleSize} 场中的最长纪录`],
    ['🛡️', '完美生存', `${stats.zeroDeaths} 场`, stats.zeroDeaths ? '整局保持零阵亡' : '近期还没有零阵亡对局'],
    ['⚔️', '输出天花板', fmtNumLocal(stats.maxDamage.value), `${homeFunChampionName(stats.maxDamage.championId)} · 单局英雄伤害`],
    [period?.icon || '🕒', '最常出没', period?.games ? period.label : '时间未知', period?.games ? `${period.games} 场集中在 ${period.from}:00–${period.to}:59` : '战绩未提供开局时间'],
    ['🎭', '近期英雄池', `${stats.uniqueChampions} 位`, `最长一局 ${longestMinutes || '--'} 分钟`],
    ['🍀', '幸运英雄', lucky ? homeFunChampionName(lucky.id) : '样本不足', lucky ? `${lucky.games} 场 ${lucky.wins} 胜 · ${Math.round(lucky.wins / lucky.games * 100)}%` : '同一英雄至少使用 2 场后生成'],
    ['🎯', '近期平均 KDA', performance.averageKda.toFixed(2), `场均 ${oneDecimal(performance.averageKills)} / ${oneDecimal(performance.averageDeaths)} / ${oneDecimal(performance.averageAssists)}`],
    ['💱', '伤害转化率', performance.damageConversion == null ? '--' : `${Math.round(performance.damageConversion)}%`, performance.damageConversion == null ? '战绩未提供金币数据' : '每 100 金币转化的英雄伤害'],
    ['⚡', '每分钟输出', performance.damagePerMinute == null ? '--' : fmtNumLocal(Math.round(performance.damagePerMinute)), '按有效对局时长折算'],
    ['🤝', '平均参团率', performance.averageParticipation == null ? '--' : `${Math.round(performance.averageParticipation)}%`, performance.participationGames ? `${performance.participationGames} 场具备队伍击杀数据` : '战绩未提供队伍击杀数据'],
    ['💥', '场均英雄伤害', performance.averageDamage == null ? '--' : fmtNumLocal(Math.round(performance.averageDamage)), '仅统计对英雄造成的伤害'],
    ['🧱', '场均承受伤害', performance.averageDamageTaken == null ? '--' : fmtNumLocal(Math.round(performance.averageDamageTaken)), '近期对局平均承伤']
  ];
  return `<section class="home-fun"><div class="home-fun-head"><span><b>玩家趣味档案</b><small>基于当前加载的近 ${stats.sampleSize} 场</small></span><em>仅代表近期</em></div>
    <div class="home-fun-grid">${cards.map(([icon, label, value, detail]) => `<div class="home-fun-card"><i>${icon}</i><span><small>${label}</small><b>${escapeHtml(String(value))}</b><em>${escapeHtml(detail)}</em></span></div>`).join('')}</div></section>`;
}
function homeSearchMarkup(placeholderText) {
  return `<div class="home-search">
    <div class="home-search-input-wrap">
      <input id="homeSearchInput" value="${escapeHtml(homeSearchDraft)}" placeholder="${escapeHtml(placeholderText)}" autocomplete="off"
        onfocus="showHomeSearchCards()" onclick="showHomeSearchCards()" oninput="homeSearchDraft=this.value"
        onblur="setTimeout(hideHomeSearchCards,120)" onkeydown="if(event.key==='Enter')homeSearch()">
      ${homeSearchHistory.length ? `<div class="home-search-card-popover" id="homeSearchCardPopover">
        ${homeSearchHistory.map(value => `<div class="home-search-record-card" onmousedown="event.preventDefault();selectHomeSearchHistory(${inlineArg(value)})" title="查询 ${escapeHtml(value)}">
          <span class="home-search-record-icon">⌕</span>
          <span>${escapeHtml(value)}</span>
        </div>`).join('')}
      </div>` : ''}
    </div>
    <button onclick="homeSearch()">查询</button>
    <span class="home-search-msg" id="homeSearchMsg"></span>
  </div>`;
}
function showHomeSearchCards() {
  document.getElementById('homeSearchCardPopover')?.classList.add('show');
}
function hideHomeSearchCards() {
  document.getElementById('homeSearchCardPopover')?.classList.remove('show');
}
function selectHomeSearchHistory(value) {
  const input = document.getElementById('homeSearchInput');
  homeSearchDraft = value;
  if (input) input.value = value;
  hideHomeSearchCards();
  homeSearch();
}
function rememberHomeSearch(value) {
  const normalized = String(value || '').trim().replace(/＃/g, '#');
  if (!normalized) return;
  homeSearchHistory = homeSearchHistory.filter(x => x.toLocaleLowerCase() !== normalized.toLocaleLowerCase());
  homeSearchHistory.unshift(normalized);
  if (homeSearchHistory.length > HOME_SEARCH_HISTORY_LIMIT) homeSearchHistory.length = HOME_SEARCH_HISTORY_LIMIT;
}
function backToMe() {
  profileOverride = null;
  homeStatsLoaded = false;
  switchPage("home");
  // 立即给出反馈, 否则点击后页面停在别人数据上直到重拉完成, 体感"没反应"
  const panel = document.getElementById("playerPanel");
  if (panel) panel.innerHTML = '<div class="meta-loading">正在加载我的战绩...</div>';
  loadHomeStats(true);
}
async function getPlatformId() {
  if (cachedPlatformId) return cachedPlatformId;
  const st = await lolAPI.lcuStatus();
  const direct = String(st?.summoner?.platformId || st?.summoner?.currentPlatformId || '').toUpperCase();
  if (direct) { cachedPlatformId = direct; return cachedPlatformId; }
  // 只取 1 场拿 platformId；国服与 Riot 外服的历史对象都带该字段。
  const hist = await lolAPI.lcuRequest("GET", `/lol-match-history/v1/products/lol/${st.summoner.puuid}/matches?begIndex=0&endIndex=1`);
  const fromHistory = String(hist?.games?.games?.[0]?.platformId || '').toUpperCase();
  if (fromHistory) { cachedPlatformId = fromHistory; return cachedPlatformId; }
  // 新账号没有历史时，从 Riot 客户端区域配置识别。不同版本返回 platformId/region/webRegion 之一。
  const platformCfg = await lolAPI.lcuRequest('GET', '/lol-platform-config/v1/namespaces/PlayerPlatformEdgeService').catch(() => null);
  const regionCfg = await lolAPI.lcuRequest('GET', '/riotclient/region-locale').catch(() => null);
  const raw = String(platformCfg?.platformId || platformCfg?.region || regionCfg?.region || regionCfg?.webRegion || '').toUpperCase();
  const aliases = {
    NA: 'NA1', EUW: 'EUW1', EUNE: 'EUN1', EUN: 'EUN1', BR: 'BR1', LAN: 'LA1', LAS: 'LA2',
    JP: 'JP1', OCE: 'OC1', OC: 'OC1', TR: 'TR1', PH: 'PH2', SG: 'SG2', TH: 'TH2', TW: 'TW2', VN: 'VN2'
  };
  cachedPlatformId = aliases[raw] || (RIOT_PLATFORM_IDS.includes(raw) || SGP_PLATFORM_IDS.includes(raw) ? raw : (raw === 'CN' ? 'HN1' : ''));
  return cachedPlatformId;
}
function getRememberedPlayerPlatform(puuid) {
  try {
    const value = JSON.parse(localStorage.getItem('poro.playerPlatform.' + puuid) || 'null');
    return value && SGP_PLATFORM_IDS.includes(value.platformId) && Date.now() - value.ts < PLAYER_PLATFORM_TTL ? value.platformId : '';
  } catch (e) { return ''; }
}
function rememberPlayerPlatform(puuid, platformId) {
  if (!puuid || !SGP_PLATFORM_IDS.includes(platformId)) return;
  try { localStorage.setItem('poro.playerPlatform.' + puuid, JSON.stringify({ platformId, ts: Date.now() })); } catch (e) {}
}
async function findSgpPlatform(puuid, preferredPlatformId, count = 50, onProgress) {
  const remembered = getRememberedPlayerPlatform(puuid);
  const preferred = SGP_PLATFORM_IDS.includes(preferredPlatformId) ? preferredPlatformId : 'HN1';
  const candidates = [...new Set([remembered, preferred, ...SGP_PLATFORM_IDS].filter(Boolean))];
  let successfulProbes = 0;
  const probeSize = 4;
  for (let start = 0; start < candidates.length; start += probeSize) {
    const group = candidates.slice(start, start + probeSize);
    const results = await mapWithConcurrency(group, probeSize, async platformId => {
      const summoner = await lolAPI.sgpSummonerByPuuid(platformId, puuid).catch(e => ({ __error: e.message }));
      return { platformId, summoner };
    });
    successfulProbes += results.filter(result => !result.summoner?.__error).length;
    if (onProgress) onProgress(Math.min(candidates.length, start + group.length), candidates.length);
    const hit = results.find(result => result.summoner?.puuid === puuid);
    if (hit) {
      const response = await lolAPI.sgpMatchHistory(hit.platformId, puuid, 0, count);
      if (response?.__error) throw new Error(response.__error);
      rememberPlayerPlatform(puuid, hit.platformId);
      const summoner = {
        ...hit.summoner,
        summonerLevel: hit.summoner.summonerLevel || hit.summoner.level || '',
        profileIconId: hit.summoner.profileIconId ?? -1
      };
      return { platformId: hit.platformId, response, summoner, found: true };
    }
  }
  if (!successfulProbes) throw new Error('所有大区召唤师服务暂不可用');
  return { platformId: preferred, response: { games: [] }, summoner: null, found: false };
}
// 统一两种数据格式 (SGP Match-V5 平铺 / LCU 嵌套)
function normalizeGame(g, isSgp) {
  if (isSgp) {
    const teamsObj = {};
    for (const t of (g.teams || [])) {
      teamsObj[t.teamId] = {
        win: t.win === true || t.win === "Win",
        baron: t.objectives?.baron?.kills ?? 0, dragon: t.objectives?.dragon?.kills ?? 0,
        tower: t.objectives?.tower?.kills ?? 0, inhibitor: t.objectives?.inhibitor?.kills ?? 0,
        herald: t.objectives?.riftHerald?.kills ?? 0, horde: t.objectives?.horde?.kills ?? 0
      };
    }
    return {
      gid: g.gameId, mode: modeName(g), queueId: g.queueId, gameType: g.gameType || '', dur: g.gameDuration || 0, time: g.gameCreation,
      teamsObj,
      participants: (g.participants || []).map(p => ({
        puuid: p.puuid || "",
        name: p.riotIdGameName || p.summonerName || p.riotId || p.summonerNameLocal || p.player?.summonerName || p.player?.riotIdGameName || "",
        tagLine: p.riotIdTagline || p.player?.riotIdTagline || "",
        championId: normalizeChampId(p.championId),
        championName: p.championName || '',
        k: p.kills || 0, d: p.deaths || 0, a: p.assists || 0,
        win: p.win === true, teamId: p.teamId,
        dmg: p.totalDamageDealtToChampions || 0,
        dmgTaken: p.totalDamageTaken || 0,
        healing: p.totalHeal || 0,
        allyHeal: p.totalHealsOnTeammates || 0,
        shielding: p.totalDamageShieldedOnTeammates || 0,
        mitigated: p.damageSelfMitigated || 0,
        physDmg: p.physicalDamageDealtToChampions || 0,
        magicDmg: p.magicDamageDealtToChampions || 0,
        trueDmg: p.trueDamageDealtToChampions || 0,
        physTaken: p.physicalDamageTaken || 0,
        magicTaken: p.magicDamageTaken || 0,
        trueTaken: p.trueDamageTaken || 0,
        position: p.teamPosition && p.teamPosition !== 'INVALID' ? p.teamPosition : '',
        gold: p.goldEarned || 0,
        cs: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0),
        level: p.champLevel || 1,
        visionScore: p.visionScore || 0,
        wardsPlaced: p.wardsPlaced || 0,
        wardsKilled: p.wardsKilled || 0,
        perkPrimary: p.perks?.styles?.[0]?.selections?.[0]?.perk || 0,
        perkSub: p.perks?.styles?.[1]?.style || 0,
        spells: [p.spell1Id ?? p.summoner1Id, p.spell2Id ?? p.summoner2Id].filter(Boolean),
        items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6].filter(id => id && id > 0),
        profileIconId: p.profileIcon || p.profileIconId || 0,
        penta: p.pentaKills || 0, fb: !!p.firstBloodKill,
        // 多杀嵌套扣减 (Akari): 高级多杀计数包含低级, 需反向扣除
        multi: (() => {
          const penta = p.pentaKills || 0;
          const quadra = Math.max(0, (p.quadraKills || 0) - penta);
          const triple = Math.max(0, (p.tripleKills || 0) - quadra - penta);
          const dbl = Math.max(0, (p.doubleKills || 0) - triple - quadra - penta);
          return penta ? '五杀' : quadra ? '四杀' : triple ? '三杀' : dbl ? '双杀' : '';
        })()
      }))
    };
  }
  const idents = g.participantIdentities || [];
  return {
    gid: g.gameId, mode: modeName(g), queueId: g.queueId, gameType: g.gameType || '', dur: g.gameDuration || 0, time: g.gameCreation,
    teamsObj: {},
    participants: (g.participants || []).map(p => {
      const ident = idents.find(i => i.participantId === p.participantId);
      return {
        puuid: ident?.player?.puuid || "", name: ident?.player?.gameName || ident?.player?.summonerName || "",
        championId: normalizeChampId(p.championId), championName: p.championName || p.stats?.championName || '', k: p.stats?.kills || 0, d: p.stats?.deaths || 0, a: p.stats?.assists || 0,
        win: p.stats?.win === true || p.stats?.wins === true, teamId: p.teamId,
        dmg: p.stats?.totalDamageDealtToChampions || 0, dmgTaken: p.stats?.totalDamageTaken || 0,
        healing: p.stats?.totalHeal || 0,
        allyHeal: p.stats?.totalHealsOnTeammates || 0,
        shielding: p.stats?.totalDamageShieldedOnTeammates || 0,
        mitigated: p.stats?.damageSelfMitigated || 0,
        physDmg: p.stats?.physicalDamageDealtToChampions || 0,
        magicDmg: p.stats?.magicDamageDealtToChampions || 0,
        trueDmg: p.stats?.trueDamageDealtToChampions || 0,
        position: p.individualPosition && p.individualPosition !== 'INVALID' ? p.individualPosition : '',
        gold: p.stats?.goldEarned || 0,
        cs: (p.stats?.totalMinionsKilled || 0) + (p.stats?.neutralMinionsKilled || 0),
        level: p.stats?.champLevel || 1,
        visionScore: p.stats?.visionScore || 0,
        wardsPlaced: p.stats?.wardsPlaced || 0, wardsKilled: p.stats?.wardsKilled || 0,
        penta: p.stats?.pentaKills || 0, fb: !!p.stats?.firstBloodKill,
        profileIconId: p.stats?.profileIcon || 0,
        spells: [
          p.spell1Id ?? p.stats?.spell1Id ?? p.summoner1Id ?? p.stats?.summoner1Id,
          p.spell2Id ?? p.stats?.spell2Id ?? p.summoner2Id ?? p.stats?.summoner2Id
        ].filter(id => id != null)
      };
    })
  };
}
// puuid→名字解析缓存
const nameCache = {};
const tagCache = {};
function hasBrokenText(value) {
  return /\uFFFD/.test(String(value || ''));
}
async function resolveNames(puuids) {
  const missing = [...new Set(puuids)].filter(p => p && (!nameCache[p] || hasBrokenText(nameCache[p])));
  if (!missing.length) return;
  const batches = missing.slice(0, 20);
  await mapWithConcurrency(batches, 5, async puuid => {
    try {
      const s = await resolveSummonerByPuuid(puuid);
      const resolvedName = s?.gameName || s?.displayName || s?.name || '';
      if (resolvedName && !hasBrokenText(resolvedName)) {
        nameCache[puuid] = resolvedName;
        if (s.tagLine) tagCache[puuid] = s.tagLine;
      }
    } catch (e) {}
  });
}
function getName(p) {
  const sourceName = hasBrokenText(p.name) ? '' : p.name;
  const sourceTag = hasBrokenText(p.tagLine) ? '' : p.tagLine;
  const name = sourceName || nameCache[p.puuid] || '未知';
  const tag = sourceTag || tagCache[p.puuid] || '';
  if (tag) return name + '#' + tag;
  return name;
}
function findProfileParticipant(game, summoner) {
  if (!game || !summoner || !Array.isArray(game.participants)) return null;
  const byPuuid = game.participants.find(p => p.puuid && p.puuid === summoner.puuid);
  if (byPuuid) return byPuuid;
  // 极少数旧 LCU 记录没有 PUUID；仅允许完整 Riot ID 精确匹配，绝不退回数组第一人。
  const wantedName = String(summoner.gameName || summoner.displayName || summoner.name || '').trim().toLocaleLowerCase();
  const wantedTag = String(summoner.tagLine || '').trim().toLocaleLowerCase();
  if (!wantedName) return null;
  return game.participants.find(p => {
    const nameMatches = String(p.name || '').trim().toLocaleLowerCase() === wantedName;
    const tagMatches = !wantedTag || String(p.tagLine || '').trim().toLocaleLowerCase() === wantedTag;
    return nameMatches && tagMatches;
  }) || null;
}
// puuid→段位缓存 (战绩详情用)
const rankCache = {};
const TIER_ICON = { IRON: '🪨', BRONZE: '🥉', SILVER: '🥈', GOLD: '🥇', PLATINUM: '🟢', EMERALD: '🟩', DIAMOND: '🔷', MASTER: '🟪', GRANDMASTER: '🔴', CHALLENGER: '👑' };
async function resolveRanks(puuids) {
  const missing = puuids.filter(p => p && !(p in rankCache));
  if (!missing.length) return;
  await mapWithConcurrency(missing.slice(0, 10), 4, async puuid => {
    try {
      const r = await lolAPI.lcuRequest("GET", `/lol-ranked/v1/ranked-stats/${encodeURIComponent(puuid)}`);
      rankCache[puuid] = r?.queueMap || {};
    } catch (e) { rankCache[puuid] = {}; }
  });
}
function hasRankedQueueData(value) {
  return !!(value && value.queueMap && Object.values(value.queueMap).some(queue => queue && (queue.tier || queue.wins || queue.losses)));
}
async function loadRankedStats(puuid, samePlatform) {
  const paths = samePlatform
    ? [`/lol-ranked/v1/ranked-stats/${encodeURIComponent(puuid)}`, `/lol-ranked/v1/cached-ranked-stats/${encodeURIComponent(puuid)}`]
    : [`/lol-ranked/v1/cached-ranked-stats/${encodeURIComponent(puuid)}`];
  for (const path of paths) {
    try {
      const value = await lolAPI.lcuRequest('GET', path);
      if (!value?.__error && hasRankedQueueData(value)) return value;
    } catch (e) {}
  }
  return null;
}
function rankLineOf(p) {
  const qm = rankCache[p.puuid];
  if (!qm) return '';
  const q = qm.RANKED_SOLO_5x5 || qm.RANKED_FLEX_SR;
  if (!q || !q.tier) return '';
  const icon = TIER_ICON[q.tier] || '';
  const div = q.division && !['NA', ''].includes(q.division) ? ' ' + q.division : '';
  const lp = q.leaguePoints != null ? ` ${q.leaguePoints}` : '';
  return `<div class="ogd-rank">${icon} ${rankTierCN(q.tier)}${div}${lp}</div>`;
}

// 首页对局卡片 (模式筛选重渲染共用)
function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const d = Math.floor(diff / 86400000);
  if (d > 3) return new Date(ts).toLocaleDateString();
  if (d >= 1) return d + '天前';
  const h = Math.floor(diff / 3600000);
  if (h >= 1) return h + '小时前';
  return Math.max(1, Math.floor(diff / 60000)) + '分钟前';
}
function buildPerformanceTags(p, myTeam, kp, dmgShare, minutes, mode) {
  return derivePerformanceTags(p, myTeam, kp, dmgShare, minutes, mode)
    .map(tag => `<span class="ako-tag ako-insight ako-insight-${tag.tone}" title="${escapeHtml(tag.tip)}">${tag.label}</span>`).join('');
}
function buildHomeGameCard(g, s) {
  const p = findProfileParticipant(g, s);
  if (!p) return '';
  const c = champNumMap[String(p.championId)];
  const kda = ((p.k + p.a) / Math.max(1, p.d)).toFixed(2);
  const teams = {};
  for (const x of g.participants) (teams[x.teamId] = teams[x.teamId] || []).push(x);
  const myTeam = teams[p.teamId] || [];
  const teamK = myTeam.reduce((sum, x) => sum + x.k, 0);
  const teamDmg = myTeam.reduce((sum, x) => sum + (x.dmg || 0), 0);
  const kp = teamK ? Math.round((p.k + p.a) / teamK * 100) : 0;
  const dmgShare = teamDmg ? Math.round((p.dmg || 0) / teamDmg * 100) : 0;
  // 承伤占比: 全队承伤分摊; 伤害转化率: 对英雄伤害 / 金币 (每金币打出的伤害)
  const teamTaken = myTeam.reduce((sum, x) => sum + (x.dmgTaken || 0), 0);
  const takenShare = teamTaken ? Math.round((p.dmgTaken || 0) / teamTaken * 100) : 0;
  const goldRate = p.gold ? Math.round((p.dmg || 0) / p.gold * 100) : 0;
  const mins = g.dur > 0 ? g.dur / 60 : 1;
  const csMin = ((p.cs || 0) / mins).toFixed(1);
  const spellName = id => spellMap[String(id)] || String(id);
  const itemIcon = id => id ? `https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${id}.png` : '';
  const spellHtml = (p.spells || []).map(id => `<img class="ako-spell" src="https://ddragon.leagueoflegends.com/cdn/${version}/img/spell/${(spellName(id) || "").replace(/\.png$/, "")}.png" onerror="this.style.visibility='hidden'">`).join('');
  const runeIcon = (map, id) => id && map[id] ? `https://ddragon.leagueoflegends.com/cdn/img/${map[id]}` : null;
  const rk1 = runeIcon(perkIconMap, p.perkPrimary), rk2 = runeIcon(styleIconMap, p.perkSub);
  const runeHtml = (rk1 || rk2) ? `<div class="ako-runecol">${rk1 ? `<img class="ako-rune" src="${rk1}" onerror="this.style.visibility='hidden'">` : ''}${rk2 ? `<img class="ako-rune" src="${rk2}" onerror="this.style.visibility='hidden'">` : ''}</div>` : '';
  const itemHtml = (p.items || []).slice(0, 6).map(id => `<img class="ako-item" src="${itemIcon(id)}" onerror="this.style.visibility='hidden'">`).join('')
    + (p.items && p.items[6] ? `<img class="ako-item ako-trinket" src="${itemIcon(p.items[6])}" onerror="this.style.visibility='hidden'">` : '');
  const posText = POS_MAP[p.position] || '';
  const rosterCol = tid => (teams[tid] || []).slice(0, 5).map(x => {
    const xc = champNumMap[String(x.championId)];
    return `<div class="ako-player${x.puuid === s.puuid ? ' ako-me' : ''}" onclick="event.stopPropagation();searchPlayerByPuuid(${inlineArg(x.puuid)}, ${inlineArg(getName(x))})">
      <img src="${xc ? champImg(xc.id) : placeholder('?')}"><span>${escapeHtml(getName(x).split('#')[0])}</span>
    </div>`;
  }).join('');
  const tids = Object.keys(teams);
  const cardRating = x => x.k + x.a * 0.7 - x.d * 0.5 + (x.dmg || 0) / 4000 + (x.gold || 0) / 6000;
  let cardBadge = '';
  for (const tid of tids) {
    const tlist = teams[tid] || [];
    const twon = tlist.some(x => x.win);
    const best = tlist.slice().sort((a, b) => cardRating(b) - cardRating(a))[0];
    if (best && best.puuid === p.puuid) {
      cardBadge = twon ? '<span class="ako-tag ako-mvptag">MVP</span>' : '<span class="ako-tag ako-acetag">ACE</span>';
      break;
    }
  }
  const performanceTags = buildPerformanceTags(p, myTeam, kp, dmgShare, mins, g.mode);
  return `<div class="ako-card ${p.win ? 'ako-win' : 'ako-loss'}" onclick="expandOpggGame(this, '${g.gid}')" data-gid="${g.gid}" data-platform="${escapeHtml(g.platformId || '')}">
        <div class="ako-main">
          <div class="ako-top">
            <div class="ako-champwrap">
              <img class="ako-champ" src="${c ? champImg(c.id) : placeholder('?')}" onerror="this.src='${placeholder('?')}'">
              ${posText ? `<span class="ako-pos">${posText}</span>` : ''}
            </div>
            ${spellHtml ? `<div class="ako-spellcol">${spellHtml}</div>` : ''}
            ${runeHtml}
            <div class="ako-stat">
              <div class="ako-big">${p.k} <i>/</i> <b>${p.d}</b> <i>/</i> ${p.a}</div>
              <div class="ako-sub">${p.d === 0 && (p.k > 0 || p.a > 0) ? '完美' : kda} (${kp}%)</div>
            </div>
            <div class="ako-stat">
              <div class="ako-big">${dmgShare}%</div>
              <div class="ako-sub">${fmtNumLocal(p.dmg)} 伤害</div>
            </div>
            <div class="ako-stat ako-stat-sm">
              <div class="ako-big">${takenShare}%</div>
              <div class="ako-sub">${fmtNumLocal(p.dmgTaken)} 承伤</div>
            </div>
            <div class="ako-stat ako-stat-sm">
              <div class="ako-big">${goldRate}%</div>
              <div class="ako-sub">伤害转化</div>
            </div>
            <div class="ako-stat ako-csblk">
              <div class="ako-big">${p.cs || 0} <em>CS</em></div>
              <div class="ako-sub">${csMin} CS/分钟</div>
            </div>
          </div>
          <div class="ako-mid">
            <span class="ako-result">${p.win ? '胜利' : '失败'}</span>
            <div class="ako-itemrow">${itemHtml}</div>
            ${p.multi ? `<span class="ako-tag">${p.multi}</span>` : ''}
            ${p.fb ? '<span class="ako-tag ako-fbtag">一血</span>' : ''}
            ${cardBadge}
            ${performanceTags}
          </div>
          <div class="ako-info">${escapeHtml(g.mode)} · ${fmtTime(g.dur)} · ${timeAgo(g.time)}</div>
        </div>
        <div class="ako-rosters">
          <div class="ako-teamcol">${rosterCol(tids[0])}</div>
          ${tids[1] ? `<div class="ako-teamcol">${rosterCol(tids[1])}</div>` : ''}
        </div>
        <div class="ako-expand">‹</div>
        <div class="og-game-detail" style="display:none"></div>
      </div>`;
}

// 首页战绩模式筛选
let homeGamesData = null;
let homeGamesOwner = null;
let homeModeFilter = 'all';
let homeChampCount = {};
let homeChampMeta = {};
const HOME_GAME_PAGE_SIZE = 20;
let homeGameVisible = HOME_GAME_PAGE_SIZE;
let homeGameRemoteState = null;
function resolveHomeChampion(cid, meta) {
  const mapped = champNumMap?.[String(cid)];
  if (mapped) return mapped;
  const suppliedName = String(meta?.name || '').trim();
  if (suppliedName) {
    const suppliedLower = suppliedName.toLocaleLowerCase();
    for (const [id, c] of Object.entries(allChampions || {})) {
      if (String(c.name || '').toLocaleLowerCase() === suppliedLower || id.toLocaleLowerCase() === suppliedLower) {
        return { id, name: c.name };
      }
    }
  }
  return { id: '', name: suppliedName || `英雄 #${cid}` };
}
function buildHomeChampionRows(counts, metadata) {
  const ids = Object.keys(counts || {}).filter(cid => Number.isFinite(Number(cid)) && Number(cid) > 0)
    .sort((a, b) => counts[b] - counts[a]).slice(0, 8);
  if (!ids.length) return '<div class="home-champ-empty">近期对局暂无可统计英雄</div>';
  return ids.map((cid, idx) => {
    const c = resolveHomeChampion(cid, metadata?.[cid]);
    const action = c.id ? ` onclick="showChampionDetail(${inlineArg(c.id)})"` : '';
    const icon = c.id ? champImg(c.id) : placeholder(c.name);
    return `<div class="home-champ-row${c.id ? '' : ' no-detail'}"${action}>
      <div class="home-champ-row-rank">${idx + 1}</div>
      <img src="${icon}" onerror="this.src='${placeholder(c.name)}'">
      <div class="home-champ-row-name">${escapeHtml(c.name)}</div>
      <div class="home-champ-row-count">${counts[cid]}场</div>
    </div>`;
  }).join('');
}
function refreshHomeChampionRows() {
  const grid = document.getElementById('homeChampGrid');
  if (grid) grid.innerHTML = buildHomeChampionRows(homeChampCount, homeChampMeta);
}
function renderHomeModeFilter() {
  const el = document.getElementById('homeModeFilter');
  if (!el || !homeGamesData) return;
  const counts = {};
  for (const g of homeGamesData) counts[g.mode] = (counts[g.mode] || 0) + 1;
  const modes = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (modes.length <= 1) { el.innerHTML = ''; return; }
  if (!counts[homeModeFilter] && homeModeFilter !== 'all') homeModeFilter = 'all';
  // 下拉框替代 chips: 所有模式都可选, 省空间且没有内联多按钮的触发问题
  const opt = (key, label, n) => `<option value="${key}"${homeModeFilter === key ? ' selected' : ''}>${label} (${n})</option>`;
  el.innerHTML = `<select class="mode-select" onchange="filterHomeGames(this.value)">`
    + opt('all', '全部模式', homeGamesData.length)
    + modes.map(m => opt(m, m, counts[m])).join('')
    + `</select>`;
}
function renderHomeGameList() {
  const el = document.getElementById('homeGamesList');
  if (!el || !homeGamesData) return;
  const list = homeModeFilter === 'all' ? homeGamesData : homeGamesData.filter(g => g.mode === homeModeFilter);
  if (!list.length) { el.innerHTML = '<div class="meta-loading">该模式下暂无对局</div>'; return; }
  const visible = list.slice(0, homeGameVisible);
  const canLoadRemote = !!(homeGameRemoteState && !homeGameRemoteState.exhausted && homeGamesData.length < 100);
  const canLoadMore = list.length > visible.length || canLoadRemote;
  const totalHint = canLoadRemote ? 100 : list.length;
  const more = canLoadMore
    ? `<button class="btn-secondary" style="width:100%;margin:8px 0;" onclick="loadMoreHomeGames()" ${homeGameRemoteState?.loading ? 'disabled' : ''}>${homeGameRemoteState?.loading ? '正在加载更多战绩...' : `继续加载 (${visible.length}/${totalHint})`}</button>`
    : '';
  el.innerHTML = visible.map(g => buildHomeGameCard(g, { puuid: homeGamesOwner })).join('') + more;
}
async function loadMoreHomeGames() {
  const desired = homeGameVisible + HOME_GAME_PAGE_SIZE;
  const filtered = () => homeModeFilter === 'all' ? homeGamesData : homeGamesData.filter(g => g.mode === homeModeFilter);
  const state = homeGameRemoteState;
  if (filtered().length < desired && state && !state.exhausted && !state.loading) {
    state.loading = true;
    state.error = '';
    renderHomeGameList();
    try {
      while (filtered().length < desired && homeGamesData.length < 100 && !state.exhausted) {
        let incoming = [];
        if (state.buffered.length) {
          incoming = state.buffered.splice(0);
          if (state.source === 'LCU') state.exhausted = true;
        } else {
          if (state.nextIndex >= state.maxFetch) { state.exhausted = true; break; }
          const resp = await lolAPI.sgpMatchHistory(state.platformId, state.puuid, state.nextIndex, state.batch);
          if (homeGameRemoteState !== state || homeGamesOwner !== state.puuid) return;
          if (!resp || resp.__error) throw new Error(resp?.__error || '战绩服务暂不可用');
          const raw = (resp.games || []).map(g => g.json || g);
          collectHexAugments(raw);
          state.nextIndex += raw.length;
          if (raw.length < state.batch) state.exhausted = true;
          incoming = raw.map(g => ({ ...normalizeGame(g, true), platformId: state.platformId }));
          if (!state.includePractice) incoming = incoming.filter(g => !isExcludedGame(g));
        }
        const known = new Set(homeGamesData.map(g => String(g.gid)));
        incoming = incoming.filter(g => g && !known.has(String(g.gid)) && !!findProfileParticipant(g, { puuid: state.puuid }));
        const room = 100 - homeGamesData.length;
        homeGamesData.push(...incoming.slice(0, room));
        if (!incoming.length && state.exhausted) break;
      }
      if (homeGamesData.length >= 100) state.exhausted = true;
      // 把已追加页写回当前档案缓存，返回该玩家或重启后不必重复下载。
      try {
        const cached = JSON.parse(localStorage.getItem(state.cacheKey) || 'null');
        if (cached && cached.s?.puuid === state.puuid) {
          cached.ts = Date.now();
          cached.games = homeGamesData;
          cached.rawGameCount = Math.max(cached.rawGameCount || 0, state.nextIndex);
          localStorage.setItem(state.cacheKey, JSON.stringify(cached));
        }
      } catch (e) {}
    } catch (e) {
      state.error = e.message || '加载失败';
    } finally {
      if (homeGameRemoteState === state) state.loading = false;
    }
  }
  homeGameVisible = Math.min(desired, filtered().length);
  renderHomeModeFilter();
  renderHomeGameList();
}
function filterHomeGames(mode) {
  homeModeFilter = mode;
  homeGameVisible = HOME_GAME_PAGE_SIZE;
  renderHomeModeFilter();
  renderHomeGameList();
}

function renderEmptyPlayerHome(panel, s, isSelf, server, ranked, message) {
  const displayName = (s.gameName || s.displayName || s.name || '未知玩家') + (s.tagLine ? '#' + s.tagLine : '');
  const icon = s.profileIconId >= 0 ? profileIcon(s.profileIconId) : placeholder((s.gameName || '?')[0]);
  const rankHtml = renderRankCards(ranked?.queueMap || {});
  panel.innerHTML = `
    <div class="home-layout">
      ${homeSearchMarkup('输入 名字#Tag 查询其他召唤师战绩')}
      <div class="home-header">
        <div class="home-avatar"><img src="${icon}" onerror="this.src='${placeholder('?')}'"></div>
        <div class="home-info">
          <div class="home-name">${escapeHtml(displayName)}</div>
          <div class="home-server">大区: ${escapeHtml(server || '待识别')} · 等级 ${escapeHtml(s.summonerLevel || '-')}</div>
        </div>
        <div class="home-winrate">${!isSelf ? '<button class="back-to-me" onclick="backToMe()">⟲ 回到我的</button>' : ''}</div>
      </div>
      ${rankHtml ? `<div class="home-ranks">${rankHtml}</div>` : ''}
      <div class="home-games">
        <div class="rk-summary-bar"><span>玩家档案</span><span>暂无可统计对局</span></div>
        <div class="meta-loading">${escapeHtml(message || '该账号暂无公开的近期对局，基础档案已显示。')}</div>
      </div>
    </div>`;
  restoreHomeScroll(s?.puuid);
}
// 训练/自定义对局是否计入统计 (开关持久化, 重载首页)
function toggleIncludePractice(on) {
  storeSet('includePractice', on ? '1' : '');
  homeStatsLoaded = false;
  loadHomeStats(true);
}
function homeSelfCachePath(includePractice) {
  return (window._userDataPath || '') + `/home-cache-${includePractice ? 1 : 0}.json`;
}
async function readHomeSelfCache(includePractice) {
  if (!window._userDataPath || !lolAPI.readFile) return null;
  try {
    const content = await lolAPI.readFile(homeSelfCachePath(includePractice));
    return content ? JSON.parse(content) : null;
  } catch (e) { return null; }
}
async function writeHomeSelfCache(includePractice, payload) {
  if (!window._userDataPath || !lolAPI.writeFile || !payload) return false;
  try { return await lolAPI.writeFile(homeSelfCachePath(includePractice), JSON.stringify(payload)); }
  catch (e) { return false; }
}

async function loadHomeStats(force, opts) {
  const loadStartedAt = performance.now();
  let loadPath = 'network';
  const skipCache = !!(opts && opts.skipCache);   // true=跳过持久缓存强制走网络(后台刷新用)
  if (homeStatsLoaded && !force) return;
  if (homeStatsLoading && !force) return;   // 并发保护: 只有用户主动的 force 请求能打断进行中的加载
  const myToken = ++homeStatsToken;          // 请求代际: 被更新的请求取代后立即放弃渲染
  const stale = () => myToken !== homeStatsToken;
  homeStatsLoading = true;
  const panel = document.getElementById("playerPanel");
  if (!panel) { homeStatsLoading = false; return; }
  if (!homeScrollSnapshot && panel.querySelector('.home-layout') && (homeScrollContainer()?.scrollTop || 0) > 0) {
    preserveHomeScroll(profileOverride?.puuid || cachedSummoner?.puuid || '');
  }
  try {
    // ---- 持久缓存快速路径: 自己的首页 + 有缓存 → 不等客户端连接, 先秒出上次数据 ----
    const includePractice = storeGet('includePractice') === '1';
    const selfPuuidSaved = localStorage.getItem('poro.selfPuuid') || '';
    const targetPuuid = profileOverride?.puuid || selfPuuidSaved;
    let cached = null;
    // 强制网络刷新也保留一份只读兜底。它不参与正常请求，只用于阻止瞬时空响应
    // 把已经展示的有效首页覆盖成“未知玩家 / 暂无对局”。
    const durableSelfCache = !profileOverride ? await readHomeSelfCache(includePractice) : null;
    // 自己的首页优先读独立文件缓存：不受 localStorage 容量、压缩和进程退出时机影响。
    if (!profileOverride && !skipCache) cached = durableSelfCache;
    if (!cached && targetPuuid && !skipCache) {
      try { cached = JSON.parse(localStorage.getItem('poro.homeCache.' + targetPuuid + '.' + (includePractice ? 1 : 0)) || 'null'); } catch (e) {}
    }
    let cacheUsable = !!(cached && Array.isArray(cached.games) && cached.s && cached.s.puuid);
    let cacheFresh = cacheUsable && (Date.now() - cached.ts < 3 * 60 * 1000);
    // 旧版可能把“当前区查不到”的空数组缓存为有效跨区结果；空的他人缓存必须重新自动定位大区。
    if (profileOverride && cacheUsable && cached.games.length === 0) { cacheUsable = false; cacheFresh = false; }

    let st = null, selfSummoner = null;
    if (profileOverride && cachedSummoner) {
      selfSummoner = cachedSummoner;
    } else if (cacheUsable && !profileOverride) {
      selfSummoner = cached.s;               // 上次会话的自己, 充当 summoner; 客户端没开也能先出数据
    } else {
      st = await lolAPI.lcuStatus();
      if (stale()) return;                   // 已有更新的请求, 本次作废
      if (!st.connected || !st.summoner || !st.summoner.puuid) {
        // 后台刷新失败 (客户端未就绪): 页面上是有效的缓存内容, 不能标记失效也不能覆盖成提示;
        // 挂起补刷标记, 等 pollLoop 检测到 LCU 就绪后自动重试
        if (skipCache) { homeStatsLoaded = true; window._homeCacheNeedRefresh = true; return; }
        panel.innerHTML = st.connected
          ? '<div class="meta-loading">客户端已连接，正在同步玩家档案...</div>'
          : '<div class="meta-loading">连接客户端后显示玩家数据统计</div>';
        // 注意: 这里不要重置 homeStatsLoaded —— 单次瞬时超时就失效会导致首页反复重载而闪烁,
        // 断开判定交给 pollLoop 的"连续两次失败"逻辑处理
        return;
      }
      selfSummoner = st.summoner;
    }
    homeStatsLoaded = true;
    cachedSummonerName = (selfSummoner.gameName || selfSummoner.displayName || selfSummoner.name || '') + (selfSummoner.tagLine ? '#' + selfSummoner.tagLine : '');
    cachedSummoner = selfSummoner;
    window._myPuuid = selfSummoner.puuid;
    window.poroSession?.setAccount(selfSummoner.puuid, cachedPlatformId || '');
    if (st && st.summoner && !profileOverride) { try { localStorage.setItem('poro.selfPuuid', selfSummoner.puuid); } catch (e) {} }
    // 查看其他玩家: profileOverride 指定 puuid
    const cacheKey = 'poro.homeCache.' + ((profileOverride && profileOverride.puuid) || selfSummoner.puuid) + '.' + (includePractice ? 1 : 0);

    let s = selfSummoner, isSelf = true;
    let games, ranked = null, rawGameCount = 0, dataSource = "SGP", dataError = '', profileOverflow = [];
    let targetPlatformId = cached?.platformId || cachedPlatformId || '';
    let targetPlatformFound = !!cached?.platformId;

    if (cacheUsable && !skipCache) {
      loadPath = 'cache';
      // 缓存命中: 不发任何战绩请求, 启动/回看秒出 (与 Seraphine 同策略)
      s = cached.s; isSelf = !!cached.isSelf;
      // 查询档案接口返回的信息比旧缓存可靠，覆盖曾误存的“对局内等级”等占位值。
      if (profileOverride?.summoner?.puuid === s.puuid) s = mergeSummonerProfile(s, profileOverride.summoner);
      games = cached.games; ranked = cached.ranked || null;
      rawGameCount = cached.rawGameCount || cached.games.length;
      dataSource = cached.dataSource || 'SGP';
      targetPlatformId = cached.platformId || cachedPlatformId || '';
    } else {
      if (profileOverride && profileOverride.puuid && profileOverride.puuid !== selfSummoner.puuid) {
        isSelf = false;
        if (profileOverride.summoner?.puuid) {
          s = { ...profileOverride.summoner };
          if (!s.tagLine && profileOverride.name?.includes('#')) s.tagLine = profileOverride.name.split('#')[1];
        } else {
          const full = profileOverride.name || '';
          s = { puuid: profileOverride.puuid, gameName: full.split('#')[0], tagLine: full.includes('#') ? full.split('#')[1] : '', profileIconId: -1, summonerLevel: '' };
        }
      }
      // SGP 战绩分页拉取: 排除训练/自定义时自动翻页, 直到攒够 100 场有效对局 (上限 500 场原始数据)
      let rankedPromise = Promise.resolve(null);
      // 他人查询优先速度：首批 50 场中统计最近 30 场；自己的首页保留 100 场深度统计。
      const isProfileQuery = !!profileOverride;
      const TARGET = isProfileQuery ? 30 : 100;
      const BATCH = isProfileQuery ? 50 : 100;
      const MAX_FETCH = isProfileQuery ? 150 : 500;
      try {
        const selfPlatformId = await getPlatformId();
        if (stale()) return;
        if (!isTencentPlatform(selfPlatformId)) {
          // Riot 外服：名字解析本身由当前 LCU 完成，因此目标必定属于当前登录平台。
          // 直接使用客户端战绩接口，不探测国服 SGP，也不需要 Riot Developer Key。
          targetPlatformId = selfPlatformId;
          targetPlatformFound = true;
          dataSource = 'LCU';
          rankedPromise = loadRankedStats(s.puuid, true);
          const hist = await lolAPI.lcuRequest('GET', `/lol-match-history/v1/products/lol/${encodeURIComponent(s.puuid)}/matches?begIndex=0&endIndex=${MAX_FETCH}`);
          if (stale()) return;
          if (!hist || hist.__error) throw new Error(hist?.__error || '外服客户端未返回战绩');
          const raw = hist?.games?.games || [];
          rawGameCount = raw.length;
          const rawNorm = raw.map(g => ({ ...normalizeGame(g, false), platformId: targetPlatformId }));
          const eligibleGames = includePractice ? rawNorm : rawNorm.filter(g => !isExcludedGame(g));
          // LCU 是本机接口，一次取回后直接准备到 100 场；首屏仍按现有分页数量渲染。
          // 这样查询同服玩家时“继续加载”不会在 30 场处提前结束。
          const foreignTarget = 100;
          games = eligibleGames.slice(0, isProfileQuery ? TARGET : foreignTarget);
          if (isProfileQuery) profileOverflow = eligibleGames.slice(TARGET, foreignTarget);
        } else {
          let allRaw = [];
          // 第 1 页先行 (同时拿到平台校验), 第 2 页与第 1 页并行: 大多数账号 2 页内凑满 100 场有效
          let r1;
          if (isProfileQuery) {
            const located = await findSgpPlatform(s.puuid, selfPlatformId, BATCH, (done, total) => {
              if (!stale() && panel) panel.innerHTML = `<div class="meta-loading">当前大区暂无记录，正在自动查找其他大区 (${done}/${total})...</div>`;
            });
            if (stale()) return;
            targetPlatformId = located.platformId;
            targetPlatformFound = located.found;
            if (located.summoner) s = mergeSummonerProfile(s, located.summoner);
            r1 = located.response;
          } else {
            targetPlatformId = selfPlatformId;
            targetPlatformFound = true;
            r1 = await lolAPI.sgpMatchHistory(targetPlatformId, s.puuid, 0, BATCH);
          }
          // 必须先知道目标所属平台再查段位。跨区只读取客户端的跨区缓存，绝不能拿
          // 当前登录大区的 ranked-stats 冒充目标玩家数据。
          rankedPromise = loadRankedStats(s.puuid, isSelf || targetPlatformId === selfPlatformId);
          const needSecond = !isProfileQuery && !includePractice;   // 自己的百场统计预取第 2 页；ID 查询只发首批
          const p2 = needSecond ? lolAPI.sgpMatchHistory(targetPlatformId, s.puuid, BATCH, BATCH).catch(() => null) : null;
          if (stale()) return;
          if (r1.__error) throw new Error(r1.__error);
          const batch1 = (r1.games || []).map(g => g.json || g);
          collectHexAugments(batch1);
          allRaw = allRaw.concat(batch1);
          let r2 = p2 ? await p2 : null;
          if (stale()) return;
          if (r2 && !r2.__error) {
            const batch2 = (r2.games || []).map(g => g.json || g);
            collectHexAugments(batch2);
            allRaw = allRaw.concat(batch2);
          }
          // 仍不足才继续串行翻页 (极少触发)
          for (let start = allRaw.length; start < MAX_FETCH && (includePractice ? allRaw.length < TARGET : allRaw.filter(g => !isExcludedGame(g)).length < TARGET); start += BATCH) {
            const resp = await lolAPI.sgpMatchHistory(targetPlatformId, s.puuid, start, BATCH);
            if (stale()) return;
            if (resp.__error) break;
            const batch = (resp.games || []).map(g => g.json || g);
            collectHexAugments(batch);
            allRaw = allRaw.concat(batch);
            if (batch.length < BATCH) break; // 没有更多历史
          }
          rawGameCount = allRaw.length;
          const rawNorm = allRaw.map(g => ({ ...normalizeGame(g, true), platformId: targetPlatformId }));
          const eligibleGames = includePractice ? rawNorm : rawNorm.filter(g => !isExcludedGame(g));
          games = eligibleGames.slice(0, TARGET);
          if (isProfileQuery) profileOverflow = eligibleGames.slice(TARGET);
        }
      } catch (e) {
        console.error("SGP 失败, 回退 LCU:", e.message);
        dataError = e.message || '';
        dataSource = "LCU";
        const hist = await lolAPI.lcuRequest("GET", `/lol-match-history/v1/products/lol/${s.puuid}/matches?begIndex=0&endIndex=100`);
        if (stale()) return;
        const rawNorm = (hist?.games?.games || []).map(g => normalizeGame(g, false));
        rawGameCount = rawNorm.length;
        games = includePractice ? rawNorm : rawNorm.filter(g => !isExcludedGame(g));
      }
      // 排位数据不阻塞渲染: 与战绩并行, 超时兜底后先渲染, 段位卡后补
      // 段位不是首屏必需信息：短暂等待后先展示战绩，迟到的数据由下方回调局部补齐。
      // 查询他人时更偏向响应速度；自己的首页稍多等一点以提高首屏段位命中率。
      const rankWaitMs = isProfileQuery ? 400 : 1200;
      ranked = await Promise.race([rankedPromise, new Promise(r => setTimeout(() => r(null), rankWaitMs))]).catch(() => null);
      if (stale()) return;
      // 先验证网络结果再落盘。SGP/LCU 在客户端刚完成登录时可能短暂返回空历史；
      // 若本机已有同一账号的有效缓存，这属于刷新失败，不是“0 场战绩”。
      games = (games || []).filter(g => !!findProfileParticipant(g, s));
      const fallbackIsSamePlayer = !!(durableSelfCache?.s?.puuid && s?.puuid && durableSelfCache.s.puuid === s.puuid);
      const fallbackHasGames = fallbackIsSamePlayer && Array.isArray(durableSelfCache.games) && durableSelfCache.games.length > 0;
      if (isSelf && games.length === 0 && fallbackHasGames) {
        window._homeCacheNeedRefresh = true;
        try { lolAPI.debugLog(`[HOME] transient empty refresh ignored puuid=${s.puuid} error=${dataError || 'empty-history'}`); } catch (e) {}
        return;
      }
      // 写持久缓存；自己的首页额外写独立文件，保证下一次启动稳定秒开。
      const cachePayload = { ts: Date.now(), s, isSelf, games, ranked, rawGameCount, dataSource, platformId: targetPlatformFound || isSelf ? targetPlatformId : '' };
      try { localStorage.setItem(cacheKey, JSON.stringify(cachePayload)); } catch (e) {}
      if (isSelf) await writeHomeSelfCache(includePractice, cachePayload);
      if (!profileOverride && s && s.puuid) { try { localStorage.setItem('poro.selfPuuid', s.puuid); } catch (e) {} }
      // 排位数据晚到: 后台等它完成后刷新段位相关区块 (不阻塞主渲染)
      if (!ranked) {
        rankedPromise.then(rv => {
          if (stale() || !rv || !rv.queueMap) return;
          ranked = rv;
          const updatedPayload = { ts: Date.now(), s, isSelf, games, ranked, rawGameCount, dataSource, platformId: targetPlatformFound || isSelf ? targetPlatformId : '' };
          try { localStorage.setItem(cacheKey, JSON.stringify(updatedPayload)); } catch (e) {}
          if (isSelf) writeHomeSelfCache(includePractice, updatedPayload).catch(() => {});
          // 局部刷新段位卡片与 MMR 芯片 (避免整页重渲染打断用户)
          const qm2 = rv.queueMap || {};
          const rkHtml = renderRankCards(qm2);
          const ranksEl = document.querySelector('.home-ranks');
          if (ranksEl && rkHtml) ranksEl.innerHTML = rkHtml;
        }).catch(() => {});
      }
    }
    if (stale()) return;
    // 只统计确实包含目标玩家的对局；匹配不到时不能拿第一名参赛者冒充目标。
    games = (games || []).filter(g => !!findProfileParticipant(g, s));
    for (const game of games) if (!game.platformId && targetPlatformId) game.platformId = targetPlatformId;
    const server = SERVER_NAMES[targetPlatformId] || targetPlatformId || "";
    if (!games.length) {
      renderEmptyPlayerHome(
        panel,
        s,
        isSelf,
        isSelf || targetPlatformFound ? server : '',
        ranked,
        dataError ? '战绩服务暂未返回数据，基础档案已显示；稍后可重新查询。' : '该账号暂无公开的近期对局，基础档案已显示。'
      );
      try { lolAPI.debugLog(`[PERF] home path=${loadPath} target=${profileOverride ? 'profile' : 'self'} games=0 render=${Math.round(performance.now() - loadStartedAt)}ms`); } catch (e) {}
      return;
    }
    ensureChampMap();
    // 旧缓存可能缺头像；历史对局可补头像，但英雄等级绝不能作为账号等级。
    if (isSelf === false && (!s.profileIconId || s.profileIconId <= 0)) {
      for (const g of games) {
        const me = findProfileParticipant(g, s);
        if (!me) continue;
        if (me.profileIconId > 0 && (!s.profileIconId || s.profileIconId <= 0)) s.profileIconId = me.profileIconId;
        if (s.profileIconId > 0) break;
      }
    }

    let totK = 0, totD = 0, totA = 0, totDur = 0, penta = 0, fb = 0, maxK = 0, wins = 0, maxD = 0;
    const champCount = {}, champMeta = {}, friendCount = {}, modeStats = {}, trend = [];
    for (const g of games) {
      const me = findProfileParticipant(g, s);
      totK += me.k; totD += me.d; totA += me.a; totDur += g.dur;
      if (me.win) wins++;
      penta += me.penta; fb += me.fb ? 1 : 0;
      if (me.k > maxK) maxK = me.k;
      if (me.d > maxD) maxD = me.d;
      trend.push({ win: me.win, k: me.k, d: me.d, a: me.a, champ: me.championId, mode: g.mode, dur: g.dur, time: g.time, gid: g.gid });

      const ck = String(me.championId);
      champCount[ck] = (champCount[ck] || 0) + 1;
      if (!champMeta[ck] || me.championName) champMeta[ck] = { name: me.championName || '' };

      if (!modeStats[g.mode]) modeStats[g.mode] = { n: 0, w: 0, k: 0, d: 0, a: 0 };
      modeStats[g.mode].n++; if (me.win) modeStats[g.mode].w++;
      modeStats[g.mode].k += me.k; modeStats[g.mode].d += me.d; modeStats[g.mode].a += me.a;

      // 基友统计 (SGP 数据含全部玩家, 按puuid合并改名, 名字取最新)
      for (const p of g.participants) {
        if (p.teamId !== me.teamId || p.puuid === me.puuid || !p.name) continue;
        if (!friendCount[p.puuid]) friendCount[p.puuid] = { name: p.name, tagLine: p.tagLine || '', count: 0, wins: 0, losses: 0 };
        friendCount[p.puuid].count++;
        if (me.win) friendCount[p.puuid].wins++;
        else friendCount[p.puuid].losses++;
      }
    }
    // 基友名字取最新: 倒序遍历取每个puuid最后一次出现的名字
    for (let i = games.length - 1; i >= 0; i--) {
      const g = games[i];
      const me = findProfileParticipant(g, s);
      for (const p of g.participants) {
        if (p.teamId !== me.teamId || p.puuid === me.puuid || !p.name) continue;
        if (friendCount[p.puuid]) {
          friendCount[p.puuid].name = p.name;
          if (p.tagLine) friendCount[p.puuid].tagLine = p.tagLine;
        }
      }
    }
    // 旧缓存中可能留有网络分块解码产生的 U+FFFD；按 PUUID 从完整档案回填后再渲染。
    const brokenFriendPuuids = Object.entries(friendCount)
      .filter(([, friend]) => hasBrokenText(friend.name) || hasBrokenText(friend.tagLine))
      .map(([puuid]) => puuid);
    if (brokenFriendPuuids.length) {
      await resolveNames(brokenFriendPuuids);
      if (stale()) return;
      for (const puuid of brokenFriendPuuids) {
        const friend = friendCount[puuid];
        if (friend && nameCache[puuid] && !hasBrokenText(nameCache[puuid])) friend.name = nameCache[puuid];
        if (friend && tagCache[puuid] && !hasBrokenText(tagCache[puuid])) friend.tagLine = tagCache[puuid];
      }
    }
    const n = games.length;
    const avgKda = ((totK + totA) / Math.max(1, totD)).toFixed(2);
    const wr = Math.round(wins / n * 100);
    homeChampCount = champCount;
    homeChampMeta = champMeta;
    // 当前赛季排位数据 + 隐藏分 (与战绩并行拉取; 缓存命中时直接来自缓存)
    if (stale()) return;                     // 渲染前最后一道闸
    const rankHtml = renderRankCards(ranked?.queueMap || {});
    const qm = ranked?.queueMap || {};
    const RANK_QUEUE_IDS = { "RANKED_SOLO_5x5": 420, "RANKED_FLEX_SR": 440 };
    // 排位胜负直接用接口数据 (当前赛段真实战绩, 与 Akari 一致)
    const rankRows = RANK_QUEUE_LABELS.map(([q, label]) => {
      const r = qm[q];
      if (!r || !r.tier || !(r.wins + r.losses)) return "";
      const total = r.wins + r.losses;
      const rank = r.tier ? `${rankTierCN(r.tier)} ${r.division || ''}` : '--';
      const lp = r.leaguePoints || 0;
      return { name: label + " (当前赛段)", n: total, w: r.wins, rank, lp, season: true };
    }).filter(Boolean);
    const mmrChips = [];
    const seasonWrOfQ = r => r && (r.wins + r.losses) ? Math.round(r.wins / (r.wins + r.losses) * 100) : null;
    const recentWrOf = modeNames => {
      let nn = 0, ww = 0;
      for (const m of modeNames) {
        const ms = modeStats[m];
        if (ms) { nn += ms.n; ww += ms.w; }
      }
      return nn >= 5 ? Math.round(ww / nn * 100) : null;
    };
    // 模式聚合战绩 (n/w/k/d/a), 供胜率+KDA 估算使用
    const recentAggOf = modeNames => {
      const agg = { n: 0, w: 0, k: 0, d: 0, a: 0 };
      for (const m of modeNames) {
        const ms = modeStats[m];
        if (ms) { agg.n += ms.n; agg.w += ms.w; agg.k += ms.k; agg.d += ms.d; agg.a += ms.a; }
      }
      return agg.n >= 5 ? agg : null;
    };
    const soloQf = qm.RANKED_SOLO_5x5;
    const flexQf = qm.RANKED_FLEX_SR;
    const soloWr = seasonWrOfQ(soloQf) ?? recentWrOf(["单双排", "排位·单双排"]) ?? wr;
    const flexWr = seasonWrOfQ(flexQf) ?? recentWrOf(["灵活组排", "排位·灵活组排"]) ?? wr;
    const soloM = mmrFromRanked(soloQf?.tier, soloQf?.division, soloQf?.leaguePoints, soloWr);
    if (soloM) mmrChips.push(["单双排", soloM]);
    const flexM = mmrFromRanked(flexQf?.tier, flexQf?.division, flexQf?.leaguePoints, flexWr);
    if (flexM) mmrChips.push(["灵活组排", flexM]);
    // 海克斯大乱斗: 优先海斗排位段位 (打过海斗排位时), 否则用 胜率+KDA 独立估算
    const jadeQ = qm.JADE_RANKED_SOLO_5x5;
    const jadeAgg = recentAggOf(["海克斯大乱斗"]);
    const jadeWr = jadeAgg ? Math.round(jadeAgg.w / jadeAgg.n * 100) : null;
    const jadeM = mmrFromRanked(jadeQ?.tier, jadeQ?.division, jadeQ?.leaguePoints, jadeWr);
    if (jadeM) mmrChips.push(["海斗排位", jadeM]);
    else if (jadeAgg) {
      const est = mmrJadeEstimate(jadeAgg, soloM);
      if (est) {
        const jadeKda = ((jadeAgg.k + jadeAgg.a) / Math.max(1, jadeAgg.d)).toFixed(2);
        const jadeWrPct = Math.round(jadeAgg.w / jadeAgg.n * 100);
        mmrChips.push(["海斗·估算", est.v, `基于近${jadeAgg.n}场海斗: 胜率${jadeWrPct}% · KDA${jadeKda} · 基准来源: ${est.basis} (非官方估算)`]);
      }
    }
    // 自校准采样: 有海斗排位段位的档案, 记录 (海斗表现, 排位推算MMR) 样本对, 用于修正估算基准
    if (jadeQ && jadeQ.tier && jadeAgg && jadeAgg.n >= 10 && jadeM) {
      addJadeCalibSample(s.puuid, jadeAgg.w / jadeAgg.n * 100, (jadeAgg.k + jadeAgg.a) / Math.max(1, jadeAgg.d), jadeM);
    }
    // 大乱斗: 胜率+KDA 独立估算 (与海斗分开统计)
    const aramAgg = recentAggOf(["极地大乱斗"]);
    if (aramAgg) mmrChips.push(["大乱斗·估算", mmrAram(aramAgg)]);
    const topFriends = dataSource === "SGP" ? Object.values(friendCount).sort((a, b) => b.count - a.count).slice(0, 8) : [];

    // ========== 渲染 op.gg 风格首页 ==========
    const soloQ = qm.RANKED_SOLO_5x5;
    const flexQ = qm.RANKED_FLEX_SR;
    const spellName = id => spellMap[String(id)] || String(id);
    const itemIcon = id => id ? `https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${id}.png` : '';
    // 段位卡片
    const rankCard = (q, label) => {
      if (!q || !q.tier) return `<div class="rank-card"><div class="rank-card-label">${label}</div><div class="rank-card-tier">无排位</div></div>`;
      const t = rankTierCN(q.tier);
      const lp = q.leaguePoints || 0;
      const total = (q.wins || 0) + (q.losses || 0);
      const wr = total ? Math.round(q.wins / total * 100) : 0;
      return `<div class="rank-card">
        <div class="rank-card-label">${label}</div>
        <div class="rank-card-tier">${t} ${q.division || ''}</div>
        <div class="rank-card-record">${q.wins || 0}胜 ${q.losses || 0}负 · ${wr}% · ${lp}LP</div>
      </div>`;
    };
    // 常用英雄
    const topChampRows = buildHomeChampionRows(champCount, champMeta);
    // 常一起玩
    const friendList = Object.entries(friendCount).sort((a, b) => b[1].count - a[1].count).slice(0, 8);
    const friendRows = friendList.map(([puuid, f]) => {
      const tag = f.tagLine || tagCache[puuid] || '';
      const displayName = tag ? f.name + '#' + tag : f.name;
      return `<div class="friend-row">
        <div class="friend-row-name" onclick="searchPlayerByPuuid(${inlineArg(puuid)}, ${inlineArg(displayName)})">${escapeHtml(displayName)}</div>
        <div class="friend-row-count">${f.wins}胜${f.losses}负</div>
      </div>`;
    }).join('');
    // 统计数据
    const avgDur = n ? Math.round(totDur / n) : 0;
    const avgDurMin = Math.floor(avgDur / 60);
    const avgDurSec = avgDur % 60;
    const fmtDur = `${avgDurMin}:${String(avgDurSec).padStart(2, '0')}`;
    const totalDurH = Math.floor(totDur / 3600);
    const totalDurM = Math.floor((totDur % 3600) / 60);
    // 对局列表卡片改由 renderHomeGameList() 按筛选状态生成 (见模板底部), 不再内联全量 gameRows
    // 右侧对局列表
    panel.innerHTML = `
      <div class="home-layout">
        ${homeSearchMarkup('输入 名字#Tag 查询其他召唤师战绩 (如 召唤师#0000)')}
        <div class="home-header">
          <div class="home-avatar">
            <img src="${s.profileIconId >= 0 ? profileIcon(s.profileIconId) : placeholder((s.gameName||'?')[0])}" onerror="this.src='${placeholder((s.gameName||'?')[0])}'">
          </div>
          <div class="home-info">
            <div class="home-name">${escapeHtml(s.gameName || s.displayName || s.name || '未知玩家')}${s.tagLine ? '#' + escapeHtml(s.tagLine) : ''}</div>
            <div class="home-server">大区: ${server} · 等级 ${s.summonerLevel || '-'} · ${includePractice ? '近 ' + n + ' 场统计' : (rawGameCount > n ? '拉取 ' + rawGameCount + ' 场 · 统计 ' + n + ' 场 (训练/自定义未计入)' : '近 ' + n + ' 场统计')}</div>
            <div class="home-mmr"><small>非官方匹配强度</small>${mmrChips.map(([l, v, tip]) => `<span class="mmr-chip"${tip ? ` title="${tip}"` : ''}>${l} ~${v}</span>`).join('')}</div>
          </div>
          <div class="home-winrate">
            ${!isSelf ? '<button class="back-to-me" onclick="backToMe()">⟲ 回到我的</button>' : ''}
            <div class="home-winrate-val ${wr >= 50 ? 'pos' : 'neg'}">${wr}%</div>
            <div class="home-winrate-label">近期胜率</div>
          </div>
        </div>
        <div class="home-ranks">
          ${rankCard(soloQ, '排位 单双排')}
          ${rankCard(flexQ, '灵活组排')}
        </div>
        <div class="home-stats">
          <div class="stat-card"><div class="stat-card-val">${totalDurH}:${String(totalDurM).padStart(2, '0')}</div><div class="stat-card-label">总游戏时长</div></div>
          <div class="stat-card"><div class="stat-card-val">${fmtDur}</div><div class="stat-card-label">场均用时</div></div>
          <div class="stat-card"><div class="stat-card-val">${totK} / ${totD} / ${totA}</div><div class="stat-card-label">总击杀/死亡/助攻</div></div>
          <div class="stat-card"><div class="stat-card-val">${avgKda}</div><div class="stat-card-label">场均 KDA</div></div>
          <div class="stat-card"><div class="stat-card-val">${maxK} / ${maxD}</div><div class="stat-card-label">单局最高杀/死</div></div>
          <div class="stat-card"><div class="stat-card-val">${penta} / ${fb}</div><div class="stat-card-label">五杀 / 一血</div></div>
        </div>
        ${buildHomeFunStats(games, s)}
        ${buildHomeCoach(games, s)}
        <div class="home-bottom">
          <div class="home-champs">
            <h4>常用英雄</h4>
            <div class="champ-grid" id="homeChampGrid">${topChampRows}</div>
          </div>
          <div class="home-friends">
            <h4>常一起玩 (基友)</h4>
            <div class="friend-grid">${friendRows}</div>
          </div>
        </div>
        <div class="home-mode-stats">
          <h4>模式统计</h4>
          <table class="mode-table">
            <thead>
              <tr><th>类型</th><th>总场次</th><th>胜率</th><th>胜场</th><th>负场</th><th>段位</th><th>胜点</th></tr>
            </thead>
            <tbody>
              ${rankRows.map(r => {
                const mwr = r.n ? Math.round(r.w / r.n * 100) : 0;
                return `<tr><td>${escapeHtml(r.name)}</td><td>${r.n}</td><td class="${mwr >= 50 ? 'pos' : 'neg'}">${mwr}%</td><td>${r.w}</td><td>${r.n - r.w}</td><td>${escapeHtml(r.rank || '--')}</td><td>${r.lp || '--'}</td></tr>`;
              }).join('')}
              ${Object.keys(modeStats).filter(m => shouldShowRecentModeRow(m, qm)).map(m => {
                const ms = modeStats[m];
                const mwr = Math.round(ms.w / ms.n * 100);
                return `<tr><td>${m}</td><td>${ms.n}</td><td class="${mwr >= 50 ? 'pos' : 'neg'}">${mwr}%</td><td>${ms.w}</td><td>${ms.n - ms.w}</td><td>--</td><td>--</td></tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        <div class="home-games">
          <div class="rk-summary-bar">
            <span>近 ${n} 场</span>
            <span class="${wr >= 50 ? 'pos' : 'neg'}">${wins}胜 ${n - wins}负 (${wr}%)</span>
            <label class="rk-toggle"><input type="checkbox" ${includePractice ? 'checked' : ''} onchange="toggleIncludePractice(this.checked)"> 训练/自定义计入</label>
            <span>场均 ${(totK/n).toFixed(1)}/${(totD/n).toFixed(1)}/${(totA/n).toFixed(1)}</span>
            <span>KDA ${avgKda}</span>
          </div>
          <div class="home-mode-filter" id="homeModeFilter"></div>
          <div id="homeGamesList"></div>
        </div>
      </div>`;
    // 模式筛选所需数据缓存
    homeGamesData = games;
    homeGamesOwner = s.puuid;
    homeGameVisible = HOME_GAME_PAGE_SIZE;
    homeGameRemoteState = !isSelf && (dataSource === 'SGP' || profileOverflow.length) && games.length < 100 ? {
      source: dataSource,
      puuid: s.puuid,
      platformId: targetPlatformId,
      includePractice,
      cacheKey,
      // 旧缓存只保留了前 30 场，需从第 0 页重取一次才能找回同页被截掉的记录。
      nextIndex: loadPath === 'cache' ? 0 : rawGameCount,
      batch: 50,
      maxFetch: 500,
      buffered: profileOverflow,
      exhausted: false,
      loading: false,
      error: ''
    } : null;
    renderHomeModeFilter();
    // 关键: 列表必须按当前筛选状态重建。原先模板内联的是"全部对局",
    // 重渲染后下拉框还显示旧选中值, 列表却是全部 —— 看起来就是"筛选失效"
    renderHomeGameList();
    // 静态英雄数据可能刚好在首页模板生成与挂载之间完成；挂载后再补绘一次，彻底消除竞态空白。
    refreshHomeChampionRows();
    restoreHomeScroll(s.puuid);
    try {
      lolAPI.debugLog(`[PERF] home path=${loadPath} target=${profileOverride ? 'profile' : 'self'} games=${games.length} render=${Math.round(performance.now() - loadStartedAt)}ms`);
    } catch (e) {}
    // 缓存已过期 (>3分钟): 标记待刷新, 由 pollLoop 在 LCU 就绪后静默补刷 (替换之前的 setTimeout 方案,
    // 因为客户端可能还没连接, 立即刷新只会失败)
    if (cacheUsable && !skipCache && !cacheFresh) window._homeCacheNeedRefresh = true;
  } catch (e) {
    homeStatsLoaded = false;
    panel.innerHTML = `<div class="msg-error">统计数据加载失败: ${escapeHtml(e.message)}</div>`;
    restoreHomeScroll(profileOverride?.puuid || cachedSummoner?.puuid || '');
  } finally {
    window.poroPerf?.record('home.load', performance.now() - loadStartedAt, {
      path: loadPath,
      target: profileOverride ? 'profile' : 'self',
      stale: myToken !== homeStatsToken
    });
    if (myToken === homeStatsToken) homeStatsLoading = false;
  }
}

function fmtNumLocal(n) { return Number(n || 0).toLocaleString('en-US'); }
// 展开对局详情
async function expandOpggGame(el, gameId) {
  const detail = el.querySelector('.og-game-detail');
  if (detail.style.display !== 'none') { detail.style.display = 'none'; el.classList.remove('expanded'); return; }
  detail.style.display = 'block';
  el.classList.add('expanded');
  detail.innerHTML = '<div class="meta-loading">加载中...</div>';
  ensureChampMap();
  let norm = null;
  // SGP SUMMARY (含完整玩家统计+符文; DETAILS 是时间线格式不能用于玩家表), 失败回退 LCU
  try {
    const platformId = el.dataset.platform || await getPlatformId();
    if (isTencentPlatform(platformId)) {
      const resp = await lolAPI.sgpGameSummary(platformId, gameId);
      if (!resp.__error) { const g = resp.json || resp; if (g.participants?.length) norm = normalizeGame(g, true); }
    }
  } catch (e) {}
  if (!norm) {
    const d = await lolAPI.lcuRequest("GET", `/lol-match-history/v1/games/${gameId}`);
    const g = (d?.games?.games?.[0]) || d;
    if (g?.participants) norm = normalizeGame(g, false);
  }
  if (!norm) { detail.innerHTML = '<div class="msg-error">详情加载失败</div>'; return; }
  // 解析空名字的玩家 + 段位
  const allPuuids = norm.participants.map(p => p.puuid).filter(Boolean);
  const emptyNames = allPuuids.filter(puuid => {
    const p = norm.participants.find(x => x.puuid === puuid);
    return !p.name || hasBrokenText(p.name);
  });
  if (emptyNames.length) {
    await resolveNames(emptyNames);
    for (const p of norm.participants) { if ((!p.name || hasBrokenText(p.name)) && nameCache[p.puuid]) p.name = nameCache[p.puuid]; }
  }
  await resolveRanks(allPuuids);
  try {
    renderOpggGameDetail(norm, detail);
  } catch (e) {
    console.error("渲染详情失败:", e);
    detail.innerHTML = `<div class="msg-error">详情渲染失败: ${escapeHtml(e.message)}</div>`;
    return;
  }
  renderGameReview(norm, gameId, detail, el.dataset.platform || '');
}

if (typeof module !== 'undefined' && module.exports) module.exports = { deriveHomeFunStats };
