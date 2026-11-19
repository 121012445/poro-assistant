// 合规模式
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 合规模式 (一键停用所有自动化, 仅保留只读功能) ==========
let complianceOn = false;
function toggleCompliance(on) {
  complianceOn = !!on;
  if (complianceOn && typeof cancelAutoReturn === 'function') cancelAutoReturn();
  storeSet('compliance', on ? '1' : '');
  applyComplianceState();
  if (typeof refreshStatusCenter === 'function') refreshStatusCenter();
  toolMsg(on ? '<span style="color:var(--positive)">合规模式已开启: 自动化功能全部停用, 仅保留只读数据</span>' : '合规模式已关闭');
}
function applyComplianceState() {
  const preferences = {
    autoAcceptToggle: !!autoAcceptOn,
    autoBPToggle: typeof autoBPEnabled !== 'undefined' && !!autoBPEnabled,
    autoRuneToggle: typeof autoRuneEnabled !== 'undefined' && !!autoRuneEnabled,
    gsLockToggle: typeof storeGet === 'function' && storeGet('gsLockOn') === '1',
    autoHonorToggle: typeof autoflow !== 'undefined' && !!autoflow.honor,
    autoReconnectToggle: typeof autoflow !== 'undefined' && !!autoflow.reconnect,
    autoReturnLobbyToggle: typeof _autoReturn !== 'undefined' && !!_autoReturn.enabled,
    pickGuardToggle: typeof pickGuardOn !== 'undefined' && !!pickGuardOn
  };
  for (const [id, preferred] of Object.entries(preferences)) {
    const el = document.getElementById(id);
    if (el) { el.disabled = complianceOn; el.checked = complianceOn ? false : preferred; }
  }
  const setState = (id, text, color = '') => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.style.color = color;
  };
  if (complianceOn) {
    setState('readyCheckState', '合规模式停用', 'var(--text-muted)');
    setState('autoBPStatus', '合规模式停用', 'var(--text-muted)');
    setState('autoRuneStatus', '合规模式停用', 'var(--text-muted)');
    setState('gsLockStatus', '合规模式停用', 'var(--text-muted)');
  } else {
    setState('autoBPStatus', preferences.autoBPToggle ? '已开启' : '未开启', preferences.autoBPToggle ? 'var(--positive)' : '');
    setState('autoRuneStatus', preferences.autoRuneToggle ? '已开启' : '未开启', preferences.autoRuneToggle ? 'var(--positive)' : '');
    setState('gsLockStatus', preferences.gsLockToggle ? '完整锁定 · 等待触发' : '未锁定');
    updateReadyCheck();
  }
  const st = document.getElementById('complianceState');
  if (st) { st.textContent = complianceOn ? '已开启' : '未开启'; st.style.color = complianceOn ? 'var(--positive)' : ''; }
}
function guardAutomation(name) {
  if (!complianceOn) return true;
  showToast('合规模式已开启, ' + name + '已停用', 'negative');
  return false;
}
// 写操作门禁: 合规模式(只读模式)下拦截一切对客户端的写入类手动操作
function guardWrite(name) {
  if (!complianceOn) return true;
  showToast('合规模式为只读模式, ' + name + '不可用', 'negative');
  return false;
}

