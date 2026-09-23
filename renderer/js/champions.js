// 英雄数据 / 强度 / 网格 / 详情
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== op.gg 英雄数据 ==========
let opggPosList = [];  // 扁平化: [{championId, position, stats, rank, championData}]
async function loadOpgg() {
  try {
    const r = await lolAPI.getOpgg();
    if (r.__error) return console.error("op.gg:", r.__error);
    opggMap = {};
    opggPosList = [];
    for (const c of (r.data || [])) {
      opggMap[c.id] = c;
      // 按位置展开, 每个位置单独排名
      for (const p of (c.positions || [])) {
        const posName = POS_MAP[p.name] || p.name;
        opggPosList.push({
          championId: c.id,
          position: posName,
          positionKey: p.name,
          stats: p.stats,
          overallTier: c.average_stats?.tier_data?.tier,
          championData: null
        });
      }
    }
    // 按位置 tier_data.rank 排序, 同 rank 按 tier 再按胜率排
    opggPosList.sort((a, b) => {
      const ra = a.stats?.tier_data?.rank ?? 999, rb = b.stats?.tier_data?.rank ?? 999;
      if (ra !== rb) return ra - rb;
      const ta = a.stats?.tier_data?.tier ?? 9, tb = b.stats?.tier_data?.tier ?? 9;
      if (ta !== tb) return ta - tb;
      return (b.stats?.win_rate ?? 0) - (a.stats?.win_rate ?? 0);
    });
    ensureChampMap();
    renderChampionGrid();
  } catch (e) { console.error("op.gg 加载失败:", e); }
}
function opggOf(c) { return opggMap[+c.key] || null; }
function opggTierLabel(c) {
  const o = opggOf(c);
  if (!o) return null;
  return { 0: "OP", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5" }[o.average_stats?.tier_data?.tier] || null;
}

// ========== 角色筛选 ==========
function renderRoleFilters() {
  document.getElementById("roleFilters").innerHTML = ROLES.map(r =>
    `<button class="role-btn ${r === "all" ? "active" : ""}" data-role="${r}" onclick="filterByRole('${r}', this)">${r === "all" ? "全部" : r}</button>`).join("");
}

// ========== 英雄强度 (op.gg 真实数据, 无数据时退回属性参考值) ==========
function tierScore(c) {
  const i = c.info || {};
  return Math.max(i.attack || 0, i.magic || 0) * 1.2 + (i.defense || 0) * 0.8 + (10 - (i.difficulty || 5)) * 0.5;
}
function tierOf(c) {
  const t = opggTierLabel(c);
  if (t) return t;
  const s = tierScore(c);
  return s >= 17.5 ? "2" : s >= 16 ? "3" : "4";
}

// ========== 英雄网格 ==========
function renderChampionGrid(filter = "", role = "all") {
  const grid = document.getElementById("championGrid");
  if (!grid) return;
  ensureChampMap();
  const POS_ICON = { '上单': 'top', '打野': 'jungle', '中单': 'mid', '下路': 'adc', '辅助': 'sup' };
  // 从扁平化位置列表筛选
  const filtered = opggPosList.filter(entry => {
    const c = champNumMap[String(entry.championId)];
    if (!c) return false;
    const nameMatch = c.name.toLowerCase().includes(filter.toLowerCase()) ||
      c.id.toLowerCase().includes(filter.toLowerCase());
    const roleMatch = role === "all" || entry.position === role;
    return nameMatch && roleMatch;
  });
  if (!filtered.length) {
    grid.innerHTML = '<div class="meta-loading">没有匹配的英雄</div>';
    return;
  }
  const rows = filtered.map((entry, idx) => {
    const c = champNumMap[String(entry.championId)];
    const tier = { 0: "OP", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5" }[entry.stats?.tier_data?.tier] || '3';
    const wr = entry.stats ? (entry.stats.win_rate * 100).toFixed(1) : '--';
    const pr = entry.stats ? (entry.stats.pick_rate * 100).toFixed(1) : '--';
    const br = entry.stats ? (entry.stats.ban_rate * 100).toFixed(1) : '--';
    const posIcon = POS_ICON[entry.position] || 'top';
    return `<div class="champ-row" onclick="showChampionDetail('${c.id}')">
      <div class="champ-rank">${idx + 1}</div>
      <img class="champ-icon" src="${champImg(c.id)}" onerror="this.src='${placeholder(c.name)}'">
      <div class="champ-name">${escapeHtml(c.name)}</div>
      <div class="champ-tier t-${tier}">${tier}</div>
      <div class="champ-pos pos-${posIcon}">${entry.position}</div>
      <div class="champ-wr ${parseFloat(wr) >= 50 ? 'pos' : 'neg'}">${wr}%</div>
      <div class="champ-pr">${pr}%</div>
      <div class="champ-br">${br}%</div>
    </div>`;
  }).join("");
  grid.innerHTML = `<div class="champ-table">
    <div class="champ-table-header">
      <div class="champ-rank">#</div><div></div><div>英雄</div><div>评级</div><div>位置</div><div>胜率</div><div>登场率</div><div>禁用率</div>
    </div>
    ${rows}
  </div>`;
}
function placeholder(name) {
  // 首字符会进入 SVG data URI, 且该 URI 被当作 HTML 属性值使用 (onerror="this.src='...'"),
  // 因此必须剔除能突破属性/URI 的字符, 否则召唤师名可注入属性。
  const initial = String(name == null ? '?' : name).replace(/[&<>"'%\\]/g, '').charAt(0) || '?';
  const svg = `<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23f3ecdf%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23a37b2c%22 font-size=%2236%22>${initial}</text></svg>`;
  return "data:image/svg+xml," + svg;
}
function filterChampions() { renderChampionGrid(document.getElementById("championSearch").value, currentRole); }
function filterByRole(role, btn) {
  currentRole = role;
  document.querySelectorAll(".role-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  filterChampions();
}

// ========== 英雄详情 (真实数据: 属性/技能/被动/皮肤) ==========
async function showChampionDetail(key) {
  const c = allChampions[key];
  if (!c) return;
  document.getElementById("modalBody").innerHTML = '<div class="meta-loading">加载中...</div>';
  document.getElementById("championModal").classList.add("active");
    const d = await lolAPI.getChampionDetail(version, key);
  if (!d) { document.getElementById("modalBody").innerHTML = '<div class="meta-loading">详情加载失败</div>'; return; }
  const stats = d.info || {};
  const statRows = [
    ["攻击", stats.attack], ["法术", stats.magic], ["防御", stats.defense], ["难度", stats.difficulty]
  ].map(([l, v]) => `<div class="champ-stat"><div class="label">${l}</div><div class="value">${v ?? "-"}</div></div>`).join("");
  const roles = (d.tags || []).map(t => `<span class="role-tag">${ROLE_MAP[t] || t}</span>`).join("");
  const spells = (d.spells || []).map((s, i) => `
    <div class="skill-item" title="${(s.description || "").replace(/<[^>]+>/g, "").replace(/"/g, "")}">
      <img src="${spellImg(s.image.full)}" loading="lazy">
      <span class="key">${["Q", "W", "E", "R"][i] || ""}</span>
      <span class="name">${s.name}</span>
    </div>`).join("");
  const passive = d.passive ? `
    <div class="skill-item" title="${(d.passive.description || "").replace(/<[^>]+>/g, "").replace(/"/g, "")}">
      <img src="${passiveImg(d.passive.image.full)}" loading="lazy" onerror="this.src='${placeholder(d.name)}'">
      <span class="key">被动</span>
      <span class="name">${d.passive.name}</span>
    </div>` : "";
  const o = opggOf(c);
  const POS_NAMES = { TOP: "上单", JUNGLE: "打野", MID: "中单", ADC: "射手", SUPPORT: "辅助" };
  const opggHtml = o ? `
    <div class="opgg-box">
      <h3>op.gg 数据 (KR)</h3>
      <div class="opgg-summary">
        <span>胜率 <b>${(o.average_stats.win_rate * 100).toFixed(1)}%</b></span>
        <span>登场率 <b>${(o.average_stats.pick_rate * 100).toFixed(1)}%</b></span>
        <span>禁用率 <b>${(o.average_stats.ban_rate * 100).toFixed(1)}%</b></span>
        <span>KDA <b>${o.average_stats.kda.toFixed(2)}</b></span>
        <span>梯度 <b>${tierOf(c)}</b></span>
      </div>
      ${(o.positions || []).slice(0, 3).map(p => `
        <div class="opgg-pos">
          <span class="pos-name">${POS_NAMES[p.name] || p.name}</span>
          <span>胜率 <b>${(p.stats.win_rate * 100).toFixed(1)}%</b></span>
          <span>登场 <b>${(p.stats.pick_rate * 100).toFixed(1)}%</b></span>
          <span class="pos-tier">${{ 1: "S", 2: "A", 3: "B", 4: "C", 5: "D" }[p.stats.tier_data?.tier] || "-"}</span>
        </div>`).join('')}
      <div class="pp-note">数据来源 op.gg · 韩服排位 · 当前版本</div>
    </div>` : "";
  const baseSkins = nonChromaSkins(d.skins);
  const skins = baseSkins.map(s => `
    <div class="skin-card" title="${s.name}">
      <img src="${splashUrl(d.id || key, s.num)}" loading="lazy" onerror="this.src='${placeholder(d.name)}';this.classList.add('skin-fallback')">
      <div class="skin-name">${s.name === "default" ? "默认皮肤" : s.name}</div>
    </div>`).join("");
  document.getElementById("modalBody").innerHTML = `
    <div class="champ-detail">
      <img src="${champImg(key)}" alt="${d.name}" onerror="this.style.display='none'">
      <div class="champ-detail-info">
        <h2>${d.name}</h2>
        <div class="title">${d.title}</div>
        <div class="roles">${roles}</div>
        <div class="champ-stats">${statRows}</div>
      </div>
    </div>
    <div class="champ-skills"><h3>技能</h3><div class="skill-list">${passive}${spells}</div></div>
    ${opggHtml}
    <div class="champ-skins"><h3>皮肤预览 (${baseSkins.length})</h3><div class="skin-grid">${skins}</div></div>`;
}
function closeModal() { document.getElementById("championModal").classList.remove("active"); }
