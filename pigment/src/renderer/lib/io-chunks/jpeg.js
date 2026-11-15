// JPEG metadata segments (ARCHITECTURE.md "0.5 features", S5), skeleton file. ICC: APP2 "ICC_PROFILE\0" + sequence
// number and count, split at 65 519 bytes; EXIF: APP1 "Exif\0\0"; XMP: APP1 "http://ns.adobe.com/xap/1.0/\0" (the
// standard packet); IPTC: APP13 "Photoshop 3.0\0", 8BIM resource 0x0404; resolution: the APP0 JFIF density. Writing
// replaces the segments of the kinds given and keeps every other byte (the entropy-coded data after SOS untouched).
import { asciiBytes, concat, be16, startsWith, u16be, fromUtf8, utf8, copyBytes, touches, parseResources, writeResources, setResource, round2 } from './bytes.js';

export const support = { read: ['icc', 'exif', 'xmp', 'iptc', 'resolution'], write: ['icc', 'exif', 'xmp', 'iptc', 'resolution'] };

const ICC_SIG = 'ICC_PROFILE\0';
const EXIF_SIG = 'Exif\0\0';
const XMP_SIG = 'http://ns.adobe.com/xap/1.0/\0';
const PS_SIG = 'Photoshop 3.0\0';
const ICC_MAX = 65519; // 65535 - the length field (2) - the signature (12) - sequence and count (2)

/**
 * Splits a JPEG into { head: segments before SOS [{ marker, data }], tail: SOS and everything after }. With `onDamage`
 * (read only) damage before SOS ends the list instead of throwing, so the segments before it are still read (S5).
 */
function segments(b, onDamage = null) {
  const damaged = (msg, list) => {
    if (!onDamage) throw new Error(msg);
    onDamage();
    return { list, tail: new Uint8Array(0) };
  };
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('Not a JPEG file');
  const list = [];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return damaged('JPEG marker expected', list);
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) {
      i++; // fill bytes
      marker = b[i + 1];
    }
    if (marker === 0xda || marker === 0xd9) return { list, tail: b.subarray(i) };
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      list.push({ marker, data: new Uint8Array(0), bare: true });
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    if (len < 2 || i + 2 + len > b.length) return damaged('JPEG segment is truncated', list);
    list.push({ marker, data: b.subarray(i + 4, i + 2 + len) });
    i += 2 + len;
  }
  return damaged('JPEG has no image data', list);
}

const isIcc = (s) => s.marker === 0xe2 && startsWith(s.data, 0, ICC_SIG);
const isExif = (s) => s.marker === 0xe1 && startsWith(s.data, 0, EXIF_SIG);
const isXmp = (s) => s.marker === 0xe1 && startsWith(s.data, 0, XMP_SIG);
const isPs = (s) => s.marker === 0xed && startsWith(s.data, 0, PS_SIG);
const isJfif = (s) => s.marker === 0xe0 && startsWith(s.data, 0, 'JFIF\0');

export function read(b) {
  let damaged = false;
  const { list } = segments(b, () => (damaged = true));
  const out = {};
  const icc = list.filter(isIcc).map((s) => ({ seq: s.data[12], data: s.data.subarray(14) })).sort((a, c) => a.seq - c.seq);
  // a damaged file whose profile is cut short (fewer APP2 parts than each declares) gives no profile, not part of one
  const whole = !damaged || list.filter(isIcc).every((s) => s.data[13] === icc.length);
  if (icc.length && whole) out.icc = concat(icc.map((p) => p.data));
  const exif = list.find(isExif);
  if (exif) out.exif = copyBytes(exif.data.subarray(EXIF_SIG.length));
  const xmp = list.find(isXmp);
  if (xmp) out.xmp = fromUtf8(xmp.data.subarray(XMP_SIG.length));
  const ps = list.find(isPs);
  if (ps) {
    const iptc = parseResources(ps.data, PS_SIG.length, ps.data.length, () => (damaged = true)).find((r) => r.id === 0x0404);
    if (iptc) out.iptc = copyBytes(iptc.data);
  }
  const jfif = list.find(isJfif);
  if (jfif && jfif.data.length >= 12) {
    const unit = jfif.data[7], x = u16be(jfif.data, 8), y = u16be(jfif.data, 10);
    out.resolution = { x: round2(x), y: round2(y), unit: unit === 1 ? 'in' : unit === 2 ? 'cm' : 'none' };
  }
  return damaged ? { ...out, damaged: true } : out;
}

const seg = (marker, data) => ({ marker, data });

export function write(b, patch) {
  const { list, tail } = segments(b);
  let head = list.slice();
  // where new segments go: after JFIF / EXIF APP0-APP1 at the start, as encoders write them
  const insertAt = () => {
    let i = 0;
    while (i < head.length && (head[i].marker === 0xe0 || head[i].marker === 0xe1)) i++;
    return i;
  };
  const replace = (test, fresh) => {
    const first = head.findIndex(test);
    head = head.filter((s) => !test(s));
    if (!fresh.length) return;
    const at = first >= 0 ? Math.min(first, head.length) : insertAt();
    head.splice(at, 0, ...fresh);
  };
  if (touches(patch, 'exif')) replace(isExif, patch.exif ? [seg(0xe1, concat([asciiBytes(EXIF_SIG), patch.exif]))] : []);
  if (touches(patch, 'xmp')) replace(isXmp, patch.xmp ? [seg(0xe1, concat([asciiBytes(XMP_SIG), utf8(patch.xmp)]))] : []);
  if (touches(patch, 'icc')) {
    const parts = [];
    const icc = patch.icc;
    if (icc?.length) {
      const count = Math.ceil(icc.length / ICC_MAX);
      for (let k = 0; k < count; k++) parts.push(seg(0xe2, concat([asciiBytes(ICC_SIG), Uint8Array.of(k + 1, count), icc.subarray(k * ICC_MAX, (k + 1) * ICC_MAX)])));
    }
    replace(isIcc, parts);
  }
  if (touches(patch, 'iptc')) {
    const old = head.find(isPs);
    const blocks = setResource(old ? parseResources(old.data, PS_SIG.length) : [], 0x0404, patch.iptc ?? null);
    replace(isPs, blocks.length ? [seg(0xed, concat([asciiBytes(PS_SIG), writeResources(blocks)]))] : []);
  }
  if (touches(patch, 'resolution')) {
    const r = patch.resolution;
    const at = head.findIndex(isJfif);
    const unit = r ? (r.unit === 'in' ? 1 : r.unit === 'cm' ? 2 : 0) : 0;
    const dens = (v) => Math.max(1, Math.min(65535, Math.round(r ? v : 1)));
    if (at >= 0) {
      const d = new Uint8Array(head[at].data);
      d[7] = unit;
      d.set(be16(dens(r?.x)), 8);
      d.set(be16(dens(r?.y)), 10);
      head[at] = seg(0xe0, d);
    } else if (r) head.unshift(seg(0xe0, concat([asciiBytes('JFIF\0'), Uint8Array.of(1, 1, unit), be16(dens(r.x)), be16(dens(r.y)), Uint8Array.of(0, 0)])));
  }
  const parts = [Uint8Array.of(0xff, 0xd8)];
  for (const s of head) {
    if (s.bare) parts.push(Uint8Array.of(0xff, s.marker));
    else {
      if (s.data.length + 2 > 65535) throw new Error(`JPEG segment 0x${s.marker.toString(16)} is too large`);
      parts.push(Uint8Array.of(0xff, s.marker), be16(s.data.length + 2), s.data);
    }
  }
  parts.push(tail);
  return concat(parts);
}
