// Publishing pipeline: media containers -> status polling -> media_publish -> first comment.
//
// Safe to re-run: containers are reported through onContainers as soon as they exist, so a
// later run can resume from post.containers instead of creating (and publishing) twice.

import { IgError, PublishPendingError, describeIgError } from './ig.js';

const CONTAINER_HINTS = {
  2207004: 'The image is too large. Use a JPEG under 8 MB.',
  2207005: 'Instagram only accepts JPEG photos. Re-upload the photo and try again.',
  2207009: 'The photo aspect ratio is not allowed. Crop it to between 4:5 and 1.91:1.',
  2207026: 'Instagram does not support this video format. Export it as MP4 (H.264 video, AAC audio).',
  2207001: 'Instagram had a server error or flagged the content. Postpilot will try again; if it keeps failing, change the media.',
  2207003: 'Instagram timed out downloading the file. Postpilot will try again.',
  2207032: 'Instagram could not create the post. Postpilot will try again.',
  2207052: 'Instagram could not download the file. Postpilot will try again; if it keeps failing, re-upload it (JPEG for photos, MP4 for videos).',
  2207053: 'Instagram could not process the video. Keep it under 300 MB, at most 1920 px wide and under 25 Mbps.',
  2207082: 'Instagram could not process the video. Re-export it as MP4 (H.264, AAC) and try again.',
  2207085: 'Instagram could not process the video. Re-export it as MP4 (H.264, AAC) and try again.',
};

// Publishing errors that a later run can fix (server errors, download timeouts, expired or lost
// containers). The retry is bounded by the worker's attempt limit, and a resumed run recreates
// containers in ERROR/EXPIRED/MISSING and checks for PUBLISHED before publishing again.
const RETRY_SUBCODES = new Set([2207001, 2207003, 2207006, 2207008, 2207020, 2207032, 2207052]);

class ExpiredSignal extends Error {
  constructor(id) {
    super(`Container ${id} expired`);
    this.id = id;
  }
}

function containerError(status) {
  const text = String(status || 'Unknown error');
  const sub = text.match(/\b(2207\d{3})\b/);
  const code = text.match(/\((3\d{4}|9004|352)\b/);
  const subcode = sub ? Number(sub[1]) : null;
  const hint = (subcode && CONTAINER_HINTS[subcode]) || 'Check the media file and try again.';
  return new IgError(`Instagram could not process the media: ${text}`, {
    code: code ? Number(code[1]) : 'container_error',
    subcode,
    permanent: !RETRY_SUBCODES.has(subcode),
    userMessage: `Instagram could not process the media. ${hint}`,
  });
}

const stripAt = (u) => String(u || '').trim().replace(/^@+/, '');
const clamp01 = (v, d = 0.5) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
};
const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Drop undefined/null/empty-string/empty-array params so only set values are sent. */
function clean(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  return out;
}

function resumableUnsupported(err) {
  if (!(err instanceof IgError)) return false;
  if (err.isAuth || err.isRateLimit) return false;
  return err.code === 100 || err.code === 'unsupported' || err.isPermission || (err.status >= 400 && err.status < 500);
}

/**
 * Publish one post. See ARCHITECTURE.md section 5.
 * @returns {Promise<{igMediaId, permalink, containers, firstCommentId, warnings: string[], exposed: object[]}>}
 * @throws IgError (classify with classifyError) or PublishPendingError (resume next run from err.containers)
 */
