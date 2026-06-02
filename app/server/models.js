/* Resolve which OpenRouter model to use for a given role. Reads from
 * process.env so settings changes via PUT /settings take effect
 * immediately. */

const DEFAULT_MODEL = 'anthropic/claude-opus-4.7';

export function getDefaultModel() {
  return process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
}

export function getModelForRole(roleId) {
  try {
    const map = JSON.parse(process.env.OPENROUTER_MODEL_BY_ROLE || '{}');
    if (roleId && typeof map[roleId] === 'string' && map[roleId]) return map[roleId];
  } catch {}
  return getDefaultModel();
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
