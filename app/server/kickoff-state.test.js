import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, getKickoff, setKickoff, deleteProject } from './projects.js';

test('kickoff state defaults to idle and round-trips', async () => {
  const p = await createProject({ name: 'Kick Test', goal: 'ship a thing', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    assert.deepEqual(getKickoff(p.id), { status: 'idle' });
    setKickoff(p.id, { status: 'awaiting_approval', planTurnIndex: 3 });
    assert.equal(getKickoff(p.id).status, 'awaiting_approval');
    assert.equal(getKickoff(p.id).planTurnIndex, 3);
    setKickoff(p.id, { startedAt: 123 });
    assert.equal(getKickoff(p.id).status, 'awaiting_approval');
    assert.equal(getKickoff(p.id).startedAt, 123);
  } finally {
    deleteProject(p.id);
  }
});
