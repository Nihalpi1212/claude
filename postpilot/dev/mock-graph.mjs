// In-memory imitation of the Instagram Graph API (graph.instagram.com and graph.facebook.com)
// plus the resumable upload host (rupload.facebook.com). Used by the dev server and tests.
//
// Behaves like the real API where it matters for Postpilot: Graph-style errors, field
// projection with nested edges (unknown fields fail with code 100), cursor paging with absolute
// `paging.next` URLs, all-or-nothing insights (an unsupported metric fails the whole call), the
// container state machine (IN_PROGRESS -> FINISHED / ERROR / EXPIRED -> PUBLISHED), media URL
// validation (Instagram really downloads the file), messaging windows and private replies.
//
// Tokens: anything works except 'expired-token' (190/463) and 'invalid-token' (190/467).
// Test hooks on `state`: faults (inject errors: {method, path: string|RegExp, when(params), times,
// error: {status, code, subcode, message} | destroy: true}), dmMode ('ok'|'advanced_access'|'disabled'),
// publishLimit, businessAccounts, tokenExpiry (debug_token expires_at per token), requests (log), containers,
// media, comments, conversations, sentMessages, ...

import { addDaysKey, dayKey, startOfDay, zonedParts, zonedToUtc } from '../core/time.js';

const DAY = 864e5;
const HOUR = 36e5;
const PT = 'America/Los_Angeles';
const RUPLOAD = 'https://rupload.facebook.com/ig-api-upload';

class GraphFail extends Error {
  constructor(code, message, { subcode, status = 400, type = 'OAuthException', userTitle, userMsg } = {}) {
    super(message);
    this.code = code;
    this.subcode = subcode;
    this.status = status;
    this.type = type;
    this.userTitle = userTitle;
    this.userMsg = userMsg;
  }
}

function h32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const graphTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+0000');
const b64 = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '');

// ---------------------------------------------------------------------------------------------
// Field-expansion parser: "a,b{c,d},media.limit(5){id},business_discovery.username(x){id}"

function parseFields(str) {
  const s = String(str || '').replace(/\s+/g, '');
  let i = 0;
  function list() {
    const out = [];
    while (i < s.length && s[i] !== '}') {
      if (s[i] === ',') {
        i++;
        continue;
      }
      const start = i;
      const f = field();
      if (i === start) i++; // skip junk
      if (f.name) out.push(f);
    }
    return out;
  }
  function word() {
    let w = '';
    while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) w += s[i++];
    return w;
  }
  function field() {
    const name = word();
    const mods = {};
    while (s[i] === '.') {
      i++;
      const m = word();
      if (s[i] === '(') {
        i++;
        let arg = '';
        while (i < s.length && s[i] !== ')') arg += s[i++];
        i++;
        mods[m] = arg;
      } else mods[m] = true;
    }
    let sub = null;
    if (s[i] === '{') {
      i++;
      sub = list();
      i++;
    }
    return { name, mods, sub };
  }
  return list();
}

function project(node, spec, typeName) {
  const out = {};
  for (const f of spec) {
    if (!(f.name in node)) throw new GraphFail(100, `(#100) Tried accessing nonexisting field (${f.name}) on node type (${typeName})`);
    let v = node[f.name];
    if (typeof v === 'function') v = v(f.mods, f.sub);
    else if (v && typeof v === 'object' && !Array.isArray(v) && f.sub) {
      if (Array.isArray(v.data)) v = { ...v, data: v.data.map((x) => pick(x, f.sub)) };
      else v = pick(v, f.sub);
    }
    if (v !== undefined) out[f.name] = v;
  }
  // Like Graph, node reads always carry the id.
  if (node.id !== undefined && typeof node.id !== 'function' && out.id === undefined) out.id = node.id;
  return out;
}

function pick(obj, spec) {
  const out = {};
  for (const f of spec) if (obj[f.name] !== undefined) out[f.name] = f.sub && obj[f.name] && typeof obj[f.name] === 'object' ? pick(obj[f.name], f.sub) : obj[f.name];
  return out;
}

// ---------------------------------------------------------------------------------------------
// Demo content

const OPENERS = [
  'New in the studio:',
  'Slow mornings,',
  'Behind the scenes:',
  'Fresh out of the kiln',
  'Weekend reset.',
  'A small detail we love:',
  'Process over perfection.',
  'Golden hour at the studio',
  'Studio notes:',
  'Meet the new collection',
  'Quiet corners',
  'Three things we learned this week',
];
const BODIES = [
  'hand-thrown stoneware in warm clay tones',
  'testing glazes until the colour feels just right',
  'our autumn palette is finally here',
  'the light hit the shelves just right this morning',
  'every piece is shaped by hand, so no two are alike',
  'swipe to see how a mug comes to life',
  'packing orders for Friday shipping',
  'a tiny preview of what drops next week',
  'coffee, clay and a playlist on repeat',
  'sketches that slowly turned into objects',
  'speckled glazes, soft edges and a lot of patience',
  'the arches outside our window inspired this series',
];
const REEL_LINES = [
  'Watch this mug go from clay to cup in 30 seconds',
  'Trimming day, the most satisfying part of the process',
  'Glaze reveal: kiln opening day',
  'How we pack your orders',
  'A day in the studio, start to finish',
  'Centering clay, slowed down',
];
const CTAS = [
  'Which one would you pick?',
  'Tell us your favourite in the comments.',
  'Link in bio to shop.',
  'Save this for later.',
  'DM us for custom orders.',
  'Drop a ☕ if you need a coffee too.',
  'Would you like a studio tour reel?',
  '',
];
const EMOJI = ['✨', '🌿', '☕', '🏺', '🧡', '🌙', '📦', '🎨'];
const TAGS = [
  '#ceramics', '#handmade', '#pottery', '#studiolife', '#slowliving', '#interiordesign', '#madebyhand', '#stoneware',
  '#designinspo', '#coffeetime', '#minimalism', '#homedecor', '#makersgonnamake', '#smallbusiness', '#potterylove',
  '#wheelthrown', '#creativeprocess', '#shopsmall',
];
const COMMENTERS = [
  'mara.lens', 'theo.builds', 'junie.makes', 'oak.and.ash', 'kiko.studio', 'lin.reads', 'sol.and.salt', 'hanna.clay',
  'the.morning.table', 'ivy.paper', 'noah.frames', 'studio.mila', 'fern.and.fable', 'atlas.coffee', 'rue.daily',
  'wren.home', 'pia.draws', 'olive.loom', 'jonas.wood', 'sage.ceramica',
];
const PRAISE = ['This is beautiful 😍', 'Love the colours!', 'Obsessed with this glaze', 'So calming 🌿', 'The details 🙌', 'Gorgeous work as always', 'Need this in my kitchen', 'Wow 🔥', 'That texture!', 'Saving this for inspiration'];
const QUESTIONS = ["What's the price on the blue one?", 'Do you ship to Canada?', 'Is there a link to the shop?', 'How long does the firing take?', 'Can I get more info on the workshop?', 'Where can I buy this?', 'Any restock planned?', 'What glaze is this?'];
const KEYWORDS = ['Price please!', 'link?', 'info pls 🙏', 'How much is the large vase? price?', 'Send me the link 🙏', 'More info on the class?'];
const SPAM = ['Promote it on @get.fame.now 🚀🚀', 'DM us to collab and get 10k followers fast 💸'];
const OWNER_REPLIES = ['Thank you so much! 🧡', 'Thanks! Sending you a DM with the details.', 'Yes, we ship worldwide.', 'The next restock is Friday ✨', 'So glad you like it!'];
const IMAGES_45 = ['f01.jpg', 'f02.jpg', 'f03.jpg', 'f04.jpg', 'f05.jpg', 'f06.jpg', 'f07.jpg', 'f08.jpg'];
const IMAGES_11 = ['f09.jpg', 'f10.jpg', 'f11.jpg', 'f12.jpg', 'f13.jpg', 'f14.jpg'];
const IMAGES = [...IMAGES_45, ...IMAGES_11];

const BD_ACCOUNTS = {
  'atelier.kin': { name: 'Atelier Kin', biography: 'Small-batch ceramics from Copenhagen. Studio visits by appointment.', website: 'https://atelierkin.example', followers: 12480, follows: 512, theme: 'ceramics' },
  'northbound.coffee': { name: 'Northbound Coffee', biography: 'Roasters + café. Single origin, roasted weekly. Open daily 7-4.', website: 'https://northbound.example', followers: 8930, follows: 801, theme: 'coffee' },
  'lumen.ceramics': { name: 'Lumen Ceramics', biography: 'Lighting and vessels thrown by hand in Lisbon.', website: 'https://lumen.example', followers: 3105, follows: 288, theme: 'ceramics' },
};

const DEMOGRAPHICS = {
  age: [['13-17', 0.02], ['18-24', 0.17], ['25-34', 0.38], ['35-44', 0.24], ['45-54', 0.11], ['55-64', 0.05], ['65+', 0.03]],
  gender: [['F', 0.64], ['M', 0.31], ['U', 0.05]],
  country: [['US', 0.34], ['GB', 0.14], ['CA', 0.08], ['DE', 0.07], ['AU', 0.06], ['NL', 0.04], ['FR', 0.04], ['ES', 0.03], ['SE', 0.03], ['IT', 0.03], ['DK', 0.02], ['PT', 0.02]],
  city: [['New York, New York', 0.07], ['London, England', 0.08], ['Los Angeles, California', 0.04], ['Brooklyn, New York', 0.03], ['Toronto, Ontario', 0.03], ['Berlin, Berlin', 0.03], ['Melbourne, Victoria', 0.025], ['Chicago, Illinois', 0.02], ['Amsterdam, North Holland', 0.02], ['Manchester, England', 0.015], ['Copenhagen, Capital Region', 0.012], ['Lisbon, Lisbon', 0.01]],
};

