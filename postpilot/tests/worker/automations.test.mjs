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

test('a temporary AI failure leaves the comment for the next run instead of dropping it', async (t) => {
  const env = await startWorkerEnv({ settings: { ai: { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-opus-5-5', voice: '', language: 'English', emoji: 'some', enabled: true } } });
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.rules = [newRule({ id: 'r_ai', name: 'AI', trigger: { source: 'comment', match: 'any', keywords: ['question'], mediaIds: null }, actions: [{ type: 'ai_reply', texts: [], guidance: 'Be kind.' }], oncePerUser: false })];
  });
  await env.run({ only: ['automations'] });
  const c1 = env.addComment(env.graph.state.media[0].id, { username: 'asker', text: 'I have a question about glazes' });
  const c2 = env.addComment(env.graph.state.media[1].id, { username: 'asker.two', text: 'Another question: do you ship?' });
  // Claude is overloaded for the whole run (the SDK retries each request twice on its own).
  for (let i = 0; i < 20; i++) env.anthropic.state.faults.push({ status: 529 });
  const first = await env.run({ only: ['automations'] });
  assert.equal(first.exitCode, 0);
  const tried = 20 - env.anthropic.state.faults.length;
  assert.ok(tried > 0 && tried <= 3, `only the first AI reply waits through the retries (${tried} requests)`);
  assert.ok(!env.graph.state.replies.some((r) => r.commentId === c1.id || r.commentId === c2.id), 'nothing sent while AI is down');
  let auto = await env.read('automations');
  assert.ok(!auto.processed.comments[c1.id] && !auto.processed.comments[c2.id], 'comments stay unprocessed');

  env.anthropic.state.faults.length = 0;
  const second = await env.run({ only: ['automations'] });
  assert.equal(second.summary.jobs.automations.aiReplies, 2);
  assert.equal(env.graph.state.replies.filter((r) => r.commentId === c1.id).length, 1);
  assert.equal(env.graph.state.replies.filter((r) => r.commentId === c2.id).length, 1);
  auto = await env.read('automations');
  assert.ok(auto.processed.comments[c1.id] && auto.processed.comments[c2.id]);

  // Answered once only.
  await env.run({ only: ['automations'] });
  assert.equal(env.graph.state.replies.filter((r) => r.commentId === c1.id).length, 1);
});

test('turning automations on during a run keeps the start time the app set', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.enabled = false;
    a.cursors = {};
  });
  const switchedOnAt = new Date().toISOString();
  // The owner switches automations on while the worker is reading direct messages.
  const real = env.graph.handle;
  let toggled = false;
  env.graph.handle = async (req, res, sub, body, url) => {
    if (!toggled && req.method === 'GET' && /\/conversations(\?|$)/.test(sub)) {
      toggled = true;
      await env.update('automations', (d) => {
        d.enabled = true;
        d.cursors ||= {};
        d.cursors.startedAt = switchedOnAt;
      });
    }
    return real(req, res, sub, body, url);
  };
  await env.run({ only: ['automations'] });
  env.graph.handle = real;
  assert.ok(toggled);
  const auto = await env.read('automations');
  assert.equal(auto.enabled, true);
  assert.equal(auto.cursors.startedAt, switchedOnAt);

  // Switched off during a run: the worker does not put a start time back.
  const real2 = env.graph.handle;
  let toggledOff = false;
  env.graph.handle = async (req, res, sub, body, url) => {
    if (!toggledOff && req.method === 'GET' && /\/conversations(\?|$)/.test(sub)) {
      toggledOff = true;
      await env.update('automations', (d) => {
        d.enabled = false;
        d.cursors.startedAt = null;
      });
    }
    return real2(req, res, sub, body, url);
  };
  await env.run({ only: ['automations'] });
  env.graph.handle = real2;
  assert.ok(toggledOff);
  const off = await env.read('automations');
  assert.equal(off.enabled, false);
  assert.equal(off.cursors.startedAt, null);
});

const LOVE_RULE = newRule({ id: 'r_love', name: 'Thanks', trigger: { source: 'comment', match: 'any', keywords: ['love'], mediaIds: null }, actions: [{ type: 'reply_comment', texts: ['Thank you!'] }], oncePerUser: false });

/** Make the ref update of the next commit whose message contains `text` fail. Returns a restore function. */
function failCommit(env, text) {
  const real = env.ghMock.handle;
  let armed = false;
  let done = false;
  env.ghMock.handle = (req, res, sub, body) => {
    if (!done && req.method === 'POST' && /\/git\/commits$/.test(sub) && String(body?.message || '').includes(text)) armed = true;
    if (armed && req.method === 'PATCH' && /\/git\/refs\/heads\//.test(sub)) {
      armed = false;
      done = true;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Simulated failure' }));
      return true;
    }
    return real(req, res, sub, body);
  };
  return () => {
    env.ghMock.handle = real;
    return done;
  };
}

const postsTo = (env, mark, suffix) => env.graph.state.requests.slice(mark).filter((r) => r.method === 'POST' && r.path.endsWith(suffix)).length;

