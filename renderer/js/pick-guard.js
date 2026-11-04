// 选人保底（防超时随机 / 防走神挂机）
// 与「备战区助手」同一类：读本地选人会话 → 判断窗口 → 替你出手 → 不需要你盯屏幕。
//
// 机制（全部来自 LCU 会话，不新增任何网络请求）：
//   · 轮到你选人（action.isInProgress）时若 action.championId 仍为 0，说明你还没悬停。
//     LCU 超时会锁「当前悬停的英雄」，没有悬停就只能随机（或判未选）。这里补一个悬停，
//     你之后仍可自由换人 —— 补位不锁定，不剥夺你最后的选择权。
//   · 补位等待 3 秒再动手：你点英雄到 WS 推回来有延迟，抢在中间会把你刚选的覆盖掉。
//   · 剩余时间低于 8 秒时不再等待，直接补。
//   · 「超时自动锁定」为可选（默认关闭）：开启后剩余 N 秒仍未锁定才 POST complete。
//
// 英雄来源：优先用「自动 BP」里配置的 pick 池；池子为空时退回客户端熟练度前 10，
// 新装用户不用配置也能用。

let pickGuardOn = false;
let pickGuardLockSec = 0;        // 0 = 只补悬浮，不自动锁定
let _pickGuardBusy = false;
let _pickGuardWait = new Map();  // actionId -> 首次看到「轮到我且未悬停」的时间
let _pickGuardDone = new Map();  // actionId -> 已经补过的英雄 id（同一动作只补一次）
let _pickGuardMastery = null;    // { at, ids } 熟练度池缓存
let _pickGuardSessionKey = '';
let _pickGuardHits = 0;          // 本次运行补位次数（诊断用）

const PICK_GUARD_WAIT_MS = 3000;   // 轮到我之后等这么久再补，避开「刚点完还没同步」
const PICK_GUARD_URGENT_MS = 8000; // 剩余不足 8 秒直接补，不再等
const PICK_GUARD_MASTERY_TTL = 10 * 60 * 1000;

function pickGuardPool() {
  const arr = (typeof autoBPHeroes !== 'undefined' && autoBPHeroes && Array.isArray(autoBPHeroes.pick))
    ? autoBPHeroes.pick : [];
  return arr.map(Number).filter(n => Number.isInteger(n) && n > 0);
}

// 熟练度池：只读接口，拿不到就返回空，功能降级为「需配置英雄池」
async function pickGuardLoadMastery() {
  const now = Date.now();
  if (_pickGuardMastery && now - _pickGuardMastery.at < PICK_GUARD_MASTERY_TTL) return _pickGuardMastery.ids;
  try {
    const list = await lolAPI.lcuRequest('GET', '/lol-champion-mastery/v1/local-player/champion-mastery');
    if (!Array.isArray(list)) return [];
    const ids = list
      .filter(x => x && Number(x.championId) > 0)
      .sort((a, b) => (Number(b.championPoints) || 0) - (Number(a.championPoints) || 0))
      .slice(0, 10)
      .map(x => Number(x.championId));
    _pickGuardMastery = { at: now, ids };
    return ids;
  } catch (e) { return []; }
}

async function pickGuardCandidates() {
  const pool = pickGuardPool();
  if (pool.length) return pool;
  return await pickGuardLoadMastery();
}

function pickGuardMyCell(session) {
  if (!session) return -1;
  if (Number.isInteger(session.localPlayerCellId) && session.localPlayerCellId >= 0) return session.localPlayerCellId;
  const me = (session.myTeam || []).find(p => p && window._myPuuid && p.puuid === window._myPuuid);
  return me && Number.isInteger(me.cellId) ? me.cellId : -1;
}

function pickGuardReset(force) {
  if (force) { _pickGuardWait.clear(); _pickGuardDone.clear(); }
}

function pickGuardState(text, tone) {
  const el = document.getElementById('pickGuardState');
  if (!el) return;
  el.textContent = text;
  el.style.color = tone === 'positive' ? 'var(--positive)' : (tone === 'negative' ? 'var(--negative)' : '');
}

function togglePickGuard(on) {
  if (on && !guardAutomation('选人保底')) {
    const t = document.getElementById('pickGuardToggle');
    if (t) t.checked = false;
    return;
  }
  pickGuardOn = !!on;
  storeSet('pickGuard', on ? '1' : '');
  pickGuardState(on ? (pickGuardLockSec > 0 ? `已开启 · 剩余 ${pickGuardLockSec} 秒自动锁定` : '已开启 · 只补悬停') : '已关闭', on ? 'positive' : '');
  if (!on) pickGuardReset(true);
}

function setPickGuardLock(value) {
  pickGuardLockSec = Math.max(0, Math.min(30, Number(value) || 0));
  storeSet('pickGuardLockSec', String(pickGuardLockSec));
  if (pickGuardOn) {
    pickGuardState(pickGuardLockSec > 0 ? `已开启 · 剩余 ${pickGuardLockSec} 秒自动锁定` : '已开启 · 只补悬停', 'positive');
  }
}

