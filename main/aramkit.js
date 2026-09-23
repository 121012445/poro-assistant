'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const HOST = 'data.aramkit.com';
const VERSIONS_PATH = '/data/versions.json';
const VERSIONS_TTL_MS = 6 * 60 * 60 * 1000;
const CHAMPION_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;
let versionsCache = null;

function getJson(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: HOST,
      port: 443,
      path: urlPath,
      method: 'GET',
      headers: { 'User-Agent': 'Poro/1.4', Accept: 'application/json' }
    }, res => {
      let body = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_BYTES) return req.destroy(new Error('海克斯统计响应过大'));
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('ARAMKit HTTP ' + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (error) { reject(new Error('ARAMKit JSON 无效: ' + error.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('ARAMKit 请求超时')));
  });
}

function finiteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeAugment(item, baseline) {
  const id = Number(item?.id);
  const winRate = Number(item?.winRate);
  if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(winRate) || winRate < 0 || winRate > 1) return null;
  return {
    id,
    winRate,
    games: Math.max(0, Number(item.sampleCount) || 0),
    pickRate: Math.max(0, Number(item.pickRate) || 0),
    rank: Math.max(0, Number(item.rank) || 0),
    tier: String(item.tier || '').substring(0, 2),
    globalWinRate: finiteNumber(item.augmentWinRate),
    globalRank: Math.max(0, Number(item.augmentRank) || 0),
    globalTier: String(item.augmentTier || '').substring(0, 2),
    availableStages: (Array.isArray(item.availableStages) ? item.availableStages : [])
      .map(Number).filter(stage => Number.isInteger(stage) && stage >= 1 && stage <= 4),
    lift: Number.isFinite(baseline) ? winRate - baseline : null
  };
}

function augmentMap(rows, baseline) {
  const out = {};
  for (const item of Array.isArray(rows) ? rows : []) {
    const normalized = normalizeAugment(item, baseline);
    if (normalized) out[normalized.id] = normalized;
  }
  return out;
}

function normalizeItems(source) {
  const scopes = {};
  for (const scope of ['filtered', 'unfiltered']) {
    const raw = source?.[scope] || {};
    const normalizeRows = rows => (Array.isArray(rows) ? rows : []).map(item => ({
      id: Math.max(0, Number(item?.id) || 0),
      rank: Math.max(0, Number(item?.rank) || 0),
      games: Math.max(0, Number(item?.sampleCount) || 0),
      pickRate: Math.max(0, Number(item?.pickRate) || 0),
      winRate: finiteNumber(item?.winRate)
    })).filter(item => item.id > 0 && item.winRate != null).slice(0, 120);
    const slots = {};
    for (const [slot, rows] of Object.entries(raw.slots || {})) slots[String(slot)] = normalizeRows(rows);
    scopes[scope] = {
      games: Math.max(0, Number(raw.sampleCount) || 0),
      pickRate: Math.max(0, Number(raw.pickRate) || 0),
      all: normalizeRows(raw.all),
      slots
    };
  }
  return scopes;
}

