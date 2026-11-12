// 游戏内聊天弹幕浮窗 (主进程 game-translate:push 推数据; 窗口常态点击穿透)
// Ctrl+F10 进入输入模式: 主进程临时取消穿透并聚焦输入框, 回车 = 翻成目标语言发进游戏。
// 行 16 秒后变暗但保留 (上限 10 条, 超出删最老); 输入模式期间冻结变暗且可滚轮回看历史。
(function () {
  'use strict';
  const MAX_AGE_MS = 16000;
  let lines = [];
  let target = 'en';
  let inputOn = false;
  let sending = false;
  const wrap = document.getElementById('gtWrap');
  const listEl = document.getElementById('gtLines');
  const hintEl = document.getElementById('gtHint');
  const dragEl = document.getElementById('gtDrag');
  const rowEl = document.getElementById('gtInputRow');
  const inputEl = document.getElementById('gtInput');
  const sendEl = document.getElementById('gtSend');
  const errEl = document.getElementById('gtErr');

  function esc(value) {
    const div = document.createElement('div');
    div.textContent = String(value == null ? '' : value);
    return div.innerHTML;
  }

  function isSelfName(name) { return /我|me\b|self/i.test(String(name || '')); }

  // 增量渲染: 按 key 缓存 DOM 节点, 只增删变化的行。
  // 之前每秒 innerHTML 全量重建会让入场动画 (gtIn) 反复重放 → 弹幕整体一直闪 (1.5.37 实测)。
  const elMap = new Map();   // key -> { el, ts, sig }
  function lineKey(l) {
    // 有稳定键就用它: 同一条消息被 OCR 重读、换了译文时键不变, 行不会跳到末尾、
    // 也不会重播入场动画 —— 只是原地把文字换掉。
    if (l.id) return 'id:' + l.id;
    if (l.k) return 'k:' + l.k;
    return (Number(l.ts) || 0) + '|' + String(l.name || '') + '|' + String(l.translated || '');
  }
  // 内容指纹: 用来判断"键相同但文字变了"(同一条消息的更完整版本 / 更好的译文)
  function lineSig(l) {
    return String(l.name || '') + '\u0000' + String(l.translated || '') + '\u0000' + String(l.body || '');
  }
  const MAX_LINES = 10;
  const FADE_MS = 800;   // 与 .gt-line 的 transition 时长一致

  function scrollToLatest() {
    if (!listEl) return;
    const apply = () => {
      listEl.scrollTop = Math.max(0, Number(listEl.scrollHeight || 0) - Number(listEl.clientHeight || 0));
    };
    // 等 DOM 插入、文字换行和字体布局都完成后再置底；只在收到新数据时调用，
    // 每秒的淡出刷新不会持续抢用户滚轮。
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(apply));
    } else {
      apply();
    }
  }

  function lineInner(l) {
    // 1.5.79: 三态可辨 —— 静默丢弃是用户反馈里最难受的一点 ("我怎么确定是翻译时间
    // 过久还是翻译失败")。
    //   pending: 翻得慢 (超过 600ms 还没回来), 灰斜体"（翻译中…）"
    //   fail:    读到了但没翻出来, 暗金色"（未能翻译）"
    //   正常:    中文译文
    const cls = 'gt-body' + (l.fail ? ' gt-fail' : (l.pending ? ' gt-pend' : ''));
    let html = '<span class="gt-name">' + esc(l.name) + '</span>'
      + '<span class="' + cls + '">' + esc(l.translated) + '</span>';
    if (l.body && l.body !== l.translated) html += '<span class="gt-orig">' + esc(l.body) + '</span>';
    return html;
  }

  function buildLine(l) {
    const el = document.createElement('div');
    el.classList.add('gt-line');
    if (isSelfName(l.name)) el.classList.add('gt-self');
    el.innerHTML = lineInner(l);
    return el;
  }

  // 新增行的插入位置: 按聊天时间 (ord) 找第一个比它更晚的可见行, 插到它前面。
  // OCR 每 4 秒重读整个聊天框, 一条消息这一帧读烂、下一帧才读出来时, 它其实比
  // 刚推进来的新消息更早 —— 直接 appendChild 就会落在两条新消息中间。
  function place(el, ord) {
    let anchor = null;
    if (ord > 0) {
      for (const child of Array.from(listEl.children)) {
        const o = Number(child.dataset.ord) || 0;
        if (o > 0 && o > ord) { anchor = child; break; }
      }
    }
    if (anchor) listEl.insertBefore(el, anchor); else listEl.appendChild(el);
  }

  function render(followLatest) {
    if (!listEl) return;
    const now = Date.now();
    // 历史不再按时间删除: 过期只变暗 (gt-old), 除非超出 MAX_LINES 被最老的挤掉。
    // 之前 16 秒直接删行, 聊天稍慢时屏幕上永远只剩最新一条 (1.5.38 用户反馈)。
    const wanted = new Map(lines.map(l => [lineKey(l), l]));
    // 移除不再存在的行
    for (const [key, rec] of Array.from(elMap)) {
      if (!wanted.has(key)) { rec.el.remove(); elMap.delete(key); }
    }
    // 新增行 (按聊天时间插到该在的位置), 已有的行只更新淡出状态
    for (const l of lines) {
      const key = lineKey(l);
      const ord = Number(l.ord) || 0;
      let rec = elMap.get(key);
      if (!rec) {
        rec = { el: buildLine(l), ts: Number(l.ts) || 0, faded: false, sig: lineSig(l), ord };
        rec.el.dataset.ord = String(ord);
        elMap.set(key, rec);
        place(rec.el, ord);
        // 超出上限: 删最老的可见行。按 DOM 头部删 —— 按 ord 插入之后
        // elMap 的插入顺序已经不等于屏幕顺序了。
        while (listEl.children.length > MAX_LINES) {
          const head = listEl.firstElementChild;
          for (const [k, r] of Array.from(elMap)) { if (r.el === head) { elMap.delete(k); break; } }
          head.remove();
        }
      } else {
        // ord 后补读到 (这一帧才认对时间戳) → 更新标记, 后续插入才有正确参照
        if (ord && ord !== rec.ord) { rec.ord = ord; rec.el.dataset.ord = String(ord); }
        // 键没变但内容变了 (同一条消息的更完整读法 / 更好的译文): 原地换文字
        const sig = lineSig(l);
        if (rec.sig !== sig) { rec.sig = sig; rec.el.innerHTML = lineInner(l); }
      }
      const shouldFade = !inputOn && now - rec.ts > MAX_AGE_MS - FADE_MS;
      if (shouldFade !== rec.faded) { rec.faded = shouldFade; rec.el.classList.toggle('gt-old', shouldFade); }
    }
    if (followLatest) scrollToLatest();
  }

  function setInputUI(on) {
    inputOn = !!on;
    if (!rowEl || !wrap) return;
    rowEl.classList.toggle('gt-active', inputOn);
    wrap.classList.toggle('gt-typing', inputOn);
    if (inputOn) {
      if (errEl) errEl.textContent = '';
      try { inputEl.focus(); } catch (e) {}
    } else {
      try { inputEl.blur(); } catch (e) {}
    }
  }

  function setErr(msg) { if (errEl) errEl.textContent = String(msg || ''); }

  async function doSend() {
    const text = String(inputEl && inputEl.value || '').trim();
    if (!text || sending) return;
    sending = true;
    if (sendEl) { sendEl.disabled = true; sendEl.textContent = '翻译中…'; }
    setErr('');
    try {
      const r = await lolAPI.gameTranslateSend(text, target);
      if (r && r.ok) {
        inputEl.value = '';
        // 本地先给一条确认 (扫描回读稍后还会补一条中文回显, 两者不重复)
        lines = lines.concat([{ name: '我（已发送）', body: text, translated: r.translated || '', ts: Date.now() }]).slice(-10);
        render(true);
      } else {
        setErr((r && r.error) || '发送失败');
      }
    } catch (e) {
      setErr('发送异常: ' + (e && e.message ? e.message : e));
    } finally {
      sending = false;
      if (sendEl) { sendEl.disabled = false; sendEl.textContent = '发送'; }
    }
  }

  if (inputEl) {
    inputEl.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); doSend(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); lolAPI.gameTranslateExitInput(); }
      ev.stopPropagation();   // 别让 F6-F10 之类的热键把打字过程打断
    });
  }
  if (sendEl) sendEl.addEventListener('click', doSend);
  // 双击拖动条 = 位置恢复默认 (主进程清掉记忆的偏移并重新定位)
  if (dragEl) dragEl.addEventListener('dblclick', () => { if (lolAPI.gameTranslateResetPos) lolAPI.gameTranslateResetPos(); });

  if (window.lolAPI && window.lolAPI.onGameTranslateData) {
    lolAPI.onGameTranslateData(d => {
      if (!d || !Array.isArray(d.lines)) return;
      lines = d.lines.slice();
      if (d.target) target = d.target;
      render(true);
    });
  }
  if (window.lolAPI && window.lolAPI.onGameTranslateInput) {
    lolAPI.onGameTranslateInput(d => {
      if (!d) return;
      if (d.target) target = d.target;
      setInputUI(!!d.on);
      render();
    });
  }
  setInterval(render, 1000);
  // OS 级窗口激活成功后, DOM 焦点可能还没落到输入框 (主进程 focus 与 IPC 推送的时序竞争),
  // 窗口一拿到前台就补聚焦一次, 保证呼出后可以直接打字, 不用再点输入框
  window.addEventListener('focus', () => { if (inputOn) { try { inputEl.focus(); } catch (e) {} } });
  if (hintEl) hintEl.textContent = 'Ctrl+F10 输入并翻译发送';
})();
