// 黑名单: 系统 / 页面 / 持久化
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 黑名单系统 ==========
let blacklist = [];
function addToBlacklist(puuid, name, reason) {
  if (!name) return;
  if (blacklist.find(b => b.name === name)) { showToast(name + ' 已在黑名单中', 'negative'); return; }
  blacklist.push({ name, puuid: puuid || '', reason: reason || '', time: Date.now() });
  saveBlacklist();
  renderBlacklist();
  renderBlacklistPage();
  showToast('已加入黑名单: ' + name, 'positive');
}
function removeBlacklist(idx) {
  const removed = blacklist[idx];
  blacklist.splice(idx, 1);
  saveBlacklist();
  renderBlacklist();
  renderBlacklistPage();
  if (removed) showToast('已移出黑名单: ' + removed.name, 'positive');
}
function removeBlacklistByName(name) {
  const idx = blacklist.findIndex(b => b.name === name);
  if (idx !== -1) removeBlacklist(idx);
}
function renderBlacklist() {
  const el = document.getElementById('blacklistDisplay');
  if (!el) return;
  el.innerHTML = blacklist.length === 0 ? '<span style="color:#666;">空</span>' :
    blacklist.map((b, i) => `<span style="display:inline-flex;align-items:center;gap:2px;background:#3a2020;padding:2px 6px;border-radius:4px;margin:2px;color:#f88;">
      ${escapeHtml(b.name)} <span onclick="removeBlacklist(${i})" style="cursor:pointer;">×</span>
    </span>`).join('');
}
function checkBlacklist(players) {
  const matched = [];
  for (const p of players) {
    if (blacklist.find(b => b.name === p.name)) matched.push(p.name);
  }
  if (matched.length) {
    showToast('⚠️ 黑名单玩家: ' + matched.join(', '), 'negative');
    toolMsg(`<span style="color:#f44;">⚠️ 黑名单玩家: ${escapeHtml(matched.join(', '))}</span>`);
    return true;
  }
  return false;
}
function isBlacklisted(name) {
  return blacklist.some(b => b.name === name);
}

// ========== 黑名单页面 ==========
function addBlacklistFromPage() {
  const name = document.getElementById('blPageName').value.trim();
  if (!name) return;
  addToBlacklist('', name, '');
  document.getElementById('blPageName').value = '';
}
function renderBlacklistPage() {
  const el = document.getElementById('blPageList');
  if (!el) return;
  if (!blacklist.length) {
    el.innerHTML = '<div class="bl-empty">暂无黑名单玩家</div>';
    return;
  }
  el.innerHTML = blacklist.map((b, i) => {
    const timeStr = b.time ? new Date(b.time).toLocaleDateString() : '';
    return `<div class="bl-item">
      <div class="bl-item-name">${escapeHtml(b.name)}</div>
      ${b.reason ? `<div class="bl-item-reason">${escapeHtml(b.reason)}</div>` : ''}
      <div class="bl-item-time">${timeStr}</div>
      <button class="bl-item-remove" onclick="removeBlacklist(${i})">移出</button>
    </div>`;
  }).join('');
}


// ========== 黑名单持久化 ==========
function loadBlacklist() {
  try {
    const data = storeGet('blacklist');
    if (data) blacklist = JSON.parse(data);
  } catch (e) {}
}
function saveBlacklist() {
  try { storeSet('blacklist', JSON.stringify(blacklist)); } catch (e) {}
}
