import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, getRole, listRoles } from './roles.js';

test('listRoles returns all 14 roles', () => {
  const ids = listRoles().map(r => r.id);
  assert.equal(ids.length, 14);
  assert.deepEqual(new Set(ids).size, 14, 'all ids unique');
});

test('every role has id, label, color, namePool, personaSeed', () => {
  for (const r of listRoles()) {
    assert.ok(r.id);
    assert.ok(r.label);
    assert.ok(r.color);
    assert.ok(Array.isArray(r.namePool) && r.namePool.length >= 4);
    assert.ok(r.personaSeed);
  }
});

test('getRole(id) returns the role or null', () => {
  assert.equal(getRole('pm').label, 'Product Manager');
  assert.equal(getRole('nope'), null);
});
