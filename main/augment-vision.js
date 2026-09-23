'use strict';

// 海斗三选一图标识别。只处理屏幕像素，不读取游戏进程，也不产生任何输入。
// 卡片位置使用相对坐标，适配 16:9 / 16:10 以及系统缩放；图标先裁掉空白再归一化，
// 因此分辨率和卡片光晕变化不会直接改变匹配结果。

const GRID = 36;
const CARD_OFFSET_BY_HEIGHT = 0.341;
const CARD_BORDER_OFFSET_BY_HEIGHT = 0.146;

function offerCenters(width, height) {
  const middle = width / 2;
  const offset = height * CARD_OFFSET_BY_HEIGHT;
  return [middle - offset, middle, middle + offset];
}

function offerIconRects(width, height) {
  // 刻意避开卡片顶部金框与下方文字；否则长边框会被当前景并压缩真正图标。
  const w = Math.max(96, Math.round(height * 0.187));
  const h = Math.max(96, Math.round(height * 0.175));
  const cy = Math.round(height * 0.2925);
  return offerCenters(width, height).map(cx => ({
    x: Math.max(0, Math.min(width - w, Math.round(cx - w / 2))),
    y: Math.max(0, Math.round(cy - h / 2)),
    width: Math.min(w, width),
    height: Math.min(h, height)
  }));
}

function pixelMask(bitmap, width, height, mode) {
  const mask = new Uint8Array(width * height);
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const b = bitmap[i], g = bitmap[i + 1], r = bitmap[i + 2], a = bitmap[i + 3];
      const lum = (r * 3 + g * 6 + b) / 10;
      const on = mode === 'template'
        ? a > 36 && lum > 30
        // 游戏内图标同时包含亮金与暗灰轮廓，按亮度提取更完整；顶部 10% 是卡框余辉，必须排除。
        : a > 36 && y > height * 0.10 && lum > 43 && r > b * 0.92 && g > b * 0.90;
      if (!on) continue;
      mask[y * width + x] = 1;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { mask, width, height, minX, minY, maxX, maxY, count };
}

function normalizeMask(raw) {
  if (!raw || raw.count < 20 || raw.maxX <= raw.minX || raw.maxY <= raw.minY) return null;
  const boxW = raw.maxX - raw.minX + 1;
  const boxH = raw.maxY - raw.minY + 1;
  const scale = Math.min((GRID - 4) / boxW, (GRID - 4) / boxH);
  const drawW = Math.max(1, boxW * scale);
  const drawH = Math.max(1, boxH * scale);
  const offX = (GRID - drawW) / 2;
  const offY = (GRID - drawH) / 2;
  const out = new Uint8Array(GRID * GRID);
  for (let y = raw.minY; y <= raw.maxY; y++) {
    for (let x = raw.minX; x <= raw.maxX; x++) {
      if (!raw.mask[y * raw.width + x]) continue;
      const tx = Math.max(0, Math.min(GRID - 1, Math.round(offX + (x - raw.minX) * scale)));
      const ty = Math.max(0, Math.min(GRID - 1, Math.round(offY + (y - raw.minY) * scale)));
      out[ty * GRID + tx] = 1;
      // 抗缩放锯齿：保留半径 1 的轮廓覆盖。
      if (tx + 1 < GRID) out[ty * GRID + tx + 1] = 1;
      if (ty + 1 < GRID) out[(ty + 1) * GRID + tx] = 1;
    }
  }
  return out;
}

function descriptorFromImage(image, mode) {
  if (!image || image.isEmpty()) return null;
  const scaled = image.resize({ width: 160, height: 160, quality: 'good' });
  const size = scaled.getSize();
  return normalizeMask(pixelMask(scaled.toBitmap(), size.width, size.height, mode));
}

function shiftedDice(a, b, dx, dy) {
  let both = 0, totalA = 0, totalB = 0;
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const av = a[y * GRID + x] ? 1 : 0;
      const bx = x + dx, by = y + dy;
      const bv = bx >= 0 && bx < GRID && by >= 0 && by < GRID && b[by * GRID + bx] ? 1 : 0;
      totalA += av;
      totalB += bv;
      if (av && bv) both++;
    }
  }
  return totalA + totalB ? (2 * both) / (totalA + totalB) : 0;
}

function compareDescriptors(a, b) {
  if (!a || !b || a.length !== GRID * GRID || b.length !== GRID * GRID) return 0;
  let best = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    best = Math.max(best, shiftedDice(a, b, dx, dy));
  }
  return best;
}

function descriptorToBase64(descriptor) {
  return descriptor ? Buffer.from(descriptor).toString('base64') : '';
}

function descriptorFromBase64(value) {
  try {
    const data = new Uint8Array(Buffer.from(String(value || ''), 'base64'));
    return data.length === GRID * GRID ? data : null;
  } catch (e) { return null; }
}