function toggleAutoAccept(on) {
  if (on && !guardAutomation('自动接受')) { document.getElementById('autoAcceptToggle').checked = false; return; }
  autoAcceptOn = on;
  if (typeof automationLog === 'function') automationLog('自动接受', on ? '已开启' : '已关闭');
  saveConfig();
  // 立即同步状态文字, 关闭时显示"已关闭", 开启时拉取一次对局状态
  if (on) toolMsg('<span style="color:var(--positive)">自动接受已开启</span>');
  updateReadyCheck();
}
// 状态文字 + 颜色: 不同状态用不同 CSS 变量着色, 状态一目了然
const READY_STATE_COLORS = { off: '', 'unavail': 'var(--negative)', listening: 'var(--accent)', active: 'var(--positive)', done: 'var(--positive)', muted: 'var(--text-muted)' };
function setReadyState(text, colorKey) {
  const el = document.getElementById("readyCheckState");
  if (!el) return;
  el.textContent = text;
  el.style.color = READY_STATE_COLORS[colorKey] || '';
}
async function updateReadyCheck() {
  if (complianceOn) { setReadyState("合规模式", 'muted'); return; }
  if (!autoAcceptOn) { setReadyState("已关闭", 'off'); return; }
  let rc = null;
  try { rc = await lolAPI.lcuRequest("GET", "/lol-matchmaking/v1/ready-check"); }
  catch (e) { setReadyState("客户端未连接", 'unavail'); return; }
  // 404 = 当前没有确认弹窗(正常空闲态), 不应误报"客户端未连接"; 仅连接性错误才提示
  if (!rc) { setReadyState("监听中...", 'listening'); return; }
  if (rc.__error) {
    if (rc.httpStatus === 404) { setReadyState("监听中...", 'listening'); return; }
    setReadyState("客户端未连接", 'unavail');
    return;
  }
  logDebug('[auto-accept] GET ready-check:', JSON.stringify({ state: rc.state, playerResponse: rc.playerResponse }));
  // LCU 的 ready-check.state 枚举: InProgress(弹窗正在等待响应) / Accepted / Declined /
  // Invalid / Expired / Error / None —— **只有 InProgress 是此刻可以接受的状态**。
  // 旧写法把 InProgress 取反排除了: 它恰好排除了唯一该接受的状态, 反过来把
  // Error / Invalid 当成"有待接受弹窗"。实测 crash.log: GET 侧出现
  // 415 次 Error + 6 次 Invalid + 只有 2 次 InProgress, 那 421 次失效状态全部触发了
  // POST accept, 每次 500 (RPC_ERROR "Failed to accept team builder ready check"),
  // 且轮询每 12 秒重入 —— 一次弹窗失效后就会无限重试下去(全量日志 438 次 POST / 433 次 500)。
  // 真正可靠的是 lcu-events.js 的 phase=ReadyCheck 触发, 这里只作兜底, 必须判准。
  const pending = String(rc.state || '') === 'InProgress';
  const notResponded = !rc.playerResponse || rc.playerResponse === 'None' || rc.playerResponse === '';
  if (pending && notResponded) {
    setReadyState("发现对局，自动接受...", 'active');
    logDebug('[auto-accept] POST accept (GET-detected popup)');
    await acceptReadyCheckNow();
  } else if (rc.playerResponse === 'Accepted') {
    setReadyState("已接受，等待队友", 'done');
  } else {
    setReadyState("监听中...", 'listening');
  }
}
// 阶段/WS/轮询共享的接受函数: POST 幂等, busy 锁防并发, 全程诊断日志
async function acceptReadyCheckNow() {
  if (!autoAcceptOn || complianceOn) return;
  if (window.automationModeAllows && !window.automationModeAllows('autoAcceptToggle')) return;
  if (_readyCheckAccepting) return;
  _readyCheckAccepting = true;
  try {
    logDebug('[auto-accept] POST accept (send)');
    const r = await lolAPI.lcuRequest('POST', '/lol-matchmaking/v1/ready-check/accept');
    logDebug('[auto-accept] POST result:', JSON.stringify(r).substring(0, 160));
    if (r && !r.__error && r.playerResponse === 'Accepted') {
      setReadyState("已接受，等待队友", 'done');
    }
  } catch (e) {
    logDebug('[auto-accept] POST threw:', e.message);
  } finally {
    _readyCheckAccepting = false;
  }
}
// 失败信息要能让用户直接截图发回来 —— 只写"没找到"等于什么都没说,
// 我们拿不到对方的屏幕, 枚举结果/错误码才是唯一能远程定位的线索。
function _fixEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function _fixDetail(text) {
  return `<div style="font-size:11px;line-height:1.5;opacity:.72;margin-top:3px;word-break:break-all">${_fixEsc(text)}</div>`;
}
async function fixWindow() {
  let r = null;
  try { r = await lolAPI.fixWindow(); } catch (e) { r = null; }
  const ok = r === true || !!(r && r.ok);
  if (!ok) {
    const red = s => `<span style="color:var(--negative)">${s}</span>`;
    const reason = (r && r.reason) || 'not-found';
    if (reason === 'denied') {
      const err = (r && r.err) || 5;
      toolMsg(red(`客户端窗口拒绝被修改（Win32 ${err}）`) +
        _fixDetail(err === 5
          ? '客户端以管理员身份运行，Poro 也必须以管理员身份启动才能改它的窗口'
          : `目标窗口类名 ${(r && r.className) || '?'}，错误码 ${err}`));
      return;
    }
    if (reason === 'unavailable') {
      toolMsg(red('窗口模块不可用') + _fixDetail(`koffi 加载失败：${(r && (r.loadError || r.error)) || '未知原因'}`));
      return;
    }
    if (reason === 'error' || reason === 'bad-rect') {
      toolMsg(red('修复失败') + _fixDetail((r && r.error) || '主进程计算目标位置时出错'));
      return;
    }
    // not-found: 把枚举到的东西摆出来
    const p = (r && r.probe) || null;
    const list = (p && p.candidates) || [];
    // 客户端会挂 9 个 135x37 的隐藏辅助窗, 全列出来会糊成一团, 只展示前 3 个 + 总数
    const desc = list.length
      ? list.slice(0, 3).map(c => `${c.className}「${c.title}」${c.width}×${c.height}${c.visible ? ' 可见' : ' 隐藏'}${c.iconic ? ' 最小化' : ''}`).join('；')
        + (list.length > 3 ? `；等 ${list.length} 个` : '')
      : '一个都没有（连枚举都没拿到客户端窗口）';
    toolMsg(red('未找到客户端窗口') + _fixDetail(`枚举到 ${list.length} 个：${desc}`));
    return;
  }
  // 新版主进程会回报修复后的实际矩形, 直接摆出来 —— 比一句"已恢复"更能确认真的动了
  const a = r && r.after;
  const b = r && r.before;
  const size = a && a.width ? `${a.width}×${a.height}` : '1280×720';
  toolMsg(`<span style="color:var(--positive)">LCU 窗口已恢复 ${size} 居中</span>` +
    (b && a ? _fixDetail(`原位置 ${b.x},${b.y} ${b.width}×${b.height} → ${a.x},${a.y} ${a.width}×${a.height}（${(r && r.className) || ''}）`) : ''));
}
function populateBgChampionList() {
  // 简单的中文拼音首字母映射 (常见英雄)
const CN_INITIALS = {
  '劫': 'J', '影流之主': 'Y', '疾风剑豪': 'J', '亚索': 'Y',
  '佛耶格': 'F', '破败之王': 'P', '泰隆': 'T', '刀锋之影': 'D',
  '李青': 'L', '盲僧': 'M', '易': 'Y', '剑圣': 'J',
  '艾瑞莉娅': 'A', '刀锋舞者': 'D', '希维尔': 'X', '弩箭天使': 'N',
  '金克丝': 'J', '暴走萝莉': 'B', '迦娜': 'J', '风女': 'F',
  '璐璐': 'L', '仙灵女巫': 'X', '娜美': 'N', '海浪之灵': 'H',
  '索拉卡': 'S', '众星之子': 'Z', '阿狸': 'A', '九尾妖狐': 'J',
  '阿梓': 'A', '阿木木': 'M', '哀嚎洞穴': 'A',
};
window._bgChampEntries = Object.keys(allChampions)
    .sort((a, b) => allChampions[a].name.localeCompare(allChampions[b].name, "zh"))
    .map(k => {
      const ch = allChampions[k];
      // 生成拼音首字母
      let initials = '';
      for (const char of ch.name) {
        const code = char.charCodeAt(0);
        if (code >= 0x4E00 && code <= 0x9FFF) {
          initials += CN_INITIALS[char] || '';
        }
      }
      return { key: k, numKey: String(ch.key), name: ch.name, title: ch.title || '', id: ch.id, enName: ch.id, initials: initials.toLowerCase() };
    });
}
function filterBgChampions() {
  const input = (document.getElementById("bgChamp")?.value || "").trim().toLowerCase();
  const dd = document.getElementById("bgChampDropdown");
  if (!dd || !window._bgChampEntries) return;
  if (!input) { dd.style.display = "none"; return; }
  const matches = window._bgChampEntries.filter(ch => {
    const n = ch.name;
    const t = (ch.title || '').toLowerCase();
    const en = ch.enName.toLowerCase();
    const key = String(ch.key);
    const numKey = String(ch.numKey || ch.key);
    // 精确匹配
    if (key.toLowerCase() === input || numKey === input || n.toLowerCase() === input || t === input || en === input) {
      return true;
    }
    // 中文字符包含匹配
    if (input.length === 1 && (n.includes(input) || t.includes(input))) {
      return true;
    }
    // 英文/数字包含匹配
    if (n.toLowerCase().includes(input) || t.includes(input) || en.includes(input) || key.toLowerCase().includes(input) || numKey.includes(input)) {
      return true;
    }
    // 模糊匹配（逐字顺序）
    let m = 0;
    for (let i = 0; i < input.length && m < n.length; i++) {
      if (n[m] === input[i]) m++;
    }
    if (m === input.length) return true;
    m = 0;
    for (let i = 0; i < input.length && m < t.length; i++) {
      if (t[m] === input[i]) m++;
    }
    if (m === input.length) return true;
    m = 0;
    for (let i = 0; i < input.length && m < en.length; i++) {
      if (en[m] === input[i]) m++;
    }
    return m === input.length;
  });
  const max = Math.min(matches.length, 15);
  if (max === 0) { dd.style.display = "none"; return; }
  dd.innerHTML = matches.slice(0, max).map(ch =>
    `<div class="bg-champ-option" data-key="${ch.key}" onclick="bgChampSelect('${ch.key}')"><strong>${ch.name}</strong> <span style="color:var(--text-muted)">#${ch.key}</span></div>`
  ).join("");
  dd.style.display = "block";
  dd._matches = matches;
}
function bgChampSelect(key) {
  const ch = allChampions[key];
  if (!ch) return;
  document.getElementById("bgChamp").value = ch.name + " #" + ch.key;
  document.getElementById("bgChampDropdown").style.display = "none";
  populateBgSkins();
}
function bgChampHide() {
  document.getElementById("bgChampDropdown").style.display = "none";
}
async function populateBgSkins() {
  const input = document.getElementById('bgChamp');
  const val = input && input.value.trim();
  if (!val) return;
  // 从 "亚索 #117" 格式提取 key，或者直接就是 key
  let key = val;
  const hashMatch = val.match(/#(\d+)/);
  if (hashMatch) {
    // 从 allChampions 中查找数字ID对应的英雄名
    let foundKey = null;
    for (const k of Object.keys(allChampions)) {
      if (allChampions[k].key === hashMatch[1]) { foundKey = k; break; }
    }
    if (foundKey) key = foundKey;
  }
  const skinSel = document.getElementById('bgSkin');
  if (!skinSel) return;
  skinSel.innerHTML = '<option>加载中...</option>';
  try {
    const d = await lolAPI.getChampionDetail(version, key);
    const skins = (d && d.skins) || [];
    // 使用 s.id (完整皮肤ID) 而不是 s.num (皮肤序号)
    skinSel.innerHTML = skins.map(s => `<option value="${s.id}">${s.name === 'default' ? '默认皮肤' : s.name}</option>`).join('');
  } catch (e) {
    skinSel.innerHTML = '<option value="0">默认皮肤</option>';
  }
}
async function setProfileBg() {
  if (!guardWrite('生涯背景修改')) return;
  const skinId = +(document.getElementById("bgSkin").value || 0);
  
  // 直接设置，不需要检查皮肤解锁 (与 Akari/Seraphine 行为一致)
  const r = await lolAPI.lcuRequest("POST", "/lol-summoner/v1/current-summoner/summoner-profile", {
    key: "backgroundSkinId",
    value: skinId
  });
  if (r && r.__error) {
    toolMsg('<span style="color:var(--negative)">设置失败: ' + r.__error + '</span>');
  } else {
    toolMsg('<span style="color:var(--positive)">生涯背景已更改，请在客户端中按 F5 刷新</span>');
  }
}

// 头像框 / 勋章 / 挑战代币 (参考 LeagueAkari 与 Seraphine)
//
// 早期注释写的「22 为无边框」不准确。2026-11-20 在本机实测 + 对照 Akari 源码后的结论:
//   1. preferredCrestType 只接受 prestige; none/blank/default/challenges 全部 400
//      Invalid preferredCrestType —— 客户端没有"不显示边框"这种状态可写。
//   2. 真正决定成败的是召唤师等级。Akari 里写死
//      MINIMUM_SUMMONER_LEVEL_FOR_PRESTIGE_CREST = 525, 等级不够时界面上直接标"需 525 级以上"。
//      实测完全对得上: 2693 级写 22 = 边框消失; 161 级写 22 = 换成另一款边框(金红→青蓝)。
//      所以 22 是"关闭等级边框"的开关值, 只有拿到权限的账号才认, 不是什么通用无框值。
//   3. 写完立刻 GET 读回不可靠, 服务端有延迟(实测读回会滞后一拍), 要做延时校验。
// 因此这里按 Akari 的做法加等级门槛: 低于 525 级的账号直接拒绝执行边框动作, 避免
// "点了卸下结果自己换了"。勋章/挑战代币与头像框拆成两个独立动作, 另外第一次执行前备份
// 原边框, 提供「恢复原头像框」还原。
const REGALIA_BACKUP_PREFIX = 'regaliaBackup:';
const FIXED_PRESTIGE_CREST = 22;                       // 对应 Akari 的 FIXED_PRESTIGE_CREST
const MINIMUM_SUMMONER_LEVEL_FOR_PRESTIGE_CREST = 525; // 对应 Akari 的同名常量(等级门槛)

function regaliaBackupKey(puuid) {
  return REGALIA_BACKUP_PREFIX + (puuid || 'anon');
}

function readRegaliaBackup(puuid) {
  let raw = null;
  try { raw = typeof storeGet === 'function' ? storeGet(regaliaBackupKey(puuid)) : null; } catch (e) { raw = null; }
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (!o || !Number.isFinite(+o.selectedPrestigeCrest)) return null;
    return o;
  } catch (e) {
    return null;
  }
}

