// SGP (Server Gateway Protocol) - 国服官方服务器网关, 提供完整历史战绩
// 网关地址与认证方式参考 LeagueAkari 开源实现
const https = require('https');
const { StringDecoder } = require('string_decoder');
const lcu = require('./lcu');

// keep-alive agent: 国服合区后的 8 个入口共享连接池，避免每次握手
const sgpAgent = new https.Agent({ keepAlive: true, maxSockets: 12, keepAliveMsecs: 3000 });
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 平台ID -> SGP 网关 (统一端口 21019)。2026 合区后旧 HN2/HN3/BGP1 等入口
// 已不再是可独立查询的大区；继续探测它们会产生 TLS 超时并漏掉合区后的玩家。
const SGP_HOSTS = {
  HN1: 'hn1-k8s-sgp.lol.qq.com:21019',      // 艾欧尼亚
  HN10: 'hn10-k8s-sgp.lol.qq.com:21019',    // 黑色玫瑰
  BGP2: 'bgp2-k8s-sgp.lol.qq.com:21019',    // 峡谷之巅
  TJ100: 'tj100-sgp.lol.qq.com:21019',      // 联盟四区
  TJ101: 'tj101-sgp.lol.qq.com:21019',      // 联盟五区
  NJ100: 'nj100-sgp.lol.qq.com:21019',      // 联盟一区
  GZ100: 'gz100-sgp.lol.qq.com:21019',      // 联盟二区
  CQ100: 'cq100-sgp.lol.qq.com:21019'       // 联盟三区
};

let tokenCache = { token: null, t: 0 };
let leagueSessionTokenCache = { token: null, t: 0 };

async function getToken(force) {
  if (!force && tokenCache.token && Date.now() - tokenCache.t < 10 * 60 * 1000) return tokenCache.token;
  const ent = await lcu.lcuRequest('GET', '/entitlements/v1/token');
  if (!ent || !ent.accessToken) throw new Error('无法获取 SGP 凭证 (需要客户端已登录)');
  tokenCache = { token: ent.accessToken, t: Date.now() };
  return tokenCache.token;
}

async function getLeagueSessionToken(force) {
  if (!force && leagueSessionTokenCache.token && Date.now() - leagueSessionTokenCache.t < 10 * 60 * 1000) {
    return leagueSessionTokenCache.token;
  }
  const token = await lcu.lcuRequest('GET', '/lol-league-session/v1/league-session-token');
  if (!token || typeof token !== 'string') throw new Error('无法获取召唤师档案凭证 (需要客户端已登录)');
  leagueSessionTokenCache = { token, t: Date.now() };
  return token;
}

function rawRequest(host, path, token, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    // host 形如 "hn1-k8s-sgp.lol.qq.com:21019", 需拆分主机与端口
    const [hostname, port] = host.split(':');
    if (process.env.SGP_DEBUG) console.log('[sgp debug]', hostname, port, path.substring(0, 60), 'token:', token.length);
    const payload = body == null ? null : JSON.stringify(body);
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
    if (payload != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request({
      hostname, port: port || 443, path, method, rejectUnauthorized: true, timeout: 10000, agent: sgpAgent,
      headers
    }, res => {
      if (process.env.SGP_DEBUG) console.log('[sgp debug] status:', res.statusCode);
      let data = '';
      const decoder = new StringDecoder('utf8');
      let bytes = 0;
      res.on('data', c => {
        bytes += c.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('SGP 响应过大'));
          return;
        }
        data += decoder.write(c);
      });
      res.on('end', () => {
        data += decoder.end();
        if (res.statusCode === 401) {
          const err = new Error('SGP 凭证过期');
          err.authFail = true;
          return reject(err);
        }
        if (res.statusCode !== 200) {
          const err = new Error('SGP HTTP ' + res.statusCode);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('SGP 响应解析失败')); }
      });
    });
    req.on('error', e => reject(new Error('SGP 连接失败: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('SGP 请求超时')); });
    if (payload != null) req.write(payload);
    req.end();
  });
}

async function sgpRequest(platformId, path) {
  const host = SGP_HOSTS[platformId];
  if (!host) throw new Error('暂不支持该大区: ' + platformId);
  let lastErr = null;
  // 凭证过期、限流、网关抖动和瞬时网络错误采用短退避重试。
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const token = await getToken(false);
      return await rawRequest(host, path, token);
    } catch (e) {
      lastErr = e;
      if (e.authFail) tokenCache = { token: null, t: 0 };
      const retryable = e.authFail || e.statusCode === 404 || e.statusCode === 429 || e.statusCode >= 500 || /ECONNRESET|ETIMEDOUT|超时/.test(e.message);
      if (!retryable || attempt === 2) throw e;
      await delay(300 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

// 玩家历史战绩 (完整 Match-V5 格式, 支持分页/队列筛选)
async function matchHistory(platformId, puuid, startIndex, count, tag) {
  let path = `/match-history-query/v1/products/lol/player/${puuid}/SUMMARY?startIndex=${startIndex}&count=${count}`;
  if (tag) path += `&tag=${tag}&tagsQueryType=OR`;
  return sgpRequest(platformId, path);
}

// 单场对局详情 (全部玩家)
async function gameSummary(platformId, gameId) {
  return sgpRequest(platformId, `/match-history-query/v1/products/lol/${platformId}_${gameId}/SUMMARY`);
}

// 单场对局完整详情 (含符文/时间线等, 参考 LeagueAkari)
async function gameDetails(platformId, gameId) {
  return sgpRequest(platformId, `/match-history-query/v1/products/lol/${platformId}_${gameId}/DETAILS`);
}

// 跨区召唤师档案。与战绩接口不同，这个接口即使玩家近期没有公开对局也能准确
// 判断所属大区，并返回账号等级与头像，因此自动查区必须优先使用它。
async function summonerByPuuid(platformId, puuid) {
  const host = SGP_HOSTS[platformId];
  if (!host) throw new Error('暂不支持该大区: ' + platformId);
  let token = await getLeagueSessionToken(false);
  const path = `/summoner-ledge/v1/regions/${platformId}/summoners/puuids`;
  try {
    const rows = await rawRequest(host, path, token, 'POST', [puuid]);
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (e) {
    if (!e.authFail) throw e;
    leagueSessionTokenCache = { token: null, t: 0 };
    token = await getLeagueSessionToken(true);
    const rows = await rawRequest(host, path, token, 'POST', [puuid]);
    return Array.isArray(rows) ? rows[0] || null : null;
  }
}

module.exports = { matchHistory, gameSummary, gameDetails, summonerByPuuid, SGP_HOSTS };
