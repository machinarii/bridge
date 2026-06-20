// app/renderer/health.js
/* Settings -> Health tab rendering and polling. */

function statusLabel(s) {
  if (!s) return 'Unknown';
  if (s.ok) return 'OK';
  if (s.status === 'missing') return 'Missing';
  return 'Error';
}

function statusClass(s) {
  if (!s) return 'unknown';
  if (s.ok) return 'ok';
  if (s.status === 'missing') return 'warn';
  return 'err';
}

function row(name, s) {
  const cls = statusClass(s);
  return `
    <div class="health-row health-${cls}">
      <div class="health-name">${name}</div>
      <div class="health-state">${statusLabel(s)}</div>
      <div class="health-detail">${s?.detail ? String(s.detail) : '—'}</div>
    </div>`;
}

export function renderHealth(el, payload = {}) {
  if (!el) return;
  const m = payload.metrics || {};
  const stamp = payload.at ? new Date(payload.at).toLocaleTimeString() : '—';
  el.innerHTML = `
    <div class="health-head">
      <div class="health-stamp">Updated: ${stamp}</div>
      <div class="health-meta">Uptime: ${Number(m.uptimeSec || 0)}s · Requests: ${Number(m.requests || 0)} · Canceled: ${Number(m.canceled || 0)}</div>
      <div class="health-meta">Secret storage: ${payload.keychain ? 'macOS Keychain + env fallback' : 'env fallback'}</div>
    </div>
    ${row('OpenRouter', payload.openrouter)}
    ${row('Local STT', payload.stt)}
    ${row('Docker daemon', payload.docker)}
    ${row('GitHub auth', payload.github)}
  `;
}

export async function fetchHealth() {
  const r = await fetch('/health/system');
  if (!r.ok) throw new Error(`health ${r.status}`);
  return r.json();
}
