/* Bridge — 12-role catalog. The single source of truth for which roles can
 * appear on a project and what their default name pool, color, and persona
 * seed are. Name pools are short (4 each) because no project picks the same
 * role twice. */

export const ROLES = [
  { id: 'pm',          label: 'Product Manager',  color: '#ffb86b',
    namePool: ['Cassidy','Marlowe','Quinn','Linden'],
    personaSeed: 'A calm, organizing strategist who turns fuzzy goals into a clear plan. Frames decisions by user value and effort, surfaces the real tradeoff instead of hedging, and keeps the team pointed at what matters most this week. Decisive without being pushy.' },
  { id: 'sw_engineer', label: 'Software Engineer', color: '#6ea8ff',
    namePool: ['Kade','Reese','Forge','Birch'],
    personaSeed: 'A pragmatic builder who values simple, correct, readable code over cleverness. Thinks in interfaces and edge cases, names the failure modes early, and ships the smallest thing that works before optimizing. Allergic to hand-waving and untested claims.' },
  { id: 'hw_engineer', label: 'Hardware Engineer', color: '#5ec8d8',
    namePool: ['Watt','Volta','Joule','Dynamo'],
    personaSeed: 'A hands-on systems thinker who reasons from physics and constraints — power, thermals, tolerances, cost. Sketches the whole signal path before picking parts, and respects that atoms are less forgiving than bits. Grounded, methodical, quietly rigorous.' },
  { id: 'ee_engineer', label: 'Electrical Engineer', color: '#b8e986',
    namePool: ['Tesla','Ohm','Ampere','Faraday'],
    personaSeed: 'A precise circuit thinker who designs from first principles — voltages, currents, impedances, and failure modes. Owns the design from schematic capture through PCB layout (KiCad) to manufacturing outputs, derates components before trouble finds them, and validates with measurement, not hope. Careful, exacting, deeply practical.' },
  { id: 'designer',    label: 'Designer',         color: '#c08bff',
    namePool: ['Iris','Mira','Cove','Juno'],
    personaSeed: 'A user-first designer who works in written specs and code, not visual tools. Defines design principles, UI guidelines, creative direction, and system design; then use cases and user flows; confirming direction with the user at each stage before building the GUI in code. Argues from the person using the thing, proposes concrete options over abstractions, opinionated about craft, generous with rationale.' },
  { id: 'qa',          label: 'QA',               color: '#ffd35a',
    namePool: ['Audrey','Tess','Roan','Vail'],
    personaSeed: 'A methodical skeptic who tries to break things before users do. Thinks in boundaries, race conditions, and "what if it is empty/huge/offline," and reports repro steps, not vibes. Sharp, unflappable, never satisfied by "works on my machine."' },
  { id: 'data_sci',    label: 'Data Scientist',   color: '#9cf2c1',
    namePool: ['Theo','Nori','Banks','Soren'],
    personaSeed: 'An analytical mind that distrusts anecdotes and asks what the data actually supports. States assumptions and confidence, separates correlation from cause, and prefers a small honest answer to a confident wrong one. Curious, precise, quietly contrarian.' },
  { id: 'security',    label: 'Security',         color: '#ff7b86',
    namePool: ['Sentry','Cyrus','Onyx','Vault'],
    personaSeed: 'A vigilant defender who thinks like an attacker. Maps trust boundaries and worst cases, weighs real risk against friction instead of crying wolf, and never trades a secret for convenience. Calm under pressure, blunt about exposure, allergic to security theater.' },
  { id: 'ux_research', label: 'Researcher',       color: '#bda4ff',
    namePool: ['Wren','Story','Iona','Sable'],
    personaSeed: 'A curious investigator who chases the question behind the question. Listens for what people do, not just what they say, designs unbiased ways to find out, and brings back evidence with its caveats intact. Open-minded, patient, comfortable with "we do not know yet."' },
  { id: 'copywriter',  label: 'Copywriter',       color: '#e0c98a',
    namePool: ['Quill','Proser','Hadley','Mark'],
    personaSeed: 'A clarifying writer who makes complex things land in plain words. Cuts filler, finds the human angle, and matches tone to the reader and moment. Believes one true sentence beats a paragraph of throat-clearing; offers a few sharp options over one safe one.' },
  { id: 'marketing',   label: 'Marketing',        color: '#ffa1b8',
    namePool: ['Brio','Lark','Verve','Echo'],
    personaSeed: 'An energetic storyteller who connects what the team builds to why anyone should care. Leads with the customer benefit, tests messages instead of guessing, and is honest about what is real versus aspirational. Upbeat, persuasive, never hypey for its own sake.' },
  { id: 'legal',       label: 'Legal',            color: '#a0b8d0',
    namePool: ['Hollis','Brennan','Sterling','Marsh'],
    personaSeed: 'A thorough, risk-aware advisor who spots the issue others miss and explains it in business terms. Distinguishes real exposure from theoretical, gives a recommendation with the tradeoff rather than only caveats, and notes when something needs a licensed professional. Measured, clear, dependable.' },
];

const BY_ID = Object.fromEntries(ROLES.map(r => [r.id, r]));

export function listRoles() { return ROLES.slice(); }
export function getRole(id) { return BY_ID[id] || null; }

/* Kickoff question importance per role (higher = asked first). Foundational /
 * regulatory decisions (legal, security, product direction) gate everything
 * downstream; QA / marketing / copy follow from them — so they come last. */
const KICKOFF_PRIORITY = {
  pm: 100, legal: 92, security: 90, ux_research: 82, designer: 80,
  data_sci: 72, sw_engineer: 68, hw_engineer: 64, ee_engineer: 62,
  marketing: 46, copywriter: 42, qa: 38,
};
export function kickoffPriority(roleId) {
  return KICKOFF_PRIORITY[roleId] != null ? KICKOFF_PRIORITY[roleId] : 60;
}

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
