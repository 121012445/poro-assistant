// 界面文案词典 (骨架)。键是中文原文, 值是目标语言 —— 这样现有代码不用改调用点,
// 只在需要翻译的地方传原文即可。
// 目前只覆盖导航与页面标题; 新增文案往这里加, 没收录的自动回落中文。
(function (root) {
  if (!root) return;
  root.PORO_I18N = {
    'zh-CN': {},
    en: {
      '首页': 'Home',
      '我的画像': 'My profile',
      '成长': 'Growth',
      '英雄库': 'Champions',
      '克制关系': 'Counters',
      '实时对局': 'Live game',
      '强化资料': 'Augments',
      '工具箱': 'Toolbox',
      '玩家记忆': 'Player memory',
      '车队': 'Team',
      '收起': 'Collapse',
      '展开': 'Expand'
    }
  };
})(typeof window !== 'undefined' ? window : this);
