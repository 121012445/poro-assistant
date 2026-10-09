# Poro 源码分析（2026-10-02）

> 对象：`D:\lol-assistant`，版本 **v1.5.1**（上次分析 1.4.83 / 09-27，再上次 1.3.42 / 09-17）
> 状态：`npm test` **38 个套件全绿**（退出码 0）· 源码 / dist / 已安装 asar 三者字节一致
> **但：当前安装版 v1.5.1 的渲染层初始化链是断的** —— 详见第二节

---

## 一、规模快照

| 维度 | 1.5.1 | 1.4.83 | 1.3.42 |
| --- | --- | --- | --- |
| 渲染层 JS | 27 文件 / **8455 行** | 25 / 7815 | 18 / ~4660 |
| 主进程 JS | 16 文件 / **3765 行** | 15 / 3540 | ~10 / ~1500 |
| CSS | 4 文件 / 2208 行 | 4 / 2167 | 4 / 1388 |
| 测试文件 | **39 个**（38 接线 + 2 个 e2e 显式 opt-out） | 26 接线 + 6 孤儿 | 8 |
| 顶层全局声明 | **570 个，跨文件重名 0** | 532 | — |
| 顶层函数 | 527 个，平均 **18.3 行** | 467 / 18 | — |
| 主页面脚本 | 25 个（另 2 个给浮窗页） | 23 | 18 |
| 代码总量（main+renderer+test） | **18123 行** | — | — |

单文件：`home.js` 1947 · `index.js`(main) 1632 · `hex.js` 1422 · `index.html` 488 · `bench.js` 733

---

## 二、P0：v1.5.1 渲染层初始化在第 209 行断掉

### 症状

`renderer/js/app.js:209` 调用 `loadAramBalance()`，而**这个函数在全库、以及 1.3.40 以来的全部历史 asar 里都不存在**。

```
2026-10-02T08:14:50.844Z [CONSOLE ERR] Uncaught (in promise) ReferenceError: loadAramBalance is not defined
```

### 为什么它是 P0 而不是"一个没用的报错"

`init()` 起于 138 行，`try/catch` **只覆盖到 199 行**。209 行在保护之外：

```js
  } catch (e) {                                  // ← 197-199, try 到这里就结束了
    console.error("初始化失败", e);
  }
  ...
  loadAramBalance();        // ← 209  抛 ReferenceError
  initAutoReturnToggles();  // ← 210  ✗ 不再执行
  restoreSideAnnounceToggle();// ← 211 ✗
  wireLcuEvents();          // ← 212  ✗ LCU 事件不接线
  applyTheme();             // ← 213  ✗
  loadAiConfig();           // ← 214  ✗
  await loadHomeStats();    // ← 217  ✗ 首页不加载
  pollLoop();               // ← 218  ✗ 轮询不启动
```

调用方丢弃了返回值，所以是未处理的 promise rejection：

```js
document.addEventListener("DOMContentLoaded", init);   // app.js:229
```

**结果：程序起得来、窗口画得出来、日志一片祥和，但首页永远停在"连接客户端后显示玩家数据统计"，
LCU 事件与轮询都没接上。**

### 证据链（三条独立证据）

**1）日志对照 —— 同一个日志文件里前后两次启动**

| 启动后 | v1.5.0（15:32 本地） | v1.5.1（16:14 本地） |
| --- | --- | --- |
| +2.0s | `[PERF] home path=cache games=100 render=28ms` | **无** |
| +2.0s | `[SHORTCUT] unregistered` | **无** |
| +6.0s | `[PERF] home path=network render=3836ms` | **无** |
| +6.3s | `[HOME] post-game refresh ready` | **无** |
| +26s 起 | 每 12 秒一次 `[PERF] home ...` | **无** |
| 全程 | 无异常 | `ReferenceError: loadAramBalance` |

v1.5.1 启动后 **4 分钟零日志**（整个 `crash.log` 就停在那一行）。

**2）userData 落盘时间（只看得到"活下来"的那些步骤）**

