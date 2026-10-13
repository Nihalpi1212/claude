// Evergreen lists: turn each enabled list's recurring slots into scheduled posts for the next
// `horizonDays`. Idempotent: a slot that already has a post from the list (any status, canceled
// included) is never filled twice (see schedule.expandListSlots). Each post keeps its slot's
// identity in `listSlot`, so moving it in the planner or changing the time zone does not empty the slot.
//
// Lists with `repeat: false` use each item once: items already used (timesUsed > 0) or waiting in
// an active post are not scheduled again, and the publish job removes an item once it is published.
//
// Items whose media is still being downloaded from a link (asset.importUrl, feed and CSV imports) are
// scheduled as usual (the publish job waits for the file); items whose download failed
// (asset.importError) are skipped until the owner fixes the file in the Library. So are items with a
// photo outside the feed's 4:5 to 1.91:1 range: Instagram would refuse every post made from them.
// When a download fails after its item was scheduled, the post this job made for it is removed (if
// the owner has not changed it), so its slot goes to the next usable item instead of failing at
// publish time. A post the owner edited or moved stays: publishing then reports the problem.

import { brokenAssetIds } from '../../core/feed.js';
import { expandListSlots } from '../../core/schedule.js';
import { newPost } from '../../core/model.js';

export { brokenAssetIds };

const MAX_PER_RUN = 50;

function hasAllMedia(item, assetIds) {
  const media = item.media || [];
  return media.length > 0 && media.every((m) => assetIds.has(m.assetId));
}

function hasBrokenMedia(item, brokenIds) {
  return !!brokenIds && (item.media || []).some((m) => brokenIds.has(m.assetId));
}

function postTypeFor(item) {
  if (item.type) return item.type;
  return (item.media || []).length > 1 ? 'carousel' : 'feed';
}

/**
 * Plan posts for one list against the current posts. Returns { posts: [...], nextIndex, missing: [itemIds] }.
 * brokenIds: assets that cannot be posted to the feed, because their download from a link failed or
 * they are photos of the wrong shape (their items are skipped, not flagged missing; see brokenAssetIds).
 * Exported for tests.
 */
export function planList(list, { posts, assetIds, brokenIds = null, tz, now, nowIso }) {
  const missing = [];
  const usable = [];
  for (const item of list.items || []) {
    if (!hasAllMedia(item, assetIds)) missing.push(item.id);
    else if (!hasBrokenMedia(item, brokenIds)) usable.push(item);
  }
  let source;
  let limit = MAX_PER_RUN;
  if (list.repeat === false) {
    const busy = new Set(posts.filter((p) => p.listId === list.id && p.status !== 'canceled' && p.listItemId).map((p) => p.listItemId));
    const fresh = usable.filter((it) => !busy.has(it.id) && !(it.timesUsed > 0));
    source = { ...list, items: fresh, nextIndex: 0 };
    limit = Math.min(limit, fresh.length);
  } else {
    const start = Number.isInteger(list.nextIndex) && list.nextIndex >= 0 ? list.nextIndex : 0;
    source = { ...list, items: usable, nextIndex: list.order === 'shuffle' ? start : usable.length ? start % usable.length : 0 };
  }
  if (!source.items.length) return { posts: [], nextIndex: list.nextIndex ?? 0, missing };

  const { slots, nextIndex } = expandListSlots(source, { tz, now, horizonDays: list.horizonDays, existingPosts: posts });
  const created = [];
  for (const slot of slots.slice(0, limit)) {
    const item = source.items[slot.itemIndex];
    if (!item) continue;
    created.push(
      newPost({
        type: postTypeFor(item),
        status: 'scheduled',
        caption: item.caption || '',
        firstComment: item.firstComment || '',
        media: structuredClone(item.media || []),
        altText: item.altText || '',
        scheduledAt: slot.scheduledAt,
        source: 'evergreen',
        listId: list.id,
        listItemId: item.id,
        listSlot: slot.listSlot,
        needsApproval: false,
        createdAt: nowIso,
        updatedAt: nowIso,
        history: [{ at: nowIso, event: 'created', detail: `Scheduled from the evergreen list "${list.name || 'Evergreen'}".` }],
      }),
    );
  }
  // For repeat=false lists nextIndex is not meaningful (items are picked by availability).
  let next = nextIndex;
  if (list.repeat === false) next = list.nextIndex ?? 0;
  else if (slots.length > limit) {
    const n = source.items.length;
    next = list.order === 'shuffle' && n > 2 ? source.nextIndex + limit : (source.nextIndex + limit) % n;
  }
  return { posts: created, nextIndex: next, missing };
}

