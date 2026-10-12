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
