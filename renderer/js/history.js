// 战绩查询 + 对局详情
// 由 _debug_archive/split_renderer.py 从 app.js 抽出; 依赖 utils.js 与 app.js 里的全局函数,
// 因此 index.html 中必须排在 app.js 之前加载。

// 战绩查询已经统一到首页；本文件只保留静态映射辅助与对局详情。
function ensureChampMap() {
  // 空表也要重建: 首页提速后可能先于 DDragon 数据渲染, 早期调用会创建空映射表
  if (!champNumMap || !Object.keys(champNumMap).length) {
    champNumMap = {};
    Object.keys(allChampions).forEach(k => { champNumMap[allChampions[k].key] = { id: k, name: allChampions[k].name }; });
  }
}
// 国服战绩/选人接口对新英雄使用 60000+国际ID (60011=剑圣11), 需归一化
function normalizeChampId(id) { id = +id; return id >= 60000 ? id - 60000 : id; }
// ========== 对局详情 (全部玩家数据 + MVP/SVP) ==========
function closeGameModal() { document.getElementById("gameModal").classList.remove("active"); }
