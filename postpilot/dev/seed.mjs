// Demo workspace for the dev server (`node dev/server.mjs --seed`).
//
// Creates the encrypted data branch with passphrase "demo passphrase 123", connects the mock
// Instagram account (Instagram Login), uploads the fixture images/video as encrypted library assets,
// and fills a week and a half of posts, automation rules, an evergreen list, hashtag sets, a bio
// page and a first analytics snapshot. Everything runs against the dev server's mocks.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { b64encode, createKeyring, generateDataKey, importDataKey, utf8 } from '../core/crypto.js';
import { createStore, createDataBranch, DATA_BRANCH } from '../core/store.js';
import { newAsset, newList, newPost, newRule, uid } from '../core/model.js';
import { addDaysKey, dayKey, zonedToUtc } from '../core/time.js';
import { connectInstagram, createIg } from '../core/ig.js';

export const DEMO_PASSPHRASE = 'demo passphrase 123';
export const DEMO_TZ = 'America/New_York';
export const DEMO_IG_TOKEN = 'demo-instagram-token';
export const DEMO_AI_KEY = 'sk-ant-demo-key';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures');

/** Width/height from a JPEG's SOF marker (null when not a JPEG). */
export function jpegSize(bytes) {
  if (!bytes || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + len;
  }
  return null;
}

async function fixture(name) {
  return new Uint8Array(await readFile(path.join(FIXTURES, name)));
}

const IMAGES = [
  { file: 'f03.jpg', name: 'Vase trio', hint: 'New vases, fresh from the kiln.', tags: ['ceramics', 'vases'], folder: 'ceramics' },
  { file: 'f08.jpg', name: 'Speckled cream vases', hint: 'Speckled cream glaze, our most requested finish.', tags: ['ceramics', 'glaze'], folder: 'ceramics' },
  { file: 'f13.jpg', name: 'Studio still life', hint: 'A quiet corner of the studio.', tags: ['ceramics', 'studio'], folder: 'ceramics' },
  { file: 'f04.jpg', name: 'Latte art', hint: 'Coffee first, clay second.', tags: ['coffee'], folder: 'coffee' },
  { file: 'f14.jpg', name: 'Heart latte', hint: 'Our morning ritual before the wheel starts spinning.', tags: ['coffee'], folder: 'coffee' },
  { file: 'f01.jpg', name: 'Desert sunrise', hint: 'Morning light on the drive to the studio.', tags: ['landscape'], folder: null },
  { file: 'f06.jpg', name: 'Arched windows', hint: 'The studio windows at golden hour.', tags: ['studio'], folder: null },
  { file: 'f07.jpg', name: 'Night hills', hint: 'Quiet evenings, loud kilns.', tags: ['landscape'], folder: null },
  { file: 'f05.jpg', name: 'Ocean glaze test', hint: 'Testing a new ocean glaze. Thoughts?', tags: ['glaze', 'process'], folder: null, autopilot: true },
  { file: 'f09.jpg', name: 'Autumn colour study', hint: 'Colour study for the autumn collection.', tags: ['process'], folder: null, autopilot: true },
  { file: 'f10.jpg', name: 'Glaze bubbles', hint: 'Glaze bubbles up close. Every firing is a surprise.', tags: ['glaze', 'process'], folder: null, autopilot: true },
  { file: 'f12.jpg', name: 'Green hills', hint: 'Where the green glaze idea came from.', tags: ['landscape'], folder: null, autopilot: true },
  { file: 'f11.jpg', name: 'Terracotta arches', hint: 'Terracotta everything.', tags: ['studio'], folder: null },
];

/**
 * Seed the demo workspace.
 * @param {{gh: object, baseUrl: string, branch?: string, now?: Date, fetchImpl?: Function, onSecret?: Function}} opts
 *   gh: createGitHub client for the mock GitHub; baseUrl: dev server origin (mocks under /mock/*).
 * @returns {Promise<{dataKeyRaw: Uint8Array, key: CryptoKey, store: object}>}
 */
