// Composer: create, edit, schedule and publish one post. app.js renders it (via openComposer) as
//   <Composer initial=${null | postId | partialPost} onClose=${fn} />
// inside its own Drawer (a full-height sheet on phones).

import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { AiError } from '../../core/ai.js';
import { LIMITS, addHistory, hashtagsIn, mentionsIn, newPost, uid, validatePost } from '../../core/model.js';
import { bestTimeMatrix, suggestSlots } from '../../core/schedule.js';
import { format, formatDateTime, relative } from '../../core/time.js';
import { aiPrefs, getAi } from '../ai-client.js';
import { useApp } from '../app.js';
import { loadViewCss } from '../css.js';
import { getStore, refreshNow, transact, useDocs } from '../data.js';
import { isImageFile, isVideoFile, prepareFile, thumbBase64, uploadPrepared, videoFrame } from '../media.js';
import { CropEditor, ratioLabel } from '../ui/crop-editor.js';
import { Icon } from '../ui/icons.js';
import {
  Badge,
  Button,
  Callout,
  CharCounter,
  Chip,
  ChipInput,
  DateTimeField,
  Drawer,
  EmptyState,
  Field,
  Frame,
  IconButton,
  Kbd,
  Menu,
  Segmented,
  Skeleton,
  Stat,
  StatusPill,
  TextArea,
  TextInput,
  Toggle,
  cx,
  useMediaQuery,
} from '../ui/kit.js';
import { MediaPicker, formatDuration, useAssetUrl } from '../ui/media-picker.js';
import { PostPreview } from '../ui/post-preview.js';

loadViewCss('composer');

// ---------------------------------------------------------------------------
// Constants and helpers

