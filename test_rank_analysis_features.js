const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const context = { console };
vm.createContext(context);
vm.runInContext(fs.readFileSync('renderer/js/utils.js', 'utf8'), context);

const steady = context.deriveRiskProfile(Array.from({ length: 10 }, (_, i) => ({ win: i < 7, k: 8, d: 3, a: 9 })));
assert.equal(steady.level, 'steady');
assert.equal(steady.confidence, 100);
assert.ok(steady.evidence.some(x => x.includes('7胜3负')));

const risky = context.deriveRiskProfile(Array.from({ length: 8 }, (_, i) => ({ win: i === 0, k: 2, d: 10, a: 3 })));
assert.equal(risky.level, 'watch');
assert.ok(risky.evidence.some(x => x.includes('场均死亡')));

const small = context.deriveRiskProfile([{ win: true, k: 9, d: 1, a: 8 }]);
assert.equal(small.level, 'unknown');
assert.equal(small.label, '样本较少');

const social = fs.readFileSync('renderer/js/social.js', 'utf8');
const review = fs.readFileSync('renderer/js/review.js', 'utf8');
const live = fs.readFileSync('renderer/js/live.js', 'utf8');
const persist = fs.readFileSync('renderer/js/persist.js', 'utf8');
const autoBp = fs.readFileSync('renderer/js/autobp.js', 'utf8');
const main = fs.readFileSync('main/index.js', 'utf8');
const preload = fs.readFileSync('main/preload.js', 'utf8');

assert(social.includes('normalizePlayerMemory'));
assert(social.includes('私人备注（仅保存在本机）'));
assert(live.includes('系统画像'));
assert(review.includes('buildEvidenceVerdict'));
assert(review.includes('aiReviewCacheKey'));
assert(persist.includes('exportPoroBackup'));
assert(persist.includes("/^aiReview:"));
assert(autoBp.includes('autoBPRuleMatches'));
assert(main.includes("ipcMain.handle('backup:export'"));
assert(main.includes("ipcMain.handle('backup:import'"));
assert(preload.includes('exportBackup:'));

console.log('Rank Analysis 借鉴功能测试通过');
