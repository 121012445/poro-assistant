'use strict';

function normalizeOcrText(value) {
  return String(value || '').toLocaleLowerCase('zh-CN').replace(/[^0-9a-z\u3400-\u9fff]+/g, '');
}

function editDistance(a, b) {
  const left = [...String(a || '')], right = [...String(b || '')];
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length];
}

// 少数两字强化标题在金色/棱彩光效下会被 Windows OCR 完全漏掉，但说明文字
// 仍然清晰。这里只收录含义唯一、不会出现在其它强化说明里的短语；它们用于确认
// 候选名称，不参与模糊猜测。这样可区分图标轮廓非常接近的“溢流/活力再生”。
const DESCRIPTION_HINTS = Object.freeze({
  '溢流': ['法力消耗翻倍']
});

function descriptionHintMatches(normalized, candidates) {
  if (!normalized) return [];
  const matches = [];
  const seen = new Set();
  for (const row of (Array.isArray(candidates) ? candidates : [])) {
    const name = String(row?.name || '').trim();
    if (!name || seen.has(name)) continue;
    const hints = DESCRIPTION_HINTS[name] || [];
    if (!hints.some(hint => normalized.includes(normalizeOcrText(hint)))) continue;
    seen.add(name);
    matches.push({
      index: Math.min(...hints.map(hint => normalized.indexOf(normalizeOcrText(hint))).filter(index => index >= 0)),
      end: normalized.length,
      length: normalizeOcrText(name).length,
      id: Number(row.id) || 0,
      name,
      icon: String(row.icon || ''),
      confirmedBy: 'description-hint'
    });
  }
  return matches.sort((a, b) => a.index - b.index);
}

// Windows OCR 偶尔会把标题中的一个字识成形近字（治疗→治疔），或漏掉一个字。
// 标题位于每张独立裁剪的开头，因此只在开头很短的窗口内做保守纠错；2 字名称
// 不做模糊猜测，避免“大力/火狐/圣火”之类互相误判，交给唯一图标连续确认。
function fuzzyTitleMatch(normalized, candidates) {
  if (!normalized) return null;
  const prefix = normalized.slice(0, 32);
  const ranked = [];
  const seen = new Set();
  for (const row of (Array.isArray(candidates) ? candidates : [])) {
    const name = String(row?.name || '').trim();
    const needle = normalizeOcrText(name);
    if (needle.length < 3 || seen.has(name)) continue;
    seen.add(name);
    const maxDistance = needle.length >= 6 ? 2 : 1;
    let best = Infinity;
    for (let start = 0; start <= Math.min(6, Math.max(0, prefix.length - 1)); start++) {
      for (const delta of [-1, 0, 1]) {
        const length = needle.length + delta;
        if (length < 2 || start + length > prefix.length) continue;
        best = Math.min(best, editDistance(needle, prefix.slice(start, start + length)));
      }
    }
    if (best <= maxDistance) ranked.push({ id: Number(row.id) || 0, name, icon: String(row.icon || ''), distance: best, length: needle.length });
  }
  ranked.sort((a, b) => a.distance - b.distance || b.length - a.length || a.name.localeCompare(b.name, 'zh-CN'));
  if (!ranked.length) return null;
  const best = ranked[0], second = ranked[1];
  // 同距离同长度存在多个答案时拒绝猜测。
  if (second && second.distance === best.distance && second.length === best.length) return null;
  return best;
}

// OCR 返回的是一段连续文本。强化名称可能互相包含，例如“无限循环往复”包含“循环往复”。
// 先选最长且互不重叠的名称，再恢复画面顺序，避免短名称占掉第三张卡的名额。
function matchAugmentNames(text, candidates, limit = 3) {
  const normalized = normalizeOcrText(text);
  if (!normalized) return [];
  const occurrences = [];
  const seenNames = new Set();
  for (const row of (Array.isArray(candidates) ? candidates : [])) {
    const name = String(row?.name || '').trim();
    const needle = normalizeOcrText(name);
    if (!needle || seenNames.has(name)) continue;
    seenNames.add(name);
    let from = 0;
    while (from <= normalized.length - needle.length) {
      const index = normalized.indexOf(needle, from);
      if (index < 0) break;
      occurrences.push({
        index,
        end: index + needle.length,
        length: needle.length,
        id: Number(row.id) || 0,
        name,
        icon: String(row.icon || '')
      });
      from = index + Math.max(1, needle.length);
    }
  }
  occurrences.sort((a, b) => b.length - a.length || a.index - b.index);
  const selected = [];
  const selectedNames = new Set();
  for (const item of occurrences) {
    if (selectedNames.has(item.name)) continue;
    if (selected.some(other => item.index < other.end && item.end > other.index)) continue;
    selected.push(item);
    selectedNames.add(item.name);
  }
  const exact = selected.sort((a, b) => a.index - b.index).slice(0, Math.max(0, Number(limit) || 0));
  if (exact.length) return exact;
  const hinted = descriptionHintMatches(normalized, candidates).slice(0, Math.max(0, Number(limit) || 0));
  if (hinted.length) return hinted;
  const fuzzy = fuzzyTitleMatch(normalized, candidates);
  return fuzzy ? [Object.assign({ index: 0, end: fuzzy.length }, fuzzy)] : [];
}

module.exports = { DESCRIPTION_HINTS, normalizeOcrText, editDistance, descriptionHintMatches, fuzzyTitleMatch, matchAugmentNames };
