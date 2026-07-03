import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createProject, deleteProject, getProject } = await import('./projects.js');
const { enqueueTask, drain } = await import('./executor.js');
const { listTasks } = await import('./tasks.js');
const { getContext } = await import('./scratchpad.js');
const { listNotes, readNote } = await import('./backends/notes.js');

const deliverableSpec = (body) => ({ intent: 'answer', template: 'reader', title: 'Done', body });

test('a deliverable reply marks the task done and reports to the PM', async () => {
  const p = await createProject({ name: 'Exec Done', goal: 'g', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    const designer = getProject(p.id).agents.find(a => a.role === 'designer');
    const calls = [];
    const interpret = async (args) => { calls.push(args); return deliverableSpec('# Design principles\nKeep it simple.'); };
    enqueueTask({ projectId: p.id, agentId: designer.id, description: 'write design principles' }, { interpret });
    await drain(p.id, { interpret });
    const [t] = listTasks(p.id);
    assert.equal(t.status, 'done');
    assert.match(t.output, /Design principles/);
    // the agent turn ran with a PM→agent handoff
    assert.equal(calls.length, 1);
    assert.equal(calls[0].agentId, designer.id);
    assert.equal(calls[0].text, 'write design principles');
    assert.ok(calls[0].handoff, 'task runs as a handoff turn');
    // the PM got a foreign-author summary bubble
    const lead = getProject(p.id).leadAgentId;
    const last = getContext(lead).messages.at(-1);
    assert.equal(last.author?.id, designer.id);
    assert.match(last.content, /write design principles/);
    // the deliverable landed as a project doc
    assert.ok(readNote(p.id, 'deliverables/deliverables-designer'), 'deliverable doc written to deliverables/');
  } finally { deleteProject(p.id); }
});

const { tasksForAgent } = await import('./tasks.js');

const questionSpec = (body, choices) => ({ intent: 'answer', template: 'reader', title: 'Q', body, choices });

test('a question the PM can answer resumes the agent without the user', async () => {
  const p = await createProject({ name: 'Exec PM Answer', goal: 'g', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    const designer = getProject(p.id).agents.find(a => a.role === 'designer');
    const seen = [];
    const interpret = async ({ text }) => {
      seen.push(text);
      if (seen.length === 1) return questionSpec('Dark or light theme?', ['Dark', 'Light']);
      return { intent: 'answer', template: 'reader', title: 'Done', body: 'Dark theme it is.' };
    };
    const callText = async () => 'Dark';   // the PM answers decisively
    enqueueTask({ projectId: p.id, agentId: designer.id, description: 'pick a theme' }, { interpret, callText, apiKey: 'k' });
    await drain(p.id, { interpret, callText, apiKey: 'k' });
    const [t] = listTasks(p.id);
    assert.equal(t.status, 'done');
    assert.deepEqual(seen, ['pick a theme', 'Dark'], 'PM answer became the agent\'s next turn');
  } finally { deleteProject(p.id); }
});

test('a question the PM cannot answer blocks on the user', async () => {
  const p = await createProject({ name: 'Exec Blocked', goal: 'g', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    const designer = getProject(p.id).agents.find(a => a.role === 'designer');
    const interpret = async () => questionSpec('What is your budget?', ['$10', '$100']);
    const callText = async () => 'ASK USER';
    enqueueTask({ projectId: p.id, agentId: designer.id, description: 'estimate cost' }, { interpret, callText, apiKey: 'k' });
    await drain(p.id, { interpret, callText, apiKey: 'k' });
    assert.equal(listTasks(p.id)[0].status, 'blocked_on_user');
    assert.equal(tasksForAgent(designer.id, 'blocked_on_user').length, 1);
  } finally { deleteProject(p.id); }
});

test('without an API key a question blocks immediately (no PM call)', async () => {
  const p = await createProject({ name: 'Exec NoKey', goal: 'g', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    const designer = getProject(p.id).agents.find(a => a.role === 'designer');
    const interpret = async () => questionSpec('Q?', ['A', 'B']);
    let pmCalled = false;
    const callText = async () => { pmCalled = true; return 'A'; };
    enqueueTask({ projectId: p.id, agentId: designer.id, description: 'task' }, { interpret, callText, apiKey: '' });
    await drain(p.id, { interpret, callText, apiKey: '' });
    assert.equal(listTasks(p.id)[0].status, 'blocked_on_user');
    assert.equal(pmCalled, false);
  } finally { deleteProject(p.id); }
});

test('a delegate reply enqueues a task for the teammate and both complete', async () => {
  const p = await createProject({ name: 'Exec Delegate', goal: 'g', roleIds: ['pm', 'designer', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    const designer = getProject(p.id).agents.find(a => a.role === 'designer');
    const swe = getProject(p.id).agents.find(a => a.role === 'sw_engineer');
    const interpret = async ({ agentId }) => {
      if (agentId === designer.id) {
        return { intent: 'delegate', to_role: 'sw_engineer', task: 'implement the landing page', body: 'engineering work' };
      }
      return { intent: 'answer', template: 'reader', title: 'Done', body: 'Landing page implemented.' };
    };
    enqueueTask({ projectId: p.id, agentId: designer.id, description: 'build the landing page' }, { interpret });
    await drain(p.id, { interpret });
    const tasks = listTasks(p.id);
    assert.equal(tasks.length, 2, 'delegation created a second task');
    assert.ok(tasks.every(t => t.status === 'done'));
    const child = tasks.find(t => t.agentId === swe.id);
    assert.equal(child.description, 'implement the landing page');
    assert.equal(child.from.agentId, designer.id);
  } finally { deleteProject(p.id); }
});

test('a delegate to a role not on the team auto-adds the agent', async () => {
  const p = await createProject({ name: 'Exec AutoAdd', goal: 'g', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    const designer = getProject(p.id).agents.find(a => a.role === 'designer');
    const interpret = async ({ agentId }) =>
      agentId === designer.id
        ? { intent: 'delegate', to_role: 'sw_engineer', task: 'wire it up', body: '' }
        : { intent: 'answer', template: 'reader', title: 'Done', body: 'Wired.' };
    enqueueTask({ projectId: p.id, agentId: designer.id, description: 'ship it' }, { interpret });
    await drain(p.id, { interpret });
    const swe = getProject(p.id).agents.find(a => a.role === 'sw_engineer');
    assert.ok(swe, 'sw_engineer auto-added');
    assert.ok(listTasks(p.id).every(t => t.status === 'done'));
  } finally { deleteProject(p.id); }
});

test('a thrown turn retries once, then succeeds', async () => {
  const p = await createProject({ name: 'Exec Retry', goal: 'g', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    const designer = getProject(p.id).agents.find(a => a.role === 'designer');
    let calls = 0;
    const interpret = async () => {
      if (++calls === 1) throw new Error('OpenRouter 502');
      return { intent: 'answer', template: 'reader', title: 'Done', body: 'ok' };
    };
    enqueueTask({ projectId: p.id, agentId: designer.id, description: 'flaky task' }, { interpret });
    await drain(p.id, { interpret });
    const [t] = listTasks(p.id);
    assert.equal(t.status, 'done');
    assert.equal(t.attempts, 2);
  } finally { deleteProject(p.id); }
});

test('a turn that keeps throwing fails after MAX_ATTEMPTS', async () => {
  const p = await createProject({ name: 'Exec Fail', goal: 'g', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    const designer = getProject(p.id).agents.find(a => a.role === 'designer');
    const interpret = async () => { throw new Error('OpenRouter 500'); };
    enqueueTask({ projectId: p.id, agentId: designer.id, description: 'doomed task' }, { interpret });
    await drain(p.id, { interpret });
    const [t] = listTasks(p.id);
    assert.equal(t.status, 'failed');
    assert.equal(t.attempts, 2);
    assert.match(t.output, /500/);
  } finally { deleteProject(p.id); }
});

test('a blocked task auto-resumes on best judgment after the fallback window', async () => {
  const p = await createProject({ name: 'Exec Fallback', goal: 'g', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    const designer = getProject(p.id).agents.find(a => a.role === 'designer');
    const interpret = async ({ text }) =>
      /best judgment/.test(text)
        ? { intent: 'answer', template: 'reader', title: 'Done', body: 'Went with dark theme.' }
        : questionSpec('Dark or light?', ['Dark', 'Light']);
    const callText = async () => 'ASK USER';   // the PM can't answer either
    const opts = { interpret, callText, apiKey: 'k', blockTimeoutMs: 20 };
    enqueueTask({ projectId: p.id, agentId: designer.id, description: 'pick theme' }, opts);
    await drain(p.id, opts);
    assert.equal(listTasks(p.id)[0].status, 'blocked_on_user', 'blocks first — the user gets a window to reply');
    const deadline = Date.now() + 2000;
    while (listTasks(p.id)[0].status !== 'done' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
    }
    const [t] = listTasks(p.id);
    assert.equal(t.status, 'done', 'fallback resumed and completed the task');
    assert.match(t.output, /dark theme/i);
  } finally { deleteProject(p.id); }
});

test('a hung turn times out and fails instead of freezing the queue', async () => {
  const p = await createProject({ name: 'Exec Hang', goal: 'g', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    const designer = getProject(p.id).agents.find(a => a.role === 'designer');
    const interpret = () => new Promise(() => {});   // never resolves — a stalled connection
    enqueueTask({ projectId: p.id, agentId: designer.id, description: 'hung task' }, { interpret, turnTimeoutMs: 25 });
    await drain(p.id, { interpret, turnTimeoutMs: 25 });
    const [t] = listTasks(p.id);
    assert.equal(t.status, 'failed');
    assert.match(t.output, /timed out/);
  } finally { deleteProject(p.id); }
});

test('a slow task does not block a sibling task from completing (no head-of-line blocking)', async () => {
  const p = await createProject({ name: 'Exec Pool', goal: 'g', roleIds: ['pm', 'designer', 'sw_engineer', 'qa'], topology: 'hub-and-spoke' });
  try {
    const agents = getProject(p.id).agents.filter(a => a.role !== 'pm');
    const [slow, fastA, fastB] = agents;
    let fastDoneWhileSlowRunning = false;
    let slowRunning = false;
    const interpret = async ({ agentId }) => {
      if (agentId === slow.id) {
        slowRunning = true;
        await new Promise(r => setTimeout(r, 120));
        slowRunning = false;
        return deliverableSpec('slow done');
      }
      await new Promise(r => setTimeout(r, 10));
      if (slowRunning) fastDoneWhileSlowRunning = true;
      return deliverableSpec('fast done');
    };
    // With MAX_ACTIVE=3 all three start together; the old batch model would be
    // fine here, but with maxActive=2 the old code waited for the WHOLE batch
    // (slow + fastA) before starting fastB. The pool starts fastB as soon as
    // fastA's worker frees up, while slow is still running.
    for (const a of [slow, fastA, fastB]) {
      enqueueTask({ projectId: p.id, agentId: a.id, description: `task ${a.role}` }, { interpret, maxActive: 2 });
    }
    await drain(p.id, { interpret, maxActive: 2 });
    assert.ok(listTasks(p.id).every(t => t.status === 'done'));
    assert.ok(fastDoneWhileSlowRunning, 'a later task ran to completion while the slow one was still in flight');
  } finally { deleteProject(p.id); }
});

const { statusSnapshot } = await import('./events.js');

test('agent stays non-idle through the settle phase (no status gap for the PM answer)', async () => {
  const p = await createProject({ name: 'Exec NoGap', goal: 'g', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    const designer = getProject(p.id).agents.find(a => a.role === 'designer');
    let verbDuringPmCall = null;
    let first = true;
    const interpret = async () => {
      if (first) { first = false; return questionSpec('Theme?', ['Dark', 'Light']); }
      return { intent: 'answer', template: 'reader', title: 'Done', body: 'ok' };
    };
    const callText = async () => {
      verbDuringPmCall = statusSnapshot(p.id)[designer.id] || 'idle';
      return 'Dark';
    };
    enqueueTask({ projectId: p.id, agentId: designer.id, description: 'pick theme' }, { interpret, callText, apiKey: 'k' });
    await drain(p.id, { interpret, callText, apiKey: 'k' });
    assert.notEqual(verbDuringPmCall, 'idle', 'agent reads as working while the PM answers');
    assert.equal(statusSnapshot(p.id)[designer.id], undefined, 'idle again once the task settles');
  } finally { deleteProject(p.id); }
});
