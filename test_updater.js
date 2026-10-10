'use strict';
// main/updater.js: 版本比较、安装包挑选、下载校验、安装; 以及 update.js 的界面状态机和主进程接线。
// 下载用模拟的响应流 (EventEmitter), 不联网。
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { createUpdater, compareVersions, pickAsset, isAllowedDownloadUrl } = require('./main/updater');

const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

// ---------- 1) 版本比较 ----------
assert.strictEqual(compareVersions('1.5.6', '1.5.5'), 1);
assert.strictEqual(compareVersions('1.5.5', '1.5.5'), 0);
assert.strictEqual(compareVersions('1.5.4', '1.5.5'), -1);
assert.strictEqual(compareVersions('1.5.10', '1.5.9'), 1, '按数字而不是字符串比较');
assert.strictEqual(compareVersions('1.10.0', '1.9.9'), 1);
assert.strictEqual(compareVersions('v2.0', '1.9.9'), 1, '允许 v 前缀与缺位');
assert.strictEqual(compareVersions('1.5', '1.5.0'), 0);
assert.strictEqual(compareVersions('1.6.0-beta', '1.6.0'), -1, '预发布低于正式版');
assert.strictEqual(compareVersions('abc', '1.0.0'), 0, '无法解析时不判定为更新');

// ---------- 2) 挑选安装包 ----------
const good = { name: 'Poro-Setup-1.5.6.exe', size: 1000, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: 'https://github.com/121012445/poro-assistant/releases/download/v1.5.6/Poro-Setup-1.5.6.exe' };
const lim = { name: 'Poro-Setup-1.5.6-limited.exe', size: 900, digest: 'sha256:' + 'b'.repeat(64), browser_download_url: 'https://github.com/121012445/poro-assistant/releases/download/v1.5.6/Poro-Setup-1.5.6-limited.exe' };
assert.strictEqual(pickAsset([lim, good], '1.5.6', 'full').name, 'Poro-Setup-1.5.6.exe', '正式版挑正式包');
assert.strictEqual(pickAsset([good, lim], '1.5.6', 'limited').name, 'Poro-Setup-1.5.6-limited.exe', '受限版挑受限包');
assert.strictEqual(pickAsset([lim], '1.5.6', 'full'), null, '没有对应版本的包不能退而求其次');
assert.strictEqual(pickAsset([Object.assign({}, good, { name: 'Poro-Setup-1.5.7.exe' })], '1.5.6', 'full'), null, '文件名必须严格匹配版本');
assert.strictEqual(pickAsset([Object.assign({}, good, { name: '../Poro-Setup-1.5.6.exe' })], '1.5.6', 'full'), null);
assert.strictEqual(pickAsset([Object.assign({}, good, { size: 0 })], '1.5.6', 'full'), null);
assert.strictEqual(pickAsset([Object.assign({}, good, { size: 10 * 1024 * 1024 * 1024 })], '1.5.6', 'full'), null, '过大的文件拒绝');
assert.strictEqual(pickAsset([Object.assign({}, good, { browser_download_url: 'http://github.com/x.exe' })], '1.5.6', 'full'), null, '必须 https');
assert.strictEqual(pickAsset([Object.assign({}, good, { browser_download_url: 'https://evil.example.com/Poro-Setup-1.5.6.exe' })], '1.5.6', 'full'), null, '下载域名必须是 GitHub');
assert.strictEqual(pickAsset([Object.assign({}, good, { browser_download_url: 'https://github.com.evil.com/x.exe' })], '1.5.6', 'full'), null, '不能被相似域名骗过');
assert.strictEqual(pickAsset([Object.assign({}, good, { digest: '' })], '1.5.6', 'full').sha256, '', '没有摘要时仍可识别, 但 installable 会是 false');
assert.strictEqual(pickAsset(null, '1.5.6', 'full'), null);
for (const [u, ok] of [['https://github.com/a/b', true], ['https://objects.githubusercontent.com/x', true], ['https://release-assets.githubusercontent.com/x', true],
  ['http://github.com/a', false], ['https://githubusercontent.com.evil.com/x', false], ['https://evilgithub.com/x', false], ['ftp://github.com/x', false], ['not a url', false]]) {
  assert.strictEqual(isAllowedDownloadUrl(u), ok, u);
}

