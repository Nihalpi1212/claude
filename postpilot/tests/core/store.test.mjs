import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockGitHub } from '../helpers/servers.mjs';
import { createGitHub } from '../../core/github.js';
import { createStore, createDataBranch, readKeyring, ConflictError } from '../../core/store.js';
import { createKeyring, generateDataKey, importDataKey, unlockKeyring, WrongPassphraseError, decryptJSON } from '../../core/crypto.js';
import { newPost } from '../../core/model.js';

test('keyring wraps and unwraps the data key', async () => {
  const dk = generateDataKey();
  const kr = await createKeyring('correct horse battery', dk, 1000);
  assert.deepEqual(await unlockKeyring(kr, 'correct horse battery'), dk);
  await assert.rejects(unlockKeyring(kr, 'wrong passphrase'), WrongPassphraseError);
});

test('store: create branch, transact, conflicts retry, encrypted at rest', async (t) => {
  const mock = await startMockGitHub({ owner: 'o', repo: 'r' });
  t.after(() => mock.close());
  const gh = createGitHub({ owner: 'o', repo: 'r', token: 't', apiBase: mock.apiBase });
  const dk = generateDataKey();
  await createDataBranch(gh, await createKeyring('passphrase-123', dk, 1000));
  const kr = await readKeyring(gh);
  const key = await importDataKey(await unlockKeyring(kr, 'passphrase-123'));

  const a = createStore({ gh, key, author: 'a' });
  const b = createStore({ gh, key, author: 'b' });

  // default doc when missing
  assert.deepEqual((await a.read('posts')).posts, []);

  await a.update('posts', (d) => { d.posts.push(newPost({ caption: 'one' })); });
  // b has a stale head (none loaded yet -> loads fresh). Load b now, then a writes again -> b conflicts and retries.
  await b.read('posts');
  await a.update('posts', (d) => { d.posts.push(newPost({ caption: 'two' })); });
  await b.update('posts', (d) => { d.posts.push(newPost({ caption: 'three' })); });
  await a.refresh();
  const final = await a.read('posts');
  assert.deepEqual(final.posts.map((p) => p.caption), ['one', 'two', 'three']);

  // Ciphertext at rest: raw blob is not JSON and decrypts with the key.
  const file = a.head.files.get('db/posts.enc');
  const raw = mock.gh.blobs.get(file.sha);
  assert.throws(() => JSON.parse(raw.toString('utf8')));
  assert.equal((await decryptJSON(key, new Uint8Array(raw))).posts.length, 3);

  // Bytes + public + delete in one transaction.
  await a.transact(async (tx) => {
    tx.writeBytes('media/x', new Uint8Array([1, 2, 3]));
    tx.writePublic('public/bio.json', { hello: 'world' });
  });
  assert.deepEqual([...(await a.readBytes('media/x'))], [1, 2, 3]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await a.readBytes('public/bio.json', { decrypt: false }))), { hello: 'world' });
  assert.equal((await a.read('bio')).hello, 'world');
  await a.transact(async (tx) => tx.delete('media/x'));
  assert.equal(await a.readBytes('media/x'), null);

  // No-op transaction makes no commit.
  const before = a.head.commit;
  await a.transact(async (tx) => { await tx.read('posts'); });
  assert.equal(a.head.commit, before);
});

test('store: gives up with ConflictError when the branch never stops moving', async (t) => {
  const mock = await startMockGitHub({ owner: 'o', repo: 'r' });
  t.after(() => mock.close());
  const gh = createGitHub({ owner: 'o', repo: 'r', token: 't', apiBase: mock.apiBase });
  const dk = generateDataKey();
  await createDataBranch(gh, await createKeyring('passphrase-123', dk, 1000));
  const key = await importDataKey(dk);
  const a = createStore({ gh, key });
  const other = createStore({ gh, key });
  await assert.rejects(
    a.transact(async (tx) => {
      await other.update('log', (d) => { d.entries.push({ at: 'x' }); });
      tx.write('posts', { v: 1, posts: [] });
    }, { retries: 2 }),
    ConflictError,
  );
});

test('passphrase strength rules', async () => {
  const { passphraseProblem } = await import('../../core/crypto.js');
  for (const weak of ['short', 'password1234', 'instagram2026!', 'aaaaaaaaaaaaaa', 'abcabcabcabc', 'lowercaseonly']) assert.ok(passphraseProblem(weak), weak);
  for (const ok of ['blue harbour morning ferry', 'correct horse battery staple', 'Tr0ub4dor&3xyz', 'averylongsingleword']) assert.equal(passphraseProblem(ok), null, ok);
});