async function readRegaliaState() {
  const reg = await lolAPI.lcuRequest('GET', '/lol-regalia/v2/current-summoner/regalia');
  return reg && !reg.__error ? reg : null;
}

// 账号维度: 换号后各自的边框备份互不覆盖
async function readRegaliaAccount() {
  const me = await lolAPI.lcuRequest('GET', '/lol-chat/v1/me');
  if (!me || me.__error) return { id: '', me: null };
  return { id: me.puuid || (me.summonerId != null ? String(me.summonerId) : ''), me };
}

function regaliaLine(ok, text) {
  return (ok ? '<span style="color:var(--positive)">' : '<span style="color:var(--negative)">') + text + '</span>';
}

// 只卸头像框。返回 { ok, text }, 由调用方决定怎么展示。
async function doRemovePrestigeCrest() {
  const reg = await readRegaliaState();
  if (!reg) return { ok: false, text: '读不到头像框状态，客户端可能没连上' };

  const level = +reg.summonerLevel || 0;
  if (level < MINIMUM_SUMMONER_LEVEL_FOR_PRESTIGE_CREST) {
    return {
      ok: false,
      text: '当前 ' + (level || '未知') + ' 级，低于 ' + MINIMUM_SUMMONER_LEVEL_FOR_PRESTIGE_CREST +
        ' 级：这个等级没有关闭等级边框的权限，硬写只会把边框换成另一款（不是卸下），已跳过。'
    };
  }

  const { id } = await readRegaliaAccount();
  // 只在第一次执行前备份。二次点击时 regalia 已经是卸下的样子, 不能覆盖原边框。
  if (!readRegaliaBackup(id)) {
    storeSet(regaliaBackupKey(id), JSON.stringify({
      preferredCrestType: reg.preferredCrestType,
      selectedPrestigeCrest: reg.selectedPrestigeCrest,
      preferredBannerType: reg.preferredBannerType,
      summonerLevel: reg.summonerLevel,
      savedAt: Date.now()
    }));
  }

  const r = await lolAPI.lcuRequest('PUT', '/lol-regalia/v2/current-summoner/regalia', {
    preferredCrestType: 'prestige',
    preferredBannerType: reg.bannerType,
    selectedPrestigeCrest: FIXED_PRESTIGE_CREST
  });
  if (r && r.__error) return { ok: false, text: '头像框写入失败: ' + r.__error };

  // 服务端有延迟, 等一拍再读回
  await new Promise((done) => setTimeout(done, 400));
  const after = await readRegaliaState();
  const applied = after && +after.selectedPrestigeCrest === FIXED_PRESTIGE_CREST;
  return applied
    ? { ok: true, text: '头像框已卸下（' + level + ' 级，原边框已备份，可随时恢复）' }
    : { ok: false, text: '写入成功但读回不是 ' + FIXED_PRESTIGE_CREST + ' 档，客户端可能没接受' };
}

