// 成长页：跨局训练计划 + 本机长期趋势的渲染与取数。
//
// 数据全部来自本机：AI 复盘缓存 (aiReview:*) 与对局台账 (gameLedger)。
// 不发请求、不调模型，所以进入页面没有等待感，也不会因为网络失败变空。
// 统计口径见 growth-model.js。
function growthReadReviews() {
  const out = new Map();     // gameId -> { gameId, text, at }
  const prefix = 'aiReview:';
  let keys = [];
  try { keys = (typeof storeKeys === 'function') ? storeKeys() : []; } catch (e) { keys = []; }
  for (const k of keys) {
    if (typeof k !== 'string' || k.indexOf(prefix) !== 0) continue;
    const rest = k.slice(prefix.length);
    // 形如 <gameId>.t<style>.<promptVer>；gameId 本身可能带点，所以从右侧切
    const parts = rest.split('.');
    if (parts.length < 3) continue;
    const gameId = parts.slice(0, parts.length - 2).join('.');
    if (!gameId) continue;
    let raw = null;
    try { raw = storeGet(k); } catch (e) { raw = null; }
    if (!raw) continue;
    let obj = null;
    try { obj = JSON.parse(raw); } catch (e) { obj = null; }
    const text = obj && obj.text ? String(obj.text) : '';
    if (!text.trim()) continue;
    const at = (obj && +obj.generatedAt) || 0;
    const prev = out.get(gameId);
    // 同一局可能有多种风格的复盘：只取最新生成的那份，避免同一局被重复计入
    if (!prev || at >= prev.at) out.set(gameId, { gameId, text, at });
  }
  return [...out.values()];
}

