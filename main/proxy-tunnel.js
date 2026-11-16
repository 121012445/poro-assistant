'use strict';
// 零依赖 HTTPS 代理隧道 Agent（打进 asar，不依赖任何 node_modules）。
//
// 为什么手写：软件只把 koffi/ws/@koromix 三个生产依赖打进 asar，https-proxy-agent
// 不在白名单里，运行时 require 不到。而更新器在国内必须走代理才能连上 GitHub，
// 所以这里用 Node 内置的 http(CONNECT) + tls 自己搭一条隧道。
//
// 原理：https.Agent 默认直接 TCP 连目标；我们改成先向代理发 CONNECT host:443，
// 代理回 200 后，在这条 TCP 上包一层 TLS，得到的 socket 就等价于直连目标。
// 之后 https.get 会照常在这个 socket 上做 TLS 握手吗？不会——我们返回的已经是
// TLS socket，所以要设置 options.socket 路径让 https 不再二次握手：
// 通过覆盖 createConnection 返回已建立的 tls.TLSSocket 即可（Node 会直接使用它）。

const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');

class HttpsProxyTunnelAgent extends https.Agent {
  constructor(proxyUrl, opts) {
    super(Object.assign({ keepAlive: false }, opts || {}));
    const u = new URL(proxyUrl);
    this.proxyHost = u.hostname;
    this.proxyPort = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    this.proxyTls = u.protocol === 'https:';
    this.proxyAuth = (u.username || u.password)
      ? 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64')
      : '';
    this.proxySecure = !!opts && !!opts.proxySecure;
  }

  // Node 调用：createConnection(options, cb) → cb(null, socket)
  createConnection(options, cb) {
    const targetHost = options.host || options.hostname;
    const targetPort = options.port || 443;
    const self = this;

    const onConnected = (tcpSocket) => {
      // 在代理隧道上做 TLS：SNI 用目标 host，证书校验照常
      const tlsSocket = tls.connect({
        socket: tcpSocket,
        servername: targetHost,
        rejectUnauthorized: options.rejectUnauthorized !== false
      });
      tlsSocket.once('secureConnect', () => cb(null, tlsSocket));
      tlsSocket.once('error', err => cb(err));
    };

    const connectOpts = {
      host: this.proxyHost,
      port: this.proxyPort,
      method: 'CONNECT',
      path: targetHost + ':' + targetPort,
      headers: { Host: targetHost + ':' + targetPort },
      agent: false
    };
    if (this.proxyAuth) connectOpts.headers['Proxy-Authorization'] = this.proxyAuth;

    const doConnect = () => {
      const req = (self.proxySecure ? https : http).request(connectOpts);
      req.once('connect', (res, socket) => {
        if (res.statusCode === 200) return onConnected(socket);
        try { socket.destroy(); } catch (e) {}
        cb(new Error('代理 CONNECT 失败: HTTP ' + res.statusCode));
      });
      req.once('error', err => cb(err));
      req.setTimeout(15000, () => { req.destroy(new Error('代理连接超时')); });
      req.end();
    };
    doConnect();
  }
}

module.exports = { HttpsProxyTunnelAgent };
