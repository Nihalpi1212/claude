// E2E: Inbox (comments grouped by post, older watched posts from the worker copy with the same count
// as Today, reply, hide/unhide, comments on/off, mark done,
// DM conversation reply with the 24-hour window, story reply / story mention chips, mentions gating,
// collaboration invites tab opened from #/inbox/invites, accept and decline, a live read that updates
// the saved invites, invites unavailable for the connection, the account's own story reply, four tabs
// that fit a phone).
// Run: node --test tests/e2e/inbox.spec.mjs
//
// The dev server runs in this process so the test can check what the mock Instagram API recorded.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startDevServer } from '../../dev/server.mjs';
import { loadPlaywright, shot, unlock } from './helpers.mjs';

const PORT = Number(process.env.INBOX_E2E_PORT || 5502);

let dev;
let browser;
let page;
const consoleErrors = [];

async function viewShot(name) {
  await page.waitForTimeout(350);
  const dir = process.env.SCREENSHOT_DIR || '/tmp/claude-0/-home-user-claude/61a6d9a0-a933-5d86-8721-920a439be9c7/scratchpad/shots';
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
}

async function readDoc(name) {
  await dev.seeded.store.refresh();
  return dev.seeded.store.read(name);
}

/** The n-th top-level comment card currently shown: { el, id, username }. */
async function topComment(n = 0) {
  const el = page.locator('.ibx-comments > .ibx-c').nth(n);
  await el.waitFor();
  const id = await el.getAttribute('data-comment-id');
  const username = (await el.locator('> .ibx-c-body > .ibx-c-meta .ibx-c-user').textContent()).replace(/^@/, '');
  return { el: page.locator(`[data-comment-id="${id}"]`), id, username };
}

