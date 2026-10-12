// E2E: Today (dashboard), Library and Autopilot against the seeded dev server.
// Run: node --test tests/e2e/home.spec.mjs
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp, shot } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, '../../dev/fixtures/f02.jpg');
const PORT = 5215;

let h;
let page;

async function go(hash) {
  await page.evaluate((x) => (location.hash = x), hash);
}

async function toastText(re, timeout = 15_000) {
  const t = page.locator('.toast', { hasText: re }).first();
  await t.waitFor({ timeout });
  return t.textContent();
}

/** Close the composer (and confirm discarding if it asks). */
async function closeComposer() {
  await page.keyboard.press('Escape');
  const discard = page.getByRole('button', { name: /^Discard/ });
  if (await discard.isVisible().catch(() => false)) await discard.click();
  else {
    await page.waitForTimeout(300);
    if (await discard.isVisible().catch(() => false)) await discard.click();
  }
}

describe('Today, Library and Autopilot', { timeout: 240_000 }, () => {
  before(async () => {
    h = await openApp({ port: PORT, hash: '#/' });
    page = h.page;
  });
  after(async () => {
    if (h) await h.close();
  });

  test('dashboard shows the account, KPIs, the week and up next', async () => {
    await page.locator('.dash-account').waitFor({ timeout: 20_000 });
    await page.locator('.dash-account', { hasText: '@studio.north' }).waitFor();
    assert.match(await page.locator('.page-title').textContent(), /Today/);
    assert.match(await page.locator('.page-subtitle').textContent(), /scheduled for the next 7 days/);

    const labels = (await page.locator('.dash-kpis .stat-label').allTextContents()).map((s) => s.trim().toLowerCase());
    assert.deepEqual(labels, ['followers', 'reach', 'views', 'interactions']);
    await page.waitForFunction(() => /\d/.test(document.querySelector('.dash-kpis .stat .stat-value')?.textContent || ''));
    await page.waitForFunction(() => /\d/.test(document.querySelectorAll('.dash-kpis .stat .stat-value')[1]?.textContent || ''));

    await page.locator('.dash-upnext .dash-post').first().waitFor();
    const upNext = await page.locator('.dash-upnext .dash-post').count();
    assert.ok(upNext >= 3 && upNext <= 5, `up next shows 3-5 posts (got ${upNext})`);
    assert.equal(await page.locator('.dash-day').count(), 7);

    // Alerts from the seed: a failed post and an autopilot draft waiting for approval.
    await page.locator('.dash-alerts .callout', { hasText: 'failed to publish' }).waitFor();
    await page.locator('.dash-alerts .callout', { hasText: 'waiting for your approval' }).waitFor();

    // Recent posts come from analytics-media.
    assert.ok((await page.locator('.dash-sheet > li').count()) >= 3);
    await page.locator('.dash-side', { hasText: 'Inbox' }).waitFor();

    await shot(page, 'home-e2e-dashboard');

    // A day in the week strip opens the planner week view.
    await page.locator('.dash-day').nth(1).click();
    await page.waitForFunction(() => location.hash.startsWith('#/planner') && location.hash.includes('view=week'));
    await go('#/');
    await page.locator('.dash-account').waitFor();
  });

  test('library: upload, filter, search, tag, autopilot pool, create post', async () => {
    await go('#/library');
    await page.locator('.lib-item').first().waitFor({ timeout: 20_000 });
    const before = await page.locator('.lib-item').count();
    assert.equal(before, 16, 'seeded library has 16 files');

    // Upload a fixture through the file input.
    await page.setInputFiles('.lib-file-input', FIXTURE);
    await toastText(/Added 1 file to your library/, 30_000);
    await page.waitForFunction((n) => document.querySelectorAll('.lib-item').length === n, before + 1);
    const item = page.locator('.lib-item', { has: page.locator('.frame-label', { hasText: 'f02.jpg' }) });
    await item.waitFor();
    assert.match(await page.locator('.page-subtitle').textContent(), /17 files/);

    // Filters.
    await page.getByRole('radio', { name: 'Videos' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.lib-item').length === 1);
    assert.match(await page.locator('.lib-item .frame-label').first().textContent(), /Reel/);
    await page.getByRole('radio', { name: 'Photos' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.lib-item').length === 16);
    await page.getByRole('radio', { name: 'All' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.lib-item').length === 17);

    // Search by tag.
    await page.getByRole('searchbox', { name: 'Search media' }).fill('coffee');
    await page.waitForFunction(() => document.querySelectorAll('.lib-item').length === 2);
    await page.getByRole('searchbox', { name: 'Search media' }).fill('');
    await page.waitForFunction(() => document.querySelectorAll('.lib-item').length === 17);

    // Folder filter.
    await page.locator('.lib-folder', { hasText: 'Ceramics' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.lib-item').length === 3);
    await page.locator('.lib-folder', { hasText: 'All media' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.lib-item').length === 17);

    // Select the upload and tag it.
    await page.getByRole('button', { name: 'Select f02.jpg', exact: true }).click();
    await page.locator('.lib-selbar', { hasText: '1 selected' }).waitFor();
    await page.locator('.lib-selbar').getByRole('button', { name: 'Add tags' }).click();
    const dialog = page.getByRole('dialog', { name: /Add tags/ });
    await dialog.waitFor();
    await dialog.getByRole('textbox').fill('e2etest');
    await dialog.getByRole('textbox').press('Enter');
    await dialog.getByRole('button', { name: 'Add tags' }).click();
    await toastText(/Tagged 1 file with #e2etest/);

    // Add it to the autopilot pool.
    await page.locator('.lib-selbar').getByRole('button', { name: 'Add to autopilot' }).click();
    await toastText(/Added 1 file to the autopilot pool/);
    await page.locator('.lib-selbar').getByRole('button', { name: 'Clear' }).click();
    await page.getByRole('radio', { name: 'Autopilot pool' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.lib-item').length === 5);
    await item.waitFor();
    await page.getByRole('searchbox', { name: 'Search media' }).fill('e2etest');
    await page.waitForFunction(() => document.querySelectorAll('.lib-item').length === 1);
    await page.getByRole('searchbox', { name: 'Search media' }).fill('');
    await page.getByRole('radio', { name: 'All' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.lib-item').length === 17);

    // Details drawer shows the tag and where a file is used.
    await item.locator('.frame').click();
    const drawer = page.getByRole('dialog', { name: 'f02.jpg' });
    await drawer.waitFor();
    await drawer.locator('.chip', { hasText: 'e2etest' }).waitFor();
    await drawer.getByText('Not used in any post yet.').waitFor();
    await shot(page, 'home-e2e-library-drawer');
    await drawer.getByRole('button', { name: 'Close' }).click();
    await drawer.waitFor({ state: 'detached' });

    // Create a post from two selected files: the composer opens with both.
    await page.getByRole('button', { name: 'Select f02.jpg', exact: true }).click();
    await page.getByRole('button', { name: 'Select Glaze bubbles', exact: true }).click();
    await page.locator('.lib-selbar', { hasText: '2 selected' }).waitFor();
    await shot(page, 'home-e2e-library-selection');
    await page.locator('.lib-selbar').getByRole('button', { name: 'Create post' }).click();
    const composer = page.locator('.drawer[role="dialog"]').last();
    await composer.waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => {
      const d = [...document.querySelectorAll('.drawer[role="dialog"]')].pop();
      return d && d.querySelectorAll('.frame').length >= 2;
    }, null, { timeout: 15_000 });
    await closeComposer();
    await page.waitForFunction(() => !document.querySelector('.drawer[role="dialog"]'), null, { timeout: 10_000 });
    assert.equal(await page.locator('.lib-selbar').count(), 0, 'selection is cleared after creating a post');
  });

  test('autopilot: save settings, run now, approve a draft', async () => {
    await go('#/autopilot');
    await page.locator('.ap-status').waitFor({ timeout: 20_000 });
    await page.locator('.ap-approvals .ap-row').first().waitFor();
    const seededApprovals = await page.locator('.ap-approvals .ap-row').count();
    assert.equal(seededApprovals, 1, 'the seed has one draft waiting for approval');
    // The uploaded file is in the pool and ready.
    assert.ok((await page.locator('.ap-pool-item:not(.is-used)').count()) >= 3);

    // Settings: 14 posts a week, 4 hours apart.
    await page.getByLabel('Posts per week').fill('14');
    await page.getByLabel('Minimum gap between posts').selectOption({ label: '4 hours' });
    await page.locator('.ap-dirty').waitFor();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await toastText(/Autopilot settings saved/);
    await page.locator('.ap-dirty').waitFor({ state: 'detached' });
    // The preview now plans posts from the pool.
    await page.locator('.ap-plan .ap-plan-item').first().waitFor();

    // Turn it on.
    await page.getByRole('switch', { name: /Autopilot is off/ }).click();
    await toastText(/Autopilot is on/);
    await page.locator('.ap-status.is-on').waitFor();

    // Run now: the worker drafts posts that need approval.
    await page.getByRole('button', { name: 'Run autopilot now' }).click();
    await page.waitForFunction((n) => document.querySelectorAll('.ap-approvals .ap-row').length > n, seededApprovals, { timeout: 120_000 });
    await toastText(/Autopilot drafted \d+ posts?/, 60_000);
    const drafted = await page.locator('.ap-approvals .ap-row').count();
    assert.ok(drafted >= 3, `autopilot drafted posts (now ${drafted} waiting)`);
    assert.match(await page.locator('.ap-status-last').textContent(), /Last run/);
    await shot(page, 'home-e2e-autopilot-drafts');

    // Approve the first one.
    await page.locator('.ap-approvals .ap-row').first().getByRole('button', { name: 'Approve' }).click();
    await toastText(/Approved\. Scheduled for/);
    await page.waitForFunction((n) => document.querySelectorAll('.ap-approvals .ap-row').length === n - 1, drafted);
    await page.locator('.ap-scheduled .ap-row').first().waitFor();

    // Reject another: it leaves the list and its media leaves the pool.
    const poolBefore = await page.locator('.ap-pool-item').count();
    await page.locator('.ap-approvals .ap-row').first().getByRole('button', { name: 'Reject' }).click();
    await page.getByRole('dialog', { name: 'Reject this draft?' }).getByRole('button', { name: 'Reject draft' }).click();
    await toastText(/Draft rejected/);
    await page.waitForFunction((n) => document.querySelectorAll('.ap-approvals .ap-row').length === n - 2, drafted);
    await page.waitForFunction((n) => document.querySelectorAll('.ap-pool-item').length === n - 1, poolBefore);

    // The dashboard reflects it.
    await go('#/');
    await page.locator('.dash-side', { hasText: 'Autopilot' }).locator('.status', { hasText: 'On' }).waitFor();

    // Quick action: upload straight from Today.
    await page.setInputFiles('.dash input[type="file"]', FIXTURE);
    await toastText(/Added 1 file to the library/, 30_000);
  });

  test('no console errors', () => {
    const errors = h.consoleErrors.filter((e) => !/favicon/i.test(e));
    assert.deepEqual(errors, []);
  });
});
