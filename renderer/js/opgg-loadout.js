// 选人锁定英雄后按 OP.GG 数据配置: 符文页 / 召唤师技能 / 客户端装备方案
// (由 settings.js 的「自动符文」触发; 数据来自主进程 main/opgg.js, 已校验过格式)
//
// 优先级: 你保存过的「符文记忆」 > OP.GG 推荐 > 原来的轮换规则 (OP.GG 不可用时)。
// 三项可分别开关, 默认: 符文 开、召唤师技能 关 (改动更明显, 由你决定)、装备方案 开。
// 写入时只动 Poro 自己的东西: 符文页优先用名为「Poro」的页; 装备方案只增删 uid 以 poro- 开头的条目, 你自建的方案原样保留。

const OPGG_LOADOUT_DEFAULTS = { runes: true, spells: false, items: true };
const OPGG_RUNE_PAGE_NAME = 'Poro';
const OPGG_ITEMSET_PREFIX = 'poro-';
const OPGG_ITEMSET_MAX = 20;            // Poro 写入的装备方案最多保留几份 (新的在前)
const FLASH_SPELL_ID = 4;

function opggLoadoutOptions() {
  let saved = {};
  try { saved = JSON.parse(storeGet('opggLoadout') || '{}') || {}; } catch (e) { saved = {}; }
  const out = {};
  for (const k of Object.keys(OPGG_LOADOUT_DEFAULTS)) out[k] = typeof saved[k] === 'boolean' ? saved[k] : OPGG_LOADOUT_DEFAULTS[k];
  return out;
}
function setOpggLoadoutOption(key, on) {
  if (!(key in OPGG_LOADOUT_DEFAULTS)) return;
  const o = opggLoadoutOptions();
  o[key] = !!on;
  storeSet('opggLoadout', JSON.stringify(o));
}
function restoreOpggLoadoutOptions() {
  const o = opggLoadoutOptions();
  for (const k of Object.keys(o)) {
    const el = document.getElementById('opggLoadout_' + k);
    if (el) el.checked = o[k];
  }
}

// 队列 → OP.GG 模式; 其他模式 (斗魂竞技场、克隆等) 返回 null, 不处理
const OPGG_QUEUE_MODES = { 450: 'aram', 2400: 'aram_mayhem', 900: 'urf', 1010: 'urf', 1900: 'urf' };
const OPGG_RANKED_QUEUES = new Set([400, 420, 430, 440, 480, 490, 700]);
function opggModeForQueue(queueId, gameMode) {
  const q = Number(queueId);
  if (OPGG_QUEUE_MODES[q]) return OPGG_QUEUE_MODES[q];
  if (OPGG_RANKED_QUEUES.has(q)) return 'ranked';
  const m = String(gameMode || '').toUpperCase();
  if (m === 'ARAM') return 'aram';
  if (m === 'KIWI') return 'aram_mayhem';
  if (m === 'URF') return 'urf';
  return null;
}

// 选人分配的位置 → OP.GG 分路; 没有分配 (匹配/自选) 时取该英雄最常走的分路
const OPGG_POSITION_ALIASES = { TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'mid', MID: 'mid', BOTTOM: 'adc', ADC: 'adc', UTILITY: 'support', SUPPORT: 'support' };
function opggPositionFor(assignedPosition, championId) {
  const direct = OPGG_POSITION_ALIASES[String(assignedPosition || '').toUpperCase()];
  if (direct) return direct;
  const positions = (typeof opggMap === 'object' && opggMap && opggMap[championId]?.positions) || [];
  let best = null;
  for (const p of positions) {
    const rate = Number(p?.stats?.role_rate) || 0;
    const key = OPGG_POSITION_ALIASES[String(p?.name || '').toUpperCase()];
    if (key && (!best || rate > best.rate)) best = { key, rate };
  }
  return best ? best.key : null;
}

// 召唤师技能顺序: 你习惯把闪现放在 D 还是 F, 就保持在那一格; 否则尽量少换位置
function orderSpells(ids, current) {
  let [a, b] = ids;
  const [oldA, oldB] = [Number(current?.spell1Id) || 0, Number(current?.spell2Id) || 0];
  if (a === FLASH_SPELL_ID || b === FLASH_SPELL_ID) {
    if (oldA === FLASH_SPELL_ID && b === FLASH_SPELL_ID) [a, b] = [b, a];
    else if (oldB === FLASH_SPELL_ID && a === FLASH_SPELL_ID) [a, b] = [b, a];
  } else if (a === oldB || b === oldA) {
    [a, b] = [b, a];
  }
  return [a, b];
}

const OPGG_MODE_NAMES = { ranked: '峡谷', aram: '大乱斗', aram_mayhem: '海斗', urf: '无限火力' };
const OPGG_POSITION_NAMES = { top: '上单', jungle: '打野', mid: '中单', adc: '下路', support: '辅助', none: '' };

