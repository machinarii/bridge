import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBaseCharter, validateCharterMarkdown, FALLBACK_REASON } from './charters.js';
import { mkdtempSync, writeFileSync as wfs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
