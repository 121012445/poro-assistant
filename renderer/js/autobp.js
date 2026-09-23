// 自动 BP
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// ========== 自动BP ==========
let autoBPEnabled = false;
let autoBPHeroes = { ban: [], pick: [] };
function toggleAutoBP(on) {
  if (on && !guardAutomation('自动BP')) { document.getElementById('autoBPToggle').checked = false; return; }
  autoBPEnabled = on;
  document.getElementById('autoBPStatus').textContent = on ? '已开启' : '未开启';
  document.getElementById('autoBPStatus').style.color = on ? 'var(--positive)' : '';
  saveConfig();
}

let premadeNotifyOn = true;
function togglePremadeNotify(on) {
  premadeNotifyOn = on;
  storeSet('premadeNotify', on ? '1' : '0');
  document.getElementById("premadeNotifyState").textContent = on ? "已开启" : "已关闭";
}
function showAutoBPConfig() {
  document.getElementById('autoBPModal').classList.add('show');
  renderAutoBPHeroList();
}
function closeAutoBPModal() {
  document.getElementById('autoBPModal').classList.remove('show');
}
function addAutoBPHero(type) {
  const input = document.getElementById(type === 'ban' ? 'autoBPBanInput' : 'autoBPPickInput');
  const val = input.value.trim();
  if (!val) return;
  let heroId = parseInt(val);
  if (isNaN(heroId)) {
    // 按名字/称号搜索 (zh_CN 的 name 字段是称号)
    const found = Object.values(allChampions).find(c =>
      c.name === val || (c.title || '') === val || c.id?.toLowerCase() === val.toLowerCase() ||
      (c.name || '').includes(val) || (c.title || '').includes(val)
    );
    if (found) heroId = found.key;
  }
  if (heroId && !autoBPHeroes[type].includes(heroId)) {
    autoBPHeroes[type].push(heroId);
    input.value = '';
    renderAutoBPHeroList();
  }
}
function removeAutoBPHero(type, idx) {
  autoBPHeroes[type].splice(idx, 1);
  renderAutoBPHeroList();
}
function renderAutoBPHeroList() {
  ['ban', 'pick'].forEach(type => {
    const el = document.getElementById(type === 'ban' ? 'autoBPBanList' : 'autoBPPickList');
    el.innerHTML = autoBPHeroes[type].map((id, i) => {
      const name = allChampions[id]?.name || id;
      return `<span style="display:inline-flex;align-items:center;gap:2px;background:#2a2a3a;padding:2px 6px;border-radius:4px;font-size:11px;">
        ${name} <span onclick="removeAutoBPHero('${type}',${i})" style="cursor:pointer;color:#f44;">×</span>
      </span>`;
    }).join('');
  });
}
async function doAutoBP() {
  if (!autoBPEnabled || !lcuConnected || complianceOn) return;
  try {
    const session = await lolAPI.lcuRequest('GET', '/lol-champ-select/v1/session');
    if (!session || !session.actions) return;
    
    const mySlot = (session.myTeam || []).find(p => p.puuid === window._myPuuid);
    if (!mySlot) return;
    
    const allActions = session.actions.flat();
    const myActions = allActions.filter(a => a.actorCellId === mySlot.cellId && !a.completed);
    
    for (const action of myActions) {
      if (action.type === 'ban' && autoBPHeroes.ban.length > 0) {
        for (const heroId of autoBPHeroes.ban) {
          try {
            await lolAPI.lcuRequest('PATCH', `/lol-champ-select/v1/session/actions/${action.id}`, { championId: heroId });
            break;
          } catch (e) {}
        }
      } else if (action.type === 'pick' && autoBPHeroes.pick.length > 0) {
        // 预选→锁定: PATCH 设英雄后, 轮到我们(isInProgress)时 POST complete 完成选择
        for (const heroId of autoBPHeroes.pick) {
          try {
            await lolAPI.lcuRequest('PATCH', `/lol-champ-select/v1/session/actions/${action.id}`, { championId: heroId });
            if (action.isInProgress) {
              await lolAPI.lcuRequest('POST', `/lol-champ-select/v1/session/actions/${action.id}/complete`);
            }
            break;
          } catch (e) {}
        }
      }
    }
  } catch (e) {}
}
