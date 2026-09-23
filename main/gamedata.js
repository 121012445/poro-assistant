// Data Dragon 静态数据磁盘缓存
// 英雄/装备/召唤师技能 JSON 合计约 5MB, 每次启动全量走网络在国服经常超时导致首屏空白。
// 策略: 按版本号落盘到 <baseDir>/<version>/, 启动优先读盘; 网络只用于探测版本,
// 探测失败时回退到磁盘上最新的缓存版本 (而不是硬编码版本号), 断网也能正常打开。
const fs = require('fs');
const path = require('path');

const KEEP_VERSIONS = 3;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const SEGMENT_RE = /^[0-9A-Za-z._-]+$/;

// 版本号排序 (14.9.1 < 14.18.1, 直接字符串比较会排错)
function compareVersionDesc(a, b) {
  const x = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const y = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (y[i] || 0) - (x[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function createStore(baseDir, onLog) {
  const log = typeof onLog === 'function' ? onLog : () => {};

  // 版本号与子路径都来自外部输入, 必须严格校验, 防止路径穿越
  function resolve(version, relPath) {
    // 版本号形如 14.18.1: 必须数字开头, 只含版本号允许的字符, 且不得出现 ..
    const raw = String(version == null ? '' : version).trim();
    if (!/^\d[0-9A-Za-z._-]*$/.test(raw) || raw.includes('..')) return null;
    const segments = String(relPath || '').split('/').filter(Boolean);
    if (!segments.length || segments.some(s => s === '.' || s === '..' || !SEGMENT_RE.test(s))) return null;
    return path.join(baseDir, raw, ...segments);
  }

  function read(version, relPath) {
    const target = resolve(version, relPath);
    if (!target) return null;
    try {
      const st = fs.statSync(target);
      if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES) return null;
      return JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (e) { return null; }
  }

  function write(version, relPath, data) {
    const target = resolve(version, relPath);
    if (!target) return false;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // 先写临时文件再改名, 避免写入中断留下半个 JSON
      const tmp = target + '.poro-tmp';
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, target);
      return true;
    } catch (e) { log('[GAMEDATA] 写入 ' + relPath + ' 失败: ' + e.message); return false; }
  }

  function cachedVersions() {
    try {
      return fs.readdirSync(baseDir)
        .filter(d => /^[0-9]/.test(d) && fs.existsSync(path.join(baseDir, d, 'champion.json')))
        .sort(compareVersionDesc);
    } catch (e) { return []; }
  }

  // 网络不可用时的兜底: 用磁盘上最新的完整缓存
  function fallback(relPath, excludeVersion) {
    for (const v of cachedVersions()) {
      if (v === excludeVersion) continue;
      const data = read(v, relPath);
      if (data) return { version: v, data };
    }
    return null;
  }

  // 只保留最近 N 个版本目录, 防止无限增长
  function prune() {
    try {
      const dirs = fs.readdirSync(baseDir).filter(d => /^[0-9]/.test(d));
      if (dirs.length <= KEEP_VERSIONS) return;
      const mtime = d => { try { return fs.statSync(path.join(baseDir, d)).mtimeMs; } catch (e) { return 0; } };
      for (const d of dirs.sort((a, b) => mtime(b) - mtime(a)).slice(KEEP_VERSIONS)) {
        try { fs.rmSync(path.join(baseDir, d), { recursive: true, force: true }); } catch (e) {}
      }
    } catch (e) {}
  }

  // 统一取数: 磁盘 -> 网络(并落盘) -> 其他版本缓存兜底
  async function get(relPath, version, networkFetch) {
    const cached = read(version, relPath);
    if (cached) return { version, data: cached, source: 'disk' };
    try {
      const data = await networkFetch(version);
      if (data) {
        write(version, relPath, data);
        prune();
        return { version, data, source: 'network' };
      }
    } catch (e) {
      log('[GAMEDATA] ' + relPath + ' @' + version + ' 拉取失败: ' + e.message);
    }
    const hit = fallback(relPath, version);
    return hit ? { version: hit.version, data: hit.data, source: 'disk-fallback' } : null;
  }

  return { baseDir, resolve, read, write, cachedVersions, fallback, prune, get };
}

module.exports = { createStore, compareVersionDesc, KEEP_VERSIONS };
