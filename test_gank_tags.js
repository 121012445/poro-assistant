// 「好抓」标签的判定口径测试 (纯函数, 不需要 Electron)
//
// 这个标签会直接指使玩家去 gank 某个人, 判错就是把人往死路带。
// 所以每条断言都在守一个"不能误报"的边界: 大乱斗样本不能混进来、打野不能被叫好抓、
// carry 型上单不能被当成提款机、拿不到我方阵营时整批不出。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'renderer/js/gank-tags.js');
const Gank = require(SRC);
const liveSrc = fs.readFileSync(path.join(__dirname, 'renderer/js/live.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'renderer/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'renderer/css/poro-1632.css'), 'utf8');

// ---- 造数据 ----
// 一场峡谷对局: 默认 45% 胜率、单双排(queueId 420)
function game(o = {}) {
  return {
    win: o.win != null ? o.win : false,
    d: o.d != null ? o.d : 6.5,
    k: o.k != null ? o.k : 4,
    a: o.a != null ? o.a : 6,
    vision: o.vision != null ? o.vision : 18,
    kp: o.kp != null ? o.kp : 50,
    solo: o.solo != null ? o.solo : 1,
    position: o.position != null ? o.position : 'TOP',
    queueId: o.queueId != null ? o.queueId : 420,
    mode: o.mode != null ? o.mode : '单双排',
    champId: 86,
    cs: 180, dur: 1800
  };
}
function games(n, o) { return Array.from({ length: n }, () => game(o)); }

// 1. 典型好抓目标: 上单, 场均死 6.5, 视野 18, 参团 50, 单杀 1
{
  const r = Gank.scoreOf(games(18), { position: 'TOP' });
  assert.ok(r, '样本充足时应给出评分');
  assert.strictEqual(r.level, 'good', '死得多+视野差+单人线 应判好抓');
  assert.ok(r.score >= Gank.THRESHOLD, `分数 ${r.score} 应 >= ${Gank.THRESHOLD}`);
  assert.strictEqual(r.pos, 'TOP');
  assert.ok(r.reasons.some(x => x.includes('场均阵亡')), '理由里要写清阵亡依据');
  assert.ok(r.reasons.some(x => x.includes('视野')), '理由里要写清视野依据');
}

// 2. 打野不能叫好抓 —— 他本来就不在固定线上, "绕后抓他"这件事不成立
{
  const r = Gank.scoreOf(games(18), { position: 'JUNGLE' });
  assert.strictEqual(r.level, 'none', '打野即便死得多也不该被判好抓');
  assert.ok(r.notes.some(x => x.includes('打野')), '减分理由要说清是打野');
}

// 3. 大乱斗样本必须整批排除 —— 一场死 9 次在大乱斗是常态, 混进峡谷阈值会全员误报
{
  const aram = Array.from({ length: 20 }, () => game({ queueId: 450, mode: '极地大乱斗', d: 9, vision: 8 }));
  assert.strictEqual(Gank.scoreOf(aram, { position: 'TOP' }), null, '全是乱斗样本时不应下结论');
  // 乱斗 + 峡谷混合: 只按峡谷那 8 场算
  const mixed = aram.slice(0, 12).concat(games(8, { d: 3.2, vision: 30 }));
  const r = Gank.scoreOf(mixed, { position: 'TOP' });
  assert.ok(r, '混合样本里峡谷够 8 场就应给结论');
  assert.strictEqual(r.games, 8, '分母只能是峡谷场次, 不能把乱斗算进去');
  assert.strictEqual(r.d, 3.2, '阵亡均值不能被乱斗的 9 次拉高');
  assert.strictEqual(r.level, 'none', '少死的上单不是好抓目标');
}

// 4. 样本不足不出结论
{
  assert.strictEqual(Gank.scoreOf(games(7), { position: 'TOP' }), null, '7 场不够');
  assert.strictEqual(Gank.scoreOf([], {}), null, '空数组');
  assert.strictEqual(Gank.scoreOf(null, {}), null, 'null 不能抛');
  assert.strictEqual(Gank.scoreOf(undefined, {}), null, 'undefined 不能抛');
}

