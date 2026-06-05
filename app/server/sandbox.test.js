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

import { runInContainer } from './sandbox.js';

test('runInContainer captures combined output and the exit code', async () => {
  // Drive the real spawn/capture path with sh instead of docker.
  const r = await runInContainer('/r', { _bin: 'sh', _args: ['-c', 'echo out; echo err 1>&2; exit 3'] });
  assert.equal(r.exitCode, 3);
  assert.match(r.output, /out/);
  assert.match(r.output, /err/);
  assert.equal(r.timedOut, false);
  assert.equal(r.daemonDown, false);
});

test('runInContainer enforces a timeout', async () => {
  const r = await runInContainer('/r', { _bin: 'sh', _args: ['-c', 'sleep 5'], timeoutMs: 150 });
  assert.equal(r.timedOut, true);
});

test('runInContainer flags a stopped Docker daemon', async () => {
  const r = await runInContainer('/r', { _bin: 'sh', _args: ['-c', 'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock." 1>&2; exit 1'] });
  assert.equal(r.daemonDown, true);
});

test('runInContainer resolves (not rejects) when the binary is missing', async () => {
  const r = await runInContainer('/r', { _bin: 'definitely-not-a-real-binary-xyz', _args: ['x'] });
  assert.equal(r.exitCode, -1);
});
