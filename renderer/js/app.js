// Poro - 主应用脚本
let version = "16.17.1";
let allChampions = {};
let allItems = {};
let allSpells = {};
let spellMap = {};
let perkIconMap = {};
let styleIconMap = {};
// 1.6.23: 符文/副系的中文名 —— 对局详情要把"具体带了哪些符文"写进 title,
// 只靠图标看不出是哪个符文。
let perkNameMap = {};
let styleNameMap = {};
let currentRole = "all";
let autoAcceptOn = false;
let lcuConnected = false;
let opggMap = {};   // op.gg 数据: championKey -> average_stats + positions

const CDN = "https://ddragon.leagueoflegends.com/cdn";
const CDG = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default";
const ROLE_MAP = { Fighter: "战士", Mage: "法师", Assassin: "刺客", Marksman: "射手", Support: "辅助", Tank: "坦克" };
const ROLES = ["all", "上单", "打野", "中单", "下路", "辅助"];
// LCU/SGP 的 teamPosition / individualPosition 枚举是 TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY。
// 早期只写了 MID/ADC/SUPPORT，中单、下路、辅助三档查不到 → 静默不显示（页面上只剩
// "上单/打野"能出来）。两套键都收，兼容旧数据来源。
const POS_MAP = {
  TOP: "上单", JUNGLE: "打野", MIDDLE: "中单", BOTTOM: "下路", UTILITY: "辅助",
  MID: "中单", ADC: "下路", SUPPORT: "辅助"
};
// 只有"按分路匹配"的队列才存在真实位置。盲选匹配(430)、大乱斗(450/2400)、斗魂(17xx)
// 这类模式没有分路分配，客户端会把 teamPosition 按楼层顺序硬填（1楼TOP、2楼JUNGLE、
// 3楼MIDDLE、4楼BOTTOM、5楼UTILITY），照抄就会把 2 楼的 AD 标成"打野"。
// 宁可不显示，也不给假位置。
const ROLE_QUEUES = new Set([400, 420, 440, 490]);
function hasRealPositions(g) {
  if (!g) return false;
  return ROLE_QUEUES.has(+g.queueId || 0);
}
// 职业克制矩阵: key 职业 克制 value 列表中的职业 (参考关系, 非官方数据)
// 国服队列ID优先 (2400=海克斯大乱斗, 4320=经典模式人机), 其次 gameMode 字符串
const QUEUE_NAMES = { 0: "自定义", 420: "单双排", 430: "匹配模式", 440: "灵活组排", 450: "极地大乱斗", 870: "人机", 880: "人机", 881: "人机", 882: "人机", 900: "无限火力", 1020: "克隆大作战", 1300: "极限闪击", 1700: "斗魂竞技场", 1710: "斗魂竞技场", 1750: "斗魂竞技场", 2400: "海克斯大乱斗", 4320: "人机", 1090: "训练工具" };
const QUEUE_MODE_MAP = { 0: { gameMode: "CLASSIC", mapId: 11 }, 420: { gameMode: "CLASSIC", mapId: 11 }, 430: { gameMode: "CLASSIC", mapId: 11 }, 440: { gameMode: "CLASSIC", mapId: 11 }, 450: { gameMode: "KIWI", mapId: 12 }, 900: { gameMode: "URF", mapId: 11 }, 1020: { gameMode: "ONEFORALL", mapId: 11 }, 1300: { gameMode: "NEXUSBLITZ", mapId: 12 }, 1700: { gameMode: "SKIRMISH", mapId: 11 }, 2400: { gameMode: "KIWI", mapId: 12 }, 4320: { gameMode: "CLASSIC", mapId: 11 }, 1090: { gameMode: "PRACTICETOOL", mapId: 11 } };
const MODE_NAMES = { CLASSIC: "召唤师峡谷", KIWI: "极地大乱斗", ARAM: "极地大乱斗", JADE: "经典模式", URF: "无限火力", NEXUSBLITZ: "极限闪击", ONEFORALL: "克隆大作战", ASCENSION: "飞升", SKIRMISH: "斗魂竞技场", CHERRY: "斗魂竞技场", TUTORIAL: "新手教程", KIWI_JADE: "海克斯大乱斗", SWIFTPLAY: "快速对局", PRACTICETOOL: "训练工具" };
function modeName(g) { return QUEUE_NAMES[g.queueId] || MODE_NAMES[g.gameMode] || g.gameMode || "其他"; }
// 训练模式 (训练工具/新手教程) 和 自定义对局 不计入战绩卡片和模式统计
// 1.6.13: 日服/外服 LCU 原始战绩里 gameMode 直接是 "PRACTICETOOL" (QUEUE_NAMES 也没这个
// queueId), modeName() 兜底返回原串, 于是卡片上显示 "PRACTICETOOL" 却没被过滤掉 ——
// 国服走 SGP, gameMode=TUTORIAL/queueId=1090, 所以此前只在日服暴露。这里补齐识别。
const TRAINING_MODES = new Set(["训练工具", "新手教程", "TUTORIAL", "PRACTICETOOL"]);
function isTrainingGame(g) {
  if (!g) return false;
  return TRAINING_MODES.has(g.mode) || TRAINING_MODES.has(g.gameMode)
    || g.queueId === 1090 || TRAINING_MODES.has(g.gameType);
}
function isCustomGame(g) { return g.gameType === 'CUSTOM_GAME' || g.queueId === 0; }
function isExcludedGame(g) { return isTrainingGame(g) || isCustomGame(g); }
const SERVER_NAMES = {
  HN1: "艾欧尼亚", HN2: "恕瑞玛", HN3: "雷瑟守备", HN4: "班德尔城", HN5: "皮尔特沃夫",
  HN6: "战争学院", HN7: "巨神峰", HN8: "雷霆咆哮", HN9: "麦林炮手", HN10: "黑色玫瑰",
  HN11: "暗影岛", HN12: "均衡教派", HN13: "水晶之痕", HN14: "影流", HN15: "裁决之地",
  BGP1: "比尔吉沃特", BGP2: "峡谷之巅", BGP3: "德玛西亚", EDU: "教育网",
  GZ1: "祖安", NX1: "诺克萨斯", BJ1: "班德尔城", DX1: "德玛西亚", P1: "皮尔特沃特", CS1: "巨神峰", TZ1: "钢铁烈阳", WZ1: "守望之海", CA1: "峡湾之城",
  NJ100: "联盟一区", GZ100: "联盟二区", CQ100: "联盟三区", TJ100: "联盟四区", TJ101: "联盟五区",
  BR1: "巴西", EUN1: "北欧东欧", EUW1: "西欧", JP1: "日本", KR: "韩国",
  LA1: "拉丁美洲北", LA2: "拉丁美洲南", NA1: "北美", OC1: "大洋洲", TR1: "土耳其", RU: "俄罗斯",
  PH2: "菲律宾", SG2: "新加坡", TH2: "泰国", TW2: "台湾", VN2: "越南"
};
const SGP_PLATFORM_IDS = [
  'HN1', 'HN10', 'NJ100', 'GZ100', 'CQ100', 'TJ100', 'TJ101', 'BGP2'
];
const RIOT_PLATFORM_IDS = ['BR1', 'EUN1', 'EUW1', 'JP1', 'KR', 'LA1', 'LA2', 'NA1', 'OC1', 'TR1', 'RU', 'PH2', 'SG2', 'TH2', 'TW2', 'VN2'];
function isTencentPlatform(platformId) { return SGP_PLATFORM_IDS.includes(String(platformId || '').toUpperCase()); }
const PLAYER_PLATFORM_TTL = 30 * 24 * 60 * 60 * 1000;

