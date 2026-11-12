// Poro AI出装推荐引擎 (全局脚本版本)
'use strict';

// ========== 角色 / 伤害类型: 从 Data Dragon 数据动态推导 ==========
// 旧版是手写 5 条映射 + TODO, 170+ 英雄全落进 fighter/physical 兜底,
// 等于推荐永远按战士 AD 出装。现在直接用 champion.json 的 tags[0] (主定位)
// 和 info.attack / info.magic (官方 0-10 评分), 覆盖全部英雄。
const PORO_ROLE_BY_TAG = {
  Tank: 'tank',
  Fighter: 'fighter',
  Assassin: 'assassin',
  Mage: 'mage',
  Marksman: 'marksman',
  Support: 'support',
};

// attack 与 magic 评分差多少才认定是纯 AD / 纯 AP, 否则按混伤处理
const PORO_DAMAGE_GAP = 3;

// 三套策略的装备配比: 核心装 + 鞋固定, 其余按输出/防御件数拉开差异
// (旧版三套策略用的切片逻辑在防御池只有 1 件时输出完全一样, 等于没做策略)
const PORO_STRATEGY_MIX = {
  aggressive: { off: 3, def: 0 },
  balanced: { off: 2, def: 1 },
  defensive: { off: 1, def: 2 },
};

// ========== 装备库 (ID 全部用 16.22.1 item.json 逐个校验存在) ==========
const PORO_ITEM = {
  // 物理核心
  IE: 3031, BT: 3072, SHIV: 3087, LORDDOM: 3036, HURRICANE: 3085,
  RFC: 3094, PD: 3046, BOTRK: 3153, COLLECTOR: 6676,
  HYDRA: 3074, BLACKCLEAVER: 3071, DEATH_DANCE: 6333, TRINITY: 3078,
  SHOJIN: 3161, FYAE: 6610,
  DUSKBLADE: 3179, ECLIPSE: 6692, YOUMUU: 3142, SERYLDA: 6694, SERPENT: 6695,
  // 法系核心
  RYLAI: 3116, DEATHCAP: 3089, VOIDSTAFF: 3135, ZHONYA: 3157,
  LICHBANE: 3100, LIANDRY: 6653, MORELO: 3165, NASHOR: 3115,
  // 防御
  SUNFIRE: 3068, THORNMAIL: 3075, DEADMAN: 3742, RANDUIN: 3143,
  FROZENHEART: 3110, SPIRIT: 3065, MAW: 3156, ABYSSAL: 2504,
  MERCSCIMITAR: 3139, LOCKET: 3190, REDEMPTION: 3107,
  // 鞋
  BERSERKER: 3006, SORC: 3020, TABI: 3047, MERCURY: 3111,
};

// 战士分两类, 出装差别极大: 破败是「普攻触发」装备, 只有靠攻速/平A打伤害的战士才吃得到。
// 之前 fighter 池把破败当通用首选, 导致剑魔/德莱厄斯/盖伦这类技能型战士全被塞了一把破败,
// 属于明确错配。Data Dragon 的 tags 只到 Fighter 这一层, 没有更细的划分, 所以按英雄区分。
const PORO_AA_FIGHTERS = new Set([
  'Jax', 'Irelia', 'Fiora', 'Yasuo', 'Yone', 'Tryndamere', 'MasterYi',
  'Viego', 'Warwick', 'Trundle', 'Belveth',
]);

// 各角色默认输出池 (坦克/辅助走防御补位)
const PORO_OFFENSIVE_POOL = {
  marksman: [PORO_ITEM.BOTRK, PORO_ITEM.LORDDOM, PORO_ITEM.HURRICANE, PORO_ITEM.RFC, PORO_ITEM.COLLECTOR],
  mage: [PORO_ITEM.VOIDSTAFF, PORO_ITEM.ZHONYA, PORO_ITEM.LICHBANE, PORO_ITEM.LIANDRY, PORO_ITEM.MORELO],
  assassin: [PORO_ITEM.YOUMUU, PORO_ITEM.SERYLDA, PORO_ITEM.SERPENT, PORO_ITEM.LORDDOM],
  // 技能型战士: 死舞 + 破甲 + 朔极, 不放破败。三件是为了让三套策略真的能拉开差别:
  // 输出池只有 2 件时, "激进 3 输出" 和 "平衡 2 输出 + 1 防" 会被防御池补齐成同一套。
  fighter: [PORO_ITEM.DEATH_DANCE, PORO_ITEM.SERYLDA, PORO_ITEM.SHOJIN],
  // 平A型战士: 破败是核心启动件
  'fighter-aa': [PORO_ITEM.BOTRK, PORO_ITEM.DEATH_DANCE, PORO_ITEM.SERYLDA],
  tank: [],
  support: [],
};

