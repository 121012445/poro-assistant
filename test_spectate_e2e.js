// 有副作用的手工 E2E：会读取好友状态并可能真实启动观战，默认拒绝执行。
if (process.env.PORO_E2E_WRITE !== 'I_UNDERSTAND') {
  console.error('已拒绝：该测试可能真实启动观战。仅在明确知情时设置 PORO_E2E_WRITE=I_UNDERSTAND。');
  process.exit(2);
}
process.chdir('D:/lol-assistant');
const lcu = require('./main/lcu.js');

(async () => {
  const phase = await lcu.lcuRequest('GET', '/lol-gameflow/v1/gameflow-phase');
  console.log('PHASE ' + phase);
  const friends = await lcu.lcuRequest('GET', '/lol-chat/v1/friends');
  const live = friends.filter(f => f && f.lol && f.lol.gameId && String(f.lol.gameId) !== '0');
  console.log('LIVE_FRIENDS ' + live.length);
  for (const f of live) {
    const nm = (f.gameName || '') + '#' + (f.gameTag || '');
    const lol = f.lol;
    console.log('  ' + nm + ' | gameStatus=' + (lol.gameStatus || '?') + ' | isObservable=' + (lol.isObservable || '?') + ' | spectatorKey=' + (lol.spectatorKey ? 'YES(' + String(lol.spectatorKey).length + '字符)' : 'NO') + ' | platformId=' + (f.platformId || '?') + ' | queue=' + (lol.gameQueueType || '?'));
  }
  // 找第一个 gameStatus=inGame 且有密钥的目标做真实启动
  const target = live.find(f => f.lol.gameStatus === 'inGame' && f.lol.spectatorKey);
  if (!target) { console.log('NO_SPECTATABLE (无可观战目标: 密钥缺失或状态不符)'); process.exit(0); }
  if (phase !== 'None') { console.log('CLIENT_BUSY (' + phase + ') 跳过真实启动'); process.exit(0); }
  const nm = (target.gameName || '') + '#' + (target.gameTag || '');
  console.log('LAUNCH_TEST ' + nm);
  const r = await lcu.lcuRequest('POST', '/lol-gameflow/v2/spectate/launch', {
    gameId: Number(target.lol.gameId) || 0,
    platformId: target.platformId || '',
    spectatorKey: target.lol.spectatorKey,
    puuid: target.puuid,
    gameQueueType: target.lol.gameQueueType || '',
    allowObserveMode: 'false',
    dropInSpectateGameId: ''
  }).catch(e => ({ __error: e.message }));
  console.log('LAUNCH_RESULT ' + JSON.stringify(r).substring(0, 300));
  await new Promise(res => setTimeout(res, 3000));
  console.log('PHASE_AFTER ' + await lcu.lcuRequest('GET', '/lol-gameflow/v1/gameflow-phase'));
  console.log('DONE');
  process.exit(0);
})().catch(e => { console.log('FAIL ' + e.message); process.exit(1); });
