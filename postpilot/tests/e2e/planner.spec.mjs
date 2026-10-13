// Planner e2e: month / week / day / list / grid render seeded posts, drag and "Move to…" rescheduling
// persist, Day view keyboard use, search, reminded posts ("Post by hand"), AI ideas, bulk move to drafts,
// CSV import (with a media link) and export, grid swap, screenshots in both themes and sizes.
// Run: node --test tests/e2e/planner.spec.mjs

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { addDaysKey, dayKey, timeKey } from '../../core/time.js';
import { openApp, shot, unlock } from './helpers.mjs';

const PORT = Number(process.env.PLANNER_E2E_PORT || 5532);
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
  await page.getByRole('button', { name: 'Next week', exact: true }).click();
  await page.waitForTimeout(200);
  assert.match(page.url(), /date=/);
  await page.getByRole('button', { name: 'Today' }).click();
});

test('day view: hour rows with posts at their time, keyboard, add buttons and drag to another hour', async () => {
  const { page } = h;
  const story = (await storedPosts()).find((p) => p.type === 'story' && p.status === 'scheduled');
  const day = dayKey(new Date(story.scheduledAt), TZ);
  const hour = Number(timeKey(new Date(story.scheduledAt), TZ).slice(0, 2));
  await page.evaluate((d) => (location.hash = `#/planner?view=day&date=${d}`), day);
  await page.waitForSelector('.pl-dayview');
  assert.equal(await page.getByRole('radio', { name: 'Day' }).getAttribute('aria-checked'), 'true');
  const event = page.locator(`.pl-hour[data-hour="${hour}"] .pl-dayevent[data-post-id="${story.id}"]`);
  await event.waitFor();
  assert.match(await event.getAttribute('aria-label'), /Story/);
  assert.ok((await page.locator('.pl-hour').count()) >= 18, 'one row per hour from 06:00');

  // Keyboard: Enter on a post opens it.
  await event.focus();
  await page.keyboard.press('Enter');
  const drawer = page.locator('.cmp-drawer');
  await drawer.waitFor();
  await closeComposer(page);

  // "+" on an hour opens the composer at that hour.
  await page.locator('.pl-hour[data-hour="20"] .pl-hour-add').click();
  await drawer.waitFor();
  await waitFor(async () => (await drawer.locator('input[type="time"]').count()) > 0, { message: 'composer time field' });
  assert.equal(await drawer.locator('input[type="date"]').first().inputValue(), day);
  assert.equal(await drawer.locator('input[type="time"]').first().inputValue(), '20:00');
  await closeComposer(page);

  // Drag the post two hours later: same minutes, new hour.
  const target = hour + 2 <= 23 ? hour + 2 : hour - 2;
  await event.dragTo(page.locator(`.pl-hour[data-hour="${target}"]`));
  await page.getByText(/Rescheduled to/).first().waitFor();
  await page.locator('.toast-close').first().click().catch(() => {});
  const moved = await waitFor(async () => {
    const p = (await storedPosts()).find((x) => x.id === story.id);
    return p.scheduledAt !== story.scheduledAt ? p : null;
  }, { message: 'moved to another hour' });
  assert.equal(timeKey(new Date(moved.scheduledAt), TZ), `${String(target).padStart(2, '0')}:${timeKey(new Date(story.scheduledAt), TZ).slice(3)}`);
  await page.locator(`.pl-hour[data-hour="${target}"] .pl-dayevent[data-post-id="${story.id}"]`).waitFor();

  // Day navigation.
  await page.getByRole('button', { name: 'Next day' }).click();
  await waitFor(() => page.url().includes(`date=${addDaysKey(day, 1)}`), { message: 'next day in the URL' });
  await page.getByRole('button', { name: 'Previous day' }).click();
  await waitFor(() => page.url().includes(`date=${day}`), { message: 'previous day in the URL' });
});

