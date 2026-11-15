// Polyfills for very recent JavaScript APIs that pdf.js 6 uses. Electron 44's Chromium has them
// natively; this only matters for the browser test harness and older Chromium builds.
(() => {
  for (const Ctor of [Map, WeakMap]) {
    const proto = Ctor.prototype;
    if (typeof proto.getOrInsert !== 'function') {
      Object.defineProperty(proto, 'getOrInsert', {
        configurable: true,
        writable: true,
        value(key, defaultValue) {
          if (this.has(key)) return this.get(key);
          this.set(key, defaultValue);
          return defaultValue;
        },
      });
    }
    if (typeof proto.getOrInsertComputed !== 'function') {
      Object.defineProperty(proto, 'getOrInsertComputed', {
        configurable: true,
        writable: true,
        value(key, callback) {
          if (typeof callback !== 'function') throw new TypeError('callback is not a function');
          if (this.has(key)) return this.get(key);
          const value = callback(key);
          this.set(key, value);
          return value;
        },
      });
    }
  }
  if (typeof Promise.try !== 'function') {
    Promise.try = function (fn, ...args) {
      return new Promise((resolve) => resolve(fn(...args)));
    };
  }
  if (typeof Array.fromAsync !== 'function') {
    Array.fromAsync = async function (items, mapFn) {
      const out = [];
      let i = 0;
      for await (const item of items) out.push(mapFn ? await mapFn(item, i++) : item);
      return out;
    };
  }
  if (typeof Math.sumPrecise !== 'function') {
    Math.sumPrecise = function (values) {
      let sum = 0;
      for (const v of values) sum += v;
      return sum;
    };
  }
  if (typeof Math.clamp !== 'function') {
    Math.clamp = function (value, min, max) {
      return Math.min(Math.max(value, min), max);
    };
  }
  if (typeof Uint8Array.fromBase64 !== 'function') {
    Uint8Array.fromBase64 = function (text) {
      const bin = atob(String(text).replace(/\s+/g, ''));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    };
  }
  if (typeof Uint8Array.prototype.toBase64 !== 'function') {
    Object.defineProperty(Uint8Array.prototype, 'toBase64', {
      configurable: true,
      writable: true,
      value() {
        let bin = '';
        for (let i = 0; i < this.length; i += 0x8000) bin += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000));
        return btoa(bin);
      },
    });
  }
  if (typeof Uint8Array.fromHex !== 'function') {
    Uint8Array.fromHex = function (text) {
      const clean = String(text).replace(/\s+/g, '');
      const out = new Uint8Array(clean.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
      return out;
    };
  }
  if (typeof Uint8Array.prototype.toHex !== 'function') {
    Object.defineProperty(Uint8Array.prototype, 'toHex', {
      configurable: true,
      writable: true,
      value() {
        let s = '';
        for (const b of this) s += b.toString(16).padStart(2, '0');
        return s;
      },
    });
  }
  if (typeof RegExp.escape !== 'function') {
    RegExp.escape = (s) => String(s).replace(/[\\^$.*+?()[\]{}|\/]/g, '\\$&').replace(/^[0-9A-Za-z]/, (c) => `\\x${c.charCodeAt(0).toString(16)}`);
  }
  if (typeof Error.isError !== 'function') {
    Error.isError = (e) => e instanceof Error;
  }
  if (typeof Iterator === 'undefined' || typeof Iterator.from !== 'function') {
    globalThis.Iterator ||= function Iterator() {};
    Iterator.from = (it) => {
      const iter = it[Symbol.iterator] ? it[Symbol.iterator]() : it;
      return {
        next: () => iter.next(),
        [Symbol.iterator]() {
          return this;
        },
        map(fn) {
          const src = this;
          let i = 0;
          return Iterator.from({ next: () => { const r = src.next(); return r.done ? r : { value: fn(r.value, i++), done: false }; } });
        },
        filter(fn) {
          const src = this;
          return Iterator.from({ next: () => { for (;;) { const r = src.next(); if (r.done || fn(r.value)) return r; } } });
        },
        toArray() {
          return [...this];
        },
        forEach(fn) {
          for (const v of this) fn(v);
        },
        some(fn) {
          for (const v of this) if (fn(v)) return true;
          return false;
        },
        every(fn) {
          for (const v of this) if (!fn(v)) return false;
          return true;
        },
        find(fn) {
          for (const v of this) if (fn(v)) return v;
          return undefined;
        },
        reduce(fn, init) {
          let acc = init;
          for (const v of this) acc = fn(acc, v);
          return acc;
        },
        take(n) {
          const src = this;
          let i = 0;
          return Iterator.from({ next: () => (i++ < n ? src.next() : { done: true, value: undefined }) });
        },
      };
    };
  }
})();
