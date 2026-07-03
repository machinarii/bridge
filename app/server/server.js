import express from 'express';
import { migrateLegacyOnce } from './scratchpad.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { listRoles } from './roles.js';
import { getRouterModel, defaultModelForRole } from './models.js';
import { listSkills, getSkill, withSkillEnabled } from './skills.js';
import { githubStatus, startDeviceFlow, disconnectGithub, setGithubPersist, detectAndStore } from './github.js';
import { listProjects, getProject, createProject, setAgentEnabled, addAgent, removeAgent, renameProject, deleteProject, migrateCharterFilenames } from './projects.js';
import { buildFileTree, readProjectFile } from './server-files.js';
import { charterFileNameFor } from './charters.js';
import { listNotes, readNote, appendNote } from './backends/notes.js';
import { interpretIntent } from './orchestrator.js';
import { setLastSpec, getContext, lastActivityAt, truncateFrom } from './scratchpad.js';
import { runTeamVoice, resolveDelegateSpec } from './team.js';
import { getCouncil, saveCouncil } from './council-store.js';
import { startKickoff, handleLeadMessageDuringKickoff, declineKickoff, callOpenRouterText } from './kickoff.js';
import { getCouncilModels, buildIntake, councilContext, askMember, synthesize } from './council.js';
import { addLearning, getLearnings } from './learnings.js';
import { proposeBuildPlan, runScaffold } from './scaffold.js';
import {
  notifyStateChange, rescheduleAutosave, initProjectRepo, autosaveStatus,
} from './autosave.js';
import { subscribe as subscribeEvents, publish as publishEvent, statusSnapshot } from './events.js';
import { listTasks } from './tasks.js';
import { resolveBlockedForAgent } from './executor.js';
import { hydrateSecretsIntoEnv, readSecret, writeSecret, deleteSecret } from './secrets.js';
import { healthSnapshot } from './health.js';
import { recoverOnBoot } from './recovery.js';
import { createCancelToken, cancelToken, tokenStatus, cleanupStale } from './cancel.js';
import { countRequest, countCanceled, snapshotMetrics } from './server-metrics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = resolve(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// Default to the bundled local Parakeet STT so voice works out of the box on
// first launch. Voice always targets this local endpoint; when the sidecar is
// unavailable the renderer surfaces an STT error instead of switching engines.
if (!process.env.LOCAL_STT_URL) {
  process.env.LOCAL_STT_URL = `http://127.0.0.1:${process.env.PARAKEET_PORT || 8123}/transcribe`;
}

const PORT = Number(process.env.PORT || 4317);
const RENDERER_DIR = resolve(__dirname, '..', 'renderer');
const ASSETS_DIR   = resolve(__dirname, '..', 'assets');

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use((_req, _res, next) => { countRequest(); next(); });
app.use('/assets', express.static(ASSETS_DIR, { maxAge: '1d', immutable: true }));
// Renderer HTML/JS/CSS: never cache, so a reload always picks up the latest
// build (the browser was serving stale index.html / main.js otherwise).
app.use(express.static(RENDERER_DIR, {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

/* ---------- v2 SSE event channel ----------
 *
 * GET /projects/:pid/events  → events for a single project
 * GET /events                → events across all projects
 *
 * Renderers subscribe once on screen load. Each event lands as a
 * single SSE message:
 *
 *   event: bridge
 *   data: { "id": 17, "at": 1716700000000, "type": "status",
 *           "projectId": "p_...", "agentId": "p_..__pm", "verb": "drafting" }
 */
function attachEventStream(req, res, projectId) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`event: bridge\ndata: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`);
  const ping = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* closed */ }
  }, 25_000);
  const unsubscribe = subscribeEvents(projectId, (ev) => {
    try { res.write(`event: bridge\ndata: ${JSON.stringify(ev)}\n\n`); }
    catch { /* dropped client */ }
  });
  req.on('close', () => { clearInterval(ping); unsubscribe(); });
}
app.get('/events',                   (req, res) => attachEventStream(req, res, null));
app.get('/projects/:pid/events',     (req, res) => attachEventStream(req, res, req.params.pid));

