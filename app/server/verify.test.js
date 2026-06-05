// app/server/verify.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyScript } from './verify.js';

test('verifyScript includes only the steps the project defines, with markers', () => {
  const s = verifyScript({ build: 'tsc', test: 'node --test' });
  assert.match(s, /@@STEP install.*npm install/s);
  assert.match(s, /@@STEP build.*npm run build/s);
  assert.match(s, /@@STEP test.*npm test/s);
  // no build script → no build step
  const s2 = verifyScript({ test: 'x' });
  assert.doesNotMatch(s2, /@@STEP build/);
  assert.match(s2, /@@STEP test/);
  // always installs
  assert.match(verifyScript({}), /@@STEP install/);
});
