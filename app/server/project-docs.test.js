import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, deleteProject, docsDir, rolesDir } from './projects.js';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), "bridge-state-")); // isolate state — never touch app/state

test('docsDir/rolesDir resolve under the project repo and exist', async () => {
  const base = mkdtempSync(join(tmpdir(), 'bridge-ws-'));
  const prev = process.env.BRIDGE_PROJECTS_BASE;
  process.env.BRIDGE_PROJECTS_BASE = base;
  const p = await createProject({ name: 'Docs Test', goal: 'g', roleIds: ['pm'], topology: 'hub-and-spoke' });
  try {
    const docs = docsDir(p.id);
    assert.equal(docs, join(base, 'docs-test', 'docs'));
    assert.ok(existsSync(docs));
    assert.equal(rolesDir(p.id), join(base, 'docs-test', 'docs', 'roles'));
    assert.ok(existsSync(rolesDir(p.id)));
  } finally {
    deleteProject(p.id);
    rmSync(base, { recursive: true, force: true });
    if (prev === undefined) delete process.env.BRIDGE_PROJECTS_BASE;
    else process.env.BRIDGE_PROJECTS_BASE = prev;
  }
});

test('createProject seeds PRD.md and charters into <repo>/docs', async () => {
  const base = mkdtempSync(join(tmpdir(), 'bridge-ws-'));
  const prev = process.env.BRIDGE_PROJECTS_BASE;
  process.env.BRIDGE_PROJECTS_BASE = base;
  const p = await createProject({ name: 'Repo Docs', goal: 'build it', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    const repo = join(base, 'repo-docs');
    assert.ok(existsSync(join(repo, 'docs', 'PRD.md')));
    assert.ok(!existsSync(join(repo, 'docs', 'project.md')), 'no legacy project.md');
    assert.match(readFileSync(join(repo, 'docs', 'PRD.md'), 'utf8'), /# Repo Docs — PRD/);
    const roles = join(repo, 'docs', 'roles');
    assert.ok(existsSync(roles));
    assert.ok(readdirSync(roles).filter(f => f.endsWith('.md')).length >= 1);
  } finally {
    deleteProject(p.id);
    rmSync(base, { recursive: true, force: true });
    if (prev === undefined) delete process.env.BRIDGE_PROJECTS_BASE;
    else process.env.BRIDGE_PROJECTS_BASE = prev;
  }
});

test('notes write/read under <repo>/docs and listNotes excludes project.md', async () => {
  const base = mkdtempSync(join(tmpdir(), 'bridge-ws-'));
  const prev = process.env.BRIDGE_PROJECTS_BASE;
  process.env.BRIDGE_PROJECTS_BASE = base;
  const { writeNote, listNotes, readNote } = await import('./backends/notes.js');
  const p = await createProject({ name: 'Notes Repo', goal: 'g', roleIds: ['pm'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n\nbody\n');
    assert.ok(existsSync(join(base, 'notes-repo', 'docs', 'PRD.md')), 'note written into repo/docs');
    assert.equal(readNote(p.id, 'PRD'), '# PRD\n\nbody\n');
    const ids = listNotes(p.id).map(n => n.id);
    assert.ok(ids.includes('PRD'), 'listNotes sees PRD');
    assert.ok(!ids.includes('project'), 'listNotes excludes project.md');
  } finally {
    deleteProject(p.id);
    rmSync(base, { recursive: true, force: true });
    if (prev === undefined) delete process.env.BRIDGE_PROJECTS_BASE;
    else process.env.BRIDGE_PROJECTS_BASE = prev;
  }
});

test('clearContext wipes an agent scratchpad (used on create/delete to stop id reuse inheriting chats)', async () => {
  const { appendTurn, getContext, clearContext } = await import('./scratchpad.js');
  const id = '__test-clear__agent-xyz';
  try {
    appendTurn(id, 'assistant', 'stale kickoff plan');
    assert.equal(getContext(id).messages.length, 1);
    clearContext(id);
    assert.equal(getContext(id).messages.length, 0);   // fresh — no inherited turns
  } finally {
    clearContext(id);   // cleanup (getContext above re-creates an empty record)
  }
});
