const fs = require('fs');
const assert = require('assert');

const src = fs.readFileSync('main/index.js', 'utf8');
const firstLocalRequire = src.indexOf("require('./lcu')");

assert(firstLocalRequire > 0, '未找到本地模块加载点');
assert(src.indexOf("process.on('uncaughtException'") < firstLocalRequire,
  '启动异常处理必须早于本地模块加载');
assert(src.indexOf("process.on('unhandledRejection'") < firstLocalRequire,
  '异步启动异常处理必须早于本地模块加载');
assert(src.includes("const SAFE_MODE_ARG = '--poro-safe-mode'"), '缺少软件渲染兼容模式');
assert(src.includes("const RENDERER_COMPAT_ARG = '--poro-renderer-compat'"), '缺少渲染沙箱兼容模式');
assert(src.includes("webContents.on('render-process-gone'"), '缺少渲染进程崩溃恢复');
assert(src.includes("app.relaunch({ args })"), '渲染崩溃后没有自动重启');
assert(src.includes("if (!rendererCompatActive) {"), '缺少渲染沙箱兼容的第二级回退');
// 第二级回退不能限定在 launch-failed 上。2026-09-27 实测: 渲染进程沙箱初始化不了的环境里,
// render-process-gone 报的是 reason=killed(不是 launch-failed), 软件渲染救不回来,
// 只有关掉窗口沙箱能起来。原来限定 launch-failed 会让这类机器直接 FATAL —— 就是"装完闪退"。
assert(!src.includes("reason === 'launch-failed' && !rendererCompatActive"),
  '第二级回退不应只认 launch-failed(实测 killed 同样需要, 否则这类机器直接 FATAL)');
assert((src.match(/sandbox: !rendererCompatActive/g) || []).length >= 3,
  '主窗口和两类浮窗没有统一使用渲染兼容开关');
assert(src.includes("fs.unlinkSync(STARTUP_MARKER)"), '启动成功后没有清理启动标记');
assert(/try \{ createTray\(\); \} catch/.test(src), '托盘初始化失败仍可能拖垮主窗口');
assert(/whenReady\(\)\.then[\s\S]*\.catch\(error => reportFatal/.test(src), 'whenReady 初始化异常仍会静默退出');
assert(src.includes('function isReadySummoner(summoner)'), 'LCU 状态缺少玩家档案有效性校验');
assert(src.includes('summonerReady: false'), 'LCU 空档案没有区分客户端连接与档案就绪状态');

const homeSrc = fs.readFileSync('renderer/js/home.js', 'utf8');
assert(homeSrc.includes('const durableSelfCache = !profileOverride'), '首页网络刷新缺少持久缓存兜底');
assert(homeSrc.includes('transient empty refresh ignored'), '首页瞬时空战绩仍可能覆盖有效缓存');
assert(homeSrc.indexOf('transient empty refresh ignored') < homeSrc.indexOf('const cachePayload ='),
  '首页必须在写缓存前拦截瞬时空战绩');

console.log('启动容错测试通过');
