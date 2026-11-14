// Pure helpers for the pigment:// scheme handler. No Electron imports so they can be unit-tested.
import { extname, join, normalize, resolve, sep } from 'node:path';

export const APP_SCHEME = 'pigment';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
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
  '.ftl': 'text/plain; charset=utf-8',
};

export function mimeFor(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Maps a pigment://app/<path> URL to a file inside the renderer directory.
 * Returns null for any URL that escapes the directory or uses another host.
 */
export function resolveAppUrl(url, rendererRoot) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null;
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  // /shared/* and /build/* live next to the renderer directory (src/shared, build).
  let root = resolve(rendererRoot);
  if (pathname.startsWith('/shared/')) {
    root = resolve(rendererRoot, '..', 'shared');
    pathname = pathname.slice('/shared'.length);
  } else if (pathname.startsWith('/build/')) {
    root = resolve(rendererRoot, '..', '..', 'build');
    pathname = pathname.slice('/build'.length);
  }
  const file = normalize(join(root, pathname));
  if (file !== root && !file.startsWith(root + sep)) return null;
  return file;
}
