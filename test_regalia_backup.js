// 回归: 卸载头像框必须按等级门槛拦截, 不能"点了卸下结果自己换成另一款"。
// 背景(2026-11-20 实测 + 对照 LeagueAkari 源码):
//   Akari 里 MINIMUM_SUMMONER_LEVEL_FOR_PRESTIGE_CREST = 525, 等级不够时文案直接标
//   "召唤师等级需大于等于 525"。本机实测印证: 2693 级写 22 边框消失, 161 级写 22 变成另一款边框。
//   原实现没有门槛, 任何等级都写 22, 于是 161 级账号看到"边框自己换了"。
// 现在的约定: 低于 525 级直接拒绝(不写 regalia), 勋章/挑战代币独立于等级, 首次卸下前备份原边框。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'renderer', 'js', 'compliance.js');
const src = fs.readFileSync(SRC, 'utf8');

function extractFn(source, name) {
  let start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing fn ' + name);
  const asyncIdx = source.lastIndexOf('async ', start);
  if (asyncIdx >= 0 && start - asyncIdx === 6) start = asyncIdx;
  let depth = 0, began = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') { depth++; began = true; }
    else if (source[i] === '}') { depth--; if (began && depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const prefixMatch = src.match(/const REGALIA_BACKUP_PREFIX = '[^']*';/);
const fixedMatch = src.match(/const FIXED_PRESTIGE_CREST = \d+;/);
const levelMatch = src.match(/const MINIMUM_SUMMONER_LEVEL_FOR_PRESTIGE_CREST = \d+;/);
assert.ok(prefixMatch && fixedMatch && levelMatch, '找不到 regalia 相关常量');
assert.ok(levelMatch[0].includes('525'), '等级门槛必须是 525(对齐 LeagueAkari)');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); n++; };

const sandbox = {
  __store: {},
  __msgs: [],
  __puts: [],
  __posts: [],
  __reg: null,
  __me: { puuid: 'puuid-1', lol: { bannerIdSelected: '1' } },
  __guard: true,
  console,
  JSON,
  Number,
  Date,
  setTimeout: (fn) => global.setTimeout(fn, 0),
  lolAPI: {
    lcuRequest: async (method, p, body) => {
      if (method === 'GET' && p.indexOf('/lol-regalia') === 0) {
        return sandbox.__reg ? JSON.parse(JSON.stringify(sandbox.__reg)) : { __error: 'no client' };
      }
      if (method === 'GET' && p === '/lol-chat/v1/me') return JSON.parse(JSON.stringify(sandbox.__me));
      if (method === 'PUT' && p.indexOf('/lol-regalia') === 0) {
        sandbox.__puts.push(JSON.parse(JSON.stringify(body)));
        if (body && body.selectedPrestigeCrest != null) sandbox.__reg.selectedPrestigeCrest = body.selectedPrestigeCrest;
        if (body && body.preferredCrestType) sandbox.__reg.preferredCrestType = body.preferredCrestType;
        return {};
      }
      if (method === 'POST') { sandbox.__posts.push({ p, body }); return {}; }
      return {};
    }
  },
  guardWrite: () => sandbox.__guard,
  toolMsg: (h) => { sandbox.__msgs.push(String(h)); },
  storeGet: (k) => (sandbox.__store[k] === undefined ? null : sandbox.__store[k]),
  storeSet: (k, v) => { sandbox.__store[k] = String(v); }
};

vm.createContext(sandbox);
vm.runInContext([
  prefixMatch[0],
  fixedMatch[0],
  levelMatch[0],
  extractFn(src, 'regaliaBackupKey'),
  extractFn(src, 'readRegaliaBackup'),
  extractFn(src, 'readRegaliaState'),
  extractFn(src, 'readRegaliaAccount'),
  extractFn(src, 'regaliaLine'),
  extractFn(src, 'doRemovePrestigeCrest'),
  extractFn(src, 'doRemoveChallengeTokens'),
  extractFn(src, 'removePrestigeCrest'),
  extractFn(src, 'removeChallengeTokens'),
  extractFn(src, 'removeAllRegalia'),
  extractFn(src, 'restoreRegalia')
].join('\n\n'), sandbox);

const ctx = sandbox;
const lastMsg = () => ctx.__msgs[ctx.__msgs.length - 1] || '';

function newRegalia(over) {
  return Object.assign({
    bannerType: 'blank',
    crestType: 'prestige',
    preferredBannerType: 'blank',
    preferredCrestType: 'prestige',
    selectedPrestigeCrest: 57,   // 用户原本的边框档位(不是 22)
    summonerLevel: 2693
  }, over || {});
}

(async () => {
  // ① 2693 级: 备份 57, PUT 22
  ctx.__reg = newRegalia();
  await ctx.removeAllRegalia();
  const bkKey = 'regaliaBackup:puuid-1';
  ok(!!ctx.__store[bkKey], '第一次卸下必须写入边框备份');
  const bk = ctx.readRegaliaBackup('puuid-1');
  eq(bk.selectedPrestigeCrest, 57, '备份里必须是卸下前的 57 档');
  eq(bk.preferredBannerType, 'blank', '备份要带 preferredBannerType');
  eq(ctx.__puts.length, 1, '只应发一次 regalia PUT');
  eq(ctx.__puts[0].selectedPrestigeCrest, 22, 'PUT 必须写 22 档');
  ok(/头像框已卸下/.test(lastMsg()), '成功时要明确说头像框已卸下');
  ok(/已清空勋章与挑战代币/.test(lastMsg()), '勋章那半也要有明确回执');
  ok(!/已卸下勋章、头像框与旗帜代币/.test(lastMsg()), '不能再出现旧的笼统承诺文案');

  // ② 二次点击不覆盖备份
  await ctx.removeAllRegalia();
  eq(ctx.readRegaliaBackup('puuid-1').selectedPrestigeCrest, 57, '二次点击不能把备份改成 22');

  // ③ 恢复写回 57
  await ctx.restoreRegalia();
  eq(ctx.__puts[ctx.__puts.length - 1].selectedPrestigeCrest, 57, '恢复必须写回备份的 57 档');
  eq(ctx.__reg.selectedPrestigeCrest, 57, '读回应是 57');
  ok(/已恢复原头像框/.test(lastMsg()), '恢复成功要有明确回执');

  // ④ 低等级账号(161): 不写 regalia, 只清勋章, 并说清原因
  ctx.__me = { puuid: 'puuid-low', lol: { bannerIdSelected: '1' } };
  ctx.__reg = newRegalia({ selectedPrestigeCrest: 3, summonerLevel: 161 });
  const putsBefore = ctx.__puts.length;
  await ctx.removeAllRegalia();
  eq(ctx.__puts.length, putsBefore, '等级不足 525 时绝不能写 regalia');
  ok(!ctx.__store['regaliaBackup:puuid-low'], '被拦下时不该留下半截备份');
  ok(/低于 525/.test(lastMsg()), '要说明是等级不足导致跳过');
  ok(/已清空勋章与挑战代币/.test(lastMsg()), '勋章那半仍应执行成功');

  // ⑤ 单独点「卸下头像框」在低等级下同样被挡
  {
    const before = ctx.__puts.length;
    await ctx.removePrestigeCrest();
    eq(ctx.__puts.length, before, '单独卸头像框也要挡等级');
    ok(/低于 525/.test(lastMsg()), '单独入口也要给出同样的解释');
  }

  // ⑥ 换账号(600 级): 各自备份互不干扰
  ctx.__me = { puuid: 'puuid-2', lol: { bannerIdSelected: '1' } };
  ctx.__reg = newRegalia({ selectedPrestigeCrest: 8, summonerLevel: 600 });
  await ctx.removePrestigeCrest();
  eq(ctx.readRegaliaBackup('puuid-2').selectedPrestigeCrest, 8, '新账号要单独备份自己的 8 档');
  eq(ctx.readRegaliaBackup('puuid-1').selectedPrestigeCrest, 57, '旧账号备份不能被新号覆盖');

  // ⑦ 没有备份就点恢复: 说明原因, 不发 PUT
  ctx.__me = { puuid: 'puuid-3', lol: {} };
  const beforeRestore = ctx.__puts.length;
  await ctx.restoreRegalia();
  eq(ctx.__puts.length, beforeRestore, '没有备份时不能乱写 regalia');
  ok(/还没有边框备份/.test(lastMsg()), '没备份要说清楚为什么没动作');

  // ⑧ 坏备份数据不能抛
  ctx.__store['regaliaBackup:broken'] = '{not json';
  eq(ctx.readRegaliaBackup('broken'), null, '坏 JSON 应返回 null');
  ctx.__store['regaliaBackup:broken'] = '{"selectedPrestigeCrest":"abc"}';
  eq(ctx.readRegaliaBackup('broken'), null, '缺合法档位应返回 null');

  // ⑨ 客户端没连上: 边框动作要报错而不是静默
  ctx.__reg = null;
  await ctx.removePrestigeCrest();
  ok(/读不到头像框状态/.test(lastMsg()), '没有客户端时要说明读不到状态');

  // ⑩ guardWrite 拒绝时不发请求
  ctx.__guard = false;
  ctx.__reg = newRegalia();
  const g = ctx.__puts.length;
  await ctx.removeAllRegalia();
  eq(ctx.__puts.length, g, 'guardWrite 拒绝时不能发请求');

  console.log('test_regalia_backup: ' + n + ' asserts passed');
})().catch((e) => { console.error(e); process.exit(1); });
