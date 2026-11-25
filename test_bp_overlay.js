'use strict';
// 选人助手浮窗（1.6.70）：克制关系 + 阵容 BP 建议从软件内的页面搬到贴客户端的独立浮窗。
// 这个测试守三件事：
//   1. bp-advisor 推给浮窗的内容确实带上了克制清单，且开关关掉时可见位必须是 false；
//   2. 浮窗页/渲染脚本本身不会被塞进任何可执行的注入面（只贴主窗口算好的 HTML）；
//   3. 主进程窗口与 IPC 接线齐全（置顶、不抢焦点、阶段门禁、HTML 长度上限）。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const src = read('renderer/js/bp-advisor.js');
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CHAMPS = {
  1: { id: 'Annie', name: '安妮' },
  2: { id: 'Viktor', name: '维克托' },
  3: { id: 'Ahri', name: '阿狸' }
};
const champNumMap = Object.assign({}, CHAMPS);
const statsOf = (wr, play) => ({ win_rate: wr, play, pick_rate: 0.05, ban_rate: 0.1, tier_data: { tier: 2 } });
const opggPosList = [
  { championId: 1, positionKey: 'MID', position: '中单', stats: statsOf(0.50, 5000) },
  { championId: 2, positionKey: 'MID', position: '中单', stats: statsOf(0.52, 5000) },
  { championId: 3, positionKey: 'MID', position: '中单', stats: statsOf(0.49, 5000) }
];
// 1 的对位表：2 打 1 有 60%（威胁），3 打 1 只有 40%；2 的对位表里 1 是 50% → 1 是 2 的"猎物"
const opggMap = {
  1: { id: 1, positions: [{ name: 'MID', counters: [{ champion_id: 2, play: 600, win: 360 }, { champion_id: 3, play: 600, win: 240 }] }] },
  2: { id: 2, positions: [{ name: 'MID', counters: [{ champion_id: 1, play: 600, win: 300 }] }] },
  3: { id: 3, positions: [{ name: 'MID', counters: [] }] }
};

function load(opts) {
  const o = opts || {};
  const nodes = {};
  const document = {
    getElementById(id) { return nodes[id] || (nodes[id] = { id, hidden: true, innerHTML: '' }); }
  };
  const win = {};
  const sandbox = {
    console, Date, Map, Set, Promise, JSON, Number, String, Array, Object, Math,
    escapeHtml, champNumMap, champImg: id => 'https://ddragon.leagueoflegends.com/cdn/14.1.1/img/champion/' + id + '.png',
    opggPosList, opggMap: o.opggMap || opggMap, document, window: win
  };
  if (o.lolAPI) sandbox.lolAPI = o.lolAPI;
  if (o.bpOverlayOn !== undefined) sandbox.bpOverlayOn = o.bpOverlayOn;
  if (o.gameflowPhase !== undefined) { sandbox._gameflowPhase = o.gameflowPhase; win._gameflowPhase = o.gameflowPhase; }
  const ctx = vm.createContext(sandbox);
  win.lolAPI = sandbox.lolAPI;
  vm.runInContext(src, ctx, { filename: 'bp-advisor.js' });
  return { ctx, nodes, api: win.PoroBPAdvisor };
}

const session = {
  localPlayerCellId: 2,
  myTeam: [{ cellId: 2, championId: 1, assignedPosition: 'MIDDLE' }],
  theirTeam: [{ cellId: 6, championId: 3, assignedPosition: 'MIDDLE' }],
  actions: [], bans: { myTeamBans: [], theirTeamBans: [] }
};

const pushes = [];
const lolAPI = {
  // 全量对位接口：两条样本，一条占优一条劣势
  getOpggCounters: async (id, pos) => ({ championId: id, position: pos, rows: [
    { championId: 2, play: 800, win: 460 },
    { championId: 3, play: 700, win: 300 }
  ] }),
  bpOverlayPin: (v) => Promise.resolve(!!v),
  bpOverlayUpdate: (p) => { pushes.push(p); return Promise.resolve(true); }
};