// Insights metric catalog (mirrors research brief 2).
const ACCOUNT_METRICS = {
  reach: { types: ['time_series', 'total_value'], periods: ['day'], breakdowns: ['media_product_type', 'follow_type'] },
  follower_count: { types: ['time_series'], periods: ['day'], breakdowns: [] },
  online_followers: { types: ['time_series'], periods: ['lifetime'], breakdowns: [] },
  views: { types: ['total_value'], periods: ['day'], breakdowns: ['follower_type', 'media_product_type'] },
  accounts_engaged: { types: ['total_value'], periods: ['day'], breakdowns: [] },
  total_interactions: { types: ['total_value'], periods: ['day'], breakdowns: ['media_product_type'] },
  likes: { types: ['total_value'], periods: ['day'], breakdowns: ['media_product_type'] },
  comments: { types: ['total_value'], periods: ['day'], breakdowns: ['media_product_type'] },
  shares: { types: ['total_value'], periods: ['day'], breakdowns: ['media_product_type'] },
  saves: { types: ['total_value'], periods: ['day'], breakdowns: ['media_product_type'] },
  replies: { types: ['total_value'], periods: ['day'], breakdowns: [] },
  reposts: { types: ['total_value'], periods: ['day'], breakdowns: [] },
  profile_links_taps: { types: ['total_value'], periods: ['day'], breakdowns: ['contact_button_type'] },
  follows_and_unfollows: { types: ['total_value'], periods: ['day'], breakdowns: ['follow_type'] },
  follower_demographics: { types: ['total_value'], periods: ['lifetime'], breakdowns: ['age', 'gender', 'country', 'city'], demo: true },
  engaged_audience_demographics: { types: ['total_value'], periods: ['lifetime'], breakdowns: ['age', 'gender', 'country', 'city'], demo: true },
  reached_audience_demographics: { types: ['total_value'], periods: ['lifetime'], breakdowns: ['age', 'gender', 'country', 'city'], demo: true },
};

