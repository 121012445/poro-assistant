# 提权（requireAdministrator）评估报告

日期：2026-09-27
结论：**`asInvoker` 改造可行，核心功能在非提权下已实测跑通**；只有"游戏内注入按键"一类功能会失效。

---

## 一、结论摘要

| 问题 | 答案 |
| --- | --- |
| `Poro.exe` 是否强制要求管理员 | **是**，PE manifest 写死 `requireAdministrator` |
| 安装器是否要求管理员 | **否**，是 `asInvoker`（这就是"装完才闪退"的成因） |
| 非提权下能否连上 LCU | **能**，已实测 HTTP 200 |
| 非提权下能否跑完整首页/战绩 | **能**，已实测渲染 100 场 |
| 提权到底支撑了什么 | 只有 3 项，且其中 2 项是**兜底路径** |
| 改 `asInvoker` 的代价 | 游戏内热键 + 聊天预填失效（UIPI 限制），其余全部保留 |
| 推荐方案 | **双包**：主包保持完整功能，另出"受限版"给无法提权的用户 |

---

## 二、实验设计与证据

### 2.1 确认 manifest 差异（静态）

```bash
node -e "const b=require('fs').readFileSync('dist/win-unpacked/Poro.exe');
const i=b.toString('latin1').indexOf('requestedExecutionLevel');
console.log(b.toString('latin1').slice(i,i+120))"
```

| 文件 | manifest 级别 |
| --- | --- |
| `dist/Poro-Setup-1.4.83.exe`（安装器） | `asInvoker` |
| `dist/win-unpacked/Poro.exe`（程序本体） | **`requireAdministrator`** |

**这个组合就是"装完闪退"的成因**：装的时候不要求提权，一切正常；双击启动时才要管理员。

### 2.2 复现"非提权启动失败且无日志"（动态）

从**非提权**进程 `spawn` 该 exe：

```
spawn 失败        : EACCES / errno=-4092      ← Windows 740 ERROR_ELEVATION_REQUIRED
日志文件是否产生  : 否 —— 进程没跑到写日志的地方
```

对照组：`spawn` 一个 `asInvoker` 的 exe（node 自身）→ **成功**。
说明 EACCES 来自 manifest，不是环境或沙箱造成的。

### 2.3 确认本机环境（为什么本机看不出问题）

| 项 | 值 |
| --- | --- |
| `EnableLUA` | 1（UAC 开启） |
| `ConsentPromptBehaviorAdmin` | **0（管理员静默提权）** |
| 当前用户 | `DESKTOP-A79LJB8\kcq`（管理员） |

管理员账户 + 静默提权 → **从不弹框、从不失败**。
所以"我这能用"完全不能说明别人能用。

### 2.4 国服客户端实际形态

| 项 | 值 |
| --- | --- |
| 安装位置 | `D:\WeGameApps\英雄联盟\LeagueClient` —— **不在 `Program Files` 下** |
| `Config` 目录 | `D:\WeGameApps\英雄联盟\Game\Config` —— 非提权下**可写** |
| `lockfile` | size=0（国服写空文件，不可用） |
| 客户端进程完整性级别 | **High IL（提权）** |

进程完整性级别用对照实验判定：从非提权进程读 `Win32_Process.CommandLine`

| 进程 | 命令行可读 | 判定 |
| --- | --- | --- |
| `Poro.exe`（已知 requireAdministrator） | 否 | High IL |
| `LeagueClient.exe` / `LeagueClientUx.exe` | 否 | **High IL** |
| `explorer.exe` | 是 | Medium IL |

### 2.5 决定性实验：非提权下真的调 LCU

在非提权进程里走 `lcu.js` 的文件快路径（读 `*_LeagueClientUx.log` 解析 port/token），
然后真发一次请求：

```
✓ 拿到凭证: port=64458 token长度=22 来源=2026-09-27T03-07-07_5700_32720_LeagueClientUx.log
HTTP 200
✓ LCU 调用成功! 召唤师: 雨未散 等级=2666
```

### 2.6 决定性实验：把 manifest 改成 asInvoker 后非提权实跑

把 `dist/win-unpacked` 完整复制到临时目录，只改副本的 manifest
（`requireAdministrator` → `asInvoker`，等长替换补 11 个空格，**文件大小不变 246320640 字节**），
然后在**非提权**上下文启动：

```
=== APP START ===
[ICON] native image loaded 256x256
[STARTUP] renderer ready softwareRendering=false
[RENDERER] [PERF] home path=network target=self games=100 render=8479ms
[SHORTCUT] unregistered (left InProgress)
```

stdout 侧（LCU 全部成功）：

```
[LCU] << GET /lol-summoner/v1/current-summoner          status=200 len=454
[LCU] << GET /lol-match-history/.../matches?...&endIndex=1  status=200 len=8024
[LCU] << GET /entitlements/v1/token                     status=200 len=1811
[LCU] << GET /lol-ranked/v1/current-ranked-stats        status=200 len=10034
```

**无任何权限错误，无 FATAL。** 进程完整性级别经核对为 **Medium IL（非提权）**，
与正式安装版（High IL）形成对照。测试进程已全部清理，残留 0。

---

## 三、提权到底支撑了什么

逐个代码路径核查（`main/lcu.js`、`game-settings.js`、`win-rect.js`、`hotkey-poller.js`、`native/PoroInput.cs`）：

