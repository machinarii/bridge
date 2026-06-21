import { test } from 'node:test';
import assert from 'node:assert/strict';

const { healthSnapshot } = await import('./health.js');

test('healthSnapshot returns expected top-level shape', async () => {
  const h = await healthSnapshot();
  assert.ok(h && typeof h === 'object');
  assert.equal(typeof h.at, 'number');
  assert.equal(typeof h.keychain, 'boolean');
  assert.ok(h.openrouter && typeof h.openrouter.ok === 'boolean');
  assert.ok(h.stt && typeof h.stt.ok === 'boolean');
  assert.ok(h.docker && typeof h.docker.ok === 'boolean');
  assert.ok(h.github && typeof h.github.ok === 'boolean');
});
