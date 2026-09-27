'use strict';
/**
 * 判断当前进程是否以管理员身份（High 完整性级别）运行。
 *
 * 为什么需要它：正式版与受限版共用同一份代码，唯一差别是 PE manifest 里
 * 要不要提权（见 docs/elevation-assessment-20260927.md）。运行时只有问过才知道
 * 自己有没有提权 —— 而"没提权"有一个具体后果：游戏内热键与聊天预填会失效，
 * 因为 native/PoroInput.exe 的 SendInput 无法作用于以管理员运行的游戏进程
 * （Windows 的 UIPI 会拦掉跨完整性级别的输入注入，SendInput 返回 ERROR_ACCESS_DENIED）。
 * 有了这个判断，界面才能把"为什么用不了"讲清楚，而不是丢一个 Win32 错误码。
 *
 * 设计原则与 win-rect.js 一致：**任何环节失败都返回 null，绝不抛异常**。
 * 判定不了就是"未知"，不能因此影响启动。
 *
 * 实现用官方接口（advapi32 令牌查询），不用 shell32!IsUserAnAdmin —— 后者已废弃，
 * 且两者在本机非提权上下文下实测结论一致（见技能 §5.5.1 的验证方法）。
 */

let cached = null;      // true | false | null
let loaded = false;

const TOKEN_QUERY = 0x0008;
const TOKEN_ELEVATION = 20;   // TOKEN_INFORMATION_CLASS 枚举值

function probe() {
  if (process.platform !== 'win32') return null;
  try {
    const koffi = require('koffi');
    const advapi32 = koffi.load('advapi32.dll');
    const kernel32 = koffi.load('kernel32.dll');

    const GetCurrentProcess = kernel32.func('void *GetCurrentProcess()');
    const OpenProcessToken = advapi32.func('bool OpenProcessToken(void *h, uint32 access, _Out_ void **token)');
    const GetTokenInformation = advapi32.func('bool GetTokenInformation(void *token, int cls, _Out_ void *buf, uint32 len, _Out_ uint32 *ret)');
    const CloseHandle = kernel32.func('bool CloseHandle(void *h)');

    const token = [null];
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, token)) return null;
    try {
      const buf = Buffer.alloc(4);       // TOKEN_ELEVATION 就是一个 DWORD
      const ret = [0];
      if (!GetTokenInformation(token[0], TOKEN_ELEVATION, buf, buf.length, ret)) return null;
      if (ret[0] < 4) return null;
      return buf.readUInt32LE(0) !== 0;
    } finally {
      try { CloseHandle(token[0]); } catch (e) { /* 关闭失败无所谓 */ }
    }
  } catch (e) {
    // koffi 没装 / 不是 Windows / 被 EDR 拦 —— 一律"未知"
    return null;
  }
}

/** @returns {boolean|null} true=已提权, false=未提权, null=判定不了 */
function isElevated() {
  if (!loaded) { loaded = true; cached = probe(); }
  return cached;
}

/** 供日志与诊断页使用的稳定字符串：'yes' | 'no' | '?' */
function describe() {
  const v = isElevated();
  return v === true ? 'yes' : (v === false ? 'no' : '?');
}

/**
 * 把 native 输入组件的报错翻译成用户能看懂的话。
 * 未提权 + SendInput 失败 = 极可能是 UIPI 拦截，这是受限版在国服的必然结果，
 * 只说"SendInput错误 5"用户无从下手。
 * @param {string} detail native 组件 stderr 的原文
 * @returns {string}
 */
function explainGameInputError(detail) {
  const text = String(detail || '').trim();
  if (text && /SendInput/i.test(text) && isElevated() === false) {
    return text + ' —— 当前 Poro 未以管理员身份运行，无法向以管理员身份运行的游戏注入按键。'
      + '请改用正式版安装包，或右键"以管理员身份运行"。';
  }
  return text;
}

module.exports = { isElevated, describe, explainGameInputError };
