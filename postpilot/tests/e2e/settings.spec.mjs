// E2E: Settings (seeded workspace) and Onboarding (fresh workspace) on port 5216.
// Run: node --test tests/e2e/settings.spec.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DEMO_PASSPHRASE, loadPlaywright, openApp, shot, startDevServer, unlock } from './helpers.mjs';

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

/**
 * Wait until `fn` (run in the page, may be async) returns something truthy. page.waitForFunction
 * takes the Promise an async function returns as truthy, so it would not wait at all.
 */
async function pollPage(page, fn, arg, { timeout = 90_000, every = 1000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn, arg)) return;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout} ms waiting for: ${fn}`);
    await new Promise((r) => setTimeout(r, every));
  }
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

    // Time zone: saving explains that scheduled posts keep their exact moment; Cancel changes nothing.
    const prefs = page.locator('#settings-preferences');
    await prefs.getByLabel('Time zone').fill('Europe/Berlin');
    await prefs.getByRole('button', { name: 'Save time zone' }).click();
    const tzDialog = page.getByRole('dialog');
    await tzDialog.getByText('Change the time zone to Europe/Berlin?').waitFor();
    await tzDialog.getByText(/already scheduled keep their exact moment/).waitFor();
    await tzDialog.getByRole('button', { name: 'Cancel' }).click();
    await prefs.getByRole('button', { name: 'Save time zone' }).waitFor();
    await prefs.getByRole('button', { name: 'Save time zone' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Change time zone' }).click();
    await page.getByText('Time zone set to Europe/Berlin.').waitFor();

    // AI: save a new key, test it against the mock, then a rejected key.
    // The label is tied to the input (screen readers, clicking the label, password managers).
    const key = page.getByLabel('Anthropic API key');
    assert.equal(await key.getAttribute('id'), 'settings-ai-key');
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

    // Security: a weak new passphrase is refused with the same rules as creating a workspace.
    const sec = page.locator('#settings-security');
    await sec.getByText('At least 12 characters. A short sentence of three or four words').waitFor();
    await sec.getByText(/does not lock out anyone who already knows the old passphrase/).waitFor();
    await sec.getByLabel('Current passphrase').fill('not the passphrase');
    await sec.getByLabel('New passphrase', { exact: true }).fill('password12');
    await sec.getByLabel('Repeat new passphrase').fill('password12');
    await sec.getByRole('button', { name: 'Change passphrase', exact: true }).click();
    await sec.getByText('Use at least 12 characters').waitFor();
    await sec.getByLabel('New passphrase', { exact: true }).fill('password1234');
    await sec.getByLabel('Repeat new passphrase').fill('password1234');
    await sec.getByRole('button', { name: 'Change passphrase', exact: true }).click();
    await sec.getByText('That passphrase is too common').waitFor();

    // Wrong current passphrase is explained.
    await sec.getByLabel('New passphrase', { exact: true }).fill('a brand new passphrase');
    await sec.getByLabel('Repeat new passphrase').fill('a brand new passphrase');
    await sec.getByRole('button', { name: 'Change passphrase', exact: true }).click();
    await sec.getByText('The current passphrase is not right').waitFor({ timeout: 20_000 });

    // Recent runs name what the newer jobs did (reminders, feeds, downloads, invites, reports, reposts).
    // (The run started with "Run now" above finishes first: it would otherwise be listed on top.)
    await pollPage(page, async () => (await (await fetch('/mock/gh/repos/demo/postpilot/actions/workflows/postpilot-worker.yml/runs')).json()).workflow_runs.every((r) => r.status === 'completed'));
    await page.evaluate(async () => {
      const { getStore, mutate } = await import('/postpilot/js/data.js');
      await getStore().refresh(); // the worker's run just committed: start from the latest commit
      const t0 = Date.now() + 3600e3; // newer than the worker's own runs, so they are listed first
      const at = (min) => new Date(t0 + min * 60e3).toISOString();
      const run = (min, counts) => ({ startedAt: at(min), finishedAt: at(min), durationMs: 1000, ok: true, trigger: 'workflow_dispatch', counts: { published: 0, failed: 0, replies: 0, dms: 0, hidden: 0, stories: 0, snapshots: 0, ...counts }, errors: [] });
      await mutate('log', (d) => {
        d.runs = [
          run(5, { reminded: 1 }),
          run(4, { feedsChecked: 1, feedItems: 3, downloaded: 4, downloadFailed: 1 }),
          run(3, { invitesNew: 2, invitesAccepted: 1 }),
          run(2, { reportsCreated: 1 }),
          run(1, { autopilotCreated: 2, reposts: 2 }),
          ...(d.runs || []),
        ];
      }, { message: 'e2e: runs of the newer jobs' });
    });
    await page.reload();
    const worker = page.locator('#settings-worker');
    await worker.getByText('Recent runs').waitFor({ timeout: 20_000 });
    const activity = await worker.locator('table tbody tr').evaluateAll((rows) => rows.slice(0, 5).map((r) => r.lastElementChild.textContent.trim()));
    assert.deepEqual(activity, [
      '1 reminder sent',
      '1 feed checked, 3 feed items, 4 files downloaded, 1 download failed',
      '2 new invites, 1 invite accepted',
      '1 monthly report',
      '2 autopilot drafts, 2 reposts',
    ]);

    // Notification toggles keep their wording in the confirmation.
    const notif = page.locator('#settings-notifications');
    await notif.getByRole('switch', { name: 'Time to post by hand' }).waitFor();
    await notif.getByRole('switch', { name: 'Instagram connection problems' }).click();
    await page.getByText('Notifications off: Instagram connection problems.').waitFor();
    await notif.getByRole('switch', { name: 'Instagram connection problems' }).click();
    await page.getByText('Notifications on: Instagram connection problems.').waitFor();

    // Retries: 4 attempts in all (worker/jobs/publish.mjs MAX_ATTEMPTS).
    await page.getByText('the worker tries again on the next runs (up to 4 attempts in all).').waitFor();

    // Disconnecting says reminder posts still come due (no device gets notifications in the demo).
    await page.locator('#settings-instagram').getByRole('button', { name: 'Disconnect' }).click();
    const dis = page.getByRole('dialog');
    await dis.getByText(/Posts set to publish automatically wait, and automations stop, until you connect again\./).waitFor();
    await dis.getByText(/Reminder posts still come due, but no device has notifications turned on/).waitFor();
    await dis.getByRole('button', { name: 'Cancel' }).click();
    await dis.waitFor({ state: 'detached' });

    // Free up space keeps photos downloaded from a link: their file is also their thumbnail.
    const planned = await page.evaluate(async () => {
      const { freeUpPlan } = await import('/postpilot/js/views/settings.js');
      const old = new Date(Date.now() - 60 * 864e5).toISOString();
      const asset = (id, kind, own) => ({ id, kind, path: `media/${id}`, thumbPath: own ? `media/${id}` : `media/${id}.thumb`, bytes: 1000 });
      const post = { id: 'p1', status: 'published', publishedAt: old, media: ['a_up', 'a_dl', 'a_vid'].map((assetId) => ({ assetId, kind: 'image' })) };
      const plan = freeUpPlan({ posts: { posts: [post] }, archive: { posts: [] }, library: { assets: [asset('a_up', 'image', false), asset('a_dl', 'image', true), asset('a_vid', 'video', true)] }, lists: { lists: [] } });
      return plan.assets.map((a) => a.id);
    });
    assert.deepEqual(planned, ['a_up', 'a_vid']);

    // Phone: a deep link (the composer's "Notification settings", the worker chip...) opens with the
    // section title below the sticky top bar.
    const phoneCtx = await h.browser.newContext({ viewport: { width: 390, height: 844 } });
    const phone = await phoneCtx.newPage();
    const phoneErrors = trackErrors(phone);
    await phone.goto(`${h.url}/postpilot/index.html#/settings?section=notifications`);
    await unlock(phone);
    await phone.waitForSelector('#settings-notifications .panel-title', { timeout: 20_000 });
    await phone.waitForFunction(() => window.scrollY > 500 && document.activeElement && document.activeElement.id === 'settings-notifications', null, { timeout: 20_000 });
    await phone.waitForTimeout(500);
    const title = await phone.evaluate(() => {
      const t = document.querySelector('#settings-notifications .panel-title');
      const r = t.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + 8, r.top + r.height / 2);
      return { top: r.top, bar: document.querySelector('.mobile-topbar').getBoundingClientRect().bottom, visible: !!hit && t.contains(hit) };
    });
    assert.ok(title.top >= title.bar, `the Notifications title (top ${Math.round(title.top)}) is below the top bar (ends at ${Math.round(title.bar)})`);
    assert.ok(title.visible, 'nothing covers the Notifications title');
    await shot(phone, 'settings-deeplink-notifications-phone-light');
    assert.deepEqual(phoneErrors, []);
    await phoneCtx.close();

    assert.deepEqual(errors, []);
    await shot(page, 'settings-flow-end');
    await screenshots(h, '#/settings', 'settings', '.settings-section');
  } finally {
    await h.close();
  }
});

