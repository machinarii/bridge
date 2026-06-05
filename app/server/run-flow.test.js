// app/server/run-flow.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createProject, getProject, deleteProject, setKickoff, ensureRepoPath } = await import('./projects.js');
const { handleLeadMessageDuringKickoff } = await import('./kickoff.js');

async function runReady(name) {
  const p = await createProject({ name, goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  writeFileSync(resolve(ensureRepoPath(p.id), 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8');
  setKickoff(p.id, { status: 'run_pending' });
  return p;
}

test('run_pending + "Run it" runs the loop green → verified', async () => {
  const p = await runReady('Run Green');
  try {
    const r = await handleLeadMessageDuringKickoff(p.id, 'Run it', { runner: async () => ({ exitCode: 0, output: 'ok' }), callText: async () => '{}' });
    assert.equal(r.intent, 'verified');
    assert.equal(getProject(p.id).kickoff.status, 'verified');
  } finally { deleteProject(p.id); }
});

test('run_pending + "Run it" that stays broken → reports failure, status built', async () => {
  const p = await runReady('Run Broken');
  try {
    const r = await handleLeadMessageDuringKickoff(p.id, 'Run it', { runner: async () => ({ exitCode: 1, output: '@@STEP test\nboom' }), callText: async () => JSON.stringify({ files: [{ path: 'a.js', contents: 'x\n' }] }) });
    assert.equal(r.intent, 'run_failed');
    assert.equal(getProject(p.id).kickoff.status, 'built');
  } finally { deleteProject(p.id); }
});

test('run_pending + "Not now" closes without running', async () => {
  const p = await runReady('Run Skip');
  try {
    const r = await handleLeadMessageDuringKickoff(p.id, 'Not now', { runner: async () => { throw new Error('should not run'); } });
    assert.equal(r.intent, 'run_declined');
    assert.equal(getProject(p.id).kickoff.status, 'done');
  } finally { deleteProject(p.id); }
});

test('run_pending + "Run it" with Docker down → asks to start Docker, stays run_pending', async () => {
  const p = await runReady('Run NoDocker');
  try {
    const r = await handleLeadMessageDuringKickoff(p.id, 'Run it', { runner: async () => ({ exitCode: 1, output: 'Cannot connect to the Docker daemon', daemonDown: true }), callText: async () => '{}' });
    assert.equal(getProject(p.id).kickoff.status, 'run_pending');
    assert.match(JSON.parse(r.spec).body, /Docker/i);
  } finally { deleteProject(p.id); }
});
