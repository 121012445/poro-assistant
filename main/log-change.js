'use strict';

// 日志"仅在变化时记录"辅助。
//
// 背景：渲染层会周期性推送同一份状态（浮窗可见性、强化 OCR 结果等），
// 主进程无条件记录会让这几行占满整个日志。2026-09-27 实测：
//   [AUGMENT OVERLAY] hide requested  515 行
//   [AUGMENT OCR] slot                483 行
//   = crash.log 的 55%，而它们每 12 秒就写一次。
// 日志按 512KB 轮转，一个会话就能把 `=== APP START ===` 挤进 .old ——
// 真正要排查"装完闪退"的启动行反而先没了。
//
// 用法：按"键"记忆上一次的内容，内容没变就不写，变了立刻写（不丢信息）。
// 只在进程内记忆，不落盘、不增长（键的个数由调用方固定，通常是个位数）。

function createChangeLog() {
  const seen = new Map();
  return {
    // 返回 true 表示"与上次不同，应当记录"
    shouldLog(key, line) {
      if (seen.get(key) === line) return false;
      seen.set(key, line);
      return true;
    },
    // 新一局 / 新一轮开始时清空，让下一笔一定落盘。
    // 不传 key 清空全部。
    reset(key) {
      if (key === undefined) seen.clear();
      else seen.delete(key);
    },
    // 仅用于测试与诊断：当前记住了多少个键
    size() { return seen.size; }
  };
}

module.exports = { createChangeLog };
