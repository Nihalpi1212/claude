// .abr brushes (ARCHITECTURE.md "0.5 features", S10.6): an ag-psd Brush and its samples to a BrushPreset. Owned by
// brush-settings-panel, which maps every section and registers .abr as a two-kind format (brushes, patterns);
// preset-files-manager's .tpl calls brushFromAgPsd for a painting preset's brush descriptor.
//
// Skeleton stub (S15, ABR_REAL false): the tip's size, hardness, angle, roundness and spacing through brushFromLegacy,
// flips and Spacing on/off, a sampled tip as a SampleRef with its grey PNG as a blob; every other section is reported,
// not mapped. Pure and synchronous (Node-testable): the PNG is written with stored (uncompressed) deflate blocks and
// named by its SHA-1, so the same tip always gives the same blob.
import { brushFromLegacy, normalizeBrush } from './preset.js';

export const ABR_REAL = false;

const SECTIONS = [
  ['shapeDynamics', 'Shape Dynamics'],
  ['scatter', 'Scattering'],
  ['texture', 'Texture'],
  ['dualBrush', 'Dual Brush'],
  ['colorDynamics', 'Color Dynamics'],
  ['transfer', 'Transfer'],
  ['brushPose', 'Brush Pose'],
];

const num = (v) => (Number.isFinite(v) ? v : undefined);

/**
 * brushFromAgPsd(brush, samples: Map<id, { width, height, alpha: Uint8Array }>) → { preset, blobs: { [name]:
 * Uint8Array }, report: string[] }. Never throws: a brush it cannot read is the default round brush with a report line.
 */
export function brushFromAgPsd(brush, samples = new Map()) {
  const report = [];
  const blobs = {};
  const name = typeof brush?.name === 'string' && brush.name ? brush.name : 'Brush';
  const shape = brush?.shape && typeof brush.shape === 'object' ? brush.shape : {};
  const legacy = {
    size: num(shape.size),
    hardness: shape.type === 'computed' ? num(shape.hardness) : 1,
    angle: num(shape.angle),
    roundness: num(shape.roundness),
    spacing: num(shape.spacing),
  };
  const preset = normalizeBrush(brushFromLegacy(legacy));
  preset.tip.flipX = !!shape.flipX;
  preset.tip.flipY = !!shape.flipY;
  if (shape.spacingOn === false) preset.tip.spacingOn = false;
  if (shape.type === 'sampled') {
    const sample = samples?.get?.(shape.sampledData) ?? null;
    if (sample?.alpha && sample.width > 0 && sample.height > 0 && sample.alpha.length >= sample.width * sample.height) {
      const png = greyPng(sample.width, sample.height, sample.alpha);
      const hash = sha1Hex(png);
      const blob = `tip-${hash}.png`;
      blobs[blob] = png;
      preset.tip.kind = 'sampled';
      preset.tip.sample = { blob, hash, width: sample.width, height: sample.height };
    } else report.push(`"${name}": its sampled tip is missing from the file; a round tip is used`);
  } else if (shape.type && shape.type !== 'computed') report.push(`"${name}": ${shape.type} tips are not read yet; a round tip is used`);
  for (const [key, label] of SECTIONS) if (brush?.[key]) report.push(`"${name}": ${label} is not read yet`);
  return { preset: normalizeBrush(preset), blobs, report };
}

// ---- a grey PNG without compression (sync) ------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** An 8-bit greyscale PNG of the coverage (white = full coverage), its zlib stream in stored blocks. */
function greyPng(w, h, alpha) {
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) raw.set(alpha.subarray(y * w, y * w + w), y * (w + 1) + 1); // filter byte 0
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  z[0] = 0x78;
  z[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const from = b * 65535;
    const len = Math.min(65535, raw.length - from);
    z[o++] = b === blocks - 1 ? 1 : 0;
    z[o++] = len & 0xff;
    z[o++] = len >>> 8;
    z[o++] = ~len & 0xff;
    z[o++] = (~len >>> 8) & 0xff;
    z.set(raw.subarray(from, from + len), o);
    o += len;
  }
  let s1 = 1, s2 = 0;
  for (let i = 0; i < raw.length; i++) {
    s1 = (s1 + raw[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  const adler = ((s2 << 16) | s1) >>> 0;
  z[o++] = adler >>> 24;
  z[o++] = (adler >>> 16) & 0xff;
  z[o++] = (adler >>> 8) & 0xff;
  z[o++] = adler & 0xff;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  const chunks = [['IHDR', ihdr], ['IDAT', z.subarray(0, o)], ['IEND', new Uint8Array(0)]];
  const total = 8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0);
  const out = new Uint8Array(total);
  out.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const odv = new DataView(out.buffer);
  let p = 8;
  for (const [type, data] of chunks) {
    odv.setUint32(p, data.length);
    for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
    out.set(data, p + 8);
    odv.setUint32(p + 8 + data.length, crc32(out, p + 4, p + 8 + data.length));
    p += 12 + data.length;
  }
  return out;
}

// ---- SHA-1 (sync; the blob names are content addresses) ------------------------------------------------------------

function sha1Hex(bytes) {
  const ml = bytes.length;
  const n = (((ml + 8) >>> 6) + 1) << 6;
  const m = new Uint8Array(n);
  m.set(bytes);
  m[ml] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(n - 8, Math.floor((ml * 8) / 0x100000000));
  dv.setUint32(n - 4, (ml * 8) >>> 0);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < n; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((v) => v.toString(16).padStart(8, '0')).join('');
}
