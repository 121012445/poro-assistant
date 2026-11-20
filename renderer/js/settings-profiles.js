// 游戏设置配置档 —— 单排 / 车队 / 直播各存一套, 一键切回。
//
// 底层: main/game-settings.js 的 listSlots/saveSlot/restoreSlot/deleteSlot。
// 语义: "保存"把当前锁定快照另存为具名档; "应用"把档写回快照再走一次 apply-full
//       (apply 会自己处理只读与合并), 所以不需要新的生效路径。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  // window.X 形式既是浏览器里的真实赋值, 也让静态检查 (test_undef_globals) 认得出这个名字
  if (typeof window !== 'undefined') window.PoroGsProfiles = api;
  else if (root) root.PoroGsProfiles = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function has() { return !!(window.lolAPI && typeof lolAPI.listGameSettingSlots === 'function'); }

  function html(slots, status) {
    const ready = status && status.exists;
    const rows = (slots || []).map(s => `<div class="gsp-item">
      <b>${esc(s.name)}</b>
      <span>${s.settingCount || 0} 项 · ${s.savedAt ? new Date(s.savedAt).toLocaleDateString() : '—'}</span>
      <button class="btn-secondary" onclick="applyGsProfile(${JSON.stringify(s.name)})">应用</button>
      <button class="btn-secondary" onclick="deleteGsProfile(${JSON.stringify(s.name)})">删除</button>
    </div>`).join('');
    const saveBtn = ready
      ? '<button class="btn-secondary" onclick="saveGsProfile()">存为配置档</button>'
      : '<button class="btn-secondary" disabled title="先开启一次「锁定游戏设置」">存为配置档</button>';
    return `<div class="gsp-row">
      <input class="tool-input" id="gsProfileName" placeholder="配置档名，如：直播 / 车队" style="flex:1">
      ${saveBtn}
    </div>
    ${rows ? `<div class="gsp-list">${rows}</div>` : '<div class="gsp-empty">还没有配置档。开启「锁定游戏设置」后，可以把当前这套存成具名档。</div>'}
    <p class="gsp-foot">应用 = 把该档写回设置快照并立即生效；不会删除你其它的档。</p>`;
  }

  async function refresh() {
    const box = document.getElementById('gsSlots');
    if (!box) return;
    if (!has()) { box.innerHTML = '<div class="gsp-empty">当前版本不支持配置档。</div>'; return; }
    const [list, status] = await Promise.all([
      lolAPI.listGameSettingSlots().catch(() => ({ slots: [] })),
      (typeof lolAPI.fullGameSettingsStatus === 'function' ? lolAPI.fullGameSettingsStatus().catch(() => ({})) : Promise.resolve({}))
    ]);
    box.innerHTML = html(list && list.slots, status);
  }

  async function save() {
    const input = document.getElementById('gsProfileName');
    const name = input ? input.value.trim() : '';
    if (!name) { if (typeof toolMsg === 'function') toolMsg('先给配置档起个名字'); return; }
    const r = await lolAPI.saveGameSettingSlot(name);
    if (typeof toolMsg === 'function') toolMsg(r && r.ok ? `已存为配置档「${name}」` : `保存失败：${(r && r.error) || '未知错误'}`);
    if (r && r.ok && input) input.value = '';
    refresh();
  }

  async function apply(name) {
    const r = await lolAPI.restoreGameSettingSlot(name);
    if (!r || !r.ok) { if (typeof toolMsg === 'function') toolMsg(`应用失败：${(r && r.error) || '未知错误'}`); return; }
    // restore 只写回快照, 真正落到游戏目录要再走 apply-full
    const a = await lolAPI.applyFullGameSettings();
    if (typeof toolMsg === 'function') toolMsg(a && a.ok !== false ? `已应用配置档「${name}」` : `写回失败：${(a && a.error) || '未知错误'}`);
  }

  async function remove(name) {
    const r = await lolAPI.deleteGameSettingSlot(name);
    if (typeof toolMsg === 'function') toolMsg(r && r.ok ? `已删除配置档「${name}」` : `删除失败：${(r && r.error) || '未知错误'}`);
    refresh();
  }

  return { html, refresh, save, apply, remove };
});