export async function seedDemo({ gh, baseUrl, branch = DATA_BRANCH, now = new Date(), fetchImpl, passphrase = DEMO_PASSPHRASE, iterations } = {}) {
  const dataKeyRaw = generateDataKey();
  const keyring = await createKeyring(passphrase, dataKeyRaw, iterations);
  await createDataBranch(gh, keyring, branch);
  const key = await importDataKey(dataKeyRaw);
  const store = createStore({ gh, key, branch, author: 'seed' });
  const tz = DEMO_TZ;
  const nowIso = now.toISOString();
  const igBase = `${baseUrl}/mock/ig`;

  // Instagram connection (mock Instagram Login account).
  let ig;
  try {
    ig = await connectInstagram({ mode: 'instagram', token: DEMO_IG_TOKEN, igBase, fetchImpl });
  } catch {
    ig = { mode: 'instagram', token: DEMO_IG_TOKEN, tokenType: 'ig_long', userId: '17841400000000001', username: 'studio.north', name: 'Studio North', profilePictureUrl: null, accountType: 'BUSINESS', apiVersion: 'v26.0' };
  }
  ig.connectedAt = new Date(now.getTime() - 20 * 864e5).toISOString();
  ig.tokenRefreshedAt = new Date(now.getTime() - 2 * 864e5).toISOString();
  ig.tokenExpiresAt = new Date(now.getTime() + 58 * 864e5).toISOString();
  ig.status = { state: 'ok', at: ig.connectedAt, checkedAt: ig.tokenRefreshedAt };

  // Recent media on the mock account, to link published posts and the bio grid.
  let liveMedia = [];
  try {
    liveMedia = await createIg({ mode: 'instagram', token: ig.token, userId: ig.userId, igBase, fetchImpl }).listMedia({ limit: 25, max: 25 });
  } catch {
    liveMedia = [];
  }

  // Library assets.
  const folders = [
    { id: 'fd_ceramics', name: 'Ceramics', createdAt: nowIso },
    { id: 'fd_coffee', name: 'Coffee', createdAt: nowIso },
  ];
  const assets = [];
  const files = new Map(); // path -> bytes
  for (const img of IMAGES) {
    const bytes = await fixture(img.file);
    const size = jpegSize(bytes) || { width: 1080, height: 1350 };
    const a = newAsset({
      name: img.name,
      kind: 'image',
      mime: 'image/jpeg',
      bytes: bytes.length,
      width: size.width,
      height: size.height,
      tags: img.tags,
      captionHint: img.hint,
      folderId: img.folder ? `fd_${img.folder}` : null,
      autopilot: !!img.autopilot,
      createdAt: nowIso,
    });
    files.set(a.path, bytes);
    files.set(a.thumbPath, bytes); // demo: the fixture doubles as its thumbnail
    assets.push(a);
  }
  const storyBytes = await fixture('story01.jpg');
  const storyAsset = newAsset({ name: 'Story: kiln opening', kind: 'image', mime: 'image/jpeg', bytes: storyBytes.length, width: 1080, height: 1920, tags: ['story'], createdAt: nowIso });
  files.set(storyAsset.path, storyBytes);
  files.set(storyAsset.thumbPath, storyBytes);
  assets.push(storyAsset);
  const tallBytes = await fixture('story03.jpg');
  const tallAsset = newAsset({ name: 'Studio lights (9:16)', kind: 'image', mime: 'image/jpeg', bytes: tallBytes.length, width: 1080, height: 1920, tags: ['studio'], createdAt: nowIso });
  files.set(tallAsset.path, tallBytes);
  files.set(tallAsset.thumbPath, tallBytes);
  assets.push(tallAsset);
  const clipBytes = await fixture('clip.mp4');
  const coverBytes = await fixture('story02.jpg');
  const videoAsset = newAsset({ name: 'Reel: on the wheel', kind: 'video', mime: 'video/mp4', bytes: clipBytes.length, width: 720, height: 1280, durationSec: 5, tags: ['reel', 'process'], captionHint: 'Five seconds on the wheel.', createdAt: nowIso });
  files.set(videoAsset.path, clipBytes);
  files.set(videoAsset.thumbPath, coverBytes);
  assets.push(videoAsset);
  const byName = Object.fromEntries(assets.map((a) => [a.name, a]));
  const ref = (a) => ({ assetId: a.id, kind: a.kind, altText: '' });

  // Posts across this week and next, in the demo time zone.
  const today = dayKey(now, tz);
  const at = (offsetDays, time) => zonedToUtc(addDaysKey(today, offsetDays), time, tz).toISOString();
  const history = (event, when = nowIso, detail) => [{ at: nowIso, event: 'created' }, ...(event ? [{ at: when, event, ...(detail ? { detail } : {}) }] : [])];
  const posts = [];
  const published = [
    { asset: 'Latte art', caption: 'Coffee first, clay second. What is in your mug this morning?\n\n#slowmorning #coffee', days: -3, time: '08:30' },
    { asset: 'Desert sunrise', caption: 'Morning light on the drive to the studio.\n\n#studiolife #morning', days: -2, time: '12:15' },
    { asset: 'Arched windows', caption: 'Golden hour in the studio. This light is why we work late.\n\n#studiolife #ceramics', days: -1, time: '17:45' },
  ];
  published.forEach((p, i) => {
    const media = liveMedia[i];
    const when = media?.timestamp || at(p.days, p.time);
    posts.push(
      newPost({
        type: 'feed',
        status: 'published',
        caption: p.caption,
        media: [ref(byName[p.asset])],
        scheduledAt: when,
        publishedAt: when,
        igMediaId: media?.id || null,
        permalink: media?.permalink || null,
        attempts: 1,
        createdAt: nowIso,
        updatedAt: when,
        history: history('published', when),
      }),
    );
  });
  const scheduled = [
    { type: 'feed', assets: ['Vase trio'], caption: 'Three new shapes for the autumn drop. Which one goes home with you?\n\n#ceramics #handmade', days: 1, time: '12:00', firstComment: 'Restock opens Friday at noon.' },
    { type: 'carousel', assets: ['Speckled cream vases', 'Studio still life', 'Terracotta arches'], caption: 'Swipe through this week in the studio.\n\n#pottery #studiolife', days: 2, time: '10:30' },
    { type: 'story', assets: ['Story: kiln opening'], caption: '', days: 1, time: '17:00' },
    { type: 'reel', assets: ['Reel: on the wheel'], caption: 'Five seconds on the wheel.\n\n#wheelthrown #reels', days: 4, time: '19:00' },
    { type: 'feed', assets: ['Night hills'], caption: 'Quiet evenings, loud kilns.\n\n#makersmovement', days: 8, time: '12:30' },
  ];
  for (const s of scheduled) {
    posts.push(
      newPost({
        type: s.type,
        status: 'scheduled',
        caption: s.caption,
        firstComment: s.firstComment || '',
        media: s.assets.map((n) => ref(byName[n])),
        scheduledAt: at(s.days, s.time),
        shareToFeed: true,
        createdAt: nowIso,
        updatedAt: nowIso,
        history: history('scheduled'),
      }),
    );
  }
  posts.push(
    newPost({
      type: 'feed',
      status: 'draft',
      caption: 'Our morning ritual before the wheel starts spinning.',
      media: [ref(byName['Heart latte'])],
      scheduledAt: at(5, '09:00'),
      labels: ['product'],
      createdAt: nowIso,
      updatedAt: nowIso,
    }),
    newPost({
      type: 'feed',
      status: 'draft',
      caption: '',
      media: [ref(byName['Green hills'])],
      notes: 'Workshop announcement: add date and price.',
      createdAt: nowIso,
      updatedAt: nowIso,
    }),
    newPost({
      type: 'feed',
      status: 'draft',
      source: 'autopilot',
      needsApproval: true,
      caption: 'Testing a new ocean glaze. Thoughts?\n\n#glaze #ceramics',
      media: [ref(byName['Ocean glaze test'])],
      scheduledAt: at(6, '18:00'),
      createdAt: nowIso,
      updatedAt: nowIso,
      history: [{ at: nowIso, event: 'created', detail: 'Created by autopilot.' }],
    }),
    newPost({
      type: 'feed',
      status: 'failed',
      caption: 'Late night at the studio.',
      media: [ref(byName['Studio lights (9:16)'])],
      scheduledAt: at(-1, '16:00'),
      attempts: 1,
      lastError: { message: 'The image aspect ratio is not allowed. Crop it to between 4:5 and 1.91:1.', code: 36003, subcode: 2207009, at: at(-1, '16:01'), permanent: true },
      createdAt: nowIso,
      updatedAt: at(-1, '16:01'),
      history: history('failed', at(-1, '16:01'), 'The image aspect ratio is not allowed.'),
    }),
  );
  for (const p of posts) {
    for (const m of p.media) {
      const a = assets.find((x) => x.id === m.assetId);
      if (a && p.status === 'published') a.usedBy = [...new Set([...(a.usedBy || []), p.id])];
    }
  }

  // Evergreen list: Thursday throwbacks.
  const list = newList({
    name: 'Throwback Thursday',
    color: '#8b5cf6',
    slots: [{ weekday: 4, time: '18:00' }],
    horizonDays: 14,
    items: [
      { id: uid('li_'), type: 'feed', caption: 'Throwback to the very first vases we fired. We have come a long way.\n\n#tbt #ceramics', firstComment: '', media: [ref(byName['Vase trio'])], timesUsed: 2, lastUsedAt: at(-7, '18:00') },
      { id: uid('li_'), type: 'feed', caption: 'Throwback to the day we got the keys to the studio.\n\n#tbt #smallbusiness', firstComment: '', media: [ref(byName['Terracotta arches'])], timesUsed: 1, lastUsedAt: at(-14, '18:00') },
    ],
    nextIndex: 0,
    createdAt: nowIso,
  });

  const rules = [
    newRule({
      name: 'Price questions',
      trigger: { source: 'comment', match: 'any', keywords: ['price', 'how much', 'link', 'info'], mediaIds: null },
      actions: [
        { type: 'reply_comment', texts: ['Thanks {mention}! Sent you the details by DM.', 'Hi {mention}, check your DMs for prices and the shop link.'] },
        { type: 'private_reply', texts: ['Hi {first_name}! Prices and the shop are here: https://studionorth.example/shop'] },
      ],
      oncePerUser: true,
      createdAt: nowIso,
    }),
    newRule({
      name: 'Workshop questions',
      trigger: { source: 'dm', match: 'any', keywords: ['workshop', 'class', 'course*'], mediaIds: null },
      actions: [{ type: 'send_dm', texts: ['Our next wheel-throwing workshops are on the studio site: https://studionorth.example/workshops. Spots go fast!'] }],
      oncePerUser: false,
      createdAt: nowIso,
    }),
  ];

  const docs = {
    settings: {
      v: 1,
      timezone: tz,
      ig,
      ai: { provider: 'anthropic', apiKey: DEMO_AI_KEY, model: 'claude-opus-5-5', voice: 'Warm, calm and concise. Talks like a potter, never salesy.', language: 'English', emoji: 'some', enabled: true },
      publishing: { defaultFirstComment: '', autoFirstCommentHashtags: false, retryFailed: true },
      worker: { enabled: true },
      ui: {},
      createdAt: nowIso,
    },
    posts: { v: 1, posts },
    library: { v: 1, assets, folders },
    lists: { v: 1, lists: [list] },
    automations: {
      v: 1,
      enabled: true,
      rules,
      welcome: { enabled: true, text: 'Thanks for writing to Studio North! We are at the wheel most of the day and reply within a few hours.' },
      blockedWords: { enabled: true, words: ['followers fast', 'promote it'], action: 'hide' },
      limits: { maxActionsPerRun: 25, maxDmsPerHour: 40 },
      processed: { comments: {}, messages: {}, conversations: {} },
      cursors: {},
      stats: { replies: 0, dms: 0, hidden: 0 },
    },
    autopilot: {
      v: 1,
      enabled: false,
      mode: 'review',
      postsPerWeek: 4,
      horizonDays: 7,
      slotStrategy: 'best',
      fixedSlots: [{ weekday: 2, time: '12:00' }, { weekday: 4, time: '18:00' }],
      minGapHours: 20,
      allowedTypes: ['feed', 'carousel', 'reel'],
      captionStyle: 'Short, calm, one question to spark comments.',
      hashtagSetIds: ['hs_ceramics'],
      useAi: true,
      recycleTopPosts: false,
      recycleAfterDays: 120,
      lastRunAt: null,
    },
    hashtags: {
      v: 1,
      sets: [
        { id: 'hs_ceramics', name: 'Ceramics', tags: ['#ceramics', '#pottery', '#handmade', '#stoneware', '#wheelthrown', '#studiolife'], createdAt: nowIso },
        { id: 'hs_coffee', name: 'Coffee', tags: ['#coffee', '#slowmorning', '#mugshot', '#coffeetime'], createdAt: nowIso },
        { id: 'hs_shop', name: 'Shop', tags: ['#smallbusiness', '#shopsmall', '#handmadegifts', '#makersmovement'], createdAt: nowIso },
      ],
      templates: [
        { id: 'tp_drop', name: 'New drop', text: 'New in the shop: {product}. {detail}\n\nRestock opens Friday at noon, link in bio.', createdAt: nowIso },
        { id: 'tp_workshop', name: 'Workshop', text: 'Wheel-throwing workshop on {date}. Six spots, all materials included. Link in bio.', createdAt: nowIso },
      ],
      savedReplies: [
        { id: 'sr_thanks', name: 'Thanks', text: 'Thank you so much! It means a lot to us.', createdAt: nowIso },
        { id: 'sr_shipping', name: 'Shipping', text: 'Yes, we ship worldwide. Orders go out every Friday.', createdAt: nowIso },
        { id: 'sr_custom', name: 'Custom orders', text: 'We take a few custom orders each month. Send us a DM with what you have in mind.', createdAt: nowIso },
      ],
      tracked: [],
    },
    competitors: { v: 1, accounts: [{ username: 'atelier.kin', addedAt: nowIso }, { username: 'northbound.coffee', addedAt: nowIso }, { username: 'lumen.ceramics', addedAt: nowIso }], snapshots: {}, posts: {} },
    bio: {
      v: 1,
      published: true,
      title: 'Studio North',
      bio: 'Hand-thrown ceramics, slow coffee and studio notes. Custom orders open.',
      avatarUrl: '',
      theme: 'paper',
      accent: '#1f5f8b',
      links: [
        { id: uid('bl_'), title: 'Shop the autumn drop', url: 'https://studionorth.example/shop', enabled: true },
        { id: uid('bl_'), title: 'Book a wheel-throwing workshop', url: 'https://studionorth.example/workshops', enabled: true },
        { id: uid('bl_'), title: 'Custom orders', url: 'https://studionorth.example/custom', enabled: true },
      ],
      grid: liveMedia.slice(0, 6).map((m) => ({ id: uid('bg_'), igMediaId: m.id, imageUrl: m.thumbnailUrl || m.mediaUrl || '', url: m.permalink || '', permalink: m.permalink || '' })),
      updatedAt: nowIso,
    },
  };

  await store.transact(
    async (tx) => {
      for (const [p, bytes] of files) tx.writeBytes(p, bytes);
      for (const [name, value] of Object.entries(docs)) tx.write(name, value);
    },
    { message: 'seed demo workspace' },
  );
  return { dataKeyRaw, key, store };
}

/** Value the app stores in the POSTPILOT_DATA_KEY secret: the base64 data key as UTF-8 text. */
export function dataKeySecretPlaintext(dataKeyRaw) {
  return utf8(b64encode(dataKeyRaw));
}

