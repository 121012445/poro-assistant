// 解说模式: 阶段播报 + 对局事件语音 + 局势估算
//
// 数据源:
//   · 阶段变化 —— lcu-events.js 的 handleGameflowPhase 调用 commentaryOnPhase()
//   · 对局事件 —— Live Client Data /liveclientdata/eventdata (一血/大小龙/团灭/多杀)
//   · 局势     —— /liveclientdata/allgamedata 的装备估值 + 补刀估值 (只做相对比较, 不是官方经济)
//
// 语音用 Chromium 内置 speechSynthesis: 不联网、不额外下载、不写磁盘。没有中文音色时退回默认音色。
// 原则: 宁可少说, 不刷屏 —— 同类播报有冷却, 队列超过 2 条直接丢弃。
//
// 两套独立开关共用同一条发声通道 (cmtSpeakRaw):
//   · 解说模式  commentaryOn  —— 阶段 / 击杀 / 目标物 / 局势
//   · 对局提示  liveTips      —— 敌方成装 / 对位经济 / 十分钟补刀
// 分开是因为它们的诉求不同: 有人只想听事件, 不想被经济数字打扰; 也有人反过来。

let commentaryOn = false;
let commentaryTone = 'caster';
let commentaryRate = 1;
let commentaryVolume = 0.9;
let commentaryEngine = 'online';
let commentaryVoice = '';
let commentaryStyle = 'soft';
let commentaryEvents = { phase: true, kill: true, objective: true, swing: true, summary: true };

// 对局提示 (默认全关, 由用户自己打开, 免得刚更新就被语音打扰)
let liveTips = { itemSpike: false, matchup: false, creep10: false };
// F9 浮窗是否显示本局实时数据
let liveBoardOn = true;

let _cmtPollTimer = null;
let _cmtPollToken = 0;
let _cmtSeen = new Set();
let _cmtSeenSpike = new Set();
let _cmtMatchSide = 0;
let _cmtCreep10Done = false;
let _cmtPosTable = Object.create(null);
let _cmtLastBoard = '';
let _cmtFirstBlood = false;
let _cmtSwingSide = 0;
let _cmtLastPhase = '';
let _cmtVoice = null;
let _cmtPending = 0;
let _cmtRateLimited = Object.create(null);
let _cmtItemPrices = null;
let _cmtItemLoading = false;
// 解说用: 文案变体轮换序号 / 阵营连杀 / 已播过的阶段小结节点 / 战况快照(结束时总结用)
let _cmtSeq = 0;
let _cmtKillStreak = { ally: 0, enemy: 0 };
let _cmtSummaryDone = 0;
let _cmtSnapshot = null;
// 在线语音的串行播放队列与失败计数 (声明提前, 避免 TDZ 问题)
let _cmtAudioQueue = [];
let _cmtAudioBusy = false;
let _cmtCurrentAudio = null;
let _cmtCurrentSource = null;
let _cmtCtx = null;
let _cmtIr = null;
let _cmtOnlineOff = false;
let _cmtOnlineFails = 0;

// ---------- 文案 ----------
const CMT_TEXT = {
  caster: {
    champSelect: '选人开始，看看这把怎么排',
    loading: '正在载入，马上开打',
    start: '对局开始，一级团都小心点',
    end: '对局结束',
    fbAlly: '一血！我们这边先打开局面',
    fbEnemy: '一血被对面拿走，开局有点被动',
    pentaAlly: '五杀！这波全场都看到了',
    pentaEnemy: '对面五杀，这波很难看',
    quadAlly: '四杀，还差最后一个',
    quadEnemy: '对面四杀，注意站位',
    aceAlly: '团灭对面！',
    aceEnemy: '我们被团灭，先等复活',
    dragonAlly: '小龙拿下，节奏在我们这',
    dragonEnemy: '小龙被对面拿走了',
    baronAlly: '大龙拿下，这下可以推了',
    baronEnemy: '大龙被对面拿下，先守住',
    heraldAlly: '先锋到手，中路可以撞塔了',
    heraldEnemy: '先锋被对面拿走，中路留意',
    lead: '经济领先了，主动权在我们手里',
    behind: '经济落后，先稳住别乱开',
    spike: '对面{champ}已经{n}件套，得小心了',
    matchLead: '对位压着打，领先{gold}',
    matchBehind: '对位落后{gold}，先别硬拼',
    creepGood: '十分钟{cs}刀，补刀很稳',
    creepBad: '十分钟{cs}刀，补刀少了点',
    test: '解说模式开了，稍后见'
  },
  coach: {
    champSelect: '选人开始',
    loading: '正在载入对局',
    start: '对局开始，保持专注',
    end: '对局结束',
    fbAlly: '一血，我方拿到',
    fbEnemy: '对面拿到一血',
    pentaAlly: '我方五杀',
    pentaEnemy: '对面五杀',
    quadAlly: '我方四杀',
    quadEnemy: '对面四杀',
    aceAlly: '团灭对面',
    aceEnemy: '我方被团灭',
    dragonAlly: '我方拿下小龙',
    dragonEnemy: '对面拿下小龙',
    baronAlly: '我方拿下大龙',
    baronEnemy: '对面拿下大龙',
    heraldAlly: '我方拿到峡谷先锋',
    heraldEnemy: '对面拿到峡谷先锋',
    lead: '我方经济领先明显，可以扩大优势',
    behind: '局势告急，先稳住',
    spike: '对面{champ}已经{n}件套了',
    matchLead: '你对位领先{gold}',
    matchBehind: '你对位落后{gold}',
    creepGood: '十分钟{cs}刀，补刀不错',
    creepBad: '十分钟{cs}刀，补刀偏少',
    test: '解说模式已开启，对局开始时我会开口'
  },
  tough: {
    champSelect: '选人开始，别乱点',
    loading: '载入中，手别抖',
    start: '开局了，这局看着点',
    end: '打完收工',
    fbAlly: '一血到手，开局舒服',
    fbEnemy: '一血被拿了，脸有点疼',
    pentaAlly: '五杀，这波可以吹一周',
    pentaEnemy: '对面五杀，这波站好',
    quadAlly: '四杀，还差一个',
    quadEnemy: '对面四杀了，躲一躲',
    aceAlly: '团灭对面，跟上节奏',
    aceEnemy: '被团灭，先冷静一下',
    dragonAlly: '小龙到手，节奏不错',
    dragonEnemy: '小龙丢了，别慌',
    baronAlly: '大龙拿了，抱团推进',
    baronEnemy: '大龙没了，收缩防守',
    heraldAlly: '先锋到手，推塔去',
    heraldEnemy: '先锋丢了，注意中路',
    lead: '钱领先了，别送回去',
    behind: '经济落后，先别乱开团',
    spike: '对面{champ}都{n}件套了，注意点',
    matchLead: '对位压制，领先{gold}',
    matchBehind: '对位落后{gold}，先别硬拼',
    creepGood: '十分钟{cs}刀，还行',
    creepBad: '十分钟{cs}刀，补刀在打瞌睡',
    test: '解说模式开了，等下我开嘴'
  }
};
function cmtLines() { return CMT_TEXT[commentaryTone] || CMT_TEXT.caster; }

