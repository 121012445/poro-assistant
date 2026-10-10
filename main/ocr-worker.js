'use strict';
// 强化卡 OCR 子进程 (PowerShell + Windows.Media.Ocr) 的管理。
// 从 index.js 抽出, 以便用模拟子进程测试; 正常路径的行为与原实现一致:
//   · 一个常驻 PowerShell 进程, stdin 一行一个 base64 图片路径, stdout 一行一个 "OK|ERR \t base64文本"
//   · 请求按先进先出对应响应; 单次 4 秒超时即杀掉进程 (下一次请求自动重启)
//
// 新增: 启动失败退避。
// 机器上没有「中文(简体)」OCR 语言包时, 脚本在启动阶段就抛错退出。原实现下一次请求立刻再起一个
// PowerShell, 而强化卡显示期间每 0.5 秒扫一轮 —— 等于每秒起两个 PowerShell (每个启动约 0.5~1 秒、
// 几十 MB 内存), 识别也永远不会成功。现在: 进程在给出任何响应之前就自己退出, 视为启动失败,
// 在退避期内直接拒绝请求 (调用方回退到图标识别), 并保留失败原因供诊断页显示。
// 超时被我们主动杀掉的进程不算启动失败。stop() (离开对局) 会清除退避, 下一局重新尝试。

const DEFAULT_TIMEOUT_MS = 4000;
const STARTUP_BACKOFF_MS = [60 * 1000, 5 * 60 * 1000];   // 第 1 次启动失败退避 1 分钟, 之后 5 分钟

function createOcrWorker(options) {
  const opts = options || {};
  const spawn = opts.spawn;
  const scriptPath = opts.scriptPath;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const setTimer = opts.setTimeout || setTimeout;
  const clearTimer = opts.clearTimeout || clearTimeout;

  let worker = null;
  let output = '';
  let pending = [];
  let responded = false;          // 当前进程是否已给出过至少一行响应
  let stderrTail = '';
  let startupFailures = 0;        // 连续启动失败次数 (任何一次成功响应即清零)
  let unavailableUntil = 0;
  let unavailableReason = '';

  function rejectPending(error) {
    const list = pending.splice(0);
    for (const item of list) {
      clearTimer(item.timer);
      item.reject(error);
    }
  }

  function scriptPathValue() { return typeof scriptPath === 'function' ? scriptPath() : scriptPath; }

  function backoffActive() { return unavailableUntil > 0 && now() < unavailableUntil; }

  function ensure() {
    if (worker && !worker.killed) return worker;
    if (backoffActive()) return null;
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPathValue()
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    worker = child;
    output = '';
    responded = false;
    stderrTail = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (worker !== child) return;
      output += chunk;
      let newline;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline).replace(/\r$/, '');
        output = output.slice(newline + 1);
        responded = true;
        startupFailures = 0;
        const item = pending.shift();
        if (!item) continue;
        clearTimer(item.timer);
        const [status, encoded = ''] = line.split('\t', 2);
        let value = '';
        try { value = Buffer.from(encoded, 'base64').toString('utf8'); } catch (e) {}
        if (status === 'OK') item.resolve(value);
        else item.reject(new Error(value || 'OCR 识别失败'));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      const text = String(chunk).trim();
      if (!text) return;
      stderrTail = (stderrTail + ' ' + text).trim().slice(-400);
      log('[AUGMENT OCR WORKER] ' + text.substring(0, 400));
    });
    const failed = error => {
      if (worker !== child) return;           // 已被 stop()/超时主动替换, 不是启动失败
      worker = null;
      if (!responded) {
        startupFailures++;
        const backoff = STARTUP_BACKOFF_MS[Math.min(startupFailures, STARTUP_BACKOFF_MS.length) - 1];
        unavailableUntil = now() + backoff;
        unavailableReason = (describeStartupError(stderrTail) || (error && error.message) || 'OCR 识别进程启动失败').substring(0, 240);
        log(`[AUGMENT OCR WORKER] 启动失败 #${startupFailures}, ${Math.round(backoff / 1000)}s 内不再重试: ${unavailableReason}`);
      }
      rejectPending(new Error(unavailableReason && !responded ? 'OCR 不可用: ' + unavailableReason : (error && error.message) || 'OCR 识别进程已退出'));
    };
    child.on('error', failed);
    child.on('exit', code => failed(new Error('OCR 识别进程已退出 (' + code + ')')));
    return child;
  }

  function stop() {
    const child = worker;
    worker = null;
    output = '';
    // 离开对局: 下一局重新尝试启动 (例如用户在两局之间装好了语言包)
    unavailableUntil = 0;
    startupFailures = 0;
    rejectPending(new Error('OCR 识别进程已停止'));
    try { child && child.kill(); } catch (e) {}
  }

  function request(imagePath) {
    return new Promise((resolve, reject) => {
      const child = ensure();
      if (!child) { reject(new Error('OCR 不可用: ' + (unavailableReason || '启动失败, 稍后重试'))); return; }
      const item = { resolve, reject, timer: null };
      item.timer = setTimer(() => {
        if (!pending.includes(item)) return;
        // 与原实现一致: 超时杀掉进程, 其余排队请求一起失败, 下次请求重启
        const timedOut = worker;
        worker = null;
        output = '';
        rejectPending(new Error('OCR 识别超时'));
        try { timedOut && timedOut.kill(); } catch (e) {}
      }, timeoutMs);
      pending.push(item);
      const encodedPath = Buffer.from(String(imagePath), 'utf8').toString('base64');
      child.stdin.write(encodedPath + '\n', error => {
        if (!error) return;
        const index = pending.indexOf(item);
        if (index >= 0) pending.splice(index, 1);
        clearTimer(item.timer);
        reject(error);
      });
    });
  }

  // 调用方据此决定要不要先把裁图写盘: 退避期内直接跳过 OCR, 不必编码、写入 PNG。
  function isAvailable() { return !backoffActive(); }

  function status() {
    const active = backoffActive();
    return {
      available: !active,
      running: !!(worker && !worker.killed),
      startupFailures,
      reason: active ? unavailableReason : '',
      retryInMs: active ? Math.max(0, unavailableUntil - now()) : 0
    };
  }

  return { ensure, stop, request, isAvailable, status };
}

// 脚本报错只用 ASCII (见 PoroOcrWorker.ps1), 这里翻译成用户能看懂的提示
function describeStartupError(text) {
  const raw = String(text || '');
  const m = /OCR_LANG_MISSING installed=([^\r\n"']*)/.exec(raw);
  if (m) {
    const installed = m[1].trim().replace(/[.\s]+$/, '') || 'none';
    return `缺少 Windows「中文(简体)」OCR 语言包 (已安装的 OCR 语言: ${installed === 'none' ? '无' : installed})。` +
      '可在 设置 > 时间和语言 > 语言和区域 添加「中文(简体，中国)」; 在此之前强化识别只能靠图标比对';
  }
  return firstLine(raw);
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
}

module.exports = { createOcrWorker, describeStartupError, STARTUP_BACKOFF_MS };
