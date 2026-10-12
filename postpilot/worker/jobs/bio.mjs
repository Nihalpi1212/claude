// Link-in-bio: Instagram media URLs expire after a few days, so once a day refresh the image URLs
// of grid items linked to Instagram posts (item.igMediaId or item.mediaId). The bio document is
// public JSON (public/bio.json); only public post images and permalinks are written to it.

function imageOf(m) {
  const child = (m.children || [])[0] || {};
  return m.thumbnailUrl || (m.mediaType === 'VIDEO' ? null : m.mediaUrl) || child.thumbnailUrl || child.mediaUrl || null;
}

export default async function bio(ctx) {
  const doc = await ctx.store.read('bio');
  if (!doc.published) return { skipped: 'disabled' };
  const linked = (doc.grid || []).filter((it) => it && (it.igMediaId || it.mediaId));
  if (!linked.length) return { bioImages: 0 };
  if (doc.gridRefreshedDay === ctx.today()) return { skipped: 'not_due' };

  const media = await ctx.ig.listMedia({ limit: 50, max: 100 });
  const byId = new Map(media.map((m) => [m.id, m]));
  let updated = 0;
  await ctx.store.transact(
    async (tx) => {
      updated = 0;
      const d = await tx.read('bio');
      for (const it of d.grid || []) {
        const m = it && byId.get(it.igMediaId || it.mediaId);
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
      d.gridRefreshedDay = ctx.today();
      d.gridRefreshedAt = ctx.nowIso();
      tx.write('bio', d);
    },
    { message: 'bio: refresh grid images' },
  );
  return { bioImages: updated };
}
