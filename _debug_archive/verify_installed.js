// 校验安装目录 app.asar 的版本与关键改动（用独立进程读，避免 asar header 缓存）
const asar = require('@electron/asar');
const path = require('path');

const T = process.env.PORO_ASAR || path.join(process.env.LOCALAPPDATA, 'Programs', 'Poro', 'resources', 'app.asar');
const rd = f => asar.extractFile(T, f.split('/').join('\\')).toString('utf8');

const pkg = JSON.parse(rd('package.json'));
const home = rd('renderer/js/home.js');
const pi = rd('renderer/js/player-index.js');
const dm = rd('renderer/js/data-model.js');
const hex = rd('renderer/js/hex.js');
const live = rd('renderer/js/live.js');

const checks = [
  ['版本号', pkg.version],
  // 1.5.107: Chromium 不支持 oncomposition* 内联属性 (探针实证 handler 编译不出来),
  // 合成事件必须 addEventListener 捕获委托绑定
  ['home 合成事件监听绑定', /addEventListener\('compositionend'/.test(home)],
  ['home oninput 传 event', /onHomeSearchInput\(this\.value, event\)/.test(home)],
  ['home 无内联 composition 属性', !/oncompositionstart=|oncompositionend=/.test(home)],
  ['home 以 DOM 值为准', /function homeSearchLiveValue/.test(home)],
  // 1.5.98: 候选层只对完整名字负责 (对齐 LeagueAkari), 近似/裁字猜测全部移除
  ['home 不再猜相近名字', !/function homeAliasGuessName/.test(home)],
  ['home 候选区分来源', /同名账号/.test(home) && /最近遇到/.test(home)],
  ['index 无近似扫描', !/piApproxHit|PI_APPROX_SCORE|piLevenshtein/.test(pi)],
  ['index 待定池 PI_ALIAS_POOL', /PI_ALIAS_POOL/.test(pi)],
  ['hex 别名跨区定位', /function searchPlayerByAliasCrossRegion/.test(hex)],
  // 1.5.99: 「明明有 id 主页却显示未知玩家」—— 名字兜底 + 统一拼装
  ['data 名字兜底 fillSummonerName', /function fillSummonerName/.test(dm)],
  ['data 展示名 summonerDisplayName', /function summonerDisplayName/.test(dm)],
  ['data 拒绝「未知」占位名', /未知玩家\|unknown\|player/.test(dm)],
  ['home 他人档案用名字兜底', /s = typeof fillSummonerName === 'function'[\s\S]{0,120}fillSummonerName\(profileOverride\.summoner, profileOverride\.name\)/.test(home)],
  ['home 标题统一走 summonerDisplayName', /summonerDisplayName\(s\)/.test(home)],
  ['hex 入口先补名字', /summoner = fillSummonerName\(summoner, name\)/.test(hex)],
  ['hex SGP 档案带回名字', /splitRiotId\(remote\.name/.test(hex)],
  // 1.5.100: 「名字#Tag 前缀」模糊查询
  ['home Tag 前缀解析', /function homeSearchTagPrefix/.test(home)],
  ['home Tag 前缀放宽大区', /relaxed \? raw : strict/.test(home)],
  ['home Tag 命中按全区分大区', /allRegions: true/.test(home)],
  ['home Tag 筛空有专门文案', /开头的 Tag/.test(home)],
  // 1.5.101: 实时页(作战计划)整页闪烁
  ['live 整页比对后才重建', /body\.innerHTML !== pageHtml/.test(live)],
  ['live 计划条幂等写入', /_liveHeadPanelHtml/.test(live)],
  ['live 入口不再清计划条', !/renderToken;\n  setLiveHeadPanel\(''\)/.test(live)],
  // 1.5.103: 搜索对齐 Akari — nameset 接口 / PUUID 直查 / 候选分组+头像
  ['主进程 nameset 接口', /namesetsByPuuidsEx/.test(rd('main/riot-client.js'))],
  ['preload 暴露 playerNamesets', /playerNamesets/.test(rd('main/preload.js'))],
  ['hex PUUID 直查', /function searchPlayerByPuuidRaw/.test(hex) && /function looksLikePuuid/.test(hex)],
  ['hex PUUID 补名走 nameset', /playerNamesets\(\[id\]\)/.test(hex)],
  ['home 回车识别 PUUID', /looksLikePuuid\(raw\)/.test(hex)],
  ['home 候选分组渲染', /title: '同名账号'/.test(home) && /title: '最近遇到'/.test(home)],
  ['home 候选行带头像', /hs-avatar/.test(home) && /hs-avatar/.test(rd('renderer/css/style.css'))],
  ['home PUUID 直查行', /按 PUUID 查询/.test(home)],
];

let bad = 0;
for (const [name, val] of checks) {
  const pass = typeof val === 'boolean' ? val : !!val;
  if (!pass) bad++;
  console.log((pass ? 'OK   ' : 'FAIL ') + name + (typeof val === 'string' ? ' = ' + val : ''));
}
console.log('自检 ' + (checks.length - bad) + '/' + checks.length);
process.exit(bad ? 1 : 0);
