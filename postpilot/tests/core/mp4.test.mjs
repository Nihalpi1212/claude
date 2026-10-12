import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripMp4Metadata } from '../../core/mp4.js';

function box(t, ...children) {
  const body = children.length ? Buffer.concat(children) : Buffer.alloc(0);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(t, 4, 'latin1');
  return Buffer.concat([head, body]);
}

test('renames location/device metadata boxes and keeps sizes', () => {
  const xyz = box('©xyz', Buffer.from('+40.7128-074.0060/'));
  const file = Buffer.concat([
    box('ftyp', Buffer.from('isom0000')),
    box('moov', box('mvhd', Buffer.alloc(20)), box('udta', xyz), box('trak', box('tkhd', Buffer.alloc(20)), box('meta', Buffer.alloc(12)))),
    box('uuid', Buffer.alloc(24)),
    box('mdat', Buffer.alloc(32)),
  ]);
  const bytes = new Uint8Array(file);
  const before = bytes.length;
  const stripped = stripMp4Metadata(bytes);
  assert.deepEqual(stripped.sort(), ['meta', 'udta', 'uuid']);
  assert.equal(bytes.length, before);
  const text = Buffer.from(bytes).toString('latin1');
  assert.ok(!text.includes('udta') && !text.includes('meta') && !text.includes('uuid'));
  assert.ok(text.includes('mvhd') && text.includes('tkhd') && text.includes('mdat'), 'playback boxes untouched');
});

test('leaves non-MP4 data and the fixture video playable structure intact', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(stripMp4Metadata(jpeg), []);
  const clip = new Uint8Array(await readFile(new URL('../../dev/fixtures/clip.mp4', import.meta.url)));
  const copy = clip.slice();
  stripMp4Metadata(copy);
  assert.equal(copy.length, clip.length);
  assert.equal(Buffer.from(copy.subarray(4, 8)).toString('latin1'), 'ftyp');
  assert.ok(Buffer.from(copy).toString('latin1').includes('moov'));
});
