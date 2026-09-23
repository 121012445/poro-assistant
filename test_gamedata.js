// gamedata 磁盘缓存单测: 落盘/命中/网络回退/路径穿越防护/版本裁剪
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore, compareVersionDesc, KEEP_VERSIONS } = require('./main/gamedata');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poro-gamedata-'));
const store = createStore(root, () => {});

// 版本号必须按数值段比较, 字符串比较会把 14.9.1 排在 14.18.1 前面
assert.ok(compareVersionDesc('14.18.1', '14.9.1') < 0, '14.18.1 应排在 14.9.1 之前');
assert.ok(compareVersionDesc('14.9.1', '14.18.1') > 0, '14.9.1 应排在 14.18.1 之后');
assert.strictEqual(compareVersionDesc('14.18.1', '14.18.1'), 0, '同版本应相等');

// 路径穿越: 版本号与子路径都来自外部输入, 必须逐段白名单校验
assert.strictEqual(store.resolve('14.18.1', '../../evil.json'), null, '子路径含 .. 必须拒绝');
assert.strictEqual(store.resolve('../etc', 'a.json'), null, '版本号含 .. 必须被清洗后拒绝');
assert.strictEqual(store.resolve('', 'a.json'), null, '空版本号必须拒绝');
assert.strictEqual(store.resolve('14.18.1', ''), null, '空子路径必须拒绝');
assert.strictEqual(store.resolve('14.18.1', 'champion/Ahri.json'),
  path.join(root, '14.18.1', 'champion', 'Ahri.json'), '正常多级路径应解析正确');

(async () => {
  const payload = { type: 'champion', data: { Ahri: { id: 'Ahri' } } };

  // 1) 首次取数: 走网络并落盘
  let networkCalls = 0;
  const first = await store.get('champion.json', '14.18.1', async () => { networkCalls++; return payload; });
  assert.strictEqual(first.source, 'network', '首次应走网络');
  assert.strictEqual(networkCalls, 1, '网络应只被调用一次');
  assert.deepStrictEqual(first.data, payload, '返回数据应与网络一致');
  assert.ok(fs.existsSync(path.join(root, '14.18.1', 'champion.json')), '应落盘 champion.json');

  // 2) 二次取数: 直接命中磁盘, 不再走网络
  const second = await store.get('champion.json', '14.18.1', async () => { networkCalls++; return null; });
  assert.strictEqual(second.source, 'disk', '二次应命中磁盘');
  assert.strictEqual(networkCalls, 1, '命中磁盘时不应再发起网络请求');
  assert.deepStrictEqual(second.data, payload, '磁盘数据应与写入一致');

  // 3) 新版本 + 网络失败: 回退到磁盘上最新的完整缓存
  const fallback = await store.get('champion.json', '14.19.1', async () => { throw new Error('模拟断网'); });
  assert.strictEqual(fallback.source, 'disk-fallback', '网络失败应回退到磁盘缓存');
  assert.strictEqual(fallback.version, '14.18.1', '应回退到已有缓存版本');
  assert.deepStrictEqual(fallback.data, payload, '回退数据应可用');

  // 4) 全新版本且网络失败且无任何缓存: 返回 null, 由调用方决定降级
  const empty = await store.get('item.json', '99.0.1', async () => { throw new Error('模拟断网'); });
  assert.strictEqual(empty, null, '无任何缓存时应返回 null');

  // 5) 缓存文件损坏: 视为未命中, 重新走网络而不是把坏数据交给渲染层
  fs.writeFileSync(path.join(root, '14.18.1', 'item.json'), '{ 坏掉的 JSON', 'utf8');
  const repaired = await store.get('item.json', '14.18.1', async () => ({ data: { 1001: {} } }));
  assert.strictEqual(repaired.source, 'network', '损坏缓存应重新拉取');
  assert.ok(repaired.data.data['1001'], '修复后应拿到有效数据');

  // 6) 版本裁剪: 只保留最近 KEEP_VERSIONS 个目录
  for (const v of ['13.1.1', '13.2.1', '13.3.1', '13.4.1']) store.write(v, 'champion.json', payload);
  store.prune();
  const left = fs.readdirSync(root).filter(d => /^[0-9]/.test(d));
  assert.strictEqual(left.length, KEEP_VERSIONS, `裁剪后应只剩 ${KEEP_VERSIONS} 个版本目录, 实际 ${left.length}`);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('gamedata 缓存测试通过');
})().catch(error => {
  console.error('gamedata 缓存测试失败: ' + error.message);
  process.exit(1);
});
