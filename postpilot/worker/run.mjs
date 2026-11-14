// Postpilot worker entry point: `node postpilot/worker/run.mjs` (GitHub Actions cron + dispatch).
//
// Runs every job in a fixed order. Each job is isolated: an error is recorded in the run summary and
// the encrypted activity log, and the next job still runs. Console output is public (Actions logs of
// a public repo), so it only ever contains counts and generic status lines.

import { pathToFileURL } from 'node:url';
import { ConfigError, createContext, describeError, errorKind, isIgAuth, LOG_ENTRY_CAP, RUN_CAP } from './context.mjs';
import { sendNotifications } from './notify.mjs';
import token, { markExpired } from './jobs/token.mjs';
import outbox from './jobs/outbox.mjs';
import publish from './jobs/publish.mjs';
import feeds from './jobs/feeds.mjs';
import evergreen from './jobs/evergreen.mjs';
import autopilot from './jobs/autopilot.mjs';
import automations from './jobs/automations.mjs';
import invites from './jobs/invites.mjs';
import stories from './jobs/stories.mjs';
import analytics from './jobs/analytics.mjs';
import competitors from './jobs/competitors.mjs';
import reports from './jobs/reports.mjs';
import bio from './jobs/bio.mjs';
import housekeeping from './jobs/housekeeping.mjs';
import maintenance from './jobs/maintenance.mjs';

export const NOT_CONFIGURED_MESSAGE = 'Postpilot worker is not configured yet (POSTPILOT_DATA_KEY secret missing).';

/** [name, fn, needsInstagram] in run order. */
export const JOBS = [
  ['token', token, true],
  ['outbox', outbox, false],
  ['publish', publish, false], // runs without Instagram too: reminder posts need no connection (the job skips the rest)
  ['feeds', feeds, false],
  ['evergreen', evergreen, false],
  ['autopilot', autopilot, false],
  ['automations', automations, true],
  ['invites', invites, true],
  ['stories', stories, true],
  ['analytics', analytics, true],
  ['competitors', competitors, true],
  ['reports', reports, false],
  ['bio', bio, true],
  ['housekeeping', housekeeping, false],
  ['maintenance', maintenance, false],
];

/** Jobs that still run while the worker is paused in Settings (maintenance only). */
const RUN_WHEN_PAUSED = new Set(['token', 'housekeeping', 'maintenance']);

/** Counts that make a run worth recording even when nothing failed. */
const ACTIVITY_KEYS = new Set([
  'published',
  'failed',
  'pending',
  'retried',
  'commands',
  'commandsFailed',
  'evergreenCreated',
  'autopilotCreated',
  'replies',
  'privateReplies',
  'dms',
  'hidden',
  'deleted',
  'aiReplies',
  'tokenRefreshed',
  'reminded',
  'feedItems',
  'reportsCreated',
  'invitesAccepted',
  'invitesNew',
  'downloaded',
  'downloadFailed',
]);

/** Count keys every stored run record carries (others are stored only when non-zero). */
export const CORE_COUNTS = ['published', 'failed', 'replies', 'dms', 'hidden', 'stories', 'snapshots'];

/**
 * Write a run record at least this often even when nothing happened (worker heartbeat). The app
 * shows "Worker is late" when the newest record is older than 90 minutes, which leaves 30 minutes
 * for GitHub's delays of scheduled runs. Every write stores the whole encrypted log document again
 * (up to about 150 KB), so idle runs in between are not recorded unless they logged something.
 */
export const HEARTBEAT_MS = 60 * 60 * 1000;

const SKIP_TEXT = {
  not_connected: 'Instagram not connected',
  paused: 'worker paused in Settings',
  disabled: 'turned off',
  not_due: 'not due yet',
  nothing_due: 'nothing due',
  token_expired: 'Instagram login expired',
  needs_facebook_login: 'needs Facebook Login',
  unsupported: 'not supported for this account',
  no_ai: 'AI not configured',
  no_time: 'out of time this run',
};