// 在现有装备方案里替换 Poro 为该英雄+模式写入的那一份, 你自建的方案不动
function mergeItemSets(existing, build, championId, championName) {
  const sets = Array.isArray(existing?.itemSets) ? existing.itemSets.filter(Boolean) : [];
  const uid = `${OPGG_ITEMSET_PREFIX}${championId}-${build.mode}-${build.position}`;
  const mine = sets.filter(s => String(s.uid || '').startsWith(OPGG_ITEMSET_PREFIX) && s.uid !== uid);
  const others = sets.filter(s => !String(s.uid || '').startsWith(OPGG_ITEMSET_PREFIX));
  const pos = OPGG_POSITION_NAMES[build.position] ? ' · ' + OPGG_POSITION_NAMES[build.position] : '';
  const set = {
    uid,
    title: `Poro OP.GG ${championName} · ${OPGG_MODE_NAMES[build.mode] || build.mode}${pos}`.slice(0, 75),
    type: 'custom', map: 'any', mode: 'any', sortrank: 0, startedFrom: 'blank',
    associatedChampions: [Number(championId)],
    associatedMaps: [],
    preferredItemSlots: [],
    blocks: build.itemBlocks.map(b => ({ type: b.title, items: b.items.map(id => ({ id: String(id), count: 1 })) }))
  };
  return {
    accountId: existing?.accountId,
    timestamp: Date.now(),
    itemSets: [set].concat(mine.slice(0, OPGG_ITEMSET_MAX - 1), others)
  };
}

async function applyOpggRunes(build, championName) {
  const r = build.runes;
  const pages = await lolAPI.lcuRequest('GET', '/lol-perks/v1/pages');
  if (!Array.isArray(pages)) throw new Error('获取符文页失败');
  let page = pages.find(p => p && p.name === OPGG_RUNE_PAGE_NAME && p.isEditable);
  const body = { name: OPGG_RUNE_PAGE_NAME, primaryStyleId: r.primaryStyleId, subStyleId: r.subStyleId, selectedPerkIds: r.perkIds, current: true };
  if (!page) {
    const inv = await lolAPI.lcuRequest('GET', '/lol-perks/v1/inventory');
    if (inv && !inv.__error && inv.canAddCustomPage) {
      const created = await lolAPI.lcuRequest('POST', '/lol-perks/v1/pages', body);
      if (created && !created.__error) return true;
    }
    // 没有空位: 沿用原「自动符文」的做法, 覆盖名为 Auto 的页或第一个可编辑页
    page = pages.find(p => p && p.name === 'Auto' && p.isEditable) || pages.find(p => p && p.isEditable);
  }
  if (!page) throw new Error('没有可编辑的符文页');
  const res = await lolAPI.lcuRequest('PUT', `/lol-perks/v1/pages/${page.id}`, body);
  if (res && res.__error) throw new Error(res.__error);
  return true;
}

async function applyOpggSpells(build) {
  const current = await lolAPI.lcuRequest('GET', '/lol-champ-select/v1/session/my-selection');
  const [spell1Id, spell2Id] = orderSpells(build.spells.ids, current && !current.__error ? current : null);
  const res = await lolAPI.lcuRequest('PATCH', '/lol-champ-select/v1/session/my-selection', { spell1Id, spell2Id });
  if (res && res.__error) throw new Error(res.__error);
  return true;
}

async function applyOpggItemSets(build, championId, championName) {
  const me = await lolAPI.lcuRequest('GET', '/lol-summoner/v1/current-summoner');
  const sid = me && !me.__error ? me.summonerId : null;
  if (!sid) throw new Error('读取召唤师信息失败');
  const existing = await lolAPI.lcuRequest('GET', `/lol-item-sets/v1/item-sets/${sid}/sets`);
  if (!existing || existing.__error) throw new Error('读取装备方案失败');
  const res = await lolAPI.lcuRequest('PUT', `/lol-item-sets/v1/item-sets/${sid}/sets`, mergeItemSets(existing, build, championId, championName));
  if (res && res.__error) throw new Error(res.__error);
  return true;
}

// 返回 { runesApplied, done: [...], failed: [...] }; 不抛异常
async function applyOpggLoadout(championId, champSession, opts) {
  const o = Object.assign({ skipRunes: false }, opts || {});
  const result = { runesApplied: false, done: [], failed: [] };
  const options = opggLoadoutOptions();
  if (complianceOn || !window.lolAPI?.getOpggBuild) return result;
  if (!options.runes && !options.spells && !options.items) return result;
  const flow = await lolAPI.lcuRequest('GET', '/lol-gameflow/v1/session').catch(() => null);
  const mode = opggModeForQueue(flow?.gameData?.queue?.id, flow?.gameData?.queue?.gameMode || flow?.map?.gameMode);
  if (!mode) return result;
  const me = (champSession?.myTeam || []).find(p => p && window._myPuuid && p.puuid === window._myPuuid);
  const position = mode === 'ranked' ? opggPositionFor(me?.assignedPosition, championId) : 'none';
  if (!position) return result;
  const build = await lolAPI.getOpggBuild(mode, championId, position);
  if (!build || build.__error) { result.failed.push('OP.GG: ' + (build?.__error || '无数据')); return result; }
  const championName = champNumMap?.[String(championId)]?.name || ('英雄' + championId);
  const steps = [
    ['runes', '符文', options.runes && !o.skipRunes && build.runes, () => applyOpggRunes(build, championName)],
    ['spells', '召唤师技能', options.spells && build.spells, () => applyOpggSpells(build)],
    ['items', '装备方案', options.items && build.itemBlocks?.length, () => applyOpggItemSets(build, championId, championName)]
  ];
  for (const [key, label, enabled, run] of steps) {
    if (!enabled) continue;
    try {
      await run();
      result.done.push(label);
      if (key === 'runes') result.runesApplied = true;
    } catch (e) {
      result.failed.push(label + ': ' + e.message);
    }
  }
  return result;
}
