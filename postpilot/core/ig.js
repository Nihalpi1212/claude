// Instagram Graph API client shared by the browser app and the Node worker.
//
// Works with both login types:
//   mode 'instagram' -> graph.instagram.com, Instagram User token (Instagram Login)
//   mode 'facebook'  -> graph.facebook.com, Page token (Facebook Login, messaging via the Page)
//
// Browser-friendly by design: GET/DELETE send access_token as a query parameter and POST
// bodies are application/x-www-form-urlencoded (object/array values JSON-encoded), so no
// request needs a CORS preflight. Never use Authorization headers or JSON bodies here,
// except for the Node-only resumable video upload.

import { addDaysKey, dayKey, dayRange, startOfDay, timeKey, zonedParts, zonedToUtc } from './time.js';

export const GRAPH_VERSION = 'v26.0';

/** Meta reports daily insights buckets and online_followers hours in Pacific time. */
export const INSIGHTS_TZ = 'America/Los_Angeles';

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002, 368]);
const AUTH_SUBCODES = new Set([458, 459, 460, 463, 464, 467]);
const TRANSIENT_SUBCODES = new Set([2207027, 2207003, 2207052]);
const RUPLOAD_PREFIX = 'https://rupload.facebook.com/ig-api-upload';

// Plain-language explanations for publishing subcodes (see research brief section 10).
const SUBCODE_MESSAGES = {
  2207001: 'Instagram could not create the post (server error or the content was flagged). Try again later or change the media.',
  2207003: 'Instagram timed out downloading the media. Postpilot will try again.',
  2207004: 'The image is too large for Instagram. Use a JPEG under 8 MB.',
  2207005: 'Instagram does not support this image format. Use a JPEG.',
  2207006: 'Instagram could not find the uploaded media. Postpilot will upload it again.',
  2207008: 'The upload expired before it was published. Postpilot will upload it again.',
  2207009: 'The image aspect ratio is not allowed. Crop it to between 4:5 and 1.91:1.',
  2207010: 'The caption is too long. Keep it under 2,200 characters.',
  2207018: 'One of the collaborator usernames is not valid. Check the collaborators and remove any @.',
  2207020: 'The media expired on Instagram. Postpilot will upload it again.',
  2207023: 'Instagram does not recognise this media type.',
  2207026: 'Instagram does not support this video format. Export it as MP4 (H.264 video, AAC audio) and try again.',
  2207027: 'Instagram is still processing the media. Postpilot will try again.',
  2207028: 'A carousel needs between 2 and 10 items.',
  2207032: 'Instagram could not create the post. Try again later.',
  2207042: 'Instagram daily publishing limit reached. Postpilot will try again on the next run.',
  2207050: 'Your Instagram account is restricted or needs attention. Open the Instagram app to fix it, then try again.',
  2207051: 'Instagram blocked this action. Wait a while before trying again, and avoid repeating the same content.',
  2207052: 'Instagram could not download the media file. Postpilot will try again; if it keeps failing, re-upload the file as JPEG or MP4.',
  2207053: 'Instagram could not process the video. Keep it under 300 MB, at most 1920 px wide and under 25 Mbps.',
  2207057: 'The reel cover position is outside the video. Pick a cover frame inside the video.',
  2207078: 'You reached the limit for trial reels. Try again later.',
  2207081: 'This account cannot post trial reels yet.',
  2207082: 'Instagram could not process the video. Re-export it as MP4 (H.264, AAC) and try again.',
  2207085: 'Instagram could not process the video. Re-export it as MP4 (H.264, AAC) and try again.',
};

/** Error from the Graph API (or the network) with classification helpers. */
export class IgError extends Error {
  constructor(message, { code, subcode, type, status, fbtraceId, userMessage, userTitle, userDetail, permanent, cause } = {}) {
    super(message);
    this.name = 'IgError';
    this.code = code ?? null;
    this.subcode = subcode ?? null;
    this.type = type ?? null;
    this.status = status ?? null;
    this.fbtraceId = fbtraceId ?? null;
    this.userTitle = userTitle ?? null;
    this.userDetail = userDetail ?? null;
    this.permanentOverride = typeof permanent === 'boolean' ? permanent : null;
    if (cause) this.cause = cause;
    this.userMessage = userMessage || explain(this);
  }

  get isAuth() {
    return this.code === 190 || this.code === 102 || this.code === 463 || this.code === 467 || AUTH_SUBCODES.has(this.subcode);
  }

  get isRateLimit() {
    return RATE_LIMIT_CODES.has(this.code) || this.subcode === 2207042 || this.code === 'publish_limit';
  }

  get isTransient() {
    if (this.code === 'network') return true;
    if (this.code === 1 || this.code === 2) return true;
    if (this.code === -1 && !this.subcode) return true;
    if (this.status >= 500 && !this.subcode && !this.isAuth) return true;
    return TRANSIENT_SUBCODES.has(this.subcode);
  }

  get isPermanent() {
    if (this.permanentOverride !== null) return this.permanentOverride;
    return !(this.isTransient || this.isRateLimit);
  }

  get isPermission() {
    return this.code === 10 || (typeof this.code === 'number' && this.code >= 200 && this.code <= 299);
  }

  get needsAdvancedAccess() {
    return this.code === 200 && /advanced access|does not have role|has no role/i.test(this.message);
  }

  get isOutsideWindow() {
    return this.subcode === 2534022 || /outside (of )?(the )?allowed window/i.test(this.message);
  }

  get isDmDisabled() {
    return /disabled access to instagram direct/i.test(`${this.message} ${this.userDetail || ''}`);
  }

  get isNotFound() {
    return (this.code === 100 && this.subcode === 33) || this.status === 404;
  }
}

/** Thrown by publishPost when a container is still processing; resume from `containers` later. */
export class PublishPendingError extends Error {
  constructor(message, containers) {
    super(message || 'Instagram is still processing the media.');
    this.name = 'PublishPendingError';
    this.containers = containers || null;
    this.userMessage = 'Instagram is still processing the media. Postpilot will finish publishing on the next run.';
  }
}

