'use strict';
/**
 * 选人浮窗的位置计算 —— 刻意做成**纯函数**, 不依赖 electron, 便于单测。
 *
 * 坐标全部是 Electron 的 DIP 空间 (与 screen.workArea / BrowserWindow.setBounds 一致)。
 * 读取客户端窗口矩形的活由 win-rect.js 负责, 这里只管"拿到矩形之后摆哪儿"。
 */

const OVERLAY_SIZE = { width: 244, height: 336 };
const OVERLAY_GAP = 8;   // 与客户端边缘留一点缝, 免得视觉上糊在一起

// 客户端最小化/被隐藏时, Windows 会给出这类哨兵矩形:
//   {x:-21333, y:-21333, w:158, h:26}   (实测国服客户端最小化)
//   {x:-32000, y:-32000, ...}           (系统托盘类)
// 拿它去摆浮窗会把窗甩到屏幕外, 所以必须先判掉。
function isUsableClientRect(r) {
  if (!r) return false;
  if (!['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k]))) return false;
  if (r.width < 200 || r.height < 50) return false;   // 塌缩成小条 = 最小化
  if (r.x < -10000 || r.y < -10000) return false;     // 负得离谱 = 已移出桌面
  if (r.width > 20000 || r.height > 20000) return false;
  return true;
}

// 没有可用客户端矩形时的兜底: 贴主屏工作区右侧、垂直居中 (客户端通常居中/靠左, 这样不挡画面)
function defaultOverlayBounds(workArea, size) {
  const wa = workArea || { x: 0, y: 0, width: 1280, height: 720 };
  const s = size || OVERLAY_SIZE;
  return {
    x: Math.round(wa.x + wa.width - s.width - 16),
    y: Math.round(wa.y + Math.max(0, (wa.height - s.height) / 2)),
    width: s.width,
    height: s.height
  };
}

/**
 * @param {object} req
 * @param {object|null} req.clientRect  客户端窗口矩形 (DIP)
 * @param {object} req.workArea         该显示器的可用区 (DIP)
 * @param {object} [req.size]           浮窗尺寸
 * @param {object|null} [req.saved]     用户拖拽后保存的位置; 有则原样沿用
 */
function computeOverlayBounds(req) {
  const r = req || {};
  const size = r.size || OVERLAY_SIZE;
  const wa = r.workArea || { x: 0, y: 0, width: 1280, height: 720 };

  // 用户手动摆过就以用户为准 —— 自动吸附不该覆盖用户的明确意图
  if (r.saved) return r.saved;
  if (!isUsableClientRect(r.clientRect)) return defaultOverlayBounds(wa, size);

  const c = r.clientRect;
  const maxX = wa.x + wa.width - size.width;
  const rightX = c.x + c.width + OVERLAY_GAP;
  const leftX = c.x - size.width - OVERLAY_GAP;

  let x;
  if (rightX <= maxX) {
    x = rightX;                                    // 贴客户端右外侧 (最常见)
  } else if (leftX >= wa.x) {
    x = leftX;                                     // 右边放不下就贴左外侧
  } else {
    // 两侧都放不下 (客户端最大化/占满屏幕): 压回客户端右缘 ——
    // 这正是 Akari 的行为, 也是玩家看到"它就贴在客户端上"的来源。
    x = Math.max(wa.x, Math.min(c.x + c.width - size.width, maxX));
  }

  // 垂直方向与客户端顶部对齐, 再夹进工作区, 保证整个窗都在屏幕内
  const y = Math.max(wa.y, Math.min(c.y, wa.y + wa.height - size.height));

  return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height };
}

// 对局聊天框 OCR 的裁剪矩形 —— 同样做成纯函数, 便于单测。
//
// 1.5.53: 用用户真实帧把裁剪带/放大倍数试穿了 (同一帧喂给 Poro 自己的
// PoroOcrWorker.ps1, 对比 2x/3x/4x/5x × 6 条裁剪带)。结论:
//   · 聊天列实测在 y≈48~54%、x 0~14% (1440p), 是一条很窄的带;
//   · 2x 时 "hello everyone" 被读成 "helldeveryone"/"hellöeveryone";
//     **y45~62% + 4x** 能完整读对, 5 条消息全部识别出来;
//   · 二值化/反色/灰度全都更差 (把抗锯齿的文字边缘切碎了), 不要用。
// 之前 1.5.50 用 x0~30% / y5~62%, 把 "/help 获取命令列表"、队伍面板一起截进来。
// 1.5.54: 又用一张 26 分钟对局的真实全屏帧重测 (2560x1440, 9 条聊天在列表里)。
// 关键修正 —— 之前的带**偏下且偏窄**:
//   · 聊天列表底部锚定在 y≈0.537, 往上长; 9 行时首行在 y≈0.407。原来从 0.45
//     起裁, 上面 3 行直接被切掉, 而下面是 80px 的游戏画面 (纯噪声);
//   · 最长的 "hi everyone i'm from shenzhen" 右端到 x≈0.230, 原来 0.22 把它
//     截成 "shenzhe" —— 宁可多 3% 也不能切字。
// 于是改成 y0.40~0.575 / x0~0.25。列表只会往上长, 最新消息永远在底部,
// 所以固定裁下半段不会漏新消息。
// 1.5.55: 同一块带在两局里表现**不一致** —— 深色背景那局 4x 就全对, 亮色丛林
// 背景那局 4x 把 4 行聊天读成 "0" / "1" / 两行界面文字, 一条消息都没出来。
// 把同一帧按 Poro 的真实输出尺寸 (640x252 再放大 S 倍) 逐个试:
//   4x → 0 条聊天; 5x → "hello everyone" + "hello" 都对; 8x → 也对但更慢。
// 取 5x (实测单帧 278ms, 4x 是冷启动 1.9s, 8x 是 637ms)。
const CHAT_OCR_RECT = { x: 0, y: 0.40, width: 0.25, height: 0.175 };
// 1.5.72: 放大倍数改成"按目标宽度算", 不再写死 5/6 倍。
// 05:44 局真实帧上按 1.5/2/2.5/3/3.5/4/5x 逐个跑真引擎 (zh-Hans), 结论很干脆:
//   1.5x / 2x  → "our top too strong" / "Our top is too strong" 词边界全对
//   2.5x 起    → 开始断词 "our t0P to 0 strong"
//   5x         → 最差 "our to p 地 0 strong"
// 高倍放大把抗锯齿后的字框间隙也放大了, 引擎于是按字符切开单词; 顺带把时间戳
// "01:18" 读成 "山：18" —— 时间戳一丢, 去重键就没了, 同一条消息每 4 秒重进一次
// 管线 (日志实证: `ocr lines +1 last="O 0 too strong@无键"`)。
// 所以按**目标宽度**反推倍数: 不同分辨率下 OCR 拿到的字高恒定, 不随分辨率漂移。
const CHAT_OCR_TARGET_W = 1280;
const CHAT_OCR_SCALE_MIN = 1.5;
const CHAT_OCR_SCALE_MAX = 3;
const CHAT_OCR_OVERLAY_GAP = 6;    // 与浮窗留的缝 (像素)
const CHAT_OCR_MIN_KEEP = 0.5;     // 浮窗最多吃掉一半高度, 再多就不裁 (宁可糊, 不能空)

// 两档都跑 (1.5.56 的结论: 单档必然有一类帧读不对)。
// 1.5.74: **大的一档排前面**。去重层只认先到的那条 (同一时间戳的后续版本会被判重),
// 所以顺序就是"谁说了算"。14:14 局实证: 同一条 "how are u"
//   2.0x → "hö/are u"  (机翻给"豪阿乌")
//   2.4x → "how are u"  (正确)
// 反过来时用户看到的就是音译。两档都覆盖 1.5~3 的"不断词"区间, 所以调换顺序不会
// 把 05:44 那种帧读坏 (那帧 2.4 读 "our top too strong", 比 2.0 的 "our t0P" 还准)。
function chatOcrScales(width) {
  const w = Math.max(1, Number(width) || 0);
  const k = Math.min(CHAT_OCR_SCALE_MAX, Math.max(CHAT_OCR_SCALE_MIN, CHAT_OCR_TARGET_W / w));
  const main = Math.round(Math.min(CHAT_OCR_SCALE_MAX, k + 0.4) * 100) / 100;
  const fallback = Math.round(k * 100) / 100;
  return [main, fallback];
}

function chatOcrCrop(size, overlay) {
  const w = Math.max(1, Math.round((size && size.width) || 0));
  const h = Math.max(1, Math.round((size && size.height) || 0));
  const rect = {
    x: Math.round(w * CHAT_OCR_RECT.x),
    y: Math.round(h * CHAT_OCR_RECT.y),
    width: Math.max(1, Math.min(w, Math.round(w * CHAT_OCR_RECT.width))),
    height: Math.max(1, Math.round(h * CHAT_OCR_RECT.height))
  };
  rect.height = Math.max(1, Math.min(rect.height, h - rect.y));
  if (!overlay || !Number.isFinite(overlay.y)) return rect;
  const oTop = overlay.y;
  const oBottom = overlay.y + (Number.isFinite(overlay.height) ? overlay.height : 0);
  const oRight = overlay.x + (Number.isFinite(overlay.width) ? overlay.width : 0);
  const intersects = Number.isFinite(overlay.x)
    && overlay.x < rect.x + rect.width && oRight > rect.x
    && oTop < rect.y + rect.height && oBottom > rect.y;
  if (!intersects) return rect;
  // 只有"浮窗压住下沿"这一种情况能靠抬高下沿解决; 压住整段时保持原样
  const clipped = Math.round(oTop - CHAT_OCR_OVERLAY_GAP) - rect.y;
  if (clipped < rect.height && clipped >= rect.height * CHAT_OCR_MIN_KEEP) rect.height = clipped;
  return rect;
}

module.exports = { OVERLAY_SIZE, OVERLAY_GAP, isUsableClientRect, defaultOverlayBounds, computeOverlayBounds, chatOcrCrop, chatOcrScales, CHAT_OCR_TARGET_W };
