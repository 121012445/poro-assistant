'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const context = vm.createContext({ window: {}, Date, Set, String, Number, Math });
vm.runInContext(fs.readFileSync('renderer/js/session-state.js', 'utf8'), context);
const session = context.window.poroSession;

session.setAccount('account-a', 'HN1');
session.transition('ChampSelect');
session.setGame('game-1', 'a|b|c');
session.setChampion(81);
const first = session.token();
assert.strictEqual(session.isCurrent(first), true);
session.transition('GameStart');
assert.strictEqual(session.isCurrent(first), true, '同一局从选人到加载不得换代');
assert.strictEqual(session.snapshot().championId, 81, '加载阶段必须保留所选英雄');
session.transition('EndOfGame');
assert.strictEqual(session.isCurrent(first), false, '离开本局后旧异步令牌必须失效');
session.transition('ChampSelect');
session.setGame('game-2', 'd|e|f');
const second = session.token();
assert.notStrictEqual(second.generation, first.generation);
session.setAccount('account-b', 'NA1');
assert.strictEqual(session.isCurrent(second), false, '切换账号后旧请求必须失效');
assert.strictEqual(session.snapshot().gameId, '', '切换账号必须清空旧对局身份');

console.log('统一对局状态机测试通过');
