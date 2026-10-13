// E2E: Automations screen (rules list, rule editor with test panel, toggles, templates, worker run,
// watched posts, post picker, story reply / story mention sources, collaboration-invite allowlist).
// Run: node --test tests/e2e/automations.spec.mjs
//
// The dev server runs in this process (not as a child) so the test can add a fresh comment or story
// reply to the mock Instagram account and check what the worker sent. Port 5501 by default; set
// AUTOMATIONS_E2E_PORT to change it (0 = any free port).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startDevServer } from '../../dev/server.mjs';
import { loadPlaywright, shot, unlock } from './helpers.mjs';

const PORT = Number(process.env.AUTOMATIONS_E2E_PORT ?? 5501);

let dev;
let browser;
let page;
const consoleErrors = [];

/** Viewport-only screenshot (overlays are position: fixed, so full-page shots crop them oddly). */
async function viewShot(name) {
  await page.waitForTimeout(350); // let the overlay's entry animation finish
  const dir = process.env.SCREENSHOT_DIR || '/tmp/claude-0/-home-user-claude/61a6d9a0-a933-5d86-8721-920a439be9c7/scratchpad/shots';
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
}

async function readDoc(name) {
  await dev.seeded.store.refresh();
  return dev.seeded.store.read(name);
}

/** Add a comment from someone else to the newest post on the mock account (like a real follower would). */
function addMockComment(text, username) {
  const st = dev.graph.state;
  const media = st.media[0];
  const id = `1809${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
  const c = { id, mediaId: media.id, parentId: null, text, timestamp: Date.now(), username, fromId: `79${String(Math.floor(Math.random() * 1e13)).padStart(14, '0')}`, like_count: 0, hidden: false };
  st.nodes.set(id, { type: 'comment', obj: c });
  st.comments.set(id, c);
  media.comments_count = (media.comments_count || 0) + 1;
  return c;
}

/** A DM replying to the account's story (kind 'reply') or a story mention (kind 'mention'), from a new person. */
function addMockStoryMessage(kind, text, username) {
  const st = dev.graph.state;
  const own = { id: st.userId, username: st.username };
  const other = { id: `79${String(Math.floor(Math.random() * 1e13)).padStart(14, '0')}`, username };
  const conv = { id: `conv_${username}`, participants: [other, own], messages: [] };
  st.nodes.set(conv.id, { type: 'conversation', obj: conv });
  st.conversations.push(conv);
  const msg = {
    id: `mid_${Math.floor(Math.random() * 1e12)}`,
    created_time: Date.now(),
    from: other,
    to: [own],
    message: text,
    attachments: [],
    story: kind === 'reply' ? { kind, id: st.stories[0].id, file: 'story01.jpg' } : { kind, id: '18010000000000001', file: 'story02.jpg' },
  };
  st.nodes.set(msg.id, { type: 'message', obj: msg });
  conv.messages.unshift(msg);
  return { conv, msg, other };
}

describe('Automations', { timeout: 300_000 }, () => {
  before(async () => {
    dev = await startDevServer({ port: PORT, seed: true, quiet: true });
    const { chromium } = loadPlaywright();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'light' });
    page = await context.newPage();
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.goto(`${dev.url}/postpilot/index.html#/automations`);
    await unlock(page);
    await page.waitForSelector('.automations .auto-rule', { timeout: 30_000 });
  });

  after(async () => {
    await browser?.close().catch(() => {});
    await dev?.close();
  });

  test('shows seeded rules, welcome message and blocked words', async () => {
    await page.getByRole('heading', { name: 'Automations', level: 1 }).waitFor();
    const names = await page.locator('.auto-rule-name').allTextContents();
    assert.deepEqual(names, ['Price questions', 'Workshop questions']);
    assert.match(await page.locator('.auto-rule').first().textContent(), /Comment contains price, how much, link or info/);
    assert.match(await page.locator('.auto-rule').nth(1).textContent(), /Message contains workshop, class or course…/);
    assert.equal(await page.getByRole('switch', { name: 'Send a welcome message' }).getAttribute('aria-checked'), 'true');
    await page.getByText('Sent once to people who message you, reply to your story or mention you in theirs for the first time').waitFor();
    await page.locator('.chip-label', { hasText: 'followers fast' }).waitFor();
    await page.getByText('Instagram allows one private reply per comment').waitFor();
    await shot(page, 'automations-desktop-light');
  });

  test('creates a keyword rule and the test panel shows the match and exact reply', async () => {
    await page.getByRole('button', { name: 'New rule' }).click();
    const dialog = page.getByRole('dialog', { name: 'New rule' });
    await dialog.waitFor();
    await dialog.getByLabel('Rule name').fill('Glaze questions');
    const kw = dialog.getByLabel('Keywords');
    await kw.fill('glaze');
    await kw.press('Enter');
    await dialog.getByLabel('Reply to the comment, version 1').fill('Thanks {username}! It is our speckled cream glaze.');

    // A near miss: "glazed" is not the whole word "glaze".
    await dialog.getByLabel('Sample comment').fill('Glazed donuts are the best');
    await dialog.locator('.rule-test-verdict', { hasText: 'No match' }).waitFor();

    await dialog.getByLabel('Sample comment').fill('Love it! What glaze is this?');
    await dialog.getByLabel('From').fill('new.fan');
    await dialog.locator('.rule-test-verdict', { hasText: 'Matches' }).waitFor();
    assert.match(await dialog.locator('.rule-test-verdict').textContent(), /on “glaze”/);
    await dialog.locator('.rule-test-text', { hasText: 'Thanks new.fan! It is our speckled cream glaze.' }).waitFor();

    // The hint says what {first_name} really becomes: the worker only gets usernames, so a
    // "{first_name|there}" fallback never shows "there".
    const hint = dialog.locator('p', { hasText: 'in messages.' });
    assert.match(await hint.textContent(), /does not get people’s names from Instagram, so \{first_name\} is their username too/);
    assert.doesNotMatch(await hint.textContent(), /uses “there”/);
    const reply = dialog.getByLabel('Reply to the comment, version 1');
    await reply.fill('Hi {first_name|there}!');
    await dialog.locator('.rule-test-text', { hasText: 'Hi new.fan!' }).waitFor();
    await reply.fill('Thanks {username}! It is our speckled cream glaze.');
    await dialog.locator('.rule-test-text', { hasText: 'Thanks new.fan! It is our speckled cream glaze.' }).waitFor();
    await viewShot('automations-editor-desktop-light');

    await dialog.getByRole('button', { name: 'Save rule' }).click();
    await page.locator('.toast', { hasText: 'Rule “Glaze questions” created' }).waitFor();
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(await page.locator('.auto-rule-name').allTextContents(), ['Price questions', 'Workshop questions', 'Glaze questions']);

    const doc = await readDoc('automations');
    const rule = doc.rules.find((r) => r.name === 'Glaze questions');
    assert.ok(rule, 'rule saved to the encrypted automations document');
    assert.deepEqual(rule.trigger, { source: 'comment', match: 'any', keywords: ['glaze'], mediaIds: null });
    assert.deepEqual(rule.actions, [{ type: 'reply_comment', texts: ['Thanks {username}! It is our speckled cream glaze.'] }]);
    assert.equal(rule.enabled, true);
  });

  test('blocks saving an invalid rule and explains why', async () => {
    await page.getByRole('button', { name: 'New rule' }).click();
    const dialog = page.getByRole('dialog', { name: 'New rule' });
    await dialog.getByRole('button', { name: 'Save rule' }).click();
    await dialog.getByText('Give the rule a name.').waitFor();
    await dialog.getByText('Add at least one keyword, or choose "Every message".').waitFor();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached' });
  });

  test('pauses a rule with its toggle and saves it', async () => {
    const sw = page.getByRole('switch', { name: 'Pause rule Workshop questions' });
    await sw.click();
    await page.locator('.toast', { hasText: 'Rule paused' }).waitFor();
    const turnOn = page.getByRole('switch', { name: 'Turn on rule Workshop questions' });
    assert.equal(await turnOn.getAttribute('aria-checked'), 'false');
    await page.locator('.auto-rule', { hasText: 'Workshop questions' }).getByText('Paused').waitFor();
    const doc = await readDoc('automations');
    assert.equal(doc.rules.find((r) => r.name === 'Workshop questions').enabled, false);
  });

  test('applies a starter template', async () => {
    await page.getByRole('button', { name: 'Use template: Hide spam words' }).click();
    const dialog = page.getByRole('dialog', { name: 'Hide spam words' });
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel('Rule name').inputValue(), 'Hide spam');
    await dialog.getByLabel('Sample comment').fill('Get FREE followers fast!!');
    await dialog.locator('.rule-test-verdict', { hasText: 'Matches' }).waitFor();
    await dialog.getByText('The comment would be hidden.').waitFor();
    await dialog.getByRole('button', { name: 'Save rule' }).click();
    await page.locator('.toast', { hasText: 'Rule “Hide spam” created' }).waitFor();
    assert.deepEqual(await page.locator('.auto-rule-name').allTextContents(), ['Price questions', 'Workshop questions', 'Glaze questions', 'Hide spam']);
  });

  test('moves a rule up', async () => {
    await page.getByRole('button', { name: 'Move Hide spam up' }).click();
    await page.locator('.toast', { hasText: 'Moved up' }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.auto-rule-name')].map((e) => e.textContent).join('|') === 'Price questions|Workshop questions|Hide spam|Glaze questions');
    await page.getByRole('button', { name: 'Move Hide spam down' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.auto-rule-name')].map((e) => e.textContent).join('|') === 'Price questions|Workshop questions|Glaze questions|Hide spam');
  });

  test('the worker fires the new rule on a matching comment and the activity feed shows it', async () => {
    const c = addMockComment('Love it! What glaze is this?', 'new.fan');
    await page.getByRole('button', { name: 'Run now' }).click();
    const row = page.locator('.auto-feed-row', { hasText: 'Replied to @new.fan’s comment' });
    await row.waitFor({ timeout: 60_000 });
    assert.match(await row.textContent(), /Glaze questions/);
    assert.match(await row.textContent(), /Thanks new\.fan! It is our speckled cream glaze\./);
    await page.locator('.auto-rule', { hasText: 'Glaze questions' }).getByText(/Fired 1 time/).waitFor();

    const sent = dev.graph.state.replies.find((r) => r.commentId === c.id);
    assert.ok(sent, 'the mock Instagram received the reply');
    assert.equal(sent.text, 'Thanks new.fan! It is our speckled cream glaze.');
    await shot(page, 'automations-after-run-desktop-light');
  });

  test('watched posts: the window and the post count are saved to the limits', async () => {
    const panel = page.locator('.auto-watch');
    await panel.getByText('Watch comments on posts from the last').waitFor();
    assert.equal(await panel.getByLabel('Days').inputValue(), '90');
    assert.equal(await panel.getByLabel('Posts').inputValue(), '50');
    await panel.getByText(/one Instagram call/).waitFor();
    await panel.getByText(/each one outside this window costs one more call every 30 minutes/).waitFor();
    await panel.getByText('Rules only answer comments made while a post is watched, so raising these numbers never answers old comments.').waitFor();
    await panel.getByLabel('Days').fill('0');
    await panel.getByText('Days: enter a number from 1 to 365.').waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Save watched posts' }).isDisabled(), true);
    await panel.getByLabel('Days').fill('120');
    await panel.getByLabel('Posts').fill('120');
    await panel.getByText(/up to 3 Instagram calls/).waitFor();
    await panel.getByRole('button', { name: 'Save watched posts' }).click();
    await page.locator('.toast', { hasText: 'Watched posts saved' }).waitFor();
    const doc = await readDoc('automations');
    assert.equal(doc.limits.watchDays, 120);
    assert.equal(doc.limits.watchPosts, 120);
    assert.equal(doc.limits.maxActionsPerRun, 25, 'the other limits are kept');
    await panel.screenshot({ path: `${process.env.SCREENSHOT_DIR || '/tmp/claude-0/-home-user-claude/61a6d9a0-a933-5d86-8721-920a439be9c7/scratchpad/shots'}/automations-watch-panel-light.png` });
  });

  test('a comment rule can be scoped to any post, newest first, found by caption search', async () => {
    const media = Object.values((await readDoc('analytics-media')).media).filter((m) => m.productType !== 'STORY');
    const newestFirst = media.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    assert.ok(newestFirst.length > 24, `analytics has more posts than the old picker showed (${newestFirst.length})`);
    await page.getByRole('button', { name: 'New rule' }).click();
    const dialog = page.getByRole('dialog', { name: 'New rule' });
    await dialog.getByText('Your newest 120 posts from the last 120 days, as set under Watched posts.').waitFor();
    await dialog.getByRole('radio', { name: 'Chosen posts' }).click();
    const grid = dialog.getByRole('group', { name: 'Choose posts' });
    await grid.locator('.frame').first().waitFor();
    assert.equal(await grid.locator('.frame').count(), Math.min(36, newestFirst.length));
    assert.match(await grid.locator('.frame').first().getAttribute('aria-label'), /^Choose post: /);
    if (newestFirst.length > 36) {
      await dialog.getByRole('button', { name: /Show more posts/ }).click();
      assert.equal(await grid.locator('.frame').count(), Math.min(108, newestFirst.length));
    }
    // The oldest post is there too; find it by a word of its caption.
    const oldest = newestFirst[newestFirst.length - 1];
    const word = String(oldest.caption).split(/\s+/).filter((w) => /^[a-z]{5,}$/i.test(w)).sort((a, b) => b.length - a.length)[0];
    await dialog.getByLabel('Search posts by caption').fill(word);
    const hits = newestFirst.filter((m) => String(m.caption).toLowerCase().includes(word.toLowerCase()));
    await page.waitForFunction((n) => document.querySelectorAll('[aria-label="Choose posts"] .frame').length === n, Math.min(hits.length, 36));
    await grid.locator('.frame').last().click();
    await dialog.getByText('1 chosen').waitFor();
    await viewShot('automations-picker-desktop-light');
    await dialog.getByLabel('Rule name').fill('Old post question');
    await dialog.getByLabel('Keywords').fill('pattern');
    await dialog.getByLabel('Keywords').press('Enter');
    await dialog.getByLabel('Reply to the comment, version 1').fill('The pattern is in the shop, {mention}.');
    await dialog.getByRole('button', { name: 'Save rule' }).click();
    await page.locator('.toast', { hasText: 'Rule “Old post question” created' }).waitFor();
    const doc = await readDoc('automations');
    const rule = doc.rules.find((r) => r.name === 'Old post question');
    assert.deepEqual(rule.trigger.mediaIds, [hits[Math.min(hits.length, 36) - 1].id]);
    await page.locator('.auto-rule', { hasText: 'Old post question' }).getByText('on 1 chosen post').waitFor();
  });

  test('a chosen post Instagram no longer has is flagged on the rule and in the picker', async () => {
    const doc = await readDoc('automations');
    const rule = doc.rules.find((r) => r.name === 'Old post question');
    const id = rule.trigger.mediaIds[0];
    await dev.seeded.store.update('automations', (a) => {
      a.cursors = { ...(a.cursors || {}), goneMedia: { [id]: new Date().toISOString() } };
    }, { message: 'e2e: a chosen post was deleted' });
    await page.reload();
    await page.waitForSelector('.automations .auto-rule', { timeout: 30_000 });
    const card = page.locator('.auto-rule', { hasText: 'Old post question' });
    await card.getByText('1 chosen post no longer exists on Instagram.').waitFor();
    await card.getByRole('button', { name: 'Edit the rule' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit rule' });
    const warning = dialog.locator('.rule-picker-missing');
    await warning.getByText(/One chosen post was not found on Instagram/).waitFor();
    assert.equal(await dialog.getByRole('group', { name: 'Choose posts' }).locator('.frame.is-selected, .frame[aria-pressed="true"]').count(), 0, 'the deleted post is not offered');
    await viewShot('automations-picker-gone-desktop-light');
    await warning.getByRole('button', { name: 'Remove it' }).click();
    await dialog.getByText('0 chosen').waitFor();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached' });
    await dev.seeded.store.update('automations', (a) => {
      delete a.cursors.goneMedia;
    }, { message: 'e2e: clean up' });
    await page.reload();
    await page.waitForSelector('.automations .auto-rule', { timeout: 30_000 });
  });

  test('switching a rule to story mentions offers DM actions and answers every mention', async () => {
    await page.getByRole('button', { name: 'New rule' }).click();
    const dialog = page.getByRole('dialog', { name: 'New rule' });
    await dialog.getByLabel('Listen to').selectOption({ label: 'Stories that mention me' });
    await dialog.getByText(/It usually has no text/).waitFor();
    assert.equal(await dialog.getByLabel('Match').locator('option:checked').textContent(), 'Every message');
    const options = await dialog.getByLabel('Action 1').locator('option').allTextContents();
    assert.deepEqual(options, ['Reply in DM', 'AI reply']);
    assert.equal(await dialog.getByRole('radio', { name: 'Chosen posts' }).count(), 0, 'no post scope outside comments');
    await dialog.getByLabel('Listen to').selectOption({ label: 'Replies to my stories' });
    await dialog.getByLabel('Sample story reply').waitFor();
    // Leaving story mentions puts the earlier Match back: a keyword rule never silently answers everything.
    assert.equal(await dialog.getByLabel('Match').locator('option:checked').textContent(), 'Contains any keyword');
    await dialog.getByLabel('Listen to').selectOption({ label: 'Stories that mention me' });
    await dialog.getByLabel('Listen to').selectOption({ label: 'Comments on my posts' });
    assert.equal(await dialog.getByLabel('Match').locator('option:checked').textContent(), 'Contains any keyword');
    // A Match chosen by hand is kept.
    await dialog.getByLabel('Listen to').selectOption({ label: 'Stories that mention me' });
    await dialog.getByLabel('Match').selectOption({ label: 'Contains all keywords' });
    await dialog.getByLabel('Listen to').selectOption({ label: 'Direct messages' });
    assert.equal(await dialog.getByLabel('Match').locator('option:checked').textContent(), 'Contains all keywords');
    await dialog.getByText(/Also answers replies to your stories when no “Replies to my stories” rule matches/).waitFor();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached' });
  });

  test('story mention template: matches a mention without text', async () => {
    await page.getByRole('button', { name: 'Use template: Thank people who mention you in their story' }).click();
    const dialog = page.getByRole('dialog', { name: 'Thank people who mention you in their story' });
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel('Listen to').locator('option:checked').textContent(), 'Stories that mention me');
    await dialog.locator('.rule-test-verdict', { hasText: 'Matches' }).waitFor();
    assert.match(await dialog.locator('.rule-test-verdict').textContent(), /every story mention/);
    await viewShot('automations-editor-mention-desktop-light');
    await dialog.getByRole('button', { name: 'Save rule' }).click();
    await page.locator('.toast', { hasText: 'Rule “Story mention thanks” created' }).waitFor();
    await page.locator('.auto-rule', { hasText: 'Story mention thanks' }).getByText('Every story mention').waitFor();
  });

  test('story reply template: the worker DMs the guide to someone who replies GUIDE to a story', async () => {
    await page.getByRole('button', { name: 'Use template: Reply GUIDE to my story → DM the guide' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reply GUIDE to my story → DM the guide' });
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel('Listen to').locator('option:checked').textContent(), 'Replies to my stories');
    await dialog.getByLabel('Sample story reply').fill('Guide please!');
    await dialog.locator('.rule-test-verdict', { hasText: 'Matches' }).waitFor();
    // The template's [your link] has to be replaced first.
    await dialog.getByRole('button', { name: 'Save rule' }).click();
    await dialog.getByText(/replace the text in \[brackets\]/).first().waitFor();
    await dialog.getByLabel('Reply in DM, version 1').fill('Here is the guide, {first_name}: https://studionorth.example/guide');
    await dialog.getByRole('button', { name: 'Save rule' }).click();
    await page.locator('.toast', { hasText: 'Rule “Story guide” created' }).waitFor();
    await page.locator('.auto-rule', { hasText: 'Story guide' }).getByText('Story reply contains guide').waitFor();

    const reply = addMockStoryMessage('reply', 'GUIDE please', 'story.fan');
    const mention = addMockStoryMessage('mention', '', 'trail.cafe');
    await page.getByRole('button', { name: 'Run now' }).click();
    const row = page.locator('.auto-feed-row', { hasText: 'Replied to @story.fan’s story reply' });
    await row.waitFor({ timeout: 60_000 });
    assert.match(await row.textContent(), /Story guide/);
    await page.locator('.auto-feed-row', { hasText: 'Sent @trail.cafe a DM for their story mention' }).waitFor();
    const sent = (other) => dev.graph.state.sentMessages.filter((m) => m.recipientId === other.id).map((m) => m.text);
    assert.deepEqual(sent(reply.other), ['Here is the guide, story.fan: https://studionorth.example/guide']);
    assert.equal(sent(mention.other).length, 1);
    assert.match(sent(mention.other)[0], /trail\.cafe/);
    await shot(page, 'automations-story-run-desktop-light');
  });

  test('collaboration invite allowlist is saved without @ and in lower case', async () => {
    const panel = page.locator('.auto-collab');
    await panel.scrollIntoViewIfNeeded();
    await panel.getByRole('button', { name: '2 invites waiting' }).waitFor();
    const input = panel.getByLabel('Accept automatically from');
    await input.fill('@Atelier.Kin');
    await input.press('Enter');
    await panel.locator('.chip-label', { hasText: 'atelier.kin' }).waitFor();
    await input.fill('bad name!');
    await input.press('Enter');
    await panel.getByText('Not a valid username: bad name!').waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Save allowlist' }).isDisabled(), true);
    await panel.getByRole('button', { name: 'Remove bad name!' }).click();
    await panel.getByRole('button', { name: 'Save allowlist' }).click();
    await page.locator('.toast', { hasText: 'Allowlist saved' }).waitFor();
    assert.deepEqual((await readDoc('automations')).collabAllowlist, ['atelier.kin']);
    await panel.screenshot({ path: `${process.env.SCREENSHOT_DIR || '/tmp/claude-0/-home-user-claude/61a6d9a0-a933-5d86-8721-920a439be9c7/scratchpad/shots'}/automations-collab-panel-light.png` });

    await panel.getByRole('button', { name: '2 invites waiting' }).click();
    await page.waitForFunction(() => location.hash === '#/inbox/invites');
    assert.equal(await page.getByRole('tab', { name: /Invites/ }).getAttribute('aria-selected'), 'true');
    await page.locator('.ibx-invite', { hasText: '@atelier.kin' }).waitFor();
    await page.goto(`${dev.url}/postpilot/index.html#/automations`);
    await page.waitForSelector('.automations .auto-rule', { timeout: 30_000 });
  });

  test('the Invites tab link opens the allowlist in view on a phone, ready to type', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${dev.url}/postpilot/index.html#/inbox/invites`);
    await page.getByRole('link', { name: 'Accept trusted accounts automatically' }).click();
    await page.waitForFunction(() => location.hash === '#/automations?section=collab');
    // The panel is the last one on a page about five screens tall: it is scrolled into view and its field focused.
    await page.waitForFunction(() => document.activeElement && document.activeElement.closest('.auto-collab') && document.activeElement.tagName === 'INPUT', null, { timeout: 20_000 });
    await page.waitForTimeout(1000); // smooth scrolling
    const pos = await page.evaluate(() => {
      const title = document.querySelector('.auto-collab .panel-title').getBoundingClientRect();
      return { top: title.top, bottom: title.bottom, bar: document.querySelector('.mobile-topbar').getBoundingClientRect().bottom, scrollY: window.scrollY };
    });
    assert.ok(pos.scrollY > 1000, `scrolled down to the panel (scrollY ${pos.scrollY})`);
    assert.ok(pos.top >= pos.bar && pos.bottom <= 844 - 60, `panel title visible below the top bar (title ${Math.round(pos.top)}–${Math.round(pos.bottom)}, top bar ends at ${pos.bar})`);
    // No device gets notifications in the demo workspace, so the hint does not promise the phone.
    const panel = page.locator('.auto-collab');
    await panel.getByText(/Invites from anyone else wait in Inbox → Invites\. Postpilot checks/).waitFor();
    assert.equal(await panel.getByText(/notify your phone/).count(), 0);
    await shot(page, 'automations-collab-deeplink-phone-light');
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto(`${dev.url}/postpilot/index.html#/automations`);
    await page.waitForSelector('.automations .auto-rule', { timeout: 30_000 });
  });

  test('DM problems name the messages permission of the login type', async () => {
    const texts = await page.evaluate(async () => {
      const { dmProblemOf } = await import('/postpilot/js/views/automations.js');
      return ['instagram', 'facebook'].map((mode) => ['needs_advanced_access', 'no_permission'].map((code) => dmProblemOf(code, mode).body));
    });
    for (const body of texts[0]) assert.match(body, /instagram_business_manage_messages/);
    for (const body of texts[1]) {
      assert.match(body, /instagram_manage_messages/);
      assert.doesNotMatch(body, /instagram_business_/, 'Facebook Login never names the Instagram Login scopes');
    }
    // The seeded (Instagram Login) workspace shows its own permission name.
    const before = (await readDoc('automations')).status;
    await dev.seeded.store.update('automations', (d) => {
      d.status = { ...(d.status || {}), dm: 'no_permission' };
    }, { message: 'e2e: DM problem' });
    await page.reload();
    await page.waitForSelector('.automations .auto-rule', { timeout: 30_000 });
    const callout = page.locator('.callout', { hasText: 'Postpilot cannot read your messages' });
    await callout.getByText(/instagram_business_manage_messages/).waitFor();
    await dev.seeded.store.update('automations', (d) => {
      d.status = { ...(d.status || {}), dm: (before && before.dm) ?? null };
    }, { message: 'e2e: DM problem cleared' });
    await page.reload();
    await page.waitForSelector('.automations .auto-rule', { timeout: 30_000 });
  });

  test('screenshots in dark mode and on a phone', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, 'automations-desktop-dark');
    await page.getByRole('button', { name: 'New rule' }).click();
    await page.getByRole('dialog', { name: 'New rule' }).waitFor();
    await viewShot('automations-editor-desktop-dark');
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `no horizontal page scroll on a phone (overflow ${overflow}px)`);
    await shot(page, 'automations-phone-light');
    await page.locator('.auto-rule-name', { hasText: 'Glaze questions' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit rule' });
    await dialog.waitFor();
    await dialog.getByLabel('Sample comment').fill('what glaze?');
    await dialog.locator('.rule-test-verdict', { hasText: 'Matches' }).waitFor();
    await viewShot('automations-editor-phone-light');
    await page.keyboard.press('Escape');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'automations-phone-dark');
  });

  test('no console errors', () => {
    assert.deepEqual(consoleErrors, []);
  });
});