// ---------- 3) 检查 ----------
const release = (o = {}) => Object.assign({ tag_name: 'v1.5.6', body: '## 更新\n- 新增功能', published_at: '2026-10-11T00:00:00Z', assets: [good, lim] }, o);
function makeUpdater(o = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poro-upd-'));
  const events = { spawned: [], quit: 0, requests: [] };
  const upd = createUpdater({
    getJson: async (host, p) => { events.requests.push(host + p); return o.release === undefined ? release() : o.release; },
    httpsGet: async (url, headers) => { events.requests.push(url); return o.httpsGet(url, headers); },
    currentVersion: () => o.current || '1.5.5',
    edition: () => o.edition || 'full',
    tmpDir: () => tmp,
    spawnInstaller: f => events.spawned.push(f),
    quit: () => { events.quit++; },
    now: () => 123
  });
  return { upd, events, tmp };
}
function stream(buf, { status = 200, headers = {}, chunk = 7 } = {}) {
  const res = new EventEmitter();
  res.statusCode = status; res.headers = headers; res.resume = () => {}; res.pause = () => {}; res.destroy = () => { res.destroyed = true; };
  process.nextTick(() => {
    for (let i = 0; i < buf.length && !res.destroyed; i += chunk) res.emit('data', buf.subarray(i, i + chunk));
    if (!res.destroyed) res.emit('end');
  });
  return res;
}

