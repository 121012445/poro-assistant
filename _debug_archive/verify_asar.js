'use strict';
/**
 * 校验已安装 app.asar 内是否含关键改动标记 (asar 内文件未压缩, 直接字节搜索即可)。
 * 用法: node _debug_archive/verify_asar.js "<app.asar 路径>"
 */
const fs = require('fs');
const path = require('path');

const target = process.argv[2] || 'D:\\lol-assistant\\Poro\\resources\\app.asar';
const body = fs.readFileSync(target);

const markers = [
  ['lcu-ws 节点级事件', "'/lol-lobby-team-builder/champ-select/v1'"],
  ['benchFetchLists(force)', 'function benchFetchLists(force)'],
  ['PATCH 选择分支', '/lol-champ-select/v1/session/actions/'],
  ['null 判成功', 'if (!r || !r.__error) ok = true;'],
  ['_benchSwapRetryDelay', '_benchSwapRetryDelay'],
  ['_benchSubsetTries', '_benchSubsetTries'],
  ['_benchPickActionId', '_benchPickActionId']
];

const lines = [];
lines.push('校验目标: ' + target);
lines.push('文件大小: ' + (body.length / 1024).toFixed(0) + ' KB, 修改时间: ' + fs.statSync(target).mtime.toISOString());
let allOk = true;
for (const [name, needle] of markers) {
  const hit = body.includes(Buffer.from(needle, 'utf8'));
  if (!hit) allOk = false;
  lines.push('  ' + (hit ? 'OK  ' : '缺失') + ' ' + name);
}
lines.push(allOk ? '结论: 已安装 asar 含全部关键改动 v1.3.43' : '结论: 仍有缺失, 需重新打包!');

const out = lines.join('\n');
console.log(out);
fs.writeFileSync(path.join(__dirname, 'verify_result.txt'), out, 'utf8');
process.exit(allOk ? 0 : 1);
