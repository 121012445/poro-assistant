// 备战区倒计时 + 一键换英雄 (大乱斗/海斗)
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 备战区抢英雄倒计时 (大乱斗/海斗, 纯本地提示) ==========
// 机制: 用骰子重随英雄后, 被换掉的英雄进备战区并带 3 秒冷却 (由服务器判定)。
// 本功能只做本地差分检测 + 倒计时展示: 不代点、不写入客户端、不注入不读内存,
// 也不尝试缩短冷却。目的只是让用户知道"什么时候可以点", 而不是替他抢。
const BENCH_CD_MS = 3000;          // 备战区英雄冷却, 与服务端规则一致, 仅用于本地计时
const BENCH_READY_HOLD_MS = 4000;  // 归零后"可抢"提示保留时长
const BENCH_MAX_ITEMS = 3;         // 同屏最多展示几个, 避免刷屏
let benchAlertOn = false;
let _benchKnownIds = null;         // 上一次的备战区英雄 id 集合; null = 尚未建立基线
let _benchItems = [];              // [{ championId, readyAt }]
let _benchTick = null;
let _benchStateNote = null;        // 上一次写入的状态文案, 避免选人事件高频重复写 DOM

// 状态文案只在变化时写 DOM (选人事件每秒会触发多次)
function _benchSetState(text, colorKey) {
  if (_benchStateNote === text) return;
  _benchStateNote = text;
  const st = document.getElementById('benchAlertState');
  if (st) { st.textContent = text; st.style.color = colorKey ? 'var(--' + colorKey + ')' : ''; }
}

function toggleBenchAlert(on) {
  benchAlertOn = !!on;
  storeSet('benchAlert', on ? '1' : '0');
  // 开启瞬间重建基线: 此刻已在备战区的英雄早已过冷却, 不该立刻报警
  _benchTrackingReset();
  _benchSetState(on ? '已开启' : '已关闭', on ? 'positive' : '');
  toolMsg(on ? '<span style="color:var(--positive)">备战区倒计时已开启 (大乱斗/海斗选人时生效)</span>' : '备战区倒计时已关闭');
}

function _benchAlertHide() {
  const el = document.getElementById('benchAlert');
  if (el) el.className = 'bench-alert';
}

// 只重置"记账"部分: 冷却时间戳与倒计时浮层。
// 与提醒开关无关地复用, 因此不能顺手清掉换英雄任务 (关提醒不该打断正在进行的换人)。
function _benchTrackingReset() {
  _benchKnownIds = null;
  _benchItems = [];
  if (_benchTick) { clearInterval(_benchTick); _benchTick = null; }
  _benchAlertHide();
}

// 离开选人时的完整清理: 记账 + 浮层 + 换英雄重试 + 按钮行 + 列表缓存
function _benchAlertReset() {
  _benchTrackingReset();
  // GameStart/加载页到来后，任何迟到的列表事件都不能再借用上一局选人会话把浮窗唤醒。
  _benchLastSession = null;
  _benchOverlayDismissed = false;
  if (benchAlertOn) _benchSetState('已开启', 'positive');
  _benchSwapCancel();
  // 列表缓存必须清掉: 下一局选人时若沿用旧数据, 会列出上一局才可选的英雄
  _benchSubsetIds = [];
  _benchPickableIds = null;
  _benchListsTries = 0;
  _benchSubsetTries = 0;
  _benchListsInFlight = false;
  _benchLastPhase = null;
  _benchSubsetState = 'idle';
  _benchPickableState = 'idle';
  _benchSwapBtnsKey = '';
  const box = document.getElementById('benchSwapBtns');
  if (box) box.innerHTML = '<span class="tool-state">当前没有可换的英雄</span>';
  _benchSetSwapState('');
  _benchRenderDiag();
  _benchOverlayReset();   // 最后收尾: 让浮窗也收起, 不带走上一局的按钮
}

function _benchAlertRender() {
  const el = document.getElementById('benchAlert');
  if (!el) return;
  if (!_benchItems.length) { _benchAlertHide(); return; }
  const now = Date.now();
  const allReady = _benchItems.every(it => it.readyAt <= now);
  const parts = _benchItems.map(it => {
    // 英雄名来自 ddragon 静态数据, 仍按项目规范转义后再拼 HTML
    const name = escapeHtml(champNumMap?.[String(it.championId)]?.name || ('英雄#' + it.championId));
    if (it.readyAt <= now) return '<b>' + name + '</b>';
    return '<b>' + name + '</b> ' + ((it.readyAt - now) / 1000).toFixed(1) + 's';
  });
  el.innerHTML = (allReady ? '✅ 备战区 ' + parts.join(' · ') + ' — 现在可抢'
                           : '⏱ 备战区 ' + parts.join(' · ') + ' 后可抢');
  el.className = 'bench-alert show' + (allReady ? ' ready' : '');
}

function _benchAlertTickStart() {
  if (_benchTick) return;
  _benchTick = setInterval(() => {
    const now = Date.now();
    _benchItems = _benchItems.filter(it => now < it.readyAt + BENCH_READY_HOLD_MS);
    if (!_benchItems.length) { clearInterval(_benchTick); _benchTick = null; _benchAlertHide(); return; }
    _benchAlertRender();
  }, 100);
}

