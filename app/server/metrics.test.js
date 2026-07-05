import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, metrics;
before(async () => { tmp = mkdtempSync(join(tmpdir(), 'bridge-metrics-')); process.env.BRIDGE_STATE_DIR = tmp; metrics = await import('./metrics.js'); });
after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });
beforeEach(() => {
  if (existsSync(metrics.metricsFile())) writeFileSync(metrics.metricsFile(), '');
  if (existsSync(metrics.metricsFile() + '.1')) rmSync(metrics.metricsFile() + '.1');
  delete process.env.BRIDGE_METRICS;
  delete process.env.BRIDGE_METRICS_MAX_BYTES;
});

function lines() {
  const f = metrics.metricsFile();
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

test('records a call with model, role, kind, latency, and token usage', () => {
  metrics.recordModelCall({ model: 'a/x', role: 'designer', kind: 'agent', latencyMs: 123.7, usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, ok: true });
  const [r] = lines();
  assert.equal(r.model, 'a/x');
  assert.equal(r.role, 'designer');
  assert.equal(r.kind, 'agent');
  assert.equal(r.latencyMs, 124);        // rounded
  assert.equal(r.promptTokens, 10);
  assert.equal(r.completionTokens, 20);
  assert.equal(r.totalTokens, 30);
  assert.equal(r.ok, true);
  assert.ok(typeof r.ts === 'number');
});

test('missing usage / fields default to null, ok coerced to boolean', () => {
  metrics.recordModelCall({ model: 'a/x', ok: 0 });
  const [r] = lines();
  assert.equal(r.role, null);
  assert.equal(r.kind, null);
  assert.equal(r.promptTokens, null);
  assert.equal(r.totalTokens, null);
  assert.equal(r.latencyMs, null);
  assert.equal(r.ok, false);
});

test('records orchestration events with counts', () => {
  metrics.recordOrchestrationEvent({
    projectId: 'p1',
    kind: 'team_voice',
    latencyMs: 42.4,
    counts: { assigned: 3, timedOut: 1 },
    ok: true,
  });
  const [r] = lines();
  assert.equal(r.type, 'orchestration');
  assert.equal(r.projectId, 'p1');
  assert.equal(r.kind, 'team_voice');
  assert.equal(r.latencyMs, 42);
  assert.deepEqual(r.counts, { assigned: 3, timedOut: 1 });
  assert.equal(r.ok, true);
});

test('BRIDGE_METRICS=off disables orchestration logging', () => {
  process.env.BRIDGE_METRICS = 'off';
  metrics.recordOrchestrationEvent({ projectId: 'p1', kind: 'team_voice' });
  assert.equal(lines().length, 0);
});

test('BRIDGE_METRICS=off disables logging', () => {
  process.env.BRIDGE_METRICS = 'off';
  metrics.recordModelCall({ model: 'a/x', ok: true });
  assert.equal(lines().length, 0);
});

test('appends one line per call', () => {
  metrics.recordModelCall({ model: 'a/x', ok: true });
  metrics.recordModelCall({ model: 'b/y', ok: true });
  assert.equal(lines().length, 2);
});

test('rolls to a .1 generation once the file passes the size cap', () => {
  process.env.BRIDGE_METRICS_MAX_BYTES = '200';   // tiny cap so a couple calls trip it
  for (let i = 0; i < 10; i++) metrics.recordModelCall({ model: 'a/x', role: 'r', ok: true });
  assert.ok(existsSync(metrics.metricsFile() + '.1'), 'a rolled .1 file was created');
});
