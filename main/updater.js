'use strict';
// 软件更新: 查 GitHub Releases 最新版 → 用户点击后下载安装包 → 校验大小与 sha256 → 启动安装程序。
//
// 安全边界 (不使用 electron-updater, 不引入新依赖):
//   · 只认本仓库 latest release 里、文件名与版本号严格匹配的安装包; 下载地址只能来自上一次检查的结果,
//     渲染层不能传入任意 URL
//   · 只走 https, 重定向只跟随到 github.com / *.githubusercontent.com, 最多 5 次
//   · 下载大小必须等于 release 标注的大小, sha256 必须等于 GitHub 给出的 digest; 没有 digest 的资源不自动安装
//   · 从不静默安装: 由用户点击后启动安装程序 (NSIS 向导照常显示), Poro 随即退出以便覆盖文件
//   · 正式版 / 受限版按当前是否以管理员运行选择, 与当前版本保持一致

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const UPDATE_REPO = '121012445/poro-assistant';
const API_HOST = 'api.github.com';
const MAX_REDIRECTS = 5;
const MAX_ASSET_BYTES = 400 * 1024 * 1024;
const ALLOWED_DOWNLOAD_HOSTS = [/^github\.com$/i, /^([a-z0-9-]+\.)*githubusercontent\.com$/i];

// 1.5.10 > 1.5.9; 只比较数字段, 带预发布后缀的版本 (1.6.0-beta) 视为低于正式版
function compareVersions(a, b) {
  const parse = v => {
    const m = /^v?(\d+(?:\.\d+)*)(-.+)?$/.exec(String(v || '').trim());
    return m ? { nums: m[1].split('.').map(Number), pre: !!m[2] } : null;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (x.pre !== y.pre) return x.pre ? -1 : 1;
  return 0;
}

function pickAsset(assets, version, edition) {
  const want = edition === 'limited' ? `Poro-Setup-${version}-limited.exe` : `Poro-Setup-${version}.exe`;
  const asset = (Array.isArray(assets) ? assets : []).find(a => a && a.name === want);
  if (!asset) return null;
  const size = Number(asset.size);
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''));
  if (!Number.isInteger(size) || size <= 0 || size > MAX_ASSET_BYTES) return null;
  let url;
  try { url = new URL(String(asset.browser_download_url || '')); } catch (e) { return null; }
  if (url.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.some(re => re.test(url.hostname))) return null;
  return { name: asset.name, size, sha256: m ? m[1].toLowerCase() : '', url: url.toString() };
}

function isAllowedDownloadUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && ALLOWED_DOWNLOAD_HOSTS.some(re => re.test(u.hostname));
  } catch (e) { return false; }
}

