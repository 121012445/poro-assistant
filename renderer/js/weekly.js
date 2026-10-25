// 周报分享卡: 从首页已加载的战绩 (homeGamesData) 统计近 7 天 vs 上一个 7 天,
// 弹窗预览 + 保存为 PNG (离屏渲染由主进程 share-card:save 完成)。
// 依赖 utils.js (escapeHtml/showToast), home.js 的 homeGamesData, live.js 的 isExcludedGame。
function openWeeklyReport() {
  const games = Array.isArray(homeGamesData) ? homeGamesData : [];
  if (!games.length) { showToast('战绩还没加载好, 稍后再试', 'negative'); return; }
  try { buildWeeklyReport(games); }
  catch (e) { showToast('周报生成失败: ' + (e?.message || e), 'negative'); }
}

function weeklySum(games, begin, end, ownerPuuid) {
  // homeGamesData 新局在前; time 是毫秒时间戳
  const rows = [];
  for (const g of games) {
    const t = +g.time || 0;
    if (!t || t < begin || t >= end) continue;
    const me = (g.participants || []).find(p => p.puuid && p.puuid === ownerPuuid);
    if (!me) continue;
    if (typeof isExcludedGame === 'function' && isExcludedGame({ mode: g.mode, queueId: g.queueId, gameType: g.gameType })) continue;
    rows.push({ game: g, me });
  }
  return rows;
}

