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
  const btn = document.getElementById('themeToggle');
  if (btn) btn.innerHTML = t === 'dark' ? poroIcon('sun') : poroIcon('moon');
}
function toggleTheme() {
  // 月亮按钮: 明暗互换, 强调色保持不变
  if (typeof currentThemeState === 'function' && typeof applyThemeState === 'function') {
    const st = currentThemeState();
    applyThemeState({ mode: st.mode === 'dark' ? 'light' : 'dark', accent: st.accent });
    return;
  }
  // 兜底: 无 applyThemeState 的环境 (个别测试) 保留旧深浅切换
  const dark = !document.body.classList.contains('dark');
  document.body.classList.toggle('dark', dark);
  storeSet('theme', dark ? 'dark' : 'light');
  const btn = document.getElementById('themeToggle');
  if (btn) btn.innerHTML = dark ? poroIcon('sun') : poroIcon('moon');
}
