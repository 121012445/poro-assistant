// 软件更新界面 (主进程见 main/updater.js)
// 流程: 检查 (启动 20 秒后静默一次, 之后每 6 小时最多一次; 也可手动) → 发现新版 → 用户点「下载」
//       → 校验通过 → 用户点「安装并重启」。全程不自动下载、不自动安装。

const UPDATE_AUTO_CHECK_DELAY_MS = 20 * 1000;
const UPDATE_AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let updateState = { phase: 'idle', info: null, error: '', progress: 0 };   // idle | checking | available | downloading | ready | latest | error

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
  return v + ' B';
}

// 更新说明来自 GitHub 发布页, 只做转义后按纯文本显示
function updateNotesPreview(notes) {
  const lines = String(notes || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 8);
  return lines.length ? '<ul class="update-notes">' + lines.map(l => '<li>' + escapeHtml(l.replace(/^[-*#>\s]+/, '').slice(0, 120)) + '</li>').join('') + '</ul>' : '';
}

function renderUpdateCard() {
  const box = document.getElementById('updateBody');
  if (!box) return;
  const s = updateState, info = s.info;
  let html = '';
  if (s.phase === 'checking') html = '<span class="tool-state">正在检查更新…</span>';
  else if (s.phase === 'latest') html = `<span class="tool-state" style="color:var(--positive)">已是最新版 v${escapeHtml(info?.current || '')}</span>`;
  else if (s.phase === 'error') html = `<span class="tool-state" style="color:var(--negative)">${escapeHtml(s.error)}</span>`;
  else if (info && (s.phase === 'available' || s.phase === 'downloading' || s.phase === 'ready')) {
    html += `<div class="update-line"><b>发现新版本 v${escapeHtml(info.version)}</b><span> 当前 v${escapeHtml(info.current)}${info.assetSize ? ' · ' + formatBytes(info.assetSize) : ''}${info.edition === 'limited' ? ' · 受限版' : ''}</span></div>`;
    html += updateNotesPreview(info.notes);
    if (s.phase === 'available') {
      html += info.installable
        ? '<button class="btn-primary" onclick="downloadUpdate()">下载更新</button>'
        : '<span class="tool-state">这个版本没有可校验的安装包，请到发布页手动下载。</span>';
      html += ' <button class="btn-secondary" onclick="lolAPI.openUpdatePage()">查看发布页</button>';
    } else if (s.phase === 'downloading') {
      html += `<div class="update-progress"><div style="width:${Math.min(100, s.progress)}%"></div></div><span class="tool-state">下载中 ${s.progress}%</span>`;
    } else {
      html += '<span class="tool-state" style="color:var(--positive)">已下载并通过校验 (sha256)。</span> <button class="btn-primary" onclick="installUpdate()">安装并重启</button>';
    }
  }
  box.innerHTML = html;
  const badge = document.getElementById('updateBadge');
  if (badge) badge.hidden = !(info && info.available && s.phase !== 'latest');
  const btn = document.getElementById('updateCheckBtn');
  if (btn) btn.disabled = s.phase === 'checking' || s.phase === 'downloading';
}

async function checkForUpdate(silent) {
  if (!window.lolAPI?.checkUpdate) return updateState;
  if (updateState.phase === 'checking' || updateState.phase === 'downloading') return updateState;
  const keep = updateState.phase === 'ready' ? updateState : null;
  if (keep) return keep;
  updateState = { phase: 'checking', info: null, error: '', progress: 0 };
  if (!silent) renderUpdateCard();
  try {
    const r = await lolAPI.checkUpdate();
    if (!r || r.__error) throw new Error(r?.__error || '检查失败');
    updateState = { phase: r.available ? (r.downloaded ? 'ready' : 'available') : 'latest', info: r, error: '', progress: 0 };
    try { storeSet('updateLastCheck', String(Date.now())); } catch (e) {}
    if (silent && r.available) showToast('发现新版本 v' + r.version + '，可在「工具箱 → 软件更新」下载', 'positive');
  } catch (e) {
    // 静默检查失败 (没网等) 不打扰用户; 手动检查才显示原因
    updateState = { phase: silent ? 'idle' : 'error', info: null, error: '检查更新失败: ' + e.message, progress: 0 };
  }
  renderUpdateCard();
  return updateState;
}

async function downloadUpdate() {
  if (updateState.phase !== 'available' || !window.lolAPI?.downloadUpdate) return;
  const info = updateState.info;
  updateState = { phase: 'downloading', info, error: '', progress: 0 };
  renderUpdateCard();
  const r = await lolAPI.downloadUpdate();
  if (!r || r.__error) {
    updateState = { phase: 'error', info: null, error: '下载失败: ' + (r?.__error || '未知错误'), progress: 0 };
    renderUpdateCard();
    return;
  }
  updateState = { phase: 'ready', info: Object.assign({}, info, { downloaded: true }), error: '', progress: 100 };
  renderUpdateCard();
}

async function installUpdate() {
  if (updateState.phase !== 'ready') return;
  if (!confirm('将启动安装程序并关闭 Poro。继续吗？')) return;
  const r = await lolAPI.installUpdate();
  if (r && r.__error) { updateState = { phase: 'error', info: null, error: '启动安装失败: ' + r.__error, progress: 0 }; renderUpdateCard(); }
}

function initUpdate() {
  if (window.lolAPI?.onUpdateProgress) {
    lolAPI.onUpdateProgress(p => {
      if (updateState.phase !== 'downloading' || !p?.total) return;
      updateState.progress = Math.min(100, Math.round(p.received / p.total * 100));
      renderUpdateCard();
    });
  }
  renderUpdateCard();
  const last = Number(storeGet('updateLastCheck')) || 0;
  const wait = Date.now() - last > UPDATE_AUTO_CHECK_INTERVAL_MS ? UPDATE_AUTO_CHECK_DELAY_MS : Math.max(UPDATE_AUTO_CHECK_DELAY_MS, UPDATE_AUTO_CHECK_INTERVAL_MS - (Date.now() - last));
  setTimeout(() => { checkForUpdate(true); }, wait);
}
