// 玩家索引: 让战绩查询支持"只输名字"的模糊搜索。
//
// 为什么不用 Akari 那套: 它的模糊查询是调 Riot Client 的
// /player-account/aliases/v1/lookup?gameName=xxx, 连接参数来自客户端命令行里的
// --riotclient-app-port / --riotclient-auth-token。**国服客户端没有这两个参数**
// (实测最新 LeagueClientUx.log 只有 --app-port / --remoting-auth-token), 所以那条
// 通道在国服根本不存在, 也没有公开的腾讯后台联想接口可替代。
//
// 能做的: 把 Poro 已经见过的玩家 (好友列表 / 最近对局的所有参与者 / 查过的人)
// 攒成本地索引, 输入时做前缀与子串匹配 —— 实际使用中要查的人九成是"刚遇到的那个",
// 这个覆盖面足够, 也不需要任何额外接口。
//
// 同一个人可能同时存在"搜索记录"和"战绩记录"两条 (一个有 puuid 一个没有),
// 候选里并排显示两个一模一样的 名字#Tag, 会让人以为同名有两个账号。
// 按 label 去重, 保留信息更全的那条 (有 puuid > 有等级 > 有头像)。
function piUniqByLabel(list) {
  const seen = new Map();
  const rich = x => (x.puuid ? 2 : 0) + (x.level ? 1 : 0) + (x.icon ? 1 : 0);
  for (const c of (list || [])) {
    if (!c) continue;
    const k = piNorm(c.label || (c.name + '#' + (c.tag || '')));
    const prev = seen.get(k);
    if (!prev || rich(c) > rich(prev)) seen.set(k, c);
  }
  return [...seen.values()];
}

// 匹配优先级 (同名不同 Tag 很常见, 必须让精确的那个排前面):
//   全名(含tag)完全一致 > 名字完全一致 > 名字前缀 > 全名前缀 > 名字子串 > 全名子串
// 时间作为次级排序: 近期一起打过的排前面。
//
// 带 # 的查询单独一条链路 (对齐 Akari 的手感): 输入 "名字#" 列出这个人所有 Tag,
// 继续输入数字 "名字#12" 按 Tag 前缀逐位收窄。所以这里绝不能拿整串去和
// "名字#Tag" 做 startsWith —— 那样 "雨#" 匹配不到 "雨未散#1234", 输入到第二个字
// 就没结果了。

const PI_STORE_KEY = 'poroPlayerIndex.v1';
const PI_MAX = 1500;              // 上限: 约 1500 人 × 90 字节, localStorage 无压力
// 别名接口带回来的"归属未知/外区、无等级"条目单独占的池子上限
const PI_ALIAS_POOL = 300;
const PI_KEEP_DAYS = 240;         // 8 个月没再出现的老记录在裁剪时优先淘汰
const PI_MIN_QUERY = 1;           // 单字即可匹配 (中文一个字的信息量已经够)

let _piCache = null;