// 由选人会话事件驱动: 备战区新增英雄 = 有人刚重随, 起本地 3 秒倒计时。
// 注意这里的"记账"(每个英雄的冷却结束时刻) 与提醒开关无关 —— 换英雄要拿它挑出手时机,
// 所以开关关着也照记, 只是不弹浮层。
function benchAlertWatch(session) {
  // 仅启用备战区的模式 (大乱斗/海斗) 会带该字段; 非大乱斗模式不存在或为空。
  const bench = (session && Array.isArray(session.benchChampions)) ? session.benchChampions : null;
  if (!bench) {
    _benchKnownIds = null;
    _benchItems = [];
    if (benchAlertOn) _benchSetState(session ? '当前模式无备战区' : '已开启', session ? 'text-muted' : 'positive');
    return;
  }
  if (benchAlertOn) _benchSetState('监听中', 'accent');
  const ids = new Set(bench.map(b => b && b.championId).filter(id => typeof id === 'number' && id > 0));
  const now = Date.now();
  // 只留仍在备战区、且还在保留期内的条目: 离场英雄的旧时间戳会误导换英雄的出手时机
  _benchItems = _benchItems.filter(it => ids.has(it.championId) && now < it.readyAt + BENCH_READY_HOLD_MS);
  // 首次快照只建基线: 刚进房间时已在备战区的英雄早已过冷却, 不能报警
  if (_benchKnownIds === null) { _benchKnownIds = ids; return; }
  const added = [...ids].filter(id => !_benchKnownIds.has(id));
  _benchKnownIds = ids;
  if (!added.length) return;
  for (const id of added) {
    _benchItems.push({ championId: id, readyAt: now + BENCH_CD_MS });
  }
  if (_benchItems.length > BENCH_MAX_ITEMS) _benchItems = _benchItems.slice(-BENCH_MAX_ITEMS);
  if (!benchAlertOn) return;   // 未开提醒: 只记账不显示
  _benchAlertRender();
  _benchAlertTickStart();
}

// ---- 一键换英雄: 点一下立即发起, 被服务器拒绝(冷却未过)则持续重试 ----
// 冷却本身由服务器判定, 这里不缩短它; 重试只是把"等"这件事从用户身上挪走。
//
// 重要修正 (2026-09-17): 首次出手【永不等待】。原先按本地记账把首次请求排到 readyAt 之后,
// 但那条 3 秒规则的真实作用域很窄 —— 只有「用骰子重随进备战席」的那一个英雄带 3 秒保护,
// 其余备战席英雄 (队友换下来的、备战席互换的) 服务器允许立即选择, 完全没有冷却。
// 本地只能观察到"备战区新增了一个英雄", 分不清来源, 于是给所有英雄都加了 3 秒等待,
// 把本来可以瞬换的英雄硬生生拖成了"有 CD"。现在改为: 立即打一次, 用服务器的真实答复说话;
// 只有被拒时才用本地记录把重试精确排到保护期结束, 省掉中间那一串注定被拒的请求。
const BENCH_SWAP_RETRY_MS = 250;     // 无本地记录时的重试间隔 (盲试)
const BENCH_SWAP_GIVEUP_MS = 15000;  // 放弃上限, 避免选人结束后还在打接口
const BENCH_SWAP_AFTER_CD_MS = 100;  // 冷却刚结束就出手容易撞上竞态, 留一点余量
const BENCH_SWAP_MAX_WAIT_MS = 3500; // 本地记录的等待超过此值说明时间戳不可信, 改为盲试
let _benchSwapTask = null;           // { championId, startedAt, until, tries, waitedLocally, scheduledFor }
let _benchSwapTimer = null;
let _benchSwapBtnsKey = '';          // 上一次渲染的按钮集合, 避免选人事件高频重绘
let _benchLastSession = null;        // 最近一次选人会话, 供列表事件到来时重绘
let _benchSubsetIds = [];            // 抽卡池 (ARAM 类模式的 subset), 这些英雄没有 3 秒冷却
let _benchPickableIds = null;        // 服务器权威"现在能选什么"; null = 未知, 此时不做门禁
let _benchOverlayDismissed = false;   // 用户点 × 后本局不再弹出；离开选人时重置
// 抽卡池与可选列表的额度必须分开计数。共用时 pickable 往往第 1 次就成功并把额度一次性拉满,
// 而抽卡池会晚于会话就绪 (真机上先返回 404) —— 结果是抽卡池整局都拿不到, 备选按钮直接消失。
let _benchListsTries = 0;            // 可选列表的主动拉取次数
let _benchSubsetTries = 0;           // 抽卡池的主动拉取次数
let _benchListsInFlight = false;     // 选人事件很密集, 防止并发重复拉取
let _benchLastPhase = null;          // 上一次见到的选人阶段, 用于在切进 BAN_PICK 时强制重拉
const BENCH_LISTS_MAX_TRIES = 5;     // 上限, 避免非抽卡模式白打接口
const BENCH_SUBSET_MAX_TRIES = 12;   // 抽卡池放宽: 它只在选人后半段才可能有值, 且没有叶子事件兜底
// 拉取状态: 真机上"没拉到"和"拉到了但是空"的修法完全不同 (前者是接口/时序问题, 后者是模式没抽卡池),
// 所以诊断行必须能区分, 不能都显示成 0。
let _benchSubsetState = 'idle';      // idle | ok | empty | error
let _benchPickableState = 'idle';    // idle | ok | empty | error
const BENCH_STATE_HINT = { idle: '(未拉)', error: '(失败)', empty: '(空)' };