const TYPES = [
  { value: 'feed', label: 'Post', icon: 'image' },
  { value: 'carousel', label: 'Carousel', icon: 'carousel' },
  { value: 'reel', label: 'Reel', icon: 'reel' },
  { value: 'story', label: 'Story', icon: 'story' },
];
const TYPE_NAME = { feed: 'post', carousel: 'carousel', reel: 'reel', story: 'story' };
const EDITABLE = ['type', 'caption', 'firstComment', 'media', 'location', 'collaborators', 'userTags', 'shareToFeed', 'coverAssetId', 'thumbOffsetMs', 'trialReel', 'aiGenerated', 'altText', 'scheduledAt', 'labels', 'notes'];
const CAPTION_ID = 'cmp-caption';
const FIRST_COMMENT_ID = 'cmp-first-comment';
const FIELD_TARGET = { type: 'cmp-type', media: 'cmp-media', caption: CAPTION_ID, firstComment: FIRST_COMMENT_ID, collaborators: 'cmp-details', location: 'cmp-details', trialReel: 'cmp-reel', cover: 'cmp-reel' };
const ALT_MAX = 1000;
const LOCKED = ['publishing', 'published', 'canceled'];
const SOURCE_LABEL = { autopilot: 'Autopilot', evergreen: 'Evergreen queue', csv: 'Imported', recycle: 'Recycled' };
const EVENT_LABEL = {
  created: 'Created',
  draft: 'Saved as draft',
  edited: 'Edited',
  scheduled: 'Scheduled',
  rescheduled: 'Rescheduled',
  queued: 'Added to the queue',
  unscheduled: 'Moved to drafts',
  approved: 'Approved',
  publish_now: 'Publish now requested',
  retry: 'Retry requested',
  publishing: 'Publishing started',
  processing: 'Instagram is processing',
  resumed: 'Publishing resumed',
  published: 'Published',
  failed: 'Failed',
  warning: 'Note',
};

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k] === undefined ? null : obj[k]]));
const snapshot = (post) => JSON.stringify(pick(post, EDITABLE));
const ratioOf = (a) => (a && a.width && a.height ? a.width / a.height : null);
const outOfFeedRange = (a) => {
  const r = ratioOf(a);
  return !!(a && a.kind === 'image' && r && (r < LIMITS.feedAspectMin - 0.01 || r > LIMITS.feedAspectMax + 0.01));
};
const normUser = (s) => {
  const u = String(s || '').trim().replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(u) ? u : null;
};
const normTag = (s) => {
  const body = String(s || '').trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
  return body ? `#${body}` : null;
};
const errText = (err) => (err && (err.userMessage || err.message)) || String(err);
const TAG_RE = /(^|[^\w&])(#[\p{L}\p{N}_]+)/gu;

/** "Tue 14, 12:00 PM" in the account time zone. */
function slotLabel(iso, tz) {
  return format(iso, tz, { weekday: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Read an asset's decrypted bytes as a Blob (kept for the last few assets). */
const blobCache = new Map();
function assetBlob(asset) {
  if (!blobCache.has(asset.id)) {
    const p = getStore()
      .readBytes(asset.path)
      .then((bytes) => {
        if (!bytes) throw new Error('The media file is missing.');
        return new Blob([bytes], { type: asset.mime || (asset.kind === 'video' ? 'video/mp4' : 'image/jpeg') });
      });
    p.catch(() => blobCache.delete(asset.id));
    blobCache.set(asset.id, p);
    while (blobCache.size > 4) blobCache.delete(blobCache.keys().next().value);
  }
  return blobCache.get(asset.id);
}

/** Watch a post after "Publish now" and tell the owner when Instagram has it (keeps running after the composer closes). */
const watching = new Set();
function watchPublish(id, toast) {
  if (watching.has(id)) return;
  watching.add(id);
  const started = Date.now();
  const tick = async () => {
    let p = null;
    try {
      await refreshNow();
      const doc = await getStore().read('posts');
      p = doc.posts.find((x) => x.id === id);
    } catch {
      /* offline for a moment: try again */
    }
    if (p && p.status === 'published') {
      watching.delete(id);
      toast('Published on Instagram.', { kind: 'success', duration: 8000, action: p.permalink ? { label: 'View post', onClick: () => window.open(p.permalink, '_blank', 'noopener') } : undefined });
      return;
    }
    if (p && p.status === 'failed') {
      watching.delete(id);
      toast(`Instagram did not publish the post: ${(p.lastError && p.lastError.message) || 'unknown error'}`, { kind: 'error' });
      return;
    }
    if (!p && Date.now() - started > 30_000) return watching.delete(id);
    if (Date.now() - started > 8 * 60_000) return watching.delete(id);
    setTimeout(tick, Date.now() - started < 90_000 ? 3000 : 15_000);
  };
  setTimeout(tick, 2500);
}

/** Write the draft into the posts doc (merging onto the stored post so worker fields are kept). */
async function persist(draft, { status, event, detail, extra = {} }) {
  const fields = structuredClone(pick(draft, EDITABLE));
  let saved = null;
  await transact(
    async (tx) => {
      saved = null;
      const doc = await tx.read('posts');
      const i = doc.posts.findIndex((p) => p.id === draft.id);
      const prev = i >= 0 ? doc.posts[i] : null;
      if (prev && prev.status === 'publishing') throw new Error('This post is being published right now, so it cannot be changed.');
      if (prev && prev.status === 'published') throw new Error('This post is already on Instagram, so it cannot be changed. Duplicate it to post it again.');
      const next = Object.assign(prev ? structuredClone(prev) : structuredClone(draft), fields, { status }, structuredClone(extra));
      if (next.location && !String(next.location.id || '').trim() && !String(next.location.name || '').trim()) next.location = null;
      addHistory(next, event, detail);
      if (i >= 0) doc.posts[i] = next;
      else doc.posts.push(next);
      tx.write('posts', doc);
      saved = next;
    },
    { message: `composer: ${event}`, silent: true },
  );
  return saved;
}

function resolveInitial(initial, postsDoc, lib) {
  const byId = new Map(((lib && lib.assets) || []).map((a) => [a.id, a]));
  const list = (postsDoc && postsDoc.posts) || [];
  const id = typeof initial === 'string' ? initial : initial && initial.id && list.some((p) => p.id === initial.id) ? initial.id : null;
  if (id) {
    const p = list.find((x) => x.id === id);
    if (!p) return { missing: true };
    const base = newPost();
    return { draft: { ...base, ...structuredClone(p), collaborators: p.collaborators || [], userTags: p.userTags || [], labels: p.labels || [], media: p.media || [] }, existing: true, typeTouched: true };
  }
  const partial = initial && typeof initial === 'object' ? structuredClone(initial) : {};
  for (const k of ['id', 'status', 'history', 'igMediaId', 'permalink', 'publishedAt', 'attempts', 'lastError', 'containers', 'createdAt', 'updatedAt']) delete partial[k];
  const media = (partial.media || [])
    .filter((m) => m && m.assetId)
    .slice(0, LIMITS.carouselMax)
    .map((m) => ({ assetId: m.assetId, kind: m.kind || (byId.get(m.assetId) || {}).kind || 'image', altText: m.altText || '' }));
  let type = partial.type;
  const touched = !!type;
  if (!type) type = media.length > 1 ? 'carousel' : media.length === 1 && media[0].kind === 'video' ? 'reel' : 'feed';
  return { draft: newPost({ ...partial, type, media, status: 'draft', needsApproval: false }), existing: false, typeTouched: touched };
}

// ---------------------------------------------------------------------------
// Entry

export default function Composer({ initial, onClose }) {
  const { data: docs, error } = useDocs(['posts', 'library', 'hashtags', 'audience', 'analytics-media']);
  const [start, setStart] = useState(null);
  useEffect(() => {
    if (start || !docs.posts || !docs.library) return;
    setStart(resolveInitial(initial, docs.posts, docs.library));
  }, [docs.posts, docs.library]);

  if (!start || start.missing) {
    return html`<${Drawer} open=${true} title=${start ? 'Post not found' : error ? 'Could not open the composer' : 'Loading'} onClose=${onClose} width=${1120} class="cmp-drawer">
      ${start
        ? html`<${EmptyState} icon="calendar" title="This post no longer exists" body="It may have been deleted on another device." action=${html`<${Button} onClick=${onClose}>Close<//>`} />`
        : error
          ? html`<${Callout} tone="danger" title="Your posts could not be loaded">${errText(error)}. Check your connection, then close this panel and try again.<//>`
          : html`<div class="cmp-loading"><${Skeleton} height=${36} width="60%" /><${Skeleton} height=${140} /><${Skeleton} lines=${4} /></div>`}
    <//>`;
  }
  return html`<${Editor} start=${start} docs=${docs} onClose=${onClose} />`;
}

// ---------------------------------------------------------------------------
// Editor

function Editor({ start, docs, onClose }) {
  const app = useApp();
  const { settings, tz, toast, confirm, dispatchWorker, openComposer, navigate } = app;
  const wide = useMediaQuery('(min-width: 1024px)');
  const [draft, setDraft] = useState(start.draft);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [baseline, setBaseline] = useState(() => snapshot(start.draft));
  const existing = start.existing;
  const typeTouched = useRef(start.typeTouched);
  const autoRef = useRef(null);
  const [note, setNote] = useState('');
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState('');
  const [picker, setPicker] = useState(null); // 'media' | 'cover'
  const [crop, setCrop] = useState(null);
  const cropSeq = useRef(0);
  const [uploads, setUploads] = useState([]);
  const chain = useRef(Promise.resolve());
  const mounted = useRef(true);
  const [tab, setTab] = useState('edit');
  const [previewMode, setPreviewMode] = useState('feed');
  const [frameUrl, setFrameUrl] = useState(null);
  const [dropping, setDropping] = useState(false);
  const [dragFrom, setDragFrom] = useState(-1);
  const [recropping, setRecropping] = useState('');
  const [showDetails, setShowDetails] = useState(() => !!(start.draft.collaborators?.length || start.draft.location || start.draft.userTags?.length || start.draft.labels?.length || start.draft.notes || start.draft.aiGenerated));
  const fileRef = useRef(null);
  const coverFileRef = useRef(null);
  const primaryRef = useRef(null);
  const overlayRef = useRef({ picker: null, crop: null });
  overlayRef.current = { picker, crop };

  useEffect(() => () => (mounted.current = false), []);
  useEffect(() => () => frameUrl && URL.revokeObjectURL(frameUrl), [frameUrl]);

  const posts = (docs.posts && docs.posts.posts) || [];
  const assets = (docs.library && docs.library.assets) || [];
  const assetsById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [docs.library]);
  const live = existing ? posts.find((p) => p.id === draft.id) : null;
  const liveStatus = live ? live.status : draft.status;
  const ro = existing && LOCKED.includes(liveStatus);
  const dirty = !ro && snapshot(draft) !== baseline;
  const uploading = uploads.some((u) => !u.error);
  const type = draft.type;
  const ai = getAi(settings);
  const account = (settings && settings.ig) || null;
  const username = (account && account.username) || 'your account';

  // Automatic type note ("Switched to Carousel ...").
  useEffect(() => {
    if (!autoRef.current) return;
    const { to, n } = autoRef.current;
    autoRef.current = null;
    setNote(to === 'carousel' ? `Switched to Carousel because you added ${n} items.` : to === 'reel' ? 'Switched to Reel because you added a video.' : 'Switched back to a single post.');
  }, [draft.type]);

  // Warn before leaving the page with unsaved changes.
  useEffect(() => {
    if (!dirty && !uploading) return undefined;
    const fn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', fn);
    return () => window.removeEventListener('beforeunload', fn);
  }, [dirty, uploading]);

  const update = (p) => setDraft((d) => (typeof p === 'function' ? p(d) : { ...d, ...p }));

  /** Apply automatic type changes after the media list changed (only until the owner picks a type). */
  const autoType = (d) => {
    if (typeTouched.current) return d;
    let t = d.type;
    if (t === 'feed' && d.media.length >= 2) t = 'carousel';
    else if (t === 'feed' && d.media.length === 1 && d.media[0].kind === 'video') t = 'reel';
    else if (t === 'carousel' && d.media.length === 1 && d.media[0].kind !== 'video') t = 'feed';
    else if (t === 'reel' && d.media.length === 1 && d.media[0].kind === 'image') t = 'feed';
    if (t === d.type) return d;
    autoRef.current = { to: t, n: d.media.length };
    return { ...d, type: t, trialReel: t === 'reel' ? d.trialReel : null };
  };

  const isSingle = (t) => t === 'reel' || t === 'story';

  const addAssets = (list) => {
    if (!list.length) return;
    const refs = list.map((a) => ({ assetId: a.id, kind: a.kind, altText: '' }));
    setDraft((d) => {
      const single = isSingle(d.type);
      const media = single ? refs.slice(0, 1) : [...d.media, ...refs].slice(0, LIMITS.carouselMax);
      const next = autoType({ ...d, media, coverAssetId: d.coverAssetId, thumbOffsetMs: single && d.media[0]?.assetId !== media[0]?.assetId ? null : d.thumbOffsetMs });
      return next;
    });
    setSel(isSingle(draftRef.current.type) ? 0 : Math.min(LIMITS.carouselMax - 1, draftRef.current.media.length));
  };

  const removeAt = (i) => {
    setDraft((d) => {
      const media = d.media.filter((_, j) => j !== i);
      const positional = d.type === 'feed' || d.type === 'carousel';
      const userTags = positional
        ? (d.userTags || []).filter((t) => (t.mediaIndex ?? 0) !== i).map((t) => ((t.mediaIndex ?? 0) > i ? { ...t, mediaIndex: t.mediaIndex - 1 } : t))
        : d.userTags;
      return autoType({ ...d, media, userTags });
    });
    setSel((s) => Math.max(0, s >= i ? s - 1 : s));
  };

  const move = (from, to) => {
    if (from === to || to < 0) return;
    setDraft((d) => {
      if (to >= d.media.length) return d;
      const media = [...d.media];
      const [item] = media.splice(from, 1);
      media.splice(to, 0, item);
      const order = d.media.map((_, j) => j);
      const [o] = order.splice(from, 1);
      order.splice(to, 0, o);
      const userTags = (d.userTags || []).map((t) => ({ ...t, mediaIndex: order.indexOf(t.mediaIndex ?? 0) }));
      return { ...d, media, userTags };
    });
    setSel(to);
  };

  // ---- Upload + crop flow -------------------------------------------------

  const askCrop = (opts) =>
    new Promise((resolve) => {
      cropSeq.current += 1;
      setCrop({ ...opts, key: cropSeq.current, resolve });
    });

  const lockRatioFor = (t, media) => {
    if (t === 'story') return 9 / 16;
    if (t !== 'carousel') return null;
    const first = media.map((m) => assetsById.get(m.assetId)).find((a) => a && a.kind === 'image');
    return first ? ratioOf(first) : null;
  };

  const cropOptsFor = (t, lock) => (lock ? { lockAspect: lock } : { aspects: t === 'story' ? ['story'] : ['portrait', 'square', 'landscape', 'original'] });

  function enqueue(file, cropResult, onDone, opts = {}) {
    const key = uid('up_');
    setUploads((u) => [...u, { key, name: file.name || 'file' }]);
    chain.current = chain.current.then(async () => {
      try {
        const prepared = await prepareFile(file, cropResult ? { aspect: cropResult.aspect, focus: cropResult.focus, zoom: cropResult.zoom } : {});
        if (opts.name) prepared.name = opts.name;
        const asset = await uploadPrepared(prepared, opts.upload || {});
        if (!mounted.current) return;
        onDone(asset);
        setUploads((u) => u.filter((x) => x.key !== key));
      } catch (err) {
        if (mounted.current) setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: errText(err) } : x)));
      }
    });
    return chain.current;
  }

  async function handleFiles(fileList) {
    const all = [...fileList];
    let files = all.filter((f) => isImageFile(f) || isVideoFile(f));
    if (files.length < all.length) toast(`${all.length - files.length} file${all.length - files.length === 1 ? ' was' : 's were'} skipped. Only photos and videos can be added.`, { kind: 'error' });
    const t = draftRef.current.type;
    if (t === 'reel') {
      const videos = files.filter(isVideoFile);
      if (!videos.length && files.length) {
        toast('A reel needs a video. Switch to Post or Story to share a photo.', { kind: 'error' });
        return;
      }
      files = videos;
    }
    if (isSingle(t)) files = files.slice(0, 1);
    const pending = uploads.filter((u) => !u.error).length;
    const room = isSingle(t) ? 1 : LIMITS.carouselMax - draftRef.current.media.length - pending;
    if (room <= 0) {
      toast(`A carousel holds up to ${LIMITS.carouselMax} items.`, { kind: 'error' });
      return;
    }
    if (files.length > room) {
      toast(`A carousel holds up to ${LIMITS.carouselMax} items, so ${files.length - room} ${files.length - room === 1 ? 'was' : 'were'} left out.`, { kind: 'error' });
      files = files.slice(0, room);
    }
    let lock = lockRatioFor(t, draftRef.current.media);
    let reuse = null;
    const photos = files.filter(isImageFile).length;
    let seen = 0;
    for (const file of files) {
      let c = null;
      if (isImageFile(file)) {
        seen += 1;
        if (reuse) c = reuse;
        else {
          c = await askCrop({ source: file, name: file.name, ...cropOptsFor(t, lock), remaining: photos - seen });
          if (!c) return; // closed: stop this batch
          if (c.all) reuse = c;
        }
        if (!lock && (t === 'carousel' || (t === 'feed' && files.length + draftRef.current.media.length > 1))) lock = c.ratio;
        if (reuse && lock && !c.aspect) reuse = { ...reuse, aspect: lock };
      }
      enqueue(file, c, (asset) => addAssets([asset]));
    }
  }

  async function recrop(index) {
    const m = draftRef.current.media[index];
    const asset = m && assetsById.get(m.assetId);
    if (!asset || asset.kind !== 'image') return;
    setRecropping(asset.id);
    let blob;
    try {
      blob = await assetBlob(asset);
    } catch (err) {
      setRecropping('');
      toast(`Could not open the photo: ${errText(err)}`, { kind: 'error' });
      return;
    }
    setRecropping('');
    const t = draftRef.current.type;
    const others = draftRef.current.media.filter((_, j) => j !== index);
    const lock = t === 'carousel' && index > 0 ? lockRatioFor(t, others) : t === 'story' ? 9 / 16 : null;
    const c = await askCrop({ source: blob, name: asset.name, ...cropOptsFor(t, lock), title: 'Crop photo', applyLabel: 'Save crop' });
    if (!c) return;
    const base = String(asset.name || 'Photo').replace(/\s·\s[\d.:]+$/, '');
    const file = new File([blob], `${base}.jpg`, { type: asset.mime || 'image/jpeg' });
    enqueue(
      file,
      c,
      (next) => {
        setDraft((d) => ({ ...d, media: d.media.map((x) => (x.assetId === asset.id ? { ...x, assetId: next.id, kind: next.kind } : x)) }));
        toast('Cropped copy saved to your library.', { kind: 'success' });
      },
      { name: `${base} · ${ratioLabel(c.ratio)}`, upload: { folderId: asset.folderId || null, tags: asset.tags || [], captionHint: asset.captionHint || '', notes: asset.notes || '' } },
    );
  }

  async function handleCoverFile(file) {
    if (!file || !isImageFile(file)) {
      toast('Choose a photo for the cover.', { kind: 'error' });
      return;
    }
    const c = await askCrop({ source: file, name: file.name, lockAspect: 9 / 16, title: 'Crop cover', applyLabel: 'Use as cover' });
    if (!c) return;
    enqueue(file, c, (asset) => update({ coverAssetId: asset.id }));
  }

  // Paste photos anywhere in the composer (text paste is left alone).
  useEffect(() => {
    const onPaste = (e) => {
      if (overlayRef.current.picker || overlayRef.current.crop || document.querySelector('.overlay-modal')) return;
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      if (LOCKED.includes(draftRef.current.status) && existing) return;
      handleFiles(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  // Cmd/Ctrl+Enter runs the primary action.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
      // Only when the composer is the topmost overlay (not under the picker, crop editor or a dialog).
      if (overlayRef.current.picker || overlayRef.current.crop || document.querySelector('.overlay-modal')) return;
      e.preventDefault();
      primaryRef.current?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ---- Validation ---------------------------------------------------------

  const issues = useMemo(() => {
    const list = validatePost({ ...draft, status: 'scheduled' }, assetsById);
    const loc = draft.location;
    if (loc && String(loc.id || '').trim() && !/^\d+$/.test(String(loc.id).trim())) list.push({ level: 'error', field: 'location', message: 'The Facebook location ID must be a number.' });
    if (draft.type === 'reel' && draft.coverAssetId && !assetsById.get(draft.coverAssetId)) list.push({ level: 'warning', field: 'cover', message: 'The cover image is missing from the library, so Instagram will pick a frame.' });
    if (draft.media.some((m) => (m.altText || '').length > ALT_MAX)) list.push({ level: 'error', field: 'media', message: `Alt text is limited to ${ALT_MAX} characters.` });
    if (draft.type === 'carousel') {
      const ratios = draft.media.map((m) => ratioOf(assetsById.get(m.assetId))).filter(Boolean);
      if (ratios.some((r) => Math.abs(r - ratios[0]) > 0.02)) list.push({ level: 'warning', field: 'media', message: `Instagram crops every carousel item to the shape of the first one (${ratioLabel(ratios[0])}).` });
    }
    const seen = new Set();
    return list.filter((i) => !seen.has(i.message) && seen.add(i.message));
  }, [draft, assetsById]);
  const pristine = !existing && !dirty;
  const allIssues = issues.filter((i) => i.field !== 'scheduledAt');
  // A brand-new, untouched post does not shout "Add a photo" at the owner; the buttons still wait.
  const shownIssues = pristine ? [] : allIssues;
  const errors = allIssues.filter((i) => i.level === 'error');
  const issuesFor = (field) => shownIssues.filter((i) => i.field === field);

  // ---- Best times ---------------------------------------------------------

  const matrix = useMemo(
    () =>
      bestTimeMatrix({
        onlineFollowers: docs.audience && docs.audience.onlineFollowers,
        mediaStats: docs['analytics-media'] && docs['analytics-media'].media,
        tz,
      }).matrix,
    [docs.audience, docs['analytics-media'], tz],
  );
  const taken = useMemo(
    () =>
      posts
        .filter((p) => p.id !== draft.id && ['scheduled', 'publishing'].includes(p.status) && p.scheduledAt && (p.type === 'story') === (type === 'story'))
        .map((p) => p.scheduledAt),
    [docs.posts, draft.id, type],
  );
  const best = useMemo(() => {
    try {
      return suggestSlots({ matrix, tz, count: 3, taken, horizonDays: 14 });
    } catch {
      return [];
    }
  }, [matrix, tz, taken]);

  // ---- Actions --------------------------------------------------------------

  const requestClose = async () => {
    if (uploading) {
      const ok = await confirm({ title: 'Uploads are still running', body: 'Close anyway? Files that finish uploading stay in your library but are not added to this post.', confirmLabel: 'Close', danger: true });
      if (!ok) return;
    } else if (dirty) {
      const ok = await confirm({ title: 'Discard your changes?', body: existing ? 'Your edits to this post will be lost.' : 'This post has not been saved.', confirmLabel: 'Discard', danger: true });
      if (!ok) return;
    }
    onClose();
  };

  async function act(kind, fn) {
    if (busy) return;
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      toast(errText(err), { kind: 'error' });
      if (mounted.current) setBusy('');
      return;
    }
    if (mounted.current) setBusy('');
  }

  const editAction = (id) => ({ label: 'Edit', onClick: () => openComposer(id) });

  const saveDraft = () =>
    act('draft', async () => {
      const wasFailed = draft.status === 'failed';
      const saved = await persist(draft, { status: 'draft', event: existing ? (draft.status === 'scheduled' ? 'unscheduled' : 'edited') : 'draft', extra: wasFailed ? { lastError: null, attempts: 0 } : {} });
      setBaseline(snapshot(saved));
      toast(existing && draft.status === 'scheduled' ? 'Moved to drafts.' : 'Draft saved.', { kind: 'success', action: editAction(saved.id) });
      onClose();
    });

  const schedule = (how = 'schedule') =>
    act(how, async () => {
      let at = draft.scheduledAt;
      if (how === 'queue') {
        at = suggestSlots({ matrix, tz, count: 1, taken, horizonDays: 30 })[0];
        if (!at) throw new Error('There is no free best time in the next 30 days. Pick a time instead.');
      }
      if (!at) throw new Error('Pick a date and time first.');
      const event = how === 'queue' ? 'queued' : how === 'approve' ? 'approved' : existing && draft.status === 'scheduled' ? (at !== start.draft.scheduledAt ? 'rescheduled' : 'edited') : 'scheduled';
      const saved = await persist({ ...draft, scheduledAt: at }, { status: 'scheduled', event, extra: { needsApproval: false, lastError: null, attempts: draft.status === 'failed' ? 0 : draft.attempts || 0 } });
      setBaseline(snapshot(saved));
      const when = formatDateTime(at, tz);
      toast(how === 'queue' ? `Added to the queue for ${when}.` : how === 'approve' ? `Approved. Scheduled for ${when}.` : `Scheduled for ${when}.`, { kind: 'success', action: editAction(saved.id) });
      onClose();
    });

  const publishNow = (retry = false) =>
    act('publish', async () => {
      if (!retry) {
        const ok = await confirm({
          title: 'Publish now?',
          body: `This posts the ${TYPE_NAME[type]} to @${username} on Instagram right away. Published posts cannot be edited.`,
          confirmLabel: 'Publish now',
        });
        if (!ok) return;
      }
      const saved = await persist(draft, {
        status: 'scheduled',
        event: retry ? 'retry' : 'publish_now',
        extra: { scheduledAt: new Date().toISOString(), needsApproval: false, attempts: 0, lastError: null },
      });
      setBaseline(snapshot(saved));
      onClose();
      toast('Publishing… usually takes 1–3 minutes.', { kind: 'info', duration: 6000 });
      watchPublish(saved.id, toast);
      dispatchWorker('publish now').catch(() => {
        /* dispatchWorker already explained the problem; the scheduled worker run still publishes it */
      });
    });

  const remove = () =>
    act('delete', async () => {
      const ok = await confirm({ title: 'Delete this post?', body: 'It is removed from your planner. Media stays in your library. This cannot be undone.', confirmLabel: 'Delete post', danger: true });
      if (!ok) return;
      await transact(
        async (tx) => {
          const doc = await tx.read('posts');
          const p = doc.posts.find((x) => x.id === draft.id);
          if (p && p.status === 'publishing') throw new Error('This post is being published right now, so it cannot be deleted.');
          doc.posts = doc.posts.filter((x) => x.id !== draft.id);
          tx.write('posts', doc);
        },
        { message: 'composer: delete post', silent: true },
      );
      toast('Post deleted.', { kind: 'success' });
      onClose();
    });

  const duplicate = async (source = draft) => {
    if (dirty && source === draft) {
      const ok = await confirm({ title: 'Discard your changes?', body: 'Duplicating opens a copy of the saved post. Unsaved edits here are lost.', confirmLabel: 'Duplicate anyway', danger: true });
      if (!ok) return;
    }
    const copy = structuredClone(pick(source, EDITABLE.filter((k) => k !== 'scheduledAt')));
    openComposer({ ...copy, scheduledAt: null });
    toast('Copied into a new draft.', { kind: 'success' });
  };

  const goSettingsAi = async () => {
    if (dirty) {
      const ok = await confirm({ title: 'Discard your changes?', body: 'Opening Settings closes this post without saving.', confirmLabel: 'Discard', danger: true });
      if (!ok) return;
    }
    onClose();
    navigate('#/settings?section=ai');
  };

  const recentGrid = useMemo(() => {
    const media = docs['analytics-media'] && docs['analytics-media'].media;
    return Object.values(media || {})
      .filter((m) => m && m.productType !== 'STORY')
      .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
      .slice(0, 8)
      .map((m) => ({ src: m.thumbnailUrl || m.mediaUrl || null, kind: m.mediaType === 'CAROUSEL_ALBUM' ? 'carousel' : m.mediaType === 'VIDEO' ? 'reel' : 'image' }));
  }, [docs['analytics-media']]);


  // ---- Read-only (published / publishing / canceled) -----------------------

  if (ro) {
    return html`<${ReadOnly} post=${live || draft} docs=${docs} assetsById=${assetsById} account=${account} tz=${tz} wide=${wide}
      onClose=${onClose} onDuplicate=${() => duplicate(live || draft)} />`;
  }

  // ---- Primary action -----------------------------------------------------

  const approval = draft.needsApproval && draft.status === 'draft';
  const isScheduled = existing && draft.status === 'scheduled';
  const primaryLabel = approval ? 'Approve and schedule' : isScheduled ? 'Save changes' : 'Schedule';
  const canPublish = !busy && !uploading && !errors.length;
  const canPrimary = canPublish && !!draft.scheduledAt;
  primaryRef.current = canPrimary ? () => schedule(approval ? 'approve' : 'schedule') : null;
  const failed = draft.status === 'failed';
  const titleText = !existing ? 'New post' : approval ? 'Review draft' : failed ? 'Failed post' : draft.status === 'scheduled' ? 'Scheduled post' : 'Edit draft';
  const btnSize = wide ? 'md' : 'sm';

  const menuItems = existing
    ? [
        { label: 'Duplicate', icon: 'copy', onClick: () => duplicate() },
        isScheduled ? { label: 'Move to drafts', icon: 'clock', onClick: saveDraft } : null,
        '-',
        { label: 'Delete post', icon: 'trash', danger: true, onClick: remove },
      ].filter(Boolean)
    : [];

  const scrollTo = (field) => {
    const id = FIELD_TARGET[field] || 'cmp-issues';
    if (!wide) setTab('edit');
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (el.matches('textarea,input')) el.focus({ preventScroll: true });
    });
  };

  let stateText;
  if (pristine && errors.length) {
    stateText = html`<span class="muted">Add a photo or video to start</span>`;
  } else if (errors.length) {
    stateText = html`<button type="button" class="cmp-state-link text-bad" onClick=${() => scrollTo(errors[0].field)}>
      <${Icon} name="alert" size=${15} />${errors.length === 1 ? '1 thing to fix' : `${errors.length} things to fix`}
    </button>`;
  } else if (uploading) {
    stateText = html`<span class="muted">Uploading…</span>`;
  } else if (!draft.scheduledAt) {
    stateText = html`<span class="muted">Pick a time to schedule</span>`;
  } else {
    stateText = html`<span class="muted">Goes out ${relative(draft.scheduledAt)}${wide ? html` · <${Kbd}>${/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl'}<//> <${Kbd}>Enter<//>` : null}</span>`;
  }

  const when = html`<${WhenControls} draft=${draft} tz=${tz} best=${best}
    onChange=${(iso) => update({ scheduledAt: iso })} onQueue=${() => schedule('queue')} queueDisabled=${!canPublish} busy=${busy} />`;

  const footer = html`<div class="cmp-foot">
    ${wide ? when : null}
    <div class="cmp-actions">
      <span class="cmp-state">${stateText}</span>
      <span class="spacer"></span>
      ${menuItems.length ? html`<${Menu} items=${menuItems} label="More actions" size=${btnSize} />` : null}
      <${Button} variant="ghost" size=${btnSize} onClick=${saveDraft} loading=${busy === 'draft'} disabled=${!!busy && busy !== 'draft'}>${isScheduled ? 'Move to drafts' : 'Save draft'}<//>
      <${Button} size=${btnSize} icon=${failed ? 'refresh' : 'send'} onClick=${() => publishNow(failed)} loading=${busy === 'publish'} disabled=${!canPublish && busy !== 'publish'}>${failed ? 'Try again' : 'Publish now'}<//>
      <${Button} variant="primary" size=${btnSize} icon=${approval ? 'check' : 'calendar'} onClick=${() => schedule(approval ? 'approve' : 'schedule')}
        loading=${busy === 'schedule' || busy === 'approve' || busy === 'queue'} disabled=${!canPrimary && !['schedule', 'approve', 'queue'].includes(busy)}
        title=${!draft.scheduledAt ? 'Pick a date and time first' : errors.length ? 'Fix the problems listed first' : `${primaryLabel} (Ctrl+Enter)`}>${primaryLabel}<//>
    </div>
  </div>`;

  const sel0 = Math.min(sel, Math.max(0, draft.media.length - 1));
  const selRef = draft.media[sel0];
  const selAsset = selRef ? assetsById.get(selRef.assetId) : null;
  const videoAsset = type === 'reel' && draft.media[0] ? assetsById.get(draft.media[0].assetId) : null;
  const showCaption = type !== 'story' || !!(draft.caption && draft.caption.trim());

  const editor = html`<div class=${cx('cmp-main', !wide && tab !== 'edit' && 'is-hidden')}>
    ${existing ? html`<${StatusRow} post=${draft} live=${live} />` : null}
    ${failed && draft.lastError
      ? html`<${Callout} tone="danger" title="Instagram did not publish this post"
          action=${html`<${Button} size="sm" icon="refresh" onClick=${() => publishNow(true)} disabled=${!canPublish}>Try again<//>`}>
          ${draft.lastError.message}${draft.lastError.permanent ? ' Fix the problem, then try again.' : ''}
        <//>`
      : null}
    ${approval ? html`<${Callout} tone="marker" title="Autopilot drafted this post">Check the media and caption, then approve to schedule it for the time below.<//>` : null}
    ${live && existing && live.status !== start.draft.status && !LOCKED.includes(live.status)
      ? html`<${Callout} tone="warning" title="This post changed on another device">It is now ${live.status}. Saving here replaces those changes.<//>`
      : null}

    <section class="cmp-section" id="cmp-type" aria-label="Post type">
      <${Segmented} label="Post type" class="cmp-types" options=${TYPES} value=${type}
        onChange=${(t) => {
          typeTouched.current = true;
          setNote('');
          update((d) => ({ ...d, type: t, trialReel: t === 'reel' ? d.trialReel : null }));
        }} />
      <p class="cmp-type-hint text-sm muted">${TYPE_HINT[type]}</p>
    </section>

    <${MediaSection}
      draft=${draft} type=${type} assetsById=${assetsById} uploads=${uploads} sel=${sel0} setSel=${setSel} note=${note}
      issues=${issuesFor('media')} dropping=${dropping} dragFrom=${dragFrom} setDragFrom=${setDragFrom}
      onLibrary=${() => setPicker('media')} onUpload=${() => fileRef.current?.click()} onMove=${move} onRemove=${removeAt}
      onDismissUpload=${(key) => setUploads((u) => u.filter((x) => x.key !== key))}
      onSwitch=${(t, keepFirst) => {
        typeTouched.current = true;
        setNote('');
        update((d) => ({ ...d, type: t, media: keepFirst ? d.media.slice(0, 1) : d.media, trialReel: t === 'reel' ? d.trialReel : null }));
      }}
    />
    ${selRef
      ? html`<${ItemDetail} m=${selRef} index=${sel0} asset=${selAsset} type=${type} recropping=${selAsset && recropping === selAsset.id}
          onAlt=${(v) => update((d) => ({ ...d, media: d.media.map((x, j) => (j === sel0 ? { ...x, altText: v } : x)) }))}
          onCrop=${() => recrop(sel0)} />`
      : null}
    <input ref=${fileRef} type="file" class="sr-only" tabindex="-1" aria-hidden="true"
      accept=${type === 'reel' ? 'video/mp4,video/quicktime,video/*' : 'image/*,video/mp4,video/quicktime,video/*'} multiple=${!isSingle(type)}
      onChange=${(e) => {
        const files = [...e.currentTarget.files];
        e.currentTarget.value = '';
        handleFiles(files);
      }} />

    ${type === 'reel'
      ? html`<${ReelOptions} draft=${draft} update=${update} video=${videoAsset} assetsById=${assetsById} mode=${settings && settings.ig && settings.ig.mode}
          onPickCover=${() => setPicker('cover')} onUploadCover=${() => coverFileRef.current?.click()} setFrameUrl=${setFrameUrl} issues=${issuesFor('cover')} />
        <input ref=${coverFileRef} type="file" class="sr-only" tabindex="-1" aria-hidden="true" accept="image/*"
          onChange=${(e) => {
            const f = e.currentTarget.files[0];
            e.currentTarget.value = '';
            handleCoverFile(f);
          }} />`
      : null}
    ${type === 'story'
      ? html`<p class="cmp-story-note text-sm muted"><${Icon} name="info" size=${15} /> Stories stay up for 24 hours. Captions, links, stickers and polls cannot be added through Instagram's publishing API, so put any text in the image itself.</p>`
      : null}

    ${showCaption
      ? html`<${CaptionSection} draft=${draft} update=${update} hashtagsDoc=${docs.hashtags} issues=${issuesFor('caption')} />`
      : null}

    ${type !== 'story'
      ? ai
        ? html`<${AiPanel} ai=${ai} settings=${settings} draft=${draft} update=${update} assetsById=${assetsById} hashtagsDoc=${docs.hashtags} toast=${toast} />`
        : html`<p class="cmp-ai-off text-sm muted"><${Icon} name="sparkle" size=${15} /> Want help with captions and hashtags? <button type="button" class="cmp-link" onClick=${goSettingsAi}>Turn on AI in Settings</button>.</p>`
      : null}

    ${type !== 'story'
      ? html`<section class="cmp-section">
          <${Field} id=${FIRST_COMMENT_ID} label="First comment" error=${issuesFor('firstComment').find((i) => i.level === 'error')?.message}
            hint="Posted from your account right after publishing. Good for a question or extra details."
            action=${html`<${CharCounter} value=${draft.firstComment || ''} max=${LIMITS.firstCommentChars} />`}>
            <${TextArea} rows=${2} maxRows=${8} value=${draft.firstComment || ''} onChange=${(v) => update({ firstComment: v })} placeholder="Optional" />
          <//>
        </section>`
      : null}

    <${DetailsSection} open=${showDetails} setOpen=${setShowDetails} draft=${draft} update=${update} type=${type} sel=${sel0} assetsById=${assetsById}
      issues=${shownIssues} />

    <${IssuesList} issues=${shownIssues} onJump=${scrollTo} />

    ${!wide ? html`<section class="cmp-section cmp-when-section"><h3 class="label-caps">When to post</h3>${when}</section>` : null}

    ${existing ? html`<${History} post=${live || draft} />` : null}
  </div>`;

  const side = html`<aside class=${cx('cmp-side', !wide && tab !== 'preview' && 'is-hidden')} aria-label="Preview">
    <div class="cmp-side-head">
      <span class="label-caps">Preview</span>
      <${Segmented} size="sm" label="Preview mode" value=${previewMode} onChange=${setPreviewMode}
        options=${[{ value: 'feed', label: type === 'reel' ? 'Reel' : type === 'story' ? 'Story' : 'Post' }, { value: 'grid', label: 'Grid' }]} />
    </div>
    <${PostPreview} post=${draft} assetsById=${assetsById} account=${account} tz=${tz} mode=${previewMode} index=${sel0} onIndexChange=${setSel}
      coverUrl=${frameUrl} showTags=${showDetails} gridItems=${recentGrid}
      onMediaClick=${showDetails && (draft.userTags || []).length && (type === 'feed' || type === 'carousel' || type === 'story')
        ? (i, pt) => update((d) => placeTag(d, i, pt))
        : undefined} />
    <p class="text-xs faint cmp-side-note">Approximate preview. Instagram decides the final crop and text layout.</p>
  </aside>`;

  return html`<${Drawer} open=${true} title=${titleText} onClose=${requestClose} footer=${footer} width=${1120} class="cmp-drawer">
    <div class=${cx('cmp', wide && 'is-wide')}
      onDragOver=${(e) => {
        const types = [...(e.dataTransfer?.types || [])];
        if (types.includes('Files')) {
          e.preventDefault();
          if (!dropping) setDropping(true);
        }
      }}
      onDragLeave=${(e) => {
        if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) setDropping(false);
      }}
      onDrop=${(e) => {
        setDropping(false);
        if (e.dataTransfer?.files?.length) {
          e.preventDefault();
          handleFiles(e.dataTransfer.files);
        }
      }}>
      ${!wide
        ? html`<div class="cmp-tabs"><${Segmented} label="Show" value=${tab} onChange=${setTab}
            options=${[{ value: 'edit', label: 'Edit', icon: 'edit' }, { value: 'preview', label: 'Preview', icon: 'eye' }]} /></div>`
        : null}
      ${editor}
      ${side}
    </div>
    <${MediaPicker} open=${picker === 'media' || picker === 'cover'}
      onClose=${() => setPicker(null)}
      kinds=${picker === 'cover' ? ['image'] : type === 'reel' ? ['video'] : ['image', 'video']}
      multiple=${picker !== 'cover' && !isSingle(type)}
      max=${picker === 'cover' || isSingle(type) ? 1 : Math.max(1, LIMITS.carouselMax - draft.media.length)}
      title=${picker === 'cover' ? 'Choose a cover image' : type === 'reel' ? 'Choose a video' : type === 'story' ? 'Choose a photo or video' : 'Add from library'}
      confirmLabel=${picker === 'cover' ? 'Use as cover' : undefined}
      onPick=${(list) => {
        const target = picker;
        setPicker(null);
        if (target === 'cover') update({ coverAssetId: list[0].id });
        else addAssets(list);
      }} />
    ${crop
      ? html`<${CropEditor} key=${crop.key} open=${true} source=${crop.source} name=${crop.name} aspects=${crop.aspects} lockAspect=${crop.lockAspect}
          remaining=${crop.remaining || 0} title=${crop.title} applyLabel=${crop.applyLabel}
          onApply=${(r, o) => {
            const c = crop;
            setCrop(null);
            c.resolve({ ...r, all: !!(o && o.all) });
          }}
          onClose=${() => {
            const c = crop;
            setCrop(null);
            c.resolve(null);
          }} />`
      : null}
  <//>`;
}

