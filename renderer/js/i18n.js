// i18n 骨架: 中文原文即键。
//
// 为什么这样做而不是从头抽 key: 现有渲染层有 2 万多行、上千条中文字面量,
// 一次性改成 t('nav.home') 既不可能也没必要。这里先建立"能翻译的通道":
//   t('首页')            → 查词典, 没有就原样返回中文
//   applyI18n(root)      → 把导航/页面标题这类固定文案换掉
// 后续新增界面时, 文案写成 t('...') 即可; 老界面可以逐页迁移, 不需要一次动完。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  // window.X 形式既是浏览器里的真实赋值, 也让静态检查 (test_undef_globals) 认得出这个名字
  if (typeof window !== 'undefined') window.PoroI18n = api;
  else if (root) root.PoroI18n = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const LOCALES = ['zh-CN', 'en'];
  const DEFAULT = 'zh-CN';

  function dict(locale) {
    const all = (typeof window !== 'undefined' && window.PORO_I18N) || {};
    return all[locale || DEFAULT] || {};
  }

  function current() {
    let loc = '';
    try { loc = String(storeGet('locale') || ''); } catch (e) {}
    if (LOCALES.includes(loc)) return loc;
    try {
      const nav = (navigator.language || '').toLowerCase();
      if (nav && !nav.startsWith('zh')) return 'en';
    } catch (e) {}
    return DEFAULT;
  }

  function t(text, vars) {
    const loc = current();
    if (loc === DEFAULT) return String(text == null ? '' : text);
    const table = dict(loc);
    let out = Object.prototype.hasOwnProperty.call(table, text) ? table[text] : String(text == null ? '' : text);
    if (vars && typeof vars === 'object') {
      for (const [k, v] of Object.entries(vars)) out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
    }
    return out;
  }

  // 只处理结构稳定的固定文案: 侧边导航、页面标题、以及显式标了 data-i18n 的元素
  function applyI18n(rootEl) {
    const scope = rootEl || document;
    const loc = current();
    if (loc === DEFAULT) return 0;
    const table = dict(loc);
    let n = 0;
    scope.querySelectorAll('.nav-item > span, .page > .page-header > h2, [data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n') || el.textContent.trim();
      if (key && Object.prototype.hasOwnProperty.call(table, key)) {
        const next = table[key];
        if (el.textContent.trim() !== next) { el.textContent = next; n += 1; }
      }
    });
    if (document.body) document.body.setAttribute('data-locale', loc);
    return n;
  }

  function setLocale(loc) {
    if (!LOCALES.includes(loc)) return false;
    try { storeSet('locale', loc); } catch (e) { return false; }
    // 词典是中文键, 切回中文时需要把已经翻译过的节点还原 —— 最省事的做法是重载界面。
    try { if (typeof location !== 'undefined' && location.reload) location.reload(); } catch (e) {}
    return true;
  }

  return { t, applyI18n, setLocale, current, LOCALES, dict };
});

// 外服用户首次打开时自动把固定文案换掉; 中文环境什么也不做 (词典为空)。
if (typeof document !== 'undefined') {
  const runI18n = () => { try { window.PoroI18n && window.PoroI18n.applyI18n(document); } catch (e) {} };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', runI18n);
  else setTimeout(runI18n, 0);
}
