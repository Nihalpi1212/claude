// Minimal static file server for the renderer, used by the Playwright e2e tests and `npm run dev:web`.
// Serves src/renderer at / (so index.html, lib/, styles/, vendor/ resolve exactly like under folio://app/),
// src/shared at /shared/, build/ at /build/ and tests/fixtures/out at /fixtures/. No dependencies.
import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const RENDERER = join(root, 'src', 'renderer');
const SHARED = join(root, 'src', 'shared');
const BUILD = join(root, 'build');
const FIXTURES = join(root, 'tests', 'fixtures', 'out');

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.icc': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  if (clean.startsWith('/fixtures/')) {
    const file = normalize(join(FIXTURES, clean.slice('/fixtures/'.length)));
    return file.startsWith(FIXTURES + sep) ? file : null;
  }
  for (const [prefix, dir] of [['/shared/', SHARED], ['/build/', BUILD]]) {
    if (clean.startsWith(prefix)) {
      const file = normalize(join(dir, clean.slice(prefix.length - 1)));
      return file.startsWith(dir + sep) ? file : null;
    }
  }
  const rel = clean === '/' ? '/index.html' : clean;
  const file = normalize(join(RENDERER, rel));
  return file.startsWith(RENDERER + sep) ? file : null;
}

export function startServer(port = 0, host = '127.0.0.1') {
  const server = createServer(async (req, res) => {
    const file = resolveFile(req.url ?? '/');
    if (!file) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolvePromise({ server, port: address.port, url: `http://${host}:${address.port}/` });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? process.argv[2] ?? 8765);
  startServer(port).then(({ url }) => console.log(`Folio renderer served at ${url}  (fixtures at ${url}fixtures/)`));
}
