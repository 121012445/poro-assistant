# 魄罗助手 (Poro Assistant v1.1.8) 性能分析报告

> 分析时间: 2026-09-03 · 对象: Electron 33 主进程 + 无框架渲染层 + 悬浮窗子窗口
> 代码基线 (2026-09-03): `renderer/js/app.js` ~3400 行, `main/*.js` 5 个模块, 运行时依赖仅 `ws`
> **2026-09-17 起基线已变**: 渲染层拆成 18 个模块, 入口 `app.js` 只剩 185 行, 详见下方状态更新

---

## 〇、状态更新 (2026-09-17 复核)

当前版本 **v1.3.42**。渲染层已拆成 18 个模块 (`renderer/js/`, 由 `index.html` 按依赖顺序引入),
入口 `app.js` 只剩 185 行, 最大的 `home.js` 1292 行。原报告基于 v1.1.8, 部分结论已失效, 复核结果如下:

| 条目 | 状态 | 说明 |
|---|---|---|
| P0-1 ddragon 静态数据落盘 | ✅ 已修复 | 新增 `main/gamedata.js`, 按版本落盘 `userData/gamedata/<version>/`, 网络仅探测版本, 探测失败回退磁盘最新缓存; 单测见 `test_gamedata.js` |
| P0-2a 实时页 100→30 场 | ✅ 已修复 | `sgpProfileFor(..., count = 30)` |
| P0-2b puuid TTL 缓存 | ✅ 已修复 | `main/index.js` `_sgpCache` (5 分钟 TTL, 上限 240 条) |
| P0-3 悬浮窗整块重建 | ⚠️ 已失效 | 悬浮窗入口已在提交 `6ae36f3` 彻底移除, `main/overlay.js` 与 `renderer/overlay/` 均不存在。本章节仅作历史记录 |
| P1-4 LCU/SGP keep-alive | ✅ 已修复 | `lcuAgent` / `sgpAgent` / `lcdAgent` 三个连接池 |
| P1-5 名字/段位缓存持久化 | ❌ 仍开放 | `nameCache` / `rankCache` 仍为纯内存对象, 重启即失效 |
| P1-6 图标 CDN 双 fallback | ❌ 仍开放 | `CDG` (communitydragon) 常量已定义但未接入任何 `img`; 图标仍直连 ddragon, 失败即 `onerror` 隐藏 |
| P2-7 console.log 噪音 | ⚠️ 部分 | `lcu.js` 已把请求体打印收进 `PORO_LCU_DEBUG`; `main/index.js` 的 `[LCU-IPC]` 仍打印 body 前 300 字 |

新增待办 (2026-09-16 复核发现):
- `_sgpCache` 按"条数"限流而非字节数, 每条存整页战绩 (30~100 场 × 3-5KB), 峰值可达数十 MB, 建议改为按字节上限或只缓存摘要。
- `dist/` 历史安装包曾累积到 78 个文件 / 3.2GB, 建议打包后只保留最近 3 个版本。

新增待办 (2026-09-17 渲染层拆分后):
- `home.js` 仍是 1292 行的单体模块, 是剩下的最大块; 继续拆之前先确认收益 (它不像 app.js 那样混着
  多个不相干的功能域, 拆分收益主要在于可读性)。
- 多模块引入了一类新风险: 顶层 `let/const` 只在所属脚本执行时才初始化, 跨脚本引用会 TDZ。
  `test_split_order.js` 已把这类问题静态钉死, 以后加模块记得跑它。

---

## 一、总体结论

应用整体架构轻量、无重型框架包袱，**主要瓶颈不在 CPU 而在"网络等待 + 冗余请求 + DOM 整块重建 + 无持久化缓存"**：

| 维度 | 现状 | 主要问题 |
|---|---|---|
| 启动速度 | 每次联网拉 game-data JSON (~6MB) | 无磁盘缓存, ddragon 国服慢 → 首屏延迟 |
| 页面响应 | 首页/实时对局每次拉 100 场/人 | 请求量大且无跨会话缓存 |
| 悬浮窗 | 1.5s 整块 innerHTML 重建 | DOM 抖动 + 图片反复解码 |
| 接口层 | 每次新建 HTTPS 连接 | 无 keep-alive, 握手开销 |
| 图标 | 全部直连 ddragon | 国服超时→图裂/重试, 观感卡 |

---

## 二、按影响排序的具体发现

### P0-1  启动即联网拉取全部游戏静态数据, 无磁盘缓存
- 位置: `main/index.js` ddragon 系列 handler + `app.js` `init()`
- 现象: 每次启动要 `versions.json → champion.json(≈5MB) → summoner.json → item.json` 全量走网络。国服访问 ddragon 经常超时, 代码已有重试(600ms 间隔 ×3) 和 localStorage 兜底(**只缓存了符文图标**), 但英雄/装备/召唤师技能 JSON 每次都要等网络。
- 影响: 慢网时首屏(英雄库/克制页)空白数秒, 直接决定"打开卡不卡"的第一印象。
- 建议: 主进程把 `champion.json / summoner.json / item.json` 按版本号落盘到 `userData/gamedata/<version>/`, 启动先读盘立即渲染, 后台静默比对最新版本号, 有新版再更新。