function _benchSetSwapState(text, colorKey) {
  // 先记账再写 DOM: 主窗口没这个元素时, 浮窗依然要能拿到状态文案
  _benchOverlayState = text || '';
  _benchOverlayStateClass = _benchOverlayColorToClass(colorKey);
  const el = document.getElementById('benchSwapState');
  if (el) {
    el.textContent = text || '';
    el.style.color = colorKey ? 'var(--' + colorKey + ')' : '';
  }
  _benchOverlaySync();
}

// ========== 选人浮窗 (贴边小窗, 浮在客户端旁边) ==========
// 目的: 选人时不用切回 Poro 主窗口, 就能看到并点击"换到某个英雄"。
// 设计上刻意做得很薄 —— 浮窗自己不碰 LCU、不做任何门禁判断, 按钮列表与状态文案
// 全部由这里推过去, 点击再回传, 由 benchSwapNow 走完整流程。
// 这样"能不能换"只有一处判定 (本文件), 不会出现两个窗口判定不一致。
let benchOverlayOn = false;          // 用户开关 (设置项, 默认关)
let _benchOverlayItems = [];         // 最近一次算出的可用英雄 [{id,name,tag}]
let _benchOverlayState = '';         // 推给浮窗的状态文案
let _benchOverlayStateClass = '';    // positive | negative | accent | '' (与浮窗 CSS 类名一致)
let _benchOverlayKey = '';           // 去重: 内容没变就不打 IPC (选人事件每秒数次)
const _benchHexRateCache = new Map(); // championId -> {winRate,games}; 仅海克斯模式使用
const _benchHexRatePending = new Set();
const BENCH_OVERLAY_TITLE = '备战区';

function _benchOverlayItemKey(it) {
  const rate = Number.isFinite(Number(it?.winRate)) ? Number(it.winRate).toFixed(5) : '-';
  return it.id + ':' + it.tag + ':' + rate;
}

async function _benchLoadHexWinRates(ids) {
  if (!hexRecommendContext?.isHex || typeof lolAPI?.getHexChampionAugments !== 'function') return;
  const targets = [...new Set((ids || []).map(Number).filter(id => id > 0))]
    .filter(id => !_benchHexRateCache.has(id) && !_benchHexRatePending.has(id));
  if (!targets.length) return;
  targets.forEach(id => _benchHexRatePending.add(id));
  await Promise.all(targets.map(async id => {
    try {
      const data = await lolAPI.getHexChampionAugments(id, hexDataScope);
      const winRate = Number(data?.champion?.winRate ?? data?.baseline);
      if (!data?.__error && Number.isFinite(winRate)) {
        _benchHexRateCache.set(id, { winRate, games: Math.max(0, Number(data?.championGames) || 0) });
      }
    } catch (e) {
      // 只是不显示胜率，不能影响英雄按钮和一键换取。
    } finally {
      _benchHexRatePending.delete(id);
    }
  }));
  if (!hexRecommendContext?.isHex || !_benchLastSession) return;
  _benchOverlayKey = '';
  _benchSwapBtnsKey = '';
  benchRenderSwapButtons();
}

// 浮窗只认得三个语义色类; text-muted 之类的主题变量名传过去会失效, 一律降级为空。
function _benchOverlayColorToClass(colorKey) {
  return (colorKey === 'positive' || colorKey === 'negative' || colorKey === 'accent') ? colorKey : '';
}

// 只有"当前确实在大乱斗/海斗选人"时才让浮窗出现: 别的模式没有备战区, 浮着也是噪声。
function _benchOverlayVisible() {
  const s = _benchLastSession;
  return window._gameflowPhase === 'ChampSelect' && !!benchOverlayOn && !_benchOverlayDismissed
    && !!(s && Array.isArray(s.benchChampions));
}

function _benchOverlaySync() {
  if (!window.lolAPI || !lolAPI.overlayUpdate) return;
  const visible = _benchOverlayVisible();
  const key = (visible ? '1' : '0') + '|' +
    _benchOverlayItems.map(_benchOverlayItemKey).join(',') + '|' +
    _benchOverlayState + '|' + _benchOverlayStateClass;
  if (key === _benchOverlayKey) return;
  _benchOverlayKey = key;
  try {
    Promise.resolve(lolAPI.overlayUpdate({
      title: BENCH_OVERLAY_TITLE,
      items: visible ? _benchOverlayItems : [],
      state: _benchOverlayState,
      stateClass: _benchOverlayStateClass,
      visible: visible
    })).then(ok => {
      // 主进程重启/窗口创建竞态时允许下一帧重发，不能让去重 key 永久吞掉这次更新。
      if (!ok && _benchOverlayKey === key) _benchOverlayKey = '';
    }).catch(() => { if (_benchOverlayKey === key) _benchOverlayKey = ''; });
  } catch (e) { if (_benchOverlayKey === key) _benchOverlayKey = ''; }
}

// 离开选人 / 收尾: 清干净并让浮窗收起, 免得留下一个点不动的孤儿窗
function _benchOverlayReset() {
  _benchOverlayItems = [];
  _benchOverlayState = '';
  _benchOverlayStateClass = '';
  _benchOverlayKey = '';
  if (window.lolAPI && lolAPI.overlayUpdate) {
    try { lolAPI.overlayUpdate({ title: BENCH_OVERLAY_TITLE, items: [], state: '', stateClass: '', visible: false }); } catch (e) {}
  }
}

