// Data model: document names, defaults, ids, limits and validation.
// Every document lives at db/<name>.enc (encrypted) except `bio`, which is public.

export const SCHEMA_VERSION = 1;

export const POST_TYPES = ['feed', 'carousel', 'reel', 'story'];
export const POST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'failed', 'canceled'];

export const LIMITS = {
  captionChars: 2200,
  hashtags: 30, // hard API limit
  hashtagsRecommended: 5, // Instagram has limited posts to 5 hashtags since Dec 2025; more may be ignored
  mentions: 20,
  carouselMin: 2,
  carouselMax: 10,
  collaborators: 3,
  firstCommentChars: 2200,
  publishPer24h: 100,
  imageMaxBytes: 8 * 1024 * 1024,
  videoMaxBytes: 95 * 1024 * 1024, // GitHub hard limit is 100 MB per file
  feedAspectMin: 4 / 5,
  feedAspectMax: 1.91,
  reelMinSeconds: 3,
  reelMaxSeconds: 15 * 60,
  storyVideoMaxSeconds: 60,
};

const DEFAULTS = {
  settings: () => ({
    v: SCHEMA_VERSION,
    timezone: 'UTC',
    ig: null, // see IgConnection below
    ai: { provider: 'anthropic', apiKey: '', model: 'claude-opus-5-5', voice: '', language: 'English', emoji: 'some', enabled: false },
    publishing: { defaultFirstComment: '', autoFirstCommentHashtags: false, retryFailed: true },
    worker: { enabled: true },
    notifications: {
      vapid: null, // { publicKey, privateKeyJwk, subject } generated in the browser, used by the worker to sign pushes
      subscriptions: [], // [{ endpoint, keys: {p256dh, auth}, device, createdAt }]
      events: { published: true, failed: true, approval: true, dm: true, comment: false, account: true },
    },
    ui: {},
    createdAt: new Date().toISOString(),
  }),
  posts: () => ({ v: SCHEMA_VERSION, posts: [] }),
  library: () => ({ v: SCHEMA_VERSION, assets: [], folders: [] }),
  lists: () => ({ v: SCHEMA_VERSION, lists: [] }),
  automations: () => ({
    v: SCHEMA_VERSION,
    enabled: true,
    rules: [],
    welcome: { enabled: false, text: 'Thanks for reaching out! I will get back to you soon.' },
    blockedWords: { enabled: false, words: [], action: 'hide' },
    limits: { maxActionsPerRun: 25, maxDmsPerHour: 40 },
    processed: { comments: {}, messages: {}, conversations: {} },
    cursors: {},
    stats: { replies: 0, dms: 0, hidden: 0 },
  }),
  autopilot: () => ({
    v: SCHEMA_VERSION,
    enabled: false,
    mode: 'review', // 'review' => creates drafts needing approval, 'auto' => schedules directly
    postsPerWeek: 4,
    horizonDays: 7,
    slotStrategy: 'best', // 'best' | 'fixed'
    fixedSlots: [{ weekday: 2, time: '12:00' }, { weekday: 4, time: '18:00' }],
    minGapHours: 20,
    allowedTypes: ['feed', 'carousel', 'reel'],
    captionStyle: '',
    hashtagSetIds: [],
    useAi: true,
    recycleTopPosts: false,
    recycleAfterDays: 120,
    lastRunAt: null,
  }),
  hashtags: () => ({ v: SCHEMA_VERSION, sets: [], templates: [], savedReplies: [], tracked: [] }),
  competitors: () => ({ v: SCHEMA_VERSION, accounts: [], snapshots: {}, posts: {} }),
  'analytics-daily': () => ({ v: SCHEMA_VERSION, days: {} }),
  'analytics-media': () => ({ v: SCHEMA_VERSION, media: {} }),
  'analytics-stories': () => ({ v: SCHEMA_VERSION, stories: {} }),
  audience: () => ({ v: SCHEMA_VERSION, demographics: null, onlineFollowers: null, fetchedAt: null }),
  inbox: () => ({ v: SCHEMA_VERSION, outbox: [], comments: [], conversations: [], fetchedAt: null }),
  log: () => ({ v: SCHEMA_VERSION, entries: [], runs: [] }),
  bio: () => ({
    v: SCHEMA_VERSION,
    published: false,
    title: '',
    bio: '',
    avatarUrl: '',
    theme: 'paper',
    accent: '#1f5f8b',
    links: [],
    grid: [],
    updatedAt: null,
  }),
};

