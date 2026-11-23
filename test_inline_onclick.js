// 内联事件参数的转义回归测试 (1.6.51)
//
// 背景: 把字符串参数直接 JSON.stringify 进 onclick="..." 里, 双引号会提前结束属性,
// 浏览器拿到的处理器变成 `showMarkModal(` —— 点击直接 SyntaxError, 用户看到的是
// "按钮点了没反应"。遭遇库的「编辑」就是这样死的 (1.6.50 及以前)。
//
// 这里不模拟浏览器, 只守住一条可判定的性质: 每个 onclick/onchange 属性值都必须是
// "完整的调用" —— 括号配平、以 ) 结尾、且不含未转义的裸双引号。
const assert = require('assert');
const path = require('path');

const R = f => require(path.join(__dirname, f));
const Recent = R('renderer/js/recent-players.js');
const Profiles = R('renderer/js/settings-profiles.js');
const HexCross = R('renderer/js/hex-cross.js');
const Marks = R('renderer/js/replay-marks.js');

// 故意带双引号/单引号/尖括号/& 的名字 —— 全是会把属性写坏的角色
const NASTY = 'a"b\'c<d>&e';
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

function checkAttrs(html, label) {
  const re = /\son(?:click|change|input)="([^"]*)"/g;
  let m, count = 0;
  while ((m = re.exec(html))) {
    const v = m[1];
    count++;
    const open = (v.match(/\(/g) || []).length;
    const close = (v.match(/\)/g) || []).length;
    ok(open === close, label + ': 括号不配平 -> ' + v);
    ok(!/\(\s*$/.test(v), label + ': 属性在调用中途被截断 -> ' + v);
    if (/^\s*[A-Za-z_$][\w$.]*\s*\(/.test(v)) {
      ok(/\)\s*$/.test(v), label + ': 调用没有正常收尾 -> ' + v);
    }
    // 属性值内部不该出现裸双引号 (HTML 里必须是 &quot;)
    ok(!/"/.test(v), label + ': 属性值里有裸双引号 -> ' + v);
  }
  return count;
}

// ---- 1. 遭遇库「编辑」----
{
  const html = Recent.html({
    rows: [{ puuid: 'p-"1', name: NASTY, count: 2, lastSeen: 0, tags: [], note: '' }],
    total: 1, repeat: 0, tagged: 0
  }, {});
  const c = checkAttrs(html, '遭遇库');
  ok(c >= 1, '遭遇库: 生成了内联事件 (' + c + ' 个)');
  ok(/showMarkModal\(&quot;p-\\?&quot;?1&quot;|showMarkModal\(&quot;p-&quot;1&quot;/.test(html.replace(/\\/g, '')),
    '遭遇库: 编辑按钮把 puuid 转成了 &quot; 形式');
  ok(!/onclick="showMarkModal\("\s*,\s*"/.test(html), '遭遇库: 不再是裸 JSON.stringify 的写法');
}

// ---- 2. 配置档 应用/删除 ----
{
  const html = Profiles.html([{ name: NASTY, settingCount: 3, savedAt: 0 }], { exists: true });
  const c = checkAttrs(html, '配置档');
  ok(c >= 2, '配置档: 应用/删除都带内联事件 (' + c + ' 个)');
}

// ---- 3. 强化反查命中行 ----
{
  const html = HexCross.listHtml([{ id: 7, name: NASTY, rarity: '金', local: '' }]);
  const c = checkAttrs(html, '强化反查');
  ok(c >= 1, '强化反查: 命中行带内联事件 (' + c + ' 个)');
}

// ---- 4. 回放书签 看回放/删/改备注 ----
{
  // html() 是从存储里读的: 这里给 storeGet 打个桩 (浏览器里由 persist.js 提供)
  global.storeGet = () => JSON.stringify([{ gameId: 987654321, minute: 12, note: NASTY, platformId: 'HN1' }]);
  const html = Marks.html();
  const c = checkAttrs(html, '回放书签');
  ok(c >= 3, '回放书签: 三个内联事件都在 (' + c + ' 个)');
  ok(/openReplayMark\(987654321,/.test(html), '回放书签: gameId 仍是数字字面量, 没被转成字符串');
  delete global.storeGet;
}

console.log('test_inline_onclick: ' + n + ' assertions passed');
