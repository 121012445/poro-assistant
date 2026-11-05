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
    // 1.5.79: 假时钟把所有定时器都当"立刻执行"(节流重试/补发节流都靠它)。
    // 唯一的例外是浮窗的"（翻译中…）"占位行定时器 —— 它要是立刻触发, 每一轮
    // flush 都会先推一行占位, 后面所有断言都要改。专门验证它的用例把 GT_PEND_MS
    // 调成 0, 那时这个分支不再拦, 占位行就会正常推出来。
    setTimeout: (fn, ms) => {
      if (typeof fn !== 'function') return 1;
      if (fn.name === 'gtPendTimer' && Number(ms) > 0) return 2;
      Promise.resolve().then(fn); return 1;
    },
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
          // 1.5.75: 模拟"所有源都失败, translateBatchCore 原样返回正文"
          if (opts.echoTranslate) return t;
          // 1.5.76: 模拟"半截译文" —— 中文里夹着没翻掉的英文长词。
          // 只对**脏正文**生效 (混了非 ASCII 字符), 这样"去掉脏词重翻"那一步能拿到干净结果。
          if (opts.mixedTranslate && /[^\x20-\x7e]/.test(t)) return '你好' + String(t).split(/\s+/).pop();
          if (target === 'en') return opts.enResult !== undefined ? opts.enResult : ('EN[' + t.length + ']');
          // 译文里不能回显原文: gtTrOk 会判定"中文夹 4 个以上拉丁字母"为半截译文
          return '中文译文' + t.length;
        });
      },
      sendGameChatNow: async (text) => { sent.push(text); return { ok: true }; },
      // 真实链路是 IPC 结构化克隆: 传过去的是一份**快照**。这里必须深拷贝,
      // 否则后续对 gtRecent 的原地替换会改写已经"推出去"的那一帧, 测试就看不见
      // 占位行 → 译文的过程了 (1.5.79 踩过)。
      gameTranslatePush: (payload) => pushed.push(JSON.parse(JSON.stringify(payload))),
      // OCR 通道: 每次调用取一帧, 帧用完返回 null (相当于"这一轮没读到东西")
      gameTranslateOcrChat: opts.ocr ? async () => (opts.ocr.length ? opts.ocr.shift() : null) : undefined,
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
    // 1.5.102 真实报障夹具 (22:07 局): WeGame 自动荣誉消息是中文+英文混排,
    // 中文被"切到第一个拉丁字母"剥掉后只剩 "WeGan", 又有时间戳键, 一路闯进机翻,
    // 机翻原样吐回 → 浮窗挂出 "WeGame /（未能翻译）" (用户报障「翻译乱翻译」)。
    const e = makeEnv({});
    e.ctx.lolAPI.gameTranslateOcrChat = async () =>
      '00:16 [队伍] 雨未散 (影流之主): hello everyone\n'
      + '21:01 雨未散（影流之主）：（权威认证）超神已截图 —— WeGan\n'
      + '00:18 雨未散（影流之主）：无形之刃，最为致命（技能分配：QWE）';
    await e.run('gtOcrScan')(); await flushAsync();
    const texts = e.translated.flatMap(t => t.texts || []);
    ok('OCR 界面残渣 (WeGan/QWE) 不进翻译', texts.length === 1 && texts[0] === 'hello everyone', texts);
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
    // 1.5.54 真实报障夹具 (19:39 局, 用户截图): 改成按 OcrLine 逐行输出后, 一帧 9 行。
    // 修复前 OcrResult.Text 把 9 行用**空格**拼成一整行, 解析器 drop 3 条 / dup=0 /
    // held=0, 一条都认不出来 —— 这就是"装完 1.5.53 还是什么都不翻"的原因。
    const e = makeEnv({});
    const raw = [
      '翁 入 / he 丨 p 获 取 命 令 列 表',
      '00 ： 05 傲 之 追 猖 者 已 择 了 位 《 中 路',
      '90 ： 釕 [ 队 囿 雨 末 散 （ 傲 之 追 猎 者 ） 《 he everyone',
      'OÖ ： 31 [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 却 ： hi',
      '01 ： 32 [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 者 冫 过 ok ， “',
      '11 ： 04 [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 者 } ； goodluck',
      '1 ： 20 [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 者 ） ： goodluck',
      '5 ： 39 [ 队 伍 ] 雨 未 散 （ 傲 之 造 猎 者 ） ： congradulations',
      '25 ： [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 ： hi everyone itm from shenzhen'
    ].join('\n');
    const bodies = (await e.run('gtParseOcrChatLines')(raw)).map(l => l.body);
    // 1.5.75: 7 条 (原来是 6)。第 7 条是 01:32 的 "ok ， “" —— 行尾那个 OCR 误读的
    // 引号让 gtOcrBodyOk 整条否掉, 一条真实消息被无声吞掉。现在先剥引号再剥标点,
    // 正文归一成 "ok", 命中本地短语表直接出"好的"。
    ok('OCR 逐行输出: 9 行里抽出 7 条真实消息', bodies.length === 7, bodies);
    ok('OCR 逐行输出: 行尾引号被剥掉, ok 不再被整条丢掉', bodies.includes('ok'), bodies);
    ok('OCR 逐行输出: 正文不再粘玩家名', bodies[0] === 'he everyone' && bodies[1] === 'hi', bodies);
    ok('OCR 逐行输出: 右括号丢失的行 ("[ 队 囿 ") 仍能认出', bodies.includes('he everyone'), bodies);
    ok('OCR 逐行输出: 最长一行不被裁剪切断', bodies.includes('hi everyone itm from shenzhen'), bodies);
    ok('OCR 逐行输出: /help 提示与选人播报不进管线',
      !bodies.some(b => /help|获 取|中 路/i.test(b)), bodies);
  }
  {
    // 1.5.55 真实报障夹具 (20:05 局, 亮色丛林背景): 5x 的真实 OcrLine 输出。
    // 这一帧的频道方括号**整个消失**, 三种方括号写法全不匹配 —— 1.5.54 装上去
    // 仍然一条都不翻, 用户看到的就是"聊天框的消息没被翻译"。
    const e = makeEnv({});
    const raw = [
      '输 ） 获 取 命 令 列 表',
      '00 ： 0 破 鬼 才 已 经 选 择 了 位 置 ： 下 路 ．',
      '佣 <6 到 伍 1 雨 禾 散 （ 烁 咳 鬼 才 ） ： hello everyone',
      '00 队 伍 ] 雨 未 散 （ 鬼 才 ） hello'
    ].join('\n');
    const bodies = (await e.run('gtParseOcrChatLines')(raw)).map(l => l.body);
    ok('OCR 方括号全丢时用冒号兜底 (hello everyone)',
      bodies.includes('hello everyone'), bodies);
    ok('OCR 冒号兜底不吞系统播报', !bodies.some(b => /下 路|位 置/.test(b)), bodies);
  }
  {
    // 同一局深色背景帧 (5x): 方括号健在, 走原来的频道锚点, 7 条消息一条不少
    const e = makeEnv({});
    const raw = [
      '制 入 / he!p 获 取 命 令 列 表',
      '00 ： 05 傲 之 追 猎 者 已 择 了 位 ； 中 路',
      '00 ： 07 [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 者 hello even;one',
      '00 ： 31 [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 者 ） ： hi',
      '01 ： 32 [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 者 tokyo',
      '11 ： 04 [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 者 goodluck',
      '11 ： 20 [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 者 goodluck',
      '25 ： 39 [ 队 伍 ] 雨 未 散 （ 傲 之 犭 congradulations',
      "25 ： 56 [ 队 到 雨 未 散 （ 傲 之 追 猎 ） ： hieveryone i'm from shenzhen"
    ].join('\n');
    const bodies = (await e.run('gtParseOcrChatLines')(raw)).map(l => l.body);
    ok('OCR 5x 深色帧: 7 条消息全部抽出', bodies.length === 7, bodies);
    ok('OCR 5x 深色帧: tokyo / goodluck 读对',
      bodies.includes('tokyo') && bodies.filter(b => b === 'goodluck').length === 2, bodies);
  }
  {
    // 冒号兜底不能把 "dragon at 15:30" 这种正文里的时间当锚点
    const e = makeEnv({});
    const bodies = (await e.run('gtParseOcrChatLines')('dragon at 15:30')).map(l => l.body);
    ok('OCR 冒号兜底不切正文里的时间', bodies.length === 0, bodies);
  }
  {
    // worker 契约: 必须按 OcrLine 逐行输出。OcrResult.Text 会用空格把多行拼成一行,
    // 一旦有人改回去, 聊天 OCR 会静默退化成"一条都认不出"(不报错, 只是没反应)。
    const ps = fs.readFileSync(path.join(__dirname, 'main/native/PoroOcrWorker.ps1'), 'utf8');
    ok('OCR worker 按行输出 ($result.Lines + LF 拼接)',
      /\$result\.Lines/.test(ps) && /-join "`n"/.test(ps), 'worker 里找不到逐行输出');
    ok('OCR worker 不再直接输出 $result.Text', !/GetBytes\(\$result\.Text\)/.test(ps));
  }
  {
    // 1.5.54: 同一句在相邻两轮被读成 "he everyone" / "hello everyone" (差 3 个字母,
    // 相似度只有 0.77) —— 放宽前会翻两遍。短句不能跟着放宽。
    const e = makeEnv({});
    const same = await e.run('gtOcrSame');
    ok('OCR 长句差 3 个字母视为同一条 (he everyone ≈ hello everyone)',
      same('heeveryone', 'helloeveryone') === true);
    ok('OCR 短句差 2 个字母不合并 (gg ≠ ggwp)', same('gg', 'ggwp') === false);
    // 1.5.55: 裸包含判定把握手式前缀并掉了 —— 真实帧里 00:16 "hello everyone" 之后
    // 00:39 的 "hello" 是**另一条真消息**, 却被当成重复吞掉。加了 0.6 长度比例门禁。
    ok('OCR 包含判定加比例门禁 (hello ≠ hello everyone)', same('hello', 'helloeveryone') === false);
    ok('OCR 包含判定加比例门禁 (good ≠ goodluck)', same('good', 'goodluck') === false);
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
    // 1.5.53 真实输出 (y45~62% + 4x 裁剪, 19:31 局): 5 条聊天里能干净取出 4 条,
    // 剩下 "tokyo 的"/"℃ 4" 是 OCR 自己读坏的 (yoyo/ggwp), 丢得对。
    const e = makeEnv({});
    const raw = '00 ： 05 傲 之 追 猎 者 已 经 选 择 了 位 首 ： 中 路 '
      + '00 ： 17 [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 者 〕 ： hello everyone '
      + 'OO ： 31 [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 者 ） ： hi '
      + '01 ： 32 [ 队 伍 ] 雨 人 散 （ 傲 之 追 猎 者 ） ： tokyo 的 '
      + '11 ℃ 4 「 队 伍 ] 雨 未 散 （ 傲 之 追 猎 者 ） ： goodluck '
      + '11 ： 20 [ 队 伍 ] 雨 未 散 （ 傲 之 追 猎 司 ： goodluck';
    const lines = await e.run('gtParseOcrChatLines')(raw);
    const bodies = lines.map(l => l.body);
    ok('4x 裁剪输出: 4 条真实消息全取出', bodies.length === 4
      && bodies[0] === 'hello everyone' && bodies[1] === 'hi'
      && bodies[2] === 'goodluck' && bodies[3] === 'goodluck', bodies);
    ok('残缺左括号 "「" 也认作频道标记', bodies.filter(b => b === 'goodluck').length === 2, bodies);
    ok('时间戳被读成 "OO ： 31" 时不污染正文', !bodies.some(b => /OO\s*[:：]/.test(b)), bodies);
  }
  {
    // 1.5.53: 同一句话被 OCR 读成三个版本 (hello / heIIO / heII0), 只能翻一次。
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

  // ---- OCR 通道去重 ----
  // 国服对局里 LCU 聊天接口常常只给到一条空会话 (strict=0 loose=1), 真实消息全靠
  // 截屏 OCR。OCR 每 4 秒重读整个聊天框, 同一句话会因为渲染/遮挡读出不同版本
  // ("hello everyone" → "h eryone")。1.5.67 之前按正文模糊比对, 版本差得多就当成
  // 新消息, 于是"来一条新消息, 旧消息被重新翻译一遍"。
  console.log('— OCR 通道去重 —');
  {
    const e = makeEnv({
      ocr: [
        '02:38 [队伍] 雨未散（暗裔剑魔）: hello everyone',
        '02:38 [队伍] 雨未散（暗裔剑魔）: h eryone'
      ]
    });
    await e.run('gtOcrScan')();
    await flushAsync();
    const t1 = e.get('_gtOcrTotal');
    e.advance(4000);            // gtFlush 有 250ms 节流, 假时钟不推进会无限递归
    await e.run('gtOcrScan')();
    await flushAsync();
    const t2 = e.get('_gtOcrTotal');
    ok('同一句的残缺读法不再进翻译管线', t1 === 1 && t2 === 1, { t1, t2 });
    const lines = e.pushed.length ? e.pushed[e.pushed.length - 1].lines : [];
    ok('浮窗里只有一行', lines.length === 1, lines);
    ok('时间戳键随行一起下发', lines.length === 1 && lines[0].k === '02:38', lines[0]);
  }
  {
    // 先读到残缺版、后读到完整版: 原地替换那一行, 而不是多出一行
    const e = makeEnv({
      ocr: [
        '02:38 [队伍] 雨未散（暗裔剑魔）: h eryone',
        '02:38 [队伍] 雨未散（暗裔剑魔）: hello everyone'
      ]
    });
    await e.run('gtOcrScan')();
    await flushAsync();
    const first = e.pushed[e.pushed.length - 1].lines;
    ok('残缺版先占一行', first.length === 1 && first[0].body === 'h eryone', first);
    e.advance(4000);
    await e.run('gtOcrScan')();
    await flushAsync();
    const lines = e.pushed[e.pushed.length - 1].lines;
    ok('读得更完整时仍是一行', lines.length === 1, lines);
    ok('那一行换成完整正文', lines.length === 1 && lines[0].body === 'hello everyone', lines[0]);
  }
  {
    // 不同时间戳 = 不同消息, 必须各占一行
    const e = makeEnv({
      ocr: [
        '02:38 [队伍] 雨未散: hello everyone\n03:21 [队伍] 雨未散: good morning'
      ]
    });
    await e.run('gtOcrScan')();
    await flushAsync();
    const lines = e.pushed.length ? e.pushed[e.pushed.length - 1].lines : [];
    ok('不同消息各占一行', lines.length === 2, lines);
  }
  {
    // 1.5.68 真实报障 (用户截图: "marry me 和 good job 中间又插了一条旧消息")。
    // 05:57 局 [GT OCR] 原文里, 同一句 "hello everyone" 这一帧的频道方括号被读成
    // "」 五 ]" (走冒号兜底), 下一帧才读成 "[ 队 伍 ]"。1.5.67 的键是"频道|时间戳",
    // 兜底那条拿不到频道 → 键不同 → 同一条消息被当成两条, 后到的那条追加在末尾,
    // 于是浮窗里旧消息插到了新消息中间。
    const e = makeEnv({
      ocr: [
        '02:38 」 五 ] 雨 未 散 （ 暗 裔 剑 ） ： Vhe № everyonq\n'
          + '03:21 [ 队 伍 ] 雨 未 散 （ 暗 裔 剑 魔 ） ： marry me',
        '02:38 [ 队 伍 ] 雨 未 散 （ 暗 裔 剑 魔 ） ： hello everyone\n'
          + '03:21 [ 队 伍 ] 雨 未 散 （ 暗 裔 剑 魔 ） ： marry me\n'
          + '04:09 [ 队 伍 ] 雨 未 散 （ 暗 裔 剑 魔 ） ： good job'
      ]
    });
    await e.run('gtOcrScan')();
    await flushAsync();
    e.advance(4000);
    await e.run('gtOcrScan')();
    await flushAsync();
    const lines = e.pushed[e.pushed.length - 1].lines;
    ok('频道读丢的同一句不再多出一行', lines.length === 3, lines.map(l => l.body));
    ok('乱码行被更干净的一版原地替换', lines[0] && lines[0].body === 'hello everyone', lines[0]);
    ok('旧消息不插到新消息中间',
      lines.map(l => l.body).join('|') === 'hello everyone|marry me|good job', lines.map(l => l.body));
  }
  {
    // 更狠的一种: 老消息在第一帧**整行都没读出来**, 第二帧才读到。这时没有任何
    // 去重规则能救 —— 只能靠聊天时间把它排回上面去, 而不是追加到最新一条下面。
    const e = makeEnv({
      ocr: [
        '03:21 [ 队 伍 ] 雨 未 散 （ 暗 裔 剑 魔 ） ： marry me',
        '02:38 [ 队 伍 ] 雨 未 散 （ 暗 裔 剑 魔 ） ： hello everyone\n'
          + '03:21 [ 队 伍 ] 雨 未 散 （ 暗 裔 剑 魔 ） ： marry me\n'
          + '04:09 [ 队 伍 ] 雨 未 散 （ 暗 裔 剑 魔 ） ： good job'
      ]
    });
    await e.run('gtOcrScan')();
    await flushAsync();
    e.advance(4000);
    await e.run('gtOcrScan')();
    await flushAsync();
    const lines = e.pushed[e.pushed.length - 1].lines;
    ok('后补读到的老消息按聊天时间排回去',
      lines.map(l => l.body).join('|') === 'hello everyone|marry me|good job', lines.map(l => l.body));
    ok('下发数据带聊天时间 (浮窗靠它定位)', lines.every(l => typeof l.ord === 'number'), lines.map(l => l.ord));
  }
  {
    // 同一帧里 OCR 会把 "02:38" 读成 "02 ． ： 38" (点当分隔符)。时间戳取不出来
    // 就等于没有去重键, 下一帧又是"新消息"。归一化必须把这种点吃掉。
    const e = makeEnv({});
    const lines = await e.run('gtParseOcrChatLines')('02 ． ： 38 [ 队 伍 ] 雨 未 散 ： hello everyone');
    ok('时间戳里的点噪声被吃掉', lines[0] && lines[0].ts === '02:38', lines);
  }
  {
    // 频道完全读丢 (走冒号兜底) 时也必须带上时间戳, 否则这条消息永远没有稳定键
    const e = makeEnv({});
    const lines = await e.run('gtParseOcrChatLines')('02:38 」 五 ] 雨 未 散 （ 暗 裔 剑 ） ： Vhe № everyonq');
    ok('冒号兜底也取到时间戳', lines[0] && lines[0].ts === '02:38' && lines[0].channel === '', lines);
  }
  {
    // 05:19 局真实帧: Windows OCR 按字符框间隙断词, "the top very strong" 被读成
    // "th e to p very strong"。机翻拿到这种输入只能瞎猜 (实测"这是非常强大的"),
    // 用户看到的就是"改意思了"。单字母要能并回前面的词。
    const e = makeEnv({});
    const lines = await e.run('gtParseOcrChatLines')('01:50 [ 队 伍 ] 雨 未 散 （ 暗 裔 剑 魔 ） ： th e to p very strong');
    ok('OCR 拆成单字母的单词被拼回去',
      lines[0] && lines[0].body === 'the top very strong', lines[0] && lines[0].body);
    // 不能把真词拼坏: i / a 是词, 短句不动
    const join = e.run('gtOcrJoinSplitWords');
    ok('i am good 不被拼成 iam good', join('i am good') === 'i am good', join('i am good'));
    ok('正常的短句原样保留', join('nice try man') === 'nice try man', join('nice try man'));
    ok('两三个词的消息不参与拼接', join('ok gg') === 'ok gg', join('ok gg'));
    ok('数字不当字母并进去', join('1 v 1') === '1 v 1', join('1 v 1'));
  }
  {
    // 1.5.72 —— 05:44 局真实帧。用户截图里聊天框原文是:
    //   00:43 [队伍] 雨未散(百裂冥犬): our top too strong
    //   01:18 [队伍] 雨未散(百裂冥犬): Our top is too strong
    // 但 5x/6x 放大后引擎读成 "our to p 地 0 strong" / "Our to p is to 0 strong",
    // 机翻把 "our to p" 译成"我们的p", 浮窗上就是"我们的p太强了"。
    const e = makeEnv({});
    const join = e.run('gtOcrJoinSplitWords');
    // 1.5.71 的闸门是"单字母占比 ≥1/4", "our to p too strong" 只有 1/5 = 0.2 被放过。
    // 现在逐 token 判定: p 不是能独立成词的字母, 一定并回前一个词。
    ok('to p 也要并回 top',
      join('our to p too strong') === 'our top too strong', join('our to p too strong'));
    ok('两词消息里的断字也并 (以前 toks<3 直接跳过)',
      join('to p') === 'top', join('to p'));
    ok('hel l o 并回 hello',
      join('hel l o') === 'hello', join('hel l o'));
    // y 在聊天里是 "why", 属于能独立成词的字母, 不能并 —— 宁可少并, 不能拼错
    ok('y 被保护 (ver y 不拼成 very)',
      join('ver y stron g') === 'ver y strong', join('ver y stron g'));
    // 能独立成词的单个字母不许被吃掉 —— 否则 "thank u" 会变成 "thanku"
    ok('thank u 保留', join('thank u man') === 'thank u man', join('thank u man'));
    ok('u r 保留 (聊天里的 you are)', join('u r good') === 'u r good', join('u r good'));
    ok('ok k 保留', join('ok k gg') === 'ok k gg', join('ok k gg'));

    // 1.5.75 —— 06:23 局真实帧。聊天框原文 "how are u", OCR 读成 "h ow are IJ":
    // 首字母被切下来单独成 token (**在词前面**), 上面那条"并到前一个 token"永远修不到。
    ok('头残片 h ow 并回 how', join('h ow are u') === 'how are u', join('h ow are u'));
    ok('头残片 w hat 并回 what', join('w hat is it') === 'what is it', join('w hat is it'));
    // 能独立成词的单字母不许被吃掉 —— "a good game" 拼成 "agood game" 就废了
    ok('a 开头不并 (a good game)', join('a good game') === 'a good game', join('a good game'));
    ok('i 开头不并 (i am good)', join('i am good') === 'i am good', join('i am good'));
    ok('u 开头不并 (u r good)', join('u r good') === 'u r good', join('u r good'));
    // 下一个 token 不是纯字母时不并 —— 否则 "1 v 1" 会变成 "1 v1"
    ok('1 v 1 不被并', join('1 v 1') === '1 v 1', join('1 v 1'));

    // 乱码分: 小写句子里夹的全大写短词 (u 被读成 IJ) 要算脏, 真实缩写不算
    const garbage = e.run('gtOcrGarbage');
    ok('how are IJ 乱码分 1', garbage('how are IJ') === 1, garbage('how are IJ'));
    ok('how are u 乱码分 0', garbage('how are u') === 0, garbage('how are u'));
    ok('our top too strong 乱码分 0', garbage('our top too strong') === 0, garbage('our top too strong'));
    ok('GG WP / OMG 不算乱码', garbage('GG WP OMG') === 0, garbage('GG WP OMG'));

    // 数字 0 被读成字母 o: "t00 strong" / "t0P"
    const fix0 = e.run('gtOcrFixZero');
    ok('t00 → too, t0P → top', fix0('our t0P t00 strong') === 'our top too strong', fix0('our t0P t00 strong'));
    ok('真数字不动: 100 dmg', fix0('100 dmg') === '100 dmg', fix0('100 dmg'));
    ok('真数字不动: top10', fix0('top10') === 'top10', fix0('top10'));
    ok('真数字不动: 1v1', fix0('1v1') === '1v1', fix0('1v1'));
    // 1.5.75 —— 06:36 局真实帧: "oo" 被读成两个大写 O ("tOO")。
    // 不修的话机翻拿到 "teammates are to O strong" 给出"队友对0强"。
    ok('tOO → too', fix0('are tOO strong') === 'are too strong', fix0('are tOO strong'));
    ok('驼峰真词不动: iOS', fix0('iOS app') === 'iOS app', fix0('iOS app'));

    // "what's" 的 t' 被读成 ff —— 不修的话机翻给"错了"
    const fixw = e.run('gtOcrFixWords');
    ok('whaffs wrong → what\'s wrong', fixw('whaffs wrong') === "what's wrong", fixw('whaffs wrong'));
    ok('whafs 也修', fixw('whafs wrong') === "what's wrong", fixw('whafs wrong'));
    ok('别的词不动', fixw('what a game') === 'what a game', fixw('what a game'));
    // u 被读成 IJ (06:23 局真实帧) —— 不修就落到机翻手里变成 "IJ怎么样"
    ok('IJ 修回 u', fixw('how are IJ') === 'how are u', fixw('how are IJ'));
    ok('小写 ij 不动', fixw('how are ij') === 'how are ij', fixw('how are ij'));
    // 1.5.75 —— "too" 被切成 "to 0" (06:36 局真实帧 "teammates are to 0 strong")。
    // 尾巴那个 0 前面是空格, "0 紧跟字母"的判据够不着, 机翻按字面翻成"队友对0强"。
    ok('to 0 → too', fixw('teammates are to 0 strong') === 'teammates are too strong',
      fixw('teammates are to 0 strong'));
    // 句尾的 0 是比分, 不是 o —— "3 to 0" 不能被改成 "3 too"
    ok('比分 3 to 0 不动', fixw('score 3 to 0') === 'score 3 to 0', fixw('score 3 to 0'));

    // 端到端: 2x 放大那一档的真实 OCR 原文 (逐字抄自 05:44 帧的实测输出)
    const lines = await e.run('gtParseOcrChatLines')(
      '00 ： 43 [ 队 伍 ] 雨 未 敢 （ 甴 裂 冥 犬 ） ： our t0P t00 strong\n'
      + '01 ： 18 [ 队 伍 ] 雨 未 散 （ 百 裂 冥 犬 ） ： Our top is t00 strong'
    );
    ok('低倍放大的真实帧读出的正文是完整的',
      lines.length === 2 && lines[0].body === 'our top too strong', lines.map(l => l.body));
    ok('第二句也完整', lines[1] && lines[1].body === 'Our top is too strong', lines[1]);
    ok('两条都拿到了时间戳 (丢了就每 4 秒重翻一遍)',
      lines[0].ts === '00:43' && lines[1].ts === '01:18', lines.map(l => l.ts));
  }
  {
    // 1.5.72: OCR 把一行切成两行, 尾巴被当成独立消息 —— 孤零零一个 strong 被
    // 音译成"斯夫龙"挂在浮窗上 (用户截图里那一行)。同一帧里它是完整那句的结尾词,
    // 说明就是残片。
    const e = makeEnv({});
    const lines = await e.run('gtParseOcrChatLines')(
      '01 ： 18 [ 队 伍 ] 雨 未 散 （ 百 裂 冥 犬 ） ： Our top is too strong\n'
      + '01 ： 18 [ 队 伍 ] 雨 未 散 （ 百 裂 冥 犬 ） ： strong'
    );
    ok('同一帧里作为结尾词的残片被丢掉',
      lines.length === 1 && lines[0].body === 'Our top is too strong', lines.map(l => l.body));
    // 不是结尾词就不算残片 —— 真的另说一句 "strong" 时不能吞
    const lines2 = await e.run('gtParseOcrChatLines')(
      '01 ： 18 [ 队 伍 ] 雨 未 散 （ 百 裂 冥 犬 ） ： strong\n'
      + '03 ： 21 [ 队 伍 ] 雨 未 散 （ 百 裂 冥 犬 ） ： our top is strong now'
    );
    ok('不是结尾词的单字消息保留', lines2.length === 2, lines2.map(l => l.body));
  }
  {
    // 1.5.72: 断词版与正确版**归一化后完全相同** (gtOcrNorm 抹空格), 所以
    // 长度判定和脏字符判定都分不出来, 先到的那版会把正确版锁死。
    const e = makeEnv({
      ocr: [
        '00:43 [队伍] 雨未散: our to p too strong',
        '00:43 [队伍] 雨未散: our top too strong'
      ]
    });
    await e.run('gtOcrScan')();
    await flushAsync();
    const first = e.pushed[e.pushed.length - 1].lines;
    ok('断词版先到, 仍然只有一行', first.length === 1, first);
    e.advance(4000);
    await e.run('gtOcrScan')();
    await flushAsync();
    const lines = e.pushed[e.pushed.length - 1].lines;
    ok('词边界更干净的版本原地替换掉断词版',
      lines.length === 1 && lines[0].body === 'our top too strong', lines);
  }
  {
    // 1.5.75 —— 06:36 局真实帧。浮窗第三行是 "rearrjrr / rearrjrr": 玩家名那一行被
    // OCR 读成 "rearrjrr “", 那个行尾引号凑出第二个 token, 于是过了"短残片"守卫。
    // 判据: 词数只数**真词** (≥2 个字母)。
    const e = makeEnv({ ocr: ['[ 队 伍 ] 雨 未 散 （ 暴 怒 骑 士 ） ： rearrjrr “'] });
    await e.run('gtOcrScan')();
    await flushAsync();
    const lines = e.pushed.length ? e.pushed[e.pushed.length - 1].lines : [];
    ok('无键的玩家名残渣 (rearrjrr “) 不进管线', lines.length === 0, lines);

    // 同一条带上时间戳就会被收下 —— 守卫只管"没键"的情况。
    // 这里用两个词, 因为单词正文会走"待确认"分支 (见 gtOcrNeedsConfirm)。
    const keyed = makeEnv({ ocr: ['09:52 [ 队 伍 ] 雨 未 散 （ 暴 怒 骑 士 ） ： rearrjrr wgre'] });
    await keyed.run('gtOcrScan')();
    await flushAsync();
    ok('带时间戳的同样正文照收 (守卫不越权)',
      keyed.pushed.length === 1 && keyed.pushed[0].lines.length === 1, keyed.pushed);
  }
  {
    // 1.5.75 —— 最关键的兜底: 所有翻译源都挂了时 translateBatchCore 原样返回正文,
    // 旧代码把它当"译文"推给浮窗 → 屏幕上就是 "rearrjrr / rearrjrr" 这种假译文
    // (用户报障"又出现错误翻译了")。没有中文就不该上浮窗。
    const e = makeEnv({
      echoTranslate: true,
      ocr: ['09:52 [ 队 伍 ] 雨 未 散 （ 暴 怒 骑 士 ） ： rearrjrr wgre']
    });
    await e.run('gtOcrScan')();
    await flushAsync();
    const lines = e.pushed.length ? e.pushed[e.pushed.length - 1].lines : [];
    // 1.5.79: 从"静默丢弃"改成"显式标出"。用户 15:12 反馈: 浮窗上什么都不出现时,
    // 他分不清"还在翻"和"翻失败" —— 现在留一行"（未能翻译）"+ 原文, 一眼可辨。
    ok('译文等于原文时标成"未能翻译" (不再出现 rearrjrr/rearrjrr)',
      lines.length === 1 && lines[0].fail === true && lines[0].translated === '（未能翻译）', lines);
    ok('失败行仍带原文, 用户能自己对上', lines.length === 1 && lines[0].body === 'rearrjrr wgre', lines[0]);
    ok('但翻译确实被请求过 (不是根本没走链路)', e.translated.length === 1, e.translated.length);
  }
  {
    // 1.5.76 —— 06:58 局真实帧: OCR 把 everyone 读成 eyÄryone (混进非 ASCII 字母),
    // 机翻只翻了 hello, 把剩下那串原样贴在中文后面 → 浮窗上是 "你好everyone"。
    const okFn = makeEnv({}).run('gtTrOk');
    ok('纯中文译文可用', okFn('how are u', '你好吗') === true, okFn('how are u', '你好吗'));
    ok('译文等于原文不可用', okFn('rearrjrr', 'rearrjrr') === false, okFn('rearrjrr', 'rearrjrr'));
    ok('没有中文不可用', okFn('how are u', 'how are you') === false, okFn('how are u', 'how are you'));
    ok('半截译文不可用 (你好everyone)', okFn('hello eyÄryone', '你好everyone') === false,
      okFn('hello eyÄryone', '你好everyone'));
    ok('缩写不算半截 (ADC/KDA/GG)', okFn('adc', 'ADC 和 KDA 还有 GG') === true, okFn('adc', 'ADC 和 KDA 还有 GG'));
    // 1.5.81 真实报障 (16:24 截图): "bang is the best ad in the world" 被整条丢掉。
    // 机翻给的是 "bang是世界上最好的广告", 里面那个 bang 是玩家名、原文就有,
    // 保留它是**正确**的 —— 只有"原文里没有"的拉丁串才算残渣。
    ok('专有名词保留可用 (bang是世界上最好的ad)',
      okFn('bang is the best ad in the world', 'bang是世界上最好的ad') === true,
      okFn('bang is the best ad in the world', 'bang是世界上最好的ad'));
    ok('原文没有的拉丁串仍然拦下', okFn('hello everyone', '你好xqzw') === false,
      okFn('hello everyone', '你好xqzw'));

    const cleanFn = makeEnv({}).run('gtCleanDirtyBody');
    ok('脏词被去掉 (hello eyÄryone → hello)', cleanFn('hello eyÄryone') === 'hello', cleanFn('hello eyÄryone'));
    ok('干净正文原样保留', cleanFn('hello everyone') === 'hello everyone', cleanFn('hello everyone'));
    ok('全脏时返回空串', cleanFn('eyÄryone') === '', cleanFn('eyÄryone'));
  }
  {
    // 1.5.79 —— 只装了中文 OCR 引擎时, 英文会被读成"半字母半乱码"(eyÄryone)。
    // "token 里混进非 ASCII 字符"是确定性证据 (英文聊天里不可能有), 所以按编辑
    // 距离把它修回词表里最近的词, 而不是丢掉整句。
    const fix = makeEnv({}).run('gtOcrRepairWeirdWords');
    ok('乱码词修回真词 (eyÄryone → everyone)', fix('hello eyÄryone') === 'hello everyone', fix('hello eyÄryone'));
    ok('词中间夹标点也能修 (eye,ryone → everyone)',
      fix('hello eye,ryone') === 'hello everyone', fix('hello eye,ryone'));
    ok('短词同样修 (jÖb → job)', fix('good jÖb') === 'good job', fix('good jÖb'));
    ok('干净的句子原样返回', fix('hello everyone') === 'hello everyone', fix('hello everyone'));
    // 撇号是合法英文, 不能当"词中间夹标点"去搜索最近的词 ——
    // 实测会把 "world's" 修成 "would" ("bang is would best ad"), 把好话改坏。
    ok("撇号不算脏 (world's 不动)", fix("bang is world's best ad") === "bang is world's best ad",
      fix("bang is world's best ad"));
    ok('玩家 ID 不瞎改 (faker is good)', fix('faker is good') === 'faker is good', fix('faker is good'));
    ok('含中文的行不当乱码词处理 (交给正文校验整条丢)',
      fix('gra 卣 白 tion') === 'gra tion', fix('gra 卣 白 tion'));
  }
  {
    // 1.5.79 —— 翻译慢的时候浮窗上先挂"（翻译中…）", 翻完原地替换。
    // 用户要能区分"慢"和"失败": 占位行 = 慢, "（未能翻译）" = 失败。
    const e = makeEnv({ ocr: ['00:54 [队伍] 雨未散（北地之怒）: hello everyone'] });
    e.set('GT_PEND_MS', 0);      // 让占位定时器立刻触发 (假时钟不推进真实毫秒)
    await e.run('gtOcrScan')();
    await flushAsync();
    const frames = e.pushed;
    ok('慢的时候先推一行"翻译中"',
      frames.length >= 2 && frames[0].lines.length === 1
      && frames[0].lines[0].translated === '（翻译中…）' && frames[0].lines[0].pending === true,
      frames.map(f => f.lines.map(l => l.translated)));
    ok('翻完原地替换成译文, 不多出一行',
      frames.length >= 2 && frames[frames.length - 1].lines.length === 1
      && frames[frames.length - 1].lines[0].translated === '中文译文14'
      && !frames[frames.length - 1].lines[0].pending,
      frames[frames.length - 1].lines);
  }
  {
    // 1.5.80 真实报障 (用户截图): "大家好 / hello everyone" 下面又挂了一条
    // "（翻译中…）/ hello everyone"。两条一模一样的正文, 占位行必须靠条目 id
    // 配对 —— 靠正文会串行, 靠时间戳两条都有 k 但占位行和译文行本来就该是同一条。
    const e = makeEnv({
      ocr: ['00:04 [队伍] 雨未散（北地之怒）: hello everyone\n'
        + '00:24 [队伍] 雨未散（北地之怒）: hello everyone']
    });
    e.set('GT_PEND_MS', 0);
    await e.run('gtOcrScan')();
    await flushAsync();
    const lines = e.pushed[e.pushed.length - 1].lines;
    ok('两条相同正文各占一行', lines.length === 2, lines);
    ok('翻译成功后不留占位行', lines.every(l => !l.pending), lines.map(l => l.translated));
    ok('两行都拿到译文', lines.every(l => /^中文译文/.test(l.translated)), lines.map(l => l.translated));
    ok('两行的时间戳没有串', lines.map(l => l.k).join('|') === '00:04|00:24', lines.map(l => l.k));
  }
  {
    // 1.5.80 回归守卫: 占位行定时器必须赋值给**外层** pendTimer。
    // 写成 `const pendTimer = ...` 会遮蔽外层变量, finally 里的 clearTimeout 拿到
    // null → 定时器永远不取消, 翻译成功后 600ms 再补一条"（翻译中…）"且无人替换。
    // 假时钟复现不了"翻译完成之后才触发"的时序, 所以这里直接查源码。
    const src = fs.readFileSync(path.join(__dirname, 'renderer/js/translate.js'), 'utf8');
    ok('占位行定时器不被 const 遮蔽', !/^\s*const pendTimer\s*=/m.test(src));
    ok('finally 里会取消占位行定时器',
      /if \(pendTimer\) \{ pendDone = true; clearTimeout\(pendTimer\)/.test(src));
    ok('占位行按条目 id 配对', /x\.id === it\.id/.test(src) && /x\.id === ln\.id/.test(src));
  }
  {
    // 端到端: 脏正文先翻出半截译文 → 去掉脏词重翻 → 拿到干净中文, 上浮窗
    const e = makeEnv({
      mixedTranslate: true,
      ocr: ['00:54 [队伍] 雨未散（北地之怒）: hello eyÄryone']
    });
    await e.run('gtOcrScan')();
    await flushAsync();
    const lines = e.pushed.length ? e.pushed[e.pushed.length - 1].lines : [];
    ok('半截译文被重翻成干净中文', lines.length === 1 && !/[A-Za-z]{4,}/.test(lines[0].translated), lines);
    // 1.5.79: 现在不靠"去掉脏词再翻一次", 而是翻之前就按词表把假词修回真词
    // (eyÄryone → everyone), 所以第一次请求拿到的就是干净正文, 只发一次请求。
    ok('翻译前先把读坏的词修好 (hello eyÄryone → hello everyone)',
      e.translated.length === 1 && e.translated[0].texts[0] === 'hello everyone', e.translated);
    ok('浮窗上显示修好的正文', lines.length === 1 && lines[0].body === 'hello everyone', lines);
  }
  {
    // 重翻也救不回来时 (正文整条都是脏的) 就不上浮窗
    const e = makeEnv({
      mixedTranslate: true,
      ocr: ['00:54 [队伍] 雨未散（北地之怒）: eyÄryone']
    });
    await e.run('gtOcrScan')();
    await flushAsync();
    const lines = e.pushed.length ? e.pushed[e.pushed.length - 1].lines : [];
    ok('救不回来的脏正文不上浮窗', lines.length === 0, lines);
  }
  {
    // 1.5.75 —— 06:23 局真实帧, 日志原文:
    //   06:23:22  ocr lines +1 last="h ow are IJ@00:58"
    //   06:23:30  ocr lines +1 last="how are u@00:58"
    // 先到的乱码版长度更长 (10 > 9), 脏字符判定也不成立, 单字母残片 0 对 0 ——
    // a/b/c 三个升级条件全部失效, 浮窗上就永久挂着机翻的 "IJ怎么样"。
    const e = makeEnv({
      ocr: [
        '00:58 [队伍] 雨未散（暴怒骑士）: h ow are IJ',
        '00:58 [队伍] 雨未散（暴怒骑士）: how are u'
      ]
    });
    await e.run('gtOcrScan')();
    await flushAsync();
    const first = e.pushed[e.pushed.length - 1].lines;
    ok('头残片 + IJ 字形一起修好, 首帧就是 how are u',
      first.length === 1 && first[0].body === 'how are u', first);
    e.advance(4000);
    await e.run('gtOcrScan')();
    await flushAsync();
    const lines = e.pushed[e.pushed.length - 1].lines;
    ok('第二帧同一句不再多出一行', lines.length === 1 && lines[0].body === 'how are u', lines);
  }
  {
    // 字形修不掉的那种乱码 (u 被读成 UJ) 靠"乱码分"顶掉: 长度只差 1, a/b/c 全失效。
    const e = makeEnv({
      ocr: [
        '00:58 [队伍] 雨未散（暴怒骑士）: how are UJ',
        '00:58 [队伍] 雨未散（暴怒骑士）: how are u'
      ]
    });
    await e.run('gtOcrScan')();
    await flushAsync();
    const first = e.pushed[e.pushed.length - 1].lines;
    ok('乱码版先占一行', first.length === 1 && first[0].body === 'how are UJ', first);
    e.advance(4000);
    await e.run('gtOcrScan')();
    await flushAsync();
    const lines = e.pushed[e.pushed.length - 1].lines;
    ok('乱码分更低的版本原地替换掉 UJ 版',
      lines.length === 1 && lines[0].body === 'how are u', lines);
  }
  {
    // 1.5.74 —— 14:14 局真实帧。聊天框只有一条 "how are u", 但 OCR 在不同帧把它读成
    // "how ar&u" / "hjO ZI" / "I)OW are u" 并且**丢了时间戳** (@无键)。每一条都开新行,
    // 机翻把 "hjO ZI" 译成"公司简介"、把 "how ar&u" 音译成"豪阿乌"。
    // 判据: 没有时间戳 = 这一帧连聊天头都没读出来, 短正文里残片占绝大多数。
    const short = makeEnv({ ocr: ['[ 队 伍 ] 雨 未 散 （ 暴 怒 骑 士 ） ： hjO ZI'] });
    await short.run('gtOcrScan')();
    await flushAsync();
    ok('无键短残片不进管线 (不再出现"公司简介")',
      (short.pushed.length ? short.pushed[short.pushed.length - 1].lines : []).length === 0,
      short.pushed);

    const short2 = makeEnv({ ocr: ['[ 队 伍 ] 雨 未 散 （ 暴 怒 骑 士 ） ： how are u'] });
    await short2.run('gtOcrScan')();
    await flushAsync();
    ok('无键的短英文句也不进管线 (等下一帧带时间戳再收)',
      (short2.pushed.length ? short2.pushed[short2.pushed.length - 1].lines : []).length === 0,
      short2.pushed);

    // 长正文即使没时间戳也要收 —— 长句不可能是断行残片, 丢了就是真丢消息
    const long = makeEnv({ ocr: ['[ 队 伍 ] 雨 未 散 （ 暴 怒 骑 士 ） ： our top is too strong'] });
    await long.run('gtOcrScan')();
    await flushAsync();
    const longLines = long.pushed.length ? long.pushed[long.pushed.length - 1].lines : [];
    ok('无键长句照收', longLines.length === 1 && longLines[0].body === 'our top is too strong', longLines);

    // 同一句话带上时间戳就正常收 —— 规则只针对"没键"
    const keyed = makeEnv({ ocr: ['00:58 [ 队 伍 ] 雨 未 散 （ 暴 怒 骑 士 ） ： how are u'] });
    await keyed.run('gtOcrScan')();
    await flushAsync();
    const keyedLines = keyed.pushed.length ? keyed.pushed[keyed.pushed.length - 1].lines : [];
    ok('带时间戳的短句正常收', keyedLines.length === 1 && keyedLines[0].body === 'how are u', keyedLines);
  }

  console.log(`\n聊天翻译: ${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
})();
