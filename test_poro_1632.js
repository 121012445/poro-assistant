'use strict';
// 1.6.32 三个新模块的纯函数测试：挑战徽章 / 好友面板 / 背景原画。
// 全部用假数据与假 DOM —— 不连 LCU、不联网。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const champNumMap = { 103: { id: 'Ahri', name: '阿狸' }, 81: { id: 'Ezreal', name: '伊泽瑞尔' } };
const allChampions = { Ahri: { tags: ['Mage'], info: { attack: 3, magic: 9 } }, Ezreal: { tags: ['Marksman'], info: { attack: 8, magic: 3 } } };

function fakeBody() {
  const set = new Set();
  const styleMap = {};
  return {
    style: { setProperty(k, v) { styleMap[k] = v; }, getPropertyValue(k) { return styleMap[k] || ''; } },
    classList: {
      add(c) { set.add(c); }, remove(c) { set.delete(c); },
      contains(c) { return set.has(c); },
      toggle(c, on) { if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else if (on) set.add(c); else set.delete(c); }
    },
    _classes: set,
    _style: styleMap
  };
}

function loadModule(file, extra) {
  const body = fakeBody();
  const win = {};
  const sandbox = Object.assign({
    console, Date, Math, Number, String, Array, Object, Set, Map, Promise, JSON,
    escapeHtml, champNumMap, allChampions,
    document: { body, getElementById: () => null, querySelector: () => null, createElement: () => ({ style: {} }) },
    splashUrl: (key, n) => 'https://cdn/splash/' + key + '_' + n + '.jpg',
    storeGet: () => undefined,
    storeSet: () => {},
    window: win
  }, extra || {});
  // preload 把 lolAPI 挂在 window 上, 模块里取的是 GLOB.lolAPI -> 两边都要给
  if (extra && extra.lolAPI) win.lolAPI = extra.lolAPI;
  vm.runInContext(read(file), vm.createContext(sandbox), { filename: file });
  return { win, sandbox, body };
}

