# Poro 源码分析（2026-09-27）

> 对象：`D:\lol-assistant`，版本 **v1.4.83**（上次分析时是 1.3.42，十天前）
> 状态：`npm test` 26 个套件全绿 · 安装包与已安装版均为 1.4.83 · 工作区有 28 个未提交文件

---

## 一、规模快照

| 维度 | 数值 | 十天前（1.3.42） |
| --- | --- | --- |
| 版本 | 1.4.83 | 1.3.42 |
| 渲染层 JS | 25 个文件 / **7815 行** | 18 个 / ~4660 行 |
| 主进程 JS | 15 个文件 / **3540 行** | ~10 个 / ~1500 行 |
| 主页面加载的脚本 | 23 个（另 2 个给悬浮窗页用） | 18 个 |
| CSS | style 1215 + premium 575 + extras 318 + dark 59 | style 1184 + extras 97 + dark 48 |
| 顶层函数总数 | 467 个，平均 18 行 | — |
| 渲染层顶层声明 | 532 个名字 | — |
| 测试 | 26 个已接线 + **6 个未接线** | 8 个 |
| 安装包体积 | 112.7 MB | 82.5 MB |

**新增的子系统**（1.3.42 → 1.4.83）：

- **海克斯强化视觉识别**：`main/augment-vision.js`、`augment-recognizer.js`、`augment-ocr-match.js`、`aramkit.js`、`main/native/PoroOcrWorker.ps1`
- **悬浮窗**：`renderer/overlay.html` + `js/overlay.js`、`augment-overlay.html` + `js/augment-overlay.js`、`main/overlay-position.js`、`win-rect.js`
- **数据与状态抽取**：`data-model.js`、`session-state.js`、`performance.js`、`diagnostics.js`
- **进度报告**：`progress-report.js`（`docs/comparable-progress.md`、`docs/role-profile.md` 记录了设计）
- **热键**：`main/hotkey-poller.js`

---

## 二、做得好的地方

先说 positives，这些是真实质量信号，不是客套：

1. **532 个顶层声明零重名。** 渲染层是 23 个 `<script>` 共享全局作用域，重名会**静默互相覆盖**——这是这套架构最大的隐性风险。全量扫描确认目前没有踩到。这个指标值得持续盯。
2. **`test_split_order.js` 还在且通过。** 模块从 18 涨到 23，跨脚本 TDZ 的风险面跟着变大，这个静态守卫（549 条顶层语句 / 242 个加载期引用）依然 zero finding。
3. **`main/index.js` 1556 行但有 17 个清晰分节。** 大不等于乱，这个文件是反例证明。
4. **CSP 克制**：`object-src 'none'`、`frame-src 'none'`、`base-uri 'none'`、`form-action 'none'`，img/connect 白名单只放开 ddragon 与 communitydragon。
5. **无 TODO / FIXME / XXX / HACK 残留**（全库 0 处）。`console.log` 仅 26 处。
6. **XSS 面收敛**：`escapeHtml(` 调用 100 次 > `innerHTML` 赋值 80 处，说明转义是默认动作而非例外。
7. **产物链路一致**：源码 1.4.83 → `dist/Poro-Setup-1.4.83.exe` → 已安装 `D:\lol-assistant\Poro` 同为 1.4.83，141 个文件。

---

## 三、发现的问题（按严重度）

### P1 · 6 个测试写了但没接线，等于不跑

```
test_eog_ledger.js      通过（未接线）
test_home_identity.js   通过（未接线）
test_match_premade.js   通过（未接线）
test_profile_refresh.js 通过（未接线）
test_progress_report.js 通过（未接线）
test_rank_recovery.js   通过（未接线）
```

六个文件单独跑**全部通过**，但都不在 `package.json` 的 `test` 脚本里。它们覆盖的恰恰是近期改动最密的区域（EOG 账本、玩家身份、组队推断、档案刷新、进度报告、段位恢复）——**回归保护实际上是空的**。

而且这些文件还是 untracked，等于两头不靠：既不执行，也没进版本控制。

> 建议：接进 `npm test`，并加一条守卫——扫描 `test_*.js`，凡是不在 `test` 脚本里的就报错。这样以后不会再漏。

### P2 · `home.js` 1807 行，重新长成了单体

十天前它是 1292 行，现在 1807 行、73 个顶层函数。更麻烦的是结构：

- 全文件只有 **3 处分节注释**（第 5 / 31 / 83 行），**第 83 行之后 1720 行没有任何分节**
- 单个函数 `loadHomeStats` 长达 **519 行**（1215–1735），是全库最大的函数

73 个函数的名字能看出很清晰的自然边界，已经具备拆分条件：

