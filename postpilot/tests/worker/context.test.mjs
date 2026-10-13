// Worker context helpers: links third parties pick (guardLinks), GitHub write pacing, and the
// plaintext copies exposed for Instagram (metadata stripped, one branch rewrite for copies made together).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureBytes, startWorkerEnv } from '../helpers/worker-env.mjs';
import { createContext, guardLinks, isPrivateAddress, paceWrites, TMP_BRANCH } from '../../worker/context.mjs';
import { fetchCapped, FetchError } from '../../worker/jobs/feeds.mjs';
import { newAsset } from '../../core/model.js';

test('isPrivateAddress: loopback, private, link-local, CGNAT, multicast and IPv4 inside IPv6; public addresses pass', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.5', '198.18.0.1',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::10.0.0.1', '64:ff9b::a9fe:a9fe', '2002:c0a8:101::1', '2001:db8::1', 'localhost', 'not an ip']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '169.255.0.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:93.184.216.34', '2002:5db8:d822::1']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('guardLinks: private addresses, redirects to them and odd ports are refused; public links and redirects work', async () => {
  const dns = { 'blog.example': ['93.184.216.34'], 'cdn.example': ['2606:4700:4700::1111'], 'home.example': ['192.168.1.20'], 'mixed.example': ['93.184.216.35', '10.0.0.7'], localhost: ['127.0.0.1', '::1'] };
  const lookup = async (host) => {
    if (!dns[host]) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return dns[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  const calls = [];
  const routes = {
    'https://blog.example/feed.xml': () => new Response('<rss/>', { status: 200 }),
    'https://blog.example/img': () => new Response(null, { status: 302, headers: { Location: 'https://cdn.example/a.jpg' } }),
    'https://cdn.example/a.jpg': () => new Response('jpeg', { status: 200 }),
    'https://blog.example/camera': () => new Response(null, { status: 302, headers: { Location: 'http://192.168.1.20/snapshot.jpg' } }),
    'https://blog.example/metadata': () => new Response(null, { status: 301, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } }),
    'https://blog.example/home': () => new Response(null, { status: 307, headers: { Location: 'https://home.example/x.jpg' } }),
    'https://blog.example/loop': () => new Response(null, { status: 302, headers: { Location: '/loop' } }),
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, redirect: init.redirect });
    const route = routes[url];
    return route ? route() : new Response('nope', { status: 404 });
  };
  const fetchLinks = guardLinks(fetchImpl, { lookup });
  const ok = await fetchLinks('https://blog.example/feed.xml', { redirect: 'follow' });
  assert.equal(ok.status, 200);
  assert.equal(calls[0].redirect, 'manual', 'redirects are followed by the guard, not by fetch');
  const followed = await fetchLinks('https://blog.example/img');
  assert.equal(await followed.text(), 'jpeg');
  const refused = async (url, pattern) => {
    const before = calls.length;
    await assert.rejects(fetchLinks(url), (err) => err.blocked === true && pattern.test(err.message), url);
    return calls.slice(before).map((c) => c.url);
  };
  const local = /private or local network address/;
  assert.deepEqual(await refused('http://127.0.0.1:80/admin', local), []);
  assert.deepEqual(await refused('http://localhost/', local), []);
  assert.deepEqual(await refused('http://[::1]/', local), []);
  assert.deepEqual(await refused('http://[::ffff:a9fe:a9fe]/', local), []);
  assert.deepEqual(await refused('https://mixed.example/a.jpg', local), [], 'one private address is enough');
  assert.deepEqual(await refused('https://blog.example/camera', local), ['https://blog.example/camera'], 'the camera is never asked');
  assert.deepEqual(await refused('https://blog.example/metadata', local), ['https://blog.example/metadata']);
  assert.deepEqual(await refused('https://blog.example/home', local), ['https://blog.example/home']);
  assert.deepEqual(await refused('https://blog.example:8443/feed.xml', /port 8443/), []);
  assert.equal((await refused('https://blog.example/loop', /redirects too many times/)).length, 6);
  await assert.rejects(fetchLinks('https://nowhere.example/'), (err) => err.code === 'ENOTFOUND' && !err.blocked);

  // Through fetchCapped (the feeds job): a refused link is a lasting error with the reason.
  await assert.rejects(
    fetchCapped(fetchLinks, 'https://blog.example/camera', { maxBytes: 100, timeoutMs: 1000 }),
    (err) => err instanceof FetchError && err.code === 'blocked' && !err.transient && /private or local network address/.test(err.message),
  );
  await assert.rejects(fetchCapped(fetchLinks, 'https://nowhere.example/', { maxBytes: 100, timeoutMs: 1000 }), (err) => err.transient && /could not be found/.test(err.message));
});

