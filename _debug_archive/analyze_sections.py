"""拆分前的安全检查: 判断某个行区间能否安全地搬到独立模块。

渲染层是 file:// + 全局作用域, 拆分真正会踩的坑只有两类:
  A. 搬走的区间里有"加载时就执行"的顶层语句, 而它引用了 app.js 里的声明
     -> 新模块在 app.js 之前加载, 执行到那行时 app.js 的 let/const 还在 TDZ, 直接 ReferenceError。
  B. app.js 剩下的顶层语句引用了被搬走的 let/const
     -> 同理, 搬走后 app.js 执行到那行时该绑定还没初始化。
只要这两类都为空, 拆分就是语义等价的 (函数声明会被提升到各自脚本的全局, 调用时机不受影响)。

用法:
  python analyze_sections.py 3910 4381
  python analyze_sections.py --all      # 逐个分节给出结论
"""
import re
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "renderer", "js", "app.js")

DECL = re.compile(r"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"
                  r"|^(?:let|const|var|class)\s+([A-Za-z_$][\w$]*)")
TOPSTMT = re.compile(r"^[A-Za-z_$]")
NOT_STMT = re.compile(r"^(?:async\s+)?function\s|^(?:let|const|var|class)\s")
SECTION = re.compile(r"^// =+ .+ =+$")


def load():
    with open(APP, encoding="utf-8") as f:
        return f.read().split("\n")


def decls_of(lines):
    """name -> 行号 (只取首个声明处)"""
    out = {}
    for i, ln in enumerate(lines):
        m = DECL.match(ln)
        if m:
            name = m.group(1) or m.group(2)
            out.setdefault(name, i)
    return out


def top_stmts(lines):
    """顶层可执行语句的行号 (排除声明/注释/收尾符号/空行)"""
    out = []
    for i, ln in enumerate(lines):
        if TOPSTMT.match(ln) and not NOT_STMT.match(ln):
            out.append(i)
    return out


def names_in(text, universe):
    return {n for n in universe if re.search(r"\b" + re.escape(n) + r"\b", text)}


def check(lines, s, e, decls):
    inside = set(range(s, e))
    # 区间内声明的名字
    moved = {n for n, i in decls.items() if i in inside}
    stay = {n for n, i in decls.items() if i not in inside}

    problems = []

    # A. 搬走的区间里, 顶层语句引用了留在 app.js 的声明
    for i in top_stmts(lines):
        if i in inside:
            refs = names_in(lines[i], stay)
            if refs:
                problems.append(("A", i + 1, lines[i].strip()[:100], sorted(refs)))

    # B. 留在 app.js 的顶层语句引用了被搬走的 let/const
    moved_vars = set()
    for n, i in decls.items():
        if i in inside and not re.match(r"^(?:async\s+)?function\s", lines[i]):
            moved_vars.add(n)
    for i in top_stmts(lines):
        if i not in inside:
            refs = names_in(lines[i], moved_vars)
            if refs:
                problems.append(("B", i + 1, lines[i].strip()[:100], sorted(refs)))

    return sorted(moved), sorted(moved_vars), problems


def main():
    lines = load()
    decls = decls_of(lines)

    if "--all" in sys.argv:
        marks = [(i, ln) for i, ln in enumerate(lines) if SECTION.match(ln.strip())]
        print("app.js 共 %d 行, %d 个分节\n" % (len(lines), len(marks)))
        for k, (i, ln) in enumerate(marks):
            e = marks[k + 1][0] if k + 1 < len(marks) else len(lines)
            moved, moved_vars, probs = check(lines, i, e, decls)
            flag = "OK  " if not probs else "!! %d 个隐患" % len(probs)
            print("%-14s 行 %5d-%-5d 声明 %3d (其中 let/const %2d)  %s"
                  % (flag, i + 1, e, len(moved), len(moved_vars), ln.strip()[:60]))
            for kind, lnno, txt, refs in probs:
                print("       [%s] 第 %d 行 引用 %s\n            %s" % (kind, lnno, refs, txt))
        return

    s = int(sys.argv[1]) - 1
    e = int(sys.argv[2])
    moved, moved_vars, probs = check(lines, s, e, decls)
    print("区间 %d-%d: 搬走 %d 个声明 (其中 let/const %d 个)" % (s + 1, e, len(moved), len(moved_vars)))
    print("  声明:", ", ".join(moved) if len(moved) < 40 else "%d 个" % len(moved))
    if not probs:
        print("  结论: 安全 —— 没有加载期跨文件引用, 拆分语义等价")
    else:
        print("  结论: 有 %d 个隐患, 见下" % len(probs))
        for kind, lnno, txt, refs in probs:
            print("    [%s] 第 %d 行 引用 %s\n         %s" % (kind, lnno, refs, txt))


main()
