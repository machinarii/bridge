import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createProject, getProject, deleteProject, setKickoff } = await import('./projects.js');
const { writeNote } = await import('./backends/notes.js');
const { generateBuildPlan } = await import('./scaffold.js');
const { handleLeadMessageDuringKickoff } = await import('./kickoff.js');

test('build_pending + "Build it" scaffolds, commits, and marks built', async () => {
  const p = await createProject({ name: 'Build Flow', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n');
    await generateBuildPlan(p.id, { callText: async () => JSON.stringify({ stack: 'node', summary: 's', files: [{ path: 'src/index.js', purpose: 'entry' }] }) });
    setKickoff(p.id, { status: 'build_pending' });
    const r = await handleLeadMessageDuringKickoff(p.id, 'Build it', { callText: async () => 'console.log(1)\n' });
    assert.equal(r.intent, 'scaffolded');
    assert.ok(existsSync(resolve(getProject(p.id).build.repoPath, 'src/index.js')), 'file scaffolded');
    assert.equal(getProject(p.id).kickoff.status, 'run_pending');   // was 'built'
  } finally { deleteProject(p.id); }
});

test('build_pending + "Hold off" does not scaffold', async () => {
  const p = await createProject({ name: 'Build Hold', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n');
    await generateBuildPlan(p.id, { callText: async () => JSON.stringify({ stack: 'node', summary: 's', files: [{ path: 'a.js', purpose: 'x' }] }) });
    setKickoff(p.id, { status: 'build_pending' });
    const r = await handleLeadMessageDuringKickoff(p.id, 'Hold off — let me adjust', { callText: async () => 'x' });
    assert.equal(r.intent, 'build_hold');
    assert.ok(!existsSync(resolve(getProject(p.id).build.repoPath, 'a.js')), 'nothing scaffolded');
  } finally { deleteProject(p.id); }
});