function toggleBenchOverlay(on) {
  benchOverlayOn = !!on;
  storeSet('benchOverlay', on ? '1' : '0');
  _benchOverlayKey = '';   // 强制推一帧: 开→立刻出现, 关→立刻收起
  _benchOverlaySync();
  toolMsg(on ? '选人浮窗已开启（进入大乱斗/海斗选人时浮在客户端旁边）' : '选人浮窗已关闭');
}

// 诊断行: 让用户一眼看出各数据源到底有没有拿到 (真机排查"为什么没按钮"的唯一手段)
function _benchRenderDiag(session) {
  const el = document.getElementById('benchDiag');
  if (!el) return;
  const s = session === undefined ? _benchLastSession : session;
  const benchN = ((s && Array.isArray(s.benchChampions)) ? s.benchChampions : []).length;
  const pickN = Array.isArray(_benchPickableIds) ? _benchPickableIds.length : -1;
  const phase = (s && s.timer && s.timer.phase) ? s.timer.phase : '-';
  // allowSubsetChampionPicks 为假 ⇒ 这个模式压根没有抽卡池, 此时"备选池 0"是正常的, 不是 bug
  const subMode = s ? (s.allowSubsetChampionPicks ? '是' : '否') : '?';
  const txt = '备战席 ' + benchN +
    ' · 备选池 ' + _benchSubsetIds.length + (BENCH_STATE_HINT[_benchSubsetState] || '') +
    ' · 可选 ' + (pickN < 0 ? '未知' : pickN) + (BENCH_STATE_HINT[_benchPickableState] || '') +
    ' · 抽卡 ' + subMode +
    ' · 阶段 ' + phase;
  if (el.textContent !== txt) el.textContent = txt;
}

// benchChampions 是“此刻真正位于备战席”的权威来源，不能再被瞬时且语义不同的 pickable 列表否决。
// pickable 只用于约束抽卡池候选；它在阶段切换时偶尔只返回 1 项或短暂清空。
function _benchCanGrab(championId, tag) {
  if (tag === '备战席') return true;
  if (Array.isArray(_benchPickableIds) && _benchPickableIds.length) {
    return _benchPickableIds.includes(championId);
  }
  return true;
}

function benchSetSubset(list) {
  _benchSubsetIds = Array.isArray(list)
    ? list.filter(id => typeof id === 'number' && id > 0) : [];
  _benchSubsetState = _benchSubsetIds.length ? 'ok' : 'empty';
  _benchSwapBtnsKey = '';
  benchRenderSwapButtons();
  _benchRenderDiag();
}

function benchSetPickable(list) {
  _benchPickableIds = Array.isArray(list)
    ? list.filter(id => typeof id === 'number' && id > 0) : null;
  _benchPickableState = Array.isArray(list)
    ? (_benchPickableIds.length ? 'ok' : 'empty') : 'error';
  _benchSwapBtnsKey = '';
  benchRenderSwapButtons();
  _benchRenderDiag();
}

// WS 事件只在变化时推送, 进选人时列表可能早已就位, 因此主动拉一次。
// 首次拉取可能早于客户端把数据准备好 (会返回 404), 所以保留重试, 拉到了就停。
// force=true 用于"阶段刚切进 BAN_PICK"和"收到 LTB 节点事件"这两种确定性的重拉时机。
async function benchFetchLists(force) {
  if (_benchListsInFlight) return;
  const needSubset = (force || _benchSubsetState !== 'ok') && _benchSubsetTries < BENCH_SUBSET_MAX_TRIES;
  const needPickable = (force || _benchPickableState !== 'ok') && _benchListsTries < BENCH_LISTS_MAX_TRIES;
  if (!needSubset && !needPickable) return;
  _benchListsInFlight = true;
  try {
    if (needSubset) {
      try {
        const sub = await lolAPI.lcuRequest('GET', '/lol-lobby-team-builder/champ-select/v1/subset-champion-list');
        if (Array.isArray(sub)) benchSetSubset(sub);
        else if (_benchSubsetState === 'idle') _benchSubsetState = 'error';
      } catch (e) {
        // 非抽卡模式本来就没有该数据 (404), 属正常; 但状态要记下来, 诊断行才能区分"没拉到"和"空"
        if (_benchSubsetState === 'idle') _benchSubsetState = 'error';
      }
      _benchSubsetTries++;   // 只在真正发完一轮后计数, 避免并发把重试额度烧掉
    }
    if (needPickable) {
      try {
        const pk = await lolAPI.lcuRequest('GET', '/lol-champ-select/v1/pickable-champion-ids');
        if (Array.isArray(pk)) benchSetPickable(pk);
        else if (_benchPickableState === 'idle') _benchPickableState = 'error';
      } catch (e) {
        if (_benchPickableState === 'idle') _benchPickableState = 'error';
      }
      _benchListsTries++;
    }
  } finally {
    _benchListsInFlight = false;
    _benchRenderDiag();
  }
}

