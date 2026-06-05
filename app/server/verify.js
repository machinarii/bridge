// app/server/verify.js
/* Phase B verify: run install/build/test in a sandbox container and report
 * which step failed. Pure logic + an injected `runner` (default B1's
 * runInContainer) so it is unit-tested without Docker. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getProject, ensureRepoPath } from './projects.js';
import { runInContainer } from './sandbox.js';

/** The repo's package.json `scripts`, or null if there's no package.json. */
function pkgScripts(repoPath) {
  const f = resolve(repoPath, 'package.json');
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')).scripts || {}; } catch { return {}; }
}

/** Compose one shell script: install → (build) → (test), with @@STEP markers so
 * the failing step is identifiable from the combined output. */
export function verifyScript(scripts) {
  const steps = [{ name: 'install', cmd: 'npm install --no-audit --no-fund' }];
  if (scripts?.build) steps.push({ name: 'build', cmd: 'npm run build' });
  if (scripts?.test) steps.push({ name: 'test', cmd: 'npm test' });
  return steps.map(s => `echo "@@STEP ${s.name}" && ${s.cmd}`).join(' && ');
}

/** Run install/build/test for a project in the sandbox; report the failing step.
 * Returns { ok:true } or { ok:false, step, output, daemonDown?, timedOut? }. */
export async function verifyProject(projectId, { runner = runInContainer, image } = {}) {
  const p = getProject(projectId);
  if (!p) return { ok: false, step: 'setup', output: 'unknown project' };
  const repoPath = ensureRepoPath(projectId);
  const scripts = pkgScripts(repoPath);
  if (!scripts) return { ok: false, step: 'setup', output: 'no package.json — nothing to run' };
  const r = await runner(repoPath, { image, script: verifyScript(scripts) });
  if (r.daemonDown) return { ok: false, step: 'docker', output: r.output, daemonDown: true };
  if (r.exitCode === 0) return { ok: true };
  const markers = [...String(r.output || '').matchAll(/@@STEP (\w+)/g)].map(m => m[1]);
  return { ok: false, step: markers[markers.length - 1] || 'install', output: r.output, timedOut: !!r.timedOut };
}
