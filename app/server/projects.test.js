import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Isolate ALL project state to throwaway temp dirs — tests must NEVER touch the
// real app/state/projects.json or ~/bridge-projects. (A fresh BRIDGE_STATE_DIR
// starts empty, so no deletion of any shared file is needed.)
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const STATE_DIR = process.env.BRIDGE_STATE_DIR;

const { createProject, listProjects, getProject, deleteProject } = await import('./projects.js');
const { charterFileNameFor } = await import('./charters.js');

test('listProjects starts empty', () => {
  assert.deepEqual(listProjects(), []);
});

test('createProject builds a project with auto-named agents', async () => {
  const p = await createProject({ name: 'Test Alpha', goal: 'Ship a test', roleIds: ['pm','sw_engineer','qa'] });
  assert.match(p.id, /^p_/);
  assert.equal(p.name, 'Test Alpha');
  assert.equal(p.goal, 'Ship a test');
  assert.equal(p.agents.length, 3);
  assert.deepEqual(p.agents.map(a => a.role).sort(), ['pm','qa','sw_engineer']);
  // Lead is PM if present
  assert.equal(p.leadAgentId, p.agents.find(a => a.role === 'pm').id);
  // All enabled by default
  assert.ok(p.agents.every(a => a.enabled));
  // Names from each role's pool
  const pm = p.agents.find(a => a.role === 'pm');
  assert.ok(['Cassidy','Marlowe','Quinn','Linden'].includes(pm.name));
});

test('createProject without pm auto-adds PM as lead', async () => {
  const p = await createProject({ name: 'Test Beta', goal: 'No leads picked', roleIds: ['sw_engineer','qa'] });
  assert.equal(p.agents.length, 3, 'PM auto-added');
  assert.equal(p.agents.find(a => a.id === p.leadAgentId).role, 'pm');
});

test('createProject writes charter markdown for each role', async () => {
  const base = mkdtempSync(join(tmpdir(), 'bridge-ws-'));
  const prev = process.env.BRIDGE_PROJECTS_BASE;
  process.env.BRIDGE_PROJECTS_BASE = base;
  const p = await createProject({ name: 'Test Charters', goal: 'verify charter pipeline', roleIds: ['pm','sw_engineer'] });
  try {
    // Charters now live in <repoPath>/docs/roles/ (moved from STATE_DIR/<id>/roles/)
    for (const a of p.agents) {
      const charterPath = resolve(p.repoPath, 'docs', 'roles', charterFileNameFor(a.role));
      assert.ok(existsSync(charterPath), `charter exists for ${a.role}`);
      const md = readFileSync(charterPath, 'utf8');
      assert.match(md, /## Role/);
      assert.match(md, /## Typical tasks/);
      assert.match(md, /## Areas of expertise/);
    }
  } finally {
    deleteProject(p.id);
    rmSync(base, { recursive: true, force: true });
    if (prev === undefined) delete process.env.BRIDGE_PROJECTS_BASE;
    else process.env.BRIDGE_PROJECTS_BASE = prev;
  }
});

test('slug collision adds _2 suffix', async () => {
  await createProject({ name: 'Test Alpha', goal: 'collision', roleIds: ['pm'] });
  const list = listProjects().filter(p => p.name === 'Test Alpha');
  assert.ok(list.length >= 2);
  assert.ok(list.some(p => p.id.endsWith('_2')));
});

test('getProject returns null for unknown', () => {
  assert.equal(getProject('p_does_not_exist'), null);
});