// 只清勋章与挑战代币。这部分与等级无关, 任何账号都生效。
async function doRemoveChallengeTokens() {
  const { me } = await readRegaliaAccount();
  const r = await lolAPI.lcuRequest('POST', '/lol-challenges/v1/update-player-preferences/', {
    challengeIds: [],
    bannerAccent: me && me.lol ? me.lol.bannerIdSelected : undefined
  });
  if (r && r.__error) return { ok: false, text: '清空勋章失败: ' + r.__error };
  return { ok: true, text: '已清空勋章与挑战代币' };
}

async function removePrestigeCrest() {
  if (!guardWrite('卸下头像框')) return;
  const r = await doRemovePrestigeCrest();
  toolMsg(regaliaLine(r.ok, r.text));
}

async function removeChallengeTokens() {
  if (!guardWrite('清空勋章')) return;
  const r = await doRemoveChallengeTokens();
  toolMsg(regaliaLine(r.ok, r.text));
}

// 兼容旧的「一键卸下」入口: 两件事都做, 边框那半自己会挡等级
async function removeAllRegalia() {
  if (!guardWrite('卸下勋章')) return;
  const crest = await doRemovePrestigeCrest();
  const tokens = await doRemoveChallengeTokens();
  toolMsg(regaliaLine(tokens.ok, tokens.text) + '<br><small>' + regaliaLine(crest.ok, crest.text) + '</small>');
}

