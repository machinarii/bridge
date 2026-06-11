/* Bridge — agent skill registry.
 *
 * Skills are short, model-agnostic playbooks (SKILL.md-style) the orchestrator
 * can inject into an agent's context when it picks up a matching task — layered
 * on top of the role charter ("how to do THIS kind of work"). This module is the
 * catalog + enabled-state; the Settings → Skills tab toggles them.
 *
 * Enabled by default; the disabled set is persisted in the SKILLS_DISABLED env
 * (a JSON array of skill ids) via the same .env store as the other settings.
 */

export const SKILLS = [
  { id: 'discovery',         name: 'Discovery',            description: 'Run product discovery — interviews, jobs-to-be-done, opportunity mapping.', roles: ['pm', 'ux_research'] },
  { id: 'prioritization',    name: 'Prioritization',       description: 'Rank work with explicit tradeoffs and a clear rationale.',                    roles: ['pm'] },
  { id: 'roadmap',           name: 'Roadmap planning',     description: 'Turn goals into a sequenced, outcome-oriented roadmap.',                      roles: ['pm'] },
  { id: 'prd',               name: 'PRD authoring',        description: 'Write a crisp product requirements doc from a problem statement.',            roles: ['pm'] },
  { id: 'user-stories',      name: 'User stories',         description: 'Split work into vertical, testable user stories.',                            roles: ['pm'] },
  { id: 'writing-plans',     name: 'Writing plans',        description: 'Turn a goal into a step-by-step implementation plan.',                        roles: ['pm', 'sw_engineer'] },
  { id: 'tdd',               name: 'Test-driven development', description: 'Write the failing test first, then the code to pass it.',                  roles: ['sw_engineer', 'qa'] },
  { id: 'systematic-debugging', name: 'Systematic debugging', description: 'Reproduce, isolate, hypothesize, fix, verify.',                            roles: ['sw_engineer', 'qa'] },
  { id: 'code-review',       name: 'Code review',          description: 'Review changes for correctness, clarity, and maintainability.',               roles: ['sw_engineer', 'qa'] },
  { id: 'ux-flows',          name: 'UX flows',             description: 'Design user flows and journey maps from a goal.',                             roles: ['designer', 'ux_research'] },
  { id: 'positioning',       name: 'Positioning & messaging', description: 'Sharpen positioning, value props, and launch messaging.',                 roles: ['marketing', 'copywriter'] },
  { id: 'threat-model',      name: 'Threat modeling',      description: 'Identify security, privacy, and abuse risks and mitigations.',                roles: ['security'] },
  { id: 'kicad',             name: 'KiCad PCB design',     description: 'Design schematics and PCB layouts in KiCad — capture, footprints, DRC/ERC, and manufacturing outputs (Gerbers, BOM).', roles: ['ee_engineer'] },
];

const BY_ID = Object.fromEntries(SKILLS.map(s => [s.id, s]));

export function getSkill(id) { return BY_ID[id] || null; }

/** Parse the disabled-id set from the SKILLS_DISABLED env (JSON array). */
export function disabledSkillIds() {
  try {
    const arr = JSON.parse(process.env.SKILLS_DISABLED || '[]');
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

/** Catalog with a computed `enabled` flag per skill (default on). */
export function listSkills() {
  const disabled = disabledSkillIds();
  return SKILLS.map(s => ({ ...s, enabled: !disabled.has(s.id) }));
}

/** Return the new disabled-id array after setting one skill on/off. */
export function withSkillEnabled(id, enabled) {
  const disabled = disabledSkillIds();
  if (enabled) disabled.delete(id); else disabled.add(id);
  return [...disabled];
}