// 被拒之后的重试间隔: 本地记着该英雄还处在重随保护期, 就精确排到那一刻 (省掉中间注定被拒的请求);
// 没有记录 (或记录已过期/不可信) 就按固定间隔盲试。
// 注意: 这只决定"重试"的节奏, 首次出手一律立刻发 —— 见 benchSwapNow。
function _benchSwapRetryDelay(championId) {
  const item = _benchItems.find(it => it.championId === championId);
  if (!item) return BENCH_SWAP_RETRY_MS;
  const wait = item.readyAt - Date.now() + BENCH_SWAP_AFTER_CD_MS;
  if (wait <= BENCH_SWAP_RETRY_MS) return BENCH_SWAP_RETRY_MS;
  if (wait > BENCH_SWAP_MAX_WAIT_MS) return BENCH_SWAP_RETRY_MS;
  return wait;
}

// 分两条写入路径 (对齐 Akari 的 handleBenchSwapOrPick): 抽卡/选用阶段且自己还没有英雄时,
// 服务器允许的是"选择"(PATCH actions/{id}), 这时候发 bench/swap 必然被拒 —— 没有东西可交换。
function _benchPickActionId() {
  const s = _benchLastSession;
  if (!s || !Array.isArray(s.actions)) return null;
  const mine = (s.myTeam || []).find(p => p.cellId === s.localPlayerCellId);
  if (mine && mine.championId > 0) return null;          // 已有英雄 ⇒ 只能是"交换"
  if (!s.timer || s.timer.phase !== 'BAN_PICK') return null;
  for (const group of s.actions) {
    if (!Array.isArray(group)) continue;
    for (const a of group) {
      if (a && a.actorCellId === s.localPlayerCellId && a.type === 'pick' && !a.completed) return a.id;
    }
  }
  return null;
}

function _benchSwapRequest(championId) {
  const actionId = _benchPickActionId();
  if (actionId !== null) {
    const path = '/lol-champ-select/v1/session/actions/' + actionId;
    return { route: '选择', req: lolAPI.lcuRequest('PATCH', path, { championId, type: 'pick', completed: true }) };
  }
  return { route: '换位', req: lolAPI.lcuRequest('POST', '/lol-champ-select/v1/session/bench/swap/' + championId) };
}

// 把"当前能换到的英雄"渲染成按钮; 只在集合变化时重绘。
// 两个来源:
//   备战席 (benchChampions) —— 队伍备战区里的英雄, 通常可以立即换到; 只有"刚被骰子重随进来"
//                              的那一个带 3 秒保护期 (服务器判定, 队友在此期间不能选)
//   备选池 (subset)         —— ARAM 类模式开局就固定的抽卡池, 从来没有 3 秒冷却, 点了就是瞬换
function benchRenderSwapButtons(session) {
  const box = document.getElementById('benchSwapBtns');
  if (!box) return;
  if (session !== undefined) _benchLastSession = session;
  const s = _benchLastSession;
  const benchIds = ((s && Array.isArray(s.benchChampions)) ? s.benchChampions : [])
    .map(b => b && b.championId).filter(id => typeof id === 'number' && id > 0);
  // 抽卡池只在"抽卡式选人 + 仍在 BAN_PICK 阶段"可用 (与客户端自身逻辑保持一致)
  const subsetUsable = !!(s && s.allowSubsetChampionPicks && s.timer && s.timer.phase === 'BAN_PICK');
  const subsetIds = subsetUsable ? _benchSubsetIds.filter(id => !benchIds.includes(id)) : [];
  const items = [
    ...benchIds.map(id => ({ id, tag: '备战席' })),
    ...subsetIds.map(id => ({ id, tag: '备选' }))
  ];
  const usable = items.filter(it => _benchCanGrab(it.id, it.tag));
  // 同步给浮窗: 用同一份"已过门禁"的列表, 保证浮窗按钮与主窗口按钮永远一致。
  // 放在缓存判断之前 —— 即使 DOM 因为集合没变而不重绘, 浮窗也该拿到最新数据。
  _benchOverlayItems = usable.map(it => ({
    id: it.id,
    name: (champNumMap?.[String(it.id)]?.name) || ('英雄#' + it.id),
    tag: it.tag,
    ...(hexRecommendContext?.isHex && _benchHexRateCache.has(it.id) ? _benchHexRateCache.get(it.id) : {})
  }));
  _benchOverlaySync();
  if (hexRecommendContext?.isHex) _benchLoadHexWinRates(usable.map(it => it.id));
  // 被服务器门禁挡掉的数量要显式说出来: 否则万一门禁判错, 按钮会无声消失, 看起来像功能坏了。
  // 同时点名是哪个列表挡的、它有多大 —— 真机上如果这个数字异常小 (比如只有 1~2 项),
  // 一眼就能看出是「可选列表」语义和备战席/抽卡池对不上, 而不是功能没生效。
  const blocked = items.length - usable.length;
  const gateN = Array.isArray(_benchPickableIds) ? _benchPickableIds.length : -1;
  const key = usable.map(it => it.id + ':' + it.tag).join(',') + '|' + blocked + '|' + gateN;
  if (key === _benchSwapBtnsKey) return;
  _benchSwapBtnsKey = key;
  try {
    lolAPI.debugLog?.('[BENCH] bench=' + benchIds.length + ' subset=' + subsetIds.length +
      ' pickable=' + gateN + ' visible=' + usable.length + ' blockedSubset=' + blocked);
  } catch (e) {}
  if (!usable.length) {
    box.innerHTML = blocked
      ? '<span class="tool-state">' + blocked + ' 个备选池英雄暂不可选' +
        (gateN >= 0 ? '（该列表仅 ' + gateN + ' 项）' : '') + '</span>'
      : '<span class="tool-state">当前没有可换的英雄</span>';
    return;
  }
  box.innerHTML = usable.map(it => {
    const name = escapeHtml(champNumMap?.[String(it.id)]?.name || ('英雄#' + it.id));
    const rate = hexRecommendContext?.isHex ? _benchHexRateCache.get(it.id) : null;
    const rateText = Number.isFinite(rate?.winRate) ? ' · ' + (rate.winRate * 100).toFixed(1) + '%' : '';
    return '<button class="btn-secondary" onclick="benchSwapNow(' + it.id + ')">换到 ' + name +
      ' <span class="bench-tag">' + it.tag + rateText + '</span></button>';
  }).join('') + (blocked
    ? '<span class="tool-state">另有 ' + blocked + ' 个备选池英雄暂不可选' +
      (gateN >= 0 ? '（该列表仅 ' + gateN + ' 项）' : '') + '</span>'
    : '');
}

