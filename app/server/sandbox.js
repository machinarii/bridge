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