function champImg(id) { return `${CDN}/${version}/img/champion/${allChampions[id]?.image?.full || id + ".png"}`; }
function spellImg(full) { return `${CDN}/${version}/img/spell/${full}`; }
function passiveImg(full) { return `${CDN}/${version}/img/passive/${full}`; }
function profileIcon(id) { return `${CDN}/${version}/img/profileicon/${id}.png`; }
// 皮肤原画使用 DDragon 的英雄英文 ID + 皮肤序号，避免 CommunityDragon 目录结构变动导致全图失效。
function splashUrl(champId, skinNum) { return `${CDN}/img/champion/splash/${champId}_${skinNum}.jpg`; }
function nonChromaSkins(skins) {
  const rows = Array.isArray(skins) ? skins : [];
  const chromaBases = rows.filter(s => s?.chromas && s.name).map(s => String(s.name));
  return rows.filter(s => {
    const name = String(s?.name || '');
    return !chromaBases.some(base => name !== base && name.startsWith(base + ' '));
  });
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

// 旧 store 值迁移: b(暗色玻璃) 当时是深色 + 蓝, a 是浅色 + 紫
const LEGACY_UI_THEME = {
  c: { mode: 'dark', accent: 'blue' },
  a: { mode: 'light', accent: 'violet' },
  b: { mode: 'dark', accent: 'blue' },
  dark: { mode: 'dark', accent: 'blue' }
};
function currentThemeState() {
  const b = document.body;
  return {
    mode: b.classList.contains('dark') ? 'dark' : 'light',
    accent: b.classList.contains('theme-a') ? 'violet' : 'blue'
  };
}
function syncThemeUi() {
  const st = currentThemeState();
  document.querySelectorAll('#themePopover [data-mode]').forEach(el => {
    const on = el.dataset.mode === st.mode;
    el.classList.toggle('on', on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  document.querySelectorAll('#themePopover [data-accent]').forEach(el => {
    const on = el.dataset.accent === st.accent;
    el.classList.toggle('on', on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
function applyThemeState(state, persist = true) {
  const b = document.body;
  const mode = state && state.mode === 'dark' ? 'dark' : 'light';
  const accent = state && state.accent === 'violet' ? 'violet' : 'blue';
  b.classList.toggle('dark', mode === 'dark');
  b.classList.toggle('theme-a', accent === 'violet');
  b.classList.remove('theme-b', 'theme-c');   // 旧版本遗留类, 防止 localStorage 里带过来
  if (persist) {
    try { storeSet('uiTheme', mode + ':' + accent); } catch (e) {}
  }
  syncThemeUi();
}
// 旧入口: 仍然接受 'c' / 'a' / 'b' / 'dark', 以及新的 'light:blue' 形式
function applyUiTheme(v, persist = true) {
  let st = LEGACY_UI_THEME[v];
  if (!st && typeof v === 'string' && v.indexOf(':') > 0) {
    const p = v.split(':');
    st = { mode: p[0], accent: p[1] };
  }
  // 1.5.154: BinanceGUI 化 —— 旧 store 存过的浅色偏好一次性迁移为深色 (可设置里切回)
  if (st && st.mode === 'light') st = { mode: 'dark', accent: st.accent };
  applyThemeState(st || { mode: 'dark', accent: 'blue' }, persist);
}

function pickThemeMode(mode) {
  applyThemeState({ mode, accent: currentThemeState().accent });
}
function pickThemeAccent(accent) {
  applyThemeState({ mode: currentThemeState().mode, accent });
}

// 主题选择弹窗 (侧边栏底部调色板按钮)
function toggleThemePicker(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  const pop = document.getElementById('themePopover');
  const btn = document.getElementById('themePickerBtn');
  if (!pop || !btn) return;
  if (!pop.hidden) { pop.hidden = true; return; }
  pop.hidden = false;
  const r = btn.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = r.right + 10;
  if (x + pw > window.innerWidth - 8) x = r.left - pw - 10;
  let y = Math.max(8, Math.min(r.bottom - ph, window.innerHeight - ph - 8));
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
}

document.addEventListener('click', (e) => {
  const pop = document.getElementById('themePopover');
  if (!pop || pop.hidden) return;
  if (!pop.contains(e.target) && e.target.closest?.('#themePickerBtn')) return;
  if (!pop.contains(e.target)) pop.hidden = true;
});

// ========== 页面切换 ==========
// 导航栏收起/展开 (收起成 64px 图标栏, 偏好持久化)
function applyNavCollapsedState() {
  const collapsed = storeGet('navCollapsed') === '1';
  document.body.classList.toggle('nav-collapsed', collapsed);
  syncNavTooltips(collapsed);
}
function toggleNavCollapsed() {
  const collapsed = !document.body.classList.contains('nav-collapsed');
  document.body.classList.toggle('nav-collapsed', collapsed);
  try { storeSet('navCollapsed', collapsed ? '1' : ''); } catch (e) {}
  syncNavTooltips(collapsed);
}
function syncNavTooltips(collapsed) {
  // 收起时悬停图标显示页面名
  document.querySelectorAll('.nav-item').forEach(el => {
    el.title = collapsed ? (el.querySelector('span')?.textContent || '') : '';
  });
}
function switchPage(page) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  // 出装浮窗是挂在 body 上的 fixed 层, 不跟着页面隐藏, 切页必须主动关掉
  if (page !== "live" && typeof closeLiveBuildPop === "function") closeLiveBuildPop();
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.getElementById("page-" + page)?.classList.add("active");
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add("active");
  // 实时页在隐藏期间渲染过的话, 标签/战绩行的对齐测量会被跳过 (display:none 下量不到尺寸);
  // 切回前台立即补一次对齐, 不用等下一轮 4/12s 轮询 —— 否则进页头几秒标签只剩「+N」。
  if (page === "live" && typeof scheduleLiveRowAlignment === "function") scheduleLiveRowAlignment();
  if (page === "champions") renderChampionGrid();
  if (page === "champions" && typeof PoroMastery !== 'undefined') PoroMastery.load();
  if (page === "counters") updateCounterClientPick();
  // 「我的画像」的两块内容(擅长与提升 / 趣味档案)是懒渲染的: 首屏不再计算它们,
  // 进页面时才用首页已加载的战绩现算一次。数据没到就显示空状态。
  if (page === "profile" && typeof renderProfilePage === "function") renderProfilePage();
  if (page === "growth" && typeof renderGrowthPage === "function") renderGrowthPage();
  if (page === "growth" && typeof renderGrowthExtras === "function") renderGrowthExtras();
  if (page === "tools") {
    populateBgChampionList();
    // 提权提示要在打开工具箱时就显示，不能等用户点"刷新诊断"才出现
    refreshElevationNotice();
    // 分类小标签: 按 .tools-section 现算条数, 顺便把滚动位置归零
    if (typeof initToolsNav === "function") initToolsNav();
    if (typeof PoroSpellLock !== "undefined") {
      const box = document.getElementById("spellLockBox");
      if (box) box.innerHTML = PoroSpellLock.html();
      PoroSpellLock.restoreUi();
    }
  }
  if (page === "hex") {
    renderHexList();
    if (window._gameflowPhase === 'ChampSelect') {
      lolAPI.lcuRequest('GET', '/lol-champ-select/v1/session').then(s => {
        if (s && !s.__error) updateHexRecommendationContext(s, true);
      }).catch(() => {});
    } else if (window._gameflowPhase === 'GameStart' || window._gameflowPhase === 'InProgress') {
      // 加载页才打开 Poro 时 champ-select session 已消失，从 gameflow 恢复模式和所选英雄。
      updateHexRecommendationContext(null, true);
    }
  }
  if (page === "blacklist") {
    renderBlacklistPage();
    if (typeof switchPlayerMemoryTab === "function") switchPlayerMemoryTab(window._pmTab || "memory");
  }
  // 背景原画只在首页/我的画像挂, 其余页摘掉（表格页透出原画会糊）
  if (typeof PoroSplash !== 'undefined') PoroSplash.onPage(page);
  if (page === "profile" && typeof renderChallengeCard === "function") renderChallengeCard();
}
document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", (e) => { e.preventDefault(); switchPage(item.dataset.page); });
});

// ========== 初始化 ==========

// 符文图标映射 (参考 LeagueAkari: perk id -> icon path)
// ddragon 在国内经常超时: 带重试, 并把上次成功的结果缓存到 localStorage 兜底
async function loadPerkIcons(ver) {
  // v2: 除图标外还缓存符文/副系名称 (v1 只有图标, 老缓存没有 name 需要重新拉一次)
  const CACHE_KEY = 'poro.perkMaps.v2';
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const o = JSON.parse(cached);
      perkIconMap = o.perk || {}; styleIconMap = o.style || {};
      perkNameMap = o.perkName || {}; styleNameMap = o.styleName || {};
    }
  } catch (e) { /* 缓存缺失或损坏, 走网络加载 */ }

  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const rr = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/zh_CN/runesReforged.json`, { signal: ctrl.signal }).then(r => r.json());
      if (!Array.isArray(rr) || !rr.length) throw new Error('符文数据为空');
      perkIconMap = {}; styleIconMap = {}; perkNameMap = {}; styleNameMap = {};
      for (const style of rr) {
        styleIconMap[style.id] = style.icon;
        styleNameMap[style.id] = style.name || '';
        for (const slot of (style.slots || [])) for (const rune of (slot.runes || [])) {
          perkIconMap[rune.id] = rune.icon;
          perkNameMap[rune.id] = rune.name || '';
        }
      }
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ perk: perkIconMap, style: styleIconMap, perkName: perkNameMap, styleName: styleNameMap })); } catch (e) {}
      return true;
    } catch (e) {
      if (attempt < 2) { await new Promise(r => setTimeout(r, 600)); continue; }
      // 三次都失败: 已有缓存则不影响使用, 只降级提示
      if (Object.keys(perkIconMap || {}).length) logDebug("符文数据刷新失败, 已使用本地缓存:", e.message);
      else console.warn("符文数据加载失败且无缓存:", e.message);
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

async function init() {
  try {
    if (lolAPI.getUserData) { try { window._userDataPath = await lolAPI.getUserData(); } catch (e) {} }
    // 版本号一律从主进程读 (asar 内 package.json), 渲染层禁止硬编码 —
    // 否则改了 package.json 但 UI 还显示旧号, 会误判成"部署没生效"。
    let appVer = '';
    try { if (lolAPI.getAppVersion) appVer = String(await lolAPI.getAppVersion() || ''); } catch (e) {}
    const setVersionText = (ddragon) => {
      const el = document.getElementById("versionText");
      if (!el) return;
      const v = appVer && appVer !== 'unknown' ? 'v' + appVer : 'v?';
      const d = ddragon ? String(ddragon).replace(/^(\d+)\.(\d+)\.\d+$/, '$1.$2') : '';
      el.textContent = d ? v + " · DDragon " + d : v;
      el.title = appVer ? '应用版本 ' + appVer + (d ? ' / 数据版本 ' + ddragon : '') : '';
    };
    window.__appVersion = appVer;
    setVersionText('');
    await loadStore();
    window.reloadAutomationModeMatrix?.();
    // 把用户自定义热键下发给主进程 (主进程默认键位在收到前先用内置值)
    if (typeof syncHotkeysToMain === 'function') syncHotkeysToMain();
    // 主题要在拿到持久化配置后立刻应用, 否则深色用户每次启动都先闪一下浅色
    applyTheme();
    // 正式主题选择 (C 浅蓝默认 / A 雾紫 / B 暗色玻璃 / dark 经典深色) 覆盖旧的深浅开关
    applyUiTheme(storeGet('uiTheme') || 'c');
    // 恢复导航栏收起/展开偏好
    applyNavCollapsedState();
    // 1.6.32: 挑战分（只在"我的画像"顶部与实时页自己那张卡上显示）。
    // 缓存半小时, 取不到就整块隐藏 —— 不显示 0 分。
    if (typeof PoroChallenge !== 'undefined') {
      PoroChallenge.load().then(() => { if (typeof renderChallengeCard === 'function') renderChallengeCard(); }).catch(() => {});
    }
    // 静态数据 (DDragon/符文图标/英雄网格) 与首页数据并行: 首页不再等待静态资源
    const staticLoad = (async () => {
      try {
        version = await lolAPI.getVersion();
        setVersionText(version);
        const [res, itemRes, spellRes] = await Promise.all([
          lolAPI.getChampions(version),
          lolAPI.getItems(version),
          lolAPI.getSummonerSpells(version)
        ]);
        allChampions = res.champions || {};
        allItems = itemRes?.data || {};
        allSpells = spellRes?.data || {};
        spellMap = {};
        Object.values(allSpells).forEach(s => { spellMap[s.key] = s.image?.full || s.id; });
        // 初始化出装引擎: 角色/伤害类型由 champion.json 的 tags 与 attack/magic 推导,
        // 不依赖手写映射, 缺数据时引擎内部有兜底
        if (typeof poroBuildEngine !== 'undefined') {
          try {
            poroBuildEngine.initialize(allItems, allChampions);
          } catch (e) {
            console.warn('[BuildEngine] 初始化失败:', e && e.message);
          }
        }
        // 英雄映射表重建: 首页提速后可能早于本块渲染, 早期空表需要推翻重算
        champNumMap = null;
        ensureChampMap();
        // 符文图标映射 (参考 LeagueAkari: perk id -> icon path)
        await loadPerkIcons(version);
        // 1.6.24: 符文悬停卡片的事件委托 (首页战绩卡与对局详情共用, 幂等)
        if (typeof runeHoverBind === 'function') runeHoverBind();
        // 1.6.24: 符文名称 + 一句话描述 + 本局结算模板。ddragon 的 runesReforged 只有
        // 名称和图标, 所以描述从客户端自己的 perks.json 取; 客户端没开时静默失败,
        // 卡片退化成"图标 + 名称"。缓存命中时这一步几乎是瞬时的。
        loadRuneMeta().then(ok => {
          if (ok && homeStatsLoaded && homeGamesData && homeGamesData.length
            && (typeof isHomeGameDetailExpanded !== 'function' || !isHomeGameDetailExpanded())) {
            renderHomeGameList();
          }
        });
        renderRoleFilters();
        renderChampionGrid();
        // 首页若已用空映射渲染过 (占位图标), 用真实数据重渲染列表
        if (homeStatsLoaded && homeGamesData && homeGamesData.length) {
          renderHomeModeFilter();
          // 静态资源可能刚好在用户查看详情时完成。不要因此替换整批战绩卡片。
          if (typeof isHomeGameDetailExpanded !== 'function' || !isHomeGameDetailExpanded()) renderHomeGameList();
          refreshHomeChampionRows();
          refreshHomeCoach();
          if (typeof refreshHomeFunStats === 'function') refreshHomeFunStats();
        }
      } catch (e) { console.error("静态数据加载失败", e); }
    })();
    // 加载持久化配置
    loadConfig();
    if (typeof syncSplashToggleBtn === 'function') syncSplashToggleBtn();
    // 持久化开关是在工具箱摘要的 DOMContentLoaded 之后恢复的，
    // 配置完成后立即让顶部摘要和左下状态中心读取同一份最终状态。
    if (typeof refreshToolsOverview === 'function') refreshToolsOverview();
    if (typeof refreshStatusCenter === 'function') refreshStatusCenter();
    loadBlacklist();
    renderBlacklist();
    loadEncounters();
    // 页面深链 (#tools 等)
    const pageHash = (location.hash || '').replace('#', '');
    if (["profile", "champions", "counters", "live", "hex", "tools", "blacklist"].includes(pageHash)) switchPage(pageHash);
  } catch (e) {
    console.error("初始化失败", e);
  }
  await gsRestore();
  // gsRestore 会根据持久化偏好恢复勾选；最后再应用合规模式，确保文字、开关和实际有效状态一致。
  applyComplianceState();
  if (typeof refreshToolsOverview === 'function') refreshToolsOverview();
  if (typeof refreshStatusCenter === 'function') refreshStatusCenter();
  populateBgChampionList();
  loadHexDB().then(() => loadHexAugments()).then(() => { if (document.getElementById("hexList")) renderHexList(); });
  loadJadeCalib();
  loadOpgg();
  loadRuneMemory();
  autoReturnLoad();
  // 大乱斗平衡性调整 (balance.js)。1.5.0/1.5.1 曾在这里调用一个从未实现的 loadAramBalance(),
  // 抛 ReferenceError 掐断了下面全部初始化。现在函数体在 balance.js, 且内部捕获所有错误、不等待结果;
  // test_undef_globals.js 会拦住"调用了但没定义"的情况。
  loadAramBalance().catch(() => {});
  initAutoReturnToggles();
  autoflowLoad();
  chatStatusLoad();
  initUpdate();
  restoreSideAnnounceToggle();
  wireLcuEvents();
  applyTheme();
  loadAiConfig();
  // 外服聊天翻译 + 好友助手 (需在 loadStore 之后的任意时点初始化)
  initGameTranslate();
  initFriendAssist();
  // 严格先完成首页文件缓存渲染，再启动 LCU 探测。两者并发时，国服客户端日志扫描
  // 会占用主进程并让缓存 IPC 排队数秒，造成“缓存命中但首页仍然慢”的假象。
  await loadHomeStats();
  pollLoop();
}

// ========== 快捷键 ==========
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable || e.target.tagName === 'SELECT') return;
  if (e.key === 'PageUp') { e.preventDefault(); sendKDABriefing(true); }
  if (e.key === 'PageDown') { e.preventDefault(); sendKDABriefing(false); }
});

// ========== 1.6.30 新页面区块的胶水层 ==========
// 成长页多出三块 (LP 曲线 / 回放书签 / 账号对比)。它们的数据源都是本机存储,
// 与成长页主体的渲染互不依赖, 所以单独一个入口, 失败不影响原有内容。
function renderGrowthExtras() {
  try {
    const lp = document.getElementById('lpPanel');
    if (lp && typeof PoroLp !== 'undefined') lp.innerHTML = PoroLp.panelHtml();
    if (typeof PoroDrift !== 'undefined') { PoroDrift.recordCurrent(); PoroDrift.render(); }
    if (typeof PoroReplayMarks !== 'undefined') PoroReplayMarks.render();
    if (typeof PoroRankBench !== 'undefined') renderRankBenchPanel();
  } catch (e) {}
}

// 当前账号的单双排队位列 (没有单双排就退到灵活), 拿不到返回空串
async function poroMyRankTier() {
  try {
    const stats = await lolAPI.lcuRequest('GET', '/lol-ranked/v1/current-ranked-stats');
    const qm = stats && (stats.queueMap || stats);
    const entry = qm && (qm.RANKED_SOLO_5x5 || qm.RANKED_FLEX_SR);
    if (entry && entry.tier) return String(entry.tier).toUpperCase();
  } catch (e) {}
  return window.__poroMyTier || '';
}

function poroChampNameOf(id) {
  try {
    const c = typeof champOfLive === 'function' ? champOfLive(id) : null;
    return c ? c.name : '';
  } catch (e) { return ''; }
}

// 同段位基准线面板。先用手上已有的那份立刻上屏, 再补齐当前段位的;
// OP.GG 不可达时 rank-bench 会渲染成"取不到数据", 位置 KPI 自动退回本地经验带。
let _rbkBusy = false;
async function renderRankBenchPanel() {
  const el = document.getElementById('rankBenchPanel');
  if (!el || typeof PoroRankBench === 'undefined') return;
  if (_rbkBusy) return;
  _rbkBusy = true;
  try {
    const cached = PoroRankBench.benchSync();
    if (cached) el.innerHTML = PoroRankBench.html(cached, { champName: poroChampNameOf });
    const tier = await poroMyRankTier();
    if (tier) window.__poroMyTier = tier;
    const bench = await PoroRankBench.ensure(tier, 'global');
    el.innerHTML = bench ? PoroRankBench.html(bench, { champName: poroChampNameOf })
      : PoroRankBench.html({ __error: PoroRankBench.lastErr() || '取不到数据' }, {});
  } catch (e) {
    el.innerHTML = PoroRankBench.html({ __error: (e && e.message) || '未知错误' }, {});
  } finally {
    _rbkBusy = false;
  }
}

// 玩家记忆页的两个标签: 人工档案 / 全部遭遇过的人
function switchPlayerMemoryTab(tab) {
  // 1.6.32: 第三个页签「好友」—— 只读好友列表, 游戏中的那行给旁观按钮
  window._pmTab = tab === 'recent' ? 'recent' : (tab === 'friends' ? 'friends' : 'memory');
  const cur = window._pmTab;
  const recent = cur === 'recent';
  const friends = cur === 'friends';
  const plain = cur === 'memory';
  const list = document.getElementById('blPageList');
  const addRow = document.getElementById('blAddRow');
  const rp = document.getElementById('recentPlayersPanel');
  const fp = document.getElementById('friendsPanel');
  const tabA = document.getElementById('pmTabMemory');
  const tabB = document.getElementById('pmTabRecent');
  const tabC = document.getElementById('pmTabFriends');
  if (list) list.hidden = !plain;
  if (addRow) addRow.hidden = !plain;
  if (rp) rp.hidden = !recent;
  if (fp) fp.hidden = !friends;
  if (tabA) tabA.classList.toggle('active', plain);
  if (tabB) tabB.classList.toggle('active', recent);
  if (tabC) tabC.classList.toggle('active', friends);
  if (recent) renderRecentPlayers();
  if (friends && typeof PoroFriends !== 'undefined') PoroFriends.refresh();
}

// 好友行上的旁观按钮（inline handler 只传 puuid，按钮自己找）
function spectateFriendByPuuid(puuid) {
  if (typeof PoroFriends !== 'undefined') return PoroFriends.spectate(null, puuid);
}

// 背景原画开关：写进本机设置，重启后保持
// 关掉背景后重启 Poro: 按钮若还画成"开启"的样子, 用户会以为设置没生效。
// 启动时按持久化值同步一次按钮外观。
function syncSplashToggleBtn() {
  if (typeof PoroSplash === 'undefined') return;
  const btn = document.getElementById('splashToggleBtn');
  if (!btn) return;
  const on = PoroSplash.enabled();
  btn.classList.toggle('is-off', !on);
  btn.title = on ? '背景原画：已开启（点一下关闭）' : '背景原画：已关闭（点一下开启）';
}

function toggleSplashBg() {
  if (typeof PoroSplash === 'undefined') return;
  const on = PoroSplash.toggle();
  const btn = document.getElementById('splashToggleBtn');
  if (btn) {
    btn.classList.toggle('is-off', !on);
    btn.title = on ? '背景原画：已开启（点一下关闭）' : '背景原画：已关闭（点一下开启）';
  }
  // 关掉之后当前页也要立刻回到纯色，不能等切页
  if (typeof switchPage === 'function' && document.body) {
    const active = document.querySelector('.page.active');
    if (active && active.id) PoroSplash.onPage(active.id.replace('page-', ''));
  }
}

// 画像页顶部的挑战卡：只有本机账号有数据，取不到就整块隐藏
function renderChallengeCard() {
  const box = document.getElementById('challengeCard');
  if (!box || typeof PoroChallenge === 'undefined') return;
  const data = PoroChallenge.get();
  if (!data) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<b>挑战</b><span class="chg-points">' + PoroChallenge.html(data) + '</span>'
    + '<span class="chg-meta">等级 ' + (data.level || '—') + ' · 积分 ' + data.points
    + (data.categories ? ' · ' + data.categories + ' 个分类' : '') + '</span>'
    + '<span class="chg-src">本机账号 · 客户端挑战接口</span>';
}

function renderRecentPlayers(query) {
  const box = document.getElementById('recentPlayersPanel');
  if (!box || typeof PoroRecentPlayers === 'undefined') return;
  const q = typeof query === 'string' ? query : ((document.getElementById('rpQuery') || {}).value || '');
  const sortEl = document.getElementById('rpSort');
  const sort = (sortEl && sortEl.value) || window._rpSort || 'recent';
  window._rpSort = sort;
  const view = PoroRecentPlayers.build(
    (typeof encounterMap === 'object' && encounterMap) ? encounterMap : {},
    (typeof playerMarks === 'object' && playerMarks) ? playerMarks : {},
    { query: q, sort }
  );
  box.innerHTML = PoroRecentPlayers.html(view, { query: q, sort });
  // 重绘后把焦点还给搜索框 (每次按键都会重绘, 不还焦点就只能输入一个字符)
  if (typeof query === 'string' && query) {
    const input = document.getElementById('rpQuery');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
}

// 召唤师技能锁定 (工具箱卡片)
function toggleSpellLock(on) { if (typeof PoroSpellLock !== 'undefined') PoroSpellLock.toggle(on); }
function saveSpellLock() { if (typeof PoroSpellLock !== 'undefined') PoroSpellLock.save(); }

// 回放书签
function addReplayMarkManual() { if (typeof PoroReplayMarks !== 'undefined') PoroReplayMarks.addManual(); }
function editReplayMarkNote(gameId, minute, text) { if (typeof PoroReplayMarks !== 'undefined') { PoroReplayMarks.note(gameId, minute, text); } }
function dropReplayMark(gameId, minute) { if (typeof PoroReplayMarks !== 'undefined') { PoroReplayMarks.remove(gameId, minute); PoroReplayMarks.render(); } }
function openReplayMark(gameId, platformId) { if (typeof PoroReplayMarks !== 'undefined') PoroReplayMarks.open(gameId, platformId); }
function markCurrentReview() { if (typeof PoroReplayMarks !== 'undefined') PoroReplayMarks.markCurrent(); }

// 强化反查
function poroAugmentFit(id, name) { if (typeof PoroHexCross !== 'undefined') PoroHexCross.runFit(id, name); }

// 启动
document.addEventListener("DOMContentLoaded", init);
