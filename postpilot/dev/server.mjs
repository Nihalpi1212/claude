#!/usr/bin/env node
// Postpilot dev server (zero dependencies).
//
//   node dev/server.mjs [--seed] [--cron[=seconds]]      PORT env (default 5173)
//
// Serves the repository root statically, so the app is at http://localhost:5173/postpilot/, and
// mounts in-memory mocks of every external service the app and the worker use:
//   /mock/gh         GitHub REST API (+ /mock/gh/raw/... like raw.githubusercontent.com)
//   /mock/ig         graph.instagram.com        /mock/fb   graph.facebook.com
//   /mock/rupload    rupload.facebook.com       /mock/anthropic   api.anthropic.com
//   /mock/feed/demo.xml   a demo RSS feed (and /mock/feed/<slug>.html pages) for queue feeds
//   /mock/img/<file>      demo images for feed items and CSV links (fixtures; swatch.png and
//                         workshop-poster are PNGs)
// "Run worker" in the app (workflow_dispatch) runs worker/run.mjs in this process against the
// mocks, using the POSTPILOT_DATA_KEY secret the app saved (opened with a real curve25519 key pair).
//
// --seed   create a demo workspace first (passphrase "demo passphrase 123", any GitHub token)
// --cron   also run the worker every N seconds (default 600), like the GitHub Actions schedule

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { b64decode, b64encode, fromUtf8 } from '../core/crypto.js';
import { createGitHub } from '../core/github.js';
import { DATA_BRANCH } from '../core/store.js';
import { createMockGitHub } from './mock-github.mjs';
import { createMockGraph } from './mock-graph.mjs';
import { runWorker } from '../worker/run.mjs';

globalThis.self = globalThis.self || globalThis; // the sealed-box bundle expects `self`
const { boxKeyPair, sealedBox, sealedBoxOpen } = await import('../vendor/sealed-box.js');

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../..');
const APP_PATH = '/postpilot/';
const OWNER = 'demo';
const REPO = 'postpilot';
const SECRET_NAME = 'POSTPILOT_DATA_KEY';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  if (!raw.length) return {};
  const type = req.headers['content-type'] || '';
  try {
    if (type.includes('application/json')) return JSON.parse(raw.toString('utf8'));
    if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  } catch {
    return raw;
  }
  return raw;
}

/** Resolve a URL path inside `root`, refusing traversal and dot-files (.git, .env ...). */
export function safePath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((s) => s === '..' || s.startsWith('.'))) return null;
  const full = path.resolve(root, ...segments);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

async function serveStatic(req, res, pathname, root) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' });
    return res.end('Method not allowed');
  }
  if (pathname === '/') {
    res.writeHead(302, { Location: APP_PATH });
    return res.end();
  }
  const file = safePath(root, pathname);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  let target = file;
  let info = await stat(target).catch(() => null);
  if (info && info.isDirectory()) {
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { Location: `${pathname}/` });
      return res.end();
    }
    target = path.join(file, 'index.html');
    info = await stat(target).catch(() => null);
  }
  if (!info || !info.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range && info.size) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      return res.end();
    }
    const body = (await readFile(target)).subarray(start, end + 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': body.length, 'Accept-Ranges': 'bytes' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  const body = await readFile(target);
  res.writeHead(200, { ...headers, 'Content-Length': body.length, 'Accept-Ranges': 'bytes' });
  return res.end(req.method === 'HEAD' ? undefined : body);
}

// ---- demo feed and linked images (fetched by the in-process worker, like real sites) ---------------

// A 1x1 PNG. The feed declares swatch.png as a PNG, so the worker skips that item; workshop-poster
// has no type or extension, so the worker downloads it and refuses it (it can only post JPEG): the
// demo shows both.
const DEMO_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

