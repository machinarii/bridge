/* Bridge — project-scoped markdown notes. One file per note under
 * <repo>/docs/ (the project's git repo). */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { docsDir } from '../projects.js';

function notesDir(projectId) {
  // Planning docs live in the project repo's docs/ dir (the single home).
  const dir = docsDir(projectId);
  if (!dir) throw new Error(`no repo for project ${projectId}`);
  return dir;   // docsDir already mkdir-p's it
}

function deriveLabel(body) {
  const firstLine = String(body).split('\n')[0].trim();
  return firstLine.slice(0, 60) || 'note';
}

export function listNotes(projectId) {
  const dir = notesDir(projectId);
  return readdirSync(dir)
    .filter(f => f.endsWith('.md') && f !== 'project.md')
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