export const DOC_NAMES = Object.keys(DEFAULTS);

export function docPath(name) {
  if (!DEFAULTS[name]) throw new Error(`Unknown document "${name}"`);
  return name === 'bio' ? 'public/bio.json' : `db/${name}.enc`;
}

export function defaultDoc(name) {
  if (!DEFAULTS[name]) throw new Error(`Unknown document "${name}"`);
  return DEFAULTS[name]();
}

/** Fill in fields added after a document was first written. */
export function migrateDoc(name, value) {
  const base = defaultDoc(name);
  if (!value || typeof value !== 'object') return base;
  for (const k of Object.keys(base)) if (value[k] === undefined) value[k] = base[k];
  return value;
}

/** Time-sortable unique id: 8 chars of time + 8 random. */
export function uid(prefix = '') {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('');
  return `${prefix}${t}${r}`;
}

/*
 * Shapes (documentation only)
 *
 * IgConnection (settings.ig):
 *   { mode: 'instagram' | 'facebook',
 *     token, tokenType: 'ig_long' | 'fb_user' | 'fb_page',
 *     tokenExpiresAt: ISO|null, tokenRefreshedAt: ISO|null,
 *     userId, username, name, profilePictureUrl, accountType,
 *     pageId?, pageName?, pageToken?,           // facebook mode
 *     appId?, appSecret?,                        // optional, used to exchange short-lived tokens
 *     apiVersion, connectedAt }
 *
 * Post (posts.posts[]):
 *   { id, type: 'feed'|'carousel'|'reel'|'story', status, caption, firstComment,
 *     media: [MediaRef], location: {id, name}|null, collaborators: [username],
 *     userTags: [{username, x, y, mediaIndex}], shareToFeed: true, coverAssetId, thumbOffsetMs,
 *     trialReel: null|'MANUAL'|'SS_PERFORMANCE', aiGenerated: bool,
 *     altText, scheduledAt: ISO|null, source: 'manual'|'autopilot'|'evergreen'|'csv'|'recycle',
 *     listId?, needsApproval: bool, labels: [string], notes,
 *     createdAt, updatedAt, publishedAt, igMediaId, permalink,
 *     attempts: number, lastError: {message, code, at, permanent}|null,
 *     history: [{at, event, detail}] }
 *
 * MediaRef: { assetId, kind: 'image'|'video', altText }
 *
 * Asset (library.assets[]):
 *   { id, kind: 'image'|'video', name, mime, bytes, width, height, durationSec,
 *     path: 'media/<id>', thumbPath: 'media/<id>.thumb', folderId, tags: [string],
 *     notes, captionHint, usedBy: [postId], autopilot: bool, createdAt }
 *
 * List (lists.lists[]) - evergreen / recurring queue:
 *   { id, name, color, enabled, order: 'sequential'|'shuffle', repeat: true (false = remove items once used), slots: [{weekday, time}],
 *     items: [{id, type, caption, firstComment, media: [MediaRef], timesUsed, lastUsedAt}],
 *     nextIndex, horizonDays, createdAt }
 *
 * Rule (automations.rules[]):
 *   { id, name, enabled, trigger: {source: 'comment'|'dm'|'story_reply'|'mention',
 *       match: 'any'|'all'|'exact'|'always', keywords: [string], mediaIds: [id]|null },
 *     actions: [{type: 'reply_comment'|'private_reply'|'send_dm'|'hide_comment'|'ai_reply', texts: [string], guidance?}],
 *     oncePerUser: bool, createdAt, stats: {fired, lastFiredAt} }
 *
 * Outbox command (inbox.outbox[]): { id, type, payload, status: 'pending'|'sending'|'done'|'failed', error, createdAt, doneAt,
 *   attempts, maybeSent } ('sending' = claimed by a worker run; a command left 'sending' becomes 'failed' with maybeSent=true
 *   and is never re-sent automatically, because Instagram may already have received it)
 *   types: 'publish_now' {postId} | 'reply_comment' {commentId, text} | 'hide_comment' {commentId, hide} |
 *          'delete_comment' {commentId} | 'send_dm' {recipientId, text} | 'private_reply' {commentId, text}
 *
 * DailySnapshot (analytics-daily.days[YYYY-MM-DD]):
 *   { followers, follows, mediaCount, reach, views, accountsEngaged, totalInteractions,
 *     likes, comments, shares, saves, replies, profileLinksTaps, websiteClicks, profileViews,
 *     followsGained, unfollows, capturedAt }
 *
 * MediaStats (analytics-media.media[id]):
 *   { id, caption, mediaType, productType, permalink, timestamp, thumbnailUrl, likeCount, commentsCount,
 *     metrics: {reach, views, likes, comments, shares, saved, totalInteractions, profileVisits, follows,
 *               avgWatchTimeMs, totalWatchTimeMs}, fetchedAt }
 *
 * StoryStats (analytics-stories.stories[id]):
 *   { id, mediaType, timestamp, permalink, thumbPath?, metrics: {reach, views, replies, shares,
 *     totalInteractions, follows, profileVisits, navigation: {tapForward, tapBack, tapExit, swipeForward}}, capturedAt }
 */

