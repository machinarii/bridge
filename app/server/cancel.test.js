import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createCancelToken, cancelToken, tokenStatus, throwIfCanceled, completeToken } = await import('./cancel.js');

test('cancel token lifecycle: create -> cancel -> throws -> complete', () => {
  const token = createCancelToken({ kind: 'run_fix', projectId: 'p1', ownerAgentId: 'a1' });
  const st0 = tokenStatus(token);
  assert.equal(st0.canceled, false);
  assert.equal(st0.kind, 'run_fix');

  assert.equal(cancelToken(token, 'user canceled'), true);
  const st1 = tokenStatus(token);
  assert.equal(st1.canceled, true);
  assert.match(st1.reason, /user canceled/i);

  assert.throws(() => throwIfCanceled(token), /user canceled/i);

  completeToken(token);
  assert.equal(tokenStatus(token), null);
  assert.equal(cancelToken(token), false);
});

test('team voice observes a canceled operation token before starting work', async () => {
  process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-cancel-state-'));
  process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-cancel-repo-'));
  process.env.OPENROUTER_API_KEY = 'test-key';

  const { createProject, deleteProject } = await import('./projects.js');
  const { runTeamVoice } = await import('./team.js');
  const project = await createProject({
    name: 'Canceled Team Voice',
    goal: 'g',
    roleIds: ['pm', 'sw_engineer'],
    topology: 'hub-and-spoke',
  });

  try {
    const token = createCancelToken({ kind: 'team_interpret', projectId: project.id, ownerAgentId: project.leadAgentId });
    cancelToken(token, 'stop now');
    await assert.rejects(
      () => runTeamVoice({ projectId: project.id, text: 'delegate this', cancelToken: token }),
      (err) => err?.code === 'CANCELED' && /stop now/i.test(err.message),
    );
  } finally {
    deleteProject(project.id);
    delete process.env.OPENROUTER_API_KEY;
  }
});
