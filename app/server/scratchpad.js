/* Tiny per-agent context store. JSON file on disk; one record per agent.
 * Each record holds: messages (the running conversation), lastSpec (the last
 * tile spec rendered for that agent), and a freeform `notes` blob agents can
 * write into.
 *
 * API:
 *   getContext(agentId)             → record (creates empty if absent)
 *   appendTurn(agentId, role, text, extra?) → record (history-trimmed; extra
 *                                     fields like { author } merge onto the turn)
 *   setLastSpec(agentId, spec)      → record
 *   writeNotes(agentId, patch)      → record (shallow-merge into notes)
 *   reset(agentId)                  → record
 *   all()                           → { [agentId]: record }
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname);
const DATA_DIR = resolve(SERVER_ROOT, '..', 'state');
const FILE = join(DATA_DIR, 'scratchpad.json');

const HISTORY_TURN_LIMIT = 24; // keep the last N turns per agent

let cache = null;

function load() {
  if (cache) return cache;
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(FILE)) {
    try { cache = JSON.parse(readFileSync(FILE, 'utf8')); }
    catch { cache = {}; }
  } else cache = {};
  return cache;
}

function save() {
  if (!cache) return;
  writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf8');
}

function record(agentId) {
  const data = load();
  if (!data[agentId]) {
    data[agentId] = { messages: [], lastSpec: null, notes: {}, updatedAt: Date.now() };
  }
  return data[agentId];
}

export function getContext(agentId) { return record(agentId); }

/** Most recent updatedAt across the given agent ids. Returns null if
 *  none of those agents have a scratchpad record yet (i.e. no
 *  activity since project creation). */
export function lastActivityAt(agentIds) {
  const data = load();
  let max = 0;
  for (const id of agentIds || []) {
    const r = data[id];
    if (r?.updatedAt && r.updatedAt > max) max = r.updatedAt;
  }
  return max || null;
}

export function appendTurn(agentId, role, content, extra = {}) {
  const r = record(agentId);
  r.messages.push({ role, content, at: Date.now(), ...extra });
  if (r.messages.length > HISTORY_TURN_LIMIT) {
    r.messages = r.messages.slice(-HISTORY_TURN_LIMIT);
  }
  r.updatedAt = Date.now();
  save();
  return r;
}

/* Drop messages from `index` onward (keep messages[0..index-1]). Used by the
 * "redo" affordance to remove a prompt + its response before regenerating. */
export function truncateFrom(agentId, index) {
  const r = record(agentId);
  if (index < 0 || index >= r.messages.length) return r;
  r.messages = r.messages.slice(0, index);
  r.updatedAt = Date.now();
  save();
  return r;
}

export function setLastSpec(agentId, spec) {
  const r = record(agentId);
  r.lastSpec = spec;
  r.updatedAt = Date.now();
  save();
  return r;
}

export function writeNotes(agentId, patch) {
  const r = record(agentId);
  r.notes = { ...r.notes, ...patch };
  r.updatedAt = Date.now();
  save();
  return r;
}

export function reset(agentId) {
  const data = load();
  data[agentId] = { messages: [], lastSpec: null, notes: {}, updatedAt: Date.now() };
  save();
  return data[agentId];
}

export function all() { return { ...load() }; }

const LEGACY_KEYS = new Set(['nova','atlas','sage','echo','vesper','halo','lyra','ember']);

/** Wipe legacy 8-agent records on first boot under the new schema. */
export function migrateLegacyOnce() {
  const data = load();
  let touched = false;
  for (const key of Object.keys(data)) {
    if (LEGACY_KEYS.has(key)) { delete data[key]; touched = true; }
  }
  if (touched) {
    cache = data;
    save();
    console.log('[migrate] wiped legacy scratchpad keys');
  }
}
