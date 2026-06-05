// app/server/scaffold-endpoints.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createProject, deleteProject } = await import('./projects.js');
const { writeNote } = await import('./backends/notes.js');
const { proposeBuildPlan, runScaffold } = await import('./scaffold.js');

test('proposeBuildPlan + runScaffold drive the engine and return JSON-able results', async () => {
  const p = await createProject({ name: 'Endpoint Go', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n');
    const plan = await proposeBuildPlan(p.id, {
      callText: async () => JSON.stringify({ stack: 'node', summary: 's', files: [{ path: 'a.js', purpose: 'p' }] }),
    });
    assert.equal(plan.files.length, 1);
    const r = await runScaffold(p.id, { callText: async () => 'content\n' });
    assert.equal(r.ok, true);
    assert.match(r.commitSha, /^[0-9a-f]{7,}$/);
    // unknown project → null / ok:false, not a throw
    assert.equal(await proposeBuildPlan('nope', { callText: async () => '{}' }), null);
  } finally { deleteProject(p.id); }
});