test('a rule never says it sent a DM when the DM was refused, and stays available for that person', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.rules = [PRICE_RULE];
  });
  await env.run({ only: ['automations'] });
  const media = env.graph.state.media[0];
  env.graph.state.dmMode = 'advanced_access';
  const c = env.addComment(media.id, { username: 'no.role', text: 'price please' });
  const res = await env.run({ only: ['automations'] });
  assert.equal(res.exitCode, 0);
  assert.ok(!env.graph.state.replies.some((r) => r.commentId === c.id), 'no public "check your DMs" reply');
  assert.ok(!env.graph.state.sentMessages.some((m) => m.commentId === c.id));
  let auto = await env.read('automations');
  assert.ok(auto.processed.comments[c.id], 'the comment is not retried every run');
  assert.ok(!auto.processed.users?.r_price?.[c.fromId], 'oncePerUser is not used up');
  assert.equal(auto.status.dm, 'needs_advanced_access');

  // Access fixed: after the re-check window the same person asking again gets the DM and the reply.
  env.graph.state.dmMode = 'ok';
  const again = env.addComment(media.id, { username: 'no.role', text: 'price?' });
  await env.run({ only: ['automations'], now: Date.now() + 7 * 36e5 });
  assert.ok(env.graph.state.sentMessages.some((m) => m.commentId === again.id));
  assert.ok(env.graph.state.replies.some((r) => r.commentId === again.id));
  auto = await env.read('automations');
  assert.ok(auto.processed.users.r_price[again.fromId]);
});

test('a comment held back by the hourly DM limit is answered on a later run, DM first', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.rules = [PRICE_RULE];
    a.limits = { maxActionsPerRun: 25, maxDmsPerHour: 1 };
  });
  await env.run({ only: ['automations'] });
  const media = env.graph.state.media[0];
  const first = env.addComment(media.id, { username: 'first.asker', text: 'price?', at: Date.now() - 2000 });
  const second = env.addComment(media.id, { username: 'second.asker', text: 'price?' });
  await env.run({ only: ['automations'] });
  assert.ok(env.graph.state.sentMessages.some((m) => m.commentId === first.id));
  assert.ok(env.graph.state.replies.some((r) => r.commentId === first.id));
  assert.ok(!env.graph.state.sentMessages.some((m) => m.commentId === second.id));
  assert.ok(!env.graph.state.replies.some((r) => r.commentId === second.id), 'no public reply without the DM');
  let auto = await env.read('automations');
  assert.ok(!auto.processed.comments[second.id], 'kept for the next run');

  await env.run({ only: ['automations'], now: Date.now() + 61 * 60e3 });
  assert.equal(env.graph.state.sentMessages.filter((m) => m.commentId === second.id).length, 1);
  assert.equal(env.graph.state.replies.filter((r) => r.commentId === second.id).length, 1);
  assert.equal(env.graph.state.replies.filter((r) => r.commentId === first.id).length, 1);
  auto = await env.read('automations');
  assert.ok(auto.processed.comments[second.id]);
});

test('replies already sent are saved when a run stops part-way (expired token)', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.rules = [LOVE_RULE];
  });
  await env.run({ only: ['automations'] });
  const media = env.graph.state.media[0];
  const a1 = env.addComment(media.id, { username: 'a.one', text: 'love it', at: Date.now() - 2000 });
  const a2 = env.addComment(media.id, { username: 'b.two', text: 'love it' });
  let n = 0;
  env.graph.state.faults.push({ method: 'POST', path: /\/replies$/, when: () => ++n === 2, error: { code: 190, status: 400, message: 'Error validating access token: The session has been invalidated.' } });
  const res = await env.run({ only: ['automations'] });
  assert.ok(res.summary.jobs.automations.error);
  let auto = await env.read('automations');
  assert.ok(auto.processed.comments[a1.id], 'the reply that went out is recorded');
  assert.ok(!auto.processed.comments[a2.id]);
  assert.equal(auto.stats.replies, 1);

  env.graph.state.faults.length = 0;
  await env.run({ only: ['automations'] });
  assert.equal(env.graph.state.replies.filter((r) => r.commentId === a1.id).length, 1);
  assert.equal(env.graph.state.replies.filter((r) => r.commentId === a2.id).length, 1);
  auto = await env.read('automations');
  assert.equal(auto.stats.replies, 2);
});

test('a failed save keeps the batch, so the next run does not answer the same comments again', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.rules = [LOVE_RULE];
  });
  await env.run({ only: ['automations'] });
  const media = env.graph.state.media[0];
  const ids = ['u.one', 'u.two', 'u.three', 'u.four', 'u.five', 'u.six'].map((u, i) => env.addComment(media.id, { username: u, text: 'love it', at: Date.now() - (6 - i) * 1000 }).id);
  const restore = failCommit(env, 'automations: record activity');
  const res = await env.run({ only: ['automations'] });
  assert.ok(restore(), 'the save after five replies failed');
  assert.ok(res.summary.jobs.automations.error);
  let auto = await env.read('automations');
  assert.equal(ids.slice(0, 5).filter((id) => auto.processed.comments[id]).length, 5, 'the batch was saved on the way out');
  assert.equal(auto.stats.replies, 5);

  await env.run({ only: ['automations'] });
  for (const id of ids) assert.equal(env.graph.state.replies.filter((r) => r.commentId === id).length, 1);
});