/** Plain-language description of any error (IgError.userMessage when available). */
export function describeIgError(err) {
  if (!err) return 'Something went wrong.';
  return err.userMessage || err.message || String(err);
}

function explain(e) {
  const msg = e.message || '';
  if (e.code === 'network') return 'Could not reach Instagram. Check the internet connection; Postpilot will try again.';
  if (e.code === 'unsupported') return 'This feature is not available with your Instagram connection.';
  if (e.isAuth) return 'Your Instagram connection expired or was revoked. Reconnect Instagram in Settings.';
  if (e.isDmDisabled) {
    return 'Message access is turned off for this Instagram account. In the Instagram app open Settings > Messages and story replies > Message controls > Connected tools and turn on "Allow access to messages".';
  }
  if (e.isOutsideWindow) return 'Instagram only allows messages within 24 hours of the person\'s last message. Reply from the Instagram app instead.';
  if (e.needsAdvancedAccess) {
    return 'Instagram only lets this app message people who have a role on the app until it gets Advanced Access. Reply from the Instagram app, or apply for Advanced Access in the Meta App Dashboard.';
  }
  if (e.subcode && SUBCODE_MESSAGES[e.subcode]) return SUBCODE_MESSAGES[e.subcode];
  if (e.code === 368) return 'Instagram temporarily blocked this action. Wait a few hours before trying again.';
  if (e.isRateLimit) return 'Instagram is limiting requests right now. Postpilot will try again later.';
  if (e.code === 10 && /not enough viewers/i.test(msg)) return 'Not enough people have seen this yet to show insights.';
  if (e.isPermission) return 'Postpilot is missing an Instagram permission for this. Reconnect Instagram in Settings and allow every requested permission.';
  if (e.isNotFound) return 'Instagram could not find that item. It may have been deleted.';
  if (e.status >= 500 || e.code === 1 || e.code === 2 || e.code === -1) return 'Instagram is having problems right now. Postpilot will try again.';
  const detail = e.userDetail || msg.replace(/^\(#\d+\)\s*/, '');
  return detail ? `Instagram rejected the request: ${detail}` : 'Instagram rejected the request.';
}

function errorFromBody(status, data) {
  const e = data && typeof data === 'object' ? data.error : null;
  if (e && typeof e === 'object') {
    return new IgError(e.message || `Instagram request failed (HTTP ${status})`, {
      code: e.code,
      subcode: e.error_subcode,
      type: e.type,
      status,
      fbtraceId: e.fbtrace_id,
      userTitle: e.error_user_title,
      userDetail: e.error_user_msg,
    });
  }
  // rupload.facebook.com reports failures as { debug_info: { type, message, retriable } }
  const d = data && typeof data === 'object' ? data.debug_info : null;
  if (d) {
    let inner = null;
    try {
      inner = typeof d.message === 'string' && d.message.startsWith('{') ? JSON.parse(d.message).error : null;
    } catch {
      inner = null;
    }
    if (inner) return errorFromBody(status, { error: inner });
    return new IgError(d.message || d.type || `Upload failed (HTTP ${status})`, { code: d.retriable ? 2 : 'upload_failed', type: d.type, status });
  }
  const text = typeof data === 'string' ? data.slice(0, 200) : '';
  return new IgError(text || `Instagram request failed (HTTP ${status})`, { status });
}

/** Retry these immediately (inside one call), as opposed to "retry on a later run". */
function retryableNow(err) {
  if (err.code === 1 || err.code === 2) return true;
  if (err.code === -1 && !err.subcode) return true;
  return err.status >= 500 && !err.subcode && !err.isAuth;
}

const CREATE_PATH = /\/(media|media_publish|messages|replies|comments|mentions)$/;

function encodeParams(params) {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    out.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return out;
}

function isoTime(t) {
  if (!t) return null;
  const d = new Date(String(t).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function unix(date) {
  return Math.floor(date.getTime() / 1000);
}

function productFromType(mediaType) {
  if (mediaType === 'VIDEO') return 'REELS';
  if (mediaType === 'IMAGE' || mediaType === 'CAROUSEL_ALBUM') return 'FEED';
  return null;
}

function normMedia(m) {
  if (!m) return null;
  const mediaType = m.media_type || null;
  const permalink = m.permalink || null;
  const sc = m.shortcode || (permalink && (permalink.match(/\/(?:p|reel|tv)\/([^/?#]+)/) || [])[1]) || null;
  return {
    id: m.id,
    caption: m.caption || '',
    mediaType,
    productType: m.media_product_type || productFromType(mediaType),
    mediaUrl: m.media_url || null,
    thumbnailUrl: m.thumbnail_url || null,
    permalink,
    shortcode: sc,
    timestamp: isoTime(m.timestamp),
    likeCount: m.like_count ?? null,
    commentsCount: m.comments_count ?? null,
    commentsEnabled: m.is_comment_enabled ?? null,
    children: ((m.children && m.children.data) || []).map((c) => ({
      id: c.id,
      mediaType: c.media_type || null,
      mediaUrl: c.media_url || null,
      thumbnailUrl: c.thumbnail_url || null,
    })),
  };
}

function normComment(c) {
  return {
    id: c.id,
    text: c.text || '',
    timestamp: isoTime(c.timestamp),
    username: c.username || (c.from && c.from.username) || null,
    fromId: (c.from && c.from.id) || null,
    likeCount: c.like_count ?? 0,
    hidden: !!c.hidden,
    parentId: c.parent_id || null,
    mediaId: (c.media && c.media.id) || null,
    replies: ((c.replies && c.replies.data) || []).map(normComment),
  };
}

function normMessage(m) {
  return {
    id: m.id,
    createdTime: isoTime(m.created_time),
    fromId: (m.from && m.from.id) || null,
    fromUsername: (m.from && m.from.username) || null,
    toIds: ((m.to && m.to.data) || []).map((t) => t.id),
    text: m.message || '',
    attachments: (m.attachments && m.attachments.data) || [],
    replyTo: m.reply_to || null,
    isUnsupported: !!m.is_unsupported,
  };
}

function metricValue(item) {
  if (item.total_value && item.total_value.value !== undefined) return item.total_value.value;
  const v = item.values && item.values[0];
  return v ? v.value : undefined;
}

function breakdownResults(item) {
  const b = item.total_value && item.total_value.breakdowns && item.total_value.breakdowns[0];
  return (b && b.results) || [];
}

const MEDIA_METRIC_KEYS = {
  reach: 'reach',
  views: 'views',
  likes: 'likes',
  comments: 'comments',
  shares: 'shares',
  saved: 'saved',
  total_interactions: 'totalInteractions',
  profile_visits: 'profileVisits',
  follows: 'follows',
  ig_reels_avg_watch_time: 'avgWatchTimeMs',
  ig_reels_video_view_total_time: 'totalWatchTimeMs',
  reposts: 'reposts',
  reels_skip_rate: 'skipRate',
  replies: 'replies',
};

// Known-working sets first (research brief 2, section 4), then newer extras that are dropped
// automatically when the API rejects them.
const MEDIA_METRICS = {
  REELS: ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time', 'total_interactions', 'reposts', 'reels_skip_rate'],
  IMAGE: ['reach', 'saved', 'likes', 'comments', 'shares', 'follows', 'profile_visits', 'views', 'total_interactions', 'reposts'],
  CAROUSEL_ALBUM: ['reach', 'saved', 'shares', 'follows', 'profile_visits', 'views', 'likes', 'comments', 'total_interactions', 'reposts'],
  FEED_VIDEO: ['reach', 'saved', 'views', 'likes', 'comments', 'shares', 'total_interactions'],
  STORY: ['reach', 'views', 'replies', 'shares', 'total_interactions', 'follows', 'profile_visits'],
};

const DAILY_TOTAL_KEYS = {
  views: 'views',
  reach: 'reach',
  accounts_engaged: 'accountsEngaged',
  total_interactions: 'totalInteractions',
  likes: 'likes',
  comments: 'comments',
  shares: 'shares',
  saves: 'saves',
  replies: 'replies',
  profile_links_taps: 'profileLinksTaps',
};

const NAV_KEYS = { TAP_FORWARD: 'tapForward', TAP_BACK: 'tapBack', TAP_EXIT: 'tapExit', SWIPE_FORWARD: 'swipeForward' };

function mediaKind(media) {
  const mt = media.mediaType || media.media_type;
  const pt = media.productType || media.media_product_type;
  if (pt === 'STORY') return 'STORY';
  if (pt === 'REELS') return 'REELS';
  if (mt === 'CAROUSEL_ALBUM') return 'CAROUSEL_ALBUM';
  if (mt === 'VIDEO') return pt === 'FEED' ? 'FEED_VIDEO' : 'REELS';
  return 'IMAGE';
}

/** Which of `list` an insights code-100 error complains about ([] when unclear). */
function offendingMetrics(message, list) {
  const msg = String(message || '');
  const idx = msg.match(/metric\[(\d+)\]/);
  const allowed = msg.match(/must be one of the following values:\s*([\w\s,]+)/i);
  if (allowed) {
    const ok = new Set(allowed[1].split(',').map((s) => s.trim()).filter(Boolean));
    const bad = list.filter((m) => !ok.has(m));
    if (bad.length && bad.length < list.length) return bad;
  }
  if (idx && list[Number(idx[1])]) return [list[Number(idx[1])]];
  const named = msg.match(/support (?:the )?(\w+) metric/i);
  if (named && list.includes(named[1])) return [named[1]];
  const mentioned = list.filter((m) => new RegExp(`(^|[^\\w])${m}([^\\w]|$)`).test(msg));
  if (mentioned.length && mentioned.length < list.length) return mentioned;
  return [];
}

function isTimeParamError(err) {
  return /\b(since|until)\b|more than 30 days|time range/i.test(err.message || '');
}

function isMetricError(err) {
  return err instanceof IgError && err.code === 100 && err.subcode !== 33 && !isTimeParamError(err);
}

function isNotEnoughViewers(err) {
  return err instanceof IgError && err.code === 10 && /not enough viewers/i.test(err.message || '');
}

/** Day key for an insights `end_time` (end of the bucket). */
function insightsDayKey(endTime, tz) {
  const end = new Date(isoTime(endTime));
  if (Number.isNaN(end.getTime())) return null;
  const before = new Date(end.getTime() - 1000);
  if (timeKey(end, tz) === '00:00') return dayKey(before, tz);
  return dayKey(before, INSIGHTS_TZ);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Create a Graph API client.
 * @param {object} opts
 * @param {'instagram'|'facebook'} [opts.mode]
 * @param {string} opts.token Access token (Instagram User token, or Page token in facebook mode)
 * @param {string} [opts.userId] Instagram professional account id (user_id / instagram_business_account.id)
 * @param {string} [opts.pageId] Facebook Page id (facebook mode, messaging)
 * @param {string} [opts.pageToken] Page token (facebook mode, messaging). Defaults to `token`.
 */
export function createIg({
  mode = 'instagram',
  token,
  userId,
  pageId,
  pageToken,
  igBase = 'https://graph.instagram.com',
  fbBase = 'https://graph.facebook.com',
  ruploadBase = 'https://rupload.facebook.com/ig-api-upload',
  version = GRAPH_VERSION,
  fetchImpl,
  retryDelayMs = 500,
  sleep = defaultSleep,
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const host = (mode === 'facebook' ? fbBase : igBase).replace(/\/+$/, '');
  const base = `${host}/${version}`;
  let accessToken = token;
  let usage = null;
  const unsupported = new Set(); // `${scope}:${metric}` rejected by the API during this client's life
  const isFb = mode === 'facebook';
  const uidPath = () => `/${userId || 'me'}`;
  const msgPath = () => (isFb ? `/${pageId}` : '/me');
  const msgToken = () => (isFb ? pageToken || accessToken : accessToken);

  function fullUrl(path, unversioned) {
    if (/^https?:\/\//.test(path)) return path;
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${unversioned ? host : base}${p}`;
  }

  function readUsage(res) {
    try {
      const raw = res.headers && res.headers.get && res.headers.get('x-business-use-case-usage');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const first = Object.values(parsed)[0];
      const u = Array.isArray(first) ? first[0] : null;
      if (u) {
        usage = {
          callCount: u.call_count ?? null,
          totalCputime: u.total_cputime ?? null,
          totalTime: u.total_time ?? null,
          regainMinutes: u.estimated_time_to_regain_access ?? 0,
          at: new Date().toISOString(),
        };
      }
    } catch {
      // ignore malformed header
    }
  }

  /**
   * Low-level request. opts: { token, unversioned, idempotent, retries }
   */
  async function request(method, path, params = {}, opts = {}) {
    const tok = opts.token || accessToken;
    const m = method.toUpperCase();
    let url = fullUrl(path, opts.unversioned);
    const init = { method: m, cache: 'no-store' };
    if (m === 'POST') {
      const body = encodeParams({ ...params, access_token: tok });
      init.body = body;
    } else {
      const u = new URL(url);
      for (const [k, v] of encodeParams(params)) u.searchParams.set(k, v);
      if (tok && !u.searchParams.has('access_token')) u.searchParams.set('access_token', tok);
      url = u.toString();
    }
    const idempotent = opts.idempotent ?? (m !== 'POST' || !CREATE_PATH.test(new URL(url).pathname));
    const retries = opts.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await doFetch(url, init);
      } catch (cause) {
        const err = new IgError(`Could not reach Instagram (${(cause && cause.message) || cause}).`, { code: 'network', status: 0, cause });
        if (attempt < retries) {
          await sleep(retryDelayMs * 2 ** attempt);
          continue;
        }
        throw err;
      }
      readUsage(res);
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (res.ok && !(data && typeof data === 'object' && data.error)) return data ?? {};
      const err = errorFromBody(res.status, data);
      if (idempotent && attempt < retries && retryableNow(err)) {
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }

  const get = (path, params, opts) => request('GET', path, params, opts);
  const post = (path, params, opts) => request('POST', path, params, opts);
  const del = (path, params, opts) => request('DELETE', path, params, opts);

  /** Follow paging.next (same origin only) until `max` items are collected. */
  async function paginate(path, params = {}, { max = 500, token: tok } = {}) {
    const items = [];
    const seen = new Set();
    const origin = new URL(base).origin;
    let page = await get(path, params, { token: tok });
    for (;;) {
      const data = (page && page.data) || [];
      for (const it of data) {
        items.push(it);
        if (items.length >= max) return items;
      }
      const paging = (page && page.paging) || {};
      const after = paging.cursors && paging.cursors.after;
      if (!data.length || (!paging.next && !after)) break;
      let nextUrl = null;
      if (paging.next) {
        try {
          const u = new URL(paging.next);
          if (u.origin === origin) {
            if (!u.searchParams.has('access_token')) u.searchParams.set('access_token', tok || accessToken);
            nextUrl = u.toString();
          }
        } catch {
          nextUrl = null;
        }
      }
      if (!paging.next) break; // no next page even if a cursor is present
      const key = nextUrl || `after:${after}`;
      if (seen.has(key)) break;
      seen.add(key);
      page = nextUrl ? await get(nextUrl, {}, { token: tok }) : after ? await get(path, { ...params, after }, { token: tok }) : null;
      if (!page) break;
    }
    return items;
  }

  /** GET insights with automatic removal of metrics the API rejects. Returns data[]. */
  async function insights(path, metrics, extra, scope) {
    let list = metrics.filter((m) => !unsupported.has(`${scope}:${m}`));
    for (let guard = 0; list.length && guard < metrics.length + 1; guard++) {
      try {
        const res = await get(path, { metric: list.join(','), ...extra });
        return (res && res.data) || [];
      } catch (err) {
        if (!isMetricError(err)) throw err;
        if (list.length === 1) {
          unsupported.add(`${scope}:${list[0]}`);
          return [];
        }
        const bad = offendingMetrics(err.message, list);
        if (bad.length) {
          for (const m of bad) unsupported.add(`${scope}:${m}`);
          list = list.filter((m) => !bad.includes(m));
          continue;
        }
        // Unclear which metric failed: ask for each one separately.
        const out = [];
        for (const m of list) {
          try {
            const res = await get(path, { metric: m, ...extra });
            out.push(...((res && res.data) || []));
          } catch (e2) {
            if (isMetricError(e2)) unsupported.add(`${scope}:${m}`);
            else throw e2;
          }
        }
        return out;
      }
    }
    return [];
  }

  const ME_FIELDS = 'user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count';
  const FB_USER_FIELDS = 'id,ig_id,username,name,profile_picture_url,followers_count,follows_count,media_count';
  const MEDIA_FIELDS =
    'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,shortcode,timestamp,like_count,comments_count,is_comment_enabled,children{id,media_type,media_url,thumbnail_url}';
  const MEDIA_FIELDS_BASIC = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,children{id,media_type,media_url,thumbnail_url}';
  const COMMENT_FIELDS = 'id,text,timestamp,username,from{id,username},like_count,hidden,parent_id';
  const COMMENT_FIELDS_BASIC = 'id,text,timestamp,username,like_count';

  function requireFacebook(feature) {
    if (!isFb) {
      throw new IgError(`${feature} requires Instagram API with Facebook Login.`, {
        code: 'unsupported',
        userMessage: `${feature} needs a Facebook Login connection. In Settings, connect Instagram through the Facebook Page linked to your account to use it.`,
      });
    }
  }

  const ig = {
    mode,
    version,
    get userId() {
      return userId;
    },
    get pageId() {
      return pageId;
    },
    get token() {
      return accessToken;
    },
    /** Last parsed X-Business-Use-Case-Usage header ({callCount, totalCputime, totalTime, regainMinutes}) or null. */
    get usage() {
      return usage;
    },
    /** Metrics the API rejected during this client's life, as 'scope:metric' strings. */
    unsupportedMetrics: unsupported,
    setToken(t) {
      accessToken = t;
    },
    request,
    get,
    post,
    del,
    paginate,

    /** Profile of the connected account. */
    async me() {
      let data;
      if (isFb) {
        const path = uidPath();
        try {
          data = await get(path, { fields: `${FB_USER_FIELDS},biography,website` });
        } catch (err) {
          if (!(err instanceof IgError) || err.code !== 100) throw err;
          data = await get(path, { fields: FB_USER_FIELDS });
        }
      } else {
        try {
          data = await get('/me', { fields: `${ME_FIELDS},biography,website` });
        } catch (err) {
          if (!(err instanceof IgError) || err.code !== 100) throw err;
          data = await get('/me', { fields: ME_FIELDS });
        }
      }
      const me = {
        id: data.id,
        userId: data.user_id || data.id,
        username: data.username || '',
        name: data.name || '',
        profilePictureUrl: data.profile_picture_url || null,
        followersCount: data.followers_count ?? null,
        followsCount: data.follows_count ?? null,
        mediaCount: data.media_count ?? null,
        biography: data.biography ?? null,
        website: data.website ?? null,
        accountType: data.account_type || null,
      };
      if (!userId && me.userId) userId = me.userId;
      return me;
    },

    /** Recent feed media (newest first), normalized. */
    async listMedia({ limit = 50, max = 100 } = {}) {
      const path = `${uidPath()}/media`;
      let raw;
      try {
        raw = await paginate(path, { fields: MEDIA_FIELDS, limit: Math.min(limit, max) }, { max });
      } catch (err) {
        if (!(err instanceof IgError) || err.code !== 100 || err.subcode === 33) throw err;
        raw = await paginate(path, { fields: MEDIA_FIELDS_BASIC, limit: Math.min(limit, max) }, { max });
      }
      return raw.map(normMedia);
    },

    /** Alias kept for ARCHITECTURE.md (`ig.media`). */
    media(opts) {
      return ig.listMedia(opts);
    },

    async getMedia(id, fields = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,shortcode,timestamp,like_count,comments_count') {
      return get(`/${id}`, { fields });
    },

    /** Lifetime insights for one media object; unsupported metrics are dropped automatically. */
    async mediaInsights(media) {
      const kind = mediaKind(media);
      try {
        const data = await insights(`/${media.id}/insights`, MEDIA_METRICS[kind], {}, `media-${kind}`);
        const out = {};
        for (const item of data) {
          const key = MEDIA_METRIC_KEYS[item.name];
          const v = metricValue(item);
          if (key && typeof v === 'number') out[key] = v;
        }
        return out;
      } catch (err) {
        if (isNotEnoughViewers(err)) return {};
        if (err instanceof IgError && err.subcode === 2108006) return {};
        throw err;
      }
    },

    /**
     * Daily account metrics keyed by local day: { 'YYYY-MM-DD': partial DailySnapshot }.
     * Days that fail for non-auth reasons are skipped.
     */
    async accountDaily({ sinceKey, untilKey, tz = 'UTC', concurrency = 3 } = {}) {
      const out = {};
      const keys = dayRange(sinceKey, untilKey);
      const day = (k) => (out[k] = out[k] || {});
      const fatal = (err) => !(err instanceof IgError) || err.isAuth || err.isRateLimit || err.code === 'network';
      const path = `${uidPath()}/insights`;

      for (let i = 0; i < keys.length; i += 30) {
        const chunk = keys.slice(i, i + 30);
        const since = unix(startOfDay(chunk[0], tz));
        const until = Math.min(unix(startOfDay(addDaysKey(chunk[chunk.length - 1], 1), tz)), unix(new Date()));
        if (until <= since) continue;
        try {
          const data = await insights(path, ['follower_count', 'reach'], { period: 'day', since, until }, `account-ts-${chunk[0]}`);
          for (const item of data) {
            for (const v of item.values || []) {
              const k = insightsDayKey(v.end_time, tz);
              if (!k || k < sinceKey || k > untilKey || typeof v.value !== 'number') continue;
              if (item.name === 'follower_count') day(k).followerCountDelta = v.value;
              if (item.name === 'reach') day(k).reachSeries = v.value;
            }
          }
        } catch (err) {
          if (fatal(err)) throw err;
        }
      }

      const nowSec = unix(new Date());
      await mapLimit(keys, concurrency, async (k) => {
        const since = unix(startOfDay(k, tz));
        const until = Math.min(unix(startOfDay(addDaysKey(k, 1), tz)), nowSec);
        if (until <= since) return;
        const params = { period: 'day', metric_type: 'total_value', since, until };
        try {
          const data = await insights(path, Object.keys(DAILY_TOTAL_KEYS), params, 'account-day');
          for (const item of data) {
            const key = DAILY_TOTAL_KEYS[item.name];
            const v = metricValue(item);
            if (key && typeof v === 'number') day(k)[key] = v;
          }
        } catch (err) {
          if (fatal(err)) throw err;
        }
        try {
          const data = await insights(path, ['follows_and_unfollows'], { ...params, breakdown: 'follow_type' }, 'account-follows');
          for (const item of data) {
            for (const r of breakdownResults(item)) {
              const dim = (r.dimension_values || [])[0];
              if (dim === 'FOLLOWER') day(k).followsGained = r.value;
              else if (dim === 'NON_FOLLOWER') day(k).unfollows = r.value;
            }
          }
        } catch (err) {
          if (fatal(err)) throw err;
        }
      });

      for (const k of Object.keys(out)) {
        const d = out[k];
        if (d.reach === undefined && d.reachSeries !== undefined) d.reach = d.reachSeries;
        if (d.followsGained === undefined && d.followerCountDelta !== undefined) d.followsGained = d.followerCountDelta;
        delete d.reachSeries;
        delete d.followerCountDelta;
        if (!Object.keys(d).length) delete out[k];
      }
      return out;
    },

    /** Alias kept for ARCHITECTURE.md: accountInsights({since, until, tz}) with day keys. */
    accountInsights({ since, until, tz } = {}) {
      return ig.accountDaily({ sinceKey: since, untilKey: until, tz });
    },

    /**
     * When followers are online over the last 30 days, converted to `tz` wall-clock hours.
     * -> { byHour: number[24], byWeekdayHour: number[7][24] | null, days, tz }
     */
    async onlineFollowers({ tz = 'UTC' } = {}) {
      const until = unix(new Date());
      const since = until - 30 * 86400;
      const data = await insights(`${uidPath()}/insights`, ['online_followers'], { period: 'lifetime', since, until }, 'online');
      const hourSum = new Array(24).fill(0);
      const hourCnt = new Array(24).fill(0);
      const wdSum = Array.from({ length: 7 }, () => new Array(24).fill(0));
      const wdCnt = Array.from({ length: 7 }, () => new Array(24).fill(0));
      let days = 0;
      for (const item of data) {
        for (const v of item.values || []) {
          const map = v.value;
          if (!map || typeof map !== 'object' || !Object.keys(map).length) continue;
          const ptDay = insightsDayKey(v.end_time, INSIGHTS_TZ);
          if (!ptDay) continue;
          days++;
          for (const [h, n] of Object.entries(map)) {
            const hour = Number(h);
            if (!(hour >= 0 && hour < 24) || typeof n !== 'number') continue;
            const at = zonedToUtc(ptDay, `${String(hour).padStart(2, '0')}:00`, INSIGHTS_TZ);
            const p = zonedParts(at, tz);
            hourSum[p.hour] += n;
            hourCnt[p.hour]++;
            wdSum[p.weekday][p.hour] += n;
            wdCnt[p.weekday][p.hour]++;
          }
        }
      }
      const avg = (s, c) => (c ? Math.round(s / c) : 0);
      return {
        byHour: hourSum.map((s, i) => avg(s, hourCnt[i])),
        byWeekdayHour: days >= 7 ? wdSum.map((row, w) => row.map((s, h) => avg(s, wdCnt[w][h]))) : null,
        days,
        tz,
      };
    },

    /** Follower and engaged-audience breakdowns; null where unavailable (e.g. under 100 followers). */
    async demographics({ timeframe = 'this_month' } = {}) {
      const dims = ['age', 'gender', 'country', 'city'];
      const fetchOne = async (metric, dim) => {
        try {
          const res = await get(`${uidPath()}/insights`, { metric, period: 'lifetime', metric_type: 'total_value', timeframe, breakdown: dim });
          const item = ((res && res.data) || [])[0];
          if (!item) return null;
          return breakdownResults(item)
            .map((r) => ({ key: (r.dimension_values || []).join(' '), value: r.value }))
            .filter((r) => r.key && typeof r.value === 'number')
            .sort((a, b) => b.value - a.value);
        } catch (err) {
          if (err instanceof IgError && (err.isAuth || err.code === 'network')) throw err;
          return null;
        }
      };
      const build = async (metric) => {
        const rows = await Promise.all(dims.map((d) => fetchOne(metric, d)));
        if (rows.every((r) => r === null)) return null;
        return Object.fromEntries(dims.map((d, i) => [d, rows[i]]));
      };
      const [follower, engaged] = await Promise.all([build('follower_demographics'), build('engaged_audience_demographics')]);
      return { follower, engaged, timeframe };
    },

    /** Currently live stories. */
    async stories() {
      const raw = await paginate(
        `${uidPath()}/stories`,
        { fields: 'id,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp' },
        { max: 100 },
      );
      return raw.map((s) => ({
        id: s.id,
        mediaType: s.media_type || null,
        mediaUrl: s.media_url || null,
        thumbnailUrl: s.thumbnail_url || null,
        permalink: s.permalink || null,
        timestamp: isoTime(s.timestamp),
      }));
    },

    /** Insights for a live story; {} when Instagram has too few viewers to report. */
    async storyInsights(id) {
      const out = {};
      try {
        const data = await insights(`/${id}/insights`, MEDIA_METRICS.STORY, {}, 'media-STORY');
        for (const item of data) {
          const key = MEDIA_METRIC_KEYS[item.name];
          const v = metricValue(item);
          if (key && typeof v === 'number') out[key] = v;
        }
      } catch (err) {
        if (isNotEnoughViewers(err)) return {};
        throw err;
      }
      try {
        const res = await get(`/${id}/insights`, { metric: 'navigation', breakdown: 'story_navigation_action_type' });
        const item = ((res && res.data) || [])[0];
        if (item) {
          const nav = { tapForward: 0, tapBack: 0, tapExit: 0, swipeForward: 0 };
          for (const r of breakdownResults(item)) {
            const key = NAV_KEYS[(r.dimension_values || [])[0]];
            if (key) nav[key] = r.value;
          }
          out.navigation = nav;
        }
      } catch (err) {
        if (err instanceof IgError && err.isAuth) throw err;
      }
      return out;
    },

    /** Top-level comments with their replies (newest first). */
    async comments(mediaId, { max = 100 } = {}) {
      const fields = `${COMMENT_FIELDS},replies{${COMMENT_FIELDS}}`;
      let raw;
      try {
        raw = await paginate(`/${mediaId}/comments`, { fields, limit: Math.min(50, max) }, { max });
      } catch (err) {
        if (!(err instanceof IgError) || err.code !== 100 || err.subcode === 33) throw err;
        raw = await paginate(`/${mediaId}/comments`, { fields: `${COMMENT_FIELDS_BASIC},replies{${COMMENT_FIELDS_BASIC}}`, limit: Math.min(50, max) }, { max });
      }
      return raw.map((c) => {
        const n = normComment(c);
        n.mediaId = n.mediaId || mediaId;
        for (const r of n.replies) {
          r.parentId = r.parentId || n.id;
          r.mediaId = r.mediaId || mediaId;
        }
        return n;
      });
    },

    /** Replies to one comment. */
    async replies(commentId, { max = 100 } = {}) {
      const raw = await paginate(`/${commentId}/replies`, { fields: COMMENT_FIELDS }, { max });
      return raw.map((c) => ({ ...normComment(c), parentId: c.parent_id || commentId }));
    },

    async replyToComment(commentId, text) {
      const res = await post(`/${commentId}/replies`, { message: text });
      return { id: res.id };
    },

    async hideComment(commentId, hide = true) {
      await post(`/${commentId}`, { hide: !!hide }, { idempotent: true });
      return { id: commentId, hidden: !!hide };
    },

    async deleteComment(commentId) {
      await del(`/${commentId}`);
      return { id: commentId, deleted: true };
    },

    async setCommentsEnabled(mediaId, enabled) {
      await post(`/${mediaId}`, { comment_enabled: !!enabled }, { idempotent: true });
      return { id: mediaId, commentsEnabled: !!enabled };
    },

    /** DM threads, most recently active first. */
    async conversations({ max = 50 } = {}) {
      const raw = await paginate(
        `${msgPath()}/conversations`,
        { platform: 'instagram', fields: 'id,updated_time,participants' },
        { max, token: msgToken() },
      );
      return raw.map((c) => ({
        id: c.id,
        updatedTime: isoTime(c.updated_time),
        participants: ((c.participants && c.participants.data) || []).map((p) => ({ id: p.id, username: p.username || null })),
      }));
    },

    /** Messages of one thread, newest first (Instagram only returns the latest 20). */
    async messages(conversationId) {
      const res = await get(
        `/${conversationId}`,
        { fields: 'messages{id,created_time,from,to,message,attachments}' },
        { token: msgToken() },
      );
      return ((res.messages && res.messages.data) || []).map(normMessage);
    },

    async sendMessage(recipientId, text) {
      const res = await post(`${msgPath()}/messages`, { recipient: { id: recipientId }, message: { text } }, { token: msgToken() });
      return { messageId: res.message_id || res.id, recipientId: res.recipient_id || recipientId };
    },

    async sendImage(recipientId, url) {
      const res = await post(
        `${msgPath()}/messages`,
        { recipient: { id: recipientId }, message: { attachment: { type: 'image', payload: { url } } } },
        { token: msgToken() },
      );
      return { messageId: res.message_id || res.id, recipientId: res.recipient_id || recipientId };
    },

    /** One private DM in reply to a comment (within 7 days of the comment). */
    async privateReply(commentId, text) {
      const res = await post(`${msgPath()}/messages`, { recipient: { comment_id: commentId }, message: { text } }, { token: msgToken() });
      return { messageId: res.message_id || res.id, recipientId: res.recipient_id || null };
    },

    async publishingLimit() {
      const res = await get(`${uidPath()}/content_publishing_limit`, { fields: 'config,quota_usage' });
      const d = ((res && res.data) || [])[0] || {};
      return {
        used: d.quota_usage ?? 0,
        total: (d.config && d.config.quota_total) ?? 100,
        durationSec: (d.config && d.config.quota_duration) ?? 86400,
      };
    },

    /** Extend a long-lived Instagram token by 60 days (Instagram Login only). */
    async refreshToken() {
      if (isFb) {
        throw new IgError('Facebook Login tokens cannot be refreshed.', {
          code: 'unsupported',
          userMessage: 'Facebook Page tokens do not expire, so there is nothing to refresh.',
        });
      }
      const res = await get('/refresh_access_token', { grant_type: 'ig_refresh_token' }, { unversioned: true });
      if (!res || !res.access_token) throw new IgError('Instagram did not return a new token.', { code: 'refresh_failed' });
      accessToken = res.access_token;
      const expiresAt = res.expires_in ? new Date(Date.now() + Number(res.expires_in) * 1000).toISOString() : null;
      return { token: res.access_token, expiresAt };
    },

    /** Public profile + recent media of another business/creator account (Facebook Login only). */
    async businessDiscovery(username, { mediaLimit = 12 } = {}) {
      requireFacebook('Competitor tracking');
      const name = String(username || '').trim().replace(/^@/, '');
      if (!/^[A-Za-z0-9._]{1,30}$/.test(name)) {
        throw new IgError(`"${name}" is not a valid Instagram username.`, { code: 'invalid_username', userMessage: 'Enter a valid Instagram username.' });
      }
      const mediaFields = 'id,caption,media_type,media_product_type,media_url,permalink,timestamp,like_count,comments_count';
      const fields = `business_discovery.username(${name}){id,username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count,media.limit(${mediaLimit}){${mediaFields}}}`;
      let res;
      try {
        res = await get(uidPath(), { fields });
      } catch (err) {
        if (err instanceof IgError && (err.subcode === 2207013 || /invalid user|cannot be found/i.test(`${err.message} ${err.userDetail || ''}`))) {
          err.userMessage = `Instagram could not find @${name}, or it is not a business or creator account.`;
        }
        throw err;
      }
      const bd = res.business_discovery || {};
      return {
        id: bd.id || null,
        username: bd.username || name,
        name: bd.name || '',
        biography: bd.biography || '',
        website: bd.website || '',
        profilePictureUrl: bd.profile_picture_url || null,
        followersCount: bd.followers_count ?? null,
        followsCount: bd.follows_count ?? null,
        mediaCount: bd.media_count ?? null,
        media: ((bd.media && bd.media.data) || []).map((m) => {
          const n = normMedia(m);
          return {
            id: n.id,
            caption: n.caption,
            mediaType: n.mediaType,
            productType: n.productType,
            permalink: n.permalink,
            timestamp: n.timestamp,
            likeCount: n.likeCount,
            commentsCount: n.commentsCount,
            mediaUrl: n.mediaUrl,
          };
        }),
      };
    },

    /** Hashtag id for a name (Facebook Login only; 30 unique hashtags per 7 days). */
    async hashtagSearch(name) {
      requireFacebook('Hashtag research');
      const q = String(name || '').trim().replace(/^#/, '');
      const res = await get('/ig_hashtag_search', { user_id: userId, q });
      const first = ((res && res.data) || [])[0];
      if (!first) throw new IgError(`No hashtag found for #${q}.`, { code: 'not_found', userMessage: `Instagram has no hashtag #${q}.` });
      return first.id;
    },

    async hashtagMedia(id, edge = 'top', { limit = 25 } = {}) {
      requireFacebook('Hashtag research');
      const path = `/${id}/${edge === 'recent' ? 'recent_media' : 'top_media'}`;
      const res = await get(path, {
        user_id: userId,
        fields: 'id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count,children{id,media_type,media_url}',
        limit,
      });
      return ((res && res.data) || []).map(normMedia);
    },

    /** Media where the account is photo-tagged (Facebook Login only). */
    async tags({ max = 50 } = {}) {
      requireFacebook('Tagged posts');
      const raw = await paginate(
        `${uidPath()}/tags`,
        { fields: 'id,caption,media_type,media_url,permalink,timestamp,username,like_count,comments_count' },
        { max },
      );
      return raw.map((m) => ({ ...normMedia(m), username: m.username || null }));
    },

    /** Delete published media (Facebook Login only). */
    async deleteMedia(id) {
      requireFacebook('Deleting posts');
      await del(`/${id}`);
      return { id, deleted: true };
    },

    // Publishing primitives (used by core/publish.js)

    async createContainer(params) {
      const res = await post(`${uidPath()}/media`, params);
      return { id: res.id, ...(res.uri ? { uri: res.uri } : {}) };
    },

    async containerStatus(id) {
      const res = await get(`/${id}`, { fields: 'status_code,status' });
      return { statusCode: res.status_code || null, status: res.status || '' };
    },

    async publishContainer(creationId) {
      const res = await post(`${uidPath()}/media_publish`, { creation_id: creationId });
      return res.id;
    },

    /** Upload video bytes to a resumable container (Node only; rupload has no CORS). */
    async uploadResumable(uri, bytes) {
      let url = String(uri);
      if (url.startsWith(RUPLOAD_PREFIX)) url = ruploadBase.replace(/\/+$/, '') + url.slice(RUPLOAD_PREFIX.length);
      let res;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: {
            Authorization: `OAuth ${accessToken}`,
            offset: '0',
            file_size: String(bytes.byteLength ?? bytes.length),
            'Content-Type': 'application/octet-stream',
          },
          body: bytes,
        });
      } catch (cause) {
        throw new IgError(`Could not upload the video (${(cause && cause.message) || cause}).`, { code: 'network', status: 0, cause });
      }
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = text;
      }
      if (!res.ok || (data && typeof data === 'object' && (data.error || data.debug_info) && !data.success)) throw errorFromBody(res.status, data);
      return data || { success: true };
    },
  };
  return ig;
}

/**
 * Validate a token and build the IgConnection to store in settings.ig.
 * Facebook mode: `token` is a Facebook user (or system user) token; the first Page with a linked
 * Instagram professional account is used unless `pageId` picks another. All candidates are in `.pages`.
 */
export async function connectInstagram({ mode = 'instagram', token, igBase, fbBase, ruploadBase, version = GRAPH_VERSION, fetchImpl, pageId } = {}) {
  const tok = String(token || '').trim();
  if (!tok) throw new IgError('No access token given.', { code: 'no_token', userMessage: 'Paste an access token first.' });
  const now = new Date().toISOString();
  if (mode !== 'facebook') {
    const ig = createIg({ mode: 'instagram', token: tok, igBase, fbBase, ruploadBase, version, fetchImpl });
    const me = await ig.me();
    return {
      mode: 'instagram',
      token: tok,
      tokenType: 'ig_long',
      tokenExpiresAt: null,
      tokenRefreshedAt: null,
      userId: me.userId,
      username: me.username,
      name: me.name,
      profilePictureUrl: me.profilePictureUrl,
      accountType: me.accountType,
      apiVersion: version,
      connectedAt: now,
    };
  }

  const user = createIg({ mode: 'facebook', token: tok, igBase, fbBase, ruploadBase, version, fetchImpl });
  let pages;
  try {
    pages = await user.paginate('/me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 100 }, { max: 200 });
  } catch (err) {
    // A Page token was pasted directly: /me is the Page itself.
    if (!(err instanceof IgError) || err.code !== 100) throw err;
    const page = await user.get('/me', { fields: 'id,name,instagram_business_account{id,username}' });
    pages = [{ ...page, access_token: tok }];
  }
  const candidates = pages
    .filter((p) => p.instagram_business_account && p.instagram_business_account.id)
    .map((p) => ({
      pageId: p.id,
      pageName: p.name || '',
      pageToken: p.access_token || tok,
      userId: p.instagram_business_account.id,
      username: p.instagram_business_account.username || '',
    }));
  if (!candidates.length) {
    throw new IgError('No Facebook Page with a linked Instagram account.', {
      code: 'no_ig_account',
      userMessage: 'None of your Facebook Pages has an Instagram professional account linked. Link your Instagram account to a Page (Instagram app > Settings > Account type and tools), then try again.',
    });
  }
  const chosen = (pageId && candidates.find((c) => c.pageId === pageId)) || candidates[0];
  const ig = createIg({
    mode: 'facebook',
    token: chosen.pageToken,
    userId: chosen.userId,
    pageId: chosen.pageId,
    pageToken: chosen.pageToken,
    igBase,
    fbBase,
    ruploadBase,
    version,
    fetchImpl,
  });
  const me = await ig.me();
  return {
    mode: 'facebook',
    token: chosen.pageToken,
    tokenType: 'fb_page',
    tokenExpiresAt: null,
    tokenRefreshedAt: null,
    userToken: tok,
    userId: chosen.userId,
    username: me.username || chosen.username,
    name: me.name,
    profilePictureUrl: me.profilePictureUrl,
    accountType: me.accountType || 'BUSINESS',
    pageId: chosen.pageId,
    pageName: chosen.pageName,
    pageToken: chosen.pageToken,
    apiVersion: version,
    connectedAt: now,
    pages: candidates.map(({ pageToken: _t, ...rest }) => rest),
  };
}
