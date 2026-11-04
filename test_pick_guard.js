// 选人保底（pick-guard.js）行为测试
// 沙箱里只加载 pick-guard.js 一个文件，其余全局全部打桩，
// 用可推进的假时钟验证「等待 3 秒再补位」「紧急时不等」这类时间相关分支。
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
}

const SRC = fs.readFileSync(path.join(__dirname, 'renderer/js/pick-guard.js'), 'utf8');

function makeEnv(opts = {}) {
  const calls = [];
  let now = 1700000000000;
  const ctx = {
    console,
    complianceOn: !!opts.complianceOn,
    lcuConnected: true,
    _autoBPBusy: !!opts.busy,
    autoBPHeroes: { ban: [], pick: opts.pool || [] },
    window: { _myPuuid: 'ME' },
    document: { getElementById: () => null },
    storeGet: () => null,
    storeSet: () => {},
    toolMsg: () => {},
    guardAutomation: () => true,
    Date: { now: () => now },
    lolAPI: {
      lcuRequest: async (method, url, body) => {
        calls.push({ method, url, body });
        if (/champion-mastery/.test(url)) return opts.mastery || [];
        if (opts.reject && opts.reject(method, url, body)) return { __error: true };
        return {};
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return {
    ctx, calls,
    advance: ms => { now += ms; },
    get: name => vm.runInContext(name, ctx),
    set: (name, v) => vm.runInContext(`${name} = ${JSON.stringify(v)}`, ctx),
    run: expr => vm.runInContext(expr, ctx),
    tick: s => vm.runInContext('pickGuardTick', ctx)(s)
  };
}

function session(o = {}) {
  return {
    gameId: o.gameId || 'G1',
    localPlayerCellId: 2,
    myTeam: [{ puuid: 'ME', cellId: 2 }],
    timer: { phase: 'BAN_PICK', adjustedTimeLeftInPhase: o.left === undefined ? 25000 : o.left },
    actions: [[{
      id: o.id === undefined ? 10 : o.id,
      actorCellId: 2,
      type: 'pick',
      championId: o.championId || 0,
      completed: !!o.completed,
      isInProgress: o.inProgress === undefined ? true : o.inProgress
    }]]
  };
}

(async () => {
  console.log('— 开关与门禁 —');
  {
    const e = makeEnv({ pool: [1, 2] });
    await e.tick(session());
    ok('未开启时不动作', e.calls.length === 0, e.calls);

    e.set('pickGuardOn', true);
    e.ctx.complianceOn = true;
    await e.tick(session());
    ok('合规模式不动作', e.calls.length === 0, e.calls);
  }
  {
    const e = makeEnv({ pool: [1], busy: true });
    e.set('pickGuardOn', true);
    await e.tick(session());
    ok('自动 BP 正在写客户端时让路', e.calls.length === 0, e.calls);
  }
  {
    const e = makeEnv({ pool: [1] });
    e.set('pickGuardOn', true);
    await e.tick(session({ inProgress: false }));
    e.advance(10000);
    await e.tick(session({ inProgress: false }));
    ok('还没轮到我时不出手', e.calls.length === 0, e.calls);
  }

  console.log('— 补悬停的时机 —');
  {
    const e = makeEnv({ pool: [55, 66] });
    e.set('pickGuardOn', true);
    await e.tick(session());
    ok('轮到我但还没悬停：首次只看不写', e.calls.length === 0, e.calls);

    e.advance(1000);
    await e.tick(session());
    ok('等待不足 3 秒仍不写', e.calls.length === 0, e.calls);

    e.advance(2500);
    await e.tick(session());
    const patch = e.calls.find(c => c.method === 'PATCH');
    ok('等待满 3 秒后补池里第一个', !!patch && patch.body.championId === 55, e.calls);
    ok('只补悬停、不锁定', !e.calls.some(c => /complete/.test(c.url)), e.calls);
  }
  {
    const e = makeEnv({ pool: [55] });
    e.set('pickGuardOn', true);
    await e.tick(session({ left: 6000 }));
    const patch = e.calls.find(c => c.method === 'PATCH');
    ok('剩余不足 8 秒时不再等待，立即补', !!patch, e.calls);
  }
  {
    const e = makeEnv({ pool: [55] });
    e.set('pickGuardOn', true);
    e.advance(-5000);
    await e.tick(session({ championId: 99 }));
    ok('已经悬停的英雄绝不覆盖', e.calls.length === 0, e.calls);
  }
  {
    const e = makeEnv({ pool: [55] });
    e.set('pickGuardOn', true);
    e.advance(-5000);
    await e.tick(session({ completed: true, championId: 99 }));
    ok('已完成的动作不再处理', e.calls.length === 0, e.calls);
  }

  console.log('— 候选来源 —');
  {
    const e = makeEnv({ pool: [], mastery: [
      { championId: 3, championPoints: 100 },
      { championId: 7, championPoints: 9000 },
      { championId: 9, championPoints: 400 }
    ] });
    e.set('pickGuardOn', true);
    await e.tick(session({ left: 5000 }));
    const patch = e.calls.find(c => c.method === 'PATCH');
    ok('池子为空时按熟练度取最高', !!patch && patch.body.championId === 7, e.calls);
  }
  {
    const e = makeEnv({ pool: [], mastery: [] });
    e.set('pickGuardOn', true);
    await e.tick(session({ left: 5000 }));
    ok('没有可用候选时不乱写', !e.calls.some(c => c.method !== 'GET'), e.calls);
  }
  {
    // 第一个候选被服务器拒（__error），应继续试下一个
    const e = makeEnv({ pool: [11, 22], reject: (m, u, b) => b && b.championId === 11 });
    e.set('pickGuardOn', true);
    await e.tick(session({ left: 5000 }));
    const patches = e.calls.filter(c => c.method === 'PATCH');
    ok('被拒后继续试下一个候选', patches.length === 2 && patches[1].body.championId === 22, patches);
  }
  {
    const e = makeEnv({ pool: [55] });
    e.set('pickGuardOn', true);
    await e.tick(session({ left: 5000 }));
    const n1 = e.calls.length;
    e.advance(5000);
    await e.tick(session({ left: 5000 }));
    ok('同一动作只补一次', e.calls.length === n1, e.calls.length);
  }

  console.log('— 超时自动锁定 —');
  {
    const e = makeEnv({ pool: [55] });
    e.set('pickGuardOn', true);
    e.set('pickGuardLockSec', 0);
    await e.tick(session({ championId: 99, left: 3000 }));
    ok('锁定关闭时不动已悬停的动作', e.calls.length === 0, e.calls);
  }
  {
    const e = makeEnv({ pool: [55] });
    e.set('pickGuardOn', true);
    e.set('pickGuardLockSec', 5);
    await e.tick(session({ championId: 99, left: 5000 }));
    ok('剩余 5 秒且已悬停 → 替用户锁定',
      e.calls.some(c => c.method === 'POST' && /\/complete$/.test(c.url)), e.calls);
    const n = e.calls.length;
    await e.tick(session({ championId: 99, left: 4000 }));
    ok('锁定只发一次', e.calls.length === n, e.calls.length);
  }
  {
    const e = makeEnv({ pool: [55] });
    e.set('pickGuardOn', true);
    e.set('pickGuardLockSec', 5);
    await e.tick(session({ championId: 99, left: 20000 }));
    ok('时间还早时不提前锁定', !e.calls.some(c => /complete/.test(c.url)), e.calls);
  }

  console.log('— 换局清理 —');
  {
    const e = makeEnv({ pool: [55] });
    e.set('pickGuardOn', true);
    await e.tick(session({ left: 5000 }));
    const n = e.calls.length;
    // 新的一局：动作 id 复用，但不应被上一局的「已补」记录挡住
    await e.tick(session({ gameId: 'G2', left: 5000, id: 10 }));
    ok('换局后同一动作 id 仍可补位', e.calls.length > n, { before: n, after: e.calls.length });
  }

  console.log(`\n选人保底: ${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
})();
