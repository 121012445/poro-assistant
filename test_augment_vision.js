'use strict';
const assert = require('assert');
const vision = require('./main/augment-vision');
const augmentRecognizer = require('./main/augment-recognizer');
const ocrMatch = require('./main/augment-ocr-match');
const fs = require('fs');

assert.ok(augmentRecognizer.MAX_CANDIDATES >= 600,
  '视觉识别候选上限必须覆盖当前 552 条目录并为后续新增强化留余量');

const rects = vision.offerIconRects(2560, 1440);
assert.strictEqual(rects.length, 3);
assert.ok(rects[0].x > 600 && rects[0].x < 700, '第一张图标裁剪应避开卡片边框');
assert.ok(rects[1].x > 1100 && rects[1].x < 1200);
assert.ok(rects[2].x > 1600 && rects[2].x < 1700);
assert.ok(rects.every(r => r.y > 280 && r.y < 320), '裁剪顶部不得包含金色卡框');

const ultraCenters = vision.offerCenters(3440, 1440);
assert.strictEqual(Math.round(ultraCenters[1]), 1720, '超宽屏中间卡必须保持屏幕居中');
assert.ok(ultraCenters[0] > 1100 && ultraCenters[2] < 2340, '超宽屏卡片间距应按高度缩放，不能沿用宽度百分比漂向两侧');
const classicCenters = vision.offerCenters(1280, 1024);
assert.ok(classicCenters[0] > 250 && classicCenters[2] < 1030, '4:3 分辨率三张卡应完整落在画面内');
const ultraOcr = vision.offerOcrRect(3440, 1440);
assert.ok(Math.abs((ultraOcr.x + ultraOcr.width / 2) - 1720) <= 1, '超宽屏 OCR 区域必须居中');
const nameRects = vision.offerNameRects(2560, 1440);
assert.strictEqual(nameRects.length, 3, '必须分别裁剪三张卡的名称，不能用一整块 OCR 后猜槽位');
assert.ok(nameRects.every((rect, index) => Math.abs((rect.x + rect.width / 2) - vision.offerCenters(2560, 1440)[index]) <= 1),
  '每张名称裁剪必须与对应卡片中心对齐');
assert.ok(nameRects[0].x + nameRects[0].width < nameRects[1].x, '三张名称裁剪不能互相重叠');
const titleRects = vision.offerTitleRects(2560, 1440);
assert.strictEqual(titleRects.length, 3, '短标题兜底必须逐卡裁剪');
assert.ok(titleRects.every((rect, index) => rect.height < nameRects[index].height && rect.y >= nameRects[index].y),
  '短标题兜底区域必须比完整 OCR 区域更窄并覆盖标题位置');

const n = vision.GRID;
const a = new Uint8Array(n * n);
const b = new Uint8Array(n * n);
const other = new Uint8Array(n * n);
for (let y = 8; y < 26; y++) for (let x = 10; x < 24; x++) a[y * n + x] = 1;
for (let y = 9; y < 27; y++) for (let x = 11; x < 25; x++) b[y * n + x] = 1;
for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) other[y * n + x] = 1;
assert.ok(vision.compareDescriptors(a, b) > 0.95, '轻微平移后的相同图标应稳定命中');
assert.ok(vision.compareDescriptors(a, other) < 0.2, '不同轮廓不能误判为相同图标');

const encoded = vision.descriptorToBase64(a);
assert.deepStrictEqual([...vision.descriptorFromBase64(encoded)], [...a]);
assert.strictEqual(vision.isLikelyOfferScreen([
  { score: 0.644 }, { score: 0.751 }, { score: 0.581 }
]), true, '金色强化卡的较低图标分数也应进入 OCR 名称确认');
assert.strictEqual(vision.isLikelyOfferScreen([
  { score: 0.72 }, { score: 0.49 }, { score: 0.75 }
]), false, '明显缺少一张卡时不应触发 OCR');

