// 背景原画开关: 只有真正验证过"关得掉 / 打得开"才算数。
// 这条链路踩过两个坑:
//   1) storeSet 一律 String(v), 读回来是 "false", 而 enabled() 用 !!v 判断 → 永远为真
//   2) toggle() 用自己刚摘掉的 splash-page class 反推当前页 → 关掉后再点开不回来
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, 'renderer/js/home-splash.js'), 'utf8');

function boot(initial) {
  const store = Object.assign({}, initial);
  const classes = new Set();
  const cssVars = {};
  const active = { id: 'page-home' };
  const body = {
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      contains: c => classes.has(c),
      toggle: (c, on) => {
        if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
        else if (on) classes.add(c); else classes.delete(c);
      }
    },
    style: { setProperty: (k, v) => { cssVars[k] = v; } }
  };
  const sandbox = {
    module: { exports: {} },
    console,
    document: {
      body,
      querySelector: sel => (sel === '.page.active' ? active : null)
    },
    storeGet: k => (store[k] !== undefined ? store[k] : null),
    // 与 persist.js 一致: 存进去的永远是字符串
    storeSet: (k, v) => { store[k] = String(v); },
    champNumMap: { 103: { id: 'Ahri' }, 222: { id: 'Jinx' } },
    splashUrl: (key, skin) => 'https://cdn/' + key + '_' + skin + '.jpg'
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'home-splash.js' });
  const api = sandbox.window.PoroSplash || sandbox.module.exports;
  return { api, store, classes, cssVars, active };
}

// ---------- enabled(): 字符串必须按字面解析 ----------
{
  const { api } = boot({});
  assert.strictEqual(api.enabled(), true, '没有任何记录时默认开启');
}
{
  const { api, store } = boot({ splashBg: 'false' });
  assert.strictEqual(api.enabled(), false, '落盘 "false" 必须判为关闭 (旧实现 !!"false" === true)');
  assert.strictEqual(store.splashBg, 'false');
}
{
  const { api } = boot({ splashBg: 'true' });
  assert.strictEqual(api.enabled(), true);
}
{
  const { api } = boot({ splashBg: '' });
  assert.strictEqual(api.enabled(), true, '空串视作未设置');
}
{
  const { api } = boot({ splashBg: '0' });
  assert.strictEqual(api.enabled(), false, '"0" 也是关闭');
}
{
  const { api } = boot({ splashBg: false });
  assert.strictEqual(api.enabled(), false, '布尔 false 也要认');
}

// ---------- 开 → 关 → 开 的完整往返 ----------
{
  const { api, classes, store, cssVars } = boot({});
  // 数据到齐, 首页挂背景
  api.applyFromGames([{ participants: [{ puuid: 'me', championId: 103 }] }], 'me');
  assert.ok(classes.has('splash-on'), '数据到齐后应有 splash-on');
  assert.ok(classes.has('splash-page'), '首页应挂 splash-page');
  assert.ok(String(cssVars['--poro-splash'] || '').includes('Ahri_0.jpg'), '背景变量应指向自己最近一局英雄');

  // 第一次点: 关
  const off = api.toggle();
  assert.strictEqual(off, false, '第一次点击应返回 false');
  assert.strictEqual(store.splashBg, 'false', '关闭状态要落盘');
  assert.ok(!classes.has('splash-on'), '关闭后 splash-on 必须摘掉');
  assert.ok(!classes.has('splash-page'), '关闭后 splash-page 必须摘掉');

  // 第二次点: 开 (旧实现在这里失效, 因为 splash-page 已被摘掉)
  const on = api.toggle();
  assert.strictEqual(on, true, '第二次点击应返回 true');
  assert.strictEqual(store.splashBg, 'true');
  assert.ok(classes.has('splash-on'), '再打开要恢复 splash-on');
  assert.ok(classes.has('splash-page'), '再打开要恢复 splash-page');

  // 第三次点又关, 保证状态机可重复
  assert.strictEqual(api.toggle(), false);
  assert.ok(!classes.has('splash-on'));
}

// ---------- 非白名单页面不加背景 ----------
{
  const { api, classes, active } = boot({});
  api.applyFromGames([{ participants: [{ puuid: 'me', championId: 222 }] }], 'me');
  active.id = 'page-live';
  api.onPage('live');
  assert.ok(!classes.has('splash-page'), '实时对局页不挂背景');
  active.id = 'page-profile';
  api.onPage('profile');
  assert.ok(classes.has('splash-page'), '我的画像页要挂背景');
}

// ---------- 没有图片时也不能留着旧的开关状态 ----------
{
  const { api, classes } = boot({ splashBg: 'false' });
  api.apply(0);   // 没有英雄/没有 URL
  assert.ok(!classes.has('splash-on'), '没图且开关关闭时, 不能残留 splash-on');
}

// ---------- pickChampion: 只认"我"那一行 ----------
{
  const { api } = boot({});
  const games = [
    { participants: [{ puuid: 'other', championId: 222 }, { puuid: 'me', championId: 103 }] },
    { participants: [{ puuid: 'me', championId: 222 }] }
  ];
  assert.strictEqual(api.pickChampion(games, 'me'), 103, '取我最近一局, 不能拿别人的英雄');
  assert.strictEqual(api.pickChampion(games, 'nobody'), 0, 'puuid 匹配不上就返回 0, 不猜');
  assert.strictEqual(api.pickChampion([], 'me'), 0);
  assert.strictEqual(api.pickChampion(null, 'me'), 0);
}

// ---------- 接线检查: 启动时要同步按钮外观 ----------
{
  const app = fs.readFileSync(path.join(__dirname, 'renderer/js/app.js'), 'utf8');
  assert.ok(app.includes('function syncSplashToggleBtn'), '缺少启动时同步按钮状态的函数');
  assert.ok(/loadConfig\(\);\s*\n\s*if \(typeof syncSplashToggleBtn === 'function'\) syncSplashToggleBtn\(\);/.test(app),
    'loadConfig 之后必须同步一次按钮状态, 否则重启后按钮外观与实际设置相反');
  const html = fs.readFileSync(path.join(__dirname, 'renderer/index.html'), 'utf8');
  assert.ok(html.includes('id="splashToggleBtn"'), '按钮要在页面上');
}

console.log('test_home_splash: OK');