// 文案占位替换: {champ} / {n} / {gold} / {cs}
function cmtFmt(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, key) => {
    const v = vars && Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '';
    return String(v == null ? '' : v);
  });
}

// ---------- 语音 ----------
// 两条通道:
//   local  —— Chromium speechSynthesis. 离线、零延迟, 但只有 Windows 自带的
//             Huihui/Kangkang/Yaoyao, 是十几年前的拼接式合成, 念中文像机器报站。
//   online —— 主进程在线合成 (免费接口, 免注册), 自然度高一个档次。
//             只把播报文本发出去, 不发对局数据; 失败自动退回 local。
// 默认走 online, 因为"机械音"正是这条功能最劝退的地方。
function commentaryVoiceList() {
  try {
    const voices = window.speechSynthesis?.getVoices?.() || [];
    return voices.filter(v => /^zh/i.test(v.lang));
  } catch (e) { return []; }
}

// 用户选定的音色优先; 没选过就用系统默认中文音色
function commentaryPickVoice() {
  try {
    const list = commentaryVoiceList();
    if (!list.length) return null;
    if (commentaryVoice) {
      const hit = list.find(v => v.name === commentaryVoice);
      if (hit) return hit;
    }
    return list.find(v => v.lang && /^zh[-_]CN/i.test(v.lang)) || list[0] || null;
  } catch (e) { return null; }
}

function commentaryInitVoices() {
  try {
    if (!window.speechSynthesis) return;
    _cmtVoice = commentaryPickVoice();
    // Chromium 的音色列表是异步填充的, 首次调用通常是空的
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      _cmtVoice = commentaryPickVoice();
      cmtRenderVoiceOptions();
    });
  } catch (e) {}
}

// 设置页的音色下拉: 只列中文音色, 名字太长(带 "Microsoft ... Chinese (Simplified, PRC)")
// 会撑破布局, 砍到 "Microsoft Huihui" 这一段
function cmtRenderVoiceOptions() {
  const sel = document.getElementById('commentaryVoice');
  if (!sel) return;
  const list = commentaryVoiceList();
  if (!list.length) {
    sel.innerHTML = '<option value="">本机无中文音色</option>';
    return;
  }
  // 在线通道的音色由服务端决定, 本机音色对它无效 —— 与其置灰留着让人猜,
  // 不如换成一句说明, 切回本机时再重建列表。
  if (commentaryEngine === 'online') {
    sel.innerHTML = '<option value="">音色: 在线女声</option>';
    sel.disabled = true;
    return;
  }
  const opts = list.map(v => {
    const label = String(v.name || '').replace(/\s*-\s*Chinese.*$/i, '').replace(/^Microsoft\s+/i, '') || v.name;
    return `<option value="${escapeHtml(v.name)}">音色: ${escapeHtml(label)}</option>`;
  }).join('');
  sel.innerHTML = opts;
  const cur = commentaryVoice || (commentaryPickVoice()?.name || '');
  sel.value = list.some(v => v.name === cur) ? cur : list[0].name;
  sel.disabled = false;
}

// 在线通道的语速档位: 上游是 1-7 的整数, 但实测 5~7 之间只差 0.6 秒,
// 靠它调语速意义不大, 所以固定 6 (音质最好的一档), 语速交给 playbackRate 调 ——
// 这样三档之间的差异才听得出来, 而且变速不变调。
function commentaryOnlineSpeed() {
  return 6;
}

// 解说要比日常朗读快: 实测每秒 3.6 字, 一句 13 字要念 3.6 秒, 跟不上对局节奏。
// 1.20 倍速下约 3 秒。这里比原先的 1.12 高, 是因为柔和档自己会把速度压到 0.92
// (降调), 1.20 x 0.92 净速 1.10, 与改前的听感一致 —— 音色变柔和, 语速不该跟着变慢。
const CMT_ONLINE_RATE_BOOST = 1.20;

// ---------- 音色风格 (在线语音的后处理) ----------
// 免费接口只提供一个女声, 换不到更柔和的音源 (Edge 神经语音在本机网络被 403,
// 有道/搜狗/Google 的公共发声接口都已失效), 所以"更柔和"只能自己做:
//   rate —— 降速同时降调 (playbackRate 是变速变调), 听感更厚、更慢、更松弛
//   lp   —— 低通切掉 7kHz 以上的齿音, "沙沙"的高频是机械感的第一来源
//   peak —— 2.9kHz 附近正是合成音的金属共鸣峰, 压下去立刻不像播报
//   low  —— 降调后容易发闷, 补一点 190Hz 的胸腔
//   wet  —— 30ms 级的极短混响, 抹掉录音棚式的干涩
// clear 是改前的原声, 留着给"觉得太闷"的人退回去。
const CMT_STYLE = {
  soft:  { rate: 0.92, lp: 6800,  peak: -3.0, peakF: 2900, low: 2.0, lowF: 190, wet: 0.10 },
  clear: { rate: 1.00, lp: 20000, peak: 0,    peakF: 2900, low: 0,   lowF: 190, wet: 0 },
  deep:  { rate: 0.86, lp: 5200,  peak: -2.0, peakF: 2500, low: 3.5, lowF: 170, wet: 0.14 }
};
function cmtStyleCfg(name) { return CMT_STYLE[name] || CMT_STYLE.soft; }

function cmtAudioCtx() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!_cmtCtx) _cmtCtx = new AC();
    // 长时间没交互时 AudioContext 会自己挂起, 每次出声前叫醒一次
    if (_cmtCtx.state === 'suspended') {
      const p = _cmtCtx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
    return _cmtCtx;
  } catch (e) { return null; }
}

