// app/server/server-metrics.js
/* Minimal server-side metrics for quick diagnostics and health panel display. */

const counters = {
  requests: 0,
  errors5xx: 0,
  canceled: 0,
};

const startedAt = Date.now();

export function countRequest() { counters.requests += 1; }
export function countError5xx() { counters.errors5xx += 1; }
export function countCanceled() { counters.canceled += 1; }

export function snapshotMetrics() {
  return {
    startedAt,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    ...counters,
  };
}
