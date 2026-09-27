'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const context = vm.createContext({ Date, Set, Map, String, Number, Object, Array });
vm.runInContext(fs.readFileSync('renderer/js/utils.js', 'utf8'), context);

context.players = [
  { puuid: 'a', teamId: 100, partyId: 'party-blue' },
  { puuid: 'b', teamId: 100, partyId: 'party-blue' },
  { puuid: 'c', teamId: 100 },
  { puuid: 'x', teamId: 200, partyId: 'party-blue' },
  { puuid: 'y', teamId: 200 }
];
context.profiles = [
  { teamGames: [
    { id: '1', players: ['x', 'y'] },
    { id: '2', players: ['x', 'y'] },
    { id: '3', players: ['x', 'y'] }
  ] }
];
const result = JSON.parse(vm.runInContext('JSON.stringify(resolveMatchPremadeGroups(players, profiles, 3))', context));
assert.strictEqual(result.groups.a, result.groups.b, '相同队伍和相同 partyId 应归为官方组队');
assert.strictEqual(result.sources.a, 'official');
assert.notStrictEqual(result.groups.a, result.groups.x, '相同 partyId 不得跨队合并');
assert.strictEqual(result.groups.x, result.groups.y, '近期至少三场同队应形成推测组队');
assert.strictEqual(result.sources.x, 'inferred');

context.weakProfiles = [{ teamGames: [{ id: '1', players: ['c', 'b'] }, { id: '2', players: ['c', 'b'] }] }];
const weak = JSON.parse(vm.runInContext('JSON.stringify(resolveMatchPremadeGroups(players, weakProfiles, 3))', context));
assert.strictEqual(weak.groups.c, undefined, '只有两场共同对局时不得误报组队');

const home = fs.readFileSync('renderer/js/home.js', 'utf8');
const hex = fs.readFileSync('renderer/js/hex.js', 'utf8');
assert.ok(home.includes('recentProfileFor(platformId, player.puuid, 30)'), '详情页应后台读取近期共同对局');
assert.ok(hex.includes('ak-party-slot'), '详情玩家行应预留组队徽标');
assert.ok(hex.includes('推测组队：近 30 场至少'), '推断关系必须明确说明并非官方确认');

console.log('战绩详情组队关系测试通过');
