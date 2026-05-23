import express from 'express';
import { migrateLegacyOnce } from './scratchpad.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { listRoles } from './roles.js';
import { listProjects, getProject, createProject, setAgentEnabled } from './projects.js';

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

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/roles', (_req, res) => {
  res.json({ roles: listRoles() });
});

app.get('/projects', (_req, res) => {
  res.json({ projects: listProjects() });
});

app.get('/projects/:pid', (req, res) => {
  const p = getProject(req.params.pid);
  if (!p) return res.status(404).json({ error: 'unknown project' });
  res.json(p);
});

app.post('/projects', async (req, res) => {
  try {
    const { name, goal, roleIds } = req.body || {};
    const p = await createProject({ name, goal, roleIds });
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

migrateLegacyOnce();

app.listen(PORT, () => {
  console.log(`[bridge] orchestrator listening on http://localhost:${PORT}`);
  console.log(`[bridge] renderer at http://localhost:${PORT}/`);
});
