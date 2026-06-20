// app/server/health.js
/* Runtime health probes surfaced to Settings -> Health panel. */

import { execFile } from 'node:child_process';
import { getProject } from './projects.js';
import { keychainEnabled } from './secrets.js';

function run(cmd, args = [], timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function checkOpenRouter() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, status: 'missing', detail: 'API key not set' };
  try {
    const r = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) return { ok: true, status: 'ok', detail: 'reachable and key valid' };
    return { ok: false, status: 'error', detail: `HTTP ${r.status}` };
  } catch (err) {
    return { ok: false, status: 'error', detail: String(err?.message || err) };
  }
}

async function checkStt() {
  const target = process.env.LOCAL_STT_URL;
  if (!target) return { ok: false, status: 'missing', detail: 'LOCAL_STT_URL not set' };
  const healthUrl = target.replace(/\/transcribe\/?$/, '/health');
  try {
    const r = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
    return r.ok
      ? { ok: true, status: 'ok', detail: healthUrl }
      : { ok: false, status: 'error', detail: `HTTP ${r.status}` };
  } catch (err) {
    return { ok: false, status: 'error', detail: String(err?.message || err) };
  }
}

async function checkDocker() {
  const r = await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (!r.ok) return { ok: false, status: 'error', detail: (r.stderr || r.err?.message || 'docker unavailable').trim().slice(0, 240) };
  return { ok: true, status: 'ok', detail: `server ${r.stdout.trim() || 'reachable'}` };
}

async function checkGitHub() {
  const token = process.env.GITHUB_TOKEN;
  if (token) return { ok: true, status: 'ok', detail: `connected${process.env.GITHUB_LOGIN ? ` as ${process.env.GITHUB_LOGIN}` : ''}` };
  return { ok: false, status: 'missing', detail: 'not connected' };
}

export async function healthSnapshot(projectId = null) {
  const [openrouter, stt, docker, github] = await Promise.all([
    checkOpenRouter(),
    checkStt(),
    checkDocker(),
    checkGitHub(),
  ]);
  const project = projectId ? getProject(projectId) : null;
  return {
    at: Date.now(),
    keychain: keychainEnabled(),
    openrouter,
    stt,
    docker,
    github,
    ...(project ? { project: { id: project.id, name: project.name } } : {}),
  };
}
