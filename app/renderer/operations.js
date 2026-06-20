// app/renderer/operations.js
/* Client helpers for long-running operation tokens and cancellation. */

export async function createOperationToken(meta = {}) {
  const r = await fetch('/operations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta),
  });
  if (!r.ok) throw new Error(`operations ${r.status}`);
  const d = await r.json();
  return d.token || null;
}

export async function cancelOperation(token, reason = 'Canceled by user') {
  if (!token) return false;
  const r = await fetch(`/operations/${encodeURIComponent(token)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!r.ok) return false;
  const d = await r.json();
  return !!d.ok;
}