function buildWeeklyReport(games) {
  const now = Date.now();
  const DAY = 24 * 3600 * 1000;
  // 周报跟随当前数据归属者: 查看其他玩家时生成对方的数据, 标题标注姓名
  const ownerPuuid = (typeof homeGamesOwner !== 'undefined' && homeGamesOwner) || window._myPuuid || '';
  const ownerLabel = (typeof homeGamesOwnerLabel !== 'undefined' && homeGamesOwnerLabel) || '';
  const cur = weeklySum(games, now - 7 * DAY, now + DAY, ownerPuuid);
  const prev = weeklySum(games, now - 14 * DAY, now - 7 * DAY, ownerPuuid);
  const modal = document.getElementById('weeklyModal');
  const box = document.getElementById('weeklyCard');
  if (!modal || !box) return;
  if (!cur.length) {
    box.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-muted)">最近 7 天没有有效对局记录</div>';
    modal.classList.add('show');
    return;
  }
  const sum = rows => rows.reduce((a, r) => {
    a.k += r.me.k; a.d += r.me.d; a.a += r.me.a;
    if (r.me.win) a.wins++;
    a.dur += +r.game.dur || 0;
    const cid = r.me.championId;
    a.champs[cid] = a.champs[cid] || { n: 0, w: 0 };
    a.champs[cid].n++;
    if (r.me.win) a.champs[cid].w++;
    return a;
  }, { k: 0, d: 0, a: 0, wins: 0, dur: 0, champs: {} });
  const s = sum(cur), p = sum(prev);
  const wr = Math.round(s.wins / cur.length * 100);
  // 注意 p 是统计对象, 场次要取 prev.length (之前误写成 p.length 导致 NaN)
  const pwr = prev.length ? Math.round(p.wins / prev.length * 100) : null;
  const kda = (s.k + s.a) / Math.max(1, s.d);
  const hours = Math.floor(s.dur / 3600), mins = Math.round(s.dur % 3600 / 60);
  // 最长连胜/连败: 按时间正序扫一遍
  const chrono = cur.slice().sort((a, b) => (+a.game.time || 0) - (+b.game.time || 0));
  let streak = 0, bestStreak = 0, bestStreakType = '胜';
  let curType = null;
  for (const r of chrono) {
    const t = r.me.win ? '胜' : '败';
    if (t === curType) streak++; else { curType = t; streak = 1; }
    if (streak > bestStreak) { bestStreak = streak; bestStreakType = t; }
  }
  // 常用英雄前三 (带场次)
  const topChamps = Object.entries(s.champs).sort((a, b) => b[1].n - a[1].n).slice(0, 3);
  ensureChampMap();
  const delta = pwr == null ? '' : (wr === pwr
    ? '<i class="wc-delta">持平</i>'
    : '<i class="wc-delta ' + (wr > pwr ? 'up' : 'down') + '">' + (wr > pwr ? '↑' : '↓') + Math.abs(wr - pwr) + '</i>');
  const dateStr = new Date(now - 7 * DAY).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
    + ' - ' + new Date(now).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  const mvp = cur.slice().sort((a, b) =>
    ((b.me.k + b.me.a) / Math.max(1, b.me.d)) - ((a.me.k + a.me.a) / Math.max(1, a.me.d)))[0];
  const fmtDur = sec => Math.floor(sec / 60) + '分' + Math.round(sec % 60) + '秒';
  const champCell = ([cid, st], idx) => {
    const c = champNumMap?.[String(cid)];
    const img = c ? champImg(c.id) : placeholder('?');
    const wrC = st.n ? Math.round(st.w / st.n * 100) : 0;
    return '<div class="wc-champ"><em class="wc-rank">TOP' + (idx + 1) + '</em><img src="' + img + '"><b>' + escapeHtml(c ? c.name : '英雄#' + cid) + '</b>'
      + '<span>' + st.n + '场 ' + wrC + '%胜率</span></div>';
  };
  box.innerHTML = '<div class="weekly-card" id="weeklyCardInner">'
    + '<div class="wc-head"><span class="wc-logo">P</span><div class="wc-title-wrap"><h3>Poro 周报</h3>'
    + '<div class="wc-sub">' + escapeHtml(dateStr) + ' · 共 ' + cur.length + ' 场对局' + (ownerLabel ? ' · ' + escapeHtml(ownerLabel) : '') + '</div></div></div>'
    + '<div class="wc-grid">'
    + '<div class="wc-stat accent"><b>' + wr + '%' + delta + '</b><span>胜率</span></div>'
    + '<div class="wc-stat"><b>' + s.wins + '/' + cur.length + '</b><span>胜 / 场</span></div>'
    + '<div class="wc-stat"><b>' + kda.toFixed(1) + '</b><span>场均 KDA</span></div>'
    + '<div class="wc-stat"><b>' + (hours ? hours + '时' : '') + mins + '分</b><span>游戏时长</span></div>'
    + '</div>'
    + '<div class="wc-row">' + topChamps.map(champCell).join('') + '</div>'
    + '<div class="wc-note">'
    + (pwr != null ? '较上周胜率<b>' + (wr >= pwr ? '提升 ' : '下降 ') + Math.abs(wr - pwr) + '%</b>。' : '')
    + '最长连' + bestStreakType + '<b>' + bestStreak + ' 场</b>。'
    + (mvp ? '最高光一战: <b>' + escapeHtml(mvp.me.name || '你') + '</b> 的 ' + fmtDur(+mvp.game.dur || 0) + ' (' + mvp.me.k + '/' + mvp.me.d + '/' + mvp.me.a + ')。' : '')
    + '</div>'
    + '<div class="wc-foot">由 Poro · 英雄联盟游戏助手 生成</div></div>';
  modal.classList.add('show');
}

function closeWeeklyModal() {
  const modal = document.getElementById('weeklyModal');
  if (modal) modal.classList.remove('show');
}

async function saveWeeklyReportImage() {
  const card = document.getElementById('weeklyCardInner');
  if (!card) return;
  const r = await lolAPI.saveShareCard(card.outerHTML, Math.ceil(card.getBoundingClientRect().width), Math.ceil(card.getBoundingClientRect().height)).catch(e => ({ __error: e?.message || e }));
  if (r && r.ok) showToast('周报已保存: ' + r.filePath, 'positive');
  else if (r && !r.canceled) showToast('保存失败: ' + (r.__error || '未知错误'), 'negative');
}
