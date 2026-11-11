// 对局提示: 敌方成装 / 对位经济 / 十分钟补刀 —— 只在游戏里用语音播三条有用的信息
//
// 历史: 这个文件原来是「解说模式」(commentary.js), 除了这三条提示还会念击杀、多杀、
// 推塔、大小龙、团灭、五分钟小结。1.5.82 按用户要求把解说模式整块删掉, 只留下对局
// 提示 —— 它复用的是同一套语音通道, 所以音频处理链、在线合成、音色档位都原样保留。
//
// 数据源: Live Client Data 的 /liveclientdata/allgamedata (4 秒一次)
// 原则: 宁可少说, 不刷屏 —— 同类播报有冷却, 队列超过 3 条丢最旧的。
//
// 命名说明: 内部的 `cmt*` 前缀是 commentary 的缩写, 属于历史遗留; 对外的函数
// 已经改成 liveTips*。storage key (commentaryRate 等) 刻意没改 —— 改了等于把用户
// 已经调好的音色/语速/音量全部重置。

// 语音设置 (沿用旧的 storage key, 见文件头说明)
let commentaryRate = 1;
let commentaryVolume = 0.9;
let commentaryEngine = 'online';
let commentaryVoice = '';
// 在线通道的神经音色 id (与本机音色分开存, 两者值域不同, 混用会在切换时互相覆盖)
let _cmtNeuralVoice = '';
let commentaryStyle = 'soft';

// 对局提示 (默认全关, 由用户自己打开, 免得刚更新就被语音打扰)
let liveTips = { itemSpike: false, matchup: false, creep10: false };
// F9 浮窗是否显示本局实时数据
let liveBoardOn = true;

let _cmtPollTimer = null;
let _cmtPollToken = 0;
let _cmtSeenSpike = new Set();
let _cmtMatchSide = 0;
let _cmtCreep10Done = false;
let _cmtPosTable = Object.create(null);
let _cmtLastBoard = '';
let _cmtLastPhase = '';
let _cmtVoice = null;
let _cmtPending = 0;
let _cmtRateLimited = Object.create(null);
let _cmtItemPrices = null;
let _cmtItemLoading = false;
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
// 只保留三条对局提示的句子。占位符: {champ} 英雄名 / {gold} 金币差 / {cs} 补刀数
const TIPS_TEXT = {
  spike: '对面{champ}已经{n}件套，得小心了',
  matchLead: '对位压着打，领先{gold}',
  matchBehind: '对位落后{gold}，先别硬拼',
  creepGood: '十分钟{cs}刀，补刀很稳',
  creepBad: '十分钟{cs}刀，补刀少了点'
};

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
  const sel = document.getElementById('voiceVoice');
  if (!sel) return;
  // 在线通道: 列出神经音色 (男女声可选), 这是这一版"不机械"的关键
  if (commentaryEngine === 'online') {
    const list = cmtNeuralVoices();
    sel.innerHTML = list.map(v =>
      `<option value="${escapeHtml(v.id)}">音色: ${escapeHtml(v.label || v.id)}</option>`
    ).join('');
    sel.value = cmtPickNeuralVoice(_cmtNeuralVoice);
    sel.disabled = false;
    // 主进程的音色表最准, 拉到了会重绘一次
    cmtEnsureNeuralVoices();
    return;
  }
  const list = commentaryVoiceList();
  if (!list.length) {
    sel.innerHTML = '<option value="">本机无中文音色</option>';
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

// ---------- 神经音色 (在线通道) ----------
// 在线语音走微软神经 TTS, 可选音色。这里是一份兜底表 (首屏就能渲染下拉),
// 主进程的 ttsVoices 返回后覆盖 —— 只列实测服务端认的音色。
const CMT_NEURAL_FALLBACK = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔女声', desc: '最自然, 播报不抢戏' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 清亮女声', desc: '声音偏亮, 听得清' },
  { id: 'zh-CN-XiaoxuanNeural', label: '晓璇 · 冷静女声', desc: '平稳, 情绪起伏小' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 年轻男声', desc: '偏解说腔' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 沉稳男声', desc: '低沉, 适合当背景音' }
];
const CMT_NEURAL_DEFAULT = 'zh-CN-XiaoxiaoNeural';
// 神经语音自带自然停顿, 默认比朗读稍快一点就跟得上对局; 用户语速档位在此之上叠加
const CMT_NEURAL_BASE_RATE = 8;
let _cmtNeuralVoices = null;

