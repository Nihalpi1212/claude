import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerEnv, visibleLines } from '../helpers/worker-env.mjs';
import { newRule } from '../../core/model.js';

const PRICE_RULE = newRule({
  id: 'r_price',
  name: 'Price',
  trigger: { source: 'comment', match: 'any', keywords: ['price'], mediaIds: null },
  actions: [{ type: 'reply_comment', texts: ['Thanks {mention}, check your DMs!'] }, { type: 'private_reply', texts: ['Hi {username}, prices are on our site.'] }],
  oncePerUser: true,
});

test('outbox commands run and update the cached inbox', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const media = env.graph.state.media[0];
  const target = [...env.graph.state.comments.values()].find((c) => c.mediaId === media.id && !c.parentId && !c.hidden);
  await env.update('inbox', (d) => {
    d.outbox.push(
      { id: 'c1', type: 'reply_comment', payload: { commentId: target.id, text: 'Thank you!' }, status: 'pending', createdAt: new Date().toISOString() },
      { id: 'c2', type: 'hide_comment', payload: { commentId: target.id, hide: true }, status: 'pending', createdAt: new Date().toISOString() },
      { id: 'c3', type: 'delete_comment', payload: { commentId: 'does-not-exist' }, status: 'pending', createdAt: new Date().toISOString() },
    );
  });
  const res = await env.run({ only: ['outbox'] });
  assert.equal(res.exitCode, 0);
  const inbox = await env.read('inbox');
  const byId = Object.fromEntries(inbox.outbox.map((c) => [c.id, c]));
  assert.equal(byId.c1.status, 'done');
  assert.ok(byId.c1.result.id);
  assert.equal(byId.c2.status, 'done');
  assert.equal(byId.c3.status, 'failed');
  assert.ok(byId.c3.error);
  assert.ok(env.graph.state.replies.some((r) => r.commentId === target.id && r.text === 'Thank you!'));
  assert.ok(env.graph.state.hidden.has(target.id));
  assert.ok(res.lines.includes('outbox: 2 commands, 1 commands failed'));
});

test('a comment keyword rule replies once, never twice across runs', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.rules = [PRICE_RULE];
  });
  // First run: automations start now; existing comments are left alone.
  const repliesBefore = env.graph.state.replies.length;
  await env.run({ only: ['automations'] });
  assert.equal(env.graph.state.replies.length, repliesBefore, 'old comments are not answered');
  let auto = await env.read('automations');
  assert.ok(auto.cursors.startedAt);
  assert.ok(Object.keys(auto.cursors.mediaComments).length > 0);

  const media = env.graph.state.media[0];
  const c = env.addComment(media.id, { username: 'curious.cat', text: 'What is the PRICE of this one?' });
  const second = await env.run({ only: ['automations'] });
  assert.equal(second.exitCode, 0);
  const reply = env.graph.state.replies.find((r) => r.commentId === c.id);
  assert.ok(reply, 'replied to the new comment');
  assert.equal(reply.text, 'Thanks @curious.cat, check your DMs!');
  const dm = env.graph.state.sentMessages.find((m) => m.commentId === c.id);
  assert.ok(dm, 'sent a private reply');
  assert.equal(dm.text, 'Hi curious.cat, prices are on our site.');
  assert.ok(second.lines.includes('automations: 1 replies, 1 dms, 0 hidden, 0 deleted, 0 ai replies, 1 comments checked, 0 messages checked'));
  assert.ok(!visibleLines(second.lines).join('\n').includes('curious.cat'));

  auto = await env.read('automations');
  assert.ok(auto.processed.comments[c.id]);
  assert.ok(auto.processed.users.r_price[c.fromId], 'oncePerUser recorded');
  assert.equal(auto.rules[0].stats.fired, 1);
  assert.equal(auto.stats.replies, 1);
  assert.equal(auto.stats.dms, 1);
  assert.equal(auto.activity[0].ok, true);

  // Third run: nothing new, nothing sent.
  const replies = env.graph.state.replies.length;
  const sent = env.graph.state.sentMessages.length;
  await env.run({ only: ['automations'] });
  assert.equal(env.graph.state.replies.length, replies);
  assert.equal(env.graph.state.sentMessages.length, sent);

  // The same person asking again does not trigger a once-per-user rule.
  env.addComment(media.id, { username: 'curious.cat', text: 'price again?' });
  await env.run({ only: ['automations'] });
  assert.equal(env.graph.state.replies.length, replies);

  // The inbox cache holds the comment.
  const inbox = await env.read('inbox');
  assert.ok(inbox.comments.some((x) => x.id === c.id));
  assert.ok(inbox.fetchedAt);
});

test('blocked words hide comments', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.blockedWords = { enabled: true, words: ['scam*'], action: 'hide' };
  });
  await env.run({ only: ['automations'] });
  const c = env.addComment(env.graph.state.media[1].id, { username: 'bot.account', text: 'Total scammers lol' });
  const res = await env.run({ only: ['automations'] });
  assert.ok(env.graph.state.hidden.has(c.id));
  assert.equal(res.summary.jobs.automations.hidden, 1);
});