| 聚类 | 代表函数 | 约行数 |
| --- | --- | --- |
| 段位 / MMR / 海斗自校准 | `rankTierCN` `mmrFromRanked` `mmrAram` `jadeCalib*` `mmrJadeEstimate` `renderRankCards` `buildHomeMmr` | ~180 |
| 滚动与展开态保持 | `preserveHomeScroll` `restoreHomeScroll` `resumeDeferredHomeRefresh` | ~65 |
| Coach + 趣味道据 | `buildHomeCoach` `refreshHomeCoach` `deriveHomeFunStats` `buildHomeFunStats` | ~300 |
| 搜索 | `homeSearchMarkup` `showHomeSearchCards` `rememberHomeSearch` | ~45 |
| 平台 / 名字 / 段位解析 | `getPlatformId` `findSgpPlatform` `normalizeGame` `resolveNames` `resolveRanks` | ~235 |
| EOG 待处理对局 | `eogStat` `normalizeEogGame` `pendingEogKey` `mergePendingEogGames` | ~95 |
| 首页渲染 | `buildHomeGameCard` `renderHomeGameList` `filterHomeGames` `readHomeSelfCache` | ~300 |
| **主流程** | `loadHomeStats` | **~520** |

> 建议顺序：**先把 `loadHomeStats` 拆成若干步骤函数**（这一步收益最大、风险最低），再按上表把聚类抽成模块。不要一次性全抽——一次一个模块，抽完跑 `npm test` + CDP 探针。

### P2 · 12/23 个脚本的缓存戳已过期

| 文件 | 缓存戳 | 实际改于 |
| --- | --- | --- |
| `bench.js` | 2026091602 | 09-27 |
| `app.js` | 2026091602 | 09-26 |
| `lcu-events.js` | 2026091602 | 09-26 |
| `chat.js` | 2026091602 | 09-25 |
| `compliance.js` / `settings.js` | 2026091602 | 09-21 |
| `history.js` | 2026091602 | 09-19 |
| `diagnostics.js` | 2026092101 | 09-27 |
| `home.js` | 2026092102 | 09-27 |
| `hex.js` | 2026092202 | 09-27 |
| `utils.js` | 2026092601 | 09-27 |
| `progress-report.js` | **无戳** | 09-26 |

戳的分布是 09-16（9 个）、09-21（5 个）、09-22（1 个）、09-26（7 个）、无（1 个）——明显是想到才加，没有统一刷新。最旧的落后 11 天。

> 影响：打包后做 in-place 升级时，`file://` 的 URL 没变，Chromium 可能继续用旧副本；开发时也会出现"改了没生效"的假象。
> 建议：出包前统一刷新全部戳（例如统一成同一个日期串），并把这一步写进 `check_build.js`——现在 `check_build.js` 只查文件存在性，不查戳。

### P3 · 其他超长函数

```
268 行  live.js    renderLiveFromGameflow
178 行  hex.js     scanCurrentAugmentOffers
171 行  home.js    deriveHomeFunStats
141 行  hex.js     renderOpggGameDetail
141 行  main/augment-recognizer.js  createRecognizer
110 行  main/index.js  createWindow
```

全库 467 个函数平均 18 行，只有 2 个超过 200 行、7 个超过 100 行——整体是健康的，上面这几个是明确的离群点。

### P3 · 工作区又有 28 个文件未提交

20 个已跟踪文件被修改（`home.js` +480、`hex.js` +153、`utils.js` +61、`bench.js` +44），外加 8 个 untracked（含 `progress-report.js`、`docs/`、6 个孤儿测试）。

这和 09-17 那次发现的是**同一型问题**：一次性产物容易只落工作区。上一次提交后十天的工作目前没有保护。

### P3 · `test_audit.js` 的假阳性仍在

输出里那行 `== HTML 调用但 app.js 未定义的函数 ==` 后面跟着 `if, setTimeout, if, if, if`——正则把 `if (` 当成函数调用了。噪音不大，但会让人习惯性忽略这块输出，等真出问题就看不见了。

---

## 四、建议的处理顺序

| 顺序 | 事项 | 成本 | 收益 |
| --- | --- | --- | --- |
| 1 | 6 个孤儿测试接进 `npm test` + 加"漏接线"守卫 | 低 | 高（直接补上回归保护） |
| 2 | 出包前统一刷新缓存戳 + `check_build.js` 校验 | 低 | 中 |
| 3 | 提交当前 28 个文件 | 低 | 高（防止再丢） |
| 4 | 拆 `loadHomeStats`（519 行）为步骤函数 | 中 | 高 |
| 5 | `home.js` 按聚类抽模块（一次一个） | 中 | 中 |
| 6 | 修 `test_audit.js` 的 `if(` 假阳性 | 低 | 低 |
| 7 | `renderLiveFromGameflow` / `scanCurrentAugmentOffers` 拆分 | 中 | 中 |

前三项是几分钟的事，建议先做掉；4–5 是真正的重构，需要一次一个模块地推进并逐级验证。

---

## 五、验证手段现状

上次建立的验证链仍然有效，且已随项目长大：

- `npm test`：26 个套件
- `test_split_order.js`：23 模块加载顺序静态守卫（含 `--dump` 诊断开关）
- CDP 真机探针 `_debug_archive/probe_renderer.js`：可指向源码版 / `dist` 打包产物 / 已安装 exe 三处
- `_debug_archive/asar` 内容校验（`poro-dev` 技能里的 `asar_ls.js`）

拆 `home.js` 时建议沿用上次的节奏：抽一个模块 → `npm test` → CDP 探针 36 项全绿 → 再抽下一个。
