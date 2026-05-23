import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBaseCharter, validateCharterMarkdown, FALLBACK_REASON } from './charters.js';

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