// ============ 挑战徽章 ============
{
  const { win } = loadModule('renderer/js/challenge-badge.js');
  const api = win.PoroChallenge;
  assert.ok(api, '应挂到 window.PoroChallenge');

  assert.strictEqual(api.parse({ overallChallengeLevel: 7, overallChallengePoints: 7285 }).level, 7);
  assert.strictEqual(api.parse({ overallChallengeLevel: 7, overallChallengePoints: 7285 }).points, 7285);
  // 不同版本的字段名
  assert.strictEqual(api.parse({ challengeLevel: 3, challengePoints: 1200 }).points, 1200);
  assert.strictEqual(api.parse({ totalPoints: 900 }).points, 900);
  // 取不到就 null，不编 0
  assert.strictEqual(api.parse(null), null);
  assert.strictEqual(api.parse({ __error: 'LCU 路径不在白名单内' }), null);
  assert.strictEqual(api.parse({ overallChallengeLevel: 0, overallChallengePoints: 0 }), null);
  assert.strictEqual(api.parse({}), null);

  assert.strictEqual(api.fmtPoints(7285), '7.3k');
  assert.strictEqual(api.fmtPoints(12000), '12k');
  assert.strictEqual(api.fmtPoints(950), '950');

  assert.strictEqual(api.tierClass(8), 'chg-hi');
  assert.strictEqual(api.tierClass(5), 'chg-mid');
  assert.strictEqual(api.tierClass(3), 'chg-low');
  assert.strictEqual(api.tierClass(0), 'chg-base');

  const h = api.html({ level: 7, points: 7285 });
  assert.ok(h.includes('◆7.3k'), '徽章显示积分缩写');
  assert.ok(h.includes('挑战等级 7'), 'tooltip 要说清等级');
  assert.ok(h.includes('chg-hi'));
  assert.ok(!h.includes('undefined'));
  assert.strictEqual(api.html(null), '', '没有数据就不出徽章');

  // 缓存：TTL 内不重复请求
  let calls = 0;
  const fake = loadModule('renderer/js/challenge-badge.js', {
    lolAPI: { lcuRequest: async () => { calls++; return { overallChallengeLevel: 4, overallChallengePoints: 1500 }; } }
  });
  (async () => {
    const a = await fake.win.PoroChallenge.load();
    const b = await fake.win.PoroChallenge.load();
    assert.strictEqual(a.points, 1500);
    assert.strictEqual(calls, 1, '半小时内只请求一次');
    assert.strictEqual(b.points, 1500);
    await fake.win.PoroChallenge.load(true);
    assert.strictEqual(calls, 2, 'force 会重新请求');

    // ============ 好友面板 ============
    const f = loadModule('renderer/js/friends-panel.js').win.PoroFriends;
    assert.ok(f, '应挂到 window.PoroFriends');

    assert.strictEqual(f.queueName('RANKED_SOLO_5x5'), '单双排');
    assert.strictEqual(f.queueName('aram'), '大乱斗');
    assert.strictEqual(f.queueName('WEIRD_MODE'), 'WEIRD_MODE', '未知队列原样返回，不猜');
    assert.strictEqual(f.queueName(''), '');

    const now = 1_700_000_000_000;
    assert.strictEqual(f.minutesSince(now - 5 * 60000, now), 5);
    assert.strictEqual(f.minutesSince(0, now), null, '没有时间戳就 null');
    assert.strictEqual(f.minutesSince(now + 60000, now), null, '未来时间戳当异常');

    const ingame = f.rowOf({ puuid: 'p1', gameName: 'A', gameTag: '123', availability: 'chat',
      lol: { gameStatus: 'inGame', gameQueueType: 'RANKED_SOLO_5x5', timeStamp: now - 12 * 60000, spectatorKey: 'KEY' } }, now);
    assert.strictEqual(ingame.bucket, 'ingame');
    assert.strictEqual(ingame.queue, '单双排');
    assert.strictEqual(ingame.since, 12);
    assert.strictEqual(ingame.canSpectate, true);
    assert.strictEqual(ingame.tagLine, '#123');

    const noKey = f.rowOf({ gameName: 'B', lol: { gameStatus: 'inGame', spectatorKey: '' } }, now);
    assert.strictEqual(noKey.canSpectate, false, '没有观战密钥就不能旁观');

    assert.strictEqual(f.rowOf({ gameName: 'C', availability: 'dnd', lol: {} }, now).bucket, 'away');
    assert.strictEqual(f.rowOf({ gameName: 'D', availability: 'offline', lol: {} }, now).bucket, 'offline');
    assert.strictEqual(f.rowOf({ gameName: 'E', availability: 'chat', lol: { gameStatus: 'outOfGame' } }, now).bucket, 'online');
    assert.strictEqual(f.rowOf({ lol: {} }, now), null, '没名字的人不画');

    const rows = f.normalize([
      { puuid: 'a', gameName: '新人', lol: { gameStatus: 'inGame', timeStamp: now - 60000, spectatorKey: 'K' } },
      { puuid: 'b', gameName: '老人', lol: { gameStatus: 'inGame', timeStamp: now - 20 * 60000, spectatorKey: 'K' } },
      { puuid: 'a', gameName: '新人', lol: {} },   // 重复 puuid
      { puuid: 'c', gameName: '在线的', availability: 'chat', lol: {} }
    ], { now });
    assert.strictEqual(rows.length, 3, '重复 puuid 只留一条');
    assert.strictEqual(rows[0].name, '老人', '游戏中的按已开始时间长的排前面');

    const g = f.group(rows);
    assert.strictEqual(g.length, 2, '只输出有人的分组');
    assert.strictEqual(g[0].key, 'ingame');
    assert.strictEqual(g[0].rows.length, 2);

    const st = f.stats(rows);
    assert.strictEqual(st.total, 3);
    assert.strictEqual(st.ingame, 2);

    const html = f.html(rows, { spectate: id => "spectateFriendByPuuid('" + id + "')" });
    assert.ok(html.includes('老人') && html.includes('新人') && html.includes('在线的'));
    assert.ok(html.includes('旁观'), '可旁观的人要有按钮');
    assert.strictEqual((html.match(/旁观<\/button>/g) || []).length, 2, '只有 2 个有密钥的人能旁观');
    assert.ok(html.includes('fr-ingame'), '游戏中的行要有单独样式钩子');
    assert.ok(html.includes('共 3 人'), '要给出总数');
    assert.ok(f.html([]).includes('好友列表是空的'));
    // 注入防护
    const evil = f.html([{ puuid: 'x', name: '<img onerror=1>', bucket: 'online', tagLine: '', queue: '', since: null, championId: 0, canSpectate: false }], {});
    assert.ok(!evil.includes('<img onerror'), '名字必须转义');

    // ============ 背景原画 ============
    const { win: sw, sandbox: sc, body } = loadModule('renderer/js/home-splash.js');
    const sp = sw.PoroSplash;
    assert.ok(sp, '应挂到 window.PoroSplash');
    assert.strictEqual(sp.keyOf(103), 'Ahri');
    assert.strictEqual(sp.keyOf(9999), '');
    assert.strictEqual(sp.urlOf(103), 'https://cdn/splash/Ahri_0.jpg');

    const games = [
      { participants: [{ puuid: 'other', championId: 81 }, { puuid: 'me', championId: 103 }] },
      { participants: [{ puuid: 'me', championId: 81 }] }
    ];
    assert.strictEqual(sp.pickChampion(games, 'me'), 103, '取最近一局里我用的英雄');
    assert.strictEqual(sp.pickChampion([], 'me'), 0);
    assert.strictEqual(sp.pickChampion(games, 'nobody'), 0, '找不到自己就不给背景（不拿别人的英雄顶）');

    assert.strictEqual(sp.enabled(), true, '默认开启');
    assert.strictEqual(sp.applyFromGames(games, 'me'), 103);
    assert.ok(body._style['--poro-splash'].indexOf('Ahri_0.jpg') > 0, '要写进 CSS 变量');
    assert.ok(body._classes.has('splash-on'), '开启时挂 splash-on');

    sp.onPage('home');
    assert.ok(body._classes.has('splash-page'), '首页要有 splash-page');
    sp.onPage('growth');
    assert.ok(!body._classes.has('splash-page'), '成长页不该有背景');

    // 关掉
    let saved;
    let stored = true;    // 假的设置存储: setEnabled 写进去之后 enabled 要能读到
    Object.assign(sc, { storeSet: (k, v) => { saved = { k, v }; stored = v; }, storeGet: () => stored });
    assert.strictEqual(sp.enabled(), true, "默认仍是开");
    sp.setEnabled(false);
    assert.strictEqual(sp.enabled(), false, 'storeGet 返回 false 就是关');
    sp.apply(103);
    assert.ok(!body._classes.has('splash-on'), '关了就不挂 splash-on');
    assert.strictEqual(sp.setEnabled(true), true);
    assert.deepStrictEqual(saved && saved.k, 'splashBg', '开关写进本机设置');
    assert.ok(body._classes.has('splash-on'));

    console.log('1.6.32 挑战徽章 / 好友面板 / 背景原画 测试通过');
  })().catch(e => { console.error('FAIL', e.message); process.exit(1); });
}
