'use strict';
const assert = require('assert');
const path = require('path');

// 双包配置守卫。
// 正式版(requireAdministrator)与受限版(asInvoker)共用同一份构建配置，
// 只应该差两个字段。差多了说明有人改配置时漏改了一边 —— 那会导致
// 两个包在 appId/安装目录/文件清单上分叉，用户装完互相覆盖不干净。

const root = __dirname;
const pkg = JSON.parse(require('fs').readFileSync(path.join(root, 'package.json'), 'utf8'));
const base = pkg.build;
const limited = require('./electron-builder.limited.js');

// 1. 正式版必须保持 requireAdministrator（test_kda_briefing.js 也依赖这一条）
assert.strictEqual(base.win.requestedExecutionLevel, 'requireAdministrator',
  '正式版必须要求管理员权限，否则所有用户的游戏内热键/聊天预填都会失效');

// 2. 受限版必须不提权
assert.strictEqual(limited.win.requestedExecutionLevel, 'asInvoker',
  '受限版必须是 asInvoker，否则无法提权的用户依然起不来');

// 3. 安装包文件名必须可分辨，否则会把受限版当正式版发出去
assert.ok(/limited/i.test(limited.win.artifactName || ''),
  '受限版 artifactName 必须带 limited 标识，便于与正式版区分');
assert.ok(!/limited/i.test(base.win.artifactName || ''),
  '正式版 artifactName 不应带 limited 标识');
assert.notStrictEqual(limited.win.artifactName, base.win.artifactName,
  '两个包的 artifactName 不能相同，否则后构建的会覆盖前一个');

// 4. 两者必须是"同一程序的两种打包"：appId / productName 一致，
//    这样互相覆盖安装是干净的，也不会出现两个卸载项
assert.strictEqual(limited.appId, base.appId, 'appId 必须一致：两种打包是同一个程序');
assert.strictEqual(limited.productName, base.productName,
  'productName 必须一致：否则安装目录会分叉，切换版本时留下孤立文件');
assert.strictEqual(limited.nsis.shortcutName, base.nsis.shortcutName, '快捷方式名必须一致');

// 5. 核心守卫：两个配置的差异必须**恰好**是这两个字段
function diffPaths(a, b, prefix) {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const p = prefix ? prefix + '.' + k : k;
    const va = a ? a[k] : undefined;
    const vb = b ? b[k] : undefined;
    const bothObj = va && vb && typeof va === 'object' && typeof vb === 'object' && !Array.isArray(va) && !Array.isArray(vb);
    if (bothObj) out.push(...diffPaths(va, vb, p));
    else if (JSON.stringify(va) !== JSON.stringify(vb)) out.push(p);
  }
  return out;
}

const diffs = diffPaths(base, limited, '').sort();
assert.deepStrictEqual(diffs, ['directories.output', 'win.artifactName', 'win.requestedExecutionLevel'],
  '两个构建配置只允许差 artifactName、requestedExecutionLevel 与输出目录，实际差异: ' + JSON.stringify(diffs));

// 5b. 输出目录必须分开：共用 dist/ 会让构建受限版覆盖正式版的 win-unpacked
assert.strictEqual(base.directories.output, 'dist', '正式版输出到 dist/');
assert.strictEqual(limited.directories.output, 'dist-limited', '受限版必须输出到独立目录');
assert.notStrictEqual(limited.directories.output, base.directories.output, '两者输出目录不能相同');

// 6. 受限版不能把 electron 自带的 asar 结构、文件清单等改掉
assert.strictEqual(limited.asar, base.asar, 'asar 设置必须一致');
assert.deepStrictEqual(limited.files, base.files, '打包文件清单必须一致');
assert.deepStrictEqual(limited.win.target, base.win.target, '目标平台/架构必须一致');
assert.deepStrictEqual(limited.asarUnpack, base.asarUnpack, 'asarUnpack 必须一致（native 组件要解包）');

// 7. 运行时提权检测必须 fail-soft：任何环境都不能抛异常
const elevation = require('./main/elevation');
let described;
assert.doesNotThrow(() => { described = elevation.describe(); }, 'describe() 不允许抛异常');
assert.ok(['yes', 'no', '?'].includes(described), 'describe() 只能返回 yes/no/?，实际 ' + described);
assert.ok(elevation.isElevated() === true || elevation.isElevated() === false || elevation.isElevated() === null,
  'isElevated() 只能返回 true/false/null');

// 8. 报错翻译：空输入不编造内容；未提权时把 SendInput 失败翻译成人话
assert.strictEqual(elevation.explainGameInputError(''), '', '空输入应原样返回');
assert.strictEqual(elevation.explainGameInputError('未找到英雄联盟游戏窗口'), '未找到英雄联盟游戏窗口',
  '与提权无关的报错不应被改写');
const sendFail = '无法打开游戏聊天 (SendInput错误 5)';
const explained = elevation.explainGameInputError(sendFail);
assert.ok(explained.startsWith(sendFail), '翻译后应保留原始报错，便于排查');
if (elevation.isElevated() === false) {
  assert.ok(explained.length > sendFail.length && /管理员/.test(explained),
    '未提权时 SendInput 失败必须补充"需要管理员权限"的说明');
} else {
  assert.strictEqual(explained, sendFail, '非"未提权"状态不应改写报错');
}

console.log('双包构建配置：asInvoker 变体、仅允许两处差异、身份一致与提权检测 fail-soft 测试通过');