test('comments and messages the account already answered get no second reply when a record is lost', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.rules = [
      LOVE_RULE,
      newRule({ id: 'r_hours', name: 'Hours', trigger: { source: 'dm', match: 'any', keywords: ['hours'], mediaIds: null }, actions: [{ type: 'send_dm', texts: ['We are open 9-5.'] }], oncePerUser: false }),
    ];
  });
  await env.run({ only: ['automations'] });
  const media = env.graph.state.media[0];
  const top = env.addComment(media.id, { username: 'top.level', text: 'love this', at: Date.now() - 3000 });
  const parent = env.addComment(media.id, { username: 'thread.starter', text: 'Nice glaze', at: Date.now() - 2000 });
  const child = env.addComment(media.id, { username: 'thread.reply', text: 'love it too', parentId: parent.id, at: Date.now() - 1000 });
  const { other, msg } = env.addMessage({ username: 'dm.person', text: 'What are your hours?', at: Date.now() - 1000 });
  await env.run({ only: ['automations'] });
  assert.equal(env.graph.state.replies.filter((r) => r.commentId === top.id).length, 1);
  assert.equal(env.graph.state.replies.filter((r) => r.commentId === parent.id).length, 1, 'a reply is answered on its parent');
  assert.equal(env.graph.state.sentMessages.filter((m) => m.recipientId === other.id).length, 1);

  // Lose the record of what was done (as if the save after the replies had failed).
  await env.update('automations', (a) => {
    for (const id of [top.id, child.id, parent.id]) delete a.processed.comments[id];
    delete a.processed.messages[msg.id];
    a.cursors.mediaComments = {};
    a.cursors.dmUpdatedTime = null;
  });
  const mark = env.graph.state.requests.length;
  await env.run({ only: ['automations'] });
  assert.equal(postsTo(env, mark, '/replies'), 0);
  assert.equal(postsTo(env, mark, '/messages'), 0);
  const auto = await env.read('automations');
  assert.ok(auto.processed.comments[top.id] && auto.processed.comments[child.id] && auto.processed.messages[msg.id]);

  // A new message after our answer is still answered.
  env.addMessage({ username: 'dm.person', text: 'and on sundays? hours?' });
  await env.run({ only: ['automations'] });
  assert.equal(env.graph.state.sentMessages.filter((m) => m.recipientId === other.id).length, 2);
});

test('a rate limit or temporary block stops automation writes and pauses later runs', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.rules = [LOVE_RULE];
  });
  await env.run({ only: ['automations'] });
  const media = env.graph.state.media[0];
  const ids = ['r.one', 'r.two', 'r.three'].map((u, i) => env.addComment(media.id, { username: u, text: 'love it', at: Date.now() - (3 - i) * 1000 }).id);
  env.addMessage({ username: 'dm.waiting', text: 'hello' });
  env.graph.state.faults.push({ method: 'POST', path: /\/replies$/, error: { code: 368, status: 400, message: 'It looks like you were misusing this feature by going too fast.' } });
  let mark = env.graph.state.requests.length;
  const res = await env.run({ only: ['automations'] });
  assert.equal(res.exitCode, 0);
  assert.equal(postsTo(env, mark, '/replies'), 1, 'one attempt, then it stops');
  assert.equal(env.graph.state.requests.slice(mark).filter((r) => r.path.endsWith('/conversations')).length, 0, 'no more reads either');
  let auto = await env.read('automations');
  const until = Date.parse(auto.cursors.pausedUntil);
  assert.ok(until > Date.now() + 5.5 * 36e5 && until < Date.now() + 6.5 * 36e5, 'error 368 pauses for hours');
  assert.equal(ids.filter((id) => auto.processed.comments[id]).length, 0);

  // Still paused: no reads, no writes.
  mark = env.graph.state.requests.length;
  await env.run({ only: ['automations'], now: Date.now() + 2 * 36e5 });
  assert.equal(env.graph.state.requests.length - mark, 0);

  // After the pause the waiting comments are answered.
  env.graph.state.faults.length = 0;
  await env.run({ only: ['automations'], now: Date.now() + 7 * 36e5 });
  for (const id of ids) assert.equal(env.graph.state.replies.filter((r) => r.commentId === id).length, 1);
  auto = await env.read('automations');
  assert.equal(ids.filter((id) => auto.processed.comments[id]).length, 3);
});

test('a rate limit on reads pauses automations for at least an hour', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.rules = [LOVE_RULE];
  });
  await env.run({ only: ['automations'] });
  env.addComment(env.graph.state.media[0].id, { username: 'reader', text: 'love it' });
  env.graph.state.faults.push({ method: 'GET', path: /\/comments$/, error: { code: 80002, status: 400, message: 'There have been too many calls to this Instagram account.' } });
  const mark = env.graph.state.requests.length;
  await env.run({ only: ['automations'] });
  assert.equal(env.graph.state.requests.slice(mark).filter((r) => r.path.endsWith('/comments')).length, 1);
  const auto = await env.read('automations');
  const until = Date.parse(auto.cursors.pausedUntil);
  assert.ok(until >= Date.now() + 55 * 60e3 && until < Date.now() + 65 * 60e3);
});

test('outbox: an Instagram command is sent at most once, even when its outcome is not saved', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const media = env.graph.state.media[0];
  const target = [...env.graph.state.comments.values()].find((c) => c.mediaId === media.id && !c.parentId && !c.hidden);
  await env.update('inbox', (d) => {
    d.outbox.push({ id: 'once', type: 'reply_comment', payload: { commentId: target.id, text: 'Only once' }, status: 'pending', createdAt: new Date().toISOString() });
  });
  const restore = failCommit(env, 'outbox: process commands');
  const res = await env.run({ only: ['outbox'] });
  assert.ok(restore(), 'the outcome commit failed');
  assert.ok(res.summary.jobs.outbox.error);
  let inbox = await env.read('inbox');
  let cmd = inbox.outbox.find((c) => c.id === 'once');
  assert.equal(cmd.status, 'sending', 'claimed before it was sent');
  assert.equal(cmd.attempts, 1);
  assert.equal(env.graph.state.replies.filter((r) => r.text === 'Only once').length, 1);

  const next = await env.run({ only: ['outbox'] });
  assert.equal(next.exitCode, 0);
  inbox = await env.read('inbox');
  cmd = inbox.outbox.find((c) => c.id === 'once');
  assert.equal(cmd.status, 'failed');
  assert.match(cmd.error, /may already have been sent/);
  assert.equal(cmd.maybeSent, true);
  assert.equal(env.graph.state.replies.filter((r) => r.text === 'Only once').length, 1, 'never sent twice');
});