function growthLedger() {
  try {
    const raw = storeGet('gameLedger');
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function growthSaveLedger(rows) {
  try { storeSet('gameLedger', JSON.stringify(rows)); } catch (e) {}
}

// 首页每次加载战绩后调用：把新对局增量记进台账（只记自己的）。
// 这是长期趋势能突破"接口只给最近 50 局"的唯一手段，所以放在数据落地的那一步。
function growthRecordGames(games, puuid) {
  if (!puuid || !Array.isArray(games) || !games.length) return;
  const prev = growthLedger();
  const r = PoroGrowth.mergeLedger(prev, games, puuid, typeof isExcludedGame === 'function' ? isExcludedGame : null, Date.now());
  if (r.added > 0 || r.records.length !== prev.length) growthSaveLedger(r.records);
}

function growthChampName(cid) {
  const c = (typeof champNumMap === 'object' && champNumMap) ? champNumMap[String(cid)] : null;
  return c && c.name ? c.name : (cid ? '英雄#' + cid : '未知');
}

function growthChampImg(cid) {
  const c = (typeof champNumMap === 'object' && champNumMap) ? champNumMap[String(cid)] : null;
  if (c && c.id && typeof champImg === 'function') return champImg(c.id);
  return typeof placeholder === 'function' ? placeholder('?') : '';
}

function growthPlanHtml(plan) {
  if (!plan.reviewed) {
    return `<div class="gw-empty">还没有做过 AI 复盘。在对局详情里点「AI 复盘」生成的结论会存到本机，攒够 ${PoroGrowth.MIN_REVIEWS} 局就能归纳共性问题。</div>`;
  }
  if (plan.targets.length === 0) {
    return `<div class="gw-empty">${escapeHtml(plan.note || '暂时没有可归纳的共性问题。')}</div>`;
  }
  const rows = plan.targets.map((t, i) => `
    <div class="gw-target">
      <div class="gw-t-top">
        <b class="gw-t-rank">${i + 1}</b>
        <b class="gw-t-label">${escapeHtml(t.label)}</b>
        <span class="gw-t-badge">${t.games}/${t.reviewed} 局提到</span>
      </div>
      ${t.quote ? `<p class="gw-t-quote">「${escapeHtml(t.quote)}」</p>` : ''}
      <p class="gw-t-action">${escapeHtml(t.action)}</p>
    </div>`).join('');
  // 被旧版解码弄坏的句子已经抹掉乱码，但少掉的字回不来，得让用户知道原句不全
  const warn = plan.damaged
    ? `<div class="gw-plan-warn">其中 ${plan.damaged} 局的复盘原句在旧版本里被截断过（缺了几个字，已抹掉乱码）。重新生成这几局的 AI 复盘可拿回完整原句。</div>`
    : '';
  return `<div class="gw-targets">${rows}</div>${warn}`;
}

function growthKpi(label, value, sub) {
  return `<div class="gw-kpi"><b>${value}</b><span>${escapeHtml(label)}${sub ? ' ' + sub : ''}</span></div>`;
}

function growthTrendHtml(tr) {
  if (!tr.total) {
    return `<div class="gw-empty">本机还没有累计到对局。先在首页加载一次战绩，台账会从那时开始逐局记录（SGP 接口只能翻最近 50 局，跨月趋势只能靠本机累积）。</div>`;
  }
  const pct = v => (v == null ? '--' : v + '%');
  const num = v => (v == null ? '--' : String(v));
  const delta = tr.wrDelta;
  const deltaHtml = delta == null ? ''
    : (delta === 0 ? '<i class="gw-delta">持平</i>'
      : `<i class="gw-delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '↑' : '↓'}${Math.abs(delta)}</i>`);
  const kpis = [
    growthKpi('近 30 天胜率', pct(tr.d30.wr), deltaHtml),
    growthKpi('近 30 天场次', tr.d30.n, `胜 ${tr.d30.wins}`),
    growthKpi('场均 KDA', num(tr.d30.kda), ''),
    growthKpi('场均死亡', num(tr.d30.dAvg), ''),
    growthKpi('CS / 分钟', num(tr.d30.csMin), '')
  ].join('');

  const champLine = (list, total) => list.length
    ? list.map(c => `<span class="gw-champ"><img src="${growthChampImg(c.id)}" alt="" onerror="this.style.display='none'"><b>${escapeHtml(growthChampName(c.id))}</b><i>${c.n}</i></span>`).join('')
    : '<span class="gw-champ-none">暂无</span>';
  const since = tr.firstAt ? new Date(tr.firstAt) : null;
  const sinceStr = since ? `${since.getMonth() + 1}月${since.getDate()}日` : '';
  const spanNote = tr.spanDays < 90
    ? `本机只累积了 ${tr.spanDays} 天（自 ${sinceStr} 起），90 天口径尚未满。`
    : `自 ${sinceStr} 起累积，覆盖 ${tr.spanDays} 天。`;
  const weekStart = tr.currentWeekStart ? new Date(tr.currentWeekStart) : null;
  const weekEnd = tr.currentWeekEnd ? new Date(tr.currentWeekEnd) : null;
  const weekRange = weekStart && weekEnd
    ? `${weekStart.getMonth() + 1}/${weekStart.getDate()}–${weekEnd.getMonth() + 1}/${weekEnd.getDate()}`
    : '';
  const weekNote = weekRange
    ? `按周统计 · 当前周 ${weekRange} · 已累计 ${tr.currentWeekGames || 0} 局`
    : '按周统计';
  const topRows = (rows, labelOf) => (Array.isArray(rows) ? rows : []).slice(0, 4).map(r =>
    `<span class="gw-breakdown"><b>${escapeHtml(labelOf(r.key))}</b><i>${r.wr}%</i><small>${r.n} 局</small></span>`).join('') || '<span class="gw-champ-none">样本不足</span>';
  const champBreakdown = topRows(tr.byChampion, id => growthChampName(+id));
  const positionNames = { top: '上路', jungle: '打野', mid: '中路', middle: '中路', adc: '下路', bottom: '下路', support: '辅助', utility: '辅助' };
  const positionBreakdown = topRows(tr.byPosition, id => positionNames[String(id).toLowerCase()] || id);

  return `
    <div class="gw-kpis">${kpis}</div>
    <div class="gw-chart-wrap"><canvas class="gw-chart" width="640" height="132"></canvas><div class="gw-chart-note">${escapeHtml(weekNote)}</div></div>
    <div class="gw-champrow">
      <div class="gw-champcol"><span class="gw-champhead">近 30 天常用</span><div class="gw-champs">${champLine(tr.champs30)}</div></div>
      <div class="gw-champcol"><span class="gw-champhead">近 90 天常用</span><div class="gw-champs">${champLine(tr.champs90)}</div></div>
    </div>
    <div class="gw-breakdown-row"><div><span class="gw-champhead">近 90 天英雄表现</span><div class="gw-breakdowns">${champBreakdown}</div></div><div><span class="gw-champhead">近 90 天位置表现</span><div class="gw-breakdowns">${positionBreakdown}</div></div></div>
    <div class="gw-foot">${escapeHtml(spanNote)} 近 90 天共 ${tr.d90.n} 局。数据存本机，清空配置即清空。</div>`;
}

// 近 13 周胜率柱状图。样本 <2 场的周画成灰柱：胜率 100% 的一局不能当趋势看。
function growthDrawChart(canvas, weeks) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 640;
  const cssH = 132;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = cssH + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW, H = cssH;
  const padL = 26, padR = 4, padT = 8, padB = 18;
  const css = getComputedStyle(document.body);
  const cText = css.getPropertyValue('--text-muted').trim() || '#888';
  // canvas 默认字体是 Arial, 和界面用的 Segoe UI 不是一套; 9px 也在可读下限之下。
  const cFont = css.getPropertyValue('font-family').trim() || 'sans-serif';
  const cWin = css.getPropertyValue('--positive').trim() || '#27ae60';
  const cLoss = css.getPropertyValue('--negative').trim() || '#e74c3c';
  ctx.clearRect(0, 0, W, H);

  const innerH = H - padT - padB;
  // 50% 基准线：柱子在它上面是赢多，下面是输多
  const y50 = padT + innerH * 0.5;
  ctx.strokeStyle = 'rgba(128,128,140,0.28)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(padL, y50); ctx.lineTo(W - padR, y50); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = cText; ctx.font = '10px ' + cFont; ctx.textAlign = 'left';
  ctx.fillText('50%', 2, y50 - 3);

  const n = weeks.length || 1;
  const slot = (W - padL - padR) / n;
  const barW = Math.max(6, Math.min(26, slot * 0.56));
  weeks.forEach((w, i) => {
    const cx = padL + slot * i + slot / 2;
    const thin = w.n < 2;
    const wr = w.wr == null ? 0 : w.wr;
    const h = Math.max(2, innerH * (wr / 100));
    const y = padT + innerH - h;
    ctx.fillStyle = thin ? 'rgba(140,140,150,0.30)' : (wr >= 50 ? cWin : cLoss);
    // 样本 <2 的周画成一枚 3px 小点, 而不是和柱子同宽的 2px 短横 ——
    // 否则空数据周连成一排横线, 看着像坐标轴上多了一串破折号。
    if (thin) ctx.fillRect(cx - 1.5, padT + innerH - 2, 3, 2);
    else ctx.fillRect(cx - barW / 2, y, barW, h);
    if (w.n && !thin) {
      ctx.fillStyle = cText; ctx.font = '10px ' + cFont; ctx.textAlign = 'center';
      ctx.fillText(String(wr), cx, y - 3);
    }
    // 每 2 周标一次日期，避免挤在一起
    if (i % 2 === (n - 1) % 2) {
      const d = new Date(w.start);
      ctx.fillStyle = cText; ctx.font = '10px ' + cFont; ctx.textAlign = 'center';
      const isCurrent = i === n - 1;
      ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}${isCurrent ? ' 本周' : ''}`, cx, H - 5);
    }
  });
}

function renderGrowthPage() {
  const box = document.getElementById('growthPanel');
  if (!box) return;
  const games = Array.isArray(homeGamesData) ? homeGamesData : [];
  if (!games.length) {
    box.innerHTML = '<div class="meta-loading">先到「首页」加载战绩后查看成长数据</div>';
    return;
  }
  const isSelf = (typeof homeGamesOwnerIsSelf === 'undefined') || homeGamesOwnerIsSelf !== false;
  const ownerLabel = (typeof homeGamesOwnerLabel === 'string' && homeGamesOwnerLabel) ? homeGamesOwnerLabel : '';
  if (!isSelf) {
    // 训练计划和台账都只记录本机主人自己的局，看别人档案时不能拿别人的数据凑
    box.innerHTML = `<div class="meta-loading">成长数据只统计自己的对局；当前查看的是 ${escapeHtml(ownerLabel || '其他玩家')}。</div>`;
    return;
  }
  try { if (typeof ensureChampMap === 'function') ensureChampMap(); } catch (e) {}

  const puuid = (typeof homeGamesOwner === 'string' && homeGamesOwner) || window._myPuuid || '';
  const reviews = growthReadReviews();
  const ledger = growthLedger();
  const plan = PoroGrowth.buildTrainingPlan({ reviews, games, puuid, now: Date.now() });
  const trend = PoroGrowth.buildTrend(ledger, Date.now());

  const reviewHint = plan.reviewed
    ? `近 ${plan.windowSize} 局 · ${plan.reviewed} 局已复盘`
    : '尚无复盘';
  const planFoot = plan.targets.length
    ? `同一主题至少 ${PoroGrowth.MIN_HIT} 局提到才计入；目标只是提示，是否执行由你判断。`
    : '';

  box.innerHTML = `
    <section class="gw-card">
      <div class="gw-head"><b>跨局训练计划</b><span>${escapeHtml(reviewHint)}</span></div>
      ${growthPlanHtml(plan)}
      ${planFoot ? `<div class="gw-foot">${escapeHtml(planFoot)}</div>` : ''}
    </section>
    <section class="gw-card">
      <div class="gw-head"><b>长期趋势</b><span>本机累计 ${trend.total} 局</span></div>
      ${growthTrendHtml(trend)}
    </section>`;

  if (trend.total) {
    const cv = box.querySelector('.gw-chart');
    try { growthDrawChart(cv, trend.weeks); } catch (e) {}
  }
}

// 首页后台刷新/新局落账后，若用户正停在成长页就顺手重算——
// 否则页面会一直显示打开那一刻的旧数字。
function refreshGrowthPageIfMounted() {
  const page = document.getElementById('page-growth');
  if (page && page.classList.contains('active')) renderGrowthPage();
}
