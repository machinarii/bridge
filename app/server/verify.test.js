// app/server/verify.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyScript, systemPackages, provisionScript } from './verify.js';
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

test('systemPackages / provisionScript: Prisma stacks get OpenSSL, plain stacks none', () => {
  // Prisma in deps OR devDeps → openssl; matched by substring so @prisma/client counts.
  assert.deepEqual(systemPackages({ dependencies: { '@prisma/client': '^5' }, devDependencies: { prisma: '^5' } }), ['openssl']);
  assert.deepEqual(systemPackages({ dependencies: { express: '^4' } }), []);
  assert.deepEqual(systemPackages({}), []);
  // provisionScript composes an apt install only when packages are needed.
  assert.match(provisionScript({ dependencies: { prisma: '^5' } }), /apt-get install -y openssl/);
  assert.equal(provisionScript({ dependencies: { express: '^4' } }), '');
});

// A package.json with arbitrary fields (deps), not just scripts.
async function withFullPkg(pkg) {
  const p = await createProject({ name: 'VerifyDep ' + Math.floor(Date.now() % 1e6), goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  writeFileSync(pathResolve(ensureRepoPath(p.id), 'package.json'), JSON.stringify(pkg), 'utf8');
  return p;
}

test('verifyProject provisions system packages before install for a Prisma stack', async () => {
  const p = await withFullPkg({ dependencies: { prisma: '^5' }, scripts: { test: 'x' } });
  try {
    let seenScript = '';
    const r = await verifyProject(p.id, { runner: async (_repo, { script }) => { seenScript = script; return { exitCode: 0, output: '@@STEP provision\n@@STEP install\n@@STEP test\nok' }; } });
    assert.equal(r.ok, true);
    assert.match(seenScript, /apt-get install -y openssl.*@@STEP install/s);   // provision precedes install
  } finally { deleteProject(p.id); }
});

test('verifyProject runs no provision step for a plain stack', async () => {
  const p = await withFullPkg({ dependencies: { express: '^4' }, scripts: { test: 'x' } });
  try {
    let seenScript = '';
    await verifyProject(p.id, { runner: async (_repo, { script }) => { seenScript = script; return { exitCode: 0, output: 'ok' }; } });
    assert.doesNotMatch(seenScript, /apt-get/);
    assert.match(seenScript, /@@STEP install/);
  } finally { deleteProject(p.id); }
});