function _benchSwapCancel() {
  if (_benchSwapTimer) { clearTimeout(_benchSwapTimer); _benchSwapTimer = null; }
  _benchSwapTask = null;
}

function benchSwapNow(championId) {
  if (!guardWrite('备战区换英雄')) return;
  _benchSwapCancel();
  const now = Date.now();
  _benchSwapTask = {
    championId,
    startedAt: now,
    until: now + BENCH_SWAP_GIVEUP_MS,
    tries: 0,
    waitedLocally: false,
    scheduledFor: now
  };
  // 立刻出手: "备战区多了个英雄"推不出"它还在保护期", 与其本地猜 3 秒,
  // 不如直接问服务器 —— 没有冷却的英雄第 1 次就换到了, 有保护期的才进入重试。
  _benchSetSwapState('已发起换英雄请求…', 'accent');
  try { lolAPI.debugLog?.('[BENCH] click champion=' + championId); } catch (e) {}
  _benchSwapAttempt();
}

async function _benchSwapAttempt() {
  const task = _benchSwapTask;
  if (!task) return;
  const { championId } = task;
  task.tries++;
  const name = champNumMap?.[String(championId)]?.name || ('英雄#' + championId);

  let ok = false;
  let reason = '';
  let route = '换位';
  try {
    const call = _benchSwapRequest(championId);
    route = call.route;
    const r = await call.req;
    // 与主进程 rawRequest 的约定一致: 只有带 __error 的才是失败。
    // 204 / 200 空体都会被 resolve 成 null —— 那是【成功】, 不能当失败(否则换成功了还在重试并报错)。
    if (!r || !r.__error) ok = true;
    else reason = r.httpStatus ? ('HTTP ' + r.httpStatus + (r.message ? ': ' + r.message : '')) : (r.__error || '服务器拒绝');
  } catch (e) {
    reason = (e && e.message) || String(e);
  }

  if (_benchSwapTask !== task) return;   // 期间被取消或被新请求取代

  if (ok) {
    const waited = ((Date.now() - task.startedAt) / 1000).toFixed(1);
    // 明确区分"第 1 次就成功"与"等了一段才成功": 这是判断冷却是否真实存在的直接依据
    _benchSetSwapState(task.tries === 1
      ? '已换到 ' + name + '（第 1 次即成功，未遇到冷却）'
      : '已换到 ' + name + '（等待 ' + waited + 's 后成功，共 ' + task.tries + ' 次请求）', 'positive');
    try { lolAPI.debugLog?.('[BENCH] success champion=' + championId + ' route=' + route + ' tries=' + task.tries); } catch (e) {}
    _benchSwapCancel();
    return;
  }

  if (Date.now() >= task.until) {
    _benchSetSwapState('换英雄失败: ' + reason + '（已重试 ' + task.tries + ' 次后放弃）', 'negative');
    try { lolAPI.debugLog?.('[BENCH] failed champion=' + championId + ' route=' + route + ' reason=' + reason); } catch (e) {}
    _benchSwapCancel();
    return;
  }

  const wait = _benchSwapRetryDelay(championId);
  task.waitedLocally = true;
  task.scheduledFor = Date.now() + wait;
  _benchSetSwapState('等待服务器允许…（' + route + ' ' + reason + '，已重试 ' + task.tries + ' 次' +
    (wait > BENCH_SWAP_RETRY_MS * 2 ? '，' + (wait / 1000).toFixed(1) + 's 后自动再试' : '') + '）', 'text-muted');
  _benchSwapTimer = setTimeout(_benchSwapAttempt, wait);
}

// 浮窗点击 -> 直接复用主窗口那条换人流程 (guardWrite 门禁 / 重试 / 合规拦截都在里面)。
// 绝不能让浮窗自己再写一套请求逻辑, 否则两处行为会分叉, 合规模式也可能被绕过。
if (window.lolAPI && lolAPI.onOverlaySwap) {
  lolAPI.onOverlaySwap(id => { try { benchSwapNow(id); } catch (e) { console.error('overlay swap error', e); } });
}
if (window.lolAPI && lolAPI.onOverlayHidden) {
  lolAPI.onOverlayHidden(() => {
    _benchOverlayDismissed = true;
    _benchOverlayKey = '';
  });
}