### P0-2  实时对局页每次进入拉 10 人 × 100 场 SGP = 单次 3~6MB
- 位置: `renderer/js/app.js:2141` (`renderLiveFromGameflow` 内 10 个并发 `sgpMatchHistory(...,0,100)`)
- 现象: 每次进入一局(或切回实时页且 key 变化)会并发拉 10 名玩家各 100 场战绩 → 约 1000 条对局记录, 单场 3-5KB → 3-6MB JSON。虽有 `livePlayersCache` 防同局重复, 但**跨局、跨会话不缓存**。
- 影响: 加载页/对局页首开慢、吃带宽; 对局密集时每局都重拉。
- 建议:
  1. 实时页用途只是"近况参考", 100 场改成拉 **20~30 场**即可(近 5 场胜负/英雄/KD 展示需要), 请求体降 70%+;
  2. 加 **按 puuid 的磁盘/内存 TTL 缓存** (如 10 分钟), 同会话切账号/多局直接命中;
  3. 10 并发改为 **3 并发批量**(SGP 服务器 22 个区共用, 别一次打满)。

### P0-3  悬浮窗 1.5s 整块 innerHTML 重建
- 位置: `main/overlay.js` pump(1.5s) + `renderer/overlay/overlay.js` `renderLive()` 每次把整个 `#ovTeams` 的 10 行(含头像/装备 img)全部重建
- 影响: 常驻叠加层每秒级重建 DOM → CPU/GPU 抖动、掉帧, 还可能与游戏抢资源(笔记本/核显明显)。
- 建议: 行骨架(英雄/名字/位置)只在玩家或阶段变化时重建; 每 tick 只更新 KDA/补刀/金币/时间/比分/计时这些**数字节点** (`querySelector` 后改 `textContent`)。预估 CPU 占用降 60%+。

### P1-4  LCU 与 SGP 全部无 keep-alive, 每请求新握手
- 位置: `main/lcu.js` `rawRequest` / `main/sgp.js` 均 `https.request` 无 agent
- 影响: 本地 LCU 请求多(TLS 握手是纯开销), SGP 跨公网握手成本更高(匹配 → ready-check 高频轮询场景被放大)。
- 建议: 两处各建一个 `https.Agent({ keepAlive: true, maxSockets: 6 })` 复用连接。本地 LCU 收益尤其直接(毫秒级握手消失)。

### P1-5  nameCache / rankCache 只存在内存, 重启即失效
- 位置: `renderer/js/app.js:468/491`
- 现象: 每次启动、每切一次账号, 所有查过的名字/段位都要重新 LCU 请求; 克制页/对局列表/悬浮窗都反复触发。
- 建议: 段位/名字短 TTL(如 5-10 分钟)持久化到 `poro-config.json` 或独立 JSON, 命中即免网络。克制页、战绩页、实时页、悬浮窗四类入口共用收益。

### P1-6  所有图标直连 ddragon, 国服体验差
- 位置: `app.js:14/39` + 详情页 spell/item/rune 图 + overlay 同
- 现象: 主界面英雄头像/技能/装备图全走 `ddragon.leagueoflegends.com`, 国服普遍超时 → `onerror` 隐藏或重试, 页面看起来"图没刷出来"。
- 建议: 参考 overlay 已加的 `communitydragon` 兜底(本次已修), 把 `champImg()/itemIcon()/spellIcon()` 统一升级为 **ddragon → communitydragon 两级 fallback**, 并把成功路径的图 URL 用 `<link rel=preload>` 或 img `loading=lazy` 策略化加载。

### P2-7  轮询/事件杂项(低优先级, 可保持现状)
- 4s `pollLoop`: 频率合理, 且有"展开详情时跳过整页重渲染"保护, **不必改**;
- 首页 100 场统计: 单用户一次性, 已有 `homeStatsLoaded` 防抖, **可接受**; 若求快可降 60 场;
- 战绩详情 SGP SUMMARY/DETAILS: 展开才拉, 合理;
- `console.log` 每次 LCU 请求打印 body 前 300-500 字: 高频时刷日志, 建议降为仅 DEBUG 或截断到 120 字(对性能影响小但对排障噪音大)。

---

## 三、建议落地顺序(收益/成本)

| 序号 | 动作 | 收益 | 成本 | 风险 |
|---|---|---|---|---|
| 1 | P0-2a: 实时页 SGP 100→30 场 | 请求体 -70%, 首开提速明显 | 低(改一个参数+缓存) | 极低 |
| 2 | P0-2b: puuid TTL 缓存(内存即可先上) | 跨局免重拉 | 低 | 低 |
| 3 | P1-4: LCU/SGP keep-alive agent | 高频轮询毫秒级省握手 | 低(几行) | 低 |
| 4 | P0-1: game-data JSON 落盘缓存 | 启动首屏秒开 | 中(main 进程加文件缓存) | 低(版本号比对兜底) |
| 5 | P0-3: 悬浮窗增量更新 | CPU/GPU 掉帧消失 | 中(渲染层重构一行更新) | 中(需实测对局回归) |
| 6 | P1-5: 名字/段位 TTL 持久化 | 克制/战绩/悬浮窗全面提速 | 中 | 低 |
| 7 | P1-6: 图标 CDN 双 fallback | 国服图全出 | 低-中(逐函数替换) | 低 |

> 建议先做 1+2+3(半小时内可完成、风险极低、用户可立即感知), 再做 4, 最后做 5~7 视验收效果。

---

## 四、度量建议

改前/改后建议用同一把尺子验收(开发者工具 Performance/Network):
- 冷启动到首页数据可交互秒数
- 实时对局页从进入(或对局 GameStart 自动跳转)到 10 人战绩刷完秒数
- 悬浮窗开启后任务管理器 GPU/CPU 占用
- 单局内 SGP 网络请求总字节数(Network 面板)
