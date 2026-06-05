import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, getProject, deleteProject, ensureRepoPath } from './projects.js';

test('ensureRepoPath resolves once, persists, and creates a git repo', async () => {
  const base = mkdtempSync(join(tmpdir(), 'bridge-ws-'));
  const prev = process.env.BRIDGE_PROJECTS_BASE;
  process.env.BRIDGE_PROJECTS_BASE = base;
  const p = await createProject({ name: 'FinTech app', goal: 'trade stocks', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    const path1 = ensureRepoPath(p.id);
    assert.equal(path1, join(base, 'fintech-app'));
    assert.ok(existsSync(join(path1, '.git')), 'git repo created');
    assert.equal(getProject(p.id).repoPath, path1, 'persisted on the project');
    assert.equal(ensureRepoPath(p.id), path1);   // stable across calls
  } finally {
    deleteProject(p.id);
    rmSync(base, { recursive: true, force: true });
    if (prev === undefined) delete process.env.BRIDGE_PROJECTS_BASE;
    else process.env.BRIDGE_PROJECTS_BASE = prev;
  }
});
