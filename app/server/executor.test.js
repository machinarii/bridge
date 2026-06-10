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
const { listNotes } = await import('./backends/notes.js');

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
    assert.ok(listNotes(p.id).some(n => /deliverable/i.test(n.id)), 'deliverable doc written');
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
