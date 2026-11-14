import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerEnv, visibleLines } from '../helpers/worker-env.mjs';
import { b64url, generateVapidKeys } from '../../core/webpush.js';
import { decisionHolds, normUsername } from '../../worker/jobs/invites.mjs';
import { runWorker } from '../../worker/run.mjs';

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const HOUR = 36e5;

async function device(url, name) {
  const keys = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const p256dh = b64url(new Uint8Array(await subtle.exportKey('raw', keys.publicKey)));
  return { keys, auth, sub: { endpoint: `${url}/push/${name}`, keys: { p256dh, auth: b64url(auth) }, device: name, createdAt: new Date().toISOString() } };
}

/** RFC 8291 decryption, as the browser does it. */
async function decrypt(body, ua, authSecret) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const uaPublic = new Uint8Array(await subtle.exportKey('raw', ua.publicKey));
  const asKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const hk = async (s, ikm, info, len) => new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), len * 8));
  const ikm = await hk(authSecret, secret, new Uint8Array([...te.encode('WebPush: info\0'), ...uaPublic, ...asPublic]), 32);
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

async function withPhone(env) {
  const phone = await device(env.url, 'phone');
  const vapid = { ...(await generateVapidKeys()), subject: 'mailto:owner@example.com' };
  await env.update('settings', (s) => {
    s.notifications = { vapid, subscriptions: [phone.sub], events: { collab: true } };
  });
  return phone;
}

const at = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const inviteReads = (env) => env.graph.state.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/collaboration_invites')).length;

test('new invites are saved and notified once; Instagram is asked at most every 6 hours', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const phone = await withPhone(env);

  const first = await env.run({ only: ['invites'] });
  assert.equal(first.exitCode, 0);
  assert.deepEqual(first.summary.jobs.invites, { invitesNew: 2, invitesAccepted: 0 });
  assert.ok(first.lines.includes('invites: 2 invites new, 0 invites accepted'));
  const visible = visibleLines(first.lines).join('\n');
  assert.ok(!visible.includes('atelier.kin') && !visible.includes('lumen.ceramics'), 'no usernames in public logs');

  let inbox = await env.read('inbox');
  assert.equal(inbox.invites.length, 2);
  const atelier = inbox.invites.find((i) => i.owner === 'atelier.kin');
  assert.equal(atelier.status, 'pending');
  assert.equal(atelier.mediaId, env.graph.state.collabInvites[0].media_id);
  assert.match(atelier.caption, /joint mug collection/);
  assert.match(atelier.mediaUrl, /f05\.jpg$/);
  assert.ok(atelier.id && atelier.seenAt);
  assert.equal(atelier.decidedAt, null);
  assert.ok(inbox.invitesCheckedAt);
  assert.equal(inbox.invitesStatus.state, 'ok');

  assert.equal(env.pushes.length, 1, 'one coalesced push');
  const payload = await decrypt(env.pushes[0].body, phone.keys, phone.auth);
  assert.equal(payload.title, '2 new collaboration invites');
  assert.equal(payload.url, './#/inbox/invites');

  // Right after: not due, Instagram is not asked again.
  const reads = inviteReads(env);
  const again = await env.run({ only: ['invites'] });
  assert.deepEqual(again.summary.jobs.invites, { skipped: 'not_due' });
  assert.equal(inviteReads(env), reads);

  // Seven hours later: the same invites are not news.
  const later = await env.run({ only: ['invites'], now: at(7 * HOUR) });
  assert.deepEqual(later.summary.jobs.invites, { invitesNew: 0, invitesAccepted: 0 });
  assert.equal(env.pushes.length, 1, 'no second push for the same invites');

  // An invite answered in the Instagram app disappears from the list and from Postpilot.
  env.graph.state.collabInvites[1].status = 'declined';
  await env.run({ only: ['invites'], now: at(14 * HOUR) });
  inbox = await env.read('inbox');
  assert.deepEqual(inbox.invites.map((i) => i.owner), ['atelier.kin']);
});

test('invites from allowlisted accounts are accepted automatically; others wait and notify', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const phone = await withPhone(env);
  await env.update('automations', (a) => {
    a.collabAllowlist = ['@Atelier.Kin '];
  });

  const res = await env.run({ only: ['invites'] });
  assert.deepEqual(res.summary.jobs.invites, { invitesNew: 2, invitesAccepted: 1 });
  const atelierMedia = env.graph.state.collabInvites[0].media_id;
  assert.deepEqual(env.graph.state.collabResponses.map((r) => [r.mediaId, r.accept]), [[atelierMedia, true]]);

  const inbox = await env.read('inbox');
  const byOwner = Object.fromEntries(inbox.invites.map((i) => [i.owner, i]));
  assert.equal(byOwner['atelier.kin'].status, 'accepted');
  assert.equal(byOwner['atelier.kin'].auto, true);
  assert.ok(byOwner['atelier.kin'].decidedAt);
  assert.equal(byOwner['lumen.ceramics'].status, 'pending');

  assert.equal(env.pushes.length, 1);
  const payload = await decrypt(env.pushes[0].body, phone.keys, phone.auth);
  assert.equal(payload.title, 'New collaboration invite');
  assert.equal(payload.body, '@lumen.ceramics invited you to collaborate on a post.');

  const log = await env.read('log');
  assert.ok(log.entries.some((e) => e.job === 'invites' && /Accepted @atelier\.kin/.test(e.message)));

  // Answered invites stay for 30 days, then go.
  await env.run({ only: ['invites'], now: at(7 * HOUR) });
  assert.ok((await env.read('inbox')).invites.some((i) => i.owner === 'atelier.kin' && i.status === 'accepted'));
  await env.run({ only: ['invites'], now: at(31 * 24 * HOUR) });
  assert.deepEqual((await env.read('inbox')).invites.map((i) => i.owner), ['lumen.ceramics']);
});

