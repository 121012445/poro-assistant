'use strict';
// 渲染层多模块加载顺序安全检查
//
// 为什么需要这个测试:
//   拆分后每个模块都是独立的 <script>, 它们共享同一个全局环境 (window + 全局词法环境),
//   但顶层 let/const 只有在"所属脚本被执行到那一行"时才被初始化。
//   于是出现一类只在真实浏览器里才炸的坑:
//
//     // a.js (先加载)
//     window.x = Object.keys(allChampions);   // 顶层就执行
//     // z.js (后加载)
//     let allChampions = {};
//
//   a.js 执行时 allChampions 既不在全局词法环境里 (z.js 还没跑), 也不在 window 上,
//   引用它会直接抛 ReferenceError —— a.js 后面所有绑定全部丢失, 而 z.js 照常加载、
//   首页照常渲染, 日志一片祥和。
//
//   现有的 vm 测试抓不到这个: 它们把 18 个脚本顺序 runInContext 完才断言, 那时所有
//   binding 都已就位。所以这里用纯静态扫描, 把"顶层代码引用了后加载模块的声明"钉死。
//
// 判定规则 (只看加载期真的会执行的代码):
//   顶层可执行语句 + 顶层声明的初始化表达式 (函数体/箭头函数体/方法体不算, 它们加载期不跑)
//   引用到某个标识符, 而该标识符
//     - 被后加载模块以 let/const/class 声明 -> 报错 (TDZ, 必炸)
//     - 被后加载模块以 var/function 声明 -> 报错 (静默拿到 undefined, 更难查)
//     - 在同模块内、以 let/const/class 声明于引用位置之后 -> 报错 (同模块 TDZ)
//
// 用法:
//   node test_split_order.js              检查 (有问题则退出码 1)
//   node test_split_order.js --dump       打印各模块切出的顶层语句, 用于排查误报
//   node test_split_order.js --dump bench.js   只看某一个模块
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

// ---------- 1. 取 index.html 里的脚本加载顺序 ----------
const html = read('renderer/index.html');
const order = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1].split('?')[0]);
assert.ok(order.length >= 2, 'index.html 至少应引用 utils.js 与 app.js');

// ---------- 2. 把注释 / 字符串 / 正则清成空格 (长度与偏移严格不变) ----------
// 只在"语法骨架"上做扫描, 避免注释里的代码片段和字符串里的名字造成误报。
const REGEX_OK_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_OK_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await', 'instanceof', 'throw']);
const WORD_RE = /[A-Za-z0-9_$]/;

function blankLiterals(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  let lastSig = '';
  let lastWord = '';
  const bumpWord = ch => {
    if (WORD_RE.test(ch)) lastWord = (lastWord + ch).slice(-14);
    else lastWord = '';
  };
  const regexAllowed = () => REGEX_OK_AFTER.has(lastSig) || REGEX_OK_WORDS.has(lastWord);

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // 行注释
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    // 块注释 (保留换行, 方便报错定位)
    if (c === '/' && c2 === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    // 普通字符串
    if (c === '"' || c === "'") {
      out[i] = ' '; i++;
      while (i < n) {
        if (src[i] === '\\') { out[i] = ' '; if (i + 1 < n && src[i + 1] !== '\n') out[i + 1] = ' '; i += 2; continue; }
        if (src[i] === c) { out[i] = ' '; i++; break; }
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      lastSig = 'x'; bumpWord('x');
      continue;
    }
    // 模板字符串: 字面量部分清空, ${...} 里的表达式原样保留 (那部分会被执行)
    if (c === '`') {
      out[i] = ' '; i++;
      let depth = 0;
      while (i < n) {
        const ch = src[i];
        if (depth === 0) {
          if (ch === '\\') { out[i] = ' '; if (i + 1 < n && src[i + 1] !== '\n') out[i + 1] = ' '; i += 2; continue; }
          if (ch === '`') { out[i] = ' '; i++; break; }
          if (ch === '$' && src[i + 1] === '{') { out[i] = ' '; out[i + 1] = ' '; i += 2; depth = 1; continue; }
          if (ch !== '\n') out[i] = ' ';
          i++;
          continue;
        }
        // ${...} 内部: 保留原样, 只跟大括号配平
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { out[i] = ' '; i++; continue; } }
        i++;
      }
      lastSig = 'x'; bumpWord('x');
      continue;
    }
    // 正则字面量
    if (c === '/' && regexAllowed()) {
      out[i] = ' '; i++;
      let inClass = false;
      let closed = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') { out[i] = ' '; if (i + 1 < n && src[i + 1] !== '\n') out[i + 1] = ' '; i += 2; continue; }
        if (ch === '\n') break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { out[i] = ' '; i++; closed = true; break; }
        out[i] = ' ';
        i++;
      }
      if (closed) { lastSig = 'x'; bumpWord('x'); }
      continue;
    }

    if (!/\s/.test(c)) { lastSig = c; bumpWord(c); }
    i++;
  }
  return out.join('');
}