export function newPost(partial = {}) {
  const now = new Date().toISOString();
  return {
    id: uid('p_'),
    type: 'feed',
    status: 'draft',
    caption: '',
    firstComment: '',
    media: [],
    location: null,
    collaborators: [],
    userTags: [],
    shareToFeed: true,
    coverAssetId: null,
    thumbOffsetMs: null,
    trialReel: null, // null | 'MANUAL' | 'SS_PERFORMANCE' (reels only: shown to non-followers first)
    aiGenerated: false, // sends is_ai_generated=true so Instagram shows the "AI info" label
    altText: '',
    scheduledAt: null,
    source: 'manual',
    needsApproval: false,
    labels: [],
    notes: '',
    createdAt: now,
    updatedAt: now,
    publishedAt: null,
    igMediaId: null,
    permalink: null,
    attempts: 0,
    lastError: null,
    history: [{ at: now, event: 'created' }],
    ...partial,
  };
}

export function newAsset(partial = {}) {
  const id = partial.id || uid('a_');
  return {
    id,
    kind: 'image',
    name: '',
    mime: 'image/jpeg',
    bytes: 0,
    width: 0,
    height: 0,
    durationSec: null,
    path: `media/${id}`,
    thumbPath: `media/${id}.thumb`,
    folderId: null,
    tags: [],
    notes: '',
    captionHint: '',
    usedBy: [],
    autopilot: false,
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

export function newRule(partial = {}) {
  return {
    id: uid('r_'),
    name: 'New rule',
    enabled: true,
    trigger: { source: 'comment', match: 'any', keywords: [], mediaIds: null },
    actions: [{ type: 'reply_comment', texts: [''] }],
    oncePerUser: true,
    createdAt: new Date().toISOString(),
    stats: { fired: 0, lastFiredAt: null },
    ...partial,
  };
}

export function newList(partial = {}) {
  return {
    id: uid('l_'),
    name: 'Evergreen',
    color: '#1f5f8b',
    enabled: true,
    order: 'sequential',
    repeat: true,
    slots: [{ weekday: 3, time: '12:00' }],
    items: [],
    nextIndex: 0,
    horizonDays: 14,
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

export function hashtagsIn(text = '') {
  return (text.match(/(^|[^\w&])#([\p{L}\p{N}_]+)/gu) || []).map((m) => m.replace(/^[^#]*#/, '#').toLowerCase());
}

export function mentionsIn(text = '') {
  return (text.match(/(^|[^\w])@([A-Za-z0-9._]{1,30})/g) || []).map((m) => m.replace(/^[^@]*@/, '@').toLowerCase());
}

/**
 * Validate a post before scheduling. Returns [{level: 'error'|'warning', field, message}].
 * `assets` is a Map or object of assetId -> Asset.
 */
export function validatePost(post, assets = {}) {
  const issues = [];
  const get = (id) => (assets instanceof Map ? assets.get(id) : assets[id]);
  const err = (field, message) => issues.push({ level: 'error', field, message });
  const warn = (field, message) => issues.push({ level: 'warning', field, message });
  const media = post.media || [];
  const kinds = media.map((m) => (get(m.assetId) || {}).kind || m.kind);

  if (!POST_TYPES.includes(post.type)) err('type', 'Choose a post type.');
  if (!media.length) err('media', 'Add a photo or video.');
  for (const m of media) if (!get(m.assetId)) err('media', 'A media file is missing from the library.');

  if (post.type === 'feed' && media.length > 1) err('media', 'A single post takes one photo or video. Use Carousel for more.');
  if (post.type === 'carousel') {
    if (media.length < LIMITS.carouselMin) err('media', `A carousel needs at least ${LIMITS.carouselMin} items.`);
    if (media.length > LIMITS.carouselMax) err('media', `A carousel can hold at most ${LIMITS.carouselMax} items.`);
  }
  if (post.type === 'reel') {
    if (media.length !== 1 || kinds[0] !== 'video') err('media', 'A reel needs exactly one video.');
    const a = get(media[0]?.assetId);
    if (a && a.durationSec != null) {
      if (a.durationSec < LIMITS.reelMinSeconds) err('media', `Reels must be at least ${LIMITS.reelMinSeconds} seconds.`);
      if (a.durationSec > LIMITS.reelMaxSeconds) err('media', 'Reels can be at most 15 minutes.');
    }
  }
  if (post.type === 'story') {
    if (media.length !== 1) err('media', 'A story takes exactly one photo or video.');
    const a = get(media[0]?.assetId);
    if (a && a.kind === 'video' && a.durationSec > LIMITS.storyVideoMaxSeconds) warn('media', 'Story videos longer than 60 seconds may be rejected.');
    if (post.caption) warn('caption', 'Instagram does not show captions on stories.');
  }
  if (post.type === 'feed' || post.type === 'carousel') {
    for (const m of media) {
      const a = get(m.assetId);
      if (a && a.kind === 'image' && a.width && a.height) {
        const r = a.width / a.height;
        if (r < LIMITS.feedAspectMin - 0.01 || r > LIMITS.feedAspectMax + 0.01) {
          err('media', `"${a.name || 'Image'}" is ${a.width}x${a.height}. Feed photos must be between 4:5 and 1.91:1. Crop it in the editor.`);
        }
      }
    }
  }

  const caption = post.caption || '';
  if (caption.length > LIMITS.captionChars) err('caption', `Captions are limited to ${LIMITS.captionChars} characters.`);
  const tags = hashtagsIn(caption + ' ' + (post.firstComment || ''));
  const captionTags = hashtagsIn(caption).length;
  if (captionTags > LIMITS.hashtags) err('caption', `Instagram allows at most ${LIMITS.hashtags} hashtags.`);
  else if (captionTags > LIMITS.hashtagsRecommended) warn('caption', `Instagram limits posts to ${LIMITS.hashtagsRecommended} hashtags since December 2025, so extra ones may be ignored. Keep your best ${LIMITS.hashtagsRecommended}.`);
  if (tags.length > LIMITS.hashtags) warn('firstComment', 'More than 30 hashtags across caption and first comment.');
  if (mentionsIn(caption).length > LIMITS.mentions) err('caption', `At most ${LIMITS.mentions} @mentions per caption.`);
  if ((post.collaborators || []).length > LIMITS.collaborators) err('collaborators', `At most ${LIMITS.collaborators} collaborators.`);
  if (post.trialReel && post.type !== 'reel') err('trialReel', 'Trial reels are only available for reels.');
  if (post.type === 'story' && (post.collaborators || []).length) err('collaborators', 'Stories cannot have collaborators.');
  if (post.firstComment && post.firstComment.length > LIMITS.firstCommentChars) err('firstComment', 'First comment is too long.');

  if (post.status === 'scheduled') {
    if (!post.scheduledAt) err('scheduledAt', 'Pick a date and time.');
    else if (new Date(post.scheduledAt).getTime() < Date.now() - 60_000) warn('scheduledAt', 'This time is in the past; it will publish on the next worker run.');
  }
  return issues;
}

export function hasErrors(issues) {
  return issues.some((i) => i.level === 'error');
}

/** Append an entry to a post's history (kept to the last 30). */
export function addHistory(post, event, detail) {
  post.history = [...(post.history || []), { at: new Date().toISOString(), event, ...(detail ? { detail } : {}) }].slice(-30);
  post.updatedAt = new Date().toISOString();
  return post;
}