// 图标相似度只用于判断“三张强化卡是否大概率正在屏幕上”，最终名称仍由 OCR 确认。
// 不同稀有度的卡框、光效和灰度会明显改变图标分数，因此不能要求三张都达到同一高门槛。
function isLikelyOfferScreen(offers) {
  if (!Array.isArray(offers) || offers.length !== 3) return false;
  const scores = offers.map(item => Number(item?.score) || 0);
  const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  return Math.min(...scores) >= 0.52 && Math.max(...scores) >= 0.70 && average >= 0.60;
}

// 三张卡的左右边框在各种稀有度下位置固定。这个几何检测不依赖强化图标缓存，
// 可在新安装、图标刚更新或金色卡光效导致相似度偏低时，安全地触发 OCR。
function isLikelyOfferLayout(image) {
  if (!image || image.isEmpty()) return false;
  const { width, height } = image.getSize();
  if (width < 900 || height < 500) return false;
  const bitmap = image.toBitmap();
  const ratios = [];
  const darkPanels = [];
  const edgePairs = [];
  for (const center of offerCenters(width, height)) {
    const pair = [];
    for (const direction of [-1, 1]) {
      const x = Math.max(0, Math.min(width - 1, Math.round(center + direction * height * CARD_BORDER_OFFSET_BY_HEIGHT)));
      let bright = 0;
      let total = 0;
      for (let y = Math.round(height * 0.20); y < Math.round(height * 0.64); y += 3) {
        const i = (y * width + x) * 4;
        const lum = (bitmap[i + 2] * 3 + bitmap[i + 1] * 6 + bitmap[i]) / 10;
        if (lum > 100) bright++;
        total++;
      }
      const ratio = total ? bright / total : 0;
      ratios.push(ratio);
      pair.push(ratio);
    }
    edgePairs.push(pair);
    // 强化卡内部是三块位置固定的近黑色面板。战斗画面中的塔、血条、技能光效
    // 偶尔也会凑出六条亮线，但不可能同时形成三块完整暗面板。
    let dark = 0;
    let sampled = 0;
    for (let y = Math.round(height * 0.20); y < Math.round(height * 0.64); y += 6) {
      for (let x = Math.round(center - height * 0.10); x < Math.round(center + height * 0.10); x += 6) {
        if (x < 0 || x >= width) continue;
        const i = (y * width + x) * 4;
        const lum = (bitmap[i + 2] * 3 + bitmap[i + 1] * 6 + bitmap[i]) / 10;
        if (lum < 55) dark++;
        sampled++;
      }
    }
    darkPanels.push(sampled ? dark / sampled : 0);
  }
  const strong = ratios.filter(value => value >= 0.40).length;
  const average = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
  const eachCardHasEdge = edgePairs.every(pair => Math.max(...pair) >= 0.40);
  const eachCardHasDarkPanel = darkPanels.every(value => value >= 0.72);
  // 后两轮棱彩光效会让同一侧边框断裂，因此允许每张卡只命中一侧；暗面板条件
  // 负责排除普通战斗画面的偶然亮线，既减少残留，也提升第三、四轮的召回率。
  return strong >= 3 && average >= 0.26 && eachCardHasEdge && eachCardHasDarkPanel;
}

function offerOcrRect(width, height) {
  const desiredWidth = Math.round(height * 1.138);
  const x = Math.max(0, Math.round((width - desiredWidth) / 2));
  return {
    x,
    y: Math.max(0, Math.round(height * 0.37)),
    width: Math.min(width - x, desiredWidth),
    height: Math.min(height, Math.max(48, Math.round(height * 0.105)))
  };
}

function offerNameRects(width, height) {
  // 名称位于卡片中部偏上。保留类型标签和首行说明可提升中文 OCR 的上下文稳定性，
  // 但每个裁剪严格限制在单卡宽度内，避免 Windows OCR 按“左、右、中”重排。
  const w = Math.max(180, Math.round(height * 0.245));
  const h = Math.max(86, Math.round(height * 0.145));
  const y = Math.max(0, Math.round(height * 0.355));
  return offerCenters(width, height).map(center => ({
    x: Math.max(0, Math.min(width - w, Math.round(center - w / 2))),
    y,
    width: Math.min(w, width),
    height: Math.min(h, height - y)
  }));
}

function offerTitleRects(width, height) {
  // 第二遍只看标题与类型标签，避免两字标题被下方更长的说明文字抢走 OCR 注意力。
  const w = Math.max(180, Math.round(height * 0.245));
  const h = Math.max(54, Math.round(height * 0.075));
  const y = Math.max(0, Math.round(height * 0.372));
  return offerCenters(width, height).map(center => ({
    x: Math.max(0, Math.min(width - w, Math.round(center - w / 2))),
    y,
    width: Math.min(w, width),
    height: Math.min(h, height - y)
  }));
}

module.exports = {
  GRID,
  offerCenters,
  offerIconRects,
  offerOcrRect,
  offerNameRects,
  offerTitleRects,
  descriptorFromImage,
  compareDescriptors,
  descriptorToBase64,
  descriptorFromBase64,
  isLikelyOfferScreen,
  isLikelyOfferLayout
};
