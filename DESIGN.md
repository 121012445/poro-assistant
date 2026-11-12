# Design System: Poro

Poro 是英雄联盟桌面助手（Electron，classic script 架构，非组件框架）。
界面的使用场景是 **Operate**：玩家在选人/对局间隙扫一眼就想拿到结论，不是来欣赏页面。
所以这套规范的第一目标是一致与可扫读，不是表达。

按此判断一切取舍：**同一类信息必须长得一样；不同层级必须一眼可分。**

---

## 1. 层叠真源（改动前必读）

6 个样式表按此顺序加载，后加载者赢：

```
style.css → extras.css → dark.css → premium.css → ui-polish.css → ui-system-v3.css
```

**`ui-system-v3.css` 里的 `:root` 才是生效的那一份。** 它重定义了
`--radius` / `--radius-sm` / `--radius-xs` / 全部颜色令牌，`premium.css` 顶部那套同名
变量在同名属性上是死代码。

实际生效值：

| 令牌 | premium.css 写的 | 实际生效（ui-system-v3） | 用途 |
|---|---|---|---|
| `--radius` | 12px | **6px** | 卡片、面板、缩略图 |
| `--radius-sm` | 8px | **4px** | 按钮、输入框、次级容器 |
| `--radius-xs` | 6px | **3px** | 徽章、标签、指标胶囊 |

圆角只有这 3 档 + `999px`（胶囊/圆形）+ `0`。硬编码 px 值已被脚本收敛，
新增样式一律用 `var(--radius*)`；写裸数字会在 `test_ui_tokens.js` 里被拦。

改圆角/颜色请改 `ui-system-v3.css`；只改 `premium.css` 不会有效果。
**不要再新增第三个 `:root` 覆盖层。**

字号令牌是唯一例外：`--fs-*` 只在 `premium.css` 定义，`ui-system-v3.css` 不碰它。

---

## 2. Typography

字体族：`"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif`
（中文回退依赖 Microsoft YaHei UI，不要改成 Inter 之类的纯拉丁字体。）

**只允许取这 9 档，不允许出现阶梯外的值。**

| 令牌 | 值 | 用途 |
|---|---|---|
| `--fs-2xs` | 10px | 极密集数字：KDA、时间戳、表格微指标。**这是下限** |
| `--fs-xs` | 11px | 角标、次要标签 |
| `--fs-sm` | 12px | 列表副文本、卡片标签 |
| `--fs-md` | 13px | 次要正文、按钮 |
| `--fs-base` | 14px | 正文基准（`body` 取值） |
| `--fs-lg` | 16px | 区块标题 |
| `--fs-xl` | 20px | 页面主标题 |
| `--fs-2xl` | 24px | 卡片主数值 |
| `--fs-3xl` | 30px | 大屏统计数字 |

规则：

- **低于 10px 一律禁止。** Windows 150% 缩放下 9px 会落在半像素上，文字发虚，
  这是界面"显得廉价"的首要来源，不是审美问题。
- `<small>` 已设 `font-size: max(10px, .8333em)` 兜住浏览器默认的 `smaller`。
  想更小就改用 `--fs-2xs`，不要依赖标签默认值。
- 数字列（KDA、伤害、经济）必须带 `font-variant-numeric: tabular-nums`，
  否则逐行数字左右不对齐。
- 层级的差别用 size **加** weight **加** color 一起做，不要只靠字号。

---

## 3. Spacing

基准 **2px**（不是 8 也不是 4）。桌面密集数据面板的步进必须比网页细，
4px 会把 5/6/7px 全挤到同一档，反而丢掉节奏。

实际取值集合（收敛后）：`2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 32 40`

规则：

- **禁止奇数 px。** 1px 仅允许用于 1px 内缩补偿与边框，不得出现在区块间距上。
- 同类元素必须同间距：卡片内 padding、卡片间 gap、区块间 margin 各自一个值。
- 亲疏用间距表达，不要用加边框/加卡片来表达分组。

---