test('a connection without the invites endpoint is skipped, noted once and checked again later', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  env.graph.state.collabMode = 'unsupported';

  const res = await env.run({ only: ['invites'] });
  assert.equal(res.exitCode, 0);
  assert.deepEqual(res.summary.jobs.invites, { skipped: 'unsupported' });
  assert.ok(res.lines.includes('invites: skipped (not supported for this account)'));
  let inbox = await env.read('inbox');
  assert.equal(inbox.invitesStatus.state, 'unsupported');
  assert.match(inbox.invitesStatus.message, /Instagram app/);
  assert.deepEqual(inbox.invites, []);

  await env.run({ only: ['invites'], now: at(7 * HOUR) });
  let log = await env.read('log');
  assert.equal(log.entries.filter((e) => e.job === 'invites').length, 1, 'explained once, not on every check');
  assert.equal(log.runs[0].errors.length, 0);

  env.graph.state.collabMode = undefined;
  const ok = await env.run({ only: ['invites'], now: at(14 * HOUR) });
  assert.deepEqual(ok.summary.jobs.invites, { invitesNew: 2, invitesAccepted: 0 });
  inbox = await env.read('inbox');
  assert.equal(inbox.invitesStatus.state, 'ok');
  log = await env.read('log');
  assert.ok(log.entries.some((e) => e.job === 'invites' && /can be read again/.test(e.message)));
});

test('a failed automatic accept leaves the invite pending and notifies the owner', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const phone = await withPhone(env);
  await env.update('automations', (a) => {
    a.collabAllowlist = ['atelier.kin'];
  });
  env.graph.state.faults.push({ method: 'POST', path: /\/collaboration_invites$/, error: { status: 400, code: 10, message: '(#10) Application does not have permission for this action' } });
  const res = await env.run({ only: ['invites'] });
  assert.deepEqual(res.summary.jobs.invites, { invitesNew: 2, invitesAccepted: 0 });
  const inbox = await env.read('inbox');
  assert.ok(inbox.invites.every((i) => i.status === 'pending'));
  assert.equal(env.graph.state.collabResponses.length, 0);
  assert.equal((await decrypt(env.pushes[0].body, phone.keys, phone.auth)).title, '2 new collaboration invites');
  const log = await env.read('log');
  assert.ok(log.entries.some((e) => e.job === 'invites' && e.level === 'warn' && /Could not accept @atelier\.kin/.test(e.message)));
});

test('allowlist usernames are compared without @ and case', () => {
  assert.equal(normUsername(' @@Atelier.Kin '), 'atelier.kin');
  assert.equal(normUsername(null), '');
});

/** fetch that delivers the first `n` invite answers to Instagram but loses the responses (`reach: false`: never sends them). */
function losingFetch(n, { reach = true } = {}) {
  let lost = 0;
  return async (url, init) => {
    const isAnswer = init && init.method === 'POST' && String(url).includes('/collaboration_invites');
    if (isAnswer && lost < n) {
      lost++;
      if (reach) await (await fetch(url, init)).text();
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    }
    return fetch(url, init);
  };
}

const runWith = (env, fetchImpl, now) => runWorker({ env: env.env, only: ['invites'], fetchImpl, now, log: () => {} });

test('an automatic accept whose response is lost is recorded as accepted, never as a new waiting invite', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const phone = await withPhone(env);
  await env.update('automations', (a) => {
    a.collabAllowlist = ['atelier.kin'];
  });
  const atelierMedia = env.graph.state.collabInvites[0].media_id;
  // The accept reaches Instagram, the response is lost; the resend is refused because the invite is closed.
  const res = await runWith(env, losingFetch(1));
  assert.deepEqual(res.summary.jobs.invites, { invitesNew: 2, invitesAccepted: 1 });
  assert.deepEqual(env.graph.state.collabResponses.map((r) => [r.mediaId, r.accept]), [[atelierMedia, true]]);
  let inbox = await env.read('inbox');
  let atelier = inbox.invites.find((i) => i.owner === 'atelier.kin');
  assert.deepEqual([atelier.status, atelier.auto, atelier.unconfirmed], ['accepted', true, true]);
  assert.equal(env.pushes.length, 1);
  const payload = await decrypt(env.pushes[0].body, phone.keys, phone.auth);
  assert.equal(payload.title, 'New collaboration invite', 'only the other invite is announced');
  // Next check: Instagram no longer lists it, which confirms the accept.
  await env.run({ only: ['invites'], now: at(7 * HOUR) });
  inbox = await env.read('inbox');
  atelier = inbox.invites.find((i) => i.owner === 'atelier.kin');
  assert.equal(atelier.status, 'accepted');
  assert.equal(atelier.unconfirmed, undefined);
});

