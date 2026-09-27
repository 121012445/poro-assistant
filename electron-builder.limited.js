'use strict';

// 受限版（asInvoker）构建配置。
//
// 与正式版的**唯一**差别：PE manifest 不要求管理员权限，因此任何账户都能启动。
// 代价是「游戏内热键」与「聊天预填」失效 —— Windows 的 UIPI 会拦掉从低完整性级别
// 向高完整性级别进程的输入注入（国服客户端以管理员运行），SendInput 返回
// ERROR_ACCESS_DENIED。完整评估见 docs/elevation-assessment-20260927.md。
//
// 为什么正式版不能直接改成 asInvoker：那会让**所有**用户的游戏内热键都失效。
// 双包让管理员用户零损失，无法提权的用户从"完全不能用"变成"只少两个功能"。
// （test_kda_briefing.js 里有一条断言锁定了正式版必须 requireAdministrator，
//   就是为了防止有人图省事把正式版直接改掉。）
//
// 刻意保持与正式版相同的 appId / productName / 安装目录：
// 两者是"同一个程序的两种打包"，不是两个程序。用户装其中一个即可，
// 互相覆盖是干净的，不会留下孤立目录或重复的卸载项。
// 运行时由 main/elevation.js 判断自己有没有提权，从而在界面上如实说明限制。
//
// 用法：npm run build:limited

const base = require('./package.json').build;

module.exports = Object.assign({}, base, {
  // 独立输出目录：否则构建受限版会覆盖 dist/win-unpacked 里正式版的可执行文件，
  // 破坏"验证新代码到底进没进包"的流程（那个流程依赖 dist/win-unpacked 是正式版）。
  directories: Object.assign({}, base.directories, { output: 'dist-limited' }),
  win: Object.assign({}, base.win, {
    requestedExecutionLevel: 'asInvoker',
    // 安装包文件名必须一眼能分辨，否则发错包 = 用户继续闪退
    artifactName: '${productName}-Setup-${version}-limited.${ext}'
  })
});
