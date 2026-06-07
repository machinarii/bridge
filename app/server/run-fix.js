// app/server/run-fix.js
/* Phase B run-fix loop: verify a project (verify.js); on failure, have the model
 * return multi-file edits, apply + commit them, and re-verify — bounded. DI
 * `callText` + `runner` so the whole loop is unit-tested without Docker. */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { ensureRepoPath } from './projects.js';
import { writeFiles, commitIfChanged } from './workspace.js';
import { getModelForRole } from './models.js';
import { runInContainer } from './sandbox.js';
import { verifyProject } from './verify.js';

/** Repo source files (excluding node_modules/.git), each under fileMax bytes,
 * capped at totalMax bytes total — bounded context for the fix prompt. */
export function listSourceFiles(repoPath, { fileMax = 20_000, totalMax = 60_000 } = {}) {
  const out = [];
  let total = 0;
  const walk = (dir) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git') continue;
      const abs = join(dir, name);
      let st; try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) { walk(abs); continue; }
      if (st.size > fileMax) continue;
      let contents; try { contents = readFileSync(abs, 'utf8'); } catch { continue; }
      if (total + contents.length > totalMax) continue;
      total += contents.length;
      out.push({ path: relative(repoPath, abs), contents });
    }
  };
  walk(repoPath);
  return out;
}

function parseEdits(raw) {
  const s = String(raw || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cand = fenced ? fenced[1] : s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  try {
    const o = JSON.parse(cand);
    return Array.isArray(o?.files) ? o.files.filter(f => f && f.path && typeof f.contents === 'string') : [];
  } catch { return []; }
}

/** Ask the model to fix the failing step. Returns [{path, contents}] edits. */
export async function proposeFixes(projectId, result, callText, { apiKey } = {}) {
  const repoPath = ensureRepoPath(projectId);
  const block = listSourceFiles(repoPath).map(f => `=== ${f.path} ===\n${f.contents}`).join('\n\n');
  const prompt =
    `The project's ${result.step} step failed:\n\n${String(result.output || '').slice(-4000)}\n\n` +
    `Current files:\n${block}\n\n` +
    `Return ONLY JSON {"files":[{"path":"<repo-relative>","contents":"<full corrected file>"}]} with the ` +
    `COMPLETE corrected contents of every file you need to change. No prose.\n\n` +
    `This runs in an OFFLINE sandbox (a throwaway Linux container, no network ` +
    `services, no external database). You may edit ANY file — including ` +
    `package.json (scripts/deps), config, or an ORM schema. Keep it ` +
    `self-contained: prefer SQLite over a database server; a Prisma schema must ` +
    `have complete generator + datasource blocks (provider "sqlite", ` +
    `url "file:./dev.db"). Don't require services that npm test doesn't start.`;
  const raw = await callText({ apiKey, model: getModelForRole('sw_engineer'), prompt, timeoutMs: 60_000 });
  return parseEdits(raw);
}

/** Classify a failing verify result so the user gets a diagnosis, not just a
 * raw dump. `environment` = a missing system lib (not fixable by editing files
 * alone); `dependency` = a missing/misdeclared package; otherwise the step name. */
export function classifyFailure(step, output) {
  const o = String(output || '');
  if (/libssl|openssl|\blib[\w.+-]*\.so(?:\.\d+)*\b|GLIBC_|error while loading shared libraries/i.test(o))
    return { kind: 'environment', hint: 'a missing system library in the sandbox image' };
  if (/Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i.test(o))
    return { kind: 'dependency', hint: 'a missing or misdeclared dependency' };
  return { kind: 'code', hint: `the ${step || 'build'} step` };
}

/** Verify → fix → re-verify until green or maxRounds. Each fix round applies the
 * model's edits and commits them. Returns {ok, rounds, lastStep, lastOutput, daemonDown}. */
export async function runAndFix(projectId, { callText, runner = runInContainer, image, apiKey, maxRounds = 3 } = {}) {
  let round = 0;
  let result = await verifyProject(projectId, { runner, image });
  while (!result.ok && !result.daemonDown && round < maxRounds) {
    round++;
    const edits = await proposeFixes(projectId, result, callText, { apiKey });
    if (!edits.length) break;
    const repoPath = ensureRepoPath(projectId);
    writeFiles(repoPath, edits);
    commitIfChanged(repoPath, `Fix: ${result.step} failures (round ${round})`);
    result = await verifyProject(projectId, { runner, image });
  }
  return { ok: !!result.ok, rounds: round, lastStep: result.step, lastOutput: result.output, daemonDown: !!result.daemonDown };
}