test('outbox: a temporary failure is retried on the next run', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const media = env.graph.state.media[0];
  const target = [...env.graph.state.comments.values()].find((c) => c.mediaId === media.id && !c.parentId && !c.hidden);
  await env.update('inbox', (d) => {
    d.outbox.push({ id: 'retry', type: 'reply_comment', payload: { commentId: target.id, text: 'Second try' }, status: 'pending', createdAt: new Date().toISOString() });
  });
  env.graph.state.faults.push({ method: 'POST', path: /\/replies$/, times: 1, error: { code: 2, status: 503, message: 'Service temporarily unavailable' } });
  await env.run({ only: ['outbox'] });
  let cmd = (await env.read('inbox')).outbox.find((c) => c.id === 'retry');
  assert.equal(cmd.status, 'pending');
  assert.equal(cmd.attempts, 1);
  await env.run({ only: ['outbox'] });
  cmd = (await env.read('inbox')).outbox.find((c) => c.id === 'retry');
  assert.equal(cmd.status, 'done');
  assert.equal(cmd.attempts, 2);
  assert.equal(env.graph.state.replies.filter((r) => r.text === 'Second try').length, 1);
});

test('a DM Instagram may have received (connection dropped) is never sent again and gets no public claim', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.rules = [PRICE_RULE];
  });
  await env.run({ only: ['automations'] });
  const c = env.addComment(env.graph.state.media[0].id, { username: 'flaky.line', text: 'price?' });
  env.graph.state.faults.push({ method: 'POST', path: /\/messages$/, times: 1, destroy: true });
  let mark = env.graph.state.requests.length;
  const res = await env.run({ only: ['automations'] });
  assert.equal(res.exitCode, 0);
  assert.equal(postsTo(env, mark, '/messages'), 1, 'not resent within the run');
  assert.ok(!env.graph.state.replies.some((r) => r.commentId === c.id), 'no "check your DMs" without a confirmed DM');
  const auto = await env.read('automations');
  assert.ok(auto.processed.comments[c.id]);
  assert.ok(auto.processed.users.r_price[c.fromId], 'the person is not DMed again by this rule');
  assert.equal(auto.activity[0].unsure, true);

  mark = env.graph.state.requests.length;
  await env.run({ only: ['automations'] });
  assert.equal(postsTo(env, mark, '/messages'), 0);
});

test('outbox: a command Instagram may have received is failed, not retried', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const media = env.graph.state.media[0];
  const target = [...env.graph.state.comments.values()].find((c) => c.mediaId === media.id && !c.parentId && !c.hidden);
  await env.update('inbox', (d) => {
    d.outbox.push({ id: 'flaky', type: 'reply_comment', payload: { commentId: target.id, text: 'Maybe sent' }, status: 'pending', createdAt: new Date().toISOString() });
  });
  env.graph.state.faults.push({ method: 'POST', path: /\/replies$/, times: 1, destroy: true });
  let mark = env.graph.state.requests.length;
  await env.run({ only: ['outbox'] });
  assert.equal(postsTo(env, mark, '/replies'), 1);
  const cmd = (await env.read('inbox')).outbox.find((c) => c.id === 'flaky');
  assert.equal(cmd.status, 'failed');
  assert.match(cmd.error, /may have gone through/);
  assert.equal(cmd.maybeSent, true);
  mark = env.graph.state.requests.length;
  await env.run({ only: ['outbox'] });
  assert.equal(postsTo(env, mark, '/replies'), 0);
});

const DAY = 864e5;