export async function publishPost({
  ig,
  post,
  assets,
  exposeMedia,
  readMedia,
  onContainers,
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollIntervalMs = 4000,
  maxWaitMs = 240000,
  tryResumable = true,
}) {
  const warnings = [];
  const exposed = [];
  const getAsset = (id) => (assets instanceof Map ? assets.get(id) : assets && assets[id]);
  const started = Date.now();
  let waited = 0;
  const elapsed = () => Math.max(Date.now() - started, waited);
  const nap = async () => {
    await sleep(pollIntervalMs);
    waited += pollIntervalMs;
  };
  const type = post.type || 'feed';
  const refs = post.media || [];
  let containers = null;

  if (!refs.length) {
    throw new IgError('The post has no media.', { code: 'missing_media', permanent: true, userMessage: 'Add a photo or video to this post before publishing.' });
  }
  for (const ref of refs) {
    if (!getAsset(ref.assetId)) {
      throw new IgError(`Asset ${ref.assetId} is missing.`, { code: 'missing_media', permanent: true, userMessage: 'A media file for this post is missing from the library. Re-add it and try again.' });
    }
  }

  const snapshot = () => JSON.parse(JSON.stringify(containers));
  async function save() {
    if (!onContainers) return;
    try {
      await onContainers(snapshot());
    } catch (err) {
      log(`Could not save upload progress (${(err && err.message) || err}).`);
    }
  }

  async function expose(asset) {
    if (!exposeMedia) throw new IgError('No way to make the media reachable for Instagram.', { code: 'no_expose', permanent: true });
    const r = await exposeMedia(asset);
    if (!r || !r.url) throw new Error('Could not prepare a public link for the media.');
    exposed.push({ assetId: asset.id, ...r });
    return r;
  }

  async function statusOf(id) {
    try {
      return await ig.containerStatus(id);
    } catch (err) {
      if (err instanceof IgError && (err.isNotFound || err.code === 100 || err.code === 24)) return { statusCode: 'MISSING', status: err.message };
      throw err;
    }
  }

  async function checkLimit() {
    let lim;
    try {
      lim = await ig.publishingLimit();
    } catch (err) {
      if (err instanceof IgError && err.isAuth) throw err;
      log('Could not read the publishing limit; continuing.');
      return;
    }
    if (lim && typeof lim.total === 'number' && typeof lim.used === 'number' && lim.used >= lim.total) {
      throw new IgError('Instagram daily publishing limit reached', {
        code: 9,
        subcode: 2207042,
        permanent: false,
        userMessage: 'Instagram daily publishing limit reached. Postpilot will try again on the next run.',
      });
    }
  }

  // ----- container params ------------------------------------------------------------------
  const caption = normText(post.caption) ? post.caption : undefined;
  const collaborators = (post.collaborators || []).map(stripAt).filter(Boolean).slice(0, 3);
  const locationId = post.location && post.location.id ? String(post.location.id) : undefined;
  // "AI info" label (Graph API 2026-06): allowed on single posts, reels and carousel parents, not carousel items.
  const aiGenerated = post.aiGenerated ? true : undefined;
  const tags = (post.userTags || []).filter((t) => t && stripAt(t.username));
  const tagsWithXY = (index) =>
    tags.filter((t) => (t.mediaIndex ?? 0) === index).map((t) => ({ username: stripAt(t.username), x: clamp01(t.x), y: clamp01(t.y) }));
  // Everything that goes into the containers, saved with them so a later run notices edits.
  const fp = JSON.stringify({
    type,
    caption: caption || '',
    media: refs.map((r) => [r.assetId, r.altText || '']),
    altText: post.altText || '',
    cover: post.coverAssetId || null,
    thumb: post.thumbOffsetMs ?? null,
    collaborators,
    tags: tags.map((t) => [stripAt(t.username), t.x ?? null, t.y ?? null, t.mediaIndex ?? 0]),
    locationId: locationId || null,
    shareToFeed: post.shareToFeed !== false,
    trialReel: post.trialReel || null,
    aiGenerated: !!aiGenerated,
  });

  async function createVideo(params, asset) {
    if (tryResumable && readMedia && typeof ig.uploadResumable === 'function') {
      let created = null;
      try {
        created = await ig.createContainer({ ...params, upload_type: 'resumable' });
      } catch (err) {
        if (!resumableUnsupported(err)) throw err;
        log('Direct video upload is not available for this connection; using a link instead.');
      }
      if (created && created.uri) {
        try {
          const bytes = await readMedia(asset);
          await ig.uploadResumable(created.uri, bytes);
          return created.id;
        } catch (err) {
          if (err instanceof IgError && (err.isAuth || err.isRateLimit)) throw err;
          log('Direct video upload failed; using a link instead.');
        }
      }
    }
    const { url } = await expose(asset);
    return (await ig.createContainer({ ...params, video_url: url })).id;
  }

  async function createImage(params, asset) {
    const { url } = await expose(asset);
    return (await ig.createContainer({ ...params, image_url: url })).id;
  }

  async function reelParams() {
    const p = {
      media_type: 'REELS',
      caption,
      share_to_feed: post.shareToFeed !== false,
      collaborators,
      location_id: locationId,
      user_tags: tags.map((t) => ({ username: stripAt(t.username) })),
      is_ai_generated: aiGenerated,
    };
    // Trial reels are shown to non-followers first; graduation is manual or automatic.
    if (post.trialReel === 'MANUAL' || post.trialReel === 'SS_PERFORMANCE') p.trial_params = { graduation_strategy: post.trialReel };
    if (post.coverAssetId) {
      const cover = getAsset(post.coverAssetId);
      if (cover) p.cover_url = (await expose(cover)).url;
      else warnings.push('The cover image is missing from the library, so Instagram picked the cover.');
    } else if (post.thumbOffsetMs !== null && post.thumbOffsetMs !== undefined && Number.isFinite(Number(post.thumbOffsetMs))) {
      p.thumb_offset = Math.max(0, Math.round(Number(post.thumbOffsetMs)));
    }
    return clean(p);
  }

  /** Create every container for the post (children first for carousels). */
  async function createAll() {
    containers = { parent: null, children: [], type, fp, createdAt: new Date().toISOString() };
    if (type === 'carousel') {
      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        const asset = getAsset(ref.assetId);
        let id;
        if (asset.kind === 'video') {
          id = await createVideo({ is_carousel_item: true, media_type: 'VIDEO' }, asset);
        } else {
          id = await createImage(clean({ is_carousel_item: true, alt_text: ref.altText || undefined, user_tags: tagsWithXY(i) }), asset);
        }
        containers.children.push(id);
      }
      log(`Created ${containers.children.length} carousel items.`);
      await save();
      return;
    }
    const ref = refs[0];
    const asset = getAsset(ref.assetId);
    if (type === 'story') {
      const userTags = tags.map((t) => {
        const tag = { username: stripAt(t.username) };
        if (t.x !== undefined && t.y !== undefined && t.x !== null && t.y !== null) Object.assign(tag, { x: clamp01(t.x), y: clamp01(t.y) });
        return tag;
      });
      const base = clean({ media_type: 'STORIES', user_tags: userTags });
      containers.parent = asset.kind === 'video' ? await createVideo(base, asset) : await createImage(base, asset);
    } else if (type === 'reel' || asset.kind === 'video') {
      if (asset.kind !== 'video') {
        throw new IgError('A reel needs a video.', { code: 'invalid_media', permanent: true, userMessage: 'A reel needs exactly one video.' });
      }
      containers.parent = await createVideo(await reelParams(), asset);
    } else {
      const params = clean({
        caption,
        alt_text: ref.altText || post.altText || undefined,
        user_tags: tagsWithXY(0),
        location_id: locationId,
        collaborators,
        is_ai_generated: aiGenerated,
      });
      containers.parent = await createImage(params, asset);
    }
    log('Created the media container.');
    await save();
  }

  /** Poll until every id is FINISHED (or PUBLISHED). Returns {id: statusCode}. */
  async function waitFor(ids) {
    const pending = new Set(ids);
    const final = {};
    for (;;) {
      for (const id of [...pending]) {
        const { statusCode, status } = await ig.containerStatus(id);
        if (statusCode === 'FINISHED' || statusCode === 'PUBLISHED') {
          final[id] = statusCode;
          pending.delete(id);
        } else if (statusCode === 'ERROR') {
          throw containerError(status);
        } else if (statusCode === 'EXPIRED') {
          throw new ExpiredSignal(id);
        }
      }
      if (!pending.size) return final;
      if (elapsed() >= maxWaitMs) {
        throw new PublishPendingError('Instagram is still processing the media.', snapshot());
      }
      await nap();
    }
  }

  async function locatePublished(startedAt) {
    const since = Date.parse(post.publishStartedAt || startedAt || 0) - 10 * 60_000;
    if (type === 'story') {
      const stories = await ig.stories();
      const found = stories
        .filter((s) => !s.timestamp || Date.parse(s.timestamp) >= since)
        .sort((a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0))[0];
      return found ? { id: found.id, permalink: found.permalink || null } : null;
    }
    const recent = await ig.listMedia({ limit: 10, max: 10 });
    const prefix = normText(post.caption).slice(0, 60);
    const inWindow = (m) => !m.timestamp || Date.parse(m.timestamp) >= since;
    let found;
    if (prefix) {
      found = recent.find((m) => normText(m.caption).startsWith(prefix) && inWindow(m));
    } else {
      // No caption to match: accept only a single captionless post of the same kind, never a guess.
      const want = type === 'carousel' ? 'CAROUSEL_ALBUM' : type === 'reel' || getAsset(refs[0].assetId).kind === 'video' ? 'VIDEO' : 'IMAGE';
      const cands = recent.filter((m) => !normText(m.caption) && (!m.mediaType || m.mediaType === want) && inWindow(m));
      found = cands.length === 1 ? cands[0] : null;
    }
    return found ? { id: found.id, permalink: found.permalink || null } : null;
  }

  async function addFirstComment(mediaId, { checkExisting = false } = {}) {
    const text = normText(post.firstComment) ? post.firstComment : '';
    if (!text || type === 'story') return null;
    try {
      if (checkExisting) {
        const existing = await ig.comments(mediaId, { max: 50 });
        const same = existing.find((c) => normText(c.text) === normText(text));
        if (same) return same.id;
      }
      const res = await ig.post(`/${mediaId}/comments`, { message: text });
      return res.id || null;
    } catch (err) {
      // Never resend: a comment whose response was lost may already be on the post.
      if (err && err.maybeSent) warnings.push('The post is live, but Instagram did not confirm the first comment. Check the post and add it by hand if it is missing.');
      else warnings.push(`The post is live, but the first comment could not be added: ${describeIgError(err)}`);
      return null;
    }
  }

  async function finish(mediaId, permalink, { resumed = false } = {}) {
    let link = permalink || null;
    if (mediaId && !link) {
      try {
        const m = await ig.getMedia(mediaId, 'id,permalink,timestamp');
        link = m.permalink || null;
      } catch (err) {
        if (err instanceof IgError && err.isAuth) throw err;
        warnings.push('Published, but Instagram did not return the post link yet.');
      }
    }
    const firstCommentId = mediaId ? await addFirstComment(mediaId, { checkExisting: resumed }) : null;
    return { igMediaId: mediaId, permalink: link, containers: snapshot(), firstCommentId, warnings, exposed };
  }

  async function finishFromPublished(startedAt) {
    // The container status already proves the post is live, so a failed lookup is only a warning.
    let found = null;
    try {
      found = await locatePublished(startedAt);
    } catch (err) {
      if (err instanceof IgError && err.isAuth) throw err; // the worker keeps the containers and resumes after reconnecting
      log(`Could not look up the published post: ${describeIgError(err)}`);
    }
    if (!found) {
      warnings.push('Instagram reports this post as published, but Postpilot could not find it among your recent posts.');
      return { igMediaId: null, permalink: null, containers: snapshot(), firstCommentId: null, warnings, exposed };
    }
    log('Found the post that was published on an earlier run.');
    return finish(found.id, found.permalink, { resumed: true });
  }

  // ----- resume from an earlier run ---------------------------------------------------------
  const prev = post.containers;
  if (prev && (prev.parent || (Array.isArray(prev.children) && prev.children.length))) {
    // Containers saved before fingerprints existed are treated as matching.
    containers = { parent: prev.parent || null, children: [...(prev.children || [])], type, fp: prev.fp || fp, createdAt: prev.createdAt || null };
    if (prev.parent) {
      const { statusCode } = await statusOf(prev.parent);
      // Checked before the edit check below, so an already-published container is never published twice.
      if (statusCode === 'PUBLISHED') return finishFromPublished(prev.createdAt);
      if (statusCode !== 'FINISHED' && statusCode !== 'IN_PROGRESS') {
        log(`The earlier upload is no longer usable (${statusCode}); starting over.`);
        containers = null;
      }
    } else {
      const states = await Promise.all(containers.children.map((id) => statusOf(id)));
      if (states.some((s) => s.statusCode !== 'FINISHED' && s.statusCode !== 'IN_PROGRESS')) {
        log('An earlier carousel item is no longer usable; starting over.');
        containers = null;
      }
    }
    if (containers && prev.fp && prev.fp !== fp) {
      log('The post was edited since the earlier upload; uploading again.');
      containers = null;
    } else if (containers && prev.parent) {
      log('Resuming the earlier upload.');
    }
  }

  await checkLimit();

  // ----- create / wait ------------------------------------------------------------------------
  let parentStatus = null;
  for (let attempt = 0; ; attempt++) {
    try {
      if (!containers) await createAll();
      if (type === 'carousel' && !containers.parent) {
        await waitFor(containers.children);
        const params = clean({ media_type: 'CAROUSEL', children: containers.children.join(','), caption, location_id: locationId, collaborators, is_ai_generated: aiGenerated });
        containers.parent = (await ig.createContainer(params)).id;
        log('Created the carousel container.');
        await save();
      }
      parentStatus = (await waitFor([containers.parent]))[containers.parent];
      break;
    } catch (err) {
      if (err instanceof ExpiredSignal) {
        if (attempt === 0) {
          log('The upload expired before publishing; uploading again.');
          containers = null;
          continue;
        }
        throw new IgError('The media container expired twice.', { code: 24, subcode: 2207008, permanent: false });
      }
      throw err;
    }
  }

  if (parentStatus === 'PUBLISHED') return finishFromPublished(containers.createdAt);

  // ----- publish ------------------------------------------------------------------------------
  let mediaId = null;
  for (let i = 0; ; i++) {
    try {
      mediaId = await ig.publishContainer(containers.parent);
      break;
    } catch (err) {
      if (err instanceof IgError && err.subcode === 2207027 && i < 3) {
        await nap();
        continue;
      }
      if (err instanceof IgError && !err.isAuth) {
        // The outcome may be unknown (lost response), or a retry hit an already-published
        // container (100/2207006): check whether Instagram published it anyway.
        const s = await statusOf(containers.parent).catch(() => null);
        if (s && s.statusCode === 'PUBLISHED') return finishFromPublished(containers.createdAt);
      }
      throw err;
    }
  }
  log('Published.');
  return finish(mediaId, null);
}

/**
 * Decide what to do with a failed publish.
 * @returns {{permanent: boolean, userMessage: string, code, subcode, pending?: boolean, auth?: boolean, rateLimit?: boolean}}
 */
export function classifyError(err) {
  if (!err) return { permanent: false, userMessage: 'Something went wrong.', code: null, subcode: null };
  if (err instanceof PublishPendingError || err.name === 'PublishPendingError') {
    return { permanent: false, pending: true, userMessage: err.userMessage || err.message, code: 'pending', subcode: null };
  }
  if (err instanceof IgError || err.name === 'IgError') {
    return {
      permanent: !!err.isPermanent && !RETRY_SUBCODES.has(err.subcode),
      userMessage: err.userMessage || err.message,
      code: err.code ?? null,
      subcode: err.subcode ?? null,
      auth: !!err.isAuth,
      rateLimit: !!err.isRateLimit,
    };
  }
  const bug = ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(err.name);
  return {
    permanent: err.permanent === true || bug,
    userMessage: err.userMessage || err.message || String(err),
    code: err.code ?? null,
    subcode: null,
  };
}
