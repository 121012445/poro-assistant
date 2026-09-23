// 临时探测: 2999 端口游戏客户端 API 的聊天发送端点
process.chdir('D:/lol-assistant');
const https = require('https');
const lcu = require('./main/lcu.js');

function g2999(path, method, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1', port: 2999, path, method: method || 'GET',
      rejectUnauthorized: false, timeout: 6000,
      headers: Object.assign({ Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {})
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const phase = await lcu.lcuRequest('GET', '/lol-gameflow/v1/gameflow-phase');
  console.log('PHASE ' + phase);
  if (phase !== 'InProgress') { console.log('NOT_IN_GAME'); process.exit(0); }
  // 1. 探各版本 swagger
  try {
    const v2 = await g2999('/swagger/v2/swagger.json');
    console.log('V2_STATUS ' + v2.status);
    try {
      const spec = JSON.parse(v2.body);
      const paths = Object.keys(spec.paths || {});
      console.log('V2_PATHS ' + paths.length);
      for (const p of paths) { if (!/liveclientdata|swagger/i.test(p)) console.log('V2_PATH ' + p + ' [' + Object.keys(spec.paths[p]).join(',') + ']'); }
    } catch (e) { console.log('V2_PARSE ' + v2.body.substring(0, 120)); }
  } catch (e) { console.log('V2_FAIL ' + e.message.substring(0, 80)); }
  try {
    const v1 = await g2999('/swagger/v1/api-docs');
    console.log('V1_STATUS ' + v1.status + ' ' + v1.body.substring(0, 200));
  } catch (e) { console.log('V1_FAIL ' + e.message.substring(0, 80)); }
  for (const api of ['GameChat', 'Chat', 'GameClient', 'liveclientdata']) {
    try {
      const r = await g2999('/swagger/v1/api-docs/' + api);
      console.log('V1API ' + api + ' ' + r.status + ' ' + r.body.substring(0, 150).replace(/\s+/g, ' '));
    } catch (e) { console.log('V1API ' + api + ' FAIL ' + e.message.substring(0, 60)); }
  }
  console.log('DONE');
  process.exit(0);
})().catch(e => { console.log('FAIL ' + e.message); process.exit(1); });
