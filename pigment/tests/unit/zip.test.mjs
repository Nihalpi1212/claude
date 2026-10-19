import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip, readZip, crc32, findEntry } from '../../src/shared/zip.js';

const enc = new TextEncoder();
const codecs = { deflate: (b) => new Uint8Array(deflateRawSync(b)), inflate: (b) => new Uint8Array(inflateRawSync(b)) };

test('crc32 matches known values', () => {
  assert.equal(crc32(enc.encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  assert.equal(crc32(new Uint8Array(0)), 0);
  const all = enc.encode('hello world');
  assert.equal(crc32(all.subarray(6), crc32(all.subarray(0, 6))), crc32(all));
});

const sample = () => {
  const binary = new Uint8Array(5000);
  for (let i = 0; i < binary.length; i++) binary[i] = (i * 31) % 256;
  return [
    { name: 'document.json', data: enc.encode(JSON.stringify({ a: 1, text: 'x'.repeat(500) })), compress: true },
    { name: 'layers/1.png', data: binary, compress: true },
    { name: 'empty.txt', data: new Uint8Array(0), compress: true },
    { name: 'ßü.png', data: enc.encode('unicode name') },
  ];
};

test('round trip with store and deflate, names, sizes and dates preserved', async () => {
  const date = new Date(2026, 9, 18, 14, 37, 20);
  for (const opts of [{}, codecs]) {
    const bytes = await writeZip(sample(), { ...opts, date });
    const entries = await readZip(bytes, opts);
    assert.deepEqual(entries.map((e) => e.name), ['document.json', 'layers/1.png', 'empty.txt', 'ßü.png']);
    for (const [i, s] of sample().entries()) assert.deepEqual(entries[i].data, s.data);
    assert.equal(entries[0].date.getMinutes(), 37);
    assert.equal(entries[0].date.getFullYear(), 2026);
    assert.equal(findEntry(entries, 'layers/1.png').data.length, 5000);
    assert.equal(findEntry(entries, 'missing'), null);
    if (opts.deflate) assert.equal(entries[0].method, 8);
    else assert.equal(entries[0].method, 0);
  }
});

test('errors: corrupt CRC, missing inflate, not a zip, trailing comment tolerated', async () => {
  const bytes = await writeZip(sample(), codecs);
  await assert.rejects(readZip(bytes), /no inflate function/);
  const stored = await writeZip([{ name: 'a.txt', data: enc.encode('abcdef') }]);
  const bad = stored.slice();
  bad[30 + 5] ^= 0xff; // flip a data byte
  await assert.rejects(readZip(bad), /CRC mismatch/);
  await assert.rejects(readZip(enc.encode('definitely not a zip file at all')), /Not a ZIP/);
  // add a comment after the end record
  const withComment = new Uint8Array(stored.length + 7);
  withComment.set(stored);
  new DataView(withComment.buffer).setUint16(stored.length - 2, 7, true);
  withComment.set(enc.encode('comment'), stored.length);
  const entries = await readZip(withComment);
  assert.equal(new TextDecoder().decode(entries[0].data), 'abcdef');
});

test('archives are readable by an independent implementation', async (t) => {
  const bytes = await writeZip(sample(), codecs);
  const dir = mkdtempSync(join(tmpdir(), 'pigment-zip-'));
  try {
    const file = join(dir, 'test.zip');
    writeFileSync(file, bytes);
    let ok = false;
    try {
      const out = execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(",".join(z.namelist()))', file], { encoding: 'utf8' });
      assert.equal(out.trim(), 'document.json,layers/1.png,empty.txt,ßü.png');
      ok = true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (!ok) t.skip('python3 not available');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
