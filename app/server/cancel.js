// app/server/cancel.js
/* Lightweight cancellation registry for long-running server flows.
 * Tokens are generated per operation and can be cancelled from the UI.
 */

import { randomUUID } from 'node:crypto';

const TOKENS = new Map(); // token -> { canceled, reason, at, kind, projectId, ownerAgentId, controller }

export function createCancelToken(meta = {}) {
  const token = randomUUID();
  const controller = new AbortController();
  TOKENS.set(token, {
    canceled: false,
    reason: '',
    at: Date.now(),
    kind: String(meta.kind || ''),
    projectId: String(meta.projectId || ''),
    ownerAgentId: String(meta.ownerAgentId || ''),
    controller,
  });
  return token;
}

export function cancelToken(token, reason = 'Canceled by user') {
  const rec = TOKENS.get(String(token || '').trim());
  if (!rec) return false;
  rec.canceled = true;
  rec.reason = String(reason || 'Canceled by user').slice(0, 240);
  rec.canceledAt = Date.now();
  rec.controller?.abort?.(rec.reason);
  return true;
}

export function tokenStatus(token) {
  const rec = TOKENS.get(String(token || '').trim());
  if (!rec) return null;
  const { controller, ...safe } = rec;
  return { ...safe };
}

export function throwIfCanceled(token) {
  if (!token) return;
  const rec = TOKENS.get(token);
  if (rec?.canceled) {
    const e = new Error(rec.reason || 'Canceled by user');
    e.code = 'CANCELED';
    throw e;
  }
}

export function tokenSignal(token) {
  if (!token) return null;
  const rec = TOKENS.get(String(token || '').trim());
  return rec?.controller?.signal || null;
}

export function completeToken(token) {
  if (!token) return;
  TOKENS.delete(token);
}

export function cleanupStale(maxAgeMs = 60 * 60 * 1000) {
  const now = Date.now();
  for (const [k, v] of TOKENS) {
    if ((now - (v.canceledAt || v.at || now)) > maxAgeMs) TOKENS.delete(k);
  }
}
