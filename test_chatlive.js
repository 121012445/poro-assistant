// 有副作用的手工 E2E：会向当前游戏聊天发送测试消息，默认拒绝执行。
if (process.env.PORO_E2E_WRITE !== 'I_UNDERSTAND') {
  console.error('已拒绝：该测试会真实发送游戏聊天。仅在明确知情时设置 PORO_E2E_WRITE=I_UNDERSTAND。');
  process.exit(2);
}
process.chdir('D:/lol-assistant');
const lcu = require('./main/lcu.js');

(async () => {
  const phase = await lcu.lcuRequest('GET', '/lol-gameflow/v1/gameflow-phase');
  console.log('PHASE ' + phase);
  if (phase !== 'InProgress') { console.log('NOT_IN_GAME'); process.exit(0); }
  const gs = await lcu.lcuRequest('GET', '/lol-gameflow/v1/session');
  const gameId = gs?.gameData?.gameId;
  console.log('GAMEID ' + gameId);

  const tests = [
    ['orig-bukkit', 'POST', '/lol-chat/v1/messages', { body: '[魄罗测试1] bukkit 频道', channelId: 'org.bukkit.craftbukkit' }],
    ['muc-pvp', 'POST', '/lol-chat/v1/messages', { body: '[魄罗测试2] muc 频道', channelId: gameId + '@muc.pvp.net' }],
    ['conv-muc', 'POST', '/lol-chat/v1/conversations/' + gameId + '@muc.pvp.net/messages', { body: '[魄罗测试3] conv muc', type: 'chat' }],
    ['room-cn', 'POST', '/lol-chat/v1/messages', { body: '[魄罗测试4] room 频道', channelId: 'room-' + gameId + '@chat.hn1.lol.qq.com' }]
  ];
  for (const [name, method, path, body] of tests) {
    try {
      const r = await lcu.lcuRequest(method, path, body);
      console.log('TEST ' + name + ' -> ' + (r && r.__error ? 'ERR ' + JSON.stringify(r).substring(0, 120) : (r === null ? 'NULL(204?) 可能成功' : JSON.stringify(r).substring(0, 100))));
    } catch (e) {
      console.log('TEST ' + name + ' -> EXC ' + e.message.substring(0, 80));
    }
    await new Promise(res => setTimeout(res, 800));
  }
  console.log('DONE - 请看游戏内聊天是否出现 测试1-4');
  process.exit(0);
})().catch(e => { console.log('FAIL ' + e.message); process.exit(1); });
