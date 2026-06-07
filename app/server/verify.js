// app/server/verify.js
/* Phase B verify: run install/build/test in a sandbox container and report
 * which step failed. Pure logic + an injected `runner` (default B1's
 * runInContainer) so it is unit-tested without Docker. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getProject, ensureRepoPath } from './projects.js';
import { runInContainer } from './sandbox.js';

/** The repo's parsed package.json, or null if there's no package.json. */
function readPkg(repoPath) {
  const f = resolve(repoPath, 'package.json');
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')) || {}; } catch { return {}; }
}

/** Dependencies (prod + dev) a package.json declares, as a lowercase Set of names. */
function depNames(pkg) {
  return new Set(Object.keys({ ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) }).map(n => n.toLowerCase()));
}

// Native-dependency → required Debian system packages. `node:20-slim` is bare
// (no OpenSSL), so stacks that need a system lib must install it before npm runs.
// Keyed by a substring match against dependency names.
const SYSTEM_DEPS = [
  { match: 'prisma', packages: ['openssl'] },   // Prisma's query engine needs libssl
];

/** Debian packages the project's stack needs at the system level (deduped). */
export function systemPackages(pkg) {
  const names = [...depNames(pkg)];
  const out = new Set();
  for (const rule of SYSTEM_DEPS) {
    if (names.some(n => n.includes(rule.match))) rule.packages.forEach(p => out.add(p));
  }
  return [...out];
}

/** A shell prefix that installs the stack's system packages, or '' if none.
 * Quiet + non-interactive so it doesn't drown the real step output. */
export function provisionScript(pkg) {
  const pkgs = systemPackages(pkg);
  if (!pkgs.length) return '';
  return `echo "@@STEP provision" && (apt-get update -y && apt-get install -y ${pkgs.join(' ')}) >/dev/null 2>&1`;
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
 * Stacks that need system libraries (e.g. Prisma → OpenSSL) are provisioned
 * first so an otherwise-unwinnable environment failure never reaches the user.
 * Returns { ok:true } or { ok:false, step, output, daemonDown?, timedOut? }. */
export async function verifyProject(projectId, { runner = runInContainer, image } = {}) {
  const p = getProject(projectId);
  if (!p) return { ok: false, step: 'setup', output: 'unknown project' };
  const repoPath = ensureRepoPath(projectId);
  const pkg = readPkg(repoPath);
  if (!pkg) return { ok: false, step: 'setup', output: 'no package.json — nothing to run' };
  const provision = provisionScript(pkg);
  const script = provision ? `${provision} && ${verifyScript(pkg.scripts)}` : verifyScript(pkg.scripts);
  const r = await runner(repoPath, { image, script });
  if (r.daemonDown) return { ok: false, step: 'docker', output: r.output, daemonDown: true };
  if (r.exitCode === 0) return { ok: true };
  const markers = [...String(r.output || '').matchAll(/@@STEP (\w+)/g)].map(m => m[1]);
  return { ok: false, step: markers[markers.length - 1] || 'install', output: r.output, timedOut: !!r.timedOut };
}
