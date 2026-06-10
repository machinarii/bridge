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
