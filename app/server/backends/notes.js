/* Bridge — project-scoped markdown notes. One file per note under
 * app/state/<projectId>/notes/. */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, '..', '..', 'state');

function notesDir(projectId) {
  const dir = resolve(STATE_DIR, projectId, 'notes');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function deriveLabel(body) {
  const firstLine = String(body).split('\n')[0].trim();
  return firstLine.slice(0, 60) || 'note';
}

export function listNotes(projectId) {
  const dir = notesDir(projectId);
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse()
    .map(f => {
      const body = readFileSync(join(dir, f), 'utf8');
      return { id: f.replace(/\.md$/, ''), label: deriveLabel(body) };
    });
}

export function readNote(projectId, id) {
  const path = join(notesDir(projectId), `${id}.md`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

export function appendNote(projectId, body) {
  // Timestamp prefix keeps IDs lexicographically time-ordered (listNotes sorts
  // by filename); the random suffix avoids same-millisecond collisions without
  // a process-local counter that resets across restarts.
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
  writeFileSync(join(notesDir(projectId), `${id}.md`), body, 'utf8');
  return { id, label: deriveLabel(body) };
}

/* Write (or overwrite) a note with a stable, human-readable filename — used by
 * the kickoff so docs land as PRD.md, milestones.md, … instead of timestamps. */
export function writeNote(projectId, name, body) {
  const id = String(name).replace(/\.md$/i, '').replace(/[^a-z0-9._-]/gi, '-').replace(/^-+|-+$/g, '') || 'note';
  writeFileSync(join(notesDir(projectId), `${id}.md`), body, 'utf8');
  return { id, label: deriveLabel(body) };
}
