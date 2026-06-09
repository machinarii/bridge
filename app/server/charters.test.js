import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBaseCharter, validateCharterMarkdown, FALLBACK_REASON, deepenCharters } from './charters.js';
import { listRoles } from './roles.js';
import { mkdtempSync, writeFileSync as wfs, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('every active role baseline has the three required charter headings', () => {
  for (const r of listRoles()) {
    const md = loadBaseCharter(r.id);
    const v = validateCharterMarkdown(md);
    assert.equal(v.ok, true, `role ${r.id} invalid: ${v.reason || ''}`);
    assert.match(md, /^# /, `role ${r.id} missing top-level title`);
  }
});

test('loadBaseCharter returns the file contents for a known role', () => {
  const md = loadBaseCharter('pm');
  assert.match(md, /^# Product Manager/);
  assert.match(md, /## Role/);
  assert.match(md, /## Typical tasks/);
  assert.match(md, /## Areas of expertise/);
});

test('loadBaseCharter throws for unknown role', () => {
  assert.throws(() => loadBaseCharter('nope'));
});

test('validateCharterMarkdown accepts complete charter', () => {
  const md = '# X\n## Role\nfoo\n## Typical tasks\n- bar\n## Areas of expertise\n- baz\n';
  assert.equal(validateCharterMarkdown(md).ok, true);
});

test('validateCharterMarkdown rejects when heading missing', () => {
  const md = '# X\n## Role\nfoo\n## Typical tasks\n- bar\n';
  const r = validateCharterMarkdown(md);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Areas of expertise/);
});

test('FALLBACK_REASON is exported', () => {
  assert.ok(FALLBACK_REASON);
});

test('loadBaseCharter prefers a valid BRIDGE_CHARTERS_DIR override', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-charters-'));
  const prev = process.env.BRIDGE_CHARTERS_DIR;
  process.env.BRIDGE_CHARTERS_DIR = dir;
  // pm → role-pm.md (CHARTER_SLUG_OVERRIDE)
  wfs(join(dir, 'role-pm.md'),
    '# Override PM\n## Role\nr\n## Typical tasks\n- t\n## Areas of expertise\n- e\n', 'utf8');
  try {
    assert.match(loadBaseCharter('pm'), /^# Override PM/);
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_CHARTERS_DIR; else process.env.BRIDGE_CHARTERS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadBaseCharter ignores an invalid override and uses the bundled template', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-charters-'));
  const prev = process.env.BRIDGE_CHARTERS_DIR;
  process.env.BRIDGE_CHARTERS_DIR = dir;
  wfs(join(dir, 'role-pm.md'), '# Bad\n## Role only\n', 'utf8'); // missing headings
  try {
    assert.match(loadBaseCharter('pm'), /^# Product Manager/); // bundled wins
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_CHARTERS_DIR; else process.env.BRIDGE_CHARTERS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeProject(dir) {
  return {
    id: 'p_test', name: 'Test Co', goal: 'ship it', features: 'feat A; feat B',
    repoPath: dir,
    agents: [{ id: 'p_test__pm', role: 'pm', name: 'Cassidy' }],
  };
}

test('deepenCharters rewrites the charter and preserves a ## Plan section', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-deepen-'));
  const rolesDir = join(dir, 'docs', 'roles');
  mkdirSync(rolesDir, { recursive: true });
  wfs(join(rolesDir, 'role-pm.md'),
    '# Product Manager\n## Role\nbase\n## Typical tasks\n- base\n## Areas of expertise\n- base\n\n## Plan\n\n- ship the MVP\n', 'utf8');
  const callText = async () =>
    '# Product Manager\n## Role\nTAILORED to Test Co\n## Typical tasks\n- TAILORED task\n## Areas of expertise\n- TAILORED area\n';
  try {
    const res = await deepenCharters(fakeProject(dir), { prd: '# PRD\n\nrich context', callText, apiKey: 'k' });
    const md = readFileSync(join(rolesDir, 'role-pm.md'), 'utf8');
    assert.equal(res[0].deepened, true);
    assert.match(md, /TAILORED to Test Co/);              // body rewritten
    assert.match(md, /TAILORED to Test Co[\s\S]*## Plan/); // rewritten body precedes the preserved plan
    assert.match(md, /ship the MVP/);                     // plan content preserved
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deepenCharters keeps the existing charter on a failed/invalid model reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-deepen-'));
  const rolesDir = join(dir, 'docs', 'roles');
  mkdirSync(rolesDir, { recursive: true });
  const original = '# Product Manager\n## Role\nKEEP ME\n## Typical tasks\n- t\n## Areas of expertise\n- e\n';
  wfs(join(rolesDir, 'role-pm.md'), original, 'utf8');
  const callText = async () => 'garbage with no headings';
  try {
    const res = await deepenCharters(fakeProject(dir), { prd: '# PRD', callText, apiKey: 'k' });
    assert.equal(res[0].deepened, false);
    assert.equal(readFileSync(join(rolesDir, 'role-pm.md'), 'utf8'), original);  // unchanged
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deepenCharters skips entirely when the PRD is empty/not-generated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-deepen-'));
  mkdirSync(join(dir, 'docs', 'roles'), { recursive: true });
  let called = false;
  const callText = async () => { called = true; return 'x'; };
  try {
    const res = await deepenCharters(fakeProject(dir), { prd: '_not generated_', callText, apiKey: 'k' });
    assert.deepEqual(res, []);
    assert.equal(called, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
