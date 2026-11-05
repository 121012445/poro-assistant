'use strict';
// riot-client.js 行为测试。
// 背景: 国服 LCU 的 alias/lookup 必须同时给 gameName + tagLine, 少一个就 400;
// Riot Client 的 /player-account/aliases/v1/lookup 只给 gameName 就能返回该名字下
// 全部 Riot ID —— 这是"陌生玩家不用输完整 Tag"的唯一来源。连接参数藏在
// LeagueClientUx.log 的启动行里 (国服进程命令行读不到), 解析错了整条通道就哑掉。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const rc = require('./main/riot-client');
const { readRCFromFile, newestLogs, mapAliasList } = rc._internals;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poro-rc-'));
let passed = 0;
function ok(title, cond, extra) {
  if (cond) { passed++; return; }
  console.log('✗ ' + title + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  process.exitCode = 1;
}

function write(name, text, dir) {
  const d = dir || root;
  const p = path.join(d, name);
  fs.writeFileSync(p, text);
  return p;
}

(async () => {
  // ---------- 启动行解析 ----------
  {
    const f = write('a_LeagueClientUx.log',
      'LeagueClientUx.exe --riotclient-auth-token=zOtDW-bf_HKu4zu9Zt8Blw --riotclient-app-port=62175 ' +
      '--remoting-auth-token=uobwaxLmo_iyzp9D0gQGQA --app-port=62339\n');
    const conn = await readRCFromFile(f);
    ok('解析 riotclient 端口', conn && conn.port === 62175, conn);
    ok('解析 riotclient token', conn && conn.token === 'zOtDW-bf_HKu4zu9Zt8Blw', conn);
  }
  {
    // 只有 LCU 参数 (老客户端 / 没起 Riot Client) → 必须返回 null, 不能拿 LCU 的当 RC 用
    const f = write('b_LeagueClientUx.log', '--remoting-auth-token=abc --app-port=62339\n');
    ok('缺少 riotclient 参数返回 null', (await readRCFromFile(f)) === null);
    ok('文件不存在返回 null', (await readRCFromFile(path.join(root, 'nope.log'))) === null);
  }
  {
    // 参数在超长日志的中段: 只在开头 256KB 里找, 找不到就是 null (日志尾部不会被误读)
    const f = write('c_LeagueClientUx.log', 'x'.repeat(300 * 1024) + ' --riotclient-app-port=1 --riotclient-auth-token=t\n');
    ok('只读文件头, 不乱翻整份日志', (await readRCFromFile(f)) === null);
  }

  // ---------- 最新日志挑选 ----------
  {
    const d = fs.mkdtempSync(path.join(root, 'logs-'));
    const old = write('2019-01-01T00-00-00_1_1_LeagueClientUx.log', 'old --riotclient-app-port=1111 --riotclient-auth-token=o\n', d);
    const fresh = write('2026-11-05T11-10-47_2_2_LeagueClientUx.log', 'new --riotclient-app-port=2222 --riotclient-auth-token=n\n', d);
    const t = Date.now();
    fs.utimesSync(old, new Date(t - 60000), new Date(t - 60000));
    fs.utimesSync(fresh, new Date(t), new Date(t));
    const logs = await newestLogs(d);
    ok('按修改时间取最新日志', logs[0] === fresh, logs.map(x => path.basename(x)));
    ok('最多取两条', logs.length <= 2);
    ok('目录不存在返回空数组', (await newestLogs(path.join(root, 'no-such-dir'))).length === 0);
  }

  // ---------- 返回体映射 ----------
  {
    const mapped = mapAliasList([
      { alias: { game_name: '雨未散', tag_line: '16127' }, puuid: 'p1' },
      { alias: { gameName: '雨未散', tagLine: '22894' }, puuid: 'p2' },   // 驼峰写法
      { alias: { game_name: '雨未散' }, puuid: 'p3' },                    // 缺 tag 仍要保留
      { alias: { game_name: '' }, puuid: 'p4' },                          // 空名字丢弃
      { puuid: 'p5' },                                                    // 无 alias 丢弃
      { alias: { game_name: '雨未散', tag_line: '9' } },                  // 无 puuid 丢弃
      null
    ]);
    ok('映射 3 条有效记录', mapped.length === 3, mapped);
    ok('snake_case 正确', mapped[0].gameName === '雨未散' && mapped[0].tagLine === '16127', mapped[0]);
    ok('camelCase 兼容', mapped[1].tagLine === '22894', mapped[1]);
    ok('缺 tag 保留空串', mapped[2].tagLine === '', mapped[2]);
    ok('非数组返回空', mapAliasList(null).length === 0 && mapAliasList({}).length === 0);
  }

  // ---------- 空输入 / 服务不可用 ----------
  {
    ok('空名字直接返回空数组', (await rc.aliasLookup('')) .length === 0);
    ok('undefined 名字返回空数组', (await rc.aliasLookup(undefined)).length === 0);
    // aliasLookupEx 要能把"通道没通"和"没有这个人"分开 —— 渲染层据此决定提示文案
    const exEmpty = await rc.aliasLookupEx('');
    ok('aliasLookupEx 空名字 ok=false', exEmpty.ok === false && exEmpty.list.length === 0, exEmpty);
    const exReal = await rc.aliasLookupEx('这个名字肯定不存在' + Date.now());
    ok('aliasLookupEx 有 ok 字段', typeof exReal.ok === 'boolean', exReal);
    if (exReal.ok) ok('查无此人时是 ok=true + 空列表', exReal.list.length === 0, exReal);
    else ok('通道未就绪时给出错误文案', /未就绪|HTTP|认证/.test(String(exReal.error)), exReal.error);
    const conn = await rc.getRC();
    ok('getRC 返回值形态 (null 或 {port,token})',
      conn === null || (typeof conn.port === 'number' && typeof conn.token === 'string'), conn);
  }

  // ---------- 大区解析 (别名服务是跨区的, 归属要靠 SGP 批量查) ----------
  {
    const sgp = require('./main/sgp');
    ok('resolveRegions 导出', typeof sgp.resolveRegions === 'function');
    ok('8 个合区入口', Object.keys(sgp.SGP_HOSTS).length === 8, Object.keys(sgp.SGP_HOSTS));
    const empty = await sgp.resolveRegions([]);
    ok('空列表不发请求', Object.keys(empty.map).length === 0 && empty.queried.length === 0, empty);
    const dup = await sgp.resolveRegions(['', null, undefined]);
    ok('去重后仍为空', Object.keys(dup.map).length === 0 && dup.queried.length === 0, dup);
    // 限定大区: 非法平台名不该变成请求 (省请求的前提是不能乱发)
    const bad = await sgp.resolveRegions(['p1'], { platforms: ['NOPE'] });
    ok('非法大区不查', Object.keys(bad.map).length === 0 && bad.queried.length === 0, bad);
    const mixed = await sgp.resolveRegions(['p1'], { platforms: ['NOPE', 'XX'] });
    ok('全是非法大区也不查', Object.keys(mixed.map).length === 0 && mixed.queried.length === 0, mixed);
  }

  fs.rmSync(root, { recursive: true, force: true });
  if (!process.exitCode) console.log('riot-client: 全部通过 (' + passed + ' 项)');
})();
