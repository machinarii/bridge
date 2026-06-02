/* Bridge — 14-role catalog. The single source of truth for which roles can
 * appear on a project and what their default name pool, color, and persona
 * seed are. Name pools are short (4 each) because no project picks the same
 * role twice. */

export const ROLES = [
  { id: 'pm',          label: 'Product Manager',  color: '#ffb86b',
    namePool: ['Cassidy','Marlowe','Quinn','Linden'],
    personaSeed: 'organizing, strategic' },
  { id: 'sw_engineer', label: 'Software Engineer', color: '#6ea8ff',
    namePool: ['Kade','Reese','Forge','Birch'],
    personaSeed: 'builder, precise' },
  { id: 'hw_engineer', label: 'Hardware Engineer', color: '#5ec8d8',
    namePool: ['Watt','Volta','Joule','Dynamo'],
    personaSeed: 'hands-on, systems-minded' },
  { id: 'designer',    label: 'Designer',         color: '#c08bff',
    namePool: ['Iris','Mira','Cove','Juno'],
    personaSeed: 'visual, intuitive' },
  { id: 'qa',          label: 'QA',               color: '#ffd35a',
    namePool: ['Audrey','Tess','Roan','Vail'],
    personaSeed: 'methodical, sharp' },
  { id: 'data_sci',    label: 'Data Scientist',   color: '#9cf2c1',
    namePool: ['Theo','Nori','Banks','Soren'],
    personaSeed: 'analytical' },
  { id: 'security',    label: 'Security',         color: '#ff7b86',
    namePool: ['Sentry','Cyrus','Onyx','Vault'],
    personaSeed: 'vigilant' },
  { id: 'ux_research', label: 'Researcher',       color: '#bda4ff',
    namePool: ['Wren','Story','Iona','Sable'],
    personaSeed: 'curious' },
  { id: 'copywriter',  label: 'Copywriter',       color: '#e0c98a',
    namePool: ['Quill','Proser','Hadley','Mark'],
    personaSeed: 'clarifying' },
  { id: 'marketing',   label: 'Marketing',        color: '#ffa1b8',
    namePool: ['Brio','Lark','Verve','Echo'],
    personaSeed: 'energetic' },
  { id: 'legal',       label: 'Legal',            color: '#a0b8d0',
    namePool: ['Hollis','Brennan','Sterling','Marsh'],
    personaSeed: 'thorough, risk-aware' },
];

const BY_ID = Object.fromEntries(ROLES.map(r => [r.id, r]));

export function listRoles() { return ROLES.slice(); }
export function getRole(id) { return BY_ID[id] || null; }
