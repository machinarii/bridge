import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { interpretIntent } from './orchestrator.js';
import { listNotes, readNote, appendNote } from './backends/notes.js';
import { AGENTS, isValidAgent } from './agents.js';
import { getContext, setLastSpec, reset, all as allContext } from './scratchpad.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = resolve(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const PORT = Number(process.env.PORT || 4317);
const RENDERER_DIR = resolve(__dirname, '..', 'renderer');

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(RENDERER_DIR));

app.get('/agents', (_req, res) => {
  const ctx = allContext();
  res.json({
    agents: AGENTS.map(a => ({
      ...a,
      lastSpec: ctx[a.id]?.lastSpec || null,
      turnCount: ctx[a.id]?.messages?.length || 0,
      updatedAt: ctx[a.id]?.updatedAt || null,
    })),
  });
});

app.get('/agents/:id', (req, res) => {
  if (!isValidAgent(req.params.id)) return res.status(404).json({ error: 'unknown agent' });
  const ctx = getContext(req.params.id);
  res.json({ id: req.params.id, lastSpec: ctx.lastSpec, turnCount: ctx.messages.length });
});

app.post('/agents/:id/interpret', async (req, res) => {
  const agentId = req.params.id;
  if (!isValidAgent(agentId)) return res.status(404).json({ error: 'unknown agent' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty intent' });
  try {
    const spec = await interpretIntent(agentId, text);
    setLastSpec(agentId, spec);
    res.json(spec);
  } catch (err) {
    console.error(`[interpret:${agentId}] error:`, err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post('/agents/:id/spec', (req, res) => {
  const agentId = req.params.id;
  if (!isValidAgent(agentId)) return res.status(404).json({ error: 'unknown agent' });
  setLastSpec(agentId, req.body?.spec || null);
  res.json({ ok: true });
});

app.post('/agents/:id/reset', (req, res) => {
  if (!isValidAgent(req.params.id)) return res.status(404).json({ error: 'unknown agent' });
  reset(req.params.id);
  res.json({ ok: true });
});

app.get('/notes',          (_req, res) => res.json({ items: listNotes() }));
app.get('/notes/:id',      (req, res) => {
  const body = readNote(req.params.id);
  if (body == null) return res.status(404).json({ error: 'not found' });
  res.json({ id: req.params.id, body });
});
app.post('/notes', (req, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'empty note' });
  res.json(appendNote(body));
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[bridge] orchestrator listening on http://localhost:${PORT}`);
  console.log(`[bridge] renderer at http://localhost:${PORT}/`);
  console.log(`[bridge] agents: ${AGENTS.map(a => a.name).join(', ')}`);
});
