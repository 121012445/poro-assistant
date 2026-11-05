// 首页: 段位 / 海斗自校准 / 玩家数据统计 / op.gg 风格渲染
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 召唤师段位 (合并到首页) ==========
const TIER_CN = { IRON: "坚韧黑铁", BRONZE: "英勇黄铜", SILVER: "不屈白银", GOLD: "荣耀黄金", PLATINUM: "华贵铂金", EMERALD: "翡翠", DIAMOND: "璀璨钻石", MASTER: "超凡大师", GRANDMASTER: "傲世宗师", CHALLENGER: "最强王者" };
const RANK_QUEUE_LABELS = [["RANKED_SOLO_5x5", "排位 单双排"], ["RANKED_FLEX_SR", "灵活组排"]];
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

// 段位晋升追踪: LP 进度条 + 预计晋级场次 (按每胜约 +15LP 估算; 大师以上无分段 LP 不封顶, 不显示)
function rankPromoHtml(q) {
  const lp = q.leaguePoints || 0;
  const tier = String(q.tier || '').toUpperCase();
  if (['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(tier)) return '';
  if (String(q.division || '').toUpperCase() === 'I') {
    return lp >= 100 ? '<div class="rank-promo"><span>已进入晋级赛, 祝好运!</span></div>' : '';
  }
  const wins = Math.max(1, Math.ceil((100 - lp) / 15));
  const pct = Math.max(0, Math.min(100, lp));
  return '<div class="rank-promo" title="按每胜约 +15LP 估算, 仅供参考">'
    + '<div class="rank-promo-bar"><i style="width:' + pct + '%"></i></div>'
    + '<span>距晋级约 <b>' + wins + '</b> 胜</span></div>';
}

// 段位卡片 (统一用 home-ranks 大卡片, 与 premium 设计一致; 旧 rank-mini 已弃用)
function renderRankCards(queues) {
  return RANK_QUEUE_LABELS.map(([queueKey, label]) => {
    const q = queues ? queues[queueKey] : null;
    if (!q || !q.tier) return `<div class="rank-card"><div class="rank-card-label">${label}</div><div class="rank-card-tier">无排位</div></div>`;
    const t = rankTierCN(q.tier);
    const lp = q.leaguePoints || 0;
    const total = (q.wins || 0) + (q.losses || 0);
    const wr = total ? Math.round(q.wins / total * 100) : 0;
    return `<div class="rank-card">
      <div class="rank-card-label">${label}</div>
      <div class="rank-card-tier">${t} ${q.division || ''}</div>
      <div class="rank-card-record">${q.wins || 0}胜 ${q.losses || 0}负 · ${wr}% · ${lp}LP</div>
      ${rankPromoHtml(q)}
    </div>`;
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

// ---------- 战绩服务故障退避 ----------
// 国服 SGP 战绩网关 (HN1 等) 在深夜偶发持续 5xx（实测 2026-10-09/10 的 23:00~00:3x 连续
// 25 分钟返回 500/503）。原先的轮询每 12 秒无脑重试一次，整个故障窗口会打出上千次请求，
// 既没有意义（服务端已经挂了）又会加重网关负载、拖慢恢复。
// 这里改成指数退避：连续失败就拉长间隔，一旦成功立刻复位。
const SGP_BACKOFF_STEPS_MS = [30000, 60000, 120000, 300000];
let sgpFailureStreak = 0;
let sgpBackoffUntil = 0;
// 判定"服务端暂时不可用"（可退避重试），与"这个玩家就是没数据"区分开。
function isTransientSgpError(message) {
  const text = String(message || '');
  return /SGP HTTP 5\d\d|SGP 请求超时|SGP 连接失败|SGP 凭证过期|所有大区召唤师服务暂不可用|ECONNRESET|ETIMEDOUT|socket hang up/i.test(text);
}
function noteSgpFailure() {
  const step = Math.min(sgpFailureStreak, SGP_BACKOFF_STEPS_MS.length - 1);
  sgpFailureStreak++;
  sgpBackoffUntil = Date.now() + SGP_BACKOFF_STEPS_MS[step];
  try { lolAPI.debugLog(`[HOME] SGP 退避 ${SGP_BACKOFF_STEPS_MS[step] / 1000}s (连续失败 ${sgpFailureStreak} 次)`); } catch (e) {}
}
function noteSgpSuccess() {
  if (sgpFailureStreak) {
    try { lolAPI.debugLog(`[HOME] SGP 恢复 (此前连续失败 ${sgpFailureStreak} 次)`); } catch (e) {}
  }
  sgpFailureStreak = 0;
  sgpBackoffUntil = 0;
}
function sgpBackoffActive() { return Date.now() < sgpBackoffUntil; }
let homeScrollSnapshot = null;
// 自动补刷可以和用户打开详情并发。详情展开期间不替换首页 DOM；否则异步请求
// 返回时会把 .ako-card 整批重建，表现为“详情自己合上”。关闭详情后再从新缓存补绘。
let homeRenderDeferred = false;

function isHomeGameDetailExpanded() {
  return !!document.querySelector('#playerPanel .ako-card.expanded');
}

function resumeDeferredHomeRefresh() {
  if (!homeRenderDeferred || isHomeGameDetailExpanded()) return;
  homeRenderDeferred = false;
  setTimeout(() => loadHomeStats(true), 0);
}

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
  ensureChampMap();
  const rows=(games||[]).map(game=>({game,me:findProfileParticipant(game,summoner)})).filter(r=>r.me);
  const data=PoroProgress.analyze(rows,allChampions,buildHomeCoach.selectedQueue||'',typeof allItems==='undefined'?{}:allItems);
  const fmt=(n,suffix='')=>n==null?'暂无数据':Number(n).toFixed(1)+suffix;
  const value=(n,suffix='',tone='blue')=>'<b class="hc-value hc-value-'+tone+'">'+fmt(n,suffix)+'</b>';
  const esc=escapeHtml;
  const cards=data.categories.map(c=>{
    if(!c.count) return '<article class="hc-card"><strong>'+c.name+'</strong><p>该模式暂无此类别战绩</p></article>';
    const reps=c.champions.map(h=>'<span class="hc-champ"><span><b>'+esc(h.name)+'</b><small>'+h.count+' 场 · 胜率 '+fmt(h.winRate*100,'%')+(h.count<3?' · 样本较少':'')+'</small></span></span>').join('');
    return '<article class="hc-card"><strong>'+c.name+' · '+c.count+' 场</strong>'+
      '<p>胜率 '+value(c.winRate*100,'%','teal')+' · KDA '+value(c.kda,'','violet')+'</p>'+
      '<p>伤转 '+value(c.efficiency,'%','gold')+' · 每分钟伤害 '+value(c.dpm)+'<br>'+
      '每分钟承伤 '+value(c.tanking)+' · 对友治疗/护盾 '+value(c.support,'','teal')+'/分钟</p>'+
      '<p class="hc-strength"><b>优势依据：</b>'+esc(c.strength)+'</p>'+
      '<p class="hc-advice"><b>如何提升：</b>'+(c.count<5?'样本较少，以下仅为类别通用建议。':'')+esc(c.tip)+'</p>'+
      '<p>分类依据：出装辅助判断 '+c.buildCount+' 场 · 基础标签估计 '+c.fallbackCount+' 场，其余按预设玩法。</p>'+
      '<p>代表英雄（优先至少 3 场、胜率较好的英雄）</p>'+reps+'</article>';
  }).join('');
  return '<section class="home-coach"><div class="hc-head"><b>我的擅长与提升</b><span>历史类别画像 · 不设训练目标，不监控进度</span></div>'+
    '<select aria-label="画像游戏模式" onchange="setProfileQueue(this.value)">'+data.modes.map(m=>'<option value="'+esc(m.queue)+'"'+(m.queue===data.queue?' selected':'')+'>'+esc(m.name)+'（'+m.count+' 场）</option>').join('')+'</select>'+
    '<p>玩得最多：'+esc(data.mostPlayed?data.mostPlayed.name+'（'+data.mostPlayed.count+' 场）':'暂无数据')+
    '；近期胜率优势：'+esc(data.best?data.best.name+'（'+data.best.count+' 场，'+fmt(data.best.winRate*100,'%')+'）':'暂不足以区分')+'</p>'+
    '<small>胜率优势仅比较你本人同模式下至少 5 场的玩法，不是熟练度定论。按预设玩法归类；多定位英雄有至少两件倾向明确的成装时参考出装，否则保留默认定位。分类为规则估计，非官方定位，每场只计一类；未知类别 '+data.unclassified+' 场暂未纳入。样本来自当前已加载历史，不跨模式混算。</small>'+
    '<div class="hc-profile-grid">'+cards+'</div><small>原始输出、承伤受英雄定位影响；建议是复盘方向，不能从汇总数据认定操作原因。没有同类玩家基准，不生成排名或能力百分位。</small></section>';
}

function setProfileQueue(queue) {
  buildHomeCoach.selectedQueue=String(queue);
  refreshHomeCoach();
}

// 趣味数据只描述本次首页已加载的近期对局，不包装成“生涯纪录”。保持为纯计算函数，
// 便于用固定样本回归最长连胜、活跃时段和幸运英雄等边界。
const HOME_ROLE_LABELS = { Fighter: '战士', Mage: '法师', Assassin: '刺客', Marksman: '射手', Support: '辅助', Tank: '坦克' };
// icons.js 提供 poroIcon；但 Node 测试会直接 require 本文件，那时它不在作用域里
// （顶层常量 HOME_ROLE_ICONS 在模块加载期就要算图标字符串，会 ReferenceError）。
// 这里兜一个空 SVG 保证纯计算函数可被测试调用；浏览器里这行不会执行。
if (typeof poroIcon !== 'function') { globalThis.poroIcon = () => '<svg class="pi"></svg>'; }
const HOME_ROLE_ICONS = { Fighter: poroIcon('sword'), Mage: poroIcon('orb'), Assassin: poroIcon('dagger'), Marksman: poroIcon('bow'), Support: poroIcon('heart'), Tank: poroIcon('shield') };
const HOME_ITEM_EXCLUDES = new Set([2003, 2010, 2031, 2033, 2055, 2138, 2139, 2140, 2141, 2142, 2143, 2144, 3340, 3348, 3363, 3364]);

function homeCatalogEntryByKey(catalog, numericId) {
  const id = String(+numericId || '');
  if (!id || !catalog || typeof catalog !== 'object') return null;
  if (catalog[id]) return catalog[id];
  return Object.values(catalog).find(entry => String(entry?.key || '') === id) || null;
}


function refreshHomeCoach() {
  const host = profileHost();
  const old = host && host.querySelector('.home-coach');
  if (!old || !homeGamesData?.length || !homeGamesOwner) return;
  const html = buildHomeCoach(homeGamesData, { puuid: homeGamesOwner });
  if (html && old.outerHTML !== html) old.outerHTML = html;
}

// “钟爱装备”只统计最终成装。药水、守卫、饰品、鞋子和仍可继续合成的散件
// 会高频出现在每局背包中，但不代表玩家的出装偏好，因此在这里主动排除。
function isHomeSignatureItem(itemId, itemCatalog) {
  const id = +itemId || 0;
  if (!id || HOME_ITEM_EXCLUDES.has(id)) return false;
  const item = itemCatalog?.[String(id)] || itemCatalog?.[id];
  if (!item) return id >= 3000 && id < 9000;
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const name = String(item.name || '');
  if (tags.some(tag => ['Consumable', 'Trinket', 'Boots'].includes(tag))) return false;
  if (/药水|合剂|守卫|饰品|药剂|鞋/.test(name)) return false;
  if (Array.isArray(item.into) && item.into.length) return false;
  return (+item.gold?.total || 0) >= 1600;
}

// 从累加结果里挑出各项"最"：最常玩时段、幸运英雄、钟爱装备/三件套/位置、
// 最佳时段、黄金队友、苦主。
//
// 2026-09-27 从 deriveHomeFunStats 抽出。这一段是 8 条 sort/filter 取值链，
// 夹在累加循环和分类规则之间；抽出来后主函数变成清晰的
// 「累加 → 挑亮点 → 分类 → 返回」四步。
//
// 注意 favoriteRole.championCount 是**故意**写回对象的 —— 下游按这个字段显示
// "用过 N 个英雄", 原来就在这儿赋值。
function pickFunHighlights(acc) {
  const { periods, champions, favoriteItems, itemTriples, roleStats, partners, nemeses } = acc;
  const favoritePeriod = periods.slice().sort((a, b) => b.games - a.games || periods.indexOf(a) - periods.indexOf(b))[0];
  const luckyChampion = [...champions.values()].filter(item => item.games >= 2).sort((a, b) =>
    b.wins / b.games - a.wins / a.games || b.games - a.games || a.id - b.id)[0] || null;
  const favoriteItem = [...favoriteItems.values()].sort((a, b) =>
    b.games - a.games || b.wins / b.games - a.wins / a.games || a.id - b.id)[0] || null;
  const favoriteTriple = [...itemTriples.values()].sort((a, b) =>
    b.games - a.games || b.wins / b.games - a.wins / a.games || a.ids.join('-').localeCompare(b.ids.join('-')))[0] || null;
  const favoriteRole = [...roleStats.values()].filter(role => role.games >= 2).sort((a, b) =>
    b.games - a.games || b.wins / b.games - a.wins / a.games ||
    (b.k + b.a) / Math.max(1, b.d) - (a.k + a.a) / Math.max(1, a.d) || a.tag.localeCompare(b.tag))[0] || null;
  if (favoriteRole) favoriteRole.championCount = favoriteRole.champions.size;
  const bestPeriod = periods.filter(period => period.games >= 2).sort((a, b) =>
    b.wins / b.games - a.wins / a.games || b.games - a.games || periods.indexOf(a) - periods.indexOf(b))[0] || null;
  const goldenPartner = [...partners.values()].filter(item => item.games >= 2).sort((a, b) =>
    b.wins / b.games - a.wins / a.games || b.games - a.games || a.name.localeCompare(b.name))[0] || null;
  const nemesis = [...nemeses.values()].filter(item => item.games >= 2).sort((a, b) =>
    b.losses / b.games - a.losses / a.games || b.games - a.games || a.id - b.id)[0] || null;
  return { favoritePeriod, luckyChampion, favoriteItem, favoriteTriple, favoriteRole, bestPeriod, goldenPartner, nemesis };
}

// 英雄池专一度分类。
//
// 2026-09-27 从 deriveHomeFunStats 抽出，把原来一长串匿名 if/else 变成具名规则 ——
// 之前测试只能断言"label 存在"(test_home_fun_stats.js 第 95 行), 阈值改错了照样绿。
// 现在可以按具体输入断言会落到哪个 label。
// 判定顺序即优先级: 先看最常用英雄占比, 再看英雄数量, 最后看前三占比。
function classifyHeroPool(list, champions, topShare, topThreeShare) {
  if (list.length >= 5 && topShare >= 0.45) return { label: '绝活专精', detail: `最常用英雄占近期 ${Math.round(topShare * 100)}%` };
  if (list.length >= 8 && champions.size / list.length >= 0.75) return { label: '全能选手', detail: `${list.length} 场使用 ${champions.size} 位英雄` };
  if (list.length >= 5 && topThreeShare >= 0.75) return { label: '精简英雄池', detail: `前三英雄覆盖 ${Math.round(topThreeShare * 100)}% 对局` };
  return { label: '均衡英雄池', detail: `${list.length} 场使用 ${champions.size} 位英雄` };
}

// 战斗风格分类。
//
// 2026-09-27 从 deriveHomeFunStats 抽出，同 classifyHeroPool。
// 判定顺序即优先级: 团队辅助 → 前排抗压 → 激进收割 → 稳健输出 → 兜底均衡。
// participation / avgDamage / avgTaken 由调用方先做 `|| 0` 兜底再传进来 ——
// 这里拿到的都是数字, 不用再考虑 null。
function classifyCombatStyle(performance, participation, avgDamage, avgTaken) {
  if ((performance.averageUtility || 0) >= 3500 && participation >= 60) return { label: '团队辅助型', detail: `平均参团 ${Math.round(participation)}% · 治疗护盾 ${Math.round(performance.averageUtility)}` };
  if (avgTaken > avgDamage * 1.2 && avgTaken >= 12000) return { label: '前排抗压型', detail: `场均承伤 ${Math.round(avgTaken).toLocaleString('en-US')}` };
  if (performance.averageKills >= 8 || (performance.averageDeaths >= 8 && avgDamage >= 15000)) return { label: '激进收割型', detail: `场均 ${performance.averageKills.toFixed(1)} 杀 · ${performance.averageDeaths.toFixed(1)} 死` };
  if (performance.averageDeaths <= 5 && avgDamage >= avgTaken * 0.8) return { label: '稳健输出型', detail: `场均死亡 ${performance.averageDeaths.toFixed(1)} · KDA ${performance.averageKda.toFixed(2)}` };
  return { label: '均衡适应型', detail: `KDA ${performance.averageKda.toFixed(2)} · 参团 ${participation ? Math.round(participation) + '%' : '--'}` };
}

function deriveHomeFunStats(rows, catalogs = {}) {
  const list = Array.isArray(rows) ? rows.filter(row => row?.game && row?.me) : [];
  const periods = [
    { key: 'late', label: '深夜档', icon: poroIcon('moon'), from: 0, to: 5 },
    { key: 'morning', label: '上午档', icon: poroIcon('sun'), from: 6, to: 11 },
    { key: 'afternoon', label: '下午档', icon: poroIcon('cloudSun'), from: 12, to: 17 },
    { key: 'evening', label: '晚间档', icon: poroIcon('sunset'), from: 18, to: 23 }
  ].map(period => ({ ...period, games: 0, wins: 0 }));
  let longestWinStreak = 0, runningWins = 0, zeroDeaths = 0;
  let maxDamage = { value: 0, championId: 0 };
  let bestKda = { value: 0, championId: 0, k: 0, d: 0, a: 0 };
  let longestGame = { seconds: 0, championId: 0 };
  let totalKills = 0, totalDeaths = 0, totalAssists = 0;
  let totalDamage = 0, damageGames = 0, timedDamage = 0, timedSeconds = 0;
  let totalDamageTaken = 0, damageTakenGames = 0;
  let conversionDamage = 0, conversionGold = 0;
  let participationTotal = 0, participationGames = 0;
  let totalUtility = 0, utilityGames = 0;
  const champions = new Map();
  const favoriteItems = new Map();
  const itemTriples = new Map();
  const roleStats = new Map();
  const partners = new Map();
  const nemeses = new Map();
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
    const utility = (+me.healing || 0) + (+me.allyHeal || 0) + (+me.shielding || 0);
    if (utility > 0) { totalUtility += utility; utilityGames++; }
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
    for (const player of teammates) {
      if (player === me || (me.puuid && player?.puuid === me.puuid)) continue;
      const key = String(player?.puuid || `${player?.name || ''}#${player?.tagLine || ''}`);
      if (!key || key === '#') continue;
      const partner = partners.get(key) || { key, name: player?.name || '未知队友', tagLine: player?.tagLine || '', games: 0, wins: 0 };
      partner.games++; partner.wins += me.win ? 1 : 0;
      if (player?.name) partner.name = player.name;
      if (player?.tagLine) partner.tagLine = player.tagLine;
      partners.set(key, partner);
    }
    const enemies = Array.isArray(game.participants)
      ? game.participants.filter(player => String(player?.teamId) !== String(me.teamId))
      : [];
    for (const player of enemies) {
      const enemyChampionId = +player?.championId || 0;
      if (!enemyChampionId) continue;
      const enemy = nemeses.get(enemyChampionId) || { id: enemyChampionId, games: 0, losses: 0 };
      enemy.games++; enemy.losses += me.win ? 0 : 1;
      nemeses.set(enemyChampionId, enemy);
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

      const champion = homeCatalogEntryByKey(catalogs.champions, championId);
      for (const tag of (Array.isArray(champion?.tags) ? champion.tags : [])) {
        if (!HOME_ROLE_LABELS[tag]) continue;
        const role = roleStats.get(tag) || { tag, games: 0, wins: 0, k: 0, d: 0, a: 0, champions: new Set() };
        role.games++; role.wins += me.win ? 1 : 0;
        role.k += kills; role.d += deaths; role.a += assists;
        role.champions.add(+championId);
        roleStats.set(tag, role);
      }
    }
    // 一局内同名装备只记一次，避免少数可重复购买的模式装备放大偏好。
    const ownedItems = [...new Set((Array.isArray(me.items) ? me.items : []).map(Number).filter(Boolean))];
    for (const itemId of ownedItems) {
      if (!isHomeSignatureItem(itemId, catalogs.items)) continue;
      const item = favoriteItems.get(itemId) || { id: itemId, games: 0, wins: 0 };
      item.games++; item.wins += me.win ? 1 : 0;
      favoriteItems.set(itemId, item);
    }
    const signatureItems = ownedItems.filter(id => isHomeSignatureItem(id, catalogs.items));
    if (signatureItems.length >= 3) {
      for (let a = 0; a < signatureItems.length - 2; a++) for (let b = a + 1; b < signatureItems.length - 1; b++) for (let c = b + 1; c < signatureItems.length; c++) {
        const ids = [signatureItems[a], signatureItems[b], signatureItems[c]].sort((x, y) => x - y);
        const key = ids.join('-');
        const triple = itemTriples.get(key) || { ids, games: 0, wins: 0 };
        triple.games++; triple.wins += me.win ? 1 : 0;
        itemTriples.set(key, triple);
      }
    }
    let timestamp = +game.time || 0;
    if (timestamp > 0 && timestamp < 1e12) timestamp *= 1000;
    if (timestamp > 0) {
      const hour = new Date(timestamp).getHours();
      const period = periods.find(item => hour >= item.from && hour <= item.to);
      if (period) { period.games++; period.wins += me.win ? 1 : 0; }
    }
  }
  // 挑亮点见前面的 pickFunHighlights()
  const { favoritePeriod, luckyChampion, favoriteItem, favoriteTriple, favoriteRole, bestPeriod, goldenPartner, nemesis } =
    pickFunHighlights({ periods, champions, favoriteItems, itemTriples, roleStats, partners, nemeses });
  const championUsage = [...champions.values()].sort((a, b) => b.games - a.games || a.id - b.id);
  const topShare = list.length ? (championUsage[0]?.games || 0) / list.length : 0;
  const topThreeShare = list.length ? championUsage.slice(0, 3).reduce((sum, item) => sum + item.games, 0) / list.length : 0;
  // 分类见前面的 classifyHeroPool()
  const heroPoolProfile = classifyHeroPool(list, champions, topShare, topThreeShare);
  const performance = {
    averageKda: (totalKills + totalAssists) / Math.max(1, totalDeaths),
    averageKills: list.length ? totalKills / list.length : 0,
    averageDeaths: list.length ? totalDeaths / list.length : 0,
    averageAssists: list.length ? totalAssists / list.length : 0,
    damageConversion: conversionGold > 0 ? conversionDamage / conversionGold * 100 : null,
    damagePerMinute: timedSeconds > 0 ? timedDamage / (timedSeconds / 60) : null,
    averageDamage: damageGames ? totalDamage / damageGames : null,
    averageDamageTaken: damageTakenGames ? totalDamageTaken / damageTakenGames : null,
    averageUtility: utilityGames ? totalUtility / utilityGames : null,
    averageParticipation: participationGames ? participationTotal / participationGames * 100 : null,
    participationGames
  };
  const participation = performance.averageParticipation || 0;
  const avgDamage = performance.averageDamage || 0;
  const avgTaken = performance.averageDamageTaken || 0;
  // 分类见前面的 classifyCombatStyle()
  const combatStyle = classifyCombatStyle(performance, participation, avgDamage, avgTaken);
  return { sampleSize: list.length, longestWinStreak, zeroDeaths, uniqueChampions: champions.size, favoritePeriod, bestPeriod, maxDamage, bestKda, longestGame, luckyChampion, favoriteItem, favoriteTriple, favoriteRole, goldenPartner, nemesis, heroPoolProfile, combatStyle, performance };
}

function homeFunChampionName(championId) {
  const champion = champNumMap?.[String(championId)] || Object.values(allChampions || {}).find(row => +row?.key === +championId);
  return champion?.name || champion?.id || `英雄 #${championId || '?'}`;
}

function homeFunItemName(itemId) {
  const item = allItems?.[String(itemId)] || allItems?.[itemId];
  return item?.name || `装备 #${itemId || '?'}`;
}

function buildHomeFunStats(games, summoner) {
  const rows = (games || []).map(game => ({ game, me: findProfileParticipant(game, summoner) })).filter(row => row.me);
  const stats = deriveHomeFunStats(rows, { champions: allChampions, items: allItems });
  if (!stats.sampleSize) return '';
  const lucky = stats.luckyChampion;
  const favoriteItem = stats.favoriteItem;
  const favoriteRole = stats.favoriteRole;
  const favoriteTriple = stats.favoriteTriple;
  const goldenPartner = stats.goldenPartner;
  const nemesis = stats.nemesis;
  const bestPeriod = stats.bestPeriod;
  const period = stats.favoritePeriod;
  const performance = stats.performance;
  const longestMinutes = Math.round(stats.longestGame.seconds / 60);
  const oneDecimal = value => Number(value || 0).toFixed(1);
  const cards = [
    [poroIcon('flame'), '最长连胜', `${stats.longestWinStreak} 连胜`, `近 ${stats.sampleSize} 场中的最长纪录`],
    [poroIcon('shield'), '完美生存', `${stats.zeroDeaths} 场`, stats.zeroDeaths ? '整局保持零阵亡' : '近期还没有零阵亡对局'],
    [poroIcon('trendUp'), '输出天花板', fmtNumLocal(stats.maxDamage.value), `${homeFunChampionName(stats.maxDamage.championId)} · 单局英雄伤害`],
    [period?.icon || poroIcon('clock'), '最常出没', period?.games ? period.label : '时间未知', period?.games ? `${period.games} 场集中在 ${period.from}:00–${period.to}:59` : '战绩未提供开局时间'],
    [poroIcon('mask'), '近期英雄池', `${stats.uniqueChampions} 位`, `最长一局 ${longestMinutes || '--'} 分钟`],
    [poroIcon('clover'), '幸运英雄', lucky ? homeFunChampionName(lucky.id) : '样本不足', lucky ? `${lucky.games} 场 ${lucky.wins} 胜 · ${Math.round(lucky.wins / lucky.games * 100)}%` : '同一英雄至少使用 2 场后生成'],
    [poroIcon('toolbox'), '钟爱装备', favoriteItem ? homeFunItemName(favoriteItem.id) : '样本不足', favoriteItem ? `${favoriteItem.games} 场携带 · ${Math.round(favoriteItem.wins / favoriteItem.games * 100)}% 胜率` : '成装数据加载后自动生成'],
    [HOME_ROLE_ICONS[favoriteRole?.tag] || poroIcon('compass'), '擅长英雄分类', favoriteRole ? `${HOME_ROLE_LABELS[favoriteRole.tag]}型` : '样本不足', favoriteRole ? `${favoriteRole.games} 场 · ${favoriteRole.championCount} 位英雄 · ${Math.round(favoriteRole.wins / favoriteRole.games * 100)}%` : '同类英雄至少使用 2 场后生成'],
    [poroIcon('palette'), '战斗风格', stats.combatStyle.label, stats.combatStyle.detail],
    [poroIcon('cards'), '英雄池专一度', stats.heroPoolProfile.label, stats.heroPoolProfile.detail],
    [poroIcon('puzzle'), '常用三件套', favoriteTriple ? favoriteTriple.ids.map(homeFunItemName).join(' + ') : '样本不足', favoriteTriple ? `${favoriteTriple.games} 场成型 · ${Math.round(favoriteTriple.wins / favoriteTriple.games * 100)}% 胜率` : '至少一局拥有三件最终成装后生成'],
    [poroIcon('users'), '黄金搭档', goldenPartner ? `${goldenPartner.name}${goldenPartner.tagLine ? '#' + goldenPartner.tagLine : ''}` : '样本不足', goldenPartner ? `共同 ${goldenPartner.games} 场 · ${Math.round(goldenPartner.wins / goldenPartner.games * 100)}% 胜率` : '与同一队友完成至少 2 场后生成'],
    [poroIcon('nemesis'), '宿敌英雄', nemesis ? homeFunChampionName(nemesis.id) : '样本不足', nemesis ? `对阵 ${nemesis.games} 场 · 负率 ${Math.round(nemesis.losses / nemesis.games * 100)}%` : '对阵同一英雄至少 2 场后生成'],
    [bestPeriod?.icon || poroIcon('alarm'), '最佳上分时间', bestPeriod ? bestPeriod.label : '样本不足', bestPeriod ? `${bestPeriod.games} 场 ${bestPeriod.wins} 胜 · ${Math.round(bestPeriod.wins / bestPeriod.games * 100)}%` : '同一时间段至少 2 场后生成'],
    [poroIcon('target'), '近期平均 KDA', performance.averageKda.toFixed(2), `场均 ${oneDecimal(performance.averageKills)} / ${oneDecimal(performance.averageDeaths)} / ${oneDecimal(performance.averageAssists)}`],
    [poroIcon('exchange'), '伤害转化率', performance.damageConversion == null ? '--' : `${Math.round(performance.damageConversion)}%`, performance.damageConversion == null ? '战绩未提供金币数据' : '每 100 金币转化的英雄伤害'],
    [poroIcon('zap'), '每分钟输出', performance.damagePerMinute == null ? '--' : fmtNumLocal(Math.round(performance.damagePerMinute)), '按有效对局时长折算'],
    [poroIcon('users'), '平均参团率', performance.averageParticipation == null ? '--' : `${Math.round(performance.averageParticipation)}%`, performance.participationGames ? `${performance.participationGames} 场具备队伍击杀数据` : '战绩未提供队伍击杀数据'],
    [poroIcon('burst'), '场均英雄伤害', performance.averageDamage == null ? '--' : fmtNumLocal(Math.round(performance.averageDamage)), '仅统计对英雄造成的伤害'],
    [poroIcon('brick'), '场均承受伤害', performance.averageDamageTaken == null ? '--' : fmtNumLocal(Math.round(performance.averageDamageTaken)), '近期对局平均承伤']
  ];
  return `<section class="home-fun"><div class="home-fun-head"><span><b>玩家趣味档案</b><small>基于当前加载的近 ${stats.sampleSize} 场</small></span><em>仅代表近期</em></div>
    <div class="home-fun-grid">${cards.map(([icon, label, value, detail]) => {
      const fullValue = String(value);
      const wide = label === '常用三件套';
      return `<div class="home-fun-card${wide ? ' home-fun-card-wide' : ''}" title="${escapeHtml(`${label}：${fullValue}；${detail}`)}"><i>${icon}</i><span><small>${label}</small><b>${escapeHtml(fullValue)}</b><em>${escapeHtml(detail)}</em></span></div>`;
    }).join('')}</div></section>`;
}

// ── 「我的画像」独立页 ──────────────────────────────────────────────────────
// 2026-09-27: 「我的擅长与提升」与「玩家趣味档案」原先内联在首页模板里, 首页太长
// (两块加起来占了首页近一半纵向空间), 拆到 #page-profile。
//
// 设计取舍:
//   1) 首页不再内联这两块 —— 首屏省掉教练分析 + 20 张趣味卡的计算与 DOM,
//      只在首页留一行 .home-profile-entry 入口。进页面时才付这个成本。
//   2) 数据仍然复用首页那份 homeGamesData/homeGamesOwner, 不重复拉接口 ——
//      两块内容的入参本来就是"当前已加载的近期对局", 与首页口径一致。
//   3) 因此必须处理"数据还没加载就进画像页": 显示空状态, 等 loadHomeStats
//      完成后由 refreshProfilePageIfMounted() 补渲染。
function profileHost() {
  return document.getElementById('profilePanel');
}

const PROFILE_EMPTY = '<div class="meta-loading">先到「首页」加载战绩后查看画像</div>';

// 页面标签写的是「我的画像」，但 homeGamesData 在查看其他玩家时是**别人的**战绩。
// 不把归属标出来，用户会把别人的擅长/趣味数据当成自己的 —— 这是误导，不是小瑕疵。
function renderProfileOwnerNote() {
  const note = document.getElementById('profileOwnerNote');
  if (!note) return;
  if (!homeGamesOwner) { note.hidden = true; note.textContent = ''; return; }
  note.hidden = false;
  note.textContent = homeGamesOwnerIsSelf
    ? '当前：你自己（' + (homeGamesOwnerLabel || '未知玩家') + '）'
    : '当前：' + (homeGamesOwnerLabel || '未知玩家') + ' 的数据（不是你自己）';
  note.classList.toggle('is-other', !homeGamesOwnerIsSelf);
}



// 胜率走势图: 折线 = 场均 KDA (带 Y 轴刻度/网格/渐变面积), 圆点颜色 = 胜负, X 轴为日期
function buildHomeTrendChart(games, summoner) {
  const puuid = summoner?.puuid || window._myPuuid;
  if (!puuid) return '';
  const rows = [];
  for (const g of (games || [])) {
    if (rows.length >= 20) break;
    const me = (g.participants || []).find(p => p.puuid === puuid);
    if (!me) continue;
    if (typeof isExcludedGame === 'function' && isExcludedGame({ mode: g.mode, queueId: g.queueId, gameType: g.gameType })) continue;
    rows.push({ win: !!me.win, k: me.k || 0, d: me.d || 0, a: me.a || 0, time: +g.time || 0, mode: g.mode });
  }
  if (rows.length < 4) return '';
  rows.reverse();   // 时间正序
  const n = rows.length;
  const W = 468, H = 178, padL = 36, padR = 16, padT = 16, padB = 30;
  const xAt = i => padL + i * ((W - padL - padR) / (n - 1));
  const kdaOf = r => (r.k + r.a) / Math.max(1, r.d);
  const maxK = Math.max(3, Math.ceil(Math.max(...rows.map(kdaOf)) * 2) / 2);
  const yAt = v => padT + (1 - v / maxK) * (H - padT - padB);
  const fmtD = t => t ? new Date(t).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '';

  // Y 轴刻度 + 横向网格
  let grid = '';
  const steps = 4;
  for (let s = 0; s <= steps; s++) {
    const v = maxK * s / steps;
    const y = yAt(v).toFixed(1);
    grid += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="var(--border)" stroke-width="1"' + (s === 0 ? '' : ' stroke-dasharray="3,4"') + '/>';
    grid += '<text x="' + (padL - 6) + '" y="' + (+y + 3) + '" text-anchor="end" font-size="9" fill="var(--text-muted)">' + (Math.round(v * 10) / 10) + '</text>';
  }
  // X 轴日期 (首/中/末)
  const xTicks = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
  let xLabels = '';
  for (const i of xTicks) {
    const anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    xLabels += '<text x="' + xAt(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' + anchor + '" font-size="9" fill="var(--text-muted)">' + fmtD(rows[i].time) + '</text>';
  }
  // 折线 + 渐变面积
  const linePts = rows.map((r, i) => xAt(i).toFixed(1) + ',' + yAt(kdaOf(r)).toFixed(1));
  const areaPath = 'M' + linePts.join(' L') + ' L' + xAt(n - 1).toFixed(1) + ',' + (H - padB) + ' L' + xAt(0).toFixed(1) + ',' + (H - padB) + ' Z';
  const dots = rows.map((r, i) => {
    const tip = fmtD(r.time) + ' ' + (r.mode || '') + ' ' + r.k + '/' + r.d + '/' + r.a + ' · ' + (r.win ? '胜' : '负');
    return '<circle cx="' + xAt(i).toFixed(1) + '" cy="' + yAt(kdaOf(r)).toFixed(1) + '" r="3" fill="var(--' + (r.win ? 'positive' : 'negative') + ')" stroke="var(--bg-card)" stroke-width="1"><title>' + escapeHtml(tip) + '</title></circle>';
  }).join('');
  const wins = rows.filter(r => r.win).length;
  return '<section class="home-fun"><div class="home-fun-head"><span><b>近 ' + n + ' 场走势</b><small>' + wins + '胜' + (n - wins) + '负 · 折线为场均 KDA, 圆点: 绿胜红负</small></span><em>悬停看单局</em></div>'
    + '<svg class="trend-svg" viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block;">'
    + '<defs><linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="var(--accent)" stop-opacity=".16"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>'
    + '</linearGradient></defs>'
    + grid
    + '<path d="' + areaPath + '" fill="url(#trendFill)"/>'
    + '<polyline points="' + linePts.join(' ') + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>'
    + dots + xLabels
    + '</svg></section>';
}

function renderProfilePage() {
  const host = profileHost();
  if (!host) return;
  if (!homeGamesData?.length || !homeGamesOwner) {
    host.innerHTML = PROFILE_EMPTY;
    delete host.dataset.owner;
  } else {
    const s = { puuid: homeGamesOwner };
    host.innerHTML = buildHomeFunStats(homeGamesData, s) + buildHomeTrendChart(homeGamesData, s) + buildHomeCoach(homeGamesData, s);
    host.dataset.owner = homeGamesOwner;
  }
  renderProfileOwnerNote();
}

// 首页数据更新后, 只有"画像页已经挂载过"或"用户正停在画像页"才需要重算。
// 否则每刷新一次首页就白算一遍教练分析。
function refreshProfilePageIfMounted() {
  const host = profileHost();
  if (!host) return;
  const page = document.getElementById('page-profile');
  if (host.dataset.owner || page?.classList.contains('active')) renderProfilePage();
}

function refreshHomeFunStats() {
  const host = profileHost();
  const old = host && host.querySelector('.home-fun');
  if (!old || !homeGamesData?.length || !homeGamesOwner) return;
  const html = buildHomeFunStats(homeGamesData, { puuid: homeGamesOwner });
  if (html) old.outerHTML = html;
}
// 搜索框的大区下拉: 决定"去哪个区找人", 也就决定了要问几个 SGP 网关。
//   auto  跟随当前登录大区 (默认; 只发 1 条批量请求)
//   all   全部大区 (8 条请求; 同名的人在各区都列出来, 其它区灰显)
//   <pid> 指定大区 (1 条请求)
// 这既省请求, 也让候选列表不再被十几个外区同名账号淹没。
const HOME_REGION_STORE = 'poroHomeRegionPick.v1';
let homeRegionPickCache = null;
function homeRegionPickValue() {
  if (homeRegionPickCache != null) return homeRegionPickCache;
  let v = 'auto';
  try {
    const raw = localStorage.getItem(HOME_REGION_STORE);
    if (raw === 'all') v = 'all';
    else if (raw && typeof SGP_PLATFORM_IDS !== 'undefined' && SGP_PLATFORM_IDS.indexOf(raw) >= 0) v = raw;
  } catch (e) { /* 隐私模式 */ }
  homeRegionPickCache = v;
  return v;
}
function homeCurrentRegion() {
  return (typeof cachedPlatformId === 'string' && cachedPlatformId) ? cachedPlatformId : '';
}
// 实际生效的查询范围: '' = 全部大区
function homeRegionPickRegion() {
  const v = homeRegionPickValue();
  if (v === 'all') return '';
  if (v === 'auto') return homeCurrentRegion();
  return v;
}
function homeRegionSelectHtml() {
  const cur = homeRegionPickValue();
  const parts = [`<option value="auto"${cur === 'auto' ? ' selected' : ''}>跟随当前大区</option>`];
  const ids = (typeof SGP_PLATFORM_IDS !== 'undefined') ? SGP_PLATFORM_IDS : [];
  for (const pid of ids) {
    const name = (typeof SERVER_NAMES !== 'undefined' && SERVER_NAMES[pid]) || pid;
    parts.push(`<option value="${pid}"${cur === pid ? ' selected' : ''}>${escapeHtml(name)}</option>`);
  }
  parts.push(`<option value="all"${cur === 'all' ? ' selected' : ''}>全部大区</option>`);
  return `<select class="home-search-region" id="homeRegionSelect" title="选择在哪个大区找人：选定单个大区只查该区，比「全部大区」少 7 次请求" onchange="onHomeRegionChange(this.value)">${parts.join('')}</select>`;
}
function onHomeRegionChange(value) {
  homeRegionPickCache = value || 'auto';
  try { localStorage.setItem(HOME_REGION_STORE, homeRegionPickCache); } catch (e) { /* 忽略 */ }
  // 范围变了, 之前解析出来的归属与候选不再适用于新范围
  homeAliasCache.clear();
  homeSearchAliasSeq++;
  homeSearchCancelAutoGo();
  homeSearchAutoFired = '';
  renderHomeSearchCards();
  // 用 draft 而不是 input.value: 整页重渲染后 input 可能是新节点, 值为空,
  // 拿它判断会把"刚切完区"当成"没输入", 候选就一直不刷新。
  const v = String(typeof homeSearchDraft === 'string' ? homeSearchDraft : '').trim();
  if (v && homeAliasQueryName(v)) homeSearchScheduleAlias(v);
}

function homeSearchMarkup(placeholderText) {
  return `<div class="home-search">
    ${homeRegionSelectHtml()}
    <div class="home-search-input-wrap">
      <input id="homeSearchInput" value="${escapeHtml(homeSearchInputValue())}" placeholder="${escapeHtml(placeholderText)}" autocomplete="off"
        onfocus="showHomeSearchCards()" onclick="showHomeSearchCards()" oninput="onHomeSearchInput(this.value, event)"
        onblur="setTimeout(hideHomeSearchCards,120)" onkeydown="homeSearchKeydown(event)">
      <div class="home-search-card-popover" id="homeSearchCardPopover"></div>
    </div>
    <button onclick="homeSearch()">查询</button>
    <button class="btn-secondary" onclick="openWeeklyReport()" title="统计最近 7 天的对局数据" style="font-size:12px;">生成周报</button>
    <span class="home-search-msg" id="homeSearchMsg"></span>
  </div>`;
}
// 搜索框候选: 本地玩家索引 (好友 / 最近对局遇到过的人 / 查过的人) + 查询历史。
// 本地索引负责前缀与子串 (输入半个名字就能搜), 远端别名服务负责"陌生玩家 + 全部 Tag":
// Riot Client 的 /player-account/aliases/v1/lookup 只给完整名字就能返回该名字下
// 所有 Riot ID, 但**没有前缀联想** (输入 "雨未" 返回空), 两者互补。
// 候选列表 + 命中总数。total 用于在候选被截断时明确告诉用户"还有几条没显示",
// 否则像"23 个同名只露出 8 个"这种情况会被当成搜索结果缺失。
// 「名字#Tag 前缀」里 Tag 那一段 (只留数字)。没有 # 或 # 后为空 → ''。
function homeSearchTagPrefix(query) {
  const s = String(query == null ? '' : query).replace(/[＃﹟]/g, '#').trim();
  const at = s.lastIndexOf('#');
  return at > 0 ? s.slice(at + 1).replace(/\D/g, '') : '';
}

function homeSearchCandidates(query) {
  const q = String(query || '').trim();
  if (!q || typeof playerIndexSearch !== 'function') return { list: [], total: 0, limit: 0, relax: false, outOfScope: 0, tagPrefix: '' };
  // 打完 # 之后是在挑 Tag, 同名的 Tag 可能一大串
  const limit = q.includes('#') ? HOME_ALIAS_TAG_LIMIT : HOME_ALIAS_NAME_LIMIT;
  const region = typeof homeRegionPickRegion === 'function' ? homeRegionPickRegion() : '';
  // 先取全量再筛再截断: 选定大区时若先截断, 前几条会被外区同名占满,
  // 本区那个人根本露不出来; 全部大区时若先截断, total 也就不是真实命中数了
  const raw = playerIndexSearch(q, HOME_SEARCH_SCAN_MAX);
  const current = typeof homeCurrentRegion === 'function' ? homeCurrentRegion() : '';
  const tagPrefix = homeSearchTagPrefix(q);
  // Tag 前缀够具体时**不再按大区裁**: 用户在按 Tag 认人, 不是在按大区找人。
  // 实测 彩虹海#778 在「艾欧尼亚」范围下 0 条, 而 彩虹海#77843 在联盟一区 ——
  // 界面只回一句"该区没有匹配", 看起来就是 Tag 筛选坏了。放宽后逐条标出大区,
  // 点开照样用该区服务器查战绩。
  const relax = tagPrefix.length >= HOME_TAG_PREFIX_RELAX;
  const inRegion = c => (!region || typeof playerIndexInRegion !== 'function')
    ? true
    : playerIndexInRegion(c, region, current);
  const strict = (!region || typeof playerIndexInRegion !== 'function') ? raw : raw.filter(inRegion);
  // 只打 1 位数字时先按大区筛; 但**筛成 0 条**就退回全部大区 —— 用户已经在按 Tag 认人,
  // 这时候回一句"该区没有"只会让他以为筛选坏了。
  const relaxed = relax || (tagPrefix.length === 1 && strict.length === 0);
  const scoped = relaxed ? raw : strict;
  return {
    list: scoped.slice(0, limit),
    total: scoped.length,
    limit,
    tagPrefix,
    relax: relaxed,
    // 放宽后有几个人其实不在当前选定的大区 (界面要说明"点开是去别的区查")
    outOfScope: (relaxed && region) ? scoped.filter(c => !inRegion(c)).length : 0
  };
}
// 兼容旧调用点 (只想要列表的地方)
function homeSearchCandidateList(query) {
  return homeSearchCandidates(query).list;
}
// 远端别名补全: 本地索引只涵盖"见过的人", 陌生玩家靠 Riot Client 的别名服务 ——
// 给一个**完整名字**就返回该名字下的全部 Tag (实测 "雨未散" 16 条), 这正是
// Akari 那种"不输完整 Tag 也能查"的能力。该接口只认完整名字, 前缀/子串仍由本地索引负责。
const HOME_ALIAS_TTL = 5 * 60 * 1000;
const HOME_ALIAS_DEBOUNCE = 260;
// 空结果只信 20 秒: Riot Client 刚启动 (端口还没解析出来) 或客户端没登录时, 一次
// 失败会被当成"这个名字没人"缓存 5 分钟, 期间怎么改 Tag 都是空的。缓存命中路径
// 会重试到成功为止, 代价只是多一次本机请求。
const HOME_ALIAS_FAIL_TTL = 20 * 1000;
// 通道没通时 (客户端刚启动, --riotclient-app-port 还没写进日志) 当场重试, 别等 20 秒
// 缓存过期: 2026-11-05 用户开机后搜 "小熊冰糖" (国服确有 8 个同名账号) 却看到
// "本地索引里没有匹配的玩家", 就是这一次失败被当成了"没有这个人"。
const HOME_ALIAS_RETRY_DELAY = 1200;
const HOME_ALIAS_RETRY_MAX = 2;
// 输入完整「名字#Tag」后自动查询前的停顿: 够用户打完下一位数字, 又不至于等太久
const HOME_AUTOGO_DELAY = 700;
// 同名不同 Tag 极常见 (实测一个名字下有 16~23 个账号)。上限压得太低会出现
// "提示匹配 23 个、下拉只露 8 个"的情况 —— 用户既看不到剩下的，也点不到。
// 现在一次性全列, 弹层自带滚动, 靠 # 前缀筛 Tag 仍然更快。
const HOME_ALIAS_NAME_LIMIT = 60;
const HOME_ALIAS_TAG_LIMIT = 60;
const HOME_SEARCH_SCAN_MAX = 1200;    // 本地索引 1500 条上限内的扫描量
// 打了几位 Tag 才允许"跨出当前大区": 1 位数字太宽 (彩虹海 315 个同名, 一半以上都以
// 1/2/3 开头), 2 位开始命中数已经收敛到个位数, 这时还按大区把外区的裁掉, 界面上
// 就只剩"该区没有匹配"——用户会以为 Tag 模糊查询坏了 (2026-11-05 实际反馈)。
const HOME_TAG_PREFIX_RELAX = 2;
const homeAliasCache = new Map();     // 小写名字 → { ts, list } (同一次会话不重复打网络)
let homeSearchAliasTimer = null;
let homeSearchAliasSeq = 0;
let homeSearchAutoTimer = null;       // 完整 #Tag 的自动查询定时器
let homeSearchAutoFired = '';         // 已经自动查过的 ID, 同一个值不反复触发

function homeAliasQueryName(raw) {
  const q = String(raw == null ? '' : raw).trim();
  if (!q) return '';
  // "名字#12" 也只用名字去问服务端, Tag 部分由本地筛选
  const at = q.replace(/[＃﹟]/g, '#').lastIndexOf('#');
  return (at > 0 ? q.slice(0, at) : q).trim();
}

// 别名接口是跨大区的: 同名 16 个账号里通常只有 1 个在本区。归属判定分两步:
//   1) SGP 批量查 (8 个合区网关各一条, 实测 250ms 出全部 16 条的大区+等级+头像)
//   2) SGP 不可用时退回逐个问 LCU (200=本区 / 404 "No summoner name" = 其它大区),
//      只能分辨本区与否, 拿不到具体大区
const HOME_ALIAS_RESOLVE_CONCURRENCY = 6;

function homeSelfPuuid() {
  try {
    if (window._myPuuid) return window._myPuuid;
    if (typeof cachedSummoner !== 'undefined' && cachedSummoner && cachedSummoner.puuid) return cachedSummoner.puuid;
  } catch (e) { /* 未登录 */ }
  return '';
}

// 逐个问 LCU (兜底): 200 顺便拿到等级/头像, 404 即其它大区
async function homeAliasResolveByLcu(puuids) {
  const metas = {};
  const list = (puuids || []).filter(Boolean);
  let at = 0;
  async function worker() {
    while (at < list.length) {
      const puuid = list[at++];
      const r = await lolAPI.lcuRequest('GET', '/lol-summoner/v2/summoners/puuid/' + encodeURIComponent(puuid)).catch(() => null);
      if (r && !r.__error && r.puuid) {
        metas[puuid] = { inRegion: true, level: r.summonerLevel || 0, icon: r.profileIconId || 0 };
      } else if (r && (r.httpStatus === 404 || /No summoner name/i.test(r.__error || r.message || ''))) {
        metas[puuid] = { inRegion: false };
      }
    }
  }
  const workers = Math.min(HOME_ALIAS_RESOLVE_CONCURRENCY, list.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return metas;
}

async function homeAliasResolveMetas(puuids, opts) {
  const ids = (puuids || []).filter(Boolean);
  if (!ids.length) return {};
  // opts.allRegions: 用户在按 Tag 前缀筛人, 命中者很可能不在当前大区, 必须问全部
  // 网关才知道他到底属于哪个区 (否则那行只能显示"其它大区", 点开还要再猜一轮)。
  const region = (opts && opts.allRegions) ? '' : homeRegionPickRegion();   // '' = 全部大区
  const mine = homeSelfPuuid();
  // 只查指定大区时, 当前大区如果已知就不用再拿自己当探针 (省一条无关查询)
  const needProbe = !homeCurrentRegion() && mine && ids.indexOf(mine) < 0;
  const probe = needProbe ? ids.concat(mine) : ids;
  let map = {};
  let queried = [];
  if (lolAPI && typeof lolAPI.playerResolveRegions === 'function') {
    const r = await lolAPI.playerResolveRegions(probe, region ? [region] : null).catch(() => null);
    if (r && r.ok) { map = r.map || {}; queried = r.queried || []; }
  }
  let current = (needProbe && map[mine]) ? map[mine].platformId : homeCurrentRegion();
  if (!current) current = await getPlatformId().catch(() => '');
  if (current && current !== cachedPlatformId) cachedPlatformId = current;
  const metas = {};
  const allRegions = (typeof SGP_PLATFORM_IDS !== 'undefined') ? SGP_PLATFORM_IDS.length : 8;
  for (const id of ids) {
    const hit = map[id];
    if (hit) {
      metas[id] = { inRegion: hit.platformId === current, level: hit.level, icon: hit.icon, platform: hit.platformId };
      continue;
    }
    // 没命中只有在"那个区确实查通了"时才敢下结论 —— 否则一次超时就会把本区
    // 账号误标成"其它大区", 之后再也点不开。
    if (!queried.length) continue;
    if (region) {
      // 查的就是本区: 没命中 = 不在本区, 可以标其它大区 (具体哪个区没查, 不知道)。
      // 查的是别的大区: 没命中只说明"不在那个区", 完全可能是本区的人 → 保持未知,
      // 绝不能标 foreign。
      if (queried.indexOf(region) >= 0 && region === current) metas[id] = { inRegion: false };
    } else if (queried.length >= allRegions) {
      metas[id] = { inRegion: false };
    }
  }
  if (!Object.keys(metas).length) return homeAliasResolveByLcu(ids);
  return metas;
}

// 返回新增索引条数; opts.render=false 时不动下拉 (回车查询路径自己会处理展示),
// opts.awaitRegion=true 时等归属解析完成再返回 (回车时用, 保证决策看到的是最终归属)。
// Riot 的别名接口只做**完整名字精确匹配**: 实测 "小慕" → 0 条, "小慕冰" → 1 条,
// 也没有 prefix / search 之类的参数(试过 400 Unknown argument)。
// 以前这里会尾部裁字去"猜相近名字", 2026-11-05 起按 LeagueAkari 的口径取消 ——
// 猜出来的名字会让用户以为系统认错了人, 比直接说查不到更糟。

async function homeSearchFetchAlias(raw, opts) {
  const name = homeAliasQueryName(raw);
  if (!name || name.length > 64) return 0;
  if (!lolAPI || typeof lolAPI.playerAliasLookup !== 'function') return 0;
  if (typeof playerIndexFromAliases !== 'function') return 0;
  const key = name.toLocaleLowerCase();
  const quiet = !!(opts && opts.render === false);
  const typed = String(raw == null ? '' : raw).trim();
  // 用户已经打出的 Tag 前缀: 写入索引时优先保留这些 (他多半就在找它们)
  const tagPrefix = (() => {
    const i = typed.lastIndexOf('#');
    return i > 0 ? typed.slice(i + 1).replace(/\D/g, '') : '';
  })();
  const seq = ++homeSearchAliasSeq;
  const refresh = () => {
    // 结果到手就顺手看一眼能不能自动查 (完整 #Tag 且已定位到本区账号)。
    // quiet = 回车/点选路径自己会处理展示与查询, 别再自动补一刀重复查同一个人。
    if (!quiet) homeSearchScheduleAutoGo();
    // 期间又敲了字: 把重绘权交给最新那一轮, 避免旧结果把新候选顶掉
    // 判断"用户还在等这一轮结果吗"用 draft 而不是 input.value: 首页数据加载完后
    // 整页重渲染会把 input 换成新节点(值可能还没回填), 拿 DOM 判断会误判成"已改词"
    // 而丢掉这次结果。
    const live = String(typeof homeSearchDraft === 'string' ? homeSearchDraft : '').trim();
    if (quiet || live !== typed || seq !== homeSearchAliasSeq) return;
    const el = document.getElementById('homeSearchCardPopover');
    if (el && el.classList.contains('show')) renderHomeSearchCards();
  };

  let list = null;
  let added = 0;
  let skipGenericResolve = false;
  let cacheEntry = homeAliasCache.get(key);
  // 空列表走短 TTL (见 HOME_ALIAS_FAIL_TTL)
  const ttl = (cacheEntry && Array.isArray(cacheEntry.list) && !cacheEntry.list.length)
    ? HOME_ALIAS_FAIL_TTL : HOME_ALIAS_TTL;
  const freshHit = cacheEntry && Date.now() - cacheEntry.ts < ttl;
  if (freshHit) {
    list = cacheEntry.list;
    // 缓存命中也要按**当前**的 Tag 前缀重写一遍索引。用户正常的操作顺序是
    // "先打名字 → 看候选 → 接着补 #Tag": 第一轮是按空前缀截的 60 条 (实测同名
    // 500 条上限), 精确那一条大概率没进去; 以前这里直接 return, 于是接着输
    // 完整 Tag 时下拉永远停在"本地未收录", 只能回车才能查到。
    // 这一步只动本地数据, 零网络成本。
    if (Array.isArray(list) && list.length && typeof playerIndexFromAliases === 'function') {
      if (playerIndexFromAliases(list, null, { tagPrefix }) > 0) refresh();
    }
    // 归属已经解析过就不必再问网关; 上次没解析成 (客户端没登录) 才补一次
    // 注意不能直接 return: 下面还有"Tag 前缀命中的那些人要按全部大区定位"这一步,
    // 它跟"这批名字查没查过归属"是两件独立的事 (缓存里解析的是本区, 前缀命中
    // 的往往在别的区, 那时只会被标成"其它大区")。
    if (cacheEntry.resolvedAt && Date.now() - cacheEntry.resolvedAt < HOME_ALIAS_TTL) skipGenericResolve = true;
  } else {
    let res = null;
    for (let attempt = 0; ; attempt++) {
      try { res = await lolAPI.playerAliasLookup(name); } catch (e) {
        res = { ok: false, list: [], error: String((e && e.message) || e) };
      }
      if (res && res.ok) break;
      if (attempt >= HOME_ALIAS_RETRY_MAX) break;
      // 客户端刚启动时端口还没解析出来, 隔一会儿再问 —— 这条通道一秒钟内恢复很常见
      await new Promise(r => setTimeout(r, HOME_ALIAS_RETRY_DELAY));
      if (String(typeof homeSearchDraft === 'string' ? homeSearchDraft : '').trim() !== typed) return 0;
    }
    // ok=false 只表示"通道没通"(没开 Riot Client / 端口没解析出来), 不等于没有这个人
    if (!res || !res.ok) {
      try { lolAPI.debugLog && lolAPI.debugLog('[SEARCH] 别名通道未就绪 ' + name + ': ' + ((res && res.error) || '?')); } catch (e) { /* 日志失败无所谓 */ }
      homeAliasCache.set(key, { ts: Date.now(), list: [], resolvedAt: 0, unready: true });
      refresh();
      return 0;
    }
    if (!Array.isArray(res.list) || !res.list.length) {
      // 记成 miss: 下拉里要能说清"是服务端没有这个人", 而不是"本地没收录"
      try { lolAPI.debugLog && lolAPI.debugLog('[SEARCH] 别名查无此人 ' + name); } catch (e) { /* 忽略 */ }
      homeAliasCache.set(key, { ts: Date.now(), list: [], resolvedAt: 0, miss: name });
      refresh();
      return 0;
    }
    list = res.list;
    cacheEntry = { ts: Date.now(), list, resolvedAt: 0 };
    homeAliasCache.set(key, cacheEntry);
    added = playerIndexFromAliases(list, null, { tagPrefix });
    // 先把候选摆出来 (归属未知), 别让归属查询把列表卡住
    if (added > 0) refresh();
  }

  // ---- Tag 前缀命中的人: 在**全部大区**里定位 ----
  // 用户按 Tag 认人时, 命中者大概率不在当前选定的大区 (彩虹海#77843 在联盟一区,
  // 而范围是艾欧尼亚)。只按当前区查归属的话, 那行只能显示"其它大区", 点开还得
  // 再猜一轮; 而且 candidates 那边已经放宽了大区过滤, 这里必须给得出一致的信息。
  if (tagPrefix.length >= 1) {
    const prefixed = (list || [])
      .filter(x => String((x && (x.tagLine || x.tag)) || '').startsWith(tagPrefix))
      .map(x => x && x.puuid).filter(Boolean);
    if (prefixed.length) {
      // 已经知道具体大区的不用再问 (切一次前缀就会重走这里, 别每次都打 8 个网关)
      const unknown = typeof playerIndexNeedRegion === 'function'
        ? new Set(playerIndexNeedRegion(list, { needPlatform: true }))
        : new Set(prefixed);
      const todo = prefixed.filter(p => unknown.has(p));
      if (todo.length) {
        const job = homeAliasResolveMetas(todo, { allRegions: true }).then(metas => {
          cacheEntry.resolvedAt = Date.now();
          if (!Object.keys(metas).length) return;
          playerIndexFromAliases(list, metas, { tagPrefix });
          refresh();
        }).catch(() => {});
        if (opts && opts.awaitRegion) await job;
      }
      return added;
    }
  }
  if (skipGenericResolve) return added;

  // 全部大区模式要连"只判过不在本区、还没问出具体区名"的一起补 —— 否则切过来
  // 只能看到一排"其它大区", 白费 8 条请求
  const pending = typeof playerIndexNeedRegion === 'function'
    ? playerIndexNeedRegion(list, { needPlatform: !homeRegionPickRegion() })
    : [];
  if (pending.length) {
    const job = homeAliasResolveMetas(pending).then(metas => {
      cacheEntry.resolvedAt = Date.now();
      if (!Object.keys(metas).length) return;
      playerIndexFromAliases(list, metas, { tagPrefix });
      refresh();
    }).catch(() => {});
    if (opts && opts.awaitRegion) await job;
  }
  return added;
}

function homeSearchScheduleAlias(value) {
  if (homeSearchAliasTimer) clearTimeout(homeSearchAliasTimer);
  if (!homeAliasQueryName(value)) return;
  homeSearchAliasTimer = setTimeout(() => {
    homeSearchAliasTimer = null;
    homeSearchFetchAlias(value);
  }, HOME_ALIAS_DEBOUNCE);
}

// 完整「名字#Tag」= 用户已经把账号指定到唯一一个了, 不该再逼他按一次回车。
// 判定条件全部满足才自动查, 缺一条都留给用户自己决定:
//   1) 输入法/焦点还在搜索框里, 而且值没变 (人已经走了或改了字就别抢)
//   2) 没有用 ↑↓ 手动高亮别的候选 (那说明他在挑, 不是在等自动跳)
//   3) 本地索引能精确对到这条, 且不是明确在别的区 (查了也是空白)
// 别名结果一回来就会重新调一次, 所以"先打名字、再补 Tag"这条路径也覆盖得到。
function homeSearchCancelAutoGo() {
  if (homeSearchAutoTimer) { clearTimeout(homeSearchAutoTimer); homeSearchAutoTimer = null; }
}

function homeSearchScheduleAutoGo() {
  const raw = String(homeSearchLiveValue() || '').trim()
    .replace(/[＃﹟]/g, '#');
  if (!raw || typeof playerIndexAutoGoTarget !== 'function') return;
  if (homeSearchAutoFired === raw) return;
  homeSearchCancelAutoGo();
  homeSearchAutoTimer = setTimeout(() => {
    homeSearchAutoTimer = null;
    const input = document.getElementById('homeSearchInput');
    const live = String(homeSearchLiveValue() || '').trim().replace(/[＃﹟]/g, '#');
    if (!input || document.activeElement !== input) return;
    if (live !== raw || homeSearchActive >= 0) return;
    const label = playerIndexAutoGoTarget(raw);
    if (!label) return;
    homeSearchAutoFired = raw;
    selectHomeSearchCandidate(label);
  }, HOME_AUTOGO_DELAY);
}

function homeServerLabel() {
  return (typeof cachedPlatformId === 'string' && cachedPlatformId && typeof SERVER_NAMES !== 'undefined')
    ? (SERVER_NAMES[cachedPlatformId] || cachedPlatformId) : '';
}
function homeRegionName(platformId) {
  if (!platformId) return '';
  return typeof SERVER_NAMES !== 'undefined' ? (SERVER_NAMES[platformId] || platformId) : platformId;
}

function homeSearchCardHtml() {
  // 以输入框里真正显示的内容为准: draft 可能还停在输入法的拼音上
  const raw = String(homeSearchLiveValue() || '').trim();
  const q = raw;
  const candPack = homeSearchCandidates(q);
  const cands = candPack.list;
  // 这一轮名字在别名服务上的结果: 空列表说明服务端确实没有这个完整名字,
  // 只有 miss/unready 两种状态要在界面上说清楚 (不再有"近似名字"这条路径)。
  const aliasName = typeof homeAliasQueryName === 'function' ? homeAliasQueryName(raw) : '';
  const aliasEntry = aliasName ? homeAliasCache.get(aliasName.toLocaleLowerCase()) : null;
  // 别名接口命中 = 线上确实存在这个完整名字的账号(可能多个区); 这是"同名账号"的唯一来源
  const aliasHits = (aliasEntry && Array.isArray(aliasEntry.list)) ? aliasEntry.list : [];
  const aliasMiss = !!(aliasEntry && aliasEntry.miss);
  const aliasUnready = !!(aliasEntry && aliasEntry.unready);
  const seen = new Set(cands.map(c => piNorm(c.label)));
  const hist = homeSearchHistory
    .filter(v => !seen.has(piNorm(v)) && (!q || piNorm(v).includes(piNorm(q))))
    .slice(0, 6);
  // "名字#" 末尾刚好一个井号: 提示可以继续输数字筛 Tag
  const tagOpen = /[#＃]$/.test(raw);
  let html = '';
  if (cands.length) {
    const srcText = c => c.src === 'friend' ? '好友' : c.src === 'match' ? '对局' : c.src === 'alias' ? '同名' : c.src === 'search' ? '查过' : '';
    // 标题写明"正在哪个区找": 选定大区时只查这一个区, 不标清楚会让人以为
    // 同名的人只在这个区有
    const scope = homeRegionPickRegion();
    const regionLabel = scope ? (homeRegionName(scope) || scope) : '全部大区';
    // 按 Tag 前缀筛选时范围已经放宽到全部大区 (见 homeSearchCandidates.relax),
    // 标题再写"· 艾欧尼亚"会自相矛盾 —— 底下明明列着别的区的人。
    const scopeName = candPack.relax ? '按 Tag 前缀筛选' : regionLabel;
    const curRegion = homeCurrentRegion();
    // 每条候选属于哪个大区: 「全部大区」模式下必须逐条标出来, 否则 20 多个同名
    // 账号排在一起完全分不清哪个是本区的、哪个点进去是空白。选定单一区时标题
    // 已经写了区名, 只在"别的区"的条目上标(预防混合情况)。
    const regionOf = c => {
      if (c.platform) return homeRegionName(c.platform) || c.platform;
      if (c.foreign) return '其它大区';
      if (c.regionUnknown) return '归属待定';
      return homeRegionName(curRegion) || '本区';
    };
    const showRegionAll = !scope;
    // 候选一多, 横排换行会挤成一片, 改成单列竖排 (每行一个人 + 区名), 便于扫读
    const rowClass = cands.length > 6 ? 'hs-row hs-list' : 'hs-row';
    // 分组渲染 (对齐 Akari 的"搜索结果=线上验证过的账号"): 线上同名永远在第一组,
    // 本地"最近遇到"降为第二组。以前单列表混排, alias 命中可能被一排本地记录
    // 淹在中间, 看起来和 Akari 完全不一样。
    const groups = [
      { key: 'alias', title: '同名账号', hint: '', list: cands.filter(c => c.src === 'alias') },
      { key: 'local', title: '最近遇到', hint: '本地记录，只包含遇到过的玩家', list: cands.filter(c => c.src !== 'alias') }
    ].filter(g => g.list.length);
    if (groups.length === 1 && groups[0].key === 'alias') {
      groups[0].hint = aliasHits.length > 1 ? `线上同名 ${aliasHits.length} 个，按大区区分` : '线上查到的完整同名账号';
    }
    const rowHtml = (c, i) => {
      const src = srcText(c);
      // 放宽大区后, "不在当前大区"的条目必须标区名, 否则用户不知道自己点开的是别的区
      const inScope = !scope || (typeof playerIndexInRegion === 'function' ? playerIndexInRegion(c, scope, curRegion) : true);
      const region = (showRegionAll || c.foreign || (candPack.relax && !inScope)) ? regionOf(c) : '';
      // 候选行带头像 (Akari 的结果行是头像+名字+区+等级): 索引条目存了 icon
      const avatar = c.icon ? profileIcon(c.icon) : placeholder((c.name || '?')[0] || '?');
      return `<div class="home-search-record-card${c.foreign ? ' hs-foreign' : ''}" data-hs-kind="player" data-hs-pick="${escapeHtml(c.label)}" data-hs-idx="${i}" onmousedown="event.preventDefault();selectHomeSearchCandidate(${inlineArg(c.label)})" title="${escapeHtml(c.foreign ? '这条 ID 在' + region + '，点开用该区服务器查战绩' : '查询 ' + c.label + (region ? '（' + region + '）' : ''))}">
        <img class="hs-avatar" src="${avatar}" onerror="this.style.visibility='hidden'">
        <span class="hs-pick-name">${escapeHtml(c.label)}</span>
        ${region ? `<span class="hs-meta${c.foreign ? ' hs-foreign-tag' : ' hs-region-here'}">${escapeHtml(region)}</span>` : ''}
        ${c.level ? `<span class="hs-meta">Lv${escapeHtml(String(c.level))}</span>` : ''}
        ${!c.foreign && src ? `<span class="hs-meta">${src}</span>` : ''}
      </div>`;
    };
    let idx = 0;
    for (const g of groups) {
      html += `<div class="hs-title">${g.title} · ${escapeHtml(g.key === 'alias' ? scopeName : '本地')}` 
        + `<span class="hs-count">${escapeHtml(g.hint)}${g.key === 'alias' && candPack.total > cands.length ? ' · 匹配 ' + candPack.total + ' 条' : ''}</span></div>`;
      html += `<div class="${rowClass}">` + g.list.map(c => rowHtml(c, idx++)).join('') + '</div>';
    }
    if (tagOpen) html += '<div class="hs-hint">继续输入数字可按 Tag 前缀筛选，↑↓ 选择，回车确认</div>';
    else if (candPack.relax) {
      // 说明"为什么这里会出现别的大区的人": 不解释的话, 选了艾欧尼亚却看到联盟一区
      // 的账号会被当成筛选出错。
      html += `<div class="hs-hint">Tag 前缀「${escapeHtml(candPack.tagPrefix)}」命中 ${candPack.total} 个`
        + (candPack.outOfScope ? `，其中 ${candPack.outOfScope} 个不在${escapeHtml(regionLabel)}（点开即用该区服务器查战绩）` : '')
        + '</div>';
    }
    else if (candPack.total > cands.length) html += `<div class="hs-hint">命中 ${candPack.total} 个，已显示前 ${cands.length} 个：输入 # 可按 Tag 筛选</div>`;
    else if (cands.length >= 12) html += '<div class="hs-hint">候选较多，可滚动查看；输入 # 后跟数字可筛 Tag</div>';
  }
  if (hist.length) {
    html += '<div class="hs-title">最近查询</div>';
    html += '<div class="hs-row">' + hist.map(value => `<div class="home-search-record-card" data-hs-kind="hist" data-hs-pick="${escapeHtml(value)}" onmousedown="event.preventDefault();selectHomeSearchHistory(${inlineArg(value)})" title="${escapeHtml('查询 ' + value)}">
      <span class="home-search-record-icon">↺</span>
      <span>${escapeHtml(value)}</span>
    </div>`).join('') + '</div>';
  }
  if (!html) {
    const total = playerIndexSize();
    const scope = homeRegionPickRegion();
    // 输入已经是完整「名字#Tag」时, 本地没收录不等于"没有这个人" —— 回车就是
    // 让客户端按 Riot ID 直查。旧文案在这里说"输入完整名字#Tag 仍可直接查询",
    // 但用户明明已经输入完整了, 看起来就像在说"查无此人"。
    const fullTag = typeof playerIndexFullTag === 'function' && playerIndexFullTag(q);
    if (q) {
      // 粘贴的是一串 PUUID: 不是名字, 给一条直查行 (Akari 的搜索框直接支持 puuid)
      if (typeof looksLikePuuid === 'function' && looksLikePuuid(q)) {
        html = '<div class="hs-title">按 PUUID 查询</div><div class="hs-row">'
          + `<div class="home-search-record-card hs-go" data-hs-kind="go" data-hs-pick="${escapeHtml(q)}" onmousedown="event.preventDefault();selectHomeSearchCandidate(${inlineArg(q)})" title="向客户端查询这个 PUUID">`
          + '<span class="home-search-record-icon">⏎</span>'
          + `<span class="hs-pick-name">PUUID · ${escapeHtml(q.slice(0, 13))}…</span>`
          + '<span class="hs-meta">回车直查</span>'
          + '</div></div>';
      } else if (fullTag) {
        // 完整 ID 时把"回车"做成可点的一行: 光写一行文字, 鼠标用户会以为只是提示,
        // 而键盘用户又不知道必须再按一次回车。自动查询 (homeSearchScheduleAutoGo)
        // 成功跳走之前它会一直在这儿。
        html = '<div class="hs-title">直接查询</div><div class="hs-row">'
          + `<div class="home-search-record-card hs-go" data-hs-kind="go" data-hs-pick="${escapeHtml(q)}" onmousedown="event.preventDefault();selectHomeSearchCandidate(${inlineArg(q)})" title="向客户端查询 ${escapeHtml(q)}">`
          + '<span class="home-search-record-icon">⏎</span>'
          + `<span class="hs-pick-name">${escapeHtml(q)}</span>`
          + '<span class="hs-meta">不在本地索引</span>'
          + '</div></div>'
          + '<div class="hs-hint">点击或按回车向客户端查询；也可以只输名字，从同名列表里挑</div>';
      } else if (aliasUnready) {
        html = '<div class="hs-empty">Riot Client 还没连上，现在只能搜遇到过的玩家<br>启动英雄联盟客户端后会自动恢复</div>';
      } else if (aliasMiss) {
        // 服务端明确回答"没有这个名字"。2026-11-05 起候选层只对完整名字负责
        // (对齐 LeagueAkari): 这里必须说清"名字要完整", 不能让人以为是本地没收录。
        html = aliasName.length <= 3
          ? `<div class="hs-empty">「${escapeHtml(aliasName)}」太短，不可能是完整名字<br>只输一半只能匹配本地遇到过的玩家（上面没有就是没遇到过）</div>`
          : `<div class="hs-empty">线上没有「${escapeHtml(aliasName)}」这个完整名字的账号<br>Riot ID 只按完整名字精确匹配（多一个字少一个字都查不到）<br>如果这只是一半的名字，那就只能匹配遇到过的玩家</div>`;
      } else if (candPack.tagPrefix && candPack.tagPrefix.length >= HOME_TAG_PREFIX_RELAX && aliasHits.length) {
        // 名字确实存在, 但这个名字下没有以该前缀开头的 Tag —— 这是"筛空了",
        // 不是"查不到这个人"。把同名账号数量与样例列出来, 用户才知道该删几位。
        const samples = aliasHits.slice(0, 3).map(x => aliasName + '#' + (x.tagLine || '')).join('、');
        html = `<div class="hs-empty">「${escapeHtml(aliasName)}」名下没有以 ${escapeHtml(candPack.tagPrefix)} 开头的 Tag<br>线上同名 ${aliasHits.length} 个，例如 ${escapeHtml(samples)}<br>少输几位再试，或只输名字从同名列表里挑</div>`;
      } else if (scope) {
        html = `<div class="hs-empty">${escapeHtml(homeRegionName(scope) || scope)} 里没有匹配的账号<br>切到「全部大区」可以看其它区的同名 ID</div>`;
      } else {
        html = '<div class="hs-empty">遇到过的玩家里没有匹配的<br>输入完整「名字#Tag」后按回车可直接查询（会去线上查，不受本地记录限制）</div>';
      }
    } else if (!total) html = '<div class="hs-empty">还没有记录过任何玩家<br>打开首页加载一次战绩后，遇到过的人就能只输名字搜到</div>';
    else html = `<div class="hs-empty">输入完整名字搜索线上账号；只输一半时匹配本地 ${total} 位遇到过的玩家</div>`;
  }
  return html;
}
let homeSearchActive = -1;
function renderHomeSearchCards(noNet) {
  const el = document.getElementById('homeSearchCardPopover');
  if (!el) return;
  el.innerHTML = homeSearchCardHtml();
  // 候选多 = 单列 + 名字/区名/等级/来源四个元素挤在一行, 弹层太窄会把名字
  // 压成省略号, 所以这时给弹层一个更宽的基准宽度
  el.classList.toggle('hs-pop-wide', !!el.querySelector('.hs-row.hs-list'));
  el.classList.add('show');
  homeSearchActive = -1;   // 内容变了就清掉高亮, 免得高亮停在别的条目上
  // noNet: 输入法合成期间的本地重渲染, 不补发网络请求 (值可能是拼音中间态)
  if (!noNet) homeSearchEnsureAlias();
}

// 兜底再发一次别名请求: 名字已经在框里, 但这一轮从来没发出过请求 (输入法合成结束、
// 首页整页重渲染都可能让最后一次 oninput 丢掉) 时, 下拉会永远停在"本地没收录"。
// 只补发, 不重复打: 缓存里刚有结果的 (成功或失败) 一律放过。
function homeSearchEnsureAlias() {
  if (homeSearchAliasTimer) return;
  const raw = String(homeSearchLiveValue() || '').trim();
  const name = homeAliasQueryName(raw);
  if (!name || name.length > 64) return;
  const entry = homeAliasCache.get(name.toLocaleLowerCase());
  if (entry) {
    const ttl = (Array.isArray(entry.list) && entry.list.length) ? HOME_ALIAS_TTL : HOME_ALIAS_FAIL_TTL;
    if (Date.now() - entry.ts < ttl) return;
  }
  homeSearchScheduleAlias(raw);
}
function showHomeSearchCards() {
  renderHomeSearchCards();
}
function hideHomeSearchCards() {
  document.getElementById('homeSearchCardPopover')?.classList.remove('show');
  homeSearchActive = -1;
}
// 输入法(拼音)合成状态。2026-11-05 实测事故: 用户打「巧丝绒」时, 输入框里依次
// 出现 qiao'si'rong / 巧si'rong / 巧丝 / 巧丝rong'mao 这些**拼音串**, 每一次都被
// 当成"名字"发去 Riot 别名服务, 于是满屏"查无此人"; 而上屏后的「巧丝绒」国服
// 明明有 3 个账号(#28970/#55366/#71906), 界面却只剩两条按编辑距离凑出来的
// 「巧克力」「巧遇記」。根因就是合成期间的 value 被当成了输入内容。
let homeSearchComposing = false;

// 合成事件**必须 addEventListener 绑定** (1.5.107 探针实证): Chromium 不支持
// oncompositionstart/oncompositionend 内联内容属性 —— 属性写在标记上、
// getAttribute 也拿得到, 但编译不出事件处理器 (inp.oncompositionend === undefined,
// dispatchEvent 也不触发), Firefox 才支持。1.5.95~1.5.106 的内联绑定全是死代码,
// 中文上屏后 compositionend 从未到达 → 上屏后的 alias 补发从未发生
// (2026-11-06 用户输「黑凤体育生」零请求, 下拉只剩本地空态提示)。
// 用 document 捕获委托: 输入框会被整页重渲染换掉, 委托不怕节点重建。
if (typeof document !== 'undefined') {
  document.addEventListener('compositionstart', e => {
    if (e.target && e.target.id === 'homeSearchInput') homeSearchComposing = true;
  }, true);
  document.addEventListener('compositionend', e => {
    if (e.target && e.target.id === 'homeSearchInput') {
      homeSearchComposing = false;
      // Chromium 的合成收尾顺序: 最后一个 input(isComposing=true) → compositionend,
      // 之后**没有**普通 input 事件。这里是合成文本唯一能进"非合成"路径的入口。
      onHomeSearchInput(typeof e.target.value === 'string' ? e.target.value : '');
    }
  }, true);
}

// 输入框里的真实值。整页重渲染、输入法合成都可能让 homeSearchDraft 落后于 DOM,
// 所有"按什么搜"的判断都从这里取, 免得拿拼音或上一轮的值去查。
function homeSearchLiveValue() {
  const el = document.getElementById('homeSearchInput');
  if (el && typeof el.value === 'string') {
    if (el.value !== homeSearchDraft) homeSearchDraft = el.value;
    return el.value;
  }
  return typeof homeSearchDraft === 'string' ? homeSearchDraft : '';
}
// 重绘模板时写回输入框的值: 优先用 DOM 里正在显示的内容(用户看得见的那个)
function homeSearchInputValue() {
  return homeSearchLiveValue();
}

function onHomeSearchInput(value, ev) {
  // 统一规则 (1.5.106, 收掉 1.5.95/104/105 三次补丁):
  //   本地渲染 —— 永远执行。渲染只读索引和别名缓存, 不出网, 合成态画下拉无害。
  //   网络/自动查询 —— 只在非合成态执行。拼音中间态永远不 alias、不 autoGo。
  // 以前是"合成态整件事都不做", 结果 1.5.104 (伊莉丝#5) 和 1.5.105 (baby#0)
  // 先后被"数字也走合成""英文也走合成"咬到 —— 条件怎么收都有漏的输入法。
  // 现在渲染与出网解耦, 不再依赖任何对输入法行为的猜测。
  const composing = !!(ev && ev.isComposing === true);
  homeSearchComposing = composing;
  homeSearchDraft = value;
  // 值变了就允许下一次自动查询 (同一个 ID 只自动跳一次, 否则他删了重打会跳不动)
  if (!composing &&
      String(value == null ? '' : value).trim().replace(/[＃﹟]/g, '#') !== homeSearchAutoFired) {
    homeSearchAutoFired = '';
  }
  // 合成态补一步零网络重写: 名字已 alias 过 (缓存有 list) 且正在输 #Tag 时,
  // 按新前缀重排索引 —— 否则同名一大堆 (实测 黑皮体育生 500 条, 索引只装下
  // Tag 升序前 60) 时, 后输的 Tag 段命中的账号不在那 60 条里, 合成态本地
  // 筛出 0 行, 上屏后才"突然蹦出来"。
  if (composing) homeAliasRewriteFromCache(value);
  renderHomeSearchCards(composing);   // 合成态 noNet
  if (!composing) {
    homeSearchScheduleAlias(value);
    homeSearchScheduleAutoGo();
  }
}

// 从别名缓存按**当前输入**的 Tag 前缀重写索引。纯本地 (读缓存+写索引), 不发请求;
// 没缓存/没打到 # 时不做任何事。合成态与非合成态都安全。
function homeAliasRewriteFromCache(raw) {
  if (typeof homeAliasQueryName !== 'function' || typeof playerIndexFromAliases !== 'function') return false;
  const name = homeAliasQueryName(raw);
  if (!name) return false;
  const entry = homeAliasCache.get(name.toLocaleLowerCase());
  if (!entry || !Array.isArray(entry.list) || !entry.list.length) return false;
  const typed = String(raw == null ? '' : raw).trim();
  const at = typed.lastIndexOf('#');
  const tagPrefix = at > 0 ? typed.slice(at + 1).replace(/\D/g, '') : '';
  return playerIndexFromAliases(entry.list, null, { tagPrefix }) > 0;
}
// 键盘操作 (Akari 的手感): ↑↓ 在候选里移动, 回车选中高亮项, Esc 收起。
// 没高亮时回车仍走 homeSearch 的原有决策。
function homeSearchKeydown(ev) {
  // 输入法选词时的回车/方向键属于输入法, 不能拿来选候选或直接查询。
  // 只信事件自带的字段: 合成中的 keydown 恒为 isComposing/229 (Chromium 保证)。
  // 不再用 homeSearchComposing 粘性标记 —— 输入法若不发 compositionend,
  // 它会永远挂着, 之后回车全部失效 (2026-11-06 收口)。
  if (ev.isComposing || ev.keyCode === 229) return;
  const el = document.getElementById('homeSearchCardPopover');
  const rows = el ? Array.from(el.querySelectorAll('.home-search-record-card')) : [];
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    if (!rows.length) return;
    ev.preventDefault();
    const step = ev.key === 'ArrowDown' ? 1 : -1;
    const next = homeSearchActive < 0
      ? (step > 0 ? 0 : rows.length - 1)
      : (homeSearchActive + step + rows.length) % rows.length;
    rows.forEach(r => r.classList.remove('hs-active'));
    rows[next].classList.add('hs-active');
    homeSearchActive = next;
    if (rows[next].scrollIntoView) rows[next].scrollIntoView({ block: 'nearest' });
    return;
  }
  if (ev.key === 'Escape') { hideHomeSearchCards(); return; }
  if (ev.key !== 'Enter') return;
  const active = rows[homeSearchActive];
  if (active) {
    const pick = active.dataset.hsPick;
    if (pick) {
      ev.preventDefault();
      if (active.dataset.hsKind === 'hist') selectHomeSearchHistory(pick);
      else selectHomeSearchCandidate(pick);
      return;
    }
  }
  // Tag 前缀已经把范围收窄到唯一一个人 (彩虹海#778 → 只剩 彩虹海#77843) 时,
  // 回车就该直接打开他。否则回车会去"按名字查", 反而不认这个半截 ID。
  const tagPrefix = typeof homeSearchTagPrefix === 'function' ? homeSearchTagPrefix(homeSearchLiveValue()) : '';
  const players = rows.filter(r => r.dataset.hsKind === 'player' && r.dataset.hsPick);
  if (tagPrefix.length >= HOME_TAG_PREFIX_RELAX && players.length === 1) {
    ev.preventDefault();
    selectHomeSearchCandidate(players[0].dataset.hsPick);
    return;
  }
  homeSearch();
}
// 其它大区(ID 归属在国服别的合区): LCU 只认本区 puuid, 按名字查必然 404, 但国服
// 8 个合区网关都开放了 SGP, 拿索引里的 puuid 就能直接跨区取档案与战绩。
// 以前这里一律放弃, 用户只能看到「在黑色玫瑰，当前是艾欧尼亚，查不到战绩」。
// 返回 true 表示已经接手查询。
function homeOpenIndexedPlayer(label) {
  const hit = typeof playerIndexFind === 'function' ? playerIndexFind(label) : null;
  if (!hit || !hit.puuid) return false;
  const platform = hit.platform || '';
  if (platform && typeof rememberPlayerPlatform === 'function') rememberPlayerPlatform(hit.puuid, platform);
  const sp = piSplitName(label);
  const input = document.getElementById('homeSearchInput');
  homeSearchAutoFired = label;   // 已经按这个 ID 查了, 别再自动补一刀
  homeSearchDraft = label;
  if (input) input.value = label;
  hideHomeSearchCards();
  searchPlayerByPuuid(hit.puuid, label, {
    puuid: hit.puuid,
    gameName: sp.name || '',
    tagLine: sp.tag || '',
    displayName: label,
    profileIconId: hit.icon || -1,
    summonerLevel: hit.level || ''
  }, { platformId: platform });
  return true;
}
function selectHomeSearchCandidate(label) {
  // 已经有人在查这个 ID 了, 取消待触发的自动查询, 避免同一个人被查两遍
  homeSearchCancelAutoGo();
  const norm = String(label == null ? '' : label).trim().replace(/[＃﹟]/g, '#');
  const input = document.getElementById('homeSearchInput');
  const msg = document.getElementById('homeSearchMsg');
  // 点的是 PUUID 直查行: 不当名字查
  if (typeof looksLikePuuid === 'function' && looksLikePuuid(norm)) {
    hideHomeSearchCards();
    searchPlayerByPuuidRaw(norm);
    return;
  }
  // 其它大区的 ID: 本地索引里有 puuid, 直接跨区查; 连 puuid 都没有才提示
  const hit = typeof playerIndexFind === 'function' ? playerIndexFind(label) : null;
  if (hit && hit.foreign && hit.puuid && typeof homeOpenIndexedPlayer === 'function') {
    if (msg) msg.textContent = '';
    if (homeOpenIndexedPlayer(label)) return;
  }
  homeSearchAutoFired = norm;   // 已经按这个 ID 查了, 别再自动补一刀
  homeSearchDraft = label;
  if (input) input.value = label;
  hideHomeSearchCards();
  // 用户已经明确点了某一条, 直接按这个完整 ID 查 —— 不再走"猜测+自动补全"那条路,
  // 否则归属还没解析出来的候选会被再弹一次选择框。
  searchPlayerByName(label);
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
  // 顺手进本地索引: 查过的人下次可以只输名字
  if (typeof playerIndexUpsert === 'function') {
    const sp = piSplitName(normalized);
    if (sp.name && sp.tag) playerIndexUpsert([{ name: sp.name, tag: sp.tag }], 'search');
  }
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
// 平台标识归一化: 把客户端各处返回的写法统一成 Poro 内部使用的 platformId。
// 国服 /riotclient/region-locale 返回 {region:"TENCENT", webRegion:"staging.na"} ——
// 既不等于 "CN", 也不在任何平台列表里。此前没映射, 归一化结果为空, 于是
// isTencentPlatform('') 判成 false, 国服玩家被当成"Riot 外服"去查 LCU 战绩接口,
// 而国服 LCU 的 /lol-match-history 返回 HTTP 500 "Error getting match list for
// summoner" → 点击他人 ID 查看战绩必然失败（自己首页有持久缓存兜底, 所以看不出）。
const PLATFORM_ALIASES = {
  NA: 'NA1', EUW: 'EUW1', EUNE: 'EUN1', EUN: 'EUN1', BR: 'BR1', LAN: 'LA1', LAS: 'LA2',
  JP: 'JP1', OCE: 'OC1', OC: 'OC1', TR: 'TR1', PH: 'PH2', SG: 'SG2', TH: 'TH2', TW: 'TW2', VN: 'VN2',
  TENCENT: 'HN1', CN: 'HN1'
};
function normalizePlatformId(raw) {
  const key = String(raw || '').toUpperCase();
  if (!key) return '';
  if (PLATFORM_ALIASES[key]) return PLATFORM_ALIASES[key];
  return (RIOT_PLATFORM_IDS.includes(key) || SGP_PLATFORM_IDS.includes(key)) ? key : '';
}
async function getPlatformId() {
  if (cachedPlatformId) return cachedPlatformId;
  const st = await lolAPI.lcuStatus();
  // 只接受能归一化成已知平台的值。未知值（如国服的 "TENCENT"）不能直接当平台用,
  // 否则会被 isTencentPlatform 判成外服, 把国服玩家路由到不可用的 LCU 战绩接口。
  const direct = normalizePlatformId(st?.summoner?.platformId || st?.summoner?.currentPlatformId);
  if (direct) { cachedPlatformId = direct; return cachedPlatformId; }
  // 只取 1 场拿 platformId；国服与 Riot 外服的历史对象都带该字段。
  const hist = await lolAPI.lcuRequest("GET", `/lol-match-history/v1/products/lol/${st.summoner.puuid}/matches?begIndex=0&endIndex=1`);
  const fromHistory = normalizePlatformId(hist?.games?.games?.[0]?.platformId);
  if (fromHistory) { cachedPlatformId = fromHistory; return cachedPlatformId; }
  // 新账号没有历史时，从 Riot 客户端区域配置识别。不同版本返回 platformId/region/webRegion 之一。
  const platformCfg = await lolAPI.lcuRequest('GET', '/lol-platform-config/v1/namespaces/PlayerPlatformEdgeService').catch(() => null);
  const regionCfg = await lolAPI.lcuRequest('GET', '/riotclient/region-locale').catch(() => null);
  const raw = platformCfg?.platformId || platformCfg?.region || regionCfg?.region || regionCfg?.webRegion;
  // 三条路径都失败时按国服处理（本产品主要面向国服; 外服的 region 一定能被上面的
  // 映射表命中, 走到这里说明客户端状态异常, 默认国服比默认"外服"安全得多）。
  cachedPlatformId = normalizePlatformId(raw) || 'HN1';
  if (!normalizePlatformId(raw)) {
    try { lolAPI.debugLog(`[HOME] 平台识别失败, 按国服处理 raw=${String(raw || '')}`); } catch (e) {}
  }
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
      if (response?.__error) {
        // 大区已经确定了（召唤师档案查得到），只是战绩接口挂了。把这份信息挂在错误上
        // 传给调用方，否则调用方只能显示"大区: 待识别"，把"服务暂时不可用"误报成
        // "这个人查不到"，用户会以为功能坏了。
        const err = new Error(response.__error);
        err.platformId = hit.platformId;
        err.summoner = hit.summoner;
        throw err;
      }
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
        partyId: p.partyId ?? p.premadeId ?? p.partyIdHash ?? p.playerPartyId ?? p.player?.partyId ?? '',
        name: p.riotIdGameName || p.summonerName || p.riotId || p.summonerNameLocal || p.player?.summonerName || p.player?.riotIdGameName || "",
        tagLine: p.riotIdTagline || p.player?.riotIdTagline || "",
        championId: normalizeChampId(p.championId),
        progressDataComplete: [p.deaths, p.totalDamageDealtToChampions, p.goldEarned].every(v => v != null && Number.isFinite(Number(v))),
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
        partyId: p.partyId ?? p.premadeId ?? p.partyIdHash ?? p.playerPartyId ?? ident?.player?.partyId ?? '',
        progressDataComplete: [p.stats?.deaths, p.stats?.totalDamageDealtToChampions, p.stats?.goldEarned].every(v => v != null && Number.isFinite(Number(v))),
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
// puuid→段位缓存 (战绩详情/实时页用)
// 调用方直接按 rankCache[puuid] 读取, 所以仍保持"puuid → queueMap"的原结构, 过期时间另记在 rankCacheAt。
// 原先写入后永不过期: 一次会话里队友的段位一直是旧的; 查询失败还会写成 {} 永久缓存, 之后不再重试。
const rankCache = {};
const rankCacheAt = {};                         // puuid → { t: 写入时间, ok: 是否成功拿到数据 }
const RANK_CACHE_TTL = 5 * 60 * 1000;           // 成功结果: 段位在一局内基本不变, 5 分钟足够
const RANK_CACHE_FAIL_TTL = 30 * 1000;          // 失败结果: 很快重试, 不要把一次网络抖动固化
const RANK_CACHE_MAX = 300;                     // 上限, 防止长时间运行后无限增长
function rankCacheFresh(puuid, now = Date.now()) {
  const meta = rankCacheAt[puuid];
  if (!meta || !(puuid in rankCache)) return false;
  return now - meta.t < (meta.ok ? RANK_CACHE_TTL : RANK_CACHE_FAIL_TTL);
}
function rankCacheStore(puuid, queueMap, ok, now = Date.now()) {
  rankCache[puuid] = queueMap;
  rankCacheAt[puuid] = { t: now, ok };
  const keys = Object.keys(rankCacheAt);
  if (keys.length > RANK_CACHE_MAX) {
    keys.sort((a, b) => rankCacheAt[a].t - rankCacheAt[b].t)
      .slice(0, keys.length - RANK_CACHE_MAX)
      .forEach(k => { delete rankCache[k]; delete rankCacheAt[k]; });
  }
}
const TIER_ICON = { IRON: poroIcon('rock'), BRONZE: poroIcon('medal'), SILVER: poroIcon('medal'), GOLD: poroIcon('medal'), PLATINUM: poroIcon('shield'), EMERALD: poroIcon('shield'), DIAMOND: poroIcon('gem'), MASTER: poroIcon('gem'), GRANDMASTER: poroIcon('crown'), CHALLENGER: poroIcon('crown') };
async function resolveRanks(puuids) {
  const now = Date.now();
  const missing = [...new Set(puuids)].filter(p => p && !rankCacheFresh(p, now));
  if (!missing.length) return;
  await mapWithConcurrency(missing.slice(0, 10), 4, async puuid => {
    // 刷新期间旧值照常可读 (rankCache[puuid] 不先清空), 失败时也保留旧值而不是退化成空段位。
    const previous = rankCache[puuid];
    try {
      const r = await lolAPI.lcuRequest("GET", `/lol-ranked/v1/ranked-stats/${encodeURIComponent(puuid)}`);
      // LCU 对 4xx/5xx 不抛异常而是返回带 __error 的对象, 不能把它当成"这个人没有段位"。
      if (!r || r.__error || typeof r !== 'object') throw new Error(r?.__error || '段位数据为空');
      rankCacheStore(puuid, r.queueMap || {}, true);
    } catch (e) {
      rankCacheStore(puuid, previous || {}, false);
    }
  });
}
function hasRankedQueueData(value) {
  return !!(value && value.queueMap && Object.values(value.queueMap).some(queue => queue && (queue.tier || queue.wins || queue.losses)));
}
async function loadRankedStats(puuid, samePlatform, isSelf=false, stale=()=>false) {
  const paths = samePlatform
    ? [`/lol-ranked/v1/ranked-stats/${encodeURIComponent(puuid)}`, `/lol-ranked/v1/cached-ranked-stats/${encodeURIComponent(puuid)}`]
    : [`/lol-ranked/v1/cached-ranked-stats/${encodeURIComponent(puuid)}`];
  if(isSelf) paths.unshift('/lol-ranked/v1/current-ranked-stats');
  for(let attempt=0;attempt<3;attempt++) {
  if(attempt) await new Promise(resolve=>setTimeout(resolve,attempt*1500));
  if(stale()) return null;
  for (const path of paths) {
    try {
      const value = await lolAPI.lcuRequest('GET', path);
      if (!value?.__error && hasRankedQueueData(value)) return value;
    } catch (e) {}
  }
  }
  return null;
}

// 结算页数据会比 SGP/战绩接口早到数秒到一分钟。先把它标准化为首页可直接展示的
// 临时对局；正式战绩出现同一 gameId 后自动替换，避免用户打完一局却长时间看不到结果。
function eogStat(stats, ...names) {
  const source = stats && typeof stats === 'object' ? stats : {};
  const normalizedKeys = new Map(Object.keys(source).map(key => [key.toLowerCase().replace(/[^a-z0-9]/g, ''), key]));
  for (const name of names) {
    if (source[name] != null) return source[name];
    const hit = normalizedKeys.get(String(name).toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (hit) return source[hit];
  }
  return 0;
}

function normalizeEogGame(block, ownerPuuid, platformId) {
  if (!block || !block.gameId || !Array.isArray(block.teams)) return null;
  const participants = [];
  for (const team of block.teams) {
    for (const player of (team?.players || [])) {
      const stats = player?.stats || {};
      const winStat = eogStat(stats, 'WIN');
      const won = team?.isWinningTeam === true || winStat === 1 || winStat === true || String(winStat).toLowerCase() === 'win';
      const penta = +eogStat(stats, 'PENTA_KILLS', 'PENTAKILLS') || 0;
      const quadra = +eogStat(stats, 'QUADRA_KILLS', 'QUADRAKILLS') || 0;
      const triple = +eogStat(stats, 'TRIPLE_KILLS', 'TRIPLEKILLS') || 0;
      const dbl = +eogStat(stats, 'DOUBLE_KILLS', 'DOUBLEKILLS') || 0;
      participants.push({
        puuid: player.puuid || (player.isLocalPlayer ? ownerPuuid : '') || '',
        name: player.riotIdGameName || player.summonerName || '',
        tagLine: player.riotIdTagLine || '',
        championId: normalizeChampId(player.championId), championName: player.championName || '',
        k: +eogStat(stats, 'CHAMPIONS_KILLED', 'KILLS') || 0,
        d: +eogStat(stats, 'NUM_DEATHS', 'DEATHS') || 0,
        a: +eogStat(stats, 'ASSISTS') || 0,
        win: won, teamId: player.teamId || team.teamId || 0,
        dmg: +eogStat(stats, 'TOTAL_DAMAGE_DEALT_TO_CHAMPIONS', 'TOTAL_DAMAGE_DEALT_TO_CHAMPIONS') || 0,
        dmgTaken: +eogStat(stats, 'TOTAL_DAMAGE_TAKEN') || 0,
        healing: +eogStat(stats, 'TOTAL_HEAL', 'TOTAL_HEAL_ON_TEAMMATES') || 0,
        allyHeal: +eogStat(stats, 'TOTAL_HEALS_ON_TEAMMATES') || 0,
        shielding: +eogStat(stats, 'TOTAL_DAMAGE_SHIELDED_ON_TEAMMATES') || 0,
        mitigated: +eogStat(stats, 'DAMAGE_SELF_MITIGATED') || 0,
        gold: +eogStat(stats, 'GOLD_EARNED') || 0,
        cs: (+eogStat(stats, 'MINIONS_KILLED', 'TOTAL_MINIONS_KILLED') || 0) + (+eogStat(stats, 'NEUTRAL_MINIONS_KILLED') || 0),
        level: +eogStat(stats, 'LEVEL', 'CHAMP_LEVEL') || player.level || 1,
        visionScore: +eogStat(stats, 'VISION_SCORE') || 0,
        position: player.detectedTeamPosition || player.selectedPosition || '',
        spells: [player.spell1Id, player.spell2Id].filter(Boolean),
        items: (player.items || []).filter(id => +id > 0),
        profileIconId: player.profileIconId || 0,
        penta, fb: !!eogStat(stats, 'FIRST_BLOOD_KILL'),
        multi: penta ? '五杀' : quadra ? '四杀' : triple ? '三杀' : dbl ? '双杀' : '',
        progressDataComplete: true
      });
    }
  }
  if (!participants.length || !participants.some(p => p.puuid === ownerPuuid)) return null;
  const mode = String(block.gameMode || block.queueType || '刚结束的对局');
  return {
    gid: block.gameId, mode: mode === 'ARAM' ? '极地大乱斗' : mode === 'JADE' ? '海克斯大乱斗' : mode,
    queueId: +block.queueId || 0, gameType: block.gameType || '', dur: +block.gameLength || 0,
    time: (() => { const ts = +block.endOfGameTimestamp || Date.now(); return ts > 0 && ts < 100000000000 ? ts * 1000 : ts; })(),
    participants, teamsObj: {}, platformId: platformId || '',
    pendingSettlement: true
  };
}

function pendingEogKey(puuid) { return 'poro.pendingEog.' + String(puuid || ''); }
function readPendingEogGames(puuid) {
  if (!puuid) return [];
  try {
    const rows = JSON.parse(localStorage.getItem(pendingEogKey(puuid)) || '[]');
    return Array.isArray(rows) ? rows.filter(g => g && Date.now() - (+g.savedAt || +g.time || 0) < 6 * 60 * 60 * 1000) : [];
  } catch (e) { return []; }
}
function writePendingEogGames(puuid, games) {
  try { localStorage.setItem(pendingEogKey(puuid), JSON.stringify((games || []).slice(0, 12))); } catch (e) {}
}
function mergePendingEogGames(games, summoner, platformId) {
  const puuid = summoner?.puuid || '';
  if (!puuid) return games || [];
  const officialIds = new Set((games || []).map(g => String(g.gid)));
  const pending = readPendingEogGames(puuid).filter(g => !officialIds.has(String(g.gid)) && findProfileParticipant(g, summoner));
  writePendingEogGames(puuid, pending);
  return pending.concat(games || []);
}
function capturePendingEogGame(block) {
  const puuid = window._myPuuid || cachedSummoner?.puuid || block?.localPlayer?.puuid || '';
  const game = normalizeEogGame(block, puuid, cachedPlatformId || '');
  if (!game) return false;
  const rows = readPendingEogGames(puuid).filter(g => String(g.gid) !== String(game.gid));
  rows.unshift(Object.assign({}, game, { savedAt: Date.now() }));
  writePendingEogGames(puuid, rows);
  if (!profileOverride && homeGamesOwner === puuid && Array.isArray(homeGamesData)) {
    homeGamesData = [game].concat(homeGamesData.filter(g => String(g.gid) !== String(game.gid)));
    if (typeof growthRecordGames === 'function' && puuid) growthRecordGames([game], puuid);
    renderHomeModeFilter();
    renderHomeGameList();
    // 画像页吃的是同一份 homeGamesData, 新对局落账后若它已挂载也要跟着更新。
    refreshProfilePageIfMounted();
  }
  try { lolAPI.debugLog(`[HOME] local EOG ledger gameId=${game.gid} participants=${game.participants.length}`); } catch (e) {}
  return true;
}
function buildHomeMmr(qm,modeStats,wr,s) {
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
    return mmrChips;
}
// 当前档案是不是"其它大区"的人: 段位走的是 LCU 的 ranked 接口, 只认本区,
// 跨区注定拿不到 —— 与其一直显示"段位同步中/暂未获取", 不如直接说清楚。
function homeProfileCrossRegion() {
  const p = (profileOverride && profileOverride.platformId) || '';
  const cur = (typeof cachedPlatformId === 'string') ? cachedPlatformId : '';
  return !!(p && cur && p !== cur);
}
function renderHomeMmr(chips, ranked, fromCache, pending, crossRegion) {
  const missing=['单双排','灵活组排'].filter(label=>!chips.some(c=>c[0]===label));
  return '<small>非官方匹配强度'+(fromCache?' · 历史段位缓存':'')+'</small>'+chips.map(([label,value,tip])=>'<span class="mmr-chip" title="'+escapeHtml(tip||'非官方估算')+'">'+escapeHtml(label)+' ~'+value+'</span>').join('')+
    missing.map(label=>'<span class="mmr-chip">'+label+' · '+(crossRegion?'跨区不显示':(pending?'段位同步中':hasRankedQueueData(ranked)?'暂无可用段位':'段位暂未获取'))+'</span>').join('');
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
  const spellHtml = (p.spells || []).map(id => `<img class="ako-spell" src="https://ddragon.leagueoflegends.com/cdn/${version}/img/spell/${(spellName(id) || "").replace(/\.png$/, "")}.png" onerror="retryImg(this)" loading="lazy" decoding="async">`).join('');
  const runeIcon = (map, id) => id && map[id] ? `https://ddragon.leagueoflegends.com/cdn/img/${map[id]}` : null;
  const rk1 = runeIcon(perkIconMap, p.perkPrimary), rk2 = runeIcon(styleIconMap, p.perkSub);
  const runeHtml = (rk1 || rk2) ? `<div class="ako-runecol">${rk1 ? `<img class="ako-rune" src="${rk1}" onerror="retryImg(this)" loading="lazy" decoding="async">` : ''}${rk2 ? `<img class="ako-rune" src="${rk2}" onerror="retryImg(this)" loading="lazy" decoding="async">` : ''}</div>` : '';
  const itemHtml = (p.items || []).slice(0, 6).map(id => `<img class="ako-item" src="${itemIcon(id)}" onerror="retryImg(this)" loading="lazy" decoding="async">`).join('')
    + (p.items && p.items[6] ? `<img class="ako-item ako-trinket" src="${itemIcon(p.items[6])}" onerror="retryImg(this)" loading="lazy" decoding="async">` : '');
  const posText = POS_MAP[p.position] || '';
  const rosterCol = tid => (teams[tid] || []).slice(0, 5).map(x => {
    const xc = champNumMap[String(x.championId)];
    return `<div class="ako-player${x.puuid === s.puuid ? ' ako-me' : ''}" onclick="event.stopPropagation();searchPlayerByPuuid(${inlineArg(x.puuid)}, ${inlineArg(getName(x))})">
      <img src="${xc ? champImg(xc.id) : placeholder('?')}" loading="lazy" decoding="async"><span>${escapeHtml(getName(x).split('#')[0])}</span>
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
  const pendingBadge = g.pendingSettlement ? '<span class="ako-tag ako-pendingtag">结算同步中</span>' : '';
  return `<div class="ako-card ${p.win ? 'ako-win' : 'ako-loss'}" onclick="expandOpggGame(this, '${g.gid}')" data-gid="${g.gid}" data-platform="${escapeHtml(g.platformId || '')}">
        <div class="ako-main">
          <div class="ako-top">
            <div class="ako-champwrap">
              <img class="ako-champ" src="${c ? champImg(c.id) : placeholder('?')}" ${c ? champIconAttrs(c.id, c.name) : `onerror="this.src='${placeholder('?')}'"`} loading="lazy" decoding="async">
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
            ${pendingBadge}
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
// 「我的画像」页与首页共用 homeGamesData。查看其他玩家时 (profileOverride)
// 这份数据是**别人**的，而页面标签写的是「我的画像」—— 不标出来就是直接误导。
// 所以顺带记下当前数据属于谁、是不是自己。
let homeGamesOwnerLabel = '';
let homeGamesOwnerIsSelf = true;
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
  // 用户主动筛选/加载更多也可能移除原展开节点；此时不能让延迟刷新永久挂起。
  resumeDeferredHomeRefresh();
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
          writeHomeCacheEntry(state.cacheKey, JSON.stringify(cached));
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

// 用户在"服务暂时不可用"页面上手动重试：清掉退避与轮询计时，立刻重新拉一次。
// 自动轮询要退避（避免打挂掉的网关），但用户的主动操作必须立刻生效。
function retryHomeStatsNow() {
  sgpFailureStreak = 0;
  sgpBackoffUntil = 0;
  profileRefreshAfter = 0;
  window._homeCacheNeedRefresh = false;
  homeStatsLoaded = false;
  loadHomeStats(true, { skipCache: true });
}
function renderEmptyPlayerHome(panel, s, isSelf, server, ranked, message, canRetry) {
  const displayName = typeof summonerDisplayName === 'function'
    ? summonerDisplayName(s)
    : (s.gameName || s.displayName || s.name || '未知玩家') + (s.tagLine ? '#' + s.tagLine : '');
  const icon = s.profileIconId >= 0 ? profileIcon(s.profileIconId) : placeholder((s.gameName || '?')[0]);
  const rankHtml = renderRankCards(ranked?.queueMap || {});
  panel.innerHTML = `
    <div class="home-layout">
      ${homeSearchMarkup('输入名字搜索 (好友/最近对局的人)；输 名字# 可按 Tag 筛选')}
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
        ${canRetry ? '<button class="back-to-me" onclick="retryHomeStatsNow()">立即重试</button>' : ''}
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
  if(!payload.isSelf || !payload.s?.puuid) return false;
  const status=await lolAPI.lcuStatus().catch(()=>null);
  if(!status?.connected || status.summoner?.puuid!==payload.s.puuid) return false;
  try { return await lolAPI.writeFile(homeSelfCachePath(includePractice), JSON.stringify(payload)); }
  catch (e) { return false; }
}

let profileRefreshAfter = 0;
async function refreshViewedProfile() {
  if(!profileOverride || homeStatsLoading || Date.now()<profileRefreshAfter || document.hidden) return;
  // 战绩服务故障期间不轮询：等退避窗口过去再试，避免对着已经挂掉的网关持续打请求。
  if(sgpBackoffActive()) return;
  profileRefreshAfter=Date.now()+60000;
  await loadHomeStats(true,{skipCache:true,profileRefresh:true});
}
// 渲染 op.gg 风格的首页模板。
//
// 2026-09-27 从 loadHomeStats 抽出：这段原本内联在主流程里约 110 行，
// 是"首页核心路径里最难读的一段"。抽成纯函数后，loadHomeStats 只负责
// 「取数 → 落状态 → 挂载」，模板本身可以单独读、单独改。
//
// 纯函数约定：只接收算好的数据、返回 HTML 字符串；不碰 DOM、不改模块状态。
// 渲染后的状态写入（homeGamesData 等）与挂载仍留在 loadHomeStats 里。
function buildHomeTemplate(v) {
  const { s, server, includePractice, n, rawGameCount, wins, wr, isSelf,
          mmrChips, ranked, rankFromCache, rankPending, qm, totDur,
          totK, totD, totA, avgKda, maxK, maxD, penta, fb, games,
          champCount, champMeta, friendCount, tagCache, rankRows, modeStats } = v;

  // ========== 渲染 op.gg 风格首页 ==========
  const soloQ = qm.RANKED_SOLO_5x5;
  const flexQ = qm.RANKED_FLEX_SR;
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
      ${rankPromoHtml(q)}
    </div>`;
  };
  // 常用英雄
  const topChampRows = buildHomeChampionRows(champCount, champMeta);
  // 常一起玩
  const friendList = Object.entries(friendCount).sort((a, b) => b[1].count - a[1].count).slice(0, 8);
  window._poroDuoList = friendList;   // 好友助手: 一键邀请用
  if (typeof refreshDuoChips === 'function') refreshDuoChips();
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
  return `
    <div class="home-layout">
      ${homeSearchMarkup('输入名字搜索 (好友/最近对局的人)；输 名字# 可按 Tag 筛选')}
      <div class="home-header">
        <div class="home-avatar">
          <img src="${s.profileIconId >= 0 ? profileIcon(s.profileIconId) : placeholder((s.gameName||'?')[0])}" onerror="this.src='${placeholder((s.gameName||'?')[0])}'">
        </div>
        <div class="home-info">
          <div class="home-name">${escapeHtml(typeof summonerDisplayName === 'function' ? summonerDisplayName(s) : ((s.gameName || s.displayName || s.name || '未知玩家') + (s.tagLine ? '#' + s.tagLine : '')))}</div>
          <div class="home-server">大区: ${server} · 等级 ${s.summonerLevel || '-'} · ${includePractice ? '近 ' + n + ' 场统计' : (rawGameCount > n ? '拉取 ' + rawGameCount + ' 场 · 统计 ' + n + ' 场 (训练/自定义未计入)' : '近 ' + n + ' 场统计')}</div>
          <div class="home-mmr">${renderHomeMmr(mmrChips,ranked,rankFromCache,rankPending,homeProfileCrossRegion())}</div>
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
      <a href="#" class="home-profile-entry" onclick="switchPage('profile');return false;">
        <span class="hpe-icon">${poroIcon('chart')}</span>
        <span class="hpe-text"><b>我的画像</b><small>擅长与提升 · 玩家趣味档案</small></span>
        <em>查看 →</em>
      </a>
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
}

async function loadHomeStats(force, opts) {
  const loadStartedAt = performance.now();
  let loadPath = 'network';
  const skipCache = !!(opts && opts.skipCache);   // true=跳过持久缓存强制走网络(后台刷新用)
  // Background self refresh must never take ownership of a searched profile.
  if (skipCache && profileOverride && !opts?.profileRefresh) return;
  const profileBackground=!!(profileOverride && opts?.profileRefresh);
  const requestedProfile = profileOverride?.puuid || '';
  if (homeStatsLoaded && !force) return;
  if (homeStatsLoading && !force) return;   // 并发保护: 只有用户主动的 force 请求能打断进行中的加载
  const myToken = ++homeStatsToken;          // 请求代际: 被更新的请求取代后立即放弃渲染
  const stale = () => myToken !== homeStatsToken || requestedProfile !== (profileOverride?.puuid || '');
  homeStatsLoading = true;
  const panel = document.getElementById("playerPanel");
  if (!panel) { homeStatsLoading = false; return; }
  if (!homeScrollSnapshot && panel.querySelector('.home-layout') && (homeScrollContainer()?.scrollTop || 0) > 0) {
    preserveHomeScroll(profileOverride?.puuid || cachedSummoner?.puuid || '');
  }
  try {
    // ---- 持久缓存快速路径: 自己的首页 + 有缓存 → 不等客户端连接, 先秒出上次数据 ----
    const includePractice = storeGet('includePractice') === '1';
    const st=await lolAPI.lcuStatus();
    if(stale()) return;
    if(!st?.connected || !st.summoner?.puuid) {
      if(!profileBackground) panel.innerHTML='<div class="meta-loading">等待客户端确认当前账号后显示战绩...</div>';
      homeStatsLoaded=false;
      return;
    }
    const selfPuuidSaved = st.summoner.puuid;
    const targetPuuid = profileOverride?.puuid || selfPuuidSaved;
    let cached = null;
    // 强制网络刷新也保留一份只读兜底。它不参与正常请求，只用于阻止瞬时空响应
    // 把已经展示的有效首页覆盖成“未知玩家 / 暂无对局”。
    const durableSelfCache = !profileOverride ? await readHomeSelfCache(includePractice) : null;
    // 自己的首页优先读独立文件缓存：不受 localStorage 容量、压缩和进程退出时机影响。
    if (!profileOverride && !skipCache) cached = durableSelfCache;
    if (!cached && targetPuuid) {
      try { cached = JSON.parse(localStorage.getItem('poro.homeCache.' + targetPuuid + '.' + (includePractice ? 1 : 0)) || 'null'); } catch (e) {}
    }
    if(cached?.s?.puuid!==targetPuuid) cached=null;
    let cacheUsable = !!(cached && Array.isArray(cached.games) && cached.s && cached.s.puuid);
    let cacheFresh = cacheUsable && (Date.now() - cached.ts < (profileOverride ? 60000 : 3 * 60 * 1000));
    let historyFetchedAt=cached?.ts || 0;
    // 旧版可能把“当前区查不到”的空数组缓存为有效跨区结果；空的他人缓存必须重新自动定位大区。
    if (profileOverride && cacheUsable && cached.games.length === 0) { cacheUsable = false; cacheFresh = false; }

    const selfSummoner=st.summoner;
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
    let rankedPromise = Promise.resolve(null), rankPending=false, rankFromCache=false;
    let targetPlatformId = cached?.platformId || cachedPlatformId || '';
    let targetPlatformFound = !!cached?.platformId;

    if (cacheUsable && !skipCache && (!profileOverride || cacheFresh)) {
      loadPath = 'cache';
      // 缓存命中: 不发任何战绩请求, 启动/回看秒出 (与 Seraphine 同策略)
      s = cached.s; isSelf = s.puuid===selfSummoner.puuid;
      if(isSelf) s={...cached.s,...selfSummoner};
      // 查询档案接口返回的信息比旧缓存可靠，覆盖曾误存的“对局内等级”等占位值。
      if (profileOverride?.summoner?.puuid === s.puuid) s = mergeSummonerProfile(s, profileOverride.summoner);
      // 旧缓存里可能已经把「未知玩家」存下来了；每次读缓存都用查询时的 Riot ID 纠正一次
      if (profileOverride && typeof fillSummonerName === 'function') s = fillSummonerName(s, profileOverride.name);
      games = cached.games; ranked = cached.ranked || null;
      rawGameCount = cached.rawGameCount || cached.games.length;
      dataSource = cached.dataSource || 'SGP';
      targetPlatformId = cached.platformId || cachedPlatformId || '';
      rankFromCache=hasRankedQueueData(ranked);
      rankPending=true;
      rankedPromise=loadRankedStats(s.puuid,isSelf || (!!targetPlatformId && targetPlatformId===cachedPlatformId),isSelf,stale);
    } else {
      if(profileOverride) {
        profileRefreshAfter=Date.now()+60000;
        try { await lolAPI.sgpInvalidateMatchHistory?.(profileOverride.puuid); } catch(e) {}
        if(stale()) return;
      }
      if (profileOverride && profileOverride.puuid && profileOverride.puuid !== selfSummoner.puuid) {
        isSelf = false;
        if (profileOverride.summoner?.puuid) {
          // 以前这里只补 tagLine、不补 gameName，于是"外区账号 + 只有 Tag 的档案"
          // 必然渲染成「未知玩家#77843」。名字的唯一来源是查询时的 Riot ID，
          // 统一交给 fillSummonerName 处理（LCU gameName 恒空、SGP name 可能为空）。
          s = typeof fillSummonerName === 'function'
            ? fillSummonerName(profileOverride.summoner, profileOverride.name)
            : { ...profileOverride.summoner };
        } else {
          const full = profileOverride.name || '';
          s = { puuid: profileOverride.puuid, gameName: full.split('#')[0], tagLine: full.includes('#') ? full.split('#')[1] : '', profileIconId: -1, summonerLevel: '' };
        }
      }
      // SGP 战绩分页拉取: 排除训练/自定义时自动翻页, 直到攒够 100 场有效对局 (上限 500 场原始数据)
      rankPending=true;
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
          rankedPromise = loadRankedStats(s.puuid, true, isSelf, stale);
          // LCU 单次最多返回 100 场: endIndex 超过 100 会被服务端直接拒绝
          // （HTTP 500 "Error getting match list for summoner, begin 0, end: N"）。
          // 原先这里把 MAX_FETCH（自己 500 / 他人 150）当 endIndex 传，外服查询必然
          // 失败；而本分支最终也只准备前 100 场（见下方 foreignTarget）。
          const hist = await lolAPI.lcuRequest('GET', `/lol-match-history/v1/products/lol/${encodeURIComponent(s.puuid)}/matches?begIndex=0&endIndex=100`);
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
            // 已知归属 (本地索引/搜索结果带来的 puuid+大区) 就把它排在探测队列最前,
            // 跨区查询第一次探测就能命中, 不用白扫 8 个网关。
            const preferredPlatform = (profileOverride && profileOverride.platformId) || selfPlatformId;
            const located = await findSgpPlatform(s.puuid, preferredPlatform, BATCH, (done, total) => {
              if (!profileBackground && !stale() && panel) panel.innerHTML = `<div class="meta-loading">当前大区暂无记录，正在自动查找其他大区 (${done}/${total})...</div>`;
            });
            if (stale()) return;
            targetPlatformId = located.platformId;
            targetPlatformFound = located.found;
            if (located.summoner) s = mergeSummonerProfile(s, located.summoner);
            // SGP 档案行只回 name(完整 Riot ID) 或干脆 name:""+unnamed:true，
            // 都过一遍 fillSummonerName，名字和 Tag 才不会各缺一半。
            if (typeof fillSummonerName === 'function') s = fillSummonerName(s, profileOverride?.name || '');
            r1 = located.response;
          } else {
            targetPlatformId = selfPlatformId;
            targetPlatformFound = true;
            r1 = await lolAPI.sgpMatchHistory(targetPlatformId, s.puuid, 0, BATCH);
          }
          // 必须先知道目标所属平台再查段位。跨区只读取客户端的跨区缓存，绝不能拿
          // 当前登录大区的 ranked-stats 冒充目标玩家数据。
          rankedPromise = loadRankedStats(s.puuid, isSelf || targetPlatformId === selfPlatformId, isSelf, stale);
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
          // 服务端这次真的答了（哪怕是空历史）→ 清掉退避计数，轮询立刻回到正常节奏。
          noteSgpSuccess();
        }
      } catch (e) {
        console.error("SGP 失败, 回退 LCU:", e.message);
        if(isSelf) rankedPromise=loadRankedStats(s.puuid,true,true,stale);
        dataError = e.message || '';
        dataSource = "LCU";
        // 服务端暂时不可用 → 记入退避，别让 12 秒轮询一直砸同一个挂掉的网关。
        if (isTransientSgpError(e.message)) noteSgpFailure();
        // findSgpPlatform 已经确认过目标大区（召唤师档案查得到）时，即使战绩接口失败
        // 也要把大区显示出来，不能退化成"大区: 待识别"。
        if (e.platformId) {
          targetPlatformId = e.platformId;
          targetPlatformFound = true;
          if (e.summoner) s = mergeSummonerProfile(s, e.summoner);
        }

        // 国服 SGP 失败时，LCU 只能可靠返回当前账号的战绩，无法直接查询陌生玩家。
        // 但与当前账号同局的玩家会出现在当前账号的本地历史中；先从这份历史筛选
        // 目标玩家的共同对局，避免“自己能查、同局队友全失败”的假空结果。
        if (!isSelf) {
          const ownHist = await lolAPI.lcuRequest(
            "GET",
            `/lol-match-history/v1/products/lol/${selfPuuidSaved}/matches?begIndex=0&endIndex=100`
          );
          if (stale()) return;
          if (!ownHist?.__error) {
            const ownGames = (ownHist?.games?.games || []).map(g => normalizeGame(g, false));
            const sharedGames = ownGames.filter(g => !!findProfileParticipant(g, s));
            if (sharedGames.length) {
              rawGameCount = sharedGames.length;
              games = includePractice ? sharedGames : sharedGames.filter(g => !isExcludedGame(g));
              dataSource = "LCU-encounter";
              targetPlatformFound = true;
              try { lolAPI.debugLog(`[HOME] SGP failed; recovered ${games.length} shared games from self history puuid=${s.puuid}`); } catch (e) {}
            }
          }
        }

        // 目标不在本机历史中时，保留原有 LCU 兜底；它可能命中客户端已有的目标缓存。
        if (!games) {
          const hist = await lolAPI.lcuRequest("GET", `/lol-match-history/v1/products/lol/${s.puuid}/matches?begIndex=0&endIndex=100`);
          if (stale()) return;
          const rawNorm = (hist?.games?.games || []).map(g => normalizeGame(g, false));
          rawGameCount = rawNorm.length;
          games = includePractice ? rawNorm : rawNorm.filter(g => !isExcludedGame(g));
        }
      }
      // 排位数据不阻塞渲染: 与战绩并行, 超时兜底后先渲染, 段位卡后补
      // 段位不是首屏必需信息：短暂等待后先展示战绩，迟到的数据由下方回调局部补齐。
      // 查询他人时更偏向响应速度；自己的首页稍多等一点以提高首屏段位命中率。
      const rankWaitMs = isProfileQuery ? 400 : 1200;
      ranked = await Promise.race([rankedPromise, new Promise(r => setTimeout(() => r(null), rankWaitMs))]).catch(() => null);
      if(ranked) rankPending=false;
      if(!ranked) {
        const prior=[cached,durableSelfCache].find(c=>c?.s?.puuid===s.puuid && c?.platformId===targetPlatformId && hasRankedQueueData(c.ranked));
        if(prior) { ranked=prior.ranked; rankFromCache=true; }
      }
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
      if(profileOverride && !games.length && cached?.games?.length) {
        if(profileBackground) return;
        throw new Error('战绩服务暂未返回有效数据，请稍后重试；已保留旧缓存');
      }
      historyFetchedAt=Date.now();
      const cachePayload = { ts: historyFetchedAt, s, isSelf, games, ranked, rawGameCount, dataSource, platformId: targetPlatformFound || isSelf ? targetPlatformId : '' };
      try { writeHomeCacheEntry(cacheKey, JSON.stringify(cachePayload)); } catch (e) {}
      if (isSelf) await writeHomeSelfCache(includePractice, cachePayload);
      if (!profileOverride && s && s.puuid) { try { localStorage.setItem('poro.selfPuuid', s.puuid); } catch (e) {} }
    }
    if (stale()) return;
    // 只统计确实包含目标玩家的对局；匹配不到时不能拿第一名参赛者冒充目标。
    games = mergePendingEogGames(games || [], s, targetPlatformId).filter(g => !!findProfileParticipant(g, s));
    for (const game of games) if (!game.platformId && targetPlatformId) game.platformId = targetPlatformId;
    const server = SERVER_NAMES[targetPlatformId] || targetPlatformId || "";
    if(profileBackground && homeGamesOwner===s.puuid && games.length===homeGamesData.length &&
      games.every((g,i)=>String(g.gid)===String(homeGamesData[i]?.gid))) return;
    // 请求可能在详情展开前已经发出，因此只在轮询入口判断还不够。提交 DOM 前再次检查，
    // 同一玩家详情仍打开时保留当前节点；网络结果已经写入缓存，关闭后可立即补绘。
    if (homeGamesOwner === s.puuid && (isHomeGameDetailExpanded() || profileBackground || (skipCache && (homeScrollContainer()?.scrollTop || 0) > 80))) {
      homeRenderDeferred = true;
      // Never restore a request-time scroll snapshot over the user's newer position.
      homeScrollSnapshot = null;
      panel.style.minHeight = '';
      if (!document.getElementById('homeRefreshNotice')) {
        const notice = document.createElement('button');
        notice.id = 'homeRefreshNotice';
        notice.className = 'btn-secondary';
        notice.textContent = '数据已更新 · 点击刷新（将收起详情）';
        notice.onclick = () => {
          panel.querySelectorAll('.ako-card.expanded').forEach(card => card.classList.remove('expanded'));
          homeRenderDeferred = false;
          notice.remove();
          loadHomeStats(true);
        };
        panel.appendChild(notice);
      }
      return;
    }
    if (!games.length) {
      renderEmptyPlayerHome(
        panel,
        s,
        isSelf,
        isSelf || targetPlatformFound ? server : '',
        ranked,
        dataError
          ? (isTransientSgpError(dataError)
            // 服务端 5xx：这是"国服战绩服务挂了"，不是"这个人没战绩"。必须说清楚，
            // 否则用户会以为 Poro 查不到别人，转而反复点击甚至怀疑功能坏了。
            ? `国服战绩服务暂时不可用${server ? '（' + server + '）' : ''}，已自动重试；基础档案已显示，恢复后会自动补上战绩。`
            : '战绩服务暂未返回数据，基础档案已显示；稍后可重新查询。')
          : '该账号暂无公开的近期对局，基础档案已显示。',
        !!(dataError && isTransientSgpError(dataError))
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
    const qm = ranked?.queueMap || {};
    // 排位胜负直接用接口数据 (当前赛段真实战绩, 与 Akari 一致)
    const rankRows = RANK_QUEUE_LABELS.map(([q, label]) => {
      const r = qm[q];
      if (!r || !r.tier || !(r.wins + r.losses)) return "";
      const total = r.wins + r.losses;
      const rank = r.tier ? `${rankTierCN(r.tier)} ${r.division || ''}` : '--';
      const lp = r.leaguePoints || 0;
      return { name: label + " (当前赛段)", n: total, w: r.wins, rank, lp, season: true };
    }).filter(Boolean);
    const mmrChips = buildHomeMmr(qm,modeStats,wr,s);

    // 模板见前面的 buildHomeTemplate() —— 这里只负责"挂载"
    // 整页重渲染会把搜索框换成新节点: 用户正在输名字时战绩刚好拉回来, 光标就掉了,
    // 候选弹层也跟着消失 —— 之后他会以为"搜索框坏了", 而自动查询 (要求输入框仍在
    // 焦点上) 也会静默失效。替换前记住焦点/弹层状态, 替换后原样恢复。
    const prevInput = document.getElementById('homeSearchInput');
    const hadSearchFocus = !!prevInput && document.activeElement === prevInput;
    const popWasOpen = !!document.getElementById('homeSearchCardPopover')
      && document.getElementById('homeSearchCardPopover').classList.contains('show');
    panel.innerHTML = buildHomeTemplate({
      s, server, includePractice, n, rawGameCount, wins, wr, isSelf,
      mmrChips, ranked, rankFromCache, rankPending, qm, totDur,
      totK, totD, totA, avgKda, maxK, maxD, penta, fb, games,
      champCount, champMeta, friendCount, tagCache, rankRows, modeStats
    });
    if (hadSearchFocus) {
      const nextInput = document.getElementById('homeSearchInput');
      if (nextInput) {
        nextInput.value = String(homeSearchDraft || '');
        nextInput.focus();
        const len = nextInput.value.length;
        try { nextInput.setSelectionRange(len, len); } catch (e) { /* 不支持就算了 */ }
        if (popWasOpen) { renderHomeSearchCards(); homeSearchScheduleAutoGo(); }
      }
    }
    // 模式筛选所需数据缓存
    // prevOwner: 用于"同一玩家重载时保留已展开条数"(见下方 homeGameVisible 的赋值)
    const prevOwner = homeGamesOwner;
    homeGamesData = games;
    // 战绩里的所有参与者顺手进本地玩家索引: 打开一次首页就能攒下 20 场 × 10 人,
    // 之后这些人可以只输名字查到 (国服没有别名模糊接口, 见 player-index.js)
    if (typeof playerIndexFromGames === 'function') {
      try { playerIndexFromGames(games); } catch (e) {}
    }
    homeGamesOwner = s.puuid;
    // 画像页要能说明"这份画像属于谁" —— 查看其他玩家时是别人的数据。
    homeGamesOwnerLabel = String(s.gameName || s.displayName || s.name || '未知玩家')
      + (s.tagLine ? '#' + s.tagLine : '');
    homeGamesOwnerIsSelf = isSelf !== false;
    // 画像页(#page-profile)与首页共用这份数据。若画像页已经挂载过、或用户正停在
    // 画像页等数据, 这里补一次渲染; 否则完全不碰它, 不白算教练分析。
    refreshProfilePageIfMounted();
    // 成长页的长期趋势全靠这里逐局累积 —— SGP 一次只给最近 50 局，
    // 不落本地账本的话，"90 天胜率"永远只能算出这 50 局覆盖的那几天。
    if (homeGamesOwnerIsSelf && typeof growthRecordGames === 'function') {
      growthRecordGames(games, s.puuid);
      if (typeof refreshGrowthPageIfMounted === 'function') refreshGrowthPageIfMounted();
    }
    // 同一玩家重新载入(新对局落账/返回档案/缓存刷新)时保留已展开条数 ——
    // 用户往下刷到 60 条, 任何一次后台刷新都不该把它打回 20 条;
    // 换人查看(含搜索其他玩家)才收回一页。
    homeGameVisible = prevOwner === s.puuid
      ? Math.max(HOME_GAME_PAGE_SIZE, homeGameVisible || 0)
      : HOME_GAME_PAGE_SIZE;
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
    // Attach only after DOM mounting; never replace the history list or scroll position.
    rankedPromise.then(rv=>{
      if(stale() || homeGamesOwner!==s.puuid) return;
      if(hasRankedQueueData(rv)) {
        ranked=rv; rankFromCache=false;
        const payload={ts:historyFetchedAt,rankedTs:Date.now(),s,isSelf,games,ranked,rawGameCount,dataSource,platformId:targetPlatformId};
        try { writeHomeCacheEntry(cacheKey,JSON.stringify(payload)); } catch(e) {}
        if(isSelf) writeHomeSelfCache(includePractice,payload).catch(()=>{});
        const ranksEl=panel.querySelector('.home-ranks');
        if(ranksEl) ranksEl.innerHTML=renderRankCards(rv.queueMap);
      }
      const chipsEl=panel.querySelector('.home-mmr');
      if(chipsEl) chipsEl.innerHTML=renderHomeMmr(buildHomeMmr(ranked?.queueMap||{},modeStats,wr,s),ranked,rankFromCache,false,homeProfileCrossRegion());
    }).catch(()=>{});
    try {
      lolAPI.debugLog(`[PERF] home path=${loadPath} target=${profileOverride ? 'profile' : 'self'} games=${games.length} render=${Math.round(performance.now() - loadStartedAt)}ms`);
    } catch (e) {}
    // 缓存已过期 (>3分钟): 标记待刷新, 由 pollLoop 在 LCU 就绪后静默补刷 (替换之前的 setTimeout 方案,
    // 因为客户端可能还没连接, 立即刷新只会失败)
    if (!profileOverride && cacheUsable && !skipCache && !cacheFresh) window._homeCacheNeedRefresh = true;
  } catch (e) {
    if (stale()) return; // 被新查询取代的失败结果也不能覆盖当前玩家页面
    if(profileBackground) { homeScrollSnapshot=null; return; }
    // 他人查询失败后保留当前错误页，等待用户修正名称或主动重试；若设为 false，
    // pollLoop 会把它当作“本人首页尚未加载”而永久重试，形成周期性整页闪烁。
    homeStatsLoaded = !!profileOverride;
    // 失败页必须给出路: 重试 + 回到我的 (否则他人查询失败 = 整页死路, 只能重启)
    panel.innerHTML = `<div class="msg-error">统计数据加载失败: ${escapeHtml(e.message)}</div>
      <div class="msg-error-actions">
        <button class="btn-primary" onclick="loadHomeStats(true)">重试</button>
        ${profileOverride ? '<button class="btn-secondary" onclick="backToMe()">⟲ 回到我的战绩</button>' : ''}
      </div>`;
    restoreHomeScroll(profileOverride?.puuid || cachedSummoner?.puuid || '');
  } finally {
    window.poroPerf?.record('home.load', performance.now() - loadStartedAt, {
      path: loadPath,
      target: profileOverride ? 'profile' : 'self',
      stale: myToken !== homeStatsToken
    });
    if (myToken === homeStatsToken) {
      homeStatsLoading = false;
      if(profileBackground) homeScrollSnapshot=null;
    }
  }
}

function fmtNumLocal(n) { return Number(n || 0).toLocaleString('en-US'); }
// 展开对局详情
async function expandOpggGame(el, gameId) {
  const detail = el.querySelector('.og-game-detail');
  if (detail.style.display !== 'none') {
    detail.style.display = 'none';
    el.classList.remove('expanded');
    resumeDeferredHomeRefresh();
    return;
  }
  detail.style.display = 'block';
  el.classList.add('expanded');
  detail.innerHTML = '<div class="meta-loading">加载中...</div>';
  ensureChampMap();
  let norm = null;
  let platformId = el.dataset.platform || '';
  if (!platformId) {
    try { platformId = await getPlatformId(); } catch (e) {}
  }
  // SGP SUMMARY (含完整玩家统计+符文; DETAILS 是时间线格式不能用于玩家表), 失败回退 LCU
  try {
    if (platformId && isTencentPlatform(platformId)) {
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
    applyMatchPremadeBadges(detail, resolveMatchPremadeGroups(norm.participants, [], 3), true);
  } catch (e) {
    console.error("渲染详情失败:", e);
    detail.innerHTML = `<div class="msg-error">详情渲染失败: ${escapeHtml(e.message)}</div>`;
    return;
  }
  renderGameReview(norm, gameId, detail, el.dataset.platform || '');
  // 组队推断不阻塞详情首屏。近期战绩查询完成后仅更新徽标，不重绘详情，
  // 因此不会把已经展开的复盘内容合上或造成页面跳动。
  void (async () => {
    if (typeof recentProfileFor !== 'function') {
      applyMatchPremadeBadges(detail, resolveMatchPremadeGroups(norm.participants, [], 3), false);
      return;
    }
    const profiles = [];
    await mapWithConcurrency(norm.participants.filter(p => p.puuid), 4, async player => {
      try {
        const profile = await recentProfileFor(platformId, player.puuid, 30);
        if (profile) profiles.push(profile);
      } catch (e) {}
    });
    if (!detail.isConnected || !el.classList.contains('expanded')) return;
    applyMatchPremadeBadges(detail, resolveMatchPremadeGroups(norm.participants, profiles, 3), false);
  })();
}

if (typeof module !== 'undefined' && module.exports) module.exports = { deriveHomeFunStats, isHomeSignatureItem, pickFunHighlights, classifyHeroPool, classifyCombatStyle };
