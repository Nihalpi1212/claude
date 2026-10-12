// Autopilot: keep the queue filled with posts made from library media marked for autopilot.
// planAutopilot (core/schedule.js) decides what to create and when (best times or fixed slots);
// this job writes at most 5 posts per run:
//   mode 'auto'   -> status 'scheduled' (published by the worker at that time)
//   mode 'review' -> status 'draft' with needsApproval, for the owner to approve in the app
// Captions come from Claude (ctx.ai.captions, with the asset thumbnails as images) when autopilot.useAi
// is on and AI is configured; otherwise from the assets' caption hints plus the chosen hashtag sets.

import { bestTimeMatrix, planAutopilot } from '../../core/schedule.js';
import { LIMITS, newPost } from '../../core/model.js';
import { b64encode } from '../../core/crypto.js';
import { describeError } from '../context.mjs';

const MAX_PER_RUN = 5;
const MAX_IMAGES = 4;
const LAST_RUN_EVERY_MS = 60 * 60e3;

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
  const tags = [...new Set(sets.flatMap(tagsOf))].slice(0, LIMITS.hashtags);
  const caption = [hints.join('\n\n'), tags.join(' ')].filter(Boolean).join('\n\n').slice(0, LIMITS.captionChars);
  return { caption, firstComment: defaultFirstComment || '', altText: '', ai: false };
}

async function thumbnails(ctx, assets) {
  const images = [];
  for (const a of assets.slice(0, MAX_IMAGES)) {
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
  const docs = await ctx.store.readMany(['library', 'posts', 'audience', 'analytics-media', 'hashtags']);
  const nowMs = ctx.nowMs();
  const followers = ctx.settings.ig?.followersCount ?? undefined;
  const { matrix } = bestTimeMatrix({ onlineFollowers: docs.audience.onlineFollowers, mediaStats: docs['analytics-media'].media, tz: ctx.tz, now: nowMs, followers });
  const plan = planAutopilot({ autopilot: ap, assets: docs.library.assets, posts: docs.posts.posts, matrix, tz: ctx.tz, now: nowMs });
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
  const reason = plan.reason || '';
  await ctx.store.transact(
    async (tx) => {
      created = 0;
      const a = await tx.read('autopilot');
      const nowIso = ctx.nowIso();
      if (drafts.length) {
        const postsDoc = await tx.read('posts');
        const lib = await tx.read('library');
        const busy = new Set();
        for (const p of postsDoc.posts) if (p.status !== 'canceled') for (const m of p.media || []) busy.add(m.assetId);
        const mode = a.mode === 'auto' ? 'auto' : 'review';
        for (const d of drafts) {
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
    ctx.log('autopilot', 'info', `Autopilot ${what} ${created} post${created === 1 ? '' : 's'}${aiCaptions ? ` (${aiCaptions} with AI captions)` : ''}.`);
  }
  return { autopilotCreated: created, aiCaptions };
}
