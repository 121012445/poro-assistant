'use strict';
// proxy-tunnel.js 端到端：起本地 CONNECT 代理 + 本地 HTTPS 服务器，验证隧道能把
// https.get 的请求正确转发。用自签证书 + rejectUnauthorized:false（仅测试）。
const assert = require('assert');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { HttpsProxyTunnelAgent } = require('./main/proxy-tunnel');

// 生成一个临时自签证书（用 openssl，Windows Git Bash 自带；失败则跳过 TLS 部分）
let key, cert;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poro-tunnel-'));
  const keyPath = path.join(dir, 'k.pem'), crtPath = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', crtPath, '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  key = fs.readFileSync(keyPath); cert = fs.readFileSync(crtPath);
} catch (e) { console.log('SKIP (openssl unavailable): ' + e.message); process.exit(0); }

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

async function main() {
  // 1) 本地 HTTPS 目标服务器
  const httpsSrv = https.createServer({ key, cert }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  await new Promise(r => httpsSrv.listen(0, '127.0.0.1', r));
  const targetPort = httpsSrv.address().port;

  // 2) 本地 CONNECT 代理（记录是否被用到）
  let connectSeen = '';
  const proxy = http.createServer();
  proxy.on('connect', (req, clientSocket, head) => {
    connectSeen = req.url;
    const [host, port] = req.url.split(':');
    const serverSocket = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => serverSocket.destroy());
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const proxyPort = proxy.address().port;

  // 3) 用隧道 Agent 发请求
  const agent = new HttpsProxyTunnelAgent('http://127.0.0.1:' + proxyPort);
  const body = await new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'localhost', port: targetPort, path: '/ping',
      agent, rejectUnauthorized: false
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });

  ok(connectSeen === 'localhost:' + targetPort, '代理收到正确的 CONNECT 目标: ' + connectSeen);
  ok(body.status === 200, '经隧道拿到 200');
  const parsed = JSON.parse(body.text);
  ok(parsed.ok === true && parsed.url === '/ping', '响应体完整：' + body.text);

  // 4) 代理认证头
  const agentAuth = new HttpsProxyTunnelAgent('http://u:p@127.0.0.1:' + proxyPort);
  ok(agentAuth.proxyAuth === 'Basic ' + Buffer.from('u:p').toString('base64'), '代理 Basic 认证头');

  httpsSrv.close(); proxy.close();
  console.log('PASS ' + pass + ' assertions (proxy tunnel e2e)');
}
main().catch(e => { console.error('FAIL', e); process.exit(1); });
