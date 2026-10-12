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
