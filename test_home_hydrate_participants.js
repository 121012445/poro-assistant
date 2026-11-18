// 1.6.16 回归: 外服 LCU 列表接口每场只带自己 1 人, 详情接口才有完整 10 人。
// 实测(日服): /lol-match-history/v1/games/613483554 -> participants=10, identities=10,
// identities 全部带 puuid 且本人命中, stats 含 KDA/伤害/承伤/装备/win。
// 本测试锁定: 缺人对局按详情补齐、已满员不重复请求、limit 生效。
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const home = fs.readFileSync('renderer/js/home.js', 'utf8');

function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing fn ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;   // 保留 async 关键字
  let depth = 0, began = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') { depth++; began = true; }
    else if (src[i] === '}') { depth--; if (began && depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced fn ' + name);
}

// ---- 静态: 必须存在补全函数且在统一出口被调用 ----
assert.ok(home.includes('async function hydrateLcuParticipants'),
  '必须提供按详情接口补全 participants 的函数');
assert.ok(home.includes('hydrateLcuParticipants(games, 3)'),
  '统一出口应调用补全(限最近 3 场)');
assert.ok(home.indexOf('/lol-match-history/v1/games/') >= 0,
  '必须走 /lol-match-history/v1/games/<gid> 详情接口');

// ---- 动态: 补齐行为 ----
const calls = [];
const detail = {
  gameId: 1,
  participants: Array.from({ length: 10 }, (_, i) => ({ participantId: i + 1, teamId: i < 5 ? 100 : 200 })),
  participantIdentities: Array.from({ length: 10 }, (_, i) => ({ participantId: i + 1, player: { puuid: 'p' + i, gameName: 'n' + i } })),
};
const ctx = vm.createContext({
  lolAPI: {
    lcuRequest: async (m, p) => { calls.push(p); return detail; },
    debugLog: () => {},
  },
  normalizeGame: (d) => ({
    participants: (d.participants || []).map((p, i) => ({
      puuid: d.participantIdentities?.[i]?.player?.puuid || '', teamId: p.teamId,
    })),
    teamsObj: {},
  }),
});
vm.runInContext(extractFn(home, 'hydrateLcuParticipants'), ctx);
const hydrate = ctx.hydrateLcuParticipants;

(async () => {
  // A. 单人局 -> 补到 10 人
  const solo = [{ gid: 11, participants: [{ puuid: 'me', teamId: 100 }] }];
  const changed = await hydrate(solo, 3);
  assert.strictEqual(changed, true, '缺人时必须补全并返回 true');
  assert.strictEqual(solo[0].participants.length, 10, '补全后应有 10 个参与者');
  assert.strictEqual(solo[0].participants[0].puuid, 'p0', '补全数据应来自详情接口');
  assert.strictEqual(calls.length, 1, '单人局应只发 1 次详情请求');

  // B. 已满员 -> 不发请求
  calls.length = 0;
  const full = [{ gid: 12, participants: Array.from({ length: 10 }, (_, i) => ({ puuid: 'q' + i })) }];
  const changed2 = await hydrate(full, 3);
  assert.strictEqual(changed2, false, '已满员不应改动');
  assert.strictEqual(calls.length, 0, '已满员不得发详情请求');

  // C. limit 生效: 5 个缺人对局, limit=2 -> 只拉 2 个
  calls.length = 0;
  const many = Array.from({ length: 5 }, (_, i) => ({ gid: 100 + i, participants: [{ puuid: 'me' }] }));
  await hydrate(many, 2);
  assert.strictEqual(calls.length, 2, 'limit=2 时只应对前 2 场发请求');
  assert.strictEqual(many[0].participants.length, 10, '前 2 场应被补全');
  assert.strictEqual(many[4].participants.length, 1, '超出 limit 的场次保持原样');

  // D. 无 lolAPI 时安全早退
  const ctx2 = vm.createContext({});
  vm.runInContext(extractFn(home, 'hydrateLcuParticipants'), ctx2);
  assert.strictEqual(await ctx2.hydrateLcuParticipants([{ gid: 1, participants: [] }], 3), false,
    '无 lolAPI 时必须安全返回 false, 不抛异常');

  console.log('OK test_home_hydrate_participants: 详情补全 10 人 + 满员不请求 + limit + 无 API 安全');
})();