// 5. carry 型上单不能被当成提款机 —— 这是最伤人的误报
{
  const carry = Array.from({ length: 18 }, () => game({ d: 4.4, vision: 18, kp: 52, solo: 3.4, win: true }));
  const r = Gank.scoreOf(carry, { position: 'TOP' });
  assert.strictEqual(r.level, 'none', '场均单杀 3.4 + 高胜率 的上单不该被标好抓');
  assert.ok(r.notes.some(x => x.includes('单杀')), '要记录单杀减分理由');
  assert.ok(r.notes.some(x => x.includes('胜率')), '要记录胜率减分理由');
}

// 6. 视眼很多的人不好抓 (辅助典型: 死得多但眼睛铺满河道)
{
  const sup = Array.from({ length: 18 }, () => game({ d: 7.4, vision: 44, kp: 64, position: 'UTILITY' }));
  const r = Gank.scoreOf(sup, { position: 'UTILITY' });
  assert.strictEqual(r.level, 'none', '视野 44 的辅助不该被标好抓');
}

// 7. 单人线 + 单带型 (参团极低) 应入选
{
  const split = Array.from({ length: 16 }, () => game({ d: 5.4, vision: 15, kp: 42, solo: 0.8, position: 'MIDDLE' }));
  const r = Gank.scoreOf(split, { position: 'MIDDLE' });
  assert.strictEqual(r.level, 'good', '中路单带型 (参团 42%) 是好抓目标');
  assert.ok(r.reasons.some(x => x.includes('参团')), '要写清参团依据');
}

// 8. 位置缺失时用历史主玩位置兜底, 占比不够就不认
{
  const r = Gank.scoreOf(games(18), {});
  assert.strictEqual(r.pos, 'TOP', '本局位置为空时应回落到历史主玩位置');
  assert.strictEqual(r.posSrc, 'history');
  // 五个位置各 4 场 (共 20): 没有主玩线, 不该硬认
  const spread = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
  const mixed = Array.from({ length: 20 }, (_, i) => game({ position: spread[i % 5] }));
  const r2 = Gank.scoreOf(mixed, {});
  assert.strictEqual(r2.pos, '', '补位型玩家不该被赋予主玩位置');
  assert.strictEqual(r2.level, 'none', '位置不明时不应判好抓');
}

// 9. 本局位置优先于历史
{
  const r = Gank.scoreOf(games(18), { position: 'MIDDLE' });
  assert.strictEqual(r.pos, 'MIDDLE');
  assert.strictEqual(r.posSrc, 'live');
}

// 10. 只给敌方: 队友/未知阵营一律不出标签
{
  const data = games(18);
  assert.ok(Gank.tagInfo(data, { enemy: true, family: 'rift', position: 'TOP' }), '敌方应出标签');
  assert.strictEqual(Gank.tagInfo(data, { enemy: false, family: 'rift', position: 'TOP' }), null, '队友不出标签');
  assert.strictEqual(Gank.tagInfo(data, { family: 'rift', position: 'TOP' }), null, '阵营未知不出标签');
  assert.strictEqual(Gank.tagInfo(data, { enemy: true, family: 'aram', position: 'TOP' }), null, '大乱斗不出标签');
  assert.strictEqual(Gank.tagInfo(data, { enemy: true, family: 'arena', position: 'TOP' }), null, '斗魂不出标签');
  // 模式识别失败 ('other') 不一律打死: 样本门会筛掉非峡谷战绩, 有峡谷样本就照常判
  assert.ok(Gank.tagInfo(data, { enemy: true, family: 'other', position: 'TOP' }), '模式不明但有峡谷样本时应照常判');
  const aramOnly = Array.from({ length: 20 }, () => game({ queueId: 450, mode: '极地大乱斗' }));
  assert.strictEqual(Gank.tagInfo(aramOnly, { enemy: true, family: 'other', position: 'TOP' }), null,
    '模式不明且样本全是乱斗时, 样本门必须挡住');
}