// 极短混响的脉冲响应: 指数衰减的白噪声, 比自己搭 delay 反馈省事且没有金属回声
function cmtRoomIr(ctx) {
  if (_cmtIr && _cmtIr.sampleRate === ctx.sampleRate) return _cmtIr;
  const len = Math.max(1, Math.floor(ctx.sampleRate * 0.32));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const k = 1 - i / len;
      d[i] = (Math.random() * 2 - 1) * k * k * 0.45;
    }
  }
  _cmtIr = buf;
  return buf;
}

function cmtDataUrlBuffer(url) {
  const s = String(url || '');
  const comma = s.indexOf(',');
  if (comma < 0) throw new Error('bad data url');
  const bin = atob(s.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// 走 WebAudio: 变速降调 + EQ + 混响。解码失败返回 false, 交给 <audio> 兜底。
async function cmtPlayProcessed(dataUrl, rate, style) {
  const ctx = cmtAudioCtx();
  if (!ctx) return false;
  let buf = null;
  try { buf = await ctx.decodeAudioData(cmtDataUrlBuffer(dataUrl)); } catch (e) { return false; }
  if (!buf || !buf.duration) return false;
  const cfg = cmtStyleCfg(style);
  const speed = Math.min(4, Math.max(0.5, (Number.isFinite(rate) ? rate : 1) * cfg.rate));
  return new Promise(resolve => {
    let src = null;
    let settled = false;
    let timer = null;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (src) src.onended = null; } catch (e) {}
      if (_cmtCurrentSource === src) _cmtCurrentSource = null;
      resolve(true);
    };
    try {
      src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = speed;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = cfg.lp; lp.Q.value = 0.7;
      const peak = ctx.createBiquadFilter();
      peak.type = 'peaking'; peak.frequency.value = cfg.peakF; peak.Q.value = 1.1; peak.gain.value = cfg.peak;
      const low = ctx.createBiquadFilter();
      low.type = 'lowshelf'; low.frequency.value = cfg.lowF; low.gain.value = cfg.low;
      // 压一点动态: 合成音的音节头常比尾巴响得多, 压平后不刺耳
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -22; comp.knee.value = 24; comp.ratio.value = 2.4;
      comp.attack.value = 0.005; comp.release.value = 0.22;
      const out = ctx.createGain();
      out.gain.value = Math.min(1, Math.max(0, commentaryVolume));

      src.connect(lp); lp.connect(peak); peak.connect(low); low.connect(comp);
      if (cfg.wet > 0) {
        const dry = ctx.createGain(); dry.gain.value = 1;
        const wet = ctx.createGain(); wet.gain.value = cfg.wet;
        const conv = ctx.createConvolver(); conv.buffer = cmtRoomIr(ctx);
        comp.connect(dry); dry.connect(out);
        comp.connect(conv); conv.connect(wet); wet.connect(out);
      } else {
        comp.connect(out);
      }
      out.connect(ctx.destination);

      src.onended = done;
      _cmtCurrentSource = src;
      // 自己兜超时: 解码后的时长换算成播放时长, 再留 1.5 秒余量
      timer = setTimeout(done, Math.round(buf.duration / speed * 1000) + 1500);
      src.start(0);
    } catch (e) { resolve(false); }
  });
}

// 兜底通道: 不支持 WebAudio 时直接播元素 (此时无法降调, 只保留降速)
function cmtPlayElement(dataUrl, rate, style) {
  const cfg = cmtStyleCfg(style);
  return new Promise(resolve => {
    let settled = false;
    let audio = null;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (audio) { audio.onended = null; audio.onerror = null; } } catch (e) {}
      if (_cmtCurrentAudio === audio) _cmtCurrentAudio = null;
      resolve();
    };
    const timer = setTimeout(done, 12000);
    try {
      audio = new Audio(dataUrl);
      _cmtCurrentAudio = audio;
      audio.volume = commentaryVolume;
      // playbackRate 只在 0.5~4 之间有效, 超出会被浏览器静默忽略
      const r = (Number.isFinite(rate) ? rate : 1) * cfg.rate;
      audio.playbackRate = Math.min(4, Math.max(0.5, r));
      // 关掉保调, 让降速顺带降调 (Chromium 支持, 忽略也不报错)
      try { audio.preservesPitch = false; audio.webkitPreservesPitch = false; } catch (e) {}
      audio.onended = done;
      audio.onerror = done;
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(done);
    } catch (e) { done(); }
  });
}

// 播放一段 data URL 音频, 用 Promise 表示"播完了", 便于串行排队。
// 优先走 WebAudio 处理链 (柔和化), 解码不了再退回元素直放。
async function cmtPlayAudio(dataUrl, rate) {
  const ok = await cmtPlayProcessed(dataUrl, rate, commentaryStyle);
  if (ok) return;
  return cmtPlayElement(dataUrl, rate, commentaryStyle);
}


// 关掉解说 / 换局时立刻掐断, 否则已经排队的几条会继续念完
function cmtStopAudio() {
  _cmtAudioQueue.length = 0;
  if (_cmtCurrentSource) {
    try { _cmtCurrentSource.stop(0); } catch (e) {}
    _cmtCurrentSource = null;
  }
  if (_cmtCurrentAudio) {
    try { _cmtCurrentAudio.pause(); } catch (e) {}
    _cmtCurrentAudio = null;
  }
}

// 在线语音不可用时降级: 把这一轮没播出来的内容用本地音色补上, 并只提示一次
function cmtFallbackToLocal(reason) {
  if (_cmtOnlineOff) return;
  _cmtOnlineOff = true;
  console.warn('[commentary] 在线语音不可用, 回退本地音色:', reason || '');
  const hint = document.getElementById('commentaryHint');
  if (hint) hint.textContent = '在线语音不可用，已回退本地音色';
  if (typeof toolMsg === 'function') {
    toolMsg('<span style="color:var(--negative)">在线语音连不上，已自动回退本机音色</span>');
  }
}

function cmtSpeakLocal(text) {
  try {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(String(text).slice(0, 80));
    u.lang = 'zh-CN';
    u.rate = commentaryRate;
    u.volume = commentaryVolume;
    const voice = _cmtVoice || commentaryPickVoice();
    if (voice) u.voice = voice;
    _cmtPending++;
    // 占位计数必须有兜底释放: Chromium 的 speechSynthesis 在个别系统上
    // 会出现 onend 不回调, 那样 _cmtPending 永远不降, 之后所有播报都会被队列上限静默吞掉。
    let timer = null;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      _cmtPending = Math.max(0, _cmtPending - 1);
    };
    // 按字数估个上限, 最多 15 秒
    timer = setTimeout(done, Math.min(15000, 1500 + String(text).length * 200));
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
  } catch (e) {}
}

