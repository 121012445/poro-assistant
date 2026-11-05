// 校验构建产物 D:/_asar_out/app.asar 的版本与跨区改动
const asar = require('@electron/asar');
const T = 'D:\\_asar_out\\app.asar';
const rd = f => asar.extractFile(T, f.split('/').join('\\')).toString('utf8');

const pkg = JSON.parse(rd('package.json'));
const home = rd('renderer/js/home.js');
const hex = rd('renderer/js/hex.js');
// 版本期望取本地源 package.json (单一事实来源), 避免每次 bump 都要改自检脚本
const expectVersion = require('../package.json').version;

const checks = [
  ['版本 ' + expectVersion, pkg.version === expectVersion, pkg.version],
  ['home 跨区入口函数', /function homeOpenIndexedPlayer/.test(home), ''],
  ['home 点击放行跨区', /if \(hit && hit\.foreign && hit\.puuid/.test(home), ''],
  ['home 跨区段位文案', /跨区不显示/.test(home), ''],
  ['home 候选显示等级', /\$\{c\.level \?/.test(home), ''],
  ['home 优先已知大区', /profileOverride && profileOverride\.platformId\) \|\| selfPlatformId/.test(home), ''],
  ['hex 回车不再拦跨区', /found\.foreign && found\.puuid && typeof homeOpenIndexedPlayer/.test(hex), ''],
  ['hex 跨区取档案', /sgpSummonerByPuuid\(hintPlatform, puuid\)/.test(hex), ''],
  ['hex LCU 失败回退索引', /homeOpenIndexedPlayer\(name\)\) \{\n\s+if \(msg\) msg\.textContent = ''/.test(hex), ''],
  ['hex 大区提示改口', /点候选即可查看该区战绩/.test(hex), ''],
  // 1.5.97: 精确名字路径改成 Akari 的做法, 不再依赖本地索引
  ['hex 别名跨区定位函数', /async function searchPlayerByAliasCrossRegion/.test(hex), ''],
  ['hex 逐区探针定位大区', /playerResolveRegions\(ids, null\)/.test(hex), ''],
  ['hex LCU 未命中先跨区', /await searchPlayerByAliasCrossRegion\(name, msg\)/.test(hex), ''],
  // 1.5.99: 名字兜底 —— 主页标题不能是「未知玩家#77843」
  ['data 名字兜底函数', /function fillSummonerName/.test(rd('renderer/js/data-model.js')), ''],
  ['data 展示名统一拼装', /function summonerDisplayName/.test(rd('renderer/js/data-model.js')), ''],
  ['home 他人档案补名字', /fillSummonerName\(profileOverride\.summoner, profileOverride\.name\)/.test(home), ''],
  ['hex 入口补名字', /summoner = fillSummonerName\(summoner, name\)/.test(hex), ''],
  ['hex SGP 档案带回名字', /splitRiotId\(remote\.name/.test(hex), ''],
  // 1.5.100: 「名字#Tag 前缀」模糊查询 —— 打 彩虹海#778 要能筛出 彩虹海#77843
  ['home Tag 前缀解析函数', /function homeSearchTagPrefix/.test(home), ''],
  ['home Tag 前缀放宽大区', /relaxed \? raw : strict/.test(home), ''],
  ['home Tag 前缀逐条标大区', /candPack\.relax && !inScope/.test(home), ''],
  ['home Tag 前缀命中按全区分大区', /homeAliasResolveMetas\(todo, \{ allRegions: true \}\)/.test(home), ''],
  ['home 回车唯一命中直开', /players\.length === 1/.test(home), ''],
  ['home Tag 筛空有专门文案', /名下没有以 \$\{escapeHtml\(candPack\.tagPrefix\)\} 开头的 Tag/.test(home), ''],
];

let bad = 0;
for (const [name, ok, extra] of checks) {
  if (!ok) bad++;
  console.log((ok ? 'OK   ' : 'FAIL ') + name + (extra ? ' = ' + extra : ''));
}
console.log('包内自检 ' + (checks.length - bad) + '/' + checks.length);
process.exit(bad ? 1 : 0);