(async () => {
  // ---------- 1. 对位清单：方向不能反 ----------
  // 夹具里 map[1].counters = [{2, 60%}, {3, 40%}]，这两个百分比是**安妮自己**的胜率：
  // 打维克托 60% → 优势，打阿狸 40% → 打不过。反过来标就是 1.6.70 之前那个 bug。
  const { api } = load();
  const c = api.countersOf(1);
  assert.ok(c && c.good.length === 1 && c.bad.length === 1, '英雄 1 的对位应分成优势/劣势各一条');
  assert.strictEqual(c.good[0].id, 2, '60% 是我打维克托的胜率 → 优势对位');
  assert.strictEqual(Math.round(c.good[0].wr * 100), 60, '优势胜率应换算成 60%');
  assert.strictEqual(c.bad[0].id, 3, '40% → 打不过阿狸');
  assert.strictEqual(Math.round(c.bad[0].wr * 100), 40, '劣势胜率应换算成 40%');
  assert.strictEqual(api.countersOf(999), null, '没有 op.gg 数据的英雄应返回 null 而不是空壳');

  // 样本不够的不列（宁可少给，不拿小样本吹对位）
  const tiny = {
    9: { id: 9, positions: [{ name: 'MID', counters: [{ champion_id: 2, play: 10, win: 9 }] }] }
  };
  const tinyApi = load({ opggMap: tiny }).api;
  assert.strictEqual(tinyApi.countersOf(9), null, '样本 10 场不该进对位清单');

  // ---------- 2. 英雄数据页渲染（概要条 + 密集网格）----------
  const dataHtml = api.dataHtml(c, 1, 'mid', opggPosList[0].stats);
  assert.ok(dataHtml.includes('劣势对位') && dataHtml.includes('优势对位'), '两段标题都要在');
  assert.ok(dataHtml.includes('class="cell"'), '对位项应是密集网格单元');
  assert.ok(dataHtml.includes('class="grid"'), '单元要放在 flex 网格里');
  assert.ok(dataHtml.includes('40.00%') && dataHtml.includes('60.00%'), '两边胜率都要显示（两位小数）');
  assert.ok(dataHtml.includes('wr bad') && dataHtml.includes('wr good'), '颜色要区分优劣势');
  assert.ok(dataHtml.includes('hero-tier') && dataHtml.includes('hero-stats'), '概要条要有梯队与三项统计');
  assert.ok(dataHtml.includes('https://ddragon.leagueoflegends.com'), '头像要走 CDN（浮窗 CSP 已放行）');
  assert.strictEqual(api.dataHtml(null, 0, '', null), '', '没有英雄时整块不渲染');
  assert.ok(api.dataHtml(c, 1, 'mid', opggPosList[0].stats, true).includes('推断 · 中单'),
    '1.6.74: 无分路推出来的位置必须标注推断，不能冒充真实分路');

  // ---------- 3. 推送：正常态 ----------
  pushes.length = 0;
  const live = load({ lolAPI, bpOverlayOn: true, gameflowPhase: 'ChampSelect' });
  await live.api.refresh(session, true);
  assert.strictEqual(pushes.length, 1, '一次刷新应推一帧');
  const p0 = pushes[0];
  assert.strictEqual(p0.visible, true, '选人且开关打开时应可见');
  assert.strictEqual(p0.csLive, true, '实时选人事件推的帧要标 csLive');
  assert.strictEqual(p0.phase, 'ChampSelect', '要带上阶段，主进程用它做兜底门禁');
  assert.ok(p0.html.includes('BP 建议'), '推送内容应包含 BP 面板');
  assert.ok(p0.cnt.includes('劣势对位') && p0.cnt.includes('class="cell"'), '数据页应是概要条 + 对位网格');
  assert.ok(p0.cnt.includes('57.50%') && p0.cnt.includes('42.86%'), '数据页要带上对位胜率');
  assert.ok(p0.sub.includes('中单'), '副标题应写位置');

  // 同一会话重复刷新不重复推（去重由 stateKey 保证）
  await live.api.refresh(session, true);
  assert.strictEqual(pushes.length, 1, '相同会话不应重复推送');

  // ---------- 4. 推送：开关关掉 ----------
  pushes.length = 0;
  const off = load({ lolAPI, bpOverlayOn: false, gameflowPhase: 'ChampSelect' });
  await off.api.refresh(session, true);
  assert.strictEqual(pushes[0].visible, false, '开关关掉时只能推不可见，不能自己弹出来');

  // ---------- 5. 推送：离开选人 ----------
  pushes.length = 0;
  live.api.clear();
  assert.strictEqual(pushes.length, 1, 'clear 应推一帧空内容');
  assert.strictEqual(pushes[0].visible, false, '离开选人必须收起浮窗');
  assert.strictEqual(pushes[0].html, '', '收起时不应留内容');

  // 盲选/无分路模式：给一句说明，但浮窗仍可见（让玩家知道为什么没内容）
  pushes.length = 0;
  await live.api.refresh({ localPlayerCellId: 1, myTeam: [{ cellId: 1, championId: 5 }], theirTeam: [{ cellId: 6, championId: 3 }], bans: {} }, true);
  assert.ok(pushes.length === 1 && pushes[0].html.includes('盲选'), '无分路时要推说明文案');

  // 1.6.74/75: 训练模式 = 无分路 + 已选英雄 + gameflow phase 永远不到 ChampSelect。
  // BP 页保留原因，英雄数据页照常出；关键是实时帧要标 csLive 才能过主进程门禁。
  pushes.length = 0;
  const training = load({ lolAPI, bpOverlayOn: true, gameflowPhase: 'ReadyCheck' });
  const trainingSession = {
    localPlayerCellId: 1, myTeam: [{ cellId: 1, championId: 1 }],
    theirTeam: [], actions: [], bans: {}
  };
  await training.api.refresh(trainingSession, true);
  assert.strictEqual(pushes.length, 1, '训练模式应推一帧');
  assert.strictEqual(pushes[0].visible, true, '数据页有内容时浮窗应可见');
  assert.strictEqual(pushes[0].phase, 'ReadyCheck', '训练模式 phase 确实不是 ChampSelect');
  assert.strictEqual(pushes[0].csLive, true, '实时选人帧必须标 csLive，否则主进程会把窗挡掉');
  assert.strictEqual(pushes[0].inCs, true, '要告诉主进程会话确实在选人');
  assert.ok(pushes[0].html.includes('盲选'), 'BP 页仍要说明没有分路分配');
  assert.ok(pushes[0].cnt.includes('劣势对位') && pushes[0].cnt.includes('class="cell"'),
    '训练模式英雄数据页要照常出对位网格');
  assert.ok(pushes[0].cnt.includes('推断 · 中单'), '推断位置要在数据页显式标注');
  assert.ok(!pushes[0].sub.includes('中单'), '副标题不能把推断位置说成真实分路');

  // 1.5s tick 拿缓存会话重算时不能冒充实时帧，否则大厅里的旧会话会误弹窗
  pushes.length = 0;
  await training.api.refresh(trainingSession, false);
  assert.strictEqual(pushes[0].csLive, false, '缓存帧必须标 csLive=false');

  // ---------- 6. 浮窗页面本体 ----------
  const ovHtml = read('renderer/bp-overlay.html');
  assert.ok(/id="paneData"/.test(ovHtml) && /id="paneBp"/.test(ovHtml), '浮窗要有两个页签容器');
  assert.ok(/id="tabData"/.test(ovHtml) && /id="tabBp"/.test(ovHtml), '浮窗要有页签按钮');
  assert.ok(/id="pin"/.test(ovHtml), '标题栏要有图钉（切换始终置顶）');
  assert.ok(/id="hide"/.test(ovHtml), '浮窗要能收起');
  assert.ok(/js\/bp-overlay\.js/.test(ovHtml), '浮窗要引入自己的渲染脚本');
  assert.ok(/-webkit-app-region:\s*drag/.test(ovHtml), '标题栏要可拖动');
  // 密集网格的尺寸规格（照 Akari champion-data：46px 格 / 32px 头像 / 8px 间距）
  assert.ok(/\.cell\s*\{[^}]*width:\s*46px/.test(ovHtml), '对位格宽应为 46px');
  assert.ok(/\.cell img\s*\{[^}]*width:\s*32px/.test(ovHtml), '格内头像应为 32px');
  assert.ok(/\.grid\s*\{[^}]*gap:\s*8px/.test(ovHtml), '网格间距应为 8px');
  for (const cls of ['.bp-card', '.bp-tp-chip', '.cell', '.hero', '.bp-fusion', '.bpt-brief']) {
    assert.ok(ovHtml.includes(cls), '浮窗缺样式 ' + cls);
  }
  // CSP 必须放行 hero 头像，但不能再放开其它来源
  assert.ok(/img-src[^"]*https:\/\/ddragon\.leagueoflegends\.com/.test(ovHtml), 'CSP 应放行 ddragon 头像');
  assert.ok(!/img-src[^"]*\*/.test(ovHtml), 'CSP 不能通配图片来源');
  assert.ok(/default-src 'none'/.test(ovHtml), '浮窗默认什么都别加载');

  const ovJs = read('renderer/js/bp-overlay.js');
  assert.ok(/onBpOverlayData/.test(ovJs), '渲染脚本要订阅主进程推送');
  assert.ok(/bpOverlayHide/.test(ovJs), '渲染脚本要能收起');
  for (const bad of ['eval(', 'new Function', 'require(', 'innerHTML = html']) {
    // innerHTML 只允许贴主窗口算好的块，不允许在浮窗里再拼逻辑
    if (bad === 'innerHTML = html') continue;
    assert.ok(!ovJs.includes(bad), '浮窗脚本不应出现 ' + bad);
  }
  assert.ok(/bodyEl\.innerHTML = html/.test(ovJs) || /paneBp\.innerHTML = bp/.test(ovJs), '浮窗只负责把 HTML 贴进来');

  // ---------- 7. 主进程接线 ----------
  const mainSrc = read('main/index.js');
  assert.ok(mainSrc.includes("ipcMain.handle('bp-overlay:update'"), '主进程要有 bp-overlay:update');
  assert.ok(mainSrc.includes("ipcMain.handle('bp-overlay:status'"), '主进程要有 status');
  assert.ok(mainSrc.includes("ipcMain.handle('bp-overlay:hide'"), '主进程要有 hide');
  assert.ok(mainSrc.includes("ipcMain.handle('bp-overlay:pin'"), '主进程要有 pin（图钉切换置顶）');
  assert.ok(/width:\s*466,\s*height:\s*700/.test(mainSrc), '浮窗尺寸应为 466x700（照 Akari champion-data 的窗口比例）');
  assert.ok(/BP_HTML_MAX/.test(mainSrc), '推送内容要有长度上限');
  assert.ok(/win\.showInactive\(\)/.test(mainSrc), '显示浮窗不能抢客户端焦点');
  assert.ok(/setAlwaysOnTop\(bpOverlayPinned, 'screen-saver'\)/.test(mainSrc), '置顶要跟图钉状态绑定，并压过客户端层级');
  assert.ok(/lastReportedPhase === 'ChampSelect'/.test(mainSrc), '主进程要按阶段兜底门禁');
  assert.ok(mainSrc.includes("p.csLive === true") && mainSrc.includes('|| csLive)'),
    '1.6.75 主进程要用实时选人帧放行训练模式（phase 不到 ChampSelect）');
  assert.ok(/'bp-overlay:data'/.test(mainSrc), '要能把内容推给浮窗');
  assert.ok(/bp-overlay\.json/.test(mainSrc), '拖拽位置要落盘，下次沿用');

  const preload = read('main/preload.js');
  for (const api2 of ["invoke('bp-overlay:update'", "invoke('bp-overlay:status'", "invoke('bp-overlay:hide'", "'bp-overlay:data'"]) {
    assert.ok(preload.includes(api2), 'preload 缺 ' + api2);
  }

  // ---------- 8. 1.6.72 筛选条：四项控件 + 真能驱动重算 ----------
  for (const id of ['fRegion', 'fTier', 'fPos', 'fVer', 'fltNote']) {
    assert.ok(ovHtml.includes('id="' + id + '"'), '浮窗筛选条缺控件 ' + id);
  }
  const nOpts = v => (ovHtml.match(new RegExp('<option value="' + v + '"', 'g')) || []).length;
  assert.ok(ovJs.includes('bpOverlayFilter') && /\[fRegion, fTier, fPos\]/.test(ovJs),
    '三个真筛选下拉 change 后要把选择交给主进程');
  assert.ok(!/fVer\.addEventListener/.test(ovJs), '版本不可切换，不能给只读控件绑 change');
  assert.ok(/bpOverlayStatus/.test(ovJs), '浮窗重建时要恢复已保存的筛选');
  assert.ok(/version/.test(ovJs) && /filterNote/.test(ovJs), '要展示当前数据版本与筛选摘要');
  assert.ok(nOpts('gold_plus') === 1 && nOpts('challenger') === 1, '段位筛选要有完整档位');
  assert.ok(nOpts('auto') >= 2, '位置筛选要有自动项');

  const seenOpts = [];
  const benchCalls = [];
  let filterCb = null;
  const filterApi = {
    getOpggCounters: async (id, pos, opts) => {
      seenOpts.push({ id, pos, opts });
      return { championId: id, position: pos, rows: [
        { championId: 2, play: 800, win: 460 }, { championId: 3, play: 700, win: 300 }
      ] };
    },
    getOpggBench: async (tier, region) => {
      benchCalls.push({ tier, region });
      return { version: '16.23', champions: { '1': { MID: { winRate: 55.5, pickRate: 12.3, banRate: 4.5, rank: 8 } } } };
    },
    bpOverlayUpdate: (p) => { pushes.push(p); return Promise.resolve(true); },
    bpOverlayStatus: () => Promise.resolve({ filter: { region: 'kr', tier: 'all', position: 'auto', version: 'auto' } }),
    onBpFilterChanged: (cb) => { filterCb = cb; }
  };
  pushes.length = 0;
  const filtered = load({ lolAPI: filterApi, bpOverlayOn: true, gameflowPhase: 'ChampSelect' });
  await filtered.api.refresh(session, true);
  assert.strictEqual(JSON.stringify(seenOpts[0] && seenOpts[0].opts), JSON.stringify({ region: 'kr', tier: 'all' }),
    '默认口径仍是 KR/全部段位');
  assert.strictEqual(pushes[0].filters.region, 'kr', '推送要带筛选状态，浮窗才能恢复');
  assert.strictEqual(pushes[0].version, '16.23', '版本要从 bench 的 meta 带给浮窗');
  assert.ok(typeof filterCb === 'function', '主窗口要订阅筛选变更');

  // 改段位 + 地区 + 位置：必须重新取数、重算、重推，而不是只改下拉文字
  pushes.length = 0;
  filterCb({ region: 'global', tier: 'gold', position: 'top', version: 'auto' });
  await new Promise(r => setTimeout(r, 30));
  const changed = seenOpts.find(o => o.opts && o.opts.region === 'global' && o.opts.tier === 'gold');
  assert.ok(changed, '改筛选后必须按新地区/段位重新请求对位');
  assert.ok(seenOpts.some(o => o.pos === 'top'), '位置筛选应覆盖"自动跟随我的分路"');
  assert.ok(benchCalls.some(c => c.tier === 'gold' && c.region === 'global'), '概要条也要用新段位/地区的基准');
  assert.ok(pushes.length >= 1, '改筛选后要重新推一帧');
  const last = pushes[pushes.length - 1];
  assert.strictEqual(last.filters.tier, 'gold', '推送里的段位要更新');
  assert.strictEqual(last.filters.position, 'top', '推送里的位置要更新');
  assert.ok(last.cnt.includes('55.50%'), '概要条胜率要换成新段位的统计值');

  // 主进程：维度白名单、缓存分维、筛选落盘转发
  assert.ok(/BP_FILTER_TIERS/.test(mainSrc) && /BP_FILTER_REGIONS/.test(mainSrc), '主进程要有维度白名单');
  assert.ok(mainSrc.includes("ipcMain.handle('bp-overlay:filter'"), '主进程要接收浮窗筛选');
  assert.ok(/bp-overlay:filter-changed/.test(mainSrc), '筛选要转发给主窗口重算');
  assert.ok(/bp-overlay-filter\.json/.test(mainSrc), '筛选要落盘，重开后沿用');
  assert.ok(/filter: Object\.assign\(\{}, bpFilter\)/.test(mainSrc), 'status 要返回当前筛选');
  assert.ok(/region \+ '\|' \+ tier \+ '\|' \+ id/.test(mainSrc), '对位缓存键必须带地区与段位');
  assert.ok(mainSrc.includes("/api/' + region + '/champions/ranked/")
    && mainSrc.includes("'?tier=' + encodeURIComponent(tier)"), '对位请求要真的按地区/段位取数');
  const preload2 = read('main/preload.js');
  assert.ok(preload2.includes("invoke('bp-overlay:filter'") && preload2.includes("'bp-overlay:filter-changed'"),
    'preload 要暴露筛选提交与变更订阅');
  assert.ok(/getOpggCounters: \(championId, position, opts\)/.test(preload2), '对位接口要能传筛选参数');

  // ---------- 9. 页面下线与驱动 ----------
  const idx = read('renderer/index.html');
  assert.ok(!/data-page="counters"/.test(idx), '导航里的克制关系项应已移除');
  assert.ok(!/id="counterLayout"/.test(idx), '克制页容器应已移除');
  assert.ok(/id="bpOverlayToggle"/.test(idx), '工具箱要有开关');
  const benchSrc = read('renderer/js/bench.js');
  assert.ok(/bp\.refresh\(session, true\)/.test(benchSrc), '实时选人事件要驱动刷新并标 csLive');
  const hexSrc = read('renderer/js/hex.js');
  assert.ok(!/calcCounterData/.test(hexSrc), 'hex.js 里的旧克制实现应已删除（只留 bp-advisor 一份）');
  const liveSrc = read('renderer/js/live.js');
  assert.ok(/bpApi\.countersOf\(/.test(liveSrc), '选人克制提醒应改用 PoroBPAdvisor.countersOf');
  const evSrc = read('renderer/js/lcu-events.js');
  assert.ok(/PoroBPAdvisor\?\.clear\(\)/.test(evSrc), '离开选人要主动收起浮窗');

  console.log('选人助手浮窗测试通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
