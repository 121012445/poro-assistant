"""按分节注释把 renderer/js/app.js 的若干区间抽成独立模块, 并维护 index.html 的加载顺序。

为什么用脚本而不是手工删改: 要搬的是几千行, 手工 Edit 极容易错位;
而且 index.html 的 script 顺序必须与原来的相对顺序一致, 手工同步迟早漏。

用法:
  python split_renderer.py --list            只列出 app.js 的分节, 不修改任何文件
  python split_renderer.py bench             执行 bench 批次
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "renderer", "js", "app.js")
HTML = os.path.join(ROOT, "renderer", "index.html")
CACHE_STAMP = "2026091601"

# 批次定义: 批次名 -> [(输出文件, 一句话说明, [(起始分节标记, 结束分节标记), ...]), ...]
# 结束标记那行本身**不**属于本模块 (它是下一个模块的开头)。
BATCHES = {
    "bench": [
        ("js/bench.js", "备战区倒计时 + 一键换英雄 (大乱斗/海斗)",
         [("// ========== 备战区抢英雄倒计时 (大乱斗/海斗, 纯本地提示) ==========",
           "// ========== 锁定游戏设置 (Seraphine 风格) ==========")]),
    ],
    # 入口 (页面切换 / 初始化 / 快捷键) 故意留在 app.js:
    # 快捷键那节末尾是 document.addEventListener("DOMContentLoaded", init), 引用 app.js 自己的 init,
    # 搬走就会变成在 app.js 之前执行 -> init 还不存在。
    "rest": [
        ("js/champions.js", "英雄数据 / 强度 / 网格 / 详情",
         [("// ========== op.gg 英雄数据 ==========", "// ========== 召唤师段位 (合并到首页) ==========")]),
        ("js/home.js", "首页: 段位 / 海斗自校准 / 玩家数据统计 / op.gg 风格渲染",
         [("// ========== 召唤师段位 (合并到首页) ==========", "// ========== 赛后复盘: 魄罗评分 + SGP 时间线图表 + AI 分析 ==========")]),
        ("js/review.js", "赛后复盘 + AI 复盘",
         [("// ========== 赛后复盘: 魄罗评分 + SGP 时间线图表 + AI 分析 ==========", "// ========== 主题切换 ==========")]),
        ("js/theme.js", "主题切换",
         [("// ========== 主题切换 ==========", "// ========== 海克斯大乱斗强化 (HexBox 式自采样本库) ==========")]),
        ("js/hex.js", "海克斯大乱斗强化 + 克制关系",
         [("// ========== 海克斯大乱斗强化 (HexBox 式自采样本库) ==========", "// ========== 战绩查询 ==========")]),
        ("js/history.js", "战绩查询 + 对局详情",
         [("// ========== 战绩查询 ==========", "// ========== 实时对局 (Live Client Data + 倒计时) ==========")]),
        ("js/live.js", "实时对局",
         [("// ========== 实时对局 (Live Client Data + 倒计时) ==========", "// ========== 合规模式 (一键停用所有自动化, 仅保留只读功能) ==========")]),
        # 合规模式里有顶层语句 Object.keys(allChampions) -> 依赖 champions.js 先加载 (顺序已保证)
        ("js/compliance.js", "合规模式",
         [("// ========== 合规模式 (一键停用所有自动化, 仅保留只读功能) ==========", "// ========== 黑名单系统 ==========")]),
        ("js/blacklist.js", "黑名单: 系统 / 页面 / 持久化",
         [("// ========== 黑名单系统 ==========", "// ========== 观战功能 =========="),
          ("// ========== 黑名单持久化 ==========", "// ========== 历史遭遇持久化 ==========")]),
        # 对局历史遭遇标记 与 历史遭遇持久化 必须同模块: 后者在顶层对前者的 addEncounter 做包装
        ("js/social.js", "观战 / 玩家标记 / 遭遇记录",
         [("// ========== 观战功能 ==========", "// ========== 对局内聊天 (参考 LeagueAkari: 先从 conversations 识别对局会话, 再向会话发消息) =========="),
          ("// ========== 对局历史遭遇标记 ==========", "// ========== 自动BP =========="),
          ("// ========== 历史遭遇持久化 ==========", "// ========== 持久化存储 (userData/poro-config.json, 首次运行自动从 localStorage 迁移) ==========")]),
        ("js/chat.js", "对局内聊天 + KDA 简报",
         [("// ========== 对局内聊天 (参考 LeagueAkari: 先从 conversations 识别对局会话, 再向会话发消息) ==========", "// ========== 对局历史遭遇标记 ==========")]),
        ("js/autobp.js", "自动 BP",
         [("// ========== 自动BP ==========", "// ========== LCU WebSocket 事件驱动 (轮询仅作兜底) ==========")]),
        ("js/lcu-events.js", "LCU WebSocket 事件驱动",
         [("// ========== LCU WebSocket 事件驱动 (轮询仅作兜底) ==========", "// ========== 锁定游戏设置 (Seraphine 风格) ==========")]),
        ("js/settings.js", "锁定游戏设置 + 自动符文",
         [("// ========== 锁定游戏设置 (Seraphine 风格) ==========", "// ========== 黑名单持久化 ==========")]),
        ("js/persist.js", "持久化存储 + 配置同步 + 对局看板增强",
         [("// ========== 持久化存储 (userData/poro-config.json, 首次运行自动从 localStorage 迁移) ==========", "// ========== 快捷键 ==========")]),
    ],
}


def read_lines(p):
    with open(p, "r", encoding="utf-8") as f:
        return f.read().split("\n")


def list_sections(lines):
    out = []
    for i, ln in enumerate(lines):
        if re.match(r"^// =+ .+ =+$", ln.strip()):
            out.append((i + 1, ln.strip()))
    return out


def resolve_unique(lines, marker):
    """按整行精确匹配定位分节标记, 且必须唯一。"""
    hits = [i for i, ln in enumerate(lines) if ln.strip() == marker]
    if len(hits) != 1:
        raise SystemExit("分节标记出现 %d 次 (期望恰好 1 次): %s" % (len(hits), marker))
    return hits[0]


def main():
    lines = read_lines(APP)

    if "--list" in sys.argv:
        print("== app.js 分节 (%d 行) ==" % len(lines))
        for n, txt in list_sections(lines):
            print("  %5d  %s" % (n, txt))
        return

    batch = None
    for a in sys.argv[1:]:
        if a in BATCHES:
            batch = a
    if not batch:
        raise SystemExit("用法: split_renderer.py <批次名> | --list\n可用批次: " + ", ".join(BATCHES))

    spec = BATCHES[batch]

    # 1. 解析所有区间。各模块的区间可能相互交错 (例如"黑名单持久化"夹在 social 的两个区段之间),
    #    所以不能用只向前走的游标, 必须各自独立定位后再统一按行号排序。
    plan = []          # (out_file, desc, start, end)  end 不含
    for out_file, desc, ranges in spec:
        for start_marker, end_marker in ranges:
            s = resolve_unique(lines, start_marker)
            e = resolve_unique(lines, end_marker)
            if e <= s:
                raise SystemExit("区间为空 (结束标记在起始标记之前): %s -> %s" % (start_marker, end_marker))
            plan.append((out_file, desc, s, e))

    plan.sort(key=lambda x: x[2])
    for a, b in zip(plan, plan[1:]):
        if a[3] > b[2]:
            raise SystemExit("区间重叠: %s(%d-%d) 与 %s(%d-%d)" % (a[0], a[2] + 1, a[3], b[0], b[2] + 1, b[3]))

    # 2. 写出模块文件 (按批次里声明的顺序, 保持各模块内部行序)
    for out_file, desc, _ranges in spec:
        chunks = [lines[s:e] for (of, _d, s, e) in plan if of == out_file]
        body = []
        for idx, ch in enumerate(chunks):
            if idx:
                body.append("")
            body.extend(ch)
        # 去掉尾部多余空行
        while body and body[-1].strip() == "":
            body.pop()
        header = [
            "// " + desc,
            "// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,",
            "// 因此 index.html 中必须排在 app.js 之前加载。",
            "",
        ]
        dst = os.path.join(ROOT, "renderer", out_file)
        with open(dst, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(header + body) + "\n")
        print("写出 %-24s %d 行" % (out_file, len(header) + len(body)))

    # 3. 从 app.js 里删掉这些区间
    drop = set()
    for _of, _d, s, e in plan:
        drop.update(range(s, e))
    kept = [ln for i, ln in enumerate(lines) if i not in drop]
    # 合并连续空行, 避免留下大片空洞
    merged = []
    for ln in kept:
        if ln.strip() == "" and merged and merged[-1].strip() == "":
            continue
        merged.append(ln)
    with open(APP, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(merged) + "\n")
    print("app.js: %d 行 -> %d 行 (删除 %d 行)" % (len(lines), len(merged), len(drop)))

    # 4. 维护 index.html 的加载顺序: 新模块插在 app.js 之前, 按批次声明顺序
    html = read_lines(HTML)
    new_tags = ['<script src="%s?v=%s"></script>' % (of, CACHE_STAMP) for of, _d, _r in spec]
    app_idx = next(i for i, ln in enumerate(html) if 'src="js/app.js' in ln)
    # 同一批次重复执行时要幂等: 先删掉已经存在的同名 tag
    for of, _d, _r in spec:
        html = [ln for ln in html if ('src="%s?' % of) not in ln]
        app_idx = next(i for i, ln in enumerate(html) if 'src="js/app.js' in ln)
    html[app_idx:app_idx] = new_tags
    # 统一刷新缓存戳, 避免 file:// 下加载到旧文件
    html = [re.sub(r'\?v=\d+', '?v=' + CACHE_STAMP, ln) if "<script src=" in ln else ln for ln in html]
    with open(HTML, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(html))
    print("index.html 加载顺序:")
    for ln in html:
        if "<script src=" in ln:
            print("   " + ln.strip())


main()
