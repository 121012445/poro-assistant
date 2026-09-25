// Poro - 主应用脚本
let version = "16.17.1";
let allChampions = {};
let allItems = {};
let allSpells = {};
let spellMap = {};
let perkIconMap = {};
let styleIconMap = {};
let currentRole = "all";
let autoAcceptOn = false;
let lcuConnected = false;
let opggMap = {};   // op.gg 数据: championKey -> average_stats + positions

const CDN = "https://ddragon.leagueoflegends.com/cdn";
const CDG = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default";
const ROLE_MAP = { Fighter: "战士", Mage: "法师", Assassin: "刺客", Marksman: "射手", Support: "辅助", Tank: "坦克" };
const ROLES = ["all", "上单", "打野", "中单", "下路", "辅助"];
const POS_MAP = { TOP: "上单", JUNGLE: "打野", MID: "中单", ADC: "下路", SUPPORT: "辅助" };
// 职业克制矩阵: key 职业 克制 value 列表中的职业 (参考关系, 非官方数据)
// 国服队列ID优先 (2400=海克斯大乱斗, 4320=经典模式人机), 其次 gameMode 字符串
const QUEUE_NAMES = { 0: "自定义", 420: "单双排", 430: "匹配模式", 440: "灵活组排", 450: "极地大乱斗", 870: "人机", 880: "人机", 881: "人机", 882: "人机", 900: "无限火力", 1020: "克隆大作战", 1300: "极限闪击", 1700: "斗魂竞技场", 1710: "斗魂竞技场", 1750: "斗魂竞技场", 2400: "海克斯大乱斗", 4320: "人机", 1090: "训练工具" };
const QUEUE_MODE_MAP = { 0: { gameMode: "CLASSIC", mapId: 11 }, 420: { gameMode: "CLASSIC", mapId: 11 }, 430: { gameMode: "CLASSIC", mapId: 11 }, 440: { gameMode: "CLASSIC", mapId: 11 }, 450: { gameMode: "KIWI", mapId: 12 }, 900: { gameMode: "URF", mapId: 11 }, 1020: { gameMode: "ONEFORALL", mapId: 11 }, 1300: { gameMode: "NEXUSBLITZ", mapId: 12 }, 1700: { gameMode: "SKIRMISH", mapId: 11 }, 2400: { gameMode: "KIWI", mapId: 12 }, 4320: { gameMode: "CLASSIC", mapId: 11 }, 1090: { gameMode: "PRACTICETOOL", mapId: 11 } };
const MODE_NAMES = { CLASSIC: "召唤师峡谷", KIWI: "极地大乱斗", ARAM: "极地大乱斗", JADE: "经典模式", URF: "无限火力", NEXUSBLITZ: "极限闪击", ONEFORALL: "克隆大作战", ASCENSION: "飞升", SKIRMISH: "斗魂竞技场", CHERRY: "斗魂竞技场", TUTORIAL: "新手教程", KIWI_JADE: "海克斯大乱斗", SWIFTPLAY: "快速对局", PRACTICETOOL: "训练工具" };
function modeName(g) { return QUEUE_NAMES[g.queueId] || MODE_NAMES[g.gameMode] || g.gameMode || "其他"; }
// 训练模式 (训练工具/新手教程) 和 自定义对局 不计入战绩卡片和模式统计
const TRAINING_MODES = new Set(["训练工具", "新手教程", "TUTORIAL"]);
function isTrainingGame(g) { return TRAINING_MODES.has(g.mode) || g.queueId === 1090 || g.gameMode === "TUTORIAL"; }
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

// ========== 页面切换 ==========
function switchPage(page) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.getElementById("page-" + page)?.classList.add("active");
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add("active");
  if (page === "champions") renderChampionGrid();
  if (page === "counters") updateCounterClientPick();
  if (page === "tools") populateBgChampionList();
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
  if (page === "blacklist") renderBlacklistPage();
}
document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", (e) => { e.preventDefault(); switchPage(item.dataset.page); });
});

// ========== 初始化 ==========

// 符文图标映射 (参考 LeagueAkari: perk id -> icon path)
// ddragon 在国内经常超时: 带重试, 并把上次成功的结果缓存到 localStorage 兜底
async function loadPerkIcons(ver) {
  const CACHE_KEY = 'poro.perkMaps.v1';
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const o = JSON.parse(cached);
      perkIconMap = o.perk || {}; styleIconMap = o.style || {};
    }
  } catch (e) { /* 缓存缺失或损坏, 走网络加载 */ }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const rr = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/zh_CN/runesReforged.json`, { signal: ctrl.signal }).then(r => r.json());
      clearTimeout(timer);
      if (!Array.isArray(rr) || !rr.length) throw new Error('符文数据为空');
      perkIconMap = {}; styleIconMap = {};
      for (const style of rr) {
        styleIconMap[style.id] = style.icon;
        for (const slot of (style.slots || [])) for (const rune of (slot.runes || [])) perkIconMap[rune.id] = rune.icon;
      }
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ perk: perkIconMap, style: styleIconMap })); } catch (e) {}
      return true;
    } catch (e) {
      if (attempt < 2) { await new Promise(r => setTimeout(r, 600)); continue; }
      // 三次都失败: 已有缓存则不影响使用, 只降级提示
      if (Object.keys(perkIconMap || {}).length) console.log("符文数据刷新失败, 已使用本地缓存:", e.message);
      else console.warn("符文数据加载失败且无缓存:", e.message);
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
        // 英雄映射表重建: 首页提速后可能早于本块渲染, 早期空表需要推翻重算
        champNumMap = null;
        ensureChampMap();
        // 符文图标映射 (参考 LeagueAkari: perk id -> icon path)
        await loadPerkIcons(version);
        renderRoleFilters();
        renderChampionGrid();
        // 首页若已用空映射渲染过 (占位图标), 用真实数据重渲染列表
        if (homeStatsLoaded && homeGamesData && homeGamesData.length) {
          renderHomeModeFilter();
          renderHomeGameList();
          refreshHomeChampionRows();
          if (typeof refreshHomeFunStats === 'function') refreshHomeFunStats();
        }
      } catch (e) { console.error("静态数据加载失败", e); }
    })();
    // 加载持久化配置
    loadConfig();
    loadBlacklist();
    renderBlacklist();
    loadEncounters();
    // 页面深链 (#tools 等)
    const pageHash = (location.hash || '').replace('#', '');
    if (["champions", "counters", "live", "hex", "tools", "blacklist"].includes(pageHash)) switchPage(pageHash);
  } catch (e) {
    console.error("初始化失败", e);
  }
  await gsRestore();
  // gsRestore 会根据持久化偏好恢复勾选；最后再应用合规模式，确保文字、开关和实际有效状态一致。
  applyComplianceState();
  populateBgChampionList();
  loadHexDB().then(() => loadHexAugments()).then(() => { if (document.getElementById("hexList")) renderHexList(); });
  loadJadeCalib();
  loadOpgg();
  wireLcuEvents();
  applyTheme();
  loadAiConfig();
  // 严格先完成首页文件缓存渲染，再启动 LCU 探测。两者并发时，国服客户端日志扫描
  // 会占用主进程并让缓存 IPC 排队数秒，造成“缓存命中但首页仍然慢”的假象。
  await loadHomeStats();
  pollLoop();
}

// ========== 快捷键 ==========
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'PageUp') { e.preventDefault(); sendKDABriefing(true); }
  if (e.key === 'PageDown') { e.preventDefault(); sendKDABriefing(false); }
});

// 启动
document.addEventListener("DOMContentLoaded", init);
