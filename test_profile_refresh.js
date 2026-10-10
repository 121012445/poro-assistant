const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
const src=fs.readFileSync('renderer/js/home.js','utf8');
let now=100000,calls=0,backoffUntil=0;
const context=vm.createContext({Date:{now:()=>now},profileOverride:{puuid:'other'},homeStatsLoading:false,document:{hidden:false},loadHomeStats:async(force,opts)=>{calls++;assert(opts.profileRefresh&&opts.skipCache);},
  // home.js 里的 sgpBackoffActive() 依赖主流程状态；这里注入可控实现，
  // 好把"战绩服务故障退避期间不得轮询"也一起钉住。
  sgpBackoffActive:()=>now<backoffUntil});
vm.runInContext(src.slice(src.indexOf('let profileRefreshAfter'),src.indexOf('async function loadHomeStats')),context);
(async()=>{
  await context.refreshViewedProfile();
  await context.refreshViewedProfile();
  assert.equal(calls,1,'poll must be throttled');
  now+=60001;
  context.homeStatsLoading=true;
  await context.refreshViewedProfile();
  assert.equal(calls,1,'no overlapping requests');
  context.homeStatsLoading=false;
  await context.refreshViewedProfile();
  assert.equal(calls,2);
  now+=60001;context.profileOverride=null;
  await context.refreshViewedProfile();
  assert.equal(calls,2,'do not refresh self through profile flow');
  // 国服战绩网关连续 5xx 时的退避窗口: 节流时间已过也不能再打请求
  context.profileOverride={puuid:'other'};
  now+=60001;calls=0;backoffUntil=now+30000;
  await context.refreshViewedProfile();
  assert.equal(calls,0,'退避期间必须跳过轮询');
  assert.equal(src.includes('if(sgpBackoffActive()) return;'),true,'refreshViewedProfile 必须尊重退避');
  backoffUntil=0;
  await context.refreshViewedProfile();
  assert.equal(calls,1,'退避结束后必须立刻恢复轮询');
  assert(src.includes('cacheUsable && !skipCache && (!profileOverride || cacheFresh)'));
  assert(src.includes('ts:historyFetchedAt,rankedTs:Date.now()'));
  assert(src.includes('sgpInvalidateMatchHistory?.(profileOverride.puuid)'));
  assert(src.includes('isHomeGameDetailExpanded() || profileBackground'));
  assert(src.includes('if(profileBackground) { homeScrollSnapshot=null; return; }'));
  assert(src.includes('if (!profileBackground && !stale() && panel)'));
  console.log('他人战绩刷新：节流、并发、账号隔离、缓存期限与非侵入更新通过');
})().catch(e=>{console.error(e);process.exitCode=1;});
