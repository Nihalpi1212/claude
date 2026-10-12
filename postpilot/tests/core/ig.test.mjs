import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startServer } from '../helpers/servers.mjs';
import { createMockGraph } from '../../dev/mock-graph.mjs';
import { createIg, connectInstagram, describeIgError, IgError, GRAPH_VERSION } from '../../core/ig.js';
import { addDaysKey, dayKey } from '../../core/time.js';

const FIXTURES = new URL('../../dev/fixtures/', import.meta.url);

async function serveFixture(req, res, path) {
  try {
    const name = path.split('?')[0].replace(/^\/+/, '');
    if (!/^[\w.-]+$/.test(name)) throw new Error('bad name');
    const bytes = await readFile(new URL(name, FIXTURES));
    res.writeHead(200, { 'Content-Type': name.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg' });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
  return true;
}

async function setup(t, opts = {}) {
  const graph = createMockGraph({ imageProcessingMs: 30, videoProcessingMs: 60, fixturesPath: '/fixtures', ...opts });
  const srv = await startServer({
    '/mock/ig': (req, res, path, body, url) => graph.handle(req, res, path, body, url),
    '/mock/fb': (req, res, path, body, url) => graph.handle(req, res, path, body, url),
    '/mock/rupload': (req, res, path, body) => graph.handleRupload(req, res, path, body),
    '/fixtures': serveFixture,
  });
  t.after(() => srv.close());
  const bases = { igBase: `${srv.url}/mock/ig`, fbBase: `${srv.url}/mock/fb`, ruploadBase: `${srv.url}/mock/rupload` };
  const ig = createIg({ token: 'tok', ...bases, retryDelayMs: 1 });
  return { graph, srv, bases, ig };
}

const count = (graph, method, re) => graph.state.requests.filter((r) => r.method === method && re.test(r.path)).length;

test('GRAPH_VERSION is pinned to v26.0', () => {
  assert.equal(GRAPH_VERSION, 'v26.0');
});

test('me() returns the professional account and falls back when optional fields fail', async (t) => {
  const { graph, ig } = await setup(t);
  const me = await ig.me();
  assert.equal(me.username, 'studio.north');
  assert.equal(me.userId, graph.state.userId);
  assert.equal(me.id, graph.state.appScopedId);
  assert.equal(me.followersCount, 4820);
  assert.equal(me.accountType, 'BUSINESS');
  assert.ok(me.biography);
  assert.equal(ig.userId, graph.state.userId);

  graph.state.faults.push({ method: 'GET', path: /\/me$/, times: 1, error: { status: 400, code: 100, message: '(#100) Tried accessing nonexisting field (biography) on node type (User)' } });
  const me2 = await ig.me();
  assert.equal(me2.username, 'studio.north');
  assert.equal(me2.biography, null);
  const last = graph.state.requests.filter((r) => r.path.endsWith('/me')).at(-1);
  assert.ok(!last.params.fields.includes('biography'));
});

test('listMedia follows paging.next and normalizes media', async (t) => {
  const { graph, ig } = await setup(t);
  const media = await ig.listMedia({ limit: 25, max: 60 });
  assert.equal(media.length, 60);
  assert.equal(count(graph, 'GET', /\/media$/), 3);
  for (let i = 1; i < media.length; i++) assert.ok(media[i - 1].timestamp >= media[i].timestamp, 'newest first');
  const ids = new Set(media.map((m) => m.id));
  assert.equal(ids.size, 60);
  const reel = media.find((m) => m.mediaType === 'VIDEO');
  assert.equal(reel.productType, 'REELS');
  assert.ok(reel.thumbnailUrl);
  assert.match(reel.permalink, /instagram\.com\/reel\//);
  const album = media.find((m) => m.mediaType === 'CAROUSEL_ALBUM');
  assert.ok(album.children.length >= 2);
  assert.ok(album.children[0].mediaUrl.endsWith('.jpg'));
  assert.equal(typeof media[0].likeCount, 'number');
  assert.equal(typeof media[0].commentsCount, 'number');
  assert.ok(media[0].shortcode);

  const all = await ig.listMedia({ limit: 50, max: 500 });
  assert.equal(all.length, 70);
});

test('mediaInsights drops metrics the API rejects and remembers them', async (t) => {
  const { graph, ig } = await setup(t);
  const media = await ig.listMedia({ max: 70 });
  const albums = media.filter((m) => m.mediaType === 'CAROUSEL_ALBUM');
  const first = await ig.mediaInsights(albums[0]);
  assert.ok(first.reach > 0);
  assert.ok(first.saved >= 0);
  assert.equal(first.reposts, undefined, 'reposts unsupported for carousels in the mock');
  assert.ok(ig.unsupportedMetrics.has('media-CAROUSEL_ALBUM:reposts'));
  const before = count(graph, 'GET', /\/insights$/);
  await ig.mediaInsights(albums[1]);
  assert.equal(count(graph, 'GET', /\/insights$/) - before, 1, 'second album needs a single call');

  const reel = media.find((m) => m.productType === 'REELS');
  const ri = await ig.mediaInsights(reel);
  assert.ok(ri.avgWatchTimeMs > 0);
  assert.ok(ri.totalWatchTimeMs > 0);
  assert.ok(ri.views >= ri.reach);
  assert.equal(typeof ri.skipRate, 'number');

  // Unclear error: probe metric by metric and still return data.
  const image = media.find((m) => m.mediaType === 'IMAGE');
  graph.state.faults.push({ method: 'GET', path: /\/insights$/, times: 1, error: { status: 400, code: 100, message: '(#100) Invalid parameter' } });
  const ii = await ig.mediaInsights(image);
  assert.ok(ii.reach > 0);
  assert.ok(ii.profileVisits >= 0);

  // Deprecated metric requested directly: all-or-nothing error from the mock.
  await assert.rejects(ig.get(`/${image.id}/insights`, { metric: 'impressions,reach' }), (err) => err instanceof IgError && err.code === 100);
});

test('stories and story insights (navigation breakdown, not enough viewers)', async (t) => {
  const { graph, ig } = await setup(t);
  const stories = await ig.stories();
  assert.equal(stories.length, 3);
  const si = await ig.storyInsights(stories[0].id);
  assert.ok(si.reach > 0);
  assert.ok(si.navigation.tapForward > 0);
  assert.equal(typeof si.navigation.swipeForward, 'number');
  graph.state.stories[0].ins.reach = 2;
  assert.deepEqual(await ig.mediaInsights({ id: graph.state.stories[0].id, mediaType: 'IMAGE', productType: 'STORY' }), {});
});

test('accountDaily returns daily snapshots across chunks and skips days past retention', async (t) => {
  const { ig } = await setup(t);
  const tz = 'Europe/Berlin';
  const today = dayKey(new Date(), tz);
  const untilKey = addDaysKey(today, -1);
  const sinceKey = addDaysKey(today, -40);
  const days = await ig.accountDaily({ sinceKey, untilKey, tz });
  const keys = Object.keys(days).sort();
  assert.equal(keys.length, 40);
  assert.equal(keys[0], sinceKey);
  assert.equal(keys.at(-1), untilKey);
  for (const k of keys) {
    const d = days[k];
    for (const f of ['reach', 'views', 'likes', 'comments', 'shares', 'saves', 'accountsEngaged', 'totalInteractions', 'followsGained', 'unfollows']) {
      assert.equal(typeof d[f], 'number', `${k}.${f}`);
    }
  }
  assert.ok(days[untilKey].reach > 100);

  const old = await ig.accountDaily({ sinceKey: addDaysKey(today, -100), untilKey: addDaysKey(today, -95), tz });
  assert.deepEqual(old, {});
});

test('onlineFollowers converts Pacific hours into the requested zone', async (t) => {
  const { ig } = await setup(t);
  const of = await ig.onlineFollowers({ tz: 'America/New_York' });
  assert.equal(of.byHour.length, 24);
  assert.ok(of.days >= 28);
  assert.equal(of.tz, 'America/New_York');
  const peak = of.byHour.indexOf(Math.max(...of.byHour));
  assert.ok(peak >= 18 && peak <= 22, `peak at ${peak}`);
  assert.equal(of.byWeekdayHour.length, 7);
  assert.equal(of.byWeekdayHour[3].length, 24);
});

test('demographics returns sorted breakdowns', async (t) => {
  const { ig } = await setup(t);
  const demo = await ig.demographics();
  assert.ok(demo.follower.age.length >= 5);
  assert.ok(demo.follower.age[0].value >= demo.follower.age[1].value);
  assert.ok(demo.follower.country.some((r) => r.key === 'US'));
  assert.ok(demo.engaged.gender.length === 3);

  const small = await setup(t, { followers: 60 });
  const d2 = await small.ig.demographics();
  assert.equal(d2.follower, null);
});

test('comments: list with replies, reply, hide, unhide, delete', async (t) => {
  const { graph, ig } = await setup(t);
  const [recent] = await ig.listMedia({ max: 1 });
  const comments = await ig.comments(recent.id);
  assert.ok(comments.length >= 3);
  const c = comments.find((x) => !x.hidden);
  assert.ok(c.text && c.username && c.fromId && c.timestamp);
  assert.equal(c.mediaId, recent.id);
  assert.ok(Array.isArray(c.replies));

  const reply = await ig.replyToComment(c.id, 'Thank you!');
  assert.ok(reply.id);
  assert.equal(graph.state.replies.at(-1).text, 'Thank you!');
  const again = await ig.comments(recent.id);
  const withReply = again.find((x) => x.id === c.id);
  assert.ok(withReply.replies.some((r) => r.id === reply.id && r.parentId === c.id && r.username === 'studio.north'));

  await ig.hideComment(c.id);
  assert.ok(graph.state.hidden.has(c.id));
  await assert.rejects(ig.replyToComment(c.id, 'nope'), (err) => err instanceof IgError && err.code === 100);
  await ig.hideComment(c.id, false);
  assert.ok(!graph.state.hidden.has(c.id));

  await ig.deleteComment(c.id);
  assert.ok(graph.state.deleted.includes(c.id));
  assert.ok(!(await ig.comments(recent.id)).some((x) => x.id === c.id));

  await ig.setCommentsEnabled(recent.id, false);
  assert.equal(graph.state.media[0].is_comment_enabled, false);
});

test('conversations, messages, sending and messaging errors', async (t) => {
  const { graph, ig } = await setup(t);
  const convs = await ig.conversations();
  assert.equal(convs.length, 6);
  for (let i = 1; i < convs.length; i++) assert.ok(convs[i - 1].updatedTime >= convs[i].updatedTime);
  const mara = convs.find((c) => c.participants.some((p) => p.username === 'mara.lens'));
  const other = mara.participants.find((p) => p.username === 'mara.lens');
  const msgs = await ig.messages(mara.id);
  assert.equal(msgs[0].fromUsername, 'mara.lens');
  assert.match(msgs[0].text, /custom orders/);
  assert.ok(msgs[0].createdTime > msgs[1].createdTime);
  assert.deepEqual(msgs[1].toIds, [other.id]);

  const sent = await ig.sendMessage(other.id, 'Hi Mara, yes we do!');
  assert.ok(sent.messageId);
  assert.equal(graph.state.sentMessages.length, 1);
  assert.equal((await ig.messages(mara.id))[0].text, 'Hi Mara, yes we do!');
  const img = await ig.sendImage(other.id, 'https://example.com/a.jpg');
  assert.ok(img.messageId);

  const kiko = convs.find((c) => c.participants.some((p) => p.username === 'kiko.studio'));
  const kikoId = kiko.participants.find((p) => p.username === 'kiko.studio').id;
  await assert.rejects(ig.sendMessage(kikoId, 'late'), (err) => {
    assert.ok(err.isOutsideWindow);
    assert.match(err.userMessage, /24 hours/);
    return true;
  });

  graph.state.dmMode = 'disabled';
  await assert.rejects(ig.sendMessage(other.id, 'x'), (err) => err.isDmDisabled && /Allow access to messages/.test(err.userMessage));
  graph.state.dmMode = 'advanced_access';
  await assert.rejects(ig.sendMessage(other.id, 'x'), (err) => err.needsAdvancedAccess && err.isPermission && /Advanced Access/.test(err.userMessage));
});

test('privateReply sends one DM per comment', async (t) => {
  const { graph, ig } = await setup(t);
  const [recent] = await ig.listMedia({ max: 1 });
  const [c] = await ig.comments(recent.id);
  const r = await ig.privateReply(c.id, 'Here is the link you asked for');
  assert.ok(r.messageId);
  assert.equal(graph.state.sentMessages.at(-1).commentId, c.id);
  await assert.rejects(ig.privateReply(c.id, 'again'), (err) => err instanceof IgError && err.code === 100);

  const oldMedia = graph.state.media.at(-1);
  const oldComment = [...graph.state.comments.values()].find((x) => x.mediaId === oldMedia.id);
  await assert.rejects(ig.privateReply(oldComment.id, 'too late'), (err) => err.isOutsideWindow);
});

test('refreshToken swaps the token; expired tokens map to a reconnect message', async (t) => {
  const { graph, ig, bases } = await setup(t);
  const { token, expiresAt } = await ig.refreshToken();
  assert.match(token, /refreshed1$/);
  assert.equal(ig.token, token);
  const days = (Date.parse(expiresAt) - Date.now()) / 864e5;
  assert.ok(days > 59 && days < 61);
  assert.equal(graph.state.tokens.lastRefreshedFrom, 'tok');
  const refreshReq = graph.state.requests.find((r) => r.path === '/refresh_access_token');
  assert.ok(refreshReq, 'refresh endpoint is unversioned');

  const dead = createIg({ token: 'expired-token', ...bases });
  await assert.rejects(dead.me(), (err) => {
    assert.ok(err instanceof IgError);
    assert.equal(err.code, 190);
    assert.equal(err.subcode, 463);
    assert.ok(err.isAuth);
    assert.ok(err.isPermanent);
    assert.match(err.userMessage, /Reconnect Instagram in Settings/);
    assert.equal(describeIgError(err), err.userMessage);
    return true;
  });

  const fb = createIg({ mode: 'facebook', token: 'page-token-1', ...bases });
  await assert.rejects(fb.refreshToken(), (err) => err.code === 'unsupported');
});

test('connectInstagram in both modes; businessDiscovery and hashtags need Facebook Login', async (t) => {
  const { graph, ig, bases } = await setup(t);
  const igConn = await connectInstagram({ mode: 'instagram', token: 'tok', ...bases });
  assert.equal(igConn.mode, 'instagram');
  assert.equal(igConn.userId, graph.state.userId);
  assert.equal(igConn.username, 'studio.north');
  assert.equal(igConn.tokenType, 'ig_long');
  assert.equal(igConn.apiVersion, 'v26.0');
  assert.equal(igConn.tokenExpiresAt, null);

  await assert.rejects(ig.businessDiscovery('atelier.kin'), (err) => {
    assert.equal(err.code, 'unsupported');
    assert.match(err.userMessage, /Facebook Login/);
    return true;
  });
  await assert.rejects(ig.hashtagSearch('ceramics'), (err) => err.code === 'unsupported');

  const fbConn = await connectInstagram({ mode: 'facebook', token: 'user-token', ...bases });
  assert.equal(fbConn.mode, 'facebook');
  assert.equal(fbConn.pageId, graph.state.pageId);
  assert.equal(fbConn.userId, graph.state.userId);
  assert.equal(fbConn.token, 'page-token-1');
  assert.equal(fbConn.pageToken, 'page-token-1');
  assert.equal(fbConn.userToken, 'user-token');
  assert.equal(fbConn.pages.length, 1);
  assert.equal(fbConn.pages[0].pageToken, undefined, 'page tokens are not repeated in the picker list');

  const fb = createIg({ ...bases, mode: 'facebook', token: fbConn.token, userId: fbConn.userId, pageId: fbConn.pageId, pageToken: fbConn.pageToken });
  const bd = await fb.businessDiscovery('@atelier.kin', { mediaLimit: 12 });
  assert.equal(bd.username, 'atelier.kin');
  assert.equal(bd.followersCount, 12480);
  assert.equal(bd.media.length, 12);
  assert.ok(bd.media[0].permalink && bd.media[0].timestamp && typeof bd.media[0].likeCount === 'number');
  await assert.rejects(fb.businessDiscovery('nobody.here'), (err) => err.code === 100 && /could not find @nobody.here/.test(err.userMessage));

  const tagId = await fb.hashtagSearch('#Ceramics');
  assert.ok(tagId);
  const top = await fb.hashtagMedia(tagId, 'top', { limit: 10 });
  assert.equal(top.length, 10);
  assert.ok(top[0].caption.includes('#ceramics'));
  const tagged = await fb.tags();
  assert.ok(tagged.length > 0 && tagged[0].username);

  // Facebook-mode messaging goes through the Page.
  const convs = await fb.conversations();
  assert.equal(convs.length, 6);
  assert.ok(graph.state.requests.some((r) => r.path.endsWith(`/${graph.state.pageId}/conversations`)));
});

test('IgError classification', () => {
  const auth = new IgError('Error validating access token', { code: 190, subcode: 463 });
  assert.ok(auth.isAuth && auth.isPermanent && !auth.isTransient);
  assert.match(auth.userMessage, /Reconnect Instagram/);

  const rate = new IgError('(#4) Application request limit reached', { code: 4 });
  assert.ok(rate.isRateLimit && !rate.isPermanent && !rate.isAuth);
  assert.ok(new IgError('x', { code: 80002 }).isRateLimit);

  const adv = new IgError('(#200) App does not have Advanced Access to instagram_manage_messages permission, and recipient user does not have role on app', { code: 200 });
  assert.ok(adv.needsAdvancedAccess && adv.isPermission && adv.isPermanent);
  assert.ok(!new IgError('(#200) Permissions error', { code: 200 }).needsAdvancedAccess);

  const win = new IgError('(#10) This message is sent outside of allowed window.', { code: 10, subcode: 2534022 });
  assert.ok(win.isOutsideWindow && win.isPermission);
  assert.match(win.userMessage, /24 hours/);

  assert.ok(new IgError('x', { code: 2 }).isTransient);
  assert.ok(new IgError('x', { code: -1 }).isTransient);
  assert.ok(!new IgError('x', { code: -1, subcode: 2207001 }).isTransient);
  assert.ok(new IgError('x', { status: 503 }).isTransient);
  assert.ok(new IgError('x', { code: 'network' }).isTransient);
  assert.ok(new IgError('x', { code: 9, subcode: 2207042 }).isRateLimit);
  assert.ok(new IgError('x', { code: 100, subcode: 2207026 }).isPermanent);
  assert.ok(new IgError('x', { code: 'container_error', permanent: false }).isPermanent === false);
  assert.equal(describeIgError(new Error('plain')), 'plain');
});

test('transient GET errors are retried; creating POSTs are not', async (t) => {
  const { graph, ig } = await setup(t);
  graph.state.faults.push({ method: 'GET', path: /\/me$/, times: 1, error: { status: 500, code: 2, message: 'Service temporarily unavailable' } });
  assert.equal((await ig.me()).username, 'studio.north');

  graph.state.faults.push({ method: 'GET', path: /\/me$/, times: 1, destroy: true });
  assert.equal((await ig.me()).username, 'studio.north');

  const before = count(graph, 'POST', /\/media$/);
  graph.state.faults.push({ method: 'POST', path: /\/media$/, times: 1, error: { status: 500, code: 2, message: 'Service temporarily unavailable' } });
  await assert.rejects(ig.createContainer({ image_url: 'http://example.invalid/x.jpg' }), (err) => err.isTransient && !err.isPermanent);
  assert.equal(count(graph, 'POST', /\/media$/) - before, 1, 'not retried');

  const limit = await ig.publishingLimit();
  assert.deepEqual(limit, { used: 0, total: 100, durationSec: 86400 });
  assert.ok(ig.usage && typeof ig.usage.callCount === 'number');
});

test('network errors: creating POSTs are sent once and flagged maybeSent; reads and unsent requests are retried', async (t) => {
  const { graph, ig } = await setup(t);
  const before = count(graph, 'POST', /\/replies$/);
  graph.state.faults.push({ method: 'POST', path: /\/replies$/, times: 3, destroy: true });
  await assert.rejects(ig.replyToComment('17900000000000001', 'Thank you'), (err) => {
    assert.ok(err instanceof IgError);
    assert.equal(err.code, 'network');
    assert.equal(err.maybeSent, true);
    assert.match(err.userMessage, /may have gone through/);
    return true;
  });
  assert.equal(count(graph, 'POST', /\/replies$/) - before, 1, 'a reply that may have reached Instagram is not resent');
  graph.state.faults.length = 0;

  // Stub transport: every request fails at the socket.
  const calls = [];
  const failing = (code) => async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    throw Object.assign(new TypeError('fetch failed'), code ? { cause: Object.assign(new Error(code), { code }) } : {});
  };
  const stub = (code) => createIg({ token: 'tok', userId: '1784', igBase: 'http://ig.invalid', fetchImpl: failing(code), retryDelayMs: 1 });

  for (const send of [(c) => c.sendMessage('123', 'hi'), (c) => c.publishContainer('999'), (c) => c.post('/555/comments', { message: 'first' })]) {
    calls.length = 0;
    await assert.rejects(send(stub('ECONNRESET')), (err) => err.code === 'network' && err.maybeSent === true);
    assert.equal(calls.length, 1, `${calls[0]} sent once`);
  }

  calls.length = 0;
  await assert.rejects(stub('ECONNRESET').get('/me', { fields: 'id' }), (err) => err.code === 'network' && err.maybeSent === false);
  assert.equal(calls.length, 3, 'reads are retried');

  calls.length = 0;
  await assert.rejects(stub('ECONNREFUSED').replyToComment('1', 'x'), (err) => err.code === 'network' && err.maybeSent === false);
  assert.equal(calls.length, 3, 'a request that never left the machine is safe to retry');
  assert.match(new IgError('x', { code: 'network' }).userMessage, /Could not reach Instagram/);
});

test('an object-level insights error (2108006) is not mistaken for unsupported metrics', async (t) => {
  const { graph, ig } = await setup(t);
  const media = await ig.listMedia({ max: 70 });
  const [old, other] = media.filter((m) => m.mediaType === 'IMAGE');
  const fault = {
    method: 'GET',
    path: new RegExp(`/${old.id}/insights$`),
    error: { status: 400, code: 100, subcode: 2108006, message: '(#100) Media posted before business account conversion' },
  };
  graph.state.faults.push(fault);
  const before = count(graph, 'GET', /\/insights$/);
  assert.deepEqual(await ig.mediaInsights(old), {});
  assert.equal(count(graph, 'GET', /\/insights$/) - before, 1, 'one call, no per-metric probing');
  assert.equal(ig.unsupportedMetrics.size, 0);
  graph.state.faults.length = 0;
  const ok = await ig.mediaInsights(other);
  assert.ok(ok.reach > 0 && ok.likes >= 0, 'other photos still get their metrics');

  // Unknown object-level code-100 error: every metric fails one by one, so nothing is cached.
  graph.state.faults.push({ ...fault, error: { status: 400, code: 100, message: '(#100) Invalid parameter' } });
  await assert.rejects(ig.mediaInsights(old), (err) => err instanceof IgError && err.code === 100);
  assert.equal(ig.unsupportedMetrics.size, 0);
  graph.state.faults.length = 0;
  assert.ok((await ig.mediaInsights(other)).reach > 0);
});

test('connectInstagram (Facebook Login) stores the Page token expiry and refuses short-lived tokens', async (t) => {
  const { graph, bases } = await setup(t);
  const never = await connectInstagram({ mode: 'facebook', token: 'user-token', ...bases });
  assert.equal(never.tokenExpiresAt, null);
  const dbg = graph.state.requests.find((r) => r.path.endsWith('/debug_token'));
  assert.equal(dbg.params.input_token, 'page-token-1');

  const in30Days = Math.floor(Date.now() / 1000) + 30 * 86400;
  graph.state.tokenExpiry['page-token-1'] = in30Days;
  const dated = await connectInstagram({ mode: 'facebook', token: 'user-token', ...bases });
  assert.equal(dated.tokenExpiresAt, new Date(in30Days * 1000).toISOString());

  graph.state.tokenExpiry['page-token-1'] = Math.floor(Date.now() / 1000) + 3600;
  await assert.rejects(connectInstagram({ mode: 'facebook', token: 'user-token', ...bases }), (err) => {
    assert.equal(err.code, 'short_lived');
    assert.match(err.userMessage, /Extend Access Token/);
    return true;
  });

  // debug_token refused: connect anyway.
  delete graph.state.tokenExpiry['page-token-1'];
  graph.state.faults.push({ method: 'GET', path: /\/debug_token$/, times: 1, error: { status: 400, code: 190, message: 'Invalid OAuth access token' } });
  const fallback = await connectInstagram({ mode: 'facebook', token: 'user-token', ...bases });
  assert.equal(fallback.token, 'page-token-1');
  assert.equal(fallback.tokenExpiresAt, null);
});

test('messages(): story replies and story mentions in every reported shape; falls back when the fields are refused', async (t) => {
  const { graph, ig, bases } = await setup(t);
  const convs = await ig.conversations();
  const byUser = (u) => convs.find((c) => c.participants.some((p) => p.username === u));
  for (const shape of ['story', 'reply_to']) {
    graph.state.storyShape = shape;
    const [reply] = await ig.messages(byUser('oak.and.ash').id);
    assert.deepEqual(reply.storyReply, { id: graph.state.stories[0].id, url: reply.storyReply.url }, shape);
    assert.match(reply.storyReply.url, /story01\.jpg$/);
    assert.equal(reply.storyMention, null);
    assert.match(reply.text, /workshop/);
    const [mention, photo] = await ig.messages(byUser('junie.makes').id);
    assert.equal(mention.text, '');
    assert.match(mention.storyMention.url, /story02\.jpg$/);
    assert.equal(mention.storyReply, null);
    assert.equal(photo.storyMention, null, 'an ordinary photo is not a story mention');
    const plain = await ig.messages(byUser('mara.lens').id);
    assert.ok(plain.every((m) => m.storyReply === null && m.storyMention === null));
  }
  assert.ok(graph.state.requests.some((r) => /story,reply_to/.test(r.params.fields || '')));

  // A host without the fields: one refused call, then plain reads for the rest of the client's life.
  graph.state.storyShape = 'none';
  const mark = graph.state.requests.length;
  const msgs = await ig.messages(byUser('oak.and.ash').id);
  assert.match(msgs[0].text, /workshop/);
  assert.equal(msgs[0].storyReply, null);
  assert.equal(ig.storyFieldsRejected, true);
  await ig.messages(byUser('mara.lens').id);
  const reads = graph.state.requests.slice(mark).map((r) => r.params.fields);
  assert.equal(reads.length, 3);
  assert.ok(!/story/.test(reads[2]), 'later reads skip the refused fields');

  // A missing thread (100/33) is an error of its own, not refused fields.
  graph.state.storyShape = 'story';
  const other = createIg({ token: 'tok', igBase: bases.igBase, retryDelayMs: 1 });
  await assert.rejects(other.messages('no-such-thread'), (err) => err.code === 100 && err.subcode === 33);
  assert.equal(other.storyFieldsRejected, false);
});

test('normMessage reads webhook-style story mention attachments', async (t) => {
  const { graph, ig } = await setup(t);
  const convs = await ig.conversations();
  const conv = convs.find((c) => c.participants.some((p) => p.username === 'junie.makes'));
  graph.state.storyShape = 'reply_to';
  const [mention] = await ig.messages(conv.id);
  assert.equal(mention.storyMention.id, null, 'the attachment form carries only the link');
  assert.ok(mention.attachments.some((a) => a.type === 'story_mention'));
});

test('collaboration invites: list, accept, decline, gone and unsupported (both login types)', async (t) => {
  const { graph, ig, bases } = await setup(t);
  const list = await ig.collaborationInvites();
  assert.deepEqual(list.map((i) => i.owner), ['atelier.kin', 'lumen.ceramics']);
  assert.match(list[0].mediaUrl, /f05\.jpg$/);
  assert.match(list[0].caption, /joint mug/);
  const req = graph.state.requests.find((r) => r.path.endsWith('/collaboration_invites'));
  assert.equal(req.params.fields, 'media_id,media_owner_username,caption,media_url');

  assert.deepEqual(await ig.respondCollabInvite(list[0].mediaId, true), { mediaId: list[0].mediaId, accepted: true, success: true });
  assert.deepEqual(await ig.respondCollabInvite(list[1].mediaId, false), { mediaId: list[1].mediaId, accepted: false, success: true });
  assert.deepEqual(graph.state.collabResponses.map((r) => r.accept), [true, false]);
  assert.deepEqual(await ig.collaborationInvites(), []);
  // Answering again: the invite is gone (not "unsupported").
  await assert.rejects(ig.respondCollabInvite(list[0].mediaId, true), (err) => err.isNotFound && err.code === 100);

  // Unknown field names: read again with the default fields.
  graph.state.collabInvites.push({ media_id: '17900000000000777', owner: 'north.trails', caption: 'Trail mugs', file: 'f01.jpg', status: 'pending' });
  graph.state.faults.push({ method: 'GET', path: /\/collaboration_invites$/, when: (p) => !!p.fields, times: 1, error: { status: 400, code: 100, message: '(#100) Tried accessing nonexisting field (media_owner_username) on node type (IGCollaborationInvite)' } });
  assert.deepEqual((await ig.collaborationInvites()).map((i) => i.owner), ['north.trails']);

  graph.state.collabMode = 'unsupported';
  await assert.rejects(ig.collaborationInvites(), (err) => err instanceof IgError && err.code === 'unsupported' && /Instagram app/.test(err.userMessage) && err.cause.code === 100);
  await assert.rejects(ig.respondCollabInvite('17900000000000777', true), (err) => err.code === 'unsupported');
  graph.state.collabMode = undefined;

  // Login and rate-limit errors keep their meaning.
  graph.state.faults.push({ method: 'GET', path: /\/collaboration_invites$/, times: 1, error: { status: 400, code: 4, message: '(#4) Application request limit reached' } });
  await assert.rejects(ig.collaborationInvites(), (err) => err.isRateLimit && err.code === 4);

  // Facebook Login: the same edge on the account id.
  const fb = createIg({ mode: 'facebook', token: 'user-token', userId: graph.state.userId, pageId: graph.state.pageId, pageToken: 'page-token-1', ...bases, retryDelayMs: 1 });
  assert.deepEqual((await fb.collaborationInvites()).map((i) => i.owner), ['north.trails']);
  assert.ok(graph.state.requests.some((r) => r.path.endsWith(`/${graph.state.userId}/collaboration_invites`)));

  // A lost connection: answering is safe to resend, so it is retried and never flagged maybeSent.
  let calls = 0;
  const flaky = createIg({
    token: 't',
    igBase: 'https://graph.example',
    retryDelayMs: 1,
    fetchImpl: async () => {
      calls++;
      if (calls < 2) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    },
  });
  assert.equal((await flaky.respondCollabInvite('1', true)).success, true);
  assert.equal(calls, 2);
});

test('accountDaily breakdowns: format and follower splits for chosen days, bounded and non-fatal', async (t) => {
  const { graph, ig, bases } = await setup(t);
  const tz = 'UTC';
  const today = dayKey(new Date(), tz);
  const sinceKey = addDaysKey(today, -4);
  const untilKey = addDaysKey(today, -1);
  const bdCalls = (from) => graph.state.requests.slice(from).filter((r) => /insights$/.test(r.path) && /media_product_type|follow_type|follower_type/.test(r.params.breakdown || '') && /reach|views/.test(r.params.metric || ''));

  // Off by default: the same calls as before.
  let mark = graph.state.requests.length;
  const plain = await ig.accountDaily({ sinceKey, untilKey, tz });
  assert.equal(bdCalls(mark).length, 0);
  assert.equal(plain[untilKey].reachByType, undefined);

  mark = graph.state.requests.length;
  const days = await ig.accountDaily({ sinceKey, untilKey, tz, breakdowns: [untilKey, sinceKey] });
  const calls = bdCalls(mark);
  assert.equal(calls.length, 2 * 3, 'three breakdown calls per chosen day');
  assert.ok(calls.every((r) => r.params.metric_type === 'total_value'));
  assert.deepEqual(calls.filter((r) => r.params.metric === 'views' && r.params.breakdown === 'follower_type').length, 2);
  for (const k of [untilKey, sinceKey]) {
    const d = days[k];
    assert.deepEqual(Object.keys(d.viewsByType).sort(), ['CAROUSEL_CONTAINER', 'POST', 'REEL', 'STORY']);
    assert.equal(Object.values(d.viewsByType).reduce((a, b) => a + b, 0), d.views);
    assert.equal(d.reachFollowers + d.reachNonFollowers, d.reach);
    assert.equal(d.viewsFollowers + d.viewsNonFollowers, d.views);
  }
  assert.equal(days[addDaysKey(today, -2)].reachByType, undefined, 'days not asked for get no breakdowns');

  // If views rejects follower_type (the research is unverified) it is tried once with follow_type;
  // both rejections are remembered, so later days make no more views-split calls.
  graph.state.faults.push({ method: 'GET', path: /\/insights$/, when: (p) => p.breakdown === 'follower_type', times: 100, error: { status: 400, code: 100, message: '(#100) Incompatible breakdowns (follower_type) with metric (views)' } });
  const fresh = createIg({ token: 'tok', ...bases, retryDelayMs: 1 });
  mark = graph.state.requests.length;
  const fb = await fresh.accountDaily({ sinceKey: untilKey, untilKey, tz, breakdowns: true });
  const tried = bdCalls(mark).filter((r) => /views/.test(r.params.metric)).map((r) => r.params.breakdown);
  assert.deepEqual(tried.sort(), ['follow_type', 'follower_type', 'media_product_type']);
  assert.equal(fb[untilKey].viewsFollowers, undefined, 'the mock accepts neither, so no views split');
  assert.equal(typeof fb[untilKey].reachFollowers, 'number');
  assert.ok(fb[untilKey].viewsByType);
  mark = graph.state.requests.length;
  await fresh.accountDaily({ sinceKey: addDaysKey(today, -2), untilKey: addDaysKey(today, -2), tz, breakdowns: true });
  assert.deepEqual(bdCalls(mark).map((r) => r.params.breakdown).sort(), ['follow_type', 'media_product_type'], 'rejections remembered');
  graph.state.faults.length = 0;

  // A rate limit stops the remaining breakdown calls but keeps the totals.
  graph.state.faults.push({ method: 'GET', path: /\/insights$/, when: (p) => p.breakdown === 'media_product_type', times: 100, error: { status: 400, code: 4, message: 'Application request limit reached' } });
  mark = graph.state.requests.length;
  const limited = await ig.accountDaily({ sinceKey, untilKey, tz, breakdowns: true });
  assert.equal(Object.keys(limited).length, 4);
  assert.ok(Object.values(limited).every((d) => typeof d.reach === 'number' && d.reachByType === undefined && d.reachFollowers === undefined));
  assert.ok(bdCalls(mark).length <= 3, `stopped after the rate limit (${bdCalls(mark).length})`);
  graph.state.faults.length = 0;

  // Auth errors still throw.
  graph.state.faults.push({ method: 'GET', path: /\/insights$/, when: (p) => p.breakdown === 'follow_type' && p.metric === 'reach', times: 100, error: { status: 400, code: 190, subcode: 463, type: 'OAuthException', message: 'Error validating access token: Session has expired' } });
  await assert.rejects(ig.accountDaily({ sinceKey: untilKey, untilKey, tz, breakdowns: true }), (err) => err.isAuth);
  graph.state.faults.length = 0;
});

test('collaboration invites: a lost answer is resent once, and "not found" after it means Instagram has it', async (t) => {
  const { graph, bases } = await setup(t);
  const lose = (n) => {
    let lost = 0;
    return async (url, init) => {
      const res = await fetch(url, init);
      if (init && init.method === 'POST' && String(url).includes('/collaboration_invites') && lost < n) {
        lost++;
        await res.text(); // Instagram processed it, but the answer never arrived
        throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
      }
      return res;
    };
  };
  const [first, second] = graph.state.collabInvites;
  const ig1 = createIg({ token: 'tok', ...bases, retryDelayMs: 1, fetchImpl: lose(1) });
  assert.deepEqual(await ig1.respondCollabInvite(first.media_id, true), { mediaId: first.media_id, accepted: true, success: true, unconfirmed: true });
  assert.deepEqual(graph.state.collabResponses.map((r) => r.accept), [true], 'answered once');

  // Every attempt lost: flagged maybeSent, so callers do not report the invite as still open.
  const ig2 = createIg({ token: 'tok', ...bases, retryDelayMs: 1, fetchImpl: lose(9) });
  await assert.rejects(ig2.respondCollabInvite(second.media_id, false), (err) => err.code === 'network' && err.maybeSent === true && /may have gone through/.test(err.userMessage));

  // Nothing left the machine: a plain network error, not maybeSent.
  const ig3 = createIg({
    token: 'tok',
    igBase: 'https://graph.example',
    retryDelayMs: 1,
    fetchImpl: async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    },
  });
  await assert.rejects(ig3.respondCollabInvite('1', true), (err) => err.code === 'network' && !err.maybeSent);
  // An invite that was never open stays "not found" on the first attempt.
  const { ig } = await setup(t);
  await assert.rejects(ig.respondCollabInvite('17900000000000999', true), (err) => err.isNotFound);
});

test('collaboration invites: preview images skip video files, and answered invites are not listed as open', async () => {
  // Imitates a response with more fields than the mock returns (field names unverified).
  const data = [
    { media_id: '1', media_owner_username: 'reel.maker', media_type: 'VIDEO', media_url: 'https://cdn.example/v.mp4?x=1', thumbnail_url: 'https://cdn.example/t.jpg' },
    { media_id: '2', media_owner_username: 'clip.only', media_url: 'https://cdn.example/clip.mp4' },
    { media_id: '3', media_owner_username: 'done.already', status: 'ACCEPTED', media_url: 'https://cdn.example/p.jpg' },
    { media_id: '4', media_owner_username: 'photo.person', media_url: 'https://cdn.example/p.jpg' },
  ];
  const ig = createIg({ token: 't', igBase: 'https://graph.example', retryDelayMs: 1, fetchImpl: async () => new Response(JSON.stringify({ data }), { status: 200 }) });
  const list = await ig.collaborationInvites();
  assert.deepEqual(list.map((i) => [i.mediaId, i.mediaUrl]), [['1', 'https://cdn.example/t.jpg'], ['2', null], ['4', 'https://cdn.example/p.jpg']]);
  assert.ok(!('open' in list[0]));
});
