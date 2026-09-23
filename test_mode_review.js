'use strict';

const assert = require('assert');
const fs = require('fs');

const review = fs.readFileSync('renderer/js/review.js', 'utf8');
const home = fs.readFileSync('renderer/js/home.js', 'utf8');
const utils = fs.readFileSync('renderer/js/utils.js', 'utf8');

assert(review.includes('function isAramReviewMode('), '复盘应识别极地/海克斯大乱斗');
assert(review.includes("['承伤', clamp"), '大乱斗评分应以承伤替代视野');
assert(review.includes("aramMode ? '大乱斗按输出/生存/承伤/经济/参团评分'"), '评分说明应按模式切换');
assert(review.includes('if (!aramMode && ownDragons !== enemyDragons)'), '大乱斗复盘不得生成控龙建议');
assert(review.includes('避免复活后与队伍脱节进场'), '大乱斗死亡建议应围绕团战同步');
assert(review.includes('大乱斗没有野区、野怪、插眼控视野或小龙大龙运营'), 'AI 大乱斗复盘应明确禁止峡谷建议');
assert(utils.includes('const aramMode = /极地大乱斗|海克斯大乱斗|ARAM|KIWI|MAYHEM/i'), '战绩标签应识别大乱斗模式');
assert(utils.includes('if (!aramMode && (+player.visionScore'), '大乱斗战绩标签不得使用视野掌控');
assert(home.includes('mins, g.mode)'), '战绩卡应把模式传入标签规则');

console.log('按模式评分与复盘测试通过');
