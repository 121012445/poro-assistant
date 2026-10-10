// 大乱斗 / 海斗英雄平衡性调整 (数据: OP.GG aram-balance, 由主进程 main/opgg.js 拉取并校验)
//
// 1.5.0 曾在 app.js 调用 loadAramBalance()、在 live.js 调用 balanceTipFor(), 但两个函数从未实现
// (见 docs/source-analysis-20261002.md), 1.5.2 摘除了调用。这里是完整实现:
//   · loadAramBalance(): 永不抛异常, 失败只记日志; 主进程有 30 分钟缓存
//   · 实时对局页 (选人/加载/对局中) 每张玩家卡显示该英雄的调整
//   · 备战区换英雄按钮上也显示, 换之前就能看到
// 海斗 (海克斯大乱斗) 沿用同一份大乱斗平衡数据 (与 balance-buff-viewer 的做法一致);
// 若官方对海斗另有调整, 这里不会反映, 提示文案里写明了来源。

let aramBalance = { champions: {}, loadedAt: 0, stale: false, error: '' };
let _aramBalanceLoading = null;
const ARAM_BALANCE_REFRESH_MS = 30 * 60 * 1000;
const BALANCE_QUEUE_IDS = new Set([450, 2400]);          // 极地大乱斗 / 海克斯大乱斗
const BALANCE_GAME_MODES = new Set(['ARAM', 'KIWI']);

async function loadAramBalance(force) {
  if (!window.lolAPI?.getAramBalance) return aramBalance;
  if (!force && aramBalance.loadedAt && Date.now() - aramBalance.loadedAt < ARAM_BALANCE_REFRESH_MS) return aramBalance;
  if (_aramBalanceLoading) return _aramBalanceLoading;
  _aramBalanceLoading = (async () => {
    try {
      const r = await lolAPI.getAramBalance();
      if (!r || r.__error || !r.champions || typeof r.champions !== 'object') throw new Error(r?.__error || '数据为空');
      aramBalance = { champions: r.champions, loadedAt: Date.now(), stale: !!r.stale, error: '' };
    } catch (e) {
      aramBalance = Object.assign({}, aramBalance, { error: String(e?.message || e) });
      try { lolAPI.debugLog?.('[BALANCE] 加载失败: ' + aramBalance.error); } catch (x) {}
    } finally {
      _aramBalanceLoading = null;
    }
    return aramBalance;
  })();
  return _aramBalanceLoading;
}

function isBalanceMode(queueId, gameMode) {
  return BALANCE_QUEUE_IDS.has(Number(queueId)) || BALANCE_GAME_MODES.has(String(gameMode || '').toUpperCase());
}

function balanceChanges(championId) {
  const list = aramBalance.champions?.[String(Number(championId))];
  return Array.isArray(list) ? list : [];
}

function formatBalanceChange(c) {
  const sign = c.delta > 0 ? '+' : '';
  return c.label + ' ' + sign + c.delta + (c.unit === 'pct' ? '%' : '');
}

// 一行简短说明, 例如 "造成伤害 +5% · 承受伤害 -5%"; 没有调整返回空串
function balanceTipFor(championId) {
  return balanceChanges(championId).map(formatBalanceChange).join(' · ');
}

function balanceOverall(changes) {
  const buff = changes.some(c => c.effect === 'buff'), nerf = changes.some(c => c.effect === 'nerf');
  return buff && nerf ? 'mixed' : buff ? 'buff' : nerf ? 'nerf' : '';
}

// 玩家卡/按钮上的小徽标: 增强绿、削弱红、有增有减黄; 悬停看完整列表
function balanceBadgeHtml(championId) {
  const changes = balanceChanges(championId);
  if (!changes.length) return '';
  const overall = balanceOverall(changes);
  const label = { buff: '增强', nerf: '削弱', mixed: '调整' }[overall];
  const title = '大乱斗平衡性调整 (OP.GG' + (aramBalance.stale ? ', 数据可能过期' : '') + '): ' + balanceTipFor(championId);
  return `<span class="lp-balance lp-balance-${overall}" title="${escapeHtml(title)}">${label}</span>`;
}

// ============ 英雄强度角标 (OP.GG 各模式强度榜) ============
// 大乱斗 / 海斗 / 无限火力的选人阶段, 在英雄头像旁标出该英雄在「当前模式」下的强度等级。
// 不用英雄库页那份排位 (峡谷) 数据: 排位的强度放到大乱斗里是误导。
// 注意: 这是 Poro 自己界面里的信息, 不是往游戏客户端里注入角标。
const TIER_QUEUE_MODES = { 450: 'aram', 2400: 'aram_mayhem', 900: 'urf', 1010: 'urf', 1900: 'urf' };
const TIER_LABELS = { 0: 'OP', 1: '1', 2: '2', 3: '3', 4: '4', 5: '5' };
const TIER_TTL_MS = 60 * 60 * 1000;
const modeTiers = {};              // mode → { champions, loadedAt, stale }
const _modeTierLoading = {};

function tierModeFor(queueId, gameMode) {
  const q = Number(queueId);
  if (TIER_QUEUE_MODES[q]) return TIER_QUEUE_MODES[q];
  const m = String(gameMode || '').toUpperCase();
  return m === 'ARAM' ? 'aram' : m === 'KIWI' ? 'aram_mayhem' : m === 'URF' ? 'urf' : null;
}

async function loadModeTiers(mode, force) {
  if (!mode || !window.lolAPI?.getModeTiers) return null;
  const have = modeTiers[mode];
  if (!force && have && Date.now() - have.loadedAt < TIER_TTL_MS) return have;
  if (_modeTierLoading[mode]) return _modeTierLoading[mode];
  _modeTierLoading[mode] = (async () => {
    try {
      const r = await lolAPI.getModeTiers(mode);
      if (!r || r.__error || !r.champions || typeof r.champions !== 'object') throw new Error(r?.__error || '数据为空');
      modeTiers[mode] = { champions: r.champions, loadedAt: Date.now(), stale: !!r.stale };
    } catch (e) {
      try { lolAPI.debugLog?.('[TIER] ' + mode + ' 加载失败: ' + (e?.message || e)); } catch (x) {}
    } finally { delete _modeTierLoading[mode]; }
    return modeTiers[mode] || null;
  })();
  return _modeTierLoading[mode];
}

function modeTierOf(mode, championId) {
  const row = modeTiers[mode]?.champions?.[String(Number(championId))];
  return row && Object.prototype.hasOwnProperty.call(TIER_LABELS, row.tier) ? row : null;
}

// 角标: 1 阶最强。OP 和 1 用强调色, 4/5 用弱化色, 其余中性; 悬停写清楚模式、排名、来源
const TIER_MODE_NAMES = { aram: '大乱斗', aram_mayhem: '海克斯大乱斗', urf: '无限火力' };
function modeTierBadgeHtml(mode, championId) {
  const row = modeTierOf(mode, championId);
  if (!row) return '';
  const cls = row.tier <= 1 ? 'top' : row.tier >= 4 ? 'low' : 'mid';
  const title = `${TIER_MODE_NAMES[mode] || mode}强度 ${TIER_LABELS[row.tier]} 阶` + (row.rank ? ` · 排名 ${row.rank}` : '') + ' (OP.GG' + (modeTiers[mode]?.stale ? ', 数据可能过期' : '') + ')';
  const text = row.tier === 0 ? 'OP' : 'T' + TIER_LABELS[row.tier];     // OP 不加 T 前缀, 否则读成 "TOP"
  return `<span class="lp-tier lp-tier-${cls}" title="${escapeHtml(title)}">${text}</span>`;
}
