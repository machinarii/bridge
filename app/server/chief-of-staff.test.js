import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-cos-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-cos-proj-'));
const { createProject, deleteProject, getProject } = await import('./projects.js');
const { createTask, updateTask } = await import('./tasks.js');
const cos = await import('./chief-of-staff.js');

const HOUR = 60 * 60_000;
const tick = () => new Promise(r => setTimeout(r, 5));

// Distinct names per test: the project id derives from the name, so reusing one
// would hand a fresh project the previous test's tasks.
async function board(name) {
  const p = await createProject({ name, goal: 'ship it', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  return { p, designer: getProject(p.id).agents.find(a => a.role === 'designer') };
}

const blockedTask = (p, agent, description) => {
  const t = createTask({ projectId: p.id, agentId: agent.id, description });
  updateTask(t.id, { status: 'blocked_on_user' });
  return t;
};

test('the snapshot buckets tasks and only counts finished work since the last brief', async () => {
  const { p, designer } = await board('CoS Buckets');
  try {
    blockedTask(p, designer, 'what budget?');
    const stale = createTask({ projectId: p.id, agentId: designer.id, description: 'draft flows' });
    updateTask(stale.id, { status: 'in_progress' });
    const old = createTask({ projectId: p.id, agentId: designer.id, description: 'old news' });
    updateTask(old.id, { status: 'done' });

    await tick();
    const cutoff = Date.now();      // stands in for "when the last brief ran"
    await tick();

    const fresh = createTask({ projectId: p.id, agentId: designer.id, description: 'new deliverable' });
    updateTask(fresh.id, { status: 'done' });

    // Look at the board from two hours out, so the in_progress task reads as stalled.
    const snap = cos.boardSnapshot({ now: Date.now() + 2 * HOUR, since: cutoff });
    const proj = snap.projects.find(x => x.id === p.id);
    assert.deepEqual(proj.needsYou.map(t => t.description), ['what budget?']);
    assert.deepEqual(proj.stalled.map(t => t.description), ['draft flows'], 'in_progress for 2h is stalled');
    assert.deepEqual(proj.finished.map(t => t.description), ['new deliverable'], 'pre-cutoff work is not re-reported');
    assert.equal(proj.needsYou[0].role, 'Designer', 'entries carry the agent name + role label');
    assert.equal(snap.totals.needsYou, 1);
    assert.ok(cos.isNotable(snap));
    assert.match(cos.headline(snap), /1 needs you/);
  } finally { deleteProject(p.id); }
});

test('a quiet board writes no brief and makes no model call', async () => {
  const { p } = await board('CoS Quiet');
  try {
    let called = false;
    const callText = async () => { called = true; return 'should never happen'; };
    assert.equal(cos.isNotable(cos.boardSnapshot({ now: Date.now() })), false);
    assert.equal(await cos.runChiefOfStaff({ apiKey: 'k', callText }), null);
    assert.equal(called, false, 'a quiet board costs nothing');
  } finally { deleteProject(p.id); }
});

test('a notable board writes a brief artifact that latestBrief reads back', async () => {
  const { p, designer } = await board('CoS Brief');
  try {
    blockedTask(p, designer, 'dark or light?');
    let prompt = null;
    const callText = async (args) => { prompt = args.prompt; return '## Needs you\n- CoS Brief: pick a theme\n\n**Next:** answer it.'; };
    const out = await cos.runChiefOfStaff({ apiKey: 'k', callText });

    assert.ok(out, 'brief produced');
    assert.match(out.body, /pick a theme/);
    assert.match(out.headline, /1 needs you/);
    assert.match(prompt, /dark or light\?/, 'the blocked question reaches the prompt');
    assert.match(prompt, /Chief of Staff/);
    const latest = cos.latestBrief();
    assert.equal(latest.id, out.id);
    assert.match(latest.body, /pick a theme/);
  } finally { deleteProject(p.id); }
});

test('an empty model reply writes no artifact', async () => {
  const { p, designer } = await board('CoS Empty');
  try {
    blockedTask(p, designer, 'q');
    const before = cos.latestBrief()?.id || null;
    assert.equal(await cos.runChiefOfStaff({ apiKey: 'k', callText: async () => '  ' }), null);
    assert.equal(cos.latestBrief()?.id || null, before);
  } finally { deleteProject(p.id); }
});

test('without an API key the loop is a no-op', async () => {
  const { p, designer } = await board('CoS NoKey');
  try {
    blockedTask(p, designer, 'q');
    assert.equal(await cos.runChiefOfStaff({ apiKey: '' }), null);
  } finally { deleteProject(p.id); }
});
