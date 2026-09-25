const { ipcRenderer, contextBridge } = require('electron');
contextBridge.exposeInMainWorld('lolAPI', {
  // 窗口控制
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  // Data Dragon
  getVersion: () => ipcRenderer.invoke('ddragon:getVersion'),
  getChampions: (v) => ipcRenderer.invoke('ddragon:getChampions', v),
  getChampionDetail: (v, id) => ipcRenderer.invoke('ddragon:getChampionDetail', v, id),
  getItems: (v) => ipcRenderer.invoke('ddragon:getItems', v),
  getSummonerSpells: (v) => ipcRenderer.invoke('ddragon:getSummonerSpells', v),
  getOpgg: () => ipcRenderer.invoke('opgg:champions'),
  getHexChampionAugments: (championId, scope) => ipcRenderer.invoke('hex:championAugments', championId, scope),
  // Riot API (远程战绩)
  getAccount: (region, gameName, tagLine, apiKey) => ipcRenderer.invoke('riot:getAccount', region, gameName, tagLine, apiKey),
  getMatchIds: (region, puuid, apiKey) => ipcRenderer.invoke('riot:getMatchIds', region, puuid, apiKey),
  getMatch: (region, matchId, apiKey) => ipcRenderer.invoke('riot:getMatch', region, matchId, apiKey),
  // LCU (本地客户端)
  lcuStatus: () => ipcRenderer.invoke('lcu:status'),
  lcuReconnect: () => ipcRenderer.invoke('lcu:reset'),
  lcuRequest: (method, path, body) => ipcRenderer.invoke('lcu:request', method, path, body),
  captureFullGameSettings: () => ipcRenderer.invoke('game-settings:capture-full'),
  applyFullGameSettings: () => ipcRenderer.invoke('game-settings:apply-full'),
  fullGameSettingsStatus: () => ipcRenderer.invoke('game-settings:full-status'),
  verifyFullGameSettings: () => ipcRenderer.invoke('game-settings:verify-full'),
  clearFullGameSettings: () => ipcRenderer.invoke('game-settings:clear-full'),
  // LCU WebSocket 事件流
  onLcuEvent: (cb) => { ipcRenderer.on('lcu:event', (e, d) => cb(d)); },
  onWsState: (cb) => { ipcRenderer.on('lcu:wsState', (e, d) => cb(d)); },
  reportPhase: (phase) => ipcRenderer.send('phase:report', phase),
  // SGP (国服官方网关, 完整战绩)
  sgpMatchHistory: (platformId, puuid, startIndex, count, tag) => ipcRenderer.invoke('sgp:matchHistory', platformId, puuid, startIndex, count, tag),
  sgpInvalidateMatchHistory: (puuid) => ipcRenderer.invoke('sgp:invalidateMatchHistory', puuid),
  sgpSummonerByPuuid: (platformId, puuid) => ipcRenderer.invoke('sgp:summonerByPuuid', platformId, puuid),
  sgpGameSummary: (platformId, gameId) => ipcRenderer.invoke('sgp:gameSummary', platformId, gameId),
  sgpGameDetails: (platformId, gameId) => ipcRenderer.invoke('sgp:gameDetails', platformId, gameId),
  // Live Client Data (对局内 2999 端口)
  liveGameData: () => ipcRenderer.invoke('live:gameData'),
  livePlayerlist: () => ipcRenderer.invoke('live:playerlist'),
  // 文件读写 (持久化配置, 仅限 userData 白名单目录)
  readFile: (path) => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path, content) => ipcRenderer.invoke('fs:writeFile', path, content),
  exportBackup: (payload) => ipcRenderer.invoke('backup:export', payload),
  importBackup: () => ipcRenderer.invoke('backup:import'),
  getUserData: () => ipcRenderer.invoke('app:userData'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  // 全局快捷键 (游戏内 F7/F8 发送 KDA 简报)
  onShortcut: (cb) => { ipcRenderer.on('shortcut:kda', (e, ally) => cb(ally)); },
  onAugmentShortcut: (cb) => { ipcRenderer.on('shortcut:augment', () => cb()); },
  recognizeAugments: (candidates) => ipcRenderer.invoke('game:recognizeAugments', candidates),
  augmentOverlayUpdate: (payload) => ipcRenderer.invoke('augment-overlay:update', payload),
  augmentOverlayStatus: () => ipcRenderer.invoke('augment-overlay:status'),
  onAugmentOverlayData: (cb) => { ipcRenderer.on('augment-overlay:data', (e, d) => cb(d)); },
  // 对局内简报: 可预填，也可在用户明确启用的快捷键流程中直接发送
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  prefillGameChat: (text, activate) => ipcRenderer.invoke('game:prefillChat', text, !!activate),
  sendGameChatNow: (text, activate) => ipcRenderer.invoke('game:sendChat', text, !!activate),
  // 系统通知 (游戏中主窗口不可见时的反馈通道)
  notify: (title, body) => ipcRenderer.send('app:notify', { title, body }),
  // 诊断日志 (渲染层关键链路写入 crash.log 便于排查)
  debugLog: (msg) => ipcRenderer.send('app:debugLog', String(msg)),
  getRecentLogs: () => ipcRenderer.invoke('diag:recentLogs'),
  // AI 复盘 (OpenAI 兼容接口, API Key 由主进程安全存储)
  getAiConfig: () => ipcRenderer.invoke('ai:getConfig'),
  saveAiConfig: (config) => ipcRenderer.invoke('ai:saveConfig', config),
  aiChat: (messages) => ipcRenderer.invoke('ai:chat', messages),
  // 设置 (托盘/自启)
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setAutoLaunch: (on) => ipcRenderer.invoke('settings:autoLaunch', on),
  // 系统
  fixWindow: () => ipcRenderer.invoke('system:fixWindow'),
  // 选人浮窗 (备战区助手): 主窗口推数据 / 收点击, 浮窗收数据 / 发点击
  overlayUpdate: (payload) => ipcRenderer.invoke('overlay:update', payload),
  overlayStatus: () => ipcRenderer.invoke('overlay:status'),
  onOverlaySwap: (cb) => { ipcRenderer.on('overlay:swap', (e, id) => cb(id)); },
  onOverlayHidden: (cb) => { ipcRenderer.on('overlay:hidden', () => cb()); },
  onOverlayData: (cb) => { ipcRenderer.on('overlay:data', (e, d) => cb(d)); },
  overlaySwap: (championId) => ipcRenderer.invoke('overlay:swap', championId),
  overlayHide: () => ipcRenderer.invoke('overlay:hide')
});
