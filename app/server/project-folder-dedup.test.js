import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createProject, deleteProject } = await import('./projects.js');

test('two projects with the same name get distinct, non-redundant repo folders', async () => {
  const a = await createProject({ name: 'Same Name', goal: 'g', roleIds: ['pm'], topology: 'hub-and-spoke' });
  const b = await createProject({ name: 'Same Name', goal: 'g', roleIds: ['pm'], topology: 'hub-and-spoke' });
  try {
    assert.notEqual(a.repoPath, b.repoPath, 'distinct repo folders');
    assert.match(a.repoPath, /[/\\]same-name$/);
    assert.match(b.repoPath, /[/\\]same-name-2$/);
    assert.ok(existsSync(a.repoPath) && existsSync(b.repoPath));
  } finally { deleteProject(a.id); deleteProject(b.id); }
});

test("re-creating a removed project's name does NOT reuse its preserved folder", async () => {
  const a = await createProject({ name: 'Recreate Me', goal: 'g', roleIds: ['pm'], topology: 'hub-and-spoke' });
  const repoA = a.repoPath;
  deleteProject(a.id);                  // folder preserved (with #PROJECT-REMOVED.md)
  assert.ok(existsSync(repoA), 'removed project folder is preserved');
  const b = await createProject({ name: 'Recreate Me', goal: 'g', roleIds: ['pm'], topology: 'hub-and-spoke' });
  try {
    assert.notEqual(b.repoPath, repoA, 'new project gets a fresh folder, not the removed one');
    assert.match(b.repoPath, /[/\\]recreate-me-2$/);
  } finally {
    deleteProject(b.id);
    rmSync(repoA, { recursive: true, force: true });
  }
});
