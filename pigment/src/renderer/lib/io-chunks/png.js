// PNG metadata chunks (ARCHITECTURE.md "0.5 features", S5), skeleton file. ICC: iCCP (zlib; writing one removes sRGB,
// gAMA and cHRM, which would contradict it); EXIF: eXIf; XMP: iTXt "XML:com.adobe.xmp"; IPTC: read only, ImageMagick's
// zTXt "Raw profile type iptc"; resolution: pHYs. Writing replaces the chunks of the kinds given (new ones right
// after IHDR, before PLTE and IDAT as the format requires) and keeps every other chunk byte for byte.
import { crc32 } from '../../../shared/zip.js';
import { zlibCodecs } from '../../../shared/pixels/png.js';
import { ascii, asciiBytes, concat, be32, u32be, fromUtf8, utf8, latin1, copyBytes, touches, parseResources } from './bytes.js';

const round1 = (v) => Math.round(v * 10) / 10;

export const support = { read: ['icc', 'exif', 'xmp', 'iptc', 'resolution'], write: ['icc', 'exif', 'xmp', 'resolution'] };

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const XMP_KEY = 'XML:com.adobe.xmp';

/** [{ type, data }] of every chunk (data aliases `b`); throws on a damaged file. */
function chunksOf(b) {
  for (let i = 0; i < 8; i++) if (b[i] !== SIGNATURE[i]) throw new Error('Not a PNG file');
  const list = [];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    if (i + 12 + len > b.length) throw new Error(`PNG chunk ${type} is truncated`);
    list.push({ type, data: b.subarray(i + 8, i + 8 + len), raw: b.subarray(i, i + 12 + len) });
    i += 12 + len;
    if (type === 'IEND') break;
  }
  if (!list.length || list[0].type !== 'IHDR') throw new Error('PNG has no IHDR');
  list.trailer = b.subarray(i); // bytes after IEND (some writers leave them): kept
  return list;
}

const chunk = (type, data) => {
  const body = concat([asciiBytes(type), data]);
  return { type, data, raw: concat([be32(data.length), body, be32(crc32(body))]) };
};

const nul = (d, from = 0) => d.indexOf(0, from);

/** IPTC from ImageMagick's text profile: "\niptc\n   <length>\n<hex digits…>"; a Photoshop resource wrapper is opened. */
function iptcFromRawProfile(text) {
  const m = /^\s*\S+\s+(\d+)\s+([0-9a-fA-F\s]+)$/.exec(text);
  if (!m) return null;
  const hex = m[2].replace(/\s+/g, '');
  const n = Math.min(Number(m[1]), hex.length >> 1);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  if (ascii(out, 0, 4) === '8BIM') {
    try {
      const r = parseResources(out).find((x) => x.id === 0x0404);
      if (r) return copyBytes(r.data);
    } catch {}
  }
  return out;
}

export async function read(b, { inflate = zlibCodecs.inflate } = {}) {
  const out = {};
  for (const c of chunksOf(b)) {
    const d = c.data;
    if (c.type === 'iCCP' && out.icc === undefined) {
      const z = nul(d);
      if (z > 0 && d[z + 1] === 0) out.icc = await inflate(d.subarray(z + 2));
    } else if (c.type === 'eXIf' && out.exif === undefined) out.exif = copyBytes(d);
    else if (c.type === 'iTXt' && out.xmp === undefined) {
      const z = nul(d);
      if (z < 0 || latin1(d.subarray(0, z)) !== XMP_KEY) continue;
      const compressed = d[z + 1] === 1;
      const lang = nul(d, z + 3);
      const tkey = lang < 0 ? -1 : nul(d, lang + 1);
      if (tkey < 0) continue;
      const text = d.subarray(tkey + 1);
      out.xmp = fromUtf8(compressed ? await inflate(text) : text);
    } else if (c.type === 'zTXt' && out.iptc === undefined) {
      const z = nul(d);
      if (z < 0 || latin1(d.subarray(0, z)) !== 'Raw profile type iptc' || d[z + 1] !== 0) continue;
      const iptc = iptcFromRawProfile(latin1(await inflate(d.subarray(z + 2))));
      if (iptc) out.iptc = iptc;
    } else if (c.type === 'pHYs' && d.length >= 9 && out.resolution === undefined) {
      const x = u32be(d, 0), y = u32be(d, 4);
      // pixels per metre: shown per inch, the unit Pigment and Photoshop use
      // (to a tenth: whole pixels per metre cannot hold 72 dpi exactly, 2835 ppm reads 72.009)
      out.resolution = d[8] === 1 ? { x: round1(x * 0.0254), y: round1(y * 0.0254), unit: 'in' } : { x, y, unit: 'none' };
    }
  }
  return out;
}

export async function write(b, patch, { deflate = zlibCodecs.deflate } = {}) {
  const list = chunksOf(b);
  const drop = new Set();
  const fresh = [];
  if (touches(patch, 'icc')) {
    drop.add('iCCP');
    if (patch.icc?.length) {
      for (const t of ['sRGB', 'gAMA', 'cHRM']) drop.add(t);
      fresh.push(chunk('iCCP', concat([asciiBytes('ICC profile'), Uint8Array.of(0, 0), await deflate(patch.icc)])));
    }
  }
  if (touches(patch, 'exif')) {
    drop.add('eXIf');
    if (patch.exif?.length) fresh.push(chunk('eXIf', patch.exif));
  }
  const isXmp = (c) => c.type === 'iTXt' && latin1(c.data.subarray(0, Math.max(0, nul(c.data)))) === XMP_KEY;
  let dropXmp = false;
  if (touches(patch, 'xmp')) {
    dropXmp = true;
    if (patch.xmp) fresh.push(chunk('iTXt', concat([asciiBytes(XMP_KEY), Uint8Array.of(0, 0, 0, 0, 0), utf8(patch.xmp)])));
  }
  if (touches(patch, 'resolution')) {
    drop.add('pHYs');
    const r = patch.resolution;
    if (r) {
      const per = r.unit === 'in' ? 1 / 0.0254 : r.unit === 'cm' ? 100 : 1;
      const v = (n) => Math.max(1, Math.round(n * per)) >>> 0;
      fresh.push(chunk('pHYs', concat([be32(v(r.x)), be32(v(r.y)), Uint8Array.of(r.unit === 'none' ? 0 : 1)])));
    }
  }
  const kept = list.filter((c) => !drop.has(c.type) && !(dropXmp && isXmp(c)));
  const parts = [SIGNATURE];
  for (const c of kept) {
    parts.push(c.raw);
    if (c.type === 'IHDR') for (const f of fresh) parts.push(f.raw);
  }
  parts.push(list.trailer);
  return concat(parts);
}
