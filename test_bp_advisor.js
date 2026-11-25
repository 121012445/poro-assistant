'use strict';
// renderer/js/bp-advisor.js: 选人阶段按敌方已亮英雄的对位胜率给 pick/ban 建议。
// 这个测试全部用合成数据 —— 不依赖 LCU、不依赖 op.gg 网络, 只验算分与渲染规则。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const src = read('renderer/js/bp-advisor.js');
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CHAMPS = {
  1: { id: 'Annie', name: '安妮' },
  2: { id: 'Viktor', name: '维克托' },
  3: { id: 'Ahri', name: '阿狸' },
  4: { id: 'Garen', name: '盖伦' },
  5: { id: 'Zed', name: '劫' }
};
const champNumMap = Object.assign({}, CHAMPS);

const statsOf = (wr, play) => ({ win_rate: wr, play, pick_rate: 0.05, ban_rate: 0.1, tier_data: { tier: 2 } });
const opggPosList = [
  { championId: 1, positionKey: 'MID', position: '中单', stats: statsOf(0.50, 5000) },
  { championId: 2, positionKey: 'MID', position: '中单', stats: statsOf(0.50, 5000) },
  { championId: 4, positionKey: 'MID', position: '中单', stats: statsOf(0.50, 5000) },
  { championId: 5, positionKey: 'MID', position: '中单', stats: statsOf(0.52, 5000) },
  // 上单池: 用来验证位置过滤不会把上单英雄混进中单候选
  { championId: 4, positionKey: 'TOP', position: '上单', stats: statsOf(0.54, 8000) }
];
const opggMap = {
  3: { id: 3, positions: [{ name: 'MID' }] },
  4: { id: 4, positions: [{ name: 'TOP' }] },
  6: { id: 6, positions: [{ name: 'JUNGLE' }] }
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
    escapeHtml, champNumMap, champImg: id => '/img/' + id + '.png',
    opggPosList, opggMap, document, window: win
  };
  if (o.lolAPI) sandbox.lolAPI = o.lolAPI;
  const ctx = vm.createContext(sandbox);
  win.lolAPI = sandbox.lolAPI;
  vm.runInContext(src, ctx, { filename: 'bp-advisor.js' });
  return { ctx, nodes, api: win.PoroBPAdvisor };
}

const baseState = extra => Object.assign({
  inChampSelect: true,
  myPosition: 'mid',
  myChampionId: 0,
  myIntentId: 0,
  enemy: [{ id: 3, pos: 'mid', guessed: false }],
  ally: [],
  unavailable: new Set(),
  bannedMy: [],
  bannedTheir: [],
  myAction: 'pick'
}, extra || {});

const byId = (rows, id) => rows.find(r => r.id === id);
const num = (v, d) => Number(v.toFixed(d == null ? 2 : d));

