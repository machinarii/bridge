/* Bridge — GitHub pairing via OAuth Device Flow.
 *
 * Keyboard-free by design (see memory: accessibility-first). The renderer shows
 * a short code + a pre-filled verification link (and a QR for phones); the user
 * authorizes on github.com and the server polls for the token, stores it, and
 * does all git ops server-side.
 *
 * Requires a GitHub OAuth App client id in GITHUB_OAUTH_CLIENT_ID (the app must
 * have "Device Flow" enabled). The resulting token + login are persisted via the
 * injected `persist({ token, login })` callback (writes the .env).
 */

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL       = 'https://github.com/login/oauth/access_token';
const USER_URL        = 'https://api.github.com/user';
const SCOPE           = 'repo';

let pending = null;       // { deviceCode, interval, expiresAt, status, error }
let _persist = () => {};  // injected by the server to write token/login to .env

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function setGithubPersist(fn) { if (typeof fn === 'function') _persist = fn; }

export function githubStatus() {
  return {
    configured: !!process.env.GITHUB_OAUTH_CLIENT_ID,
    connected:  !!process.env.GITHUB_TOKEN,
    login:      process.env.GITHUB_LOGIN || null,
    pending:    pending ? { status: pending.status, error: pending.error || null } : null,
  };
}

/** Begin the device flow. Returns the user code + verification URLs and kicks
 *  off a background poll for the token. */
export async function startDeviceFlow() {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) throw new Error('GITHUB_OAUTH_CLIENT_ID is not set');
  const r = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: SCOPE }),
  });
  if (!r.ok) throw new Error(`device-code request failed (${r.status})`);
  const d = await r.json();
  if (d.error) throw new Error(d.error_description || d.error);

  pending = {
    deviceCode: d.device_code,
    interval:   Math.max(1, d.interval || 5),
    expiresAt:  Date.now() + (d.expires_in || 900) * 1000,
    status:     'pending',
    error:      null,
  };
  pollForToken(clientId).catch(() => {});  // fire-and-forget

  return {
    user_code: d.user_code,
    verification_uri: d.verification_uri,
    verification_uri_complete:
      d.verification_uri_complete ||
      `${d.verification_uri}?user_code=${encodeURIComponent(d.user_code)}`,
    expires_in: d.expires_in,
  };
}

async function pollForToken(clientId) {
  while (pending && pending.status === 'pending') {
    if (Date.now() > pending.expiresAt) { pending.status = 'error'; pending.error = 'expired'; return; }
    await sleep(pending.interval * 1000);
    if (!pending || pending.status !== 'pending') return;
    let d;
    try {
      const r = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          device_code: pending.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      d = await r.json();
    } catch { continue; /* transient — keep polling until expiry */ }

    if (d.access_token) {
      const login = await fetchLogin(d.access_token).catch(() => null);
      try { _persist({ token: d.access_token, login }); } catch {}
      pending.status = 'connected';
      return;
    }
    switch (d.error) {
      case 'authorization_pending': break;            // keep waiting
      case 'slow_down':             pending.interval += 5; break;
      case 'expired_token':         pending.status = 'error'; pending.error = 'expired'; return;
      case 'access_denied':         pending.status = 'error'; pending.error = 'denied';  return;
      default:                      if (d.error) { pending.status = 'error'; pending.error = d.error; return; }
    }
  }
}

async function fetchLogin(token) {
  const r = await fetch(USER_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Bridge' },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.login || null;
}

export function disconnectGithub() {
  pending = null;
  try { _persist({ token: '', login: '' }); } catch {}
  return githubStatus();
}
