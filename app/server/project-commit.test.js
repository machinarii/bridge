import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createProject, deleteProject } = await import('./projects.js');

test('createProject commits initial docs so the repo has clean history', async () => {
  const p = await createProject({ name: 'Has Commit', goal: 'g', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    const log = execFileSync('git', ['log', '--oneline'], { cwd: p.repoPath }).toString();
    assert.match(log, /Initialize project docs/);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: p.repoPath }).toString().trim(), '', 'clean tree after commit');
  } finally { deleteProject(p.id); }
});