// deps: { getJson(host, path, headers), httpsGet(url, headers) → Promise<res>, currentVersion(), edition(),
//         tmpDir(), spawnInstaller(file), quit(), now() }
function createUpdater(deps) {
  const d = deps || {};
  const now = typeof d.now === 'function' ? d.now : Date.now;
  let last = null;           // 上一次检查结果
  let downloading = null;    // Promise
  let downloaded = null;     // { file, version }

  async function check() {
    const current = String(d.currentVersion() || '');
    const rel = await d.getJson(API_HOST, `/repos/${UPDATE_REPO}/releases/latest`, { Accept: 'application/vnd.github+json' });
    const version = String(rel && rel.tag_name || '').replace(/^v/, '');
    if (!/^\d+(\.\d+){1,3}$/.test(version)) throw new Error('发布信息无效');
    const edition = d.edition() === 'limited' ? 'limited' : 'full';
    const available = compareVersions(version, current) > 0;
    const asset = available ? pickAsset(rel.assets, version, edition) : null;
    const pageUrl = `https://github.com/${UPDATE_REPO}/releases/tag/v${version}`;
    last = {
      checkedAt: now(), current, version, available, edition,
      notes: String(rel.body || '').slice(0, 4000),
      publishedAt: String(rel.published_at || ''),
      pageUrl,
      asset,
      // 有新版但找不到可校验的安装包: 只给发布页链接, 不自动安装
      installable: !!(asset && asset.sha256)
    };
    if (downloaded && downloaded.version !== version) downloaded = null;
    return publicInfo(last);
  }

  function publicInfo(info) {
    if (!info) return null;
    const { asset, ...rest } = info;
    return Object.assign(rest, { assetName: asset ? asset.name : '', assetSize: asset ? asset.size : 0, downloaded: !!(downloaded && downloaded.version === info.version) });
  }

  async function fetchFollowing(url, redirectsLeft) {
    if (!isAllowedDownloadUrl(url)) throw new Error('下载地址不在允许范围内');
    const res = await d.httpsGet(url, { 'User-Agent': 'Poro-Updater', Accept: 'application/octet-stream' });
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      res.resume && res.resume();
      if (redirectsLeft <= 0) throw new Error('重定向次数过多');
      const next = new URL(String(res.headers && res.headers.location || ''), url).toString();
      return fetchFollowing(next, redirectsLeft - 1);
    }
    if (res.statusCode !== 200) { res.resume && res.resume(); throw new Error('下载失败 HTTP ' + res.statusCode); }
    return res;
  }

  function download(onProgress) {
    if (!last || !last.available || !last.installable) return Promise.reject(new Error('没有可安装的更新, 请先检查更新'));
    if (downloaded && downloaded.version === last.version) return Promise.resolve({ file: downloaded.file, version: downloaded.version });
    if (downloading) return downloading;
    const info = last;
    const asset = info.asset;
    downloading = (async () => {
      const dir = d.tmpDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, asset.name);
      const part = file + '.part';
      try { fs.unlinkSync(part); } catch (e) {}
      const res = await fetchFollowing(asset.url, MAX_REDIRECTS);
      const hash = crypto.createHash('sha256');
      let received = 0;
      // 任何失败路径都不能在磁盘上留下半个安装包
      const removePart = () => { try { fs.unlinkSync(part); } catch (e) {} };
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(part);
        let failed = false;
        const fail = err => {
          if (failed) return;
          failed = true;
          try { res.destroy && res.destroy(); } catch (e) {}
          // 写入流关闭之后再删除, 否则 Windows 上文件仍被占用会删不掉
          out.once('close', () => { removePart(); reject(err); });
          out.destroy();
        };
        res.on('data', chunk => {
          received += chunk.length;
          if (received > asset.size) return fail(new Error('下载大小超出发布标注'));
          hash.update(chunk);
          if (!out.write(chunk)) { res.pause && res.pause(); out.once('drain', () => res.resume && res.resume()); }
          if (onProgress) { try { onProgress({ received, total: asset.size }); } catch (e) {} }
        });
        res.on('error', fail);
        out.on('error', fail);
        res.on('end', () => { if (!failed) out.end(); });
        out.on('finish', () => { if (!failed) resolve(); });
      });
      if (received !== asset.size) { removePart(); throw new Error(`下载不完整 (${received}/${asset.size} 字节)`); }
      const sha = hash.digest('hex');
      if (sha !== asset.sha256) { removePart(); throw new Error('安装包校验失败 (sha256 不一致), 已删除'); }
      try { fs.unlinkSync(file); } catch (e) {}
      fs.renameSync(part, file);
      downloaded = { file, version: info.version };
      return { file, version: info.version };
    })().finally(() => { downloading = null; });
    return downloading;
  }

  function install() {
    if (!downloaded || !last || downloaded.version !== last.version) throw new Error('安装包尚未下载完成');
    if (!fs.existsSync(downloaded.file)) { downloaded = null; throw new Error('安装包已不存在, 请重新下载'); }
    d.spawnInstaller(downloaded.file);
    d.quit();
    return true;
  }

  return { check, download, install, status: () => publicInfo(last) };
}

module.exports = { createUpdater, compareVersions, pickAsset, isAllowedDownloadUrl, UPDATE_REPO };
