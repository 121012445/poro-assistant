// 好友面板：把 LCU 好友列表按「游戏中 / 在线 / 离开 / 离线」分层，游戏中的那一行
// 直接给出模式、已开始多久、以及一个旁观按钮。
//
// 数据: GET /lol-chat/v1/friends（只读）。字段名各版本略有差异，一律"取得到才显示":
//   f.gameName / f.gameTag / f.puuid / f.availability
//   f.lol.gameStatus ('inGame' 等) / gameMode / gameQueueType / timeStamp / spectatorKey
//   f.lol.championId —— 不是每个版本都有, 没有就不显示英雄, 不猜。
//
// 旁观走的是 social.js 已经验过的链路（国服 /lol-spectator 查询接口全 404,
// 只有 /lol-chat/v1/friends 里的 spectatorKey 能用）。这里只复用, 不重写。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  if (typeof window !== 'undefined') window.PoroFriends = api; else if (root) root.PoroFriends = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // factory 与 IIFE 的参数不在同一作用域: 全局对象要自己取一次
  const GLOB = (typeof window !== 'undefined') ? window : (typeof global !== 'undefined' ? global : {});

  // LCU 的 gameQueueType 是 QUEUE 枚举或短码, 两种都给一个中文名
  const QUEUE_CN = {
    RANKED_SOLO_5x5: '单双排', RANKED_FLEX_SR: '灵活组排', RANKED_FLEX_TT: '3v3',
    NORMAL: '匹配', DRAFT: '征召', CLASSIC: '经典', ARAM: '大乱斗',
    ARAM_UNRATED: '大乱斗', URF: '无限火力', ONE_FOR_ALL: '克隆', CHERRY: '斗魂竞技场',
    ARENA: '斗魂竞技场', TFT: '云顶', PRACTICETOOL: '训练', CUSTOM: '自定义',
    RANKED_TFT: '云顶排位', BOT: '人机', URF_BOT: '人机', NEXUS_BLITZ: '极地大乱斗'
  };
  // 模式名偶发是 CLASSIC/ARAM 这种, 复用队列表即可
  const GROUP_ORDER = [
    { key: 'ingame', label: '游戏中' },
    { key: 'online', label: '在线' },
    { key: 'away', label: '离开 / 请勿打扰' },
    { key: 'offline', label: '离线' }
  ];

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s)) : String(s));
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  // LCU 的队列枚举是 RANKED_SOLO_5x5 这种大小写混排, 直接 toUpperCase 查表会查不到,
  // 所以表本身按大写索引建一份。
  const QUEUE_LOOKUP = {};
  for (const k of Object.keys(QUEUE_CN)) QUEUE_LOOKUP[k.toUpperCase()] = QUEUE_CN[k];

  function queueName(raw) {
    const s = raw ? String(raw) : '';
    if (!s) return '';
    return QUEUE_LOOKUP[s.toUpperCase()] || s;
  }

  function minutesSince(ts, now) {
    const t = num(ts);
    if (!t) return null;
    const ms = (now || Date.now()) - t;
    if (ms < 0 || ms > 24 * 3600 * 1000) return null;   // 时间戳异常就干脆不显示
    return Math.floor(ms / 60000);
  }

  // 一个好友 → 一行。所有判断都基于客户端给的字段, 不补默认值。
  function rowOf(f, now) {
    if (!f || typeof f !== 'object') return null;
    const lol = f.lol && typeof f.lol === 'object' ? f.lol : {};
    const name = String(f.gameName || f.name || f.displayName || '').trim();
    if (!name) return null;
    const status = String(lol.gameStatus || '').toLowerCase();
    const avail = String(f.availability || '').toLowerCase();
    const ingame = status === 'ingame';
    let bucket = 'offline';
    if (ingame) bucket = 'ingame';
    else if (avail === 'dnd' || avail === 'away') bucket = 'away';
    else if (avail === 'offline' || avail === '') bucket = 'offline';
    else bucket = 'online';
    return {
      puuid: f.puuid || '',
      name,
      tagLine: f.gameTag ? '#' + f.gameTag : '',
      bucket,
      availability: avail,
      status,
      queue: queueName(lol.gameQueueType || lol.gameMode),
      mode: String(lol.gameMode || ''),
      since: minutesSince(lol.timeStamp, now),
      championId: num(lol.championId) || 0,
      canSpectate: !!(ingame && lol.spectatorKey),
      spectatorKey: lol.spectatorKey || ''
    };
  }

  function normalize(list, opts) {
    const now = (opts && opts.now) || Date.now();
    const rows = [];
    const seen = new Set();
    for (const f of (Array.isArray(list) ? list : [])) {
      const r = rowOf(f, now);
      if (!r) continue;
      const key = r.puuid || (r.name + r.tagLine);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
    }
    // 游戏中按已开始时间长的排前面（更容易接入观战）; 其余按名字
    rows.sort((a, b) => {
      if (a.bucket !== b.bucket) return 0;
      if (a.bucket === 'ingame') {
        const d = (b.since == null ? -1 : b.since) - (a.since == null ? -1 : a.since);
        if (d) return d;
      }
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
    return rows;
  }

  function group(rows) {
    return GROUP_ORDER.map(g => ({
      key: g.key,
      label: g.label,
      rows: (rows || []).filter(r => r.bucket === g.key)
    })).filter(g => g.rows.length);
  }

  function stats(rows) {
    const out = { total: rows.length, ingame: 0, spectatable: 0 };
    for (const r of rows) {
      if (r.bucket === 'ingame') out.ingame++;
      if (r.canSpectate) out.spectatable++;
    }
    return out;
  }

  function sinceText(min) {
    if (min == null) return '';
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟';
    return Math.floor(min / 60) + ' 小时 ' + (min % 60) + ' 分';
  }

  // 自己那张卡上的"我"不会有旁观按钮
  function rowHtml(r, opts) {
    const o = opts || {};
    const bits = [];
    if (r.bucket === 'ingame') {
      if (r.queue) bits.push(esc(r.queue));
      const s = sinceText(r.since);
      if (s) bits.push('状态 ' + esc(s));
    } else if (r.bucket === 'away') {
      bits.push(r.availability === 'dnd' ? '请勿打扰' : '离开');
    }
    const champ = r.championId && typeof o.champImg === 'function' ? o.champImg(r.championId) : '';
    const btn = (r.canSpectate && typeof o.spectate === 'function')
      ? '<button class="fr-btn" type="button" onclick="' + o.spectate + '">旁观</button>'
      : '';
    return '<div class="fr-row fr-' + r.bucket + '">'
      + (champ ? '<img class="fr-champ" src="' + esc(champ) + '" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'">' : '<span class="fr-dot"></span>')
      + '<div class="fr-body"><div class="fr-name">' + esc(r.name)
      + (r.tagLine ? '<i>' + esc(r.tagLine) + '</i>' : '') + '</div>'
      + (bits.length ? '<div class="fr-meta">' + bits.join(' · ') + '</div>' : '') + '</div>'
      + btn + '</div>';
  }

  function html(rows, opts) {
    const o = opts || {};
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      return '<div class="fr-panel"><div class="fr-empty">好友列表是空的，或者客户端还没连上。</div>'
        + '<div class="fr-note">只读 /lol-chat/v1/friends，不改任何状态；国服只对有观战密钥的好友显示「旁观」。</div></div>';
    }
    const s = stats(list);
    const groups = group(list).map(g => '<div class="fr-group">'
      + '<div class="fr-group-title">' + esc(g.label) + '<i>' + g.rows.length + '</i></div>'
      + g.rows.map(r => rowHtml(r, o)).join('')
      + '</div>').join('');
    return '<div class="fr-panel">'
      + '<div class="fr-head"><b>好友</b><span>共 ' + s.total + ' 人 · 游戏中 ' + s.ingame
      + (s.spectatable ? ' · 可旁观 ' + s.spectatable : '') + '</span>'
      + '<button class="fr-refresh" type="button" onclick="PoroFriends.refresh()">刷新</button></div>'
      + groups
      + '<div class="fr-note">状态时间来自客户端，是「状态更新至今」而不是精确开局时长；'
      + '英雄图标只有客户端返回了 championId 才显示。只读列表，不入库。</div>'
      + '</div>';
  }

  const OFFLINE_HTML = '<div class="fr-panel"><div class="fr-empty">好友列表是空的，或者客户端还没连上。</div></div>';
  let _last = [];
  let _loading = null;

  async function fetchList() {
    const lcu = GLOB.lolAPI;
    if (!lcu || typeof lcu.lcuRequest !== 'function') return null;
    try {
      const r = await lcu.lcuRequest('GET', '/lol-chat/v1/friends');
      if (!Array.isArray(r)) return null;
      return normalize(r);
    } catch (e) { return null; }
  }

  async function refresh(force) {
    const host = document.getElementById('friendsPanel');
    if (!host) return _last;
    if (_loading && !force) return _loading;
    host.innerHTML = '<div class="fr-panel"><div class="fr-empty">正在读取好友列表…</div></div>';
    _loading = (async () => {
      const rows = await fetchList();
      _last = rows || [];
      host.innerHTML = rows === null
        ? '<div class="fr-panel"><div class="fr-empty">读不到好友列表：客户端未连接，或该大区不提供这个接口。</div>'
          + '<div class="fr-note">这个面板只读，不会改任何状态。</div></div>'
        : html(_last, {
          champImg: id => (typeof champImg === 'function' ? champImg(id) : ''),
          spectate: id => "PoroFriends.spectate(this, '" + String(id).replace(/'/g, '') + "')"
        });
      _loading = null;
      return _last;
    })();
    return _loading;
  }

  // 旁观：复用 social.js 的凭证提取与占用检查（国服只能观好友且需要 spectatorKey）
  async function spectate(btn, puuid) {
    const lcu = GLOB.lolAPI;
    const say = (text, bad) => {
      if (btn && btn.parentNode) {
        const tip = document.createElement('span');
        tip.className = 'fr-tip' + (bad ? ' fr-tip-bad' : '');
        tip.textContent = text;
        btn.parentNode.appendChild(tip);
        setTimeout(() => { try { tip.remove(); } catch (e) {} }, 6000);
      }
    };
    if (!lcu) { say('客户端没连上', true); return { ok: false }; }
    try {
      const friends = await lcu.lcuRequest('GET', '/lol-chat/v1/friends');
      const info = (typeof spectateFriendInfo === 'function') ? spectateFriendInfo(friends, puuid) : null;
      if (!info) { say('好友列表里找不到这个人', true); return { ok: false }; }
      if (info.gameStatus !== 'inGame') { say('TA 已经不在对局里了', true); return { ok: false }; }
      if (!info.spectatorKey) { say('没有观战密钥（开局几分钟后才开放）', true); return { ok: false }; }
      if (typeof spectateEnsureIdle === 'function') {
        const idle = await spectateEnsureIdle();
        if (!idle || !idle.ok) { say('客户端正忙，已取消', true); return { ok: false }; }
      }
      const r = await lcu.lcuRequest('POST', '/lol-gameflow/v2/spectate/launch', {
        gameId: info.gameId, platformId: info.platformId, spectatorKey: info.spectatorKey,
        puuid: info.puuid, gameQueueType: info.gameQueueType,
        allowObserveMode: 'false', dropInSpectateGameId: ''
      });
      if (r && (r.__error || r.errorCode)) {
        say((r.message || r.__error || '启动失败').replace(/^Failed to set launch spectator mode: /, ''), true);
        return { ok: false };
      }
      say('正在启动观战…');
      return { ok: true };
    } catch (e) {
      say(e.message || '观战失败', true);
      return { ok: false, error: e.message };
    }
  }

  return { QUEUE_CN, GROUP_ORDER, queueName, minutesSince, rowOf, normalize, group, stats, html, refresh, spectate, OFFLINE_HTML };
});
