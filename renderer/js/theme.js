// 图标兜底：Node 测试 require 本文件时 icons.js 不在作用域（同 home.js 的守卫）。
if (typeof poroIcon !== 'function') { globalThis.poroIcon = () => '<svg class="pi"></svg>'; }

// 主题切换
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 主题切换 ==========
function applyTheme() {
  const t = storeGet('theme');
  document.body.classList.toggle('dark', t === 'dark');
  const btn = document.getElementById('themeToggle');
  if (btn) btn.innerHTML = t === 'dark' ? poroIcon('sun') : poroIcon('moon');
}
function toggleTheme() {
  const dark = !document.body.classList.contains('dark');
  document.body.classList.toggle('dark', dark);
  storeSet('theme', dark ? 'dark' : 'light');
  const btn = document.getElementById('themeToggle');
  if (btn) btn.innerHTML = dark ? poroIcon('sun') : poroIcon('moon');
}
