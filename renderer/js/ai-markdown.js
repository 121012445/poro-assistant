// AI 复盘文本渲染 (纯函数, 无 DOM / 无 IO)
//
// 为什么单独成文件: 模型返回的是 markdown 片段, 原先把整段塞进 div 用 <br> 换行,
// 结果用户在界面上看到的是 "**复盘分析：**" 这种裸星号 —— 不是模型的问题, 是没渲染。
// 这里只做模型真的会输出的那几种语法: 标题 / 有序无序列表 / 粗体 / 行内代码 / 分隔线,
// 外加把【亮点】【问题】【建议】这类标签抽成彩色 chip, 让每一条要点有可扫读的类别。
//
// 安全: 全量先 escape, 再做白名单替换, 不引入任何第三方 markdown 库
// (渲染层没有模块系统, 也不想为了 5 条要点拖一个 30KB 的解析器进来)。

(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  if (root) root.PoroAiMd = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // 模型常用的分类标签 → 色调。只认小标签, 长句不猜。
  const TAG_TONE = {
    '亮点': 'pos', '胜因': 'pos', '优势': 'pos', '做得好': 'pos', '值得肯定': 'pos',
    '问题': 'neg', '败因': 'neg', '失误': 'neg', '风险': 'neg', '槽点': 'neg', '短板': 'neg',
    '建议': 'acc', '改进': 'acc', '改进点': 'acc', '下一步': 'acc', '优化': 'acc',
    '关键': 'neu', '节点': 'neu', '数据': 'neu', '总评': 'neu', '复盘': 'neu'
  };
  const STYLE_LABEL = { coach: '教练视角', tough: '毒舌视角', formal: '数据分析' };

  // 复述性的大标题: 面板本身已经有「复盘分析」标题, 再渲染一遍只是噪音
  const REDUNDANT_TITLE = /^(复盘分析|对局复盘|对手分析|赛后复盘|比赛复盘)\s*[：:]?$/;

  // 无数字实体的转义 —— 后面要按正则高亮数字, &#39; 里的 39 会被误伤
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
    })[c]);
  }

  // 行内: **粗体** / `代码` / 数字(含 -2757、9.5万、8分钟这类)
  const INLINE_RE = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|(-?\d+(?:\.\d+)?(?:万|千|%|k|K|分钟|秒)?)/g;
  function inline(s) {
    const src = esc(s);
    let out = '';
    let last = 0;
    let m;
    INLINE_RE.lastIndex = 0;
    while ((m = INLINE_RE.exec(src))) {
      out += src.slice(last, m.index);
      if (m[1] != null) out += '<strong>' + m[1] + '</strong>';
      else if (m[2] != null) out += '<code>' + m[2] + '</code>';
      else out += '<span class="rv-md-n">' + m[3] + '</span>';
      last = m.index + m[0].length;
    }
    out += src.slice(last);
    return out;
  }

  // 软换行拼接: 中文之间不加空格 ("很多 直到" 这种空格很出戏), 英文/数字之间保留
  function joinLines(lines) {
    let out = '';
    for (const line of lines) {
      if (!out) { out = line; continue; }
      const cjk = /[\u4e00-\u9fff\uff00-\uffef]$/.test(out) || /^[\u4e00-\u9fff\uff00-\uffef]/.test(line);
      out += (cjk ? '' : ' ') + line;
    }
    return out;
  }

  // 纯文本 (去标签) —— 只用于判定「是不是一句总评」
  function plain(s) {
    return String(s == null ? '' : s).replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim();
  }

  // 把每行分类成块
  function parseBlocks(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n');
    const blocks = [];
    let para = [];
    let list = null;

    const flushPara = () => { if (para.length) { blocks.push({ type: 'p', text: joinLines(para) }); para = []; } };
    const flushList = () => { if (list) { blocks.push(list); list = null; } };
    const flushAll = () => { flushPara(); flushList(); };

    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, '');
      const t = line.trim();
      if (!t) { flushAll(); continue; }

      let m;
      // 分隔线
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushAll(); blocks.push({ type: 'hr' }); continue; }

      // 显式标题 ## / ###
      if ((m = /^#{1,6}\s+(.*)$/.exec(t))) {
        flushAll();
        blocks.push({ type: 'h', text: m[1] });
        continue;
      }

      // 整行只有一个粗体 (模型最常见的"小节标题"写法): **关键节点**
      if ((m = /^\*\*([^*]+?)\*\*\s*[：:]?\s*$/.exec(t))) {
        flushAll();
        blocks.push({ type: 'h', text: m[1] });
        continue;
      }

      // 有序列表: 1. / 1、 / 1)
      if ((m = /^(\d{1,2})\s*[.、)）]\s*(.*)$/.exec(t))) {
        // 整行其实塞了多条: "1. xxx 2. yyy" → 先按编号切开
        const inlineNum = splitNumLine(t);
        if (inlineNum && inlineNum.length > 1) {
          flushPara();
          if (!list) { flushList(); list = { type: 'list', kind: 'ol', items: [] }; }
          for (const seg of inlineNum) list.items.push(seg);
          continue;
        }
        flushPara();
        if (!list || list.kind !== 'ol') { flushList(); list = { type: 'list', kind: 'ol', items: [] }; }
        list.items.push(m[2]);
        continue;
      }

      // 无序列表: - * • ·
      if ((m = /^[-*•·]\s+(.*)$/.exec(t))) {
        flushPara();
        if (!list || list.kind !== 'ul') { flushList(); list = { type: 'list', kind: 'ul', items: [] }; }
        list.items.push(m[1]);
        continue;
      }

      // 引用
      if ((m = /^>\s?(.*)$/.exec(t))) {
        flushAll();
        blocks.push({ type: 'q', text: m[1] });
        continue;
      }

      // 模型经常不按格式输出: 一行一个【标签】、甚至把 5 条全塞进一行。
      // 只要标签出现在句首或标点之后, 就当作一条要点的起点切开。
      const segs = splitTagLine(t) || splitNumLine(t);
      if (segs) {
        flushPara();
        if (!list) { flushList(); list = { type: 'list', kind: 'ul', items: [] }; }
        for (const seg of segs) list.items.push(seg);
        continue;
      }

      // 普通段落: 同一段内的软换行合并, 避免一句总评被拆成三行
      flushList();
      para.push(t);
    }
    flushAll();
    return blocks;
  }

  // 按【标签】切分一行 → 多个条目; 只有一个标签且不在行首时返回 null (交给普通段落)
  function splitTagLine(text) {
    const marks = [];
    const re = /【\s*([^】]{1,6})\s*】/g;
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(0, m.index);
      if (m.index !== 0 && !/[，。；！？、,.;!?\s]$/.test(before)) continue;
      marks.push(m.index);
    }
    if (!marks.length) return null;
    if (marks.length === 1 && marks[0] !== 0) return null;
    return sliceBy(text, marks);
  }

  // 同上的数字编号版: "1. xxx 2. yyy"; 要求至少两个编号才切, 免得把正文里的 "3." 当分隔
  function splitNumLine(text) {
    const marks = [];
    const re = /(^|[。；！？;!?\s])(\d{1,2})\s*[.、)）]\s*/g;
    let m;
    while ((m = re.exec(text))) marks.push(m.index + m[1].length);
    if (marks.length < 2) return null;
    return sliceBy(text, marks);
  }

  function sliceBy(text, marks) {
    const out = [];
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1] : text.length;
      const seg = text.slice(marks[i], end).replace(/^[\s，,；;、]+|[\s，,；;、]+$/g, '');
      if (plain(seg)) out.push(seg);
    }
    return out.length ? out : null;
  }

  // 【亮点】/ [问题] / 建议： 这类前缀抽成 chip
  function splitTag(text) {
    let m = /^【\s*([^】]{1,6})\s*】\s*/.exec(text);
    if (m && TAG_TONE[m[1]]) return { tag: m[1], tone: TAG_TONE[m[1]], text: text.slice(m[0].length) };
    if (m) return { tag: m[1], tone: 'neu', text: text.slice(m[0].length) };
    m = /^\[\s*([^\]\n]{1,6})\s*\]\s*/.exec(text);
    if (m && TAG_TONE[m[1]]) return { tag: m[1], tone: TAG_TONE[m[1]], text: text.slice(m[0].length) };
    m = /^(亮点|胜因|优势|问题|败因|失误|风险|槽点|短板|建议|改进|改进点|下一步)\s*[：:]\s*/.exec(text);
    if (m) return { tag: m[1], tone: TAG_TONE[m[1]], text: text.slice(m[0].length) };
    return { tag: '', tone: '', text };
  }

  // 把模型输出里的 {{P3}} / {P3} 换回英雄名。
  // 为什么不让模型直接写英雄名: 它会把英雄叫错(官方新译名认不全就自己编), 而且改得理直气壮;
  // 让它只写占位符, 名字由我们按英雄 ID 填, 结果才是可验证的。
  function fillPlayers(text, players) {
    const map = {};
    (players || []).forEach(p => { if (p && p.idx != null) map[String(p.idx)] = p.label || ''; });
    const src = String(text == null ? '' : text);
    const pick = (m, n) => (map[n] != null && map[n] !== '' ? map[n] : m);
    return src
      // {{P3}} / {P3} / 【P3】
      .replace(/\{\{\s*[Pp]?\s*(\d{1,2})\s*\}\}/g, pick)
      .replace(/[\{\[【]\s*[Pp]\s*(\d{1,2})\s*[\}\]】]/g, pick)
      // 裸 P3: 模型经常把花括号吃掉, 只留 P3 —— 实测这是最常见的形态
      .replace(/(?<![A-Za-z0-9])[Pp]\s?(\d{1,2})(?![0-9])/g, pick)
      // 兜底: 不存在的编号别把壳留给用户
      .replace(/\{\{?\s*[Pp]?\s*\d{1,2}\s*\}?\}/g, '');
  }

  function fmtTime(ts) {    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function renderList(block) {
    const items = block.items.filter(x => plain(x));
    if (!items.length) return '';
    return '<div class="rv-md-list">' + items.map((raw, i) => {
      const { tag, tone, text } = splitTag(raw.trim());
      const chip = tag ? '<span class="rv-md-tag ' + tone + '">' + esc(tag) + '</span>' : '';
      return '<div class="rv-md-item">'
        + '<span class="rv-md-idx">' + (i + 1) + '</span>'
        + '<div class="rv-md-body">' + chip + inline(text) + '</div>'
        + '</div>';
    }).join('') + '</div>';
  }

  // 主入口: 返回可直接塞进 .rv-ai-out 的 HTML
  function render(text, opts) {
    opts = opts || {};
    try {
      // U+FFFD = 解码时坏掉的字节(历史版本的主进程按分片解码造成)。
      // 上游已修, 但旧的本地缓存里还留着这些字符, 显示前一律抹掉, 不留"◆◆◆"。
      const clean = String(text == null ? '' : text).replace(/\uFFFD+/g, '');
      let blocks = parseBlocks(clean);

      // 去掉开头重复的大标题
      while (blocks.length && (blocks[0].type === 'h' || blocks[0].type === 'p')
        && REDUNDANT_TITLE.test(plain(blocks[0].text))) {
        blocks.shift();
      }
      if (!blocks.length) return '<div class="rv-ai-empty">模型没有返回可读文本</div>';

      // 第一块是短句且不带分类标签 → 当作"总评", 单独放大呈现
      let verdict = '';
      const head = blocks[0];
      if ((head.type === 'p' || head.type === 'h')) {
        const pt = plain(head.text);
        const tagged = splitTag(pt);
        if (pt.length && pt.length <= 44 && !tagged.tag) {
          // 注意: 判定用 plain(去符号), 渲染必须用原文, 否则粗体/行内代码会被当成普通字符吞掉
          verdict = '<div class="rv-md-verdict"><span class="rv-md-verdict-k">总评</span><div>' + inline(head.text) + '</div></div>';
          blocks.shift();
        }
      }

      const body = blocks.map(b => {
        if (b.type === 'h') {
          const pt = plain(b.text);
          if (REDUNDANT_TITLE.test(pt)) return '';
          return '<div class="rv-md-sec"><span class="rv-md-sec-bar"></span>' + inline(pt) + '</div>';
        }
        if (b.type === 'list') return renderList(b);
        if (b.type === 'hr') return '<div class="rv-md-hr"></div>';
        if (b.type === 'q') return '<div class="rv-md-quote">' + inline(b.text) + '</div>';
        return '<p class="rv-md-p">' + inline(b.text) + '</p>';
      }).join('');

      const style = STYLE_LABEL[opts.style] || STYLE_LABEL.coach;
      const time = fmtTime(opts.at);
      const headBar = '<div class="rv-ai-head">'
        + '<span class="rv-ai-style">' + esc(style) + '</span>'
        + (time ? '<span class="rv-ai-time">' + esc(time) + '</span>' : '')
        + (opts.cached ? '<span class="rv-ai-cache">本地缓存</span>' : '')
        // 用 span 而不是 button: 全局 button 规则(min-height 38px / padding 0 16px)
        // 优先级远高于这里, 会把它撑成一个占满半行的大按钮
        + '<span role="button" tabindex="0" class="rv-ai-copy">复制</span>'
        + '</div>';

      return headBar + '<div class="rv-md-doc">' + verdict + body + '</div>';
    } catch (e) {
      // 渲染失败也必须让用户看到原文, 不能白屏
      return '<div class="rv-md-doc"><p class="rv-md-p">' + esc(text) + '</p></div>';
    }
  }

  return { render, parseBlocks, inline, splitTag, fmtTime, fillPlayers, STYLE_LABEL, TAG_TONE };
});
