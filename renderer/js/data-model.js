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

// "彩虹海#77843" → { gameName: '彩虹海', tagLine: '77843' }
// 全角 # 一起归一，输入法/复制粘贴经常带进来。
function splitRiotId(label) {
  const raw = String(label == null ? '' : label).trim().replace(/[＃﹟]/g, '#');
  const at = raw.lastIndexOf('#');
  if (at > 0) return { gameName: raw.slice(0, at).trim(), tagLine: raw.slice(at + 1).trim() };
  return { gameName: raw, tagLine: '' };
}

// 档案名字兜底。2026-11-05 实测的三个事实，决定了这一步不能省：
//   1) LCU `/lol-summoner/v2/summoners/puuid/{puuid}` 对外区账号直接 404
//      (`No summoner name for puuid`)，按名字查也是 404 —— 本区之外 LCU 什么都不知道；
//   2) 国服 SGP `summoner-ledge` 对部分账号只回 `name: ""` + `unnamed: true`
//      (彩虹海#77843 就是)，跨区探测能拿到大区/等级/头像，唯独没有名字；
//   3) 所以名字的唯一可靠来源是**调用方手上的 Riot ID**（搜索结果、对局里的
//      riotIdGameName、索引里的 label）。
// 缺这一步时，主页会显示「未知玩家#77843」——Tag 有、名字没有，可战绩列表里
// 明明写着「彩虹海」。这就是"明明有 ID 却不显示"的全部原因。
function fillSummonerName(profile, label) {
  const s = (profile && typeof profile === 'object') ? { ...profile } : {};
  const fromLabel = splitRiotId(label);
  // displayName / name 有可能本身就是完整 Riot ID，也可能是纯名字，一律拆一遍
  const fromDisplay = splitRiotId(s.displayName || '');
  const fromName = splitRiotId(s.name || '');
  // 占位名不是名字：getName() 找不到真名时会回退成「未知」，当成名字会把
  // 「未知#77843」直接渲染到标题上，等于换个字重演同一个 bug。
  const isPlaceholder = v => !v || !v.trim() || /^(未知|未知玩家|unknown|player|\?|-)$/i.test(v.trim());
  const pick = (...vals) => vals.find(v => typeof v === 'string' && !isPlaceholder(v)) || '';
  // gameName 优先信已有字段；LCU 的 gameName 在 Riot ID 化之后恒为空串，会被跳过
  s.gameName = pick(s.gameName, fromDisplay.gameName, fromName.gameName, fromLabel.gameName).trim();
  s.tagLine = String(pick(s.tagLine, fromDisplay.tagLine, fromName.tagLine, fromLabel.tagLine)).trim();
  const clean = {};
  for (const [k, v] of Object.entries(s)) {
    if (v === '' || v == null) continue;   // 与 normalizeSummonerProfile 口径一致：空值不落库
    clean[k] = v;
  }
  return clean;
}

// 展示名（名字#Tag）的唯一拼装入口。
// 直接写 `s.gameName || s.displayName || s.name` + `#tag` 会踩两个坑：
//   · displayName 可能已经是完整 Riot ID，再接一次 Tag 就成了「彩虹海#77843#77843」
//   · 三者都为空时前面会渲染出「未知玩家#77843」，看着像账号坏了
function summonerDisplayName(s) {
  if (!s || typeof s !== 'object') return '未知玩家';
  const filled = fillSummonerName(s, '');
  const base = String(filled.gameName || filled.displayName || filled.name || '').trim();
  const tag = String(filled.tagLine || '').trim();
  if (!base) return tag ? '未知玩家#' + tag : '未知玩家';
  if (base.includes('#')) return base;
  return tag ? base + '#' + tag : base;
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
