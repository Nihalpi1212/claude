import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub, GitHubError } from '../../core/github.js';

/** A client whose fetch answers from `replies` in order and counts the calls. */
function client(replies, opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const [status, body, headers = {}] = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  };
  return { gh: createGitHub({ token: 't', owner: 'o', repo: 'r', apiBase: 'http://gh.test', fetchImpl, ...opts }), calls };
}

const SECONDARY = { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' };

test('github: a 403 secondary rate limit is waited out and retried', async () => {
  const { gh, calls } = client([[403, SECONDARY, { 'retry-after': '0.05' }], [201, { sha: 'abc' }]]);
  assert.equal(await gh.createBlob(new Uint8Array([1])), 'abc');
  assert.equal(calls.length, 2);
});

test('github: a secondary rate limit without retry-after waits a minute once, then fails as a rate limit', async () => {
  const waits = [];
  const make = (replies) => client(replies, { sleep: async (ms) => void waits.push(ms) });

  const once = make([[403, SECONDARY], [201, { sha: 'abc' }]]);
  assert.equal(await once.gh.createBlob(new Uint8Array([1])), 'abc');
  assert.equal(once.calls.length, 2);
  assert.deepEqual(waits, [60_000]);

  waits.length = 0;
  const twice = make([[403, SECONDARY]]);
  await assert.rejects(twice.gh.createBlob(new Uint8Array([1])), (err) => err instanceof GitHubError && err.status === 403 && err.isRateLimit && /rate limit/i.test(err.message));
  assert.equal(twice.calls.length, 2, 'not a third time');
  assert.deepEqual(waits, [60_000], 'the minute is waited once');

  waits.length = 0;
  const tooMany = make([[429, { message: 'Too many requests' }]]);
  await assert.rejects(tooMany.gh.getRepo(), (err) => err.status === 429 && err.isRateLimit);
  assert.deepEqual(waits, [60_000]);

  // A refusal is not a rate limit; the primary limit is one too.
  assert.equal(new GitHubError(403, 'GitHub refused this action: Resource not accessible by integration.', { message: 'Resource not accessible by integration' }).isRateLimit, false);
  assert.equal(new GitHubError(403, 'GitHub rate limit reached. Wait a few minutes and try again.', { message: 'API rate limit exceeded for installation.' }).isRateLimit, true);
  assert.equal(new GitHubError(422, 'Validation Failed').isRateLimit, false);
});

test('github: other 403s fail at once and a far-away rate-limit reset is not waited for', async () => {
  const refused = client([[403, { message: 'Resource not accessible by integration' }]]);
  await assert.rejects(refused.gh.getRepo(), (err) => err instanceof GitHubError && err.status === 403);
  assert.equal(refused.calls.length, 1);

  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const primary = client([[403, { message: 'API rate limit exceeded for installation.' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }]]);
  const started = Date.now();
  await assert.rejects(primary.gh.getRepo(), (err) => err.status === 403 && /rate limit/i.test(err.message));
  assert.equal(primary.calls.length, 1);
  assert.ok(Date.now() - started < 1000);
});
