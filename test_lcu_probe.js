'use strict';
// LCU 连接探测 (main/lcu.js): 异步分块读日志。
// 核心要求: 与旧实现 (整文件读入 + parseConn) 结果完全等价, 同时 不阻塞事件循环、拿到参数就停、没变化不重读。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

// regInstallPaths 会起 reg 子进程: 在加载 lcu.js 之前换掉 exec (lcu.js 加载时解构取走了 exec)
let execCalls = 0;
let execStdout = Buffer.from('');
childProcess.exec = (cmd, opts, cb) => { execCalls++; process.nextTick(() => cb(null, execStdout)); return {}; };
const lcu = require('./main/lcu.js');
const { parseConn, readConnFromFile, fromLogs, fromLockfile, collectCandidates, regInstallPaths, CONN_READ_CHUNK } = lcu._internals;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poro-lcu-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {} });
let seq = 0;
const write = (name, content) => { const f = path.join(root, `${++seq}-${name}`); fs.writeFileSync(f, content); return f; };

// 统计磁盘读取量: 包装 fs.promises.open (lcu.js 运行时才查找该属性)
const realOpen = fs.promises.open;
let opens = 0;
let bytesReadTotal = 0;
fs.promises.open = async (...args) => {
  opens++;
  const handle = await realOpen.apply(fs.promises, args);
  const realRead = handle.read.bind(handle);
  handle.read = async (...a) => { const r = await realRead(...a); bytesReadTotal += r.bytesRead; return r; };
  return handle;
};
const measure = async fn => { opens = 0; bytesReadTotal = 0; const r = await fn(); return { r, opens, bytes: bytesReadTotal }; };

const CMD = (port, token) => `"C:\\x\\LeagueClientUx.exe" "--app-port=${port}" "--remoting-auth-token=${token}" "--riotclient-app-port=1"`;
const filler = n => ('日志噪音 log noise '.repeat(Math.ceil(n / 14))).slice(0, n);
// 真实客户端日志是按行的: 大文件样本必须带换行 (整个文件只有一行是不存在的极端情况)
const LOG_LINE = '2026-10-09T12:00:00.123 | INFO | rcp-fe-lol-league-loot | 日志噪音 some typical log line data=12345\n';
const logLines = bytes => LOG_LINE.repeat(Math.ceil(bytes / LOG_LINE.length));

