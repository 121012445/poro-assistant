// LoL 术语表（main/lol-glossary.js）行为测试
// 这张表的存在理由：通用机翻在这个语境里错得离谱（实测腾讯/Google 都错）
//   上路差距 → road gap     下路差距 → underpass gap     大龙 → magnosaurus
//   top gap  → 顶部间隙     baron now → 拉古诺           im otw → 伊姆奥特夫
const G = require('./main/lol-glossary');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
}

console.log('— 中→英 整句 —');
{
  const cases = [
    ['上路差距', 'top gap'], ['上单差距', 'top gap'], ['上路崩了', 'top gap'],
    ['中路差距', 'mid gap'], ['打野差距', 'jungle gap'], ['下路差距', 'bot gap'],
    ['辅助差距', 'support gap'], ['大龙', 'baron'], ['小龙', 'dragon'],
    ['别送了', 'stop feeding'], ['打团', 'group up'], ['做视野', 'ward'],
    ['对面打野在哪', 'where is enemy jg'], ['我有大招', 'my ult is up'],
    ['我要回城', 'recall'], ['谢谢', 'ty'], ['打得好', 'wp'],
    ['等我', 'wait for me'], ['投降', 'ff'], ['对面没闪', 'enemy no flash']
  ];
  for (const [cn, en] of cases) ok(cn + ' → ' + en, G.phraseOut(cn) === en, G.phraseOut(cn));
}
{
  ok('带标点也能命中', G.phraseOut('上路差距！') === 'top gap', G.phraseOut('上路差距！'));
  ok('带空格也能命中', G.phraseOut('上 路 差 距') === 'top gap', G.phraseOut('上 路 差 距'));
  ok('没收录的句子返回空', G.phraseOut('这局我打得不太好大家多包涵') === '');
  ok('英文不会被当中文命中', G.phraseOut('top gap') === '');
}

console.log('— 英→中 整句 —');
{
  const cases = [
    ['gg', '打得好'], ['WP', '打得漂亮'], ['gg wp', '打得好，打得漂亮'],
    ['top gap', '上路差距'], ['top diff', '上路差距'], ['jungle diff', '打野差距'],
    ['mid gap', '中路差距'], ['bot diff', '下路差距'], ['support gap', '辅助差距'],
    ['no ss', '没闪'], ['ss', '有闪'], ['otw', '我在路上'], ['im otw', '我在路上'],
    ['ff 15', '15 分钟投降'], ['otw', '我在路上'], ['jg', '打野'], ['baron', '打大龙'],
    ['care ss', ''], ['nvm', '算了'], ['ty', '谢谢'], ['afk', '挂机'],
    // 机翻会丢关键词的整句 (实测 2026-11-04: "they are doing baron" → 「他们正在做」)
    ['they are doing baron', '他们在打大龙'], ['our jg is inting', '我方打野在送'],
    ['no ss top', '上路没闪'], ['no ss mid', '中路没闪']
  ];
  for (const [en, cn] of cases) {
    if (!cn) continue;
    ok(en + ' → ' + cn, G.phraseIn(en) === cn, G.phraseIn(en));
  }
  ok('大小写不敏感', G.phraseIn('GG WP') === '打得好，打得漂亮', G.phraseIn('GG WP'));
  ok('长句不会误命中', G.phraseIn('gg we lost this one hard') === '');
  ok('中文不会被当英文命中', G.phraseIn('上路差距') === '');
}