// 串行播放在线音频: 解说是有先后顺序的, 重叠播放等于什么都听不清
async function cmtDrainAudio() {
  if (_cmtAudioBusy) return;
  _cmtAudioBusy = true;
  try {
    while (_cmtAudioQueue.length) {
      const job = _cmtAudioQueue.shift();
      let res = null;
      try {
        res = await lolAPI.ttsSynthesize(job.text, commentaryOnlineSpeed());
      } catch (e) { res = null; }
      if (!res || !res.ok || !res.dataUrl) {
        _cmtOnlineFails++;
        // 一次拿不到就整局退回本地: 断网时如果每句都要等超时, 解说就变成几分钟前的旧闻。
        // 下一局开始时会重置, 网络恢复了自然会用回在线音色。
        cmtFallbackToLocal(res && res.error);
        cmtSpeakLocal(job.text);
        continue;
      }
      _cmtOnlineFails = 0;
      await cmtPlayAudio(res.dataUrl, commentaryRate * CMT_ONLINE_RATE_BOOST);
    }
  } finally {
    _cmtAudioBusy = false;
  }
}

function cmtEnqueueAudio(text) {
  _cmtAudioQueue.push({ text });
  // 落后太多就丢最旧的: 宁可少播一条, 也不要追着念二十秒前的事
  while (_cmtAudioQueue.length > 3) _cmtAudioQueue.shift();
  cmtDrainAudio();
}

// 底层发声: 只管冷却与排队, 不判断哪个开关 (由上面两个通道各自判断)
function cmtSpeakRaw(text, key, cooldownMs) {
  if (!text) return;
  const now = Date.now();
  const k = key || text;
  if (cooldownMs && _cmtRateLimited[k] && now - _cmtRateLimited[k] < cooldownMs) return;
  _cmtRateLimited[k] = now;
  const engine = commentaryEngine === 'local' ? 'local' : 'online';
  if (engine === 'online' && !_cmtOnlineOff && lolAPI.ttsSynthesize) {
    cmtEnqueueAudio(String(text).slice(0, 120));
    return;
  }
  // 本地通道的并发上限: 已在念两条以上时直接丢弃, 否则会追着念十秒前发生的事
  if (_cmtPending >= 2) return;
  cmtSpeakLocal(text);
}

// 解说模式通道. force=true 用于「试听」: 关闭状态下也能出声
function commentarySpeak(text, key, cooldownMs, force) {
  if (!text) return;
  if (!force && !commentaryOn) return;
  cmtSpeakRaw(text, key, cooldownMs);
}

function liveTipsAnyOn() {
  return !!(liveTips.itemSpike || liveTips.matchup || liveTips.creep10);
}

// 对局提示通道: 与 commentaryOn 无关, 只要有一项提示开着就出声
function liveTipsSpeak(text, key, cooldownMs) {
  if (!text || !liveTipsAnyOn()) return;
  cmtSpeakRaw(text, key, cooldownMs);
}

// ---------- 设置与界面 ----------
function commentarySetState() {
  const el = document.getElementById('commentaryState');
  if (el) {
    el.textContent = commentaryOn ? '已开启' : '已关闭';
    el.style.color = commentaryOn ? 'var(--positive)' : '';
  }
  const hint = document.getElementById('commentaryHint');
  if (hint && !commentaryOn) hint.textContent = '未开启';
}

function commentaryLoadConfig() {
  commentaryOn = storeGet('commentary') === '1';
  const savedTone = storeGet('commentaryTone');
  commentaryTone = savedTone === 'coach' || savedTone === 'tough' ? savedTone : 'caster';
  const rate = parseFloat(storeGet('commentaryRate'));
  commentaryRate = [0.85, 1, 1.15].includes(rate) ? rate : 1;
  const vol = parseFloat(storeGet('commentaryVolume'));
  commentaryVolume = Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 0.9;
  const ev = safeParseStore('commentaryEvents', null, v => v && typeof v === 'object' && !Array.isArray(v));
  if (ev) commentaryEvents = Object.assign({}, commentaryEvents, ev);
  commentaryEngine = storeGet('commentaryEngine') === 'local' ? 'local' : 'online';
  commentaryVoice = String(storeGet('commentaryVoice') || '');
  const style = String(storeGet('commentaryStyle') || '');
  commentaryStyle = CMT_STYLE[style] ? style : 'soft';
  const tips = safeParseStore('liveTips', null, v => v && typeof v === 'object' && !Array.isArray(v));
  if (tips) {
    liveTips = {
      itemSpike: !!tips.itemSpike,
      matchup: !!tips.matchup,
      creep10: !!tips.creep10
    };
  }
  liveBoardOn = storeGet('liveBoard') !== '0';

  const toggle = document.getElementById('commentaryToggle');
  if (toggle) toggle.checked = commentaryOn;
  const toneEl = document.getElementById('commentaryTone');
  if (toneEl) toneEl.value = commentaryTone;
  const rateEl = document.getElementById('commentaryRate');
  if (rateEl) rateEl.value = String(commentaryRate);
  const volEl = document.getElementById('commentaryVolume');
  if (volEl) volEl.value = String(Math.round(commentaryVolume * 100));
  const evEls = { phase: 'cmtEvPhase', kill: 'cmtEvKill', objective: 'cmtEvObjective', swing: 'cmtEvSwing', summary: 'cmtEvSummary' };
  for (const [key, id] of Object.entries(evEls)) {
    const el = document.getElementById(id);
    if (el) el.checked = !!commentaryEvents[key];
  }
  const engineEl = document.getElementById('commentaryEngine');
  if (engineEl) engineEl.value = commentaryEngine;
  const styleEl = document.getElementById('commentaryStyle');
  if (styleEl) styleEl.value = commentaryStyle;
  cmtRenderVoiceOptions();
  const tipEls = { itemSpike: 'tipItemSpike', matchup: 'tipMatchup', creep10: 'tipCreep10' };
  for (const [key, id] of Object.entries(tipEls)) {
    const el = document.getElementById(id);
    if (el) el.checked = !!liveTips[key];
  }
  const boardEl = document.getElementById('liveBoardToggle');
  if (boardEl) boardEl.checked = liveBoardOn;
  commentarySetState();
}