/** Demo RSS 2.0 feed, newest first; image URLs point back at this server. */
export function demoFeedXml(base, now = Date.now()) {
  const at = (hours) => new Date(now - hours * 36e5).toUTCString();
  const items = [
    { slug: 'glaze-day', title: 'Glaze day: ocean and sand', hours: 2, desc: '<p>We mixed two new glazes this week: a deep ocean blue and a warm sand.</p>', media: `${base}/mock/img/f05.jpg` },
    { slug: 'kiln-opening', title: 'Kiln opening: five things we learned', hours: 26, desc: '<p>Every firing teaches us something. Here are five lessons &amp; one mistake.</p>' },
    { slug: 'studio-playlist', title: 'The studio playlist', hours: 50, desc: 'What we listen to at the wheel.', enclosure: `${base}/mock/img/swatch.png` },
    { slug: 'workshops', title: 'Workshop dates for November', hours: 74, desc: 'Six spots per class. Materials included.', poster: `${base}/mock/img/workshop-poster` },
    { slug: 'open-studio', title: 'Open studio on Saturday', hours: 98, desc: 'Come and throw a pot with us.', enclosure: `${base}/mock/img/f09.jpg` },
    { slug: 'note', title: 'A note without a picture', hours: 122, desc: 'Just words today.' },
  ];
  const body = items
    .map((it) => [
      '    <item>',
      `      <title>${xmlEscape(it.title)}</title>`,
      `      <link>${base}/mock/feed/${it.slug}.html</link>`,
      `      <guid isPermaLink="false">studio-north-${it.slug}</guid>`,
      `      <pubDate>${at(it.hours)}</pubDate>`,
      `      <description><![CDATA[${it.desc}]]></description>`,
      it.media ? `      <media:content url="${it.media}" medium="image" width="1080" height="1350" />` : '',
      it.poster ? `      <media:content url="${it.poster}" medium="image" />` : '',
      it.enclosure ? `      <enclosure url="${it.enclosure}" length="1000" type="${it.enclosure.endsWith('.png') ? 'image/png' : 'image/jpeg'}" />` : '',
      '    </item>',
    ].filter(Boolean).join('\n'))
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Studio North Journal</title>
    <link>${base}/mock/feed/</link>
    <description>Notes from the studio (demo feed)</description>
    <atom:link href="${base}/mock/feed/demo.xml" rel="self" type="application/rss+xml" />
${body}
  </channel>
</rss>
`;
}

async function handleDemoFeed(req, res, sub, base) {
  const name = decodeURIComponent(sub.split('?')[0]).replace(/^\/+/, '');
  if (name === 'demo.xml') {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : demoFeedXml(base));
    return true;
  }
  const page = /^([\w-]+)\.html$/.exec(name);
  if (page) {
    const og = page[1] === 'kiln-opening' ? `<meta property="og:image" content="${base}/mock/img/f10.jpg">` : '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${xmlEscape(page[1])}</title>${og}</head><body><p>Demo post.</p></body></html>`);
    return true;
  }
  return false;
}

