// 合规模式
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 合规模式 (一键停用所有自动化, 仅保留只读功能) ==========
let complianceOn = false;
function toggleCompliance(on) {
  complianceOn = !!on;
  storeSet('compliance', on ? '1' : '');
  applyComplianceState();
  toolMsg(on ? '<span style="color:var(--positive)">合规模式已开启: 自动化功能全部停用, 仅保留只读数据</span>' : '合规模式已关闭');
}
function applyComplianceState() {
  const preferences = {
    autoAcceptToggle: !!autoAcceptOn,
    autoBPToggle: typeof autoBPEnabled !== 'undefined' && !!autoBPEnabled,
    autoRuneToggle: typeof autoRuneEnabled !== 'undefined' && !!autoRuneEnabled,
    gsLockToggle: typeof storeGet === 'function' && storeGet('gsLockOn') === '1'
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
  console.log('[auto-accept] GET ready-check:', JSON.stringify({ state: rc.state, playerResponse: rc.playerResponse }));
  // 兼容多种取值: state 表示有弹窗 + 玩家未响应 → 触发接受 (POST 幂等, 重发无副作用)
  const hasPopup = !!rc.state && rc.state !== 'None' && rc.state !== 'InProgress';
  const notResponded = !rc.playerResponse || rc.playerResponse === 'None' || rc.playerResponse === '';
  if (hasPopup && notResponded) {
    setReadyState("发现对局，自动接受...", 'active');
    console.log('[auto-accept] POST accept (GET-detected popup)');
    await acceptReadyCheckNow();
  } else if (hasPopup && rc.playerResponse === 'Accepted') {
    setReadyState("已接受，等待队友", 'done');
  } else {
    setReadyState("监听中...", 'listening');
  }
}
// 阶段/WS/轮询共享的接受函数: POST 幂等, busy 锁防并发, 全程诊断日志
async function acceptReadyCheckNow() {
  if (!autoAcceptOn || complianceOn) return;
  if (_readyCheckAccepting) return;
  _readyCheckAccepting = true;
  try {
    console.log('[auto-accept] POST accept (send)');
    const r = await lolAPI.lcuRequest('POST', '/lol-matchmaking/v1/ready-check/accept');
    console.log('[auto-accept] POST result:', JSON.stringify(r).substring(0, 160));
    if (r && !r.__error && r.playerResponse === 'Accepted') {
      setReadyState("已接受，等待队友", 'done');
    }
  } catch (e) {
    console.log('[auto-accept] POST threw:', e.message);
  } finally {
    _readyCheckAccepting = false;
  }
}
async function fixWindow() {
  const ok = await lolAPI.fixWindow();
  toolMsg(ok ? '<span style="color:var(--positive)">LCU 窗口已恢复 1280×720 居中</span>' : '<span style="color:var(--negative)">未找到客户端窗口，请确认客户端正在运行</span>');
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

// 卸下勋章/头像框/旗帜代币 (参考 Akari/Seraphine; 头像框 = regalia prestige crest, 22 为无边框)
async function removeAllRegalia() {
  if (!guardWrite('卸下勋章')) return;
  const reg = await lolAPI.lcuRequest('GET', '/lol-regalia/v2/current-summoner/regalia');
  const me = await lolAPI.lcuRequest('GET', '/lol-chat/v1/me');
  const r1 = await lolAPI.lcuRequest('PUT', '/lol-regalia/v2/current-summoner/regalia', {
    preferredCrestType: 'prestige',
    preferredBannerType: reg && !reg.__error ? reg.bannerType : null,
    selectedPrestigeCrest: 22
  });
  const r2 = await lolAPI.lcuRequest('POST', '/lol-challenges/v1/update-player-preferences/', {
    challengeIds: [],
    bannerAccent: me && !me.__error && me.lol ? me.lol.bannerIdSelected : undefined
  });
  const bad = (r1 && r1.__error) || (r2 && r2.__error);
  toolMsg(bad ? `<span style="color:var(--negative)">卸下失败: ${(r1 && r1.__error) || (r2 && r2.__error)}</span>` : '<span style="color:var(--positive)">已卸下勋章、头像框与旗帜代币</span>');
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
        catch (e) { console.log('[claim] mission error:', m.id, e.message); }
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
