// 守卫: main/native 下的 PowerShell 脚本必须是纯 ASCII (或带 UTF-8 BOM)。
//
// 原因: 无 BOM 的 .ps1 会被 Windows PowerShell 5.1 按系统 ANSI 代码页解码, 中文 Windows 上是 GBK。
// UTF-8 中文的字节按 GBK 两两配对时, 行尾最后一个字节会和换行符拼成一个字 —— 换行被吞, 下一行代码
// 并进了注释。1.5.7 的 PoroOcrWorker.ps1 因为两行中文注释丢了 'foreach (...) {' 和 'throw' 两行,
// 花括号不配对, 整个脚本解析失败, 强化卡 OCR 完全不可用, PowerShell 的报错 (GBK) 在日志/诊断页里是乱码。
//
// 另测 ocr-worker.js 的 decodeConsoleText: GBK 输出能还原成中文, UTF-8 原样, 字符串直接返回。
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// 返回不合规的行号 (1 起); 带 BOM 的文件视为合规
function nonAsciiLines(buf) {
  if (buf.subarray(0, 3).equals(BOM)) return [];
  const bad = [];
  let line = 1;
  for (const b of buf) {
    if (b === 0x0a) line++;
    else if (b > 0x7f && bad[bad.length - 1] !== line) bad.push(line);
  }
  return bad;
}

const nativeDir = path.join(__dirname, 'main', 'native');
const scripts = fs.readdirSync(nativeDir).filter(f => /\.ps1$/i.test(f));

console.log('test_ps1_ascii');

test('main/native 下至少有 PoroOcrWorker.ps1 (防止目录改名后守卫空转)', () => {
  assert.ok(scripts.includes('PoroOcrWorker.ps1'), '找到的脚本: ' + scripts.join(', '));
});

for (const f of scripts) {
  test(f + ' 为纯 ASCII 或带 UTF-8 BOM', () => {
    const bad = nonAsciiLines(fs.readFileSync(path.join(nativeDir, f)));
    assert.deepStrictEqual(bad, [], '含非 ASCII 字符的行: ' + bad.join(', ') + ' (Windows PowerShell 5.1 会按 GBK 读, 可能吞掉换行)');
  });
}

// 守卫本身要能拦住 1.5.7 的那种写法
test('守卫能识别 1.5.7 那种中文注释', () => {
  const sample = Buffer.from("if ($null -eq $engine) {\n  # 逐个匹配已安装的简体中文\n  foreach ($c in $list) {\n", 'utf8');
  assert.deepStrictEqual(nonAsciiLines(sample), [2]);
  assert.deepStrictEqual(nonAsciiLines(Buffer.concat([BOM, sample])), []);
});

// 运行时会被 PowerShell 执行的脚本必须在 asarUnpack 里 (否则 -File 指向 asar 内部路径, 根本启动不了)
test('PoroOcrWorker.ps1 在 asarUnpack 中', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.ok((pkg.build.asarUnpack || []).includes('main/native/PoroOcrWorker.ps1'));
});

const { decodeConsoleText } = require('./main/ocr-worker');

test('decodeConsoleText: 字符串原样返回', () => {
  assert.strictEqual(decodeConsoleText('OCR_LANG_MISSING installed=none'), 'OCR_LANG_MISSING installed=none');
});

test('decodeConsoleText: UTF-8 字节按 UTF-8 解码', () => {
  assert.strictEqual(decodeConsoleText(Buffer.from('所在位置 行:20', 'utf8')), '所在位置 行:20');
});

let gbkSupported = true;
try { new TextDecoder('gbk'); } catch (e) { gbkSupported = false; }
test('decodeConsoleText: GBK 字节 (PowerShell 中文报错) 还原为中文' + (gbkSupported ? '' : ' [跳过: 当前 Node 无 GBK 解码]'), () => {
  if (!gbkSupported) return;
  // "所在位置 行:20" 的 GBK 编码
  const gbk = Buffer.from([0xcb, 0xf9, 0xd4, 0xda, 0xce, 0xbb, 0xd6, 0xc3, 0x20, 0xd0, 0xd0, 0x3a, 0x32, 0x30]);
  assert.strictEqual(decodeConsoleText(gbk), '所在位置 行:20');
});

test('decodeConsoleText: 空输入不抛异常', () => {
  assert.strictEqual(decodeConsoleText(Buffer.alloc(0)), '');
  assert.strictEqual(decodeConsoleText(undefined), '');
});

if (failed) { console.log(failed + ' 项失败'); process.exit(1); }
console.log('全部通过');
