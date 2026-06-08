import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, deleteProject } from './projects.js';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), "bridge-state-")); // isolate state — never touch app/state
import { writeNote } from './backends/notes.js';
import { buildFileTree, readProjectFile } from './server-files.js';

test('buildFileTree lists repo docs (charters + notes, no legacy project.md); readProjectFile reads + guards', async () => {
  const base = mkdtempSync(join(tmpdir(), 'bridge-ws-'));
  const prev = process.env.BRIDGE_PROJECTS_BASE;
  process.env.BRIDGE_PROJECTS_BASE = base;
  const p = await createProject({ name: 'Files Test', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n');
    const tree = buildFileTree(p.id);
    assert.equal(tree.projectMd, null);   // new projects seed PRD.md, not project.md
    assert.ok(tree.notes.some(n => n.path === 'docs/PRD.md'), 'PRD listed');
    assert.ok(!tree.notes.some(n => n.path === 'docs/project.md'), 'project.md not in notes');
    assert.ok(tree.charters.length >= 1, 'charters listed');
    assert.equal(readProjectFile(p.id, 'docs/PRD.md'), '# PRD\n');
    assert.throws(() => readProjectFile(p.id, '../../etc/passwd'), /bad path/i);
    assert.throws(() => readProjectFile(p.id, 'docs/nope.md'), /not found/i);
  } finally {
    deleteProject(p.id);
    rmSync(base, { recursive: true, force: true });
    if (prev === undefined) delete process.env.BRIDGE_PROJECTS_BASE;
    else process.env.BRIDGE_PROJECTS_BASE = prev;
  }
});
