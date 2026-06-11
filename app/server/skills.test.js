import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILLS, getSkill, listSkills, withSkillEnabled, skillsForRole, loadSkillPlaybook } from './skills.js';
import { listRoles } from './roles.js';

const PLAYBOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'skill-playbooks');

test('skill ids are unique', () => {
  const ids = SKILLS.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every skill maps only to known role ids', () => {
  const known = new Set(listRoles().map(r => r.id));
  for (const s of SKILLS) {
    assert.ok(Array.isArray(s.roles) && s.roles.length > 0, `${s.id} has roles`);
    for (const r of s.roles) assert.ok(known.has(r), `${s.id} -> unknown role ${r}`);
  }
});

test('every role has at least one skill', () => {
  const covered = new Set(SKILLS.flatMap(s => s.roles));
  for (const r of listRoles()) {
    assert.ok(covered.has(r.id), `role ${r.id} has no skills`);
  }
});

test('every skill has id, name, description; sourced skills use GitHub URLs', () => {
  for (const s of SKILLS) {
    assert.ok(s.id && s.name && s.description, `${s.id} complete`);
    if (s.source) assert.match(s.source, /^https:\/\/github\.com\//, `${s.id} source is a GitHub URL`);
  }
});

test('listSkills marks everything enabled by default and honors SKILLS_DISABLED', () => {
  delete process.env.SKILLS_DISABLED;
  assert.ok(listSkills().every(s => s.enabled));
  process.env.SKILLS_DISABLED = JSON.stringify(withSkillEnabled('kicad', false));
  const kicad = listSkills().find(s => s.id === 'kicad');
  assert.equal(kicad.enabled, false);
  delete process.env.SKILLS_DISABLED;
});

test('getSkill returns the skill or null', () => {
  assert.equal(getSkill('kicad').name, 'KiCad PCB design');
  assert.equal(getSkill('nope'), null);
});

test('skillsForRole returns enabled skills for that role only', () => {
  delete process.env.SKILLS_DISABLED;
  const ee = skillsForRole('ee_engineer').map(s => s.id);
  assert.ok(ee.includes('kicad'));
  process.env.SKILLS_DISABLED = JSON.stringify(['kicad']);
  assert.ok(!skillsForRole('ee_engineer').map(s => s.id).includes('kicad'));
  delete process.env.SKILLS_DISABLED;
});

test('loadSkillPlaybook returns vendored content or null', () => {
  const pb = loadSkillPlaybook('kicad');
  assert.ok(pb && pb.includes('KiCad'));
  assert.equal(loadSkillPlaybook('no-such-skill'), null);
});

test('every vendored playbook file maps to a known skill id', () => {
  for (const f of readdirSync(PLAYBOOKS_DIR)) {
    if (!f.endsWith('.md')) continue;
    const id = f.slice(0, -3);
    assert.ok(getSkill(id), `orphan playbook: ${f}`);
  }
});
