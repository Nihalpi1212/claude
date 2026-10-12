// E2E: Inbox (comments grouped by post, reply, hide/unhide, comments on/off, mark done,
// DM conversation reply with the 24-hour window, mentions gating).
// Run: node --test tests/e2e/inbox.spec.mjs
//
// The dev server runs in this process so the test can check what the mock Instagram API recorded.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startDevServer } from '../../dev/server.mjs';
import { loadPlaywright, shot, unlock } from './helpers.mjs';

const PORT = Number(process.env.INBOX_E2E_PORT || 5214);

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

  test('no console errors', () => {
    assert.deepEqual(consoleErrors, []);
  });
});
