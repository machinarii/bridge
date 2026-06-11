/* Bridge — central state-dir resolution. The cross-project registry files
 * (projects.json, tasks.json, scratchpad.json) live here. Defaults to
 * ~/bridge-projects/.bridge/ so ALL Bridge data — the registry plus the
 * per-project repos beside it — lives under ~/bridge-projects, never inside
 * the app bundle (writes into a packaged .app break code signing, are wiped
 * on update, and fail under Gatekeeper app translocation).
 *
 * Tests redirect everything to a throwaway dir via BRIDGE_STATE_DIR.
 */

import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Where state lived before ~/bridge-projects/.bridge: app/state next to the
// server code (inside the .app bundle when packaged).
const LEGACY_STATE_DIR = resolve(__dirname, '..', 'state');
const REGISTRY_FILES = ['projects.json', 'tasks.json', 'scratchpad.json'];

export function stateDir() {
  return process.env.BRIDGE_STATE_DIR || join(homedir(), 'bridge-projects', '.bridge');
}

let migrationChecked = false;

/** mkdir -p the state dir and, once per process, copy any registry files
 * still sitting in the legacy app/state/ location (never overwriting files
 * already in the new home). Skipped entirely when BRIDGE_STATE_DIR is set,
 * so tests never inherit real data. Returns the dir. */
export function ensureStateDir() {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  if (migrationChecked || process.env.BRIDGE_STATE_DIR) return dir;
  migrationChecked = true;
  for (const f of REGISTRY_FILES) {
    const src = join(LEGACY_STATE_DIR, f);
    const dst = join(dir, f);
    if (existsSync(src) && !existsSync(dst)) {
      try {
        copyFileSync(src, dst);
        console.log(`[state] migrated ${f} from legacy app/state/ to ${dir}`);
      } catch (err) {
        console.warn(`[state] could not migrate ${f}: ${err.message}`);
      }
    }
  }
  return dir;
}
