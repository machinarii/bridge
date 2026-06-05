// app/server/sandbox.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dockerArgs } from './sandbox.js';

test('dockerArgs bind-mounts the repo, keeps node_modules container-only, runs the script', () => {
  const args = dockerArgs('/repo/x', { image: 'node:20-slim', script: 'npm test' });
  // throwaway + source bind mount + container-only node_modules overlay
  assert.ok(args.includes('--rm'));
  const joined = args.join(' ');
  assert.match(joined, /-v \/repo\/x:\/app/);
  assert.match(joined, /-v \/app\/node_modules/);
  assert.match(joined, /-w \/app/);
  // resource caps
  assert.ok(args.some(a => a.startsWith('--memory')));
  assert.ok(args.some(a => a.startsWith('--cpus')));
  // image precedes the shell command; script passed to sh -lc
  const i = args.indexOf('node:20-slim');
  assert.ok(i > 0);
  assert.deepEqual(args.slice(i), ['node:20-slim', 'sh', '-lc', 'npm test']);
});

test('dockerArgs defaults the image to node:20-slim', () => {
  const args = dockerArgs('/r', { script: 'echo hi' });
  assert.ok(args.includes('node:20-slim'));
});