// 归一化: 全角井号统一、连续空白压成单个空格、小写。
// 玩家名里带空格是合法的 (如 "雨 未散"), 不能把空格全删掉, 否则
// "雨未散" 与 "雨 未散" 会被误判成同一个 key。
function piNorm(s) {
  return String(s == null ? '' : s)
    .replace(/[＃﹟]/g, '#')
    .replace(/[\u3000\t\r\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

// 去掉名字里自带的 #tag, 拆成 { name, tag }
function piSplitName(raw) {
  const s = String(raw == null ? '' : raw).replace(/[＃﹟]/g, '#').trim();
  const at = s.lastIndexOf('#');
  if (at > 0 && at < s.length - 1) return { name: s.slice(0, at).trim(), tag: s.slice(at + 1).trim() };
  return { name: s, tag: '' };
}

function piStore() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
}

function piLoad() {
  if (_piCache) return _piCache;
  let list = [];
  try {
    const raw = piStore() && piStore().getItem(PI_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed.filter(e => e && e.n);
    }
  } catch (e) { list = []; }   // 损坏就当空索引重建, 不能因为索引坏了影响查询
  _piCache = list;
  // 一次性修复历史脏数据: 早期版本把战绩/好友里的**英雄等级**(1~18)当成召唤师
  // 等级写进 l, 候选里于是显示 "Lv18", 点进去实际是 1367 级。正常账号等级都在
  // 30 以上, 所以 1~20 且出自战绩/好友的一律清掉 —— 宁可暂时不显示等级,
  // 也不能显示错的。清完立刻回写, 下次启动不用再扫。
  let fixed = 0;
  for (const e of list) {
    if ((e.s === 'match' || e.s === 'friend') && e.l > 0 && e.l <= 20) { e.l = 0; fixed++; }
  }
  if (fixed) piPersist();
  return _piCache;
}

function piPersist() {
  try {
    const st = piStore();
    if (st) st.setItem(PI_STORE_KEY, JSON.stringify(_piCache || []));
  } catch (e) { /* 配额满/隐私模式: 索引退化成内存态, 不影响当次查询 */ }
}

function piKeyOf(entry) {
  if (entry.p) return 'p:' + entry.p;
  return 'n:' + piNorm(entry.n) + '#' + piNorm(entry.t);
}

// 写入/更新。list 元素: { puuid | name, tag, icon, level, src }
// 同一个人 (同 puuid, 或同名同 tag) 只保留一条, 后到的非空字段补全旧记录。
function playerIndexUpsert(list, src) {
  const idx = piLoad();
  if (!Array.isArray(list) || !list.length) return 0;
  const byKey = new Map();
  for (const e of idx) byKey.set(piKeyOf(e), e);
  let changed = 0;
  const now = Date.now();
  for (const it of list) {
    if (!it) continue;
    const split = piSplitName(it.name || it.gameName || it.displayName || '');
    const name = split.name;
    if (!name) continue;
    const tag = String(it.tag || it.tagLine || it.gameTag || split.tag || '').trim();
    const puuid = String(it.puuid || it.id || '').trim();
    const probe = { n: name, t: tag, p: puuid };
    const key = piKeyOf(probe);
    const prev = byKey.get(key);
    if (prev) {
      // 已在索引: 只补全缺失字段 + 刷新时间, 名字大小写以最新一次为准
      if (prev.n !== name) { prev.n = name; changed++; }
      if (!prev.t && tag) { prev.t = tag; changed++; }
      if (!prev.p && puuid) { prev.p = puuid; changed++; }
      if (src === 'search') {
        // 用户亲手点开的那个账号, 档案来自 LCU 全量解析 → 等级/头像权威, 直接覆盖。
        // 其余来源只在空着时补, 免得把权威值冲掉。
        if (it.icon && prev.i !== it.icon) { prev.i = it.icon; changed++; }
        if (it.level && prev.l !== it.level) { prev.l = it.level; changed++; }
      } else {
        if (!prev.i && it.icon) { prev.i = it.icon; changed++; }
        if (!prev.l && it.level) { prev.l = it.level; changed++; }
      }
      // 好友/战绩里出现 = 本区确认存在, 之前从别名接口带来"归属未知/其它大区"都作废
      if ((prev.u || prev.x) && src && src !== 'alias') { prev.u = 0; prev.x = 0; changed++; }
      prev.ts = now;
      prev.s = src || prev.s || '';
      continue;
    }
    const entry = { n: name, t: tag, p: puuid, i: it.icon || 0, l: it.level || 0, s: src || '', ts: now };
    idx.push(entry);
    byKey.set(key, entry);
    changed++;
  }
  if (!changed) return 0;
  piTrim();
  piPersist();
  return changed;
}

// 裁剪: 先淘汰太久没出现的, 仍然超限就保留数组尾部。
// 数组顺序即写入顺序 (旧 → 新), 直接砍头部比按时间排序可靠 —— 批量导入战绩时
// 几百条记录的 ts 是同一个毫秒, 按时间排序结果不稳定, 可能把刚导入的挤掉。
function piTrim() {
  const idx = _piCache || [];
  if (!idx.length) return;
  const cutoff = Date.now() - PI_KEEP_DAYS * 24 * 3600 * 1000;
  let kept = idx.filter(e => !e.ts || e.ts >= cutoff);
  // 别名接口带回来的"归属未知/外区、还没等级"条目单独限额。它们只是"这个名字
  // 还有哪些区的 ID", 却最容易成批涌进来 (一次 60 条); 而真实一起打过的人一条
  // 都不能丢。2026-11-05 事故: 索引满 1500 时, 新查到的「巧丝绒」3 条因为无等级
  // + 归属未知被当成垃圾当场淘汰, 用户搜完永远看不到 —— 所以这里按池子限额,
  // 只淘汰池子里最老的, 不碰其它来源。
  const isVague = e => e.s === 'alias' && !e.l && (e.x || e.u);
  const vague = kept.filter(isVague);
  if (vague.length > PI_ALIAS_POOL) {
    vague.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const dropVague = new Set(vague.slice(0, vague.length - PI_ALIAS_POOL));
    kept = kept.filter(e => !dropVague.has(e));
  }
  // 真实记录单独算配额: 查一个陌生名字最多往"待定池"里加人, 不能把一起打过的人
  // 挤出去。之前是混着算的, 索引满 1500 时查一次人就会顶掉 3 个老队友。
  const realCount = kept.reduce((n, e) => n + (isVague(e) ? 0 : 1), 0);
  if (realCount > PI_MAX) {
    const byOld = kept.filter(e => !isVague(e)).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const drop = new Set(byOld.slice(0, realCount - PI_MAX));
    kept = kept.filter(e => !drop.has(e));
  }
  _piCache = kept;
}

function piLabel(entry) {
  return entry.t ? entry.n + '#' + entry.t : entry.n;
}

// 对外统一字段名 (内部存的是短键 n/t/p 以省空间)
function piOut(e, extra) {
  return Object.assign({
    name: e.n, tag: e.t || '', puuid: e.p || '', icon: e.i || 0, level: e.l || 0,
    src: e.s || '', ts: e.ts || 0, foreign: !!e.x, regionUnknown: !!e.u,
    platform: e.pf || '', label: piLabel(e)
  }, extra || {});
}

// 把查询拆成 名字 与 Tag 片段。最后一个 # 之后算 Tag 片段 (可以为空, 表示
// "刚打完井号, 还没开始筛")。
function piSplitQuery(query) {
  const s = piNorm(query);
  const at = s.lastIndexOf('#');
  if (at < 0) return { name: s, tag: '', hasTag: false };
  return { name: s.slice(0, at).trim(), tag: s.slice(at + 1).trim(), hasTag: true };
}

// 带 Tag 时的打分: 名字与 Tag 分开算, 再相加。
// Tag 只认前缀 —— 输入 "#12" 应该只剩 12xx, 要是允许"包含", 输入一位数字时
// 几乎全库的人都会冒出来, 就不叫筛选了。
function piScoreWithTag(n, tag, qName, qTag) {
  let nameScore;
  if (!qName) nameScore = 18;                       // 只输了 "#数字": 全库按 Tag 筛
  else if (n === qName) nameScore = 60;
  else if (n.startsWith(qName)) nameScore = 50;
  else if (n.includes(qName)) nameScore = 32;
  else return 0;
  if (!qTag) return tag ? nameScore + 8 : nameScore;
  if (!tag) return 0;
  if (tag === qTag) return nameScore + 40;
  if (tag.startsWith(qTag)) return nameScore + 34;
  return 0;
}

// 2026-11-05 决策 (对齐 LeagueAkari): 候选层只对"完整名字"负责。
// 以前这里有编辑距离近似 + 尾部裁字的"猜名字", 结果是把「巧克力」「巧遇記」当成
// 「巧丝绒」的近似推给用户, 看起来像搜坏了; 而真正的完整名字命中反而被稀释。
// Riot 别名接口本来只做完整名字精确匹配, 近似只是本地猜测, 一律去掉。

// 本地候选搜索。返回 [{ name, tag, puuid, icon, level, src, ts, score, label }]
// 只做字面匹配: 整串相等 > 名字相等 > 名字前缀 > 整串前缀 > 名字子串 > 整串子串。
// 不再做编辑距离近似 —— 命中不了就老实说命中不了。
function playerIndexSearch(query, limit) {
  const q = piNorm(query);
  const max = limit > 0 ? limit : 8;
  if (!q || q.length < PI_MIN_QUERY) return [];
  const sq = piSplitQuery(q);
  const hasTag = sq.hasTag;
  if (hasTag && !sq.name && !sq.tag) return [];   // 只打了个 # : 不列全库
  const out = [];
  for (const e of piLoad()) {
    const n = piNorm(e.n);
    const full = piNorm(piLabel(e));
    let score = 0;
    if (hasTag) {
      score = piScoreWithTag(n, piNorm(e.t), sq.name, sq.tag);
    } else if (full === q) score = 100;
    else if (n === q) score = 92;
    else if (n.startsWith(q)) score = 80;
    else if (full.startsWith(q)) score = 72;
    else if (n.includes(q)) score = 56;
    else if (full.includes(q)) score = 36;
    if (score > 0) out.push(piOut(e, { score }));
  }
  const hits = out;  // 同一分数下, 一起打过/刚见过的排前面; 名字短的优先 (搜 "雨" 时 "雨未散" 应比
  // "雨未散的影子" 靠前 —— 前缀匹配已经区分了这点, 这里再兜一层长度差)。
  // 排序同时按大区归属分层: 本区 > 归属未知 > 其它大区。名字再像也查不到战绩的
  // 不能占住前排。
  const regionRank = e => (e.foreign ? 2 : (e.regionUnknown ? 1 : 0));
  hits.sort((a, b) => (regionRank(a) - regionRank(b)) ||
    (b.score - a.score) || ((b.ts || 0) - (a.ts || 0)) || (a.label.length - b.label.length));
  return piUniqByLabel(hits).slice(0, max);
}

// 按 label 找一条记录 (点击候选时判断是否本区)
function playerIndexFind(label) {
  const q = piNorm(label);
  if (!q) return null;
  let foreignHit = null;
  for (const e of piLoad()) {
    if (piNorm(piLabel(e)) !== q) continue;
    if (!e.x) return piOut(e);
    foreignHit = foreignHit || piOut(e);
  }
  return foreignHit;
}

// 精确找一个人: 用于"用户直接回车但没输完整"时判断能否唯一确定
function playerIndexResolve(query) {
  const q = piNorm(query);
  if (!q) return { type: 'empty' };
  const idx = piLoad();
  const sq = piSplitQuery(q);
  if (!sq.hasTag) {
    // 其它大区的同名账号不能参与"唯一确定": 自动补全过去必然查不到战绩。
    // 归属还没解析出来的 (u) 同样不参与 —— 宁让用户点一下, 也别自动跳到别的区。
    const same = idx.filter(e => piNorm(e.n) === q && !e.x && !e.u);
    if (same.length === 1) return { type: 'exact', entry: piOut(same[0]) };
    if (same.length > 1)     {
      // 去重后如果只剩一个人 (搜索记录与战绩记录指向同一个账号), 直接算确定
      const uniq = piUniqByLabel(same.map(e => piOut(e)));
      if (uniq.length === 1) return { type: 'exact', entry: uniq[0] };
      return { type: 'ambiguous', candidates: uniq };
    }
    const fuzzy = playerIndexSearch(query, 6);
    if (!fuzzy.length) return { type: 'none' };
    // 只有一个候选时也不要自动替他选: 输入 "雨" 匹配到 "雨未散#1234" 就跳过去,
    // 名字相近的人很容易查错人, 让用户点一下更稳妥。
    return { type: 'candidates', candidates: fuzzy };
  }
  // 带 #: 整串完全一致才算"确定"
  const exact = idx.find(e => piNorm(piLabel(e)) === q && !e.x && !e.u);
  if (exact) return { type: 'exact', entry: piOut(exact) };
  const fuzzy = playerIndexSearch(query, 8);
  if (!fuzzy.length) return { type: 'none' };
  // 只有一个人满足前缀且已经能定到唯一一个 Tag 时, 回车直接查, 不用再点一下
  const local = fuzzy.filter(e => !e.foreign && !e.regionUnknown);
  if (local.length === 1 && piNorm(local[0].label).startsWith(q)) return { type: 'exact', entry: local[0] };
  return { type: 'candidates', candidates: fuzzy };
}

function playerIndexSize() { return piLoad().length; }

// 回车时的决策 (渲染层只负责执行, 判断逻辑放这里才测得到):
//   empty       没输入
//   passthrough 交给原精确查询 (索引里没有这个人 → 可能是没见过的玩家)
//   exact       索引里唯一确定 → 直接用补全后的 名字#Tag 查
//   choose      有候选 → 展示下拉让用户点
// 注意带 # 的输入也要先过一遍索引: 以前这里见到 # 就直接 passthrough, 于是
// "名字#1" 这种半截 Tag 被原样丢给 LCU, 那边要求完整 Riot ID, 直接 422。
// 是否是"完整 Riot ID"形式的输入: 名字#数字, 且数字够长 (真 Tag 一般 3~5 位)。
// 用途: 用户已经把账号指定到唯一一个了, 就不该再拿候选列表拦他。
function playerIndexFullTag(raw) {
  const q = String(raw == null ? '' : raw).trim().replace(/[＃﹟]/g, '#');
  const m = /^(.+)#(\d{3,})$/.exec(q);
  return !!m;
}

function playerIndexDecide(raw) {
  const q = String(raw == null ? '' : raw).trim().replace(/[＃﹟]/g, '#');
  if (!q) return { action: 'empty' };
  const r = playerIndexResolve(q);
  if (r.type === 'exact' && r.entry && r.entry.tag) return { action: 'exact', label: r.entry.label };
  // 完整「名字#Tag」= 用户已经精确指定账号, 本地没收录就交给客户端直接查。
  // 以前这里会退化成"从候选里挑一个", 于是输入完整 Tag 反而被下拉拦住, 看起来
  // 像"查不到这个人"; 实际 LCU 按完整 Riot ID 一查就能查到。
  if (playerIndexFullTag(q)) return { action: 'passthrough', label: q };
  if (r.type === 'ambiguous' || r.type === 'candidates') return { action: 'choose', candidates: r.candidates || [] };
  return { action: 'passthrough', label: q };
}

// 完整「名字#Tag」打完就能自动查, 不必再按一次回车。返回可以直接查的 label;
// 空串 = 不自动查, 留给用户自己决定。三个前提缺一不可:
//   - 是完整 Riot ID 形式 (名字#≥3 位数字)
//   - 本地索引能精确对到这一条 (对不到就去查, 打错一个字的代价是弹一屏报错)
//   - 不明确在其它大区 (LCU 在本区查外区账号必定 404)
function playerIndexAutoGoTarget(raw) {
  const q = String(raw == null ? '' : raw).trim().replace(/[＃﹟]/g, '#');
  if (!q || !playerIndexFullTag(q)) return '';
  const hit = playerIndexFind(q);
  if (!hit || hit.foreign) return '';
  return hit.label || q;
}

function playerIndexClear() {
  _piCache = [];
  try { const st = piStore(); if (st) st.removeItem(PI_STORE_KEY); } catch (e) {}
}

// 从英雄联盟战绩对象里抽取参与者塞进索引 (SGP / EOG 两种结构都兼容)
function playerIndexFromGames(games) {
  const out = [];
  for (const g of (games || [])) {
    for (const p of (g && g.participants) || []) {
      if (!p) continue;
      const name = p.riotIdGameName || p.name || p.summonerName || '';
      if (!name) continue;
      out.push({
        name,
        tag: p.riotIdTagline || p.riotIdTagLine || p.tagLine || '',
        puuid: p.puuid || '',
        icon: p.profileIconId || 0,
        // p.level 在战绩数据里是**英雄等级**(1~18), 不是召唤师等级 —— 直接拿来
        // 会在候选里显示 "Lv18", 而点进去实际是 1367 级。只认 summonerLevel,
        // 没有就留空 (候选不显示等级, 等别名/SGP 解析补齐)。
        level: p.summonerLevel || 0
      });
    }
  }
  return playerIndexUpsert(out, 'match');
}

// Riot Client 别名查询结果入索引: [{ gameName, tagLine, puuid }]。
// 这是"陌生玩家不用输完整 Tag"的来源 —— 只给一个完整名字, 服务端返回该名字下
// 全部 Riot ID; 带 puuid 写入, 之后与战绩里遇到的同一个人自动合并成一条。
//
// 别名接口是**跨大区**的 (实测同名 16 个账号里只有 1 个在本区, 其余 LCU 一律 404
// "No summoner name for puuid")。所以必须带 metas 判断归属:
//   metas[puuid] = { inRegion: bool, level, icon }  (渲染层逐个问 LCU 得到)
// 还没问到的先记 u:1 (归属未知): 不能自动补全 (可能查不到), 也不标"其它大区"
// (会误伤本区账号), 由后续解析把它变成 x:1 (其它大区) 或清空 (本区)。
// 一次别名查询最多写入多少条。服务端对同名账号有 500 条硬上限 (实测
// gameName=Cherry 正好返回 500 条, 且 tagLine 靠后的账号**根本不在结果里**),
// 若全量写进索引, 一次搜索就能把 1500 条挤满, 把真正一起打过的人挤掉 ——
// 这也是"共 1500 人可搜"长期顶格、大量条目是两个人在别的区的直接原因。
const PI_ALIAS_WRITE_MAX = 60;

function playerIndexFromAliases(list, metas, opts) {
  const idx = piLoad();
  if (!Array.isArray(list) || !list.length) return 0;
  // 写入前先截断: tag 与用户已输入前缀一致的优先 (他多半就在找这些),
  // 其余按 Tag 升序 —— 服务端本身就是按 Tag 升序返回的, 保持一致即可。
  let src = list;
  if (list.length > PI_ALIAS_WRITE_MAX) {
    const pref = String((opts && opts.tagPrefix) || '').replace(/\D/g, '');
    src = list.slice().sort((a, b) => {
      const sa = String((a && (a.tagLine || a.tag)) || '');
      const sb = String((b && (b.tagLine || b.tag)) || '');
      const pa = pref && sa.startsWith(pref) ? 0 : 1;
      const pb = pref && sb.startsWith(pref) ? 0 : 1;
      return pa - pb || sa.localeCompare(sb, 'en');
    }).slice(0, PI_ALIAS_WRITE_MAX);
  }
  const byKey = new Map();
  for (const e of idx) byKey.set(piKeyOf(e), e);
  const now = Date.now();
  let changed = 0;
  let added = 0;
  for (const a of src) {
    if (!a) continue;
    const name = a.gameName || a.name || '';
    if (!name) continue;
    const tag = String(a.tagLine || a.tag || '').trim();
    const puuid = String(a.puuid || '').trim();
    const meta = (metas && puuid && metas[puuid]) || null;
    const key = piKeyOf({ n: name, t: tag, p: puuid });
    let entry = byKey.get(key);
    if (!entry) {
      entry = { n: name, t: tag, p: puuid, i: 0, l: 0, s: 'alias', ts: now, u: 1 };
      idx.push(entry);
      byKey.set(key, entry);
      changed++; added++;
    }
    if (meta) {
      const foreign = meta.inRegion === false;
      if (!!entry.x !== foreign) { entry.x = foreign ? 1 : 0; changed++; }
      if (entry.u) { entry.u = 0; changed++; }
      if (meta.platform && entry.pf !== meta.platform) { entry.pf = meta.platform; changed++; }
      if (!foreign) {
        if (meta.level && entry.l !== meta.level) { entry.l = meta.level; changed++; }
        if (meta.icon && entry.i !== meta.icon) { entry.i = meta.icon; changed++; }
      }
    }
    entry.ts = now;
    if (!entry.s) entry.s = 'alias';
  }
  if (!changed) return added;
  piTrim();
  piPersist();
  return added;
}

// 需要问归属的 puuid:
//   - 新出现的别名账号, 或上次解析失败还挂着 u:1 的
//   - opts.needPlatform 时, 连"已判为其它大区但没有区名"的也补一次 —— 只用本区
//     网关查过的账号只知道"不在本区", 切到全部大区后应该能显示到底在哪个区。
function playerIndexNeedRegion(list, opts) {
  const idx = piLoad();
  const byKey = new Map();
  for (const e of idx) byKey.set(piKeyOf(e), e);
  const wantPlatform = !!(opts && opts.needPlatform);
  const out = [];
  for (const a of (list || [])) {
    if (!a) continue;
    const name = a.gameName || a.name || '';
    if (!name || !a.puuid) continue;
    const entry = byKey.get(piKeyOf({ n: name, t: a.tagLine || a.tag || '', p: a.puuid }));
    // 索引里没有 = 这次没写进去 (写入有 60 条上限), 查了也没地方存 → 跳过
    if (!entry) continue;
    if (entry.u) out.push(String(a.puuid));
    else if (wantPlatform && entry.x && !entry.pf) out.push(String(a.puuid));
  }
  return out;
}

// 好友列表 (LCU /lol-chat/v1/friends): name 可能是 "名字#Tag", 也可能是纯 gameName
function playerIndexFromFriends(friends) {
  const out = [];
  for (const f of (friends || [])) {
    if (!f) continue;
    const name = f.gameName || f.name || f.riotIdGameName || '';
    if (!name) continue;
    out.push({
      name,
      tag: f.gameTag || f.tagLine || '',
      puuid: f.puuid || f.id || ''
    });
  }
  return playerIndexUpsert(out, 'friend');
}

// 候选是否落在"正在搜索的大区"里。搜索框的大区下拉就是靠它收窄候选的:
//   region 为空        → 全部大区, 不过滤 (8 个网关都查过, 谁都能显示)
//   有 platform        → 直接比大区
//   没有 platform      → 来自好友/对局/查询的条目一定是本区的人 (本就是从这个区
//                        的客户端拿到的); 别名条目解析前/解析失败都是 regionUnknown,
//                        选定大区时不敢算进来, 免得把别的区的人当本区
function playerIndexInRegion(candidate, region, current) {
  if (!region) return true;
  if (!candidate) return false;
  if (candidate.platform) return candidate.platform === region;
  if (candidate.foreign || candidate.regionUnknown) return false;
  return !current || region === current;
}
