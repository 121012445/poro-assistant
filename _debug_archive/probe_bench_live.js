'use strict';
/**
 * 备战区助手 实机诊断 (默认只读)
 * ------------------------------------------------------------------
 * 用途: 在【选人阶段】一次性打印备战区换英雄的全部真实数据源与状态码, 定位
 *       "选人页面换不了英雄" 到底断在哪一环。
 *
 * 用法:
 *   node _debug_archive/probe_bench_live.js            # 只读: 打印一次
 *   node _debug_archive/probe_bench_live.js --watch    # 只读: 等到进入选人再打印 (可提前挂着)
 *   node _debug_archive/probe_bench_live.js --swap 64  # 写入: 真的换一次 (会改变你的英雄!)
 *
 * 安全性:
 *   - 不带 --swap 时全程只发 GET, 不写客户端。
 *   - --swap 会向客户端发一次 POST bench/swap, 效果等同于你在游戏里点一下备战席英雄。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const LOG_DIRS = [
  'D:\\WeGameApps\\英雄联盟\\LeagueClient',
  'C:\\WeGameApps\\英雄联盟\\LeagueClient',
  'D:\\Riot Games\\League of Legends\\LeagueClient',
  'C:\\Riot Games\\League of Legends\\LeagueClient'
];

function liveConn() {
  for (const dir of LOG_DIRS) {
    let files;
    try { files = fs.readdirSync(dir); } catch (e) { continue; }
    const logs = files.filter(f => f.endsWith('_LeagueClientUx.log'))
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of logs.slice(0, 3)) {
      try {
        const txt = fs.readFileSync(path.join(dir, f), 'utf8');
        const port = txt.match(/--app-port=(\d+)/);
        const token = txt.match(/--remoting-auth-token=([\w-]+)/);
        if (port && token) return { port: +port[1], token: token[1], log: f };
      } catch (e) {}
    }
  }
  return null;
}

const conn = liveConn();
if (!conn) { console.log('未找到 LCU 连接 (客户端未运行?)'); process.exit(1); }
const auth = 'Basic ' + Buffer.from('riot:' + conn.token).toString('base64');
console.log('LCU: port=' + conn.port + '  日志=' + conn.log);

function call(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { Authorization: auth, Accept: 'application/json' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    else if (method !== 'GET') { headers['Content-Length'] = 0; }
    const req = https.request({
      host: '127.0.0.1', port: conn.port, path: pathname, method, headers, rejectUnauthorized: false
    }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, raw: d, len: d.length }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const get = p => call('GET', p);
function j(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

async function phase() {
  const r = await get('/lol-gameflow/v1/gameflow-phase');
  return String(j(r.raw) ?? r.raw).replace(/"/g, '');
}

async function snapshot(label) {
  console.log('\n================ ' + label + ' ================');
  const ph = await phase();
  console.log('[阶段] ' + ph + (ph === 'ChampSelect' ? '   <-- 正在选人' : '   (换英雄只在 ChampSelect 有效)'));

  // 1. 选人会话
  const s = await get('/lol-champ-select/v1/session');
  console.log('\n[1] GET /lol-champ-select/v1/session -> HTTP ' + s.status + '  (' + s.len + ' bytes)');
  if (s.status !== 200) {
    console.log('    非选人阶段无法取会话; 该端点 404 属正常。');
    return null;
  }
  const sess = j(s.raw);
  const bench = Array.isArray(sess.benchChampions) ? sess.benchChampions : [];
  const me = (sess.myTeam || []).find(p => p.cellId === sess.localPlayerCellId) || {};
  console.log('    benchEnabled           = ' + sess.benchEnabled);
  console.log('    allowSubsetChampionPicks = ' + sess.allowSubsetChampionPicks + '   <-- false 则「备选池」按钮永远不会出现');
  console.log('    benchChampions         = ' + JSON.stringify(bench));
  console.log('    timer                  = ' + JSON.stringify(sess.timer));
  console.log('    我的英雄 championId     = ' + me.championId);
  console.log('    (myTeam 里所有 championId = ' + JSON.stringify((sess.myTeam || []).map(x => x.championId)) + ')');

  // 2. 抽卡池
  const sub = await get('/lol-lobby-team-builder/champ-select/v1/subset-champion-list');
  const subIds = j(sub.raw);
  console.log('\n[2] GET /lol-lobby-team-builder/champ-select/v1/subset-champion-list -> HTTP ' + sub.status + '  (' + sub.len + ' bytes)');
  console.log('    ' + (Array.isArray(subIds) ? '数量=' + subIds.length + '  ' + JSON.stringify(subIds.slice(0, 40)) : 'raw=' + sub.raw.slice(0, 200)));

  // 3. 服务器权威可选列表
  const pk = await get('/lol-champ-select/v1/pickable-champion-ids');
  const pkIds = j(pk.raw);
  console.log('\n[3] GET /lol-champ-select/v1/pickable-champion-ids -> HTTP ' + pk.status + '  (' + pk.len + ' bytes)');
  console.log('    ' + (Array.isArray(pkIds) ? '数量=' + pkIds.length + '  ' + JSON.stringify(pkIds.slice(0, 40)) : 'raw=' + pk.raw.slice(0, 200)));

  // 4. 复刻 bench.js 的渲染决策
  console.log('\n[4] 复刻 Poro 渲染决策 (renderer/js/bench.js benchRenderSwapButtons)');
  const benchIds = bench.map(b => b && b.championId).filter(id => typeof id === 'number' && id > 0);
  const subsetUsable = !!(sess.allowSubsetChampionPicks && sess.timer && sess.timer.phase === 'BAN_PICK');
  const subsetIds = subsetUsable ? (Array.isArray(subIds) ? subIds : []).filter(id => !benchIds.includes(id)) : [];
  const items = [...benchIds.map(id => ({ id, tag: '备战席' })), ...subsetIds.map(id => ({ id, tag: '备选' }))];
  const gate = Array.isArray(pkIds) && pkIds.length ? pkIds : null;
  const canGrab = id => (gate ? gate.includes(id) : true);
  const usable = items.filter(it => canGrab(it.id));
  console.log('    备选池可用 (subsetUsable) = ' + subsetUsable +
    '   [需 allowSubsetChampionPicks=true 且 timer.phase=BAN_PICK]');
  console.log('    候选按钮 = ' + JSON.stringify(items.map(x => x.id + ':' + x.tag)));
  console.log('    门禁挡下 = ' + (items.length - usable.length) + ' 个' + (gate ? '  (可选列表 ' + gate.length + ' 项)' : '  (无门禁数据, 不做门禁)'));
  console.log('    => 工具箱本应显示的按钮: ' + (usable.length ? usable.map(x => '换到 ' + x.id + '[' + x.tag + ']').join(' | ') : '(无 — 这就是"没法换英雄"的上游原因)'));
  return sess;
}

(async () => {
  const args = process.argv.slice(2);
  const watch = args.includes('--watch');
  const swapIdx = args.indexOf('--swap');
  const swapId = swapIdx >= 0 ? Number(args[swapIdx + 1]) : null;

  if (watch && swapId === null) {
    console.log('\n--watch: 每 3 秒检查一次阶段, 进入 ChampSelect 后自动打印并退出。');
    for (;;) {
      const ph = await phase();
      process.stdout.write('\r当前阶段: ' + ph + '      ');
      if (ph === 'ChampSelect') { console.log('\n进入选人, 开始采集…'); break; }
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  const sess = await snapshot('备战区助手 实机快照');

  if (swapId !== null) {
    console.log('\n================ 换英雄写入实测 (--swap ' + swapId + ') ================');
    if (await phase() !== 'ChampSelect') {
      console.log('当前不在选人阶段, 已跳过写入以免产生无意义请求。');
      return;
    }
    const before = await get('/lol-champ-select/v1/current-champion');
    console.log('写入前 我的英雄 = ' + String(before.raw).trim());
    const r = await call('POST', '/lol-champ-select/v1/session/bench/swap/' + swapId);
    console.log('\nPOST /lol-champ-select/v1/session/bench/swap/' + swapId);
    console.log('  HTTP 状态码 = ' + r.status);
    console.log('  响应体长度 = ' + r.len);
    console.log('  响应体原文 = ' + JSON.stringify(r.raw.slice(0, 300)));
    console.log('  >>> 关键判定: 若状态码为 204 或 200+空体, 主进程 rawRequest 会 resolve(null),');
    console.log('      而 bench.js 的 `if (r && !r.__error) ok = true` 会把 null 判成【失败】—— 即使换人已经成功。');
    await new Promise(res => setTimeout(res, 700));
    const after = await get('/lol-champ-select/v1/current-champion');
    console.log('\n写入后 我的英雄 = ' + String(after.raw).trim());
    const sess2 = await get('/lol-champ-select/v1/session');
    const b2 = j(sess2.raw);
    if (b2) console.log('写入后 benchChampions = ' + JSON.stringify(b2.benchChampions));
    console.log('  >>> 若"写入后我的英雄"已变成 ' + swapId + ', 说明换人真的成功了。');
  } else {
    console.log('\n提示: 确认断点后可加 --swap <championId> 做一次真实写入实测 (会改变你的英雄)。');
  }
})().catch(e => console.error('诊断失败: ' + (e && e.message)));