function normalizeChampionData(raw, championId, versionInfo, scope = 'all') {
  const baseline = Number(raw?.champion?.stats?.winRate);
  const stats = raw?.champion?.stats || {};
  const augmentStages = {};
  for (let stage = 1; stage <= 4; stage++) augmentStages[stage] = augmentMap(raw?.augments?.stages?.[stage], baseline);
  return {
    championId: Number(championId),
    scope,
    version: String(versionInfo.version || ''),
    dataDate: String(versionInfo.dataDate || ''),
    allMatches: Math.max(0, Number(versionInfo.allMatches) || 0),
    highMatches: Math.max(0, Number(versionInfo.highMatches) || 0),
    baseline: Number.isFinite(baseline) ? baseline : null,
    championGames: Math.max(0, Number(stats.sampleCount) || 0),
    champion: {
      rank: Math.max(0, Number(raw?.champion?.rank) || 0),
      tier: String(raw?.champion?.tier || '').substring(0, 2),
      winRate: finiteNumber(stats.winRate),
      pickRate: finiteNumber(stats.pickRate),
      kda: finiteNumber(stats.kda),
      kills: finiteNumber(stats.kills), deaths: finiteNumber(stats.deaths), assists: finiteNumber(stats.assists),
      damage: finiteNumber(stats.damageToChampions), damageTaken: finiteNumber(stats.damageTaken),
      healing: finiteNumber(stats.healsOnTeammates), shielding: finiteNumber(stats.damageShieldedOnTeammates),
      cc: finiteNumber(stats.timeCcingOthers), gold: finiteNumber(stats.goldEarned),
      killParticipation: finiteNumber(stats.killParticipation), damageShare: finiteNumber(stats.damageShare),
      damageGoldEfficiency: finiteNumber(stats.damageGoldEfficiency)
    },
    summoners: (Array.isArray(raw?.summoners) ? raw.summoners : []).map(row => ({
      rank: Math.max(0, Number(row?.rank) || 0),
      spellIds: (Array.isArray(row?.spells) ? row.spells : []).map(s => Number(s?.id)).filter(id => Number.isInteger(id) && id > 0).slice(0, 2),
      games: Math.max(0, Number(row?.sampleCount) || 0), pickRate: finiteNumber(row?.pickRate), winRate: finiteNumber(row?.winRate)
    })).filter(row => row.spellIds.length === 2 && row.winRate != null).slice(0, 8),
    skills: (Array.isArray(raw?.skills) ? raw.skills : []).map(row => ({
      rank: Math.max(0, Number(row?.rank) || 0), order: String(row?.order || '').substring(0, 16),
      games: Math.max(0, Number(row?.sampleCount) || 0), pickRate: finiteNumber(row?.pickRate), winRate: finiteNumber(row?.winRate)
    })).filter(row => /^[QWER](>[QWER]){2,3}$/.test(row.order) && row.winRate != null).slice(0, 8),
    augments: augmentMap(raw?.augments?.all, baseline),
    augmentStages,
    augmentCombinations: (Array.isArray(raw?.augmentCombinations) ? raw.augmentCombinations : []).map(row => ({
      rank: Math.max(0, Number(row?.rank) || 0),
      augmentIds: (Array.isArray(row?.augmentIds) ? row.augmentIds : []).map(Number).filter(id => Number.isInteger(id) && id > 0).slice(0, 6),
      games: Math.max(0, Number(row?.sampleCount) || 0), pickRate: finiteNumber(row?.pickRate), winRate: finiteNumber(row?.winRate)
    })).filter(row => row.augmentIds.length >= 2 && row.winRate != null).slice(0, 30),
    items: normalizeItems(raw?.items),
    builds: {
      filtered: (Array.isArray(raw?.builds?.filtered?.archetypes) ? raw.builds.filtered.archetypes : []).map(row => ({
        key: String(row?.key || '').substring(0, 32), rank: Math.max(0, Number(row?.rank) || 0),
        games: Math.max(0, Number(row?.sampleCount) || 0), pickRate: finiteNumber(row?.pickRate),
        winRate: finiteNumber(row?.calibratedWinRate ?? row?.winRate),
        itemIds: (Array.isArray(row?.profiles?.[0]?.itemSet) ? row.profiles[0].itemSet : [])
          .map(item => Number(item?.id)).filter(id => Number.isInteger(id) && id > 0).slice(0, 6)
      })).filter(row => row.key && row.winRate != null).slice(0, 12),
      unfiltered: (Array.isArray(raw?.builds?.unfiltered?.archetypes) ? raw.builds.unfiltered.archetypes : []).map(row => ({
        key: String(row?.key || '').substring(0, 32), rank: Math.max(0, Number(row?.rank) || 0),
        games: Math.max(0, Number(row?.sampleCount) || 0), pickRate: finiteNumber(row?.pickRate), winRate: finiteNumber(row?.winRate),
        itemIds: (Array.isArray(row?.profiles?.[0]?.itemSet) ? row.profiles[0].itemSet : [])
          .map(item => Number(item?.id)).filter(id => Number.isInteger(id) && id > 0).slice(0, 6)
      })).filter(row => row.key && row.winRate != null).slice(0, 12)
    },
    source: 'ARAMKit',
    fetchedAt: Date.now(),
    stale: false
  };
}

async function getVersions() {
  if (versionsCache && Date.now() - versionsCache.fetchedAt < VERSIONS_TTL_MS) return versionsCache;
  const raw = await getJson(VERSIONS_PATH);
  const selected = (raw.versions || []).find(v => String(v.version) === String(raw.latest)) || raw.versions?.[0];
  if (!selected?.dataPath || !/^[a-zA-Z0-9/_.-]+$/.test(selected.dataPath)) throw new Error('ARAMKit 版本信息无效');
  versionsCache = Object.assign({}, selected, { fetchedAt: Date.now() });
  return versionsCache;
}

function cacheFile(userDataPath, championId, scope) {
  const dir = path.join(userDataPath, 'aramkit-cache');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'champ-' + championId + '-' + scope + '.json');
}

async function getChampionAugments(championId, userDataPath, requestedScope = 'all') {
  const id = Number(championId);
  if (!Number.isInteger(id) || id <= 0 || id > 10000) throw new Error('英雄 ID 无效');
  const scope = requestedScope === 'high' ? 'high' : 'all';
  const file = cacheFile(userDataPath, id, scope);
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  let versionInfo;
  try {
    versionInfo = await getVersions();
    if (cached && cached.version === versionInfo.version && Date.now() - Number(cached.fetchedAt || 0) < CHAMPION_TTL_MS) return cached;
    const raw = await getJson('/' + versionInfo.dataPath + '/stats/' + scope + '/champion-details/' + id + '.json');
    const data = normalizeChampionData(raw, id, versionInfo, scope);
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    return data;
  } catch (error) {
    if (cached?.augments) return Object.assign({}, cached, { stale: true, error: error.message });
    throw error;
  }
}

function resetMemoryCache() { versionsCache = null; }

module.exports = { getChampionAugments, normalizeChampionData, resetMemoryCache };