test('comment rules watch posts up to watchDays old and every post a rule is scoped to', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const st = env.graph.state;
  const old = st.media.find((m) => Date.now() - m.timestamp > 40 * DAY && Date.now() - m.timestamp < 80 * DAY);
  const ancient = st.media.find((m) => Date.now() - m.timestamp > 100 * DAY);
  assert.ok(st.media.indexOf(ancient) >= 50, 'the oldest posts are beyond the listed 50');
  const missing = '17999999999999999';
  await env.update('automations', (a) => {
    a.rules = [
      newRule({ id: 'r_scoped', name: 'Old reel', trigger: { source: 'comment', match: 'any', keywords: ['pattern'], mediaIds: [ancient.id, missing] }, actions: [{ type: 'reply_comment', texts: ['The pattern is in my shop.'] }], oncePerUser: false }),
      PRICE_RULE,
    ];
  });
  const mark = st.requests.length;
  await env.run({ only: ['automations'] });
  const first = st.requests.slice(mark);
  assert.equal(first.filter((r) => r.method === 'GET' && r.path.endsWith('/media')).length, 1, 'one listing call for 50 posts');
  assert.equal(first.find((r) => r.path.endsWith('/media')).params.limit, '50');
  assert.ok(/comments_count/.test(first.find((r) => r.path.endsWith('/media')).params.fields));
  assert.ok(first.some((r) => r.method === 'GET' && r.path.endsWith(`/${ancient.id}`)), 'the scoped post outside the listing is read by id');
  let auto = await env.read('automations');
  assert.ok(auto.cursors.goneMedia[missing], 'the deleted post is remembered');
  let log = await env.read('log');
  const goneLogs = () => log.entries.filter((e) => e.job === 'automations' && /not found on Instagram/.test(e.message)).length;
  assert.equal(goneLogs(), 1);
  assert.equal(log.runs[0].errors.length, 0, 'a deleted post does not fail the job');

  const c1 = env.addComment(old.id, { username: 'late.reader', text: 'price please?' });
  const c2 = env.addComment(ancient.id, { username: 'pattern.fan', text: 'Is the PATTERN available?' });
  // A post beyond the window that no rule is scoped to is not watched, so "all posts" rules skip it.
  const unwatched = st.media.find((m) => Date.now() - m.timestamp > 100 * DAY && m.id !== ancient.id);
  const c3 = env.addComment(unwatched.id, { username: 'other.fan', text: 'price?' });
  // Chosen posts outside the listing are read every 30 minutes (each costs a call).
  await env.update('automations', (a) => {
    a.cursors.pinnedCheckedAt = new Date(Date.now() - 31 * 60e3).toISOString();
  });
  const mark2 = st.requests.length;
  await env.run({ only: ['automations'] });
  const second = st.requests.slice(mark2);
  assert.ok(st.replies.some((r) => r.commentId === c1.id), 'a 2-month-old post is answered');
  assert.equal(st.replies.find((r) => r.commentId === c2.id)?.text, 'The pattern is in my shop.');
  assert.ok(!st.replies.some((r) => r.commentId === c3.id), 'unscoped rules only see watched posts');
  assert.ok(!second.some((r) => r.path.endsWith(`/${unwatched.id}/comments`)));
  // Comments are only read on the posts whose count changed.
  const commentReads = second.filter((r) => r.method === 'GET' && r.path.endsWith('/comments')).map((r) => r.path);
  assert.equal(commentReads.length, 2, `comment reads: ${commentReads.join(', ')}`);
  for (const id of [ancient.id, old.id]) assert.ok(commentReads.some((p) => p.endsWith(`/${id}/comments`)));
  // The deleted post is not looked up again within a day, and not logged again.
  assert.ok(!second.some((r) => r.path.endsWith(`/${missing}`)));
  log = await env.read('log');
  assert.equal(goneLogs(), 1);

  // Comment counts are kept only for watched posts.
  auto = await env.read('automations');
  const watched = Object.keys(auto.cursors.mediaComments);
  assert.ok(watched.includes(ancient.id) && watched.includes(old.id));
  assert.ok(watched.length <= 51, `at most the 50 listed posts plus the scoped one (${watched.length})`);
  // The inbox cache keeps the scoped post's comments with its details.
  const inbox = await env.read('inbox');
  assert.ok(inbox.comments.some((c) => c.id === c2.id && c.mediaId === ancient.id && c.media.caption));

  // The next run, minutes later, does not read the chosen old post again.
  const mark3 = st.requests.length;
  await env.run({ only: ['automations'] });
  assert.ok(!st.requests.slice(mark3).some((r) => r.path.endsWith(`/${ancient.id}`)), 'chosen old posts are not read on every run');
});

test('watch settings come from automations.limits and are clamped', async (t) => {
  const { watchLimits, pinnedMediaIds } = await import('../../worker/jobs/automations.mjs');
  assert.deepEqual(watchLimits(undefined), { days: 90, posts: 50 });
  assert.deepEqual(watchLimits({ maxActionsPerRun: 25 }), { days: 90, posts: 50 });
  assert.deepEqual(watchLimits({ watchDays: 0, watchPosts: 999 }), { days: 1, posts: 200 });
  assert.deepEqual(watchLimits({ watchDays: '30', watchPosts: 12.4 }), { days: 30, posts: 12 });
  assert.deepEqual(watchLimits({ watchDays: 'x', watchPosts: null }), { days: 90, posts: 50 });
  const ids = pinnedMediaIds([
    { enabled: true, trigger: { source: 'comment', mediaIds: ['1', 2] } },
    { enabled: false, trigger: { source: 'comment', mediaIds: ['3'] } },
    { enabled: true, trigger: { source: 'dm', mediaIds: ['4'] } },
    { enabled: true, trigger: { source: 'comment', mediaIds: null } },
  ]);
  assert.deepEqual([...ids], ['1', '2']);

  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.limits = { ...a.limits, watchDays: 7, watchPosts: 120 };
  });
  const st = env.graph.state;
  const mark = st.requests.length;
  await env.run({ only: ['automations'] });
  const lists = st.requests.slice(mark).filter((r) => r.method === 'GET' && r.path.endsWith('/media'));
  assert.equal(lists.length, 2, '70 posts in pages of 50');
  const weekOld = st.media.find((m) => Date.now() - m.timestamp > 10 * DAY);
  const c = env.addComment(weekOld.id, { username: 'x.y', text: 'price?' });
  await env.update('automations', (a) => {
    a.rules = [PRICE_RULE];
  });
  await env.run({ only: ['automations'] });
  assert.ok(!st.replies.some((r) => r.commentId === c.id), 'posts older than watchDays are not answered');
});

/** A DM that replies to the account's story, or a story mention (no text), in the mock. */
function addStoryMessage(env, kind, { username, text = '' }) {
  const { msg, other } = env.addMessage({ username, text });
  msg.story = kind === 'reply' ? { kind, id: env.graph.state.stories[0].id, file: 'story01.jpg' } : { kind, id: `1801${Math.floor(Math.random() * 1e9)}`, file: 'story02.jpg' };
  return { msg, other };
}