function toggleCommentary(on) {
  commentaryOn = !!on;
  storeSet('commentary', on ? '1' : '0');
  if (commentaryOn) {
    commentaryEnsureItemPrices();
    // 用户刚点过开关, 这次 speak 在用户手势上下文里, 不会被浏览器静默拦掉
    commentarySpeak('解说模式已开启', 'toggle:on', 2000, true);
    if (window._gameflowPhase === 'InProgress') commentaryStartPolling();
  } else {
    commentaryStopPolling();
    cmtStopAudio();
    try { window.speechSynthesis?.cancel(); } catch (e) {}
  }
  commentarySetState();
  if (typeof toolMsg === 'function') {
    toolMsg(commentaryOn
      ? '<span style="color:var(--positive)">解说模式已开启 (' + (commentaryEngine === 'local' ? '本机音色' : '在线语音') + '，击杀/目标物/五分钟小结)</span>'
      : '解说模式已关闭');
  }
}

function setCommentaryOption(key, value) {
  if (key === 'tone') {
    commentaryTone = value === 'coach' || value === 'tough' ? value : 'caster';
    storeSet('commentaryTone', commentaryTone);
  } else if (key === 'rate') {
    const rate = parseFloat(value);
    commentaryRate = [0.85, 1, 1.15].includes(rate) ? rate : 1;
    storeSet('commentaryRate', String(commentaryRate));
  } else if (key === 'volume') {
    const vol = parseFloat(value);
    commentaryVolume = Number.isFinite(vol) ? Math.min(1, Math.max(0, vol / 100)) : 0.9;
    storeSet('commentaryVolume', String(commentaryVolume));
  } else if (key === 'engine') {
    commentaryEngine = value === 'local' ? 'local' : 'online';
    storeSet('commentaryEngine', commentaryEngine);
    // 手动切回在线时要把"这条通道挂了"的判断清掉, 否则用户改了设置也不生效
    _cmtOnlineOff = false;
    _cmtOnlineFails = 0;
    cmtRenderVoiceOptions();
  } else if (key === 'voice') {
    commentaryVoice = String(value || '');
    storeSet('commentaryVoice', commentaryVoice);
    _cmtVoice = commentaryPickVoice();
  } else if (key === 'style') {
    commentaryStyle = CMT_STYLE[value] ? value : 'soft';
    storeSet('commentaryStyle', commentaryStyle);
    // 换风格后立刻用新音色说一句, 否则要等下一条播报才听得出差别
    commentarySpeak('这样听起来是不是柔和一点', 'test:style', 0, true);
  }
}

function setCommentaryEvent(key, on) {
  if (!(key in commentaryEvents)) return;
  commentaryEvents[key] = !!on;
  storeSet('commentaryEvents', JSON.stringify(commentaryEvents));
}

// 对局提示的单项开关. 与解说模式互不影响
function setLiveTip(key, on) {
  if (!(key in liveTips)) return;
  liveTips[key] = !!on;
  storeSet('liveTips', JSON.stringify(liveTips));
  if (liveTipsAnyOn()) {
    // 用户刚点过开关, 这次发声落在用户手势上下文里, 不会被浏览器静默拦掉
    liveTipsSpeak('对局提示已开启', 'tips:on', 0);
    if (window._gameflowPhase === 'InProgress') commentaryStartPolling();
  }
  if (typeof toolMsg === 'function') {
    toolMsg(liveTipsAnyOn()
      ? '<span style="color:var(--positive)">对局提示已开启</span>'
      : '对局提示已全部关闭');
  }
}

function toggleLiveBoard(on) {
  liveBoardOn = !!on;
  storeSet('liveBoard', on ? '1' : '0');
  if (liveBoardOn) {
    if (window._gameflowPhase === 'InProgress') commentaryStartPolling();
  } else {
    _cmtLastBoard = '';
    try { if (lolAPI.liveBoardPush) lolAPI.liveBoardPush({ clear: true }); } catch (e) {}
  }
}

// 试听用真实解说句而不是"解说模式已开启"这种系统提示 ——
// 用户要判断的是"打起来的时候听起来怎么样", 不是提示音好不好听。
function testCommentaryVoice() {
  commentarySpeak('试听，齐天大圣 一套打满，盲僧 直接倒地。', 'test:1', 0, true);
  const S = window.PoroScript;
  if (!S) return;
  const sample = S.buildSituation({
    tone: commentaryTone, leadPct: 22, goldDiff: 4339, gameTime: 900,
    seq: 0, kills: 12, deaths: 5, withScore: true
  });
  // 等第一句念完再补第二句, 否则两条会叠在一起
  setTimeout(() => commentarySpeak(sample.text, 'test:2', 0, true), 3000);
}

// ---------- 对局事件 ----------
function commentaryBuildTeamInfo(gd) {
  const players = gd?.allPlayers || [];
  const me = String(gd?.activePlayer?.summonerName || '').toLowerCase();
  const self = players.find(p => String(p.summonerName || '').toLowerCase() === me);
  const myTeam = self ? String(self.team) : '';
  const map = new Map();
  for (const p of players) {
    const side = myTeam && String(p.team) === myTeam ? 'ally' : 'enemy';
    const names = [p.summonerName, p.riotId, p.riotIdGameName];
    if (p.riotIdGameName && p.riotIdTagLine) names.push(p.riotIdGameName + '#' + p.riotIdTagLine);
    for (const n of names) if (n) map.set(String(n).toLowerCase(), side);
  }
  return { myTeam, teamOf: name => map.get(String(name || '').toLowerCase()) || '' };
}

function commentaryHandleEvents(events, gd) {
  if (!Array.isArray(events) || !events.length) return;
  const info = commentaryBuildTeamInfo(gd);
  // 事件里的名字是召唤师名, 要换成英雄名才念得顺 (生僻字/特殊符号念出来是噪音)
  const roster = window.PoroScript
    ? window.PoroScript.buildRoster(gd?.allPlayers || [], cmtChampNameOf)
    : null;
  const ctx = { tone: commentaryTone, roster, myTeam: info.myTeam };
  for (const e of events) {
    const id = String(e?.EventID ?? '');
    if (!id || _cmtSeen.has(id)) continue;
    _cmtSeen.add(id);
    if (_cmtSeen.size > 600) _cmtSeen = new Set(Array.from(_cmtSeen).slice(-300));
    commentaryHandleOneEvent(e, info, id, ctx, roster);
  }
}

