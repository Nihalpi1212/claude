// Competitors: daily public snapshot of tracked accounts through Business Discovery, which only
// works with Facebook Login. With Instagram Login the document gets status 'needs_facebook_login'
// so the app can explain what to do.
//
// competitors.accounts[]   strings or {username, ...} (written by the app)
// competitors.snapshots    { [username]: { [dayKey]: {followers, follows, mediaCount, avgLikes,
//                            avgComments, er, postsLast30, capturedAt} } }
// competitors.posts        { [username]: latest 12 media }
// competitors.profiles     { [username]: {name, biography, website, profilePictureUrl, ...} }
// competitors.errors       { [username]: {message, at} } for accounts that could not be read

import { describeError } from '../context.mjs';
import { DAY_MS } from './shared.mjs';

const MEDIA_LIMIT = 12;

export function usernameOf(account) {
  const raw = typeof account === 'string' ? account : account && account.username;
  return String(raw || '').trim().replace(/^@/, '').toLowerCase();
}

/** Snapshot numbers from a businessDiscovery() result. Exported for tests. */
export function snapshotOf(bd, nowMs) {
  const media = bd.media || [];
  const avg = (key) => {
    const vals = media.map((m) => m[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const avgLikes = avg('likeCount');
  const avgComments = avg('commentsCount');
  const followers = typeof bd.followersCount === 'number' ? bd.followersCount : null;
  const er = followers && (avgLikes != null || avgComments != null) ? ((avgLikes || 0) + (avgComments || 0)) / followers : null;
  const postsLast30 = media.filter((m) => nowMs - Date.parse(m.timestamp || '') <= 30 * DAY_MS).length;
  const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  return {
    followers,
    follows: bd.followsCount ?? null,
    mediaCount: bd.mediaCount ?? null,
    avgLikes: round(avgLikes, 1),
    avgComments: round(avgComments, 1),
    er: round(er, 5),
    postsLast30,
  };
}

export default async function competitors(ctx) {
  const doc = await ctx.store.read('competitors');
  if (ctx.ig.mode !== 'facebook') {
    if (doc.status !== 'needs_facebook_login') {
      await ctx.store.update('competitors', (d) => {
        d.status = 'needs_facebook_login';
        d.statusAt = ctx.nowIso();
      }, { message: 'competitors: needs Facebook Login' });
    }
    return { skipped: 'needs_facebook_login' };
  }
  const today = ctx.today();
  const names = [...new Set((doc.accounts || []).map(usernameOf).filter(Boolean))];
  const due = names.filter((u) => !doc.snapshots?.[u]?.[today] && doc.errors?.[u]?.day !== today);
  if (!due.length) {
    if (doc.status === 'needs_facebook_login') await ctx.store.update('competitors', (d) => void (d.status = 'ok'), { message: 'competitors: status' });
    return { competitors: 0 };
  }

  const got = new Map();
  const errors = new Map();
  for (const u of due) {
    try {
      got.set(u, await ctx.ig.businessDiscovery(u, { mediaLimit: MEDIA_LIMIT }));
    } catch (err) {
      if (err && err.isAuth) throw err;
      errors.set(u, describeError(err));
      if (err && err.isRateLimit) break;
    }
  }

  await ctx.store.transact(
    async (tx) => {
      const d = await tx.read('competitors');
      const nowIso = ctx.nowIso();
      const nowMs = ctx.nowMs();
      d.snapshots ||= {};
      d.posts ||= {};
      d.profiles ||= {};
      d.errors ||= {};
      for (const [u, bd] of got) {
        d.snapshots[u] ||= {};
        d.snapshots[u][today] = { ...snapshotOf(bd, nowMs), capturedAt: nowIso };
        d.posts[u] = (bd.media || []).slice(0, MEDIA_LIMIT);
        d.profiles[u] = {
          id: bd.id || null,
          username: bd.username || u,
          name: bd.name || '',
          biography: bd.biography || '',
          website: bd.website || '',
          profilePictureUrl: bd.profilePictureUrl || null,
          followersCount: bd.followersCount ?? null,
          followsCount: bd.followsCount ?? null,
          mediaCount: bd.mediaCount ?? null,
          updatedAt: nowIso,
        };
        delete d.errors[u];
      }
      for (const [u, message] of errors) d.errors[u] = { message, at: nowIso, day: today };
      d.status = 'ok';
      d.lastRunAt = nowIso;
      tx.write('competitors', d);
    },
    { message: 'competitors: daily snapshot' },
  );
  if (errors.size) ctx.log('competitors', 'warn', `Could not read ${errors.size} tracked account${errors.size === 1 ? '' : 's'}: ${[...errors.values()][0]}`);
  return { competitors: got.size };
}
