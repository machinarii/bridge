import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Anchor relative paths to app/server/ (one level above this file's backends/ dir),
// so NOTES_DIR=../notes resolves to app/notes regardless of where node was launched.
const SERVER_ROOT = resolve(__dirname, '..');

function notesDir() {
  const configured = process.env.NOTES_DIR || '../notes';
  const dir = resolve(SERVER_ROOT, configured);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function listNotes() {
  const dir = notesDir();
  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  const items = files.map(f => {
    const full = join(dir, f);
    const stat = statSync(full);
    const firstLine = readFileSync(full, 'utf8').split('\n').find(l => l.trim()) || f.replace(/\.md$/, '');
    return {
      id: f.replace(/\.md$/, ''),
      label: firstLine.slice(0, 80),
      mtime: stat.mtimeMs,
    };
  });
  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}

export function readNote(id) {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return null;
  const full = join(notesDir(), `${safe}.md`);
  try {
    return readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

export function appendNote(body) {
  const dir = notesDir();
  const now = new Date();
  const id = now.toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const full = join(dir, `${id}.md`);
  writeFileSync(full, body + '\n', 'utf8');
  return { id, body, savedAt: now.toISOString() };
}