// 一次击杀播报给几秒"呼吸"空间: 团战里连杀三四个时, 全播会变成一串机械报菜名。
// 多杀/团灭这类高信息量的事件不受此限, 走各自的 key。
const CMT_KILL_GAP_MS = 4500;

function commentaryHandleOneEvent(e, info, id, ctx, roster) {
  const S = window.PoroScript;
  if (!S) { commentaryHandleOneEventLegacy(e, info, id); return; }
  const name = e?.EventName;

  // 分类开关: 击杀类 / 目标物类 / 不参与分类的直接播
  const kind = name === 'ChampionKill' || name === 'Multikill' || name === 'Ace'
    || name === 'TurretKilled' || name === 'InhibKilled' || name === 'FirstBrick' ? 'kill' : 'objective';
  if (kind === 'kill' && !commentaryEvents.kill) return;
  if (kind === 'objective' && !commentaryEvents.objective) return;

  let seq = _cmtSeq++;
  const line = S.buildEventLine(e, Object.assign({}, ctx, {
    seq,
    allyKills: _cmtKillStreak.ally
  }));
  if (!line || !line.text) return;

  // 一血单独点一下名: 事件流里的第一条 ChampionKill 就是一血
  if (name === 'ChampionKill' && !_cmtFirstBlood) {
    _cmtFirstBlood = true;
    line.text = '一血，' + line.text;
  }

  // 连杀计数: 击杀播报里用来判断"已经连拿几个"
  if (name === 'ChampionKill') {
    const side = S.sideOf(roster, e.KillerName, info.myTeam);
    if (side === 'ally') { _cmtKillStreak.ally++; _cmtKillStreak.enemy = 0; }
    else if (side === 'enemy') { _cmtKillStreak.enemy++; _cmtKillStreak.ally = 0; }
  }

  // 普通击杀/阵亡压一下频率; 多杀、团灭、大龙这类必须立刻说。
  // 冷却键刻意用固定值而不是事件 ID: 用事件 ID 的话每条都是新 key, 冷却永远不生效。
  const quick = name === 'Multikill' || name === 'Ace' || name === 'BaronKill';
  commentarySpeak(line.text, quick ? line.key : 'kill:gap', quick ? 0 : CMT_KILL_GAP_MS);
}

// 没有 PoroScript 时的旧路径 (理论上不会走到: 脚本在 index.html 里排在前面)
function commentaryHandleOneEventLegacy(e, info, id) {
  const lines = cmtLines();
  const name = e?.EventName;
  if (name === 'Ace') {
    if (!commentaryEvents.kill || !info.myTeam || !e?.AcingTeam) return;
    const allyAce = String(e.AcingTeam) === info.myTeam;
    commentarySpeak(allyAce ? lines.aceAlly : lines.aceEnemy, 'ace:' + id, 3000);
    return;
  }
  const side = info.teamOf(e?.KillerName);
  if (!side) return;
  if (name === 'ChampionKill') {
    if (!commentaryEvents.kill || _cmtFirstBlood) return;
    _cmtFirstBlood = true;
    commentarySpeak(side === 'ally' ? lines.fbAlly : lines.fbEnemy, 'fb', 0);
    return;
  }
  if (name === 'Multikill') {
    if (!commentaryEvents.kill) return;
    const streak = Number(e?.KillStreak || 0);
    if (streak >= 5) commentarySpeak(side === 'ally' ? lines.pentaAlly : lines.pentaEnemy, 'penta:' + id, 0);
    else if (streak === 4) commentarySpeak(side === 'ally' ? lines.quadAlly : lines.quadEnemy, 'quad:' + id, 0);
    return;
  }
  if (!commentaryEvents.objective) return;
  if (name === 'DragonKill') {
    commentarySpeak(side === 'ally' ? lines.dragonAlly : lines.dragonEnemy, 'dragon:' + id, 2000);
  } else if (name === 'BaronKill') {
    commentarySpeak(side === 'ally' ? lines.baronAlly : lines.baronEnemy, 'baron:' + id, 2000);
  } else if (name === 'HeraldKill') {
    commentarySpeak(side === 'ally' ? lines.heraldAlly : lines.heraldEnemy, 'herald:' + id, 2000);
  }
}

// ---------- 局势估算 ----------
async function commentaryEnsureItemPrices() {
  if (_cmtItemPrices || _cmtItemLoading) return _cmtItemPrices;
  _cmtItemLoading = true;
  try {
    const version = await lolAPI.getVersion();
    const res = await lolAPI.getItems(version);
    const map = new Map();
    for (const [id, item] of Object.entries(res?.data || {})) {
      const total = item?.gold?.total;
      if (Number.isFinite(total)) map.set(String(id), total);
    }
    _cmtItemPrices = map;
  } catch (e) {
    _cmtItemPrices = new Map();
  } finally {
    _cmtItemLoading = false;
  }
  return _cmtItemPrices;
}

function commentaryPlayerValue(p, prices) {
  if (window.PoroMetrics) return window.PoroMetrics.playerValue(p, prices);
  // 兜底: 极端情况下指标模块没加载, 退化成上一版算法 (补刀折金 + 装备原价)
  let value = (Number(p?.scores?.creepScore) || 0) * 18;
  for (const item of (p?.items || [])) {
    const price = prices.get(String(item?.itemID));
    if (price) value += price * (Number(item?.count) || 1);
  }
  return value;
}

// live data 的 championName 是英文 id (Yasuo), 播报要用中文名才念得顺
function cmtChampNameOf(lp) {
  const key = String(lp?.championName || '').toLowerCase();
  if (!key) return '';
  try {
    if (typeof allChampions === 'object' && allChampions) {
      for (const name in allChampions) {
        const c = allChampions[name];
        if (String(c?.id || '').toLowerCase() === key) return c.name || lp.championName;
      }
    }
  } catch (e) {}
  return String(lp?.championName || '');
}

// 敌方成装提醒: 同一人同一档位只播一次 (key 带档位, 3 件套之后 4 件套还会再提一次)
function commentaryCheckSpikes(M, split, prices) {
  if (!liveTips.itemSpike || !split) return '';
  let latest = '';
  for (const s of M.detectSpikes(split.enemy, prices, [2, 3, 4])) {
    if (_cmtSeenSpike.has(s.key)) continue;
    _cmtSeenSpike.add(s.key);
    const text = cmtFmt(cmtLines().spike, { champ: cmtChampNameOf(s.player), n: s.step });
    liveTipsSpeak(text, 'spike:' + s.key, 0);
    latest = text;
  }
  return latest;
}

