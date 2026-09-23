// 赛后复盘 + AI 复盘
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 赛后复盘: 魄罗评分 + SGP 时间线图表 + AI 分析 ==========
// 魄罗评分按模式切换指标；大乱斗没有常规视野/野区评价。
function isAramReviewMode(norm) {
  const queueId = +norm?.queueId || 0;
  const text = String(norm?.mode || norm?.gameMode || '').toUpperCase();
  return queueId === 450 || queueId === 2400 || /极地大乱斗|海克斯大乱斗|ARAM|KIWI|MAYHEM/.test(text);
}

function buildPoroRadar(dims) {
  const cx = 115;
  const cy = 83;
  const radius = 55;
  const pointAt = (index, value, extraRadius = 0) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / dims.length;
    const r = extraRadius || radius * Math.max(0, Math.min(100, value)) / 100;
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  };
  const points = values => values.map((value, index) => pointAt(index, value).map(n => n.toFixed(1)).join(',')).join(' ');
  const rings = [20, 40, 60, 80, 100].map(value =>
    `<polygon class="pr-radar-ring${value === 60 ? ' is-average' : ''}" points="${points(dims.map(() => value))}"></polygon>`
  ).join('');
  const axes = dims.map((_, index) => {
    const [x, y] = pointAt(index, 100);
    return `<line class="pr-radar-axis" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"></line>`;
  }).join('');
  const labels = dims.map(([label, value], index) => {
    const [x, y] = pointAt(index, 0, 73);
    const anchor = x < cx - 8 ? 'end' : x > cx + 8 ? 'start' : 'middle';
    return `<text class="pr-radar-label" x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${anchor}">${label} ${value}</text>`;
  }).join('');
  const dots = dims.map(([, value], index) => {
    const [x, y] = pointAt(index, value);
    return `<circle class="pr-radar-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6"></circle>`;
  }).join('');
  const description = dims.map(([label, value]) => `${label}${value}`).join('，');
  return `<div class="pr-radar" role="img" aria-label="个人能力图：${description}；全场平均为60">
    <svg viewBox="0 0 230 168" aria-hidden="true">
      ${rings}${axes}
      <polygon class="pr-radar-average" points="${points(dims.map(() => 60))}"></polygon>
      <polygon class="pr-radar-personal" points="${points(dims.map(d => d[1]))}"></polygon>
      ${dots}${labels}
      <g class="pr-radar-legend">
        <rect x="52" y="155" width="9" height="9" rx="2" class="personal"></rect><text x="66" y="163">个人</text>
        <rect x="121" y="155" width="9" height="9" rx="2" class="average"></rect><text x="135" y="163">全场平均</text>
      </g>
    </svg>
  </div>`;
}
function buildPoroRating(norm) {
  try {
    const ownerPuuid = (profileOverride && profileOverride.puuid) || (cachedSummoner && cachedSummoner.puuid) || window._myPuuid;
    const me = norm.participants.find(p => p.puuid === ownerPuuid);
    if (!me) return '';
    const n = norm.participants.length || 1;
    const avg = f => norm.participants.reduce((s, p) => s + (p[f] || 0), 0) / n;
    const avgD = norm.participants.reduce((s, p) => s + (p.d || 0), 0) / n;
    const teams = {};
    for (const p of norm.participants) (teams[p.teamId] = teams[p.teamId] || []).push(p);
    const kpOf = p => { const tm = teams[p.teamId] || []; const tk = tm.reduce((s, x) => s + x.k, 0); return tk ? (p.k + p.a) / tk : 0; };
    const avgKp = norm.participants.reduce((s, p) => s + kpOf(p), 0) / n;
    const clamp = v => Math.max(5, Math.min(99, Math.round(v)));
    const aramMode = isAramReviewMode(norm);
    const dims = aramMode ? [
      ['输出', clamp(60 * ((me.dmg || 0) / Math.max(1, avg('dmg'))))],
      ['生存', clamp(60 * (avgD / Math.max(1, me.d)))],
      ['承伤', clamp(60 * ((me.dmgTaken || 0) / Math.max(1, avg('dmgTaken'))))],
      ['经济', clamp(60 * ((me.gold || 0) / Math.max(1, avg('gold'))))],
      ['参团', clamp(60 * (kpOf(me) / Math.max(0.01, avgKp)))]
    ] : [
      ['输出', clamp(60 * ((me.dmg || 0) / Math.max(1, avg('dmg'))))],
      ['生存', clamp(60 * (avgD / Math.max(1, me.d)))],
      ['视野', clamp(60 * ((me.visionScore || 0) / Math.max(1, avg('visionScore'))))],
      ['经济', clamp(60 * ((me.gold || 0) / Math.max(1, avg('gold'))))],
      ['参团', clamp(60 * (kpOf(me) / Math.max(0.01, avgKp)))]
    ];
    const total = Math.round(dims.reduce((s, d) => s + d[1], 0) / dims.length);
    return `<div class="pr-box">
      <div class="pr-score">${total}<span>魄罗评分</span></div>
      <div class="pr-dims">${dims.map(([l, v]) => `
        <div class="pr-dim"><span class="pr-label">${l}</span><div class="pr-bar"><i style="width:${v}%"></i></div><span class="pr-val">${v}</span></div>`).join('')}
      </div>
      ${buildPoroRadar(dims)}
      <div class="pr-note">60 = 本场平均 · ${aramMode ? '大乱斗按输出/生存/承伤/经济/参团评分' : '峡谷按输出/生存/视野/经济/参团评分'}</div>
    </div>`;
  } catch (e) { return ''; }
}
let _reviewSeq = 0;
async function renderGameReview(norm, gameId, detail, gamePlatformId) {
  const seq = ++_reviewSeq;
  const box = document.createElement('div');
  box.className = 'rv-box';
  box.innerHTML = '<div class="rv-title">复盘分析</div><div class="rv-body">' + buildPoroRating(norm) + '<div class="rv-tl"><span class="ri-empty">时间线加载中...</span></div></div>';
  // 点击复盘区内部 (如 AI 复盘按钮) 不冒泡到对局卡片, 否则会触发 expandOpggGame 导致详情直接折叠
  box.addEventListener('click', (ev) => ev.stopPropagation());
  detail.appendChild(box);
  const body = box.querySelector('.rv-tl');
  let tl = null;
  const pidTeam = {};
  try {
    const platformId = gamePlatformId || await getPlatformId();
    const resp = await lolAPI.sgpGameDetails(platformId, gameId);
    if (!resp.__error) {
      const g = resp.json || resp;
      // 国服 SGP DETAILS: frames 在顶层, participants 仅含 {participantId, puuid}
      // pid->team 需经 puuid 与 SUMMARY(norm) 联查; 顺序上 participants[i] 即 pid=i+1 (已实测)
      const plist = g.participants || (g.gameDetail || g).players || [];
      for (const p of plist) {
        const pid = p.participantId || 0;
        if (p.teamId != null) { pidTeam[pid] = p.teamId; continue; }
        const np = norm.participants.find(x => x.puuid && x.puuid === p.puuid)
          || norm.participants[pid - 1];
        if (np) pidTeam[pid] = np.teamId;
      }
      const gd = g.gameDetail || g;
      tl = g.frames || gd.frames || gd.gameTimeline?.timeline?.frames || gd.gameTimeline?.frames || null;
    }
  } catch (e) {}
  if (seq !== _reviewSeq) return;
  if (!tl || !tl.length) {
    body.innerHTML = '<span class="ri-empty">无时间线数据 (仅国服 SGP 对局支持复盘)</span>';
    return;
  }
  const chart = buildTimelineData(tl, pidTeam);
  const paint = drawTimelineChart(chart);
  body.innerHTML = `
    ${buildAutomaticReview(norm, chart)}
    <canvas class="rv-canvas" width="760" height="150"></canvas>
    <div class="rv-chips">${chart.chips}</div>
    <div class="rv-ai"><button class="btn-secondary rv-ai-btn">AI 复盘</button><div class="rv-ai-out"></div></div>`;
  paint(body.querySelector('.rv-canvas'));
  body.querySelector('.rv-ai-btn').addEventListener('click', (ev) => {
    runAiReview(ev.target, norm, chart);
  });
}
// 解析时间线帧 → 经济差序列 + 关键事件
function buildTimelineData(frames, pidTeam) {
  const diffs = [];   // {t(分钟), diff(蓝-红经济)}
  const kills = [];   // {t, team(击杀方), first}
  const objectives = { baron: [], dragon: [], elder: [], herald: [], towers: { 100: 0, 200: 0 }, inhibitors: { 100: 0, 200: 0 } };
  let firstBloodTeam = null;
  for (const fr of frames) {
    const tMin = (fr.timestamp || 0) / 60000;
    let g100 = 0, g200 = 0;
    const pf = fr.participantFrames || {};
    for (const key of Object.keys(pf)) {
      const pid = +key;
      const gold = pf[key]?.totalGold || 0;
      if (pidTeam[pid] === 200) g200 += gold; else g100 += gold;
    }
    diffs.push({ t: tMin, diff: g100 - g200 });
    for (const ev of (fr.events || [])) {
      if (ev.type === 'CHAMPION_KILL') {
        if (firstBloodTeam === null && ev.killerId) firstBloodTeam = pidTeam[ev.killerId] || null;
        if (ev.killerId && ev.killerId > 0) kills.push({ t: tMin, team: pidTeam[ev.killerId] || 0 });
      } else if (ev.type === 'ELITE_MONSTER_KILL') {
        const mt = ev.monsterType || '';
        const killerTeam = pidTeam[ev.killerId] || ev.killerTeamId || 0;
        if (mt === 'BARON_NASHOR') objectives.baron.push({ t: tMin, team: killerTeam });
        else if (mt === 'DRAGON') objectives.dragon.push({ t: tMin, team: killerTeam });
        else if (mt === 'ELDER_DRAGON') objectives.elder.push({ t: tMin, team: killerTeam });
        else if (mt === 'RIFTHERALD') objectives.herald.push({ t: tMin, team: killerTeam });
      } else if (ev.type === 'BUILDING_KILL') {
        const kt = ev.killerTeamId || pidTeam[ev.killerId] || 0;
        if (ev.buildingType === 'TOWER_BUILDING') { if (kt) objectives.towers[kt === 100 ? 200 : 100]++; }
        else if (ev.buildingType === 'INHIBITOR_BUILDING') { if (kt) objectives.inhibitors[kt === 100 ? 200 : 100]++; }
      }
    }
  }
  const goldAt = m => {
    let last = 0;
    for (const d of diffs) { if (d.t <= m) last = d.diff; else break; }
    return last;
  };
  const chips = [];
  const fmtGold = v => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v));
  if (firstBloodTeam) chips.push(`<span class="rv-chip">一血: ${firstBloodTeam === 100 ? '蓝方' : '红方'}</span>`);
  for (const m of [10, 15, 20, 25]) {
    const v = goldAt(m);
    if (diffs.length && diffs[diffs.length - 1].t >= m * 0.9) {
      chips.push(`<span class="rv-chip">${m}分钟: <b class="${v >= 0 ? 'pos' : 'neg'}">蓝${v >= 0 ? '+' : ''}${fmtGold(v)}</b></span>`);
    }
  }
  const baron100 = objectives.baron.filter(b => b.team === 100).length;
  const baron200 = objectives.baron.filter(b => b.team === 200).length;
  const drag100 = objectives.dragon.filter(b => b.team === 100).length + objectives.elder.filter(b => b.team === 100).length;
  const drag200 = objectives.dragon.filter(b => b.team === 200).length + objectives.elder.filter(b => b.team === 200).length;
  chips.push(`<span class="rv-chip">🏰 ${objectives.towers[100]} : ${objectives.towers[200]}</span>`);
  chips.push(`<span class="rv-chip">🐉 ${drag100} : ${drag200}</span>`);
  chips.push(`<span class="rv-chip">🦅 ${baron100} : ${baron200}</span>`);
  return { diffs, kills, chips, objectives, firstBloodTeam };
}

