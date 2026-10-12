// Autopilot: keep the queue filled with posts made from library media marked for autopilot.
// planAutopilot (core/schedule.js) decides what to create and when (best times or fixed slots);
// this job writes at most 5 posts per run:
//   mode 'auto'   -> status 'scheduled' (published by the worker at that time)
//   mode 'review' -> status 'draft' with needsApproval, for the owner to approve in the app
// Captions come from Claude (ctx.ai.captions, with the asset thumbnails as images) when autopilot.useAi
// is on and AI is configured; otherwise from the assets' caption hints plus the chosen hashtag sets.
//
// Recycling (autopilot.recycleTopPosts): top posts published through Postpilot more than
// recycleAfterDays ago (core/schedule.js recycleCandidates) are posted again as new posts with
// source 'recycle' and recycleOf = the original Instagram media id, copying the caption, first
// comment and media when all of the media is still in the library. Review / auto mode applies to
// reposts like to any other autopilot post.

import { bestTimeMatrix, freesMedia, planAutopilot, recycleCandidates } from '../../core/schedule.js';
import { LIMITS, newPost } from '../../core/model.js';
import { b64encode } from '../../core/crypto.js';
import { describeError } from '../context.mjs';

const MAX_PER_RUN = 5;
const MAX_IMAGES = 4;
const LAST_RUN_EVERY_MS = 60 * 60e3;
// Files downloaded by the worker double as their own thumbnail (thumbPath === path). Claude takes
// images up to 5 MB, so larger originals and videos are left out of the AI request.
const MAX_AI_IMAGE_BYTES = 3.5 * 1024 * 1024;

function tagsOf(set) {
  if (!set) return [];
  const raw = Array.isArray(set.tags) ? set.tags : Array.isArray(set.hashtags) ? set.hashtags : String(set.text || '').split(/[\s,]+/);
  return raw
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .map((t) => (t.startsWith('#') ? t : `#${t}`).toLowerCase());
}

/** Caption without AI: caption hints of the assets plus hashtags from the selected sets. Exported for tests. */
export function fallbackContent(assets, sets, { defaultFirstComment = '' } = {}) {
  const hints = [...new Set(assets.map((a) => String(a.captionHint || '').trim()).filter(Boolean))];
  const tags = [...new Set(sets.flatMap(tagsOf))].slice(0, LIMITS.hashtagsRecommended); // Instagram shows at most 5
  const caption = [hints.join('\n\n'), tags.join(' ')].filter(Boolean).join('\n\n').slice(0, LIMITS.captionChars);
  return { caption, firstComment: defaultFirstComment || '', altText: '', ai: false };
}

async function thumbnails(ctx, assets) {
  const images = [];
  for (const a of assets.slice(0, MAX_IMAGES)) {
    const own = a.thumbPath && a.thumbPath === a.path;
    if (a.importUrl || (own && (a.kind === 'video' || a.bytes > MAX_AI_IMAGE_BYTES))) continue;
    try {
      const bytes = await ctx.store.readBytes(a.thumbPath || `media/${a.id}.thumb`);
      if (bytes && bytes.length) images.push({ base64: b64encode(bytes), mediaType: 'image/jpeg' });
    } catch (err) {
      ctx.log('autopilot', 'warn', `Could not read a thumbnail for AI captions: ${describeError(err)}`);
    }
  }
  return images;
}

