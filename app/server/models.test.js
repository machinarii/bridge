import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getModelForRole, getDefaultModel, tiersEnabled } from './models.js';

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('tiering on by default: craft roles get the cheaper model, reason roles the flagship', () => {
  withEnv({ OPENROUTER_TIERS: undefined, OPENROUTER_MODEL_BY_ROLE: undefined, OPENROUTER_CRAFT_MODEL: undefined, OPENROUTER_MODEL: undefined }, () => {
    assert.equal(tiersEnabled(), true);
    assert.match(getModelForRole('designer'), /sonnet/);    // craft
    assert.match(getModelForRole('sw_engineer'), /sonnet/);  // craft
    assert.equal(getModelForRole('pm'), getDefaultModel());       // reason → flagship
    assert.equal(getModelForRole('security'), getDefaultModel());  // reason → flagship
  });
});

test('tiering can be disabled: every role falls back to the flat default', () => {
  withEnv({ OPENROUTER_TIERS: 'off', OPENROUTER_MODEL_BY_ROLE: undefined, OPENROUTER_MODEL: undefined }, () => {
    assert.equal(tiersEnabled(), false);
    assert.equal(getModelForRole('designer'), getDefaultModel());
    assert.equal(getModelForRole('pm'), getDefaultModel());
  });
});

test('explicit per-role override beats tiering', () => {
  withEnv({ OPENROUTER_TIERS: 'on', OPENROUTER_MODEL_BY_ROLE: JSON.stringify({ designer: 'x/custom' }) }, () => {
    assert.equal(getModelForRole('designer'), 'x/custom');
  });
});

test('craft model is overridable via OPENROUTER_CRAFT_MODEL', () => {
  withEnv({ OPENROUTER_TIERS: 'on', OPENROUTER_CRAFT_MODEL: 'budget/llama', OPENROUTER_MODEL_BY_ROLE: undefined }, () => {
    assert.equal(getModelForRole('qa'), 'budget/llama');
  });
});

test('unknown role falls back to the default even with tiering on', () => {
  withEnv({ OPENROUTER_TIERS: 'on', OPENROUTER_MODEL_BY_ROLE: undefined }, () => {
    assert.equal(getModelForRole('nonexistent_role'), getDefaultModel());
  });
});
