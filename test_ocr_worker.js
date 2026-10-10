'use strict';
// main/ocr-worker.js: 用模拟子进程验证 ① 正常收发与原实现一致 ② 启动失败退避 (缺语言包时不再每轮起 PowerShell)
const assert = require('assert');
const fs = require('fs');
const { EventEmitter } = require('events');
const { createOcrWorker, describeStartupError, STARTUP_BACKOFF_MS } = require('./main/ocr-worker');

let clock = 1000000;
const spawned = [];
function fakeSpawn(cmd, args, opts) {
  const child = new EventEmitter();
  child.killed = false;
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
  child.written = [];
  child.stdin = { write: (data, cb) => { child.written.push(data); cb && cb(child.failWrite || null); } };
  child.kill = () => { child.killed = true; process.nextTick(() => child.emit('exit', null)); };
  child.cmd = cmd; child.args = args; child.opts = opts;
  spawned.push(child);
  return child;
}
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const reply = (child, status, text) => child.stdout.emit('data', status + '\t' + b64(text) + '\r\n');
const settle = p => p.then(v => ({ ok: true, v }), e => ({ ok: false, e: e.message }));
const tick = () => new Promise(r => setImmediate(r));
let finished = false;
process.on('exit', code => {
  if (!finished && code === 0) { console.error('测试没有跑完 (有请求一直没有返回)'); process.exitCode = 1; }
});
// 请求必须在限定时间内有结果: 退避失效时请求会一直挂着, 不能让它静默通过
const settleSoon = (p, label) => Promise.race([settle(p), new Promise(r => setTimeout(() => r({ ok: false, e: 'HUNG:' + label }), 200))]);

const timers = [];
const logs = [];
const ocr = createOcrWorker({
  spawn: fakeSpawn, scriptPath: () => 'C:\\x\\PoroOcrWorker.ps1', log: m => logs.push(m), now: () => clock,
  setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
  clearTimeout: t => { if (t) t.cleared = true; }
});