/** Read a document through the app's own store (the module instance the app uses). */
async function readDoc(page, name) {
  return page.evaluate(async (n) => {
    const { getStore } = await import('/postpilot/js/data.js');
    const store = getStore();
    await store.refresh();
    return store.read(n);
  }, name);
}

test('settings: restore never republishes, passphrase change, data key rotation', { timeout: 300_000 }, async () => {
  const h = await openApp({ port: PORT, hash: '#/settings?section=data' });
  const { page, browser, url } = h;
  const errors = trackErrors(page);
  try {
    await page.waitForSelector('#settings-data', { timeout: 20_000 });

    // --- Restore: posts published since the backup stay published, overdue scheduled posts become drafts,
    // queued replies are not re-sent and handled comments are not handled again.
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download backup' }).click()]);
    const backup = JSON.parse(await readFile(await download.path(), 'utf8'));
    const posts = backup.docs.posts.posts;
    const scheduled = posts.filter((p) => p.status === 'scheduled');
    const published = posts.filter((p) => p.status === 'published');
    assert.ok(scheduled.length >= 2 && published.length >= 2, 'seed has scheduled and published posts');
    const [overdue, upcoming] = scheduled;
    const [republished, missing] = published;
    const past = new Date(Date.now() - 3600e3).toISOString();
    overdue.scheduledAt = past; // its time passed while the backup sat on disk
    Object.assign(republished, { status: 'scheduled', scheduledAt: past, igMediaId: null, permalink: null, publishedAt: null }); // published since
    backup.docs.posts.posts = posts.filter((p) => p.id !== missing.id); // published after the backup was taken
    backup.docs.inbox.outbox = [{ id: 'cmd_e2e', type: 'reply_comment', payload: { commentId: 'c1', text: 'Thanks' }, status: 'pending', createdAt: past }];
    backup.docs.automations.processed = { comments: { c_old: past }, messages: {}, conversations: {} };
    backup.docs.automations.cursors = { comments: 'stale-cursor' };
    backup.docs.automations.welcome.text = 'Restored welcome message';
    const liveInbox = await readDoc(page, 'inbox');
    const liveAutomations = await readDoc(page, 'automations');

    await page.locator('#settings-data input[type=file]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    const restoreDialog = page.getByRole('dialog');
    await restoreDialog.getByText(/scheduled posts whose time has passed come back as drafts/).waitFor();
    await restoreDialog.getByRole('button', { name: 'Replace my data' }).click();
    await page.getByText('Backup restored.').waitFor({ timeout: 20_000 });

    const after = (await readDoc(page, 'posts')).posts;
    const byId = new Map(after.map((p) => [p.id, p]));
    assert.equal(byId.get(overdue.id).status, 'draft', 'an overdue scheduled post is not published again');
    assert.equal(byId.get(overdue.id).history.at(-1).event, 'restored');
    assert.equal(byId.get(upcoming.id).status, 'scheduled', 'a future scheduled post stays scheduled');
    assert.equal(byId.get(republished.id).status, 'published', 'a post published since the backup keeps its live record');
    assert.ok(byId.get(republished.id).igMediaId);
    assert.equal(byId.get(missing.id)?.status, 'published', 'a published post missing from the backup is kept');
    assert.ok(!after.some((p) => p.status === 'scheduled' && Date.parse(p.scheduledAt) <= Date.now()), 'nothing restored is due right away');
    const inbox = await readDoc(page, 'inbox');
    assert.deepEqual(inbox.outbox, liveInbox.outbox, 'the live outbox is kept');
    const automations = await readDoc(page, 'automations');
    assert.equal(automations.welcome.text, 'Restored welcome message');
    assert.deepEqual(automations.processed, liveAutomations.processed, 'handled comments and messages are kept');
    assert.deepEqual(automations.cursors, liveAutomations.cursors);

    // A second browser profile that remembers this device with the current key.
    const other = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const otherPage = await other.newPage();
    await otherPage.goto(`${url}/postpilot/index.html#/`);
    await otherPage.getByLabel('GitHub access token').fill('mock-token');
    await otherPage.getByRole('button', { name: 'Continue' }).click();
    await otherPage.getByLabel('Passphrase', { exact: true }).fill(DEMO_PASSPHRASE);
    await otherPage.getByRole('switch', { name: 'Remember this device' }).click();
    await otherPage.getByRole('button', { name: 'Unlock' }).click();
    await otherPage.waitForSelector('.app', { timeout: 30_000 });

    // --- Change passphrase (re-wrap only).
    await page.goto(`${url}/postpilot/index.html#/settings?section=security`);
    const sec = page.locator('#settings-security');
    await sec.getByLabel('Current passphrase').fill(DEMO_PASSPHRASE);
    await sec.getByLabel('New passphrase', { exact: true }).fill('second passphrase for e2e');
    await sec.getByLabel('Repeat new passphrase').fill('second passphrase for e2e');
    await sec.getByRole('button', { name: 'Change passphrase', exact: true }).click();
    await page.getByText('Passphrase changed.').waitFor({ timeout: 30_000 });
    // Re-wrapping keeps the data key, so the remembered device still opens without a passphrase.
    await otherPage.reload();
    await otherPage.waitForSelector('.app', { timeout: 30_000 });

    // --- Change passphrase and replace the data key.
    const rotatedAt = new Date().toISOString();
    await sec.getByLabel('Current passphrase').fill('second passphrase for e2e');
    await sec.getByLabel('New passphrase', { exact: true }).fill('third passphrase after rotation');
    await sec.getByLabel('Repeat new passphrase').fill('third passphrase after rotation');
    await sec.getByRole('button', { name: 'Change passphrase and replace key' }).click();
    const rotateDialog = page.getByRole('dialog');
    await rotateDialog.getByText(/protects what you save from now on/).waitFor();
    await rotateDialog.getByRole('button', { name: 'Replace key' }).click();
    // The app reloads with the new key and says what happened.
    await page.locator('#settings-security').getByText('Data key replaced').waitFor({ timeout: 60_000 });
    await page.locator('#settings-security').getByText(/worker's secret is updated/).waitFor();
    await page.locator('#settings-instagram').getByText('@studio.north').first().waitFor();
    assert.equal((await readDoc(page, 'automations')).welcome.text, 'Restored welcome message', 'data reads with the new key');

    // The worker opens the re-sealed secret and reads the re-encrypted data.
    await page.locator('#settings-worker').getByRole('button', { name: 'Run now' }).click();
    await page.getByText('Worker started.').waitFor();
    await pollPage(
      page,
      async (since) => {
        const res = await fetch('/mock/gh/repos/demo/postpilot/actions/workflows/postpilot-worker.yml/runs');
        const run = (await res.json()).workflow_runs[0];
        return run && run.status === 'completed' && Date.parse(run.created_at) >= Date.parse(since);
      },
      rotatedAt,
    );
    const runs = await page.evaluate(async () => (await (await fetch('/mock/gh/repos/demo/postpilot/actions/workflows/postpilot-worker.yml/runs')).json()).workflow_runs);
    assert.equal(runs[0].conclusion, 'success', 'the worker runs with the new key');
    const log = await readDoc(page, 'log');
    assert.ok(log.runs.some((r) => r.startedAt >= rotatedAt), 'the worker wrote its run log with the new key');

    // The remembered device holds the old key: it now asks to unlock instead of failing to decrypt.
    await otherPage.reload();
    await otherPage.waitForSelector('#lock-token', { timeout: 30_000 });
    assert.equal(await otherPage.locator('.app').count(), 0);
    assert.equal(await otherPage.evaluate(() => localStorage.getItem('postpilot.session')), null);
    // The previous passphrase no longer unlocks; the new one does.
    await otherPage.getByLabel('GitHub access token').fill('mock-token');
    await otherPage.getByRole('button', { name: 'Continue' }).click();
    await otherPage.getByLabel('Passphrase', { exact: true }).fill('second passphrase for e2e');
    await otherPage.getByRole('button', { name: 'Unlock' }).click();
    await otherPage.getByText('That passphrase is not right').waitFor({ timeout: 30_000 });
    await otherPage.getByLabel('Passphrase', { exact: true }).fill('third passphrase after rotation');
    await otherPage.getByRole('button', { name: 'Unlock' }).click();
    await otherPage.waitForSelector('.app', { timeout: 30_000 });
    await other.close();

    await shot(page, 'settings-security-rotated');
    assert.deepEqual(errors, []);
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

    // Lock screen: every field is reachable through its label; create a workspace.
    await page.waitForSelector('#lock-token', { timeout: 20_000 });
    assert.equal(await page.getByLabel('GitHub account').inputValue(), 'demo');
    assert.equal(await page.getByLabel('Repository').inputValue(), 'postpilot');
    await page.getByLabel('GitHub access token').fill('mock-token');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForSelector('#lock-new-passphrase', { timeout: 20_000 });
    await page.getByLabel('New passphrase').fill('password1234');
    await page.getByLabel('Repeat passphrase').fill('password1234');
    await page.getByRole('button', { name: 'Create encrypted workspace' }).click();
    await page.getByText('That passphrase is too common').waitFor();
    await page.getByLabel('New passphrase').fill('a fresh e2e passphrase');
    await page.getByLabel('Repeat passphrase').fill('a fresh e2e passphrase');
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

    // A secret that no longer matches: the run fails on GitHub, and the advice names the button on screen.
    await page.evaluate(async () => {
      const { sealedBox } = await import('/postpilot/vendor/sealed-box.js');
      const pk = await (await fetch('/mock/gh/repos/demo/postpilot/actions/secrets/public-key')).json();
      const b64 = (u8) => btoa(String.fromCharCode(...u8));
      const otherKey = b64(crypto.getRandomValues(new Uint8Array(32))); // a valid data key, of another workspace
      const sealed = sealedBox(new TextEncoder().encode(otherKey), Uint8Array.from(atob(pk.key), (ch) => ch.charCodeAt(0)));
      await fetch('/mock/gh/repos/demo/postpilot/actions/secrets/POSTPILOT_DATA_KEY', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ encrypted_value: b64(sealed), key_id: pk.key_id }) });
    });
    await page.getByRole('button', { name: 'Run again' }).click();
    const failed = page.locator('.callout', { hasText: 'The worker run failed on GitHub' });
    await failed.waitFor({ timeout: 90_000 });
    assert.match(await failed.textContent(), /click\s+“Save the key again” to save it again/);
    assert.equal(await page.getByRole('button', { name: 'Connect worker' }).count(), 0, 'no "Connect worker" button is shown in this state');
    await page.getByRole('button', { name: 'Save the key again' }).click();
    await page.getByText('Worker connected. It can now read your encrypted data.').last().waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Run worker now' }).or(page.getByRole('button', { name: 'Run again' })).first().click();
    await page.getByText('The worker ran successfully').waitFor({ timeout: 90_000 });
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
      await p.getByLabel('Passphrase', { exact: true }).fill('a fresh e2e passphrase');
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