function buildAutomaticReview(norm, chart) {
  try {
    const ownerPuuid = (profileOverride && profileOverride.puuid) || (cachedSummoner && cachedSummoner.puuid) || window._myPuuid;
    const me = norm.participants.find(p => p.puuid === ownerPuuid);
    if (!me) return '';
    const ownTeam = +me.teamId || 100;
    const aramMode = isAramReviewMode(norm);
    const sign = ownTeam === 200 ? -1 : 1;
    const diffs = chart.diffs || [];
    let swing = { amount: 0, from: 0, to: 0 };
    for (let i = 1; i < diffs.length; i++) {
      const start = Math.max(0, i - 5);
      const change = (diffs[i].diff - diffs[start].diff) * sign;
      if (Math.abs(change) > Math.abs(swing.amount)) swing = { amount: change, from: diffs[start].t, to: diffs[i].t };
    }
    const team = (norm.participants || []).filter(p => +p.teamId === ownTeam);
    const teamDamage = team.reduce((sum, p) => sum + (+p.dmg || 0), 0);
    const damageShare = teamDamage ? (+me.dmg || 0) / teamDamage : 0;
    const kda = ((+me.k || 0) + (+me.a || 0)) / Math.max(1, +me.d || 0);
    const ownDragons = (chart.objectives.dragon || []).filter(x => +x.team === ownTeam).length + (chart.objectives.elder || []).filter(x => +x.team === ownTeam).length;
    const enemyDragons = (chart.objectives.dragon || []).filter(x => +x.team && +x.team !== ownTeam).length + (chart.objectives.elder || []).filter(x => +x.team && +x.team !== ownTeam).length;
    const points = [];
    if (chart.firstBloodTeam) points.push(chart.firstBloodTeam === ownTeam ? '己方拿到一血，前期建立了主动权。' : '敌方拿到一血，开局节奏落后。');
    if (Math.abs(swing.amount) >= 800) points.push(`${Math.round(swing.from)}–${Math.round(swing.to)} 分钟是最大转折段，己方经济${swing.amount > 0 ? '提升' : '损失'}约 ${Math.round(Math.abs(swing.amount) / 100) / 10}k。`);
    points.push(`你的 KDA ${kda.toFixed(1)}，团队伤害占比 ${Math.round(damageShare * 100)}%。`);
    if (!aramMode && ownDragons !== enemyDragons) points.push(`地图资源：己方 ${ownDragons} 条龙，对方 ${enemyDragons} 条龙。`);
    const goal = (+me.d || 0) >= (aramMode ? 10 : 9)
      ? (aramMode ? '下局目标：死亡控制在 9 次以内，避免复活后与队伍脱节进场。' : '下局目标：死亡控制在 8 次以内，劣势时减少无视野接团。')
      : damageShare < 0.18
        ? '下局目标：提高团战有效输出，关键技能留给可持续命中的目标。'
        : kda < 3
          ? '下局目标：参团前确认队友距离，优先保证一次完整技能循环。'
          : (aramMode ? '下局目标：保持当前生存效率，优势时与队友同步压塔，不单独追击。' : '下局目标：保持当前生存效率，并把优势转成先锋、小龙或防御塔。');
    return `<div class="rv-auto-review"><div class="rv-auto-head"><b>自动关键复盘</b><span>${me.win ? '胜利局巩固' : '败局改进'}</span></div><div class="rv-auto-points">${points.slice(0, 4).map(text => `<p>${escapeHtml(text)}</p>`).join('')}</div><strong>${escapeHtml(goal)}</strong></div>`;
  } catch (e) { return ''; }
}
function drawTimelineChart(chart) {
  return (canvas) => {
    // 按 devicePixelRatio 渲染以避免高 DPI 显示模糊; W/H 用 CSS 实际宽度 (逻辑像素)
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 760;
    const cssH = Math.round(cssW * 150 / 760);
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.height = cssH + 'px';
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = cssW, H = cssH;
    const padL = 8, padR = 8, padT = 10, padB = 16;
    const diffs = chart.diffs;
    if (!diffs.length) return;
    const tMax = Math.max(1, diffs[diffs.length - 1].t);
    let maxAbs = 2000;
    for (const d of diffs) maxAbs = Math.max(maxAbs, Math.abs(d.diff));
    maxAbs = Math.ceil(maxAbs / 2000) * 2000;
    const x = t => padL + (t / tMax) * (W - padL - padR);
    const y = v => padT + (1 - (v + maxAbs) / (2 * maxAbs)) * (H - padT - padB);
    const css = getComputedStyle(document.body);
    const cText = css.getPropertyValue('--text-muted').trim() || '#888';
    const cWin = css.getPropertyValue('--positive').trim() || '#27ae60';
    const cLoss = css.getPropertyValue('--negative').trim() || '#e74c3c';
    ctx.clearRect(0, 0, W, H);
    // 网格
    ctx.strokeStyle = 'rgba(128,128,140,0.18)';
    ctx.lineWidth = 1;
    for (const gm of [5, 10, 15, 20, 25, 30, 35, 40]) {
      if (gm > tMax) break;
      ctx.beginPath(); ctx.moveTo(x(gm), padT); ctx.lineTo(x(gm), H - padB); ctx.stroke();
      ctx.fillStyle = cText; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(gm + '分', x(gm), H - 4);
    }
    // 零轴
    ctx.strokeStyle = 'rgba(128,128,140,0.4)';
    ctx.beginPath(); ctx.moveTo(padL, y(0)); ctx.lineTo(W - padR, y(0)); ctx.stroke();
    // 经济差折线 (降采样到 120 点)
    const step = Math.max(1, Math.floor(diffs.length / 120));
    ctx.beginPath();
    let first = true;
    for (let i = 0; i < diffs.length; i += step) {
      const d = diffs[i];
      if (first) { ctx.moveTo(x(d.t), y(d.diff)); first = false; }
      else ctx.lineTo(x(d.t), y(d.diff));
    }
    const lastD = diffs[diffs.length - 1];
    ctx.lineTo(x(lastD.t), y(lastD.diff));
    ctx.strokeStyle = cWin; ctx.lineWidth = 1.6; ctx.stroke();
    // 击杀事件点
    for (const k of chart.kills) {
      const at = diffs.reduce((best, d) => (Math.abs(d.t - k.t) < Math.abs(best.t - k.t) ? d : best), diffs[0]);
      ctx.beginPath();
      ctx.arc(x(at.t), y(at.diff), 2.5, 0, Math.PI * 2);
      ctx.fillStyle = k.team === 100 ? '#5b9bd5' : '#e05555';
      ctx.fill();
    }
    // 图例
    ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
    ctx.fillStyle = cText;
    ctx.fillText('蓝方领先 ↑', padL + 4, padT + 2);
    ctx.fillText(`最终 ${lastD.diff >= 0 ? '蓝' : '红'}方领先 ${fmtGoldShort(Math.abs(lastD.diff))}`, padL + 80, padT + 2);
  };
}
function fmtGoldShort(v) { return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v); }

