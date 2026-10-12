// js/session.js rotateDataKey against the mock GitHub (no browser storage in Node: those calls are no-ops).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockGitHub } from '../helpers/servers.mjs';
import { createGitHub } from '../../core/github.js';
import { createDataBranch, createStore, readKeyring } from '../../core/store.js';
import { b64decode, b64encode, createKeyring, decryptBytes, DecryptError, fromUtf8, generateDataKey, importDataKey, unlockKeyring, WrongPassphraseError } from '../../core/crypto.js';
import { newPost } from '../../core/model.js';
import { rotateDataKey } from '../../js/session.js';

globalThis.self = globalThis.self || globalThis; // the sealed-box bundle expects `self` (as in dev/server.mjs)
const { boxKeyPair, sealedBoxOpen } = await import('../../vendor/sealed-box.js');

async function workspace(t) {
  const keyPair = boxKeyPair();
  const mock = await startMockGitHub({ owner: 'o', repo: 'r', secretsKeyPair: keyPair });
  t.after(() => mock.close());
  const gh = createGitHub({ owner: 'o', repo: 'r', token: 't', apiBase: mock.apiBase });
  const dataKeyRaw = generateDataKey();
  await createDataBranch(gh, await createKeyring('old passphrase words', dataKeyRaw, 1000));
  const key = await importDataKey(dataKeyRaw);
  const store = createStore({ gh, key });
  await store.transact(async (tx) => {
    const posts = await tx.read('posts');
    posts.posts.push(newPost({ caption: 'secret caption' }));
    tx.write('posts', posts);
    const settings = await tx.read('settings');
    settings.timezone = 'Europe/Berlin';
    tx.write('settings', settings);
    tx.writeBytes('media/a1', new Uint8Array([1, 2, 3, 4]));
    tx.writeBytes('media/a1.thumb', new Uint8Array([9, 8, 7]));
    tx.writePublic('public/bio.json', { title: 'hello' });
  });
  const session = { gh, store, key, dataKeyRaw, owner: 'o', repo: 'r', branch: 'postpilot-data', token: 't', login: 'o' };
  return { mock, gh, store, key, session, keyPair };
}

async function rawFile(gh, path) {
  const c = await gh.getCommit(await gh.getRef('postpilot-data'));
  const f = (await gh.getTree(c.tree.sha)).find((e) => e.path === path);
  return f ? gh.getBlob(f.sha) : null;
}

test('rotateDataKey re-encrypts every private file with a new key in one commit and re-seals the worker secret', async (t) => {
  const { mock, gh, key, session, keyPair } = await workspace(t);
  const before = await gh.getRef('postpilot-data');
  const progress = [];

  const res = await rotateDataKey(session, 'a brand new passphrase', { onProgress: (p) => progress.push(p) });
  assert.equal(res.secretSaved, true);
  assert.equal(res.dataKeyRaw.length, 32);
  assert.notDeepEqual([...res.dataKeyRaw], [...session.dataKeyRaw]);

  // One commit on top of the previous head.
  const head = await gh.getRef('postpilot-data');
  const commit = await gh.getCommit(head);
  assert.deepEqual(commit.parents.map((p) => p.sha), [before]);
  assert.match(commit.message, /rotate data key/);

  // keyring.json: the new passphrase gives the new key; the old passphrase no longer works.
  const kr = await readKeyring(gh);
  assert.deepEqual([...(await unlockKeyring(kr, 'a brand new passphrase'))], [...res.dataKeyRaw]);
  await assert.rejects(unlockKeyring(kr, 'old passphrase words'), WrongPassphraseError);

  // Every document and media file decrypts with the new key only, with the same content.
  const newKey = await importDataKey(res.dataKeyRaw);
  const fresh = createStore({ gh, key: newKey });
  assert.equal((await fresh.read('posts')).posts[0].caption, 'secret caption');
  assert.equal((await fresh.read('settings')).timezone, 'Europe/Berlin');
  assert.deepEqual([...(await fresh.readBytes('media/a1'))], [1, 2, 3, 4]);
  assert.deepEqual([...(await fresh.readBytes('media/a1.thumb'))], [9, 8, 7]);
  for (const path of ['db/posts.enc', 'db/settings.enc', 'media/a1', 'media/a1.thumb']) {
    await assert.rejects(decryptBytes(key, await rawFile(gh, path)), DecryptError, `${path} no longer opens with the old key`);
  }
  // Public files are untouched plaintext.
  assert.deepEqual(JSON.parse(fromUtf8(await rawFile(gh, 'public/bio.json'))), { title: 'hello' });
  assert.deepEqual(progress.at(-1), { done: 4, total: 4 });

  // The worker's secret holds the new key as base64 text, sealed to the repository key.
  const secret = mock.gh.secrets.get('POSTPILOT_DATA_KEY');
  const opened = sealedBoxOpen(b64decode(secret.encrypted_value), keyPair.publicKey, keyPair.secretKey);
  assert.equal(fromUtf8(opened), b64encode(res.dataKeyRaw));
});

test('rotateDataKey changes nothing when the token cannot update Actions secrets', async (t) => {
  const { gh, session } = await workspace(t);
  const before = await gh.getRef('postpilot-data');
  const denied = {
    ...gh,
    getSecretsPublicKey: async () => {
      throw Object.assign(new Error('Resource not accessible by personal access token'), { status: 403 });
    },
  };
  await assert.rejects(rotateDataKey({ ...session, gh: denied }, 'a brand new passphrase'), /Secrets: Read and write/);
  assert.equal(await gh.getRef('postpilot-data'), before);
  assert.deepEqual([...(await unlockKeyring(await readKeyring(gh), 'old passphrase words'))], [...session.dataKeyRaw]);
});
