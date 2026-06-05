import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, deleteProject, docsDir, rolesDir } from './projects.js';

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

test('createProject writes project.md and charters into <repo>/docs', async () => {
  const base = mkdtempSync(join(tmpdir(), 'bridge-ws-'));
  const prev = process.env.BRIDGE_PROJECTS_BASE;
  process.env.BRIDGE_PROJECTS_BASE = base;
  const p = await createProject({ name: 'Repo Docs', goal: 'build it', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    const repo = join(base, 'repo-docs');
    assert.ok(existsSync(join(repo, 'docs', 'project.md')));
    assert.match(readFileSync(join(repo, 'docs', 'project.md'), 'utf8'), /# Repo Docs/);
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
