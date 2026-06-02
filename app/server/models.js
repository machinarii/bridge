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

/* Model for cheap classification work (team-voice routing). Set
 * OPENROUTER_ROUTER_MODEL to a fast/cheap model to cut latency + cost;
 * defaults to the normal model so behavior is unchanged until configured. */
export function getRouterModel() {
  return process.env.OPENROUTER_ROUTER_MODEL || getDefaultModel();
}
