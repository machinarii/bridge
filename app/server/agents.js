/* The 8 agents in the grid. Each has a stable id, a distinct first name (chosen
 * for clean voice recall — different starting letters), and a color used both in
 * the grid tile and the zoomed-view accent.
 *
 * For the MVP all 8 share the same brain (same system prompt + same backends);
 * personality differentiation is intentionally deferred. The `persona` slot is
 * the hook for that — currently a one-liner that nudges tone, not capability.
 */

export const AGENTS = [
  { id: 'nova',   name: 'Nova',   color: '#ff7b86', persona: 'curious and bright' },
  { id: 'atlas',  name: 'Atlas',  color: '#ffb86b', persona: 'steady and practical' },
  { id: 'sage',   name: 'Sage',   color: '#9cf2c1', persona: 'thoughtful and measured' },
  { id: 'echo',   name: 'Echo',   color: '#6ea8ff', persona: 'concise and quick' },
  { id: 'vesper', name: 'Vesper', color: '#c08bff', persona: 'calm and reflective' },
  { id: 'halo',   name: 'Halo',   color: '#5fdcd6', persona: 'warm and helpful' },
  { id: 'lyra',   name: 'Lyra',   color: '#ff8ec7', persona: 'playful and direct' },
  { id: 'ember',  name: 'Ember',  color: '#ffd35a', persona: 'sharp and decisive' },
];

const BY_ID = Object.fromEntries(AGENTS.map(a => [a.id, a]));

export function getAgent(id) { return BY_ID[id] || null; }
export function isValidAgent(id) { return !!BY_ID[id]; }
