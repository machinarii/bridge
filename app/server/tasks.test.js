import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createTask, getTask, listTasks, updateTask, nextQueued, tasksForAgent, _resetForTests } =
  await import('./tasks.js');

test('createTask persists a queued task with defaults', () => {
  const t = createTask({ projectId: 'p1', agentId: 'a1', description: 'write the PRD' });
  assert.match(t.id, /^t_\d+$/);
  assert.equal(t.status, 'queued');
  assert.equal(t.attempts, 0);
  assert.equal(t.output, null);
  // survives a cache reset (re-read from disk)
  _resetForTests();
  assert.equal(getTask(t.id).description, 'write the PRD');
});

test('listTasks filters by project; tasksForAgent by agent + status', () => {
  const a = createTask({ projectId: 'pX', agentId: 'agA', description: 'one' });
  createTask({ projectId: 'pY', agentId: 'agB', description: 'two' });
  assert.deepEqual(listTasks('pX').map(t => t.id), [a.id]);
  updateTask(a.id, { status: 'blocked_on_user' });
  assert.equal(tasksForAgent('agA', 'blocked_on_user').length, 1);
  assert.equal(tasksForAgent('agA', 'queued').length, 0);
});

test('updateTask merges a patch and bumps updatedAt; nextQueued returns oldest queued', () => {
  const t1 = createTask({ projectId: 'pQ', agentId: 'a1', description: 'first' });
  const t2 = createTask({ projectId: 'pQ', agentId: 'a2', description: 'second' });
  assert.equal(nextQueued('pQ').id, t1.id);
  const before = getTask(t1.id).updatedAt;
  const u = updateTask(t1.id, { status: 'done', output: 'ok' });
  assert.equal(u.status, 'done');
  assert.ok(u.updatedAt >= before);
  assert.equal(nextQueued('pQ').id, t2.id);
  assert.equal(updateTask('t_nope', { status: 'done' }), null);
});