async function freshStore(t) {
  const mock = await startMockGitHub({ owner: 'o', repo: 'r' });
  t.after(() => mock.close());
  const gh = createGitHub({ owner: 'o', repo: 'r', token: 't', apiBase: mock.apiBase });
  const dk = generateDataKey();
  await createDataBranch(gh, await createKeyring('passphrase-123', dk, 1000));
  return { mock, gh, key: await importDataKey(dk) };
}

test('store: a conflict retry reuses uploaded byte blobs instead of encrypting and uploading them again', async (t) => {
  const { gh, key } = await freshStore(t);
  const sizes = [];
  const counted = { ...gh, createBlob: (bytes) => (sizes.push(bytes.length), gh.createBlob(bytes)) };
  const a = createStore({ gh: counted, key });
  const other = createStore({ gh, key });
  await a.read('library');
  const big = new Uint8Array(300_000).fill(7);
  let attempts = 0;
  await a.transact(async (tx) => {
    attempts++;
    if (attempts === 1) await other.update('log', (d) => { d.entries.push({ at: 'x' }); });
    tx.writeBytes('media/big', big);
    tx.write('library', await tx.read('library'));
  });
  assert.equal(attempts, 2);
  assert.equal(sizes.filter((n) => n > 250_000).length, 1, 'the large blob is uploaded once');
  assert.deepEqual(await a.readBytes('media/big'), big);
});

test('store: a refresh that resolves after our own commit does not roll the head back', { timeout: 15_000 }, async (t) => {
  const { gh, key } = await freshStore(t);
  let gate = null;
  let readStarted;
  const slow = {
    ...gh,
    async getRef(branch) {
      const ref = await gh.getRef(branch);
      if (gate) {
        const g = gate;
        gate = null;
        readStarted();
        await g;
      }
      return ref;
    },
  };
  const changes = [];
  const a = createStore({ gh: slow, key, onChange: (paths) => changes.push(paths) });
  await a.update('posts', (d) => { d.posts.push(newPost({ caption: 'one' })); });
  let release;
  gate = new Promise((r) => (release = r));
  const started = new Promise((r) => (readStarted = r));
  const pending = a.refresh(); // reads the ref (our first commit), then stalls
  await started;
  await a.update('posts', (d) => { d.posts[0].caption = 'two'; });
  const committed = a.head.commit;
  release();
  await pending;
  assert.equal(a.head.commit, committed);
  assert.equal((await a.read('posts')).posts[0].caption, 'two');
  assert.equal(changes.length, 2, 'no change event reverts the edit');

  // A ref read that lags behind our own write (it still returns the commit we just replaced) is ignored too.
  const previous = committed;
  await a.update('posts', (d) => { d.posts[0].caption = 'three'; });
  slow.getRef = async () => previous;
  await a.refresh();
  assert.equal((await a.read('posts')).posts[0].caption, 'three');
});

test('blob cache: byte-capped LRU, large blobs stay out of memory, stuck persistence counts as a miss', { timeout: 15_000 }, async () => {
  const { createBlobCache } = await import('../../core/store.js');
  const persisted = new Map();
  const persist = {
    get: async (sha) => persisted.get(sha) || null,
    set: async (sha, bytes) => void persisted.set(sha, bytes),
    delete: async (sha) => void persisted.delete(sha),
  };
  const c = createBlobCache({ persist, maxMemBytes: 100, maxItemBytes: 60, persistMaxBytes: 80 });
  const b = (n, v = n) => new Uint8Array(n).fill(v);
  await c.set('a', b(40));
  await c.set('b', b(40));
  await c.get('a'); // a is now the most recently used
  await c.set('c', b(40)); // over 100 bytes: evicts b, not a
  persisted.clear();
  assert.ok(await c.get('a'));
  assert.ok(await c.get('c'));
  assert.equal(await c.get('b'), null);
  await c.set('big', b(70)); // too big for memory, small enough to persist
  assert.ok(persisted.has('big'));
  persisted.delete('big');
  assert.equal(await c.get('big'), null, 'a large blob is not kept in memory');
  await c.set('huge', b(90)); // too big to persist as well
  assert.equal(persisted.has('huge'), false);
  persisted.set('a', b(1));
  await c.forget('a');
  assert.equal(persisted.has('a'), false);
  assert.equal(await c.get('a'), null);

  const stuck = createBlobCache({ persist: { get: () => new Promise(() => {}), set: () => new Promise(() => {}) }, persistTimeoutMs: 50 });
  await stuck.set('x', b(3)); // does not wait for the stuck store
  assert.equal(await stuck.get('y'), null);
});

