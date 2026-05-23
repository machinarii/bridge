import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, '..', 'state');

// Isolate each run — delete projects.json before importing
rmSync(resolve(STATE_DIR, 'projects.json'), { force: true });
for (const sub of ['p_test_alpha', 'p_test_alpha_2', 'p_test_beta', 'p_test_charters']) {
  rmSync(resolve(STATE_DIR, sub), { recursive: true, force: true });
}

const { createProject, listProjects, getProject } = await import('./projects.js');

test('listProjects starts empty', () => {
  assert.deepEqual(listProjects(), []);
});

test('createProject builds a project with auto-named agents', async () => {
  const p = await createProject({ name: 'Test Alpha', goal: 'Ship a test', roleIds: ['pm','engineer','qa'] });
  assert.match(p.id, /^p_/);
  assert.equal(p.name, 'Test Alpha');
  assert.equal(p.goal, 'Ship a test');
  assert.equal(p.agents.length, 3);
  assert.deepEqual(p.agents.map(a => a.role).sort(), ['engineer','pm','qa']);
  // Lead is PM if present
  assert.equal(p.leadAgentId, p.agents.find(a => a.role === 'pm').id);
  // All enabled by default
  assert.ok(p.agents.every(a => a.enabled));
  // Names from each role's pool
  const pm = p.agents.find(a => a.role === 'pm');
  assert.ok(['Cassidy','Marlowe','Quinn','Linden'].includes(pm.name));
});

test('createProject without pm or tpm auto-adds TPM as lead', async () => {
  const p = await createProject({ name: 'Test Beta', goal: 'No leads picked', roleIds: ['engineer','qa'] });
  assert.equal(p.agents.length, 3, 'TPM auto-added');
  assert.equal(p.agents.find(a => a.id === p.leadAgentId).role, 'tpm');
});

test('createProject writes charter markdown for each role', async () => {
  const p = await createProject({ name: 'Test Charters', goal: 'verify charter pipeline', roleIds: ['pm','engineer'] });
  const projDir = resolve(STATE_DIR, p.id);
  for (const a of p.agents) {
    const charterPath = resolve(projDir, 'roles', `${a.role}.md`);
    assert.ok(existsSync(charterPath), `charter exists for ${a.role}`);
    const md = readFileSync(charterPath, 'utf8');
    assert.match(md, /## Role/);
    assert.match(md, /## Typical tasks/);
    assert.match(md, /## Areas of expertise/);
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
