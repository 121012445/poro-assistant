'use strict';
// main/hotkey-manager.js 门禁: 自定义热键串 → Win32 vk + Electron accelerator。
// 规则: 字母/数字必须带修饰键; F1-F12、Home/End/PageUp/PageDown/Insert/Delete 可单用;
// 重复修饰键/多主键/无法识别 → null (拒绝保存)。
const assert = require('assert');
const { VK, normalize, parse, fromKeyboardEvent } = require('./main/hotkey-manager');

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail !== undefined ? ' | ' + JSON.stringify(detail) : '')); }
}

console.log('— 合法组合解析 —');
{
  const p = parse('Ctrl+F10');
  ok(p && p.display === 'Ctrl+F10' && p.vk === VK.f10, 'Ctrl+F10 解析', p);
  ok(p && p.mods.includes(VK.control) && p.accelerator === 'Control+F10', '修饰键与 accelerator 正确', p);
  ok(parse('ctrl + f7')?.display === 'Ctrl+F7', '大小写与空格归一化');
  ok(parse('F9')?.display === 'F9' && parse('F9').mods.length === 0, 'F 键单用允许');
  ok(parse('Alt+Home')?.accelerator === 'Alt+Home', 'Alt+Home');
  ok(parse('Ctrl+Alt+K')?.display === 'Ctrl+Alt+K', '三修饰键');
  ok(parse('Ctrl+5')?.vk === VK.n5 && parse('Ctrl+5').display === 'Ctrl+5', '数字键映射', parse('Ctrl+5'));
}

console.log('— 非法组合拒绝 —');
{
  ok(parse('K') === null, '裸字母拒绝');
  ok(parse('5') === null, '裸数字拒绝');
  ok(parse('Ctrl+Ctrl+F7') === null, '重复修饰键拒绝');
  ok(parse('Ctrl+F7+F9') === null, '双主键拒绝');
  ok(parse('Ctrl+Tab') === null, '不支持的键拒绝');
  ok(parse('') === null && parse(null) === null, '空串拒绝');
  ok(normalize(' nonsense ') === null, '乱码拒绝');
}

console.log('— 键盘事件采集 —');
{
  const ev = (over) => Object.assign({ code: 'F10', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }, over);
  ok(fromKeyboardEvent(ev()) === 'Ctrl+F10', 'Ctrl+F10 事件', fromKeyboardEvent(ev()));
  ok(fromKeyboardEvent(ev({ code: 'KeyJ', ctrlKey: true })) === 'Ctrl+J', '字母带修饰键');
  ok(fromKeyboardEvent(ev({ code: 'KeyK', ctrlKey: false })) === '', '裸字母提示需要修饰键 (空串)');
  ok(fromKeyboardEvent(ev({ code: 'ControlLeft' })) === null, '修饰键单独按继续等待');
  ok(fromKeyboardEvent(ev({ code: 'Home', ctrlKey: false })) === 'Home', 'Home 可单用');
  ok(fromKeyboardEvent(ev({ code: 'ShiftRight' })) === null, '未知 code 返回 null');
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