test('an automatic accept that never reached Instagram is tried again at the next check, without a push', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await withPhone(env);
  await env.update('automations', (a) => {
    a.collabAllowlist = ['atelier.kin'];
  });
  // Every attempt is lost before Instagram gets it (but it could have reached it: maybeSent).
  const res = await runWith(env, losingFetch(9, { reach: false }));
  assert.deepEqual(res.summary.jobs.invites, { invitesNew: 2, invitesAccepted: 1 });
  let inbox = await env.read('inbox');
  assert.equal(inbox.invites.find((i) => i.owner === 'atelier.kin').unconfirmed, true);
  assert.equal(env.pushes.length, 1, 'one push, for the other invite');
  assert.equal(env.graph.state.collabResponses.length, 0);
  const log = await env.read('log');
  assert.ok(log.entries.some((e) => e.job === 'invites' && /did not confirm/.test(e.message)));
  // Still listed at the next check: accepted again, this time confirmed.
  const next = await env.run({ only: ['invites'], now: at(7 * HOUR) });
  assert.deepEqual(next.summary.jobs.invites, { invitesNew: 1, invitesAccepted: 1 });
  assert.equal(env.graph.state.collabResponses.length, 1);
  inbox = await env.read('inbox');
  const atelier = inbox.invites.find((i) => i.owner === 'atelier.kin');
  assert.deepEqual([atelier.status, atelier.auto, atelier.unconfirmed], ['accepted', true, undefined]);
  assert.equal(env.pushes.length, 1, 'no push for an invite accepted automatically');
});

test('an invite that closes before the automatic accept is left out, without a push', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await withPhone(env);
  await env.update('automations', (a) => {
    a.collabAllowlist = ['atelier.kin'];
  });
  env.graph.state.faults.push({ method: 'POST', path: /\/collaboration_invites$/, times: 1, error: { status: 400, code: 100, subcode: 33, message: "(#100) Unsupported post request. Object with ID '1' does not exist" } });
  const res = await env.run({ only: ['invites'] });
  assert.deepEqual(res.summary.jobs.invites, { invitesNew: 1, invitesAccepted: 0 });
  const inbox = await env.read('inbox');
  assert.deepEqual(inbox.invites.map((i) => i.owner), ['lumen.ceramics']);
  assert.equal(env.pushes.length, 1);
});

test('an invite sent again after a decline is open again; a decline from minutes ago is trusted', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const phone = await withPhone(env);
  await env.run({ only: ['invites'] });
  assert.equal(env.pushes.length, 1);
  const [first, second] = env.graph.state.collabInvites;
  // The owner declined both in the app: one two hours ago, one ten minutes ago. Instagram lists both
  // as open (a new invite after the decline, or an answer that did not take).
  await env.update('inbox', (d) => {
    for (const [inv, ago] of [[first, 2 * HOUR], [second, 10 * 60e3]]) {
      const x = d.invites.find((i) => i.mediaId === inv.media_id);
      x.status = 'declined';
      x.decidedAt = at(-ago);
    }
    d.invitesCheckedAt = at(-7 * HOUR);
  });
  const res = await env.run({ only: ['invites'] });
  assert.deepEqual(res.summary.jobs.invites, { invitesNew: 1, invitesAccepted: 0 });
  const inbox = await env.read('inbox');
  const byMedia = Object.fromEntries(inbox.invites.map((i) => [i.mediaId, i]));
  assert.equal(byMedia[first.media_id].status, 'pending');
  assert.equal(byMedia[first.media_id].decidedAt, null);
  assert.equal(byMedia[second.media_id].status, 'declined', 'Instagram may list a fresh answer for a moment');
  assert.equal(env.pushes.length, 2);
  assert.equal((await decrypt(env.pushes[1].body, phone.keys, phone.auth)).body, '@atelier.kin invited you to collaborate on a post.');

  const now = Date.now();
  assert.ok(decisionHolds({ status: 'declined', decidedAt: new Date(now - 5 * 60e3).toISOString() }, now));
  assert.ok(!decisionHolds({ status: 'declined', decidedAt: new Date(now - 2 * HOUR).toISOString() }, now));
  assert.ok(!decisionHolds({ status: 'pending', decidedAt: null }, now));
});
