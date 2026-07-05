import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate state + repos to throwaway temp dirs — never touch app/state or ~/bridge-projects.
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
delete process.env.OPENROUTER_API_KEY;   // force the local-classifier fallback (no model call)

const { createProject, deleteProject, getProject } = await import('./projects.js');
const { interpretIntent } = await import('./orchestrator.js');
const { getContext } = await import('./scratchpad.js');

const isHandoff = (m) => m.role === 'system' && /"kind":"handoff"/.test(String(m.content || ''));

test('a re-run delegated task does not append a duplicate handoff bubble', async () => {
  const p = await createProject({ name: 'Handoff Dedup', goal: 'g', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    const designer = getProject(p.id).agents.find(a => a.role === 'designer');
    const handoff = { from: 'Quinn', fromRole: 'Product Manager', to: designer.name, toRole: 'Designer' };

    // First run records the From→To handoff turn.
    await interpretIntent({ projectId: p.id, agentId: designer.id, text: 'design the onboarding', handoff });
    const afterFirst = getContext(designer.id).messages.filter(isHandoff).length;
    assert.ok(afterFirst >= 1, 'first run records the handoff');

    // A retry/re-drain of the SAME task re-enters interpretIntent before a reply
    // lands — it must not append a second identical handoff (idempotency guard).
    await interpretIntent({ projectId: p.id, agentId: designer.id, text: 'design the onboarding', handoff });
    const afterRetry = getContext(designer.id).messages.filter(isHandoff).length;
    assert.equal(afterRetry, afterFirst, 'retry does not add a second identical handoff');
  } finally { deleteProject(p.id); }
});

test('parallel turns for the same agent are serialized before model calls', async () => {
  const p = await createProject({ name: 'Agent Lock', goal: 'g', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  try {
    const designer = getProject(p.id).agents.find(a => a.role === 'designer');
    let active = 0;
    let maxActive = 0;
    globalThis.fetch = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 25));
      active--;
      const content = JSON.stringify({
        intent: 'answer',
        template: 'reader',
        title: 'Done',
        body: 'ok',
        actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
      });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    };
    await Promise.all([
      interpretIntent({ projectId: p.id, agentId: designer.id, text: 'first', mode: 'team' }),
      interpretIntent({ projectId: p.id, agentId: designer.id, text: 'second', mode: 'team' }),
    ]);
    assert.equal(maxActive, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    deleteProject(p.id);
  }
});
