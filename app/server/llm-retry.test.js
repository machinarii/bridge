import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry } from './llm.js';

const noSleep = async () => {};
const res = (status, body = '{}') => new Response(body, { status });

test('fetchWithRetry retries a 429 then succeeds', async () => {
  let calls = 0;
  const _fetch = async () => (++calls === 1 ? res(429) : res(200, '{"ok":true}'));
  const r = await fetchWithRetry('http://x', {}, { _fetch, _sleep: noSleep });
  assert.equal(calls, 2);
  assert.equal(r.status, 200);
});

test('fetchWithRetry gives up after retries and returns the last response', async () => {
  let calls = 0;
  const _fetch = async () => { calls++; return res(429); };
  const r = await fetchWithRetry('http://x', {}, { retries: 2, _fetch, _sleep: noSleep });
  assert.equal(calls, 3);          // initial + 2 retries
  assert.equal(r.status, 429);
});

test('fetchWithRetry retries a thrown network error then succeeds', async () => {
  let calls = 0;
  const _fetch = async () => { if (++calls === 1) throw new Error('ECONNRESET'); return res(200); };
  const r = await fetchWithRetry('http://x', {}, { _fetch, _sleep: noSleep });
  assert.equal(calls, 2);
  assert.equal(r.status, 200);
});

test('fetchWithRetry does NOT retry a 400 (caller bug, not transient)', async () => {
  let calls = 0;
  const _fetch = async () => { calls++; return res(400); };
  const r = await fetchWithRetry('http://x', {}, { _fetch, _sleep: noSleep });
  assert.equal(calls, 1);
  assert.equal(r.status, 400);
});

test('fetchWithRetry does not retry an AbortError (caller timeout/cancel)', async () => {
  let calls = 0;
  const _fetch = async () => { calls++; const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  await assert.rejects(() => fetchWithRetry('http://x', {}, { _fetch, _sleep: noSleep }), /aborted/);
  assert.equal(calls, 1);
});

test('fetchWithRetry honors Retry-After seconds', async () => {
  let calls = 0;
  const slept = [];
  const _fetch = async () => (++calls === 1
    ? new Response('', { status: 429, headers: { 'Retry-After': '2' } })
    : res(200));
  const r = await fetchWithRetry('http://x', {}, { _fetch, _sleep: async (ms) => slept.push(ms) });
  assert.equal(r.status, 200);
  assert.deepEqual(slept, [2000]);
});