test('story replies and story mentions trigger their own rules, whatever shape Instagram reports', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.welcome = { enabled: true, text: 'Welcome {first_name}!' };
    a.rules = [
      newRule({ id: 'r_story', name: 'Story guide', trigger: { source: 'story_reply', match: 'any', keywords: ['guide'], mediaIds: null }, actions: [{ type: 'send_dm', texts: ['Here is the guide, {username}.'] }], oncePerUser: true }),
      newRule({ id: 'r_mention', name: 'Thanks for the mention', trigger: { source: 'story_mention', match: 'always', keywords: [], mediaIds: null }, actions: [{ type: 'send_dm', texts: ['Thank you for sharing, {mention}!'] }], oncePerUser: true }),
      newRule({ id: 'r_dm', name: 'DM guide', trigger: { source: 'dm', match: 'any', keywords: ['guide'], mediaIds: null }, actions: [{ type: 'send_dm', texts: ['Guide by DM.'] }], oncePerUser: false }),
    ];
  });
  await env.run({ only: ['automations'] });
  const st = env.graph.state;
  const textTo = (other) => st.sentMessages.filter((m) => m.recipientId === other.id).map((m) => m.text);

  for (const shape of ['story', 'reply_to']) {
    st.storyShape = shape;
    const reply = addStoryMessage(env, 'reply', { username: `replier.${shape}`, text: 'GUIDE please' });
    const mention = addStoryMessage(env, 'mention', { username: `mentioner.${shape}` });
    const dm = env.addMessage({ username: `dmer.${shape}`, text: 'guide?' });
    const res = await env.run({ only: ['automations'] });
    assert.equal(res.exitCode, 0);
    assert.deepEqual(textTo(reply.other), [`Here is the guide, replier.${shape}.`], `${shape}: story reply`);
    assert.deepEqual(textTo(mention.other), [`Thank you for sharing, @mentioner.${shape}!`], `${shape}: story mention`);
    assert.deepEqual(textTo(dm.other), ['Guide by DM.'], `${shape}: plain DM`);
  }
  const auto = await env.read('automations');
  const sources = new Set(auto.activity.filter((a) => a.ok).map((a) => a.source));
  assert.deepEqual([...sources].sort(), ['dm', 'story_mention', 'story_reply']);
  assert.equal(auto.rules.find((r) => r.id === 'r_mention').stats.fired, 2);

  // Without story fields (older API host), a story reply is treated as a DM and a mention gets the welcome message.
  st.storyShape = 'none';
  const plain = addStoryMessage(env, 'reply', { username: 'replier.none', text: 'guide' });
  const quiet = addStoryMessage(env, 'mention', { username: 'mentioner.none' });
  await env.run({ only: ['automations'] });
  assert.deepEqual(textTo(plain.other), ['Guide by DM.']);
  assert.deepEqual(textTo(quiet.other), ['Welcome mentioner.none!']);
});

test('a story mention without a rule gets the welcome message and its kind is cached for the inbox', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.welcome = { enabled: true, text: 'Hi {username}, thanks for the mention!' };
    a.rules = [];
  });
  await env.run({ only: ['automations'] });
  const cache = await env.read('inbox');
  const junie = cache.conversations.find((c) => c.participants.some((p) => p.username === 'junie.makes'));
  assert.equal(junie.lastMessage.story, 'mention', 'seeded story mention is marked in the cached preview');
  const oak = cache.conversations.find((c) => c.participants.some((p) => p.username === 'oak.and.ash'));
  assert.equal(oak.lastMessage.story, 'reply');

  await env.update('automations', (a) => {
    a.enabled = false;
  });
  const m = addStoryMessage(env, 'mention', { username: 'quiet.fan' });
  await env.run({ only: ['automations'] });
  assert.equal(env.graph.state.sentMessages.filter((x) => x.recipientId === m.other.id).length, 0, 'nothing is sent while automations are off');
});

const LINK_RULE = newRule({
  id: 'r_link',
  name: 'Link',
  trigger: { source: 'comment', match: 'any', keywords: ['link'], mediaIds: null },
  actions: [{ type: 'reply_comment', texts: ['Hi {mention}, the link is in my bio!'] }],
  oncePerUser: false,
});