// 主入口：由 handleChampSelectEvent 每秒调用（已经过 1 秒限流）
async function pickGuardTick(session) {
  if (!pickGuardOn || complianceOn || !lcuConnected || _pickGuardBusy) return;
  // 自动 BP 正在写客户端时让路，避免两边对同一个动作各 PATCH 一次、后者覆盖前者。
  if (typeof _autoBPBusy !== 'undefined' && _autoBPBusy) return;
  if (!session || !Array.isArray(session.actions)) return;

  // 换了一局就清空上一局的等待/已补记录（actionId 会跨局复用）
  const key = String(session.gameId || session.timer?.phase || '') + ':' + (session.myTeam || []).map(p => p?.puuid || '').join('|');
  if (key !== _pickGuardSessionKey) { _pickGuardSessionKey = key; pickGuardReset(true); }

  const myCell = pickGuardMyCell(session);
  if (myCell < 0) return;

  const actions = session.actions.flat().filter(a => a && a.type === 'pick' && a.actorCellId === myCell);
  if (!actions.length) return;

  const timer = session.timer || {};
  const left = Number(timer.adjustedTimeLeftInPhase);
  const hasLeft = Number.isFinite(left) && left > 0;

  for (const action of actions) {
    if (action.completed) continue;
    const aid = String(action.id);
    const hovered = Number(action.championId) > 0;

    if (!action.isInProgress) {
      // 还没轮到我：清掉等待态，避免上一轮残留导致下一轮「零等待」就出手；
      // 也不在未轮到时就锁定（那是替用户做决定，超出保底范围）。
      _pickGuardWait.delete(aid);
      continue;
    }

    if (hovered) {
      _pickGuardWait.delete(aid);
      if (pickGuardLockSec > 0 && hasLeft && left <= pickGuardLockSec * 1000 && !_pickGuardDone.has('lock:' + aid)) {
        _pickGuardDone.set('lock:' + aid, true);
        const r = await lolAPI.lcuRequest('POST', `/lol-champ-select/v1/session/actions/${action.id}/complete`);
        if (!(r && r.__error)) toolMsg(`<span style="color:var(--positive)">选人保底：剩余 ${Math.ceil(left / 1000)} 秒，已替你锁定</span>`);
      }
      continue;
    }

    // 轮到我 + 尚未悬停
    if (_pickGuardDone.has(aid)) continue;
    const urgent = hasLeft && left <= PICK_GUARD_URGENT_MS;
    if (!urgent) {
      const seenAt = _pickGuardWait.get(aid) || 0;
      if (!seenAt) { _pickGuardWait.set(aid, Date.now()); continue; }
      if (Date.now() - seenAt < PICK_GUARD_WAIT_MS) continue;
    }

    const cands = await pickGuardCandidates();
    if (!cands.length) {
      pickGuardState('已开启 · 未找到可用英雄（请在「自动 BP」里配置 pick 池）', 'negative');
      return;
    }

    _pickGuardBusy = true;
    try {
      for (const id of cands) {
        const r = await lolAPI.lcuRequest('PATCH', `/lol-champ-select/v1/session/actions/${action.id}`, { championId: id });
        if (r && r.__error) continue;
        _pickGuardDone.set(aid, id);
        _pickGuardHits++;
        const name = pickGuardChampionName(id);
        toolMsg(`<span style="color:var(--positive)">选人保底：你还没选，已先悬停 ${name}</span><span class="text-muted">（仍可随时换人）</span>`);
        pickGuardState(`已开启 · 本局已补位 1 次${pickGuardLockSec > 0 ? ` · 剩余 ${pickGuardLockSec} 秒自动锁定` : ''}`, 'positive');
        break;
      }
    } finally { _pickGuardBusy = false; }
  }
}

function pickGuardChampionName(id) {
  try {
    if (typeof ensureChampMap === 'function') ensureChampMap();
    if (typeof champNumMap !== 'undefined' && champNumMap && champNumMap[id]) return champNumMap[id];
    const found = Object.values(typeof allChampions !== 'undefined' ? allChampions : {})
      .find(c => c && Number(c.key) === Number(id));
    return found ? (found.name || found.id) : ('英雄 ' + id);
  } catch (e) { return '英雄 ' + id; }
}

function pickGuardLoadConfig() {
  if (storeGet('pickGuard') === '1') {
    pickGuardOn = true;
    const t = document.getElementById('pickGuardToggle');
    if (t) t.checked = true;
  }
  const sec = Number(storeGet('pickGuardLockSec'));
  pickGuardLockSec = Number.isFinite(sec) && sec > 0 ? Math.min(30, sec) : 0;
  const sel = document.getElementById('pickGuardLock');
  if (sel) sel.value = String(pickGuardLockSec);
  if (pickGuardOn) pickGuardState(pickGuardLockSec > 0 ? `已开启 · 剩余 ${pickGuardLockSec} 秒自动锁定` : '已开启 · 只补悬停', 'positive');
}
