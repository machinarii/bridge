/* Bridge — agent skill registry.
 *
 * Skills are short, model-agnostic playbooks (SKILL.md-style) the orchestrator
 * can inject into an agent's context when it picks up a matching task — layered
 * on top of the role charter ("how to do THIS kind of work"). This module is the
 * catalog + enabled-state; the Settings → Skills tab toggles them.
 *
 * Entries with a `source` are adopted from the open Claude-skills ecosystem on
 * GitHub (anthropics/skills, obra/superpowers, trailofbits/skills, …) — the URL
 * is where the playbook content lives. Entries without one are Bridge-native.
 *
 * Enabled by default; the disabled set is persisted in the SKILLS_DISABLED env
 * (a JSON array of skill ids) via the same .env store as the other settings.
 */

export const SKILLS = [
  // — Bridge-native playbooks —
  { id: 'discovery',         name: 'Discovery',            description: 'Run product discovery — interviews, jobs-to-be-done, opportunity mapping.', roles: ['pm', 'ux_research'] },
  { id: 'prioritization',    name: 'Prioritization',       description: 'Rank work with explicit tradeoffs and a clear rationale.',                    roles: ['pm'] },
  { id: 'roadmap',           name: 'Roadmap planning',     description: 'Turn goals into a sequenced, outcome-oriented roadmap.',                      roles: ['pm'] },
  { id: 'prd',               name: 'PRD authoring',        description: 'Write a crisp product requirements doc from a problem statement.',            roles: ['pm'] },
  { id: 'user-stories',      name: 'User stories',         description: 'Split work into vertical, testable user stories.',                            roles: ['pm'] },
  { id: 'ux-flows',          name: 'UX flows',             description: 'Design user flows and journey maps from a goal.',                             roles: ['designer', 'ux_research'] },
  { id: 'positioning',       name: 'Positioning & messaging', description: 'Sharpen positioning, value props, and launch messaging.',                 roles: ['marketing', 'copywriter'] },
  { id: 'threat-model',      name: 'Threat modeling',      description: 'Identify security, privacy, and abuse risks and mitigations.',                roles: ['security'] },

  // — engineering process (obra/superpowers) —
  { id: 'writing-plans',     name: 'Writing plans',        description: 'Turn a goal into a step-by-step implementation plan.',                        roles: ['pm', 'sw_engineer'], source: 'https://github.com/obra/superpowers' },
  { id: 'brainstorming',     name: 'Brainstorming',        description: 'Socratic design refinement — explore intent, requirements, and alternatives before building.', roles: ['pm', 'designer', 'ux_research'], source: 'https://github.com/obra/superpowers' },
  { id: 'tdd',               name: 'Test-driven development', description: 'Write the failing test first, then the code to pass it.',                  roles: ['sw_engineer', 'qa'], source: 'https://github.com/obra/superpowers' },
  { id: 'systematic-debugging', name: 'Systematic debugging', description: 'Reproduce, isolate, hypothesize, fix, verify — works for code and hardware bring-up alike.', roles: ['sw_engineer', 'qa', 'hw_engineer'], source: 'https://github.com/obra/superpowers' },
  { id: 'code-review',       name: 'Code review',          description: 'Review changes for correctness, clarity, and maintainability.',               roles: ['sw_engineer', 'qa'], source: 'https://github.com/obra/superpowers' },
  { id: 'verification-before-completion', name: 'Verify before done', description: 'Run verification and show evidence before claiming work is complete.', roles: ['qa', 'sw_engineer'], source: 'https://github.com/obra/superpowers' },

  // — building & testing (anthropics/skills) —
  { id: 'mcp-builder',       name: 'MCP builder',          description: 'Build MCP servers that connect agents to external APIs and tools.',           roles: ['sw_engineer'], source: 'https://github.com/anthropics/skills' },
  { id: 'frontend-design',   name: 'Frontend design',      description: 'Distinctive, production-grade UI work that avoids generic AI aesthetics.',    roles: ['designer', 'sw_engineer'], source: 'https://github.com/anthropics/skills' },
  { id: 'canvas-design',     name: 'Canvas design',        description: 'Create visual art, posters, and graphics as PNG/PDF.',                        roles: ['designer'], source: 'https://github.com/anthropics/skills' },
  { id: 'impeccable',        name: 'Impeccable design',    description: 'Design-language toolkit — polish, audit, critique, animate, bolder/quieter commands that kill generic AI-slop frontend design.', roles: ['designer'], source: 'https://github.com/pbakaus/impeccable' },
  { id: 'awesome-design',    name: 'Design system inspirations', description: 'Ready-to-use DESIGN.md design systems by aesthetic family — drop one in and scaffold a full UI from exact design tokens.', roles: ['designer'], source: 'https://github.com/VoltAgent/awesome-claude-design' },
  { id: 'webapp-testing',    name: 'Web app testing',      description: 'Drive and test web apps end-to-end with Playwright automation.',              roles: ['qa'], source: 'https://github.com/anthropics/skills' },

  // — documents & comms (anthropics/skills) —
  { id: 'doc-coauthoring',   name: 'Doc co-authoring',     description: 'Structured workflow for drafting and iterating documents together.',          roles: ['pm', 'copywriter'], source: 'https://github.com/anthropics/skills' },
  { id: 'docx',              name: 'Word documents',       description: 'Draft and edit Word documents with tracked changes — contracts, redlines, long-form docs.', roles: ['legal', 'copywriter'], source: 'https://github.com/anthropics/skills' },
  { id: 'pdf',               name: 'PDF processing',       description: 'Extract text and tables, fill forms, merge and split PDF documents.',         roles: ['legal'], source: 'https://github.com/anthropics/skills' },
  { id: 'pptx',              name: 'Presentations',        description: 'Build and edit slide decks with layouts, themes, and charts.',                roles: ['marketing', 'pm'], source: 'https://github.com/anthropics/skills' },
  { id: 'internal-comms',    name: 'Internal comms',       description: 'Write crisp status reports, newsletters, and FAQs.',                          roles: ['copywriter', 'pm'], source: 'https://github.com/anthropics/skills' },
  { id: 'brand-guidelines',  name: 'Brand guidelines',     description: 'Apply consistent brand colors, typography, and voice across deliverables.',   roles: ['marketing', 'designer'], source: 'https://github.com/anthropics/skills' },

  // — data (anthropics/skills, community) —
  { id: 'xlsx',              name: 'Spreadsheets',         description: 'Analyze and build Excel spreadsheets with formulas, pivots, and charts.',     roles: ['data_sci'], source: 'https://github.com/anthropics/skills' },
  { id: 'd3-visualization',  name: 'D3 visualization',     description: 'Build interactive data visualizations with d3.js.',                           roles: ['data_sci'], source: 'https://github.com/chrisvoncsefalvay/claude-d3js-skill' },

  // — security (trailofbits/skills) —
  { id: 'security-analysis', name: 'Security static analysis', description: 'Hunt vulnerabilities with CodeQL, Semgrep, and differential code review playbooks.', roles: ['security'], source: 'https://github.com/trailofbits/skills' },

  // — electronics (aklofas/kicad-happy) —
  { id: 'kicad',             name: 'KiCad PCB design',     description: 'Design schematics and PCB layouts in KiCad — capture, footprints, DRC/ERC, EMC pre-compliance, SPICE checks, and fab outputs (Gerbers, BOM).', roles: ['ee_engineer'], source: 'https://github.com/aklofas/kicad-happy' },
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
