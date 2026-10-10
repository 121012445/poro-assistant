'use strict';
// main/win-rect.js: 多显示器缩放比例不一致时, 窗口坐标改为"物理像素 → 所在显示器的 DIP"。
// Win32 读取部分 (koffi) 在本测试环境里不可用, 这里测换算的决策与容错, 并用源码断言钉住分支顺序。
const assert = require('assert');
const fs = require('fs');
const winRect = require('./main/win-rect');
const { usePhysicalPath, physicalToDip } = winRect._internals;

// ---------- 1) 何时走新路径 ----------
winRect.configureDpi(null);
assert.strictEqual(usePhysicalPath(), false, '未注入 (非 Windows / 测试 / 旧 Electron) 时走原路径');
let mixed = false;
let conversions = 0;
// Electron screenToDipRect 的简化模型: 按矩形所在显示器的缩放换算
// 主屏 2560x1440 @150% (DIP 0,0 1707x960), 副屏 1920x1080 @100% 位于其右侧 (物理 x=2560, DIP x=1707)
const toDip = r => {
  conversions++;
  if (r.x >= 2560) return { x: 1707 + (r.x - 2560), y: r.y, width: r.width, height: r.height };
  return { x: r.x / 1.5, y: r.y / 1.5, width: r.width / 1.5, height: r.height / 1.5 };
};
winRect.configureDpi({ mixedDpi: () => mixed, screenToDip: toDip });
assert.strictEqual(usePhysicalPath(), false, '各显示器缩放一致时保持原路径 (行为不变)');
mixed = true;
assert.strictEqual(usePhysicalPath(), true, '缩放不一致时改走物理像素路径');
winRect.configureDpi({ mixedDpi: () => { throw new Error('screen 未就绪'); }, screenToDip: toDip });
assert.strictEqual(usePhysicalPath(), false, '判断出错时退回原路径, 不抛异常');
winRect.configureDpi({ mixedDpi: () => true });
assert.strictEqual(usePhysicalPath(), false, '配置不完整时视为未注入');

// ---------- 2) 换算 ----------
winRect.configureDpi({ mixedDpi: () => true, screenToDip: toDip });
// 游戏全屏在副屏 (100%): 物理 2560,0 1920x1080
const onSecondary = physicalToDip({ x: 2560, y: 0, width: 1920, height: 1080, className: 'RiotWindowClass', title: 'League of Legends (TM) Client' });
assert.deepStrictEqual(
  { x: onSecondary.x, y: onSecondary.y, width: onSecondary.width, height: onSecondary.height },
  { x: 1707, y: 0, width: 1920, height: 1080 },
  '副屏 100% 上的窗口应保持 1920x1080 DIP'
);
assert.strictEqual(onSecondary.className, 'RiotWindowClass', '类名/标题要保留 (诊断用)');
assert.strictEqual(onSecondary.title, 'League of Legends (TM) Client');
// 对照: 原路径 (线程 DPI UNAWARE) 按系统 DPI 150% 虚拟化, 同一个窗口读成 1280x720
const legacy = { width: 1920 / 1.5, height: 1080 / 1.5 };
console.log(`  副屏 1920x1080 的游戏窗口: 原路径读成 ${legacy.width}x${legacy.height}, 新路径 ${onSecondary.width}x${onSecondary.height} (与 Electron DIP 一致)`);
// 主屏 150% 上的客户端: 物理 1920x1080 → DIP 1280x720
const onPrimary = physicalToDip({ x: 320, y: 180, width: 1920, height: 1080 });
assert.deepStrictEqual([onPrimary.x, onPrimary.y, onPrimary.width, onPrimary.height], [320 / 1.5, 120, 1280, 720]);
// 输入对象不能被改写
const input = { x: 2560, y: 0, width: 100, height: 100 };
physicalToDip(input);
assert.deepStrictEqual(input, { x: 2560, y: 0, width: 100, height: 100 });

// ---------- 3) 换算失败 → null (调用方退回原路径) ----------
for (const bad of [() => { throw new Error('boom'); }, () => null, () => ({ x: NaN, y: 0, width: 1, height: 1 }), () => ({ x: 0, y: 0, width: 0, height: 10 })]) {
  winRect.configureDpi({ mixedDpi: () => true, screenToDip: bad });
  assert.strictEqual(physicalToDip({ x: 0, y: 0, width: 10, height: 10 }), null);
}
winRect.configureDpi(null);
assert.strictEqual(physicalToDip({ x: 0, y: 0, width: 10, height: 10 }), null, '未注入时返回 null');

// ---------- 4) 源码: 分支顺序与接线 ----------
const src = fs.readFileSync('main/win-rect.js', 'utf8');
const getRectFor = src.slice(src.indexOf('function getRectFor('), src.indexOf('function readRect('));
assert.ok(getRectFor.indexOf('usePhysicalPath()') < getRectFor.indexOf('SetDpi(UNAWARE)'), '必须先判断混合缩放, 再走原来的 UNAWARE 路径');
assert.ok(/if \(dip\) return dip;/.test(getRectFor), '换算失败时必须落到原路径');
assert.ok(/saved = SetDpi\(UNAWARE\)/.test(getRectFor), '原路径必须保留');
const main = fs.readFileSync('main/index.js', 'utf8');
assert.ok(/winRect\.configureDpi\(\{\s*mixedDpi: \(\) => new Set\(electronScreen\.getAllDisplays\(\)\.map\(d => d\.scaleFactor\)\)\.size > 1,\s*screenToDip: rect => electronScreen\.screenToDipRect\(null, rect\)/.test(main),
  'index.js 应在 app ready 后注入 Electron screen');
assert.ok(main.indexOf('winRect.configureDpi(') < main.indexOf('createWindow();\n    // 托盘') || main.indexOf('winRect.configureDpi(') < main.indexOf('createWindow();\r\n    // 托盘'), '应在创建窗口前注入');

console.log('多显示器混合缩放坐标换算测试通过');