describe('Inbox', { timeout: 240_000 }, () => {
  before(async () => {
    dev = await startDevServer({ port: PORT, seed: true, quiet: true });
    const { chromium } = loadPlaywright();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'light' });
    page = await context.newPage();
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.goto(`${dev.url}/postpilot/index.html#/inbox`);
    await unlock(page);
    await page.waitForSelector('.inbox .ibx-group', { timeout: 30_000 });
  });

  after(async () => {
    await browser?.close().catch(() => {});
    await dev?.close();
  });

  test('shows live comments grouped by post', async () => {
    await page.getByRole('heading', { name: 'Inbox', level: 1 }).waitFor();
    await page.getByText('Live from Instagram').waitFor();
    const groups = await page.locator('.ibx-group').count();
    assert.ok(groups >= 1, 'at least one post group');
    // Group headers carry the post caption and type from the mock account's latest posts.
    const first = dev.graph.state.media[0];
    const header = page.locator('.ibx-group').first().locator('.ibx-post');
    assert.match(await header.textContent(), /Reel|Post|Carousel/);
    assert.ok(first.caption.length > 0);
    // "Needs reply" is the default filter, with a count in the tab badge.
    assert.equal(await page.getByRole('radio', { name: /Needs reply/ }).getAttribute('aria-checked'), 'true');
    assert.match(await page.getByRole('tab', { name: /Comments/ }).textContent(), /\d+/);
    await shot(page, 'inbox-comments-desktop-light');
  });

  test('every comment Today counts is in the Inbox: older watched posts come from the worker copy', async () => {
    // The worker watches up to 50 posts / 90 days; live mode reads the latest 12. Today counts the
    // worker's copy (commentsNeedingReply), so the Inbox must list those comments too.
    const { needs, unread } = await page.evaluate(async () => {
      const { getStore } = await import('/postpilot/js/data.js');
      const { commentsNeedingReply } = await import('/postpilot/js/views/dashboard.js');
      const store = getStore();
      const [inbox, settings] = [await store.read('inbox'), await store.read('settings')];
      const seen = inbox.seen || {};
      const unread = (inbox.conversations || []).filter((c) => c.lastMessage && !c.lastMessage.fromMe && !(seen[c.id] && Date.parse(seen[c.id]) >= Date.parse(c.lastMessage.createdTime))).length;
      return { needs: commentsNeedingReply(inbox, settings).map((c) => ({ id: c.id, mediaId: c.mediaId })), unread };
    });
    const liveIds = new Set(dev.graph.state.media.filter((m) => m.media_product_type !== 'STORY').slice(0, 12).map((m) => m.id));
    assert.ok(needs.some((c) => !liveIds.has(c.mediaId)), 'the seed has comments to answer on posts older than the latest 12');

    // The Messages badge counts the worker's copy before the tab is opened (as Today does).
    assert.ok(unread > 0, 'the seed has unread conversations');
    assert.equal((await page.getByRole('tab', { name: /Messages/ }).textContent()).match(/\d+/)?.[0], String(unread));

    // The Comments badge and "Needs reply" match Today's count.
    await page.getByText('Live from Instagram').waitFor();
    assert.equal((await page.getByRole('tab', { name: /Comments/ }).textContent()).match(/\d+/)?.[0], String(needs.length));
    assert.match(await page.getByRole('radio', { name: /Needs reply/ }).textContent(), new RegExp(`\\(${needs.length}\\)`));

    const older = page.locator('section.ibx-older');
    await older.getByRole('heading', { name: 'Older posts' }).waitFor();
    assert.match(await older.textContent(), /from its last check/);
    // Older posts follow the live ones.
    const order = await page.locator('.ibx-group, .ibx-older').evaluateAll((els) => els.map((el) => el.classList.contains('ibx-older')));
    assert.ok(order.indexOf(true) > 0, 'live posts first');
    // Expand every post, then each counted comment is on the page.
    const more = page.getByRole('button', { name: /^Show \d+ more comments?$/ });
    while (await more.count()) await more.first().click();
    for (const c of needs) assert.equal(await page.locator(`[data-comment-id="${c.id}"]`).count(), 1, `comment ${c.id} on post ${c.mediaId} is in the Inbox`);
    await shot(page, 'inbox-comments-older-desktop-light');
    await page.reload(); // collapse the groups again for the tests that follow
    await page.waitForSelector('.inbox .ibx-group', { timeout: 30_000 });
  });

  test('an action on an older post goes to Instagram and updates the worker copy', async () => {
    const el = page.locator('section.ibx-older .ibx-comments > .ibx-c').first();
    await el.waitFor();
    const id = await el.getAttribute('data-comment-id');
    const username = (await el.locator('> .ibx-c-body > .ibx-c-meta .ibx-c-user').textContent()).replace(/^@/, '');
    const card = page.locator(`[data-comment-id="${id}"]`);
    await card.getByRole('button', { name: `Hide comment from @${username}` }).first().click();
    await page.locator('.toast', { hasText: `Comment from @${username} hidden` }).waitFor();
    await card.locator('.badge', { hasText: 'Hidden' }).first().waitFor();
    assert.ok(dev.graph.state.hidden.has(id), 'hidden on Instagram');
    // The worker reads a post again only when its comment count changes: the app updates its copy.
    const cachedHidden = async () => {
      const inbox = await readDoc('inbox');
      return (inbox.comments || []).find((c) => c.id === id)?.hidden;
    };
    let deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await cachedHidden()) !== true) await new Promise((r) => setTimeout(r, 250));
    assert.equal(await cachedHidden(), true);

    await card.getByRole('button', { name: `Unhide comment from @${username}` }).first().click();
    await page.locator('.toast', { hasText: `Comment from @${username} is visible again` }).waitFor();
    assert.equal(dev.graph.state.hidden.has(id), false);
    deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await cachedHidden()) !== false) await new Promise((r) => setTimeout(r, 250));
    assert.equal(await cachedHidden(), false);
  });

  test('DM problems name the messages permission of the login type', async () => {
    const perm = await page.evaluate(async () => {
      const { messagesPermission } = await import('/postpilot/js/views/inbox.js');
      return [messagesPermission('instagram'), messagesPermission('facebook')];
    });
    assert.deepEqual(perm, ['instagram_business_manage_messages', 'instagram_manage_messages']);
  });

  test('replies to a comment and the reply appears in the thread', async () => {
    const { el, id, username } = await topComment(0);
    await el.getByRole('button', { name: `Reply to @${username}` }).click();
    const box = el.getByRole('textbox', { name: `Reply to @${username}` });
    assert.equal(await box.inputValue(), `@${username} `);

    // Saved replies come from the Hashtags screen's saved replies.
    await el.getByRole('button', { name: 'Saved replies' }).click();
    await page.getByRole('menuitem', { name: /Shipping/ }).click();
    assert.equal(await box.inputValue(), `@${username} Yes, we ship worldwide. Orders go out every Friday.`);

    // AI suggestions (mock Anthropic) can be inserted too.
    await el.getByRole('button', { name: 'Suggest replies' }).click();
    await el.locator('.ibx-suggestion').first().waitFor({ timeout: 20_000 });

    await box.fill(`@${username} Thank you so much!`);
    await el.getByRole('button', { name: 'Send reply' }).click();
    await page.locator('.toast', { hasText: `Replied to @${username}` }).waitFor();
    const reply = el.locator('.ibx-replies .ibx-c', { hasText: 'Thank you so much!' });
    await reply.waitFor();
    assert.match(await reply.textContent(), /You/);
    const sent = dev.graph.state.replies.find((r) => r.commentId === id);
    assert.ok(sent, 'the mock Instagram API recorded the reply');
    assert.equal(sent.text, `@${username} Thank you so much!`);
  });

  test('hides and unhides a comment', async () => {
    const { el, id, username } = await topComment(1);
    await el.getByRole('button', { name: `Hide comment from @${username}` }).first().click();
    await el.locator('.badge', { hasText: 'Hidden' }).first().waitFor();
    assert.ok(dev.graph.state.hidden.has(id), 'hidden on Instagram');
    assert.equal(dev.graph.state.comments.get(id).hidden, true);
    // Replying is not possible while hidden.
    assert.equal(await el.getByRole('button', { name: `Reply to @${username}` }).isDisabled(), true);

    await page.getByRole('radio', { name: /^Hidden/ }).click();
    await page.locator(`[data-comment-id="${id}"]`).waitFor();
    await page.locator(`[data-comment-id="${id}"]`).getByRole('button', { name: `Unhide comment from @${username}` }).first().click();
    await page.locator('.toast', { hasText: `Comment from @${username} is visible again` }).waitFor();
    assert.equal(dev.graph.state.hidden.has(id), false);
    assert.equal(dev.graph.state.comments.get(id).hidden, false);
    await page.getByRole('radio', { name: /^Needs reply/ }).click();
  });

  test('marks a comment as done and saves it', async () => {
    const { el, id, username } = await topComment(2);
    await el.getByRole('button', { name: `Mark as done: comment from @${username}` }).click();
    await page.locator('.toast', { hasText: 'Marked as done' }).waitFor();
    await page.locator(`[data-comment-id="${id}"]`).waitFor({ state: 'detached' });
    const inbox = await readDoc('inbox');
    assert.ok(inbox.done && inbox.done[id], 'inbox.done records the comment');
  });

  test('turns comments off and on for a post', async () => {
    await page.getByRole('radio', { name: 'All' }).click();
    const group = page.locator('.ibx-group').first();
    const media = dev.graph.state.media[0];
    await group.getByRole('button', { name: 'Turn comments off' }).click();
    await page.getByRole('dialog', { name: 'Turn comments off for this post?' }).getByRole('button', { name: 'Turn comments off' }).click();
    await group.getByRole('button', { name: 'Turn comments on' }).waitFor();
    await group.locator('.badge', { hasText: 'Comments off' }).waitFor();
    assert.equal(media.is_comment_enabled, false);
    await group.getByRole('button', { name: 'Turn comments on' }).click();
    await group.getByRole('button', { name: 'Turn comments off' }).waitFor();
    assert.equal(media.is_comment_enabled, true);
  });

  test('replies to a DM inside the 24-hour window', async () => {
    await page.getByRole('tab', { name: /Messages/ }).click();
    const conv = page.getByRole('button', { name: /@mara\.lens/ });
    await conv.waitFor();
    await page.getByText('Live', { exact: true }).waitFor();
    await conv.click();
    const thread = page.getByRole('region', { name: 'Conversation with @mara.lens' });
    await thread.getByText(/Do you take custom orders\?/).waitFor();
    await thread.getByText(/You can reply until/).waitFor();
    await viewShot('inbox-messages-desktop-light');

    const box = thread.getByRole('textbox', { name: 'Message to @mara.lens' });
    await box.fill('Yes! Custom sets take about three weeks.');
    await thread.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('.toast', { hasText: 'Message sent to @mara.lens' }).waitFor();
    await thread.locator('.ibx-msg.is-mine', { hasText: 'Yes! Custom sets take about three weeks.' }).waitFor();
    const sent = dev.graph.state.sentMessages.find((m) => m.text === 'Yes! Custom sets take about three weeks.');
    assert.ok(sent, 'the mock Instagram API recorded the DM');
    assert.equal(sent.commentId, null);

    // Opening a conversation marks it read (inbox.seen).
    const inbox = await readDoc('inbox');
    assert.ok(inbox.seen && Object.keys(inbox.seen).length >= 1);
  });

  test('explains a closed reply window', async () => {
    await page.getByRole('button', { name: /@lin\.reads/ }).click();
    const thread = page.getByRole('region', { name: 'Conversation with @lin.reads' });
    await thread.getByText(/reply window closed/).first().waitFor();
    assert.equal(await thread.getByRole('textbox', { name: 'Message to @lin.reads' }).isDisabled(), true);
  });

  test('mentions explain the Facebook Login requirement', async () => {
    await page.getByRole('tab', { name: /Mentions/ }).click();
    await page.getByText('Tagged posts need a Facebook Login connection').waitFor();
    await page.getByRole('heading', { name: 'Mentions in your comments' }).waitFor();
  });

  test('messages mark story replies and story mentions', async () => {
    await page.getByRole('tab', { name: /Messages/ }).click();
    // The conversation list says what the last message was.
    const junie = page.getByRole('button', { name: /@junie\.makes/ });
    await junie.waitFor();
    await junie.getByText('Mentioned you in their story').waitFor();
    await page.getByRole('button', { name: /@oak\.and\.ash/ }).getByText('Story reply:').waitFor();

    await page.getByRole('button', { name: /@oak\.and\.ash/ }).click();
    const oak = page.getByRole('region', { name: 'Conversation with @oak.and.ash' });
    const reply = oak.locator('.ibx-story-chip', { hasText: 'Replied to your story' });
    await reply.waitFor();
    assert.match(await reply.getByRole('link', { name: 'View story' }).getAttribute('href'), /^http:\/\/.+story01\.jpg$/);
    await oak.getByText(/workshop on the 24th/).waitFor();

    await junie.click();
    const thread = page.getByRole('region', { name: 'Conversation with @junie.makes' });
    const chip = thread.locator('.ibx-story-chip', { hasText: 'Mentioned you in their story' });
    await chip.waitFor();
    assert.equal(await chip.getByRole('link', { name: 'View story' }).count(), 1);
    // A mention has no text, so no empty "Unsupported message" bubble is drawn for it.
    assert.equal(await thread.locator('.ibx-msg.has-story .ibx-msg-bubble').count(), 0);
    await viewShot('inbox-story-desktop-light');
  });

  test('#/inbox/invites opens the Invites tab; accept and decline answer Instagram', async () => {
    await page.goto(`${dev.url}/postpilot/index.html#/inbox/invites`);
    await page.waitForSelector('.app', { timeout: 30_000 });
    assert.equal(await page.getByRole('tab', { name: /Invites/ }).getAttribute('aria-selected'), 'true');
    assert.match(await page.getByRole('tab', { name: /Invites/ }).textContent(), /2/);
    const open = page.locator('section', { has: page.getByRole('heading', { name: 'Waiting for you' }) });
    await open.locator('.badge', { hasText: 'Live' }).waitFor();
    const atelier = open.locator('.ibx-invite', { hasText: '@atelier.kin' });
    await atelier.getByText('invited you to collaborate on their post').waitFor();
    await atelier.getByText(/joint mug collection/).waitFor();
    assert.match(await atelier.locator('img').getAttribute('src'), /f05\.jpg$/);
    await shot(page, 'inbox-invites-desktop-light');

    // The worker saved both invites on its first run.
    let inbox = await readDoc('inbox');
    assert.deepEqual(inbox.invites.map((i) => i.owner).sort(), ['atelier.kin', 'lumen.ceramics']);

    await atelier.getByRole('button', { name: 'Accept @atelier.kin’s invite' }).click();
    await page.locator('.toast', { hasText: 'Accepted.' }).waitFor();
    const atelierMedia = dev.graph.state.collabInvites.find((i) => i.owner === 'atelier.kin').media_id;
    assert.ok(dev.graph.state.collabResponses.some((r) => r.mediaId === atelierMedia && r.accept === true));
    const answered = page.locator('section', { has: page.getByRole('heading', { name: 'Answered' }) });
    await answered.locator('.ibx-invite', { hasText: '@atelier.kin' }).getByText('Accepted').waitFor();

    const lumen = open.locator('.ibx-invite', { hasText: '@lumen.ceramics' });
    await lumen.getByRole('button', { name: 'Decline @lumen.ceramics’s invite' }).click();
    const dialog = page.getByRole('dialog', { name: 'Decline @lumen.ceramics’s invite?' });
    await dialog.getByRole('button', { name: 'Decline invite' }).click();
    await page.locator('.toast', { hasText: 'Declined @lumen.ceramics’s invite.' }).waitFor();
    await answered.locator('.ibx-invite', { hasText: '@lumen.ceramics' }).getByText('Declined').waitFor();
    await open.getByText('No open invites').waitFor();
    // No device gets notifications in the demo workspace, so the phone is not promised.
    assert.equal(await open.getByText('New collaboration invites show up here.', { exact: true }).count(), 1);
    assert.equal(await open.getByText(/on your phone/).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Accept trusted accounts automatically' }).getAttribute('href'), '#/automations?section=collab');
    const lumenMedia = dev.graph.state.collabInvites.find((i) => i.owner === 'lumen.ceramics').media_id;
    assert.ok(dev.graph.state.collabResponses.some((r) => r.mediaId === lumenMedia && r.accept === false));

    inbox = await readDoc('inbox');
    const status = Object.fromEntries(inbox.invites.map((i) => [i.owner, i.status]));
    assert.deepEqual(status, { 'atelier.kin': 'accepted', 'lumen.ceramics': 'declined' });
    assert.ok(inbox.invites.every((i) => i.decidedAt));
    await shot(page, 'inbox-invites-answered-desktop-light');

    // Leaving the tab drops the /invites path; ?tab=invites opens it again.
    await page.getByRole('tab', { name: /Comments/ }).click();
    await page.waitForFunction(() => location.hash === '#/inbox');
    await page.goto(`${dev.url}/postpilot/index.html#/inbox?tab=invites`);
    await page.waitForSelector('.app', { timeout: 30_000 });
    assert.equal(await page.getByRole('tab', { name: /Invites/ }).getAttribute('aria-selected'), 'true');
    await page.getByRole('heading', { name: 'Answered' }).waitFor();
  });

  test('a new invite arriving while the tab is open can be accepted on a phone', async () => {
    dev.graph.state.collabInvites.push({ media_id: '17900000000004242', owner: 'north.trails', caption: 'Trail mugs, made together.', file: 'f02.jpg', status: 'pending' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: /Messages/ }).click();
    await page.getByRole('tab', { name: /Invites/ }).click();
    await page.getByRole('button', { name: 'Refresh' }).click();
    const row = page.locator('.ibx-invite', { hasText: '@north.trails' });
    await row.waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `no horizontal page scroll on invites (overflow ${overflow}px)`);
    await shot(page, 'inbox-invites-phone-light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'inbox-invites-phone-dark');
    await page.setViewportSize({ width: 1280, height: 860 });
    await shot(page, 'inbox-invites-desktop-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    // The app remembers invites it saw first, so the worker does not notify about them again.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !(await readDoc('inbox')).invites.some((i) => i.owner === 'north.trails')) await new Promise((r) => setTimeout(r, 250));
    assert.ok((await readDoc('inbox')).invites.some((i) => i.owner === 'north.trails' && i.status === 'pending'));
    await row.getByRole('button', { name: 'Accept @north.trails’s invite' }).click();
    await page.locator('.toast', { hasText: 'Accepted.' }).waitFor();
    assert.ok(dev.graph.state.collabResponses.some((r) => r.mediaId === '17900000000004242' && r.accept));
    // Leave a conversation open (?c=) like the earlier tests did, for the phone screenshots below.
    await page.getByRole('tab', { name: /Messages/ }).click();
    await page.getByRole('button', { name: /@lin\.reads/ }).click();
    await page.getByRole('region', { name: 'Conversation with @lin.reads' }).waitFor();
    await page.getByRole('tab', { name: /Comments/ }).click();
  });

  test('a live read brings the saved invites up to date: answered elsewhere, sent again, video previews', async () => {
    const st = dev.graph.state;
    st.collabInvites.push(
      { media_id: '17900000000005001', owner: 'pine.and.co', caption: 'Pine boxes for the mugs.', file: 'f03.jpg', status: 'pending' },
      { media_id: '17900000000005002', owner: 'river.clay', caption: 'River clay test.', file: 'f04.jpg', status: 'pending' },
      { media_id: '17900000000005003', owner: 'reel.partner', caption: 'Our studio reel.', file: 'clip.mp4', status: 'pending' },
    );
    // Declined two hours ago in Postpilot, and invited again since.
    st.collabInvites.find((i) => i.owner === 'lumen.ceramics').status = 'pending';
    const now = new Date().toISOString();
    await dev.seeded.store.update('inbox', (d) => {
      for (const [mediaId, owner] of [['17900000000005001', 'pine.and.co'], ['17900000000005002', 'river.clay']]) {
        d.invites.push({ id: `ci_e2e_${owner}`, mediaId, owner, caption: '', permalink: null, mediaUrl: null, status: 'pending', seenAt: now, decidedAt: null });
      }
      d.invites.find((i) => i.owner === 'lumen.ceramics').decidedAt = new Date(Date.now() - 2 * 36e5).toISOString();
    }, { message: 'e2e: saved invites' });
    // river.clay's invite was then answered in the Instagram app.
    st.collabInvites.find((i) => i.owner === 'river.clay').status = 'accepted';

    await page.goto(`${dev.url}/postpilot/index.html#/inbox/invites`);
    await page.reload(); // a hash-only goto keeps the page (and its two-minute live cache)
    await page.waitForSelector('.app', { timeout: 30_000 });
    const open = page.locator('section', { has: page.getByRole('heading', { name: 'Waiting for you' }) });
    await open.locator('.badge', { hasText: 'Live' }).waitFor();
    await open.locator('.ibx-invite', { hasText: '@lumen.ceramics' }).waitFor();
    await open.locator('.ibx-invite', { hasText: '@pine.and.co' }).waitFor();
    assert.equal(await open.locator('.ibx-invite', { hasText: '@river.clay' }).count(), 0);
    const reel = open.locator('.ibx-invite', { hasText: '@reel.partner' });
    await reel.waitFor();
    assert.equal(await reel.locator('img').count(), 0, 'a reel’s video file is not used as a preview image');
    await reel.locator('.ibx-invite-thumb .icon').waitFor();
    // The saved copy (tab count, Automations) follows Instagram's list.
    const deadline = Date.now() + 10_000;
    let inbox = await readDoc('inbox');
    while (Date.now() < deadline && inbox.invites.some((i) => i.owner === 'river.clay')) {
      await new Promise((r) => setTimeout(r, 250));
      inbox = await readDoc('inbox');
    }
    const status = Object.fromEntries(inbox.invites.map((i) => [i.owner, i.status]));
    assert.deepEqual(status, { 'atelier.kin': 'accepted', 'lumen.ceramics': 'pending', 'north.trails': 'accepted', 'pine.and.co': 'pending', 'reel.partner': 'pending' });
    await page.waitForFunction(() => /Invites\s*3/.test([...document.querySelectorAll('[role="tab"]')].pop()?.textContent || ''));
    await shot(page, 'inbox-invites-reconciled-desktop-light');
  });

  test('invites unavailable for this connection: no live read, no counts, answer in the app, check again', async () => {
    const st = dev.graph.state;
    st.collabMode = 'unsupported';
    await dev.seeded.store.update('inbox', (d) => {
      d.invitesStatus = { state: 'unsupported', at: new Date().toISOString(), message: 'Instagram does not let Postpilot read collaboration invites with this connection.' };
    }, { message: 'e2e: invites unsupported' });
    const reads = () => st.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/collaboration_invites')).length;
    const before = reads();
    await page.goto(`${dev.url}/postpilot/index.html#/inbox/invites`);
    await page.reload(); // a hash-only goto keeps the page (and its two-minute live cache)
    await page.waitForSelector('.app', { timeout: 30_000 });
    const callout = page.locator('.callout', { hasText: 'Invites are not available with this connection' });
    await callout.waitFor();
    const open = page.locator('section', { has: page.getByRole('heading', { name: 'Waiting for you' }) });
    await open.locator('.ibx-invite', { hasText: '@pine.and.co' }).getByText('Answer in the Instagram app').waitFor();
    assert.equal(await open.getByRole('button', { name: /^Accept/ }).count(), 0);
    assert.doesNotMatch(await page.getByRole('tab', { name: /Invites/ }).textContent(), /\d/, 'saved invites are not counted as waiting');
    assert.equal(reads(), before, 'no live read that is known to fail');
    await shot(page, 'inbox-invites-unsupported-desktop-light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'inbox-invites-unsupported-desktop-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    // Instagram offers invites again: "Check again" reads them live and clears the warning.
    st.collabMode = undefined;
    await callout.getByRole('button', { name: 'Check again' }).click();
    await open.locator('.badge', { hasText: 'Live' }).waitFor();
    await callout.waitFor({ state: 'detached' });
    await open.getByRole('button', { name: 'Accept @pine.and.co’s invite' }).waitFor();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await readDoc('inbox')).invitesStatus.state !== 'ok') await new Promise((r) => setTimeout(r, 250));
    assert.equal((await readDoc('inbox')).invitesStatus.state, 'ok');
  });

  test('a story reply the account sent itself is labelled from its side', async () => {
    const st = dev.graph.state;
    const conv = st.conversations.find((c) => c.participants.some((p) => p.username === 'kiko.studio'));
    const other = conv.participants.find((p) => p.id !== st.userId);
    const msg = { id: 'mid_own_story_reply', created_time: Date.now(), from: { id: st.userId, username: st.username }, to: [other], message: 'Love this glaze!', attachments: [], story: { kind: 'reply', id: '18010000000000077', file: 'story02.jpg' } };
    st.nodes.set(msg.id, { type: 'message', obj: msg });
    conv.messages.unshift(msg);
    await page.goto(`${dev.url}/postpilot/index.html#/inbox?tab=messages`);
    await page.reload(); // a hash-only goto keeps the page (and its two-minute live cache)
    await page.waitForSelector('.app', { timeout: 30_000 });
    const item = page.getByRole('button', { name: /@kiko\.studio/ });
    await item.getByText('Love this glaze!').waitFor();
    assert.equal(await item.getByText('Story reply:').count(), 0, 'the list does not call my own message a story reply');
    await item.click();
    const thread = page.getByRole('region', { name: 'Conversation with @kiko.studio' });
    const mine = thread.locator('.ibx-msg.is-mine', { hasText: 'Love this glaze!' });
    await mine.locator('.ibx-story-chip', { hasText: 'You replied to their story' }).waitFor();
    assert.equal(await thread.locator('.ibx-msg.is-mine .ibx-story-chip', { hasText: 'Replied to your story' }).count(), 0);
    await viewShot('inbox-own-story-reply-desktop-light');
    await page.getByRole('tab', { name: /Comments/ }).click();
  });

  test('screenshots in dark mode and on a phone, no horizontal scroll', async () => {
    await page.getByRole('tab', { name: /Comments/ }).click();
    await page.locator('.ibx-group').first().waitFor();
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'inbox-comments-desktop-dark');
    await page.getByRole('tab', { name: /Messages/ }).click();
    await page.locator('.ibx-thread-body').first().waitFor();
    await viewShot('inbox-messages-desktop-dark');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByRole('tab', { name: /Comments/ }).click();
    await page.locator('.ibx-group').first().waitFor();
    const { el, username } = await topComment(0);
    await el.getByRole('button', { name: `Reply to @${username}` }).click();
    await page.waitForTimeout(150);
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `no horizontal page scroll on comments (overflow ${overflow}px)`);
    const lastTab = await page.getByRole('tab', { name: /Invites/ }).boundingBox();
    assert.ok(lastTab.x + lastTab.width <= 390 - 8, `all four tabs fit a 390px phone (Invites ends at ${Math.round(lastTab.x + lastTab.width)}px)`);
    await shot(page, 'inbox-comments-phone-light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'inbox-comments-phone-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    await page.getByRole('tab', { name: /Messages/ }).click();
    // The last opened conversation (?c=) stays open; on a phone the list is one step back.
    await page.getByRole('button', { name: 'Back to conversations' }).click();
    await page.getByRole('button', { name: /@theo\.builds/ }).click();
    await page.getByRole('region', { name: 'Conversation with @theo.builds' }).getByText(/wholesale pricing/).waitFor();
    overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `no horizontal page scroll on messages (overflow ${overflow}px)`);
    await shot(page, 'inbox-messages-phone-light');
    await page.getByRole('button', { name: 'Back to conversations' }).click();
    await page.getByRole('navigation', { name: 'Conversations' }).waitFor();
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'inbox-conversations-phone-dark');
  });

  test('falls back to the worker copy when Instagram is unreachable and queues a reply for the worker', async () => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.emulateMedia({ colorScheme: 'light' });
    const errorsBefore = consoleErrors.length;
    // The browser cannot reach Instagram: listing recent posts fails at the network level (with retries).
    // (Chromium silently retries a reset GET once, so allow plenty of failures, then clear them.)
    dev.graph.state.faults.push({ method: 'GET', path: /\/media$/, times: 12, destroy: true });
    await page.goto(`${dev.url}/postpilot/index.html#/inbox`);
    await page.reload();
    await page.waitForSelector('.app', { timeout: 30_000 });
    await page.getByText('Showing the worker’s copy').waitFor({ timeout: 30_000 });
    await page.locator('.badge', { hasText: 'Cached copy' }).waitFor();
    await page.locator('.ibx-group').first().waitFor();
    dev.graph.state.faults.length = 0;

    const { el, id, username } = await topComment(0);
    await el.getByRole('button', { name: `Reply to @${username}` }).click();
    await el.getByRole('textbox', { name: `Reply to @${username}` }).fill(`@${username} Thanks, sent from the queue!`);
    await el.getByRole('button', { name: 'Send reply' }).click();
    await page.locator('.toast', { hasText: 'The worker will post your reply' }).waitFor();

    // The app queued the command in the encrypted inbox document and started the worker, which sends it.
    const deadline = Date.now() + 60_000;
    let cmd;
    while (Date.now() < deadline) {
      const inbox = await readDoc('inbox');
      cmd = (inbox.outbox || []).find((c) => c.type === 'reply_comment' && c.payload.commentId === id);
      if (cmd && cmd.status !== 'pending') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(cmd, 'reply_comment command queued');
    assert.equal(cmd.status, 'done');
    assert.ok(dev.graph.state.replies.some((r) => r.commentId === id && r.text === `@${username} Thanks, sent from the queue!`));
    // Network failures of the faulted requests show up as console errors; they are expected here.
    const added = consoleErrors.splice(errorsBefore);
    assert.ok(added.every((e) => /Failed to load resource|ERR_EMPTY_RESPONSE|ERR_CONNECTION/.test(e)), `unexpected console errors: ${added.join('\n')}`);
  });

  test('"Try again" in a stale tab does not reset an action the worker is already sending', async () => {
    const id = 'ob_e2e_retry_race';
    const errorsBefore = consoleErrors.length;
    await dev.seeded.store.update('inbox', (d) => {
      d.outbox ||= [];
      d.outbox.push({ id, type: 'reply_comment', payload: { commentId: '0', text: 'Retry race check' }, status: 'failed', error: 'Instagram is busy.', attempts: 1, createdAt: new Date().toISOString(), doneAt: new Date().toISOString() });
    }, { message: 'e2e: failed command' });
    await page.reload();
    await page.waitForSelector('.app', { timeout: 30_000 });
    const item = page.locator('.ibx-outbox-item', { hasText: 'Retry race check' });
    await item.getByRole('button', { name: 'Try again' }).waitFor({ timeout: 30_000 });

    // Meanwhile another tab retried it and a worker run claimed it; this tab still shows "failed".
    await dev.seeded.store.update('inbox', (d) => {
      const c = d.outbox.find((x) => x.id === id);
      Object.assign(c, { status: 'sending', error: null, attempts: 1 });
    }, { message: 'e2e: worker claims command' });
    await item.getByRole('button', { name: 'Try again' }).click();
    await page.locator('.toast', { hasText: 'This action is already being sent or was sent.' }).waitFor();
    const cmd = (await readDoc('inbox')).outbox.find((x) => x.id === id);
    assert.equal(cmd.status, 'sending', 'the claimed command is left to the worker');
    // The stale tab's first commit is rejected (422, not a fast-forward) before it re-reads; that is expected.
    const added = consoleErrors.splice(errorsBefore);
    assert.ok(added.every((e) => /status of 422/.test(e)), `unexpected console errors: ${added.join('\n')}`);

    await dev.seeded.store.update('inbox', (d) => {
      d.outbox = d.outbox.filter((x) => x.id !== id);
    }, { message: 'e2e: clean up' });
  });

  test('no console errors', () => {
    assert.deepEqual(consoleErrors, []);
  });
});