test('search finds posts by caption, first comment, labels and notes, in every view', async () => {
  const { page } = h;
  await page.evaluate(() => (location.hash = '#/planner?view=list'));
  await page.waitForSelector('.pl-list');
  const search = page.getByRole('searchbox', { name: /Search captions/ });
  const titles = () => page.locator('.pl-row .pl-row-title').allInnerTexts();

  await search.fill('restock');
  await page.getByText('1 post matches “restock”.').waitFor();
  assert.deepEqual(await titles(), ['Three new shapes for the autumn drop. Which one goes home with you?'], 'first comment match');
  await waitFor(() => page.url().includes('q=restock'), { message: 'search kept in the URL' });

  await search.fill('product');
  await page.getByText(/1 post matches “product”/).waitFor();
  assert.deepEqual(await titles(), ['Our morning ritual before the wheel starts spinning.'], 'label match');

  await search.fill('workshop announcement');
  await page.getByText(/1 post matches/).waitFor();
  assert.deepEqual(await titles(), ['Workshop announcement: add date and price.'], 'notes match');

  await search.fill('#ceramics');
  await page.getByText(/(1 post matches|\d+ posts match) “#ceramics”/).waitFor();
  const tagged = await page.locator('.pl-row').evaluateAll((els) => els.map((e) => e.dataset.postId));
  const byId = new Map((await storedPosts()).map((p) => [p.id, p]));
  assert.ok(tagged.length >= 2 && tagged.every((id) => /#ceramics/.test(byId.get(id).caption)), 'caption hashtag match');

  // The month view shows only matching posts; "Show as a list" switches view.
  await search.fill('kilns');
  await setView('Month');
  await page.getByText(/1 post matches “kilns” \(all dates\)/).waitFor();
  const kilns = (await storedPosts()).find((p) => p.caption.startsWith('Quiet evenings'));
  await showDay(dayKey(new Date(kilns.scheduledAt), TZ));
  await page.locator(`.pl-month .pl-chip[data-post-id="${kilns.id}"]`).waitFor();
  assert.equal(await page.locator('.pl-month .pl-chip[data-post-id]').count(), 1);
  await search.fill('zzz no match');
  await page.getByText('No posts match “zzz no match”.').waitFor();
  await page.getByRole('button', { name: 'Clear search' }).click();
  assert.equal(await search.inputValue(), '');
  await waitFor(() => !page.url().includes('q='), { message: 'search removed from the URL' });
  await page.getByRole('button', { name: 'Today' }).click().catch(() => {});
});

test('a reminder that went out is styled apart and links to "Post by hand"', async () => {
  const { page } = h;
  const id = await page.evaluate(async () => {
    const data = await import('/postpilot/js/data.js');
    const { newPost } = await import('/postpilot/core/model.js');
    const lib = await data.getStore().read('library');
    const asset = lib.assets.find((a) => a.name === 'Desert sunrise');
    const at = new Date(Date.now() - 30 * 60_000).toISOString();
    const post = newPost({ status: 'reminded', publishMode: 'reminder', reminderSentAt: at, scheduledAt: at, caption: 'E2E reminder: post this one by hand.', media: [{ assetId: asset.id, kind: 'image' }] });
    await data.mutate('posts', (doc) => void doc.posts.push(post), { message: 'e2e: reminded post' });
    return post.id;
  });
  await page.evaluate(() => (location.hash = '#/planner'));
  const chip = page.locator(`.pl-month .pl-chip.is-reminded[data-post-id="${id}"]`);
  await chip.waitFor();
  assert.match(await chip.getAttribute('aria-label'), /post by hand/);
  // Week view: screen readers hear it too (not only the tooltip).
  await page.evaluate(() => (location.hash = '#/planner?view=week'));
  const event = page.locator(`.pl-week-event.is-reminded[data-post-id="${id}"]`);
  await event.waitFor();
  assert.match(await event.getAttribute('aria-label'), /· Post · E2E reminder: post this one by hand\., post by hand$/);
  await page.evaluate(() => (location.hash = '#/planner'));
  await chip.waitFor();
  await chip.click();
  await waitFor(() => page.url().includes(`#/post-now/${id}`), { message: 'opened Post by hand' });

  await page.evaluate(() => (location.hash = '#/planner?view=list'));
  const row = page.locator(`[data-section="reminded"] .pl-row[data-post-id="${id}"]`);
  await row.waitFor();
  await row.getByText('Post by hand', { exact: true }).first().waitFor();
  assert.equal(await row.getByRole('link', { name: 'Post by hand' }).getAttribute('href'), `#/post-now/${id}`);
  assert.match(await page.locator('.page-subtitle').innerText(), /1 to post by hand/);
  // Status filter.
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.locator('#planner-filters').getByRole('button', { name: 'Post by hand' }).click();
  await waitFor(() => page.url().includes('status=reminded'), { message: 'filter in the URL' });
  assert.deepEqual(await page.locator('.pl-row').evaluateAll((els) => els.map((e) => e.dataset.postId)), [id]);
  await page.locator('#planner-filters').getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('button', { name: /^Filters/ }).click();

  // One name for the status ("Post by hand"), with when the reminder went out as extra detail.
  await row.waitFor();
  assert.equal((await row.locator('.status').textContent()).trim(), 'Post by hand');
  await row.getByText(/^Reminder sent /).waitFor();
  const hint = page.locator('[data-section="reminded"] .pl-section-hint');
  assert.match(await hint.innerText(), /^The reminder went out\. Post these in the Instagram app/);
  // "Post by hand now" in the composer sends no reminder: nothing claims one went out.
  const nowId = await page.evaluate(async () => {
    const data = await import('/postpilot/js/data.js');
    const { newPost } = await import('/postpilot/core/model.js');
    const lib = await data.getStore().read('library');
    const asset = lib.assets.find((a) => a.name === 'Night hills');
    const post = newPost({ status: 'reminded', publishMode: 'reminder', reminderSentAt: null, scheduledAt: new Date().toISOString(), caption: 'E2E by hand now, no reminder.', media: [{ assetId: asset.id, kind: 'image' }] });
    await data.mutate('posts', (doc) => void doc.posts.push(post), { message: 'e2e: by hand now' });
    return post.id;
  });
  const nowRow = page.locator(`[data-section="reminded"] .pl-row[data-post-id="${nowId}"]`);
  await nowRow.waitFor();
  assert.equal((await nowRow.locator('.status').textContent()).trim(), 'Post by hand');
  assert.equal(await nowRow.getByText(/Reminder sent/).count(), 0);
  assert.equal((await hint.innerText()).trim(), 'Post these in the Instagram app, then mark them as posted.');

  // Grid: a reminded post keeps its place among the planned tiles, flagged "Post by hand", not movable.
  await page.evaluate(() => (location.hash = '#/planner?view=grid'));
  const tile = page.locator(`.pl-tile.is-upcoming.is-reminded[data-post-id="${id}"]`);
  await tile.waitFor();
  assert.equal(await tile.getAttribute('draggable'), 'false');
  assert.equal((await tile.locator('.pl-tile-flag').textContent()).trim(), 'Post by hand');
  assert.match(await tile.locator('.pl-tile-open').getAttribute('aria-label'), /^Waiting to be posted by hand: Post, .*E2E reminder: post this one by hand\.$/);
  await page.locator('.pl-notes li', { hasText: 'Post by hand' }).waitFor();
  await shot(page, 'planner-grid-reminded');
  await tile.locator('.pl-tile-open').click();
  await waitFor(() => page.url().includes(`#/post-now/${id}`), { message: 'the grid tile opens Post by hand' });
  await page.evaluate(async (gone) => {
    const data = await import('/postpilot/js/data.js');
    await data.mutate('posts', (doc) => void (doc.posts = doc.posts.filter((p) => p.id !== gone)), { message: 'e2e: clean up' });
  }, nowId);
  await page.evaluate(() => (location.hash = '#/planner'));
});

test('a post marked as posted by hand shows once, by its link, before the worker links it to its media', async () => {
  const { page } = h;
  // The newest Instagram post no Postpilot post has (analytics-media fills in shortly after the server starts).
  const m = await waitFor(
    () =>
      page.evaluate(async () => {
        const { getStore } = await import('/postpilot/js/data.js');
        const store = getStore();
        await store.refresh();
        const linked = new Set((await store.read('posts')).posts.map((p) => p.igMediaId).filter(Boolean));
        return Object.values((await store.read('analytics-media')).media || {})
          .filter((x) => x.productType !== 'STORY' && x.permalink && !linked.has(x.id))
          .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
      }),
    { timeout: 60_000, interval: 1000, message: 'saved Instagram media' },
  );
  const day = dayKey(new Date(m.timestamp), TZ);
  await page.evaluate((d) => (location.hash = `#/planner?view=day&date=${d}`), day);
  const igItem = page.locator(`.pl-dayview a.is-ig[href="${m.permalink}"]`);
  await igItem.waitFor();
  // As "Mark as posted" leaves it when Postpilot could not find the media yet: the link, no igMediaId.
  const id = await page.evaluate(async (m) => {
    const data = await import('/postpilot/js/data.js');
    const { newPost } = await import('/postpilot/core/model.js');
    const lib = await data.getStore().read('library');
    const asset = lib.assets.find((a) => a.name === 'Desert sunrise');
    const post = newPost({ status: 'published', publishMode: 'reminder', type: m.mediaType === 'CAROUSEL_ALBUM' ? 'carousel' : m.productType === 'REELS' ? 'reel' : 'feed', caption: 'E2E posted by hand, not linked yet.', scheduledAt: m.timestamp, publishedAt: m.timestamp, permalink: `${m.permalink}?igsh=ZTJl`, media: [{ assetId: asset.id, kind: 'image' }] });
    await data.mutate('posts', (doc) => void doc.posts.push(post), { message: 'e2e: posted by hand' });
    return post.id;
  }, m);
  await page.locator(`.pl-dayview [data-post-id="${id}"]`).waitFor();
  assert.equal(await igItem.count(), 0, 'no separate "Published on Instagram" item');
  // Grid: one tile, the Instagram one (with its picture).
  await page.evaluate(() => (location.hash = '#/planner?view=grid'));
  await page.locator('.pl-ig-grid').waitFor();
  await page.locator(`.pl-tile.is-published[href="${m.permalink}"]`).waitFor();
  assert.equal(await page.locator(`.pl-tile.is-published[href^="${m.permalink}"]`).count(), 1);
  assert.equal(await page.locator('.pl-tile.is-published[aria-label*="E2E posted by hand"]').count(), 0);
  await page.evaluate(async (gone) => {
    const data = await import('/postpilot/js/data.js');
    await data.mutate('posts', (doc) => void (doc.posts = doc.posts.filter((p) => p.id !== gone)), { message: 'e2e: clean up' });
  }, id);
  await page.evaluate(() => (location.hash = '#/planner'));
});

test('ideas for next week: Claude suggests ideas, the kept ones become drafts with the idea in the notes', async () => {
  const { page } = h;
  await page.getByRole('button', { name: 'Ideas for next week' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ideas for next week' });
  await dialog.waitFor();
  await dialog.getByLabel('Anything to focus on').fill('Autumn glazes go on sale Friday.');
  await dialog.getByRole('button', { name: 'Get ideas' }).click();
  await dialog.locator('.pl-idea').nth(1).waitFor({ timeout: 30_000 });
  const n = await dialog.locator('.pl-idea').count(); // the mock returns 3 whatever was asked
  await dialog.locator('.pl-idea').nth(1).getByRole('checkbox').click();
  await page.waitForTimeout(300);
  await shot(page, 'planner-ideas-1280-light');
  const before = (await storedPosts()).length;
  const keep = n - 1;
  await dialog.getByRole('button', { name: `Create ${keep} draft${keep === 1 ? '' : 's'}` }).click();
  await page.getByText(new RegExp(`^Added ${keep} drafts? with the idea in the notes`)).waitFor();
  const ideas = await waitFor(async () => {
    const posts = (await storedPosts()).filter((p) => (p.labels || []).includes('idea'));
    return posts.length === keep ? posts : null;
  }, { message: 'idea drafts' });
  assert.equal((await storedPosts()).length, before + keep);
  for (const p of ideas) {
    assert.equal(p.status, 'draft');
    assert.match(p.notes, /^Idea: /);
    assert.ok(!p.scheduledAt || (Date.parse(p.scheduledAt) > Date.now() && Date.parse(p.scheduledAt) < Date.now() + 9 * 864e5));
  }
  // Remove them again so the later list and filter tests see the seeded posts only.
  await page.evaluate(async () => {
    const data = await import('/postpilot/js/data.js');
    await data.mutate('posts', (doc) => void (doc.posts = doc.posts.filter((p) => !(p.labels || []).includes('idea'))), { message: 'e2e: remove idea drafts' });
  });
});

test('ideas keep the gap from a post being posted by hand', async () => {
  const { page } = h;
  // Where one idea goes, worked out as the planner does (core/schedule.js on the same documents).
  const firstSlot = () =>
    page.evaluate(async () => {
      const data = await import('/postpilot/js/data.js');
      const { bestTimeMatrix, suggestSlots } = await import('/postpilot/core/schedule.js');
      await data.refreshNow();
      const store = data.getStore();
      const tz = (await store.read('settings')).timezone;
      const audience = await store.read('audience');
      const media = await store.read('analytics-media');
      const posts = (await store.read('posts')).posts;
      const matrix = bestTimeMatrix({ onlineFollowers: audience.onlineFollowers, mediaStats: media.media, tz }).matrix;
      const taken = posts
        .filter((p) => ['draft', 'scheduled', 'publishing', 'reminded'].includes(p.status) && p.scheduledAt)
        .map((p) => (p.status === 'reminded' ? p.reminderSentAt || p.scheduledAt : p.scheduledAt));
      return suggestSlots({ matrix, tz, count: 1, horizonDays: 8, minGapHours: 20, taken, maxPerDay: 1 })[0] || null;
    });
  const before = await firstSlot();
  assert.ok(before, 'there is a free time for an idea');
  // "Post by hand now" on a post planned for that time: no reminder went out, so it counts at its planned time.
  const id = await page.evaluate(async (at) => {
    const data = await import('/postpilot/js/data.js');
    const { newPost } = await import('/postpilot/core/model.js');
    const lib = await data.getStore().read('library');
    const a = lib.assets.find((x) => x.name === 'Vase trio');
    const post = newPost({ status: 'reminded', publishMode: 'reminder', caption: 'E2E ideas gap: posting by hand', media: [{ assetId: a.id, kind: 'image', altText: '' }], scheduledAt: at, reminderSentAt: null });
    await data.mutate('posts', (doc) => void doc.posts.push(post), { message: 'e2e: reminded post' });
    return post.id;
  }, before);
  try {
    const expected = await firstSlot();
    assert.ok(expected && Math.abs(Date.parse(expected) - Date.parse(before)) >= 20 * 36e5, 'the next free time keeps the 20-hour gap');
    await page.evaluate(async () => (await import('/postpilot/js/data.js')).refreshNow());
    await page.getByRole('button', { name: 'Ideas for next week' }).click();
    const dialog = page.getByRole('dialog', { name: 'Ideas for next week' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Get ideas' }).click();
    await dialog.locator('.pl-idea').nth(2).waitFor({ timeout: 30_000 });
    const n = await dialog.locator('.pl-idea').count();
    for (let i = 1; i < n; i++) await dialog.locator('.pl-idea').nth(i).getByRole('checkbox').click();
    await dialog.getByRole('button', { name: 'Create 1 draft' }).click();
    await page.getByText(/^Added 1 draft with the idea in the notes/).waitFor();
    const idea = await waitFor(async () => (await storedPosts()).find((p) => (p.labels || []).includes('idea')), { message: 'idea draft' });
    assert.equal(idea.scheduledAt, expected, 'the idea goes to the next free time, not the reminded post\'s');
  } finally {
    await page.evaluate(async (id) => {
      const data = await import('/postpilot/js/data.js');
      await data.mutate('posts', (doc) => void (doc.posts = doc.posts.filter((p) => p.id !== id && !(p.labels || []).includes('idea'))), { message: 'e2e: clean up' });
    }, id);
  }
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

test('CSV import with a media link: the post waits for the worker to download the file', async () => {
  const { page } = h;
  await setView('List');
  const day = addDaysKey(dayKey(new Date(), TZ), 6);
  const link = `${h.url}/mock/img/f12.jpg`;
  await page.getByRole('button', { name: 'Import CSV' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import posts from CSV' });
  await dialog.waitFor();
  await dialog.getByText(/direct links to JPEG photos and MP4 videos: the worker downloads those/).waitFor();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'links.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`date,time,caption,media
${day},09:30,From a link,${link}
${day},18:30,Same link again,${link}
`),
  });
  await dialog.locator('.pl-import-row.is-ok').nth(1).waitFor();
  await dialog.getByText('1 file will be downloaded by the worker from its link after the import (it runs about every 10 minutes). Posts wait for their files.').waitFor();
  assert.equal(await dialog.locator('.pl-import-row .pl-thumb.is-importing').count(), 2);
  await page.waitForTimeout(300);
  await shot(page, 'planner-import-links-1280-light');
  await dialog.getByRole('button', { name: 'Create 2 posts' }).click();
  await page.getByText(/Imported 2 posts as scheduled\. The worker downloads 1 linked file on its next run\./).waitFor();
  const lib = await page.evaluate(async () => {
    const { getStore } = await import('/postpilot/js/data.js');
    await getStore().refresh();
    return (await getStore().read('library')).assets;
  });
  const asset = lib.find((a) => a.importUrl === link);
  assert.ok(asset, 'a library file waits for the download');
  assert.equal(asset.name, 'f12.jpg');
  const posts = (await storedPosts()).filter((p) => p.caption === 'From a link' || p.caption === 'Same link again');
  assert.equal(posts.length, 2);
  assert.ok(posts.every((p) => p.media[0].assetId === asset.id && p.status === 'scheduled' && p.source === 'csv'), 'one shared file');
  await page.locator(`.pl-row[data-post-id="${posts[0].id}"] .pl-thumb.is-importing`).waitFor();
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
      const tomorrow = addDaysKey(dayKey(new Date(), TZ), 1);
      for (const view of ['month', 'week', 'day', 'list', 'grid', 'search']) {
        const hash = { month: '#/planner', day: `#/planner?view=day&date=${tomorrow}`, search: '#/planner?view=list&q=studio' }[view] || `#/planner?view=${view}`;
        await page.evaluate((x) => (location.hash = x), hash);
        await page.waitForSelector({ month: '.pl-month', week: '.pl-week', day: '.pl-dayview', search: '.pl-search-note' }[view] || (view === 'list' ? '.pl-list' : '.pl-gridview'));
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
