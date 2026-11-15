// The main process's preset files (src/main/preset-files.js, ARCHITECTURE.md "0.4 features", C): validation, atomic
// writes, blobs, delete, corrupt files renamed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { presetFiles } from '../../src/main/preset-files.js';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pigment-presets-'));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('write, read and delete a kind file; a kind with a colon is stored with __', () => withDir(async (dir) => {
  const p = presetFiles(dir);
  assert.equal(await p.read('gradients'), null);
  const file = { format: 'pigment-presets', version: 1, kind: 'gradients', items: [{ ref: 'a' }] };
  await p.write('gradients', file);
  assert.deepEqual(await p.read('gradients'), file);
  await p.write('adjustment:levels', { format: 'pigment-presets', items: [] });
  assert.ok(existsSync(join(dir, 'adjustment__levels.json')));
  assert.deepEqual(await p.read('adjustment:levels'), { format: 'pigment-presets', items: [] });
  await p.write('gradients', null);
  assert.equal(await p.read('gradients'), null);
  assert.ok(!existsSync(join(dir, 'gradients.json')));
  // no temporary files are left behind
  assert.ok(readdirSync(dir).every((n) => !n.endsWith('.tmp')));
}));

test('blobs round trip byte for byte, and are removed', () => withDir(async (dir) => {
  const p = presetFiles(dir);
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 7]);
  await p.writeBlob('patterns', 'p-1.png', bytes);
  assert.deepEqual(Array.from(await p.readBlob('patterns', 'p-1.png')), Array.from(bytes));
  assert.deepEqual(Array.from(readFileSync(join(dir, 'patterns', 'p-1.png'))), Array.from(bytes));
  assert.equal(await p.readBlob('patterns', 'missing.png'), null);
  await p.removeBlob('patterns', 'p-1.png');
  assert.equal(await p.readBlob('patterns', 'p-1.png'), null);
}));

test('invalid kinds, names and data are rejected', () => withDir(async (dir) => {
  const p = presetFiles(dir);
  for (const kind of ['', 'Gradients', '../x', 'a/b', 'a:b:c', 'a:', ':a', 7, null]) {
    await assert.rejects(async () => p.read(kind), /Invalid preset kind/);
    await assert.rejects(async () => p.write(kind, {}), /Invalid preset kind/);
  }
  for (const name of ['', '..', '.', 'a/b', '../../etc', 'x'.repeat(129), 'a b']) {
    await assert.rejects(async () => p.readBlob('patterns', name), /Invalid preset blob name/);
    await assert.rejects(async () => p.writeBlob('patterns', name, new Uint8Array(1)), /Invalid preset blob name/);
  }
  await assert.rejects(async () => p.write('gradients', [1, 2]), /must be an object/);
  await assert.rejects(async () => p.write('gradients', 'text'), /must be an object/);
  await assert.rejects(async () => p.writeBlob('patterns', 'a.png', 'not bytes'), /binary/);
  assert.deepEqual(readdirSync(dir), []);
}));

test('a corrupt file is renamed .corrupt-<time> and reads as null', () => withDir(async (dir) => {
  const p = presetFiles(dir);
  writeFileSync(join(dir, 'contours.json'), '{ not json');
  assert.equal(await p.read('contours'), null);
  const names = readdirSync(dir);
  assert.ok(!names.includes('contours.json'));
  assert.ok(names.some((n) => /^contours\.json\.corrupt-\d+$/.test(n)));
  // the next write starts a fresh file
  await p.write('contours', { items: [] });
  assert.deepEqual(await p.read('contours'), { items: [] });
}));

test('writes of one kind land in order', () => withDir(async (dir) => {
  const p = presetFiles(dir);
  await Promise.all([1, 2, 3, 4, 5].map((n) => p.write('styles', { n })));
  assert.deepEqual(await p.read('styles'), { n: 5 });
}));
