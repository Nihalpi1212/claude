// E2E: Today (dashboard), Library and Autopilot against the seeded dev server.
// Run: node --test tests/e2e/home.spec.mjs
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp, shot, unlock } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, '../../dev/fixtures/f02.jpg');
const PORT = Number(process.env.HOME_E2E_PORT || 5513);

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

/** A second, separate browser tab (own storage), unlocked. Its console is not checked. */
async function secondPage() {
  const context = await h.browser.newContext({ viewport: { width: 1280, height: 860 } });
  const p = await context.newPage();
  await p.goto(`${h.url}/postpilot/index.html#/`);
  await unlock(p);
  return { p, close: () => context.close() };
}

/** The dashboard Inbox card's "Comments to answer" value. */
async function dashCommentsToAnswer(p) {
  const row = p.locator('.dash-side .dash-kv-row', { hasText: 'Comments to answer' });
  await row.waitFor({ timeout: 20_000 });
  return (await row.locator('dd').textContent()).trim();
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

  test('dashboard counts comments to answer the same way as the Inbox', async () => {
    // The dashboard reads the worker's cached comments; with Instagram unreachable the Inbox shows that
    // same cache, so its "Needs reply" count must match the dashboard's.
    const t = await secondPage();
    try {
      const p = t.p;
      // The card says where its numbers come from (the worker's last check).
      await p.locator('.dash-side', { hasText: 'Inbox' }).locator('.dash-side-scope').waitFor({ timeout: 20_000 });
      const dash = await dashCommentsToAnswer(p);
      assert.match(dash, /^\d+$/);
      assert.ok(Number(dash) > 0, 'the seed has comments waiting for a reply');
      await p.route(/\/mock\/ig\/[^?]*\/media(\?|$)/, (r) =>
        r.request().method() === 'GET'
          ? r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'E2E: media list unavailable', type: 'OAuthException', code: 100 } }) })
          : r.continue(),
      );
      await p.evaluate(() => (location.hash = '#/inbox'));
      await p.locator('.badge', { hasText: 'Cached copy' }).waitFor({ timeout: 30_000 });
      const label = await p.getByRole('radio', { name: /^Needs reply/ }).textContent();
      assert.equal(label.match(/\((\d+)\)/)?.[1], dash, `Inbox "${label.trim()}" vs dashboard ${dash}`);
    } finally {
      await t.close();
    }
  });

  test('a failed post is not reported as a worker problem', async () => {
    await go('#/');
    await page.locator('.dash-account').waitFor({ timeout: 20_000 });
    // The fake scheduled run finishes well after every run the app dispatched (the seed run).
    const lastDispatched = await page.evaluate(async () => {
      const data = await import('/postpilot/js/data.js');
      const log = await data.readDoc('log');
      return Math.max(0, ...(log.runs || []).filter((r) => r.trigger === 'workflow_dispatch').map((r) => Date.parse(r.finishedAt) || 0));
    });
    const now = Math.max(Date.now(), lastDispatched + 10_000);
    const fake = (extra) => ({ startedAt: new Date(now - 30_000).toISOString(), finishedAt: new Date(now).toISOString(), durationMs: 30_000, trigger: 'schedule', reason: 'e2e-fake', counts: { published: 0, failed: 1 }, ...extra });
    // Writes through the app's own data layer (the page imports the same module instance).
    const setFake = (run) =>
      page.evaluate(async (r) => {
        const data = await import('/postpilot/js/data.js');
        await data.mutate('log', (l) => {
          l.runs = [...(r ? [r] : []), ...(l.runs || []).filter((x) => x.reason !== 'e2e-fake')];
        });
      }, run);
    try {
      // The worker ran fine; only a post was rejected (worker/run.mjs stores ok:false for that).
      await setFake(fake({ ok: false, errors: [] }));
      await page.locator('.dash-health-item', { hasText: 'Worker ran' }).waitFor();
      await page.locator('.dash-alerts .callout', { hasText: 'failed to publish' }).waitFor();
      assert.equal(await page.locator('.dash-alerts .callout', { hasText: 'The last worker run had a problem' }).count(), 0);
      assert.match(await page.locator('.sidebar .worker-status').textContent(), /Worker running/);

      // "Run now" waits for the run it started, not a scheduled run that was already going.
      const found = await page.evaluate(async (since) => {
        const { waitForWorkerRun } = await import('/postpilot/js/app.js');
        return waitForWorkerRun(since, 5000);
      }, now);
      assert.equal(found, null, 'a scheduled run is not taken for the dispatched one');

      // A job error is a worker problem.
      await setFake(fake({ ok: false, errors: [{ job: 'publish', message: 'E2E boom' }] }));
      await page.locator('.dash-alerts .callout', { hasText: 'The last worker run had a problem' }).locator('text=E2E boom').waitFor();
      await page.locator('.dash-health-item', { hasText: 'Worker had a problem' }).waitFor();
      await page.locator('.sidebar .worker-status', { hasText: 'Worker had a problem' }).waitFor();
    } finally {
      await setFake(null);
    }
    await page.locator('.sidebar .worker-status', { hasText: 'Worker running' }).waitFor();
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

  test("dashboard before the worker's first sync does not claim there is nothing", async () => {
    await go('#/');
    await page.locator('.dash-account').waitFor({ timeout: 20_000 });
    const saved = await page.evaluate(async () => {
      const data = await import('/postpilot/js/data.js');
      return { media: await data.readDoc('analytics-media'), inbox: await data.readDoc('inbox'), log: await data.readDoc('log') };
    });
    try {
      // A fresh workspace: the worker has not filled post stats or the inbox cache yet.
      await page.evaluate(async () => {
        const data = await import('/postpilot/js/data.js');
        await data.mutate('analytics-media', () => ({ media: {} }));
        await data.mutate('inbox', (d) => ({ ...d, comments: [], conversations: [], fetchedAt: null }));
        await data.mutate('log', (d) => ({ ...d, runs: [] }));
      });
      await page.locator('.dash-recent .empty-title', { hasText: 'Post stats are on their way' }).waitFor();
      const inbox = page.locator('.dash-side', { hasText: 'Inbox' });
      await inbox.getByText("Comments and messages show up here after the worker's first check.").waitFor();
      assert.equal(await dashCommentsToAnswer(page), '—');
      assert.equal(await inbox.getByText('You are all caught up').count(), 0);
      await shot(page, 'home-e2e-dashboard-before-sync');
    } finally {
      await page.evaluate(async (s) => {
        const data = await import('/postpilot/js/data.js');
        await data.mutate('analytics-media', () => s.media);
        await data.mutate('inbox', () => s.inbox);
        await data.mutate('log', () => s.log);
      }, saved);
    }
    await page.locator('.dash-sheet > li').first().waitFor();
  });

  test('boot: a failed first read shows the reason and a way out instead of spinning forever', async () => {
    const t = await secondPage();
    const p = t.p;
    const boot = p.locator('.boot-error');
    try {
      // Expired or revoked token.
      const ref = /\/mock\/gh\/repos\/[^/]+\/[^/]+\/git\/ref\//;
      const deny = (r) => r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'Bad credentials' }) });
      await p.route(ref, deny);
      await p.reload();
      await boot.getByText('GitHub rejected your access token').waitFor({ timeout: 20_000 });
      await boot.getByRole('button', { name: 'Lock and use a different token' }).waitFor();
      await shot(p, 'home-e2e-boot-error');
      // Try again once GitHub accepts it.
      await p.unroute(ref, deny);
      await boot.getByRole('button', { name: 'Try again' }).click();
      await p.locator('.app .dash-account').waitFor({ timeout: 20_000 });

      // Offline: retries by itself when the connection comes back.
      const offline = (r) => r.abort('internetdisconnected');
      await p.route(ref, offline);
      await p.reload();
      await boot.getByText('Could not reach GitHub').waitFor({ timeout: 20_000 });
      await p.unroute(ref, offline);
      await p.evaluate(() => window.dispatchEvent(new Event('online')));
      await p.locator('.app .dash-account').waitFor({ timeout: 20_000 });

      // The saved data key no longer decrypts the workspace.
      await p.evaluate(() => {
        const s = JSON.parse(sessionStorage.getItem('postpilot.session'));
        s.dataKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
        sessionStorage.setItem('postpilot.session', JSON.stringify(s));
      });
      await p.reload();
      // Resuming may already drop a key that does not decrypt (lock screen); otherwise the app explains it.
      await p.locator('.boot-error, #lock-token, #lock-passphrase').first().waitFor({ timeout: 20_000 });
      if (await boot.count()) {
        await boot.getByText("This device's saved key no longer opens your workspace").waitFor();
        await boot.getByRole('button', { name: 'Lock and unlock with your passphrase' }).click();
        await p.locator('#lock-token, #lock-passphrase').first().waitFor({ timeout: 20_000 });
      }
      assert.equal(await p.locator('.boot:not(.boot-error)').count(), 0, 'not stuck on the boot spinner');
      assert.equal(await p.evaluate(() => sessionStorage.getItem('postpilot.session')), null, 'Lock forgets the saved session');
    } finally {
      await t.close();
    }
  });

  test('Today lists reminder posts to post by hand and shows planned reminders among upcoming posts', async () => {
    const ids = await page.evaluate(async () => {
      const data = await import('/postpilot/js/data.js');
      const { newPost } = await import('/postpilot/core/model.js');
      const lib = await data.getStore().read('library');
      const a = lib.assets.find((x) => x.name === 'Vase trio');
      const media = [{ assetId: a.id, kind: 'image', altText: '' }];
      const reminded = newPost({ status: 'reminded', publishMode: 'reminder', caption: 'E2E home: post with a link sticker', media, scheduledAt: new Date(Date.now() - 15 * 60e3).toISOString(), reminderSentAt: new Date().toISOString() });
      // Sooner than any automatic post: it must not be called "the next one goes out".
      const planned = newPost({ status: 'scheduled', publishMode: 'reminder', caption: 'E2E home: reel with library music', media, scheduledAt: new Date(Date.now() + 5 * 60e3).toISOString() });
      // Due two minutes ago, but its file is still downloading from a link: the worker waits for it.
      const pending = (await import('/postpilot/core/model.js')).newAsset({ kind: 'image', name: 'E2E home pending.jpg', mime: 'image/jpeg', importUrl: 'https://example.invalid/e2e/home.jpg' });
      const broken = (await import('/postpilot/core/model.js')).newAsset({ kind: 'image', name: 'E2E home broken.jpg', mime: 'image/jpeg', importUrl: 'https://example.invalid/e2e/broken.jpg', importError: 'HTTP 404' });
      await data.mutate('library', (doc) => void doc.assets.push(pending, broken), { message: 'e2e: linked files' });
      const due = new Date(Date.now() - 2 * 60e3).toISOString();
      const waiting = newPost({ status: 'scheduled', caption: 'E2E home: waits for its file', media: [{ assetId: pending.id, kind: 'image', altText: '' }], scheduledAt: due });
      const failedDl = newPost({ status: 'scheduled', caption: 'E2E home: file failed', media: [{ assetId: broken.id, kind: 'image', altText: '' }], scheduledAt: due });
      await data.mutate('posts', (doc) => void doc.posts.push(reminded, planned, waiting, failedDl), { message: 'e2e: reminder posts' });
      return { reminded: reminded.id, planned: planned.id, waiting: waiting.id, failedDl: failedDl.id, assets: [pending.id, broken.id] };
    });
    await go('#/');
    const card = page.locator('.dash-hand');
    await card.waitFor({ timeout: 20_000 });
    assert.match(await card.locator('.panel-title, h2').first().textContent(), /Post these by hand/);
    await card.locator('.dash-post', { hasText: 'E2E home: post with a link sticker' }).waitFor();
    assert.equal(await card.locator('.dash-post', { hasText: 'reel with library music' }).count(), 0, 'only posts whose reminder went out');
    assert.match(await card.textContent(), /Waiting for you to post it in Instagram\./);
    const subtitle = await page.locator('.page-subtitle').textContent();
    assert.match(subtitle, /1 post is waiting for you to post by hand\./);
    // Reminders are not "going out": the summary names the next automatic post and the reminders apart.
    assert.match(subtitle, /The next one goes out /);
    assert.match(subtitle, /1 reminder to post by hand this week, the next (today|tomorrow) at /);
    const goesOut = /The next one goes out ([^.]+)\./.exec(subtitle)[1];
    const nextReminder = /the next ((?:today|tomorrow) at [^.]+)\./.exec(subtitle)[1];
    assert.notEqual(goesOut, nextReminder, 'the reminder due in 5 minutes is not the next post to go out');
    // A due post whose file is still downloading waits for it (it is not "Publishing").
    const waitingRow = page.locator('.dash-upnext .dash-post', { hasText: 'E2E home: waits for its file' });
    await waitingRow.locator('.status', { hasText: 'Downloading' }).waitFor();
    assert.equal(await waitingRow.locator('.status', { hasText: 'Publishing' }).count(), 0);
    await page.locator('.dash-upnext .dash-post', { hasText: 'E2E home: file failed' }).locator('.status', { hasText: 'Download failed' }).waitFor();
    await page.locator('.dash-upnext .dash-post', { hasText: 'reel with library music' }).locator('.dash-post-src', { hasText: 'Reminder' }).waitFor();
    const legend = await page.locator('.dash-legend').textContent();
    assert.match(legend, /Reminder/);
    assert.match(legend, /Post by hand/);
    await shot(page, 'home-e2e-by-hand');
    await card.getByRole('link', { name: /Post this post by hand: E2E home/ }).click();
    await page.waitForFunction((id) => location.hash === `#/post-now/${id}`, ids.reminded);
    await page.locator('.pn-steps').waitFor();
    // Clean up for the tests that follow.
    await page.evaluate(async (ids) => {
      const data = await import('/postpilot/js/data.js');
      const drop = new Set([ids.reminded, ids.planned, ids.waiting, ids.failedDl]);
      await data.mutate('posts', (doc) => void (doc.posts = doc.posts.filter((p) => !drop.has(p.id))), { message: 'e2e: clean up' });
      await data.mutate('library', (doc) => void (doc.assets = doc.assets.filter((a) => !ids.assets.includes(a.id))), { message: 'e2e: clean up' });
    }, ids);
    await go('#/');
    await page.locator('.dash-account').waitFor();
    assert.equal(await page.locator('.dash-hand').count(), 0);
  });

  test('phone tab bar: Analytics lights More, a post by hand lights Today', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = () =>
      page.evaluate(() => [...document.querySelectorAll('.tabbar-item')].filter((el) => el.classList.contains('is-active') || el.getAttribute('aria-current') === 'page').map((el) => el.textContent.trim()));
    for (const [hash, lit] of [['#/analytics?tab=posts', 'More'], ['#/reports', 'More'], ['#/inbox', 'Inbox'], ['#/post-now/e2e-missing', 'Today'], ['#/', 'Today']]) {
      await go(hash);
      await page.waitForFunction((want) => [...document.querySelectorAll('.tabbar-item')].some((el) => (el.classList.contains('is-active') || el.getAttribute('aria-current') === 'page') && el.textContent.trim() === want), lit);
      assert.deepEqual(await state(), [lit], `${hash} lights ${lit} only`);
    }
    await page.setViewportSize({ width: 1280, height: 860 });
  });

  test('with Instagram disconnected, reminder posts due are listed on the Setup screen', async () => {
    const id = await page.evaluate(async () => {
      const data = await import('/postpilot/js/data.js');
      const { newPost } = await import('/postpilot/core/model.js');
      const lib = await data.getStore().read('library');
      const a = lib.assets.find((x) => x.name === 'Vase trio');
      const media = [{ assetId: a.id, kind: 'image', altText: '' }];
      const post = newPost({ status: 'reminded', publishMode: 'reminder', caption: 'E2E home: post while disconnected', media, scheduledAt: new Date(Date.now() - 10 * 60e3).toISOString(), reminderSentAt: new Date().toISOString() });
      await data.mutate('posts', (doc) => void doc.posts.push(post), { message: 'e2e: reminder post' });
      // Disconnect (Settings → Instagram → Disconnect), keeping the connection to restore it afterwards.
      await data.mutate('settings', (s) => {
        s.e2eSavedIg = s.ig;
        s.ig = null;
      }, { message: 'e2e: disconnect' });
      return post.id;
    });
    try {
      await go('#/');
      const card = page.locator('.ob-hand');
      await card.waitFor({ timeout: 20_000 });
      assert.match(await card.textContent(), /A post is waiting to be posted by hand/);
      assert.match(await card.textContent(), /Post, due /);
      await shot(page, 'home-disconnected-hand-posts');
      await card.getByRole('link', { name: 'E2E home: post while disconnected' }).click();
      await page.waitForFunction((x) => location.hash === `#/post-now/${x}`, id);
      await page.locator('.pn-steps').waitFor();
    } finally {
      await page.evaluate(async (x) => {
        const data = await import('/postpilot/js/data.js');
        await data.mutate('settings', (s) => {
          s.ig = s.e2eSavedIg;
          delete s.e2eSavedIg;
        }, { message: 'e2e: reconnect' });
        await data.mutate('posts', (doc) => void (doc.posts = doc.posts.filter((p) => p.id !== x)), { message: 'e2e: clean up' });
      }, id);
    }
    await go('#/');
    await page.locator('.dash-account').waitFor({ timeout: 20_000 });
  });

  test('no console errors', () => {
    const errors = h.consoleErrors.filter((e) => !/favicon/i.test(e));
    assert.deepEqual(errors, []);
  });
});