| 文件 | 时间 | 说明 |
| --- | --- | --- |
| `lockfile` | 16:14:50 | 应用启动 |
| `poro-config.json` | 16:14:51 | `loadStore()` 写配置 —— 209 行**之前** |
| `home-cache-0.json` | **15:54:00** | 首页缓存 —— 停在 v1.5.0 那次会话，v1.5.1 **一次都没写** |

**3）历史 asar 回溯 —— 不是"误删"，是从未存在**

在 `_debug_archive/` 的 5 份历史 asar（1.3.40 / 1.4.83 / 1.4.90 / 1.4.91 / 1.4.95）里逐份搜，
`loadAramBalance`、`balanceTipFor`、`.lp-balance` **全部 0 命中**。它们是 1.5.x 新加进来的调用，
函数体没有跟着写。

### 同源的另一处：`balanceTipFor`

```js
// renderer/js/live.js:579
const balTip = typeof balanceTipFor === 'function' ? balanceTipFor(p.championId) : '';
const balHtml = balTip ? `<span class="lp-balance" title="本模式平衡性调整">${escapeHtml(balTip)}</span>` : '';
```

同样全库无定义，但**有 `typeof` 守卫**，所以不报错、也永远渲染不出东西 —— 静默死功能。
`extras.css` 里的 `.lp-balance` 样式也一并悬空。

### 判定

这两处属于**同一个半成品特性**（"大乱斗/海斗的平衡性调整提示"）。
`loadAramBalance` 是它的加载器，`balanceTipFor` 是它的查表器，模块本身没落地。

**修法二选一**（见第六节）：补完，或摘除调用。

### 为什么 38 个测试一个都没拦住

| 测试 | 覆盖 | 为什么没抓到 |
| --- | --- | --- |
| `test_dangling.js` | **HTML 内联事件** → 函数；`app.js` → preload API | 不检查 **JS → JS 的全局调用** |
| `test_split_order.js` | 加载期 TDZ（引用了后加载模块的声明） | 只管**加载期**；`init()` 是回调，加载期不跑 |
| `test_test_wiring.js` | 测试有没有接进 `npm test` | 与运行期无关 |
| 其余 vm 测试 | 各模块行为 | 都在 `runInContext` 里注入完整环境，不模拟"少一个函数" |

结论：**"调用了但谁都没定义的名字"是当前验证体系的盲区**，而渲染层是 25 个 `<script>` 共享
一个全局作用域，这类错误既无编译期检查、又只在运行时炸。建议补一条静态守卫（见第六节）。

---

## 三、做得好的地方

1. **570 个顶层声明零跨文件重名**（上次 532，从零开始涨）。在 25 个脚本共享全局作用域的架构下，
   重名会静默互相覆盖 —— 这个指标持续干净是真实的工程质量信号。
2. **上次的 P1 已修**：`test_test_wiring.js` 落地，并且用**文件内 `// npm-test: opt-out(原因)`**
   而不是集中白名单 —— 白名单会和文件脱节（文件删了它还在）。这个设计选择是对的。
   `test_chatlive.js` / `test_spectate_e2e.js` 两个有副作用的 E2E 已显式声明 opt-out。
3. **上次建议的超长函数重构做了一部分**：
   `loadHomeStats` 519 → **426 行**，`renderLiveFromGameflow` 268 → 185，`scanCurrentAugmentOffers` 178 → 157。
   全库 201-400 行区间**已经清零**。
4. **提权双包方案（上次的方案 B）已落地**：`dist/` + `dist-limited/`，`test_limited_build.js`
   守住"两边只允许差权限与输出目录"。`docs/elevation-assessment-20260927.md` 里的实验设计
   （等长替换 manifest 造 asInvoker 副本比对）质量很高。
5. **产物链路一致**：源码 1.5.1 → `dist/Poro-Setup-1.5.1.exe` → 安装版 asar，
   `installed == dist == 2028284 字节`。
6. **零 TODO / FIXME / XXX / HACK**；`escapeHtml(` 101 次 > `innerHTML =` 88 处，转义是默认动作。
7. **CSP 克制**：`object-src/frame-src/base-uri/form-action` 全 `'none'`，img/connect 只放开
   ddragon 与 communitydragon。
