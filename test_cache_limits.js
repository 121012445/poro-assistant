'use strict';
// 渲染层按玩家累积的 Map 缓存要有上限 (utils.js limitMapSize + live.js / hex.js 的接线)。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const utils = fs.readFileSync('renderer/js/utils.js', 'utf8').replace(/\r\n/g, '\n');
const start = utils.indexOf('function limitMapSize(');
assert.ok(start >= 0, 'utils.js 应定义 limitMapSize');
const ctx = vm.createContext({ Map });
vm.runInContext(utils.slice(start, utils.indexOf('\n}\n', start) + 3), ctx);
const { limitMapSize } = ctx;

const m = new Map();
for (let i = 0; i < 10; i++) m.set('k' + i, i);
assert.strictEqual(limitMapSize(m, 4), 6);
assert.deepStrictEqual([...m.keys()], ['k6', 'k7', 'k8', 'k9'], '应删掉最早写入的');
assert.strictEqual(limitMapSize(m, 4), 0, '未超量时不删除');
assert.strictEqual(limitMapSize(m, 0), 4);
assert.strictEqual(m.size, 0);
assert.strictEqual(limitMapSize(null, 3), 0, '非 Map 不抛异常');
assert.strictEqual(limitMapSize(new Map([[1, 1]]), -1), 0, '非法上限不删除');

// 重新写入要放到末尾, 否则常用的条目会被当成"最早"删掉
const live = fs.readFileSync('renderer/js/live.js', 'utf8');
const hex = fs.readFileSync('renderer/js/hex.js', 'utf8');
assert.strictEqual((live.match(/sgpRecentCache\.delete\(key\);[^\n]*\n\s*sgpRecentCache\.set\(key, profile\);\n\s*limitMapSize\(sgpRecentCache, SGP_RECENT_CACHE_MAX\);/g) || []).length, 2,
  'live.js 两处 sgpRecentCache 写入都应先删后写再限量');
assert.ok(/const SGP_RECENT_CACHE_MAX = 300;/.test(live));
const hexSets = (hex.match(/summoner(Puuid)?LookupCache\.set\(/g) || []).length;
const hexLimits = (hex.match(/limitMapSize\(summoner(Puuid)?LookupCache, SUMMONER_LOOKUP_CACHE_MAX\)/g) || []).length;
assert.strictEqual(hexSets, 3, 'hex.js 应有 3 处查询缓存写入');
assert.strictEqual(hexLimits, hexSets, 'hex.js 每处查询缓存写入后都应限量');
assert.ok(/const SUMMONER_LOOKUP_CACHE_MAX = 500;/.test(hex));

console.log('渲染层 Map 缓存上限测试通过');
