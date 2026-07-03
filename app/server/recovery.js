/* Bridge — boot-time run recovery. Before this module, a server restart or
 * crash turned every mid-flight run into a permanent zombie: executor tasks
 * stuck `in_progress` were never re-drained (the pool only pulls `queued`),
 * and a kickoff that died at `running`/`drafting` could never re-run past the
 * executeKickoff re-entry guard. The UI showed "running" forever with no error.
 *
 * recoverOnBoot() sweeps once at startup:
 *   - in_progress tasks → queued (attempts left) or failed ("orphaned by restart")
 *   - kickoff running   → status cleared to 'stalled', executeKickoff re-runs
 *     (doc generation never clobbers existing content, so re-running is safe)
 *   - kickoff drafting  → status reset to 'idle', startKickoff re-runs
 *   - every project with queued tasks gets its drain loop kicked
 * User-waiting states (awaiting_approval, asking, team_review, build_pending,
 * run_pending, blocked_on_user) are left alone — they're waiting, not dead. */

import { listProjects, getKickoff, setKickoff } from './projects.js';
import { listAllTasks, updateTask } from './tasks.js';
import { drain } from './executor.js';
import { startKickoff, executeKickoff } from './kickoff.js';
import { emitNotification } from './events.js';

const MAX_ATTEMPTS = 2;   // mirrors executor.js

export function recoverOnBoot({
  drainFn = drain,
  executeKickoffFn = executeKickoff,
  startKickoffFn = startKickoff,
  notify = emitNotification,
} = {}) {
  const result = { requeued: 0, failed: 0, kickoffsResumed: 0, projectsDrained: 0 };
  const toDrain = new Set();

  for (const t of listAllTasks()) {
    if (t.status !== 'in_progress') continue;
    if (t.attempts < MAX_ATTEMPTS) {
      updateTask(t.id, { status: 'queued' });
      result.requeued++;
      toDrain.add(t.projectId);
    } else {
      updateTask(t.id, { status: 'failed', output: 'orphaned by server restart' });
      result.failed++;
    }
  }

  for (const p of listProjects()) {
    const k = getKickoff(p.id);
    if (k.status === 'running') {
      // Clear the stuck status so executeKickoff's re-entry guard lets it run.
      setKickoff(p.id, { status: 'stalled' });
      result.kickoffsResumed++;
      executeKickoffFn(p.id).catch(err => console.warn(`[recovery] kickoff resume ${p.id}:`, err?.message));
    } else if (k.status === 'drafting') {
      setKickoff(p.id, { status: 'idle' });
      result.kickoffsResumed++;
      startKickoffFn(p.id).catch(err => console.warn(`[recovery] kickoff restart ${p.id}:`, err?.message));
    }
  }

  for (const pid of toDrain) {
    result.projectsDrained++;
    Promise.resolve(drainFn(pid)).catch(err => console.warn(`[recovery] drain ${pid}:`, err?.message));
  }

  const touched = result.requeued + result.failed + result.kickoffsResumed;
  if (touched) {
    console.log(`[recovery] resumed after restart: ${result.requeued} task(s) requeued, ${result.failed} failed, ${result.kickoffsResumed} kickoff(s) resumed`);
    notify({
      kind: 'info',
      title: 'Resumed after restart',
      body: `${result.requeued} task${result.requeued === 1 ? '' : 's'} requeued, ${result.kickoffsResumed} kickoff${result.kickoffsResumed === 1 ? '' : 's'} resumed${result.failed ? `, ${result.failed} marked failed` : ''}.`,
    });
  }
  return result;
}
