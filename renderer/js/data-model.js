'use strict';

const PROFILE_ERROR_FIELDS = new Set(['__error', 'httpStatus', 'errorCode', 'message', 'implementationDetails']);

function validSummonerLevel(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function normalizeSummonerProfile(raw, options = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (PROFILE_ERROR_FIELDS.has(key) || key === 'level') continue;
    if (value === '' || value == null) continue;
    if (key === 'summonerLevel' && !validSummonerLevel(value)) continue;
    if (key === 'profileIconId' && Number(value) < 0) continue;
    result[key] = value;
  }
  // “level”在参赛者对象里通常是本局英雄等级，禁止作为账号等级回退。
  result.summonerLevel = validSummonerLevel(input.summonerLevel) ? Number(input.summonerLevel) : '';
  if (!result.puuid && options.puuid) result.puuid = String(options.puuid);
  if (!result.platformId && options.platformId) result.platformId = String(options.platformId).toUpperCase();
  result.dataMeta = {
    source: String(options.source || input?.dataMeta?.source || 'unknown'),
    platformId: String(options.platformId || input?.platformId || input?.dataMeta?.platformId || '').toUpperCase(),
    fetchedAt: Number(options.fetchedAt || input?.dataMeta?.fetchedAt || Date.now()),
    partial: options.partial != null ? !!options.partial : !validSummonerLevel(input.summonerLevel)
  };
  return result;
}

function mergePlayerProfile(base, incoming, options = {}) {
  const left = normalizeSummonerProfile(base, { source: base?.dataMeta?.source || 'cache' });
  const right = normalizeSummonerProfile(incoming, options);
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (key === 'dataMeta' || value === '' || value == null) continue;
    merged[key] = value;
  }
  merged.dataMeta = {
    ...left.dataMeta,
    ...right.dataMeta,
    partial: !validSummonerLevel(merged.summonerLevel)
  };
  return merged;
}

// 模式统计表中，排位接口的“当前赛段”是权威总战绩。
// 若已有该行，不再追加近期对局中的同模式样本，避免“灵活组排”重复。
const RANKED_MODE_QUEUE_KEYS = Object.freeze({
  '单双排': 'RANKED_SOLO_5x5',
  '排位 单双排': 'RANKED_SOLO_5x5',
  '排位·单双排': 'RANKED_SOLO_5x5',
  '灵活组排': 'RANKED_FLEX_SR',
  '排位·灵活组排': 'RANKED_FLEX_SR'
});

function shouldShowRecentModeRow(modeName, queueMap) {
  const queueKey = RANKED_MODE_QUEUE_KEYS[String(modeName || '')];
  if (!queueKey) return true;
  const ranked = queueMap?.[queueKey];
  return !(ranked?.tier && ((Number(ranked.wins) || 0) + (Number(ranked.losses) || 0) > 0));
}

// 从近期对局的召唤师技能顺序推断闪现键位。技能槽 1 对应 D，槽 2 对应 F。
// 接受 [spell1Id, spell2Id]、{ spells: [...] } 或 Riot 原始参赛者对象，
// 让实时页的 SGP/LCU 两条数据链路共用同一套判定规则。
function summarizeFlashPreference(samples, flashSpellId = 4) {
  let d = 0;
  let f = 0;
  for (const sample of Array.isArray(samples) ? samples : []) {
    const pair = Array.isArray(sample)
      ? sample
      : (Array.isArray(sample?.spells)
          ? sample.spells
          : [sample?.spell1Id ?? sample?.stats?.spell1Id, sample?.spell2Id ?? sample?.stats?.spell2Id]);
    if (Number(pair[0]) === Number(flashSpellId)) d++;
    if (Number(pair[1]) === Number(flashSpellId)) f++;
  }
  const total = d + f;
  if (!total) return null;
  return {
    d,
    f,
    total,
    preferred: d === f ? '' : (d > f ? 'D' : 'F'),
    inconsistent: d > 0 && f > 0
  };
}