console.log('— 英文译文纠正（发送方向）—');
{
  const cases = [
    ['road gap', 'top gap'],
    ['underpass gap', 'bot gap'],
    ['middle gap', 'mid gap'],
    ['auxiliary gap', 'support gap'],
    ['the gap in the top lane', 'top gap'],
    ['magnosaurus now', 'baron now'],
    ['dragonet', 'dragon'],
    ['I have big move', 'I have ult'],
    ['make a vision', 'ward'],
    ['play the group', 'teamfight'],
    ['The opposite jungler keeps coming for me.', 'the enemy jungler keeps coming for me.'],
    ['top diff', 'top gap'],
    ['mid diff', 'mid gap'],
    ['buy equipment', 'buy items'],
    ['push the tower together', 'push together'],
    // 腾讯机翻实测产物 (2026-11-04)
    ["There's a big gap in the road. Be careful.", "There's top gap. Be careful."],
    ['The middle is suppressed, help me', 'mid is losing, help me'],
    ['Jungle to catch me', 'jungle is coming for me'],
    ["Don't cross the tower", "Don't dive the turret"],
    ['Wait for me to equip.', 'wait for my items.'],
    // 「差距」在长句里被机翻成 difference / disparity（短语表接不住，靠 polish 兜）
    ['The top lane difference is huge', 'The top gap is huge'],
    ['There is a huge difference in the mid lane', 'There is a huge gap in the mid lane'],
    ['The difference on the bot lane is clear', 'the bot gap is clear'],
    ['jungle difference is real', 'jungle gap is real'],
    ['support disparity huge', 'support gap huge'],
    ['big difference between us', 'big gap between us']
  ];
  for (const [from, to] of cases) ok(from + ' → ' + to, G.polish(from, 'en') === to, G.polish(from, 'en'));
  ok('正常英文不被改动', G.polish('we should group mid now', 'en') === 'we should group mid now',
    G.polish('we should group mid now', 'en'));
}

console.log('— 中文译文纠正（接收方向）—');
{
  const cases = [
    ['顶部间隙', '上路差距'], ['顶部差异', '上路差距'], ['中等间隙', '中路差距'],
    ['丛林差异', '打野差距'], ['底部间隙', '下路差距'], ['辅助间隙', '辅助差距'],
    ['拉古诺', '大龙'], ['他吃饱了', '他发育起来了'], ['伊姆奥特夫', '我在路上'],
    ['没有ss', '对面没闪'], ['关心ss', '注意对面闪现'], ['做出视野', '做视野'],
    ['公路差距', '上路差距'],
    // lane 被一起翻出来 ("顶部车道差异") + 分路词归位后仍要收口成"差距"
    ['顶部车道差异', '上路差距'], ['中部车道差异明显', '中路差距明显'],
    ['打野差异明显', '打野差距明显'], ['上路差异', '上路差距'],
    ['男爵快到了', '大龙快到了'],
    // 腾讯机翻实测产物 (2026-11-04)
    ['上道差异巨大', '上路差距巨大'], ['我们的jg是inting', '我方打野在送'],
    ['无ss顶部', '上路没闪'], ['FF 20', '20 投'],
    // 腾讯机翻实测产物 (2026-11-05): "the top very strong" → 「顶部非常坚固」
    // 坚固/强壮 是形容建筑或身体的, 形容分路要用"强" (用户当场指出)
    ['顶部非常坚固', '上路非常强'], ['顶部很强壮', '上路很强'],
    ['我们的顶部非常坚固', '我们的上路非常强'],
    // 分路词被原样留在中文译文里: "top is very strong" → 「top很强」
    ['top很强', '上路很强'], ['mid太远了', '中路太远了'],
    // 带物主代词时机翻把 top 当成衣服 (2026-11-05 用户截图实测)
    ['我们的上衣太结实了', '我们的上路太强了'], ['我们的上衣很强', '我们的上路很强'],
    ['你的上装不错', '你的上路不错']
  ];
  for (const [from, to] of cases) ok(from + ' → ' + to, G.polish(from, 'zh-CN') === to, G.polish(from, 'zh-CN'));
  ok('正常中文不被改动', G.polish('我们抱团推中路', 'zh-CN') === '我们抱团推中路', G.polish('我们抱团推中路', 'zh-CN'));
  // 已经翻对的不能被动: "强大" 不是"坚固", 不该被改成"强"
  ok('上路非常强大 保持原样', G.polish('上路非常强大', 'zh-CN') === '上路非常强大',
    G.polish('上路非常强大', 'zh-CN'));
}

console.log('— 方向判定 —');
{
  ok('zh-CN 是接收方向', G.isInbound('zh-CN') === true);
  ok('zh 也算接收', G.isInbound('zh') === true);
  ok('en 是发送方向', G.isInbound('en') === false);
  ok('ja 是发送方向', G.isInbound('ja') === false);
  ok('空值按发送处理', G.isInbound('') === false);
}

console.log(`\nLoL 术语表: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
