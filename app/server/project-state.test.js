import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createProject, getProject, deleteProject, setProjectState } = await import('./projects.js');

test('setProjectState shallow-merges arbitrary fields and persists', async () => {
  const p = await createProject({ name: 'State Test', goal: 'g', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    setProjectState(p.id, { phase: 'team_review' });
    assert.equal(getProject(p.id).phase, 'team_review');
    setProjectState(p.id, { teamReview: { idx: 0 } });
    assert.equal(getProject(p.id).phase, 'team_review');
    assert.deepEqual(getProject(p.id).teamReview, { idx: 0 });
    assert.equal(setProjectState('nope', { phase: 'x' }), null);
  } finally { deleteProject(p.id); }
});
