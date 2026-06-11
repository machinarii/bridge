/* Bridge — the on-disk project repo. Resolves <BRIDGE_PROJECTS_BASE>/<slug>/
 * (default ~/bridge-projects/<slug>/), git-inits it, writes files (path-safe),
 * and commits. No model calls live here. */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute, relative } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

/** Base dir for all project repos. Env override, with leading-~ expansion. */
export function projectsBase() {
  const raw = process.env.BRIDGE_PROJECTS_BASE || join(homedir(), 'bridge-projects');
  if (raw === '~') return homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2));
  return resolve(raw);
}

/** Filesystem-safe slug from a project's display name. */
export function slugifyName(name) {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';
}

/** A unique repo path for a new project, deduping name collisions (-2, -3…). */
export function resolveRepoPath(name) {
  const base = projectsBase();
  const slug = slugifyName(name);
  let candidate = join(base, slug);
  let n = 2;
  while (existsSync(candidate)) candidate = join(base, `${slug}-${n++}`);
  return candidate;
}

/** Create the repo dir and `git init` it on first use. Idempotent. */
export function ensureRepo(repoPath) {
  mkdirSync(repoPath, { recursive: true });
  if (!existsSync(join(repoPath, '.git'))) {
    execFileSync('git', ['init', '-q'], { cwd: repoPath });
  }
  return repoPath;
}

/** Write [{path, contents}] under repoPath. Rejects absolute paths and any
 * path that escapes the repo. Creates parent dirs. Returns count written. */
export function writeFiles(repoPath, files) {
  for (const f of files) {
    const rel = String(f.path ?? '');
    if (!rel || isAbsolute(rel) || rel.split(/[/\\]/).includes('..')) {
      throw new Error(`unsafe path: ${rel}`);
    }
    const abs = resolve(repoPath, rel);
    const back = relative(repoPath, abs);
    if (back === '' || back.startsWith('..') || isAbsolute(back)) {
      throw new Error(`path escapes repo: ${rel}`);
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.contents ?? '', 'utf8');
  }
  return files.length;
}

/** Stage everything and commit. Uses an inline identity so commits work even
 * with no global git user configured (headless / CI). Returns the short SHA. */
export function commitAll(repoPath, message) {
  execFileSync('git', ['add', '-A'], { cwd: repoPath });
  execFileSync('git', [
    '-c', 'user.name=Bridge', '-c', 'user.email=bridge@local',
    'commit', '-q', '-m', message,
  ], { cwd: repoPath });
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoPath }).toString().trim();
}

/** Commit only if the working tree has changes. Returns the short SHA, or null
 * when there was nothing to commit — so callers can persist docs idempotently
 * without a "nothing to commit" failure. */
export function commitIfChanged(repoPath, message) {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoPath }).toString().trim();
  if (!status) return null;
  return commitAll(repoPath, message);
}
