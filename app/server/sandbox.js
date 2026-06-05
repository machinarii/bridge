// app/server/sandbox.js
/* Bridge — the ONLY Docker integration. Runs a shell script inside a throwaway
 * container with the project repo bind-mounted (source stays local) and
 * node_modules kept container-only (an anonymous volume overlay so Linux install
 * artifacts never pollute the host repo). No project logic lives here. */
import { spawn } from 'node:child_process';

const DEFAULT_IMAGE = 'node:20-slim';

/** Build the `docker run` argv (pure — unit-tested without Docker). */
export function dockerArgs(repoPath, { image = DEFAULT_IMAGE, script = '' } = {}) {
  return [
    'run', '--rm',
    '-v', `${repoPath}:/app`,
    '-v', '/app/node_modules',           // container-only node_modules overlay
    '-w', '/app',
    '--memory=2g', '--cpus=2',
    image, 'sh', '-lc', script,
  ];
}

const DAEMON_DOWN_RE = /cannot connect to the docker daemon|is the docker daemon running/i;

/** Run a script in the container. Returns { exitCode, output, timedOut, daemonDown }.
 * Never rejects — failures are reported in the result. `_bin`/`_args` override the
 * docker invocation for tests. */
export function runInContainer(repoPath, {
  image, script, timeoutMs = 600_000, _bin = 'docker', _args,
} = {}) {
  const args = _args || dockerArgs(repoPath, { image, script });
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    const finish = (res) => { if (!settled) { settled = true; clearTimeout(timer); resolve(res); } };

    let child;
    try { child = spawn(_bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (err) { return resolve({ exitCode: -1, output: String(err?.message || err), timedOut: false, daemonDown: DAEMON_DOWN_RE.test(String(err)) }); }

    const onData = (d) => { output += d.toString(); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs);

    child.on('error', (err) => finish({ exitCode: -1, output: output + String(err?.message || err), timedOut, daemonDown: DAEMON_DOWN_RE.test(output + String(err)) }));
    child.on('close', (code) => finish({ exitCode: timedOut ? -1 : (code ?? -1), output, timedOut, daemonDown: DAEMON_DOWN_RE.test(output) }));
  });
}