test('a first DM gets the welcome message; DM keyword rules answer later messages', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.welcome = { enabled: true, text: 'Welcome {first_name}! We reply within a day.' };
    a.rules = [
      newRule({ id: 'r_hours', name: 'Hours', trigger: { source: 'dm', match: 'any', keywords: ['hours'], mediaIds: null }, actions: [{ type: 'send_dm', texts: ['We are open 9-5.'] }], oncePerUser: false }),
    ];
  });
  const sentBefore = env.graph.state.sentMessages.length;
  await env.run({ only: ['automations'] });
  assert.equal(env.graph.state.sentMessages.length, sentBefore, 'existing conversations are not welcomed');
  const cache = await env.read('inbox');
  assert.ok(cache.conversations.length > 0, 'conversation previews cached');
  assert.ok(cache.conversations[0].lastMessage);

  const { other } = env.addMessage({ username: 'new.customer', text: 'Hi there' });
  await env.run({ only: ['automations'] });
  const welcome = env.graph.state.sentMessages.filter((m) => m.recipientId === other.id);
  assert.equal(welcome.length, 1);
  assert.equal(welcome[0].text, 'Welcome new.customer! We reply within a day.');

  // Second message: no second welcome; a keyword rule answers.
  env.addMessage({ username: 'new.customer', text: 'What are your opening hours?' });
  await env.run({ only: ['automations'] });
  const all = env.graph.state.sentMessages.filter((m) => m.recipientId === other.id);
  assert.equal(all.length, 2);
  assert.equal(all[1].text, 'We are open 9-5.');

  // Nothing new: nothing sent.
  await env.run({ only: ['automations'] });
  assert.equal(env.graph.state.sentMessages.filter((m) => m.recipientId === other.id).length, 2);
});

test('records when Instagram blocks DMs and stops sending for the run', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.welcome = { enabled: true, text: 'Welcome!' };
  });
  await env.run({ only: ['automations'] });
  env.graph.state.dmMode = 'advanced_access';
  env.addMessage({ username: 'someone.new', text: 'hello' });
  const res = await env.run({ only: ['automations'] });
  assert.equal(res.exitCode, 0);
  const auto = await env.read('automations');
  assert.equal(auto.status.dm, 'needs_advanced_access');
  assert.match(auto.status.message, /Advanced Access/);
  assert.equal(auto.activity[0].ok, false);

  // The next runs do not keep hammering the send API (re-checked every few hours).
  env.addMessage({ username: 'another.new', text: 'hi again' });
  const mark = env.graph.state.requests.length;
  await env.run({ only: ['automations'] });
  const sends = env.graph.state.requests.slice(mark).filter((r) => r.method === 'POST' && r.path.endsWith('/messages'));
  assert.equal(sends.length, 0);
  const later = await env.run({ only: ['automations'], now: Date.now() + 7 * 36e5 });
  assert.equal(later.exitCode, 0);
});

test('message access turned off: listing threads is skipped until the re-check', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  env.graph.state.dmMode = 'disabled';
  await env.run({ only: ['automations'] });
  // The mock only refuses sends; simulate the real API refusing to list threads as well.
  env.graph.state.faults.push({ method: 'GET', path: /\/conversations$/, error: { code: 10, status: 400, message: '(#10) The account owner has disabled access to Instagram Direct Messages.' } });
  await env.run({ only: ['automations'], now: Date.now() + 61 * 60e3 });
  let auto = await env.read('automations');
  assert.equal(auto.status.dm, 'dm_disabled');
  const mark = env.graph.state.requests.length;
  await env.run({ only: ['automations'], now: Date.now() + 2 * 36e5 });
  assert.equal(env.graph.state.requests.slice(mark).filter((r) => r.path.endsWith('/conversations')).length, 0);
  // Fixed in the Instagram app: after the re-check window the status clears.
  env.graph.state.faults.length = 0;
  env.graph.state.dmMode = 'ok';
  await env.run({ only: ['automations'], now: Date.now() + 8 * 36e5 });
  auto = await env.read('automations');
  assert.equal(auto.status.dm, 'ok');
});

test('respects the actions-per-run limit and finishes on the next run', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.limits = { maxActionsPerRun: 2, maxDmsPerHour: 40 };
    a.rules = [newRule({ id: 'r_any', name: 'Thanks', trigger: { source: 'comment', match: 'any', keywords: ['love'], mediaIds: null }, actions: [{ type: 'reply_comment', texts: ['Thank you!'] }], oncePerUser: false })];
  });
  await env.run({ only: ['automations'] });
  const media = env.graph.state.media[0];
  const ids = ['a.one', 'b.two', 'c.three'].map((u) => env.addComment(media.id, { username: u, text: 'love it' }).id);
  await env.run({ only: ['automations'] });
  assert.equal(ids.filter((id) => env.graph.state.replies.some((r) => r.commentId === id)).length, 2);
  await env.run({ only: ['automations'] });
  assert.equal(ids.filter((id) => env.graph.state.replies.some((r) => r.commentId === id)).length, 3);
});

test('AI replies use the mock Claude when AI is configured', async (t) => {
  const env = await startWorkerEnv({ settings: { ai: { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-opus-5-5', voice: '', language: 'English', emoji: 'some', enabled: true } } });
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.rules = [newRule({ id: 'r_ai', name: 'AI', trigger: { source: 'comment', match: 'any', keywords: ['question'], mediaIds: null }, actions: [{ type: 'ai_reply', texts: [], guidance: 'Be kind.' }], oncePerUser: false })];
  });
  await env.run({ only: ['automations'] });
  const c = env.addComment(env.graph.state.media[0].id, { username: 'asker', text: 'I have a question about glazes' });
  const res = await env.run({ only: ['automations'] });
  assert.equal(env.anthropic.state.requests.length, 1);
  const reply = env.graph.state.replies.find((r) => r.commentId === c.id);
  assert.ok(reply && reply.text.length > 0);
  assert.equal(res.summary.jobs.automations.aiReplies, 1);
});