export default async function autopilot(ctx) {
  const ap = await ctx.store.read('autopilot');
  if (!ap.enabled) return { skipped: 'disabled' };
  const docs = await ctx.store.readMany(['library', 'posts', 'lists', 'audience', 'analytics-media', 'hashtags', ...(ap.recycleTopPosts ? ['posts-archive'] : [])]);
  const nowMs = ctx.nowMs();
  const followers = ctx.settings.ig?.followersCount ?? undefined;
  const { matrix } = bestTimeMatrix({ onlineFollowers: docs.audience.onlineFollowers, mediaStats: docs['analytics-media'].media, tz: ctx.tz, now: nowMs, followers });
  const candidates = ap.recycleTopPosts
    ? recycleCandidates({
        mediaStats: docs['analytics-media'].media,
        posts: docs.posts.posts,
        archive: docs['posts-archive']?.posts || [],
        assets: docs.library.assets,
        now: nowMs,
        afterDays: Number(ap.recycleAfterDays) > 0 ? Number(ap.recycleAfterDays) : 120,
        count: 3,
        followers,
      })
    : [];
  // Queue items (feed and CSV imports among them) are left to their queues (lists).
  const plan = planAutopilot({ autopilot: ap, assets: docs.library.assets, posts: docs.posts.posts, lists: docs.lists.lists, matrix, tz: ctx.tz, now: nowMs, recycle: candidates });
  const create = (plan.create || []).slice(0, MAX_PER_RUN);

  const sets = (docs.hashtags.sets || []).filter((s) => (ap.hashtagSetIds || []).includes(s.id));
  const assetsById = new Map((docs.library.assets || []).map((a) => [a.id, a]));
  const aiSettings = ctx.settings.ai || {};
  const useAi = ap.useAi !== false && !!ctx.ai && aiSettings.enabled && !!aiSettings.apiKey;
  const defaultFirstComment = ctx.settings.publishing?.defaultFirstComment || '';
  let aiCaptions = 0;
  let aiFailed = 0;

  const drafts = [];
  for (const item of create) {
    const assets = item.assetIds.map((id) => assetsById.get(id)).filter(Boolean);
    if (assets.length !== item.assetIds.length) continue;
    if (item.recycleOf) {
      const original = candidates.find((c) => c.recycleOf === item.recycleOf);
      if (original) drafts.push({ ...item, assets, original, caption: original.caption, firstComment: original.firstComment, altText: original.altText, ai: false });
      continue;
    }
    let content = fallbackContent(assets, sets, { defaultFirstComment });
    if (useAi && !aiFailed) {
      try {
        const images = await thumbnails(ctx, assets);
        const notes = [
          ap.captionStyle ? `Caption style: ${ap.captionStyle}` : '',
          ...assets.map((a) => a.captionHint || a.notes || '').filter(Boolean),
        ]
          .filter(Boolean)
          .join('\n');
        const options = await ctx.ai.captions({
          images,
          postType: item.type,
          notes,
          emoji: aiSettings.emoji || 'some',
          count: 1,
          includeHashtags: true,
          hashtagSets: sets.map((s) => ({ name: s.name || '', tags: tagsOf(s) })),
        });
        const best = options && options[0];
        if (best && best.caption) {
          const tags = (best.hashtags || []).join(' ');
          content = {
            caption: [best.caption, tags].filter(Boolean).join('\n\n').slice(0, LIMITS.captionChars),
            firstComment: best.firstComment || defaultFirstComment,
            altText: best.altText || '',
            ai: true,
          };
          aiCaptions++;
        }
      } catch (err) {
        aiFailed++;
        ctx.log('autopilot', 'warn', `AI captions failed, used caption hints instead: ${describeError(err)}`);
      }
    }
    drafts.push({ ...item, assets, ...content });
  }

  let created = 0;
  let reposts = 0;
  const reason = plan.reason || '';
  await ctx.store.transact(
    async (tx) => {
      created = 0;
      reposts = 0;
      const a = await tx.read('autopilot');
      const nowIso = ctx.nowIso();
      if (drafts.length) {
        const postsDoc = await tx.read('posts');
        const lib = await tx.read('library');
        const busy = new Set();
        for (const p of postsDoc.posts) if (!freesMedia(p)) for (const m of p.media || []) busy.add(m.assetId);
        const mode = a.mode === 'auto' ? 'auto' : 'review';
        const libIds = new Set((lib.assets || []).map((as) => as.id));
        for (const d of drafts) {
          if (d.original) {
            // A repost: its media is in use by the published original, so only check that it is
            // still in the library and that no other repost of the same post is planned meanwhile.
            const planned = postsDoc.posts.some((p) => p.recycleOf === d.recycleOf && ['draft', 'scheduled', 'publishing'].includes(p.status));
            if (planned || !d.assetIds.every((id) => libIds.has(id))) continue;
            const o = d.original;
            const when = o.publishedAt ? ` first published ${o.publishedAt.slice(0, 10)}` : '';
            const post = newPost({
              type: d.type,
              status: mode === 'auto' ? 'scheduled' : 'draft',
              caption: o.caption,
              firstComment: o.firstComment,
              media: structuredClone(o.media),
              altText: o.altText,
              coverAssetId: o.coverAssetId,
              thumbOffsetMs: o.thumbOffsetMs,
              location: o.location ? structuredClone(o.location) : null,
              scheduledAt: d.scheduledAt,
              source: 'recycle',
              recycleOf: d.recycleOf,
              needsApproval: mode === 'review',
              createdAt: nowIso,
              updatedAt: nowIso,
              history: [{ at: nowIso, event: 'created', detail: `Created by autopilot: a repost of a top post${when}.` }],
            });
            postsDoc.posts.push(post);
            for (const as of lib.assets || []) if (d.assetIds.includes(as.id)) as.usedBy = [...new Set([...(as.usedBy || []), post.id])];
            created++;
            reposts++;
            continue;
          }
          if (d.assetIds.some((id) => busy.has(id))) continue; // used in the app meanwhile
          const single = d.assets.length === 1 && d.assets[0].kind === 'image';
          const post = newPost({
            type: d.type,
            status: mode === 'auto' ? 'scheduled' : 'draft',
            caption: d.caption,
            firstComment: d.firstComment || '',
            media: d.assets.map((as) => ({ assetId: as.id, kind: as.kind || 'image', altText: single ? d.altText || '' : '' })),
            altText: d.altText || '',
            scheduledAt: d.scheduledAt,
            source: 'autopilot',
            needsApproval: mode === 'review',
            aiGenerated: false,
            createdAt: nowIso,
            updatedAt: nowIso,
            history: [{ at: nowIso, event: 'created', detail: `Created by autopilot${d.ai ? ' with an AI caption' : ''}.` }],
          });
          postsDoc.posts.push(post);
          for (const id of d.assetIds) busy.add(id);
          for (const as of lib.assets || []) {
            if (!d.assetIds.includes(as.id)) continue;
            as.usedBy = [...new Set([...(as.usedBy || []), post.id])];
          }
          created++;
        }
        if (created) {
          tx.write('posts', postsDoc);
          tx.write('library', lib);
        }
      }
      const prev = a.lastResult || {};
      const stale = !a.lastRunAt || ctx.nowMs() - Date.parse(a.lastRunAt) >= LAST_RUN_EVERY_MS;
      if (created || prev.code !== plan.code || prev.reason !== reason || stale) {
        a.lastRunAt = nowIso;
        a.lastResult = { code: plan.code || null, reason, created, at: nowIso };
        tx.write('autopilot', a);
      }
    },
    { message: 'autopilot: fill queue' },
  );
  if (created) {
    if (ap.mode !== 'auto') ctx.notify('approval', { count: created });
    const what = ap.mode === 'auto' ? 'scheduled' : 'drafted for review';
    const extras = [aiCaptions ? `${aiCaptions} with AI captions` : '', reposts ? `${reposts} repost${reposts === 1 ? '' : 's'} of top posts` : ''].filter(Boolean).join(', ');
    ctx.log('autopilot', 'info', `Autopilot ${what} ${created} post${created === 1 ? '' : 's'}${extras ? ` (${extras})` : ''}.`);
  }
  return { autopilotCreated: created, aiCaptions, ...(reposts ? { reposts } : {}) };
}