test('store: keeps only the latest parsed version of each document and drops superseded blobs', async (t) => {
  const { gh, key } = await freshStore(t);
  const { createBlobCache } = await import('../../core/store.js');
  const inner = createBlobCache();
  const forgotten = [];
  const cache = { ...inner, forget: async (sha) => (forgotten.push(sha), inner.forget(sha)) };
  const a = createStore({ gh, key, cache });
  await a.update('posts', (d) => { d.posts.push(newPost({ caption: 'one' })); });
  const first = a.head.files.get('db/posts.enc').sha;
  await a.update('posts', (d) => { d.posts.push(newPost({ caption: 'two' })); });
  assert.ok(forgotten.includes(first));
  assert.deepEqual((await a.read('posts')).posts.map((p) => p.caption), ['one', 'two']);
});

test('media: deleting keeps files that failed posts and queue items still use', async (t) => {
  const { gh, key } = await freshStore(t);
  const { initData, stopData } = await import('../../js/data.js');
  const { deleteAssets } = await import('../../js/media.js');
  const store = createStore({ gh, key });
  initData(store);
  t.after(() => stopData());
  const asset = (id) => ({ id, kind: 'image', path: `media/${id}`, thumbPath: `media/${id}.thumb` });
  await store.transact(async (tx) => {
    for (const id of ['free', 'failed', 'queued', 'published']) {
      tx.writeBytes(`media/${id}`, new Uint8Array([1]));
      tx.writeBytes(`media/${id}.thumb`, new Uint8Array([2]));
    }
    tx.write('library', { v: 1, assets: ['free', 'failed', 'queued', 'published'].map(asset), folders: [] });
    tx.write('posts', { v: 1, posts: [
      { ...newPost({ caption: 'f' }), status: 'failed', media: [{ assetId: 'failed' }] },
      { ...newPost({ caption: 'p' }), status: 'published', media: [{ assetId: 'published' }] },
    ] });
    tx.write('lists', { v: 1, lists: [{ id: 'l1', name: 'Q', items: [{ id: 'i1', media: [{ assetId: 'queued' }] }] }] });
  });
  const { removed, kept } = await deleteAssets(['free', 'failed', 'queued', 'published']);
  assert.deepEqual(removed.sort(), ['free', 'published']);
  assert.deepEqual(kept.sort(), ['failed', 'queued']);
  assert.equal(await store.exists('media/queued'), true);
  assert.equal(await store.exists('media/free'), false);
});

test('media: object URLs are read a few at a time and least recently used ones are revoked unless shown', async (t) => {
  const { initData, stopData } = await import('../../js/data.js');
  const { mediaUrl, onMediaUrlRevoked, trimMediaUrls } = await import('../../js/media.js');
  let inFlight = 0;
  let peak = 0;
  initData({
    refresh: async () => {},
    async readBytes(path) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return new Uint8Array([path.length]);
    },
  });
  const revoked = [];
  const off = onMediaUrlRevoked((path) => revoked.push(path));
  const realDoc = globalThis.document;
  t.after(() => {
    off();
    stopData();
    globalThis.document = realDoc;
  });
  const urls = await Promise.all(Array.from({ length: 320 }, (_, i) => mediaUrl(`media/t${i}.thumb`)));
  assert.ok(peak <= 4, `at most 4 reads at once (saw ${peak})`);
  assert.equal(new Set(urls).size, 320);
  // t0 is still shown on the page, t1 was used again recently: both survive the trim.
  globalThis.document = { querySelectorAll: () => [{ getAttribute: (a) => (a === 'src' ? urls[0] : null) }] };
  assert.equal(await mediaUrl('media/t1.thumb'), urls[1]);
  trimMediaUrls();
  assert.equal(revoked.length, 20);
  assert.ok(!revoked.includes('media/t0.thumb') && !revoked.includes('media/t1.thumb'));
  assert.ok(revoked.includes('media/t2.thumb'));
  assert.equal(await mediaUrl('media/t0.thumb'), urls[0], 'a URL still shown is kept');
  assert.notEqual(await mediaUrl('media/t2.thumb'), urls[2], 'a revoked URL is read again');
});