function cmtNeuralVoices() {
  return _cmtNeuralVoices && _cmtNeuralVoices.length ? _cmtNeuralVoices : CMT_NEURAL_FALLBACK;
}

function cmtPickNeuralVoice(name) {
  const list = cmtNeuralVoices();
  return list.some(v => v.id === name) ? name : (list[0]?.id || CMT_NEURAL_DEFAULT);
}

// 主进程音色表是唯一事实来源: 拉到就替换兜底表并重绘下拉
async function cmtEnsureNeuralVoices() {
  if (_cmtNeuralVoices) return _cmtNeuralVoices;
  try {
    if (typeof lolAPI !== 'undefined' && lolAPI.ttsVoices) {
      const list = await lolAPI.ttsVoices();
      if (Array.isArray(list) && list.length) {
        _cmtNeuralVoices = list;
        cmtRenderVoiceOptions();
      }
    }
  } catch (e) {}
  if (!_cmtNeuralVoices) _cmtNeuralVoices = CMT_NEURAL_FALLBACK.slice();
  return _cmtNeuralVoices;
}

// 在线通道的合成参数。语速交给 SSML 的 rate 百分比, 不走 playbackRate ——
// 变速会给神经语音带上金属味, 正是要摆脱的东西。
function commentaryOnlineOpts(reset) {
  const o = {
    voice: cmtPickNeuralVoice(_cmtNeuralVoice),
    rate: CMT_NEURAL_BASE_RATE + Math.round((commentaryRate - 1) * 100),
    pitch: 0
  };
  if (reset) o.reset = true;
  return o;
}


// 旧接口的提速倍数: 那档音色念得慢且平, 一句 13 字要 3.6 秒, 跟不上对局节奏。
// 神经语音不适用 —— 它的语速在合成时由 SSML rate 定, 播放端倍增会毁掉自然度。
const CMT_ONLINE_RATE_BOOST = 1.20;

