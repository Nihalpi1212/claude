// Planner e2e: month / week / list / grid render seeded posts, drag and "Move to…" rescheduling persist,
// bulk move to drafts, CSV import and export, grid swap, screenshots in both themes and sizes.
// Run: node --test tests/e2e/planner.spec.mjs

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { addDaysKey, dayKey, timeKey } from '../../core/time.js';
import { openApp, shot, unlock } from './helpers.mjs';

const PORT = 5212;
const TZ = 'America/New_York';
let h;

/** Posts as committed to the (mock) GitHub data branch, not the tab's cache. */
async function storedPosts(page = h.page) {
  return page.evaluate(async () => {
    const { getStore } = await import('/postpilot/js/data.js');
    const store = getStore();
    await store.refresh();
    return (await store.read('posts')).posts;
  });
}

async function waitFor(fn, { timeout = 15_000, interval = 250, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

/** Make sure the month view shows `day` (navigates forward when it is in a later month). */
async function showDay(day) {
  for (let i = 0; i < 2 && !(await h.page.locator(`.pl-day[data-day="${day}"]:not(.is-other)`).count()); i++) {
    await h.page.getByRole('button', { name: 'Next month' }).click();
    await h.page.waitForTimeout(150);
  }
}

async function setView(view) {
  await h.page.getByRole('radio', { name: view }).click();
  await h.page.waitForTimeout(150);
}

before(async () => {
  h = await openApp({ port: PORT, hash: '#/planner' });
  await h.page.waitForSelector('.pl-month .pl-chip[data-post-id]', { timeout: 20_000 });
});

after(async () => {
  await h?.close();
});

test('month view shows seeded posts, published Instagram media and today', async () => {
  const { page } = h;
  const chips = await page.locator('.pl-month .pl-chip[data-post-id]').count();
  assert.ok(chips >= 6, `expected seeded post chips, got ${chips}`);
  assert.ok((await page.locator('.pl-month .pl-chip.is-ig').count()) >= 1, 'faded Instagram media chips');
  await page.locator('.pl-month .pl-chip[title^="12:00p · Post · Three new shapes"]').first().waitFor();
  assert.equal(await page.locator('.pl-day.is-today').count(), 1);
  assert.match(await page.locator('.pl-period').innerText(), /\d{4}/);
  // Summary line under the title.
  assert.match(await page.locator('.page-subtitle').innerText(), /scheduled in the next 7 days/);
});

async function closeComposer(page) {
  const drawer = page.locator('.cmp-drawer');
  await drawer.getByRole('button', { name: 'Close' }).first().click();
  const discard = page.getByRole('dialog', { name: 'Discard your changes?' });
  await Promise.race([drawer.waitFor({ state: 'detached' }), discard.waitFor().then(() => discard.getByRole('button', { name: 'Discard' }).click())]);
  await drawer.waitFor({ state: 'detached' });
}

test('clicking an empty day opens the composer on that day; a chip opens its post', async () => {
  const { page } = h;
  const freeDay = () =>
    page.evaluate(() => {
      const free = [...document.querySelectorAll('.pl-day:not(.is-past):not(.is-other)')].filter((c) => !c.querySelector('.pl-chip')).map((c) => c.dataset.day);
      return free[free.length - 1] || null;
    });
  let day = await freeDay();
  if (!day) {
    await page.getByRole('button', { name: 'Next month' }).click();
    day = await freeDay();
  }
  assert.ok(day, 'a free future day');
  await page.locator(`.pl-day[data-day="${day}"]`).click({ position: { x: 70, y: 70 } });
  const drawer = page.locator('.cmp-drawer');
  await drawer.waitFor();
  await waitFor(async () => (await drawer.locator('input[type="date"]').count()) > 0, { message: 'composer date field' });
  assert.equal(await drawer.locator('input[type="date"]').first().inputValue(), day);
  await closeComposer(page);

  const posts = await storedPosts();
  const post = posts.find((p) => p.caption.startsWith('Swipe through'));
  await showDay(dayKey(new Date(post.scheduledAt), TZ));
  await page.locator(`.pl-month .pl-chip[data-post-id="${post.id}"]`).click();
  await drawer.waitFor();
  await waitFor(() => drawer.locator('textarea').evaluateAll((els) => els.some((e) => e.value.startsWith('Swipe through'))), { message: 'composer shows the post caption' });
  await closeComposer(page);
});

test('drag a scheduled chip to another day keeps the time and persists', async () => {
  const { page } = h;
  const before = await storedPosts();
  const post = before.find((p) => p.caption.startsWith('Quiet evenings'));
  assert.ok(post, 'seeded post exists');
  await showDay(dayKey(new Date(post.scheduledAt), TZ));
  const chip = page.locator(`.pl-month .pl-chip[data-post-id="${post.id}"]`);
  const fromDay = await chip.evaluate((el) => el.closest('[data-day]').dataset.day);
  const target = await page.evaluate((from) => {
    const cells = [...document.querySelectorAll('.pl-day:not(.is-past)')].map((c) => ({ day: c.dataset.day, n: c.querySelectorAll('.pl-chip').length }));
    return (cells.find((c) => c.day > from && c.n === 0) || cells.find((c) => c.day !== from && c.n === 0)).day;
  }, fromDay);
  await chip.dragTo(page.locator(`.pl-day[data-day="${target}"]`));
  await page.getByText(/Rescheduled to/).first().waitFor({ timeout: 10_000 });
  await page.locator('.toast-close').first().click().catch(() => {});
  const moved = await waitFor(async () => {
    const p = (await storedPosts()).find((x) => x.id === post.id);
    return p && p.scheduledAt !== post.scheduledAt ? p : null;
  }, { message: 'rescheduled post to be committed' });
  assert.equal(dayKey(new Date(moved.scheduledAt), TZ), target);
  assert.equal(timeKey(new Date(moved.scheduledAt), TZ), timeKey(new Date(post.scheduledAt), TZ), 'time of day is kept');
  assert.equal(moved.status, 'scheduled');
  assert.ok(moved.history.some((e) => e.event === 'rescheduled'));
  await page.locator(`.pl-day[data-day="${target}"] .pl-chip[data-post-id="${post.id}"]`).waitFor();
});

test('"Move to…" menu in the day panel moves a post', async () => {
  const { page } = h;
  const posts = await storedPosts();
  const post = posts.find((p) => p.caption.startsWith('Three new shapes'));
  const day = dayKey(new Date(post.scheduledAt), TZ);
  await showDay(day);
  await page.locator(`.pl-day[data-day="${day}"]:not(.is-other) .cal-date`).click();
  const row = page.locator(`.pl-daypanel .pl-row[data-post-id="${post.id}"]`);
  await row.waitFor();
  const trigger = row.getByRole('button', { name: /^Actions for/ });
  // The kit Menu closes on scroll; let the scroll-into-view settle before opening it.
  await trigger.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await trigger.click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move post' });
  await dialog.waitFor();
  const newDay = addDaysKey(day, 3);
  await dialog.locator('input[type="date"]').fill(newDay);
  await dialog.locator('input[type="time"]').fill('15:45');
  await dialog.getByRole('button', { name: 'Move post' }).click();
  await page.getByText(/Rescheduled to/).first().waitFor();
  const moved = await waitFor(async () => {
    const p = (await storedPosts()).find((x) => x.id === post.id);
    return p && p.scheduledAt !== post.scheduledAt ? p : null;
  }, { message: 'moved post' });
  assert.equal(dayKey(new Date(moved.scheduledAt), TZ), newDay);
  assert.equal(timeKey(new Date(moved.scheduledAt), TZ), '15:45');
});

test('week view positions posts by time with best-time shading', async () => {
  const { page } = h;
  await page.evaluate(() => (location.hash = '#/planner'));
  await setView('Week');
  await page.waitForSelector('.pl-week-event[data-post-id]');
  assert.ok((await page.locator('.pl-week-col').count()) === 7);
  assert.ok((await page.locator('.pl-week-event[data-post-id]').count()) >= 2);
  assert.ok((await page.locator('.pl-best').count()) > 0, 'best-time shading');
  assert.ok((await page.locator('.pl-legend .chip').count()) >= 1, 'best time chips');
  assert.match(page.url(), /view=week/);
  // Next week keeps working.
  await page.getByRole('button', { name: 'Next week' }).click();
  await page.waitForTimeout(200);
  assert.match(page.url(), /date=/);
  await page.getByRole('button', { name: 'Today' }).click();
});

test('list view groups posts and bulk-moves selected posts to drafts', async () => {
  const { page } = h;
  await setView('List');
  await page.waitForSelector('[data-section="scheduled"] .pl-row');
  assert.ok((await page.locator('[data-section="scheduled"] .pl-row').count()) >= 4);
  await page.locator('[data-section="approval"] .pl-row').first().waitFor();
  await page.getByText('The image aspect ratio is not allowed', { exact: false }).first().waitFor();
  assert.ok((await page.locator('[data-section="drafts"] .pl-row').count()) >= 2);

  const rows = page.locator('[data-section="scheduled"] .pl-row');
  const ids = [await rows.nth(0).getAttribute('data-post-id'), await rows.nth(1).getAttribute('data-post-id')];
  await rows.nth(0).locator('.checkbox').click();
  await rows.nth(1).locator('.checkbox').click();
  const bar = page.getByRole('region', { name: 'Bulk actions' });
  await bar.getByText('2 selected').waitFor();
  await bar.getByRole('button', { name: 'Move to drafts' }).click();
  await page.getByText(/Moved 2 posts to drafts/).waitFor();
  const stored = await waitFor(async () => {
    const posts = await storedPosts();
    const sel = posts.filter((p) => ids.includes(p.id));
    return sel.length === 2 && sel.every((p) => p.status === 'draft') ? sel : null;
  }, { message: 'posts moved to drafts' });
  assert.equal(stored.length, 2);
  for (const id of ids) await page.locator(`[data-section="drafts"] .pl-row[data-post-id="${id}"]`).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Bulk actions' }).count(), 0, 'selection cleared');

  // Shift one scheduled post by 2 days (same time of day).
  const row = page.locator('[data-section="scheduled"] .pl-row').first();
  const shiftId = await row.getAttribute('data-post-id');
  const original = (await storedPosts()).find((p) => p.id === shiftId);
  await row.locator('.checkbox').click();
  await bar.getByLabel('Shift by').fill('2');
  await bar.getByRole('button', { name: 'Shift', exact: true }).click();
  await page.getByText(/Moved 1 post 2 days later/).waitFor();
  const shifted = await waitFor(async () => {
    const p = (await storedPosts()).find((x) => x.id === shiftId);
    return p.scheduledAt !== original.scheduledAt ? p : null;
  }, { message: 'shifted post' });
  assert.equal(dayKey(new Date(shifted.scheduledAt), TZ), addDaysKey(dayKey(new Date(original.scheduledAt), TZ), 2));
  assert.equal(timeKey(new Date(shifted.scheduledAt), TZ), timeKey(new Date(original.scheduledAt), TZ));

  // Delete the undated draft after confirming.
  const draftRow = page.locator('[data-section="drafts"] .pl-row', { hasText: 'Workshop announcement' });
  const draftId = await draftRow.getAttribute('data-post-id');
  await draftRow.locator('.checkbox').click();
  await bar.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete this post?' }).getByRole('button', { name: 'Delete post' }).click();
  await page.getByText('Deleted 1 post.').waitFor();
  await waitFor(async () => !(await storedPosts()).some((p) => p.id === draftId), { message: 'draft deleted' });
});

test('filters narrow the list and are kept in the URL', async () => {
  const { page } = h;
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.locator('#planner-filters').getByRole('button', { name: 'Reels' }).click();
  await page.waitForTimeout(200);
  assert.match(page.url(), /type=reel/);
  const titles = await page.locator('.pl-row .pl-row-title').allInnerTexts();
  assert.ok(titles.length >= 1 && titles.every((t) => /wheel/i.test(t)), `only reels: ${titles}`);
  await page.locator('#planner-filters').getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('button', { name: /^Filters/ }).click();
  assert.doesNotMatch(page.url(), /type=/);
});

test('grid view previews planned posts above published media and swaps by drag', async () => {
  const { page } = h;
  await setView('Grid');
  await page.waitForSelector('.pl-tile.is-upcoming');
  const upcoming = page.locator('.pl-tile.is-upcoming[draggable="true"]');
  assert.ok((await upcoming.count()) >= 3);
  assert.ok((await page.locator('.pl-tile.is-published').count()) >= 3);
  // Planned tiles come first.
  const order = await page.locator('.pl-ig-grid > *').evaluateAll((els) => els.map((e) => e.classList.contains('is-upcoming')));
  assert.equal(order.indexOf(false) > 0 && order.slice(order.indexOf(false)).every((x) => !x), true);
  const a = await upcoming.nth(0).getAttribute('data-post-id');
  const b = await upcoming.nth(1).getAttribute('data-post-id');
  const beforePosts = await storedPosts();
  const ta = beforePosts.find((p) => p.id === a).scheduledAt;
  const tb = beforePosts.find((p) => p.id === b).scheduledAt;
  await upcoming.nth(0).dragTo(upcoming.nth(1));
  await page.getByText(/^Swapped\./).waitFor();
  await waitFor(async () => {
    const posts = await storedPosts();
    return posts.find((p) => p.id === a).scheduledAt === tb && posts.find((p) => p.id === b).scheduledAt === ta;
  }, { message: 'swapped times' });
});

test('CSV import of two rows creates two posts; export downloads upcoming posts', async () => {
  const { page } = h;
  await setView('List');
  const today = dayKey(new Date(), TZ);
  const d1 = addDaysKey(today, 4);
  const d2 = addDaysKey(today, 5);
  const csv = [
    'date,time,type,caption,first_comment,media,status',
    `${d1},11:15,post,"CSV row one, with a comma",First comment,Vase trio,scheduled`,
    `${d2},19:05,carousel,CSV row two,,Desert sunrise|Night hills,draft`,
  ].join('\n');
  await page.getByRole('button', { name: 'Import CSV' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import posts from CSV' });
  await dialog.waitFor();
  // Template download works.
  const [template] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download template' }).click()]);
  assert.equal(template.suggestedFilename(), 'postpilot-import-template.csv');
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'plan.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await dialog.locator('.pl-import-row.is-ok').nth(1).waitFor();
  assert.equal(await dialog.locator('.pl-import-row.has-error').count(), 0);
  await dialog.getByRole('button', { name: 'Create 2 posts' }).click();
  await page.getByText('Imported 2 posts (1 scheduled, 1 draft).').waitFor();
  const created = await waitFor(async () => {
    const posts = (await storedPosts()).filter((p) => p.source === 'csv');
    return posts.length === 2 ? posts : null;
  }, { message: 'imported posts' });
  const one = created.find((p) => p.caption === 'CSV row one, with a comma');
  const two = created.find((p) => p.caption === 'CSV row two');
  assert.equal(one.status, 'scheduled');
  assert.equal(one.firstComment, 'First comment');
  assert.equal(dayKey(new Date(one.scheduledAt), TZ), d1);
  assert.equal(timeKey(new Date(one.scheduledAt), TZ), '11:15');
  assert.equal(two.type, 'carousel');
  assert.equal(two.status, 'draft');
  assert.equal(two.media.length, 2);

  // A bad row is reported, not imported.
  await page.getByRole('button', { name: 'Import CSV' }).click();
  await dialog.waitFor();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`date,time,media\n2020-01-01,10:00,No such file.jpg\n`),
  });
  await dialog.locator('.pl-import-row.has-error').waitFor();
  await dialog.getByText('No library file is named "No such file.jpg".').waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Nothing to import' }).isDisabled(), true);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
  assert.match(download.suggestedFilename(), /^postpilot-upcoming-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = String(await (await import('node:fs/promises')).readFile(await download.path()));
  assert.match(text.replace(/^﻿/, ''), /^date,time,type,caption,first_comment,media,status\r\n/);
  assert.match(text, /CSV row one, with a comma/);
});

test('"Try again" sends a post that still fails validation to the composer instead of the worker', async () => {
  const { page } = h;
  await setView('List');
  const row = page.locator('.pl-row', { hasText: 'Late night at the studio.' });
  const id = await row.getAttribute('data-post-id');
  await row.getByRole('button', { name: 'Try again' }).click();
  await page.getByText('Fix the problems in this post, then try again.').waitFor();
  const drawer = page.locator('.cmp-drawer');
  await drawer.waitFor();
  await drawer.getByText('Feed photos must be between 4:5 and 1.91:1', { exact: false }).first().waitFor();
  await closeComposer(page);
  const post = (await storedPosts()).find((p) => p.id === id);
  assert.equal(post.status, 'failed', 'not queued again');
  assert.ok(!post.history.some((e) => e.event === 'retry'));

  // A valid failed post is queued again with a single toast (the worker start is quiet).
  const okId = await page.evaluate(async () => {
    const data = await import('/postpilot/js/data.js');
    const { newPost } = await import('/postpilot/core/model.js');
    const lib = await data.getStore().read('library');
    const asset = lib.assets.find((a) => a.name === 'Vase trio');
    const post = newPost({
      status: 'failed',
      caption: 'E2E retry: a valid post that failed once.',
      media: [{ assetId: asset.id, kind: asset.kind }],
      scheduledAt: new Date(Date.now() - 3_600_000).toISOString(),
      attempts: 4,
      lastError: { message: 'Instagram was busy. Try again later.', code: 2, at: new Date().toISOString(), permanent: true },
    });
    await data.mutate('posts', (doc) => void doc.posts.push(post), { message: 'e2e: failed post' });
    return post.id;
  });
  const okRow = page.locator(`.pl-row[data-post-id="${okId}"]`);
  await okRow.getByRole('button', { name: 'Try again' }).click();
  await page.getByText(/^Publishing again\./).waitFor();
  await waitFor(async () => (await storedPosts()).find((p) => p.id === okId).history.some((e) => e.event === 'retry'), { message: 'retry committed' });
  await page.waitForTimeout(1000);
  assert.equal(await page.getByText(/^Worker started/).count(), 0, 'one toast, not two');
});

test('screenshots: desktop and phone, light and dark', async () => {
  for (const [w, hgt] of [[1280, 860], [390, 844]]) {
    for (const scheme of ['light', 'dark']) {
      const ctx = await h.browser.newContext({ viewport: { width: w, height: hgt }, colorScheme: scheme });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      await page.goto(`${h.url}/postpilot/index.html#/planner`);
      await unlock(page);
      for (const view of ['month', 'week', 'list', 'grid']) {
        await page.evaluate((v) => (location.hash = v === 'month' ? '#/planner' : `#/planner?view=${v}`), view);
        await page.waitForSelector(view === 'month' ? '.pl-month' : view === 'week' ? '.pl-week' : view === 'list' ? '.pl-list' : '.pl-gridview');
        await page.waitForTimeout(500);
        await page
          .waitForFunction(() => !document.querySelector('.pl-thumb:empty') && [...document.images].every((i) => i.complete), null, { timeout: 8000 })
          .catch(() => {});
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, `no horizontal page scroll in ${view} at ${w}px (${overflow}px)`);
        await shot(page, `planner-${view}-${w}-${scheme}`);
      }
      if (w === 1280 && scheme === 'light') {
        await page.getByRole('button', { name: 'Import CSV' }).click();
        await page.getByRole('dialog', { name: 'Import posts from CSV' }).waitFor();
        await shot(page, `planner-import-${w}-${scheme}`);
      }
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  }
});

test('no console errors', () => {
  assert.deepEqual(h.consoleErrors, []);
});