const layoutWidth = 1000, layoutHeight = 600;
const layoutBitmap = Buffer.alloc(layoutWidth * layoutHeight * 4);
for (const center of vision.offerCenters(layoutWidth, layoutHeight)) for (const direction of [-1, 1]) {
  const x = Math.round(center + direction * layoutHeight * 0.146);
  for (let y = Math.round(layoutHeight * 0.20); y < Math.round(layoutHeight * 0.64); y++) {
    const i = (y * layoutWidth + x) * 4;
    layoutBitmap[i] = layoutBitmap[i + 1] = layoutBitmap[i + 2] = 180;
    layoutBitmap[i + 3] = 255;
  }
}
const layoutImage = { isEmpty: () => false, getSize: () => ({ width: layoutWidth, height: layoutHeight }), toBitmap: () => layoutBitmap };
assert.strictEqual(vision.isLikelyOfferLayout(layoutImage), true, '三张卡框应能独立触发 OCR');
assert.strictEqual(vision.isLikelyOfferLayout({ ...layoutImage, toBitmap: () => Buffer.alloc(layoutBitmap.length) }), false, '普通暗色画面不能被当作三选一界面');
const brightBattleBitmap = Buffer.alloc(layoutBitmap.length, 150);
for (const center of vision.offerCenters(layoutWidth, layoutHeight)) for (const direction of [-1, 1]) {
  const x = Math.round(center + direction * layoutHeight * 0.146);
  for (let y = Math.round(layoutHeight * 0.20); y < Math.round(layoutHeight * 0.64); y++) {
    const i = (y * layoutWidth + x) * 4;
    brightBattleBitmap[i] = brightBattleBitmap[i + 1] = brightBattleBitmap[i + 2] = 220;
    brightBattleBitmap[i + 3] = 255;
  }
}
assert.strictEqual(vision.isLikelyOfferLayout({ ...layoutImage, toBitmap: () => brightBattleBitmap }), false,
  '战斗画面的偶然亮线没有三块暗色卡面时不能误判为三选一');

const overlapping = ocrMatch.matchAugmentNames(
  '扳 机 炼 狱 伤 害 无 限 循 环 往 复 功 能 艾 卡 西 亚 的 陷 落 伤 害 复 原 力',
  [
    { id: 2005, name: '扳机炼狱' },
    { id: 1388, name: '无限循环往复' },
    { id: 1068, name: '循环往复' },
    { id: 1361, name: '艾卡西亚的陷落' }
  ]
);
assert.deepStrictEqual(overlapping.map(item => item.name), ['扳机炼狱', '无限循环往复', '艾卡西亚的陷落'],
  '被长名称包含的短强化名不能占用另一张卡的识别名额');
assert.deepStrictEqual(ocrMatch.matchAugmentNames('循环往复', [{ id: 1068, name: '循环往复' }, { id: 1388, name: '无限循环往复' }]).map(x => x.name),
  ['循环往复'], '短名称单独出现时仍必须正常识别');
assert.deepStrictEqual(ocrMatch.matchAugmentNames('会 心 治 疔 功 能', [{ id: 118, name: '会心治疗' }]).map(x => x.name),
  ['会心治疗'], '标题单个形近字识别错误时应保守纠正');
assert.deepStrictEqual(ocrMatch.matchAugmentNames('蛋 白 奶 昔 功 能', [{ id: 1324, name: '蛋白粉奶昔' }]).map(x => x.name),
  ['蛋白粉奶昔'], '标题漏掉一个字时应保守纠正');
assert.deepStrictEqual(ocrMatch.matchAugmentNames('功 能 获 得 强 化', [{ id: 7, name: '大力' }]), [],
  '两字标题被完全漏读时禁止 OCR 模糊猜测');
assert.deepStrictEqual(ocrMatch.matchAugmentNames(
  '伤 害 你 的 法 力 消 耗 翻 倍 。',
  [{ id: 1311, name: '溢流' }, { id: 1330, name: '活力再生' }]
).map(x => x.name), ['溢流'], '标题漏读时应由唯一说明短语确认溢流，不能误报活力再生');
assert.strictEqual(augmentRecognizer.isSafeVisualMatch({ score: 0.771, margin: 0.048 }, true), false,
  '本次溢流误报活力再生的低分近邻结果必须被拒绝');