8. `main/index.js` 1632 行、17 个清晰分节 —— 大而不乱。

---

## 四、其他问题

### P1 · 缓存戳 9 处已过期，且 `check_build.js` 不校验

`index.html` 里 29 个带 `?v=` 的资源，**9 个的戳早于文件实际修改日期**：

```
css/extras.css        v=2026092804   文件改于 10-02 11:48
js/live.js            v=2026092804   文件改于 10-02 15:59
js/lcu-events.js      v=2026092804   文件改于 10-02 16:02
js/app.js             v=2026092804   文件改于 10-02 11:53
js/settings.js        v=2026092804   文件改于 10-02 11:43
js/chat.js            v=2026092804   文件改于 10-02 13:03
js/home.js            v=2026092804   文件改于 09-30 05:53
js/autoreturn.js      v=2026093001   文件改于 10-02 11:45
js/sona-extra.js      v=2026093001   文件改于 10-02 13:04
```

`check_build.js` 里**搜不到任何 `?v=` / stamp / 戳 相关校验** —— 上次分析的第 2 条建议没有落地。
影响：in-place 升级时 `file://` URL 没变，Chromium 可能继续用旧副本，表现为"改了没生效"。

### P2 · `dist-limited` 停在 1.4.96，1.5.0 / 1.5.1 都没有受限版

README 明确承诺"同一版本提供两个安装包"。实际 `dist-limited/` 最新是
`Poro-Setup-1.4.96-limited.exe`（09-30），**落后 5 个版本**。README 的指引现在会误导
无法提权的用户去下载一个不存在的文件。

另注：`electron-builder.limited.js` 与 `dist-limited` 的存在说明两条构建线都在维护，
但 `npm run build:all` 显然没有在最近几次发版时执行。

### P2 · `deploy.js` 与 `npm test` 的测试清单已经漂移

```
npm test        : 38 个
deploy.js TESTS :  9 个 (check_build / bench_alert / overlay_position / security / audit /
                        dangling / split_order / gamedata / game_settings)
```

`deploy.js` 是"改完到上线"的实际入口，它只跑 9 个 —— **最近新增的 29 个测试在上线路径上不执行**。
`test_test_wiring.js` 守的是"`npm test` 内部有没有漏"，守不到"`deploy.js` 跑得比 `npm test` 少"。

### P3 · 根目录碎片文件

```
0)console.log('LINE'      0B    10-02 11:24   ← 无扩展名, .gitignore 不覆盖
fp_out.txt   38B   12:08
hp_out.txt   58B   12:07
k3.txt       65B   12:09
ri_out.txt   1070B 09-30 05:20
```

`*.txt` / `*.log` 已在 `.gitignore` 里，只有那个**名为 `0)console.log('LINE'` 的 0 字节文件**
会出现在 git 视野里（某次 shell 事故的产物）。

### P3 · 最后一次提交之后的改动

`.git/index` 时间 = **09-30 14:33**。此后 **17 个文件**被改动，包括
`renderer/index.html`(16:09) / `package.json`(16:04) / `main/index.js`(15:54) /
`live.js`(15:59) / `app.js`(11:53) / `preload.js`(15:57) 等 ——
约两天的改动没有任何版本控制保护。（本机无 git CLI，改用 index 时间做代理指标，
无法给出精确的 `git status`。）

---

## 五、建议的处理顺序

| 顺序 | 事项 | 成本 | 收益 |
| --- | --- | --- | --- |
| **1** | **修 P0**：确定 `loadAramBalance`/`balanceTipFor` 是补完还是摘除 | 极低 | **极高（当前版本首页是坏的）** |
| 2 | 补一条"未定义全局调用"静态守卫 | 低 | 高（堵住 P0 那类盲区） |
| 3 | 提交当前 17 个改动 | 低 | 高（防止再丢） |
| 4 | `deploy.js` 的 TESTS 直接引用 `package.json` 的 `test` 脚本 | 低 | 中 |
| 5 | 刷新 9 个缓存戳 + `check_build.js` 加校验 | 低 | 中 |
| 6 | 补 1.5.x 的受限版 | 低 | 中（README 承诺） |
| 7 | 拆 `loadHomeStats`（426 行） | 中 | 中 |
| 8 | `home.js` 分节（1947 行只有 5 处 `===` 分节，88→1333 行之间没有分节） | 中 | 中 |

