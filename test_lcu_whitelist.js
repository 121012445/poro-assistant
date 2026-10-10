'use strict';
// ① 静态守卫: 渲染层调用的每个 LCU 路径都必须在主进程白名单 (LCU_PREFIXES) 内。
//    不在白名单的请求会被主进程直接返回 { __error: 'LCU 路径不在白名单内' }, 界面上只表现为"没反应"。
//    2026-10-10 用它查出 3 个: /lol-replays (回放观看整个不可用)、/lol-platform-config 与
//    /riotclient/region-locale (新账号的大区识别兜底从未生效)。
// ② 回放观看: 按 LCU lol-replays 接口的流程 (create → metadata → download/watch) 实际跑一遍。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const main = fs.readFileSync('main/index.js', 'utf8').replace(/\r\n/g, '\n');
const m = /const LCU_PREFIXES = \[([\s\S]*?)\];/.exec(main);
assert.ok(m, '应能在 main/index.js 找到 LCU_PREFIXES');
const prefixes = [...m[1].replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map(x => x[1]);
assert.ok(prefixes.length >= 20, '白名单解析结果异常: ' + prefixes.length);
const allowed = p => prefixes.some(pre => p.startsWith(pre));

// ---------- ① 渲染层的所有字面量路径 ----------
const files = fs.readdirSync('renderer/js').filter(f => f.endsWith('.js'));
const used = [];
for (const f of files) {
  const src = fs.readFileSync('renderer/js/' + f, 'utf8');
  const re = /lcuRequest\(\s*['"](GET|POST|PUT|DELETE|PATCH)['"]\s*,\s*[`'"](\/[^`'"$?]*)/g;
  let x;
  while ((x = re.exec(src))) used.push({ file: f, path: x[2] });
}
assert.ok(used.length >= 30, '应扫描到足够多的 LCU 调用, 实际 ' + used.length);
const missing = used.filter(u => !allowed(u.path));
assert.deepStrictEqual(missing.map(u => `${u.file}: ${u.path}`), [], '这些 LCU 路径不在主进程白名单内, 请求会被直接拒绝');
// 守卫自检: 一个不在白名单里的路径必须被判为不允许, 否则上面的检查形同虚设
assert.strictEqual(allowed('/lol-not-a-real-endpoint/v1/x'), false, '守卫自检失败');
assert.strictEqual(allowed('/riotclient/kill-and-restart-ux'), false, '/riotclient 只应放行 region-locale, 不能整个前缀放开');
console.log(`  白名单守卫: ${files.length} 个脚本 / ${used.length} 处 LCU 调用全部在白名单内`);

// ---------- ② 回放观看流程 ----------
const extra = fs.readFileSync('renderer/js/sona-extra.js', 'utf8');
const extraCode = extra.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');
assert.ok(!extraCode.includes('/lol-replays/v1/rocks'), '不存在的 /lol-replays/v1/rocks 接口应已不再调用');

function makeContext(lcu) {
  const msgs = [];
  const calls = [];
  const ctx = vm.createContext({
    console, Date, Number, String, Promise,
    setTimeout: fn => { ctx.__clock += 2000; fn(); },       // 轮询不真等, 但推进时钟
    document: { getElementById: id => (id === 'replayGameId' ? { value: ctx.__gameId } : null) },
    lolAPI: {
      lcuRequest: async (method, url, body) => { calls.push({ method, url, body }); return lcu(method, url, body, calls); },
      sgpGameSummary: async () => ({ json: { gameVersion: '16.19.1.1', gameType: 'MATCHED_GAME', queueId: 2400, gameEndTimestamp: 1791000000000 } })
    },
    toolMsg: h => msgs.push(String(h)),
    showToast: () => {}, storeGet: () => '', storeSet: () => {},
    guardWrite: () => true, escapeHtml: s => String(s), cachedPlatformId: 'HN1',
    isTencentPlatform: p => p === 'HN1', __gameId: '9876543210', __clock: 0
  });
  // 用可控时钟替换 Date.now, 让 90 秒超时可测
  vm.runInContext('Date = new Proxy(Date, { get: (t, k) => k === "now" ? () => __clock : Reflect.get(t, k) });', ctx);
  vm.runInContext(extra, ctx, { filename: 'sona-extra.js' });
  return { ctx, msgs, calls };
}
const lcuGame = { gameVersion: '16.19.1.1', gameType: 'MATCHED_GAME', queueId: 2400, gameCreation: 1790998800000, gameDuration: 1200 };

(async () => {
  // a) 需要先下载: download → downloading → watch
  {
    const states = ['checking', 'download', 'downloading', 'downloading', 'watch'];
    const { ctx, msgs, calls } = makeContext((method, url) => {
      if (url === '/lol-replays/v1/configuration') return { isReplaysEnabled: true, isPlayingGame: false };
      if (url.startsWith('/lol-match-history/v1/games/')) return lcuGame;
      if (url.endsWith('/create')) return null;
      if (url.startsWith('/lol-replays/v1/metadata/')) return { gameId: 9876543210, state: states.shift() || 'watch', downloadProgress: 40 };
      return null;
    });
    await ctx.watchReplay();
    const create = calls.find(c => c.url === '/lol-replays/v2/metadata/9876543210/create');
    assert.ok(create && create.method === 'POST', '应先创建回放元数据');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(create.body)), { gameVersion: '16.19.1.1', gameType: 'MATCHED_GAME', queueId: 2400, gameEnd: 1790998800000 + 1200 * 1000 },
      '元数据应来自这局的版本/类型/队列/结束时间');
    const downloads = calls.filter(c => c.url === '/lol-replays/v1/rofls/9876543210/download');
    assert.strictEqual(downloads.length, 1, '只请求一次下载');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(downloads[0].body)), { componentType: 'replay-button_match-history' });
    assert.ok(calls.some(c => c.method === 'POST' && c.url === '/lol-replays/v1/rofls/9876543210/watch'), '下载完成后应自动开始播放');
    assert.ok(msgs.some(t => t.includes('下载中 40%')), '应显示下载进度');
    assert.ok(msgs[msgs.length - 1].includes('正在启动回放'));
    assert.ok(calls.every(c => allowed(c.url)), '回放流程用到的接口都必须在白名单内');
  }
  // b) 本地已有回放: 直接播放, 不下载; LCU 查不到这局时用 SGP 摘要
  {
    const { ctx, calls } = makeContext((method, url) => {
      if (url === '/lol-replays/v1/configuration') return { isReplaysEnabled: true };
      if (url.startsWith('/lol-match-history/v1/games/')) return { __error: 'HTTP 404' };
      if (url.startsWith('/lol-replays/v1/metadata/')) return { state: 'watch' };
      return null;
    });
    await ctx.watchReplay();
    const create = calls.find(c => c.url.endsWith('/create'));
    assert.strictEqual(create.body.gameVersion, '16.19.1.1', 'LCU 查不到时应用 SGP 摘要里的版本');
    assert.strictEqual(create.body.gameEnd, 1791000000000);
    assert.ok(!calls.some(c => c.url.endsWith('/download')), '已有回放时不应再下载');
  }
  // c) 各种失败: 都要给出明确提示, 不能卡住
  const scenario = async (lcu, expect, label) => {
    const { ctx, msgs } = makeContext(lcu);
    await ctx.watchReplay();
    assert.ok(msgs.some(t => t.includes(expect)), `${label}: 应提示「${expect}」, 实际 ${JSON.stringify(msgs.slice(-2))}`);
    return ctx;
  };
  await scenario((m, u) => u === '/lol-replays/v1/configuration' ? { isReplaysEnabled: false } : null, '客户端当前不允许回放', '回放关闭');
  await scenario((m, u) => u === '/lol-replays/v1/configuration' ? { isReplaysEnabled: true, isPlayingGame: true } : null, '对局进行中', '对局中');
  await scenario((m, u) => u === '/lol-replays/v1/configuration' ? { __error: 'LCU 路径不在白名单内' } : null, '回放请求失败', '白名单拒绝');
  {
    const { ctx, msgs } = makeContext((m, u) => {
      if (u === '/lol-replays/v1/configuration') return { isReplaysEnabled: true };
      if (u.startsWith('/lol-match-history/v1/games/')) return { __error: 'HTTP 404' };
      return null;
    });
    ctx.lolAPI.sgpGameSummary = async () => ({ __error: 'x' });
    await ctx.watchReplay();
    assert.ok(msgs.some(t => t.includes('查不到这局对局的信息')), '查不到对局时应提示');
  }
  await scenario((m, u) => {
    if (u === '/lol-replays/v1/configuration') return { isReplaysEnabled: true };
    if (u.startsWith('/lol-match-history/v1/games/')) return lcuGame;
    if (u.startsWith('/lol-replays/v1/metadata/')) return { state: 'incompatible' };
    return null;
  }, '与当前游戏版本不兼容', '版本不兼容');
  // 一直 checking: 90 秒后放弃并提示, 不能无限轮询
  {
    let polls = 0;
    const { ctx, msgs } = makeContext((m, u) => {
      if (u === '/lol-replays/v1/configuration') return { isReplaysEnabled: true };
      if (u.startsWith('/lol-match-history/v1/games/')) return lcuGame;
      if (u.startsWith('/lol-replays/v1/metadata/')) {
        polls++;
        if (polls > 100) throw new Error('轮询失控');   // 超时逻辑失效时让测试失败, 而不是挂死
        return { state: 'checking' };
      }
      return null;
    });
    await ctx.watchReplay();
    assert.ok(polls <= 50, `应在超时后停止轮询 (实际 ${polls} 次)`);
    assert.ok(msgs[msgs.length - 1].includes('迟迟没有返回回放状态'), '超时应提示');
  }
  // 非法输入与重入
  {
    const { ctx, msgs, calls } = makeContext(() => null);
    ctx.__gameId = '12ab';
    await ctx.watchReplay();
    assert.ok(msgs[0].includes('纯数字'));
    assert.strictEqual(calls.length, 0, '非法 Game ID 不应发请求');
  }
  console.log('LCU 白名单守卫与回放流程测试通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