assert.strictEqual(augmentRecognizer.isSafeVisualMatch({ score: 0.91, margin: 0.09 }, true), true,
  '高分且与第二候选差距明确的唯一图标仍可作为 OCR 兜底');
assert.strictEqual(augmentRecognizer.isSafeVisualMatch({ score: 0.93, margin: 0.12 }, false), false,
  '共享图标即使高分也不能仅凭视觉猜名称');
const hexSource = fs.readFileSync('renderer/js/hex.js', 'utf8');
assert.ok(hexSource.includes('AUGMENT_LAYOUT_MISSES_TO_HIDE = 3') && hexSource.includes('AUGMENT_MIN_VISIBLE_MS = 1800'),
  '推荐浮窗应在卡片布局连续消失后快速隐藏');
assert.ok(hexSource.includes('selectedCount > _augmentShownSelectedCount'),
  'Live Client Data 确认选择落地后应立即隐藏推荐浮窗');
assert.ok(!/if \(_augmentScanFailures >= 3\) hideAugmentRecommendation/.test(hexSource),
  'OCR/截图临时失败不能提前清除仍在选择中的推荐');
assert.ok(hexSource.includes('_augmentManualPending = true'), '扫描忙碌时按 F6 必须排队，不能吞掉手动刷新');
assert.ok(hexSource.includes('AUGMENT_OFFER_MEMORY_MS = 6500') && hexSource.includes('_augmentOfferMemory.set(slot'),
  '后期强化应能在足够长的窗口内按卡槽合并多帧结果');
assert.ok(hexSource.includes("confirmedBy: 'vision-repeat'") && hexSource.includes('hits >= 2'),
  'OCR 漏字时应允许连续两帧同名图标安全兜底');
assert.ok(hexSource.includes('restoreAugmentOverlayIfNeeded') && hexSource.includes('_augmentLastPayload'),
  '选卡界面仍存在时应自动恢复意外消失的悬浮层');
const mainSource = fs.readFileSync('main/index.js', 'utf8');
assert.ok(mainSource.includes("Object.assign({ source: source.name, layoutDetected: true }, result)"), '识别成功必须显式回传 layoutDetected=true');
assert.ok(mainSource.includes("confirmedBy: 'ocr'") && mainSource.includes('const ocrBySlot = new Map'),
  '主进程必须回传每个已确认的 OCR 卡槽，不能要求三张同帧成功');
assert.ok(mainSource.includes('cropSize.width * 2') && mainSource.includes("quality: 'best'"),
  '强化名称 OCR 必须先高清放大，避免短标题被说明文字吞掉');
assert.ok(mainSource.includes('titleSize.width * 3') && mainSource.includes('offerTitleRects'),
  '完整 OCR 失败后必须使用三倍标题特写重试');
assert.ok(mainSource.includes('augmentRecognizer.isSafeVisualMatch') && mainSource.includes('iconNames'),
  'OCR 漏掉短标题时只能由高分、高差值且全目录唯一的图标兜底');
assert.ok(mainSource.includes('accepted: safeVisual') && mainSource.includes('item.accepted = safeVisual'),
  '共享或近邻图标无论重复多少帧都不能猜测强化名称');
assert.ok(mainSource.includes("showAugmentOverlayWindow(augmentOverlayWindow, 'did-finish-load')"),
  '透明强化浮窗必须在页面加载完成后再次显示');
assert.ok(mainSource.includes("win.setAlwaysOnTop(true, 'screen-saver', 1)") && mainSource.includes('win.moveTop()'),
  '强化浮窗每次显示都必须恢复全屏置顶层级');
assert.ok(mainSource.includes("ipcMain.handle('augment-overlay:status'"), '强化浮窗必须提供真实可见状态诊断');
console.log('海斗强化画面识别几何与特征测试通过');
