// 聊天翻译（translate.js）行为测试
// 重点是被忽略的那一半：自己在游戏里打的中文有没有被翻出来补发给队友。
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
}

const SRC = fs.readFileSync(path.join(__dirname, 'renderer/js/translate.js'), 'utf8');

function makeEnv(opts = {}) {
  const sent = [];
  const translated = [];
  const pushed = [];
  const store = Object.assign({ gameTranslate: '1', translateTarget: 'en', gtAutoMine: '1' }, opts.store || {});
  const messages = opts.messages || [];
  const clock = { t: 1700000000000 };
  const urls = [];
  const ctx = {
    console, Promise, Number, String, Array, Set, Map, JSON, Math, Object,
    setTimeout: (fn) => { if (typeof fn === 'function') Promise.resolve().then(fn); return 1; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    Date: { now: () => clock.t, parse: Date.parse },
    storeGet: k => (store[k] === undefined ? '' : store[k]),
    storeSet: (k, v) => { store[k] = v; },
    showToast: () => {},
    guardWrite: () => (opts.allowWrite === false ? false : true),
    lcuConnected: true,
    document: { getElementById: () => null },
    window: { _gameflowPhase: 'InProgress' },
    getGameChatCid: async () => opts.cid === undefined ? 'c1' : opts.cid,
    lolAPI: {
      lcuRequest: async (method, url) => {
        urls.push(String(url));
        if (/\/messages$/.test(url)) return messages;
        if (/\/lol-chat\/v1\/me$/.test(url)) return { id: opts.myId || 'me-id' };
        if (/\/current-summoner$/.test(url)) return opts.puuid ? { puuid: opts.puuid, gameName: opts.myName || '' } : {};
        if (/\/conversations$/.test(url)) return opts.convs || [];
        return {};
      },
      translateText: async (texts, target) => {
        translated.push({ texts, target });
        return texts.map((t) => {
          if (opts.failTranslate) return '';
          if (target === 'en') return opts.enResult !== undefined ? opts.enResult : ('EN[' + t.length + ']');
          return '中文译文(' + t + ')';
        });
      },
      sendGameChatNow: async (text) => { sent.push(text); return { ok: true }; },
      gameTranslatePush: (payload) => pushed.push(payload),
      debugLog: () => {}
    }
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  vm.runInContext('initGameTranslate()', ctx);   // 从 store 载入开关（gtEnabled / gtAutoMine）
  return {
    ctx, sent, translated, pushed, clock, urls,
    advance: ms => { clock.t += ms; },
    get: n => vm.runInContext(n, ctx),
    set: (n, v) => vm.runInContext(`${n} = ${JSON.stringify(v)}`, ctx),
    run: fn => vm.runInContext(fn, ctx)
  };
}

const flushAsync = () => new Promise(r => setTimeout(r, 60));

function msg(id, body, fromId) {
  return { id, body, fromId: fromId || 'other-id', fromDisplay: { gameName: '老外' } };
}

(async () => {
  console.log('— 语种判定 —');
  {
    const e = makeEnv();
    ok('纯英文算外语', e.run('gtLooksForeign')('gg wp') === true);
    ok('日文算外语', e.run('gtLooksForeign')('ありがとう') === true);
    ok('纯中文不算外语', e.run('gtLooksForeign')('谢谢你') === false);
    ok('含中文就不当外语', e.run('gtLooksForeign')('gg 谢谢') === false);
  }

  console.log('— 别人发的消息 —');
  {
    const e = makeEnv({ messages: [msg('1', 'mid open'), msg('2', 'push top')] });
    await e.run('gtScan')();
    await flushAsync();
    ok('外语消息被翻译成中文', e.translated.some(t => t.target === 'zh-CN'), e.translated);
    ok('译文推进浮窗', e.pushed.length > 0 && e.pushed[0].lines.length === 2, e.pushed);
    ok('别人的消息不会被补发', e.sent.length === 0, e.sent);
  }
  {
    const e = makeEnv({ messages: [msg('1', '谢谢你', 'other-id')] });
    await e.run('gtScan')();
    await flushAsync();
    ok('别人的中文不翻译', e.translated.length === 0, e.translated);
  }

  console.log('— 我自己发的消息 —');
  {
    // 1.5.46: 进局前的"我发过的"历史消息绝不补发 (如"连败衰神"每局开局复读)
    const oldTs = new Date(1700000000000 - 60000).toISOString();
    const e = makeEnv({ messages: [Object.assign(msg('1', '连败衰神', 'me-id'), { timestamp: oldTs })] });
    await e.run('gameTranslateOnPhase')('InProgress');   // 设置进局时间
    await e.run('gtScan')();
    await flushAsync();
    ok('进局前的我方历史消息不补发', e.sent.length === 0 && e.translated.length === 0, e.sent);
  }
  {
    const e = makeEnv({ messages: [msg('1', '打野在中路', 'me-id')] });
    await e.run('gtScan')();
    await flushAsync();
    ok('我发的中文被翻译成目标语言', e.translated.some(t => t.target === 'en'), e.translated);
    ok('译文被补发到游戏聊天', e.sent.length === 1 && /^EN\[/.test(e.sent[0]), e.sent);
    const lines = e.pushed.length ? e.pushed[e.pushed.length - 1].lines : [];
    ok('浮窗里也显示我补发了什么', lines.some(l => /已补发/.test(l.name) && /^EN\[/.test(l.translated)), lines);
  }
  {
    const e = makeEnv({ messages: [msg('1', '打野在中路', 'me-id')], store: { gtAutoMine: '0' } });
    await e.run('gtScan')();
    await flushAsync();
    ok('关掉开关后我发的中文不再补发', e.sent.length === 0 && e.translated.length === 0, e.sent);
  }
  {
    // 我发的英文：翻成中文放进浮窗，确认自己那句在外服语境里的意思；不补发
    const e = makeEnv({ messages: [msg('1', 'top gap', 'me-id')] });
    await e.run('gtScan')();
    await flushAsync();
    ok('我发的英文被翻成中文', e.translated.some(t => t.target === 'zh-CN'), e.translated);
    ok('我发的英文不补发', e.sent.length === 0, e.sent);
    const lines = e.pushed.length ? e.pushed[e.pushed.length - 1].lines : [];
    ok('浮窗里显示我的英文和中文意思', lines.some(l => l.body === 'top gap' && /中文译文/.test(l.translated)), lines);
  }
  {
    // 译文里残留中文 → 宁可不发，也别让队友看到半截
    const e = makeEnv({ messages: [msg('1', '打野在中路', 'me-id')], enResult: 'jungler 在中路' });
    await e.run('gtScan')();
    await flushAsync();
    ok('译文残留中文时不发送', e.sent.length === 0, e.sent);
  }
  {
    // 翻译接口返回空 → 不能把原文再发一遍
    const e = makeEnv({ messages: [msg('1', '打野在中路', 'me-id')], failTranslate: true });
    await e.run('gtScan')();
    await flushAsync();
    ok('翻译失败时不发原文', e.sent.length === 0, e.sent);
  }
  {
    // 我们自己补发的译文会被扫到，必须靠 gtEchoed 挡住，否则死循环
    const e = makeEnv({ messages: [msg('1', '打野在中路', 'me-id')] });
    await e.run('gtScan')();
    await flushAsync();
    const firstSent = e.sent.slice();
    // 把发出去的译文当成一条新消息再扫一遍
    const echoMsg = msg('2', firstSent[0], 'me-id');
    vm.runInContext('gtQueue = []', e.ctx);
    vm.runInContext('gtSeen = new Set()', e.ctx);
    e.ctx.lolAPI.lcuRequest = async (m, url) => (/\/messages$/.test(url) ? [echoMsg] : {});
    await e.run('gtScan')();
    await flushAsync();
    ok('补发的译文不会被再翻一次', e.sent.length === firstSent.length, { before: firstSent.length, after: e.sent.length });
  }
  {
    const e = makeEnv({ messages: [msg('1', '打野在中路', 'me-id')], allowWrite: false });
    await e.run('gtScan')();
    await flushAsync();
    ok('合规模式下不代发', e.sent.length === 0, e.sent);
  }

  console.log('— 防刷屏 (1.5.33) —');
  {
    // 默认开启: 没存过 gtAutoMine 时，游戏里打中文就自动补英文（这才是"不用切窗口"的用法）
    const e = makeEnv({ messages: [msg('1', '打野在中路', 'me-id')], store: { gtAutoMine: '' } });
    await e.run('gtScan')();
    await flushAsync();
    ok('默认就自动补发', e.sent.length === 1, e.sent);
  }
  {
    // 击杀播报挂着本人名字, 会被当成"我发的消息" → 不许翻译也不许补发
    const cases = [
      ['杀人如麻', 'chat'],
      ['雨未眠 已经大杀特杀', 'chat'],
      ['Riven is on a killing streak', 'chat'],
      ['on a killing streak', 'system']
    ];
    for (const [body, type] of cases) {
      const e = makeEnv({ messages: [{ id: '1', body, fromId: 'me-id', type, fromDisplay: { gameName: 'me' } }] });
      await e.run('gtScan')();
      await flushAsync();
      ok('系统播报不翻译不补发: ' + body, e.sent.length === 0 && e.translated.length === 0,
        { sent: e.sent, translated: e.translated });
    }
  }
  {
    // 真正的原凶: bench.js 兜底轮询每 12 秒重复调 handleGameflowPhase('InProgress')，
    // 早先每次都重置 gtSeen → 同一批消息无限重发
    const e = makeEnv({ messages: [msg('1', '打野在中路', 'me-id')] });
    await e.run('gameTranslateOnPhase')('InProgress');   // 进局的那一次回调
    await e.run('gtScan')();
    await flushAsync();
    const first = e.sent.length;
    ok('第一次正常补发一条', first === 1, e.sent);
    for (let i = 0; i < 3; i++) {
      e.advance(12000);
      await e.run('gameTranslateOnPhase')('InProgress');
      await e.run('gtScan')();
      await flushAsync();
    }
    ok('12 秒重复回调不再补发', e.sent.length === first, { before: first, after: e.sent.length });
    ok('已读集合没有被清空', e.get('gtSeen.size') >= 1, e.get('gtSeen.size'));
    // 真的打完一局再进下一局, 状态才该重置
    await e.run('gameTranslateOnPhase')('EndOfGame');
    await e.run('gameTranslateOnPhase')('InProgress');
    ok('换局后才重置已读', e.get('gtSeen.size') === 0, e.get('gtSeen.size'));
  }
  {
    // 同一句 5 秒内不重发，超过窗口就该发（正常重复说话不能被卡死）
    const e = makeEnv({ messages: [msg('1', '打野在中路', 'me-id')] });
    await e.run('gtScan')();
    await flushAsync();
    const first = e.sent.length;
    e.advance(2000);
    e.ctx.lolAPI.lcuRequest = async (m, url) => (/\/messages$/.test(url) ? [msg('2', '打野在中路', 'me-id')] : {});
    await e.run('gtScan')();
    await flushAsync();
    ok('同一句 2 秒内不重发', e.sent.length === first, { before: first, after: e.sent.length });
    e.advance(10000);
    e.ctx.lolAPI.lcuRequest = async (m, url) => (/\/messages$/.test(url) ? [msg('3', '打野在中路', 'me-id')] : {});
    await e.run('gtScan')();
    await flushAsync();
    ok('过了窗口后重复说话照常发', e.sent.length === first + 1, { want: first + 1, got: e.sent.length });
  }
  {
    // 每局总量闸门 (只防失控, 不能影响正常交流)
    const msgs = [];
    // 每条长度都不同, 否则假翻译器会返回同一串译文, 被"同句不重发"挡掉 (那是另一条规则)
    for (let i = 0; i < 60; i++) msgs.push(msg('m' + i, '第' + i + '句话' + '啊'.repeat(i), 'me-id'));
    const e = makeEnv({ messages: msgs });
    for (let i = 0; i < 60; i++) { e.advance(2000); await e.run('gtScan')(); await flushAsync(); }
    ok('每局补发有上限', e.sent.length <= 40 && e.sent.length >= 1, e.sent.length);
  }

  console.log('— OCR 聊天框通道 (1.5.46 / 1.5.51 收紧) —');
  {
    // 1.5.51 契约变更: 只认"时间戳+频道"齐全的聊天头。没有头部的文字
    // (界面提示、系统播报、别的窗口内容) 一律不进翻译管线 —— 它们是幻影消息的来源。
    const e = makeEnv({});
    const lines = await e.run('gtParseOcrChatLines')(
      '00:02 [All] Rain: Good Luck\n0:05 雨未散：连败衰神\ndragon at 15:30');
    ok('OCR 只收带"时间戳+频道"的聊天', lines.length === 1 && lines[0].body === 'Good Luck', lines);
    ok('OCR 解析结果带时间戳与频道 (去重键)', lines[0] && lines[0].ts === '00:02' && lines[0].channel === 'All', lines[0]);
  }
  {
    // 1.5.49: 真实游戏日志格式 —— 括号时间戳 + 中文玩家名(英雄名)前缀,
    // 前缀不剥会被 GT_ZH_RE 把队友外语消息整行误杀
    const e = makeEnv({});
    const raw = '(08:24) [队伍] 雨未散 (战争女神): bang is world\'s best ad\n'
      + '(00:03) [队伍] Faker (发条魔灵): IG is awesome.\n'
      + '(00:26) [队伍] Faker: dragon at 15:30';
    const lines = await e.run('gtParseOcrChatLines')(raw);
    const bodies = lines.map(l => l.body);
    ok('OCR 括号时间戳+中文名(英雄)前缀剥除', bodies[0] === 'bang is world\'s best ad' && bodies[1] === 'IG is awesome.', bodies);
    ok('OCR 正文里的时间不被当分隔符', bodies[2] === 'dragon at 15:30', bodies);
    ok('OCR 时间戳统一成 mm:ss', lines[0] && lines[0].ts === '08:24', lines[0]);
  }
  {
    // 1.5.48: 浮窗提示条/后台应用杂音行整行丢弃 (17:31 局 OCR 日志实证)
    const e = makeEnv({});
    const raw = 'Ctrl+F10 打字 - 回车发给队友 · 可拖动/滚轮回看 · Esc 取消\n'
      + '行情 SNXXUSDT Tradr 2x Long SNDK ETF game\n'
      + '00:02 [All] Rain: luck game\n'
      + 'nice escape mid';
    const lines = await e.run('gtParseOcrChatLines')(raw);
    const bodies = lines.map(l => l.body);
    ok('OCR 杂音行 (浮窗提示/混杂行情/无头部行) 丢弃', bodies.length === 1 && bodies[0] === 'luck game', bodies);
    const e2 = makeEnv({});
    e2.ctx.lolAPI.gameTranslateOcrChat = async () => raw;
    await e2.run('gtOcrScan')();
    await flushAsync();
    ok('OCR 含中文杂音行不进翻译管线', e2.translated.length === 1 && e2.translated[0].texts[0] === 'luck game', e2.translated);
  }
  {
    const e = makeEnv({});
    e.ctx.lolAPI.gameTranslateOcrChat = async () => '00:02 [All] Rain: Good Luck\n0:05 雨未散：连败衰神';
    await e.run('gtOcrScan')();
    await flushAsync();
    ok('OCR 外语行进翻译管线', e.translated.some(t => t.target === 'zh-CN'), e.translated);
    ok('OCR 中文行不处理 (无法判定身份)', !e.translated.some(t => t.target === 'en'), e.translated);
    ok('OCR 行不补发', e.sent.length === 0, e.sent);
  }
  {
    // 1.5.51 真实报障夹具 (18:31 局 [GT OCR] 原文, 整块被 OCR 读成一行):
    // 头部断行必须能在这串里认出 00:18 / 00:29 两条聊天, 其余全部丢弃。
    const e = makeEnv({});
    const raw = '` 丸 he | p 获 取 命 令 列 表 00 《 06 惩 戒 之 箭 已 经 选 择 了 位 置 ： 上 路 '
      + '00 ： 10 [ 队 伍 ] 雨 未 散 （ 惩 戒 之 箭 ） ： 大 家 女 新 '
      + '00 ： 18 [ 队 伍 ] 雨 未 散 （ 惩 戒 之 箭 ） ： hello everyone '
      + '00 ： 29 [ 队 伍 ] 雨 未 散 （ 惩 戒 之 箭 ） ： congratulations '
      + '1 ： 22 [ 队 伍 ] 雨 未 散';
    const lines = await e.run('gtParseOcrChatLines')(raw);
    const bodies = lines.map(l => l.body);
    ok('OCR 合并单行按头部断行 (带空格的 "00 ： 18" 也认)', bodies.length === 2, bodies);
    ok('OCR 合并单行只留真实外文消息', bodies[0] === 'hello everyone' && bodies[1] === 'congratulations', bodies);
    ok('OCR 头部前的 /help 提示被丢弃', !bodies.some(b => /help|获 取|命 令/i.test(b)), bodies);
  }
  {
    // 1.5.51 核心回归: 同一时间戳在不同轮次被读成不同版本, 只能产生一条翻译。
    const e = makeEnv({});
    let raw = '00:18 [队伍] 雨未散 (惩戒之箭): hello everyone\n'
      + '00:29 [队伍] 雨未散 (惩戒之箭): congratulations';
    e.ctx.lolAPI.gameTranslateOcrChat = async () => raw;
    await e.run('gtOcrScan')(); await flushAsync();
    raw = '00:18 [队伍] 雨未散 (惩戒之箭): hello éVeryone\n'
      + '00:29 [队伍] 雨未散 (惩戒之箭): congratulations\n'
      + '00:31 [队伍] 雨未散 (惩戒之箭): nice escape mid';
    e.advance(4000);
    await e.run('gtOcrScan')(); await flushAsync();
    const texts = e.translated.flatMap(t => t.texts || []);
    ok('OCR 同时间戳残片不再产生幻影消息',
      texts.length === 3 && texts.includes('hello everyone') && texts.includes('congratulations') && texts.includes('nice escape mid'), texts);
    ok('OCR 抖动版本不进翻译', !texts.some(t => /éVeryone/.test(t)), texts);
  }
  {
    // 1.5.51: 中文污染的行不再"抽外文片段", 整条丢 —— "tion" 就是这么冒出来的
    const e = makeEnv({});
    const lines = await e.run('gtParseOcrChatLines')('(08:24) [队伍] 雨未散 (惩戒之箭): gra 卣 白 tion');
    ok('OCR 中文污染残片整条丢弃', lines.length === 0, lines);
  }
  {
    // 1.5.51: 单个词可能是长词被截断的一半 —— 先待确认, 下一轮读到更完整的就用完整的
    const e = makeEnv({});
    let raw = '00:29 [队伍] 雨未散 (惩戒之箭): ulations';
    e.ctx.lolAPI.gameTranslateOcrChat = async () => raw;
    await e.run('gtOcrScan')(); await flushAsync();
    ok('OCR 单词残片先待确认 (不立刻翻译)', e.translated.length === 0, e.translated);
    raw = '00:29 [队伍] 雨未散 (惩戒之箭): congratulations';
    e.advance(4000);
    await e.run('gtOcrScan')(); await flushAsync();
    const texts = e.translated.flatMap(t => t.texts || []);
    ok('OCR 待确认的单词升级为完整版', texts.length === 1 && texts[0] === 'congratulations', texts);
  }
  {
    // 1.5.51: 裁剪边缘切断的"半个聊天头"不能留在正文里
    const e = makeEnv({});
    const lines = await e.run('gtParseOcrChatLines')('00:18 [队伍] 雨未散 (惩戒之箭): hello everyone 00:2');
    ok('OCR 正文尾部的半截时间戳被剥掉', lines.length === 1 && lines[0].body === 'hello everyone', lines);
  }
  {
    // 1.5.52 真实报障 (19:13 局 [GT OCR] 原文): Windows OCR 把 "00:17" 读成 "丽 ： 17"
    // —— 靠时间戳断行必然整条丢; 靠频道方括号才认得出这两条。
    const e = makeEnv({});
    const raw = '输 入 / he | p 获 取 命 令 列 表 00 ： 05 傲 之 追 猎 者 已 经 选 择 了 位 置 ： 中 路 '
      + '丽 ： 17 [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 者 heIIO everyone ， '
      + '00 ： 31 [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 者 ） ： hi';
    const lines = await e.run('gtParseOcrChatLines')(raw);
    const bodies = lines.map(l => l.body);
    ok('OCR 时间戳被读成"丽 ： 17"也能认出聊天', bodies.length === 2 && bodies[0] === 'heIIO everyone' && bodies[1] === 'hi', bodies);
    ok('OCR 上一条的时间戳不粘在本条正文里', !bodies.some(b => /\d\s*[:：]\s*\d/.test(b)), bodies);
  }
  {
    // 1.5.52: 同一句话被 OCR 读成三个版本 (hello / heIIO / heII0), 只能翻一次。
    // 时间戳同时被读成 "00 ： 17" / "ÖO ： 17" / "当 7", 所以去重不能依赖它。
    const e = makeEnv({});
    let raw = '00 ： 17 [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 者 ） ： hello everyone';
    e.ctx.lolAPI.gameTranslateOcrChat = async () => raw;
    await e.run('gtOcrScan')(); await flushAsync();
    raw = 'ÖO ： 17 [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 者 ） ： heIIO everyone';
    e.advance(4000);
    await e.run('gtOcrScan')(); await flushAsync();
    raw = '当 7 [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 者 ） ： heII0 everyone';
    e.advance(4000);
    await e.run('gtOcrScan')(); await flushAsync();
    const texts = e.translated.flatMap(t => t.texts || []);
    ok('OCR 模糊去重: 同一句话的多个版本只翻一次', texts.length === 1, texts);
  }
  {
    // 商店面板 / 界面文字没有频道标记 → 整段不进翻译管线
    const e = makeEnv({});
    e.ctx.lolAPI.gameTranslateOcrChat = async () => '为 50 免 费 75 300 900 推 荐 Q 点 击 此 处 进 行 搜 索 女 守 初 始 0 400 基 础 250 史 诗 775 传 说 450';
    await e.run('gtOcrScan')(); await flushAsync();
    ok('OCR 商店面板文字不进翻译', e.translated.length === 0, e.translated);
  }

  console.log('— 会话房间解析 —');
  {
    const e = makeEnv({ cid: null, convs: [
      { id: 'c1', type: 'groupchat' },
      { id: '1234', type: 'friend' }
    ] });
    const cids = await e.run('gtResolveCids')();
    ok('championSelect 房间缺失时退到 groupchat', cids.includes('c1'), cids);
  }
  {
    const e = makeEnv({ cid: null, convs: [{ id: 'c1', type: 'custom' }, { id: '999', type: 'friend' }] });
    const cids = await e.run('gtResolveCids')();
    ok('再退一步认 c1/c2 房间号', cids.includes('c1'), cids);
  }
  {
    // 队伍 c1 和全体 c2 都要扫：只取一个的话另一边的消息永远看不到
    const e = makeEnv({ cid: null, convs: [{ id: 'c1', type: 'custom' }, { id: 'c2', type: 'custom' }] });
    const cids = await e.run('gtResolveCids')();
    ok('c1 与 c2 两个房间都扫', cids.length === 2 && cids.includes('c1') && cids.includes('c2'), cids);
  }
  {
    const e = makeEnv({ cid: null, convs: [{ id: '555', type: 'friend' }] });
    const cids = await e.run('gtResolveCids')();
    ok('只有好友私聊时宁可不翻', cids.length === 0, cids);
  }
  {
    // 实测国服非对局时只有一条 type=chat、id 是本人 puuid 的会话 → 不该被当成聊天房间
    const e = makeEnv({ cid: null, convs: [{ id: 'me@pvp.net', type: 'chat' }], puuid: 'me@pvp.net' });
    const cids = await e.run('gtResolveCids')();
    ok('本人的主会话被排除', cids.length === 0, cids);
  }
  {
    // 对局中房间名不一定是 c1/c2，认不出来时放宽度到"非好友会话"
    const e = makeEnv({ cid: null, convs: [{ id: 'me@pvp.net', type: 'chat' }, { id: 'room-42', type: 'chat' }], puuid: 'me@pvp.net' });
    const cids = await e.run('gtResolveCids')();
    ok('认不出房间名时兜底选中非好友会话', cids.includes('room-42') && !cids.includes('me@pvp.net'), cids);
  }
  {
    // 1.5.44: strict 不再挡死 loose —— 1.5.43 下午实测, 旧局对局会话 (uuid@pvp.net,
    // 游戏结束不销毁) 游戏开始时先进列表, 本局 c1/c2 建好后若 strict 只含旧房间,
    // 「strict.length ? strict : loose」会把真房间挡死, 聊天永远不翻。
    // 现在合并全扫: 旧房间无新消息, 多扫无害。
    const e = makeEnv({ cid: null, convs: [{ id: 'c1', type: 'custom' }, { id: 'room-42', type: 'chat' }] });
    const cids = await e.run('gtResolveCids')();
    ok('strict 与兜底会话合并全扫', cids.includes('c1') && cids.includes('room-42'), cids);
  }

  {
    // 1.5.43: 选人房间进对局后全程无消息, 必须排除, 别让它挡住真房间
    const e = makeEnv({
      cid: null,
      convs: [
        { id: 'cs-room@lol-champ-select.pvp.net', type: 'championSelect' },
        { id: 'real-game-room@pvp.net', type: 'chat' }
      ]
    });
    const cids = await e.run('gtResolveCids')();
    ok('选人房间被排除', !cids.includes('cs-room@lol-champ-select.pvp.net'), cids);
    ok('真对局房间被选中', cids.includes('real-game-room@pvp.net'), cids);
  }
  {
    // type 名含 champ 的也要排除 (域名校验 + 类型校验双保险)
    const e = makeEnv({
      cid: null,
      convs: [
        { id: 'room-a', type: 'championSelect' },
        { id: 'room-b', type: 'chat' }
      ]
    });
    const cids = await e.run('gtResolveCids')();
    ok('championSelect 类型被排除', !cids.includes('room-a') && cids.includes('room-b'), cids);
  }
  {
    // 端到端: 扫描请求不能落到选人房间上
    const e = makeEnv({
      cid: null,
      convs: [
        { id: 'cs-room@lol-champ-select.pvp.net', type: 'championSelect' },
        { id: 'real-game-room@pvp.net', type: 'chat' }
      ],
      messages: [msg('1', 'hello there')]
    });
    await e.run('gtScan')();
    await flushAsync();
    const scanned = e.urls.filter(u => /\/messages$/.test(u));
    ok('扫描请求不落选人房间', !scanned.some(u => u.includes('cs-room')), scanned);
    ok('扫描请求打到真房间', scanned.some(u => u.includes('real-game-room')), scanned);
    ok('外语消息照常翻译', e.translated.some(t => t.target === 'zh-CN'), e.translated);
  }

  console.log(`\n聊天翻译: ${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
})();
