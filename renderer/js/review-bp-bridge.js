// 复盘→BP 闭环：把最近一局的「下局改进方向」沉淀成本地信号，下一局 BP 时读出来，
// 作为对位/阵容/敌方结构之外的第四个信号源：「你上一局暴露的短板，这局选人时补上」。
//
// 数据流：
//   赛后 buildPostGameCoach()  →  extract()  →  storeSet('poro.reviewBpHint', JSON)
//   选人 refresh()             →  load()    →  bp-fusion.blend({ reviewHints })
//
// 设计原则：
//   1) 只存结构化的「短板 key + 该补的英雄 tag」，不存文案 —— 文案归复盘，BP 只认 tag；
//   2) 信号有 7 天保质期，过期自动忽略（版本/打法会变，旧信号不该长期影响选人）；
//   3) 复用 PoroMistakes 的 key（deaths/vision/kp/dmg/...），不另建一套判定；
//   4) 纯函数：extract/adopt 无副作用，存取通过注入的 store（测试可传假对象）。
(function (root) {
  'use strict';

  const STORE_KEY = 'poro.reviewBpHint';
  const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  // 短板 key → 下局选人该补的英雄 tag + 一句人话理由。
  // 与大乱斗/海斗等无视野模式无关的信号由 extract 过滤（mode 决定）。
  const MAP = {
    deaths:   { tags: ['Tank', 'Fighter'],          reason: '上局阵亡偏多，补前排更容错', riftOnly: false },
    vision:   { tags: ['Support'],                   reason: '上局视野不足，补保护/视野', riftOnly: true },
    kp:       { tags: ['Tank', 'Support'],           reason: '上局参团偏低，补开团/跟团', riftOnly: false },
    dmg:      { tags: ['Mage', 'Marksman'],          reason: '上局输出不足，补稳定输出', riftOnly: false },
    objectives:{ tags: ['Tank', 'Fighter'],          reason: '上局资源全丢，补开团吃伤害', riftOnly: true },
    cs:       { tags: [],                            reason: '', riftOnly: false } // 补刀是操作问题，不映射到选人
  };

  // 从 PoroMistakes.detect 结果提取信号。issues: [{key, severity, mode, ...}]
  // 只取 severity>=2 的实质短板，且按严重度降序、最多 3 条，避免 BP 期噪音过多。
  function extract(issues, gameId, mode, now) {
    const list = Array.isArray(issues) ? issues : [];
    const fam = String(mode || 'rift').toLowerCase();
    const rift = fam === 'rift';
    const seen = new Set();
    const out = [];
    for (const it of list.slice().sort((a, b) => (Number(b.severity) || 0) - (Number(a.severity) || 0))) {
      const key = it && it.key;
      const rule = key && MAP[key];
      if (!rule || seen.has(key) || (rule.riftOnly && !rift)) continue;
      if (!rule.tags.length) continue;
      seen.add(key);
      out.push({ key, tags: rule.tags.slice(), reason: rule.reason, gameId: Number(gameId) || 0 });
      if (out.length >= 3) break;
    }
    return { v: 1, ts: Number(now) || Date.now(), mode: fam, hints: out };
  }

  // 存：通过注入的 storeSet（默认取全局）。存的是字符串，与 persist.js 的 storeSet 一致。
  function save(payload, storeSet) {
    const setter = storeSet || (typeof storeSet === 'undefined' && typeof globalThis.storeSet === 'function' ? globalThis.storeSet : null);
    if (!setter) return false;
    try { setter(STORE_KEY, JSON.stringify(payload)); return true; } catch (e) { return false; }
  }

  // 读：兼容 storeGet（同步，persist.js）与 localStorage。
  function load(input, now) {
    let raw = null;
    try {
      if (input && typeof input.get === 'function') raw = input.get(STORE_KEY);
      else if (typeof storeGet === 'function') raw = storeGet(STORE_KEY);
      else if (typeof localStorage !== 'undefined') raw = localStorage.getItem(STORE_KEY);
    } catch (e) { return null; }
    if (!raw) return null;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { return null; }
    if (!parsed || !Array.isArray(parsed.hints)) return null;
    const ts = Number(parsed.ts) || 0;
    if (ts && (Number(now) || Date.now()) - ts > MAX_AGE_MS) return null; // 过期
    return parsed;
  }

  // 转成 bp-fusion needs 条目：{tags, reason, weight, source:'review'}。
  // weight 略低于当场阵容缺口（1.5/1.2），因为上一局的信号不如当前这局已亮的英雄可靠。
  function adopt(payload) {
    if (!payload || !Array.isArray(payload.hints)) return [];
    return payload.hints.map(h => ({
      tags: Array.isArray(h.tags) ? h.tags : [],
      reason: String(h.reason || ''),
      weight: 0.8,
      source: 'review'
    })).filter(n => n.tags.length && n.reason);
  }

  const api = { STORE_KEY, MAX_AGE_MS, MAP, extract, save, load, adopt };
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  if (root) root.PoroReviewBPBridge = api;
})(typeof window !== 'undefined' ? window : this);