const TYPE_HINT = {
  feed: 'One photo, shown in the feed and on your profile grid.',
  carousel: `${LIMITS.carouselMin} to ${LIMITS.carouselMax} photos or videos people swipe through.`,
  reel: 'One vertical video (9:16 looks best), 3 seconds to 15 minutes.',
  story: 'One photo or video, full screen, gone after 24 hours.',
};

/** Place (or move) the most recent unplaced tag - or the last tag - on media item i. */
function placeTag(d, i, pt) {
  const tags = [...(d.userTags || [])];
  const forItem = tags.map((t, j) => [t, j]).filter(([t]) => (t.mediaIndex ?? 0) === i);
  if (!forItem.length) return d;
  const target = forItem.find(([t]) => t.x == null || t.y == null) || forItem[forItem.length - 1];
  tags[target[1]] = { ...target[0], x: Math.round(pt.x * 1000) / 1000, y: Math.round(pt.y * 1000) / 1000 };
  return { ...d, userTags: tags };
}

// ---------------------------------------------------------------------------
// Sections

function StatusRow({ post }) {
  const src = SOURCE_LABEL[post.source];
  return html`<div class="cmp-status row">
    <${StatusPill} status=${post.needsApproval && post.status === 'draft' ? 'needs-approval' : post.status} />
    ${src ? html`<${Badge} tone="outline">${src}<//>` : null}
    <span class="text-sm muted">Created ${relative(post.createdAt)}${post.updatedAt && post.updatedAt !== post.createdAt ? ` · edited ${relative(post.updatedAt)}` : ''}</span>
  </div>`;
}

function MediaItem({ m, asset, index, count, selected, needsCrop, single, onSelect, onMove, onRemove, dragFrom, setDragFrom }) {
  const src = useAssetUrl(asset);
  const kind = m.kind === 'video' || (asset && asset.kind === 'video') ? 'video' : 'image';
  const name = asset ? asset.name || (kind === 'video' ? 'Video' : 'Photo') : 'Missing file';
  return html`<div class=${cx('cmp-item', selected && 'is-selected', dragFrom === index && 'is-dragging')} draggable=${single ? undefined : 'true'}
    onDragStart=${(e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-postpilot-item', String(index));
      setDragFrom(index);
    }}
    onDragOver=${(e) => {
      if ([...e.dataTransfer.types].includes('application/x-postpilot-item')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }
    }}
    onDrop=${(e) => {
      const from = e.dataTransfer.getData('application/x-postpilot-item');
      if (from !== '') {
        e.preventDefault();
        e.stopPropagation();
        onMove(Number(from), index);
      }
      setDragFrom(-1);
    }}
    onDragEnd=${() => setDragFrom(-1)}>
    <${Frame} src=${src} alt="" ratio="1 / 1" number=${single ? undefined : index + 1} kind=${kind === 'video' ? 'video' : undefined}
      badge=${kind === 'video' ? formatDuration(asset && asset.durationSec) : needsCrop ? 'Needs crop' : undefined} marked=${needsCrop}
      class=${selected ? 'is-selected' : ''} onClick=${() => onSelect(index)} aria-pressed=${selected ? 'true' : 'false'}
      aria-label=${`${kind === 'video' ? 'Video' : 'Photo'} ${index + 1} of ${count}: ${name}${needsCrop ? '. Needs cropping' : ''}`} data-media-index=${index}>
      ${!asset ? html`<span class="frame-blank"><${Icon} name="alert" size=${20} /></span>` : null}
    <//>
    <div class="cmp-item-tools">
      ${single
        ? null
        : html`<${IconButton} icon="chevron-left" size="sm" label=${`Move item ${index + 1} earlier`} disabled=${index === 0} onClick=${() => onMove(index, index - 1)} />
          <${IconButton} icon="chevron-right" size="sm" label=${`Move item ${index + 1} later`} disabled=${index === count - 1} onClick=${() => onMove(index, index + 1)} />`}
      <${IconButton} icon="x" size="sm" label=${`Remove item ${index + 1}`} onClick=${() => onRemove(index)} />
    </div>
  </div>`;
}

function MediaSection({ draft, type, assetsById, uploads, sel, setSel, note, issues, dropping, dragFrom, setDragFrom, onLibrary, onUpload, onMove, onRemove, onDismissUpload, onSwitch }) {
  const media = draft.media;
  const single = type === 'reel' || type === 'story';
  const max = single ? 1 : LIMITS.carouselMax;
  const pending = uploads.filter((u) => !u.error).length;
  const canAdd = single ? !media.length && !pending : media.length + pending < max;
  const kinds = media.map((m) => m.kind);
  let suggestion = null;
  if (type === 'feed' && media.length >= 2) suggestion = { text: 'A single post takes one item.', label: 'Make it a carousel', to: 'carousel' };
  else if (type === 'carousel' && media.length === 1) suggestion = { text: `A carousel needs at least ${LIMITS.carouselMin} items. Add more, or post it on its own.`, label: kinds[0] === 'video' ? 'Make it a reel' : 'Make it a single post', to: kinds[0] === 'video' ? 'reel' : 'feed' };
  else if (type === 'reel' && media.length === 1 && kinds[0] !== 'video') suggestion = { text: 'A reel needs a video.', label: 'Make it a single post', to: 'feed' };
  else if (type === 'reel' && media.length > 1) suggestion = { text: 'A reel takes one video.', label: 'Make it a carousel', to: 'carousel' };
  else if (type === 'story' && media.length > 1) suggestion = { text: 'A story takes one photo or video.', label: 'Keep only the first', to: 'story', keepFirst: true };
  else if (type === 'feed' && media.length === 1 && kinds[0] === 'video') suggestion = { text: 'Instagram publishes single videos as reels.', label: 'Make it a reel', to: 'reel' };
  const errs = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level === 'warning');
  const addLabel = type === 'reel' ? 'video' : single ? 'photo or video' : media.length ? 'more' : 'photos or videos';
  return html`<section class=${cx('cmp-section', 'cmp-media', dropping && 'is-drop')} id="cmp-media" aria-labelledby="cmp-media-title">
    <div class="cmp-sec-head">
      <h3 class="label-caps" id="cmp-media-title">Media</h3>
      <span class="text-sm muted num">${single ? (type === 'reel' ? 'One video' : 'One photo or video') : `${media.length} / ${max}${media.length > 1 ? ' · drag to reorder' : ''}`}</span>
    </div>
    <div class="cmp-strip" role="list">
      ${media.map((m, i) => {
        const a = assetsById.get(m.assetId);
        const needsCrop = (type === 'feed' || type === 'carousel') && outOfFeedRange(a);
        return html`<div role="listitem" key=${`${m.assetId}-${i}`}><${MediaItem} m=${m} asset=${a} index=${i} count=${media.length} selected=${i === sel && media.length > 0}
          needsCrop=${needsCrop} single=${single} onSelect=${setSel} onMove=${onMove} onRemove=${onRemove} dragFrom=${dragFrom} setDragFrom=${setDragFrom} /></div>`;
      })}
      ${uploads.map(
        (u) => html`<div role="listitem" key=${u.key} class=${cx('cmp-item', 'cmp-uploading', u.error && 'has-error')}>
          <div class="cmp-up-box">
            ${u.error
              ? html`<${Icon} name="alert" size=${18} /><span class="text-xs">Upload failed</span>`
              : html`<span class="spinner" style="width:18px;height:18px" aria-hidden="true"></span><span class="text-xs">Encrypting…</span>`}
          </div>
          <span class="cmp-up-name text-xs truncate" title=${u.error || u.name}>${u.error || u.name}</span>
          ${u.error ? html`<${Button} size="sm" variant="ghost" onClick=${() => onDismissUpload(u.key)}>Dismiss<//>` : null}
        </div>`,
      )}
      ${canAdd
        ? html`<div role="listitem" class="cmp-add">
            <${Button} icon="image" size="sm" onClick=${onLibrary}>Library<//>
            <${Button} icon="upload" size="sm" onClick=${onUpload}>Upload<//>
            <span class="text-xs muted cmp-add-hint">or drop or paste ${addLabel}</span>
          </div>`
        : null}
    </div>
    ${note ? html`<p class="cmp-note text-sm" role="status"><${Icon} name="sparkle" size=${14} /> ${note}</p>` : null}
    ${suggestion
      ? html`<div class="cmp-suggest text-sm" role="status"><span>${suggestion.text}</span>
          <${Button} size="sm" variant="secondary" onClick=${() => onSwitch(suggestion.to, suggestion.keepFirst)}>${suggestion.label}<//></div>`
      : null}
    ${errs.length || warns.length
      ? html`<ul class="cmp-inline-issues">
          ${errs.map((i) => html`<li class="text-sm text-bad"><${Icon} name="alert" size=${14} /> ${i.message}</li>`)}
          ${warns.map((i) => html`<li class="text-sm text-warn"><${Icon} name="info" size=${14} /> ${i.message}</li>`)}
        </ul>`
      : null}
    ${dropping ? html`<div class="cmp-drop" aria-hidden="true"><span><${Icon} name="upload" size=${18} /> Drop to add</span></div>` : null}
  </section>`;
}

function ItemDetail({ m, index, asset, type, recropping, onAlt, onCrop }) {
  const isImage = asset ? asset.kind === 'image' : m.kind !== 'video';
  const needsCrop = (type === 'feed' || type === 'carousel') && outOfFeedRange(asset);
  const altAllowed = isImage && (type === 'feed' || type === 'carousel');
  const r = ratioOf(asset);
  return html`<div class="cmp-detail">
    <div class="cmp-detail-head">
      <span class="text-sm"><strong>${isImage ? 'Photo' : 'Video'} ${index + 1}</strong>
        <span class="muted mono num"> ${asset ? `${asset.width || '?'}×${asset.height || '?'} · ${r ? ratioLabel(r) : '—'}${asset.kind === 'video' && asset.durationSec ? ` · ${formatDuration(asset.durationSec)}` : ''}` : 'missing from the library'}</span>
      </span>
      ${asset && isImage
        ? html`<${Button} size="sm" icon="crop" variant=${needsCrop ? 'primary' : 'secondary'} onClick=${onCrop} loading=${recropping}>Crop<//>`
        : null}
    </div>
    ${needsCrop ? html`<p class="text-sm text-bad cmp-detail-warn">This photo is ${ratioLabel(r)}. Feed photos must be between 4:5 and 1.91:1. Crop saves a new copy and keeps the original.</p>` : null}
    ${altAllowed
      ? html`<${Field} label="Alt text" hint="Describes the photo for people who use screen readers. Instagram writes one automatically when this is empty."
          action=${html`<${CharCounter} value=${m.altText || ''} max=${ALT_MAX} />`}>
          <${TextArea} rows=${1} maxRows=${5} value=${m.altText || ''} onChange=${onAlt} placeholder="e.g. Three speckled cream vases on a wooden shelf" />
        <//>`
      : null}
  </div>`;
}

function ReelOptions({ draft, update, video, assetsById, mode, onPickCover, onUploadCover, setFrameUrl, issues }) {
  const src = useAssetUrl(video, 'original');
  const coverAsset = draft.coverAssetId ? assetsById.get(draft.coverAssetId) || null : null;
  const coverSrc = useAssetUrl(coverAsset);
  const [dur, setDur] = useState((video && video.durationSec) || 0);
  const vref = useRef(null);
  const ms = draft.thumbOffsetMs == null ? 0 : Number(draft.thumbOffsetMs);
  const coverMode = draft.coverAssetId ? 'custom' : 'frame';

  useEffect(() => setDur((video && video.durationSec) || 0), [video && video.id]);
  useEffect(() => {
    const v = vref.current;
    if (v && Number.isFinite(ms) && v.readyState >= 1) v.currentTime = Math.min(ms / 1000, v.duration || ms / 1000);
  }, [ms, src]);

  // Cover frame for the preview (media.videoFrame on the decrypted video).
  useEffect(() => {
    if (!video || draft.coverAssetId || draft.thumbOffsetMs == null) {
      setFrameUrl(null);
      return undefined;
    }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const blob = await assetBlob(video);
        const { blob: jpg } = await videoFrame(blob, ms, 720);
        if (alive) setFrameUrl(URL.createObjectURL(jpg));
      } catch {
        /* the preview falls back to the video thumbnail */
      }
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [video && video.id, ms, draft.coverAssetId, draft.thumbOffsetMs == null]);

  const trialHint =
    draft.trialReel === 'MANUAL'
      ? 'Shown to people who do not follow you first. You decide later in the Instagram app whether to share it with your followers.'
      : draft.trialReel === 'SS_PERFORMANCE'
        ? 'Shown to people who do not follow you first. Instagram shares it with your followers automatically if it performs well.'
        : 'Trial reels are shown to non-followers first, so you can test an idea without your followers seeing it.';
  return html`<section class="cmp-section cmp-reel" id="cmp-reel" aria-labelledby="cmp-reel-title">
    <div class="cmp-sec-head"><h3 class="label-caps" id="cmp-reel-title">Reel</h3></div>
    <div class="cmp-reel-grid">
      <div class="cmp-cover">
        <div class="cmp-cover-media">
          ${coverMode === 'custom'
            ? coverSrc
              ? html`<img src=${coverSrc} alt="Custom cover" />`
              : html`<span class="frame-blank"><${Icon} name="image" size=${20} /></span>`
            : src
              ? html`<video ref=${vref} src=${src} muted playsinline preload="auto" aria-label="Cover frame"
                  onLoadedMetadata=${(e) => {
                    const d = e.currentTarget.duration;
                    if (Number.isFinite(d) && d > 0) setDur(d);
                    e.currentTarget.currentTime = ms / 1000;
                  }}></video>`
              : html`<span class="frame-blank"><${Icon} name="video" size=${20} /></span>`}
        </div>
      </div>
      <div class="stack-sm stack cmp-reel-controls">
        <${Segmented} size="sm" label="Cover" value=${coverMode}
          options=${[{ value: 'frame', label: 'Frame from video' }, { value: 'custom', label: 'Custom image' }]}
          onChange=${(v) => {
            if (v === 'frame') update({ coverAssetId: null });
            else onPickCover();
          }} />
        ${coverMode === 'frame'
          ? html`<label class="cmp-scrub">
              <span class="text-sm">Cover frame <span class="mono num muted">${(ms / 1000).toFixed(1)} s</span></span>
              <input type="range" min="0" max=${Math.max(0, Math.floor((dur || 0) * 1000))} step="100" value=${ms} disabled=${!video}
                onInput=${(e) => update({ thumbOffsetMs: Number(e.currentTarget.value) })} aria-label="Cover frame position" />
            </label>`
          : html`<div class="row">
              <${Button} size="sm" icon="image" onClick=${onPickCover}>Choose from library<//>
              <${Button} size="sm" icon="upload" onClick=${onUploadCover}>Upload<//>
              <${Button} size="sm" variant="ghost" onClick=${() => update({ coverAssetId: null })}>Use a frame instead<//>
            </div>`}
        ${issues.map((i) => html`<p class="text-sm text-warn">${i.message}</p>`)}
      </div>
    </div>
    <${Toggle} checked=${draft.shareToFeed !== false} onChange=${(v) => update({ shareToFeed: v })} label="Also share to feed"
      hint="Shows the reel in your profile grid and your followers' feeds, not only in the Reels tab." />
    <${Field} label="Trial reel" hint=${`${trialHint}${mode !== 'facebook' ? ' Instagram may only allow trial reels on accounts connected with Facebook Login.' : ''}`}>
      <${Segmented} size="sm" label="Trial reel" class="cmp-trial" value=${draft.trialReel || null} onChange=${(v) => update({ trialReel: v })}
        options=${[{ value: null, label: 'Off' }, { value: 'MANUAL', label: 'Share manually later' }, { value: 'SS_PERFORMANCE', label: 'Auto-share if it does well' }]} />
    <//>
  </section>`;
}

function CaptionSection({ draft, update, hashtagsDoc, issues }) {
  const caption = draft.caption || '';
  const tags = hashtagsIn(caption).length;
  const mentions = mentionsIn(caption).length;
  const sets = (hashtagsDoc && hashtagsDoc.sets) || [];
  const templates = (hashtagsDoc && hashtagsDoc.templates) || [];
  const caret = useRef(null);
  const tagTone = tags > LIMITS.hashtags ? 'is-bad' : tags > LIMITS.hashtagsRecommended ? 'is-warn' : '';
  const err = issues.find((i) => i.level === 'error');

  const addTags = (list) =>
    update((d) => {
      const have = new Set(hashtagsIn(`${d.caption || ''} ${d.firstComment || ''}`));
      const add = [];
      for (const t of list.map(normTag).filter(Boolean)) if (!have.has(t.toLowerCase()) && !add.some((x) => x.toLowerCase() === t.toLowerCase())) add.push(t);
      if (!add.length) return d;
      const base = (d.caption || '').replace(/\s+$/, '');
      const last = base.split('\n').pop();
      const sep = !base ? '' : /^\s*(#[\p{L}\p{N}_]+\s*)+$/u.test(last) ? ' ' : '\n\n';
      return { ...d, caption: base + sep + add.join(' ') };
    });

  const insertTemplate = (text) => {
    const el = document.getElementById(CAPTION_ID);
    const cur = caption;
    let pos = cur.length;
    let insert = text;
    if (cur.trim() && caret.current != null) pos = Math.min(caret.current, cur.length);
    else if (cur.trim()) insert = `\n\n${text}`;
    const next = cur.slice(0, pos) + insert + cur.slice(pos);
    update({ caption: next });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const i = next.indexOf('{', pos);
      const j = i >= 0 ? next.indexOf('}', i) : -1;
      if (i >= 0 && j > i && j < pos + insert.length) el.setSelectionRange(i, j + 1);
      else el.setSelectionRange(pos + insert.length, pos + insert.length);
    });
  };

  const moveTags = () =>
    update((d) => {
      const found = [];
      const stripped = (d.caption || '').replace(TAG_RE, (m, pre, tag) => {
        found.push(tag);
        return pre;
      });
      if (!found.length) return d;
      const cleaned = stripped
        .split('\n')
        .map((l) => l.replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      const have = new Set(hashtagsIn(d.firstComment || ''));
      const add = found.filter((t) => !have.has(t.toLowerCase()));
      const fc = (d.firstComment || '').replace(/\s+$/, '');
      return { ...d, caption: cleaned, firstComment: add.length ? `${fc}${fc ? '\n\n' : ''}${add.join(' ')}` : fc };
    });

  const remember = (e) => (caret.current = e.currentTarget.selectionStart);

  return html`<section class="cmp-section cmp-caption">
    <${Field} id=${CAPTION_ID} label="Caption" error=${err && err.message}
      action=${html`<${CharCounter} value=${caption} max=${LIMITS.captionChars} />`}>
      <${TextArea} rows=${5} maxRows=${18} value=${caption} onChange=${(v) => update({ caption: v })}
        onKeyUp=${remember} onClick=${remember} onBlur=${remember}
        placeholder="Write a caption. The first line is all people see before “more”, so make it count." />
    <//>
    <div class="cmp-caption-bar">
      <span class=${cx('cmp-count', tagTone)} title=${`Instagram counts up to ${LIMITS.hashtagsRecommended} hashtags per post (${LIMITS.hashtags} is the hard limit).`}>
        <${Icon} name="hash" size=${14} /><span class="mono num">${tags}/${LIMITS.hashtagsRecommended}</span><span class="sr-only"> hashtags</span>
      </span>
      <span class=${cx('cmp-count', mentions > LIMITS.mentions && 'is-bad')} title=${`Up to ${LIMITS.mentions} mentions per caption.`}>
        <${Icon} name="at" size=${14} /><span class="mono num">${mentions}/${LIMITS.mentions}</span><span class="sr-only"> mentions</span>
      </span>
      <span class="spacer"></span>
      <${Menu} size="sm" trigger="Hashtag sets" label="Insert a hashtag set" align="end"
        items=${sets.length
          ? sets.map((s) => ({ label: s.name, hint: `${(s.tags || []).length}`, icon: 'hash', onClick: () => addTags(s.tags || []) }))
          : [{ label: 'No hashtag sets yet', disabled: true, hint: 'Hashtags screen' }]} />
      <${Menu} size="sm" trigger="Templates" label="Insert a caption template" align="end"
        items=${templates.length
          ? templates.map((t) => ({ label: t.name, icon: 'file', onClick: () => insertTemplate(t.text || '') }))
          : [{ label: 'No caption templates yet', disabled: true }]} />
      <${Button} size="sm" variant="ghost" icon="comment" disabled=${!tags} onClick=${moveTags} title="Move every hashtag from the caption to the first comment">Move hashtags to first comment<//>
    </div>
    ${tags > LIMITS.hashtagsRecommended && tags <= LIMITS.hashtags
      ? html`<p class="text-sm text-warn cmp-tag-warn">Instagram limits posts to ${LIMITS.hashtagsRecommended} hashtags since December 2025, so extra ones may be ignored. Keep your best ${LIMITS.hashtagsRecommended}.</p>`
      : null}
  </section>`;
}

function AiPanel({ ai, settings, draft, update, assetsById, hashtagsDoc, toast }) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [variants, setVariants] = useState(null);
  const [tags, setTags] = useState(null); // {list, picked: string[]}
  const ctrl = useRef(null);
  useEffect(() => () => ctrl.current && ctrl.current.abort(), []);

  const images = async () => {
    const out = [];
    for (const m of draft.media.slice(0, 3)) {
      const a = assetsById.get(m.assetId);
      if (!a) continue;
      const b64 = await thumbBase64(a).catch(() => null);
      if (b64) out.push({ base64: b64, mediaType: 'image/jpeg' });
    }
    return out;
  };

  const run = async (kind) => {
    if (ctrl.current) ctrl.current.abort();
    const c = new AbortController();
    ctrl.current = c;
    setBusy(kind);
    setErr('');
    try {
      const imgs = await images();
      const prefs = aiPrefs(settings);
      if (kind === 'captions') {
        const sets = ((hashtagsDoc && hashtagsDoc.sets) || []).map((s) => ({ name: s.name, tags: s.tags || [] }));
        const out = await ai.captions({ images: imgs, postType: draft.type, notes, ...prefs, hashtagSets: sets, count: 3, signal: c.signal });
        if (c.signal.aborted) return;
        setVariants(out);
        if (!out.length) setErr('The AI did not return any captions. Add a few notes about the post and try again.');
      } else {
        const existing = hashtagsIn(`${draft.caption || ''} ${draft.firstComment || ''}`);
        const list = await ai.hashtags({ caption: draft.caption || notes, images: imgs, count: 10, avoid: existing, language: prefs.language, signal: c.signal });
        if (c.signal.aborted) return;
        const have = hashtagsIn(draft.caption || '').length;
        const preselect = have ? Math.max(0, LIMITS.hashtagsRecommended - have) : LIMITS.hashtagsRecommended;
        setTags({ list, picked: list.slice(0, preselect) });
        if (!list.length) setErr('The AI did not suggest any hashtags. Write a caption first, then try again.');
      }
    } catch (e) {
      if (e instanceof AiError && e.code === 'aborted') return;
      if (c.signal.aborted) return;
      setErr(e instanceof AiError ? e.userMessage : errText(e));
    } finally {
      if (ctrl.current === c) {
        ctrl.current = null;
        setBusy('');
      }
    }
  };

  const useVariant = (v) => {
    update((d) => {
      const tagsLine = (v.hashtags || []).slice(0, LIMITS.hashtagsRecommended).join(' ');
      const next = { ...d, caption: `${v.caption.trim()}${tagsLine ? `\n\n${tagsLine}` : ''}` };
      if (!(d.firstComment || '').trim() && v.firstComment) next.firstComment = v.firstComment;
      if (v.altText && (d.type === 'feed' || d.type === 'carousel')) {
        let done = false;
        next.media = d.media.map((m) => {
          if (done || m.kind === 'video' || (m.altText || '').trim()) return m;
          done = true;
          return { ...m, altText: v.altText };
        });
      }
      return next;
    });
    toast('Caption added. Edit it as much as you like.', { kind: 'success' });
  };

  const addPicked = () => {
    const list = tags.picked;
    update((d) => {
      const base = (d.caption || '').replace(/\s+$/, '');
      const have = new Set(hashtagsIn(base));
      const add = list.filter((t) => !have.has(t.toLowerCase()));
      if (!add.length) return d;
      const last = base.split('\n').pop();
      const sep = !base ? '' : /^\s*(#[\p{L}\p{N}_]+\s*)+$/u.test(last) ? ' ' : '\n\n';
      return { ...d, caption: base + sep + add.join(' ') };
    });
    setTags(null);
  };

  const togglePick = (t) => setTags((s) => ({ ...s, picked: s.picked.includes(t) ? s.picked.filter((x) => x !== t) : [...s.picked, t] }));

  return html`<section class="cmp-section cmp-ai" aria-labelledby="cmp-ai-title">
    <div class="cmp-sec-head"><h3 class="label-caps" id="cmp-ai-title"><${Icon} name="sparkle" size=${14} /> AI assist</h3></div>
    <div class="cmp-ai-row">
      <${TextInput} value=${notes} onChange=${setNotes} class="grow" aria-label="Notes for the AI"
        placeholder="Optional notes: topic, tone, offer, details" onKeyDown=${(e) => e.key === 'Enter' && (e.preventDefault(), run('captions'))} />
      <${Button} icon="sparkle" onClick=${() => run('captions')} loading=${busy === 'captions'} disabled=${!!busy && busy !== 'captions'}>Write captions<//>
      <${Button} icon="hash" variant="ghost" onClick=${() => run('hashtags')} loading=${busy === 'hashtags'} disabled=${!!busy && busy !== 'hashtags'}>Suggest hashtags<//>
    </div>
    <p class="text-xs muted">The AI sees your notes${draft.media.length ? ' and up to 3 thumbnails' : ''}. It writes in your brand voice from Settings.</p>
    ${err ? html`<${Callout} tone="danger" title="AI could not help this time">${err}<//>` : null}
    ${variants && variants.length
      ? html`<div class="cmp-variants" role="list" aria-label="Caption ideas">
          ${variants.map(
            (v, i) => html`<div class="cmp-variant" role="listitem" key=${i}>
              <p class="pre-wrap cmp-variant-text">${v.caption}</p>
              ${v.hashtags && v.hashtags.length ? html`<p class="text-sm cmp-variant-tags">${v.hashtags.join(' ')}</p>` : null}
              <div class="row row-between">
                <span class="text-xs muted mono num">${v.caption.length} chars</span>
                <${Button} size="sm" variant="secondary" icon="check" onClick=${() => useVariant(v)} aria-label=${`Use caption idea ${i + 1}`}>Use this<//>
              </div>
            </div>`,
          )}
        </div>`
      : null}
    ${tags && tags.list.length
      ? html`<div class="cmp-ai-tags">
          <p class="text-sm">Pick the hashtags to add. Instagram counts ${LIMITS.hashtagsRecommended} per post.</p>
          <div class="row">${tags.list.map((t) => html`<${Chip} key=${t} selected=${tags.picked.includes(t)} onClick=${() => togglePick(t)}>${t}<//>`)}</div>
          <div class="row">
            <${Button} size="sm" variant="primary" disabled=${!tags.picked.length} onClick=${addPicked}>Add ${tags.picked.length} hashtag${tags.picked.length === 1 ? '' : 's'}<//>
            <${Button} size="sm" variant="ghost" onClick=${() => setTags(null)}>Dismiss<//>
          </div>
        </div>`
      : null}
  </section>`;
}

function DetailsSection({ open, setOpen, draft, update, type, sel, assetsById, issues }) {
  const [tagInput, setTagInput] = useState('');
  const story = type === 'story';
  const positional = type === 'feed' || type === 'carousel' || type === 'story';
  const mediaIndex = type === 'carousel' ? sel : 0;
  const ref = draft.media[mediaIndex];
  const asset = ref ? assetsById.get(ref.assetId) : null;
  const canPlace = positional && asset && asset.kind === 'image';
  const tags = (draft.userTags || []).map((t, i) => [t, i]).filter(([t]) => !positional || type !== 'carousel' || (t.mediaIndex ?? 0) === mediaIndex);
  const thumb = useAssetUrl(canPlace ? asset : null);
  const collabErr = issues.find((i) => i.field === 'collaborators' && i.level === 'error');
  const locErr = issues.find((i) => i.field === 'location' && i.level === 'error');
  const count = (draft.collaborators || []).length + (draft.userTags || []).length + (draft.labels || []).length + (draft.location ? 1 : 0) + (draft.notes ? 1 : 0) + (draft.aiGenerated ? 1 : 0);

  const addTag = () => {
    const u = normUser(tagInput);
    if (!u) return;
    update((d) => {
      if ((d.userTags || []).some((t) => t.username === u && (t.mediaIndex ?? 0) === mediaIndex)) return d;
      const t = { username: u, mediaIndex, x: null, y: null };
      if (!positional || !canPlace) {
        t.x = 0.5;
        t.y = 0.5;
      }
      return { ...d, userTags: [...(d.userTags || []), t] };
    });
    setTagInput('');
  };
  const setLoc = (patch) =>
    update((d) => {
      const loc = { id: '', name: '', ...(d.location || {}), ...patch };
      return { ...d, location: loc.id || loc.name ? loc : null };
    });

  return html`<section class="cmp-section cmp-details" id="cmp-details">
    <button type="button" class="cmp-disclosure" aria-expanded=${open ? 'true' : 'false'} aria-controls="cmp-details-body" onClick=${() => setOpen(!open)}>
      <${Icon} name=${open ? 'chevron-down' : 'chevron-right'} size=${16} />
      <span class="label-caps">Details</span>
      <span class="text-sm muted">${story ? 'Tag people, labels, notes' : 'Collaborators, location, tag people, AI label, labels, notes'}</span>
      ${count && !open ? html`<${Badge} tone="neutral">${count}<//>` : null}
    </button>
    ${open
      ? html`<div class="cmp-details-body stack" id="cmp-details-body">
          ${!story || (draft.collaborators || []).length
            ? html`<${Field} label="Collaborators" error=${collabErr && collabErr.message}
                hint=${`Up to ${LIMITS.collaborators} accounts. They get an invite in Instagram and the post appears on their profile once they accept.`}>
                <${ChipInput} values=${draft.collaborators || []} onChange=${(v) => update({ collaborators: v })} normalize=${normUser} max=${LIMITS.collaborators} placeholder="username, then Enter" />
              <//>`
            : null}
          ${!story
            ? html`<div class="grid-2 cmp-location">
                <${Field} label="Location name" hint="Shown in the preview and in Postpilot.">
                  <${TextInput} value=${(draft.location && draft.location.name) || ''} onChange=${(v) => setLoc({ name: v })} placeholder="e.g. Studio North, Brooklyn" />
                <//>
                <${Field} label="Facebook location ID" error=${locErr && locErr.message}
                  hint="Instagram tags a place by the ID of a Facebook Page that has an address. Copy it from the Page's URL or About section.">
                  <${TextInput} mono inputmode="numeric" value=${(draft.location && draft.location.id) || ''} onChange=${(v) => setLoc({ id: v.trim() })} placeholder="e.g. 110843418940484" />
                <//>
              </div>`
            : null}
          <div class="cmp-tagpeople">
            <${Field} label="Tag people"
              hint=${type === 'reel'
                ? 'Tagged accounts are notified. Reels do not show tag positions.'
                : canPlace
                  ? `Add a username, then click the photo to place the tag${type === 'carousel' ? ` (this tags photo ${mediaIndex + 1})` : ''}.`
                  : 'Tagged accounts are notified.'}>
              <div class="row row-nowrap">
                <${TextInput} prefix="@" value=${tagInput} onChange=${setTagInput} placeholder="username" class="grow"
                  onKeyDown=${(e) => e.key === 'Enter' && (e.preventDefault(), addTag())} />
                <${Button} onClick=${addTag} disabled=${!normUser(tagInput)}>Add<//>
              </div>
            <//>
            ${tags.length || canPlace
              ? html`<div class="cmp-tag-area">
                  ${canPlace
                    ? html`<button type="button" class="cmp-tag-photo" aria-label="Photo: click to place the newest tag"
                        style=${{ aspectRatio: String(ratioOf(asset) || 1) }}
                        onClick=${(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          const pt = { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
                          update((d) => placeTag(d, mediaIndex, pt));
                        }}>
                        ${thumb ? html`<img src=${thumb} alt="" draggable="false" />` : null}
                        ${tags.filter(([t]) => t.x != null && t.y != null).map(([t], i) => html`<span key=${i} class="cmp-tag-dot" style=${{ left: `${t.x * 100}%`, top: `${t.y * 100}%` }}>@${t.username}</span>`)}
                      </button>`
                    : null}
                  <ul class="cmp-tag-list">
                    ${tags.map(
                      ([t, i]) => html`<li key=${i}>
                        <span class="mono">@${t.username}</span>
                        <span class="text-xs muted">${!positional || type === 'reel' ? '' : t.x == null ? 'Click the photo to place' : `${Math.round(t.x * 100)}%, ${Math.round(t.y * 100)}%`}</span>
                        <${IconButton} icon="x" size="sm" label=${`Remove tag @${t.username}`} onClick=${() => update((d) => ({ ...d, userTags: d.userTags.filter((_, j) => j !== i) }))} />
                      </li>`,
                    )}
                    ${!tags.length ? html`<li class="text-sm muted">No one tagged${type === 'carousel' ? ' on this photo' : ''}.</li>` : null}
                  </ul>
                </div>`
              : null}
          </div>
          ${!story
            ? html`<${Toggle} checked=${!!draft.aiGenerated} onChange=${(v) => update({ aiGenerated: v })} label="Label as AI-generated"
                hint="Adds Instagram's “AI info” label. Use it for media made or noticeably edited with AI." />`
            : null}
          <${Field} label="Labels" hint="Only visible in Postpilot. Useful for filtering the planner.">
            <${ChipInput} values=${draft.labels || []} onChange=${(v) => update({ labels: v })} normalize=${(s) => s.trim().slice(0, 32) || null} placeholder="e.g. product, launch" />
          <//>
          <${Field} label="Notes" hint="Only visible in Postpilot.">
            <${TextArea} rows=${2} maxRows=${8} value=${draft.notes || ''} onChange=${(v) => update({ notes: v })} placeholder="Reminders for yourself" />
          <//>
        </div>`
      : null}
  </section>`;
}

function IssuesList({ issues, onJump }) {
  if (!issues.length) return null;
  const errs = issues.filter((i) => i.level === 'error');
  return html`<section class="cmp-section cmp-issues" id="cmp-issues" aria-labelledby="cmp-issues-title">
    <div class="cmp-sec-head">
      <h3 class="label-caps" id="cmp-issues-title">${errs.length ? 'Fix before scheduling' : 'Worth a look'}</h3>
    </div>
    <ul class="cmp-issue-list">
      ${issues.map(
        (i, k) => html`<li key=${k} class=${cx('cmp-issue', i.level === 'error' ? 'is-error' : 'is-warning')}>
          <${Icon} name=${i.level === 'error' ? 'alert' : 'info'} size=${15} />
          <span class="grow">${i.message}</span>
          ${FIELD_TARGET[i.field] ? html`<button type="button" class="cmp-link text-sm" onClick=${() => onJump(i.field)}>Show</button>` : null}
        </li>`,
      )}
    </ul>
  </section>`;
}

function WhenControls({ draft, tz, best, onChange, onQueue, queueDisabled, busy }) {
  const past = draft.scheduledAt && new Date(draft.scheduledAt).getTime() < Date.now() - 60_000;
  return html`<div class="cmp-when" id="cmp-when">
    <span class="label-caps cmp-when-label">When</span>
    <${DateTimeField} value=${draft.scheduledAt} tz=${tz} onChange=${onChange} clearable />
    ${best.length
      ? html`<div class="cmp-best" role="group" aria-label="Best times to post">
          ${best.map(
            (iso) => html`<${Chip} key=${iso} icon="star" selected=${draft.scheduledAt === iso} onClick=${() => onChange(iso)}
              title="Based on when your followers are online and how your past posts did">${slotLabel(iso, tz)}<//>`,
          )}
        </div>`
      : null}
    <${Button} size="sm" variant="ghost" icon="repeat" onClick=${onQueue} disabled=${queueDisabled} loading=${busy === 'queue'}
      title="Schedule at the next free best time">Add to queue<//>
    ${past ? html`<p class="cmp-when-warn text-sm text-warn">This time has passed, so the post goes out on the next worker run.</p>` : null}
  </div>`;
}

function History({ post }) {
  const [open, setOpen] = useState(false);
  const items = [...(post.history || [])].reverse();
  if (!items.length) return null;
  return html`<section class="cmp-section cmp-history">
    <button type="button" class="cmp-disclosure" aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen(!open)}>
      <${Icon} name=${open ? 'chevron-down' : 'chevron-right'} size=${16} />
      <span class="label-caps">Activity</span>
      <span class="text-sm muted">${items.length} event${items.length === 1 ? '' : 's'}</span>
    </button>
    ${open
      ? html`<ol class="cmp-history-list">
          ${items.map(
            (h, i) => html`<li key=${i}>
              <span class="mono num text-xs muted" title=${h.at}>${relative(h.at)}</span>
              <span class="text-sm">${EVENT_LABEL[h.event] || h.event}${h.detail ? html`<span class="muted">: ${h.detail}</span>` : null}</span>
            </li>`,
          )}
        </ol>`
      : null}
  </section>`;
}

// ---------------------------------------------------------------------------
// Read-only view (published, publishing, canceled)

function ReadOnly({ post, docs, assetsById, account, tz, wide, onClose, onDuplicate }) {
  const [tab, setTab] = useState('details');
  const [previewMode, setPreviewMode] = useState('feed');
  const stats = post.igMediaId && docs['analytics-media'] && docs['analytics-media'].media ? docs['analytics-media'].media[post.igMediaId] : null;
  const m = (stats && stats.metrics) || {};
  const title = post.status === 'published' ? 'Published post' : post.status === 'publishing' ? 'Publishing' : 'Canceled post';
  const footer = html`<div class="cmp-actions">
    <span class="spacer"></span>
    ${post.permalink ? html`<${Button} href=${post.permalink} target="_blank" rel="noopener noreferrer" icon="external" variant="ghost" size=${wide ? 'md' : 'sm'}>View on Instagram<//>` : null}
    <${Button} icon="copy" onClick=${onDuplicate} size=${wide ? 'md' : 'sm'}>Duplicate as new post<//>
    <${Button} variant="primary" onClick=${onClose} size=${wide ? 'md' : 'sm'}>Close<//>
  </div>`;
  const metrics = [
    ['Reach', m.reach],
    ['Views', m.views],
    ['Likes', m.likes ?? (stats && stats.likeCount)],
    ['Comments', m.comments ?? (stats && stats.commentsCount)],
    ['Saves', m.saved],
    ['Shares', m.shares],
  ].filter(([, v]) => v != null);
  return html`<${Drawer} open=${true} title=${title} onClose=${onClose} footer=${footer} width=${1120} class="cmp-drawer">
    <div class=${cx('cmp', wide && 'is-wide')}>
      ${!wide
        ? html`<div class="cmp-tabs"><${Segmented} label="Show" value=${tab} onChange=${setTab}
            options=${[{ value: 'details', label: 'Details', icon: 'list' }, { value: 'preview', label: 'Preview', icon: 'eye' }]} /></div>`
        : null}
      <div class=${cx('cmp-main', !wide && tab !== 'details' && 'is-hidden')}>
        <${StatusRow} post=${post} />
        ${post.status === 'published'
          ? html`<${Callout} tone="success" title=${`Published ${post.publishedAt ? formatDateTime(post.publishedAt, tz) : ''}`}>
              This ${TYPE_NAME[post.type] || 'post'} is live on Instagram. Instagram does not allow changing a published caption or media through its API.
            <//>`
          : post.status === 'publishing'
            ? html`<${Callout} tone="marker" title="Publishing now">Instagram is processing the media. This usually takes 1–3 minutes; this panel updates by itself.<//>`
            : html`<${Callout} tone="neutral" title="Canceled">This post will not be published. Duplicate it to use it again.<//>`}
        ${post.status === 'published'
          ? metrics.length
            ? html`<div class="stats cmp-stats">${metrics.map(([label, v]) => html`<${Stat} key=${label} label=${label} value=${v} format="compact" />`)}</div>`
            : html`<p class="text-sm muted">Stats appear after the worker's next analytics update.</p>`
          : null}
        <section class="cmp-section">
          <h3 class="label-caps">Media</h3>
          <div class="cmp-strip is-readonly">
            ${(post.media || []).map((r, i) => html`<div class="cmp-item" key=${i}><${ReadOnlyThumb} asset=${assetsById.get(r.assetId)} index=${i} /></div>`)}
          </div>
        </section>
        ${post.caption ? html`<section class="cmp-section"><h3 class="label-caps">Caption</h3><p class="pre-wrap cmp-ro-text">${post.caption}</p></section>` : null}
        ${post.firstComment ? html`<section class="cmp-section"><h3 class="label-caps">First comment</h3><p class="pre-wrap cmp-ro-text">${post.firstComment}</p></section>` : null}
        ${(post.collaborators || []).length || post.location || (post.labels || []).length
          ? html`<section class="cmp-section"><dl class="kv">
              ${(post.collaborators || []).length ? html`<dt>Collaborators</dt><dd>${post.collaborators.map((c) => `@${c}`).join(', ')}</dd>` : null}
              ${post.location ? html`<dt>Location</dt><dd>${post.location.name || post.location.id}</dd>` : null}
              ${(post.labels || []).length ? html`<dt>Labels</dt><dd>${post.labels.join(', ')}</dd>` : null}
            </dl></section>`
          : null}
        <${History} post=${post} />
      </div>
      <aside class=${cx('cmp-side', !wide && tab !== 'preview' && 'is-hidden')} aria-label="Preview">
        <div class="cmp-side-head">
          <span class="label-caps">Preview</span>
          <${Segmented} size="sm" label="Preview mode" value=${previewMode} onChange=${setPreviewMode}
            options=${[{ value: 'feed', label: post.type === 'reel' ? 'Reel' : post.type === 'story' ? 'Story' : 'Post' }, { value: 'grid', label: 'Grid' }]} />
        </div>
        <${PostPreview} post=${post} assetsById=${assetsById} account=${account} tz=${tz} mode=${previewMode} />
      </aside>
    </div>
  <//>`;
}

function ReadOnlyThumb({ asset, index }) {
  const src = useAssetUrl(asset);
  return html`<${Frame} src=${src} alt=${(asset && asset.name) || ''} ratio="1 / 1" number=${index + 1} kind=${asset && asset.kind === 'video' ? 'video' : undefined} />`;
}
