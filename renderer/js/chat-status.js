// 在线状态与个性签名 (好友列表里别人看到的你)
//   PUT /lol-chat/v1/me  只传要改的字段: { availability } 或 { statusMessage }
//   availability: chat 在线 / mobile 手机在线 / away 离开 / dnd 勿扰 / offline 隐身
//   (online / spectating 由客户端自己设置, 不提供手动选择)
// 「锁定」: 客户端在进入对局、返回大厅、重连时会把状态改回在线。勾选后, 每次发现状态被改了就改回你选的 (限速, 不会刷屏)。
// 全部写操作都受合规模式约束 (guardWrite)。

const CHAT_AVAILABILITY = [
  { value: 'chat', label: '在线' },
  { value: 'mobile', label: '手机在线' },
  { value: 'away', label: '离开' },
  { value: 'dnd', label: '勿扰' },
  { value: 'offline', label: '隐身' }
];
const CHAT_STATUS_MAX_LEN = 250;                // 客户端对签名有长度限制, 超过会被拒绝; 这里保守截断
const CHAT_LOCK_MIN_INTERVAL_MS = 15 * 1000;     // 锁定状态: 两次改回之间至少间隔
let _chatLock = { on: false, value: '' };
let _chatLockLastApplyAt = 0;
let _chatLockBusy = false;

function chatStatusKnown(value) { return CHAT_AVAILABILITY.some(x => x.value === value); }

// 控制字符 (含换行) 换成空格、连续空白折叠成一个、去首尾空白、限长。签名是单行文本, 不保留换行
function sanitizeStatusMessage(text) {
  return String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, CHAT_STATUS_MAX_LEN);
}

async function chatPutMe(body) {
  const r = await lolAPI.lcuRequest('PUT', '/lol-chat/v1/me', body);
  if (r && r.__error) throw new Error(r.message || r.__error);
  return r;
}

async function setChatAvailability(value, opts) {
  if (!chatStatusKnown(value)) { toolMsg('<span style="color:var(--negative)">不支持的状态</span>'); return false; }
  if (!guardWrite('修改在线状态')) return false;
  try {
    await chatPutMe({ availability: value });
    _chatLockLastApplyAt = Date.now();
    if (!opts || !opts.silent) toolMsg('<span style="color:var(--positive)">在线状态已改为「' + CHAT_AVAILABILITY.find(x => x.value === value).label + '」</span>');
    return true;
  } catch (e) {
    toolMsg('<span style="color:var(--negative)">修改失败: ' + escapeHtml(e.message) + '</span>');
    return false;
  }
}

async function applyChatStatusMessage() {
  const input = document.getElementById('chatStatusMessage');
  const text = sanitizeStatusMessage(input ? input.value : '');
  if (!guardWrite('修改个性签名')) return false;
  try {
    await chatPutMe({ statusMessage: text });
    storeSet('chatStatusMessage', text);
    toolMsg('<span style="color:var(--positive)">' + (text ? '个性签名已更新' : '个性签名已清空') + '</span>');
    return true;
  } catch (e) {
    toolMsg('<span style="color:var(--negative)">修改失败: ' + escapeHtml(e.message) + '</span>');
    return false;
  }
}

let _chatShownValue = '';                // 下拉框上一次确认生效的值, 修改失败时还原
function onChatAvailabilityChange(sel) {
  const value = sel && sel.value;
  if (!value) return;
  setChatAvailability(value).then(ok => {
    if (ok) {
      _chatShownValue = value;
      if (_chatLock.on) { _chatLock.value = value; storeSet('chatLockValue', value); }
    } else if (_chatShownValue) {
      sel.value = _chatShownValue;       // 失败了就别让下拉框显示一个没生效的状态
    }
  });
}

function toggleChatLock(on) {
  if (on && !guardAutomation('锁定在线状态')) { const el = document.getElementById('chatLockToggle'); if (el) el.checked = false; return; }
  const sel = document.getElementById('chatAvailability');
  _chatLock.on = !!on;
  if (on) _chatLock.value = (sel && chatStatusKnown(sel.value)) ? sel.value : 'offline';
  storeSet('chatLock', on ? '1' : '');
  storeSet('chatLockValue', on ? _chatLock.value : '');
  toolMsg(on ? '已锁定为「' + CHAT_AVAILABILITY.find(x => x.value === _chatLock.value).label + '」，客户端把状态改回去时会自动改回来' : '已取消锁定');
  if (on) chatLockEnforce();
}

// 由 LCU 事件 / 阶段变化 / 轮询调用: 发现当前状态和锁定值不一致就改回。限速并发保护。
async function chatLockEnforce() {
  if (!_chatLock.on || !chatStatusKnown(_chatLock.value) || complianceOn || _chatLockBusy) return false;
  if (Date.now() - _chatLockLastApplyAt < CHAT_LOCK_MIN_INTERVAL_MS) return false;
  _chatLockBusy = true;
  try {
    const me = await lolAPI.lcuRequest('GET', '/lol-chat/v1/me');
    if (!me || me.__error || !me.availability) return false;
    if (me.availability === _chatLock.value) return false;
    return await setChatAvailability(_chatLock.value, { silent: true });
  } catch (e) { return false; }
  finally { _chatLockBusy = false; }
}

function chatStatusLoad() {
  try {
    const lock = storeGet('chatLock') === '1';
    const value = storeGet('chatLockValue');
    _chatLock = { on: lock && chatStatusKnown(value), value: chatStatusKnown(value) ? value : '' };
  } catch (e) {}
  const sel = document.getElementById('chatAvailability');
  if (sel && !sel.options.length) sel.innerHTML = CHAT_AVAILABILITY.map(x => `<option value="${x.value}">${x.label}</option>`).join('');
  if (sel && _chatLock.on) sel.value = _chatLock.value;
  const t = document.getElementById('chatLockToggle');
  if (t) t.checked = _chatLock.on && !complianceOn;
  const msg = document.getElementById('chatStatusMessage');
  if (msg) msg.value = storeGet('chatStatusMessage') || '';
  if (msg) msg.maxLength = CHAT_STATUS_MAX_LEN;
}
