// 图标兜底：Node 测试 require 本文件时 icons.js 不在作用域（同 home.js 的守卫）。
if (typeof poroIcon !== 'function') { globalThis.poroIcon = () => '<svg class="pi"></svg>'; }

// 主题切换
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 主题切换 ==========
// 正式主题系统在 app.js: 明暗 (light/dark) × 强调色 (blue/violet), 见 store 键 uiTheme。
// applyTheme 保留为旧版深浅兼容入口。
function applyTheme() {
  const t = storeGet('theme');
  document.body.classList.toggle('dark', t === 'dark');
}

