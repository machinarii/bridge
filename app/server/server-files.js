/* File-explorer data for a project, sourced from its repo. The repo root is
 * project.repoPath; planning docs live under docs/ (project.md, *.md, roles/).
 * Paths are returned relative to the repo root so the viewer can read them back. */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { getProject, ensureRepoPath } from './projects.js';
import { charterFileNameFor } from './charters.js';

export function buildFileTree(pid) {
  const p = getProject(pid);
  if (!p) return null;
  const repo = ensureRepoPath(pid);
  const docs = resolve(repo, 'docs');
  const rolesDir = resolve(docs, 'roles');
  const entry = (abs, kind, extra = {}) => ({ path: relative(repo, abs), kind, mtime: statSync(abs).mtimeMs, ...extra });
  const charters = existsSync(rolesDir)
    ? readdirSync(rolesDir).filter(f => f.endsWith('.md')).map(f => {
        const agent = p.agents.find(a => charterFileNameFor(a.role) === f);
        return entry(resolve(rolesDir, f), 'charter', { roleId: agent?.role || null, agentName: agent?.name || '' });
      }).filter(c => c.roleId)
    : [];
  // Top-level docs (PRD, milestones, …) — .md directly under docs/, excluding
  // project.md. Specialist plans live inside the role files (roles/ section),
  // not as separate plan-*.md, so there's no Plans group.
  const notes = existsSync(docs)
    ? readdirSync(docs).filter(f => f.endsWith('.md') && f !== 'project.md')
        .sort().reverse().map(f => entry(resolve(docs, f), 'note'))
    : [];
  // project.md is legacy (new projects seed PRD.md instead); show it only if present.
  const projectMd = existsSync(resolve(docs, 'project.md')) ? 'docs/project.md' : null;
  return { projectMd, charters, notes };
}

export function readProjectFile(pid, rel) {
  if (typeof rel !== 'string' || rel.includes('..') || isAbsolute(rel)) throw new Error('bad path');
  const repo = ensureRepoPath(pid);
  const abs = resolve(repo, rel);
  if (relative(repo, abs).startsWith('..')) throw new Error('bad path');
  if (!existsSync(abs)) throw new Error('not found');
  return readFileSync(abs, 'utf8');
}