第 1 项是唯一有紧迫性的。第 2 项是防止它再发生的结构性修复，建议和第 1 项一起做。

---

## 六、验证手段现状

- `npm test`：38 个套件（`pretest` 另有 6 个）
- `test_split_order.js`：25 模块加载顺序静态守卫（596 条顶层语句 / 256 个加载期引用）
- `test_test_wiring.js`：测试接线守卫（文件内 opt-out 标记）
- `_debug_archive/probe_renderer.js` / `probe_overlay.js` / `probe_version_ui.js`：CDP 真机探针
- `_debug_archive/deploy.js`：测试 → 打包 → 热替换 → CDP 实测界面版本号

**本次暴露的缺口**：以上全部通过，应用仍然是坏的。原因是所有检查都只覆盖
「加载期」「模块间声明顺序」「HTML 内联调用」三类，没有一条覆盖**运行期的全局函数解析**。

---

## 七、诚实声明（未验证的部分）

- 本文**没有做**真机动态验证（不重启用户正在运行的应用）。P0 的判定依据是
  「静态可证 + 日志对照 + userData 时间线」三条独立证据，不是 CDP 实测。
  若要 100% 确认，重启一次应用后看 `crash.log` 是否出现 `[PERF] home ...` 即可。
- 「这两处是某个正在开发中的特性」是从文件修改时间（`live.js` 15:59 / `app.js` 11:53）
  **推断**的，没有版本控制记录佐证（本机无 git CLI）。
- 移除 `loadAramBalance()` 后能否完全恢复 v1.5.0 行为，是**推断**（该行是本次日志里唯一的异常），
  未实测。
- 本机无 git CLI，未提交清单用 `.git/index` 时间做代理指标，不是 `git status` 的准确输出。

---

## 八、后续处理（2026-10-02 当天完成，v1.5.2）

决议：走**方案 A（摘除死调用）**，不补完特性。共改 4 处代码 + 新增 1 条守卫 + 升级探针，已部署并实测。

### 8.1 摘除清单

| 文件 | 改动 |
| --- | --- |
| `renderer/js/app.js:209` | 删除 `loadAramBalance();`，原位留注释说明（含"将来要做必须同时补函数体，别只加调用"） |
| `renderer/js/live.js:578-580` | 删除 `balTip` / `balHtml` 分支 |
| `renderer/js/live.js:594` | 模板里的 `${balHtml}` 去掉 |
| `renderer/css/extras.css:354` | 删除悬空的 `.lp-balance` 规则 |

复查：安装目录 asar 内 `const balHtml` = false、`${balHtml}` = false、`loadAramBalance()` 调用 = false，
剩余出现全部落在注释里。`main/preload.js` / `main/aramkit.js` 里也确认过**没有**对应的 `balance` 通道 ——
这个特性只在渲染层留了两个悬空引用，没有任何后端残留。

### 8.2 新增守卫 `test_undef_globals.js`

- **按页面分组**校验：`index.html` 的脚本共享一个作用域，`overlay.html` / `augment-overlay.html` 各自独立。
  只做全库并集会掩盖"独立页面调用了它没加载的函数"——那正是浮窗这类功能最可能的坏法。
- 词法器**复用** `test_split_order.js` 的 `blankLiterals`（自制版会栽在 `utils.js` 的正则字面量上）。
- 覆盖两类：无定义的 `foo()` 调用（致命，运行时 ReferenceError）+ `typeof foo ===` 恒假的死分支（静默死功能）。
- **带自检**：合成样本必须先被自己抓到，否则直接失败——防止"测试通过只是因为它什么都没检查"。
- **反向验证过**：临时往 app.js 塞回 bug，守卫以退出码 1 报出 `app.js:209 调用了未定义的 loadAramBalance()`。
- 误报逃生口 `// undef-ok: 原因`（沿用 `test_test_wiring.js` 的就地声明风格，不用集中白名单）。
- 已接入 `npm test`（39 个套件）与 `deploy.js` 的 TESTS（10 个）。

