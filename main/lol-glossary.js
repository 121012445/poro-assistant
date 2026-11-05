'use strict';
// LoL 对局聊天术语表 (纯函数, 可在 node 里单测)
//
// 为什么需要它: 通用机翻在这个语境里错得离谱, 实测 (2026-11-04):
//   「上路差距」→ "road gap"        「下路差距」→ "underpass gap"
//   「大龙」    → "magnosaurus"     「打团」    → "play the group"
//   反过来: "top gap" → "顶部间隙"   "baron now" → "拉古诺"   "im otw" → "伊姆奥特夫"
//   "he is fed" → "他吃饱了"
// 所以三层处理:
//   1. 整句命中短语表 → 直接给地道说法, 不调接口 (短句占绝大多数)
//   2. 长句 → 机翻 → 把产出的错译纠正掉 (fixEn / fixZh)
//   3. 机翻完全没动过的缩写 (gg/wp/otw) 靠短语表兜
//
// 注意: 不做"中文术语预替换成英文再机翻"。实测会把句子拆坏:
//   「我大招好了就开团」→ "我 ult 好了就 teamfight" → "I ult-well, teamfight." (更差)

// 归一化: 去空白/标点/装饰符, 只留字母数字与汉字
function norm(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[。，、！？；：,.!?;:~…·\-—_"'“”‘’`()（）\[\]【】<>《》/\\|+*#@&%^$=]/g, '');
}

// ========== 1. 中 → 英 (发送方向, 整句精确匹配) ==========
const OUT = {
  // 分路差距 —— 外服最常见的说法, 必须一次到位
  '上路差距': 'top gap', '上单差距': 'top gap', '上路崩了': 'top gap', '上路裂开了': 'top gap',
  '中路差距': 'mid gap', '中单差距': 'mid gap', '中路崩了': 'mid gap',
  '打野差距': 'jungle gap', '打野崩了': 'jungle gap',
  '下路差距': 'bot gap', 'adc差距': 'bot gap', '下路崩了': 'bot gap',
  '辅助差距': 'support gap', '辅助位差距': 'support gap',
  '全方位差距': 'every lane gap', '全队差距': 'team gap',
  // 最常用的几句
  '别送了': 'stop feeding', '别送': 'stop feeding', '送什么呢': 'stop feeding',
  '稳一点': 'play safe', '稳点': 'play safe', '稳住': 'play safe', '小心点': 'care',
  '等我': 'wait for me', '等等我': 'wait for me', '等一下': 'wait', '等等': 'wait',
  '打团': 'group up', '打团战': 'group up', '团战': 'teamfight', '开团': 'engage now',
  '推塔': 'push', '一起推塔': 'push together', '推中路': 'push mid', '推上路': 'push top', '推下路': 'push bot',
  '大龙': 'baron', '打大龙': 'do baron', '小龙': 'dragon', '打小龙': 'do dragon',
  '大龙打不打': 'baron?', '打不打大龙': 'baron?', '大龙打吗': 'baron?', '打大龙吗': 'baron?',
  '小龙打不打': 'dragon?', '打不打小龙': 'dragon?', '打龙': 'do dragon',
  '做视野': 'ward', '插眼': 'ward', '补视野': 'ward',
  '对面打野在哪': 'where is enemy jg', '打野在哪': 'where is jg', '对面打野呢': 'where is enemy jg',
  '我有大招': 'my ult is up', '大招好了': 'ult is up', '我没大招': 'no ult', '我没大': 'no ult',
  '我要回城': 'recall', '回城': 'recall', '我先回城': 'i recall first',
  '加油': 'gl', '打得好': 'wp', '你打得好': 'wp', '打得漂亮': 'wp',
  '对不起': 'sorry', '抱歉': 'sorry', '我的': 'my bad', '我的错': 'my bad',
  '跟上': 'follow me', '跟我走': 'follow me', '撤退': 'back off', '撤': 'back off',
  '谢谢': 'ty', '你好': 'hi', '好的': 'ok', '好': 'ok', '可以': 'ok',
  '对面很强': 'they are strong', '我们优势': 'we are ahead', '能翻': 'we can come back',
  '投降': 'ff', '点了': 'ff', '点了吧': 'ff',
  '快点': 'hurry', '一起走': 'come with me', '我来了': 'i am coming', '马上到': 'omw',
  '有人挂机': 'someone afk', '对面掉线了': 'enemy afk',
  '他太肥了': 'he is fed', '打不过': "can't beat him", '小心他': 'care him',
  // 对线/节奏
  '我先发育': 'i farm first', '等我装备': 'wait for my items', '我六了': 'i hit 6',
  '换线': 'swap lanes', '别越塔': "don't dive", '可以越': 'we can dive',
  '他们没闪': 'no flash enemy', '对面没闪': 'enemy no flash'
};

// ========== 2. 英 → 中 (接收方向, 整句精确匹配) ==========
// 外服聊天里一半以上是这类短句/缩写, 机翻要么原样返回要么音译成"伊姆奥特夫"
const IN = {
  // 礼貌用语
  'gg': '打得好', 'ggwp': '打得好，打得漂亮', 'wp': '打得漂亮', 'gj': '干得好', 'nj': '干得好',
  'ty': '谢谢', 'thx': '谢谢', 'tyvm': '非常感谢', 'np': '没事', 'yw': '不客气',
  'sry': '抱歉', 'sorry': '抱歉', 'mb': '我的错', 'myme': '我的', 'mybad': '我的错',
  'ez': '轻松', 'ezgame': '轻松拿下', 'nice': '漂亮', 'lol': '哈哈', 'lmao': '哈哈',
  'bg': '打得好（带嘲讽）', 'gz': '恭喜',
  // 召唤师技能/资源
  'ss': '有闪', 'noss': '没闪', 'hasss': '有闪', 'dosshave': '有闪吗',
  'ssup': '闪好了没', 'nosum': '没召唤师技能',
  'flash': '闪现', 'tp': '传送', 'ign': '点燃', 'heal': '治疗', 'ult': '大招',
  'baron': '打大龙', 'nash': '打大龙', 'drake': '打小龙', 'dragon': '打小龙', 'herald': '打峡谷先锋',
  // 位置
  'jg': '打野', 'jgl': '打野', 'jng': '打野', 'jungle': '打野',
  'sup': '辅助', 'supp': '辅助', 'support': '辅助',
  'mid': '中路', 'top': '上路', 'bot': '下路', 'adc': 'ADC',
  // 差距 —— 机翻会变成"顶部间隙"
  'topgap': '上路差距', 'midgap': '中路差距', 'jggap': '打野差距', 'jnggap': '打野差距',
  'junglegap': '打野差距', 'botgap': '下路差距', 'adcgap': '下路差距', 'supgap': '辅助差距',
  'supportgap': '辅助差距', 'gap': '差距', 'diff': '差距', 'teamgap': '全队差距',
  'topdiff': '上路差距', 'middiff': '中路差距', 'jgdiff': '打野差距', 'botdiff': '下路差距',
  'junglediff': '打野差距', 'toplanediff': '上路差距', 'midlanediff': '中路差距',
  'botlanediff': '下路差距', 'adcdiff': '下路差距', 'supdiff': '辅助差距',
  // 组合短句 (机翻会拆坏或音译, 整句直接给)
  'whereareyou': '你在哪', 'whereisjg': '打野在哪', 'whereisenemyjg': '对面打野在哪',
  'enemyjgtop': '对面打野在上路', 'enemyjgbot': '对面打野在下路',
  'imotw': '我在路上', 'imomw': '我在路上', 'onmyway': '我在路上',
  // 机翻会丢关键词的固定句 (实测 2026-11-04)
  'theyaredoingbaron': '他们在打大龙', 'theyareonbaron': '他们在打大龙',
  'doingbaron': '在打大龙', 'doingdragon': '在打小龙',
  'ourjgisinting': '我方打野在送', 'jgisinting': '打野在送',
  'nosstop': '上路没闪', 'nossmid': '中路没闪', 'nossbot': '下路没闪', 'nossjg': '打野没闪',
  'carecare': '小心', 'go': '上', 'gogo': '上上上',
  // 投降/状态
  'ff': '投降', 'ff15': '15 分钟投降', 'ff20': '20 分钟投降', 'noff': '不投降',
  'otw': '我在路上', 'omw': '马上到', 'brb': '马上回来', 'afk': '挂机', 'dc': '掉线',
  'nvm': '算了', 'idk': '不知道', 'idc': '无所谓', 'nvmgo': '算了继续',
  'inting': '在送人头', 'int': '送人头', 'troll': '摆烂', 'fed': '发育很好', 'feed': '在送',
  // 指令
  'push': '推塔', 'group': '抱团', 'groupup': '抱团', 'recall': '回城', 'b': '回城',
  'oom': '没蓝', 'oov': '没视野', 'care': '小心', 'careful': '小心',
  'wait': '等等', 'stop': '停下', 'go': '上', 'now': '现在',
  'onemore': '再来一局', 'rematch': '再来一局', 'again': '再来一局',
  'wpgg': '打得好，gg', 'goodgame': '打得好'
};

// ========== 3. 译文后纠正: 英文 (发送方向) ==========
// 只收「通用机翻必错」的固定说法, 不做语序级改写, 避免越改越乱
const FIX_EN = [
  // 用户偏好 "gap" 而不是 "diff"（"top diff" 社区也用，但 gap 更贴近"差距"的原意）
  [/\btop (?:lane )?diff\b/gi, 'top gap'],
  [/\bmid (?:lane )?diff\b/gi, 'mid gap'],
  [/\bdiff\b/gi, 'gap'],
  [/\bthe road gap\b/gi, 'top gap'],
  [/\broad gap\b/gi, 'top gap'],
  [/\bthe underpass gap\b/gi, 'bot gap'],
  [/\bunderpass gap\b/gi, 'bot gap'],
  [/\bthe middle gap\b/gi, 'mid gap'],
  [/\bmiddle gap\b/gi, 'mid gap'],
  [/\bthe auxiliary gap\b/gi, 'support gap'],
  [/\bauxiliary gap\b/gi, 'support gap'],
  [/\bthe gap (?:in|on) the top lane\b/gi, 'top gap'],
  [/\bthe gap (?:in|on) the mid lane\b/gi, 'mid gap'],
  [/\bthe gap (?:in|on) the bot lane\b/gi, 'bot gap'],
  [/\bmagnosaurus\b/gi, 'baron'],
  // "大龙"被音译成《功夫熊猫》里的 "Tai Lung"（实测腾讯机翻）
  [/\btai lung\b/gi, 'baron'],
  [/\btai long\b/gi, 'baron'],
  [/\bdragonet\b/gi, 'dragon'],
  [/\bplay the group\b/gi, 'teamfight'],
  [/\bstart the group\b/gi, 'engage'],
  [/\bmake a vision\b/gi, 'ward'],
  [/\bmake vision\b/gi, 'ward'],
  [/\bthe opposite jungle\b/gi, 'the enemy jungle'],
  [/\bthe opposite jungler\b/gi, 'the enemy jungler'],
  [/\bopposite jungle\b/gi, 'enemy jungle'],
  [/\bopposite jungler\b/gi, 'enemy jungler'],
  [/\bmy big move\b/gi, 'my ult'],
  [/\bbig move\b/gi, 'ult'],
  [/\bbig skill\b/gi, 'ult'],
  [/\bgo back to the city to buy equipment\b/gi, 'recall to buy'],
  [/\bbuy equipment\b/gi, 'buy items'],
  [/\bpurchase equipment\b/gi, 'buy items'],
  [/\bpush the tower together\b/gi, 'push together'],
  [/\bkeep it steady\b/gi, 'play safe'],
  [/\bplay the group fight\b/gi, 'teamfight'],
  [/\bthe tower\b/gi, 'the turret'],
  [/\bdefense tower\b/gi, 'turret'],
  // 「差距」被机翻成 difference / disparity —— 短语表只接得住整句, 长句必须在这里兜
  [/\b(big|huge|large|massive|clear|slight) (?:difference|disparity)\b/gi, '$1 gap'],
  [/\bthe (?:difference|disparity) (?:in|on|at) the top lane\b/gi, 'the top gap'],
  [/\bthe (?:difference|disparity) (?:in|on|at) the mid lane\b/gi, 'the mid gap'],
  [/\bthe (?:difference|disparity) (?:in|on|at) the (?:bot|bottom) lane\b/gi, 'the bot gap'],
  [/\btop (?:lane )?(?:difference|disparity)\b/gi, 'top gap'],
  [/\bmid(?:dle)? (?:lane )?(?:difference|disparity)\b/gi, 'mid gap'],
  [/\b(?:bot|bottom) (?:lane )?(?:difference|disparity)\b/gi, 'bot gap'],
  [/\bsupport (?:lane )?(?:difference|disparity)\b/gi, 'support gap'],
  [/\bjungle (?:difference|disparity)\b/gi, 'jungle gap'],
  [/\bdifference\b/gi, 'gap'],
  [/\bdisparity\b/gi, 'gap'],
  // 实测腾讯机翻产物 (2026-11-04): 「上路差距太大」→ "a big gap in the road"
  [/\b(?:a |the )?(?:big |huge )?gap in the road\b/gi, 'top gap'],
  [/\broad\b/gi, 'top'],
  // 「中路被压制了」→ "The middle is suppressed"
  [/\bthe middle is (?:suppressed|pressed|under pressure)\b/gi, 'mid is losing'],
  // 「打野来抓我」→ "Jungle to catch me"
  [/\bjungle to catch me\b/gi, 'jungle is coming for me'],
  // 「别越塔」→ "Do not cross the tower"
  [/\bcross the (?:turret|tower)\b/gi, 'dive the turret'],
  // 「等我装备」→ "Wait for me to equip"
  [/\bwait for me to equip\b/gi, 'wait for my items']
];

// ========== 4. 译文后纠正: 中文 (接收方向) ==========
const FIX_ZH = [
  // 机翻会把 lane 也一起翻出来 ("顶部车道差异" / "the top lane difference")，先把分路词归位
  [/顶部(?:车道|路线|路)/g, '上路'],
  [/上方(?:车道|路线)/g, '上路'],
  [/中部(?:车道|路线|路)|中间(?:车道|路线)/g, '中路'],
  [/底部(?:车道|路线|路)|下方(?:车道|路线)/g, '下路'],
  [/辅助位?的?(?:车道|路线)/g, '辅助'],
  [/顶部(?:间隙|差异|差距)/g, '上路差距'],
  [/上路(?:间隙|差异)/g, '上路差距'],
  [/中等(?:间隙|差异|差距)/g, '中路差距'],
  [/中部(?:间隙|差异|差距)/g, '中路差距'],
  [/丛林(?:间隙|差异|差距)/g, '打野差距'],
  [/底部(?:间隙|差异|差距)/g, '下路差距'],
  [/下方(?:间隙|差异|差距)/g, '下路差距'],
  [/辅助(?:间隙|差异)/g, '辅助差距'],
  [/中路(?:间隙|差异)/g, '中路差距'],
  [/下路(?:间隙|差异)/g, '下路差距'],
  [/打野(?:间隙|差异)/g, '打野差距'],
  [/道路差距|公路差距|马路差距/g, '上路差距'],
  [/地下通道|地下道/g, '下路'],
  [/拉古诺/g, '大龙'],
  [/男爵(?!夫人)/g, '大龙'],
  [/他吃饱了/g, '他发育起来了'],
  [/伊姆奥特夫|伊姆·奥特夫/g, '我在路上'],
  [/关心\s*ss|关心闪现/gi, '注意对面闪现'],
  [/没有\s*ss/gi, '对面没闪'],
  [/做出视野|做个视野/g, '做视野'],
  [/一组|一群人/g, '抱团'],
  // 实测腾讯机翻 (2026-11-04): "The top lane difference is huge" → 「上道差异巨大」
  [/上道(?:差异|差距|间隙)/g, '上路差距'],
  [/中道(?:差异|差距|间隙)/g, '中路差距'],
  [/下道(?:差异|差距|间隙)/g, '下路差距'],
  // "our jg is inting" → 「我们的jg是inting」
  [/我们的?\s*jg\s*是?\s*inting/gi, '我方打野在送'],
  [/\bjg\b/gi, '打野'],
  [/inting/g, '送人头'],
  [/是送人头/g, '在送人头'],
  // "no ss top" → 「无ss顶部」
  [/无\s*ss\s*顶部/gi, '上路没闪'],
  [/无\s*ss/gi, '没闪'],
  // "ff at 20" → 「FF 20」
  [/\bff\s*(\d+)\b/gi, '$1 投'],
  // "the top very strong" → 「顶部非常坚固」。坚固/牢固/结实/强壮 是形容建筑或身体的,
  // 形容一条分路/一个选手要用"强" (2026-11-05 用户实测指出: 上路应该"非常强"而不是"非常坚固")
  [/坚固|牢固|结实/g, '强'],
  [/强壮|强悍/g, '强'],
  // 机翻把分路词原样留在中文里: "top is very strong" → 「top很强」。
  // 单独一个 top/mid 出现在中文译文里, 基本都是没翻的分路词。
  [/\btop\b/gi, '上路'],
  [/\bmid\b/gi, '中路'],
  // 兜底: 机翻剩下的分路词
  [/顶部/g, '上路'],
  [/底部/g, '下路'],
  [/丛林/g, '打野']
];

function applyList(text, list) {
  let out = String(text == null ? '' : text);
  for (const [re, to] of list) out = out.replace(re, to);
  return out;
}

// target 为 'zh-CN' 表示接收方向 (外→中), 其余为发送方向
function isInbound(target) {
  const t = String(target || '').toLowerCase();
  return t.startsWith('zh');
}

// 整句短语表命中 (发送方向)；未命中返回 ''
function phraseOut(text) {
  const key = norm(text);
  return key && Object.prototype.hasOwnProperty.call(OUT, key) ? OUT[key] : '';
}

// 整句短语表命中 (接收方向)；未命中返回 ''
function phraseIn(text) {
  const key = norm(text);
  return key && Object.prototype.hasOwnProperty.call(IN, key) ? IN[key] : '';
}

// 译文纠正：按方向选表
function polish(text, target) {
  return isInbound(target) ? applyList(text, FIX_ZH) : applyList(text, FIX_EN);
}

// 英文原文里常见的黑话, 给"我没翻译成功"的情况兜底 (比如接口全挂)
function fallbackIn(text) {
  return phraseIn(text);
}

module.exports = {
  norm,
  OUT,
  IN,
  FIX_EN,
  FIX_ZH,
  isInbound,
  phraseOut,
  phraseIn,
  polish,
  fallbackIn
};
