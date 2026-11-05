// 翻译链路 (main/index.js) 的纯函数门禁。
// 05:19 局实测: "the top very strong" 在浮窗里的译文是 "top gap" —— 英文原样吐回来,
// 因为 AI 提示词里的术语表永远是"中文=英文"方向, 而任务是英→中。加上这个门禁,
// 以后谁把方向写反、或者把语种校验删掉, 这里会立刻红。
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
}

const SRC = fs.readFileSync(path.join(__dirname, 'main/index.js'), 'utf8');

function pick(name) {
  const re = new RegExp('(?:^|\\n)(?:async )?function ' + name + '\\b[\\s\\S]*?\\n\\}');
  const m = SRC.match(re);
  if (!m) throw new Error('没找到函数 ' + name);
  return m[0];
}

const sandbox = {
  console, String, Number, Array, Math, JSON, Object, RegExp,
  Date: { now: () => sandbox.__now },
  __now: 1700000000000,
  logErr: () => {}
};
const code = [
  'const aiBudget = { avgMs: 0, samples: 0, offUntil: 0, offLogged: 0 };',
  pick('glossaryHint'),
  pick('aiItemOk'),
  pick('stripListNumber'),
  pick('aiBudgetOk'),
  pick('aiBudgetRecord')
].join('\n');
const fn = new Function('sandbox', `with (sandbox) { ${code}
  return { glossaryHint, aiItemOk, stripListNumber, aiBudgetOk, aiBudgetRecord, aiBudget };
}`);
const M = fn(sandbox);

// ---------- 术语表方向 ----------
{
  const zh = M.glossaryHint('zh-CN');
  ok('英→中方向的术语表是 "top gap=上路差距"', zh.includes('top gap=上路差距'), zh);
  ok('英→中方向不能再出现 "上路差距=top gap"', !zh.includes('上路差距=top gap'), zh);
  ok('英→中方向不该出现"用 gap 不要用 diff"这类出站规则', !zh.includes('不要用 diff'), zh);
  const en = M.glossaryHint('en');
  ok('中→英方向仍是 "上路差距=top gap"', en.includes('上路差距=top gap'), en);
  ok('中→英方向保留 gap 用词规则', en.includes('不要用 diff'), en);
}

// ---------- AI 输出语种校验 ----------
{
  ok('目标中文, 译文是英文 → 判为不合格', M.aiItemOk('top gap', 'zh-CN') === false);
  ok('目标中文, 译文是中文 → 合格', M.aiItemOk('上路差距', 'zh-CN') === true);
  ok('目标中文, 空串 → 不合格', M.aiItemOk('', 'zh-CN') === false);
  ok('目标英文, 译文还带中文 → 不合格', M.aiItemOk('top 差距', 'en') === false);
  ok('目标英文, 纯英文 → 合格', M.aiItemOk('top gap', 'en') === true);
}

// ---------- 译文序号 ----------
{
  ok('原文没序号时剥掉译文的 "1. "', M.stripListNumber('good job', '1. 好') === '好');
  ok('原文本身以数字开头时保留', M.stripListNumber('1. good job', '1. 好') === '1. 好');
  ok('正常译文不动', M.stripListNumber('good job', '干得好') === '干得好');
}

// ---------- 延迟预算 ----------
{
  ok('初始允许用 AI', M.aiBudgetOk() === true);
  // 单次慢不立刻关 (要看平均, 避免偶发抖动误杀)
  M.aiBudgetRecord(5000);
  ok('单次慢不关闭 AI', M.aiBudgetOk() === true);
  M.aiBudgetRecord(5000);
  M.aiBudgetRecord(5000);
  ok('连续三次都慢 → 暂停 AI', M.aiBudgetOk() === false);
  sandbox.__now += 121000;
  ok('2 分钟后自动恢复', M.aiBudgetOk() === true);
}

// ---------- 源码级契约 ----------
{
  ok('AI 请求超时收紧到 6 秒 (30 秒会让浮窗静默半分钟)', /httpsPost\([\s\S]{0,200}?body,\s*6000\)/.test(SRC));
  ok('AI 超时记录耗时 (自适应闸门的输入)', SRC.includes('aiBudgetRecord(Date.now() - tAi)'));
  ok('AI 返回后逐条做语种校验', SRC.includes('if (!aiItemOk(r, lang)) bad.push(i)'));
  ok('语种不对的条目单独退回机翻', SRC.includes('const fix = await freeTranslateBatch(bad.map(i => pending[i]), lang)'));
  ok('翻译耗时留痕 (排查"很久才出来"必须有据可查)', SRC.includes("'[TRANSLATE] 用时 '"));
}

console.log(`\n翻译链路: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