(async () => {
  // ---------- 1) 正常路径: 参数、编码、先进先出、CRLF ----------
  const p1 = settle(ocr.request('C:\\图片\\a.png'));
  const p2 = settle(ocr.request('C:\\图片\\b.png'));
  assert.strictEqual(spawned.length, 1, '两次请求只应启动一个常驻进程');
  const w = spawned[0];
  assert.strictEqual(w.cmd, 'powershell.exe');
  assert.deepStrictEqual(w.args, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\x\\PoroOcrWorker.ps1']);
  assert.strictEqual(w.opts.windowsHide, true);
  assert.deepStrictEqual(w.written, [b64('C:\\图片\\a.png') + '\n', b64('C:\\图片\\b.png') + '\n'], '路径按 UTF-8 base64 一行一个写入');
  // 一个 chunk 里两行、第二行被拆成两段到达
  const errB64 = b64('识别失败');
  w.stdout.emit('data', 'OK\t' + b64('掷骰狂人') + '\r\nERR\t' + errB64.slice(0, 5));
  w.stdout.emit('data', errB64.slice(5) + '\r\n');
  assert.deepStrictEqual(await p1, { ok: true, v: '掷骰狂人' });
  assert.deepStrictEqual(await p2, { ok: false, e: '识别失败' }, '跨 chunk 的一行应拼完整再解析');
  assert.strictEqual(ocr.status().available, true);
  assert.strictEqual(ocr.status().running, true);

  // ---------- 2) 超时: 杀进程, 不算启动失败, 下次请求立即重启 ----------
  const p3 = settle(ocr.request('c.png'));
  const t3 = timers[timers.length - 1];
  assert.strictEqual(t3.ms, 4000, '单次请求超时应为 4 秒');
  t3.fn();
  assert.deepStrictEqual(await p3, { ok: false, e: 'OCR 识别超时' });
  await tick();
  assert.strictEqual(w.killed, true, '超时应杀掉进程');
  assert.strictEqual(ocr.status().available, true, '超时被主动杀掉不算启动失败');
  const p4 = settle(ocr.request('d.png'));
  assert.strictEqual(spawned.length, 2, '超时后下一次请求应重启进程');
  // 被杀掉的旧进程迟到的输出不得被算到新进程的请求上
  w.stdout.emit('data', 'OK\t' + b64('迟到的旧结果') + '\n');
  reply(spawned[1], 'OK', '新结果');
  assert.deepStrictEqual(await p4, { ok: true, v: '新结果' }, '旧进程迟到的输出不得串到新请求');

  // 冷启动还没给出任何响应就超时: 是我们主动杀掉的, 不能当成启动失败而进入退避
  ocr.stop();
  const pSlow = settle(ocr.request('slow.png'));
  const slow = spawned[spawned.length - 1];
  timers[timers.length - 1].fn();
  assert.strictEqual((await pSlow).e, 'OCR 识别超时');
  await tick();
  assert.strictEqual(slow.killed, true);
  assert.strictEqual(ocr.status().available, true, '冷启动超时不应触发退避');
  assert.strictEqual(ocr.status().startupFailures, 0);

  // ---------- 3) 启动失败 (缺中文 OCR 语言包): 退避, 不再每轮起 PowerShell ----------
  ocr.stop();
  const before = spawned.length;
  const p5 = settle(ocr.request('e.png'));
  const bad = spawned[spawned.length - 1];
  assert.strictEqual(spawned.length, before + 1);
  bad.stderr.emit('data', 'OCR_LANG_MISSING installed=en-US, ja\r\nAt C:\\x\\PoroOcrWorker.ps1:30 char:3\r\n');
  bad.emit('exit', 1);
  const r5 = await p5;
  assert.strictEqual(r5.ok, false);
  assert.ok(r5.e.includes('中文(简体)') && r5.e.includes('en-US, ja'), '失败原因应翻译成中文提示并带上已安装的语言: ' + r5.e);
  const st = ocr.status();
  assert.strictEqual(st.available, false);
  assert.strictEqual(st.startupFailures, 1);
  assert.strictEqual(st.retryInMs, 60 * 1000, '第一次启动失败退避 1 分钟');
  assert.ok(st.reason.includes('设置 > 时间和语言'), '诊断里应有可操作的提示');
  assert.ok(logs.some(l => l.includes('启动失败 #1')), '应记录一次启动失败');

  // 模拟强化卡显示期间每 0.5 秒扫一轮、每轮 3 个槽位, 持续 30 秒
  for (let i = 0; i < 60; i++) {
    clock += 500;
    const rs = await Promise.all([0, 1, 2].map(() => settleSoon(ocr.request('slot.png'), 'backoff')));
    assert.ok(rs.every(r => !r.ok && r.e.startsWith('OCR 不可用')), '退避期内应直接拒绝');
  }
  assert.strictEqual(spawned.length, before + 1, `退避期内不得再启动 PowerShell (实际多启动了 ${spawned.length - before - 1} 个)`);
  assert.strictEqual(ocr.isAvailable(), false);

  // 退避到期 → 再试一次; 再失败 → 退避 5 分钟
  clock += STARTUP_BACKOFF_MS[0];
  assert.strictEqual(ocr.isAvailable(), true, '退避到期后应允许重试');
  const p6 = settle(ocr.request('f.png'));
  assert.strictEqual(spawned.length, before + 2, '到期后重试一次');
  spawned[spawned.length - 1].stderr.emit('data', 'OCR_LANG_MISSING installed=none');
  spawned[spawned.length - 1].emit('exit', 1);
  assert.ok((await p6).e.includes('已安装的 OCR 语言: 无'), 'installed=none 应显示为「无」');
  assert.strictEqual(ocr.status().startupFailures, 2);
  assert.strictEqual(ocr.status().retryInMs, 5 * 60 * 1000, '连续第二次失败应退避 5 分钟');

  // stop() (离开对局) 清除退避: 下一局用户可能已装好语言包
  ocr.stop();
  assert.strictEqual(ocr.status().available, true);
  const p7 = settle(ocr.request('g.png'));
  reply(spawned[spawned.length - 1], 'OK', '装好了');
  assert.deepStrictEqual(await p7, { ok: true, v: '装好了' });
  assert.strictEqual(ocr.status().startupFailures, 0, '成功响应后清零');

  // 失败计数在成功响应后清零 (不经过 stop): 下一次启动失败重新从 1 分钟开始
  spawned[spawned.length - 1].emit('exit', 1);          // 上面已正常工作的进程退出 (不计数), q1 将用全新进程
  const spawnedBeforeQ1 = spawned.length;
  const q1 = settle(ocr.request('q1.png'));
  assert.strictEqual(spawned.length, spawnedBeforeQ1 + 1, 'q1 必须由新进程处理, 否则测不到启动失败');
  spawned[spawned.length - 1].emit('exit', 1);          // 启动失败 #1
  await q1;
  assert.strictEqual(ocr.status().startupFailures, 1, '前置条件: 已记一次启动失败');
  clock += 60 * 1000;
  const q2 = settle(ocr.request('q2.png'));
  reply(spawned[spawned.length - 1], 'OK', '好了');      // 重试成功
  assert.strictEqual((await q2).v, '好了');
  const q3 = settle(ocr.request('q3.png'));
  spawned[spawned.length - 1].emit('exit', 1);          // 运行中崩溃 (已响应过) → 不退避
  await q3;
  const q4 = settle(ocr.request('q4.png'));
  spawned[spawned.length - 1].emit('exit', 1);          // 新进程启动失败
  await q4;
  assert.strictEqual(ocr.status().retryInMs, 60 * 1000, '成功过之后再失败应从第一档退避开始');
  ocr.stop();

  // ---------- 4) 正常工作后才崩溃: 不是启动失败, 不退避 ----------
  const p8warm = settle(ocr.request('h0.png'));
  reply(spawned[spawned.length - 1], 'OK', '先正常工作');
  assert.strictEqual((await p8warm).v, '先正常工作');
  const p8 = settle(ocr.request('h.png'));
  spawned[spawned.length - 1].emit('exit', 3221225477);
  assert.ok((await p8).e.includes('已退出'));
  assert.strictEqual(ocr.status().available, true, '运行中崩溃不应触发退避');
  const p9 = settle(ocr.request('i.png'));
  reply(spawned[spawned.length - 1], 'OK', '恢复');
  assert.strictEqual((await p9).v, '恢复', '崩溃后下一次请求立即重启');

  // ---------- 5) spawn 报错 (powershell.exe 被安全软件拦截) 同样退避 ----------
  ocr.stop();
  const n = spawned.length;
  const p10 = settle(ocr.request('j.png'));
  spawned[spawned.length - 1].emit('error', new Error('spawn powershell.exe EACCES'));
  assert.ok((await p10).e.includes('EACCES'));
  assert.strictEqual(ocr.isAvailable(), false);
  await settle(ocr.request('k.png'));
  assert.strictEqual(spawned.length, n + 1, 'spawn 失败后同样不应立即重试');

  // ---------- 6) 文案翻译 ----------
  assert.ok(describeStartupError('OCR_LANG_MISSING installed=en-US.').includes('en-US)'), '去掉 PowerShell 附加的句号');
  assert.strictEqual(describeStartupError('\r\n  其他错误\r\n第二行'), '其他错误');
  assert.strictEqual(describeStartupError(''), '');

  // ---------- 7) 脚本与接线 ----------
  const ps = fs.readFileSync('main/native/PoroOcrWorker.ps1', 'utf8');
  assert.ok(ps.includes("throw \"OCR_LANG_MISSING installed=$installed\""), '脚本应抛出可识别的 ASCII 标记');
  assert.ok(/AvailableRecognizerLanguages[\s\S]*-match '\^zh-\(Hans\|CN\|SG\)'/.test(ps), '应匹配已安装的其他简体中文标签');
  const codeLines = ps.split(/\r?\n/).filter(l => !l.trim().startsWith('#'));
  assert.ok(codeLines.every(l => /^[\x00-\x7f]*$/.test(l)), '无 BOM 的 .ps1 会按 ANSI 代码页读取: 代码行必须是 ASCII');
  const main = fs.readFileSync('main/index.js', 'utf8');
  assert.ok(main.includes("require('./ocr-worker')"), 'index.js 应使用 ocr-worker 模块');
  assert.ok(main.includes('if (!augmentOcr.isAvailable()) return [];'), '退避期内不应写裁图');
  assert.ok(main.includes('ocr: augmentOcr.status()'), '诊断应能看到 OCR 状态');
  assert.ok(!/let augmentOcrPending/.test(main), '旧的进程管理代码应已移除');

  finished = true;
  console.log('OCR 子进程管理测试通过 (正常收发 / 超时重启 / 启动失败退避 / 诊断文案)');
})().catch(e => { console.error(e); process.exitCode = 1; });