| 功能 | 实现 | 非提权可用? |
| --- | --- | --- |
| LCU 连接（国服主路径） | `probe()` → 扫 `KNOWN_CLIENT_DIRS` 读日志 | **可用**（已实测） |
| LCU 连接（兜底路径） | `fromProcess()` 用 PowerShell 读进程命令行 | **不可用**（客户端 High IL） |
| 注册表找安装路径 | `reg query HKLM/HKCU` | 可用（只读注册表不需要提权） |
| 战绩 / 档案 / 实时对局 | LCU HTTP + SGP | **可用**（已实测） |
| 浮窗定位 | `win-rect.js` koffi `EnumWindows`+`GetWindowRect` | 可用（读窗口几何不受 UIPI 限制） |
| 游戏设置锁定 | `game-settings.js` 写 `Config\` | **看安装位置**：不在 `Program Files` 下即可用（本机实测可写） |
| 热键第一通道 | Electron `globalShortcut` | 可用，但**游戏窗口聚焦时不触发**（UIPI） |
| 热键第二通道 | `hotkey-poller.js` `GetAsyncKeyState` | 同上受限 |
| **游戏内聊天预填** | `native/PoroInput.exe` `SendInput` | **不可用**（UIPI 拦截跨完整性级别的输入注入） |

**关键结论**：真正需要提权的只有「往游戏窗口注入按键」这一类。
LCU 那条唯一需要提权的 `fromProcess()` 是**兜底**——`probe()` 先走文件扫描，
只有扫描无结果时才轮到它（`lcu.js:123-132`）。

---

## 四、方案对比

| 方案 | 非管理员用户 | 管理员用户 | 改动量 | 风险 |
| --- | --- | --- | --- | --- |
| **A. 保持现状** | **完全无法启动** | 功能完整 | 无 | 持续收到"闪退"反馈 |
| **B. 双包**（推荐） | 受限版可用（除游戏内热键/预填） | 用完整版 | 只改构建配置 | 低 |
| **C. 单包改 asInvoker** | 可用（同上） | **丢失游戏内热键/预填** | 中（需验证降级路径） | 中 |
| **D. asInvoker + 按需自提权** | 可用 | 完整 | 大（需实现重启提权 + 状态迁移） | 高 |

### 推荐：方案 B（双包）

- **主包**：保持 `requireAdministrator`，功能完整。README 已写明需要管理员权限。
- **受限版**：`requestedExecutionLevel: "asInvoker"`，供无法提权的用户使用，
  在安装包名与关于页明确标注"受限版：游戏内热键与聊天预填不可用"。
- 好处：管理员用户零损失；非管理员用户从"完全不能用"变成"只少两个功能"。

构建侧只需要一份额外的 electron-builder 配置（或 `--config` 覆盖
`win.requestedExecutionLevel`），**运行时代码零改动**。

---

## 五、尚未验证的部分（诚实声明）

- **游戏内热键与聊天预填的失效**是依据 Windows UIPI（跨完整性级别输入注入被拦截）
  的**既有规则**推断的，不是本轮实测。原因：验证它必须向正在运行的游戏注入按键，
  会干扰用户当前对局，故未做。
  若要确认，需在一局大乱斗里用受限版按一次聊天快捷键，观察 `PoroInput.exe` 的返回。
- **浮窗定位**在非提权下的表现未实测（需要选人界面）。按 UIPI 规则，读取窗口几何
  不受限制，理论上可用。
- 本轮实验只覆盖了 **WeGame / 国服 + 非 `Program Files` 安装路径**这一种组合。
  Riot 直装、以及游戏装在 `Program Files` 下的机器需另测（后者会导致设置锁定功能不可用）。

---

## 六、复现步骤

```bash
# 1. 确认 manifest
node -e "const b=require('fs').readFileSync('dist/win-unpacked/Poro.exe');
const i=b.toString('latin1').indexOf('requestedExecutionLevel');
console.log(b.toString('latin1').slice(i,i+120))"

# 2. 复现"非提权启动失败 + 无日志"（需在非提权 shell 里跑）
node "D:/WorkBuddy工作区/temp/poro_elev_probe.js" "D:/lol-assistant/dist/win-unpacked/Poro.exe" "D:/WorkBuddy工作区/temp/probe-data"

# 3. 生成 asInvoker 副本（复制 + 等长替换 manifest）
node "D:/WorkBuddy工作区/temp/poro_make_noelev.js"

# 4. 非提权实跑受限版
"D:/WorkBuddy工作区/temp/poro-noelev/Poro.exe" --disable-gpu --disable-software-rasterizer \
  --no-sandbox --user-data-dir="D:/WorkBuddy工作区/temp/poro-noelev-data"
```

脚本与副本位置：

| 用途 | 路径 |
| --- | --- |
| 提权失败复现脚本 | `D:\WorkBuddy工作区\temp\poro_elev_probe.js` |
| asInvoker 副本生成脚本 | `D:\WorkBuddy工作区\temp\poro_make_noelev.js` |
| **可直接双击试用的受限版** | `D:\WorkBuddy工作区\temp\poro-noelev\Poro.exe`（371 MB 副本） |
| 非提权 LCU 连通性测试 | `D:\WorkBuddy工作区\temp\poro_lcu_unelev.js` |
| 环境探测脚本 | `D:\WorkBuddy工作区\temp\poro_lcu_env.js` |
