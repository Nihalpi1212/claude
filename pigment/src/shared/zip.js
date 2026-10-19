// Minimal dependency-free ZIP reader/writer for the .pigment document format (see ARCHITECTURE.md
// "File formats"). Store (0) and deflate (8) methods; the deflate/inflate functions are injected
// so the same code runs in the renderer (CompressionStream) and in Node (zlib). No ZIP64.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE) of bytes, optionally continuing from a previous value. */
export function crc32(bytes, seed = 0) {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const LIMIT = 0xffffffff;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date(1980, 0, 1);
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, day };
}

function fromDos(time, day) {
  return new Date(((day >> 9) & 0x7f) + 1980, ((day >> 5) & 0xf) - 1, day & 0x1f, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}

/**
 * Writes a ZIP archive.
 * @param {{ name: string, data: Uint8Array, compress?: boolean, date?: Date }[]} entries
 * @param {{ deflate?: (bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array, date?: Date }} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function writeZip(entries, opts = {}) {
  if (entries.length > 0xffff) throw new Error('Too many files for a ZIP archive (ZIP64 is not supported)');
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(String(entry.name));
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data ?? 0);
    if (data.length >= LIMIT) throw new Error(`"${entry.name}" is larger than 4 GB (ZIP64 is not supported)`);
    const crc = crc32(data);
    let method = 0;
    let stored = data;
    if (entry.compress && opts.deflate && data.length > 0) {
      const packed = await opts.deflate(data);
      if (packed.length < data.length) {
        method = 8;
        stored = packed;
      }
    }
    const { time, day } = dosDateTime(entry.date ?? opts.date ?? new Date());
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, stored.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, stored.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, stored);
    centrals.push(central);
    offset += local.length + stored.length;
    if (offset >= LIMIT) throw new Error('The archive is larger than 4 GB (ZIP64 is not supported)');
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

/**
 * Reads a ZIP archive.
 * @param {Uint8Array} bytes
 * @param {{ inflate?: (bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array }} [opts]
 * @returns {Promise<{ name: string, data: Uint8Array, method: number, crc32: number, date: Date }[]>}
 */
export async function readZip(bytes, opts = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (no end of central directory record)');
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === LIMIT) throw new Error('ZIP64 archives are not supported');
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const method = view.getUint16(p + 10, true);
    const time = view.getUint16(p + 12, true);
    const day = view.getUint16(p + 14, true);
    const crc = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`Corrupt ZIP entry "${name}"`);
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    if (start + compSize > bytes.length) throw new Error(`Truncated ZIP entry "${name}"`);
    const raw = bytes.subarray(start, start + compSize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) {
      if (!opts.inflate) throw new Error(`"${name}" is compressed and no inflate function was provided`);
      data = await opts.inflate(raw);
    } else throw new Error(`"${name}" uses unsupported compression method ${method}`);
    if (data.length !== size) throw new Error(`Size mismatch in "${name}"`);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch in "${name}" (the file is damaged)`);
    entries.push({ name, data, method, crc32: crc, date: fromDos(time, day) });
  }
  return entries;
}

export function findEntry(entries, name) {
  return entries.find((e) => e.name === name) ?? null;
}

/** deflate/inflate helpers built on the browser's CompressionStream (raw deflate). */
export const streamCodecs = {
  async deflate(bytes) {
    const cs = new CompressionStream('deflate-raw');
    const out = new Response(new Blob([bytes]).stream().pipeThrough(cs));
    return new Uint8Array(await out.arrayBuffer());
  },
  async inflate(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  },
};
