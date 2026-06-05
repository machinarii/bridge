import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createProject, deleteProject } = await import('./projects.js');

test('deleteProject preserves the repo and drops a #PROJECT-REMOVED.md marker', async () => {
  const p = await createProject({ name: 'To Remove', goal: 'g', roleIds: ['pm'], topology: 'hub-and-spoke' });
  const repo = p.repoPath;
  assert.ok(existsSync(repo), 'repo exists before removal');
  try {
    deleteProject(p.id);
    // The user's repo is NOT deleted...
    assert.ok(existsSync(repo), 'repo preserved after removal');
    // ...and a top-sorted marker explains why.
    const marker = resolve(repo, '#PROJECT-REMOVED.md');
    assert.ok(existsSync(marker), 'marker written');
    const body = readFileSync(marker, 'utf8');
    assert.match(body, /removed from the Bridge app by the user on /i);
    assert.match(body, /# PROJECT REMOVED/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
