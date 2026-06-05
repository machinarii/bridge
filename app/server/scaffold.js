// app/server/scaffold.js
/* Phase A scaffold engine (§5). From the captured planning docs, propose a
 * build plan (stack + file tree); on approval, generate file contents and
 * commit them to the project repo. Pure: the model call is injected as
 * `callText` (same DI as kickoff.js), so this is fully unit-testable. */
import { getProject, setProjectState, ensureRepoPath } from './projects.js';
import { listNotes, readNote } from './backends/notes.js';
import { writeFiles, commitAll, commitIfChanged } from './workspace.js';
import { getModelForRole } from './models.js';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Post-scaffold static check: syntax-check generated JS (`node --check`, no
 * execution — safe). Returns [{path, error}] for files that fail to parse. This
 * is the "observe" first step of a feedback loop; the full run/test/fix loop is
 * Phase B. */
function staticCheck(repoPath, files) {
  const issues = [];
  for (const f of files) {
    if (!/\.(?:js|mjs|cjs)$/.test(f.path)) continue;
    try { execFileSync('node', ['--check', resolve(repoPath, f.path)], { stdio: 'pipe' }); }
    catch (e) {
      const msg = String(e.stderr || e.message || '').split('\n').find(l => l.trim()) || 'syntax error';
      issues.push({ path: f.path, error: msg.trim().slice(0, 200) });
    }
  }
  return issues;
}

/** Concatenate the project's captured planning docs as model context. */
function gatherDocs(projectId) {
  return listNotes(projectId)
    .map(n => `### ${n.id}\n${readNote(projectId, n.id) || ''}`)
    .join('\n\n');
}

/** Pull the first JSON object out of a model reply (tolerates ```json fences
 * and surrounding prose). Throws if none parses. */
function parseJsonReply(raw, what) {
  const s = String(raw || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  try {
    const obj = JSON.parse(candidate);
    if (!obj || typeof obj !== 'object') throw new Error('not an object');
    return obj;
  } catch {
    throw new Error(`could not parse ${what} from model reply`);
  }
}

/** Propose a build plan (stack + file tree) from the captured docs and persist
 * it; moves the project to phase=build_pending. Returns the plan. */
export async function generateBuildPlan(projectId, { callText, apiKey } = {}) {
  const p = getProject(projectId);
  if (!p) return null;
  const docs = gatherDocs(projectId);
  const prompt =
    `You are the engineering lead for project "${p.name}". Goal: "${p.goal}".\n` +
    `Captured planning docs:\n${docs}\n\n` +
    `Propose an initial code scaffold. Output ONLY JSON: ` +
    `{"stack": "<short stack name>", "summary": "<one line>", "files": [{"path": "<repo-relative path>", "purpose": "<one line>"}]}. ` +
    `8-20 files, real source files (no node_modules). No prose outside the JSON.`;
  const raw = await callText({ apiKey, model: getModelForRole('sw_engineer'), prompt, timeoutMs: 30_000 });
  const obj = parseJsonReply(raw, 'build plan');
  const files = Array.isArray(obj.files) ? obj.files.filter(f => f && f.path) : [];
  if (!files.length) throw new Error('could not parse build plan: no files');
  const plan = { stack: String(obj.stack || ''), summary: String(obj.summary || ''), files };
  const repoPath = ensureRepoPath(projectId);
  setProjectState(projectId, { phase: 'build_pending', build: { repoPath, plan, status: 'pending', commitSha: null } });
  return plan;
}

/** Generate the contents for one planned file. */
async function generateFile(callText, project, plan, file, docs, apiKey) {
  const prompt =
    `Project "${project.name}" (goal: "${project.goal}", stack: ${plan.stack}). ` +
    `Write the complete contents of ONE file. PATH:${file.path} — purpose: ${file.purpose}. ` +
    `Context docs:\n${docs}\n\nOutput ONLY the raw file contents, no markdown fences, no commentary.`;
  const raw = await callText({ apiKey, model: getModelForRole('sw_engineer'), prompt, timeoutMs: 30_000 });
  return { path: file.path, contents: String(raw ?? '') };
}

/** Regenerate ONE file that failed the syntax check, given the error. */
async function regenerateFile(callText, project, plan, file, error, docs, apiKey) {
  const prompt =
    `The file ${file.path} in project "${project.name}" (stack: ${plan.stack}) has a syntax error:\n${error}\n\n` +
    `Rewrite the COMPLETE corrected contents of ${file.path} (purpose: ${file.purpose || 'source file'}). ` +
    `Context docs:\n${docs}\n\nOutput ONLY the raw file contents — no markdown fences, no commentary.`;
  const raw = await callText({ apiKey, model: getModelForRole('sw_engineer'), prompt, timeoutMs: 30_000 });
  return { path: file.path, contents: String(raw ?? '') };
}

/** Generate contents for every planned file (batched), write + commit atomically,
 * then close the feedback loop: syntax-check the JS and regenerate any failing
 * files until they parse or `fixRounds` is exhausted. Returns
 * {ok, commitSha, fileCount, issues, fixRounds}. On a generation failure nothing
 * is written/committed and build.status becomes 'error'. */
export async function scaffoldProject(projectId, { callText, apiKey, batchSize = 6, fixRounds = 2 } = {}) {
  const p = getProject(projectId);
  const build = p?.build;
  if (!build?.plan?.files?.length) return { ok: false, reason: 'no build plan' };
  const repoPath = ensureRepoPath(projectId);
  const docs = gatherDocs(projectId);
  setProjectState(projectId, { phase: 'scaffolding', build: { ...build, status: 'scaffolding' } });
  try {
    const out = [];
    const files = build.plan.files;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      out.push(...await Promise.all(batch.map(f => generateFile(callText, p, build.plan, f, docs, apiKey))));
    }
    // Everything generated — now the single atomic write + commit.
    writeFiles(repoPath, out);
    let commitSha = commitAll(repoPath, 'Scaffold: initial project structure');
    // Feedback loop: syntax-check the JS, regenerate failing files, re-check —
    // bounded by fixRounds. `issues` ends as whatever still won't parse.
    let issues = staticCheck(repoPath, out);
    let round = 0;
    while (issues.length && round < fixRounds) {
      round++;
      const fixes = await Promise.all(issues.map(issue => {
        const purpose = build.plan.files.find(f => f.path === issue.path)?.purpose || '';
        return regenerateFile(callText, p, build.plan, { path: issue.path, purpose }, issue.error, docs, apiKey);
      }));
      writeFiles(repoPath, fixes);
      issues = staticCheck(repoPath, fixes);   // re-check only the regenerated files
    }
    if (round > 0) {
      const fixSha = commitIfChanged(repoPath, `Fix scaffold syntax issues (${round} round${round === 1 ? '' : 's'})`);
      if (fixSha) commitSha = fixSha;
    }
    setProjectState(projectId, { phase: 'built', build: { ...build, status: 'done', commitSha, issues } });
    return { ok: true, commitSha, fileCount: out.length, issues, fixRounds: round };
  } catch (err) {
    setProjectState(projectId, { phase: 'build_pending', build: { ...build, status: 'error' } });
    throw err;
  }
}

/** Endpoint logic: propose a build plan. Returns the plan (or null if unknown). */
export async function proposeBuildPlan(projectId, opts = {}) {
  return generateBuildPlan(projectId, opts);
}

/** Endpoint logic: run the scaffold. Returns {ok, commitSha, fileCount} or {ok:false}. */
export async function runScaffold(projectId, opts = {}) {
  return scaffoldProject(projectId, opts);
}