// ---------- 3. 切出顶层语句 (只认括号深度为 0 的分号与大括号) ----------
// 注意: 语句前面的注释会一并带进来 (注释已被清成空格), 因此分类时必须用清空后的文本,
// 否则 "// 说明\nfunction foo(){}" 的开头是注释, /^function/ 匹配不到, 整个函数体
// 会被误判成"加载期代码" —— 这个坑已经踩过一次。
const CONTINUE_AFTER_BRACE = new Set(['else', 'catch', 'finally', 'while', ';', ',', ')', ']', '.', '(', '`']);

function topLevelStatements(blanked) {
  const stmts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const n = blanked.length;

  const nextToken = from => {
    let k = from;
    while (k < n && /\s/.test(blanked[k])) k++;
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(blanked.slice(k, k + 20));
    return m ? m[0] : blanked[k] || '';
  };

  while (i < n) {
    const c = blanked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0 && c === '}') {
        const tok = nextToken(i + 1);
        if (!CONTINUE_AFTER_BRACE.has(tok)) {
          stmts.push([start, i + 1]);
          start = i + 1;
        }
      }
    } else if (c === ';' && depth === 0) {
      stmts.push([start, i + 1]);
      start = i + 1;
    }
    i++;
  }
  if (blanked.slice(start).trim()) stmts.push([start, n]);

  return stmts.filter(([a, b]) => blanked.slice(a, b).trim().length > 0);
}

// ---------- 4. 清掉"加载期不执行"的函数体 ----------
// 函数声明体、箭头函数体、对象方法体都是建个闭包就完事, 加载期不跑;
// 立即调用 (IIFE) 的体例外 —— 它确实在加载期执行, 必须保留。
const BLOCK_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'else', 'do', 'try', 'finally',
  'return', 'typeof', 'new', 'delete', 'void', 'in', 'of', 'case', 'default', 'yield', 'await', 'throw'
]);

