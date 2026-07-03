// Autonomous pipeline: after the user answers the PM's kickoff questions the
// team plans, builds, and runs WITHOUT further user gates (Cowork-style).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createProject, getProject, deleteProject, setKickoff, getKickoff, rolesDir } = await import('./projects.js');
const { writeNote } = await import('./backends/notes.js');
const { handleLeadMessageDuringKickoff } = await import('./kickoff.js');
const { charterFileNameFor } = await import('./charters.js');

/* One stub that serves every model prompt in the pipeline, keyed on prompt shape. */
const PLAN_JSON = JSON.stringify({ stack: 'node', summary: 's', files: [
  { path: 'package.json', purpose: 'manifest' },
  { path: 'src/index.js', purpose: 'entry' },
] });
function pipelineStub({ prompt } = {}) {
  const p = String(prompt || '');
  if (/Propose an initial code scaffold/.test(p)) return PLAN_JSON;
  if (/Write the complete contents of ONE file/.test(p)) {
    return /PATH:package\.json/.test(p)
      ? JSON.stringify({ scripts: { test: 'node --test' } })
      : 'console.log(1)\n';
  }
  if (/write YOUR short domain plan/.test(p)) return '## My plan\n\n- step one\n';
  return '{}';
}
const stub = async (args) => pipelineStub(args);

test('answering the last PM question skips the interactive round: specialists plan autonomously, build plan lands', async () => {
  const p = await createProject({ name: 'Auto Plans', goal: 'g', roleIds: ['pm', 'designer', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n');
    setKickoff(p.id, { status: 'asking', questions: [{ q: 'Focus?', options: ['A', 'B'] }], qIdx: 0, assignments: [] });
    const r = await handleLeadMessageDuringKickoff(p.id, 'A', { callText: stub, apiKey: 'k' });
    // No per-specialist interrogation of the user — straight to the build handoff.
    assert.notEqual(getKickoff(p.id).status, 'team_review');
    assert.equal(r.intent, 'build_handoff');
    assert.equal(getKickoff(p.id).status, 'build_pending');
    // Each specialist wrote a domain plan into their role charter, autonomously.
    const designerFile = readFileSync(resolve(rolesDir(p.id), charterFileNameFor('designer')), 'utf8');
    assert.match(designerFile, /## Plan/);
    assert.match(designerFile, /step one/);
  } finally { deleteProject(p.id); }
});

test('autoRun drives scaffold → sandbox run → verified with no Build it / Run it gates', async () => {
  const p = await createProject({ name: 'Auto BuildRun', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n');
    setKickoff(p.id, { status: 'asking', questions: [{ q: 'Focus?', options: ['A', 'B'] }], qIdx: 0, assignments: [] });
    let ran = false;
    const runner = async () => { ran = true; return { exitCode: 0, output: 'ok' }; };
    const r = await handleLeadMessageDuringKickoff(p.id, 'A',
      { callText: stub, apiKey: 'k', autoRun: true, runner });
    assert.equal(r.intent, 'build_handoff');
    // The auto chain runs in the background — poll until it lands.
    const deadline = Date.now() + 5000;
    while (getKickoff(p.id).status !== 'verified' && Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 25));
    }
    assert.equal(getKickoff(p.id).status, 'verified');
    assert.ok(ran, 'sandbox run executed');
    assert.ok(existsSync(resolve(getProject(p.id).build.repoPath, 'src/index.js')), 'files scaffolded');
  } finally { deleteProject(p.id); }
});

test('without autoRun (unit-test mode) the manual Build it gate is preserved', async () => {
  const p = await createProject({ name: 'Manual Gate', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n');
    setKickoff(p.id, { status: 'asking', questions: [{ q: 'Focus?', options: ['A', 'B'] }], qIdx: 0, assignments: [] });
    await handleLeadMessageDuringKickoff(p.id, 'A', { callText: stub, apiKey: 'k' });
    assert.equal(getKickoff(p.id).status, 'build_pending');
    // Nothing scaffolded until the user (or auto mode) says so.
    assert.ok(!existsSync(resolve(getProject(p.id).build.repoPath, 'src/index.js')));
  } finally { deleteProject(p.id); }
});
