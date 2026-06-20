/* Resolve which OpenRouter model to use for a given role. Reads from
 * process.env so settings changes via PUT /settings take effect
 * immediately. */

const DEFAULT_MODEL = 'anthropic/claude-opus-4.8';

export function getDefaultModel() {
  return process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
}

/* Per-role model tiering (ON by default — set OPENROUTER_TIERS=off to disable).
 * Each role gets a tier-assigned model out of the box: 'reason' roles do
 * open-ended strategy/judgment and ride the flagship default; 'craft' roles
 * execute well-scoped production work where a faster, cheaper model holds
 * quality. Cuts cost/latency on the bulk of turns without touching the
 * high-stakes reasoning paths. Any explicit per-role override still wins. */
const CRAFT_MODEL_DEFAULT = 'anthropic/claude-sonnet-4.6';
const ROLE_TIER = {
  pm: 'reason', security: 'reason', legal: 'reason', data_sci: 'reason', ux_research: 'reason',
  sw_engineer: 'craft', hw_engineer: 'craft', ee_engineer: 'craft',
  designer: 'craft', qa: 'craft', copywriter: 'craft', marketing: 'craft',
};

export function tiersEnabled() { return (process.env.OPENROUTER_TIERS || 'on') !== 'off'; }

function tierModel(tier) {
  if (tier === 'craft') return process.env.OPENROUTER_CRAFT_MODEL || CRAFT_MODEL_DEFAULT;
  return getDefaultModel();   // 'reason' → the flagship default (opus-4.8)
}

/* The model a role uses WITHOUT an explicit override — i.e. its tier-assigned
 * model (or the flat default when tiering is off / the role isn't tiered). This
 * is what "use default" resolves to, surfaced in the Settings UI. */
export function defaultModelForRole(roleId) {
  if (tiersEnabled() && ROLE_TIER[roleId]) return tierModel(ROLE_TIER[roleId]);
  return getDefaultModel();
}

export function getModelForRole(roleId) {
  try {
    const map = JSON.parse(process.env.OPENROUTER_MODEL_BY_ROLE || '{}');
    if (roleId && typeof map[roleId] === 'string' && map[roleId]) return map[roleId];
  } catch {}
  return defaultModelForRole(roleId);
}

/* Default model for team-voice routing (cheap classification). Chosen for
 * privacy (Anthropic doesn't train on API data; same provider as the app's
 * default model — one trust boundary), price (cheapest Anthropic tier; routing
 * calls are tiny), and adequacy (more than enough for picking agents/tasks). */
export const ROUTER_DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';

/* Model for cheap classification work (team-voice routing). Override with
 * OPENROUTER_ROUTER_MODEL; otherwise the fast default above. */
export function getRouterModel() {
  return process.env.OPENROUTER_ROUTER_MODEL || ROUTER_DEFAULT_MODEL;
}