test('rules never answer old comments on posts that just started being watched', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const st = env.graph.state;
  const age = (m) => Date.now() - m.timestamp;
  const repliedTo = (c) => st.replies.some((r) => r.commentId === c.id);
  const old50 = st.media.find((m) => age(m) > 45 * DAY && age(m) < 60 * DAY);
  const mid20 = st.media.find((m) => age(m) > 15 * DAY && age(m) < 30 * DAY);
  const newest = st.media[0];
  assert.ok(age(newest) < 14 * DAY);
  // State the previous version of the job leaves (it watched the newest 15 posts of the last 14 days):
  // on for 60 days, every comment so far recorded, no per-post watch starts yet.
  await env.update('automations', (a) => {
    a.rules = [LINK_RULE];
    a.cursors = { startedAt: new Date(Date.now() - 60 * DAY).toISOString(), mediaComments: {} };
    for (const m of st.media) a.cursors.mediaComments[m.id] = m.comments_count;
    a.processed.comments = Object.fromEntries([...st.comments.keys()].map((id) => [id, new Date().toISOString()]));
  });
  const c25 = env.addComment(old50.id, { username: 'late.asker', text: 'link?', at: Date.now() - 25 * DAY });
  const c3 = env.addComment(mid20.id, { username: 'mid.asker', text: 'link please', at: Date.now() - 3 * DAY });
  const fresh = env.addComment(newest.id, { username: 'fresh.asker', text: 'link?', at: Date.now() - 2 * 60e3 });
  let mark = st.requests.length;
  await env.run({ only: ['automations'] });
  assert.ok(repliedTo(fresh), 'a post the old job watched keeps answering new comments');
  assert.ok(!repliedTo(c25), 'a 25-day-old comment on a post that was not watched before is left alone');
  assert.ok(!repliedTo(c3), 'a 3-day-old comment on a post that was not watched before is left alone');
  // Newly watched posts cost no comment reads: their counts are just recorded.
  const reads = st.requests.slice(mark).filter((r) => r.path.endsWith('/comments')).map((r) => r.path);
  assert.ok(!reads.some((p) => p.endsWith(`/${old50.id}/comments`) || p.endsWith(`/${mid20.id}/comments`)), reads.join(', '));
  let auto = await env.read('automations');
  assert.ok(Date.now() - Date.parse(auto.cursors.watchedFrom[old50.id]) < 60e3);
  assert.ok(Math.abs(Date.parse(auto.cursors.watchedFrom[newest.id]) - newest.timestamp) < 1000, 'watched since it was published');
  assert.ok(auto.cursors.watchListedAt);
  // From now on the post is watched: a new comment is answered.
  const later = env.addComment(old50.id, { username: 'later.asker', text: 'link?' });
  await env.run({ only: ['automations'] });
  assert.ok(repliedTo(later));
  assert.ok(!repliedTo(c25));

  // A post chosen in a new rule (beyond the 50 listed) only counts comments from then on.
  const ancient = st.media.find((m) => age(m) > 100 * DAY);
  const before = env.addComment(ancient.id, { username: 'way.back', text: 'link for the pattern?', at: Date.now() - 2 * DAY });
  await env.update('automations', (a) => {
    a.rules = [{ ...LINK_RULE, id: 'r_old', trigger: { ...LINK_RULE.trigger, mediaIds: [ancient.id] } }, LINK_RULE];
  });
  mark = st.requests.length;
  await env.run({ only: ['automations'] });
  assert.ok(st.requests.slice(mark).some((r) => r.path.endsWith(`/${ancient.id}`)), 'a newly chosen post is looked up right away');
  assert.ok(!st.requests.slice(mark).some((r) => r.path.endsWith(`/${ancient.id}/comments`)));
  assert.ok(!repliedTo(before));
  const after = env.addComment(ancient.id, { username: 'now.asking', text: 'link?' });
  await env.update('automations', (a) => {
    a.cursors.pinnedCheckedAt = new Date(Date.now() - 31 * 60e3).toISOString();
  });
  await env.run({ only: ['automations'] });
  assert.ok(repliedTo(after));
  assert.ok(!repliedTo(before));

  // Raising the watch settings: posts that come into the window are not combed for old comments.
  const p70 = st.media.find((m) => age(m) > 92 * DAY && m.id !== ancient.id);
  const c5 = env.addComment(p70.id, { username: 'five.days', text: 'link?', at: Date.now() - 5 * DAY });
  await env.update('automations', (a) => {
    a.limits = { ...a.limits, watchDays: 365, watchPosts: 200 };
  });
  await env.run({ only: ['automations'] });
  assert.ok(!repliedTo(c5));
  auto = await env.read('automations');
  assert.ok(auto.cursors.watchedFrom[p70.id]);
});

test('a comment whose record housekeeping pruned is not answered again, and a new post counts every comment', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const st = env.graph.state;
  const age = (m) => Date.now() - m.timestamp;
  const repliedTo = (c) => st.replies.some((r) => r.commentId === c.id);
  await env.update('automations', (a) => {
    a.rules = [LINK_RULE];
    a.cursors = { startedAt: new Date(Date.now() - 90 * DAY).toISOString() };
  });
  await env.run({ only: ['automations'] });
  // A post watched for two months; a 20-day-old comment that a rule did not answer then (e.g. the rule
  // is new) and whose processed entry is gone.
  const post = st.media.find((m) => age(m) > 45 * DAY && age(m) < 60 * DAY);
  const old = env.addComment(post.id, { username: 'old.timer', text: 'link please', at: Date.now() - 20 * DAY });
  await env.update('automations', (a) => {
    a.cursors.watchedFrom[post.id] = new Date(post.timestamp).toISOString();
    delete a.processed.comments[old.id];
  });
  const fresh = env.addComment(post.id, { username: 'new.fan', text: 'link?' });
  await env.run({ only: ['automations'] });
  assert.ok(repliedTo(fresh));
  assert.ok(!repliedTo(old), 'comments older than 14 days get no automated action');

  // A post published since the previous run: comments made before this run are answered.
  const np = { ...structuredClone(st.media[0]), id: '17900000000000777', timestamp: Date.now() - 4 * 60e3, comments_count: 0, shortcode: 'NEWPOST1' };
  st.nodes.set(np.id, { type: 'media', obj: np });
  st.media.unshift(np);
  const first = env.addComment(np.id, { username: 'first.fan', text: 'link?', at: Date.now() - 3 * 60e3 });
  await env.run({ only: ['automations'] });
  assert.ok(repliedTo(first), 'the first comments on a new post are answered');
  const auto = await env.read('automations');
  assert.ok(Math.abs(Date.parse(auto.cursors.watchedFrom[np.id]) - np.timestamp) < 1000, 'watched since it was published');
});

test('a story reply that no story-reply rule answers is answered by the DM rules, not just welcomed', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  await env.update('automations', (a) => {
    a.welcome = { enabled: true, text: 'Welcome {first_name}!' };
    a.rules = [newRule({ id: 'r_ws', name: 'Workshop', trigger: { source: 'dm', match: 'any', keywords: ['workshop'], mediaIds: null }, actions: [{ type: 'send_dm', texts: ['Workshops run every Saturday.'] }], oncePerUser: false })];
  });
  await env.run({ only: ['automations'] });
  const st = env.graph.state;
  st.storyShape = 'story';
  const reply = addStoryMessage(env, 'reply', { username: 'story.asker', text: 'Is the workshop still open?' });
  await env.run({ only: ['automations'] });
  assert.deepEqual(st.sentMessages.filter((m) => m.recipientId === reply.other.id).map((m) => m.text), ['Workshops run every Saturday.']);
  const auto = await env.read('automations');
  const entry = auto.activity.find((a) => a.username === 'story.asker' && a.ok);
  assert.equal(entry.source, 'story_reply');
  assert.equal(entry.ruleName, 'Workshop');
});

