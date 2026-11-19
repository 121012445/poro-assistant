// 回归: 「一键卸下勋章」不能假装卸掉了头像框, 且必须能恢复。
// 背景(2026-11-20 实测): 客户端没有"不显示边框"这个状态 —— preferredCrestType 只接受 prestige,
// none/blank/default 全 400; selectedPrestigeCrest 写 22 在高等级号(2693)上显示为无框, 在低等级号
// (161)上变成另一款边框。原实现直接弹"已卸下勋章、头像框", 用户以为卸了其实是换了一款。
// 现在的约定: 首次卸下前按 puuid 备份原边框, 文案如实报告, 并提供 restoreRegalia() 还原。
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

const constMatch = src.match(/const REGALIA_BACKUP_PREFIX = '[^']*';/);
assert.ok(constMatch, '找不到 REGALIA_BACKUP_PREFIX');

const sandbox = {
  __store: {},
  __msgs: [],
  __puts: [],
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
      if (method === 'GET' && p.indexOf('/lol-regalia') === 0) return JSON.parse(JSON.stringify(sandbox.__reg));
      if (method === 'GET' && p === '/lol-chat/v1/me') return JSON.parse(JSON.stringify(sandbox.__me));
      if (method === 'PUT' && p.indexOf('/lol-regalia') === 0) {
        sandbox.__puts.push(JSON.parse(JSON.stringify(body)));
        if (body && body.selectedPrestigeCrest != null) sandbox.__reg.selectedPrestigeCrest = body.selectedPrestigeCrest;
        if (body && body.preferredCrestType) sandbox.__reg.preferredCrestType = body.preferredCrestType;
        return {};
      }
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
  constMatch[0],
  extractFn(src, 'regaliaBackupKey'),
  extractFn(src, 'readRegaliaBackup'),
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
  // ① 首次卸下: 备份原值 57, PUT 22
  ctx.__reg = newRegalia();
  await ctx.removeAllRegalia();
  const bkKey = 'regaliaBackup:puuid-1';
  assert.ok(ctx.__store[bkKey], '第一次卸下必须写入边框备份');
  const bk = ctx.readRegaliaBackup('puuid-1');
  assert.strictEqual(bk.selectedPrestigeCrest, 57, '备份里必须是卸下前的 57 档');
  assert.strictEqual(bk.preferredBannerType, 'blank', '备份要带 preferredBannerType');
  assert.strictEqual(ctx.__puts.length, 1, '只应发一次 regalia PUT');
  assert.strictEqual(ctx.__puts[0].selectedPrestigeCrest, 22, 'PUT 必须写 22 档');
  assert.strictEqual(ctx.__reg.selectedPrestigeCrest, 22, '模拟服务端应接受 22');
  assert.ok(/已清空勋章与挑战代币/.test(lastMsg()), '成功文案要先讲清勋章已清');
  assert.ok(/22 档/.test(lastMsg()), '文案要说明边框切到了 22 档, 不能笼统说"已卸下头像框"');
  assert.ok(!/已卸下勋章、头像框/.test(lastMsg()), '不能再出现"已卸下头像框"这种承诺');
  assert.ok(/恢复原头像框/.test(lastMsg()), '成功提示要告诉用户能恢复');

  // ② 二次卸下不能覆盖备份(此时 regalia 已是 22)
  await ctx.removeAllRegalia();
  assert.strictEqual(ctx.readRegaliaBackup('puuid-1').selectedPrestigeCrest, 57, '二次点击不能把备份改成 22');

  // ③ 恢复: 写回 57
  await ctx.restoreRegalia();
  assert.strictEqual(ctx.__puts[ctx.__puts.length - 1].selectedPrestigeCrest, 57, '恢复必须写回备份的 57 档');
  assert.strictEqual(ctx.__reg.selectedPrestigeCrest, 57, '读回应是 57');
  assert.ok(/已恢复原头像框/.test(lastMsg()), '恢复成功要有明确回执');

  // ④ 换账号: 各自的备份互不干扰
  ctx.__me = { puuid: 'puuid-2', lol: { bannerIdSelected: '1' } };
  ctx.__reg = newRegalia({ selectedPrestigeCrest: 8, summonerLevel: 161 });
  await ctx.removeAllRegalia();
  assert.strictEqual(ctx.readRegaliaBackup('puuid-2').selectedPrestigeCrest, 8, '新账号要单独备份自己的 8 档');
  assert.strictEqual(ctx.readRegaliaBackup('puuid-1').selectedPrestigeCrest, 57, '旧账号备份不能被新手覆盖');

  // ⑤ 没有备份就点恢复: 给出解释, 不发 PUT
  ctx.__me = { puuid: 'puuid-3', lol: {} };
  const before = ctx.__puts.length;
  await ctx.restoreRegalia();
  assert.strictEqual(ctx.__puts.length, before, '没有备份时不能乱写 regalia');
  assert.ok(/还没有边框备份/.test(lastMsg()), '没备份要说清楚为什么没动作');

  // ⑥ 读坏数据不能抛
  ctx.__store['regaliaBackup:broken'] = '{not json';
  assert.strictEqual(ctx.readRegaliaBackup('broken'), null, '备份是坏 JSON 时应返回 null 而不是崩');
  ctx.__store['regaliaBackup:broken'] = '{"selectedPrestigeCrest":"abc"}';
  assert.strictEqual(ctx.readRegaliaBackup('broken'), null, '备份缺合法档位时应返回 null');

  // ⑦ 合规模式/关闭写入时不动作
  ctx.__guard = false;
  const n = ctx.__puts.length;
  await ctx.removeAllRegalia();
  assert.strictEqual(ctx.__puts.length, n, 'guardWrite 拒绝时不能发请求');

  console.log('test_regalia_backup: 21 asserts passed');
})().catch((e) => { console.error(e); process.exit(1); });
