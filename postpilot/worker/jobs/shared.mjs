// Helpers shared by worker jobs (not a job itself: no default export).

import { describeError } from '../context.mjs';

export const DAY_MS = 864e5;

/** Append to a post's history using the worker clock (kept to the last 30 entries). */
export function pushHistory(post, at, event, detail) {
  post.history = [...(post.history || []), { at, event, ...(detail ? { detail } : {}) }].slice(-30);
  post.updatedAt = at;
  return post;
}

/** {message, code, subcode} for storing an error in an encrypted document. */
export function errorInfo(err) {
  return {
    message: describeError(err),
    code: err?.code ?? null,
    subcode: err?.subcode ?? null,
  };
}

/** True for errors worth retrying on a later run (network, 5xx, rate limits, GitHub hiccups). */
export function isRetryable(err) {
  if (!err) return false;
  if (err.isPermanent === true || err.permanent === true) return false;
  if (err.isRateLimit || err.isTransient) return true;
  if (err.name === 'GitHubError') return !err.status || err.status >= 500 || err.status === 429 || err.isConflict;
  if (err.name === 'ConflictError') return true;
  if (err.name === 'TypeError' && /fetch/i.test(err.message || '')) return true;
  return false;
}

/** Find a comment (top level or reply) in a cached comment list. Returns {comment, parent, index}. */
export function findCachedComment(list, id) {
  for (let i = 0; i < (list || []).length; i++) {
    const c = list[i];
    if (c.id === id) return { comment: c, parent: null, index: i };
    const r = (c.replies || []).findIndex((x) => x.id === id);
    if (r >= 0) return { comment: c.replies[r], parent: c, index: r };
  }
  return null;
}

function stamp(v) {
  if (typeof v === 'string') return Date.parse(v);
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object') return Date.parse(v.at || v.seenAt || '');
  return NaN;
}

/**
 * Remove processed entries older than the given ages. Mutates `processed`; returns how many entries
 * were removed. Values are ISO strings (or {at}) of when the item was handled.
 * ages: { comments, messages, conversations, users } in days.
 */
export function pruneProcessed(processed, nowMs, ages = { comments: 30, messages: 30, conversations: 365, users: 365 }) {
  if (!processed || typeof processed !== 'object') return 0;
  let removed = 0;
  for (const key of ['comments', 'messages', 'conversations']) {
    const map = processed[key];
    if (!map || typeof map !== 'object') continue;
    const cutoff = nowMs - (ages[key] ?? 30) * DAY_MS;
    for (const [id, v] of Object.entries(map)) {
      const t = stamp(v);
      if (!Number.isFinite(t) || t < cutoff) {
        delete map[id];
        removed++;
      }
    }
  }
  if (processed.users && typeof processed.users === 'object') {
    const cutoff = nowMs - (ages.users ?? 365) * DAY_MS;
    for (const [ruleId, users] of Object.entries(processed.users)) {
      if (!users || typeof users !== 'object') {
        delete processed.users[ruleId];
        continue;
      }
      for (const [userId, v] of Object.entries(users)) {
        const t = stamp(v);
        if (!Number.isFinite(t) || t < cutoff) {
          delete users[userId];
          removed++;
        }
      }
      if (!Object.keys(users).length) delete processed.users[ruleId];
    }
  }
  return removed;
}

/** Oldest processed entry time (ms) per pruneProcessed rules, used to decide whether pruning is due. */
export function oldestProcessed(processed, key) {
  const map = processed?.[key];
  let min = Infinity;
  if (map && typeof map === 'object') for (const v of Object.values(map)) min = Math.min(min, stamp(v));
  return min;
}

/** Cut text for logs and caches. */
export function clip(text, n = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