/* Read/write a small subset of .env. The key is returned masked. */
const SETTINGS_KEYS = [
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
  'OPENROUTER_MODEL_BY_ROLE',  // JSON: { roleId: modelId }
  'OPENROUTER_ROUTER_MODEL',   // fast/cheap model for team-voice routing
  'MCP_PLUGINS',                // JSON: [{ id, name, enabled }]
  'SKILLS_DISABLED',            // JSON: [skillId, ...] (deactivated skills)
  'GITHUB_OAUTH_CLIENT_ID',     // GitHub OAuth App client id (device flow)
  'GIT_AUTOSAVE',               // "on" | "off"
  'GIT_AUTOSAVE_INTERVAL_MIN',  // integer
  'LOCAL_STT_URL',              // e.g. http://localhost:8123/transcribe
  'OPENROUTER_COUNCIL_MODELS',  // JSON: [m1, m2, m3] — the three Council members
  'AI_INSTRUCTIONS',            // freeform custom instructions injected into agent + council prompts
  'OPENROUTER_TIERS',           // "on"|"off" — per-role model tiering (craft roles → cheaper model)
];

function maskKey(s) {
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function readEnvFile() {
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function writeEnvFile(updates) {
  const current = readEnvFile();
  const merged = { ...current, ...updates };
  const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
  // Update process.env so the running orchestrator picks up new values.
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;
}

function parseJsonEnv(name, fallback) {
  try { return JSON.parse(process.env[name] || ''); }
  catch { return fallback; }
}

app.get('/settings', async (_req, res) => {
  const openrouterKey = await readSecret('OPENROUTER_API_KEY');
  res.set('Cache-Control', 'no-store');   // the gate must never read a stale key verdict
  res.json({
    OPENROUTER_API_KEY: maskKey(openrouterKey || ''),
    OPENROUTER_API_KEY_SET: !!openrouterKey,
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'anthropic/claude-opus-4.8',
    OPENROUTER_MODEL_BY_ROLE: parseJsonEnv('OPENROUTER_MODEL_BY_ROLE', {}),
    // The tier-resolved model each role uses with no explicit override — shown
    // in the Settings UI so each row's "default" reflects the active tier.
    OPENROUTER_MODEL_DEFAULT_BY_ROLE: Object.fromEntries(listRoles().map(r => [r.id, defaultModelForRole(r.id)])),
    OPENROUTER_ROUTER_MODEL: getRouterModel(),  // resolved (defaults to the fast router model)
    MCP_PLUGINS: parseJsonEnv('MCP_PLUGINS', []),
    GIT_AUTOSAVE: (process.env.GIT_AUTOSAVE || 'off') === 'on',
    GIT_AUTOSAVE_INTERVAL_MIN: Number(process.env.GIT_AUTOSAVE_INTERVAL_MIN || 5),
    LOCAL_STT_URL: process.env.LOCAL_STT_URL || '',
    GITHUB_OAUTH_CLIENT_ID: process.env.GITHUB_OAUTH_CLIENT_ID || '',
    OPENROUTER_COUNCIL_MODELS: getCouncilModels(),
    AI_INSTRUCTIONS: process.env.AI_INSTRUCTIONS || '',
    OPENROUTER_TIERS: (process.env.OPENROUTER_TIERS || 'on') !== 'off',
  });
});

/* ───────────────────────── Council ─────────────────────────
 * Flow (see council.js): PM intake gathers context → three members answer
 * BLIND and SEQUENTIALLY (one /council/member call per index, in turn — no
 * member sees another's answer) → chairman synthesizes. Members are
 * configurable in Settings and default to three problem-solving models no
 * other agent uses. Inspired by karpathy/llm-council. */
function councilQuestion(req, res) {
  if (!process.env.OPENROUTER_API_KEY) { res.status(400).json({ error: 'OpenRouter API key not set' }); return null; }
  const question = String(req.body?.question || '').trim();
  if (!question) { res.status(400).json({ error: 'question required' }); return null; }
  return question;
}

// PM intake — up to a few clarifying questions for the user to answer first.
app.post('/council/intake', async (req, res) => {
  const question = councilQuestion(req, res);
  if (question === null) return;
  try {
    const questions = await buildIntake({ question, apiKey: process.env.OPENROUTER_API_KEY });
    res.json({ questions, models: getCouncilModels() });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// One member's answer (blind). The client calls this once per index, in turn.
app.post('/council/member', async (req, res) => {
  const question = councilQuestion(req, res);
  if (question === null) return;
  const models = getCouncilModels();
  const index = Number(req.body?.index);
  if (!Number.isInteger(index) || index < 0 || index >= models.length) {
    return res.status(400).json({ error: 'valid member index required' });
  }
  try {
    const context = councilContext(req.body?.answers);
    res.json(await askMember({ apiKey: process.env.OPENROUTER_API_KEY, model: models[index], question, context }));
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Chairman synthesis over the collected member answers.
app.post('/council/synthesis', async (req, res) => {
  const question = councilQuestion(req, res);
  if (question === null) return;
  try {
    const context = councilContext(req.body?.answers);
    const members = Array.isArray(req.body?.members) ? req.body.members : [];
    const result = await synthesize({ apiKey: process.env.OPENROUTER_API_KEY, model: getCouncilModels()[0], question, context, members });
    // Persist the chair's one-line takeaway as a project learning so the team
    // inherits the council's decision in future turns.
    const pid = req.body?.projectId;
    if (pid && result.takeaway && getProject(pid)) {
      addLearning(pid, { key: `council:${question}`.slice(0, 80), insight: result.takeaway, type: 'decision', confidence: 8, source: 'council' });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Council transcript persistence — restore the prompt + decisions + answers
// when the user re-enters the council view for a project.
app.get('/projects/:pid/council', (req, res) => {
  res.json({ council: getCouncil(req.params.pid) });
});
app.put('/projects/:pid/council', (req, res) => {
  saveCouncil(req.params.pid, req.body?.state ?? null);
  res.json({ ok: true });
});

/* Proxy mic audio to the local Parakeet (or whichever) STT server
 * configured in LOCAL_STT_URL. The renderer captures via
 * MediaRecorder and POSTs a webm/opus blob; we forward it as
 * multipart/form-data and return the recognized text. */
app.post('/transcribe', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const target = process.env.LOCAL_STT_URL;
  if (!target) return res.status(400).json({ error: 'LOCAL_STT_URL not set' });
  try {
    // FormData is available globally on Node ≥ 18.
    const fd = new FormData();
    const ct = req.headers['content-type'] || 'application/octet-stream';
    fd.append('file', new Blob([req.body], { type: ct }), 'audio');
    const t0 = Date.now();
    const r = await fetch(target, { method: 'POST', body: fd });
    const text = await r.text();
    if (!r.ok) return res.status(502).json({ error: `upstream ${r.status}: ${text.slice(0, 200)}` });
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { text }; }
    res.json({ ...payload, latencyMs: Date.now() - t0 });
  } catch (err) {
    res.status(502).json({ error: String(err?.message || err) });
  }
});

/* Quick reachability check for the local STT sidecar, so the renderer can
 * surface a clear voice-status hint in capture UIs and settings. */
app.get('/stt-health', async (_req, res) => {
  const target = process.env.LOCAL_STT_URL;
  if (!target) return res.json({ available: false });
  const healthUrl = target.replace(/\/transcribe\/?$/, '/health');
  try {
    const r = await fetch(healthUrl, { signal: AbortSignal.timeout(800) });
    res.json({ available: r.ok });
  } catch {
    res.json({ available: false });
  }
});

// Per-operation cancellation API (build/run and other long jobs).
app.post('/operations', (req, res) => {
  const token = createCancelToken({
    kind: req.body?.kind,
    projectId: req.body?.projectId,
    ownerAgentId: req.body?.ownerAgentId,
  });
  res.json({ token });
});

app.get('/operations/:token', (req, res) => {
  const st = tokenStatus(req.params.token);
  if (!st) return res.status(404).json({ error: 'unknown token' });
  res.json(st);
});

app.post('/operations/:token/cancel', (req, res) => {
  const ok = cancelToken(req.params.token, req.body?.reason || 'Canceled by user');
  if (ok) countCanceled();
  res.json({ ok });
});

// Runtime health checks shown in Settings -> Health.
app.get('/health/system', async (req, res) => {
  const snap = await healthSnapshot(req.query?.projectId ? String(req.query.projectId) : null);
  res.json({ ...snap, metrics: snapshotMetrics() });
});

let _modelsCache = null;
let _modelsCacheAt = 0;
const MODELS_TTL = 60 * 60 * 1000;

app.get('/settings/models', async (_req, res) => {
  try {
    const now = Date.now();
    if (_modelsCache && (now - _modelsCacheAt) < MODELS_TTL) {
      return res.json({ models: _modelsCache });
    }
    const r = await fetch('https://openrouter.ai/api/v1/models');
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const data = await r.json();
    const list = (data?.data || [])
      .map(m => ({ id: m.id, name: m.name || m.id }))
      .filter(m => m.id);
    list.sort((a, b) => a.id.localeCompare(b.id));
    _modelsCache = list;
    _modelsCacheAt = now;
    res.json({ models: list });
  } catch (err) {
    res.status(502).json({ error: String(err?.message || err) });
  }
});

/* Validate an OpenRouter key WITHOUT saving it — used by the first-launch
 * gate so a typo'd key is rejected up front instead of failing on first chat. */
app.post('/settings/verify-key', async (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (!key) return res.status(400).json({ valid: false, error: 'key required' });
  try {
    const r = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { 'Authorization': `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) return res.json({ valid: true });
    res.json({ valid: false, error: r.status === 401 ? 'Invalid key' : `OpenRouter returned ${r.status}` });
  } catch (err) {
    console.warn(`[gate] verify-key: unreachable — ${err?.name === 'TimeoutError' ? 'timeout' : (err?.message || err)}`);
    res.status(502).json({ valid: false, error: 'Could not reach OpenRouter — check your connection.' });
  }
});

app.put('/settings', async (req, res) => {
  try {
    const updates = {};
    for (const k of SETTINGS_KEYS) {
      const v = req.body?.[k];
      if (v === undefined || v === null) continue;
      // Allow objects/arrays — serialize to JSON for .env storage.
      if (typeof v === 'object') updates[k] = JSON.stringify(v);
      else if (typeof v === 'boolean') updates[k] = v ? 'on' : 'off';
      else if (typeof v === 'number') updates[k] = String(v);
      else if (typeof v === 'string' && v.length > 0) updates[k] = v;
    }
    // Allow explicitly clearing free-text instructions (the generic loop skips empty strings).
    if (typeof req.body?.AI_INSTRUCTIONS === 'string') updates.AI_INSTRUCTIONS = req.body.AI_INSTRUCTIONS;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no updates' });
    if (Object.prototype.hasOwnProperty.call(updates, 'OPENROUTER_API_KEY')) {
      await writeSecret('OPENROUTER_API_KEY', updates.OPENROUTER_API_KEY);
      delete updates.OPENROUTER_API_KEY;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'GITHUB_TOKEN')) {
      const token = updates.GITHUB_TOKEN;
      if (token) await writeSecret('GITHUB_TOKEN', token);
      else await deleteSecret('GITHUB_TOKEN');
      delete updates.GITHUB_TOKEN;
    }
    if (Object.keys(updates).length) writeEnvFile(updates);
    // If git autosave just turned on, reschedule the timer.
    rescheduleAutosave();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/roles', (_req, res) => {
  res.json({ roles: listRoles() });
});

// Agent skill registry — the Settings → Skills tab lists these and toggles them.
app.get('/skills', (_req, res) => {
  res.json({ skills: listSkills() });
});

app.patch('/skills/:id', (req, res) => {
  const skill = getSkill(req.params.id);
  if (!skill) return res.status(404).json({ error: 'unknown skill' });
  const enabled = !!req.body?.enabled;
  try {
    writeEnvFile({ SKILLS_DISABLED: JSON.stringify(withSkillEnabled(skill.id, enabled)) });
    res.json({ ok: true, id: skill.id, enabled });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// GitHub pairing (OAuth device flow). Keep token in keychain when available;
// login remains in .env for display and reconnect UX.
setGithubPersist(async ({ token, login }) => {
  (async () => {
    if (token) await writeSecret('GITHUB_TOKEN', token);
    else await deleteSecret('GITHUB_TOKEN');
    writeEnvFile({ GITHUB_LOGIN: login || '' });
  })().catch((err) => console.warn('[github] persist failed:', err?.message || err));
});

app.get('/github', (_req, res) => res.json(githubStatus()));

// Try to connect from an existing local token (gh CLI / git keychain). No-op
// if already connected or nothing valid is found.
app.post('/github/detect', async (_req, res) => {
  try { res.json(await detectAndStore()); }
  catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
});

app.post('/github/device', async (_req, res) => {
  try {
    const info = await startDeviceFlow();
    res.json(info);
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.post('/github/disconnect', (_req, res) => res.json(disconnectGithub()));

/* True when an agent's latest turn is an unanswered question (an assistant turn
 * carrying a `choices` array with no user reply after it). Lets the client
 * restore "Waiting for response" on load, surviving reloads / missed events. */
function agentAwaitingReply(agentId) {
  const msgs = getContext(agentId).messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'system') continue;          // skip handoff markers
    if (m.role === 'user') return false;         // a reply came after → answered
    if (m.role === 'assistant') {
      try {
        const p = JSON.parse(String(m.content || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
        if (Array.isArray(p?.choices) && p.choices.length) return true;
      } catch { /* not a spec */ }
      return false;                              // latest is a plain deliverable
    }
  }
  return false;
}

app.get('/projects', (_req, res) => {
  // Enrich each project with the most-recent scratchpad activity across its
  // agents (falls back to createdAt), plus a per-agent `awaitingReply` flag.
  const enriched = listProjects().map(p => {
    const agentIds = p.agents.map(a => a.id);
    const last = lastActivityAt(agentIds);
    const agents = p.agents.map(a => ({ ...a, awaitingReply: agentAwaitingReply(a.id) }));
    return { ...p, agents, updatedAt: last || p.createdAt };
  });
  res.json({ projects: enriched });
});

app.get('/projects/:pid', (req, res) => {
  const p = getProject(req.params.pid);
  if (!p) return res.status(404).json({ error: 'unknown project' });
  res.json(p);
});

/* Shortens a project name to <= 40 characters via OpenRouter. Falls
 * back to a hard truncate if the API key is missing or the request
 * fails for any reason. */
const NAME_LIMIT = 30;
async function shortenViaLLM(name) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes('replace-me')) {
    return { name: name.slice(0, NAME_LIMIT).trim(), shortened: false, reason: 'no_key' };
  }
  const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-opus-4.8';
  const prompt =
    `Rewrite this project name so it is ${NAME_LIMIT} characters or fewer ` +
    `while preserving its meaning. Output only the rewritten name — ` +
    `no quotes, no commentary, no trailing punctuation.\n\n` +
    `Name: ${name}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost/bridge',
        'X-Title': 'Bridge — shorten name',
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const data = await r.json();
    const raw = String(data?.choices?.[0]?.message?.content || '').trim();
    const cleaned = raw.replace(/^["'`]+|["'`]+$/g, '').trim();
    const final = (cleaned.length && cleaned.length <= NAME_LIMIT)
      ? cleaned
      : cleaned.slice(0, NAME_LIMIT).trim();
    return { name: final, shortened: true };
  } catch (err) {
    return { name: name.slice(0, NAME_LIMIT).trim(), shortened: false, reason: String(err.message || err) };
  } finally {
    clearTimeout(t);
  }
}

app.post('/projects/shorten-name', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  if (name.length <= NAME_LIMIT) return res.json({ name, shortened: false });
  res.json(await shortenViaLLM(name));
});

app.post('/projects', async (req, res) => {
  try {
    const { name, goal, features, roleIds, topology } = req.body || {};
    const p = await createProject({ name, goal, features, roleIds, topology });
    initProjectRepo(p.id).then(() => notifyStateChange(p.id, 'Project created'));
    publishEvent({
      type: 'notification',
      kind: 'info',
      projectId: p.id,
      title: 'Project created',
      body: `${p.name} · ${p.agents.length} agent${p.agents.length === 1 ? '' : 's'} assembled.`,
    });
    // Kick off the PM plan in the background (non-blocking).
    startKickoff(p.id).catch(err => console.warn('[kickoff] start failed:', err?.message));
    res.json(p);
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.get('/projects/:pid/autosave', async (req, res) => {
  if (!getProject(req.params.pid)) return res.status(404).json({ error: 'unknown project' });
  res.json(await autosaveStatus(req.params.pid));
});

// Rename a project (display name only; the id stays stable).
app.patch('/projects/:pid', (req, res) => {
  try {
    res.json(renameProject(req.params.pid, String(req.body?.name || '')));
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

// Permanently remove a project and its on-disk state.
app.delete('/projects/:pid', (req, res) => {
  try {
    const r = deleteProject(req.params.pid);
    publishEvent({ type: 'notification', kind: 'info', title: 'Project removed', body: `${r.name} was deleted.` });
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.post('/projects/:pid/agents', async (req, res) => {
  try {
    const roleId = String(req.body?.roleId || '').trim();
    if (!roleId) return res.status(400).json({ error: 'roleId required' });
    const p = await addAgent(req.params.pid, roleId);
    notifyStateChange(p.id, `Agent added (${roleId})`);
    // Charter file got written for the new role — tell the renderer
    // so the explorer's Charters section refreshes.
    publishEvent({ type: 'file_created', projectId: p.id, kind: 'charter', file: `${roleId}.md` });
    const newAgent = p.agents[p.agents.length - 1];
    publishEvent({
      type: 'notification',
      kind: 'info',
      projectId: p.id,
      title: 'Agent added',
      body: `${newAgent?.name || roleId} joined ${p.name}.`,
    });
    res.json(p);
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.delete('/projects/:pid/agents/:aid', (req, res) => {
  try {
    const { project: p, removedRole } = removeAgent(req.params.pid, req.params.aid);
    notifyStateChange(p.id, 'Agent removed');
    // Tell the renderer the charter file is gone so the explorer drops it.
    if (removedRole) publishEvent({ type: 'file_removed', projectId: p.id, kind: 'charter', file: charterFileNameFor(removedRole) });
    publishEvent({ type: 'notification', kind: 'info', projectId: p.id, title: 'Agent removed', body: `An agent left ${p.name}.` });
    res.json(p);
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.patch('/projects/:pid/agents/:aid', (req, res) => {
  try {
    const r = setAgentEnabled(req.params.pid, req.params.aid, !!req.body?.enabled);
    if (!r.ok) return res.status(400).json({ error: r.reason });
    res.json(r.agent);
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.get('/projects/:pid/notes', (req, res) => {
  if (!getProject(req.params.pid)) return res.status(404).json({ error: 'unknown project' });
  res.json({ items: listNotes(req.params.pid) });
});

/* Per-project learnings — durable insights injected into agent prompts so the
 * team stops re-deriving settled decisions / re-finding the same bugs. */
app.get('/projects/:pid/learnings', (req, res) => {
  if (!getProject(req.params.pid)) return res.status(404).json({ error: 'unknown project' });
  const role = req.query.role ? String(req.query.role) : null;
  res.json({ learnings: getLearnings(req.params.pid, { role }) });
});

app.post('/projects/:pid/learnings', (req, res) => {
  if (!getProject(req.params.pid)) return res.status(404).json({ error: 'unknown project' });
  const rec = addLearning(req.params.pid, req.body || {});
  if (!rec) return res.status(400).json({ error: 'insight required' });
  res.json({ ok: true, learning: rec });
});

app.get('/projects/:pid/notes/:nid', (req, res) => {
  if (!getProject(req.params.pid)) return res.status(404).json({ error: 'unknown project' });
  const body = readNote(req.params.pid, req.params.nid);
  if (body == null) return res.status(404).json({ error: 'not found' });
  res.json({ id: req.params.nid, body });
});

app.post('/projects/:pid/notes', (req, res) => {
  if (!getProject(req.params.pid)) return res.status(404).json({ error: 'unknown project' });
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'empty note' });
  const note = appendNote(req.params.pid, body);
  notifyStateChange(req.params.pid, 'Note added');
  // Tell every connected renderer so an open explorer refreshes
  // its file tree in real time.
  publishEvent({
    type: 'file_created',
    projectId: req.params.pid,
    kind: 'note',
    file: note?.id || '',
    label: note?.label || '',
  });
  publishEvent({ type: 'note_added', projectId: req.params.pid, noteId: note?.id });
  res.json(note);
});

app.post('/projects/:pid/kickoff/approve', async (req, res) => {
  try {
    const result = await handleLeadMessageDuringKickoff(req.params.pid, 'Approve');
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post('/projects/:pid/kickoff/decline', (req, res) => {
  try {
    res.json({ ok: true, ...declineKickoff(req.params.pid) });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post('/projects/:pid/build-plan', async (req, res) => {
  try {
    const plan = await proposeBuildPlan(req.params.pid, { callText: callOpenRouterText });
    if (!plan) return res.status(404).json({ error: 'unknown project' });
    res.json({ plan });
  } catch (err) { res.status(500).json({ error: String(err.message) }); }
});

app.post('/projects/:pid/scaffold', async (req, res) => {
  try {
    const r = await runScaffold(req.params.pid, {
      callText: callOpenRouterText,
      cancelToken: req.body?.cancelToken ? String(req.body.cancelToken) : null,
    });
    res.json(r);
  } catch (err) { res.status(500).json({ error: String(err.message) }); }
});

app.post('/projects/:pid/agents/:aid/interpret', async (req, res) => {
  const { pid, aid } = req.params;
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty intent' });
  const cancelToken = req.body?.cancelToken ? String(req.body.cancelToken) : null;
  // A user message to an agent whose executor task is blocked on them resumes
  // the work in chat — close the executor's claim on it.
  resolveBlockedForAgent(aid);
  const regenerate = Number(req.body?.regenerate) || 0;
  const effort = String(req.body?.effort || 'high');
  try {
    // During an awaiting kickoff, a message to the lead may approve it. Once the
    // build is handed to the software engineer, their "Build it" / "Run it"
    // messages drive the build/run phases from their own chat.
    const project0 = getProject(pid);
    const ko0 = project0?.kickoff;
    const onBuildAgent = ko0 && aid === ko0.buildAgentId && ['build_pending', 'run_pending'].includes(ko0.status);
    if (project0 && (aid === project0.leadAgentId || onBuildAgent)) {
      const ko = await handleLeadMessageDuringKickoff(pid, text, {
        agentId: aid,
        cancelToken,
      });
      // The Q&A flow (one question at a time) and approval both hand back a
      // spec to surface directly as the PM's reply.
      if (ko.handled && ko.spec) {
        const spec = JSON.parse(ko.spec);
        setLastSpec(aid, spec);
        return res.json(spec);
      }
      if (ko.handled && ko.intent === 'approve') {
        const msgs = getContext(aid).messages;
        const last = msgs[msgs.length - 1];
        const reportSpec = JSON.parse(last.content);
        setLastSpec(aid, reportSpec);
        return res.json(reportSpec);   // the kickoff report / first question
      }
      // revise/unsure fall through to the normal PM reply below.
    }
    let spec = await interpretIntent({ projectId: pid, agentId: aid, text, regenerate, effort, cancelToken });
    // If the agent chose to delegate, actually route it to the teammate and
    // return their answer (otherwise the delegate intent dead-ends here).
    if (spec?.intent === 'delegate') {
      spec = await resolveDelegateSpec({ projectId: pid, fromAgentId: aid, spec, effort, cancelToken });
    }
    setLastSpec(aid, spec);
    res.json(spec);
  } catch (err) {
    console.error(`[interpret:${aid}]`, err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Executor task list for a project — status of every queued / in-progress /
// blocked / done / failed agent task (renderer task panel + debugging).
app.get('/projects/:pid/tasks', (req, res) => {
  res.json({ tasks: listTasks(req.params.pid) });
});

// Live agent-status snapshot ({ agentId: verb }, non-idle only) so a reloaded
// renderer can rehydrate busy tiles + the L2 "…" bubble — SSE replays no
// status history.
app.get('/projects/:pid/agents/status', (req, res) => {
  res.json({ statuses: statusSnapshot(req.params.pid) });
});

app.post('/projects/:pid/agents/:aid/spec', (req, res) => {
  setLastSpec(req.params.aid, req.body?.spec || null);
  res.json({ ok: true });
});

app.get('/projects/:pid/agents/:aid/history', (req, res) => {
  try {
    const ctx = getContext(req.params.aid);
    res.json({ messages: ctx.messages || [] });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Drop a prompt + its response (and anything after) so the client can redo it.
app.post('/projects/:pid/agents/:aid/history/truncate', (req, res) => {
  try {
    const index = Number(req.body?.index);
    if (!Number.isInteger(index)) return res.status(400).json({ error: 'index required' });
    const ctx = truncateFrom(req.params.aid, index);
    res.json({ messages: ctx.messages || [] });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/projects/:pid/files', (req, res) => {
  const tree = buildFileTree(req.params.pid);
  if (!tree) return res.status(404).json({ error: 'unknown project' });
  res.json(tree);
});

app.post('/projects/:pid/team/interpret', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty intent' });
  const effort = String(req.body?.effort || 'high');
  try {
    const result = await runTeamVoice({
      projectId: req.params.pid,
      text,
      effort,
      cancelToken: req.body?.cancelToken ? String(req.body.cancelToken) : null,
    });
    res.json(result);
  } catch (err) {
    console.error(`[team:${req.params.pid}]`, err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/projects/:pid/health', async (req, res) => {
  if (!getProject(req.params.pid)) return res.status(404).json({ error: 'unknown project' });
  const snap = await healthSnapshot(req.params.pid);
  res.json({ ...snap, metrics: snapshotMetrics() });
});

app.get('/projects/:pid/file/*', (req, res) => {
  try {
    const body = readProjectFile(req.params.pid, req.params[0]);
    res.json({ path: req.params[0], body });
  } catch (err) {
    const msg = String(err.message);
    res.status(msg === 'not found' ? 404 : 400).json({ error: msg });
  }
});

migrateLegacyOnce();
rescheduleAutosave();
migrateCharterFilenames();
cleanupStale();
await hydrateSecretsIntoEnv();

// Bind to loopback only: the API is unauthenticated and some endpoints lead to
// code execution (scaffold → Docker), so it must not be reachable from the LAN.
// The renderer loads http://127.0.0.1:${PORT}/ (see app/electron/main.js), so
// loopback binding is transparent to the app.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[bridge] orchestrator listening on http://127.0.0.1:${PORT}`);
  console.log(`[bridge] renderer at http://127.0.0.1:${PORT}/`);
  // Resume any runs orphaned by the last shutdown/crash — requeue in_progress
  // tasks, re-kick stuck kickoffs, restart the drain loops.
  try { recoverOnBoot(); } catch (err) { console.warn('[recovery] boot sweep failed:', err?.message); }
});

process.on('unhandledRejection', (err) => {
  console.warn('[server] unhandledRejection:', err?.message || err);
});