// 对位经济: 只有能确定位置时才比。位置拿不到就不播 —— 猜错位置等于给错结论
function commentaryCheckMatchup(M, players, gd, prices) {
  if (!liveTips.matchup) return null;
  const mu = M.findMatchup(players, gd, _cmtPosTable);
  if (!mu) return null;
  const diff = Math.round(M.playerValue(mu.self, prices) - M.playerValue(mu.opp, prices));
  // 1500 金以上算明显领先/落后; 回落到 600 以内才允许重新播报 (迟滞, 避免来回横跳)
  if (diff >= 1500 && _cmtMatchSide !== 1) {
    _cmtMatchSide = 1;
    liveTipsSpeak(cmtFmt(cmtLines().matchLead, { gold: M.formatGold(Math.abs(diff)) }), 'mu:lead', 120000);
  } else if (diff <= -1500 && _cmtMatchSide !== -1) {
    _cmtMatchSide = -1;
    liveTipsSpeak(cmtFmt(cmtLines().matchBehind, { gold: M.formatGold(Math.abs(diff)) }), 'mu:behind', 120000);
  } else if (Math.abs(diff) < 600) {
    _cmtMatchSide = 0;
  }
  return {
    posLabel: M.positionLabel(mu.position),
    diff,
    selfCs: M.creepScore(mu.self),
    oppCs: M.creepScore(mu.opp)
  };
}

// 十分钟补刀: 只在 10~13 分钟窗口内说, 超出窗口直接作废
// 原因: creepScore 是实时值, 15 分钟才说"十分钟 120 刀"就是错的
function commentaryCheckCreep10(M, split, gameTime) {
  if (_cmtCreep10Done || !liveTips.creep10 || !split || !split.self) return null;
  if (gameTime > 780) { _cmtCreep10Done = true; return null; }
  if (gameTime < 600) return null;
  _cmtCreep10Done = true;
  const m = M.creepMilestone(split.self, split.self.position);
  liveTipsSpeak(cmtFmt(m.hit ? cmtLines().creepGood : cmtLines().creepBad, { cs: m.cs }), 'creep10', 0);
  return m;
}

// 把对位结果压成 IPC 只需要的最小结构.
// 直接放行原始对象会把整份 items/scores 塞进 IPC, 而且字段名对不上浮窗预期。
function cmtNormalizeMatchup(mu) {
  if (!mu || typeof mu !== 'object') return null;
  const pos = String(mu.posLabel || mu.pos || '').trim();
  const diff = Number(mu.diff);
  if (!pos || !Number.isFinite(diff)) return null;
  return {
    pos: pos.substring(0, 4),
    diff: Math.round(diff),
    selfCs: Math.max(0, Math.round(Number(mu.selfCs)) || 0),
    oppCs: Math.max(0, Math.round(Number(mu.oppCs)) || 0)
  };
}

// F9 浮窗的"本局"区域. 内容没变不推, 避免每 4 秒重绘一次
// 返回实际推送的 payload (没推则返回 null) —— 仅用于自测断言, 生产路径不看返回值
function commentaryPushBoard(M, totals, matchup, spikeText, gameTime) {
  if (!liveBoardOn) return null;
  if (!lolAPI.liveBoardPush) return null;
  const payload = {
    gameTime: Math.round(gameTime),
    leadPct: totals.leadPct,
    allyValue: totals.allyValue,
    enemyValue: totals.enemyValue,
    matchup: cmtNormalizeMatchup(matchup),
    spike: spikeText || '',
    updatedAt: Date.now()
  };
  // 时间每 10 秒推一次让浮窗时钟走字, 其余字段变了才推
  const mu = payload.matchup;
  const key = [Math.floor(payload.gameTime / 10), payload.leadPct, payload.allyValue,
    mu ? mu.diff + ':' + mu.selfCs + ':' + mu.oppCs : '-', spikeText].join('|');
  if (key === _cmtLastBoard) return null;
  _cmtLastBoard = key;
  try { lolAPI.liveBoardPush(payload); } catch (e) {}
  return payload;
}

function commentaryHandleGameState(gd) {
  const M = window.PoroMetrics;
  if (!M) return null;
  const players = gd?.allPlayers || [];
  // 少于 4 人通常是数据还没拉全, 此时算出来的经济是错的
  if (players.length < 4) return null;
  const prices = _cmtItemPrices || new Map();

  const totals = M.teamTotals(players, prices, gd);
  if (!totals) return null;   // 队伍都分不清就不出任何数字
  const split = M.splitTeams(players, gd);
  const gameTime = Number(gd?.gameData?.gameTime) || 0;

  const spikeText = commentaryCheckSpikes(M, split, prices);
  const matchup = commentaryCheckMatchup(M, players, gd, prices);
  commentaryCheckCreep10(M, split, gameTime);

  if (commentaryOn) {
    const hint = document.getElementById('commentaryHint');
    // 降级提示要留住: 每 4 秒刷新一次领先比例会把它冲掉, 用户就不知道已经换成机器音了
    if (hint && !_cmtOnlineOff) {
      hint.textContent = (totals.leadPct >= 0 ? '我方领先 ' : '对面领先 ') + Math.abs(totals.leadPct) + '%';
    }
    // 迟滞: 超过 12% 才算一边占优, 回落到 6% 以内才允许再次播报
    if (commentaryEvents.swing) {
      if (totals.leadPct >= 12 && _cmtSwingSide !== 1) {
        _cmtSwingSide = 1;
        commentarySpeak(cmtLines().lead, 'swing:lead', 120000);
      } else if (totals.leadPct <= -12 && _cmtSwingSide !== -1) {
        _cmtSwingSide = -1;
        commentarySpeak(cmtLines().behind, 'swing:behind', 120000);
      } else if (Math.abs(totals.leadPct) < 6) {
        _cmtSwingSide = 0;
      }
    }
    commentarySituationSummary(split, totals, gameTime);
  }

  return commentaryPushBoard(M, totals, matchup, spikeText, gameTime);
}

// 我方 / 敌方的总击杀, 直接读每个玩家的 scores.kills
function cmtTeamKills(split) {
  const sum = arr => (Array.isArray(arr) ? arr.reduce((n, p) => n + (Number(p?.scores?.kills) || 0), 0) : 0);
  return { ally: sum(split && split.ally), enemy: sum(split && split.enemy) };
}