// 把第一次卸下时记录的边框写回去。备份不删除, 方便来回切换。
async function restoreRegalia() {
  if (!guardWrite('恢复头像框')) return;
  const { id } = await readRegaliaAccount();
  const bk = readRegaliaBackup(id);
  if (!bk) {
    toolMsg('<span style="color:var(--text-muted)">这个账号还没有边框备份 —— 只在点过「卸下头像框」之后才会记录。</span>');
    return;
  }
  const r = await lolAPI.lcuRequest('PUT', '/lol-regalia/v2/current-summoner/regalia', {
    preferredCrestType: bk.preferredCrestType || 'prestige',
    preferredBannerType: bk.preferredBannerType || 'blank',
    selectedPrestigeCrest: +bk.selectedPrestigeCrest
  });
  if (r && r.__error) {
    toolMsg('<span style="color:var(--negative)">恢复失败: ' + r.__error + '</span>');
    return;
  }
  await new Promise((done) => setTimeout(done, 400));
  const after = await readRegaliaState();
  const now = after ? +after.selectedPrestigeCrest : NaN;
  const ok = now === +bk.selectedPrestigeCrest;
  toolMsg(ok
    ? '<span style="color:var(--positive)">已恢复原头像框（' + bk.selectedPrestigeCrest + ' 档）</span>'
    : '<span style="color:var(--negative)">恢复请求已发出，但读回是 ' + (Number.isFinite(now) ? now : '未知') + ' 档，客户端可能需要按 F5 刷新</span>');
}
// 一键领取网页活动奖励 (事件通行证 + 任务), 参考 Akari claim-tools
// 计数采用"领取前后差值"自验证: 接口返回错误或数量无变化都不计入, 避免虚报
async function claimAllRewards() {
  if (!guardWrite('一键领取奖励')) return;
  toolMsg('领取中...<br><small>详细日志请查看控制台(F12)</small>');
  let claimed = 0;
  const notes = [];
  // 读取某活动当前未领数量; 端点不可读返回 -1
  const unclaimedCount = async (eid) => {
    try {
      const u = await lolAPI.lcuRequest('GET', `/lol-event-hub/v1/events/${eid}/reward-track/unclaimed-rewards`);
      if (!u || u.__error) return -1;
      return u.rewardsCount ?? (Array.isArray(u.rewards) ? u.rewards.length : 0);
    } catch (e) { return -1; }
  };

  // 1. 事件通行证奖励
  try {
    const events = await lolAPI.lcuRequest('GET', '/lol-event-hub/v1/events');
    if (events && !events.__error && Array.isArray(events)) {
      for (const ev of events) {
        const eid = ev.eventId || ev.id;
        const ename = ev.name || ev.title || eid;
        if (!eid) continue;
        try {
          const before = await unclaimedCount(eid);
          if (before <= 0) continue;
          const result = await lolAPI.lcuRequest('POST', `/lol-event-hub/v1/events/${eid}/reward-track/claim-all`);
          if (result && result.__error) {
            notes.push(`${ename}: 领取接口失败 (${result.message || result.__error})`);
            continue;
          }
          const after = await unclaimedCount(eid);
          if (after >= 0) {
            const delta = Math.max(0, before - after);
            if (delta > 0) claimed += delta;
            else notes.push(`${ename}: 接口调用成功但未领数量无变化 (${before}), 该活动可能不支持接口领取`);
          } else {
            claimed += before; // 端点领取后不可读, 以领取前数量为准
          }
        } catch (e) {
          notes.push(`${ename}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    notes.push(`活动列表: ${e.message}`);
  }

  // 2. 任务奖励 - 领取所有可领取的任务, 再复查状态验证实际领取数
  try {
    const missions = await lolAPI.lcuRequest('GET', '/lol-missions/v1/missions');
    if (missions && !missions.__error && Array.isArray(missions)) {
      const claimable = missions.filter(m => m.status === 'SELECT_REWARDS' || m.status === 'COMPLETED');
      for (const m of claimable) {
        try { await lolAPI.lcuRequest('PUT', '/lol-missions/v1/player', { missionIds: [m.id] }); }
        catch (e) { logDebug('[claim] mission error:', m.id, e.message); }
      }
      if (claimable.length) {
        try {
          const after = await lolAPI.lcuRequest('GET', '/lol-missions/v1/missions');
          if (after && !after.__error && Array.isArray(after)) {
            const still = new Set(after.filter(m => m.status === 'SELECT_REWARDS' || m.status === 'COMPLETED').map(m => m.id));
            claimed += claimable.filter(m => !still.has(m.id)).length;
          } else {
            claimed += claimable.length; // 无法复查, 以提交数为准
          }
        } catch (e) { claimed += claimable.length; }
      }
    }
  } catch (e) {
    notes.push(`任务: ${e.message}`);
  }

  if (claimed > 0) {
    toolMsg(`<span style="color:var(--positive)">实际领取 ${claimed} 项奖励</span>` + (notes.length ? `<br><small>${notes.map(n => n.replace(/</g, '&lt;')).join('<br>')}</small>` : ''));
  } else if (notes.length > 0) {
    toolMsg(`<span style="color:var(--negative)">本次未能确认领取</span><br><small>${notes.map(n => n.replace(/<br>/g, ' ').replace(/</g, '&lt;')).join('<br>')}</small>`);
  } else {
    toolMsg('<span style="color:var(--positive)">没有未领取的奖励</span><br><small>如果确认有奖励未领取，请打开控制台(F12)查看日志</small>');
  }
}
