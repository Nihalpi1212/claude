// Big-endian byte reading and writing for Photoshop's preset files (preset-files-manager; ARCHITECTURE.md "0.5
// features", package 10). Pure and Node-safe. The reader throws a RangeError ("the file ends early") the moment a read
// would pass the end, so every format reader can stop at the damage, keep what it read before it and report the rest.

export const MAX_PRESET_FILE = 64 * 1024 * 1024; // larger files are refused with a message (the brief's limit)

export class Truncated extends RangeError {
  constructor() {
    super('the file ends early');
  }
}

export class Reader {
  /** @param {Uint8Array} bytes */
  constructor(bytes, offset = 0, end = bytes.length) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.o = offset;
    this.end = Math.min(end, bytes.length);
  }
  need(n) {
    if (n < 0 || this.o + n > this.end) throw new Truncated();
  }
  get left() {
    return this.end - this.o;
  }
  u8() { this.need(1); return this.bytes[this.o++]; }
  u16() { this.need(2); const v = this.view.getUint16(this.o); this.o += 2; return v; }
  i16() { this.need(2); const v = this.view.getInt16(this.o); this.o += 2; return v; }
  u32() { this.need(4); const v = this.view.getUint32(this.o); this.o += 4; return v; }
  i32() { this.need(4); const v = this.view.getInt32(this.o); this.o += 4; return v; }
  f32() { this.need(4); const v = this.view.getFloat32(this.o); this.o += 4; return v; }
  f64() { this.need(8); const v = this.view.getFloat64(this.o); this.o += 8; return v; }
  take(n) {
    this.need(n);
    const out = this.bytes.subarray(this.o, this.o + n);
    this.o += n;
    return out;
  }
  skip(n) {
    this.need(n);
    this.o += n;
  }
  sig() {
    this.need(4);
    let s = '';
    for (let i = 0; i < 4; i++) s += String.fromCharCode(this.bytes[this.o + i]);
    this.o += 4;
    return s;
  }
  /** UTF-16BE of `count` code units; a trailing NUL is dropped. */
  utf16(count) {
    this.need(count * 2);
    let s = '';
    for (let i = 0; i < count; i++) s += String.fromCharCode(this.view.getUint16(this.o + i * 2));
    this.o += count * 2;
    return s.replace(/\0+$/, '');
  }
  /** Photoshop's unicode string: a u32 count of code units, then UTF-16BE (usually with a trailing NUL). */
  ustr() {
    const n = this.u32();
    if (n > this.left / 2) throw new Truncated();
    return this.utf16(n);
  }
  /** A Pascal string (u8 length), padded to a multiple of `pad` bytes counting the length byte. */
  pascal(pad = 1) {
    const n = this.u8();
    const raw = this.take(n);
    let s = '';
    for (const c of raw) s += String.fromCharCode(c);
    let total = n + 1;
    while (total % pad) {
      this.skip(1);
      total++;
    }
    return s;
  }
  align4(from = 0) {
    while ((this.o - from) % 4 && this.o < this.end) this.o++;
  }
}

export class Writer {
  constructor(size = 1 << 16) {
    this.buf = new Uint8Array(size);
    this.n = 0;
  }
  room(k) {
    if (this.n + k <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.n + k) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
  }
  dv() {
    return new DataView(this.buf.buffer);
  }
  u8(v) { this.room(1); this.buf[this.n++] = v & 255; }
  u16(v) { this.room(2); this.dv().setUint16(this.n, v & 0xffff); this.n += 2; }
  i16(v) { this.room(2); this.dv().setInt16(this.n, v); this.n += 2; }
  u32(v) { this.room(4); this.dv().setUint32(this.n, v >>> 0); this.n += 4; }
  i32(v) { this.room(4); this.dv().setInt32(this.n, v | 0); this.n += 4; }
  f32(v) { this.room(4); this.dv().setFloat32(this.n, v); this.n += 4; }
  f64(v) { this.room(8); this.dv().setFloat64(this.n, v); this.n += 8; }
  bytes(b) { this.room(b.length); this.buf.set(b, this.n); this.n += b.length; }
  zeros(k) { this.room(k); this.buf.fill(0, this.n, this.n + k); this.n += k; }
  sig(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i) || 32); }
  /** UTF-16BE code units of s (no count). */
  utf16(s) { for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i)); }
  /** Photoshop's unicode string with its trailing NUL counted. */
  ustr(s) {
    const str = String(s ?? '');
    this.u32(str.length + 1);
    this.utf16(str);
    this.u16(0);
  }
  pascal(s, pad = 1) {
    const str = String(s ?? '').slice(0, 255);
    this.u8(str.length);
    for (let i = 0; i < str.length; i++) this.u8(str.charCodeAt(i) & 255);
    let total = str.length + 1;
    while (total % pad) {
      this.u8(0);
      total++;
    }
  }
  pad4(from = 0) {
    while ((this.n - from) % 4) this.u8(0);
  }
  /** Reserves a u32 length at the current position; the returned function writes the bytes written since. */
  lengthField() {
    const at = this.n;
    this.u32(0);
    const start = this.n;
    return () => this.dv().setUint32(at, this.n - start);
  }
  done() {
    return this.buf.slice(0, this.n);
  }
}

/** The refusal of a file over 64 MB (the reader is not even started), or null. */
export function tooLarge(bytes, name = 'The file') {
  if (bytes && bytes.length > MAX_PRESET_FILE) return `${name} is ${Math.round(bytes.length / 1048576)} MB: preset files over 64 MB are not imported`;
  return null;
}

/** A Uint8Array view of bytes given as Uint8Array, ArrayBuffer or another typed array. */
export function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(0);
}

/** The file name without its folder and extension (a default group or set name). */
export function baseName(name, fallback = 'Presets') {
  return String(name ?? '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '') || fallback;
}

/** A blob name that is new on every call (pattern pixel files are never shared between presets). */
export function freshBlob(prefix, ext = 'png') {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}.${ext}`;
}