// 每 5 分钟播一次局势小结。
// 只在跨越 5 的整数倍时播, 不按累计时长 —— 中途开启解说时也要能立刻对上节奏。
function commentarySituationSummary(split, totals, gameTime) {
  const S = window.PoroScript;
  if (!S || !commentaryEvents.summary) return;
  const kd = cmtTeamKills(split);
  _cmtSnapshot = {
    gameTime,
    leadPct: totals.leadPct,
    kills: kd.ally,
    deaths: kd.enemy,
    allyValue: totals.allyValue,
    enemyValue: totals.enemyValue
  };
  const bucket = Math.floor(gameTime / 300);
  // 只播 5~30 分钟这一段; 之后局势已经明朗, 再报数字只是噪音
  if (bucket < 1 || bucket > 6 || bucket <= _cmtSummaryDone) return;
  // 漏拍了多个节点(卡顿/中途开启)时只补最近一个, 不连着补三条
  _cmtSummaryDone = bucket;
  const line = S.buildSituation({
    tone: commentaryTone,
    leadPct: totals.leadPct,
    goldDiff: totals.allyValue - totals.enemyValue,
    gameTime,
    seq: _cmtSeq++,
    kills: kd.ally,
    deaths: kd.enemy,
    withScore: true
  });
  if (line && line.text) commentarySpeak(line.text, line.key, 0);
}

// ---------- 轮询与阶段 ----------
// 只要任意一个功能需要实时数据就轮询: 解说模式 / 对局提示 / 浮窗本局区块
function cmtAnyActive() {
  return commentaryOn || liveTipsAnyOn() || liveBoardOn;
}

async function commentaryPoll() {
  if (!cmtAnyActive()) return;
  if (window._gameflowPhase !== 'InProgress' && window._gameflowPhase !== 'PRACTICETOOL') return;
  const token = ++_cmtPollToken;
  try {
    commentaryEnsureItemPrices();
    const [ev, gd] = await Promise.all([
      lolAPI.liveEventData ? lolAPI.liveEventData().catch(() => null) : null,
      lolAPI.liveGameData ? lolAPI.liveGameData().catch(() => null) : null
    ]);
    if (token !== _cmtPollToken) return;
    if (ev?.Events) commentaryHandleEvents(ev.Events, gd);
    if (gd && !gd.__error) commentaryHandleGameState(gd);
  } catch (e) {}
}

function commentaryStartPolling() {
  if (_cmtPollTimer) return;
  commentaryEnsureItemPrices();
  commentaryPoll();
  _cmtPollTimer = setInterval(commentaryPoll, 4000);
}

function commentaryStopPolling() {
  if (_cmtPollTimer) clearInterval(_cmtPollTimer);
  _cmtPollTimer = null;
  _cmtPollToken++;
  _cmtSeen.clear();
  _cmtSeenSpike.clear();
  _cmtFirstBlood = false;
  _cmtSwingSide = 0;
  _cmtMatchSide = 0;
  _cmtCreep10Done = false;
  _cmtLastBoard = '';
  // 一局结束/重开时把解说侧的状态清干净, 否则上一局的连杀数和"已播到第几分钟"
  // 会带进下一局, 表现成"刚开局就念了 20 分钟小结"
  _cmtKillStreak = { ally: 0, enemy: 0 };
  _cmtSummaryDone = 0;
  _cmtSnapshot = null;
  _cmtSeq = 0;
  // 在线语音"挂了"的判断按局重置: 上一局断网不该影响下一局用回好音色
  _cmtOnlineOff = false;
  _cmtOnlineFails = 0;
}

// 选人阶段缓存"名字 -> 位置": 对局中 live data 的 position 经常是空串,
// 这份缓存是当时唯一还拿得到位置的来源。拿不到就算了, 不做对位推断。
async function commentaryCachePositions() {
  const M = window.PoroMetrics;
  if (!M || !lolAPI.lcuRequest) return;
  try {
    const s = await lolAPI.lcuRequest('GET', '/lol-champ-select/v1/session');
    const map = Object.create(null);
    const everyone = [].concat(Array.isArray(s?.myTeam) ? s.myTeam : [], Array.isArray(s?.theirTeam) ? s.theirTeam : []);
    for (const p of everyone) {
      const pos = M.normalizePosition(p?.assignedPosition);
      if (!pos) continue;
      for (const n of [p?.gameName, p?.summonerName, p?.displayName]) {
        const key = String(n || '').trim().toLowerCase();
        if (key) map[key] = pos;
      }
    }
    if (Object.keys(map).length) _cmtPosTable = map;
  } catch (e) {}
}

function commentaryOnPhase(phase) {
  if (!cmtAnyActive()) return;
  if (phase !== _cmtLastPhase) {
    _cmtLastPhase = phase;
    const lines = cmtLines();
    if (phase === 'ChampSelect') {
      if (commentaryOn && commentaryEvents.phase) commentarySpeak(lines.champSelect, 'phase:cs', 20000);
      // 上一局的状态清掉, 但不打断正在进行的播报
      _cmtFirstBlood = false;
      _cmtSwingSide = 0;
      _cmtPosTable = Object.create(null);
      commentaryCachePositions();
    } else if (phase === 'GameStart') {
      if (commentaryOn && commentaryEvents.phase) commentarySpeak(lines.loading, 'phase:load', 15000);
    } else if (phase === 'InProgress') {
      if (commentaryOn && commentaryEvents.phase) commentarySpeak(lines.start, 'phase:start', 30000);
    } else if (phase === 'WaitingForStats' || phase === 'EndOfGame') {
      if (commentaryOn && commentaryEvents.phase) {
        commentarySpeak(lines.end, 'phase:end', 20000);
        // 结束语 + 一句战况总结。两句会按队列依次念, 不会叠在一起
        const S = window.PoroScript;
        if (S && _cmtSnapshot) {
          const sum = S.buildEndSummary({
            tone: commentaryTone,
            kills: _cmtSnapshot.kills,
            deaths: _cmtSnapshot.deaths,
            leadPct: _cmtSnapshot.leadPct,
            seq: _cmtSeq++
          });
          if (sum && sum.text) commentarySpeak(sum.text, 'end:sum', 20000);
          _cmtSnapshot = null;
        }
      }
    }
  }
  // 轮询与语音开关无关: 只要还想看浮窗数据就得采样
  if (['GameStart', 'InProgress', 'PRACTICETOOL'].includes(phase)) {
    commentaryStartPolling();
  } else if (phase !== 'ChampSelect') {
    commentaryStopPolling();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', commentaryInitVoices);
} else {
  commentaryInitVoices();
}
