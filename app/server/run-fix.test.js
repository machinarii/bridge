// app/server/run-fix.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createProject, deleteProject, ensureRepoPath } = await import('./projects.js');
const { listSourceFiles, proposeFixes } = await import('./run-fix.js');

test('listSourceFiles returns repo files but skips node_modules/.git', async () => {
  const p = await createProject({ name: 'Src List', goal: 'g', roleIds: ['pm'], topology: 'hub-and-spoke' });
  try {
    const repo = ensureRepoPath(p.id);
    writeFileSync(resolve(repo, 'index.js'), 'console.log(1)\n');
    mkdirSync(resolve(repo, 'node_modules', 'x'), { recursive: true });
    writeFileSync(resolve(repo, 'node_modules', 'x', 'junk.js'), 'junk\n');
    const files = listSourceFiles(repo);
    assert.ok(files.some(f => f.path === 'index.js'));
    assert.ok(!files.some(f => f.path.includes('node_modules')));
  } finally { deleteProject(p.id); }
});

test('proposeFixes parses the model\'s {files:[…]} edits', async () => {
  const p = await createProject({ name: 'Fix Parse', goal: 'g', roleIds: ['pm'], topology: 'hub-and-spoke' });
  try {
    const callText = async () => '```json\n' + JSON.stringify({ files: [{ path: 'a.js', contents: 'fixed\n' }] }) + '\n```';
    const edits = await proposeFixes(p.id, { step: 'test', output: 'boom' }, callText);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].path, 'a.js');
    assert.equal(edits[0].contents, 'fixed\n');
    // garbage → no edits
    assert.deepEqual(await proposeFixes(p.id, { step: 'test', output: 'x' }, async () => 'not json'), []);
  } finally { deleteProject(p.id); }
});

import { runAndFix } from './run-fix.js';

async function withPkg(name) {
  const p = await createProject({ name, goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  writeFileSync(resolve(ensureRepoPath(p.id), 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8');
  return p;
}

test('runAndFix: green on the first run needs no fixes', async () => {
  const p = await withPkg('Green');
  try {
    const r = await runAndFix(p.id, { callText: async () => '{}', runner: async () => ({ exitCode: 0, output: 'ok' }) });
    assert.equal(r.ok, true);
    assert.equal(r.rounds, 0);
  } finally { deleteProject(p.id); }
});

test('runAndFix: fails once, model fixes it, passes', async () => {
  const p = await withPkg('FixOnce');
  try {
    let n = 0;
    const runner = async () => (++n === 1) ? { exitCode: 1, output: '@@STEP test\nfail' } : { exitCode: 0, output: 'ok' };
    const callText = async () => JSON.stringify({ files: [{ path: 'index.js', contents: 'console.log(1)\n' }] });
    const r = await runAndFix(p.id, { callText, runner });
    assert.equal(r.ok, true);
    assert.equal(r.rounds, 1);
  } finally { deleteProject(p.id); }
});

test('runAndFix: gives up after maxRounds and reports the last failure', async () => {
  const p = await withPkg('NeverGreen');
  try {
    const runner = async () => ({ exitCode: 1, output: '@@STEP test\nstill broken' });
    const callText = async () => JSON.stringify({ files: [{ path: 'index.js', contents: 'x\n' }] });
    const r = await runAndFix(p.id, { callText, runner, maxRounds: 2 });
    assert.equal(r.ok, false);
    assert.equal(r.rounds, 2);
    assert.equal(r.lastStep, 'test');
  } finally { deleteProject(p.id); }
});

test('runAndFix: stops immediately on a stopped daemon', async () => {
  const p = await withPkg('NoDaemon');
  try {
    const r = await runAndFix(p.id, { callText: async () => '{}', runner: async () => ({ exitCode: 1, output: 'Cannot connect to the Docker daemon', daemonDown: true }) });
    assert.equal(r.ok, false);
    assert.equal(r.daemonDown, true);
    assert.equal(r.rounds, 0);
  } finally { deleteProject(p.id); }
});