// ---------- 音色风格 (播放端后处理) ----------
// 分两套: 神经语音已经是录音棚级的真人音, 重 EQ 只会把它压闷, 所以神经档
// 只留极轻的高频毛刺抑制和一点点空间感; 旧接口那个机械女声才需要靠降调 +
// 低通 + 压金属共鸣峰 + 补低频硬凑出"柔和"。
const CMT_STYLE = {
  soft:  { rate: 0.92, lp: 6800,  peak: -3.0, peakF: 2900, low: 2.0, lowF: 190, wet: 0.10 },
  clear: { rate: 1.00, lp: 20000, peak: 0,    peakF: 2900, low: 0,   lowF: 190, wet: 0 },
  deep:  { rate: 0.86, lp: 5200,  peak: -2.0, peakF: 2500, low: 3.5, lowF: 170, wet: 0.14 }
};
// 神经语音档: rate 只做极小幅收放 (听感差异靠音色选择, 不靠压扁音高)
const CMT_NEURAL_STYLE = {
  soft:  { rate: 0.98, lp: 18000, peak: 0, peakF: 2900, low: 0,   lowF: 190, wet: 0.05 },
  clear: { rate: 1.00, lp: 20000, peak: 0, peakF: 2900, low: 0,   lowF: 190, wet: 0 },
  deep:  { rate: 0.94, lp: 15000, peak: 0, peakF: 2400, low: 1.0, lowF: 170, wet: 0.06 }
};
function cmtStyleCfg(name, neural) {
  const table = neural ? CMT_NEURAL_STYLE : CMT_STYLE;
  return table[name] || table.soft;
}

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
// neural=true 时走轻处理档 (神经语音不需要压机械感)
async function cmtPlayProcessed(dataUrl, rate, style, neural) {
  const ctx = cmtAudioCtx();
  if (!ctx) return false;
  let buf = null;
  try { buf = await ctx.decodeAudioData(cmtDataUrlBuffer(dataUrl)); } catch (e) { return false; }
  if (!buf || !buf.duration) return false;
  const cfg = cmtStyleCfg(style, neural);
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
function cmtPlayElement(dataUrl, rate, style, neural) {
  const cfg = cmtStyleCfg(style, neural);
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
async function cmtPlayAudio(dataUrl, rate, neural) {
  const ok = await cmtPlayProcessed(dataUrl, rate, commentaryStyle, neural);
  if (ok) return;
  return cmtPlayElement(dataUrl, rate, commentaryStyle, neural);
}

// 关掉提示 / 换局时立刻掐断, 否则已经排队的几条会继续念完
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
  console.warn('[live-tips] 在线语音不可用, 回退本地音色:', reason || '');
  const hint = document.getElementById('liveTipsHint');
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

// 串行播放在线音频: 播报是有先后顺序的, 重叠播放等于什么都听不清
async function cmtDrainAudio() {
  if (_cmtAudioBusy) return;
  _cmtAudioBusy = true;
  try {
    while (_cmtAudioQueue.length) {
      const job = _cmtAudioQueue.shift();
      let res = null;
      try {
        res = await lolAPI.ttsSynthesize(job.text, commentaryOnlineOpts(job.reset));
      } catch (e) { res = null; }
      if (!res || !res.ok || !res.dataUrl) {
        _cmtOnlineFails++;
        // 一次拿不到就整局退回本地: 断网时如果每句都要等超时, 播报就变成几分钟前的旧闻。
        // 下一局开始时会重置, 网络恢复了自然会用回在线音色。
        cmtFallbackToLocal(res && res.error);
        cmtSpeakLocal(job.text);
        continue;
      }
      _cmtOnlineFails = 0;
      // 神经语音的语速已经在合成时用 SSML 定好, 播放端再倍增只会带上金属味;
      // 旧接口音色本身偏慢偏平, 才需要 playbackRate 提速。
      const neural = res.source === 'edge';
      const playRate = neural ? 1 : commentaryRate * CMT_ONLINE_RATE_BOOST;
      await cmtPlayAudio(res.dataUrl, playRate, neural);
    }
  } finally {
    _cmtAudioBusy = false;
  }
}

function cmtEnqueueAudio(text, reset) {
  _cmtAudioQueue.push({ text, reset: !!reset });
  // 落后太多就丢最旧的: 宁可少播一条, 也不要追着念二十秒前的事
  while (_cmtAudioQueue.length > 3) _cmtAudioQueue.shift();
  cmtDrainAudio();
}

// 底层发声: 只管冷却与排队。reset 用于"用户刚换了音色, 立刻要听新的",
// 它会清掉主进程神经通道的失败冷却, 否则可能干等 90 秒。
function cmtSpeakRaw(text, key, cooldownMs, reset) {
  if (!text) return;
  const now = Date.now();
  const k = key || text;
  if (cooldownMs && _cmtRateLimited[k] && now - _cmtRateLimited[k] < cooldownMs) return;
  _cmtRateLimited[k] = now;
  const engine = commentaryEngine === 'local' ? 'local' : 'online';
  if (engine === 'online' && !_cmtOnlineOff && lolAPI.ttsSynthesize) {
    cmtEnqueueAudio(String(text).slice(0, 120), reset);
    return;
  }
  // 本地通道的并发上限: 已在念两条以上时直接丢弃, 否则会追着念十秒前发生的事
  if (_cmtPending >= 2) return;
  cmtSpeakLocal(text);
}

function liveTipsAnyOn() {
  return !!(liveTips.itemSpike || liveTips.matchup || liveTips.creep10);
}

// 对局提示通道: 只要有一项提示开着就出声
function liveTipsSpeak(text, key, cooldownMs) {
  if (!text || !liveTipsAnyOn()) return;
  cmtSpeakRaw(text, key, cooldownMs);
}

// ---------- 设置与界面 ----------
function liveTipsSetState() {
  const on = liveTipsAnyOn();
  const el = document.getElementById('liveTipsState');
  if (el) {
    el.textContent = on ? '已开启' : '已关闭';
    el.style.color = on ? 'var(--positive)' : '';
  }
  // 主开关只是三个子项的聚合视图: 任一开着就算勾上 (单一事实来源, 不存第二份状态)
  const master = document.getElementById('liveTipsMaster');
  if (master) master.checked = on;
  const hint = document.getElementById('liveTipsHint');
  if (hint && !on) hint.textContent = '未开启';
}

function liveTipsLoadConfig() {
  const rate = parseFloat(storeGet('commentaryRate'));
  commentaryRate = [0.85, 1, 1.15].includes(rate) ? rate : 1;
  const vol = parseFloat(storeGet('commentaryVolume'));
  commentaryVolume = Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 0.9;
  commentaryEngine = storeGet('commentaryEngine') === 'local' ? 'local' : 'online';
  commentaryVoice = String(storeGet('commentaryVoice') || '');
  _cmtNeuralVoice = String(storeGet('commentaryNeuralVoice') || CMT_NEURAL_DEFAULT);
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

  const rateEl = document.getElementById('voiceRate');
  if (rateEl) rateEl.value = String(commentaryRate);
  const volEl = document.getElementById('voiceVolume');
  if (volEl) volEl.value = String(Math.round(commentaryVolume * 100));
  const engineEl = document.getElementById('voiceEngine');
  if (engineEl) engineEl.value = commentaryEngine;
  const styleEl = document.getElementById('voiceStyle');
  if (styleEl) styleEl.value = commentaryStyle;
  cmtRenderVoiceOptions();
  const tipEls = { itemSpike: 'tipItemSpike', matchup: 'tipMatchup', creep10: 'tipCreep10' };
  for (const [key, id] of Object.entries(tipEls)) {
    const el = document.getElementById(id);
    if (el) el.checked = !!liveTips[key];
  }
  const boardEl = document.getElementById('liveBoardToggle');
  if (boardEl) boardEl.checked = liveBoardOn;
  liveTipsSetState();
}

// 语音设置 (引擎/音色/语速/音量/风格). 解说模式删掉后, 这些控件挪进了对局提示卡。
function setVoiceOption(key, value) {
  if (key === 'rate') {
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
    if (commentaryEngine === 'online') {
      // 在线通道选的是神经音色; 本机音色名对它无效, 所以两条存位要分开
      _cmtNeuralVoice = cmtPickNeuralVoice(String(value || ''));
      storeSet('commentaryNeuralVoice', _cmtNeuralVoice);
    } else {
      commentaryVoice = String(value || '');
      storeSet('commentaryVoice', commentaryVoice);
      _cmtVoice = commentaryPickVoice();
    }
    // 换音色立刻用新声音说一句, 否则要等下一条播报才听得出差别
    cmtSpeakRaw('这样听起来是不是柔和一点', 'test:voice', 0, true);
  } else if (key === 'style') {
    commentaryStyle = CMT_STYLE[value] ? value : 'soft';
    storeSet('commentaryStyle', commentaryStyle);
    // 换风格后立刻用新音色说一句, 否则要等下一条播报才听得出差别
    cmtSpeakRaw('这样听起来是不是柔和一点', 'test:style', 0, true);
  }
}

// 对局提示的单项开关
function setLiveTip(key, on) {
  if (!(key in liveTips)) return;
  liveTips[key] = !!on;
  storeSet('liveTips', JSON.stringify(liveTips));
  if (liveTipsAnyOn()) {
    // 用户刚点过开关, 这次发声落在用户手势上下文里, 不会被浏览器静默拦掉
    liveTipsSpeak('对局提示已开启', 'tips:on', 0);
    if (window._gameflowPhase === 'InProgress') liveTipsStartPolling();
  }
  if (typeof toolMsg === 'function') {
    toolMsg(liveTipsAnyOn()
      ? '<span style="color:var(--positive)">对局提示已开启</span>'
      : '对局提示已全部关闭');
  }
  liveTipsSetState();
}

// 总开关 (2026-11-06): 一键关/开全部语音提示。关时记住当前组合, 再开时原样
// 恢复 —— 用户调好的"只要补刀不要经济差"不该被一键开关抹掉。只管语音,
// F9 浮窗 (liveBoardOn) 有自己的开关, 共用的采样轮询也不受影响。
function toggleLiveTipsMaster(on) {
  if (on) {
    const saved = safeParseStore('liveTipsSaved', null, v => v && typeof v === 'object' && !Array.isArray(v));
    liveTips = saved && (saved.itemSpike || saved.matchup || saved.creep10)
      ? { itemSpike: !!saved.itemSpike, matchup: !!saved.matchup, creep10: !!saved.creep10 }
      : { itemSpike: true, matchup: true, creep10: true };   // 没存过 = 三项全开
  } else {
    if (liveTipsAnyOn()) storeSet('liveTipsSaved', JSON.stringify(liveTips));
    liveTips = { itemSpike: false, matchup: false, creep10: false };
  }
  storeSet('liveTips', JSON.stringify(liveTips));
  for (const [key, id] of Object.entries({ itemSpike: 'tipItemSpike', matchup: 'tipMatchup', creep10: 'tipCreep10' })) {
    const el = document.getElementById(id);
    if (el) el.checked = !!liveTips[key];
  }
  if (on) {
    if (window._gameflowPhase === 'InProgress') liveTipsStartPolling();
    liveTipsSpeak('对局提示已开启', 'tips:on', 0);
  } else {
    // 语音队列里可能还压着没念完的, 掐掉, 别关了开关还在说话;
    // 浮窗也关着的话采样轮询一并停 (下次进对局 phase 会自动重启)
    cmtStopAudio();
    if (!liveBoardOn) liveTipsStopPolling();
  }
  if (typeof toolMsg === 'function') {
    toolMsg(on
      ? '<span style="color:var(--positive)">对局提示已开启</span>'
      : '对局提示已全部关闭');
  }
  liveTipsSetState();
}

function toggleLiveBoard(on) {
  liveBoardOn = !!on;
  storeSet('liveBoard', on ? '1' : '0');
  if (liveBoardOn) {
    if (window._gameflowPhase === 'InProgress') liveTipsStartPolling();
  } else {
    _cmtLastBoard = '';
    try { if (lolAPI.liveBoardPush) lolAPI.liveBoardPush({ clear: true }); } catch (e) {}
  }
}

// 试听: 念一句真实的提示语, 用户要判断的是"打起来的时候听起来怎么样"
function testVoice() {
  cmtSpeakRaw('试听，对面中单已经三件套了，得小心了。', 'test:1', 0, true);
}

// ---------- 数据 ----------
async function liveTipsEnsureItemPrices() {
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
function liveTipsCheckSpikes(M, split, prices) {
  if (!liveTips.itemSpike || !split) return '';
  let latest = '';
  for (const s of M.detectSpikes(split.enemy, prices, [2, 3, 4])) {
    if (_cmtSeenSpike.has(s.key)) continue;
    _cmtSeenSpike.add(s.key);
    const text = cmtFmt(TIPS_TEXT.spike, { champ: cmtChampNameOf(s.player), n: s.step });
    liveTipsSpeak(text, 'spike:' + s.key, 0);
    latest = text;
  }
  return latest;
}

// 对位经济: 只有能确定位置时才比。位置拿不到就不播 —— 猜错位置等于给错结论
function liveTipsCheckMatchup(M, players, gd, prices) {
  if (!liveTips.matchup) return null;
  const mu = M.findMatchup(players, gd, _cmtPosTable);
  if (!mu) return null;
  const diff = Math.round(M.playerValue(mu.self, prices) - M.playerValue(mu.opp, prices));
  // 1500 金以上算明显领先/落后; 回落到 600 以内才允许重新播报 (迟滞, 避免来回横跳)
  if (diff >= 1500 && _cmtMatchSide !== 1) {
    _cmtMatchSide = 1;
    liveTipsSpeak(cmtFmt(TIPS_TEXT.matchLead, { gold: M.formatGold(Math.abs(diff)) }), 'mu:lead', 120000);
  } else if (diff <= -1500 && _cmtMatchSide !== -1) {
    _cmtMatchSide = -1;
    liveTipsSpeak(cmtFmt(TIPS_TEXT.matchBehind, { gold: M.formatGold(Math.abs(diff)) }), 'mu:behind', 120000);
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
function liveTipsCheckCreep10(M, split, gameTime) {
  if (_cmtCreep10Done || !liveTips.creep10 || !split || !split.self) return null;
  if (gameTime > 780) { _cmtCreep10Done = true; return null; }
  if (gameTime < 600) return null;
  _cmtCreep10Done = true;
  const m = M.creepMilestone(split.self, split.self.position);
  liveTipsSpeak(cmtFmt(m.hit ? TIPS_TEXT.creepGood : TIPS_TEXT.creepBad, { cs: m.cs }), 'creep10', 0);
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
function liveTipsPushBoard(M, totals, matchup, spikeText, gameTime) {
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

function liveTipsHandleGameState(gd) {
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

  const spikeText = liveTipsCheckSpikes(M, split, prices);
  const matchup = liveTipsCheckMatchup(M, players, gd, prices);
  liveTipsCheckCreep10(M, split, gameTime);

  return liveTipsPushBoard(M, totals, matchup, spikeText, gameTime);
}

// ---------- 轮询与阶段 ----------
// 只要还想看浮窗数据或听提示就得采样
function liveTipsAnyActive() {
  const tipsAllowed = !window.automationModeAllows || window.automationModeAllows('liveTipsMaster');
  return (liveTipsAnyOn() && tipsAllowed) || liveBoardOn;
}

async function liveTipsPoll() {
  if (!liveTipsAnyActive()) return;
  if (window._gameflowPhase !== 'InProgress' && window._gameflowPhase !== 'PRACTICETOOL') return;
  const token = ++_cmtPollToken;
  try {
    liveTipsEnsureItemPrices();
    const gd = lolAPI.liveGameData ? await lolAPI.liveGameData().catch(() => null) : null;
    if (token !== _cmtPollToken) return;
    if (gd && !gd.__error) liveTipsHandleGameState(gd);
  } catch (e) {}
}

function liveTipsStartPolling() {
  if (document.hidden || _cmtPollTimer) return;
  liveTipsEnsureItemPrices();
  liveTipsPoll();
  _cmtPollTimer = setInterval(liveTipsPoll, 4000);
}

if (typeof document?.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) liveTipsStopPolling();
    else if (liveTipsAnyActive() && (window._gameflowPhase === 'InProgress' || window._gameflowPhase === 'PRACTICETOOL')) liveTipsStartPolling();
  });
}

function liveTipsStopPolling() {
  if (_cmtPollTimer) clearInterval(_cmtPollTimer);
  _cmtPollTimer = null;
  _cmtPollToken++;
  _cmtSeenSpike.clear();
  _cmtMatchSide = 0;
  _cmtCreep10Done = false;
  _cmtLastBoard = '';
  // 在线语音"挂了"的判断按局重置: 上一局断网不该影响下一局用回好音色
  _cmtOnlineOff = false;
  _cmtOnlineFails = 0;
}

// 选人阶段缓存"名字 -> 位置": 对局中 live data 的 position 经常是空串,
// 这份缓存是当时唯一还拿得到位置的来源。拿不到就算了, 不做对位推断。
async function liveTipsCachePositions() {
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

function liveTipsOnPhase(phase) {
  if (!liveTipsAnyActive()) return;
  if (phase !== _cmtLastPhase) {
    _cmtLastPhase = phase;
    if (phase === 'ChampSelect') {
      _cmtPosTable = Object.create(null);
      liveTipsCachePositions();
    }
  }
  // 轮询与语音开关无关: 只要还想看浮窗数据就得采样
  if (['GameStart', 'InProgress', 'PRACTICETOOL'].includes(phase)) {
    liveTipsStartPolling();
  } else if (phase !== 'ChampSelect') {
    liveTipsStopPolling();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', commentaryInitVoices);
} else {
  commentaryInitVoices();
}
