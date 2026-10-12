// E2E: Automations screen (rules list, rule editor with test panel, toggles, templates, worker run).
// Run: node --test tests/e2e/automations.spec.mjs
//
// The dev server runs in this process (not as a child) so the test can add a fresh comment to the
// mock Instagram account and check what the worker sent. It binds an ephemeral port by default so it
// can run next to the other e2e specs; set AUTOMATIONS_E2E_PORT to pin one.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startDevServer } from '../../dev/server.mjs';
import { loadPlaywright, shot, unlock } from './helpers.mjs';

const PORT = Number(process.env.AUTOMATIONS_E2E_PORT || 0);

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

describe('Automations', { timeout: 240_000 }, () => {
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