// ========== AI出装推荐引擎 ==========
const poroBuildEngine = {
  itemDatabase: null,
  championById: {},   // championId(number) -> DDragon champion 对象
  lastResult: null,

  /**
   * @param {Object} items      DDragon item.json 的 data
   * @param {Object} champions  DDragon champion.json 的 data (可选, 缺省则全部走兜底)
   */
  initialize(items, champions) {
    // 参数名刻意不叫 allItems/allChampions: 那样会和 app.js 的全局同名,
    // test_split_order 的静态扫描会误判成"加载期引用了后面脚本的声明"。
    this.itemDatabase = items || {};
    this.championById = {};
    const list = champions || {};
    Object.keys(list).forEach(name => {
      const c = list[name];
      if (!c) return;
      const id = Number(c.key);
      if (Number.isFinite(id) && id > 0) this.championById[id] = c;
    });
    console.log('[BuildEngine] Initialized with',
      Object.keys(this.itemDatabase).length, 'items /',
      Object.keys(this.championById).length, 'champions');
  },

  /**
   * 生成推荐
   * @param {number} myChampionId - 我的英雄ID
   * @param {Array} allies - 队友 [{championId}]
   * @param {Array} enemies - 敌人 [{championId}]
   * @returns {Object} 三套出装方案
   */
  recommend(myChampionId, allies, enemies) {
    if (!this.itemDatabase) {
      console.error('[BuildEngine] Not initialized');
      return null;
    }
    allies = Array.isArray(allies) ? allies : [];
    enemies = Array.isArray(enemies) ? enemies : [];

    const threats = this._analyzeThreats(enemies);
    const needs = this._analyzeNeeds(myChampionId, allies);
    const builds = this._generateBuilds(myChampionId, threats, needs);

    this.lastResult = {
      champion: this._championName(myChampionId),
      role: this._getRole(myChampionId),
      damageType: this._getDamageType(myChampionId),
      threats,
      needs,
      builds,
      timestamp: Date.now(),
    };
    return this.lastResult;
  },

  /**
   * 真实对局数据 (OP.GG) → 三套方案
   *
   * 本地规则分不清剑魔和剑姬: 两者 Data Dragon tags 都是 Fighter, 但真实数据里
   * 剑魔是「星蚀 / 朔极之矛 / 死亡之舞」, 剑姬是「破败 / 三相」。这种差异只能来自
   * 对局统计, 任何按标签写的规则都推不出来。所以只要拿到 OP.GG 的 itemBlocks 就走
   * 这里, 本地推算退化成离线/无数据时的兜底。
   *
   * @param {Object} realBuild { itemBlocks:[{title,items:[]}], version, mode, position }
   * @param {Object} meta      { champion, role, damageType } 用于标题展示
   */
  recommendFromReal(realBuild, meta) {
    const blocks = realBuild && Array.isArray(realBuild.itemBlocks) ? realBuild.itemBlocks : [];
    if (!blocks.length) return null;
    const titleOf = b => String((b && b.title) || '');
    const findBlock = re => blocks.find(b => re.test(titleOf(b)));
    const starterBlock = findBlock(/^出门装/);
    const bootBlock = findBlock(/^鞋子/);
    const lastBlock = findBlock(/^后期可选/);
    const coreBlocks = blocks.filter(b => /^核心出装/.test(titleOf(b)) && Array.isArray(b.items) && b.items.length);
    if (!coreBlocks.length) return null;

    const bootsId = bootBlock && bootBlock.items.length ? bootBlock.items[0] : 0;
    const fill = lastBlock && Array.isArray(lastBlock.items) ? lastBlock.items : [];
    const slots = ['aggressive', 'balanced', 'defensive'];
    const rankName = ['主流', '次选', '第三'];

    const builds = {};
    const labels = {};
    coreBlocks.slice(0, 3).forEach((block, i) => {
      const key = slots[i];
      const picked = [];
      const push = id => { if (id && picked.indexOf(id) === -1 && picked.length < 6) picked.push(id); };
      block.items.forEach(push);
      push(bootsId);
      // 不拿「后期可选」补满 6 格: 三套核心本来就高度重合 (剑魔前 3 件都是星蚀+死舞,
      // 只差中间一件), 用同一批补装填满会让三张卡看起来一模一样, 像没生效。
      // 后期补装单独列一行, 保留真实信息又不制造假差异。
      const pct = /\(([\d.]+)%\)/.exec(titleOf(block));
      labels[key] = rankName[i] + (pct ? ' ' + pct[1] + '%' : '');
      builds[key] = this._buildFromIds(picked, key, '真实对局数据, 按选取率排序');
    });

    // 出门装 / 鞋子备选单独写一行, 不占卡位
    const notes = [];
    if (starterBlock && starterBlock.items.length) {
      notes.push('出门装：' + starterBlock.items.map(id => this._itemName(id)).filter(Boolean).join(' · '));
    }
    if (bootBlock && bootBlock.items.length > 1) {
      const alt = bootBlock.items.slice(1).map(id => this._itemName(id)).filter(Boolean);
      if (alt.length) notes.push('鞋子备选：' + alt.join(' · '));
    }
    if (fill.length) {
      // 后期可选里常常把核心装又列一遍 (星蚀/死舞本来就在前三件), 排掉已出现过的
      const shown = new Set();
      coreBlocks.forEach(b => b.items.forEach(id => shown.add(id)));
      if (bootsId) shown.add(bootsId);
      const late = fill.filter(id => !shown.has(id)).slice(0, 5)
        .map(id => this._itemName(id)).filter(Boolean);
      if (late.length) notes.push('第 5-6 件常出：' + late.join(' · '));
    }

    const m = meta || {};
    return {
      champion: m.champion || '',
      role: m.role || '',
      damageType: m.damageType || '',
      real: true,
      source: 'OP.GG',
      version: realBuild.version || '',
      mode: realBuild.mode || '',
      position: realBuild.position || '',
      builds,
      labels,
      activeKey: slots[0],
      notes,
      timestamp: Date.now(),
    };
  },

  _buildFromIds(ids, strategy, description) {
    const items = ids.map(id => {
      const item = this.itemDatabase[id] || {};
      return {
        id,
        name: item.name || ('物品' + id),
        cost: item.gold ? (item.gold.total || 0) : 0,
        description: item.plaintext || '',
      };
    });
    return {
      strategy,
      items,
      description: description || '',
      totalCost: items.reduce((sum, it) => sum + it.cost, 0),
    };
  },

  _itemName(id) {
    const item = this.itemDatabase[id] || {};
    return item.name || '';
  },

  // 敌方威胁: 按真实伤害类型统计
  _analyzeThreats(enemies) {
    const threats = {
      physicalDamage: 0,
      magicalDamage: 0,
      tankiness: 0,
      cc: 0,
    };

    enemies.forEach(enemy => {
      if (!enemy) return;
      const id = Number(enemy.championId);
      const role = this._getRole(id);
      const damageType = this._getDamageType(id);

      if (damageType === 'physical') threats.physicalDamage += 1;
      else if (damageType === 'magical') threats.magicalDamage += 1;
      else if (damageType === 'mixed') {
        threats.physicalDamage += 0.5;
        threats.magicalDamage += 0.5;
      }

      if (role === 'tank') threats.tankiness += 1;
      // 刺客/辅助偏控制, 作为水银系装备的弱信号
      if (role === 'assassin' || role === 'support') threats.cc += 0.5;
    });

    return threats;
  },

  _analyzeNeeds(myChampionId, allies) {
    const needs = {
      damage: 0,
      tankiness: 0,
      utility: 0,
    };

    const allyRoles = allies
      .filter(p => p && Number(p.championId) !== Number(myChampionId))
      .map(p => this._getRole(Number(p.championId)));

    const damageRoles = allyRoles.filter(r => ['marksman', 'mage', 'assassin'].includes(r));
    if (damageRoles.length < 2) needs.damage = 1.0;

    const tankRoles = allyRoles.filter(r => ['tank', 'fighter'].includes(r));
    if (tankRoles.length < 1) needs.tankiness = 1.0;

    const supportRoles = allyRoles.filter(r => r === 'support');
    if (supportRoles.length < 1) needs.utility = 0.5;

    return needs;
  },

  _generateBuilds(championId, threats, needs) {
    const role = this._getRole(championId);
    const damageType = this._getDamageType(championId);

    const core = this._getCoreItems(role, damageType);
    const boots = this._getBoots(role, threats, damageType);

    // 坦克/辅助没有"输出件"可调配, 三套若按输出/防御件数切会完全重合。
    // 对这类角色改用抗性配比区分: 激进偏护甲贴脸, 保守偏魔抗抗消耗。
    if (role === 'tank' || role === 'support') {
      const armor = this._armorPool(threats);
      const mr = this._mrPool(threats);
      const rest = armor.concat(mr);
      return {
        aggressive: this._assembleBuild(core, boots, [], armor.slice(0, 3), 'aggressive', rest),
        balanced: this._assembleBuild(core, boots, [], armor.slice(0, 2).concat(mr.slice(0, 1)), 'balanced', rest),
        defensive: this._assembleBuild(core, boots, [], mr.slice(0, 2).concat(armor.slice(0, 1)), 'defensive', rest),
      };
    }

    const offPool = this._getOffensiveItems(role, damageType, championId);
    const defPool = this._getDefensiveItems(threats, needs);

    const builds = {};
    Object.keys(PORO_STRATEGY_MIX).forEach(strategy => {
      const mix = PORO_STRATEGY_MIX[strategy];
      builds[strategy] = this._assembleBuild(
        core, boots,
        offPool.slice(0, mix.off),
        defPool.slice(0, mix.def),
        strategy,
        defPool
      );
    });
    return builds;
  },

  /**
   * 组装方案。顺序: 核心 -> 鞋 -> 输出 -> 防御, 不足 6 格用防御池补齐
   * (坦克/辅助输出池为空时, 保证仍然给满 6 件而不是缩水成 4 件)
   */
  _assembleBuild(core, boots, offensive, defensive, strategy, fallbackPool) {
    const picked = [];
    const push = id => {
      if (id && picked.indexOf(id) === -1 && picked.length < 6) picked.push(id);
    };

    core.forEach(push);
    push(boots);
    offensive.forEach(push);
    defensive.forEach(push);
    (fallbackPool || []).forEach(push);

    const build = {
      strategy,
      items: [],
      description: '',
      totalCost: 0,
    };

    build.items = picked.map(itemId => {
      const item = this.itemDatabase[itemId] || {};
      return {
        id: itemId,
        name: item.name || `物品${itemId}`,
        cost: item.gold ? (item.gold.total || 0) : 0,
        description: item.plaintext || '',
      };
    });

    build.totalCost = build.items.reduce((sum, item) => sum + item.cost, 0);

    const descriptions = {
      aggressive: '激进出装：优先输出，适合顺风局',
      balanced: '平衡出装：攻防兼备，适合大多数情况',
      defensive: '保守出装：优先生存，适合逆风局',
    };
    build.description = descriptions[strategy] || '';

    return build;
  },

  _getCoreItems(role, damageType) {
    const coreByRole = {
      marksman: [PORO_ITEM.IE, PORO_ITEM.SHIV],
      mage: [PORO_ITEM.RYLAI, PORO_ITEM.DEATHCAP],
      assassin: [PORO_ITEM.DUSKBLADE, PORO_ITEM.ECLIPSE],
      tank: [PORO_ITEM.SUNFIRE, PORO_ITEM.THORNMAIL],
      fighter: [PORO_ITEM.HYDRA, PORO_ITEM.BLACKCLEAVER],
      support: [PORO_ITEM.REDEMPTION, PORO_ITEM.LOCKET],
    };
    const core = (coreByRole[role] || []).slice();
    // 物理型辅助不堆法强核心, 只留一件团队装
    if (role === 'support' && damageType === 'physical') {
      return [PORO_ITEM.LOCKET];
    }
    return core;
  },

  _getDefensiveItems(threats, needs) {
    const items = [];

    // 物理威胁占优 -> 护甲线
    if (threats.physicalDamage >= threats.magicalDamage) {
      items.push(PORO_ITEM.DEADMAN, PORO_ITEM.RANDUIN, PORO_ITEM.FROZENHEART);
    }
    // 有实际法系威胁才堆魔抗, 全 AD 阵容不出魔抗
    if (threats.magicalDamage > 0 && threats.magicalDamage >= threats.physicalDamage) {
      items.push(PORO_ITEM.SPIRIT, PORO_ITEM.MAW, PORO_ITEM.ABYSSAL);
    } else if (threats.magicalDamage > 0) {
      items.push(PORO_ITEM.SPIRIT);
    }

    // 控制多才出水银
    if (threats.cc > 2 && items.indexOf(PORO_ITEM.MERCSCIMITAR) === -1) {
      items.push(PORO_ITEM.MERCSCIMITAR);
    }

    return items;
  },

  // 护甲池: 敌方以物理为主时亡板优先, 否则先出冷却/减伤向的护甲
  _armorPool(threats) {
    const physFirst = [PORO_ITEM.DEADMAN, PORO_ITEM.RANDUIN, PORO_ITEM.FROZENHEART, PORO_ITEM.THORNMAIL];
    if (threats && threats.physicalDamage >= threats.magicalDamage) return physFirst;
    return [PORO_ITEM.FROZENHEART, PORO_ITEM.RANDUIN, PORO_ITEM.DEADMAN, PORO_ITEM.THORNMAIL];
  },

  // 魔抗池: 敌方法系为主时振奋优先, 否则先出带攻击性的玛莫
  _mrPool(threats) {
    const magFirst = [PORO_ITEM.SPIRIT, PORO_ITEM.MAW, PORO_ITEM.ABYSSAL];
    if (threats && threats.magicalDamage >= threats.physicalDamage) return magFirst;
    return [PORO_ITEM.MAW, PORO_ITEM.SPIRIT, PORO_ITEM.ABYSSAL];
  },

  _getOffensiveItems(role, damageType, championId) {
    // 战士要再细分一次: 平A型才给破败
    const poolKey = (role === 'fighter' && this._isAaFighter(championId)) ? 'fighter-aa' : role;
    const byRole = PORO_OFFENSIVE_POOL[poolKey] || [];
    const roleIsMagical = role === 'mage';
    const wantsMagical = damageType === 'magical';

    // 角色默认路线与实际伤害类型不符时 (如 AD 法师), 换成对应类型的输出池
    if (byRole.length && wantsMagical !== roleIsMagical) {
      return wantsMagical
        ? [PORO_ITEM.VOIDSTAFF, PORO_ITEM.ZHONYA, PORO_ITEM.LIANDRY]
        : [PORO_ITEM.LORDDOM, PORO_ITEM.BOTRK, PORO_ITEM.SERYLDA];
    }

    if (!byRole.length) {
      // 坦克/辅助: 给一件性价比输出, 其余位置留给防御池补
      return wantsMagical ? [PORO_ITEM.LIANDRY] : [PORO_ITEM.BOTRK];
    }

    return byRole.slice();
  },

  _getBoots(role, threats, damageType) {
    if (threats.cc > 2) return PORO_ITEM.MERCURY;
    // 鞋子的抗性要跟着敌方威胁走, 不能因为自己是 AD 就固定铁板靴:
    // 对面全法师时出护甲鞋等于白给, 优先水银靴
    if (threats.magicalDamage > threats.physicalDamage) return PORO_ITEM.MERCURY;
    if (threats.physicalDamage > 3) return PORO_ITEM.TABI;
    if (role === 'marksman') return PORO_ITEM.BERSERKER;
    // 法穿鞋只给法系。之前用 damageType===physical 判断, 混伤战士 (damageType='mixed')
    // 会掉进 else 拿到法师之靴 —— 武器大师出法穿鞋, 明显的错。
    if (role === 'mage' || role === 'support') return PORO_ITEM.SORC;
    return PORO_ITEM.TABI;
  },

  // 平A型战士判定 (靠 DDragon 的英文 id, 不是中文名)
  _isAaFighter(championId) {
    const c = this.championById[Number(championId)];
    return !!(c && PORO_AA_FIGHTERS.has(c.id));
  },

  _getRole(championId) {
    const c = this.championById[Number(championId)];
    const tags = (c && c.tags) || [];
    for (let i = 0; i < tags.length; i++) {
      const role = PORO_ROLE_BY_TAG[tags[i]];
      if (role) return role;   // tags[0] 是主定位, 命中即返回
    }
    return 'fighter';
  },

  _getDamageType(championId) {
    const c = this.championById[Number(championId)];
    const info = c && c.info;
    if (info && typeof info.attack === 'number' && typeof info.magic === 'number') {
      const gap = info.attack - info.magic;
      if (gap >= PORO_DAMAGE_GAP) return 'physical';
      if (gap <= -PORO_DAMAGE_GAP) return 'magical';
      return 'mixed';
    }
    // 没拿到英雄数据时按角色兜底, 而不是一律 physical
    const role = this._getRole(championId);
    if (role === 'mage' || role === 'support') return 'magical';
    if (role === 'tank') return 'mixed';
    return 'physical';
  },

  _championName(championId) {
    const c = this.championById[Number(championId)];
    return (c && c.name) || String(championId);
  },

  // 调试用: 打印某个英雄的推导结果, 验证映射是否合理
  describe(championId) {
    const c = this.championById[Number(championId)] || {};
    return {
      champion: c.name || String(championId),
      role: this._getRole(championId),
      damageType: this._getDamageType(championId),
      tags: c.tags || [],
      info: c.info || null,
    };
  },
};
