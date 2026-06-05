// app/server/verify.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyScript } from './verify.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createProject, deleteProject, ensureRepoPath } = await import('./projects.js');
const { verifyProject } = await import('./verify.js');

test('verifyScript includes only the steps the project defines, with markers', () => {
  const s = verifyScript({ build: 'tsc', test: 'node --test' });
  assert.match(s, /@@STEP install.*npm install/s);
  assert.match(s, /@@STEP build.*npm run build/s);
  assert.match(s, /@@STEP test.*npm test/s);
  // no build script → no build step
  const s2 = verifyScript({ test: 'x' });
  assert.doesNotMatch(s2, /@@STEP build/);
  assert.match(s2, /@@STEP test/);
  // always installs
  assert.match(verifyScript({}), /@@STEP install/);
});

async function withPkg(scripts) {
  const p = await createProject({ name: 'Verify ' + Math.floor(Date.now() % 1e6), goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  writeFileSync(pathResolve(ensureRepoPath(p.id), 'package.json'), JSON.stringify({ scripts }), 'utf8');
  return p;
}

test('verifyProject returns ok when the container exits 0', async () => {
  const p = await withPkg({ test: 'x' });
  try {
    const r = await verifyProject(p.id, { runner: async () => ({ exitCode: 0, output: '@@STEP install\n@@STEP test\nok', timedOut: false, daemonDown: false }) });
    assert.equal(r.ok, true);
  } finally { deleteProject(p.id); }
});

test('verifyProject identifies the failing step from the last marker', async () => {
  const p = await withPkg({ build: 'tsc', test: 'x' });
  try {
    const r = await verifyProject(p.id, { runner: async () => ({ exitCode: 1, output: '@@STEP install\nok\n@@STEP build\nTS error: boom', timedOut: false, daemonDown: false }) });
    assert.equal(r.ok, false);
    assert.equal(r.step, 'build');
    assert.match(r.output, /TS error/);
  } finally { deleteProject(p.id); }
});

test('verifyProject reports a stopped daemon and a missing package.json', async () => {
  const p1 = await withPkg({ test: 'x' });
  try {
    const r = await verifyProject(p1.id, { runner: async () => ({ exitCode: 1, output: 'Cannot connect to the Docker daemon', timedOut: false, daemonDown: true }) });
    assert.equal(r.daemonDown, true);
  } finally { deleteProject(p1.id); }
  const p2 = await createProject({ name: 'No Pkg', goal: 'g', roleIds: ['pm'], topology: 'hub-and-spoke' });
  try {
    const r = await verifyProject(p2.id, { runner: async () => ({ exitCode: 0, output: '' }) });
    assert.equal(r.ok, false);
    assert.equal(r.step, 'setup');
  } finally { deleteProject(p2.id); }
});
