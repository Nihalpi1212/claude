// E2E: Settings (seeded workspace) and Onboarding (fresh workspace) on port 5216.
// Run: node --test tests/e2e/settings.spec.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { loadPlaywright, openApp, shot, startDevServer, unlock } from './helpers.mjs';

const PORT = Number(process.env.SETTINGS_E2E_PORT) || 5216;

// Requests these tests trigger on purpose fail with an HTTP status, which Chromium logs as a console
// error ("Failed to load resource"). Only those exact requests are allowed; anything else fails the test.
const EXPECTED_FAILURES = [
  /\/mock\/anthropic\//, // the rejected "bad-key" test
  /\/mock\/ig\/.*access_token=expired-token/, // the expired-token error message test
  /\/mock\/gh\/repos\/demo\/postpilot\/git\/ref\/heads\/postpilot-data$/, // a fresh repository has no data branch yet
  /\/mock\/gh\/repos\/demo\/postpilot\/actions\/secrets\/POSTPILOT_DATA_KEY$/, // the secret does not exist before "Connect worker"
  /fonts\.(googleapis|gstatic)\.com/, // web fonts on a blocked network
];

function trackErrors(page) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = (m.location() && m.location().url) || '';
    if (/^Failed to load resource/.test(m.text()) && EXPECTED_FAILURES.some((re) => re.test(url))) return;
    errors.push(`${m.text()} ${url}`.trim());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function screenshots(h, hash, name, waitFor) {
  for (const [vw, vh, tag] of [[1280, 860, 'desktop'], [390, 844, 'phone']]) {
    for (const scheme of ['light', 'dark']) {
      const ctx = await h.browser.newContext({ viewport: { width: vw, height: vh }, colorScheme: scheme });
      const page = await ctx.newPage();
      const errors = trackErrors(page);
      await page.goto(`${h.url}/postpilot/index.html${hash}`);
      await unlock(page);
      if (waitFor) await page.waitForSelector(waitFor, { timeout: 20_000 });
      await page.waitForTimeout(800);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${name} ${tag} ${scheme}: page scrolls sideways by ${overflow}px`);
      await shot(page, `${name}-${tag}-${scheme}`);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  }
}

test('settings: sections, theme, AI key + test, backup, worker, activity log', { timeout: 240_000 }, async () => {
  const h = await openApp({ port: PORT, hash: '#/settings' });
  const { page } = h;
  const errors = trackErrors(page);
  try {
    await page.waitForSelector('.settings-page', { timeout: 20_000 });

    // Every section renders, with seeded data.
    for (const title of ['Instagram', 'Worker', 'AI', 'Preferences', 'Notifications', 'Security', 'Data', 'Activity log', 'About']) {
      await page.locator('.settings-section .panel-title', { hasText: new RegExp(`^${title}$`) }).first().waitFor();
    }
    await page.locator('#settings-instagram').getByText('@studio.north').first().waitFor();
    await page.locator('#settings-instagram').getByText('Instagram Login (no Facebook Page)').waitFor();
    await page.locator('#settings-worker').getByText('Recent runs').waitFor();
    await page.locator('#settings-activity .settings-log-row').first().waitFor();

    // Section navigation updates the address.
    await page.locator('.settings-nav').getByRole('button', { name: 'Security' }).click();
    await page.waitForFunction(() => location.hash.includes('section=security'));

    // Check the live Instagram connection.
    await page.getByRole('button', { name: 'Check connection' }).click();
    await page.getByText('Instagram connection works.').waitFor();
    await page.locator('#settings-instagram').getByText(/Published through the API in the last 24 hours/).waitFor();

    // Theme: Dark, then back to System.
    await page.getByRole('radio', { name: 'Dark' }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await page.evaluate(() => localStorage.getItem('postpilot.theme')), 'dark');
    await page.getByRole('radio', { name: 'Light' }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    await page.getByRole('radio', { name: 'System' }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme ?? null), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('postpilot.theme')), null);

    // AI: save a new key, test it against the mock, then a rejected key.
    const key = page.locator('#settings-ai-key');
    await key.fill('sk-ant-e2e-key');
    const save = page.getByRole('button', { name: 'Save AI settings' });
    await save.click();
    await page.getByText('AI settings saved.').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Save AI settings') && b.disabled));
    await page.locator('#settings-ai').getByRole('button', { name: 'Test' }).click();
    await page.getByText('Claude answered a sample comment').waitFor({ timeout: 20_000 });
    await key.fill('bad-key');
    await page.locator('#settings-ai').getByText('Anthropic API keys start with sk-ant-').waitFor();
    await page.locator('#settings-ai').getByRole('button', { name: 'Test' }).click();
    await page.getByText('The test failed').waitFor({ timeout: 20_000 });
    assert.match(await page.locator('#settings-ai .callout-danger').innerText(), /rejected/i);
    await key.fill('sk-ant-e2e-key');

    // Backup downloads every document, without secrets by default.
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download backup' }).click()]);
    assert.match(download.suggestedFilename(), /^postpilot-backup-\d{4}-\d{2}-\d{2}\.json$/);
    const backup = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(backup.app, 'postpilot');
    assert.ok(backup.docs.posts.posts.length >= 10, 'backup has the seeded posts');
    assert.equal(backup.docs.settings.ig.token, '', 'Instagram token is left out');
    assert.equal(backup.docs.settings.ai.apiKey, '', 'AI key is left out');
    assert.equal(backup.docs.settings.ig.username, 'studio.north');

    // Restore rejects files that are not backups.
    await page.locator('#settings-data input[type=file]').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
    await page.getByText('This file is not a Postpilot backup').waitFor();

    // Worker: run now from Settings.
    await page.locator('#settings-worker').getByRole('button', { name: 'Run now' }).click();
    await page.getByText('Worker started.').waitFor();

    // Activity log filter.
    await page.locator('#settings-activity').getByRole('radio', { name: 'Errors' }).click();
    await page.locator('#settings-activity').getByRole('radio', { name: 'All' }).click();
    await page.locator('#settings-activity .settings-log-row').first().waitFor();

    // Security: wrong current passphrase is explained.
    const sec = page.locator('#settings-security');
    await sec.getByLabel('Current passphrase').fill('not the passphrase');
    await sec.getByLabel('New passphrase', { exact: true }).fill('a brand new passphrase');
    await sec.getByLabel('Repeat new passphrase').fill('a brand new passphrase');
    await sec.getByRole('button', { name: 'Change passphrase' }).click();
    await sec.getByText('The current passphrase is not right').waitFor({ timeout: 20_000 });

    assert.deepEqual(errors, []);
    await shot(page, 'settings-flow-end');
    await screenshots(h, '#/settings', 'settings', '.settings-section');
  } finally {
    await h.close();
  }
});

test('onboarding: new workspace → connect Instagram → connect worker → time zone → done', { timeout: 300_000 }, async () => {
  const server = await startDevServer({ port: PORT, seed: false });
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  let errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    errors = trackErrors(page);
    await page.goto(`${server.url}/postpilot/index.html#/`);

    // Lock screen: create a workspace.
    await page.waitForSelector('#lock-token', { timeout: 20_000 });
    await page.fill('#lock-token', 'mock-token');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForSelector('#lock-new-passphrase', { timeout: 20_000 });
    await page.fill('#lock-new-passphrase', 'a fresh e2e passphrase');
    await page.fill('#lock-new-passphrase-2', 'a fresh e2e passphrase');
    await page.getByRole('button', { name: 'Create encrypted workspace' }).click();
    await page.waitForSelector('.onboarding', { timeout: 60_000 });
    await page.getByRole('heading', { name: 'Connect your Instagram account' }).waitFor();

    // Step 1: instructions are numbered and every external link opens in a new tab.
    assert.equal(await page.locator('.ci-howto ol.ci-steps > li').count(), 7);
    const links = await page.locator('.ci-howto a').evaluateAll((as) => as.map((a) => ({ href: a.href, target: a.target, rel: a.rel })));
    assert.ok(links.length >= 2);
    for (const l of links) {
      assert.equal(l.target, '_blank', `${l.href} opens in a new tab`);
      assert.match(l.rel, /noopener/);
    }
    assert.ok(links.some((l) => l.href.startsWith('https://developers.facebook.com/apps')));
    await shot(page, 'onboarding-1-instagram-desktop-light');

    // Errors say what to fix.
    const connect = page.getByRole('button', { name: 'Connect', exact: true });
    await connect.click();
    await page.getByText('Paste your access token first').waitFor();
    await page.fill('#ci-token', 'EAAB1234567890');
    await connect.click();
    await page.getByText('This is a Facebook token').waitFor();
    await page.fill('#ci-token', 'expired-token');
    await connect.click();
    await page.getByText('This token has expired').waitFor();

    // Facebook Login shows its own steps.
    await page.locator('.ci-mode', { hasText: 'Facebook Login' }).click();
    await page.locator('.ci-perms code', { hasText: 'instagram_manage_messages' }).waitFor();
    await page.locator('.ci-mode', { hasText: 'Instagram Login' }).click();

    await page.fill('#ci-token', '  mock-token \n');
    await connect.click();
    await page.getByText('Token works.').waitFor({ timeout: 20_000 });
    await page.getByText('@studio.north').first().waitFor();
    await page.getByRole('button', { name: 'Use @studio.north' }).click();

    // Step 2: connect the worker (sealed-box secret) and run it once.
    await page.getByRole('heading', { name: /Turn on the worker/ }).waitFor({ timeout: 20_000 });
    assert.match(await page.evaluate(() => location.hash), /#\/onboarding\?step=worker/);
    await page.getByText('not saved yet').waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Connect worker' }).click();
    await page.getByText('Worker connected. It can now read your encrypted data.').waitFor({ timeout: 20_000 });
    await page.locator('.ws-check.is-ok', { hasText: 'Data key secret' }).waitFor();
    await page.getByRole('button', { name: 'Run worker now' }).click();
    // The dev server opens the secret with its private key and runs the worker: success proves the key decrypts.
    await page.getByText('The worker ran successfully').waitFor({ timeout: 90_000 });
    await shot(page, 'onboarding-2-worker-desktop-light');
    await page.getByRole('button', { name: 'Continue' }).click();

    // Step 3: time zone.
    await page.getByRole('heading', { name: 'Preferences' }).waitFor();
    const tz = page.getByLabel('Time zone');
    await tz.fill('europe/berlin');
    await page.getByText(/It is .* there now/).waitFor();
    await shot(page, 'onboarding-3-preferences-desktop-light');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await page.getByText('Preferences saved.').waitFor();

    // Step 4: done.
    await page.getByRole('heading', { name: "You're set up" }).waitFor();
    await page.getByText('connected as @studio.north.').waitFor();
    await page.getByText('Europe/Berlin.').waitFor();
    await page.getByText('publishes, replies and saves analytics every 10 minutes.').waitFor();
    await shot(page, 'onboarding-4-done-desktop-light');

    // Phone + dark layouts of the first step (a second browser profile on the same workspace).
    for (const scheme of ['light', 'dark']) {
      const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
      const p = await pctx.newPage();
      await p.goto(`${server.url}/postpilot/index.html#/onboarding?step=instagram`);
      await p.waitForSelector('#lock-token', { timeout: 20_000 });
      await p.fill('#lock-token', 'mock-token');
      await p.getByRole('button', { name: 'Continue' }).click();
      await p.waitForSelector('#lock-passphrase', { timeout: 20_000 });
      await p.fill('#lock-passphrase', 'a fresh e2e passphrase');
      await p.getByRole('button', { name: 'Unlock' }).click();
      await p.waitForSelector('.onboarding', { timeout: 30_000 });
      await p.getByRole('button', { name: 'Use a different account' }).click();
      await p.waitForTimeout(500);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `onboarding phone ${scheme} scrolls sideways by ${overflow}px`);
      await shot(p, `onboarding-1-instagram-phone-${scheme}`);
      await p.goto(`${server.url}/postpilot/index.html#/onboarding?step=worker`);
      await p.getByText('Data key secret').waitFor();
      await p.waitForTimeout(800);
      await shot(p, `onboarding-2-worker-phone-${scheme}`);
      await pctx.close();
    }

    assert.deepEqual(errors, []);
  } finally {
    await browser.close().catch(() => {});
    await server.close();
  }
});
