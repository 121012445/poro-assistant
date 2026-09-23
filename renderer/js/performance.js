'use strict';

class PoroPerformance {
  constructor(limit = 60) { this.limit = limit; this.metrics = new Map(); }
  record(name, durationMs, meta = {}) {
    const key = String(name || 'unknown');
    const rows = this.metrics.get(key) || [];
    rows.push({ ms: Math.max(0, Math.round(Number(durationMs) || 0)), at: Date.now(), ...meta });
    if (rows.length > this.limit) rows.splice(0, rows.length - this.limit);
    this.metrics.set(key, rows);
  }
  summary() {
    const result = {};
    for (const [name, rows] of this.metrics) {
      const sorted = rows.map(row => row.ms).sort((a, b) => a - b);
      const percentile = p => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] || 0;
      result[name] = { count: rows.length, last: rows.at(-1)?.ms || 0, p50: percentile(0.5), p95: percentile(0.95) };
    }
    return result;
  }
}

window.poroPerf = new PoroPerformance();
