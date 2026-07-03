import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));

const { createProject, deleteProject, setKickoff, getKickoff } = await import('./projects.js');
const { createTask, updateTask, listTasks } = await import('./tasks.js');
const { recoverOnBoot } = await import('./recovery.js');

test('recoverOnBoot requeues an orphaned in_progress task with attempts left', async () => {
  const p = await createProject({ name: 'Rec Requeue', goal: 'g', roleIds: ['pm', 'designer'], topology: null });
  try {
    const designer = p.agents.find(a => a.role === 'designer');
    const t = createTask({ projectId: p.id, agentId: designer.id, description: 'orphaned work' });
    updateTask(t.id, { status: 'in_progress', attempts: 1 });   // died mid-turn
    const drained = [];
    const r = recoverOnBoot({ drainFn: (pid) => { drained.push(pid); return Promise.resolve(); }, notify: () => {} });
    assert.equal(r.requeued, 1);
    assert.equal(listTasks(p.id)[0].status, 'queued');
    assert.ok(drained.includes(p.id), 'project with recovered work is re-drained');
  } finally { deleteProject(p.id); }
});

test('recoverOnBoot fails an orphaned task that already used its attempts', async () => {
  const p = await createProject({ name: 'Rec Fail', goal: 'g', roleIds: ['pm', 'designer'], topology: null });
  try {
    const designer = p.agents.find(a => a.role === 'designer');
    const t = createTask({ projectId: p.id, agentId: designer.id, description: 'doomed work' });
    updateTask(t.id, { status: 'in_progress', attempts: 2 });
    const r = recoverOnBoot({ drainFn: () => Promise.resolve(), notify: () => {} });
    assert.equal(r.failed, 1);
    const task = listTasks(p.id)[0];
    assert.equal(task.status, 'failed');
    assert.match(task.output, /restart/i);
  } finally { deleteProject(p.id); }
});

test('recoverOnBoot resumes a kickoff that died while running', async () => {
  const p = await createProject({ name: 'Rec Kickoff', goal: 'g', roleIds: ['pm'], topology: null });
  try {
    setKickoff(p.id, { status: 'running', startedAt: Date.now() - 1000 });
    const resumed = [];
    const r = recoverOnBoot({
      drainFn: () => Promise.resolve(),
      executeKickoffFn: (pid) => { resumed.push(pid); return Promise.resolve({ ran: true }); },
      notify: () => {},
    });
    assert.equal(r.kickoffsResumed, 1);
    assert.deepEqual(resumed, [p.id]);
    assert.notEqual(getKickoff(p.id).status, 'running', 'stuck running status cleared before re-run');
  } finally { deleteProject(p.id); }
});

test('recoverOnBoot restarts a kickoff that died while drafting the plan', async () => {
  const p = await createProject({ name: 'Rec Draft', goal: 'g', roleIds: ['pm'], topology: null });
  try {
    setKickoff(p.id, { status: 'drafting' });
    const started = [];
    const r = recoverOnBoot({
      drainFn: () => Promise.resolve(),
      startKickoffFn: (pid) => { started.push(pid); return Promise.resolve(); },
      notify: () => {},
    });
    assert.equal(r.kickoffsResumed, 1);
    assert.deepEqual(started, [p.id]);
  } finally { deleteProject(p.id); }
});

test('recoverOnBoot leaves user-waiting states alone', async () => {
  const p = await createProject({ name: 'Rec Waiting', goal: 'g', roleIds: ['pm'], topology: null });
  try {
    setKickoff(p.id, { status: 'asking', questions: [{ q: 'x', options: ['a', 'b'] }], qIdx: 0 });
    const r = recoverOnBoot({ drainFn: () => Promise.resolve(), notify: () => {} });
    assert.equal(r.kickoffsResumed, 0);
    assert.equal(getKickoff(p.id).status, 'asking');
  } finally { deleteProject(p.id); }
});