test('a run where nothing happened writes nothing, and the newest DM thread is not read again and again', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const st = env.graph.state;
  await env.update('automations', (a) => {
    a.welcome = { enabled: true, text: 'Welcome! We reply within a day.' };
  });
  const commits = () => [...env.ghMock.commits.values()].filter((c) => /^worker: automations: /.test(c.message)).length;
  const at = (min) => Date.now() + min * 60e3;
  await env.run({ only: ['automations'] });
  const { conv, other } = env.addMessage({ username: 'new.customer', text: 'Hi there' });
  await env.run({ only: ['automations'] });
  assert.equal(st.sentMessages.filter((m) => m.recipientId === other.id).length, 1, 'welcomed');
  // Our welcome moved the thread's time: the next run reads it once more...
  await env.run({ only: ['automations'], now: at(10) });
  const auto = await env.read('automations');
  const inbox = await env.read('inbox');

  // ...after that, idle runs neither read it nor write anything.
  const threadReads = () => st.requests.filter((r) => r.method === 'GET' && r.path.endsWith(`/${conv.id}`)).length;
  const reads = threadReads();
  const before = commits();
  const writes = env.ghMock.stats.writes;
  await env.run({ only: ['automations'], now: at(20) });
  await env.run({ only: ['automations'], now: at(30) });
  assert.equal(threadReads(), reads, 'the settled thread is not read again');
  assert.equal(commits(), before, 'no automations commit');
  assert.equal(env.ghMock.stats.writes, writes, 'nothing written at all');
  assert.deepEqual((await env.read('automations')).processed, auto.processed);
  assert.equal((await env.read('inbox')).fetchedAt, inbox.fetchedAt);

  // Once the read time stamps are an hour old they are saved on their own, once.
  await env.run({ only: ['automations'], now: at(75) });
  assert.equal(commits(), before + 1);
  const later = await env.read('automations');
  assert.ok(Date.parse(later.cursors.watchListedAt) > Date.parse(auto.cursors.watchListedAt));
  assert.ok(Date.parse(later.cursors.inboxCheckedAt) >= Date.parse(later.cursors.watchListedAt));
  assert.deepEqual(later.processed, auto.processed);
  await env.run({ only: ['automations'], now: at(85) });
  assert.equal(commits(), before + 1);

  // A new message in the thread is still read and answered by the rules.
  await env.update('automations', (a) => {
    a.rules = [newRule({ id: 'r_hours', name: 'Hours', trigger: { source: 'dm', match: 'any', keywords: ['hours'], mediaIds: null }, actions: [{ type: 'send_dm', texts: ['We are open 9-5.'] }], oncePerUser: false })];
  });
  // (A later second than the welcome: this test's worker clock runs ahead of the mock's.)
  env.addMessage({ username: 'new.customer', text: 'What are your hours?', at: Date.now() + 1500 });
  await env.run({ only: ['automations'], now: at(95) });
  assert.equal(st.sentMessages.filter((m) => m.recipientId === other.id).length, 2);

  // Switched off: still no write on an idle run.
  await env.update('automations', (a) => void (a.enabled = false));
  await env.run({ only: ['automations'], now: at(105) });
  const off = commits();
  await env.run({ only: ['automations'], now: at(115) });
  assert.equal(commits(), off);
});

test('a comment on a chosen post read later than the others is still notified, once', async (t) => {
  const { b64url, generateVapidKeys } = await import('../../core/webpush.js');
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const st = env.graph.state;
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  const phone = { endpoint: `${env.url}/push/phone`, keys: { p256dh, auth: b64url(crypto.getRandomValues(new Uint8Array(16))) }, device: 'phone', createdAt: new Date().toISOString() };
  const vapid = { ...(await generateVapidKeys()), subject: 'mailto:owner@example.com' };
  await env.update('settings', (s) => {
    s.notifications = { vapid, subscriptions: [phone], events: { comment: true, dm: false, account: true } };
  });
  const chosen = st.media[60]; // beyond the listed posts: read by id every 30 minutes
  await env.update('automations', (a) => {
    a.limits = { ...a.limits, watchPosts: 5 };
    a.rules = [newRule({ id: 'r_give', name: 'Giveaway', trigger: { source: 'comment', match: 'always', keywords: [], mediaIds: [chosen.id] }, actions: [{ type: 'reply_comment', texts: ['Good luck!'] }], oncePerUser: false })];
  });
  await env.run({ only: ['automations'] });
  assert.equal(env.pushes.length, 0, 'nothing on the first run');

  const old = env.addComment(chosen.id, { username: 'giveaway.fan', text: 'Count me in' });
  env.addComment(st.media[0].id, { username: 'recent.fan', text: 'Lovely', at: Date.now() + 1000 });
  await env.run({ only: ['automations'] });
  assert.equal(env.pushes.length, 1, 'the newest post is read at once');

  // Half an hour later the chosen post is read: its comment is answered and notified too.
  await env.update('automations', (a) => void (a.cursors.pinnedCheckedAt = new Date(Date.now() - 31 * 60e3).toISOString()));
  await env.run({ only: ['automations'] });
  assert.ok(st.replies.some((r) => r.commentId === old.id), 'the rule answered');
  assert.equal(env.pushes.length, 2, 'and the owner is told');

  // Nothing new: no repeat.
  await env.update('automations', (a) => void (a.cursors.pinnedCheckedAt = new Date(Date.now() - 31 * 60e3).toISOString()));
  await env.run({ only: ['automations'] });
  assert.equal(env.pushes.length, 2);
  const auto = await env.read('automations');
  assert.ok(auto.cursors.commentsSeen[chosen.id] && auto.cursors.commentsSeen[st.media[0].id], 'a mark per post');
});
