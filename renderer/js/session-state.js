'use strict';

// 单一对局身份源。页面可以各自保存视图数据，但异步结果必须能证明
// 自己仍属于当前账号和当前局，避免上一局或上一账号回填到新页面。
class PoroSessionState {
  constructor() {
    this.activePhases = new Set(['ChampSelect', 'GameStart', 'InProgress']);
    this.state = {
      generation: 0, phase: '', accountPuuid: '', platformId: '',
      gameId: '', rosterKey: '', championId: 0, updatedAt: Date.now()
    };
  }
  _bump() { this.state.generation++; this.state.updatedAt = Date.now(); }
  setAccount(puuid, platformId) {
    const nextPuuid = String(puuid || '');
    const nextPlatform = String(platformId || '').toUpperCase();
    if (nextPuuid && this.state.accountPuuid && nextPuuid !== this.state.accountPuuid) {
      this._bump();
      this.state.gameId = ''; this.state.rosterKey = ''; this.state.championId = 0;
    }
    if (nextPuuid) this.state.accountPuuid = nextPuuid;
    if (nextPlatform) this.state.platformId = nextPlatform;
    this.state.updatedAt = Date.now();
  }
  transition(phase) {
    const next = String(phase || ''), previous = this.state.phase;
    const entering = next === 'ChampSelect' && previous !== 'ChampSelect';
    const leaving = this.activePhases.has(previous) && !this.activePhases.has(next);
    if (entering || leaving) {
      this._bump();
      this.state.gameId = ''; this.state.rosterKey = ''; this.state.championId = 0;
    }
    this.state.phase = next; this.state.updatedAt = Date.now();
    return { entering, leaving, generation: this.state.generation };
  }
  setGame(gameId, rosterKey) {
    const nextGame = String(gameId || ''), nextRoster = String(rosterKey || '');
    if (nextGame && this.state.gameId && nextGame !== this.state.gameId) this._bump();
    if (nextGame) this.state.gameId = nextGame;
    if (nextRoster) this.state.rosterKey = nextRoster;
    this.state.updatedAt = Date.now();
  }
  setChampion(championId) {
    this.state.championId = Math.max(0, Number(championId) || 0);
    this.state.updatedAt = Date.now();
  }
  token() {
    return { generation: this.state.generation, accountPuuid: this.state.accountPuuid, gameId: this.state.gameId };
  }
  isCurrent(token) {
    return !!token && token.generation === this.state.generation
      && token.accountPuuid === this.state.accountPuuid
      && (!token.gameId || !this.state.gameId || token.gameId === this.state.gameId);
  }
  snapshot() { return { ...this.state }; }
}

window.poroSession = new PoroSessionState();