let _champLiveRefreshTimer = null;
function handleChampSelectEvent(session) {
  const now = Date.now();
  maybeAnnounceChampSelectSide(session); // 识别蓝/红方后，仅向本局选人聊天发送一次提示。
  window.poroSession?.setChampion(hexSelectedChampion(session));
  updateHexRecommendationContext(session); // 海斗强化页跟随当前锁定/悬停英雄刷新
  benchAlertWatch(session);        // 备战区倒计时提醒 (纯本地提示, 不写入客户端)
  benchRenderSwapButtons(session); // 可换英雄按钮 (点击才写入, 受合规模式门禁)
  _benchRenderDiag(session);       // 数据源诊断行
  // 阶段刚切进 BAN_PICK 时强制重拉: 抽卡池这时候才可能有值, 而 WS 那边只推节点级事件,
  // 没有子资源事件可以依赖 (见 main/lcu-ws.js 的 FORWARD_URIS 注释)。
  const ph = (session && session.timer && session.timer.phase) || null;
  if (ph !== _benchLastPhase) {
    _benchLastPhase = ph;
    if (ph === 'BAN_PICK') benchFetchLists(true);
  }
  benchFetchLists();               // 进选人时主动拉一次抽卡池/可选列表 (内部自带一次性守卫)
  if (session) {
    const mine = Array.isArray(session.myTeam) ? session.myTeam.map(p => ({ ...p, team: 100 })) : [];
    const theirs = Array.isArray(session.theirTeam) ? session.theirTeam.map(p => ({ ...p, team: 200 })) : [];
    const current = mine.concat(theirs).filter(p => p && (p.puuid || p.championId || p.cellId != null));
    if (current.length) {
      const rosterKey = current.map(p => p.puuid || `${p.team}:${p.cellId}:${p.championId || 0}`).sort().join('|');
      window.poroSession?.setGame('', rosterKey);
      champSelectParticipants = current;
      if (document.querySelector('.page.active')?.id === 'page-live') {
        clearTimeout(_champLiveRefreshTimer);
        _champLiveRefreshTimer = setTimeout(() => updateLivePage('ChampSelect'), 120);
      }
    }
  }
  if (now - _lastAutoBPTs > 1000) { _lastAutoBPTs = now; doAutoBP(); }
  // 捕获选人聊天房间 ID (对局内 KDA 简报的发送通道, 每次选人只查一次)
  if (!_champSelectChatCid && session && Array.isArray(session.myTeam) && session.myTeam.length) {
    lolAPI.lcuRequest('GET', '/lol-chat/v1/conversations').then(cs => {
      const room = Array.isArray(cs) && cs.find(c => c && c.type === 'championSelect' && c.id);
      if (room) { _champSelectChatCid = room.id; console.log('[chat] champSelect room captured:', room.id); }
    }).catch(() => {});
  }
  if (autoRuneEnabled && session?.myTeam && window._myPuuid) {
    const mySlot = session.myTeam.find(p => p.puuid === window._myPuuid);
    if (mySlot && mySlot.championId > 0) doAutoRune(mySlot.championId);
  }
  if (document.querySelector(".page.active")?.id === "page-counters") updateCounterClientPick();
}
// 组队提示: 根据近期共同对局推断，见 inferPremadeGroups / announceInferredPremades。
let _premadeNotifiedFor = '';
function handleReadyCheckEvent(rc) {
  if (!autoAcceptOn || complianceOn) return;
  console.log('[auto-accept] WS ready-check:', JSON.stringify({ state: rc?.state, playerResponse: rc?.playerResponse }));
  const hasPopup = rc && !!rc.state && rc.state !== 'None' && rc.state !== 'InProgress';
  const notResponded = !rc?.playerResponse || rc.playerResponse === 'None' || rc.playerResponse === '';
  if (hasPopup && notResponded) {
    acceptReadyCheckNow();
  } else if (hasPopup && rc.playerResponse === 'Accepted') {
    setReadyState("已接受，等待队友", 'done');
  } else {
    setReadyState("监听中...", 'listening');
  }
}
function wireLcuEvents() {
  if (!lolAPI.onLcuEvent) return;
  lolAPI.onLcuEvent(({ uri, data, eventType }) => {
    try {
      if (uri === '/lol-gameflow/v1/gameflow-phase') handleGameflowPhase(data);
      else if (uri === '/lol-champ-select/v1/session') { if (data) handleChampSelectEvent(data); }
      // 列表类端点被清空时 eventType 为 'Delete', 此时 data 是空值, 必须显式归零
      else if (uri === '/lol-champ-select/v1/pickable-champion-ids') benchSetPickable(eventType === 'Delete' ? [] : data);
      else if (uri === '/lol-lobby-team-builder/champ-select/v1/subset-champion-list') benchSetSubset(eventType === 'Delete' ? [] : data);
      // LTB 插件只注册了这个【节点级】事件, payload 不带子资源 —— 收到就主动重拉抽卡池。
      // 不兜这一手的话, 真机上抽卡池只能靠进选人那一次主动 GET, 一旦那一刻客户端还没就绪,
      // 整局都不会再有第二次机会, 「备选」按钮就此消失。
      else if (uri === '/lol-lobby-team-builder/champ-select/v1') benchFetchLists();
      else if (uri === '/lol-matchmaking/v1/ready-check') handleReadyCheckEvent(data);
      // eog-stats-block 比 gameflow 阶段更接近结算数据真正生成的时刻，可立即唤醒同一条补刷链。
      else if (uri === '/lol-end-of-game/v1/eog-stats-block') refreshAfterGameEnd('eog-stats');
      // 仅在切换账号时才刷新首页数据 (该事件高频触发, 避免整页重渲染导致详情自动收起)
      else if (uri === '/lol-summoner/v1/current-summoner' && data && data.puuid && data.puuid !== window._myPuuid) {
        // 切换账号也可能意味着切换 Riot 区服，不能沿用上一个客户端会话的平台缓存。
        cachedPlatformId = null;
        homeStatsLoaded = false;
      }
    } catch (e) { console.error('lcu event error', e); }
  });
  if (lolAPI.onWsState) {
    lolAPI.onWsState(({ connected }) => {
      _wsConnected = !!connected;
      const text = document.getElementById("lcuStatusText");
      if (text && lcuConnected && !connected) text.textContent = "客户端已连接 (事件通道重连中)";
      else if (text && lcuConnected) text.textContent = "客户端已连接";
    });
  }
  if (lolAPI.onShortcut) lolAPI.onShortcut(ally => { try { lolAPI.debugLog('[KDA] shortcut fired ally=' + ally); } catch (e) {} sendKDABriefing(ally); });
}
let _lcuFailCount = 0;
// 兜底轮询 (4s): WS 事件为主, 轮询保证 WS 断开时功能仍可用
async function pollLoop() {
  try {
    const st = await lolAPI.lcuStatus();
    lcuConnected = !!st.connected;
    const dot = document.getElementById("lcuDot");
    dot.className = "status-dot " + (lcuConnected ? "on" : "off");
    document.getElementById("lcuStatusText").textContent = lcuConnected ? "客户端已连接" : "客户端未连接";
    // 连续两次失败才判定为断开 (瞬时超时不触发首页重渲染)
    if (!lcuConnected) _lcuFailCount++; else _lcuFailCount = 0;
    if (!lcuConnected && _lcuFailCount >= 2) homeStatsLoaded = false;
    // 有展开中的对局详情时跳过整页重渲染, 避免"详情自动关闭"
    if (lcuConnected && !homeStatsLoaded && !homeStatsLoading && !document.querySelector('.ako-card.expanded')) loadHomeStats();
    // 缓存补刷/账号校验: 页面显示的是本地缓存时, LCU 一旦就绪:
    // 1) 登录账号变了 → 切回新账号数据  2) 缓存过期 → 静默拉最新
    if (lcuConnected && !homeStatsLoading && st.summoner && window._homeCacheNeedRefresh && !document.querySelector('.ako-card.expanded')) {
      window._homeCacheNeedRefresh = false;
      if (window._myPuuid && st.summoner.puuid !== window._myPuuid) {
        profileOverride = null;   // 换账号登录: 丢弃上个账号的查看状态, 切到新账号
      }
      // 对局结算补刷必须同时清主进程分页缓存；否则本地虽跳过了首页缓存，
      // 仍可能被 SGP 的 5 分钟缓存挡住。普通过期补刷清一次也不会扩大请求量。
      try {
        if (lolAPI.sgpInvalidateMatchHistory) await lolAPI.sgpInvalidateMatchHistory(st.summoner.puuid);
      } catch (e) {}
      loadHomeStats(true, { skipCache: true });
    }
    if (lcuConnected) {
      const phaseRes = await lolAPI.lcuRequest("GET", "/lol-gameflow/v1/gameflow-phase");
      const phase = phaseRes?.__error ? null : phaseRes;
      if (phase) handleGameflowPhase(phase);
      if (autoAcceptOn) await updateReadyCheck();
      // 选人兜底: WS 不可用时自动BP/符文仍生效 (handleGameflowPhase 已含 gsLock)
      if (phase === "ChampSelect" && !lcuWsConnected()) {
        try {
          const cs = await lolAPI.lcuRequest('GET', '/lol-champ-select/v1/session');
          if (cs && cs.myTeam) handleChampSelectEvent(cs);
        } catch (e) {}
      }
    }
  } catch (e) { console.error("poll error", e); }
  // WS 正常时把轮询降为 12s，仅作漏事件兜底；WS 断开时保持 4s，未连接时 1.5s 快速探测。
  const nextPollMs = !lcuConnected ? 1500 : (lcuWsConnected() ? 12000 : 4000);
  setTimeout(pollLoop, nextPollMs);
}
// WS 连接状态 (preload 事件维护)
let _wsConnected = false;
function lcuWsConnected() { return _wsConnected; }

async function fakeRank() {
  if (!guardAutomation('伪造段位')) return;
  const tier = document.getElementById('fakeTier').value;
  const div = document.getElementById('fakeDiv').value;
  const r = await lolAPI.lcuRequest('PUT', '/lol-chat/v1/me', { lol: { rankedLeagueQueue: 'RANKED_SOLO_5x5', rankedLeagueTier: tier, rankedLeagueDivision: div } });
  toolMsg(r && r.__error ? `<span style="color:var(--negative)">修改失败: ${r.__error}</span>` : '<span style="color:var(--positive)">段位卡片已修改, 好友列表可见</span>');
}
