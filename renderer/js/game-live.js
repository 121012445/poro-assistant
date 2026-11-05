// 对局战报浮窗页面 (F9 呼出; 主进程 game-live:push 推数据; 点击穿透)
// 数据由主窗口实时对局页在 InProgress 期间推送, 这里只做纯渲染。
(function () {
  'use strict';
  const teamsEl = document.getElementById('teams');

  function esc(value) {
    const div = document.createElement('div');
    div.textContent = String(value == null ? '' : value);
    return div.innerHTML;
  }

  function champImg(p, version) {
    if (p.champKey && version) {
      return 'https://ddragon.leagueoflegends.com/cdn/' + version + '/img/champion/' + encodeURIComponent(p.champKey) + '.png';
    }
    return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="#24404d" width="100" height="100"/></svg>');
  }

  function kdaText(p) {
    if (!p.games) return { main: '--', sub: '', cls: '' };
    const kda = ((p.k + p.a) / Math.max(1, p.d)).toFixed(1);
    const wr = Math.round(p.wins / p.games * 100);
    return {
      main: wr + '%',
      sub: p.games + '场 ' + p.k + '/' + p.d + '/' + p.a,
      cls: wr >= 50 ? 'good' : 'bad'
    };
  }

  function playerRow(p) {
    const kda = kdaText(p);
    const tags = (p.isSelf ? '<span class="tag">自己</span>' : '')
      + (p.premade ? '<span class="tag premade">' + esc(p.premade) + '</span>' : '')
      + (p.flash ? '<span class="tag">' + esc(p.flash) + '</span>' : '');
    return '<div class="row' + (p.isSelf ? ' self' : '') + '">'
      + '<img src="' + champImg(p, p.version) + '" onerror="this.style.visibility=\'hidden\'">'
      + '<div class="info"><span class="name">' + esc(p.name) + '</span>'
      + '<span class="sub">' + esc(p.champName || '') + (p.rank ? ' · ' + esc(p.rank) : '') + '</span></div>'
      + '<div class="kda"><b class="' + kda.cls + '">' + kda.main + '</b><span>' + esc(kda.sub) + tags + '</span></div>'
      + '</div>';
  }

  function render(d) {
    if (!teamsEl) return;
    const version = String(d.ddragonVersion || '');
    const players = (d.players || []).map(p => Object.assign({}, p, { version }));
    if (!players.length) {
      teamsEl.innerHTML = '<div class="state">正在读取本局数据…<br>(实时对局页拉到战绩后自动更新)</div>';
      return;
    }
    const team = (list, cls, label) => '<div class="team ' + cls + '">'
      + '<div class="team-head">' + label + '</div>'
      + '<div class="rows">' + (list.length ? list.map(playerRow).join('') : '<div class="state">--</div>') + '</div></div>';
    const blue = players.filter(p => p.team === 100);
    const red = players.filter(p => p.team === 200);
    teamsEl.innerHTML = team(blue, 't100', '蓝方') + team(red, 't200', '红方');
  }

  if (window.lolAPI && window.lolAPI.onGameLiveData) {
    lolAPI.onGameLiveData(d => { if (d) render(d); });
  }

  // ---------- 本局实时区块 (经济/对位/成装) ----------
  // 数据由主窗口 live-tips.js 每 4 秒推一次; 这里只做纯渲染。
  const boardEl = document.getElementById('board');
  const bTimeEl = document.getElementById('bTime');
  const bLeadEl = document.getElementById('bLead');
  const bGoldEl = document.getElementById('bGold');
  const bFillEl = document.getElementById('bFill');
  const bSubEl = document.getElementById('bSub');

  function fmtTime(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  // 与主窗口 live-metrics.js 的 formatGold 保持一致.
  // 浮窗是独立页面 (sandbox + CSP), 不复用主窗口模块, 所以这里保留一份小实现。
  function fmtGold(n) {
    const v = Math.round(Number(n) || 0);
    return Math.abs(v) < 1000 ? String(v) : (v / 1000).toFixed(1) + 'k';
  }

  function renderBoard(d) {
    if (!boardEl) return;
    if (!d || typeof d !== 'object') { boardEl.hidden = true; return; }
    boardEl.hidden = false;
    const lead = Math.max(-100, Math.min(100, Number(d.leadPct) || 0));
    if (bTimeEl) bTimeEl.textContent = fmtTime(d.gameTime);
    if (bLeadEl) {
      const cls = lead === 0 ? 'flat' : lead > 0 ? 'up' : 'down';
      bLeadEl.className = 'b-lead ' + cls;
      bLeadEl.textContent = lead === 0 ? '均势' : (lead > 0 ? '领先 ' : '落后 ') + Math.abs(lead) + '%';
    }
    if (bGoldEl) bGoldEl.textContent = fmtGold(d.allyValue) + ' : ' + fmtGold(d.enemyValue);
    if (bFillEl) {
      // 中点为均势基准, 条从中间向有利侧延伸; 最多占满半条轨道
      const half = Math.min(50, Math.abs(lead) / 100 * 50);
      bFillEl.style.width = half + '%';
      bFillEl.style.left = (lead >= 0 ? 50 : 50 - half) + '%';
      bFillEl.className = lead < 0 ? 'down' : 'up';
    }
    if (bSubEl) {
      const parts = [];
      const m = d.matchup;
      if (m && m.pos) {
        const diff = Number(m.diff) || 0;
        parts.push(m.pos + ' ' + (diff >= 0 ? '+' : '-') + fmtGold(Math.abs(diff)) + ' · 补刀 ' + m.selfCs + ':' + m.oppCs);
      }
      if (d.spike) parts.push(d.spike);
      bSubEl.textContent = parts.join('  ');
      bSubEl.style.display = parts.length ? '' : 'none';
    }
  }

  if (window.lolAPI && window.lolAPI.onGameLiveBoard) {
    lolAPI.onGameLiveBoard(d => renderBoard(d));
  }
})();