(async () => {
  // ---------- 1) 与旧实现等价 ----------
  const T = 'AbCdEf0123456789_-xyzXYZ0123456789ab';
  const cases = {
    '命令行在文件开头': CMD(51234, T) + '\n' + filler(1000),
    'CRLF 换行': CMD(51235, T) + '\r\n' + filler(200) + '\r\n',
    '前面有大量中文噪音': filler(200000) + '\n' + CMD(51236, T) + '\n',
    '只有端口没有 token': '"--app-port=51237"\n' + filler(500),
    '只有 token 没有端口': '"--remoting-auth-token=' + T + '"\n' + filler(500),
    '都没有': filler(100000),
    '空文件': '',
    '多个匹配取第一个': CMD(11111, 'first-token') + '\n' + CMD(22222, 'second-token') + '\n',
    'token 在端口之前的另一行': '"--remoting-auth-token=' + T + '"\n' + filler(300) + '\n"--app-port=51238"\n',
    '没有结尾换行': filler(1000) + '\n' + CMD(51239, T),
    '端口与 token 分处不同块': '"--app-port=51240"\n' + filler(CONN_READ_CHUNK * 2 + 1234) + '\n"--remoting-auth-token=' + T + '"\n'
  };
  // 「--remoting-auth-token=<token>」整段 (标签+值) 相对 64KB 块边界的各种位置: 全在边界前 / 标签被切开 /
  // 值被切开 / 全在边界后。k = 这一段有多少字节落在边界之前。必须是 ASCII (1 字符 = 1 字节) 才能精确控制位置。
  const LABEL = '"--remoting-auth-token=';
  const SPAN = LABEL.length + T.length;
  const straddling = [];
  for (const k of [SPAN + 5, SPAN, SPAN - 1, SPAN - 10, T.length + 1, T.length, T.length - 1, 20, LABEL.length, 10, 1, 0]) {
    const prefix = '"--app-port=51241" ';
    const spanStart = CONN_READ_CHUNK - k;
    const content = prefix + 'x'.repeat(spanStart - prefix.length) + LABEL + T + '" tail\n' + filler(300);
    assert.strictEqual(content.indexOf(LABEL), spanStart, '用例自检: 标签起点应在预期位置');
    if (spanStart < CONN_READ_CHUNK && spanStart + SPAN > CONN_READ_CHUNK) straddling.push(k);
    cases[`标签+token 相对块边界 k=${k}`] = content;
  }
  assert.ok(straddling.length >= 8, `用例自检: 应有足够多的用例真正跨越块边界 (实际 ${straddling.length})`);
  // 多字节字符正好被块边界切开 (每个汉字 3 字节)
  cases['汉字跨块边界'] = '汉'.repeat(Math.floor(CONN_READ_CHUNK / 3) + 7) + '\n' + CMD(51242, T) + '\n';
  for (const [name, content] of Object.entries(cases)) {
    const f = write('case.log', content);
    const expected = parseConn(fs.readFileSync(f, 'utf8'));   // 旧实现的语义
    const actual = await readConnFromFile(f);
    assert.deepStrictEqual(actual, expected, `与整文件读取不一致: ${name}`);
  }
  assert.deepStrictEqual(await readConnFromFile(write('x.log', cases['命令行在文件开头'])), { port: 51234, token: T });
  assert.strictEqual(await readConnFromFile(path.join(root, 'not-exist.log')), null, '文件不存在应返回 null 而不是抛错');

  // ---------- 2) 拿到参数就停: 大文件开头命中, 只读第一块 ----------
  const big = write('big.log', CMD(52000, T) + '\n' + logLines(8 * 1024 * 1024));
  const early = await measure(() => readConnFromFile(big));
  assert.deepStrictEqual(early.r, { port: 52000, token: T });
  assert.ok(early.bytes <= CONN_READ_CHUNK, `开头命中时只应读第一块 (实际读了 ${early.bytes} 字节)`);

  // ---------- 3) 不阻塞事件循环 ----------
  const noMatch = write('noMatch.log', logLines(24 * 1024 * 1024));
  // 测量事件循环的最大停顿。同步读取时, 最大停顿≈整个读取耗时; 异步分块时只是单块的耗时。
  // 用"最大停顿 / 总耗时"比值判断, 不依赖机器快慢。
  let ticks = 0;
  let maxGap = 0;
  let last = process.hrtime.bigint();
  const ticker = setInterval(() => {
    const now = process.hrtime.bigint();
    maxGap = Math.max(maxGap, Number(now - last) / 1e6);
    last = now;
    ticks++;
  }, 1);
  const t0 = process.hrtime.bigint();
  assert.strictEqual(await readConnFromFile(noMatch), null);
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
  clearInterval(ticker);
  assert.ok(ticks >= 5, `读取期间事件循环必须持续运转 (仅触发 ${ticks} 次)`);
  assert.ok(maxGap < elapsed * 0.5, `事件循环最大停顿 ${maxGap.toFixed(1)}ms 占总耗时 ${elapsed.toFixed(1)}ms 的一半以上: 读取在阻塞主进程`);
  console.log(`  (24MB 无匹配日志耗时 ${elapsed.toFixed(0)}ms, 事件循环最大停顿 ${maxGap.toFixed(1)}ms, 定时器触发 ${ticks} 次)`);

  // ---------- 4) mtime+size 缓存 ----------
  const cacheFile = write('cache.log', CMD(53000, T) + '\n');
  assert.deepStrictEqual((await measure(() => readConnFromFile(cacheFile))).r, { port: 53000, token: T });
  const again = await measure(() => readConnFromFile(cacheFile));
  assert.strictEqual(again.opens, 0, '文件没变化时不得再次打开');
  assert.deepStrictEqual(again.r, { port: 53000, token: T });
  // 文件被追加/重写 (客户端重启会换 token): 必须重读并拿到新值
  fs.writeFileSync(cacheFile, CMD(53001, 'new-token-after-restart') + '\n' + filler(50));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(cacheFile, future, future);
  const reread = await measure(() => readConnFromFile(cacheFile));
  assert.strictEqual(reread.opens, 1, '文件变化后必须重读');
  assert.deepStrictEqual(reread.r, { port: 53001, token: 'new-token-after-restart' });
  // 没匹配的结果同样缓存; 读取失败 (文件消失) 不缓存脏数据
  const emptyConn = write('nomatch-small.log', filler(100));
  await readConnFromFile(emptyConn);
  assert.strictEqual((await measure(() => readConnFromFile(emptyConn))).opens, 0, '无匹配结果也应命中缓存');

  // ---------- 5) fromLogs: 只取最新 3 个, 顺序为 dir 先于 dir/Logs, 各自新→旧 ----------
  const dirA = path.join(root, 'clientA');
  fs.mkdirSync(path.join(dirA, 'Logs'), { recursive: true });
  const names = ['2026-10-01T10-00-00', '2026-10-02T10-00-00', '2026-10-03T10-00-00', '2026-10-04T10-00-00'];
  names.forEach((n, i) => fs.writeFileSync(path.join(dirA, `${n}_LeagueClientUx.log`), CMD(60000 + i, 'tok' + i) + '\n'));
  fs.writeFileSync(path.join(dirA, 'Logs', '2026-10-05T10-00-00_LeagueClientUx.log'), CMD(60009, 'tokLogs') + '\n');
  fs.writeFileSync(path.join(dirA, 'unrelated.log'), CMD(1, 'ignored') + '\n');
  const logsFound = await fromLogs(dirA);
  assert.deepStrictEqual(logsFound.map(c => c.port), [60003, 60002, 60001, 60009], '应取各目录最新 3 个, dir 在前, 新→旧');
  assert.ok(logsFound.every(c => c.clientDir === dirA));
  assert.deepStrictEqual(await fromLogs(path.join(root, 'nope')), [], '目录不存在应返回空数组');

  // ---------- 6) collectCandidates: 顺序、去重、跳过不存在的目录 ----------
  const dirB = path.join(root, 'clientB');
  fs.mkdirSync(dirB);
  fs.writeFileSync(path.join(dirB, 'lockfile'), 'LeagueClient:1234:61000:locktoken:https');
  fs.writeFileSync(path.join(dirB, '2026-10-06T10-00-00_LeagueClientUx.log'), CMD(60003, 'tok3') + '\n');   // 与 dirA 重复
  assert.deepStrictEqual(await fromLockfile(dirB), [{ port: 61000, token: 'locktoken', clientDir: dirB }]);
  assert.deepStrictEqual(await fromLockfile(dirA), [], '没有 lockfile 应返回空数组');
  const collected = await collectCandidates([path.join(root, 'missing'), dirB, dirA]);
  assert.deepStrictEqual(collected.map(c => c.port), [61000, 60003, 60002, 60001, 60009], 'dirs 顺序决定优先级; lockfile 先于日志; 重复项去重');
  const withInitial = await collectCandidates([dirA], [{ port: 60002, token: 'tok2', clientDir: 'x' }]);
  assert.strictEqual(withInitial.filter(c => c.port === 60002).length, 1, '进程命令行得到的候选需参与去重');
  assert.strictEqual(withInitial[0].clientDir, 'x', '初始候选(进程命令行)保持最高优先级');

  // ---------- 7) 注册表路径缓存 ----------
  lcu.reset();
  execCalls = 0;
  execStdout = Buffer.from('    InstallPath    REG_SZ    D:\\Games\\LoL\r\n');
  assert.deepStrictEqual(await regInstallPaths(), ['D:\\Games\\LoL', 'D:\\Games\\LoL', 'D:\\Games\\LoL']);
  assert.strictEqual(execCalls, 3, '首次查询 3 个注册表键');
  await regInstallPaths(); await regInstallPaths();
  assert.strictEqual(execCalls, 3, '缓存期内不得再起 reg 子进程 (客户端未运行时 probe 每 5 秒走一次)');
  lcu.reset();
  await regInstallPaths();
  assert.strictEqual(execCalls, 6, 'reset() 后应重新查询');
  // 一个都没查到: 同样缓存 (较短 TTL), 避免客户端未安装/未运行时每 5 秒起 3 个子进程
  lcu.reset();
  execCalls = 0;
  execStdout = Buffer.from('');
  assert.deepStrictEqual(await regInstallPaths(), []);
  await regInstallPaths();
  assert.strictEqual(execCalls, 3, '空结果也要缓存');

  fs.promises.open = realOpen;
  console.log('LCU 连接探测 (异步分块读取 / 缓存 / 顺序) 测试通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
