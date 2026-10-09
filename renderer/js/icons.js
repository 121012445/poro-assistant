'use strict';
/* Poro 单色图标系统
   ============================================================================
   为什么要有它：原先界面用 emoji 当图标（🔥🛡️🎭🧩🍀…）。emoji 在 Windows 上渲染成
   **彩色位图**，二十多张卡片摆在一起五颜六色，是"看着不高级"的最大单一来源；
   而且同一个 emoji 在 Win10/Win11/不同字体下长得都不一样，无法统一。

   这里统一为：24 宫格 / 1.75 描边 / stroke=currentColor 的线描图标。
   颜色完全由所在容器的 `color` 决定 —— 深浅主题、激活态、语义色自动跟随，
   不需要为每个图标准备两套图。

   用法：`poroIcon('flame')` 返回一段 `<svg class="pi">…</svg>` 字符串。
   尺寸由 CSS 控制：`.pi { width:1em; height:1em }`，即跟着容器的 font-size 走。
   找不到名字时回退到 `dot`，不会抛错、不会渲染成空白。
   ============================================================================ */
const PORO_ICON_PATHS = {
  /* ---- 时间 / 时段 ---- */
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  alarm: '<circle cx="12" cy="13" r="7"/><path d="M12 10v3.5l2 1.5"/><path d="M4.5 4.5L3 6M19.5 4.5L21 6"/>',
  hourglass: '<path d="M7 3h10M7 21h10"/><path d="M8 3v3.5c0 1.5 4 2.5 4 5.5s-4 4-4 5.5V21"/><path d="M16 3v3.5c0 1.5-4 2.5-4 5.5s4 4 4 5.5V21"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
  cloudSun: '<circle cx="8.5" cy="9" r="3"/><path d="M8.5 3.5V5M3.5 9H5M4.9 5.4l1 1M12.1 5.4l-1 1"/><path d="M10 19.5h7.5a2.75 2.75 0 0 0 0-5.5 4 4 0 0 0-7.7-.9"/>',
  sunset: '<path d="M12 3.5v4"/><path d="M5.6 9.1l1.4 1.4M18.4 9.1L17 10.5"/><path d="M3 17.5h18"/><path d="M7.5 13.5a4.5 4.5 0 0 1 9 0"/>',

  /* ---- 战绩 / 趣味档案 ---- */
  flame: '<path d="M12 3c2 3 3.5 5.2 3.5 7.8a3.5 3.5 0 0 1-7 0c0-1.6.8-2.9 1.6-3.9"/>',
  shield: '<path d="M12 3.5l6.5 2.8v5c0 3.9-2.7 7.3-6.5 8.7-3.8-1.4-6.5-4.8-6.5-8.7v-5z"/>',
  trendUp: '<path d="M4 16.5l5.5-5.5 3.5 3.5 6.5-7"/><path d="M15 7.5h5v5"/>',
  mask: '<path d="M4.5 8h15v4.5a5.5 5.5 0 0 1-5.5 5.5h-4A5.5 5.5 0 0 1 4.5 12.5z"/><path d="M9.5 11.5h.01M14.5 11.5h.01"/>',
  clover: '<circle cx="12" cy="8" r="2.6"/><circle cx="12" cy="16" r="2.6"/><circle cx="8" cy="12" r="2.6"/><circle cx="16" cy="12" r="2.6"/>',
  toolbox: '<rect x="3" y="8.5" width="18" height="10.5" rx="2"/><path d="M8.5 8.5v-2a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2"/><path d="M3 13.5h18"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="M15.2 8.8l-2 4.4-4.4 2 2-4.4z"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.1 0-1 .8-1.8 1.8-1.8H16a4.5 4.5 0 0 0 4.5-4.5c0-3.6-3.8-6.6-8.5-6.6z"/><circle cx="8" cy="12" r="1"/><circle cx="12" cy="8.5" r="1"/><circle cx="16" cy="12" r="1"/>',
  cards: '<rect x="8" y="4.5" width="11" height="15" rx="2"/><path d="M5.5 7.5v11a2 2 0 0 0 2 2h9"/>',
  puzzle: '<rect x="4.5" y="4.5" width="6" height="6" rx="1"/><rect x="13.5" y="4.5" width="6" height="6" rx="1"/><rect x="4.5" y="13.5" width="6" height="6" rx="1"/><rect x="13.5" y="13.5" width="6" height="6" rx="1"/>',
  nemesis: '<circle cx="12" cy="12" r="8.5"/><path d="M8.8 8.8l6.4 6.4M15.2 8.8l-6.4 6.4"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  exchange: '<path d="M4 8.5h13M14 5.5l3 3-3 3"/><path d="M20 15.5H7M10 12.5l-3 3 3 3"/>',
  zap: '<path d="M13 3L5.5 13H11l-1 8 7.5-10H12z"/>',
  burst: '<path d="M12 3.5l1.7 4.2 4.2-1.4-1.4 4.2 4.2 1.5-4.2 1.5 1.4 4.2-4.2-1.4L12 20.5l-1.7-4.2-4.2 1.4 1.4-4.2L3.3 12l4.2-1.5L6.1 6.3l4.2 1.4z"/>',
  brick: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 9.7h18M3 14.3h18M9 5v4.7M15 9.7v4.6M9 14.3V19"/>',
  chart: '<rect x="4" y="12" width="3.5" height="7.5" rx="1"/><rect x="10.2" y="7" width="3.5" height="12.5" rx="1"/><rect x="16.4" y="3.5" width="3.5" height="16" rx="1"/>',
  users: '<path d="M15 19.5v-1.5a3.5 3.5 0 0 0-3.5-3.5h-3A3.5 3.5 0 0 0 5 18v1.5"/><circle cx="10" cy="8.5" r="3"/><path d="M19 19.5V18a3.5 3.5 0 0 0-2.6-3.4"/><path d="M14.5 5.6a3 3 0 0 1 0 5.8"/>',

  /* ---- 英雄角色定位 ---- */
  sword: '<path d="M14.5 4.8l4.7 4.7-9 9-2.6.5.5-2.6z"/><path d="M12.8 6.5l4.7 4.7"/>',
  orb: '<circle cx="12" cy="12" r="6.5"/><path d="M5.5 12a6.5 6.5 0 0 1 13 0"/>',
  dagger: '<path d="M12 3.5l3 9-3 3.5-3-3.5z"/><path d="M9 16h6M12 16v4.5"/>',
  bow: '<path d="M5 19c9 0 14-5 14-14"/><path d="M5 19l3.6-3.6M19 5l-2.6 2.6"/>',
  leaf: '<path d="M20 4C10.5 4 4 10.5 4 20c9.5 0 16-6.5 16-16z"/><path d="M4 20c4-5 8.5-8 14-10"/>',
  heart: '<path d="M12 20s-7-4.4-7-9.2A4 4 0 0 1 12 8.2 4 4 0 0 1 19 10.8C19 15.6 12 20 12 20z"/>',

  /* ---- 段位 ---- */
  rock: '<path d="M6 13.5l3-8h6l3 8-2.5 7h-7z"/>',
  medal: '<circle cx="12" cy="15" r="5"/><path d="M8.5 10.8L6.5 3.5h11l-2 7.3"/>',
  gem: '<path d="M7 3.5h10l4 5.5-9 11.5L3 9z"/><path d="M3 9h18M9.5 3.5L8 9l4 11.5L16 9l-1.5-5.5"/>',
  crown: '<path d="M3.5 7.5l4 4.5L12 5l4.5 7 4-4.5-1.8 11.5H5.3z"/>',

  /* ---- 通用 ---- */
  sparkle: '<path d="M12 3.5l1.8 5 5 1.8-5 1.8-1.8 5-1.8-5-5-1.8 5-1.8z"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="M6.2 17.8L17.8 6.2"/>',
  warn: '<path d="M12 4.5l8.5 15h-17z"/><path d="M12 10v4M12 16.5h.01"/>',
  pin: '<path d="M9.5 3.5h5l-1 5.5 3 3v1.5H7.5V12l3-3z"/><path d="M12 13.5V21"/>',
  check: '<path d="M4.5 12.5l5 5 10-10.5"/>',
  star: '<path d="M12 3.5l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.9-5.4 2.9 1-6L3.3 9.9l6-.9z"/>',
  tower: '<path d="M6 21V7.5l6-4 6 4V21"/><path d="M3.5 21h17"/><path d="M10 21v-5h4v5"/>',
  dragon: '<path d="M4 14.5c0-4.2 3.6-7.5 8-7.5s8 3.3 8 7.5"/><path d="M7 14.5l-2 4.5M17 14.5l2 4.5"/><circle cx="9.2" cy="12" r="1"/><circle cx="14.8" cy="12" r="1"/>',
  eagle: '<path d="M12 5.5c2-2 5-2 7 0l-4 3v5l-3 3-3-3v-5z"/><path d="M5 5.5l4 3"/>',
  bug: '<circle cx="12" cy="13" r="5"/><path d="M12 8V6M9 5.2L8 3.5M15 5.2l1-1.7M7 13H4M20 13h-3M7.6 17l-2 2M16.4 17l2 2"/>',
  wave: '<path d="M2 12c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2"/><path d="M2 17c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2"/>',
  dot: '<circle cx="12" cy="12" r="2.5"/>'
};

/**
 * 取一个单色线描图标。
 * @param {string} name PORO_ICON_PATHS 里的键；未知名字回退到 dot
 * @param {number} [size] 像素尺寸；不传则由 CSS 的 font-size 决定（推荐）
 */
function poroIcon(name, size) {
  const d = PORO_ICON_PATHS[name] || PORO_ICON_PATHS.dot;
  const style = size ? ` style="width:${size}px;height:${size}px"` : '';
  return '<svg class="pi"' + style + ' viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + d + '</svg>';
}