function stripFunctionBodies(code) {
  const out = code.split('');
  const n = code.length;

  const matchBrace = from => {
    let d = 0;
    for (let i = from; i < n; i++) {
      if (code[i] === '{') d++;
      else if (code[i] === '}') { d--; if (d === 0) return i; }
    }
    return -1;
  };
  // 体结束后紧跟 '(' (允许中间夹一个 ')') 说明是立即调用
  const invoked = closeIdx => {
    let i = closeIdx + 1;
    while (i < n && /[\s)]/.test(code[i])) i++;
    return code[i] === '(';
  };
  const blankBody = (openIdx, closeIdx) => {
    if (closeIdx < 0) return;
    for (let i = openIdx + 1; i < closeIdx; i++) if (code[i] !== '\n') out[i] = ' ';
  };

  // 4.1 function 关键字 (声明与表达式都走这里)
  const fnRe = /\bfunction\b/g;
  let m;
  while ((m = fnRe.exec(code))) {
    let i = m.index + 'function'.length;
    while (i < n && /[\s*]/.test(code[i])) i++;          // 生成器星号
    while (i < n && /[A-Za-z0-9_$]/.test(code[i])) i++;  // 函数名
    while (i < n && /\s/.test(code[i])) i++;
    if (code[i] !== '(') continue;
    let d = 0;
    while (i < n) {
      const c = code[i];
      if (c === '(') d++;
      else if (c === ')') { d--; if (d === 0) { i++; break; } }
      i++;
    }
    while (i < n && /\s/.test(code[i])) i++;
    if (code[i] !== '{') continue;
    const close = matchBrace(i);
    if (close < 0) continue;
    if (!invoked(close)) blankBody(i, close);
    fnRe.lastIndex = close + 1;
  }

  // 4.2 箭头函数体 (=> {) 与对象方法简写 (name() {)
  for (let i = 0; i < n; i++) {
    if (code[i] !== '{') continue;
    let j = i - 1;
    while (j >= 0 && /\s/.test(code[j])) j--;
    let trigger = false;
    if (code[j] === '>') {
      let k = j - 1;
      while (k >= 0 && /\s/.test(code[k])) k--;
      if (code[k] === '=') trigger = true;
    } else if (code[j] === ')') {
      let d = 0;
      let k = j;
      while (k >= 0) {
        const c = code[k];
        if (c === ')') d++;
        else if (c === '(') { d--; if (d === 0) break; }
        k--;
      }
      let p = k - 1;
      while (p >= 0 && /\s/.test(code[p])) p--;
      if (p >= 0 && /[A-Za-z0-9_$]/.test(code[p])) {
        let s = p;
        while (s >= 0 && /[A-Za-z0-9_$]/.test(code[s])) s--;
        const word = code.slice(s + 1, p + 1);
        if (!BLOCK_KEYWORDS.has(word)) trigger = true;
      }
    }
    if (!trigger) continue;
    const close = matchBrace(i);
    if (close < 0) continue;
    if (!invoked(close)) blankBody(i, close);
  }
  return out.join('');
}

// ---------- 5. 语句分类 / 声明名 / 标识符 ----------
const KEYWORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield', 'async',
  'get', 'set', 'from', 'as'
]);

function classify(blankedStmt) {
  const t = blankedStmt.trim();
  if (/^(?:async\s+)?function\b/.test(t)) {
    const m = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(t);
    return { kind: 'function', name: m ? m[1] : null };
  }
  const c = /^class\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(t);
  if (c) return { kind: 'class', name: c[1] };
  const d = /^(let|const|var)\b/.exec(t);
  if (d) return { kind: d[1] };
  return { kind: 'stmt' };
}

// 加载期会执行的部分: 函数声明 -> 无; class -> 只有 extends 子句; 其余 -> 去掉函数体
function loadTimeCode(blankedStmt) {
  const info = classify(blankedStmt);
  if (info.kind === 'function') return '';
  if (info.kind === 'class') {
    const i = blankedStmt.indexOf('{');
    return i >= 0 ? blankedStmt.slice(0, i) : blankedStmt;
  }
  return stripFunctionBodies(blankedStmt);
}

function identifiers(code) {
  const names = new Set();
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let m;
  while ((m = re.exec(code))) {
    const name = m[0];
    if (KEYWORDS.has(name)) continue;
    // 属性访问 foo.bar 里的 bar
    let k = m.index - 1;
    while (k >= 0 && /\s/.test(code[k])) k--;
    if (code[k] === '.') continue;
    // 对象字面量的键 { key: value }
    if (code[k] === '{' || code[k] === ',') {
      let j = m.index + name.length;
      while (j < code.length && /\s/.test(code[j])) j++;
      if (code[j] === ':') continue;
    }
    names.add(name);
  }
  return names;
}

// let/const/var 的每个 declarator 头部取名字 (支持解构)
function declaratorNames(blankedStmt, kind) {
  const t = blankedStmt.trim().replace(/;\s*$/, '');
  const body = t.replace(/^(let|const|var)\b/, '');
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  const out = [];
  for (const p of parts) {
    const head = p.split('=')[0];
    for (const nm of identifiers(head)) out.push({ name: nm, kind: kind === 'var' ? 'hoisted' : 'lexical' });
  }
  return out;
}

