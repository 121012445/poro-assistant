'use strict';
// OP.GG 数据: 大乱斗平衡性调整 + 单英雄推荐配置 (符文 / 召唤师技能 / 出装)。
//
// 接口与字段来自 LeagueAkari (MIT) 的 OP.GG 类型定义 (src/shared/types/opgg), 只借用接口事实, 未复制实现:
//   GET /api/contents/aram-balance                                → { data: [{ champion_id, damage_dealt, ... }] }
//   GET /api/{region}/champions/{mode}/{championId}/{position}    → { data: { runes, summoner_spells, starter_items, ... }, meta: { version } }
//       aram / aram_mayhem / urf 用 position=none
// 返回数据一律在这里校验、裁剪成渲染层需要的形状, 渲染层不直接接触 OP.GG 的原始结构。

const HOST = 'lol-api-champion.op.gg';
const BALANCE_TTL_MS = 30 * 60 * 1000;
const BUILD_TTL_MS = 30 * 60 * 1000;
const BUILD_CACHE_MAX = 60;
const MODES = ['ranked', 'aram', 'aram_mayhem', 'urf'];
const POSITIONS = ['top', 'jungle', 'mid', 'adc', 'support', 'none'];

// 平衡字段: percentage 类以 100 为基准 (105 = +5%), literal 类以 0 为基准 (技能急速 +10)。
// effect: 数值变大是增强 (buff) 还是削弱 (nerf) —— 承受伤害变大是削弱。
const BALANCE_FIELDS = [
  { field: 'damage_dealt', key: 'dmgDealt', label: '造成伤害', unit: 'pct', up: 'buff' },
  { field: 'damage_taken', key: 'dmgTaken', label: '承受伤害', unit: 'pct', up: 'nerf' },
  { field: 'healing', key: 'healing', label: '治疗', unit: 'pct', up: 'buff' },
  { field: 'shield_amount', key: 'shielding', label: '护盾', unit: 'pct', up: 'buff' },
  { field: 'attack_speed', key: 'attackSpeed', label: '攻速', unit: 'pct', up: 'buff' },
  { field: 'energy_regen', key: 'energyRegen', label: '能量回复', unit: 'pct', up: 'buff' },
  { field: 'area_of_effect_damage', key: 'aoeDamage', label: '范围伤害', unit: 'pct', up: 'buff' },
  { field: 'cooldown_reduction', key: 'abilityHaste', label: '技能急速', unit: 'flat', up: 'buff' },
  { field: 'tenacity', key: 'tenacity', label: '韧性', unit: 'flat', up: 'buff' }
];

const isPosInt = v => Number.isInteger(v) && v > 0;

// 单个英雄的平衡数据 → 只保留有变化的条目
function normalizeBalanceRow(row) {
  const championId = Number(row && row.champion_id);
  if (!isPosInt(championId) || championId > 10000) return null;
  const changes = [];
  for (const def of BALANCE_FIELDS) {
    const raw = Number(row[def.field]);
    if (!Number.isFinite(raw)) continue;
    const delta = def.unit === 'pct' ? raw - 100 : raw;
    if (Math.abs(delta) < 0.01 || Math.abs(delta) > 1000) continue;
    const increased = delta > 0;
    changes.push({
      key: def.key, label: def.label, unit: def.unit,
      delta: Math.round(delta * 100) / 100,
      effect: (def.up === 'buff') === increased ? 'buff' : 'nerf'
    });
  }
  return { championId, changes };
}

function normalizeBalance(raw) {
  const rows = Array.isArray(raw && raw.data) ? raw.data : [];
  const champions = {};
  for (const row of rows) {
    const n = normalizeBalanceRow(row);
    if (n && n.changes.length) champions[n.championId] = n.changes;
  }
  return { champions, count: Object.keys(champions).length };
}

function intList(list, max) {
  return (Array.isArray(list) ? list : []).map(Number).filter(isPosInt).slice(0, max);
}

// 取第一条 (OP.GG 按热度排序) 合法的符文配置; perkIds 必须是 4 主 + 2 副 + 3 属性 = 9 个
function pickRunes(data) {
  const candidates = [];
  if (Array.isArray(data.runes)) candidates.push(...data.runes);
  if (Array.isArray(data.rune_pages)) for (const page of data.rune_pages) if (Array.isArray(page && page.builds)) candidates.push(...page.builds);
  for (const r of candidates) {
    if (!r) continue;
    const primaryStyleId = Number(r.primary_page_id), subStyleId = Number(r.secondary_page_id);
    const primary = intList(r.primary_rune_ids, 4), secondary = intList(r.secondary_rune_ids, 2), stats = intList(r.stat_mod_ids, 3);
    if (!isPosInt(primaryStyleId) || !isPosInt(subStyleId) || primaryStyleId === subStyleId) continue;
    if (primary.length !== 4 || secondary.length !== 2 || stats.length !== 3) continue;
    return { primaryStyleId, subStyleId, perkIds: primary.concat(secondary, stats), pickRate: Number(r.pick_rate) || 0, games: Number(r.play) || 0 };
  }
  return null;
}

