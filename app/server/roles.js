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

/* Large shared fallback pool. When a role's short namePool is exhausted (lots
 * of projects), pickName draws a fresh, distinct name from here instead of
 * suffixing a number ("Cassidy 2"). */
export const FALLBACK_NAMES = [
  'Avery','Riley','Jordan','Sawyer','Emerson','Rowan','Finley','Hayden','Parker','Reagan',
  'Tatum','Blake','Drew','Elliot','Skyler','Phoenix','River','Sterling','Ellis','Camden',
  'Lennon','Monroe','Beckett','Sloane','Arlo','Bodhi','Dakota','Easton','Frankie','Greer',
  'Harlow','Indie','Jules','Lane','Oakley','Paxton','Quincy','Remy','Shay','Teagan',
  'Vesper','Weston','Zane','Ari','Bex','Cleo','Esme','Flynn','Gray','Hale',
  'Joss','Knox','Lux','Mace','Nyx','Orin','Reed','Sol','Tate','Uma',
  'Vale','Wynn','Zev','Anders','Bram','Coral','Dane','Eden','Gio','Hana',
  'Ivo','Juna','Keo','Liv','Nico','Orla','Piers','Suri','Tomas','Una',
  'Vivi','Wade','Yara','Zola','Alba','Cass','Dex','Eira','Faye','Gil',
  'Hugo','Isa','Kit','Lior','Maxine','Nell','Odin','Pia','Rune','Thea',
  'Vero','Wells','Yuki','Zara','Adair','Bay','Cy','Dove','Ezra','Fable',
  'Gem','Hollis','Ines','Jae','Kira','Loy','Marlo','Nova','Otis','Perry',
  'Rory','Soren','Tova','Umi','Vance','Wilder','Xander','Yves','Zinnia','Bellamy',
  'Calla','Dashiell','Emery','Fox','Grover','Halcyon','Isadora','Jorah','Keaton','Lumen',
];
