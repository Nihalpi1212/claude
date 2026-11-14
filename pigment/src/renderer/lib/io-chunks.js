// Container chunks (ARCHITECTURE.md "0.5 features", S5), skeleton file; no package edits it. The one place that reads
// and writes ICC profiles, EXIF, XMP, IPTC and resolution in JPEG, PNG, TIFF, WebP and PSD files, at the byte level:
// lib/io-chunks/<format>.js per container. Pure and Node-testable; async because PNG's zlib streams.
//
// Chunk providers (icc-engine's 'icc' in 0.5; metadata-io's EXIF, XMP, IPTC and resolution in 0.6) say what a written
// file carries; applyChunks runs exactly once per file (io.js exportImage and encodeForPath, depth.js, edit-ops.js).
// With no provider every file is byte-identical to 0.4's.
import * as jpeg from './io-chunks/jpeg.js';
import * as png from './io-chunks/png.js';
import * as webp from './io-chunks/webp.js';
import * as tiff from './io-chunks/tiff.js';
import * as psd from './io-chunks/psd.js';

const CONTAINERS = { jpeg, png, webp, tiff, psd };
const KINDS = ['icc', 'exif', 'xmp', 'iptc', 'resolution'];
const EXT = { jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg', png: 'png', tif: 'tiff', tiff: 'tiff', webp: 'webp', psd: 'psd', psb: 'psd' };

/** The chunk format of a file name, an extension or a format id ('jpeg', 'png8', 'png16', 'tiff'), or null (GIF, TGA…). */
export function chunkFormatFor(nameOrExt) {
  const s = String(nameOrExt ?? '').toLowerCase();
  const ext = /\.([a-z0-9]+)$/.exec(s)?.[1] ?? s;
  if (EXT[ext]) return EXT[ext];
  if (/^png(8|16|24|32)?$/.test(ext)) return 'png';
  return null;
}

/** The format of bytes by their signature, or null. */
export function sniffChunkFormat(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42)) return 'tiff';
  if (b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53) return 'psd';
  return null;
}

/** Which kinds a format reads and writes: `{ read: Kind[], write: Kind[] }` (empty lists for an unknown format). */
export function chunkSupport(format) {
  const c = CONTAINERS[format];
  return c ? { read: [...c.support.read], write: [...c.support.write] } : { read: [], write: [] };
}

/**
 * The metadata chunks of a file: `{ icc?, exif?, xmp?, iptc?, resolution? }`, a kind absent when the file has none.
 * Never throws: a damaged file gives what could be read and `damaged: true`. A file whose signature is not `format`
 * is read as the format its bytes are.
 */
export async function readChunks(bytes, format) {
  const fmt = sniffChunkFormat(bytes) ?? format;
  const c = CONTAINERS[fmt];
  if (!c || !bytes?.length) return {};
  try {
    return { ...(await c.read(bytes)) };
  } catch {
    return { damaged: true };
  }
}

const patchOf = (format, chunks) => {
  const write = new Set(CONTAINERS[format]?.support.write ?? []);
  const out = {};
  for (const k of KINDS) if (chunks && Object.prototype.hasOwnProperty.call(chunks, k) && chunks[k] !== undefined && write.has(k)) out[k] = chunks[k];
  return out;
};

/**
 * Writes chunks into a file: each kind given replaces the file's (null removes it), every other byte is kept. Returns
 * `bytes` itself for an empty patch (or a format without chunks); throws on a file it cannot parse.
 */
export async function writeChunks(bytes, format, chunks) {
  const fmt = sniffChunkFormat(bytes) ?? format;
  const patch = patchOf(fmt, chunks);
  if (!CONTAINERS[fmt] || !Object.keys(patch).length) return bytes;
  return CONTAINERS[fmt].write(bytes, patch);
}

// ---- providers ------------------------------------------------------------------------------------------------

const providers = [];

/**
 * A chunk provider: `provide(doc, { format, purpose: 'save' | 'copy' | 'export', opts })` returns the kinds (of its
 * `kinds`) the written file carries, null to remove one, or null for nothing. The same id again: the later wins.
 */
export function registerChunkProvider(def) {
  if (!def?.id || typeof def.provide !== 'function') throw new Error('registerChunkProvider needs an id and provide()');
  const at = providers.findIndex((p) => p.id === def.id);
  if (at >= 0) providers.splice(at, 1);
  const entry = { order: 500, kinds: KINDS, ...def };
  providers.push(entry);
  providers.sort((a, b) => a.order - b.order);
  return () => {
    const i = providers.indexOf(entry);
    if (i >= 0) providers.splice(i, 1);
  };
}

/** The registered providers, in order. */
export const chunkProviders = () => providers.slice();

/** What the providers give for a file, in order (a later provider overrides a kind). */
export function chunksFor(doc, info = {}) {
  const out = {};
  for (const p of providers) {
    let given = null;
    try {
      given = p.provide(doc, info);
    } catch (err) {
      console.error(`chunk provider ${p.id} failed`, err);
    }
    if (!given) continue;
    for (const k of p.kinds ?? KINDS) if (Object.prototype.hasOwnProperty.call(given, k) && given[k] !== undefined) out[k] = given[k];
  }
  return out;
}

/**
 * Applies the providers' chunks to encoded bytes (`formatOrExt`: a format id, an extension or a file name). `bytes`
 * comes back unchanged without a provider, for a format without chunks (GIF, TGA) or when nothing applies.
 */
export async function applyChunks(doc, bytes, formatOrExt, { purpose = 'export', opts = {} } = {}) {
  if (!providers.length || !bytes?.length) return bytes;
  const format = chunkFormatFor(formatOrExt) ?? sniffChunkFormat(bytes);
  if (!format || !CONTAINERS[format]) return bytes;
  const patch = patchOf(format, chunksFor(doc, { format, purpose, opts }));
  if (!Object.keys(patch).length) return bytes;
  return writeChunks(bytes, format, patch);
}
