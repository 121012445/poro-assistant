// 战报卡构建测试: 卡片是发到外部社群的成品图, 图上写错一个字都没法撤回。
// 这里守三件事: 玩家名能上卡、不传名字时不硬塞占位、名字里的 HTML 必须转义。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'renderer/js/battle-card.js');
const css = fs.readFileSync(path.join(__dirname, 'renderer/css/premium.css'), 'utf8');
const hexSrc = fs.readFileSync(path.join(__dirname, 'renderer/js/hex.js'), 'utf8');

// --- 最小沙箱: build() 只用到几个全局工具函数, 没有 DOM ---
const sandbox = {
  console,
  window: {},
  escapeHtml: s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  champImg: id => 'champ/' + id + '.png',
  placeholder: () => 'ph.png',
  champNumMap: { '86': { id: '86', name: '盖伦' }, '64': { id: '64', name: '李青' } },
  version: '16.17.1',
  hexAugMeta: {},
  // app.js 里的实现按队列判断"这局有没有真实分路", 沙箱里保持同一语义
  hasRealPositions: g => [400, 420, 430, 440, 490].includes(Number(g && g.queueId) || 0)
};
sandbox.champNumMap = sandbox.champNumMap;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);
const Card = sandbox.window.PoroBattleCard;

function norm(over) {
  const P = (puuid, teamId, cid, k, d, a, win) => ({
    puuid, teamId, championId: String(cid), k, d, a, win,
    dmg: 20000, dmgTaken: 15000, gold: 12000, cs: 200, visionScore: 20,
    items: [3153, 3006], position: 'TOP', level: 16, fb: false, multi: ''
  });
  return Object.assign({
    mode: '单双排', queueId: 420, dur: 1980, time: Date.UTC(2026, 10, 22, 10, 0, 0),
    participants: [
      P('p0', 100, 86, 11, 3, 9, true), P('p1', 100, 64, 6, 5, 14, true),
      P('p2', 200, 86, 5, 8, 6, false), P('p3', 200, 64, 4, 9, 10, false)
    ]
  }, over || {});
}

// 1. 传了名字就要出现在卡上, 且在头部
{
  const html = Card.build(norm(), 'p0', { name: '雨未眠#0417' });
  assert.ok(html.includes('bc-owner'), '有名字时必须渲染 .bc-owner');
  assert.ok(html.includes('雨未眠#0417'), '名字要原样上卡');
  const top = html.slice(html.indexOf('bc-top'), html.indexOf('bc-hero'));
  assert.ok(top.includes('bc-owner'), '名字必须在卡片头部 (bc-top) 里, 不能落到别处');
  assert.ok(top.includes('胜利'), '头部胜负标题不能被名字挤掉');
}

// 2. 不传名字: 整块不渲染, 不留空占位、不写"未知召唤师"
{
  for (const opts of [undefined, null, {}, { name: '' }, { name: '   ' }]) {
    const html = Card.build(norm(), 'p0', opts);
    assert.ok(!html.includes('bc-owner'), '没名字时不应渲染 .bc-owner');
    assert.ok(!/未知召唤师|匿名/.test(html), '不能编一个占位名字');
  }
}

// 3. 名字里的 HTML 必须转义 —— Riot ID 允许尖括号/引号, 直接拼会破坏卡片结构
{
  const evil = '<img src=x onerror=alert(1)>#1234';
  const html = Card.build(norm(), 'p0', { name: evil });
  assert.ok(!html.includes('<img src=x'), '名字里的标签必须被转义');
  assert.ok(html.includes('&lt;img'), '转义后应保留可见字符');
}

// 4. 归属玩家不存在时退回胜方第一个, 但名字仍然显示 (卡住的是"谁的战报", 不是数据)
{
  const html = Card.build(norm(), 'not-exist', { name: '路人甲#0001' });
  assert.ok(html.includes('路人甲#0001'), '找不到 puuid 时也应显示传入的名字');
}

// 5. 基础内容没被这次改动破坏
{
  const html = Card.build(norm(), 'p0', { name: 'A#1' });
  assert.ok(html.includes('11<i>/</i><em>3</em><i>/</i>9'), 'KDA 要按 k/d/a 渲染');
  assert.ok(html.includes('盖伦'), '英雄名要在卡上');
  assert.ok(/bc-grid/.test(html) && /bc-mates/.test(html), '数据格与双方阵容都还在');
  assert.ok(html.includes('Poro'), '品牌脚注还在');
}

// 6. 样式: 名字要右对齐、能收缩、超长省略
{
  const i = css.indexOf('.bc-owner');
  assert.ok(i > 0, '.bc-owner 样式必须存在');
  const block = css.slice(i, css.indexOf('}', i) + 1);
  assert.ok(/margin-left:\s*auto/.test(block), '名字要推到右边');
  assert.ok(/text-overflow:\s*ellipsis/.test(block), '长 Riot ID 要省略号, 不能溢出卡片');
  assert.ok(/min-width:\s*0/.test(block), 'flex 子项必须允许收缩, 否则省略号不生效');
  assert.ok(/max-width:\s*\d+%/.test(block), '要限宽, 否则长名字会挤走胜负标题');
}

// 7. 接线: 调用处必须把名字传进来, save 必须透传给 build
{
  assert.ok(/PoroBattleCard\.save\(norm, ownerPuuid, \{ name: ownerName \}\)/.test(hexSrc),
    'hex.js 调用 save 时要带 name');
  assert.ok(/profileOverride && profileOverride\.name/.test(hexSrc), '名字优先取当前查看的档案主人');
  assert.ok(/cachedSummoner && \(cachedSummoner\.displayName \|\| cachedSummoner\.gameName\)/.test(hexSrc),
    '其次取本机召唤师名');
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(/function save\(norm, ownerPuuid, opts\)/.test(src), 'save 要接受第三个参数');
  assert.ok(/build\(norm, ownerPuuid, o\)/.test(src), 'save 必须把 opts 透传给 build');
}

console.log('test_battle_card: all assertions passed');
