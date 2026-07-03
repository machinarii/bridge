import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Isolate state + repos to throwaway temp dirs — never touch app/state or ~/bridge-projects.
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));

import { kickoffDecisionsBlock } from './orchestrator.js';
import { createProject, deleteProject } from './projects.js';
import { writeNote } from './backends/notes.js';

test('kickoffDecisionsBlock returns the resolved decisions doc', async () => {
  const p = await createProject({ name: 'Decisions', goal: 'g', roleIds: ['pm'], topology: null });
  try {
    writeNote(p.id, 'open-questions',
      '# Open Questions\n\n_Resolved during kickoff Q&A._\n\n## 1. Target user?\n\n**Answer:** Solo hikers\n');
    const block = kickoffDecisionsBlock(p.id);
    assert.match(block, /Solo hikers/);
    assert.match(block, /Do NOT re-ask/i);
  } finally { deleteProject(p.id); }
});

test('kickoffDecisionsBlock is empty when no answers were recorded', async () => {
  const p = await createProject({ name: 'NoDecisions', goal: 'g', roleIds: ['pm'], topology: null });
  try {
    // Unresolved template (no **Answer:** lines) → nothing settled yet.
    writeNote(p.id, 'open-questions', '# Open Questions\n\n- What is the budget?\n- Who is the user?\n');
    assert.equal(kickoffDecisionsBlock(p.id), '');
  } finally { deleteProject(p.id); }
});

test('kickoffDecisionsBlock is empty when the doc is absent', async () => {
  const p = await createProject({ name: 'NoDoc', goal: 'g', roleIds: ['pm'], topology: null });
  try {
    assert.equal(kickoffDecisionsBlock(p.id), '');
  } finally { deleteProject(p.id); }
});