// History events of a post nobody but the worker has touched: this job's own, and the publish job's
// note that the post waits for its download.
const WORKER_EVENTS = new Set(['created', 'waiting_download']);

/**
 * Scheduled posts this job made whose media turned out unusable after they were planned (the download
 * failed or was refused), untouched by the owner (see WORKER_EVENTS): removing them frees their slots
 * (expandListSlots counts a post of any status as filling its slot). Exported for tests.
 */
export function stalePosts(posts, brokenIds) {
  return (posts || []).filter(
    (p) =>
      p.source === 'evergreen' &&
      p.status === 'scheduled' &&
      (p.history || []).every((h) => h && WORKER_EVENTS.has(h.event)) &&
      (p.media || []).some((m) => m && brokenIds.has(m.assetId)),
  );
}

export default async function evergreen(ctx) {
  const peek = await ctx.store.read('lists');
  const active = (peek.lists || []).filter((l) => l.enabled !== false && (l.items || []).length && (l.slots || []).length);
  if (!active.length) return { evergreenCreated: 0 };

  let created = 0;
  let newlyMissing = [];
  let removed = new Map(); // list name -> posts removed
  await ctx.store.transact(
    async (tx) => {
      created = 0;
      newlyMissing = [];
      removed = new Map();
      const listsDoc = await tx.read('lists');
      const postsDoc = await tx.read('posts');
      const library = await tx.read('library');
      const assetIds = new Set((library.assets || []).map((a) => a.id));
      const brokenIds = brokenAssetIds(library.assets);
      const nowMs = ctx.nowMs();
      const nowIso = new Date(nowMs).toISOString();
      let listsChanged = false;
      const stale = new Set(stalePosts(postsDoc.posts, brokenIds));
      if (stale.size) {
        postsDoc.posts = postsDoc.posts.filter((p) => !stale.has(p));
        for (const p of stale) {
          const name = (listsDoc.lists || []).find((l) => l.id === p.listId)?.name || 'Evergreen';
          removed.set(name, (removed.get(name) || 0) + 1);
        }
      }
      for (const list of listsDoc.lists || []) {
        if (list.enabled === false || !(list.items || []).length || !(list.slots || []).length) continue;
        const plan = planList(list, { posts: postsDoc.posts, assetIds, brokenIds, tz: ctx.tz, now: nowMs, nowIso });
        // Flag items whose media was deleted from the library (shown in the app; logged once).
        for (const item of list.items) {
          const isMissing = plan.missing.includes(item.id);
          if (isMissing && !item.mediaMissing) {
            item.mediaMissing = true;
            newlyMissing.push(list.name || list.id);
            listsChanged = true;
          } else if (!isMissing && item.mediaMissing) {
            delete item.mediaMissing;
            listsChanged = true;
          }
        }
        if (plan.posts.length) {
          postsDoc.posts.push(...plan.posts);
          created += plan.posts.length;
        }
        if (plan.nextIndex !== list.nextIndex) {
          list.nextIndex = plan.nextIndex;
          listsChanged = true;
        }
      }
      if (created || stale.size) tx.write('posts', postsDoc);
      if (listsChanged || created) tx.write('lists', listsDoc);
    },
    { message: 'evergreen: schedule list posts' },
  );
  for (const [name, n] of removed) {
    ctx.log('evergreen', 'warn', `Removed ${n} scheduled post${n === 1 ? '' : 's'} of the queue "${name}": ${n === 1 ? 'its file' : 'their files'} could not be downloaded or Instagram cannot take ${n === 1 ? 'it' : 'them'}. The next items take ${n === 1 ? 'its slot' : 'their slots'}; the Library says what went wrong.`);
  }
  if (created) ctx.log('evergreen', 'info', `Scheduled ${created} post${created === 1 ? '' : 's'} from evergreen lists.`);
  for (const name of newlyMissing) ctx.log('evergreen', 'warn', `An item in the evergreen list "${name}" uses media that is no longer in the library, so it is skipped.`);
  return { evergreenCreated: created };
}
