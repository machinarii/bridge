import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getCouncilModels, intakePrompt, normalizeIntake, buildIntake,
  councilContext, memberPrompt, askMember, chairPrompt, synthesize, aiInstructionsBlock,
} from './council.js';

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('getCouncilModels: defaults to three distinct models when unset', () => {
  withEnv({ OPENROUTER_COUNCIL_MODELS: undefined }, () => {
    const m = getCouncilModels();
    assert.equal(m.length, 3);
    assert.equal(new Set(m).size, 3);
    assert.ok(m.every(Boolean));
  });
});

test('getCouncilModels: persisted setting overrides per-slot, falls back per missing slot', () => {
  withEnv({ OPENROUTER_COUNCIL_MODELS: JSON.stringify(['a/one', 'b/two']) }, () => {
    const m = getCouncilModels();
    assert.equal(m[0], 'a/one');
    assert.equal(m[1], 'b/two');
    assert.ok(m[2]); // slot 2 filled from the default
  });
});

test('getCouncilModels: malformed setting falls back to all defaults', () => {
  withEnv({ OPENROUTER_COUNCIL_MODELS: 'not json' }, () => {
    assert.equal(getCouncilModels().length, 3);
  });
});

test('normalizeIntake: caps at 3, drops <2-option and empty questions, trims', () => {
  const out = normalizeIntake({ questions: [
    { q: '  Budget?  ', options: [' low ', 'high', ''] },
    { q: 'Region?', options: ['US'] },              // dropped: <2 options
    { q: '', options: ['a', 'b'] },                 // dropped: no question
    { q: 'Timeline?', options: ['now', 'later'] },
    { q: 'Scale?', options: ['s', 'm'] },
    { q: 'Extra?', options: ['x', 'y'] },           // dropped: over the cap of 3
  ]});
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { q: 'Budget?', options: ['low', 'high'] });
  assert.deepEqual(out.map((q) => q.q), ['Budget?', 'Timeline?', 'Scale?']);
});

test('normalizeIntake: accepts a JSON string and tolerates garbage', () => {
  assert.deepEqual(normalizeIntake('{"questions":[{"q":"A?","options":["x","y"]}]}'), [{ q: 'A?', options: ['x', 'y'] }]);
  assert.deepEqual(normalizeIntake('not json'), []);
  assert.deepEqual(normalizeIntake({}), []);
  assert.deepEqual(normalizeIntake(null), []);
});

test('buildIntake: calls the PM model with the intake prompt and normalizes the reply', async () => {
  let seen = null;
  const callJSON = async (opts) => { seen = opts; return { questions: [{ q: 'Q?', options: ['a', 'b', 'c'] }] }; };
  const out = await buildIntake({ question: 'Pick a DB', apiKey: 'k', callJSON });
  assert.equal(seen.apiKey, 'k');
  assert.ok(seen.model, 'a model was chosen');
  assert.ok(seen.prompt.includes('Pick a DB'));
  assert.deepEqual(out, [{ q: 'Q?', options: ['a', 'b', 'c'] }]);
});

test('councilContext: assembles answered pairs, ignores blanks, empty when none', () => {
  assert.equal(councilContext([]), '');
  assert.equal(councilContext([{ q: 'Budget?', a: '' }]), '');
  const ctx = councilContext([{ q: 'Budget?', a: 'Low' }, { q: 'Region?', a: 'EU' }, { q: '', a: 'x' }]);
  assert.match(ctx, /Context gathered by the PM:/);
  assert.match(ctx, /- Budget\? → Low/);
  assert.match(ctx, /- Region\? → EU/);
  assert.doesNotMatch(ctx, /→ x/);
});

test('memberPrompt: blind — includes question + context, never other members', () => {
  const p = memberPrompt({ question: 'Q', context: '\n\nContext gathered by the PM:\n- a → b' });
  assert.match(p, /advisory council/);
  assert.match(p, /Q/);
  assert.match(p, /Context gathered by the PM/);
});

test('askMember: returns content + null error on success, flags empty as error', async () => {
  const ok = await askMember({ model: 'x/y', question: 'Q', context: '', callText: async () => 'answer' });
  assert.deepEqual(ok, { model: 'x/y', content: 'answer', error: null });
  const empty = await askMember({ model: 'x/y', question: 'Q', context: '', callText: async () => '' });
  assert.equal(empty.error, 'No response');
  assert.equal(empty.content, '');
});

test('chairPrompt: includes only answered members, numbered', () => {
  const p = chairPrompt({ question: 'Q', context: '', members: [
    { model: 'a/1', content: 'Answer one' },
    { model: 'b/2', content: '' },           // skipped (no content)
    { model: 'c/3', content: 'Answer three' },
  ]});
  assert.match(p, /2 members answered/);
  assert.match(p, /### Member 1 \(a\/1\)/);
  assert.match(p, /### Member 2 \(c\/3\)/);
  assert.match(p, /Answer one/);
  assert.match(p, /Answer three/);
});

test('synthesize: short-circuits to empty when no member answered (no LLM call)', async () => {
  let called = false;
  const out = await synthesize({ model: 'chair/x', question: 'Q', context: '', members: [{ model: 'a', content: '' }], callText: async () => { called = true; return 'nope'; } });
  assert.equal(called, false);
  assert.deepEqual(out, { model: 'chair/x', content: '' });
});

test('synthesize: calls chair with assembled prompt when members answered', async () => {
  let seen = null;
  const out = await synthesize({ model: 'chair/x', question: 'Q', context: '', members: [{ model: 'a/1', content: 'Hi' }], callText: async (o) => { seen = o; return 'final'; } });
  assert.equal(seen.model, 'chair/x');
  assert.match(seen.prompt, /chairman/);
  assert.deepEqual(out, { model: 'chair/x', content: 'final' });
});

test('aiInstructionsBlock: empty by default, injected when set', () => {
  withEnv({ AI_INSTRUCTIONS: undefined }, () => assert.equal(aiInstructionsBlock(), ''));
  withEnv({ AI_INSTRUCTIONS: 'Be terse.' }, () => assert.match(aiInstructionsBlock(), /Be terse\./));
});