// ========== AI 复盘 ==========
async function runAiReview(btn, norm, chart) {
  const out = btn.parentElement.querySelector('.rv-ai-out');
  btn.disabled = true;
  btn.textContent = 'AI 分析中...';
  out.textContent = '';
  try {
    const aramMode = isAramReviewMode(norm);
    const players = norm.participants.map(p => {
      const c = champNumMap[String(p.championId)];
      return {
        名字: p.name, 英雄: c ? c.name : p.championId, 阵营: p.teamId === 100 ? '蓝' : '红',
        位置: p.position || '', KDA: `${p.k}/${p.d}/${p.a}`, 补刀: p.cs || 0,
        经济: p.gold || 0, 输出: p.dmg || 0, 承伤: p.dmgTaken || 0,
        ...(aramMode ? {} : { 视野: p.visionScore || 0 }),
        胜负: p.win ? '胜' : '负'
      };
    });
    const goldCurve = [];
    for (const d of chart.diffs) {
      const m = Math.floor(d.t);
      if (!goldCurve.length || goldCurve[goldCurve.length - 1].分钟 !== m) goldCurve.push({ 分钟: m, 蓝方经济差: Math.round(d.diff) });
    }
    const userContent = JSON.stringify({
      模式: norm.mode, 时长秒: norm.dur, 时间线: goldCurve.filter((_, i) => i % 2 === 0),
      目标物: !aramMode && chart.objectives ? {
        推塔: chart.objectives.towers, 小龙: chart.objectives.dragon.length, 大龙: chart.objectives.baron.length
      } : null,
      玩家: players
    });
    const messages = [
      { role: 'system', content: aramMode
        ? '你是一名英雄联盟大乱斗教练。基于数据输出3-5条简明要点，每条不超过40字；只分析团战站位、进场时机、输出、承伤、治疗护盾、经济和参团。大乱斗没有野区、野怪、插眼控视野或小龙大龙运营，禁止给出这些建议。使用中文，直接输出要点列表。'
        : '你是一名英雄联盟峡谷教练。基于用户提供的对局数据做复盘分析，输出3-5条简明要点，每条不超过40字，关注决定胜负的关键节点、双方运营节奏差异、最值得改进的具体行为。使用中文，直接输出要点列表，不要寒暄。' },
      { role: 'user', content: userContent }
    ];
    const resp = await lolAPI.aiChat(messages);
    if (resp.__error) {
      out.innerHTML = `<span style="color:var(--negative)">${escapeHtml(resp.__error)}</span>`;
    } else {
      // 部分推理模型 (deepseek-r1 风格) 会把结果放在 reasoning_content 而 content 为空;
      // 同时 content 可能只有空白/换行 → 经 split/filter 后变空 (用户看不到任何东西)
      const m = resp.choices?.[0]?.message || {};
      let text = (m.content || '').trim() || (m.reasoning_content || '').trim();
      if (!text) text = '(空响应: 模型未返回文本)';
      // 用空行分段, 每段一个 div; 单段内换行再细分, 保留换行结构
      out.innerHTML = text.split(/\n{2,}/).map(p => p.trim() ? (
        `<div class="rv-ai-line">${p.split('\n').map(l => escapeHtml(l.trim())).join('<br>')}</div>`
      ) : '').filter(Boolean).join('');
    }
  } catch (e) {
    out.innerHTML = `<span style="color:var(--negative)">AI 请求失败: ${escapeHtml(e.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'AI 复盘';
  }
}
// AI 配置保存 (userData/ai.json, OpenAI 兼容接口)
// 预览实际请求地址 (与主进程 resolveChatUrl 同规则)
function previewAiUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    let path = u.pathname.replace(/\/+$/, '') || '';
    if (!/chat\/completions$/i.test(path)) {
      path += /\/v\d+[a-z]*$/i.test(path) ? '/chat/completions' : '/v1/chat/completions';
    }
    return u.origin + path;
  } catch (e) { return '(地址无效)'; }
}
async function saveAiConfig() {
  const baseUrl = document.getElementById('aiBaseUrl').value.trim();
  const apiKey = document.getElementById('aiApiKey').value.trim();
  const model = document.getElementById('aiModel').value.trim() || 'glm-4-flash';
  if (!baseUrl) return toolMsg('<span style="color:var(--negative)">请填写接口地址</span>');
  const result = await lolAPI.saveAiConfig({ baseUrl, apiKey, model });
  if (result?.__error) return toolMsg('<span style="color:var(--negative)">保存失败: ' + escapeHtml(result.__error) + '</span>');
  const keyEl = document.getElementById('aiApiKey');
  if (keyEl) { keyEl.value = ''; keyEl.placeholder = '已使用 Windows 安全存储保存；留空表示不修改'; }
  toolMsg('<span style="color:var(--positive)">AI 配置已安全保存<br>实际请求: ' + escapeHtml(previewAiUrl(baseUrl)) + '</span>');
}
// 连通性测试: 发送最小请求验证 地址/Key/模型 是否可用
async function testAiConfig() {
  toolMsg('测试连接中...');
  try {
    const cfg = await lolAPI.getAiConfig();
    if (!cfg || cfg.__error || !cfg.hasApiKey || !cfg.baseUrl) return toolMsg('<span style="color:var(--negative)">请先填写并保存配置</span>');
    const resp = await lolAPI.aiChat([{ role: 'user', content: '回复 OK 两个字母即可' }]);
    if (resp.__error) return toolMsg('<span style="color:var(--negative)">测试失败: ' + resp.__error + '</span>');
    const text = resp.choices?.[0]?.message?.content || '(空响应)';
    toolMsg('<span style="color:var(--positive)">测试成功, 模型回复: ' + text.replace(/</g, '&lt;').substring(0, 60) + '</span>');
  } catch (e) {
    toolMsg('<span style="color:var(--negative)">测试失败: ' + e.message + '</span>');
  }
}
async function loadAiConfig() {
  try {
    const cfg = await lolAPI.getAiConfig();
    if (!cfg || cfg.__error) return;
    const el1 = document.getElementById('aiBaseUrl'), el2 = document.getElementById('aiApiKey'), el3 = document.getElementById('aiModel');
    if (el1 && cfg.baseUrl) el1.value = cfg.baseUrl;
    if (el3 && cfg.model) el3.value = cfg.model;
    if (el2 && cfg.hasApiKey) { el2.value = ''; el2.placeholder = '已使用 Windows 安全存储保存；留空表示不修改'; }
  } catch (e) {}
}
