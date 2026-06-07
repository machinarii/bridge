// app/server/scaffold.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createProject, getProject, deleteProject } = await import('./projects.js');
const { writeNote } = await import('./backends/notes.js');
const { generateBuildPlan } = await import('./scaffold.js');

test('generateBuildPlan prompt instructs a self-contained, SQLite-default scaffold', async () => {
  const p = await createProject({ name: 'Plan SQLite', goal: 'a prisma app', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    let seenPrompt = '';
    const callText = async ({ prompt }) => {
      seenPrompt = prompt;
      return JSON.stringify({ stack: 'node+prisma', summary: 's', files: [{ path: 'package.json', purpose: 'm' }] });
    };
    await generateBuildPlan(p.id, { callText });
    assert.match(seenPrompt, /offline sandbox/i);
    assert.match(seenPrompt, /sqlite/i);
    assert.match(seenPrompt, /provider = "sqlite"/);
  } finally { deleteProject(p.id); }
});

test('generateBuildPlan parses a plan, persists it, and sets phase=build_pending', async () => {
  const p = await createProject({ name: 'Plan Gen', goal: 'a todo app', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n\nBuild a todo app.\n');
    // Stub model: returns a fenced JSON build plan regardless of prompt.
    const callText = async () => '```json\n' +
      JSON.stringify({ stack: 'node', summary: 'todo app', files: [
        { path: 'package.json', purpose: 'manifest' },
        { path: 'src/index.js', purpose: 'entry' },
      ] }) + '\n```';
    const plan = await generateBuildPlan(p.id, { callText });
    assert.equal(plan.stack, 'node');
    assert.equal(plan.files.length, 2);
    const proj = getProject(p.id);
    assert.equal(proj.phase, 'build_pending');
    assert.equal(proj.build.status, 'pending');
    assert.deepEqual(proj.build.plan.files.map(f => f.path), ['package.json', 'src/index.js']);
  } finally { deleteProject(p.id); }
});

test('generateBuildPlan throws on an unparseable plan and does not advance phase', async () => {
  const p = await createProject({ name: 'Plan Bad', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    await assert.rejects(() => generateBuildPlan(p.id, { callText: async () => 'not json at all' }), /build plan/i);
    assert.notEqual(getProject(p.id).phase, 'build_pending');
  } finally { deleteProject(p.id); }
});

// append to app/server/scaffold.test.js
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const { scaffoldProject } = await import('./scaffold.js');

test('scaffoldProject generates contents, writes files, commits, phase=built', async () => {
  const p = await createProject({ name: 'Scaffold Go', goal: 'a cli', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n');
    const planText = async () => JSON.stringify({ stack: 'node', summary: 's', files: [
      { path: 'README.md', purpose: 'readme' }, { path: 'src/cli.js', purpose: 'cli' },
    ] });
    await generateBuildPlan(p.id, { callText: planText });
    // For scaffolding, the stub returns deterministic contents per file path.
    const contentText = async ({ prompt }) => `// generated for: ${prompt.match(/PATH:(\S+)/)?.[1] || '?'}\n`;
    const r = await scaffoldProject(p.id, { callText: contentText });
    assert.equal(r.ok, true);
    assert.match(r.commitSha, /^[0-9a-f]{7,}$/);
    assert.equal(r.fileCount, 2);
    const repo = getProject(p.id).build.repoPath;
    assert.ok(existsSync(resolve(repo, 'README.md')));
    assert.ok(existsSync(resolve(repo, 'src/cli.js')));
    assert.match(readFileSync(resolve(repo, 'src/cli.js'), 'utf8'), /generated for: src\/cli\.js/);
    assert.equal(getProject(p.id).phase, 'built');
    assert.equal(getProject(p.id).build.status, 'done');
    // committed (clean tree)
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString().trim(), '');
  } finally { deleteProject(p.id); }
});

test('scaffoldProject is atomic: a generation failure writes nothing and flags error', async () => {
  const p = await createProject({ name: 'Scaffold Fail', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    await generateBuildPlan(p.id, { callText: async () => JSON.stringify({ stack: 'x', summary: 's', files: [{ path: 'a.js', purpose: 'p' }] }) });
    const repo = getProject(p.id).build.repoPath;
    await assert.rejects(() => scaffoldProject(p.id, { callText: async () => { throw new Error('boom'); } }), /boom/);
    assert.ok(!existsSync(resolve(repo, 'a.js')), 'nothing written on failure');
    assert.equal(getProject(p.id).build.status, 'error');
    assert.equal(getProject(p.id).phase, 'build_pending', 'phase rolls back to pending');
  } finally { deleteProject(p.id); }
});

test('scaffoldProject static-checks generated JS and reports syntax issues', async () => {
  const p = await createProject({ name: 'Check JS', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n');
    await generateBuildPlan(p.id, { callText: async () => JSON.stringify({ stack: 'node', summary: 's', files: [{ path: 'good.js', purpose: 'g' }, { path: 'bad.js', purpose: 'b' }] }) });
    const ct = async ({ prompt }) => prompt.includes('PATH:bad.js') ? 'function (' : 'const x = 1;\n';
    const r = await scaffoldProject(p.id, { callText: ct, fixRounds: 0 }); // isolate the check
    assert.equal(r.ok, true);
    assert.ok(r.issues.some(i => i.path === 'bad.js'), 'bad.js flagged with a syntax issue');
    assert.ok(!r.issues.some(i => i.path === 'good.js'), 'good.js is clean');
  } finally { deleteProject(p.id); }
});

test('scaffoldProject closes the feedback loop: regenerates a failing file until it parses', async () => {
  const p = await createProject({ name: 'Fix Loop', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n');
    await generateBuildPlan(p.id, { callText: async () => JSON.stringify({ stack: 'node', summary: 's', files: [{ path: 'a.js', purpose: 'p' }] }) });
    // initial generation → broken; regeneration (prompt mentions the error) → valid
    const ct = async ({ prompt }) => prompt.includes('syntax error') ? 'const x = 1;\n' : 'function (';
    const r = await scaffoldProject(p.id, { callText: ct });
    assert.equal(r.ok, true);
    assert.equal(r.issues.length, 0, 'the syntax issue was fixed');
    assert.ok(r.fixRounds >= 1, 'at least one fix round ran');
  } finally { deleteProject(p.id); }
});

test('scaffoldProject reports issues that survive the fix rounds', async () => {
  const p = await createProject({ name: 'Stays Broken', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n');
    await generateBuildPlan(p.id, { callText: async () => JSON.stringify({ stack: 'node', summary: 's', files: [{ path: 'b.js', purpose: 'p' }] }) });
    const ct = async () => 'function (';   // always broken
    const r = await scaffoldProject(p.id, { callText: ct, fixRounds: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.fixRounds, 1);
    assert.ok(r.issues.some(i => i.path === 'b.js'), 'still flagged after exhausting fix rounds');
  } finally { deleteProject(p.id); }
});