**踩到的坑**：`blankLiterals` 会把字符串字面量清成空格，所以 `typeof X === 'function'` 的检测
**不能**按 `'function'` 字面量匹配（第一版就这么写，永远不会命中）。只认 `typeof X ===` 这个前缀。

### 8.3 探针升级：从"只测版本号"到"版本号 + 启动健康"

这是本次最有价值的一处修复。第 4 项真机验证原来只断言**界面版本号**，而版本号在第 154 行就设置好了
—— **在第 209 行之前**。所以它对"init 被中途掐断"完全无感，这正是 v1.5.0/v1.5.1 能一路绿灯上线的原因。

`probe_version_ui.js` 现在：
- 跑之前先清 `_probe_userdata/crash.log`（追加写，不清会把上一轮的报错算到这一轮头上）
- 跑完扫 crash.log 的 `[CONSOLE ERR]`，命中 `ReferenceError|is not defined|TypeError|SyntaxError|not a function` 即 FAIL
- 新增 `<app.asar>` 模式：应用正在运行时 spawn `Poro.exe` 会 EACCES（镜像被自己占着），
  改用 electron 加载**同一份已安装 asar**，跑到的还是线上 JS 包，验证力等价

**同一份代码、只差一行的对照实验**：

| 受测包 | 版本号检查 | 启动健康检查 | 退出码 |
| --- | --- | --- | --- |
| 好包（已安装 v1.5.2） | 通过 | 通过（零 `[CONSOLE ERR]`） | 0 |
| 坏包（塞回 `loadAramBalance`） | **通过** | **FAIL**（`ReferenceError: loadAramBalance is not defined`） | 1 |

坏包那行"版本号检查通过"就是上一版能放过 P0 的证据。

### 8.4 部署工具链的两个修复

- `_debug_archive/build_asar.js`：解包目录原来用 `fs.cpSync` 一把梭 → 应用运行时 `koffi.node` 被占用，
  整体抛错，**排在它后面的文件一个都没同步到**（本次真实踩到，留下"JS 是新的 / 原生模块是旧的"混合态）。
  改成逐文件按内容比对：一致就跳过，真要更新却写不进去才报错。并把顺序改为**先同步解包目录、再替换 asar**，
  失败即中止 —— 不再产生混合态。
- `package.json` 升到 1.5.2 时，`check_build.js` 拦下了 `package-lock.json` 仍是 1.5.1。
  门禁有效，已同步两处版本号。

### 8.5 状态

- 安装目录 asar = **v1.5.2**，CDP 实测界面 `v1.5.2 · DDragon 16.19`，crash.log 零 `[CONSOLE ERR]`

**正面证据（不只是"没报错"）**：探针启动日志里出现了首页真实发出的请求 ——

```
[LCU] << GET /lol-summoner/v1/current-summoner status=200
[LCU] << GET /lol-match-history/v1/products/lol/<puuid>/matches?begIndex=0&endIndex=1 status=200
[LCU] << GET /lol-ranked/v1/current-ranked-stats status=200
```

这些是 `loadHomeStats()`（**第 220 行，在被掐断的第 209 行之后**）才会发的请求。
修复前它们一次都不会出现 —— 这正是"首页没加载"的直接物证，现在回来了。
- 备份 `app.asar.bak-1.5.1-to-1.5.2-20261002`（内含真正的 pre-fix v1.5.1，可回滚）
- **需重启 Poro 才生效**（托盘退出；当前运行的那 4 个进程仍是 16:14 启动的坏版本）

### 8.6 仍未处理（原建议清单 3-8 项）

第 2 项已做，其余保持原状：17 个改动未提交（本机无 git CLI）、`deploy.js` 的 TESTS 仍与 `npm test`
漂移（10 vs 39）、9 处缓存戳过期且 `check_build.js` 不校验、1.5.x 缺受限版、`loadHomeStats` 426 行、`home.js` 分节。