(() => {
  // ---------- 1. 会话解析 ----------
  const { api } = load();

  const empty = api.readSession(null);
  assert.strictEqual(empty.inChampSelect, false, '空会话应判为不在选人阶段');
  // 跨 vm realm 的数组原型不同, deepStrictEqual 会误报, 比较长度与内容
  assert.strictEqual(empty.enemy.length, 0, '空会话不应有敌方英雄');

  const session = {
    localPlayerCellId: 2,
    myTeam: [
      { cellId: 1, championId: 4, assignedPosition: 'TOP' },
      { cellId: 2, championId: 0, championPickIntent: 1, assignedPosition: 'MIDDLE' }
    ],
    theirTeam: [
      { cellId: 6, championId: 3, assignedPosition: 'MIDDLE' },
      { cellId: 7, championId: 0, assignedPosition: 'TOP' }
    ],
    actions: [
      [{ actorCellId: 6, type: 'ban', championId: 5, completed: true }]
    ],
    bans: { myTeamBans: [2], theirTeamBans: [] }
  };
  const st = api.readSession(session);
  assert.strictEqual(st.inChampSelect, true, '有队伍数据应判为选人阶段');
  assert.strictEqual(st.myPosition, 'mid', 'MIDDLE 应映射到 mid');
  assert.strictEqual(st.myIntentId, 1, '应读到预选英雄');
  assert.strictEqual(st.enemy.length, 1, '敌方已亮英雄只算真正有英雄的');
  assert.strictEqual(st.enemy[0].pos, 'mid', '敌方位置应取 assignedPosition');
  for (const id of [4, 1, 3, 5, 2]) {
    assert.ok(st.unavailable.has(id), '已选/预选/被 ban 的 ' + id + ' 应进候选排除集');
  }
  assert.strictEqual(st.myAction, '', '未轮到我时不应标记动作');

  // 对面 hover（in-progress pick 填了英雄）也要算"已亮"
  const hovering = api.readSession({
    localPlayerCellId: 2,
    myTeam: [{ cellId: 2, championId: 0, assignedPosition: 'MIDDLE' }],
    theirTeam: [{ cellId: 6, championId: 0, assignedPosition: 'MIDDLE' }],
    actions: [[{ actorCellId: 6, type: 'pick', championId: 3, isInProgress: true }]],
    bans: { myTeamBans: [], theirTeamBans: [] }
  });
  assert.strictEqual(hovering.enemy.length, 1, '对面正在 hover 的英雄应参与对位计算');
  assert.strictEqual(hovering.enemy[0].id, 3, 'hover 英雄 ID 应正确');

  // 没有 assignedPosition 时用 op.gg 主玩位置推断, 并标记 guessed
  const guessed = api.readSession({
    localPlayerCellId: 2,
    myTeam: [{ cellId: 2, championId: 0, assignedPosition: 'MIDDLE' }],
    theirTeam: [{ cellId: 6, championId: 6 }],
    actions: [], bans: { myTeamBans: [], theirTeamBans: [] }
  });
  assert.strictEqual(guessed.enemy[0].pos, 'jungle', '缺位置时应退回 op.gg 主玩位置');
  assert.strictEqual(guessed.enemy[0].guessed, true, '推断出来的位置要标记 guessed');

  // ---------- 2. 候选池只取我的位置 ----------
  const pool = api.poolFor('mid');
  assert.strictEqual(pool.map(c => c.id).sort((a, b) => a - b).join(','), '1,2,4,5', '中单池应为 4 个英雄');
  assert.strictEqual(api.poolFor('top').length, 1, '上单池只应有 1 个英雄');
  assert.strictEqual(api.poolFor('support').length, 0, '无数据位置应返回空池');

  // ---------- 3. 打分: 对位优势优先 ----------
  const tables = { '3:mid': { '2': { play: 800, wr: 0.56 }, '4': { play: 800, wr: 0.44 } } };
  const picks = api.recommend(baseState(), tables);
  assert.strictEqual(picks.length, 4, '候选应为 4 个');
  assert.strictEqual(picks[0].id, 2, '打阿狸 56% 的维克托应排第一');
  assert.strictEqual(num(picks[0].score), 6, '对位 +6% × 权重 1 = 6 分');
  assert.strictEqual(picks[picks.length - 1].id, 4, '被阿狸克制(44%)的盖伦应垫底');
  assert.strictEqual(num(byId(picks, 4).score), -6, '对位 -6% 应为 -6 分');
  assert.strictEqual(num(byId(picks, 1).score), 0, '无对位数据时只剩自身强度项');
  assert.strictEqual(byId(picks, 1).missing, 1, '无对位数据的英雄要记 missing');

  // ---------- 4. 同位置权重 > 跨位置 ----------
  const laneScore = byId(api.recommend(baseState(), { '3:mid': { '2': { play: 800, wr: 0.56 } } }), 2).score;
  const offScore = byId(api.recommend(baseState({ enemy: [{ id: 4, pos: 'top', guessed: false }] }),
    { '4:top': { '2': { play: 800, wr: 0.56 } } }), 2).score;
  assert.ok(laneScore > offScore, '同位置对位权重应高于跨位置');
  assert.strictEqual(num(laneScore), 6, '同位置: +6 × 1.0');
  assert.strictEqual(num(offScore), 2.1, '跨位置: +6 × 0.35');

  // ---------- 5. 小样本不计分 ----------
  const tiny = api.recommend(baseState(), { '3:mid': { '2': { play: 30, wr: 0.90 } } });
  const viktor = byId(tiny, 2);
  assert.strictEqual(viktor.edges.length, 0, '30 场对位(<50)不应计入');
  assert.strictEqual(viktor.missing, 1, '被丢弃的小样本要记 missing');
  assert.strictEqual(num(viktor.score), 0, '小样本不能把 90% 折进分数');

  // ---------- 6. 排除已 ban / 已选 ----------
  const blocked = api.recommend(baseState({ unavailable: new Set([2, 5]) }), tables);
  assert.ok(!blocked.some(r => r.id === 2 || r.id === 5), '已 ban/已选的英雄不应出现在推荐里');

  // ---------- 7. ban 建议: 优先 ban 克制我的 ----------
  const myBans = api.recommendBans(baseState({ myChampionId: 4 }), {
    '4:mid': { '2': { play: 900, wr: 0.57 }, '1': { play: 600, wr: 0.53 }, '5': { play: 80, wr: 0.56 } }
  });
  assert.strictEqual(myBans[0].id, 2, '最克制我的(57%)应排第一');
  assert.strictEqual(myBans[0].basis, 'counter', '已选英雄时的 ban 依据应是 counter');
  assert.ok(myBans.every(b => b.delta > 0), '只应推荐确实克制我的英雄');
  assert.strictEqual(myBans.length, 3, '最多 3 条');
  assert.strictEqual(myBans[1].id, 1, '第二位是 53% 的安妮, 而不是样本只有 80 的劫');
  assert.strictEqual(myBans[2].id, 5, '小样本的劫应排在最后');

  // 已选英雄被 ban 掉的对位不应再推荐
  const myBansBlocked = api.recommendBans(baseState({ myChampionId: 4, unavailable: new Set([2]) }), {
    '4:mid': { '2': { play: 900, wr: 0.57 }, '1': { play: 600, wr: 0.53 } }
  });
  assert.ok(!myBansBlocked.some(b => b.id === 2), '已经被 ban 掉的英雄不应再进 ban 建议');

  // ---------- 8. ban 建议: 还没选就退化成版本强势 ----------
  const metaBans = api.recommendBans(baseState(), {});
  assert.ok(metaBans.every(b => b.basis === 'meta'), '未选英雄时 ban 依据应是 meta');
  assert.strictEqual(metaBans[0].id, 5, '胜率+ban 率最高的劫应排第一');
  assert.strictEqual(metaBans.length, 3, '最多 3 条');

  // ---------- 9. 渲染 ----------
  const html = api.buildHtml(baseState(), picks, myBans);
  assert.ok(html.includes('BP 建议'), '面板应有标题');
  assert.ok(html.includes('推荐 Pick') && html.includes('推荐 Ban'), '应有两栏标题');
  assert.ok(html.includes('维克托') && html.includes('阿狸'), '应出现英雄名');
  assert.ok(html.includes('+6.0'), '分数应带符号显示');
  assert.ok(html.includes('你的位置：中单'), '应显示我的位置');
  assert.ok(html.includes('不替你点'), '脚注要说明只做建议');
  assert.ok(html.includes('/img/Viktor.png'), '应带英雄头像');

  // 英雄名进 HTML 必须转义 (国服部分称号带特殊字符)
  const evil = load();
  evil.ctx.champNumMap[9] = { id: 'Evil', name: '<img onerror=alert(1)>' };
  const evilHtml = evil.api.cardHtml({ id: 9, score: 1, base: 0.5, edges: [], missing: 0 }, 'pick');
  assert.ok(!evilHtml.includes('<img onerror'), '英雄名必须转义, 不能直接拼进 HTML');
  assert.ok(evilHtml.includes('&lt;img'), '转义后应保留为文本');

  // 无数据时的空态
  const emptyHtml = api.buildHtml(baseState(), [], []);
  assert.ok(emptyHtml.includes('没有可推荐的英雄'), '空候选要有明确空态');
  assert.ok(emptyHtml.includes('暂无 ban 建议'), '空 ban 要有明确空态');

  // ---------- 10. refresh 全链路 (mock LCU 数据源) ----------
  const calls = [];
  const lc = load({
    lolAPI: {
      getOpggCounters: async (id, pos) => {
        calls.push(id + ':' + pos);
        if (id === 3) return { championId: 3, position: pos, rows: [{ championId: 2, play: 800, win: 448 }, { championId: 4, play: 800, win: 352 }] };
        if (id === 4) return { championId: 4, position: pos, rows: [{ championId: 2, play: 900, win: 513 }] };
        return { __error: 'HTTP 500' };
      }
    }
  });
  // 只亮对面中单, 我方还没选 —— 这是 BP 建议最该起作用的时刻
  const refreshSession = {
    localPlayerCellId: 2,
    myTeam: [{ cellId: 2, championId: 0, assignedPosition: 'MIDDLE' }],
    theirTeam: [{ cellId: 6, championId: 3, assignedPosition: 'MIDDLE' }],
    actions: [], bans: { myTeamBans: [], theirTeamBans: [] }
  };
  const box = lc.nodes.bpAdvisor || lc.ctx.document.getElementById('bpAdvisor');
  const body = lc.ctx.document.getElementById('bpAdvisorBody');
  assert.strictEqual(box.hidden, true, '初始应隐藏');

  Promise.resolve()
    .then(() => lc.api.refresh(refreshSession))
    .then(() => {
      assert.strictEqual(box.hidden, false, '选人阶段应显示面板');
      assert.ok(body.innerHTML.includes('BP 建议'), '应渲染出面板内容');
      assert.ok(body.innerHTML.includes('维克托'), '应按敌方的阿狸推荐出维克托');
      assert.ok(calls.includes('3:mid'), '应请求敌方英雄的对位表');
      // 同一会话重复刷新不应重复请求
      const before = calls.length;
      return lc.api.refresh(refreshSession).then(() => {
        assert.strictEqual(calls.length, before, '相同会话不应重复拉对位表');
        return null;
      });
    })
    .then(() => {
      // 离开选人阶段 → 面板收起
      return lc.api.refresh(null).then(() => {
        assert.strictEqual(box.hidden, true, '离开选人阶段应隐藏面板');
      });
    })
    .then(() => {
      // 没有分路 (盲选/大乱斗) → 给出说明而不是空白
      return lc.api.refresh({ localPlayerCellId: 1, myTeam: [{ cellId: 1, championId: 5 }], theirTeam: [{ cellId: 6, championId: 3 }], bans: {} })
        .then(() => {
          assert.strictEqual(box.hidden, false, '无分路时也应有说明');
          assert.ok(body.innerHTML.includes('BP 建议只在有选位环节的模式里可用'), '无分路应说明原因');
        });
    })
    .then(() => {
      // ---------- 11. 只读: 一个写客户端的调用都不能有 ----------
      const lower = src;
      for (const bad of ['lcuRequest', "'PATCH'", '"PATCH"', '/complete', 'doAutoBP']) {
        assert.ok(!lower.includes(bad), 'BP 建议必须只读, 不应出现 ' + bad);
      }
      // ---------- 12. 接线 ----------
      // 1.6.70: 克制页下线, 驱动器从 hex.js 挪到 bench.js 的选人 tick
      const bench = read('renderer/js/bench.js');
      assert.ok(/bp\.refresh\(session\)/.test(bench), '选人 tick 里应刷新 BP 建议');
      assert.ok(!/page-counters/.test(bench), 'bench.js 不应再依赖已下线的克制页');
      const idx = read('renderer/index.html');
      assert.ok(/<script src="js\/bp-advisor\.js\?v=\d+"><\/script>/.test(idx), 'index.html 应引入 bp-advisor.js');
      assert.ok(!/id="page-counters"/.test(idx), '1.6.70 起软件内不再有克制关系页');
      assert.ok(/id="bpOverlayToggle"/.test(idx), '工具箱应有选人助手浮窗开关');
      // 浮窗页面自身必须带着面板骨架与自己的渲染脚本
      const ov = read('renderer/bp-overlay.html');
      assert.ok(/id="paneBp"/.test(ov) && /js\/bp-overlay\.js/.test(ov), '浮窗页应有内容容器与脚本');
      assert.ok(/img-src[^"]*ddragon\.leagueoflegends\.com/.test(ov), '浮窗 CSP 必须放行英雄头像 CDN');
      const css = read('renderer/css/v4.css');
      for (const cls of ['.bp-card', '.bp-score', '.bp-why', '.bp-foot']) {
        assert.ok(css.includes(cls), '缺少样式 ' + cls);
      }
      const preload = read('main/preload.js');
      assert.ok(preload.includes("invoke('opgg:counters'"), 'preload 应暴露对位接口');
      assert.ok(preload.includes("invoke('bp-overlay:update'"), 'preload 应暴露浮窗推送接口');
      const mainSrc = read('main/index.js');
      assert.ok(mainSrc.includes("ipcMain.handle('opgg:counters'"), '主进程应有 opgg:counters handler');
      assert.ok(/counters'\)/.test(mainSrc) || mainSrc.includes('/counters'), '主进程应请求对位接口');
      assert.ok(mainSrc.includes("ipcMain.handle('bp-overlay:update'"), '主进程应有浮窗推送 handler');
      console.log('BP 对位建议测试通过');
    })
    .catch(e => { console.error(e); process.exitCode = 1; });
})();
