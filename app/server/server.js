import express from 'express';
import { migrateLegacyOnce } from './scratchpad.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

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

migrateLegacyOnce();

app.listen(PORT, () => {
  console.log(`[bridge] orchestrator listening on http://localhost:${PORT}`);
  console.log(`[bridge] renderer at http://localhost:${PORT}/`);
});
