import express from 'express';
import { migrateLegacyOnce } from './scratchpad.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { listRoles } from './roles.js';
import { listSkills, getSkill, withSkillEnabled } from './skills.js';
import { listProjects, getProject, createProject, setAgentEnabled, addAgent, renameProject, deleteProject } from './projects.js';
import { listNotes, readNote, appendNote } from './backends/notes.js';
import { interpretIntent } from './orchestrator.js';
import { setLastSpec, getContext, lastActivityAt } from './scratchpad.js';
import { runTeamVoice } from './team.js';
import {
  notifyStateChange, rescheduleAutosave, initProjectRepo, autosaveStatus,
} from './autosave.js';
import { subscribe as subscribeEvents, publish as publishEvent } from './events.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = resolve(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// Default to the bundled local Parakeet STT so voice works out of the box on
// first launch. The renderer health-gates this (GET /stt-health) and silently
// falls back to the browser speech engine when the sidecar isn't reachable, so
// defaulting it on never breaks voice if Parakeet is absent.
if (!process.env.LOCAL_STT_URL) {
  process.env.LOCAL_STT_URL = `http://127.0.0.1:${process.env.PARAKEET_PORT || 8123}/transcribe`;
}

const PORT = Number(process.env.PORT || 4317);
const RENDERER_DIR = resolve(__dirname, '..', 'renderer');
const ASSETS_DIR   = resolve(__dirname, '..', 'assets');
const STATE_DIR = resolve(__dirname, '..', 'state');

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use('/assets', express.static(ASSETS_DIR, { maxAge: '1d', immutable: true }));
app.use(express.static(RENDERER_DIR));

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
  'MCP_PLUGINS',                // JSON: [{ id, name, enabled }]
  'SKILLS_DISABLED',            // JSON: [skillId, ...] (deactivated skills)
  'GIT_AUTOSAVE',               // "on" | "off"
  'GIT_AUTOSAVE_INTERVAL_MIN',  // integer
  'LOCAL_STT_URL',              // e.g. http://localhost:8123/transcribe
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

app.get('/settings', (_req, res) => {
  res.json({
    OPENROUTER_API_KEY: maskKey(process.env.OPENROUTER_API_KEY || ''),
    OPENROUTER_API_KEY_SET: !!process.env.OPENROUTER_API_KEY,
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'anthropic/claude-opus-4.7',
    OPENROUTER_MODEL_BY_ROLE: parseJsonEnv('OPENROUTER_MODEL_BY_ROLE', {}),
    MCP_PLUGINS: parseJsonEnv('MCP_PLUGINS', []),
    GIT_AUTOSAVE: (process.env.GIT_AUTOSAVE || 'off') === 'on',
    GIT_AUTOSAVE_INTERVAL_MIN: Number(process.env.GIT_AUTOSAVE_INTERVAL_MIN || 5),
    LOCAL_STT_URL: process.env.LOCAL_STT_URL || '',
  });
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
 * decide whether to use local Parakeet or fall back to the browser engine. */
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

app.put('/settings', (req, res) => {
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
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no updates' });
    writeEnvFile(updates);
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

app.get('/projects', (_req, res) => {
  // Enrich each project with the most-recent scratchpad activity
  // across its agents. Falls back to createdAt when there's nothing
  // logged yet so the UI always has something to render.
  const enriched = listProjects().map(p => {
    const agentIds = p.agents.map(a => a.id);
    const last = lastActivityAt(agentIds);
    return { ...p, updatedAt: last || p.createdAt };
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
const NAME_LIMIT = 40;
async function shortenViaLLM(name) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes('replace-me')) {
    return { name: name.slice(0, NAME_LIMIT).trim(), shortened: false, reason: 'no_key' };
  }
  const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-opus-4.7';
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
    const { name, goal, roleIds, topology } = req.body || {};
    const p = await createProject({ name, goal, roleIds, topology });
    initProjectRepo(p.id).then(() => notifyStateChange(p.id, 'Project created'));
    publishEvent({
      type: 'notification',
      kind: 'info',
      projectId: p.id,
      title: 'Project created',
      body: `${p.name} · ${p.agents.length} agent${p.agents.length === 1 ? '' : 's'} assembled.`,
    });
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

app.post('/projects/:pid/agents/:aid/interpret', async (req, res) => {
  const { pid, aid } = req.params;
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty intent' });
  try {
    const spec = await interpretIntent({ projectId: pid, agentId: aid, text });
    setLastSpec(aid, spec);
    res.json(spec);
  } catch (err) {
    console.error(`[interpret:${aid}]`, err);
    res.status(500).json({ error: String(err?.message || err) });
  }
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

app.get('/projects/:pid/files', (req, res) => {
  const p = getProject(req.params.pid);
  if (!p) return res.status(404).json({ error: 'unknown project' });
  const projDir = resolve(STATE_DIR, p.id);
  function fileEntry(absPath, kind) {
    const stat = statSync(absPath);
    return { path: absPath.replace(projDir + '/', ''), kind, mtime: stat.mtimeMs };
  }
  const charters = readdirSync(resolve(projDir, 'roles'))
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const roleId = f.replace(/\.md$/, '');
      const agent = p.agents.find(a => a.role === roleId);
      return { ...fileEntry(resolve(projDir, 'roles', f), 'charter'), roleId, agentName: agent?.name || '' };
    });
  const notes = readdirSync(resolve(projDir, 'notes'))
    .filter(f => f.endsWith('.md'))
    .sort().reverse()
    .map(f => ({ ...fileEntry(resolve(projDir, 'notes', f), 'note') }));
  res.json({ projectMd: 'project.md', charters, notes });
});

app.post('/projects/:pid/team/interpret', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty intent' });
  try {
    const result = await runTeamVoice({ projectId: req.params.pid, text });
    res.json(result);
  } catch (err) {
    console.error(`[team:${req.params.pid}]`, err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/projects/:pid/file/*', (req, res) => {
  const p = getProject(req.params.pid);
  if (!p) return res.status(404).json({ error: 'unknown project' });
  const rel = req.params[0];
  if (rel.includes('..')) return res.status(400).json({ error: 'bad path' });
  const path = resolve(STATE_DIR, p.id, rel);
  if (!existsSync(path)) return res.status(404).json({ error: 'not found' });
  res.json({ path: rel, body: readFileSync(path, 'utf8') });
});

migrateLegacyOnce();
rescheduleAutosave();

app.listen(PORT, () => {
  console.log(`[bridge] orchestrator listening on http://localhost:${PORT}`);
  console.log(`[bridge] renderer at http://localhost:${PORT}/`);
});
