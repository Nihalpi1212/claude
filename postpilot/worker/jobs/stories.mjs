// Stories: Instagram only reports story insights while a story is live (24 hours), so capture them
// from every run. The document keeps up to KEEP_MAX stories and is re-encrypted and committed whole on
// every write, so it is written when a story is first seen, every 3 hours while it is live (a
// fallback in case the final capture is missed), every 30 minutes in its last 90 minutes and on every
// run in its last 20 (the final numbers): about 13 writes per story instead of about 32.
// Media URLs are kept as returned (they expire; the app falls back to a placeholder).

import { describeError } from '../context.mjs';
import { DAY_MS } from './shared.mjs';

const STORY_LIFETIME_MS = DAY_MS;
const CAPTURE_EVERY_MS = 3 * 36e5;
const FINAL_WINDOW_MS = 90 * 60e3;
const FINAL_EVERY_MS = 30 * 60e3;
const LAST_CALL_MS = 20 * 60e3;
const RETRY_UNSUPPORTED_MS = DAY_MS;
const KEEP_MAX = 1000;

/** Should a live story's insights be captured (and the document written) now? Exported for tests. */
export function captureDue(prev, story, nowMs) {
  if (!prev) return true;
  const lastCapture = Date.parse(prev.capturedAt || prev.lastSeenAt || '');
  if (!Number.isFinite(lastCapture)) return true;
  const postedMs = Date.parse(story.timestamp || '') || nowMs;
  const expiresIn = postedMs + STORY_LIFETIME_MS - nowMs;
  const since = nowMs - lastCapture;
  return since >= CAPTURE_EVERY_MS || (expiresIn <= FINAL_WINDOW_MS && since >= FINAL_EVERY_MS) || expiresIn <= LAST_CALL_MS;
}

function isUnsupported(err) {
  return err && (err.code === 'unsupported' || err.code === 100 || err.isPermission);
}

export default async function stories(ctx) {
  const doc = await ctx.store.read('analytics-stories');
  const nowMs = ctx.nowMs();
  if (doc.unsupported && nowMs - Date.parse(doc.unsupported.at) < RETRY_UNSUPPORTED_MS) return { skipped: 'unsupported' };

  let live;
  try {
    live = await ctx.ig.stories();
  } catch (err) {
    if (err && err.isAuth) throw err;
    if (isUnsupported(err)) {
      const message = describeError(err);
      await ctx.store.update('analytics-stories', (d) => {
        d.unsupported = { at: ctx.nowIso(), message };
      }, { message: 'stories: not available' });
      ctx.log('stories', 'warn', `Story insights are not available for this connection: ${message}`);
      return { skipped: 'unsupported' };
    }
    throw err;
  }

  const known = doc.stories || {};
  const captured = [];
  for (const s of live) {
    if (!s || !s.id) continue;
    if (!captureDue(known[s.id], s, nowMs)) continue;
    let metrics = {};
    try {
      metrics = (await ctx.ig.storyInsights(s.id)) || {};
    } catch (err) {
      if (err && err.isAuth) throw err;
      ctx.log('stories', 'warn', `Could not read story insights: ${describeError(err)}`);
    }
    captured.push({ s, metrics });
  }
  if (!captured.length && !doc.unsupported) return { stories: 0 };

  await ctx.store.transact(
    async (tx) => {
      const d = await tx.read('analytics-stories');
      const nowIso = ctx.nowIso();
      d.stories ||= {};
      for (const { s, metrics } of captured) {
        const prev = d.stories[s.id] || {};
        const has = metrics && Object.keys(metrics).length > 0;
        d.stories[s.id] = {
          id: s.id,
          mediaType: s.mediaType || prev.mediaType || null,
          timestamp: s.timestamp || prev.timestamp || null,
          permalink: s.permalink || prev.permalink || null,
          mediaUrl: s.mediaUrl || prev.mediaUrl || null,
          thumbnailUrl: s.thumbnailUrl || prev.thumbnailUrl || null,
          firstSeenAt: prev.firstSeenAt || nowIso,
          lastSeenAt: nowIso,
          capturedAt: has ? nowIso : prev.capturedAt || null,
          metrics: has ? { ...(prev.metrics || {}), ...metrics } : prev.metrics || {},
        };
      }
      delete d.unsupported;
      const ids = Object.keys(d.stories);
      if (ids.length > KEEP_MAX) {
        ids
          .sort((a, b) => Date.parse(d.stories[b].timestamp || 0) - Date.parse(d.stories[a].timestamp || 0))
          .slice(KEEP_MAX)
          .forEach((id) => delete d.stories[id]);
      }
      tx.write('analytics-stories', d);
    },
    { message: 'stories: capture insights' },
  );
  return { stories: captured.length };
}
