/* Per-project learnings store.
 *
 * An append-only JSONL of compact, durable insights the team accumulates about
 * a project — decisions made, pitfalls hit, conventions adopted, user
 * preferences — deduped latest-write-wins by key. The confident ones are
 * injected into every agent's system prompt (see orchestrator.js) so the team
 * stops re-deriving settled facts and re-discovering the same bugs each session.
 *
 * Storage lives under the resolved state dir (BRIDGE_STATE_DIR in tests), one
 * file per project: <stateDir>/learnings/<projectId>.jsonl.
 *
 * API:
 *   addLearning(projectId, { insight, type?, confidence?, role?, source?, files?, ts? }) → record|null
 *   getLearnings(projectId, { role?, minConfidence?, limit? })                            → record[]
 *   learningsBlock(projectId, role)  → prompt block string ('' when none qualify)
 *   clearLearnings(projectId)        → void  (on project create/delete, like the scratchpad)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, ensureStateDir } from './state-dir.js';

const TYPES = new Set(['decision', 'pitfall', 'convention', 'preference', 'fact']);
const MIN_INJECT_CONFIDENCE = 7;  // only well-supported learnings reach prompts
const MAX_INJECT = 10;            // cap injected learnings so the prompt stays lean
const COMPACT_AT = 200;           // rewrite (dedupe) the file once it grows past this

function dir() { return join(stateDir(), 'learnings'); }
function slug(id) { return String(id || '').replace(/[^a-zA-Z0-9_.-]/g, '_') || 'unknown'; }
function file(projectId) { return join(dir(), `${slug(projectId)}.jsonl`); }

function clampConfidence(c) {
  const n = Number(c);
  return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : 5;
}

/** Dedup key: an explicit key, else a normalized prefix of the insight. */
function keyOf(l) {
  const explicit = l.key && String(l.key).trim();
  if (explicit) return explicit.toLowerCase();
  return String(l.insight || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}

function readAll(projectId) {
  const f = file(projectId);
  if (!existsSync(f)) return [];
  const out = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip malformed line */ }
  }
  return out;
}

/** File order is chronological, so the LAST record for a key wins. */
function dedupe(records) {
  const byKey = new Map();
  for (const l of records) byKey.set(l.key, l);
  return [...byKey.values()];
}

function maybeCompact(projectId) {
  const all = readAll(projectId);
  if (all.length <= COMPACT_AT) return;
  writeFileSync(file(projectId), dedupe(all).map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

/** Record (or update) a learning. Returns the stored record, or null if empty. */
export function addLearning(projectId, learning = {}) {
  if (!projectId) return null;
  const insight = String(learning.insight || '').trim();
  if (!insight) return null;
  const rec = {
    key: keyOf({ key: learning.key, insight }),
    type: TYPES.has(learning.type) ? learning.type : 'fact',
    insight,
    confidence: clampConfidence(learning.confidence),
    role: learning.role ? String(learning.role) : null,   // null = applies to all roles
    source: learning.source ? String(learning.source) : null,
    files: Array.isArray(learning.files) ? learning.files.slice(0, 8).map(String) : [],
    ts: Number(learning.ts) || Date.now(),
  };
  ensureStateDir();
  mkdirSync(dir(), { recursive: true });
  appendFileSync(file(projectId), JSON.stringify(rec) + '\n', 'utf8');
  maybeCompact(projectId);
  return rec;
}

/** Deduped learnings, most-relevant first (confidence, then recency). */
export function getLearnings(projectId, { role = null, minConfidence = 0, limit = Infinity } = {}) {
  let list = dedupe(readAll(projectId)).filter(l => (l.confidence ?? 0) >= minConfidence);
  // A learning with no role is global; a role-scoped one only shows for that role.
  if (role) list = list.filter(l => !l.role || l.role === role);
  list.sort((a, b) => (b.confidence - a.confidence) || (b.ts - a.ts));
  return Number.isFinite(limit) ? list.slice(0, limit) : list;
}

/** The `## Project learnings` block injected into an agent's system prompt. */
export function learningsBlock(projectId, role) {
  const list = getLearnings(projectId, { role, minConfidence: MIN_INJECT_CONFIDENCE, limit: MAX_INJECT });
  if (!list.length) return '';
  const lines = list.map(l => `- [${l.type}] ${l.insight}`).join('\n');
  return `\nProject learnings — durable facts/decisions the team has already established. ` +
    `Honor them; don't re-litigate or re-derive them:\n${lines}\n`;
}

/** Wipe a project's learnings (project create/delete — mirrors the scratchpad). */
export function clearLearnings(projectId) {
  const f = file(projectId);
  if (existsSync(f)) { try { writeFileSync(f, '', 'utf8'); } catch { /* best effort */ } }
}