test('the worker refuses linked files on its own network unless POSTPILOT_ALLOW_PRIVATE_LINKS is set (dev server)', async (t) => {
  const env = await startWorkerEnv({ connect: false });
  t.after(() => env.close());
  // The test server listens on 127.0.0.1: an "internal" host from the worker's point of view.
  await env.update('library', (d) => {
    d.assets.push(newAsset({ id: 'a_lan', name: 'snapshot.jpg', importUrl: `${env.url}/fixtures/f01.jpg` }));
  });
  const first = await env.run({ only: ['feeds'] });
  assert.equal(first.summary.jobs.feeds.downloadFailed, 1);
  let a = (await env.read('library')).assets.find((x) => x.id === 'a_lan');
  assert.match(a.importError, /private or local network address/);
  assert.equal(a.importErrorCode, 'blocked');
  // "Try again" with the dev server's setting: downloaded.
  await env.update('library', (d) => void delete d.assets.find((x) => x.id === 'a_lan').importError);
  const second = await env.run({ only: ['feeds'], env: { POSTPILOT_ALLOW_PRIVATE_LINKS: '1' } });
  assert.equal(second.summary.jobs.feeds.downloaded, 1);
  a = (await env.read('library')).assets.find((x) => x.id === 'a_lan');
  assert.equal(a.importUrl, undefined);
});

test('paceWrites: at most perMinute content-creating requests in any minute; reads never wait', async () => {
  let t = 0;
  const waits = [];
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push([url, init.method || 'GET', t]);
    return new Response('{}');
  };
  const f = paceWrites(fetchImpl, { perMinute: 3, now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
  for (let i = 0; i < 5; i++) await f(`/w${i}`, { method: i % 2 ? 'PATCH' : 'POST' });
  await f('/r', { method: 'GET' });
  await f('/r2');
  assert.deepEqual(sent.map(([u, , at]) => [u, at > 0]), [['/w0', false], ['/w1', false], ['/w2', false], ['/w3', true], ['/w4', true], ['/r', true], ['/r2', true]]);
  assert.ok(sent[3][2] >= 60_000 && sent[4][2] >= 60_000, 'the 4th and 5th write wait until the first ones are a minute old');
  assert.equal(waits.length, 1);
  // Concurrent writes queue up in order.
  t = 0;
  sent.length = 0;
  const g = paceWrites(fetchImpl, { perMinute: 2, now: () => t, sleep: async (ms) => { t += ms; } });
  await Promise.all([1, 2, 3, 4].map((i) => g(`/c${i}`, { method: 'POST' })));
  assert.deepEqual(sent.map(([u]) => u), ['/c1', '/c2', '/c3', '/c4']);
  assert.ok(sent[2][2] >= 60_000);
});

test('exposed copies: downloaded photos lose trailing data; copies exposed together share one branch rewrite', async (t) => {
  const env = await startWorkerEnv({ connect: false });
  t.after(() => env.close());
  // A photo the worker stored before stripping cut what follows the image: a motion-photo trailer.
  const photo = await fixtureBytes('f05.jpg');
  const trailer = Buffer.from('....ftypisomMotionPhoto_Data GPS 40.7128 N');
  const stored = new Uint8Array([...photo, ...trailer]);
  const downloaded = newAsset({ id: 'a_dl', name: 'from-link.jpg', thumbPath: 'media/a_dl', path: 'media/a_dl', sourceUrl: 'https://blog.example/a.jpg' });
  await env.store.transact(async (tx) => {
    tx.writeBytes(downloaded.path, stored);
    const lib = await tx.read('library');
    lib.assets.push(downloaded);
    tx.write('library', lib);
  });
  const others = [await env.addAsset('f01.jpg'), await env.addAsset('f02.jpg'), await env.addAsset('f03.jpg')];
  const ctx = await createContext({ env: env.env, consoleLog: () => {} });
  const blobOf = (path) => {
    const tree = env.ghMock.trees.get(env.ghMock.commits.get(env.ghMock.refs.get(TMP_BRANCH)).tree);
    return env.ghMock.blobs.get(tree.get(path));
  };
  const one = await ctx.exposeMedia(downloaded);
  const copy = blobOf(one.path);
  assert.equal(copy.length, photo.length, 'only the image itself');
  assert.ok(!copy.includes('MotionPhoto') && !copy.includes('GPS'));
  assert.deepEqual([...copy.subarray(-2)], [0xff, 0xd9]);

  const rewrites = () => [...env.ghMock.commits.values()].filter((c) => c.message === 'Temporary media for Instagram').length;
  const before = rewrites();
  const exposed = await Promise.all(others.map((a) => ctx.exposeMedia(a)));
  assert.ok(rewrites() - before <= 2, `copies made together share rewrites (${rewrites() - before})`);
  for (const [i, e] of exposed.entries()) assert.deepEqual(blobOf(e.path), Buffer.from(await fixtureBytes(`f0${i + 1}.jpg`)), 'every copy is on the branch');
  assert.ok(blobOf(one.path), 'earlier copies stay');
});