(async () => {
  {
    const { upd, events } = makeUpdater();
    const info = await upd.check();
    assert.strictEqual(events.requests[0], 'api.github.com/repos/121012445/poro-assistant/releases/latest');
    assert.strictEqual(info.available, true);
    assert.strictEqual(info.version, '1.5.6');
    assert.strictEqual(info.current, '1.5.5');
    assert.strictEqual(info.installable, true);
    assert.strictEqual(info.assetName, 'Poro-Setup-1.5.6.exe');
    assert.strictEqual(info.assetSize, 1000);
    assert.ok(!('asset' in info), '下载地址与摘要不应交给渲染层');
    assert.strictEqual(info.pageUrl, 'https://github.com/121012445/poro-assistant/releases/tag/v1.5.6');
  }
  {
    const info = await makeUpdater({ current: '1.5.6' }).upd.check();
    assert.strictEqual(info.available, false, '版本相同不算更新');
    assert.strictEqual(info.installable, false);
    assert.strictEqual((await makeUpdater({ current: '1.6.0' }).upd.check()).available, false, '本地更新时不降级');
    assert.strictEqual((await makeUpdater({ edition: 'limited' }).upd.check()).assetName, 'Poro-Setup-1.5.6-limited.exe');
    assert.strictEqual((await makeUpdater({ release: release({ assets: [Object.assign({}, good, { digest: '' })] }) }).upd.check()).installable, false, '没有 sha256 摘要的包不自动安装');
    assert.strictEqual((await makeUpdater({ release: release({ assets: [] }) }).upd.check()).installable, false);
    for (const bad of [null, {}, { tag_name: 'latest' }, { tag_name: 'v1.5.6; rm -rf' }]) {
      await assert.rejects(makeUpdater({ release: bad }).upd.check(), /发布信息无效|Cannot read/, JSON.stringify(bad));
    }
    assert.ok((await makeUpdater({ release: release({ body: 'x'.repeat(10000) }) }).upd.check()).notes.length <= 4000, '更新说明限长');
  }

  // ---------- 4) 下载 + 校验 ----------
  const payload = crypto.randomBytes(1000);
  const asset = (buf, o = {}) => Object.assign({}, good, { size: buf.length, digest: 'sha256:' + sha(buf) }, o);
  {   // 正常: 带一次重定向 (GitHub 实际会 302 到 objects.githubusercontent.com)
    const { upd, events, tmp } = makeUpdater({
      release: release({ assets: [asset(payload)] }),
      httpsGet: async url => url.startsWith('https://github.com/') ? stream(Buffer.alloc(0), { status: 302, headers: { location: 'https://objects.githubusercontent.com/abc?token=1' } }) : stream(payload)
    });
    await upd.check();
    const progress = [];
    const r = await upd.download(p => progress.push(p));
    assert.strictEqual(fs.readFileSync(r.file).equals(payload), true, '落盘内容与下载一致');
    assert.strictEqual(path.dirname(r.file), tmp);
    assert.strictEqual(path.basename(r.file), 'Poro-Setup-1.5.6.exe');
    assert.ok(!fs.existsSync(r.file + '.part'), '不应残留 .part');
    assert.strictEqual(progress[progress.length - 1].received, 1000);
    assert.ok(events.requests.some(x => x.startsWith('https://objects.githubusercontent.com/')), '跟随了重定向');
    assert.strictEqual(upd.status().downloaded, true);
    assert.deepStrictEqual(events.spawned, [], '下载完成不会自动安装');
    const again = await upd.download();
    assert.strictEqual(again.file, r.file, '已下载时不重复下载');
    assert.strictEqual(events.requests.filter(x => x.startsWith('https://objects')).length, 1);
    // ---------- 5) 安装 ----------
    assert.strictEqual(upd.install(), true);
    assert.deepStrictEqual(events.spawned, [r.file]);
    assert.strictEqual(events.quit, 1);
  }
  {   // sha256 不一致: 必须删除文件, 不能安装
    const tampered = Buffer.from(payload); tampered[10] ^= 0xff;
    const { upd, events, tmp } = makeUpdater({ release: release({ assets: [asset(payload)] }), httpsGet: async () => stream(tampered) });
    await upd.check();
    await assert.rejects(upd.download(), /sha256/);
    assert.deepStrictEqual(fs.readdirSync(tmp), [], '校验失败后不得留下任何文件 (含 .part)');
    assert.throws(() => upd.install(), /尚未下载/, '校验失败后不能安装');
    assert.deepStrictEqual(events.spawned, []);
  }
  {   // 大小不符
    const { upd, tmp } = makeUpdater({ release: release({ assets: [asset(payload)] }), httpsGet: async () => stream(payload.subarray(0, 500)) });
    await upd.check();
    await assert.rejects(upd.download(), /下载不完整/);
    assert.deepStrictEqual(fs.readdirSync(tmp), []);
  }
  {   // 比标注的还大: 提前中止, 不写满磁盘
    const big = Buffer.concat([payload, payload]);
    let destroyed = false;
    const { upd, tmp } = makeUpdater({ release: release({ assets: [asset(payload)] }), httpsGet: async () => { const s = stream(big, { chunk: 100 }); const d = s.destroy; s.destroy = () => { destroyed = true; d(); }; return s; } });
    await upd.check();
    await assert.rejects(upd.download(), /超出/);
    assert.strictEqual(destroyed, true, '超出标注大小时应立即断开连接');
    assert.deepStrictEqual(fs.readdirSync(tmp), []);
  }
  {   // 重定向到不在白名单的域名 / 重定向过多 / HTTP 错误
    let hops = 0;
    const redirectTo = loc => async () => {
      // 熔断: 重定向次数限制失效时让测试失败, 而不是无限循环挂死
      if (++hops > 20) throw new Error('重定向失控: 次数限制没有生效');
      return stream(Buffer.alloc(0), { status: 302, headers: { location: loc } });
    };
    for (const [httpsGet, re] of [
      [redirectTo('https://evil.example.com/x.exe'), /不在允许范围/],
      [redirectTo('http://objects.githubusercontent.com/x.exe'), /不在允许范围/],
      [redirectTo('https://github.com/loop'), /重定向次数过多/],
      [async () => stream(Buffer.alloc(0), { status: 404 }), /HTTP 404/]
    ]) {
      const { upd } = makeUpdater({ release: release({ assets: [asset(payload)] }), httpsGet });
      await upd.check();
      await assert.rejects(upd.download(), re);
    }
  }
  {   // 不可安装的版本不能下载; 没检查过不能下载/安装; 并发下载只跑一次
    const { upd } = makeUpdater({ release: release({ assets: [Object.assign({}, good, { digest: '' })] }), httpsGet: async () => { throw new Error('不应请求'); } });
    await assert.rejects(upd.download(), /没有可安装的更新/);
    await upd.check();
    await assert.rejects(upd.download(), /没有可安装的更新/, '没有 sha256 摘要的包不能下载安装');
    assert.throws(() => upd.install(), /尚未下载/);
    let n = 0;
    const m = makeUpdater({ release: release({ assets: [asset(payload)] }), httpsGet: async () => { n++; return stream(payload); } });
    await m.upd.check();
    const [a, b] = await Promise.all([m.upd.download(), m.upd.download()]);
    assert.strictEqual(n, 1, '并发下载应合并');
    assert.strictEqual(a.file, b.file);
  }
  {   // 下载完成后又发布了更新的版本: 旧安装包不能被当成新版安装
    const rel1 = release({ assets: [asset(payload)] });
    let current = rel1;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poro-upd-'));
    const spawned = [];
    const upd = createUpdater({ getJson: async () => current, httpsGet: async () => stream(payload), currentVersion: () => '1.5.5', edition: () => 'full', tmpDir: () => tmp, spawnInstaller: f => spawned.push(f), quit: () => {} });
    await upd.check(); await upd.download();
    const newer = Buffer.from('newer');
    current = release({ tag_name: 'v1.5.7', assets: [Object.assign({}, good, { name: 'Poro-Setup-1.5.7.exe', size: newer.length, digest: 'sha256:' + sha(newer) })] });
    await upd.check();
    assert.strictEqual(upd.status().downloaded, false);
    assert.throws(() => upd.install(), /尚未下载/, '1.5.6 的安装包不能当作 1.5.7 安装');
    assert.deepStrictEqual(spawned, []);
  }
  {   // 安装包被删除后
    const { upd } = makeUpdater({ release: release({ assets: [asset(payload)] }), httpsGet: async () => stream(payload) });
    await upd.check();
    const r = await upd.download();
    fs.unlinkSync(r.file);
    assert.throws(() => upd.install(), /已不存在/);
  }

  // ---------- 6) 主进程接线 ----------
  const main = read('main/index.js');
  const preload = read('main/preload.js');
  for (const ch of ['update:check', 'update:download', 'update:install', 'update:openPage']) {
    const block = main.slice(main.indexOf(`ipcMain.handle('${ch}'`));
    assert.ok(main.includes(`ipcMain.handle('${ch}'`), '缺少 IPC ' + ch);
    assert.ok(/fromMainWindow\(e\)/.test(block.slice(0, 200)), ch + ' 必须校验调用来源是主窗口');
    assert.ok(preload.includes(`'${ch}'`), 'preload 缺少 ' + ch);
  }
  assert.ok(!/ipcRenderer\.invoke\('update:[a-zA-Z]+',\s*\w/.test(preload), '更新相关 IPC 不接收渲染层参数 (下载地址只能来自上次检查结果)');
  assert.ok(main.includes('spawn(file, [], { detached: true, stdio: \'ignore\' }).unref()'), '安装程序脱离 Poro 进程运行');
  assert.ok(main.includes("require('./elevation').isElevated() ? 'full' : 'limited'"), '按当前是否提权选择正式版/受限版');
  assert.ok(/releases\\\/\//.test(main) || main.includes('121012445\\/poro-assistant\\/releases'), '打开发布页只允许本仓库的 releases');

  // ---------- 7) 界面状态机 ----------
  const uiSrc = read('renderer/js/update.js');
  const html = read('renderer/index.html');
  const store = {};
  const toasts = [];
  const els = {};
  const el = id => (els[id] = els[id] || { id, innerHTML: '', hidden: false, disabled: false });
  const info = { available: true, version: '1.5.6', current: '1.5.5', installable: true, assetSize: 1048576, notes: '## 更新\n- <img src=x onerror=1>', edition: 'full', downloaded: false };
  let calls = [];
  let nextCheck = info;
  const ctx = vm.createContext({
    console, Date, Math, Number, String, setTimeout: (fn, ms) => { calls.push(['timer', ms]); return 1; },
    document: { getElementById: el },
    storeGet: k => store[k], storeSet: (k, v) => { store[k] = v; },
    showToast: (m, t) => toasts.push([m, t]),
    confirm: () => true,
    escapeHtml: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    window: {},
    lolAPI: {
      checkUpdate: async () => { calls.push(['check']); return nextCheck; },
      downloadUpdate: async () => { calls.push(['download']); return { ok: true }; },
      installUpdate: async () => { calls.push(['install']); return { ok: true }; },
      onUpdateProgress: cb => { ctx.__progress = cb; }
    }
  });
  ctx.window.lolAPI = ctx.lolAPI;
  vm.runInContext(uiSrc, ctx);
  const state = () => JSON.parse(vm.runInContext('JSON.stringify(updateState)', ctx));
  ctx.initUpdate();
  assert.strictEqual(calls.find(c => c[0] === 'timer')[1], 20000, '首次启动 20 秒后静默检查');
  await ctx.checkForUpdate(true);
  assert.strictEqual(state().phase, 'available');
  assert.ok(toasts.some(([m]) => m.includes('v1.5.6')), '静默检查发现新版会提示');
  assert.strictEqual(el('updateBadge').hidden, false, '有新版时显示徽标');
  assert.ok(el('updateBody').innerHTML.includes('下载更新'));
  assert.ok(!el('updateBody').innerHTML.includes('<img'), '更新说明必须转义');
  assert.ok(el('updateBody').innerHTML.includes('1.0 MB'));
  assert.ok(Number(store.updateLastCheck) > 0, '记录检查时间');
  await ctx.downloadUpdate();
  assert.strictEqual(state().phase, 'ready');
  assert.ok(el('updateBody').innerHTML.includes('安装并重启') && el('updateBody').innerHTML.includes('sha256'));
  await ctx.installUpdate();
  assert.ok(calls.some(c => c[0] === 'install'));
  // 下载进度
  vm.runInContext("updateState = { phase: 'downloading', info: " + JSON.stringify(info) + ", error: '', progress: 0 }", ctx);
  ctx.__progress({ received: 250, total: 1000 });
  assert.strictEqual(state().progress, 25);
  assert.ok(el('updateBody').innerHTML.includes('width:25%'));
  // 已是最新 / 失败
  vm.runInContext("updateState = { phase: 'idle', info: null, error: '', progress: 0 }", ctx);
  nextCheck = { available: false, current: '1.5.5', version: '1.5.5' };
  await ctx.checkForUpdate(false);
  assert.strictEqual(state().phase, 'latest');
  assert.strictEqual(el('updateBadge').hidden, true);
  nextCheck = { __error: 'HTTP 403' };
  const before = toasts.length;
  await ctx.checkForUpdate(true);
  assert.strictEqual(state().phase, 'idle', '静默检查失败不打扰用户');
  assert.strictEqual(toasts.length, before);
  await ctx.checkForUpdate(false);
  assert.strictEqual(state().phase, 'error', '手动检查失败要显示原因');
  assert.ok(el('updateBody').innerHTML.includes('HTTP 403'));
  // 没有 sha256: 只给发布页
  nextCheck = Object.assign({}, info, { installable: false });
  vm.runInContext("updateState = { phase: 'idle', info: null, error: '', progress: 0 }", ctx);
  await ctx.checkForUpdate(false);
  assert.ok(!el('updateBody').innerHTML.includes('downloadUpdate()'), '不可校验的版本不提供下载按钮');
  assert.ok(el('updateBody').innerHTML.includes('发布页'));
  // 最近检查过: 自动检查延后
  calls = [];
  store.updateLastCheck = String(Date.now() - 60 * 1000);
  ctx.initUpdate();
  assert.ok(calls.find(c => c[0] === 'timer')[1] > 5 * 60 * 60 * 1000, '一分钟前刚检查过, 下次自动检查应在约 6 小时后');
  // 页面接线
  assert.ok(html.includes('id="updateBody"') && html.includes('onclick="checkForUpdate(false)"'));
  assert.ok(read('renderer/js/app.js').includes('initUpdate();'));
  assert.ok([...html.matchAll(/<script src="js\/([^"?]+)/g)].some(m => m[1] === 'update.js'));

  console.log('软件更新 (检查 / 下载校验 / 安装 / 界面) 测试通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
