(function(root) {
  'use strict';
  const roles = { SpellDps:'持续法术', Burst:'爆发法术', Attack:'普攻输出', Assassin:'刺客收割', Fighter:'近战战士', Tank:'前排坦克', Support:'治疗保护' };
  // Product heuristics, not official roles. Only allow build-based switching between
  // reviewed candidates; AP items alone must not turn a tank into a burst mage.
  const profiles = {};
  function register(ids, candidates) { ids.forEach(id=>{ profiles[id]=candidates; }); }
  register([68,69,30,50,63,90,136,8,43,61], ['SpellDps']);
  register([11,23,24,10,67,96,22,51,119,222,429,15,18,29,498,523,221,895], ['Attack']);
  register([1,7,45,99,134,142,101,161,103,4,9,518], ['Burst']);
  register([35,28,55,38,84,105,91,238,121,107,555], ['Assassin']);
  register([16,40,37,117,350,267,902,432], ['Support']);
  register([12,201,111,89,223,78,516,14], ['Tank']);
  register([54,31,32,57], ['Tank','Burst']);
  register([85,112,127], ['Burst','SpellDps']);
  register([17,145,110,21,81], ['Attack','SpellDps']);
  register([76,60], ['Burst','Assassin']);
  register([164,114,122,86,266,420,58,875,240,80,92], ['Fighter']);
  register([5,19,2,48,77,102,106], ['Fighter','Tank']);
  function classify(champion, meta, participant={}, items={}) {
    const tags=Array.isArray(meta?.tags)?meta.tags:[];
    const fallback=tags.includes('Marksman')?'Attack':tags.includes('Tank')?'Tank':
      tags.includes('Assassin')?'Assassin':tags.includes('Mage')?'Burst':
      tags.includes('Fighter')?'Fighter':tags.includes('Support')?'Support':null;
    const candidates=profiles[champion] || (fallback?[fallback]:[]);
    if(!candidates.length) return {role:null,candidates:[],source:'unknown'};
    const counts={ap:0,attack:0,tank:0};
    const owned=Array.isArray(participant.items)?participant.items:[];
    for(const id of new Set(owned)) {
      const item=items[id], stats=item?.stats||{};
      if(!(Number(item?.gold?.total)>=2000) || item?.tags?.includes('Boots')) continue;
      if(Number(stats.FlatMagicDamageMod)>0) counts.ap++;
      if(Number(stats.FlatPhysicalDamageMod)>0 || Number(stats.PercentAttackSpeedMod)>0) counts.attack++;
      if(!(Number(stats.FlatMagicDamageMod)>0) && !(Number(stats.FlatPhysicalDamageMod)>0) &&
        (Number(stats.FlatArmorMod)>0 || Number(stats.FlatSpellBlockMod)>0)) counts.tank++;
    }
    let preferred=null;
    if(counts.ap>=2 && counts.ap>counts.attack && counts.ap>counts.tank) preferred=candidates.find(r=>r==='SpellDps'||r==='Burst');
    else if(counts.tank>=2 && counts.tank>counts.ap && counts.tank>counts.attack) preferred=candidates.find(r=>r==='Tank');
    else if(counts.attack>=2 && counts.attack>counts.ap && counts.attack>counts.tank) preferred=candidates.find(r=>r==='Attack'||r==='Fighter');
    return {role:preferred||candidates[0],candidates,source:preferred?'build':profiles[champion]?'reviewed':'fallback'};
  }
  const metric = n => n != null && Number.isFinite(Number(n)) && Number(n)>=0 ? Number(n) : null;
  const tips = {
    Fighter:'复盘进场时机与持续输出空间：区分承担前排与侧翼切入的对局。',
    Assassin:'复盘切入目标、关键技能交出后的进场时机，以及击杀后的撤离路线。',
    SpellDps:'复盘持续技能覆盖、施法距离与输出窗口，避免持续伤害尚未打满就被迫退出团战。',
    Burst:'复盘关键技能命中、连招与爆发目标，检查是否过早交技能错过输出窗口。',
    Attack:'复盘持续普攻时间、进场与收割时机，优先保证输出空间而非冒险追击。',
    Tank:'复盘开团后队友是否能跟上，以及何时应回身保护；承伤高不等于有效承伤。',
    Support:'复盘保护目标与技能使用时机，结合控制和队友跟进观察贡献，不能只看伤害。'
  };
  function aggregate(rows) {
    const average = field => {
      const available = rows.filter(r => r[field] != null);
      return available.length ? available.reduce((s,r)=>s+r[field],0)/available.length : null;
    };
    const rate = field => {
      const available = rows.filter(r => r[field] != null);
      return available.length ? available.reduce((s,r)=>s+r[field],0)/available.reduce((s,r)=>s+r.seconds,0)*60 : null;
    };
    const combat = rows.filter(r=>r.k!=null && r.d!=null && r.a!=null);
    const economy = rows.filter(r=>r.damage!=null && r.gold>0);
    return { count:rows.length, wins:rows.filter(r=>r.win).length,
      winRate:rows.length ? rows.filter(r=>r.win).length/rows.length : null,
      kda:combat.length ? combat.reduce((s,r)=>s+r.k+r.a,0)/Math.max(1,combat.reduce((s,r)=>s+r.d,0)) : null,
      deaths:average('d'), dpm:rate('damage'), tanking:rate('taken'), support:rate('support'),
      efficiency:economy.length ? economy.reduce((s,r)=>s+r.damage,0)/economy.reduce((s,r)=>s+r.gold,0)*100 : null };
  }
  function analyze(rows, catalog={}, selectedQueue='', items={}) {
    const seen=new Set(), valid=[];
    let unclassified=0;
    for (const {game:g,me:p} of rows || []) {
      if (!g || !p || !g.gid || !Number(g.queueId) || g.gameType==='CUSTOM_GAME' || !(Number(g.dur)>=300) || typeof p.win!=='boolean') continue;
      const id=String(g.platformId||'')+':'+g.gid;
      if(seen.has(id)) continue;
      seen.add(id);
      const champion=Number(p.championId)>=60000 ? Number(p.championId)-60000 : Number(p.championId);
      const meta=catalog[champion] || Object.values(catalog).find(c=>Number(c?.key)===champion);
      const classification=classify(champion,meta,p,items);
      const role=classification.role;
      const heal=metric(p.allyHeal), shield=metric(p.shielding);
      valid.push({queue:String(g.queueId),mode:String(g.mode||g.queueId),role,champion,source:classification.source,
        name:meta?.name||('英雄 #'+champion), win:p.win,seconds:Number(g.dur),
        k:metric(p.k),d:metric(p.d),a:metric(p.a),damage:metric(p.dmg),gold:metric(p.gold),
        taken:metric(p.dmgTaken),support:heal!=null && shield!=null ? heal+shield : null});
    }
    const modes=[...new Set(valid.map(r=>r.queue))].map(queue=>({queue,name:valid.find(r=>r.queue===queue).mode,count:valid.filter(r=>r.queue===queue).length})).sort((a,b)=>b.count-a.count||a.queue.localeCompare(b.queue));
    const queue=modes.some(m=>m.queue===String(selectedQueue))?String(selectedQueue):(modes[0]?.queue||'');
    const scope=valid.filter(r=>r.queue===queue);
    unclassified=scope.filter(r=>!r.role).length;
    const categories=Object.entries(roles).map(([role,name])=>{
      const list=scope.filter(r=>r.role===role);
      const champions=[...new Set(list.map(r=>r.champion))].map(id=>{
        const games=list.filter(r=>r.champion===id);
        return {id,name:games[0].name,...aggregate(games)};
      }).sort((a,b)=>(b.count>=3)-(a.count>=3) || (a.count>=3 && b.count>=3 ? b.winRate-a.winRate : 0) || b.count-a.count).slice(0,3);
      return {role,name,...aggregate(list),champions,tip:tips[role],buildCount:list.filter(r=>r.source==='build').length,fallbackCount:list.filter(r=>r.source==='fallback').length};
    });
    const eligible=categories.filter(c=>c.count>=5);
    const mostPlayed=categories.filter(c=>c.count).sort((a,b)=>b.count-a.count)[0]||null;
    const ranked=eligible.slice().sort((a,b)=>b.winRate-a.winRate||b.count-a.count);
    const best=ranked.length>=2 && ranked[0].winRate>ranked[1].winRate ? ranked[0] : null;
    for(const c of categories) {
      const field=c.role==='Tank'?'tanking':c.role==='Support'?'support':'dpm';
      const label=field==='tanking'?'每分钟承伤':field==='support'?'每分钟对友治疗与护盾':'每分钟英雄伤害';
      const peers=eligible.filter(x=>x.role!==c.role && x[field]!=null);
      c.strength=c.count<5 ? '样本不足 5 场，暂不判断优势。' :
        c[field]!=null && peers.length && peers.every(x=>c[field]>x[field])
        ? label+'在你有至少 5 场的类别中最高；类别机制差异会影响数值，并非全服水平排名。'
        : '暂无足够证据判断突出优势；下方为你的历史表现，不是能力评分。';
      if(c.count>=5 && c.winRate<0.5) c.tip='该类别历史胜率低于 50%，建议优先回看败局；胜率不能定位原因。'+c.tip;
      else c.tip='建议复盘方向（不代表已确认存在问题）：'+c.tip;
    }
    return {queue,modes,categories,mostPlayed,best,unclassified};
  }
  const api={roles,analyze,classify};
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
  else root.PoroProgress=api;
})(typeof window!=='undefined'?window:globalThis);
