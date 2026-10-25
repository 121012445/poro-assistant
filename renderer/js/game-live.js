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
})();