function pickSpells(data) {
  for (const s of Array.isArray(data.summoner_spells) ? data.summoner_spells : []) {
    const ids = intList(s && s.ids, 2);
    if (ids.length === 2 && ids[0] !== ids[1]) return { ids, pickRate: Number(s.pick_rate) || 0 };
  }
  return null;
}

function uniqueIds(rows, maxRows, maxIds) {
  const out = [];
  for (const row of (Array.isArray(rows) ? rows : []).slice(0, maxRows)) {
    for (const id of intList(row && row.ids, 6)) if (!out.includes(id)) out.push(id);
  }
  return out.slice(0, maxIds);
}

// 出装分组 → 客户端装备方案的 blocks
function pickItemBlocks(data) {
  const blocks = [];
  const add = (title, items) => { if (items.length) blocks.push({ title, items }); };
  add('出门装', uniqueIds(data.starter_items, 2, 6));
  add('鞋子', uniqueIds(data.boots, 3, 3));
  (Array.isArray(data.core_items) ? data.core_items : []).slice(0, 3).forEach((row, i) => {
    const pr = Number(row && row.pick_rate);
    add(`核心出装 ${i + 1}` + (Number.isFinite(pr) && pr > 0 ? ` (${(pr * 100).toFixed(1)}%)` : ''), intList(row && row.ids, 6));
  });
  add('棱彩装备', uniqueIds(data.prism_items, 6, 8));
  add('后期可选', uniqueIds(data.last_items, 10, 10));
  return blocks;
}

function normalizeBuild(raw) {
  const data = raw && raw.data;
  if (!data || typeof data !== 'object') return null;
  const championId = Number(data.summary && data.summary.id) || 0;
  return {
    championId,
    version: String((raw.meta && raw.meta.version) || '').slice(0, 20),
    runes: pickRunes(data),
    spells: pickSpells(data),
    itemBlocks: pickItemBlocks(data)
  };
}

function createOpggClient(options) {
  const opts = options || {};
  const httpGet = opts.httpGet;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  let balance = null;            // { t, value }
  let balancePending = null;
  const builds = new Map();      // key → { t, value }

  async function getAramBalance() {
    if (balance && now() - balance.t < BALANCE_TTL_MS) return balance.value;
    if (balancePending) return balancePending;
    balancePending = (async () => {
      try {
        const raw = await httpGet(HOST, '/api/contents/aram-balance');
        const value = Object.assign(normalizeBalance(raw), { fetchedAt: now(), source: 'OP.GG' });
        if (!value.count) throw new Error('OP.GG 平衡数据为空');
        balance = { t: now(), value };
        return value;
      } catch (error) {
        if (balance) return Object.assign({}, balance.value, { stale: true });   // 网络失败时继续用上一份
        throw error;
      } finally { balancePending = null; }
    })();
    return balancePending;
  }

  async function getBuild(mode, championId, position) {
    const m = MODES.includes(mode) ? mode : null;
    const id = Number(championId);
    if (!m) throw new Error('不支持的模式: ' + mode);
    if (!isPosInt(id) || id > 10000) throw new Error('英雄 ID 无效');
    const pos = m === 'ranked' ? (POSITIONS.includes(position) && position !== 'none' ? position : null) : 'none';
    if (!pos) throw new Error('排位/匹配需要分路');
    const key = `${m}|${id}|${pos}`;
    const hit = builds.get(key);
    if (hit && now() - hit.t < BUILD_TTL_MS) return hit.value;
    const raw = await httpGet(HOST, `/api/global/champions/${m}/${id}/${pos}`);
    const value = normalizeBuild(raw);
    if (!value || (!value.runes && !value.spells && !value.itemBlocks.length)) throw new Error('OP.GG 暂无该英雄数据');
    value.championId = value.championId || id;
    value.mode = m;
    value.position = pos;
    builds.delete(key);
    builds.set(key, { t: now(), value });
    while (builds.size > BUILD_CACHE_MAX) builds.delete(builds.keys().next().value);
    return value;
  }

  return { getAramBalance, getBuild };
}

module.exports = { createOpggClient, normalizeBalance, normalizeBuild, BALANCE_FIELDS, MODES, POSITIONS };
