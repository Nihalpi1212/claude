import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startDevServer, safePath, openDataKeySecret, REPO_ROOT } from '../../dev/server.mjs';
import { DEMO_PASSPHRASE } from '../../dev/seed.mjs';
import { createGitHub } from '../../core/github.js';
import { createStore, readKeyring } from '../../core/store.js';
import { b64encode, importDataKey, unlockKeyring } from '../../core/crypto.js';
import { hasErrors, validatePost } from '../../core/model.js';

test('dev server: seeded demo workspace, static files, secret and dispatch', async (t) => {
  const dev = await startDevServer({ port: 0, seed: true, quiet: true });
  t.after(() => dev.close());

  const index = await fetch(`${dev.url}/postpilot/index.html`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  const js = await fetch(`${dev.url}/postpilot/core/model.js`);
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${dev.url}/postpilot/core/`)).status, 404, 'no directory listing');
  assert.equal((await fetch(`${dev.url}/.git/HEAD`)).status, 404, 'dot-files are never served');
  const root = await fetch(`${dev.url}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);

  // Unlock the demo workspace like the app does.
  const gh = createGitHub({ token: 'anything', owner: 'demo', repo: 'postpilot', apiBase: `${dev.url}/mock/gh` });
  const raw = await unlockKeyring(await readKeyring(gh), DEMO_PASSPHRASE);
  const store = createStore({ gh, key: await importDataKey(raw) });
  const { settings, posts, library, automations, lists, log } = await store.readMany(['settings', 'posts', 'library', 'automations', 'lists', 'log']);
  assert.equal(settings.timezone, 'America/New_York');
  assert.equal(settings.ig.mode, 'instagram');
  assert.equal(settings.ig.username, dev.graph.state.username);
  const manual = posts.posts.filter((p) => p.source !== 'evergreen');
  assert.ok(manual.length >= 12, `about a dozen demo posts (${manual.length})`);
  for (const s of ['draft', 'scheduled', 'published', 'failed']) assert.ok(posts.posts.some((p) => p.status === s), `has a ${s} post`);
  const assets = new Map(library.assets.map((a) => [a.id, a]));
  for (const p of posts.posts.filter((x) => x.status === 'scheduled')) assert.ok(!hasErrors(validatePost(p, assets)), `scheduled post "${p.caption.slice(0, 20)}" is valid`);
  assert.ok(library.assets.length >= 14);
  assert.ok(await store.exists(library.assets[0].thumbPath), 'thumbnails stored');
  assert.equal(automations.rules.length, 2);
  assert.equal(lists.lists.length, 1);
  assert.ok(log.runs.length >= 1, 'the first worker run happened during seeding');

  // The Actions secret holds the data key, sealed with the dev server's key pair.
  const secret = dev.gh.secrets.get('POSTPILOT_DATA_KEY');
  assert.equal(openDataKeySecret(secret, dev.keyPair), b64encode(raw));

  // "Run worker" in the app: workflow_dispatch runs the worker in-process.
  await gh.dispatchWorkflow('postpilot-worker.yml', 'main', { reason: 'Publish now' });
  let runs;
  for (let i = 0; i < 100; i++) {
    runs = await gh.listWorkflowRuns('postpilot-worker.yml');
    if (runs[0] && runs[0].status === 'completed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(runs[0].conclusion, 'success');
  await store.refresh();
  const after = await store.read('log');
  assert.equal(after.runs[0].trigger, 'workflow_dispatch');
  assert.equal(after.runs[0].reason, 'Publish now');
});

test('safePath refuses traversal and dot-files', () => {
  const root = REPO_ROOT;
  assert.equal(safePath(root, '/postpilot/index.html'), path.join(root, 'postpilot', 'index.html'));
  assert.equal(safePath(root, '/postpilot/../../etc/passwd'), null);
  assert.equal(safePath(root, '/postpilot/%2e%2e/%2e%2e/etc/passwd'), null);
  assert.equal(safePath(root, '/.git/config'), null);
  assert.equal(safePath(root, '/postpilot/%00x'), null);
  assert.equal(safePath(root, '/%E0%A4%A'), null);
});
