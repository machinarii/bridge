/* Bridge — agent skill registry.
 *
 * Skills are short, model-agnostic playbooks (SKILL.md-style) the orchestrator
 * can inject into an agent's context when it picks up a matching task — layered
 * on top of the role charter ("how to do THIS kind of work"). This module is the
 * catalog + enabled-state; the Settings → Skills tab toggles them.
 *
 * Entries with a `source` are adopted from the open Claude-skills ecosystem on
 * GitHub (anthropics/skills, obra/superpowers, trailofbits/skills, …) — the URL
 * is where the full playbook lives. Entries without one are Bridge-native.
 *
 * Skills with a condensed playbook vendored at skill-playbooks/<id>.md get the
 * full playbook injected into matching agents' prompts (see orchestrator.js);
 * the rest inject as a one-line "you can do this" capability.
 *
 * Enabled by default; the disabled set is persisted in the SKILLS_DISABLED env
 * (a JSON array of skill ids) via the same .env store as the other settings.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOKS_DIR = resolve(__dirname, 'skill-playbooks');

export const SKILLS = [
  // — Bridge-native playbooks —
  { id: 'ux-flows',          name: 'UX flows',             description: 'Design user flows and journey maps from a goal.',                             roles: ['designer', 'ux_research'] },
  { id: 'positioning',       name: 'Positioning & messaging', description: 'Sharpen positioning, value props, and launch messaging.',                 roles: ['marketing', 'copywriter'] },
  { id: 'threat-model',      name: 'Threat modeling',      description: 'Identify security, privacy, and abuse risks and mitigations.',                roles: ['security'] },

  // — product management (phuryn/pm-skills — 68-skill marketplace; PM charter
  //   baselines were originally distilled from it) —
  { id: 'discovery',         name: 'Discovery',            description: 'Run product discovery — interviews, jobs-to-be-done, assumption mapping, opportunity solution trees.', roles: ['pm', 'ux_research'], source: 'https://github.com/phuryn/pm-skills' },
  { id: 'prioritization',    name: 'Prioritization',       description: 'Rank work with explicit frameworks (RICE, ICE, MoSCoW, Kano) and a clear rationale.', roles: ['pm'], source: 'https://github.com/phuryn/pm-skills' },
  { id: 'roadmap',           name: 'Roadmap planning',     description: 'Turn goals into a sequenced, outcome-oriented roadmap.',                      roles: ['pm'], source: 'https://github.com/phuryn/pm-skills' },
  { id: 'prd',               name: 'PRD authoring',        description: 'Write a crisp product requirements doc from a problem statement.',            roles: ['pm'], source: 'https://github.com/phuryn/pm-skills' },
  { id: 'user-stories',      name: 'User stories',         description: 'Split work into vertical, testable user stories (3 C’s, INVEST, job stories).', roles: ['pm'], source: 'https://github.com/phuryn/pm-skills' },
  { id: 'product-strategy',  name: 'Product strategy',     description: 'Strategy canvas, vision, value proposition, business model, SWOT/PESTLE/Five Forces.', roles: ['pm'], source: 'https://github.com/phuryn/pm-skills' },
  { id: 'market-research',   name: 'Market research',      description: 'Personas, segmentation, customer journey maps, TAM/SAM/SOM sizing, competitor analysis.', roles: ['pm', 'ux_research'], source: 'https://github.com/phuryn/pm-skills' },
  { id: 'go-to-market',      name: 'Go-to-market',         description: 'GTM strategy and motions, ideal customer profile, beachhead segment, growth loops, battlecards.', roles: ['pm', 'marketing'], source: 'https://github.com/phuryn/pm-skills' },
  { id: 'product-analytics', name: 'Product analytics',    description: 'North Star + input metrics, cohort and retention analysis, A/B test evaluation, SQL from questions.', roles: ['pm', 'data_sci'], source: 'https://github.com/phuryn/pm-skills' },
  { id: 'lean-startup',      name: 'Minimalist entrepreneur', description: 'Lean validation playbook — validate the idea, scope an MVP, win first customers, price it, grow sustainably.', roles: ['pm', 'marketing'], source: 'https://github.com/slavingia/skills' },
  { id: 'mental-models',     name: 'Mental models',        description: '249 decision frameworks with a selection protocol — frame the stakes, pick ONE fitting model, apply it interactively.', roles: ['pm'], source: 'https://github.com/machinarii/awesome-mental-models' },

  // — engineering process (obra/superpowers) —
  { id: 'writing-plans',     name: 'Writing plans',        description: 'Turn a goal into a step-by-step implementation plan.',                        roles: ['pm', 'sw_engineer'], source: 'https://github.com/obra/superpowers' },
  { id: 'brainstorming',     name: 'Brainstorming',        description: 'Socratic design refinement — explore intent, requirements, and alternatives before building.', roles: ['pm', 'designer', 'ux_research'], source: 'https://github.com/obra/superpowers' },
  { id: 'tdd',               name: 'Test-driven development', description: 'Write the failing test first, then the code to pass it.',                  roles: ['sw_engineer', 'qa'], source: 'https://github.com/obra/superpowers' },
  { id: 'systematic-debugging', name: 'Systematic debugging', description: 'Reproduce, isolate, hypothesize, fix, verify — works for code and hardware bring-up alike.', roles: ['sw_engineer', 'qa', 'hw_engineer'], source: 'https://github.com/obra/superpowers' },
  { id: 'code-review',       name: 'Code review',          description: 'Review changes for correctness, clarity, and maintainability.',               roles: ['sw_engineer', 'qa'], source: 'https://github.com/obra/superpowers' },
  { id: 'verification-before-completion', name: 'Verify before done', description: 'Run verification and show evidence before claiming work is complete.', roles: ['qa', 'sw_engineer'], source: 'https://github.com/obra/superpowers' },

  // — building & testing (anthropics/skills) —
  { id: 'mcp-builder',       name: 'MCP builder',          description: 'Build MCP servers that connect agents to external APIs and tools.',           roles: ['sw_engineer'], source: 'https://github.com/anthropics/skills' },
  { id: 'engineering-patterns', name: 'Engineering patterns', description: 'API design, backend/frontend architecture patterns, e2e testing, and build-test-lint verification loops.', roles: ['sw_engineer'], source: 'https://github.com/affaan-m/ECC' },
  { id: 'frontend-design',   name: 'Frontend design',      description: 'Distinctive, production-grade UI work that avoids generic AI aesthetics.',    roles: ['designer', 'sw_engineer'], source: 'https://github.com/anthropics/skills' },
  { id: 'canvas-design',     name: 'Canvas design',        description: 'Create visual art, posters, and graphics as PNG/PDF.',                        roles: ['designer'], source: 'https://github.com/anthropics/skills' },
  { id: 'impeccable',        name: 'Impeccable design',    description: 'Design-language toolkit — polish, audit, critique, animate, bolder/quieter commands that kill generic AI-slop frontend design.', roles: ['designer'], source: 'https://github.com/pbakaus/impeccable' },
  { id: 'awesome-design',    name: 'Design system inspirations', description: 'Ready-to-use DESIGN.md design systems by aesthetic family — drop one in and scaffold a full UI from exact design tokens.', roles: ['designer'], source: 'https://github.com/VoltAgent/awesome-claude-design' },
  { id: 'ui-ux-pro',         name: 'UI/UX Pro Max',        description: 'Design-system generator — 67 UI styles, 161 palettes, 57 font pairings, 99 UX guidelines, tailored per project across 15 stacks.', roles: ['designer'], source: 'https://github.com/nextlevelbuilder/ui-ux-pro-max-skill' },
  { id: 'web-motion-3d',     name: 'Web motion & 3D',      description: 'Interactive web experiences — Three.js/R3F, GSAP ScrollTrigger, spring physics, Lottie/Rive, and integration patterns.', roles: ['designer', 'sw_engineer'], source: 'https://github.com/freshtechbro/claudedesignskills' },
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

  // — security (trailofbits/skills, AgriciDaniel/claude-cybersecurity) —
  { id: 'security-analysis', name: 'Security static analysis', description: 'Hunt vulnerabilities with CodeQL, Semgrep, and differential code review playbooks.', roles: ['security'], source: 'https://github.com/trailofbits/skills' },
  { id: 'security-audit',    name: 'Cybersecurity code audit', description: 'Comprehensive security review — vulnerabilities, authorization, secrets, supply chain, IaC, and business-logic flaws, mapped to OWASP/CWE/ATT&CK.', roles: ['security'], source: 'https://github.com/AgriciDaniel/claude-cybersecurity' },

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

/** The ENABLED skills available to a role, for prompt injection. */
export function skillsForRole(roleId) {
  return listSkills().filter(s => s.enabled && s.roles.includes(roleId));
}