// ---------- 6. 逐模块扫描 ----------
const modules = order.map(src => {
  const raw = read(path.join('renderer', src));
  const blanked = blankLiterals(raw);
  const stmts = topLevelStatements(blanked).map(([a, b]) => ({
    raw: raw.slice(a, b),
    code: blanked.slice(a, b),
    offset: a
  }));
  const decls = [];   // [{name, kind, offset}]
  const refs = [];    // [{name, offset}]

  for (const s of stmts) {
    const info = classify(s.code);
    if (info.kind === 'function') {
      if (info.name) decls.push({ name: info.name, kind: 'hoisted', offset: s.offset });
    } else if (info.kind === 'class') {
      if (info.name) decls.push({ name: info.name, kind: 'lexical', offset: s.offset });
    } else if (info.kind === 'let' || info.kind === 'const' || info.kind === 'var') {
      for (const d of declaratorNames(s.code, info.kind)) decls.push({ name: d.name, kind: d.kind, offset: s.offset });
    }
    const code = loadTimeCode(s.code);
    if (!code.trim()) continue;
    for (const nm of identifiers(code)) refs.push({ name: nm, offset: s.offset });
  }
  return { src, stmts, decls, refs };
});

// ---------- 7. --dump 诊断 ----------
if (process.argv.includes('--dump')) {
  const idx = process.argv.indexOf('--dump');
  const only = process.argv[idx + 1];
  for (const mod of modules) {
    if (only && only !== mod.src && only !== path.basename(mod.src)) continue;
    console.log('\n===== ' + mod.src + ' (' + mod.stmts.length + ' 条顶层语句) =====');
    mod.stmts.forEach((s, i) => {
      const one = s.raw.trim().replace(/\s+/g, ' ').slice(0, 88);
      const lines = s.raw.split('\n').length;
      const kind = classify(s.code).kind;
      console.log(`${String(i).padStart(3)} [${String(lines).padStart(3)}行] ${kind.padEnd(8)} ${one}`);
    });
  }
  process.exit(0);
}

// ---------- 8. 判定 ----------
const declIndex = new Map();
modules.forEach((mod, mi) => {
  for (const d of mod.decls) {
    if (!declIndex.has(d.name)) declIndex.set(d.name, []);
    declIndex.get(d.name).push({ mi, kind: d.kind, offset: d.offset });
  }
});

const problems = [];
modules.forEach((mod, mi) => {
  for (const r of mod.refs) {
    const decls = declIndex.get(r.name);
    if (!decls) continue;   // 浏览器全局 / preload 注入, 不归本测试管
    for (const d of decls) {
      if (d.mi > mi) {
        problems.push(
          `${mod.src} 在加载期引用了 ${modules[d.mi].src} 的 `
          + `${d.kind === 'lexical' ? 'let/const/class' : 'var/function'} 声明 "${r.name}"`
          + ` —— 声明在后面的脚本里, 执行到时还不存在`
        );
      } else if (d.mi === mi && d.kind === 'lexical' && d.offset > r.offset) {
        // var/function 有提升, 同文件里先用后声明是合法的; let/const/class 则会 TDZ
        problems.push(`${mod.src} 在加载期引用了同文件更靠后声明的 "${r.name}" (同一脚本内的 TDZ)`);
      }
    }
  }
});

// ---------- 9. 输出 ----------
const unique = [...new Set(problems)];
console.log('渲染层加载顺序检查');
console.log('  模块数          :', modules.length);
console.log('  顶层语句数      :', modules.reduce((a, m) => a + m.stmts.length, 0));
console.log('  顶层声明名      :', declIndex.size);
console.log('  加载期引用数    :', modules.reduce((a, m) => a + m.refs.length, 0));

if (unique.length) {
  console.log('\n发现问题:');
  for (const p of unique) console.log('  - ' + p);
}

assert.deepStrictEqual(unique, [],
  '渲染层存在跨模块加载期引用 —— 需要调整模块加载顺序, 或把共享声明提前到最早加载的模块');

console.log('\n加载顺序安全检查通过: 没有任何模块在加载期引用后加载模块的声明');
