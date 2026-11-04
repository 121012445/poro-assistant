'use strict';
// chat.js 对局聊天房间解析 (getGameChatCid / resetGameChatCid) 行为测试。
// 背景 (1.5.43): 选人房间的 cid 跨局残留 + 对局期继续认选人房间, 导致翻译
// 扫描/补发永远盯着一个进对局后全程无消息的死房间 —— 聊天不翻译。
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, 'renderer/js/chat.js'), 'utf8');

function makeEnv(opts = {}) {
  const convs = opts.convs || [];
  const ctx = {
    console, Promise, String, Array, Object, JSON, Number, Math,
    Date: { now: () => 1700000000000 },
    window: { _gameflowPhase: opts.phase || 'InProgress' },
    complianceOn: false,
    lolAPI: {
      lcuRequest: async (method, url) => {
        if (/\/conversations$/.test(url)) return convs;
        if (/gameflow\/v1\/session$/.test(url)) return opts.gameflow || {};
        return {};
      },
      debugLog: () => {}
    }
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return {
    get: n => vm.runInContext(n, ctx),
    set: (n, v) => vm.runInContext(`${n} = ${JSON.stringify(v)}`, ctx),
    run: f => vm.runInContext(f, ctx)
  };
}

(async () => {
  // 1) 对局期 + 缓存了选人房间 → 必须作废, 不能返回死房间
  {
    const e = makeEnv({ phase: 'InProgress', convs: [{ type: 'championSelect', id: 'cs@lol-champ-select.pvp.net' }] });
    e.set('_champSelectChatCid', 'cs@lol-champ-select.pvp.net');
    const cid = await e.run('getGameChatCid')();
    assert.ok(cid !== 'cs@lol-champ-select.pvp.net', '对局期不得返回选人房间, got ' + cid);
    assert.ok(!e.get('_champSelectChatCid'), '对局期选人缓存应被清空');
    assert.ok(!e.get('_gameChatCid') || !/@lol-champ-select/.test(e.get('_gameChatCid')), '_gameChatCid 不得是选人房间');
  }

  // 2) 对局期 + 会话列表里还挂着选人房间 → 也不能认它 (真房间不在时返回 null)
  {
    const e = makeEnv({ phase: 'InProgress', convs: [{ type: 'championSelect', id: 'cs@lol-champ-select.pvp.net' }] });
    const cid = await e.run('getGameChatCid')();
    assert.ok(cid !== 'cs@lol-champ-select.pvp.net', '对局期不得从列表认选人房间, got ' + cid);
  }

  // 3) 选人阶段: 选人房间仍是合法通道 (公告/发送要用)
  {
    const e = makeEnv({ phase: 'ChampSelect', convs: [{ type: 'championSelect', id: 'cs@lol-champ-select.pvp.net' }] });
    const cid = await e.run('getGameChatCid')();
    assert.strictEqual(cid, 'cs@lol-champ-select.pvp.net', '选人阶段应返回选人房间');
    assert.strictEqual(e.get('_gameChatCid'), 'cs@lol-champ-select.pvp.net', '选人阶段缓存保留');
  }

  // 4) resetGameChatCid 清掉跨局残留
  {
    const e = makeEnv({ phase: 'ChampSelect', convs: [{ type: 'championSelect', id: 'cs@lol-champ-select.pvp.net' }] });
    await e.run('getGameChatCid')();
    e.run('resetGameChatCid')();
    assert.ok(!e.get('_gameChatCid'), 'reset 清 _gameChatCid');
    assert.ok(!e.get('_champSelectChatCid'), 'reset 清 _champSelectChatCid');
  }

  // 5) 对局期 gameId 房间匹配仍可用 (真对局房间)
  {
    const e = makeEnv({ phase: 'InProgress', convs: [{ type: 'chat', id: 'abc-123@pvp.net' }], gameflow: { gameData: { gameId: 123 } } });
    const cid = await e.run('getGameChatCid')();
    assert.strictEqual(cid, 'abc-123@pvp.net', 'gameId 房间正常返回, got ' + cid);
  }

  // 6) 对局期残留上一局的 gameId 房间 → reset 后应重新解析, 不再返回旧房间
  {
    const e = makeEnv({ phase: 'InProgress', convs: [{ type: 'chat', id: 'new-456@pvp.net' }], gameflow: { gameData: { gameId: 456 } } });
    e.set('_gameChatCid', 'old-999@pvp.net');
    e.run('resetGameChatCid')();
    const cid = await e.run('getGameChatCid')();
    assert.strictEqual(cid, 'new-456@pvp.net', '跨局重置后应解析到新房间, got ' + cid);
  }

  console.log('chat cid 房间解析: 全部通过');
})().catch(e => { console.error('FAIL: ' + e.message); process.exit(1); });
