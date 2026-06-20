// app/server/secrets.js
/* Secret storage facade.
 * Priority: macOS Keychain via `security` CLI -> process.env/.env fallback.
 */

import { execFile } from 'node:child_process';

const SERVICE = 'Bridge';
const ACCOUNTS = {
  OPENROUTER_API_KEY: 'openrouter_api_key',
  GITHUB_TOKEN: 'github_token',
};

function securityAvailable() {
  return process.platform === 'darwin';
}

function runSecurity(args) {
  return new Promise((resolve) => {
    execFile('security', args, { timeout: 5000 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function keychainRead(account) {
  if (!securityAvailable()) return null;
  const r = await runSecurity(['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
  if (r.err) return null;
  return r.stdout.trim() || null;
}

async function keychainWrite(account, value) {
  if (!securityAvailable()) return false;
  // delete any existing item first so add is deterministic
  await runSecurity(['delete-generic-password', '-s', SERVICE, '-a', account]);
  const r = await runSecurity(['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', String(value || '')]);
  return !r.err;
}

async function keychainDelete(account) {
  if (!securityAvailable()) return false;
  const r = await runSecurity(['delete-generic-password', '-s', SERVICE, '-a', account]);
  return !r.err;
}

export async function readSecret(name) {
  const account = ACCOUNTS[name];
  if (!account) return process.env[name] || '';
  const kc = await keychainRead(account);
  if (kc) return kc;
  return process.env[name] || '';
}

export async function writeSecret(name, value) {
  const account = ACCOUNTS[name];
  const v = String(value || '');
  process.env[name] = v;
  if (!account) return false;
  return keychainWrite(account, v);
}

export async function deleteSecret(name) {
  const account = ACCOUNTS[name];
  delete process.env[name];
  if (!account) return false;
  return keychainDelete(account);
}

export async function hydrateSecretsIntoEnv() {
  for (const [envName, account] of Object.entries(ACCOUNTS)) {
    if (process.env[envName]) continue;
    const v = await keychainRead(account);
    if (v) process.env[envName] = v;
  }
}

export function keychainEnabled() {
  return securityAvailable();
}
