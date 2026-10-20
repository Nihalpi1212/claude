// Link-in-bio: Instagram media URLs expire after a few days, so once a day refresh the image URLs
// of grid items linked to Instagram posts (item.igMediaId or item.mediaId). The bio document is
// public JSON (public/bio.json); only public post images and permalinks are written to it.
//
// Posts deleted from Instagram leave the grid (and public/bio.json is written again):
// - on the first run that knows of it, with no Instagram call: the analytics job flagged the media
//   (analytics-media.media[id].deletedAt) or the post was deleted with "Delete from Instagram"
//   (posts[].deletedFromInstagramAt);
// - on the daily refresh, a grid post missing from the listing of the newest 100 is looked up (at
//   most LOOKUPS_MAX a run): "not found" means deleted; found, its image is refreshed too.

const LOOKUPS_MAX = 12; // the grid holds at most 12 posts (js/views/bio.js MAX_GRID)

function imageOf(m) {
  const child = (m.children || [])[0] || {};
  return m.thumbnailUrl || (m.mediaType === 'VIDEO' ? null : m.mediaUrl) || child.thumbnailUrl || child.mediaUrl || null;
}

const mediaIdOf = (it) => (it && (it.igMediaId || it.mediaId) ? String(it.igMediaId || it.mediaId) : null);

/** Media ids Postpilot knows were deleted from Instagram. */
function deletedIds(analyticsMedia, postsDoc) {
  const ids = new Set();
  for (const [id, e] of Object.entries((analyticsMedia && analyticsMedia.media) || {})) if (e && e.deletedAt) ids.add(String(id));
  for (const p of (postsDoc && postsDoc.posts) || []) if (p && p.deletedFromInstagramAt && p.igMediaId) ids.add(String(p.igMediaId));
  return ids;
}

export default async function bio(ctx) {
  const doc = await ctx.store.read('bio');
  if (!doc.published) return { skipped: 'disabled' };
  const linked = (doc.grid || []).map(mediaIdOf).filter(Boolean);
  if (!linked.length) return { bioImages: 0 };
  const [analyticsMedia, postsDoc] = await Promise.all([ctx.store.read('analytics-media'), ctx.store.read('posts')]);
  const gone = deletedIds(analyticsMedia, postsDoc);
  const due = doc.gridRefreshedDay !== ctx.today();
  if (!due && !linked.some((id) => gone.has(id))) return { skipped: 'not_due' };

  const byId = new Map();
  if (due) {
    for (const m of await ctx.ig.listMedia({ limit: 50, max: 100 })) byId.set(String(m.id), m);
    let lookups = 0;
    for (const id of linked) {
      if (byId.has(id) || gone.has(id) || lookups >= LOOKUPS_MAX) continue;
      lookups++;
      try {
        const raw = await ctx.ig.getMedia(id, 'id,media_type,media_url,thumbnail_url,permalink');
        byId.set(id, { id, mediaType: raw.media_type || null, mediaUrl: raw.media_url || null, thumbnailUrl: raw.thumbnail_url || null, permalink: raw.permalink || null });
      } catch (err) {
        if (err && err.isAuth) throw err;
        if (err && (err.isNotFound || (err.code === 100 && !err.isTransient))) gone.add(id);
        else if (err && err.isRateLimit) break;
        // Other errors: look again on the next daily refresh.
      }
    }
  }

  let updated = 0;
  let removed = 0;
  await ctx.store.transact(
    async (tx) => {
      updated = 0;
      removed = 0;
      const d = await tx.read('bio');
      const before = (d.grid || []).length;
      d.grid = (d.grid || []).filter((it) => !gone.has(mediaIdOf(it)));
      removed = before - d.grid.length;
      for (const it of d.grid) {
        const m = byId.get(mediaIdOf(it));
        if (!m) continue;
        const url = imageOf(m);
        if (url && it.imageUrl !== url) {
          it.imageUrl = url;
          if ('thumbnailUrl' in it) it.thumbnailUrl = url;
          updated++;
        }
        if (!it.permalink && m.permalink) {
          it.permalink = m.permalink;
          updated++;
        }
      }
      if (due) {
        d.gridRefreshedDay = ctx.today();
        d.gridRefreshedAt = ctx.nowIso();
      }
      if (due || removed) tx.write('bio', d);
    },
    { message: 'bio: refresh grid images' },
  );
  if (removed) ctx.log('bio', 'info', `Removed ${removed} post${removed === 1 ? '' : 's'} deleted from Instagram from the link-in-bio grid.`);
  return { bioImages: updated, ...(removed ? { bioRemoved: removed } : {}) };
}