async function handleDemoImage(req, res, sub) {
  const name = decodeURIComponent(sub.split('?')[0]).replace(/^\/+/, '');
  if (name === 'swatch.png' || name === 'workshop-poster') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': DEMO_PNG.length });
    res.end(req.method === 'HEAD' ? undefined : DEMO_PNG);
    return true;
  }
  if (!/^[\w-]+\.(jpg|mp4)$/.test(name)) return false;
  const bytes = await readFile(path.join(here, 'fixtures', name)).catch(() => null);
  if (!bytes) return false;
  res.writeHead(200, { 'Content-Type': name.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg', 'Content-Length': bytes.length });
  res.end(req.method === 'HEAD' ? undefined : bytes);
  return true;
}

/** Open the sealed POSTPILOT_DATA_KEY secret and return the base64 data key (or null). */
export function openDataKeySecret(secret, keyPair) {
  if (!secret || !secret.encrypted_value) return null;
  let plain;
  try {
    plain = sealedBoxOpen(b64decode(secret.encrypted_value), keyPair.publicKey, keyPair.secretKey);
  } catch {
    return null;
  }
  if (!plain) return null;
  // The app stores the base64 data key as text; accept raw 32 bytes too.
  const text = fromUtf8(plain).trim();
  try {
    if (b64decode(text).length === 32) return text;
  } catch {
    /* not base64 text */
  }
  return plain.length === 32 ? b64encode(plain) : null;
}

/**
 * Start the dev server.
 * @returns {Promise<{server, url, port, gh, graph, anthropic, runDevWorker, close}>}
 */
export async function startDevServer({ port = Number(process.env.PORT) || 5173, host = '127.0.0.1', seed = false, cronSec = 0, quiet = false, root = REPO_ROOT } = {}) {
  const say = quiet ? () => {} : (...a) => console.log(...a);
  const keyPair = boxKeyPair();
  let baseUrl = `http://${host}:${port}`;

  let chain = Promise.resolve();
  async function workerRun(reason, trigger) {
    const secret = ghMock.secrets.get(SECRET_NAME);
    const dataKey = openDataKeySecret(secret, keyPair);
    const env = {
      POSTPILOT_DATA_KEY: dataKey || '',
      GITHUB_TOKEN: 'dev-worker-token',
      GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
      GITHUB_EVENT_NAME: trigger,
      POSTPILOT_BRANCH: DATA_BRANCH,
      POSTPILOT_GITHUB_API: `${baseUrl}/mock/gh`,
      POSTPILOT_RAW_BASE: `${baseUrl}/mock/gh/raw`,
      POSTPILOT_IG_BASE: `${baseUrl}/mock/ig`,
      POSTPILOT_FB_BASE: `${baseUrl}/mock/fb`,
      POSTPILOT_RUPLOAD_BASE: `${baseUrl}/mock/rupload`,
      POSTPILOT_ANTHROPIC_BASE: `${baseUrl}/mock/anthropic`,
      POSTPILOT_MAX_WAIT_SEC: '0',
      POSTPILOT_POLL_MS: '500',
      POSTPILOT_DM_DELAY_MS: '0',
      POSTPILOT_REASON: reason || '',
      // The demo feed and its images are on this server (localhost), which the worker refuses otherwise.
      POSTPILOT_ALLOW_PRIVATE_LINKS: '1',
    };
    const res = await runWorker({ env, log: (line) => say(`[worker] ${line}`) });
    if (res.exitCode) throw new Error('worker run failed');
    return res;
  }
  /** Run the worker in-process, one run at a time (like the workflow's concurrency group). */
  function runDevWorker(reason = '', trigger = 'workflow_dispatch') {
    const run = chain.then(() => workerRun(reason, trigger));
    chain = run.catch(() => {});
    return run;
  }

  const ghMock = createMockGitHub({
    owner: OWNER,
    repo: REPO,
    defaultBranch: 'main',
    secretsKeyPair: keyPair,
    onDispatch: (body) => runDevWorker(body?.inputs?.reason || '', 'workflow_dispatch'),
  });
  const graph = createMockGraph({ fixturesPath: '/postpilot/dev/fixtures' });
  let anthropic = null;
  try {
    const mod = await import('./mock-anthropic.mjs');
    anthropic = mod.createMockAnthropic();
  } catch (err) {
    say(`Mock Anthropic is not available (${err.message}); AI features will fail locally.`);
  }

  const mounts = [
    ['/mock/gh', (req, res, sub, body) => ghMock.handle(req, res, sub, body)],
    ['/mock/ig', (req, res, sub, body, url) => graph.handle(req, res, sub, body, url)],
    ['/mock/fb', (req, res, sub, body, url) => graph.handle(req, res, sub, body, url)],
    ['/mock/rupload', (req, res, sub, body) => graph.handleRupload(req, res, sub, body)],
    ['/mock/anthropic', (req, res, sub, body, url) => (anthropic ? anthropic.handle(req, res, sub, body, url) : false)],
    ['/mock/feed', (req, res, sub) => handleDemoFeed(req, res, sub, baseUrl)],
    ['/mock/img', (req, res, sub) => handleDemoImage(req, res, sub)],
  ];

  // Until the demo workspace is seeded the app itself answers 503, so nobody (or no test) opens
  // it half-initialised. The mocks are available right away because seeding goes through them.
  let ready = !seed;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, baseUrl);
      for (const [prefix, handler] of mounts) {
        if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
          const body = await readBody(req);
          const sub = url.pathname.slice(prefix.length) + url.search;
          if (await handler(req, res, sub || '/', body, url)) return;
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: `No mock route for ${req.method} ${url.pathname}` }));
        }
      }
      if (!ready) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '1' });
        return res.end('Preparing the demo workspace. Reload in a moment.');
      }
      return await serveStatic(req, res, url.pathname, root);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: String((err && err.message) || err) }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  baseUrl = `http://${host}:${actualPort}`;

  let seeded = null;
  if (seed) {
    const { seedDemo, dataKeySecretPlaintext } = await import('./seed.mjs');
    const gh = createGitHub({ token: 'demo', owner: OWNER, repo: REPO, apiBase: `${baseUrl}/mock/gh` });
    seeded = await seedDemo({ gh, baseUrl });
    // Save the data key as the Actions secret, exactly like Settings > Worker does in the app.
    const pk = await gh.getSecretsPublicKey();
    const sealed = sealedBox(dataKeySecretPlaintext(seeded.dataKeyRaw), b64decode(pk.key));
    await gh.putSecret(SECRET_NAME, b64encode(sealed), pk.key_id);
    // First snapshot so analytics and stories have data right away.
    await runDevWorker('seed', 'workflow_dispatch').catch((err) => say(`[worker] first run failed: ${err.message}`));
    ready = true;
  }

  let timer = null;
  if (cronSec > 0) {
    timer = setInterval(() => {
      runDevWorker('', 'schedule').catch(() => {});
    }, cronSec * 1000);
    timer.unref?.();
  }

  return {
    server,
    url: baseUrl,
    port: actualPort,
    gh: ghMock,
    graph,
    anthropic,
    keyPair,
    seeded,
    runDevWorker,
    async close() {
      if (timer) clearInterval(timer);
      await chain.catch(() => {});
      await new Promise((r) => server.close(r));
    },
  };
}

function parseArgs(argv) {
  const out = { seed: false, cronSec: 0 };
  for (const a of argv) {
    if (a === '--seed') out.seed = true;
    else if (a === '--cron') out.cronSec = 600;
    else if (a.startsWith('--cron=')) out.cronSec = Math.max(10, Number(a.slice(7)) || 600);
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const host = process.env.HOST || '127.0.0.1';
  try {
    const dev = await startDevServer({ ...args, host });
    const shown = `http://localhost:${dev.port}${APP_PATH}`;
    console.log('');
    console.log(`Postpilot dev server running at ${shown}`);
    console.log(`  Repository: ${OWNER}/${REPO} (mock GitHub; any token works, for example "demo")`);
    if (args.seed) console.log('  Demo workspace ready. Passphrase: demo passphrase 123');
    else console.log('  No workspace yet: set one up in the app, or restart with --seed for a demo.');
    console.log('  Mocks: /mock/gh  /mock/ig  /mock/fb  /mock/rupload  /mock/anthropic');
    if (args.cronSec) console.log(`  Worker runs every ${args.cronSec}s (and whenever the app dispatches it).`);
    console.log('');
    const stop = () => dev.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (err) {
    console.error(`Could not start the dev server: ${err.message}`);
    process.exit(1);
  }
}