function humanize(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

/** One public console line per job: numbers and fixed reason codes only. */
export function formatJobLine(name, result) {
  if (!result || typeof result !== 'object') return `${name}: done`;
  if (result.skipped) return `${name}: skipped (${SKIP_TEXT[result.skipped] || 'nothing to do'})`;
  const parts = Object.entries(result)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
    .map(([k, v]) => `${v} ${humanize(k)}`);
  return `${name}: ${parts.length ? parts.join(', ') : 'done'}`;
}

function sumCounts(jobs) {
  const counts = {};
  for (const res of Object.values(jobs)) {
    if (!res || typeof res !== 'object') continue;
    for (const [k, v] of Object.entries(res)) if (typeof v === 'number' && Number.isFinite(v)) counts[k] = (counts[k] || 0) + v;
  }
  return counts;
}

/**
 * Run the worker once.
 * @param {{env?: object, fetchImpl?: Function, now?: string|number|Date|Function, log?: Function, maxWaitSec?: number, only?: string[]}} opts
 * @returns {Promise<{ok: boolean, exitCode: number, summary: object}>}
 */
export async function runWorker({ env = process.env, fetchImpl, now, log: consoleLog = console.log, maxWaitSec, only } = {}) {
  if (!env.POSTPILOT_DATA_KEY) {
    consoleLog(NOT_CONFIGURED_MESSAGE);
    return { ok: true, exitCode: 0, summary: { configured: false } };
  }

  let ctx;
  try {
    ctx = await createContext({ env, fetchImpl, now, consoleLog, maxWaitSec });
  } catch (err) {
    if (err instanceof ConfigError) {
      consoleLog(err.publicMessage);
      return { ok: !err.fatal, exitCode: err.fatal ? 1 : 0, summary: { configured: false, reason: err.code } };
    }
    consoleLog(`Postpilot worker could not start (${errorKind(err)}).`);
    return { ok: false, exitCode: 1, summary: { configured: true, error: true } };
  }

  const startedAt = ctx.nowIso();
  const realStart = Date.now();
  ctx.say(`Postpilot worker started (${ctx.trigger === 'schedule' ? 'scheduled run' : ctx.trigger === 'workflow_dispatch' ? 'started from the app' : 'manual run'}).`);

  const paused = ctx.settings.worker && ctx.settings.worker.enabled === false;
  if (paused) ctx.say('The worker is paused in Settings; only maintenance jobs run.');

  const jobs = {};
  const errors = [];
  let saidNotConnected = false;
  for (const [name, fn, needsIg] of JOBS) {
    if (only && !only.includes(name)) continue;
    if (paused && !RUN_WHEN_PAUSED.has(name)) {
      jobs[name] = { skipped: 'paused' };
      continue;
    }
    if (needsIg && !ctx.ig) {
      const expired = ctx.settings.ig?.status?.state === 'expired';
      jobs[name] = { skipped: expired ? 'token_expired' : 'not_connected' };
      if (!saidNotConnected) {
        ctx.say(expired ? 'Instagram login has expired; reconnect it in Settings. Instagram jobs skipped.' : 'Instagram is not connected; Instagram jobs skipped.');
        saidNotConnected = true;
      }
      continue;
    }
    try {
      const res = (await fn(ctx)) || {};
      jobs[name] = res;
      ctx.say(formatJobLine(name, res));
    } catch (err) {
      if (isIgAuth(err) && ctx.ig && ctx.settings.ig) {
        // Instagram rejected the login mid-run (revoked after the token job's daily check): record it
        // as the token job does (reconnect banner, one 'account' push, a single log entry) and skip
        // Instagram for the rest of this run; later runs skip it until the token job's recheck.
        try {
          jobs[name] = { error: true, ...(await markExpired(ctx, ctx.settings.ig, err)) };
          ctx.say(formatJobLine(name, jobs[name]));
          continue;
        } catch {
          // Could not save the status: report the job error as usual (Instagram is skipped anyway).
        }
      }
      const message = describeError(err);
      errors.push({ job: name, message });
      jobs[name] = { error: true };
      ctx.log(name, 'error', message, { code: err?.code ?? null, name: err?.name || 'Error' });
      ctx.say(`${name}: failed (${errorKind(err)}); details are in the app's activity log.`);
    }
  }

  // Exposed media that a job forgot to clean up (never leave plaintext copies behind).
  if (ctx.exposed.size) {
    try {
      await ctx.cleanupExposed([...ctx.exposed]);
    } catch (err) {
      ctx.log('worker', 'warn', `Could not remove temporary media: ${describeError(err)}`);
    }
  }

  let pushed = null;
  if (ctx.notifications.length) {
    pushed = await sendNotifications(ctx, { fetchImpl });
    if (pushed.sent || pushed.failed) ctx.say(`notifications: ${pushed.sent} sent, ${pushed.failed} failed`);
  }

  const counts = sumCounts(jobs);
  const finishedAt = ctx.nowIso();
  const failedPosts = counts.failed || 0;
  const noteworthy =
    errors.length > 0 ||
    ctx.entries.some((e) => e.level === 'error' || e.level === 'warn') ||
    Object.entries(counts).some(([k, v]) => ACTIVITY_KEYS.has(k) && v > 0);
  const skipped = Object.fromEntries(Object.entries(jobs).filter(([, r]) => r && r.skipped).map(([name, r]) => [name, r.skipped]));
  // Stored run record (kept small: the log document is rewritten on every recorded run).
  const run = {
    startedAt,
    finishedAt,
    durationMs: Date.now() - realStart,
    ok: errors.length === 0 && failedPosts === 0,
    trigger: ctx.trigger,
    ...(env.POSTPILOT_REASON ? { reason: String(env.POSTPILOT_REASON).slice(0, 200) } : {}),
    counts: { ...Object.fromEntries(CORE_COUNTS.map((k) => [k, counts[k] || 0])), ...Object.fromEntries(Object.entries(counts).filter(([, v]) => v)) },
    ...(Object.keys(skipped).length ? { skipped } : {}),
    errors,
    ...(pushed ? { notifications: pushed } : {}),
    ...(noteworthy ? {} : { idle: true }),
  };
  try {
    await ctx.store.transact(
      async (tx) => {
        const logDoc = await tx.read('log');
        const lastRun = (logDoc.runs || [])[0];
        const lastMs = lastRun ? Date.parse(lastRun.finishedAt) : NaN;
        const heartbeatDue = !Number.isFinite(lastMs) || ctx.nowMs() - lastMs >= HEARTBEAT_MS || ctx.trigger === 'workflow_dispatch';
        // Idle runs are only recorded as a heartbeat (and replace the previous idle record) to keep
        // the data branch small. A run that logged something (keep-alive, compaction, archiving,
        // feed notes...) is saved too: its entries exist only in this run's buffer.
        if (!noteworthy && !heartbeatDue && !ctx.entries.length) return;
        logDoc.entries = [...ctx.entries.slice().reverse(), ...(logDoc.entries || [])].slice(0, LOG_ENTRY_CAP);
        const previous = logDoc.runs || [];
        const keep = run.idle && previous[0] && previous[0].idle ? previous.slice(1) : previous;
        logDoc.runs = [run, ...keep].slice(0, RUN_CAP);
        tx.write('log', logDoc);
      },
      { message: 'worker run log' },
    );
  } catch (err) {
    ctx.say(`Could not save the run log (${errorKind(err)}).`);
  }

  const exitCode = failedPosts > 0 ? 1 : 0;
  if (failedPosts > 0) ctx.say(`${failedPosts} post${failedPosts === 1 ? '' : 's'} failed to publish. Open Postpilot to see why.`);
  ctx.say(`Postpilot worker finished in ${Math.round((Date.now() - realStart) / 1000)}s.`);
  return { ok: run.ok, exitCode, summary: { ...run, counts, jobs } };
}

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  runWorker()
    .then((res) => {
      process.exitCode = res.exitCode;
    })
    .catch((err) => {
      console.log(`Postpilot worker crashed (${errorKind(err)}).`);
      process.exitCode = 1;
    });
}
