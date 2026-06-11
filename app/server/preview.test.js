// app/server/preview.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createProject, deleteProject, ensureRepoPath } = await import('./projects.js');
const { previewName, previewPortFor, detectAppPort, previewScript, previewArgs, startPreview, stopPreview } =
  await import('./preview.js');

test('previewPortFor is stable and inside the 4500-4699 range', () => {
  const a = previewPortFor('p_2026_06_10_demo');
  assert.equal(a, previewPortFor('p_2026_06_10_demo'), 'deterministic');
  assert.ok(a >= 4500 && a < 4700, `in range: ${a}`);
  assert.notEqual(previewPortFor('p_other'), undefined);
});

test('previewName sanitizes the project id into a valid container name', () => {
  assert.match(previewName('p_2026_06_10_My App!'), /^bridge-preview-[a-z0-9_.-]+$/);
});

test('detectAppPort finds a listen() literal, else falls back to 3000', () => {
  const repo = mkdtempSync(join(tmpdir(), 'bridge-repo-'));
  mkdirSync(resolve(repo, 'src'), { recursive: true });
  writeFileSync(resolve(repo, 'src/index.js'), 'const app = express();\napp.listen(8087);\n', 'utf8');
  assert.equal(detectAppPort(repo), 8087);
  const empty = mkdtempSync(join(tmpdir(), 'bridge-repo-'));
  assert.equal(detectAppPort(empty), 3000);
});

test('previewScript composes install → build → start; null without a runnable entry', () => {
  const s = previewScript({ scripts: { build: 'tsc', start: 'node dist/index.js' } });
  assert.match(s, /npm install .*&& npm run build && npm start/);
  assert.match(previewScript({ main: 'server.js' }), /node server\.js/);
  assert.equal(previewScript({}), null);
});

test('previewArgs publishes localhost:hostPort→appPort with PORT env, detached + named', () => {
  const args = previewArgs('/repo', { name: 'bridge-preview-x', hostPort: 4512, appPort: 3000, script: 'npm start' });
  assert.equal(args[0], 'run');
  assert.ok(args.includes('-d'), 'detached');
  assert.ok(args.includes('bridge-preview-x'), 'named');
  assert.ok(args.includes('127.0.0.1:4512:3000'), 'port published to localhost only');
  assert.ok(args.includes('PORT=3000'), 'PORT env set');
  assert.ok(args.includes('/repo:/app'), 'repo mounted');
});

test('startPreview replaces the old container, starts detached, returns the URL', async () => {
  const p = await createProject({ name: 'Preview Up', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeFileSync(resolve(ensureRepoPath(p.id), 'package.json'),
      JSON.stringify({ main: 'index.js', scripts: { start: 'node index.js' } }), 'utf8');
    writeFileSync(resolve(ensureRepoPath(p.id), 'index.js'), 'require("http").createServer().listen(5050);', 'utf8');
    const calls = [];
    const _exec = async (args) => { calls.push(args); return { exitCode: 0, output: 'cid' }; };
    const r = await startPreview(p.id, { _exec, probe: async () => true });
    assert.equal(r.ok, true);
    assert.equal(r.url, `http://localhost:${previewPortFor(p.id)}`);
    assert.equal(r.ready, true);
    assert.deepEqual(calls[0].slice(0, 2), ['rm', '-f'], 'previous preview removed first');
    assert.equal(calls[1][0], 'run');
    assert.ok(calls[1].includes(`127.0.0.1:${previewPortFor(p.id)}:5050`), 'detected app port published');
  } finally { deleteProject(p.id); }
});

test('startPreview reports failure when docker run fails; stopPreview issues rm -f', async () => {
  const p = await createProject({ name: 'Preview Down', goal: 'g', roleIds: ['pm', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeFileSync(resolve(ensureRepoPath(p.id), 'package.json'),
      JSON.stringify({ scripts: { start: 'node index.js' } }), 'utf8');
    const _exec = async (args) => (args[0] === 'run' ? { exitCode: 1, output: 'no daemon' } : { exitCode: 0, output: '' });
    const r = await startPreview(p.id, { _exec, probe: async () => true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no daemon/);
    const calls = [];
    await stopPreview(p.id, { _exec: async (a) => { calls.push(a); return { exitCode: 0, output: '' }; } });
    assert.deepEqual(calls[0].slice(0, 2), ['rm', '-f']);
  } finally { deleteProject(p.id); }
});