## 4. 层与浮层

`z-index` 已收敛为 8 档语义 token，定义在 `ui-system-v3.css`。**禁止再写裸数字。**

| 令牌 | 值 | 用途 |
|---|---|---|
| `--z-base` | 1 | 卡片内部相对抬升（头像、粘性表头） |
| `--z-badge` | 2 | 压在图片/头像上的小徽章 |
| `--z-sticky` | 10 | 粘性侧栏标题 |
| `--z-popover` | 20 | 卡片内下拉、速选面板、主题选择器 |
| `--z-overlay` | 40 | 全屏遮罩（模态遮罩、出装遮罩、抽屉遮罩） |
| `--z-modal` | 50 | 模态框、详情浮窗、出装浮窗主体 |
| `--z-toast` | 70 | 全局提示、临时告警 |
| `--z-top` | 90 | 最上层瞬时浮层（指标浮层） |

新增浮层只能挂到上面 8 档之一；不够用说明层级设计有问题，不要发明第 9 档。

---

## 5. 硬性禁令

1. 不写 `<10px` 的字号。
2. 不写奇数 px 的 padding/margin/gap。
3. 不在 `premium.css` 之外新增 `:root` 覆盖。
4. 不用 `!important` 解决优先级（全站已有 19 处，只减不增）。
5. 不给同一语义的卡片叠加多层容器（卡中卡）。
6. 不用渐变文字、色晕、发光阴影做装饰。

---

## 6. 门禁（改完必跑）

```bash
node test_ui_tokens.js      # 字号下限 10px / 9 档令牌齐全 / 主题隔离
node test_live_compact.js   # 1200x800 必须露出 7 场，1440x900 露出 9 场
node test_behavior_tags.js  # 玩家标签语义
node check_build.js

# 真机几何：标签行不得压住战绩列表（三档宽度）
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS node D:/poro-build/verify/live_tags_geometry.js

# 全站巡检：横向溢出必须为 0，<10px 元素必须为 0
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS node D:/poro-build/verify/ui_page_audit.js after
```

---

## 7. 已知未做的债

按影响排序，下一轮再动：

1. `.lp-profile-line` 在 `premium.css` 有 27 处选择器、6 次重复定义同一批属性
   （1688–1410 区间交错覆盖），改一处要读五处。收敛需要删旧的层，风险高于纯样式改动。
2. 首页数字卡片里「1259 / 1045 / 2093」三行堆叠，数值行数与相邻卡片不一致，破坏横向对齐。
3. 玩家名允许换行（`#page-live .lp-name` 显式 `white-space: normal`，为长 ID 不吞字）。
   代价是长名卡片的头部参差。若改为单行省略号能立刻变整齐，但那会牺牲长 ID 可见性，
   属内容取舍，需产品确认。

---

## 8. 变更记录

**1.5.126（本次）**

- 圆角：15 种硬编码取值（2/3/4/5/6/7/8/9/10/11/12/14/16/20/24px）258 处收敛为
  `--radius` 6px / `--radius-sm` 4px / `--radius-xs` 3px 三档 + 胶囊 999px；
  token 使用从 67 处升到 307 处。整体从 8/6/4 收到 6/4/3，密集面板更利落。
- 层级：19 处 `z-index` 的 13 个互不相关取值收敛为 8 档语义 token。
- 字号：380 处硬编码收敛为 token；9/9.5/10.5/11.5/12.5px 全部消灭，
  阶梯外取值从 8 个降到 0 个；全站渲染态 `<10px` 元素 8 页清零。
- 间距：255 处奇数值归偶；间距取值从 30 个降到 17 个（奇数仅剩 1px 微调）。
- 门禁：字号下限由 9px 提到 10px，令牌检查由 8 档提到 9 档。
- 修复：`<small>` 默认 `smaller` 导致的 9.17px；图表 SVG 轴标签 9px；
  两个游戏内覆盖层页面（`augment-overlay.html`、`game-live.html`）的内联样式
  最小字号 8/9px → 10px。
