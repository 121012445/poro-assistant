# Poro

Poro 是一款面向《英雄联盟》玩家的 Windows 桌面助手，基于 Electron 构建。它整合玩家档案、近期战绩、实时对局、海克斯大乱斗强化推荐、备战区工具和赛后复盘，并尽量让所有自动化功能保持透明、可关闭。

> 本项目是社区开源工具，与 Riot Games、腾讯游戏及其关联公司没有官方关系。“League of Legends”“英雄联盟”及相关素材归各自权利人所有。

## 功能

- 玩家档案：近期胜率、模式统计、常用英雄、常一起玩的队友和趣味数据。
- 战绩查询：最多加载近 100 场，展示 KDA、伤害、承伤、经济效率和表现标签。
- 实时对局：两队十人信息、近期表现、阵容结构与模式适配分析。
- 海克斯大乱斗：按英雄、轮次、样本量与组合数据推荐三选一强化。
- 游戏内悬浮层：强化选择提示、备战区英雄信息及自适应分辨率定位。
- 工具箱：客户端窗口修复、游戏设置锁定、自动符文、KDA 简报等。
- 赛后复盘：按模式生成表现评分、关键节点和可选的 AI 分析。
- 国内与 Riot 平台路由：根据客户端区域选择可用的数据接口。

## 技术栈

- Electron 44
- 原生 Node.js / JavaScript / CSS
- League Client Update API（LCU）
- Live Client Data API
- CommunityDragon / Data Dragon 公共静态数据
- Windows OCR、Win32 窗口与输入接口

## 本地开发

要求：Windows 10/11、Node.js 20+、npm。

```bash
npm install
npm start
```

运行测试：

```bash
npm test
```

生成 Windows 安装包：

```bash
npm run build
```

构建产物位于 `dist/`，该目录不会提交到 Git。

## 数据与隐私

- Poro 只在本机读取已登录英雄联盟客户端提供的会话与对局数据。
- LCU/SGP 临时令牌只保存在内存中，不写入仓库。
- AI 复盘为可选功能，API Key 使用 Electron `safeStorage` 加密后保存在用户目录。
- `userData`、日志、缓存、安装包与个人配置均已从版本控制中排除。

## 使用风险

第三方工具是否被允许取决于所在服务器的规则及其后续变化。使用自动化、输入模拟或游戏内悬浮功能前，请自行确认服务器规则并评估账号风险。项目提供合规模式用于关闭写入和自动化能力。

## 贡献

欢迎提交 Issue 和 Pull Request。修改后请先运行 `npm test`；涉及 UI 的改动请同时检查浅色、夜间模式及不同窗口宽度。

## License

[MIT](LICENSE)
