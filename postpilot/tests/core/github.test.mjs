import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub, GitHubError } from '../../core/github.js';

/** A client whose fetch answers from `replies` in order and counts the calls. */
function client(replies) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const [status, body, headers = {}] = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  };
  return { gh: createGitHub({ token: 't', owner: 'o', repo: 'r', apiBase: 'http://gh.test', fetchImpl }), calls };
}

const SECONDARY = { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' };

test('github: a 403 secondary rate limit is waited out and retried', async () => {
  const { gh, calls } = client([[403, SECONDARY, { 'retry-after': '0.05' }], [201, { sha: 'abc' }]]);
  assert.equal(await gh.createBlob(new Uint8Array([1])), 'abc');
  assert.equal(calls.length, 2);
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
