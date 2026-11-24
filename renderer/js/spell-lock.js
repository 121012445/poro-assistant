// 召唤师技能锁定 —— 进选人自动把两个技能设成指定组合, 中途被改回来时纠正。
//
// LCU 没有"锁定"接口: 只有 GET/PATCH /lol-champ-select/v1/session/my-selection。
// 所以做法是轮询/事件驱动地比对当前 spell1Id/spell2Id, 不一致就 PATCH 回去。
// 与 OP.GG 写技能的关系: 锁定开启时, opgg-loadout 的 spells 步跳过, 避免两边抢写。
(function (root, factory) {
  const api = factory();
  try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
  if (typeof window !== 'undefined') window.PoroSpellLock = api;
  else if (root) root.PoroSpellLock = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const KEY_ON = 'spellLockOn';
  const KEY_IDS = 'spellLockIds';

  function sget(k) {
    if (typeof storeGet === 'function') return storeGet(k);
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function sset(k, v) {
    if (typeof storeSet === 'function') { storeSet(k, v); return; }
    try { localStorage.setItem(k, v); } catch (e) {}
  }

  // 目标组合: [id1, id2], 两个都是正整数且不相同才有效
  function target() {
    let raw = sget(KEY_IDS);
    // store 存的是字符串; 也兼容直接塞进来的数组/对象 (测试与备份导入会这样用)
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw || '[]'); } catch (e) { raw = []; }
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) raw = raw.ids;
    const ids = Array.isArray(raw) ? raw : [];
    const [a, b] = ids.map(Number);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) return null;
    return [a, b];
  }

  function enabled() { return sget(KEY_ON) === '1' && !!target(); }

  // 当前选择是否与目标一致 (顺序敏感: spell1 是 D, spell2 是 F)
  function matches(current, ids) {
    if (!current || current.__error || !ids) return false;
    return (Number(current.spell1Id) || 0) === ids[0] && (Number(current.spell2Id) || 0) === ids[1];
  }

  // 判定 + 写入分离, 便于单测; 真正发请求只在这里
  async function enforceOnce(getter, patcher) {
    const ids = target();
    if (!ids) return { skipped: true, reason: 'no-target' };
    const cur = await getter();
    if (matches(cur, ids)) return { ok: true, unchanged: true };
    // 404 "No active delegate" = 已不在选人阶段 (或还没开始)。此时 PATCH 只会拿到同样的 404,
    // 别把它当"被改了"去写, 免得事件竞态下刷请求。
    if (cur && (cur.httpStatus === 404 || /No active delegate/i.test(String(cur.message || '')))) {
      return { skipped: true, reason: 'no-champ-select' };
    }
    const r = await patcher({ spell1Id: ids[0], spell2Id: ids[1] });
    if (r && r.__error) return { ok: false, error: r.__error };
    return { ok: true, changed: true, ids };
  }

  // 选人事件很密: 同一组值不重复写; 写失败保留冷却避免刷屏
  let _lastKey = '';
  let _lastAt = 0;
  async function run() {
    if (!enabled()) return { skipped: true, reason: 'off' };
    if (window.complianceOn) return { skipped: true, reason: 'compliance' };
    if (window.automationModeAllows && !window.automationModeAllows('spellLockToggle')) {
      return { skipped: true, reason: 'mode' };
    }
    const ids = target();
    const key = ids.join(':');
    const now = Date.now();
    // 已经写过且没证据表明变了, 1.5s 内不再 GET, 减轻事件风暴压力
    if (key === _lastKey && now - _lastAt < 1500) return { skipped: true, reason: 'cooldown' };
    try {
      const r = await enforceOnce(
        () => lolAPI.lcuRequest('GET', '/lol-champ-select/v1/session/my-selection'),
        body => lolAPI.lcuRequest('PATCH', '/lol-champ-select/v1/session/my-selection', body)
      );
      _lastKey = key;
      _lastAt = now;
      if (r.changed && typeof showToast === 'function') {
        const n = id => {
          const s = (typeof allSpells === 'object' && allSpells)
            ? Object.values(allSpells).find(x => Number(x && x.key) === Number(id)) : null;
          return (s && s.name) || ('技能' + id);
        };
        showToast('召唤师技能已锁定为 ' + n(ids[0]) + ' / ' + n(ids[1]), 'info');
      }
      return r;
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  function set(on, id1, id2) {
    sset(KEY_ON, on ? '1' : '');
    if (on) {
      const a = Number(id1), b = Number(id2);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) {
        return { ok: false, error: '请选择两个不同的召唤师技能' };
      }
      sset(KEY_IDS, JSON.stringify([a, b]));
    }
    _lastKey = '';
    _lastAt = 0;
    return { ok: true, enabled: !!enabled(), ids: target() };
  }

  // 工具箱下拉: 只列真正能选的召唤师技能 (ddragon summoner.json 的全部条目,
  // 按 key 数值排; 排除 key 非数字的占位项)
  function spellOptions() {
    const out = [];
    const spells = (typeof allSpells === 'object' && allSpells) ? allSpells : {};
    for (const s of Object.values(spells)) {
      const id = Number(s && s.key);
      if (!Number.isInteger(id) || id <= 0 || !s.name) continue;
      out.push({ id, name: String(s.name) });
    }
    return out.sort((x, y) => x.id - y.id);
  }

  function html() {
    const opts = spellOptions();
    const ids = target() || [4, 14];
    const on = enabled();
    const sel = (which, val) => '<select class="tool-select" id="spellLock' + which + '">'
      + opts.map(s => '<option value="' + s.id + '"' + (s.id === val ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('')
      + '</select>';
    return '<div class="tool-row">'
      + '<span class="tool-state" id="spellLockState">' + (on ? '已锁定' : '未锁定') + '</span>'
      + '<label class="switch"><input type="checkbox" id="spellLockToggle" onchange="toggleSpellLock(this.checked)"><span class="slider"></span></label>'
      + '</div>'
      + '<div class="tool-row spell-lock-row">'
      + '<label>D 格 ' + sel('1', ids[0]) + '</label>'
      + '<label>F 格 ' + sel('2', ids[1]) + '</label>'
      + '<button class="btn-secondary" onclick="saveSpellLock()" style="font-size:11px;">保存组合</button>'
      + '</div>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function restoreUi() {
    const t = document.getElementById('spellLockToggle');
    const s1 = document.getElementById('spellLock1');
    const s2 = document.getElementById('spellLock2');
    const st = document.getElementById('spellLockState');
    const on = enabled();
    const ids = target() || [4, 14];
    if (t) t.checked = on;
    if (s1) s1.value = String(ids[0]);
    if (s2) s2.value = String(ids[1]);
    if (st) st.textContent = on ? '已锁定' : '未锁定';
  }

  function toggle(on) {
    const r = set(on, document.getElementById('spellLock1')?.value, document.getElementById('spellLock2')?.value);
    if (!r.ok) { if (typeof toolMsg === 'function') toolMsg(r.error); restoreUi(); return r; }
    if (typeof toolMsg === 'function') toolMsg(on ? '召唤师技能锁定已开启' : '召唤师技能锁定已关闭');
    if (on && window._gameflowPhase === 'ChampSelect') run();
    restoreUi();
    return r;
  }

  function save() {
    const id1 = document.getElementById('spellLock1')?.value;
    const id2 = document.getElementById('spellLock2')?.value;
    const r = set(true, id1, id2);
    if (!r.ok) { if (typeof toolMsg === 'function') toolMsg(r.error); return r; }
    if (typeof toolMsg === 'function') toolMsg('技能组合已保存：' + (target() || []).join(' / '));
    if (window._gameflowPhase === 'ChampSelect') run();
    restoreUi();
    return r;
  }

  return { enabled, target, matches, enforceOnce, run, set, spellOptions, html, restoreUi, toggle, save,
    KEY_ON, KEY_IDS };
});