// 11. 标签文案与 tooltip: 必须写清"这是历史习惯, 不是本局预测"
{
  const t = Gank.tagInfo(games(18), { enemy: true, family: 'rift', position: 'TOP' });
  assert.strictEqual(t.label, '好抓');
  assert.ok(t.tip.includes('近 18 场'), 'tooltip 要带样本量');
  assert.ok(t.tip.includes('场均阵亡 6.5'), 'tooltip 要带阵亡均值');
  assert.ok(t.tip.includes('视野 18'), 'tooltip 要带视野');
  assert.ok(t.tip.includes('不是本局位置预测'), 'tooltip 必须声明这是历史判断, 不能让人当成实时预测');
}

// 12. 缺字段容错: 没有 vision/kp/solo 的老接口不能崩, 也不能因此判成好抓
{
  const bare = Array.from({ length: 10 }, () => ({ win: false, d: 4, k: 2, a: 3, position: 'MIDDLE', queueId: 420, mode: '单双排' }));
  const r = Gank.scoreOf(bare, { position: 'MIDDLE' });
  assert.ok(r, '只要阵亡够场次就应能算');
  assert.strictEqual(r.vision, null);
  assert.strictEqual(r.kp, null);
  assert.strictEqual(r.level, 'none', '仅凭场均死 4 次不能判好抓');
}

// 13. 权重方向守门: 同一份数据, 只把视野调低, 分数必须变高
{
  const good = Gank.scoreOf(games(18, { vision: 12 }), { position: 'TOP' }).score;
  const bad = Gank.scoreOf(games(18, { vision: 40 }), { position: 'TOP' }).score;
  assert.ok(good > bad, `视野低应得分更高 (${good} vs ${bad})`);
  const dieMore = Gank.scoreOf(games(18, { d: 7.2 }), { position: 'TOP' }).score;
  const dieLess = Gank.scoreOf(games(18, { d: 3.2 }), { position: 'TOP' }).score;
  assert.ok(dieMore > dieLess, `死得多应得分更高 (${dieMore} vs ${dieLess})`);
}

// ---- 接线检查 ----
{
  assert.ok(/PoroGank\.tagInfo\(/.test(liveSrc), 'live.js 要调用 gank-tags 的 tagInfo');
  assert.ok(/isEnemyPlayer/.test(liveSrc), 'live.js 必须有敌我判定');
  assert.ok(/_poroSelfTeam/.test(liveSrc), '要落地我方阵营, 否则局部刷新时判不出敌我');
  assert.ok(/lp-tag-gank/.test(liveSrc), '标签要带自己的类名');
  assert.ok(/specialTags\.push\(`<span class="lp-metric lp-tag-gank"/.test(liveSrc), '好抓要进 specialTags (和组队/小代同一套拼接)');
  assert.ok(html.indexOf('gank-tags.js') > 0, 'index.html 要挂载 gank-tags.js');
  assert.ok(html.indexOf('gank-tags.js') < html.indexOf('live.js'), 'gank-tags.js 必须在 live.js 之前加载');
  assert.ok(/#page-live \.lp-profile-line \.lp-tag-gank\s*\{/.test(css), '样式要写在最后加载的表里');
  assert.ok(/body\.dark #page-live \.lp-profile-line \.lp-tag-gank/.test(css), '深色主题要单独给色');
}

// 14. vm 沙箱: 脚本必须挂到 window 上 (经典 script 共享全局, 没有模块系统)
{
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);
  assert.ok(sandbox.window.PoroGank, 'gank-tags.js 必须挂 window.PoroGank');
  assert.strictEqual(typeof sandbox.window.PoroGank.tagInfo, 'function');
}

console.log('test_gank_tags: all assertions passed');
