import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { interpretIntent } from './orchestrator.js';
import { listNotes, readNote, appendNote } from './backends/notes.js';

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

app.post('/interpret', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty intent' });
  try {
    const spec = await interpretIntent(text);
    res.json(spec);
  } catch (err) {
    console.error('[interpret] error:', err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/notes', (req, res) => {
  res.json({ items: listNotes() });
});

app.get('/notes/:id', (req, res) => {
  const body = readNote(req.params.id);
  if (body == null) return res.status(404).json({ error: 'not found' });
  res.json({ id: req.params.id, body });
});

app.post('/notes', (req, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'empty note' });
  const saved = appendNote(body);
  res.json(saved);
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[bridge] orchestrator listening on http://localhost:${PORT}`);
  console.log(`[bridge] renderer at http://localhost:${PORT}/`);
});
