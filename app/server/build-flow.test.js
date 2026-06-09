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

test('build_pending + a natural "Yes" scaffolds (not just the exact "Build it")', async () => {
  const p = await createProject({ name: 'Build Yes', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n');
    await generateBuildPlan(p.id, { callText: async () => JSON.stringify({ stack: 'node', summary: 's', files: [{ path: 'src/index.js', purpose: 'entry' }] }) });
    setKickoff(p.id, { status: 'build_pending' });
    const r = await handleLeadMessageDuringKickoff(p.id, 'Yes.', { callText: async () => 'console.log(1)\n' });
    assert.equal(r.intent, 'scaffolded', '"Yes." triggers the real scaffold');
    assert.ok(existsSync(resolve(getProject(p.id).build.repoPath, 'src/index.js')), 'file scaffolded');
    // The scaffold-done spec carries the run choices ("Want me to: Run it / Not now").
    const spec = JSON.parse(r.spec);
    assert.deepEqual(spec.choices, ['Run it', 'Not now']);
  } finally { deleteProject(p.id); }
});

test('build_pending + "no" does not scaffold (negation guard)', async () => {
  const p = await createProject({ name: 'Build No', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n');
    await generateBuildPlan(p.id, { callText: async () => JSON.stringify({ stack: 'node', summary: 's', files: [{ path: 'b.js', purpose: 'x' }] }) });
    setKickoff(p.id, { status: 'build_pending' });
    const r = await handleLeadMessageDuringKickoff(p.id, 'no, hold on', { callText: async () => 'x' });
    assert.equal(r.intent, 'build_hold');
    assert.ok(!existsSync(resolve(getProject(p.id).build.repoPath, 'b.js')), 'nothing scaffolded');
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

import { getContext } from './scratchpad.js';
import { startTeamReview } from './team-review.js';

test('team round completion hands the build off to the software engineer', async () => {
  const p = await createProject({ name: 'Round Handoff', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n');
    const swe = getProject(p.id).agents.find(a => a.role === 'sw_engineer');
    startTeamReview(p.id);
    setKickoff(p.id, { status: 'team_review' });
    // callText returns a build plan; as a "question" it has no `question` field,
    // so the specialist is skipped → round ends → build plan → handoff.
    const planJson = async () => JSON.stringify({ stack: 'node', summary: 's', files: [{ path: 'a.js', purpose: 'x' }] });
    const r = await handleLeadMessageDuringKickoff(p.id, 'my input', { callText: planJson });
    assert.equal(r.intent, 'build_handoff');
    assert.equal(getProject(p.id).kickoff.status, 'build_pending');
    assert.equal(getProject(p.id).kickoff.buildAgentId, swe.id);
    assert.ok(getContext(swe.id).messages.some(m => /Build plan/.test(m.content)), 'build plan in engineer chat');
    assert.ok(getContext(getProject(p.id).leadAgentId).messages.some(m => /handed this off/.test(m.content)), 'PM handoff in lead chat');
  } finally { deleteProject(p.id); }
});

test('build handoff: scaffold runs in the engineer chat, lead chat stays clean', async () => {
  const p = await createProject({ name: 'Handoff Build', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n');
    const swe = getProject(p.id).agents.find(a => a.role === 'sw_engineer');
    await generateBuildPlan(p.id, { callText: async () => JSON.stringify({ stack: 'node', summary: 's', files: [{ path: 'src/index.js', purpose: 'entry' }] }) });
    setKickoff(p.id, { status: 'build_pending', buildAgentId: swe.id });
    const r = await handleLeadMessageDuringKickoff(p.id, 'Build it', { agentId: swe.id, callText: async () => 'console.log(1)\n' });
    assert.equal(r.intent, 'scaffolded');
    assert.equal(getProject(p.id).kickoff.status, 'run_pending');
    assert.ok(getContext(swe.id).messages.some(m => /Scaffolded/.test(m.content)), 'scaffold result in engineer chat');
    assert.ok(!getContext(getProject(p.id).leadAgentId).messages.some(m => /Scaffolded/.test(m.content)), 'lead chat clean of scaffold');
  } finally { deleteProject(p.id); }
});

test('build phase ignores messages from a non-owner (the PM)', async () => {
  const p = await createProject({ name: 'Owner Gate', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n');
    const swe = getProject(p.id).agents.find(a => a.role === 'sw_engineer');
    await generateBuildPlan(p.id, { callText: async () => JSON.stringify({ stack: 'node', summary: 's', files: [{ path: 'a.js', purpose: 'x' }] }) });
    setKickoff(p.id, { status: 'build_pending', buildAgentId: swe.id });
    const r = await handleLeadMessageDuringKickoff(p.id, 'Build it', { agentId: getProject(p.id).leadAgentId, callText: async () => 'x' });
    assert.equal(r.handled, false);
    assert.equal(getProject(p.id).kickoff.status, 'build_pending');
  } finally { deleteProject(p.id); }
});
