// Worker test environment: mock GitHub + mock Graph API + mock Anthropic on one local server, an
// encrypted data branch with a known data key, helpers to seed documents/media and to run the
// worker with captured console output.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './servers.mjs';
import { createMockGitHub } from '../../dev/mock-github.mjs';
import { createMockGraph } from '../../dev/mock-graph.mjs';
import { createMockAnthropic } from '../../dev/mock-anthropic.mjs';
import { createGitHub } from '../../core/github.js';
import { createDataBranch, createStore } from '../../core/store.js';
import { b64encode, createKeyring, generateDataKey, importDataKey } from '../../core/crypto.js';
import { newAsset } from '../../core/model.js';
import { connectInstagram } from '../../core/ig.js';
import { runWorker } from '../../worker/run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, '../../dev/fixtures');
export const PASSPHRASE = 'worker test passphrase';
export const TEST_TOKEN = 'IGAAtest-long-lived-token-123456';
const DAY = 864e5;

export function fixtureBytes(name) {
  return readFile(path.join(FIXTURES, name)).then((b) => new Uint8Array(b));
}

async function serveFixture(req, res, sub) {
  const name = decodeURIComponent(sub.split('?')[0]).replace(/^\/+/, '');
  if (!/^[\w.-]+$/.test(name)) return false;
  try {
    const bytes = await readFile(path.join(FIXTURES, name));
    res.writeHead(200, { 'Content-Type': name.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
  return true;
}

/**
 * Start a worker environment.
 * @param {{graph?: object, connect?: boolean, mode?: 'instagram'|'facebook', token?: string, settings?: object}} opts
 */
export async function startWorkerEnv({ graph: graphOpts = {}, connect = true, mode = 'instagram', token = TEST_TOKEN, settings = {} } = {}) {
  const ghMock = createMockGitHub({ owner: 'o', repo: 'r' });
  const graph = createMockGraph({ imageProcessingMs: 30, videoProcessingMs: 150, fixturesPath: '/fixtures', ...graphOpts });
  const anthropic = createMockAnthropic();
  const pushes = []; // web push deliveries: {path, headers, body}
  const srv = await startServer({
    '/push': (req, res, sub, body) => {
      pushes.push({ path: sub, headers: req.headers, body: Buffer.isBuffer(body) ? new Uint8Array(body) : null });
      res.writeHead(/gone/.test(sub) ? 410 : 201);
      res.end();
      return true;
    },
    '/gh': (req, res, sub, body) => ghMock.handle(req, res, sub, body),
    '/ig': (req, res, sub, body, url) => graph.handle(req, res, sub, body, url),
    '/fb': (req, res, sub, body, url) => graph.handle(req, res, sub, body, url),
    '/rupload': (req, res, sub, body) => graph.handleRupload(req, res, sub, body),
    '/anthropic': (req, res, sub, body, url) => anthropic.handle(req, res, sub, body, url),
    '/fixtures': (req, res, sub) => serveFixture(req, res, sub),
  });
  const apiBase = `${srv.url}/gh`;
  const client = createGitHub({ token: 't', owner: 'o', repo: 'r', apiBase });
  const dataKeyRaw = generateDataKey();
  await createDataBranch(client, await createKeyring(PASSPHRASE, dataKeyRaw, 1000));
  const key = await importDataKey(dataKeyRaw);
  const store = createStore({ gh: client, key, author: 'test' });

  let ig = null;
  if (connect) {
    ig = await connectInstagram({ mode, token, igBase: `${srv.url}/ig`, fbBase: `${srv.url}/fb` });
    ig.connectedAt = new Date(Date.now() - 10 * DAY).toISOString();
    ig.tokenRefreshedAt = new Date(Date.now() - 1 * DAY).toISOString();
    ig.tokenExpiresAt = new Date(Date.now() + 59 * DAY).toISOString();
  }
  await store.update('settings', (s) => {
    s.timezone = 'UTC';
    s.ig = ig;
    Object.assign(s, settings);
  });

  const env = {
    POSTPILOT_DATA_KEY: b64encode(dataKeyRaw),
    GITHUB_TOKEN: 'gh-test-token',
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_EVENT_NAME: 'schedule',
    GITHUB_ACTIONS: 'true',
    POSTPILOT_GITHUB_API: apiBase,
    POSTPILOT_RAW_BASE: `${srv.url}/gh/raw`,
    POSTPILOT_IG_BASE: `${srv.url}/ig`,
    POSTPILOT_FB_BASE: `${srv.url}/fb`,
    POSTPILOT_RUPLOAD_BASE: `${srv.url}/rupload`,
    POSTPILOT_ANTHROPIC_BASE: `${srv.url}/anthropic`,
    POSTPILOT_MAX_WAIT_SEC: '0',
    POSTPILOT_POLL_MS: '40',
    POSTPILOT_DM_DELAY_MS: '0',
  };

  const lines = [];
  /** Run the worker; returns runWorker's result plus the console lines of this run. */
  async function run({ env: extra = {}, only, now } = {}) {
    const out = [];
    const res = await runWorker({
      env: { ...env, ...extra },
      only,
      now,
      log: (l) => {
        out.push(String(l));
        lines.push(String(l));
      },
    });
    return { ...res, lines: out };
  }

  async function read(name) {
    await store.refresh();
    return store.read(name);
  }

  async function update(name, fn) {
    await store.refresh();
    return store.update(name, fn);
  }

  /** Upload a fixture as an encrypted library asset (the fixture doubles as its thumbnail). */
  async function addAsset(file, partial = {}) {
    const bytes = await fixtureBytes(file);
    const isVideo = file.endsWith('.mp4');
    const asset = newAsset({
      name: file,
      kind: isVideo ? 'video' : 'image',
      mime: isVideo ? 'video/mp4' : 'image/jpeg',
      bytes: bytes.length,
      width: isVideo ? 720 : 1080,
      height: isVideo ? 1280 : 1350,
      durationSec: isVideo ? 5 : null,
      ...partial,
    });
    const thumb = isVideo ? await fixtureBytes('story02.jpg') : bytes;
    await store.refresh();
    await store.transact(async (tx) => {
      tx.writeBytes(asset.path, bytes);
      tx.writeBytes(asset.thumbPath, thumb);
      const lib = await tx.read('library');
      lib.assets.push(asset);
      tx.write('library', lib);
    });
    return asset;
  }

  /** Add an incoming comment to a media item in the mock graph. */
  function addComment(mediaId, { username = 'new.fan', text = 'Nice!', at = Date.now(), parentId = null } = {}) {
    const media = graph.state.nodes.get(mediaId);
    const id = `1809${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
    const c = { id, mediaId, parentId, text, timestamp: at, username, fromId: `7${String(Math.abs(hash(username))).padStart(15, '0')}`, like_count: 0, hidden: false };
    graph.state.nodes.set(id, { type: 'comment', obj: c });
    graph.state.comments.set(id, c);
    if (media) media.obj.comments_count = (media.obj.comments_count || 0) + 1;
    return c;
  }

  /** Add an incoming DM (new conversation unless one with the user exists). */
  function addMessage({ username = 'new.customer', text = 'Hello!', at = Date.now() } = {}) {
    const other = { id: `7${String(Math.abs(hash(`dm:${username}`))).padStart(15, '0')}`, username };
    const own = { id: graph.state.userId, username: graph.state.username };
    let conv = graph.state.conversations.find((c) => c.participants.some((p) => p.id === other.id));
    if (!conv) {
      conv = { id: `conv_${username}_${Math.floor(Math.random() * 1e9)}`, participants: [other, own], messages: [] };
      graph.state.nodes.set(conv.id, { type: 'conversation', obj: conv });
      graph.state.conversations.push(conv);
    }
    const msg = { id: `mid_${Math.floor(Math.random() * 1e12)}`, created_time: at, from: other, to: [own], message: text, attachments: [] };
    graph.state.nodes.set(msg.id, { type: 'message', obj: msg });
    conv.messages.unshift(msg);
    return { conv, msg, other };
  }

  return {
    url: srv.url,
    ghMock,
    graph,
    anthropic,
    pushes,
    store,
    gh: client,
    env,
    ig,
    dataKeyRaw,
    lines,
    run,
    read,
    update,
    addAsset,
    addComment,
    addMessage,
    close: () => srv.close(),
  };
}

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/** Console lines minus GitHub ::add-mask:: commands (which Actions never prints). */
export function visibleLines(lines) {
  return lines.filter((l) => !l.startsWith('::add-mask::'));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