const MEDIA_METRICS = {
  FEED: ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'follows', 'profile_visits', 'profile_activity', 'reposts'],
  CAROUSEL: ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'follows', 'profile_visits', 'profile_activity'],
  REELS: ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time', 'reposts', 'reels_skip_rate'],
  STORY: ['reach', 'views', 'replies', 'shares', 'total_interactions', 'follows', 'profile_visits', 'navigation', 'profile_activity', 'reposts'],
};
const ALL_MEDIA_METRICS = [
  'comments', 'crossposted_views', 'facebook_views', 'follows', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time', 'likes',
  'navigation', 'profile_activity', 'profile_visits', 'reach', 'reels_skip_rate', 'replies', 'reposts', 'saved', 'shares',
  'total_interactions', 'views', 'impressions',
];

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * Create the mock. Options:
 *  seed, username, followers, now() (data clock; containers expire after 24h of it),
 *  imageProcessingMs / videoProcessingMs (real time until a container is FINISHED),
 *  fixturesBase (absolute URL or (req) => URL of dev/fixtures; default http://<host><fixturesPath>),
 *  fixturesPath ('/postpilot/dev/fixtures'), audienceTz, publishLimit, validateMediaUrls, fetchImpl,
 *  businessAccounts ({ username: {followers, name, ...} } extra Business Discovery targets).
 */
export function createMockGraph({
  seed = 42,
  username = 'studio.north',
  name = 'Studio North',
  followers = 4820,
  now = () => new Date(),
  imageProcessingMs = 1000,
  videoProcessingMs = 3000,
  fixturesBase = null,
  fixturesPath = '/postpilot/dev/fixtures',
  audienceTz = 'America/New_York',
  publishLimit = 100,
  validateMediaUrls = true,
  businessAccounts = {},
  fetchImpl,
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const rng = mulberry32(seed);
  const r = (a, b) => a + (b - a) * rng();
  const ri = (a, b) => Math.floor(r(a, b + 1));
  const choice = (arr) => arr[Math.floor(rng() * arr.length)];
  const nowMs = () => now().getTime();
  const t0 = nowMs();
  const noise = (...parts) => h32(`${seed}|${parts.join('|')}`) / 4294967296;

  let counter = 0;
  const nextId = (prefix) => `${prefix}${String(100000000000 + (++counter) * 7919 + Math.floor(rng() * 7000)).padStart(14, '0')}`;
  const shortcode = () => Array.from({ length: 11 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'[Math.floor(rng() * 64)]).join('');
  const igsid = (u) => `7${String(h32(`igsid|${u}`)).padStart(10, '0')}${String(h32(`igsid2|${u}`) % 100000).padStart(5, '0')}`;

  const state = {
    userId: `178414${String(h32(`uid|${seed}`)).padStart(11, '0')}`,
    appScopedId: `2690${String(h32(`asid|${seed}`)).padStart(12, '0')}`,
    pageId: `1040${String(h32(`page|${seed}`)).padStart(11, '0')}`,
    username,
    name,
    followers,
    follows: 612,
    biography: 'Hand-thrown ceramics, slow coffee and studio notes. Custom orders open.',
    website: 'https://studionorth.example',
    media: [], // newest first (feed + reels)
    stories: [],
    nodes: new Map(), // id -> {type, obj}
    containers: new Map(),
    comments: new Map(),
    conversations: [],
    sentMessages: [],
    privateReplies: new Map(), // commentId -> messageId
    replies: [], // {commentId, id, text}
    hidden: new Set(),
    deleted: [],
    publishCount: 0,
    publishLog: [], // data-clock ms of each publish
    publishLimit,
    uploads: new Map(), // containerId -> byte length
    tokens: { refreshed: [], lastRefreshedFrom: null },
    tokenExpiry: {}, // token -> unix seconds reported by debug_token (0 = never expires)
    dmMode: 'ok',
    faults: [],
    requests: [],
    hashtags: new Map(),
    // Business Discovery targets; tests may add more: state.businessAccounts['rival.studio'] = { followers: 9000 }
    businessAccounts: { ...JSON.parse(JSON.stringify(BD_ACCOUNTS)), ...businessAccounts },
  };

  const reg = (type, obj) => (state.nodes.set(obj.id, { type, obj }), obj);

  // ----- seed media -----------------------------------------------------------------------
  function makeCaption(kind) {
    const tags = [...TAGS].sort(() => rng() - 0.5).slice(0, ri(3, 9));
    const lead = kind === 'REELS' ? choice(REEL_LINES) : `${choice(OPENERS)} ${choice(BODIES)}`;
    const cta = choice(CTAS);
    const e = rng() < 0.7 ? ` ${choice(EMOJI)}` : '';
    return `${lead}${e}${cta ? `\n\n${cta}` : ''}\n.\n.\n${tags.join(' ')}`;
  }

  function mediaInsightsBase(kind, reachMul = 1) {
    const f = state.followers;
    let reach = f * r(0.22, 0.55) * reachMul;
    if (kind === 'CAROUSEL_ALBUM') reach *= 1.2;
    if (kind === 'REELS') reach *= r(0.9, 3.2);
    reach = Math.round(reach);
    const views = Math.round(reach * (kind === 'REELS' ? r(1.6, 2.8) : r(1.25, 2.1)));
    const likes = Math.round(reach * r(0.035, 0.09));
    const shares = Math.round(likes * r(0.03, 0.12));
    const saved = Math.round(likes * r(0.05, 0.16) * (kind === 'CAROUSEL_ALBUM' ? 1.6 : 1));
    const base = { reach, views, likes, shares, saved, follows: ri(0, 12), profile_visits: Math.round(reach * r(0.01, 0.04)), reposts: ri(0, 6) };
    if (kind === 'REELS') {
      const avg = Math.round(r(3800, 11500));
      base.ig_reels_avg_watch_time = avg;
      base.ig_reels_video_view_total_time = avg * views;
      base.reels_skip_rate = Math.round(r(18, 52) * 10) / 10;
    }
    return base;
  }

  function addComment(media, { username: u, text, ts, parentId = null, own = false, hidden = false, likes = 0 }) {
    const c = reg('comment', {
      id: nextId('180'),
      mediaId: media.id,
      parentId,
      text,
      timestamp: ts,
      username: own ? state.username : u,
      fromId: own ? state.userId : igsid(u),
      like_count: likes,
      hidden,
    });
    state.comments.set(c.id, c);
    if (hidden) state.hidden.add(c.id);
    return c;
  }

  {
    let t = t0 - 120 * DAY + r(0, DAY);
    const count = 70;
    const span = (t0 - DAY * 0.6 - t) / count;
    const seeded = [];
    for (let i = 0; i < count; i++) {
      const day = new Date(t + i * span + r(-0.3, 0.3) * span);
      const hour = choice([13, 14, 16, 17, 22, 23, 23, 0, 1]);
      day.setUTCHours(hour, ri(0, 59), ri(0, 59), 0);
      const ts = Math.min(day.getTime(), t0 - 2 * HOUR);
      const roll = rng();
      const kind = roll < 0.45 ? 'IMAGE' : roll < 0.7 ? 'CAROUSEL_ALBUM' : 'REELS';
      const m = {
        id: nextId('179'),
        caption: makeCaption(kind),
        media_type: kind === 'REELS' ? 'VIDEO' : kind,
        media_product_type: kind === 'REELS' ? 'REELS' : 'FEED',
        file: kind === 'REELS' ? 'clip.mp4' : choice(IMAGES),
        thumbFile: kind === 'REELS' ? choice(IMAGES_45) : null,
        timestamp: ts,
        shortcode: shortcode(),
        is_comment_enabled: true,
        children: [],
        ins: mediaInsightsBase(kind),
      };
      if (kind === 'CAROUSEL_ALBUM') {
        const n = ri(2, 5);
        for (let k = 0; k < n; k++) m.children.push(reg('child', { id: nextId('179'), media_type: 'IMAGE', file: choice(IMAGES_45), timestamp: ts }));
      }
      m.like_count = m.ins.likes;
      seeded.push(m);
    }
    seeded.sort((a, b) => b.timestamp - a.timestamp);
    for (const m of seeded) state.media.push(reg('media', m));

    // comments
    state.media.forEach((m, idx) => {
      const recent = t0 - m.timestamp < 14 * DAY;
      const n = recent ? ri(3, 9) : ri(1, 6);
      const people = [...COMMENTERS].sort(() => rng() - 0.5);
      for (let k = 0; k < n; k++) {
        const u = people[k % people.length];
        const roll = rng();
        let text;
        if (idx < 6 && k === 0) text = choice(KEYWORDS);
        else if (roll < 0.5) text = choice(PRAISE);
        else if (roll < 0.82) text = choice(QUESTIONS);
        else if (roll < 0.95) text = choice(KEYWORDS);
        else text = choice(SPAM);
        const maxAge = Math.min(3 * DAY, t0 - m.timestamp - 60_000);
        const ts = m.timestamp + r(10 * 60_000, Math.max(11 * 60_000, maxAge));
        const isSpam = SPAM.includes(text);
        const c = addComment(m, { username: u, text, ts: Math.min(ts, t0 - 60_000), hidden: isSpam && rng() < 0.5, likes: ri(0, 4) });
        if (!isSpam && rng() < 0.3 && !(idx < 6 && k === 0)) {
          addComment(m, { text: choice(OWNER_REPLIES), ts: Math.min(c.timestamp + r(5 * 60_000, 6 * HOUR), t0 - 30_000), parentId: c.id, own: true });
        }
      }
      m.comments_count = [...state.comments.values()].filter((c) => c.mediaId === m.id).length;
      m.ins.comments = m.comments_count;
      m.ins.total_interactions = m.ins.likes + m.ins.comments + m.ins.shares + m.ins.saved;
    });

    // live stories
    const storyDefs = [
      ['IMAGE', 'story01.jpg', 2.2],
      ['VIDEO', 'clip.mp4', 7.5],
      ['IMAGE', 'story02.jpg', 15.1],
    ];
    for (const [type, file, hoursAgo] of storyDefs) {
      const reach = Math.round(state.followers * r(0.06, 0.16));
      const s = reg('media', {
        id: nextId('179'),
        caption: '',
        media_type: type,
        media_product_type: 'STORY',
        file,
        thumbFile: type === 'VIDEO' ? 'story03.jpg' : null,
        timestamp: t0 - hoursAgo * HOUR,
        shortcode: shortcode(),
        is_comment_enabled: false,
        children: [],
        ins: {
          reach,
          views: Math.round(reach * r(1.1, 1.5)),
          replies: ri(0, 7),
          shares: ri(0, 9),
          follows: ri(0, 4),
          profile_visits: ri(4, 30),
          reposts: 0,
          navigation: { TAP_FORWARD: Math.round(reach * r(0.5, 0.8)), TAP_BACK: Math.round(reach * r(0.03, 0.08)), TAP_EXIT: Math.round(reach * r(0.05, 0.12)), SWIPE_FORWARD: Math.round(reach * r(0.04, 0.1)) },
        },
      });
      s.ins.total_interactions = s.ins.replies + s.ins.shares;
      state.stories.push(s);
    }

    // conversations
    const own = { id: state.userId, username: state.username };
    const convDefs = [
      ['mara.lens', [[50 * HOUR, 'in', 'Hi! I love your work 🧡'], [49 * HOUR, 'out', 'Thank you so much, Mara!'], [0.25 * HOUR, 'in', "Do you take custom orders? I'd love a set of 4 mugs in the speckled glaze. What's the price?"]]],
      ['theo.builds', [[3.2 * HOUR, 'in', "Hey! We're opening a café in Leeds and would love to stock your cups."], [3 * HOUR, 'in', 'Could we talk wholesale pricing?']]],
      ['junie.makes', [[30 * HOUR, 'out', 'Thanks for ordering, Junie! Your vase ships tomorrow.'], [6 * HOUR, 'in', 'It arrived and it is perfect 😍', true]]],
      ['oak.and.ash', [[20 * HOUR, 'in', 'Is the workshop on the 24th still open? Can I get more info?']]],
      ['kiko.studio', [[31 * HOUR, 'in', 'Thanks for the quick shipping!'], [29 * HOUR, 'out', 'Our pleasure, enjoy it!']]],
      ['lin.reads', [[100 * HOUR, 'in', 'Could you send me the link to the planter?'], [98 * HOUR, 'out', 'Here you go: https://studionorth.example/planter']]],
    ];
    for (const [u, msgs] of convDefs) {
      const other = { id: igsid(u), username: u };
      const conv = reg('conversation', { id: `aWdfZAG06${b64(`conv:${seed}:${u}`)}`, participants: [other, own], messages: [] });
      msgs.forEach(([ago, dir, text, attach], i) => {
        const msg = reg('message', {
          id: `aWdfZAG1faXRlbToxOklHTWVzc2FnZAWQ${b64(`${u}:${i}:${seed}`)}`,
          created_time: t0 - ago,
          from: dir === 'in' ? other : own,
          to: dir === 'in' ? [own] : [other],
          message: text,
          attachments: attach ? [{ id: `att_${i}`, mime_type: 'image/jpeg', name: 'photo.jpg', image_data: { width: 1080, height: 1350, fileName: 'f03.jpg' } }] : [],
        });
        conv.messages.unshift(msg);
      });
      state.conversations.push(conv);
    }
  }

  const postedDays = new Map();
  for (const m of state.media) {
    const k = dayKey(new Date(m.timestamp), 'UTC');
    postedDays.set(k, Math.max(postedDays.get(k) || 0, m.media_product_type === 'REELS' ? 1.6 : 1.3));
  }

  // ----- daily account model -----------------------------------------------------------------
  function dayValues(key) {
    const startMs = Date.parse(`${key}T00:00:00Z`);
    const t = (startMs - (t0 - 120 * DAY)) / DAY;
    const trend = 1 + 0.25 * Math.max(-0.5, Math.min(1.1, t / 120));
    const wd = [0.82, 0.95, 1.05, 1.1, 1.08, 1.0, 0.86][new Date(startMs).getUTCDay()];
    const boost = postedDays.get(key) || 1;
    const n = (salt) => 0.88 + 0.24 * noise(key, salt);
    const reach = Math.round(state.followers * 0.21 * trend * wd * boost * n('reach'));
    const likes = Math.round(reach * 0.055 * n('likes'));
    const comments = Math.round(likes * 0.06 * n('comments'));
    const shares = Math.round(likes * 0.07 * n('shares'));
    const saves = Math.round(likes * 0.09 * n('saves'));
    const replies = Math.floor(6 * noise(key, 'replies'));
    const follows = Math.round((6 + 10 * noise(key, 'follows')) * (boost > 1 ? 1.6 : 1));
    return {
      reach,
      views: Math.round(reach * 2.6 * n('views')),
      accounts_engaged: Math.round(reach * 0.075 * n('eng')),
      likes,
      comments,
      shares,
      saves,
      replies,
      reposts: Math.floor(4 * noise(key, 'reposts')),
      total_interactions: likes + comments + shares + saves + replies,
      profile_links_taps: Math.floor(7 * noise(key, 'taps')),
      follows,
      unfollows: Math.round(2 + 5 * noise(key, 'unf')),
    };
  }

  function sumWindow(since, until) {
    const n = Math.max(1, Math.round((until - since) / 86400));
    const total = {};
    const nowS = nowMs() / 1000;
    for (let i = 0; i < n; i++) {
      const sliceStart = since + i * 86400;
      if (sliceStart > nowS) break;
      const frac = Math.min(1, Math.max(0, (nowS - sliceStart) / 86400));
      const key = dayKey(new Date((sliceStart + 43200) * 1000), 'UTC');
      const v = dayValues(key);
      for (const [k, val] of Object.entries(v)) total[k] = (total[k] || 0) + Math.round(val * frac);
    }
    return total;
  }

  function onlineMap(ptKey) {
    const map = {};
    const wd = [0.9, 0.97, 1.0, 1.02, 1.0, 0.96, 0.92][new Date(`${ptKey}T12:00:00Z`).getUTCDay()];
    for (let h = 0; h < 24; h++) {
      const at = zonedToUtc(ptKey, `${String(h).padStart(2, '0')}:00`, PT);
      const lh = zonedParts(at, audienceTz).hour;
      const curve = [0.12, 0.08, 0.06, 0.05, 0.05, 0.08, 0.16, 0.3, 0.38, 0.34, 0.33, 0.38, 0.47, 0.44, 0.36, 0.35, 0.4, 0.5, 0.68, 0.88, 1.0, 0.93, 0.66, 0.3][lh];
      map[String(h)] = Math.round(state.followers * 0.36 * curve * wd * (0.92 + 0.16 * noise(ptKey, h, 'online')));
    }
    return map;
  }

  // ----- helpers ------------------------------------------------------------------------------
  function fixtures(ctx, file) {
    return `${ctx.fixtures.replace(/\/+$/, '')}/${file}`;
  }

  function mediaUrl(m, ctx) {
    return m.url || fixtures(ctx, m.file);
  }

  function permalinkOf(m) {
    if (m.media_product_type === 'STORY') return `https://www.instagram.com/stories/${state.username}/${m.id}/`;
    return `https://www.instagram.com/${m.media_product_type === 'REELS' ? 'reel' : 'p'}/${m.shortcode}/`;
  }

  function ageFactor(m) {
    if (!m.fromApi) return 1;
    return Math.min(1, Math.max(0, (nowMs() - m.timestamp) / (48 * HOUR)));
  }

  function mediaNode(m, ctx) {
    const isVideo = m.media_type === 'VIDEO';
    return {
      id: m.id,
      caption: m.media_product_type === 'STORY' ? undefined : m.caption,
      media_type: m.media_type,
      media_product_type: m.media_product_type,
      media_url: mediaUrl(m, ctx),
      thumbnail_url: isVideo ? m.thumbUrl || fixtures(ctx, m.thumbFile || 'f01.jpg') : undefined,
      permalink: permalinkOf(m),
      shortcode: m.media_product_type === 'STORY' ? undefined : m.shortcode,
      timestamp: graphTime(m.timestamp),
      like_count: m.media_product_type === 'STORY' ? undefined : Math.round((m.like_count || 0) * ageFactor(m)),
      comments_count: m.media_product_type === 'STORY' ? undefined : m.comments_count || 0,
      is_comment_enabled: m.is_comment_enabled,
      is_shared_to_feed: m.media_product_type === 'REELS' ? m.share_to_feed !== false : undefined,
      username: state.username,
      owner: { id: state.userId },
      alt_text: m.alt_text,
      children: (mods, sub) => ({ data: m.children.map((c) => project(childNode(c, ctx), sub || [{ name: 'id' }], 'IGMedia')) }),
      comments: (mods, sub) => ({ data: topComments(m.id).slice(0, Number(mods.limit) || 25).map((c) => project(commentNode(c), sub || DEFAULT_COMMENT, 'IGComment')) }),
    };
  }

  function childNode(c, ctx) {
    return {
      id: c.id,
      media_type: c.media_type,
      media_url: c.url || fixtures(ctx, c.file),
      thumbnail_url: c.media_type === 'VIDEO' ? fixtures(ctx, 'f01.jpg') : undefined,
      timestamp: graphTime(c.timestamp),
      username: state.username,
    };
  }

  const DEFAULT_COMMENT = parseFields('id,text,timestamp');

  function topComments(mediaId) {
    return [...state.comments.values()].filter((c) => c.mediaId === mediaId && !c.parentId).sort((a, b) => b.timestamp - a.timestamp);
  }

  function repliesOf(commentId) {
    return [...state.comments.values()].filter((c) => c.parentId === commentId).sort((a, b) => a.timestamp - b.timestamp);
  }

  function commentNode(c) {
    const media = state.nodes.get(c.mediaId);
    return {
      id: c.id,
      text: c.text,
      timestamp: graphTime(c.timestamp),
      username: c.username,
      from: { id: c.fromId, username: c.username },
      like_count: c.like_count,
      hidden: c.hidden,
      parent_id: c.parentId || undefined,
      legacy_instagram_comment_id: undefined,
      media: { id: c.mediaId, media_product_type: media ? media.obj.media_product_type : 'FEED' },
      user: undefined,
      replies: (mods, sub) => ({ data: repliesOf(c.id).map((x) => project(commentNode(x), sub || DEFAULT_COMMENT, 'IGComment')) }),
    };
  }

  function messageNode(m) {
    return {
      id: m.id,
      created_time: graphTime(m.created_time),
      from: m.from,
      to: { data: m.to },
      message: m.message,
      attachments: m.attachments.length ? { data: m.attachments.map((a) => ({ ...a, image_data: a.image_data ? { ...a.image_data } : undefined })) } : undefined,
      is_unsupported: false,
      reply_to: undefined,
    };
  }

  function conversationNode(c) {
    return {
      id: c.id,
      updated_time: graphTime(c.messages[0] ? c.messages[0].created_time : t0),
      participants: { data: c.participants },
      messages: (mods, sub) => ({ data: c.messages.slice(0, Math.min(20, Number(mods.limit) || 20)).map((m) => project(messageNode(m), sub || parseFields('id,created_time'), 'Message')) }),
      message_count: c.messages.length,
    };
  }

  function containerNode(c) {
    const s = containerStatus(c);
    return { id: c.id, status_code: s, status: statusText(c, s) };
  }

  function userNode(ctx) {
    return {
      id: ctx.asApp ? state.appScopedId : state.userId,
      user_id: state.userId,
      ig_id: String(h32(`igid|${seed}`) * 7),
      username: state.username,
      name: state.name,
      account_type: 'BUSINESS',
      profile_picture_url: fixtures(ctx, 'avatar.jpg'),
      followers_count: state.followers,
      follows_count: state.follows,
      media_count: state.media.length,
      biography: state.biography,
      website: state.website,
      has_profile_pic: true,
      business_discovery: (mods, sub) => businessDiscovery(mods.username, sub, ctx),
      media: (mods, sub) => ({ data: state.media.slice(0, Number(mods.limit) || 25).map((m) => project(mediaNode(m, ctx), sub || [{ name: 'id' }], 'IGMedia')) }),
      stories: (mods, sub) => ({ data: liveStories().map((m) => project(mediaNode(m, ctx), sub || [{ name: 'id' }], 'IGMedia')) }),
    };
  }

  function pageNode() {
    return {
      id: state.pageId,
      name: state.name,
      category: 'Artist',
      access_token: 'page-token-1',
      instagram_business_account: { id: state.userId, username: state.username },
      connected_instagram_account: { id: state.userId },
    };
  }

  function liveStories() {
    return state.stories.filter((s) => nowMs() - s.timestamp < DAY).sort((a, b) => b.timestamp - a.timestamp);
  }

  function bdAccount(uname) {
    const acc = state.businessAccounts[uname];
    if (!acc) return null;
    const title = uname.split(/[._]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    return { name: title, biography: '', website: '', followers: 5000, follows: 300, theme: 'ceramics', ...acc };
  }

  function bdMedia(uname, ctx) {
    const acc = bdAccount(uname);
    const rr = mulberry32(h32(`bd|${uname}|${seed}`));
    const out = [];
    let t = t0 - rr() * 20 * HOUR;
    for (let i = 0; i < 30; i++) {
      t -= (1.4 + rr() * 2.6) * DAY;
      const roll = rr();
      const kind = roll < 0.4 ? 'IMAGE' : roll < 0.65 ? 'CAROUSEL_ALBUM' : 'REELS';
      const reach = acc.followers * (0.15 + rr() * 0.35) * (kind === 'REELS' ? 1.8 : 1);
      out.push({
        id: `179${String(h32(`bdm|${uname}|${i}`)).padStart(14, '0')}`,
        caption: `${acc.theme === 'coffee' ? 'This week on bar:' : 'From the studio:'} ${BODIES[Math.floor(rr() * BODIES.length)]} ${TAGS[Math.floor(rr() * TAGS.length)]} ${TAGS[Math.floor(rr() * TAGS.length)]}`,
        media_type: kind === 'REELS' ? 'VIDEO' : kind,
        media_product_type: kind === 'REELS' ? 'REELS' : 'FEED',
        media_url: kind === 'REELS' ? fixtures(ctx, 'clip.mp4') : fixtures(ctx, IMAGES[Math.floor(rr() * IMAGES.length)]),
        permalink: `https://www.instagram.com/p/${b64(`${uname}${i}`).slice(0, 11)}/`,
        timestamp: graphTime(t),
        like_count: Math.round(reach * (0.04 + rr() * 0.05)),
        comments_count: Math.round(reach * (0.002 + rr() * 0.006)),
      });
    }
    return out;
  }

  function businessDiscovery(rawName, sub, ctx) {
    const uname = String(rawName || '').toLowerCase();
    const acc = bdAccount(uname);
    if (!acc) {
      throw new GraphFail(100, '(#100) Invalid user id', { subcode: 2207013, userTitle: 'Cannot find User', userMsg: `The user with username: ${rawName} cannot be found.` });
    }
    const node = {
      id: `178414${String(h32(`bd|${uname}`)).padStart(11, '0')}`,
      ig_id: String(h32(`bdig|${uname}`)),
      username: uname,
      name: acc.name,
      biography: acc.biography,
      website: acc.website,
      profile_picture_url: fixtures(ctx, 'avatar.jpg'),
      followers_count: acc.followers,
      follows_count: acc.follows,
      media_count: 30,
      media: (mods, msub) => ({
        data: bdMedia(uname, ctx).slice(0, Math.min(100, Number(mods.limit) || 25)).map((m) => (msub ? pick(m, msub) : { id: m.id })),
        paging: { cursors: { after: 'QVFIUm1vY2tCRA' } },
      }),
    };
    return project(node, sub || [{ name: 'id' }], 'IGUser');
  }

  // ----- containers -----------------------------------------------------------------------------
  function containerStatus(c) {
    if (c.forceStatus) return c.forceStatus;
    if (c.mediaId) return 'PUBLISHED';
    if (c.error) return 'ERROR';
    if (nowMs() - c.createdData > DAY) return 'EXPIRED';
    if (c.readyAt && Date.now() >= c.readyAt) return 'FINISHED';
    return 'IN_PROGRESS';
  }

  function statusText(c, s) {
    if (s === 'FINISHED') return 'Finished: Media has been uploaded and it is ready to be published.';
    if (s === 'PUBLISHED') return 'Published: Media has been published.';
    if (s === 'EXPIRED') return 'Expired: The container was not published within 24 hours.';
    if (s === 'ERROR') return c.error;
    return c.uploadPending ? 'In Progress: Waiting for the video upload.' : 'In Progress: Media is still being processed.';
  }

  async function checkUrl(kind, url, { aspect } = {}) {
    if (!validateMediaUrls) return null;
    let res;
    try {
      res = await doFetch(url, { signal: AbortSignal.timeout(15000) });
    } catch {
      return "Error: Media download has failed. The media URI doesn't meet our requirements. (2207052)";
    }
    if (!res.ok) return `Error: Media download has failed. The media URI doesn't meet our requirements (HTTP ${res.status}). (2207052)`;
    const buf = Buffer.from(await res.arrayBuffer());
    if (kind === 'image') {
      if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 'Error: Unsupported image format. Only JPEG images are supported. (36001, 2207005)';
      if (buf.length > 8 * 1024 * 1024) return 'Error: The image is too large. (36000, 2207004)';
      if (aspect) {
        const size = jpegSize(buf);
        if (size && size.height) {
          const ratio = size.width / size.height;
          if (ratio < 0.8 - 0.01 || ratio > 1.91 + 0.01) return `Error: The aspect ratio ${size.width}x${size.height} is not supported. (36003, 2207009)`;
        }
      }
    } else if (buf.length < 12 || buf.toString('latin1', 4, 8) !== 'ftyp') {
      return 'Error: The video format is not supported. Please check the spec for supported video formats. (2207026)';
    }
    return null;
  }

  async function processContainer(c) {
    if (c.uploadPending || c.mediaType === 'CAROUSEL') return;
    const checks = [];
    const p = c.params;
    const feedAspect = c.mediaType === 'IMAGE' || (c.isCarouselItem && !p.video_url);
    if (p.image_url) checks.push(['image', p.image_url, { aspect: feedAspect }]);
    if (p.video_url) checks.push(['video', p.video_url]);
    if (p.cover_url) checks.push(['image', p.cover_url]);
    for (const [kind, url, opts] of checks) {
      const problem = await checkUrl(kind, url, opts);
      if (problem) {
        c.error = problem;
        return;
      }
    }
    c.readyAt = Date.now() + (c.kind === 'video' ? videoProcessingMs : imageProcessingMs);
  }

  function parseJson(v, what) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      throw new GraphFail(100, `(#100) Param ${what} must be a JSON array or object`);
    }
  }

  function createContainer(p) {
    const caption = p.caption || '';
    const isItem = String(p.is_carousel_item) === 'true';
    let mt = String(p.media_type || '').toUpperCase();
    if (!mt && p.image_url) mt = 'IMAGE';
    const resumable = p.upload_type === 'resumable';
    if (!['IMAGE', 'VIDEO', 'REELS', 'STORIES', 'CAROUSEL'].includes(mt)) {
      throw new GraphFail(100, '(#100) The media type is not supported. Pass image_url, or media_type=REELS|STORIES|CAROUSEL|VIDEO.', { subcode: 2207023 });
    }
    if (caption.length > 2200) throw new GraphFail(100, '(#100) The caption is too long', { subcode: 2207010, userMsg: 'The caption exceeds 2,200 characters.' });
    if (mt === 'IMAGE' && !p.image_url) throw new GraphFail(100, '(#100) The parameter image_url is required.');
    if (mt === 'VIDEO' && !isItem) {
      throw new GraphFail(100, '(#100) The VIDEO media type is no longer supported for feed posts. Use media_type=REELS.', { subcode: 2207023 });
    }
    if (['VIDEO', 'REELS'].includes(mt) && !p.video_url && !resumable) throw new GraphFail(100, '(#100) The parameter video_url is required.');
    if (mt === 'STORIES' && !p.image_url && !p.video_url && !resumable) throw new GraphFail(100, '(#100) The parameter image_url or video_url is required.');
    if (isItem && (mt === 'REELS' || mt === 'STORIES' || mt === 'CAROUSEL')) throw new GraphFail(100, `(#100) ${mt} cannot be a carousel item.`);
    if (p.alt_text !== undefined && !(mt === 'IMAGE' || (isItem && p.image_url))) {
      throw new GraphFail(100, '(#100) alt_text is only supported for image posts and carousel images.');
    }
    if (p.alt_text && String(p.alt_text).length > 1000) throw new GraphFail(100, '(#100) alt_text is limited to 1000 characters.');
    const collabs = parseJson(p.collaborators, 'collaborators');
    if (collabs) {
      if (!Array.isArray(collabs)) throw new GraphFail(100, '(#100) Param collaborators must be an array');
      if (mt === 'STORIES' || isItem) throw new GraphFail(100, '(#100) Collaborators are not supported for stories or carousel items.');
      if (collabs.length > 3) throw new GraphFail(100, '(#100) A post can have at most 3 collaborators.');
      if (collabs.some((u) => typeof u !== 'string' || u.startsWith('@') || !/^[A-Za-z0-9._]{1,30}$/.test(u))) {
        throw new GraphFail(100, '(#100) Invalid collaborator username', { subcode: 2207018, userMsg: 'One or more collaborator usernames are invalid. Do not include @.' });
      }
    }
    const tags = parseJson(p.user_tags, 'user_tags');
    if (tags) {
      if (!Array.isArray(tags)) throw new GraphFail(100, '(#100) Param user_tags must be an array');
      tags.forEach((t, i) => {
        if (!t || typeof t.username !== 'string') throw new GraphFail(100, `(#100) Param user_tags[${i}][username] is required`);
        const needsXY = mt === 'IMAGE' || (isItem && p.image_url);
        if (needsXY && (typeof t.x !== 'number' || typeof t.y !== 'number' || t.x < 0 || t.x > 1 || t.y < 0 || t.y > 1)) {
          throw new GraphFail(100, `(#100) Param user_tags[${i}][x] and [y] must be numbers between 0 and 1`);
        }
      });
    }
    if (p.share_to_feed !== undefined && mt !== 'REELS') throw new GraphFail(100, '(#100) share_to_feed is only supported for reels.');
    if (p.is_ai_generated !== undefined && (isItem || mt === 'STORIES')) throw new GraphFail(100, '(#100) is_ai_generated is not supported for stories or carousel items.');
    if (p.trial_params !== undefined) {
      const tp = parseJson(p.trial_params, 'trial_params');
      if (mt !== 'REELS') throw new GraphFail(100, '(#100) trial_params is only supported for reels.');
      if (!tp || !['MANUAL', 'SS_PERFORMANCE'].includes(tp.graduation_strategy)) throw new GraphFail(100, '(#100) Param trial_params[graduation_strategy] must be MANUAL or SS_PERFORMANCE');
    }
    let children = null;
    if (mt === 'CAROUSEL') {
      const raw = parseJson(String(p.children || '').trim().startsWith('[') ? p.children : null, 'children') || String(p.children || '').split(',').map((s) => s.trim()).filter(Boolean);
      children = raw.map(String);
      if (children.length < 2 || children.length > 10) {
        throw new GraphFail(100, '(#100) The carousel is invalid. A carousel needs between 2 and 10 items.', { subcode: 2207028 });
      }
      for (const id of children) {
        const ch = state.containers.get(id);
        if (!ch || !ch.isCarouselItem) throw new GraphFail(100, `(#100) Invalid carousel item ${id}`, { subcode: 2207028 });
        const s = containerStatus(ch);
        if (s !== 'FINISHED') throw new GraphFail(9007, 'Media ID is not available', { subcode: 2207027, userMsg: 'A carousel item is not ready. Wait until every item is FINISHED.' });
      }
    }
    const isVideo = mt === 'REELS' || mt === 'VIDEO' || (mt === 'STORIES' && (p.video_url || resumable));
    const c = {
      id: nextId('178'),
      mediaType: mt,
      isCarouselItem: isItem,
      params: { ...p, access_token: undefined },
      kind: mt === 'CAROUSEL' ? 'carousel' : isVideo ? 'video' : 'image',
      createdData: nowMs(),
      createdReal: Date.now(),
      readyAt: mt === 'CAROUSEL' ? Date.now() + Math.round(imageProcessingMs / 2) : null,
      uploadPending: resumable,
      children,
      error: null,
      mediaId: null,
    };
    state.containers.set(c.id, reg('container', c));
    processContainer(c).catch((e) => {
      c.error = `Error: ${e.message}`;
    });
    return resumable ? { id: c.id, uri: `${RUPLOAD}/v26.0/${c.id}` } : { id: c.id };
  }

  function publish(p) {
    const c = state.containers.get(String(p.creation_id || ''));
    if (!c) throw new GraphFail(24, 'The media with the given creation_id cannot be found.', { subcode: 2207006 });
    if (c.isCarouselItem) throw new GraphFail(100, '(#100) Carousel items cannot be published on their own.');
    const s = containerStatus(c);
    if (s === 'PUBLISHED') throw new GraphFail(100, '(#100) This media has already been published.', { subcode: 2207006 });
    if (s === 'EXPIRED') throw new GraphFail(24, 'The media container has expired.', { subcode: 2207008 });
    if (s === 'ERROR') throw new GraphFail(-1, 'Create media failed', { subcode: 2207032, userMsg: c.error });
    if (s !== 'FINISHED') throw new GraphFail(9007, 'Media ID is not available', { subcode: 2207027, userMsg: 'The media is not ready for publishing, please wait for a moment.' });
    const dayAgo = nowMs() - DAY;
    if (state.publishLog.filter((t) => t > dayAgo).length >= state.publishLimit) {
      throw new GraphFail(9, 'Application request limit reached', { subcode: 2207042, userMsg: 'The maximum number of posts that were published has been reached.' });
    }
    const pp = c.params;
    const mt = c.mediaType;
    const isStory = mt === 'STORIES';
    const isVideo = c.kind === 'video';
    const m = reg('media', {
      id: nextId('179'),
      caption: isStory ? '' : pp.caption || '',
      media_type: mt === 'CAROUSEL' ? 'CAROUSEL_ALBUM' : isVideo ? 'VIDEO' : 'IMAGE',
      media_product_type: isStory ? 'STORY' : mt === 'REELS' ? 'REELS' : 'FEED',
      url: pp.image_url || pp.video_url || null,
      file: pp.image_url || pp.video_url ? null : isVideo ? 'clip.mp4' : 'f01.jpg',
      thumbUrl: pp.cover_url || null,
      thumbFile: isVideo ? 'f05.jpg' : null,
      timestamp: nowMs(),
      shortcode: shortcode(),
      is_comment_enabled: !isStory,
      share_to_feed: pp.share_to_feed === undefined ? true : String(pp.share_to_feed) === 'true',
      alt_text: pp.alt_text,
      collaborators: parseJson(pp.collaborators, 'collaborators') || [],
      user_tags: parseJson(pp.user_tags, 'user_tags') || [],
      location_id: pp.location_id || null,
      children: (c.children || []).map((cid) => {
        const ch = state.containers.get(cid);
        return reg('child', { id: nextId('179'), media_type: ch.kind === 'video' ? 'VIDEO' : 'IMAGE', url: ch.params.image_url || ch.params.video_url || null, file: ch.params.image_url ? null : 'clip.mp4', timestamp: nowMs() });
      }),
      comments_count: 0,
      like_count: 0,
      fromApi: true,
      creationId: c.id,
    });
    const kind = m.media_product_type === 'REELS' ? 'REELS' : m.media_type;
    m.ins = isStory
      ? { reach: 0, views: 0, replies: 0, shares: 0, follows: 0, profile_visits: 0, reposts: 0, total_interactions: 0, navigation: { TAP_FORWARD: 0, TAP_BACK: 0, TAP_EXIT: 0, SWIPE_FORWARD: 0 } }
      : mediaInsightsBase(kind);
    if (!isStory) {
      m.like_count = m.ins.likes;
      m.ins.comments = 0;
      m.ins.total_interactions = m.ins.likes + m.ins.shares + m.ins.saved;
    }
    if (isStory) state.stories.unshift(m);
    else state.media.unshift(m);
    c.mediaId = m.id;
    state.publishCount++;
    state.publishLog.push(nowMs());
    return { id: m.id };
  }

  // ----- insights --------------------------------------------------------------------------------
  function accountInsights(p, ctx) {
    const metrics = String(p.metric || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!metrics.length) throw new GraphFail(100, '(#100) The parameter metric is required.');
    metrics.forEach((m, i) => {
      if (!ACCOUNT_METRICS[m]) throw new GraphFail(100, `(#100) metric[${i}] must be one of the following values: ${Object.keys(ACCOUNT_METRICS).join(', ')}`);
    });
    const type = p.metric_type || 'time_series';
    const needTotal = metrics.filter((m) => !ACCOUNT_METRICS[m].types.includes(type));
    if (needTotal.length) {
      throw new GraphFail(100, `(#100) The following metrics (${needTotal.join(', ')}) should be specified with parameter metric_type=${type === 'total_value' ? 'time_series' : 'total_value'}`);
    }
    const period = p.period || 'day';
    for (const m of metrics) if (!ACCOUNT_METRICS[m].periods.includes(period)) throw new GraphFail(100, `(#100) Incompatible period (${period}) with metric (${m})`);
    const breakdown = p.breakdown ? String(p.breakdown) : null;
    if (breakdown) {
      if (type !== 'total_value') throw new GraphFail(100, '(#100) Breakdowns are only supported with metric_type=total_value');
      for (const m of metrics) {
        if (!ACCOUNT_METRICS[m].breakdowns.includes(breakdown)) throw new GraphFail(100, `(#100) Incompatible breakdowns (${breakdown}) with metric (${m})`);
      }
    }
    const small = state.followers < 100;
    for (const m of metrics) {
      if (small && ['follower_count', 'follows_and_unfollows', 'online_followers'].includes(m)) {
        throw new GraphFail(100, `(#100) The ${m} metric is not available for accounts with fewer than 100 followers`);
      }
    }
    const id = (m) => `${state.userId}/insights/${m}/${period}`;
    const meta = (m) => ({ name: m, period, title: m.replace(/_/g, ' '), description: `Mock ${m}`, id: id(m) });

    if (metrics.some((m) => ACCOUNT_METRICS[m].demo)) {
      const tf = p.timeframe;
      if (!tf) throw new GraphFail(100, '(#100) Demographic metrics require the timeframe parameter.');
      if (!breakdown) throw new GraphFail(100, '(#100) Demographic metrics require a breakdown.');
      return {
        data: metrics.map((m) => {
          if (m !== 'follower_demographics' && !['this_week', 'this_month'].includes(tf)) {
            throw new GraphFail(100, `(#100) Timeframe ${tf} is not supported for ${m}. Use this_week or this_month.`);
          }
          if (small) throw new GraphFail(100, '(#100) Not enough followers to show demographics.');
          const total = m === 'follower_demographics' ? state.followers : Math.round(state.followers * (tf === 'this_week' ? 0.09 : 0.21));
          const results = DEMOGRAPHICS[breakdown].map(([key, share]) => ({
            dimension_values: [key],
            value: Math.max(1, Math.round(total * share * (0.92 + 0.16 * noise(m, key, tf)))),
          }));
          return { ...meta(m), period: 'lifetime', total_value: { breakdowns: [{ dimension_keys: [breakdown], results: results.slice(0, 45) }] } };
        }),
      };
    }

    const nowS = Math.floor(nowMs() / 1000);
    const until = p.until ? Number(p.until) : nowS;
    const since = p.since ? Number(p.since) : until - 86400;
    if (!Number.isFinite(since) || !Number.isFinite(until) || until < since) throw new GraphFail(100, '(#100) The since and until parameters are not valid.');
    if (since > nowS + 60) throw new GraphFail(100, '(#100) The since param is not valid. It cannot be in the future.');
    if (until - since > 30 * 86400 + 3600) throw new GraphFail(100, '(#100) There cannot be more than 30 days (2592000 s) between since and until');
    const oldest = nowS - 90 * 86400;
    if (since < oldest && !metrics.includes('online_followers')) {
      throw new GraphFail(100, '(#100) The since param is not valid. Insights are only available for the last 90 days.');
    }

    if (metrics.includes('online_followers')) {
      const values = [];
      const firstKey = dayKey(new Date(Math.max(since, nowS - 30 * 86400) * 1000), PT);
      const lastKey = dayKey(new Date((Math.min(until, nowS) - 1) * 1000), PT);
      const todayPT = dayKey(new Date(nowMs()), PT);
      for (let k = firstKey; k <= lastKey && k < todayPT; k = addDaysKey(k, 1)) {
        values.push({ value: onlineMap(k), end_time: graphTime(startOfDay(addDaysKey(k, 1), PT).getTime()) });
      }
      return { data: [{ ...meta('online_followers'), period: 'lifetime', values }] };
    }

    if (type === 'time_series') {
      const firstKey = dayKey(new Date(since * 1000), PT);
      const lastKey = dayKey(new Date((until - 1) * 1000), PT);
      const todayPT = dayKey(new Date(nowMs()), PT);
      return {
        data: metrics.map((m) => {
          const values = [];
          for (let k = firstKey; k <= lastKey; k = addDaysKey(k, 1)) {
            const start = startOfDay(k, PT).getTime();
            if (start > nowMs()) break;
            if (m === 'follower_count' && (k >= todayPT || start < nowMs() - 31 * DAY)) continue;
            const v = dayValues(k);
            const frac = Math.min(1, (nowMs() - start) / DAY);
            values.push({ value: Math.round((m === 'follower_count' ? v.follows : v.reach) * frac), end_time: graphTime(startOfDay(addDaysKey(k, 1), PT).getTime()) });
          }
          return { ...meta(m), values };
        }),
      };
    }

    const totals = sumWindow(since, until);
    return {
      data: metrics.map((m) => {
        if (m === 'follows_and_unfollows') {
          const tv = { value: totals.follows + totals.unfollows };
          if (breakdown === 'follow_type') {
            tv.breakdowns = [{ dimension_keys: ['follow_type'], results: [{ dimension_values: ['FOLLOWER'], value: totals.follows }, { dimension_values: ['NON_FOLLOWER'], value: totals.unfollows }] }];
          }
          return { ...meta(m), total_value: tv };
        }
        const value = totals[m] ?? 0;
        const tv = { value };
        if (breakdown === 'media_product_type') {
          const post = Math.round(value * 0.46);
          const reel = Math.round(value * 0.38);
          const story = Math.round(value * 0.11);
          tv.breakdowns = [{ dimension_keys: ['media_product_type'], results: [['POST', post], ['REEL', reel], ['STORY', story], ['CAROUSEL_CONTAINER', value - post - reel - story]].map(([k, v]) => ({ dimension_values: [k], value: v })) }];
        } else if (breakdown === 'follow_type' || breakdown === 'follower_type') {
          const f = Math.round(value * 0.62);
          tv.breakdowns = [{ dimension_keys: [breakdown], results: [{ dimension_values: ['FOLLOWER'], value: f }, { dimension_values: ['NON_FOLLOWER'], value: value - f }] }];
        } else if (breakdown === 'contact_button_type') {
          tv.breakdowns = [{ dimension_keys: [breakdown], results: [{ dimension_values: ['EMAIL'], value: Math.ceil(value / 2) }, { dimension_values: ['DIRECTION'], value: Math.floor(value / 2) }] }];
        }
        return { ...meta(m), total_value: tv };
      }),
    };
  }

  function mediaInsights(m, p) {
    const metrics = String(p.metric || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!metrics.length) throw new GraphFail(100, '(#100) The parameter metric is required.');
    const kind = m.media_product_type === 'STORY' ? 'STORY' : m.media_product_type === 'REELS' ? 'REELS' : m.media_type === 'CAROUSEL_ALBUM' ? 'CAROUSEL' : 'FEED';
    metrics.forEach((x, i) => {
      if (!ALL_MEDIA_METRICS.includes(x)) throw new GraphFail(100, `(#100) metric[${i}] must be one of the following values: ${ALL_MEDIA_METRICS.filter((y) => y !== 'impressions').join(', ')}`);
    });
    for (const x of metrics) {
      if (!MEDIA_METRICS[kind].includes(x)) throw new GraphFail(100, `(#100) The Media Insights API does not support the ${x} metric for this media product type.`);
    }
    if (kind === 'STORY' && m.ins.reach < 5 && !m.forceInsights) throw new GraphFail(10, '(#10) Not enough viewers for the media to show insights', { type: 'OAuthException' });
    const breakdown = p.breakdown ? String(p.breakdown) : null;
    const f = ageFactor(m);
    return {
      data: metrics.map((x) => {
        const base = { name: x, period: 'lifetime', title: x.replace(/_/g, ' '), description: `Mock ${x}`, id: `${m.id}/insights/${x}/lifetime` };
        if (x === 'navigation') {
          const nav = m.ins.navigation || {};
          const total = Object.values(nav).reduce((a, b) => a + b, 0);
          if (breakdown === 'story_navigation_action_type') {
            return { ...base, total_value: { value: total, breakdowns: [{ dimension_keys: ['story_navigation_action_type'], results: Object.entries(nav).map(([k, v]) => ({ dimension_values: [k], value: v })) }] } };
          }
          return { ...base, values: [{ value: total }] };
        }
        if (x === 'profile_activity') return { ...base, values: [{ value: Math.round((m.ins.profile_visits || 0) * 0.3) }] };
        let v = m.ins[x] ?? 0;
        if (x === 'comments') v = m.comments_count || m.ins.comments || 0;
        else if (!['ig_reels_avg_watch_time', 'reels_skip_rate'].includes(x)) v = Math.round(v * f);
        return { ...base, values: [{ value: v }] };
      }),
    };
  }

  // ----- messaging ----------------------------------------------------------------------------
  function sendMessage(p) {
    const recipient = parseJson(p.recipient, 'recipient');
    const message = parseJson(p.message, 'message');
    if (!recipient || (!recipient.id && !recipient.comment_id)) throw new GraphFail(100, '(#100) The parameter recipient is required');
    if (!message || (!message.text && !message.attachment)) throw new GraphFail(100, '(#100) The parameter message must include text or an attachment');
    if (message.text && String(message.text).length > 1000) throw new GraphFail(100, '(#100) Message text is limited to 1000 characters.');
    if (state.dmMode === 'disabled') {
      throw new GraphFail(10, '(#10) The account owner has disabled access to Instagram Direct Messages.', { userMsg: 'The account owner has disabled access to Instagram Direct Messages.' });
    }
    if (state.dmMode === 'advanced_access') {
      throw new GraphFail(200, '(#200) App does not have Advanced Access to instagram_manage_messages permission, and recipient user does not have role on app', { type: 'OAuthException' });
    }
    const own = { id: state.userId, username: state.username };
    let conv;
    let other;
    if (recipient.comment_id) {
      const c = state.comments.get(String(recipient.comment_id));
      if (!c) throw new GraphFail(100, '(#100) Invalid comment_id. The comment may have been deleted.', { subcode: 33 });
      if (state.privateReplies.has(c.id)) throw new GraphFail(100, '(#100) A private reply was already sent for this comment.', { userMsg: 'You already sent a private reply to this comment.' });
      if (nowMs() - c.timestamp > 7 * DAY) throw new GraphFail(10, '(#10) This message is sent outside of allowed window.', { subcode: 2534022 });
      other = { id: c.fromId, username: c.username };
      conv = state.conversations.find((x) => x.participants.some((pp) => pp.id === other.id));
      if (!conv) {
        conv = reg('conversation', { id: `aWdfZAG06${b64(`conv:${seed}:${other.username}:${c.id}`)}`, participants: [other, own], messages: [], viaPrivateReply: true });
        state.conversations.push(conv);
      }
    } else {
      conv = state.conversations.find((x) => x.participants.some((pp) => pp.id === String(recipient.id)));
      if (!conv) throw new GraphFail(100, '(#100) No matching user found', { subcode: 2018001 });
      other = conv.participants.find((pp) => pp.id !== state.userId);
      const lastIn = conv.messages.find((mm) => mm.from.id === other.id);
      if (!lastIn || nowMs() - lastIn.created_time > DAY) throw new GraphFail(10, '(#10) This message is sent outside of allowed window.', { subcode: 2534022 });
    }
    const att = message.attachment ? [{ id: `att_${counter}`, mime_type: 'image/jpeg', image_data: { url: message.attachment.payload && message.attachment.payload.url } }] : [];
    const msg = reg('message', { id: `aWdfZAG1faXRlbToxOklHTWVzc2FnZAWQ${b64(`sent:${++counter}:${seed}`)}`, created_time: nowMs(), from: own, to: [other], message: message.text || '', attachments: att });
    conv.messages.unshift(msg);
    if (recipient.comment_id) state.privateReplies.set(String(recipient.comment_id), msg.id);
    state.sentMessages.push({ id: msg.id, recipientId: other.id, commentId: recipient.comment_id || null, text: message.text || '', attachment: message.attachment || null, at: new Date(nowMs()).toISOString() });
    return { recipient_id: other.id, message_id: msg.id };
  }

  // ----- request plumbing -------------------------------------------------------------------------
  function send(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Expose-Headers': 'X-Business-Use-Case-Usage',
      'X-Business-Use-Case-Usage': JSON.stringify({ [state.userId]: [{ type: 'instagram', call_count: Math.min(100, Math.round(state.requests.length / 50)), total_cputime: 1, total_time: 1, estimated_time_to_regain_access: 0 }] }),
    });
    res.end(body === null ? '' : JSON.stringify(body));
    return true;
  }

  function sendError(res, e) {
    const error = { message: e.message, type: e.type || 'OAuthException', code: e.code, fbtrace_id: `A${h32(e.message + counter).toString(16)}mock` };
    if (e.subcode) error.error_subcode = e.subcode;
    if (e.userTitle) error.error_user_title = e.userTitle;
    if (e.userMsg) error.error_user_msg = e.userMsg;
    return send(res, e.status || 400, { error });
  }

  function bodyParams(req, body) {
    if (!body) return {};
    if (Buffer.isBuffer(body) || typeof body === 'string') {
      const type = req.headers['content-type'] || '';
      if (type.includes('x-www-form-urlencoded') || typeof body === 'string') return Object.fromEntries(new URLSearchParams(body.toString('utf8')));
      if (type.includes('json')) {
        try {
          return JSON.parse(body.toString('utf8'));
        } catch {
          return {};
        }
      }
      return {};
    }
    return typeof body === 'object' ? body : {};
  }

  function checkToken(token) {
    if (!token) throw new GraphFail(104, 'An access token is required to request this resource.');
    if (token === 'expired-token') {
      throw new GraphFail(190, 'Error validating access token: Session has expired on Friday, 09-Oct-26 10:00:00 PDT.', { subcode: 463 });
    }
    if (token === 'invalid-token') throw new GraphFail(190, 'Invalid OAuth access token - Cannot parse access token', { subcode: 467 });
  }

  function applyFault(method, pathname, params, res) {
    for (let i = 0; i < state.faults.length; i++) {
      const f = state.faults[i];
      if (f.method && f.method.toUpperCase() !== method) continue;
      const match = f.path instanceof RegExp ? f.path.test(pathname) : pathname.includes(f.path || '');
      if (!match) continue;
      if (f.when && !f.when(params)) continue;
      if (f.times !== undefined) {
        f.times--;
        if (f.times <= 0) state.faults.splice(i, 1);
      }
      if (f.destroy) {
        res.destroy();
        return true;
      }
      const e = f.error || {};
      return sendError(res, new GraphFail(e.code ?? 1, e.message || 'An unknown error occurred', { subcode: e.subcode, status: e.status || 500, type: e.type }));
    }
    return false;
  }

  function paged(list, p, ctx, mapFn, max = 100) {
    const limit = Math.max(1, Math.min(max, Number(p.limit) || 25));
    const offset = p.after ? Number(Buffer.from(String(p.after), 'base64').toString('utf8').replace(/^off:/, '')) || 0 : 0;
    const slice = list.slice(offset, offset + limit);
    const out = { data: slice.map(mapFn) };
    if (list.length) {
      out.paging = { cursors: { before: Buffer.from(`off:${offset}`).toString('base64'), after: Buffer.from(`off:${offset + slice.length}`).toString('base64') } };
      if (offset + slice.length < list.length) {
        const u = new URLSearchParams();
        for (const [k, v] of Object.entries(p)) if (v !== undefined && k !== 'after') u.set(k, v);
        u.set('limit', String(limit));
        u.set('after', out.paging.cursors.after);
        out.paging.next = `${ctx.origin}${ctx.prefix}${ctx.pathname}?${u.toString()}`;
      }
    }
    return out;
  }

  /** Handle a request whose mount prefix was stripped. `path` may include the query string. */
  async function handle(req, res, path, body, url) {
    const method = req.method.toUpperCase();
    if (method === 'OPTIONS') return send(res, 204, null);
    const u = new URL(path, 'http://mock.local');
    const pathname = u.pathname;
    const params = { ...Object.fromEntries(u.searchParams), ...bodyParams(req, body) };
    const fullPath = url ? url.pathname : pathname;
    const ctx = {
      origin: `http://${req.headers.host || 'localhost'}`,
      prefix: fullPath.endsWith(pathname) ? fullPath.slice(0, fullPath.length - pathname.length) : '',
      pathname,
      fixtures: typeof fixturesBase === 'function' ? fixturesBase(req) : fixturesBase || `http://${req.headers.host || 'localhost'}${fixturesPath}`,
      asApp: false,
    };
    state.requests.push({ method, path: pathname, params: { ...params, access_token: undefined } });
    if (state.requests.length > 1000) state.requests.splice(0, 200);
    if (applyFault(method, pathname, params, res)) return true;
    try {
      const segs = pathname.split('/').filter(Boolean);
      if (/^v\d+\.\d+$/.test(segs[0] || '')) segs.shift();
      const token = params.access_token;
      checkToken(token);
      delete params.access_token;
      const result = await route(method, segs, params, ctx, token);
      return send(res, 200, result);
    } catch (e) {
      if (e instanceof GraphFail) return sendError(res, e);
      return sendError(res, new GraphFail(2, `An unexpected error has occurred. Please retry your request later. (${e.message})`, { status: 500 }));
    }
  }

  function resolve(id, token) {
    if (id === 'me') return token && token.startsWith('page-') ? { type: 'page' } : { type: 'user', asApp: true };
    if (id === state.userId) return { type: 'user' };
    if (id === state.appScopedId) return { type: 'user', asApp: true };
    if (id === state.pageId) return { type: 'page' };
    const n = state.nodes.get(id);
    if (n) return n;
    for (const [name, hid] of state.hashtags) if (hid === id) return { type: 'hashtag', obj: { id, name } };
    return null;
  }

  async function route(method, segs, p, ctx, token) {
    const [first, edge, extra] = segs;
    if (!first) throw new GraphFail(100, '(#100) Unsupported request');

    if (first === 'refresh_access_token') {
      if (p.grant_type !== 'ig_refresh_token') throw new GraphFail(100, '(#100) grant_type must be ig_refresh_token');
      const fresh = `IGAAmock${h32(`${token}|${state.tokens.refreshed.length}`).toString(36)}refreshed${state.tokens.refreshed.length + 1}`;
      state.tokens.refreshed.push(fresh);
      state.tokens.lastRefreshedFrom = token;
      return { access_token: fresh, token_type: 'bearer', expires_in: 5184000, permissions: 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_messages,instagram_business_manage_insights' };
    }
    if (first === 'access_token') {
      return { access_token: `IGAAmocklong${h32(String(token)).toString(36)}`, token_type: 'bearer', expires_in: 5184000 };
    }
    if (first === 'debug_token') {
      // Access Token Debugger. Page tokens never expire unless a test sets state.tokenExpiry[token]
      // (unix seconds, 0 = never); other tokens act like 60-day user tokens.
      const input = String(p.input_token || '');
      if (!input) throw new GraphFail(100, '(#100) The parameter input_token is required');
      const isPage = input.startsWith('page-');
      const exp = input in state.tokenExpiry ? Number(state.tokenExpiry[input]) || 0 : isPage ? 0 : Math.floor(nowMs() / 1000) + 60 * 86400;
      return {
        data: {
          app_id: '1234567890',
          type: isPage ? 'PAGE' : 'USER',
          application: 'Postpilot',
          data_access_expires_at: Math.floor(nowMs() / 1000) + 90 * 86400,
          expires_at: exp,
          is_valid: true,
          issued_at: Math.floor(t0 / 1000),
          ...(isPage ? { profile_id: state.pageId } : {}),
          scopes: ['pages_show_list', 'pages_read_engagement', 'business_management', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights', 'instagram_manage_messages'],
          user_id: state.appScopedId,
        },
      };
    }
    if (first === 'ig_hashtag_search') {
      const q = String(p.q || '').replace(/^#/, '').toLowerCase();
      if (!q || !/^[\p{L}\p{N}_]+$/u.test(q)) throw new GraphFail(100, '(#100) Invalid hashtag name');
      if (!state.hashtags.has(q)) state.hashtags.set(q, `178412${String(h32(`tag|${q}`)).padStart(11, '0')}`);
      return { data: [{ id: state.hashtags.get(q) }] };
    }
    if (first === 'me' && edge === 'accounts') {
      if (token.startsWith('page-')) throw new GraphFail(100, '(#100) Tried accessing nonexisting field (accounts) on node type (Page)');
      const pages = [
        { id: `1040${String(h32(`page2|${seed}`)).padStart(11, '0')}`, name: 'Side Project', access_token: 'page-token-2', category: 'Product/service', instagram_business_account: undefined },
        pageNode(),
      ];
      const spec = parseFields(p.fields || 'id,name');
      return paged(pages, p, ctx, (pg) => project(pg, spec, 'Page'));
    }

    const target = resolve(first, token);
    if (!target) throw new GraphFail(100, `(#100) Unsupported get request. Object with ID '${first}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`, { subcode: 33 });
    if (target.asApp) ctx.asApp = true;
    const t = target.type;

    // --- account (IG user) ---
    if (t === 'user' || t === 'page') {
      if (!edge) {
        if (method !== 'GET') throw new GraphFail(100, '(#100) Unsupported post request.');
        if (t === 'page') return project(pageNode(), parseFields(p.fields || 'id,name'), 'Page');
        return project(userNode(ctx), parseFields(p.fields || 'id'), 'IGUser');
      }
      if (edge === 'messages' && method === 'POST') return sendMessage(p);
      if (edge === 'conversations' && method === 'GET') {
        if (t === 'page' && p.platform !== 'instagram') throw new GraphFail(100, '(#100) The platform parameter is required (platform=instagram).');
        let list = [...state.conversations].sort((a, b) => (b.messages[0]?.created_time || 0) - (a.messages[0]?.created_time || 0));
        if (p.user_id) list = list.filter((c) => c.participants.some((pp) => pp.id === p.user_id));
        const spec = parseFields(p.fields || 'id,updated_time');
        return paged(list, p, ctx, (c) => project(conversationNode(c), spec, 'Conversation'));
      }
      if (t === 'page') throw new GraphFail(100, `(#100) Tried accessing nonexisting field (${edge}) on node type (Page)`);
      if (edge === 'media' && method === 'POST') return createContainer(p);
      if (edge === 'media' && method === 'GET') {
        const spec = parseFields(p.fields || 'id');
        return paged(state.media, p, ctx, (m) => project(mediaNode(m, ctx), spec, 'IGMedia'));
      }
      if (edge === 'media_publish' && method === 'POST') return publish(p);
      if (edge === 'stories' && method === 'GET') {
        const spec = parseFields(p.fields || 'id');
        return paged(liveStories(), p, ctx, (m) => project(mediaNode(m, ctx), spec, 'IGMedia'));
      }
      if (edge === 'tags' && method === 'GET') {
        const spec = parseFields(p.fields || 'id');
        const tagged = COMMENTERS.slice(0, 5).map((uname, i) => ({
          id: `179${String(h32(`tag|${uname}`)).padStart(14, '0')}`,
          caption: `Thank you @${state.username} for this beauty ${EMOJI[i % EMOJI.length]}`,
          media_type: 'IMAGE',
          media_url: fixtures(ctx, IMAGES[i]),
          permalink: `https://www.instagram.com/p/${b64(`tag${uname}`).slice(0, 11)}/`,
          timestamp: graphTime(t0 - (i * 3 + 1) * DAY),
          username: uname,
          like_count: 40 + i * 13,
          comments_count: 2 + i,
        }));
        return paged(tagged, p, ctx, (m) => pick(m, spec));
      }
      if (edge === 'insights' && method === 'GET') return accountInsights(p, ctx);
      if (edge === 'content_publishing_limit' && method === 'GET') {
        const used = state.publishLog.filter((x) => x > nowMs() - DAY).length;
        const node = { config: { quota_total: state.publishLimit, quota_duration: 86400 }, quota_usage: used };
        return { data: [p.fields ? pick(node, parseFields(p.fields)) : node] };
      }
      if (edge === 'recently_searched_hashtags') return { data: [...state.hashtags.values()].map((id) => ({ id })) };
      throw new GraphFail(100, `(#100) Tried accessing nonexisting field (${edge}) on node type (IGUser)`);
    }

    // --- hashtag ---
    if (t === 'hashtag') {
      if (!edge) return { id: target.obj.id, name: target.obj.name };
      if (edge !== 'top_media' && edge !== 'recent_media') throw new GraphFail(100, `(#100) Tried accessing nonexisting field (${edge}) on node type (IGHashtag)`);
      if (!p.user_id) throw new GraphFail(100, '(#100) The parameter user_id is required.');
      const rr = mulberry32(h32(`ht|${target.obj.name}|${edge}`));
      const recent = edge === 'recent_media';
      const list = Array.from({ length: 40 }, (_, i) => ({
        id: `179${String(h32(`htm|${target.obj.name}|${edge}|${i}`)).padStart(14, '0')}`,
        caption: `${BODIES[Math.floor(rr() * BODIES.length)]} #${target.obj.name} ${TAGS[Math.floor(rr() * TAGS.length)]}`,
        media_type: rr() < 0.7 ? 'IMAGE' : 'CAROUSEL_ALBUM',
        media_url: fixtures(ctx, IMAGES[Math.floor(rr() * IMAGES.length)]),
        permalink: `https://www.instagram.com/p/${b64(`${target.obj.name}${edge}${i}`).slice(0, 11)}/`,
        timestamp: graphTime(t0 - (recent ? rr() * DAY : rr() * 20 * DAY)),
        like_count: Math.round((recent ? 20 : 900) * (0.3 + rr() * 3)),
        comments_count: Math.round((recent ? 2 : 40) * (0.2 + rr() * 2)),
      }));
      list.sort((a, b) => (recent ? (a.timestamp < b.timestamp ? 1 : -1) : b.like_count - a.like_count));
      const spec = parseFields(p.fields || 'id');
      return paged(list, p, ctx, (m) => pick(m, spec), 50);
    }

    // --- container ---
    if (t === 'container') {
      if (edge || method !== 'GET') throw new GraphFail(100, '(#100) Unsupported request on a media container.');
      return project(containerNode(target.obj), parseFields(p.fields || 'id'), 'IGContainer');
    }

    // --- media ---
    if (t === 'media' || t === 'child') {
      const m = target.obj;
      if (!edge) {
        if (method === 'GET') return t === 'child' ? project(childNode(m, ctx), parseFields(p.fields || 'id'), 'IGMedia') : project(mediaNode(m, ctx), parseFields(p.fields || 'id'), 'IGMedia');
        if (method === 'POST') {
          if (p.comment_enabled === undefined) throw new GraphFail(100, '(#100) The parameter comment_enabled is required.');
          m.is_comment_enabled = String(p.comment_enabled) === 'true';
          return { success: true };
        }
        if (method === 'DELETE') {
          state.media = state.media.filter((x) => x.id !== m.id);
          state.stories = state.stories.filter((x) => x.id !== m.id);
          state.nodes.delete(m.id);
          state.deleted.push(m.id);
          return { success: true };
        }
      }
      if (edge === 'insights' && method === 'GET') {
        if (t === 'child') throw new GraphFail(100, '(#100) Insights are not available for carousel children.');
        return mediaInsights(m, p);
      }
      if (edge === 'children' && method === 'GET') {
        const spec = parseFields(p.fields || 'id');
        return { data: m.children.map((c) => project(childNode(c, ctx), spec, 'IGMedia')) };
      }
      if (edge === 'comments') {
        if (method === 'GET') {
          const spec = parseFields(p.fields || 'id,text,timestamp');
          return paged(topComments(m.id), p, ctx, (c) => project(commentNode(c), spec, 'IGComment'), 50);
        }
        if (method === 'POST') {
          if (m.media_product_type === 'STORY') throw new GraphFail(100, '(#100) Comments are not supported on stories.');
          if (!m.is_comment_enabled) throw new GraphFail(100, '(#100) Comments are turned off for this media.');
          const text = String(p.message || '').trim();
          if (!text) throw new GraphFail(100, '(#100) The parameter message is required.');
          const c = addComment(m, { text, ts: nowMs(), own: true });
          m.comments_count = (m.comments_count || 0) + 1;
          return { id: c.id };
        }
      }
      throw new GraphFail(100, `(#100) Unsupported ${method.toLowerCase()} request on media.`);
    }

    // --- comment ---
    if (t === 'comment') {
      const c = target.obj;
      const media = state.nodes.get(c.mediaId);
      if (!edge) {
        if (method === 'GET') return project(commentNode(c), parseFields(p.fields || 'id,text,timestamp'), 'IGComment');
        if (method === 'POST') {
          if (p.hide === undefined) throw new GraphFail(100, '(#100) The parameter hide is required.');
          if (c.fromId === state.userId) throw new GraphFail(100, '(#100) You cannot hide your own comments.');
          c.hidden = String(p.hide) === 'true';
          if (c.hidden) state.hidden.add(c.id);
          else state.hidden.delete(c.id);
          return { success: true };
        }
        if (method === 'DELETE') {
          const gone = [c.id, ...repliesOf(c.id).map((x) => x.id)];
          for (const id of gone) {
            state.comments.delete(id);
            state.nodes.delete(id);
            state.hidden.delete(id);
            state.deleted.push(id);
          }
          if (media) media.obj.comments_count = Math.max(0, (media.obj.comments_count || 0) - gone.length);
          return { success: true };
        }
      }
      if (edge === 'replies') {
        if (method === 'GET') {
          const spec = parseFields(p.fields || 'id,text,timestamp');
          return paged(repliesOf(c.id), p, ctx, (x) => project(commentNode(x), spec, 'IGComment'), 50);
        }
        if (method === 'POST') {
          if (c.parentId) throw new GraphFail(100, '(#100) You can only reply to top-level comments.');
          if (c.hidden) throw new GraphFail(100, '(#100) You cannot reply to a hidden comment. Unhide it first.');
          const text = String(p.message || '').trim();
          if (!text) throw new GraphFail(100, '(#100) The parameter message is required.');
          const reply = addComment(media ? media.obj : { id: c.mediaId }, { text, ts: nowMs(), own: true, parentId: c.id });
          if (media) media.obj.comments_count = (media.obj.comments_count || 0) + 1;
          state.replies.push({ commentId: c.id, id: reply.id, text });
          return { id: reply.id };
        }
      }
      throw new GraphFail(100, `(#100) Unsupported ${method.toLowerCase()} request on comment.`);
    }

    // --- conversation / message ---
    if (t === 'conversation') {
      if (edge === 'messages') {
        const spec = parseFields(p.fields || 'id,created_time');
        return paged(target.obj.messages.slice(0, 20), p, ctx, (m) => project(messageNode(m), spec, 'Message'));
      }
      return project(conversationNode(target.obj), parseFields(p.fields || 'id,updated_time'), 'Conversation');
    }
    if (t === 'message') return project(messageNode(target.obj), parseFields(p.fields || 'id,created_time'), 'Message');

    throw new GraphFail(100, '(#100) Unsupported request');
  }

  /** rupload.facebook.com/ig-api-upload/<version>/<container-id> */
  async function handleRupload(req, res, path, body) {
    const method = req.method.toUpperCase();
    if (method === 'OPTIONS') return send(res, 204, null);
    const segs = new URL(path, 'http://mock.local').pathname.split('/').filter(Boolean);
    const id = segs[segs.length - 1];
    const fail = (status, type, message) => send(res, status, { debug_info: { retriable: false, type, message } });
    const auth = String(req.headers.authorization || '');
    const token = auth.replace(/^OAuth\s+/i, '');
    if (!/^OAuth\s+\S+/i.test(auth) || token === 'expired-token' || token === 'invalid-token') {
      return fail(401, 'AuthError', JSON.stringify({ error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190, error_subcode: token === 'expired-token' ? 463 : 467 } }));
    }
    const c = state.containers.get(id);
    if (!c) return fail(404, 'NotFoundError', 'Container not found.');
    if (method !== 'POST') return fail(405, 'MethodNotAllowed', 'Use POST.');
    if (!c.uploadPending) return fail(400, 'ProcessingFailedError', 'This container does not accept an upload.');
    const bytes = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
    const size = Number(req.headers.file_size || req.headers['file-size']);
    const offset = Number(req.headers.offset || 0);
    if (offset !== 0) return fail(400, 'ProcessingFailedError', 'Only offset 0 is supported by the mock.');
    if (!bytes.length || size !== bytes.length) return fail(400, 'ProcessingFailedError', `file_size header (${size}) does not match the body (${bytes.length} bytes).`);
    c.uploadPending = false;
    state.uploads.set(c.id, bytes.length);
    if (bytes.length < 12 || bytes.toString('latin1', 4, 8) !== 'ftyp') {
      c.error = 'Error: The video format is not supported. Please check the spec for supported video formats. (2207026)';
    } else {
      c.readyAt = Date.now() + videoProcessingMs;
    }
    return send(res, 200, { success: true, message: 'Upload successful.' });
  }

  return { handle, handleRupload, state };
}