/* Task-trigger terms per skill (lowercase substrings; multi-word phrases ok).
 * Used by selectSkillsForTask to decide which skills a given task actually
 * calls for — the skill NAME always counts as an implicit trigger too.
 * Skills absent from this map only match on their name. */
const TASK_KEYWORDS = {
  'ux-flows':          ['flow', 'journey', 'wireframe', 'navigation', 'screens', 'onboarding'],
  'positioning':       ['positioning', 'messag', 'value prop', 'tagline', 'launch copy'],
  'threat-model':      ['threat', 'risk', 'abuse', 'privacy', 'attack surface'],
  'discovery':         ['interview', 'user research', 'jobs-to-be-done', 'jtbd', 'assumption', 'opportunit', 'validate'],
  'prioritization':    ['prioriti', 'rank', 'backlog', 'rice', 'moscow', 'kano', 'tradeoff', 'what first'],
  'roadmap':           ['roadmap', 'milestone', 'quarter', 'sequence', 'timeline'],
  'prd':               ['prd', 'requirement', 'spec', 'scope'],
  'user-stories':      ['user stor', 'stories', 'story', 'acceptance criteria', 'backlog'],
  'product-strategy':  ['strateg', 'vision', 'business model', 'swot', 'pestle', 'five forces', 'value proposition'],
  'market-research':   ['market', 'persona', 'segment', 'competitor', 'tam', 'journey map', 'sizing'],
  'go-to-market':      ['launch', 'gtm', 'go-to-market', 'icp', 'growth loop', 'channel', 'customer profile', 'battlecard'],
  'product-analytics': ['metric', 'north star', 'cohort', 'retention', 'a/b', 'ab test', 'funnel', 'sql', 'analytics'],
  'lean-startup':      ['mvp', 'validate', 'first customer', 'pricing', 'bootstrap', 'startup'],
  'mental-models':     ['decide', 'decision', 'tradeoff', 'stuck', 'think through', 'framework', 'weigh'],
  'writing-plans':     ['plan', 'breakdown', 'steps', 'sequence the work'],
  'brainstorming':     ['brainstorm', 'idea', 'explore', 'direction', 'options', 'before building'],
  'tdd':               ['test', 'tdd', 'implement', 'fix', 'bug', 'feature', 'code', 'build'],
  'systematic-debugging': ['debug', 'bug', 'broken', 'fail', 'crash', 'error', 'not working', 'regression', 'bring-up', 'flaky'],
  'code-review':       ['review', 'pull request', ' pr ', 'diff', 'code quality', 'refactor'],
  'verification-before-completion': ['verify', 'done', 'complete', 'finished', 'ship', 'confirm', 'works'],
  'mcp-builder':       ['mcp', 'integration', 'connector', 'tool server', 'external api'],
  'engineering-patterns': ['api', 'backend', 'frontend', 'architecture', 'database', 'cache', 'endpoint', 'e2e', 'schema'],
  'frontend-design':   ['ui', 'interface', 'frontend', 'page', 'component', 'landing', 'web design', 'screen'],
  'canvas-design':     ['poster', 'art', 'graphic', 'visual', 'banner', 'illustration'],
  'impeccable':        ['polish', 'audit', 'critique', 'animate', 'refine', 'spacing', 'design pass', 'slop'],
  'awesome-design':    ['design system', 'token', 'design.md', 'aesthetic', 'scaffold'],
  'ui-ux-pro':         ['design system', 'palette', 'font', 'ux', 'style guide', 'color', 'theme'],
  'web-motion-3d':     ['3d', 'three.js', 'webgl', 'animation', 'motion', 'scroll', 'lottie', 'parallax', 'interactive'],
  'webapp-testing':    ['test', 'e2e', 'playwright', 'browser', 'regression', 'click through', 'automation'],
  'doc-coauthoring':   ['draft', 'document', 'doc', 'write up', 'co-author', 'memo'],
  'docx':              ['word', 'docx', 'contract', 'redline', 'tracked changes', 'agreement'],
  'pdf':               ['pdf', 'form', 'extract'],
  'pptx':              ['deck', 'slide', 'presentation', 'powerpoint', 'pitch'],
  'internal-comms':    ['status report', 'newsletter', 'faq', 'announcement', 'update the team'],
  'brand-guidelines':  ['brand', 'typography', 'voice', 'logo', 'identity'],
  'xlsx':              ['spreadsheet', 'excel', 'xlsx', 'formula', 'pivot', 'csv', 'table'],
  'd3-visualization':  ['chart', 'visualiz', 'graph', 'd3', 'plot', 'dashboard'],
  'security-analysis': ['vulnerab', 'codeql', 'semgrep', 'static analysis', 'cve', 'exploit'],
  'security-audit':    ['audit', 'vulnerab', 'secret', 'supply chain', 'owasp', 'authoriz', 'security review', 'pentest'],
  'kicad':             ['pcb', 'schematic', 'kicad', 'circuit', 'board', 'layout', 'footprint', 'gerber', 'bom', 'emc', 'spice', 'power tree'],
};

function skillScore(skill, t) {
  let score = 0;
  for (const kw of TASK_KEYWORDS[skill.id] || []) if (t.includes(kw)) score++;
  if (t.includes(skill.name.toLowerCase())) score += 2;
  return score;
}

/** Task-aware selection: the role's enabled skills, plus which of them the
 * given task text actually triggers (sorted by keyword-hit count, registry
 * order as tiebreak). Empty/missing text → no matches, just the full list. */
export function selectSkillsForTask(roleId, text) {
  const all = skillsForRole(roleId);
  const t = String(text || '').toLowerCase();
  if (!t) return { matched: [], all };
  const matched = all
    .map((s, i) => ({ s, i, score: skillScore(s, t) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(x => x.s);
  return { matched, all };
}

/** The skill's vendored condensed playbook (skill-playbooks/<id>.md), or null
 * when none ships — callers fall back to the one-line description. */
export function loadSkillPlaybook(id) {
  const path = resolve(PLAYBOOKS_DIR, `${id}.md`);
  if (!existsSync(path)) return null;
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}
