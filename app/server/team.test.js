import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRoutingOutput, applyCostCap } from './team.js';

test('parseRoutingOutput accepts the JSON shape', () => {
  const r = parseRoutingOutput('{"assignments":[{"agentId":"a1","task":"x"}],"summary_intent":"ok"}');
  assert.equal(r.assignments.length, 1);
  assert.equal(r.summary_intent, 'ok');
});

test('parseRoutingOutput strips code fences', () => {
  const r = parseRoutingOutput('```json\n{"assignments":[],"summary_intent":"none"}\n```');
  assert.deepEqual(r.assignments, []);
});

test('parseRoutingOutput throws on garbage', () => {
  assert.throws(() => parseRoutingOutput('this is not json'));
});

test('applyCostCap drops assignees past cap', () => {
  const xs = [1,2,3,4,5,6,7].map(i => ({ agentId: `a${i}`, task: 't' }));
  const r = applyCostCap(xs, 5);
  assert.equal(r.kept.length, 5);
  assert.equal(r.dropped.length, 2);
});

test('parseRoutingOutput sanitizes sharedFrom (cap count, truncate snippet)', () => {
  const longSnippet = 'x'.repeat(500);
  const raw = JSON.stringify({
    assignments: [{
      agentId: 'a1', task: 't',
      sharedFrom: [
        { fromAgentName: 'Kade', fromRole: 'Engineer', snippet: longSnippet },
        { fromAgentName: 'Iris', fromRole: 'Designer', snippet: 'short' },
        { fromAgentName: 'Tess', fromRole: 'QA',       snippet: 'also short' },
        { fromAgentName: 'Vex',  fromRole: 'Sec',      snippet: 'dropped past cap' },
      ],
    }],
    summary_intent: 'ok',
  });
  const r = parseRoutingOutput(raw);
  assert.equal(r.assignments[0].sharedFrom.length, 3);
  assert.equal(r.assignments[0].sharedFrom[0].snippet.length, 240);
});

test('runTeamVoice synthesizes after the soft deadline and aborts unfinished assignees', async () => {
  process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-team-state-'));
  process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-team-repo-'));
  process.env.OPENROUTER_API_KEY = 'test-key';
  const { createProject, deleteProject, getProject } = await import('./projects.js');
  const { runTeamVoice } = await import('./team.js');
  const originalFetch = globalThis.fetch;
  const p = await createProject({ name: 'Team Deadline', goal: 'g', roleIds: ['pm', 'designer', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    const project = getProject(p.id);
    const designer = project.agents.find(a => a.role === 'designer');
    const swe = project.agents.find(a => a.role === 'sw_engineer');
    const routing = {
      assignments: [
        { agentId: designer.id, task: 'design it' },
        { agentId: swe.id, task: 'build it' },
      ],
      summary_intent: 'team work',
    };
    const summary = {
      intent: 'answer',
      template: 'reader',
      context: 'Team',
      title: 'Partial',
      body: 'Designer replied.',
      actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
    };
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      const content = fetchCalls++ === 0 ? JSON.stringify(routing) : JSON.stringify(summary);
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    };
    let slowAborted = false;
    const interpret = async ({ agentId, signal, mode }) => {
      assert.equal(mode, 'team');
      if (agentId === designer.id) return { intent: 'answer', template: 'reader', body: 'Designer replied.' };
      assert.equal(agentId, swe.id);
      return new Promise(resolve => {
        signal.addEventListener('abort', () => {
          slowAborted = true;
          resolve({ intent: 'answer', template: 'reader', body: 'Too late.' });
        }, { once: true });
      });
    };
    const r = await runTeamVoice({ projectId: p.id, text: 'ship it', interpret, softDeadlineMs: 20 });
    assert.equal(r.routing.timedOut, true);
    assert.equal(r.summary.title, 'Partial');
    assert.equal(r.perAgent[designer.id].body, 'Designer replied.');
    assert.equal(slowAborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENROUTER_API_KEY;
    deleteProject(p.id);
  }
});
