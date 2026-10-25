// 图标兜底：Node 测试 require 本文件时 icons.js 不在作用域（同 home.js 的守卫）。
if (typeof poroIcon !== 'function') { globalThis.poroIcon = () => '<svg class="pi"></svg>'; }

// 主题切换
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 主题切换 ==========
// applyTheme 保留为旧版深浅兼容入口; 正式主题系统 (applyUiTheme) 在 app.js:
// C 浅蓝(默认) / A 雾紫 / B 暗色玻璃 / dark 经典深色, 见 store 键 uiTheme。
function applyTheme() {
  const t = storeGet('theme');
  document.body.classList.toggle('dark', t === 'dark');
  const btn = document.getElementById('themeToggle');
  if (btn) btn.innerHTML = t === 'dark' ? poroIcon('sun') : poroIcon('moon');
}
function toggleTheme() {
  // 月亮按钮: 浅色变体 (C 浅蓝 / A 雾紫) <-> 暗色 (B 暗色玻璃), 记住上次用的浅色变体
  if (typeof applyUiTheme === 'function') {
    if (document.body.classList.contains('dark')) {
      applyUiTheme(typeof _lastLightUiTheme !== 'undefined' ? _lastLightUiTheme : 'c');
    } else {
      applyUiTheme('b');
    }
    return;
  }
  // 兜底: 无 applyUiTheme 的环境 (个别测试) 保留旧深浅切换
  const dark = !document.body.classList.contains('dark');
  document.body.classList.toggle('dark', dark);
  storeSet('theme', dark ? 'dark' : 'light');
  const btn = document.getElementById('themeToggle');
  if (btn) btn.innerHTML = dark ? poroIcon('sun') : poroIcon('moon');
}
