// Queues e2e: seeded queue card, create a queue with 2 items and 2 slots (repeat off), worker fills it,
// reorder items, CSV with a link into a queue, items written with AI, the demo RSS feed (the dev
// server's worker downloads the images; a PNG is refused), pause, duplicate, delete; screenshots in
// both themes and sizes.
// Run: node --test tests/e2e/queues.spec.mjs

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, shot, unlock } from './helpers.mjs';

// Separate from the planner spec's port (5532) so both files can run in parallel.
const PORT = Number(process.env.QUEUES_E2E_PORT || 5531);
let h;

async function stored(name, page = h.page) {
  return page.evaluate(async (doc) => {
    const { getStore } = await import('/postpilot/js/data.js');
    const store = getStore();
    await store.refresh();
    return store.read(doc);
  }, name);
}

async function waitFor(fn, { timeout = 15_000, interval = 300, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

/** Open a kit Menu without the scroll-into-view closing it. */
async function openMenu(trigger) {
  await trigger.scrollIntoViewIfNeeded();
  await h.page.waitForTimeout(200);
  await trigger.click();
}

before(async () => {
  h = await openApp({ port: PORT, hash: '#/queues' });
  await h.page.waitForSelector('.qu-card', { timeout: 20_000 });
});

after(async () => {
  await h?.close();
});

test('seeded queue renders with slots, items and next post', async () => {
  const card = h.page.locator('.qu-card', { hasText: 'Throwback Thursday' });
  await card.waitFor();
  assert.match(await card.locator('.qu-slots').innerText(), /Thu 6:00p/);
  assert.match(await card.innerText(), /2 items · in order · repeats/);
  assert.match(await card.innerText(), /Next post/);
  assert.equal(await card.locator('.qu-strip .pl-thumb').count(), 2);
  assert.equal(await card.getByRole('switch', { name: /^Throwback Thursday:/ }).getAttribute('aria-checked'), 'true');
});

test('create a queue with 2 items and 2 slots; the worker fills it', async () => {
  const { page } = h;
  await page.getByRole('button', { name: 'New queue' }).click();
  const dialog = page.getByRole('dialog', { name: 'New queue' });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Create queue' }).click();
  await dialog.getByText('Give the queue a name.').waitFor();

  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Studio tips');
  await dialog.getByRole('radio', { name: 'Green' }).click();
  // One default slot (Tuesday 12:00); add a second on Friday 18:30.
  await dialog.getByRole('button', { name: 'Add time slot' }).click();
  await dialog.getByLabel('Slot 2 day').selectOption({ label: 'Friday' });
  await dialog.getByLabel('Slot 2 time').fill('18:30');
  await dialog.getByRole('switch', { name: /Repeat items/ }).click();
  await dialog.getByLabel('Fill ahead').fill('21');

  // Two items from the library through the MediaPicker.
  await dialog.getByRole('button', { name: 'Add from library' }).first().click();
  const picker = page.getByRole('dialog', { name: 'Add items from the library' });
  await picker.waitFor();
  await picker.locator('.mp-tile[aria-label^="Photo: Vase trio"]').click();
  await picker.locator('.mp-tile[aria-label^="Photo: Night hills"]').click();
  await picker.getByRole('button', { name: /^Add 2/ }).click();
  await picker.waitFor({ state: 'detached' });
  const items = dialog.locator('.qu-item');
  assert.equal(await items.count(), 2);
  await items.nth(0).getByLabel('Caption').fill('Tip one: wedge your clay before you throw.');
  await items.nth(1).getByLabel('Caption').fill('Tip two: let the kiln cool before you open it.');
  await items.nth(1).getByLabel('First comment').fill('More tips every week.');
  // The preview lists what the worker will create.
  await dialog.locator('.qu-preview-list li').first().waitFor();
  await shot(page, 'queues-editor-1280-light');

  await dialog.getByRole('button', { name: 'Create queue' }).click();
  await page.getByText(/Queue "Studio tips" created/).waitFor();
  const card = page.locator('.qu-card', { hasText: 'Studio tips' });
  await card.waitFor();
  assert.match(await card.innerText(), /2 items · in order · each used once/);

  const doc = await stored('lists');
  const list = doc.lists.find((l) => l.name === 'Studio tips');
  assert.ok(list, 'saved');
  assert.equal(list.items.length, 2);
  assert.deepEqual(list.slots, [{ weekday: 2, time: '12:00' }, { weekday: 5, time: '18:30' }]);
  assert.equal(list.repeat, false);
  assert.equal(list.enabled, true);
  assert.equal(list.horizonDays, 21);
  assert.equal(list.color, '#189E6E');
  assert.equal(list.items[1].firstComment, 'More tips every week.');
  assert.ok(list.items.every((it) => it.media.length === 1 && it.type === 'feed'));

  // "Fill now" runs the worker (the dev server runs it against the mocks): one post per item.
  await page.getByRole('button', { name: 'Fill now' }).click();
  const posts = await waitFor(async () => {
    const p = (await stored('posts')).posts.filter((x) => x.listId === list.id);
    return p.length === 2 ? p : null;
  }, { timeout: 30_000, message: 'queue posts from the worker' });
  assert.deepEqual(posts.map((p) => p.caption).sort(), list.items.map((it) => it.caption).sort());
  assert.ok(posts.every((p) => p.status === 'scheduled' && p.source === 'evergreen'));
  await page.evaluate(async () => (await import('/postpilot/js/data.js')).refreshNow());
  await card.getByText('+1 more').waitFor({ timeout: 10_000 });
});

test('edit: reorder items and save', async () => {
  const { page } = h;
  const card = page.locator('.qu-card', { hasText: 'Studio tips' });
  await card.getByRole('button', { name: 'Edit queue' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit "Studio tips"' });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Move item 2 up' }).click();
  assert.equal(await dialog.locator('.qu-item').nth(0).getByLabel('Caption').inputValue(), 'Tip two: let the kiln cool before you open it.');
  await dialog.getByRole('button', { name: 'Save queue' }).click();
  await page.getByText(/Queue "Studio tips" saved/).waitFor();
  const list = (await stored('lists')).lists.find((l) => l.name === 'Studio tips');
  assert.equal(list.items[0].caption, 'Tip two: let the kiln cool before you open it.');

  // Unsaved edits ask before they are thrown away.
  await card.getByRole('button', { name: 'Edit queue' }).click();
  await dialog.waitFor();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Renamed but not saved');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  const ask = page.getByRole('dialog', { name: 'Discard your changes?' });
  await ask.getByRole('button', { name: 'Discard' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.ok((await stored('lists')).lists.some((l) => l.name === 'Studio tips'));
});

test('CSV into a queue: library file names and links; linked files wait for the worker', async () => {
  const { page } = h;
  const card = page.locator('.qu-card', { hasText: 'Throwback Thursday' });
  await openMenu(card.getByRole('button', { name: 'Actions for Throwback Thursday' }));
  await page.getByRole('menuitem', { name: 'Import CSV into this queue' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import CSV into "Throwback Thursday"' });
  await dialog.waitFor();
  const csv = [
    'caption,first_comment,media,date,type',
    '"From the library, with a comma",Hi,Vase trio,2030-01-01,',
    `From a link,,${h.url}/mock/img/f11.jpg,,`,
    'Missing file,,No such file.jpg,,',
    `Video link,,${h.url}/mock/img/clip.mp4,,`,
    `Story row,,${h.url}/mock/img/f14.jpg,,story`,
  ].join('\n');
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'queue.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await dialog.locator('.qu-csv-row.is-ok').nth(2).waitFor();
  assert.equal(await dialog.locator('.qu-csv-row.has-error').count(), 2);
  await dialog.getByText('2 files will be downloaded by the worker from their links after the import.').waitFor();
  await dialog.getByText('Ignored columns: date').waitFor();
  await dialog.getByText('"f11.jpg" will be downloaded by the worker from its link.').waitFor();
  // A skipped row downloads nothing, so it gets no download note.
  const storyRow = dialog.locator('.qu-csv-row.has-error', { hasText: 'Story row' });
  await storyRow.getByText('Queues post to the feed, so stories cannot go in a queue.').waitFor();
  assert.equal(await storyRow.getByText(/will be downloaded by the worker/).count(), 0);
  await dialog.locator('.qu-csv-row.is-ok .pl-thumb.is-importing').first().waitFor();
  await shot(page, 'queues-csv-1280-light');
  await dialog.getByRole('button', { name: 'Add 3 items' }).click();
  await page.getByText(/Added 3 items to "Throwback Thursday"\. The worker downloads 2 linked files on its next run\./).waitFor();

  const list = (await stored('lists')).lists.find((l) => l.name === 'Throwback Thursday');
  const added = list.items.filter((it) => it.source === 'csv');
  assert.deepEqual(added.map((it) => it.caption), ['From the library, with a comma', 'From a link', 'Video link']);
  assert.equal(added[2].type, 'reel');
  assert.equal(added[0].firstComment, 'Hi');
  const lib = (await stored('library')).assets;
  const linked = lib.find((a) => a.id === added[1].media[0].assetId);
  assert.equal(linked.importUrl, `${h.url}/mock/img/f11.jpg`);
  assert.equal(linked.name, 'f11.jpg');
  assert.equal(linked.kind, 'image');
  assert.equal(lib.find((a) => a.id === added[0].media[0].assetId).name, 'Vase trio');
  // The card and the editor show the placeholder, without trying to load the missing file.
  await card.getByText('2 items waiting for the worker to download their files.').waitFor();
  await card.getByRole('button', { name: 'Edit queue' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit "Throwback Thursday"' });
  await editor.waitFor();
  const item = editor.locator(`.qu-item[data-item-id="${added[1].id}"]`);
  await item.locator('.pl-thumb.is-importing').waitFor();
  await item.getByText('From CSV').waitFor();
  await item.getByText(/still being downloaded from its link by the worker/).waitFor();
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await editor.waitFor({ state: 'detached' });
});

test('generate queue items with AI from picked library media', async () => {
  const { page } = h;
  const card = page.locator('.qu-card', { hasText: 'Throwback Thursday' });
  await openMenu(card.getByRole('button', { name: 'Add items' }));
  await page.getByRole('menuitem', { name: 'Generate with AI' }).click();
  const dialog = page.getByRole('dialog', { name: 'Generate items for "Throwback Thursday"' });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Choose media first' }).isDisabled(), true);
  await dialog.getByRole('button', { name: 'Choose media', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Media for the new items' });
  await picker.waitFor();
  // Files still downloading cannot be picked here: Claude needs to see them.
  const waiting = picker.locator('.mp-tile[aria-label^="Photo: f11.jpg"]');
  assert.match(await waiting.getAttribute('aria-label'), /still downloading from its link, cannot be picked yet/);
  assert.equal(await waiting.isDisabled(), true);
  await picker.locator('.mp-tile[aria-label^="Photo: Desert sunrise"]').click();
  await picker.locator('.mp-tile[aria-label^="Photo: Night hills"]').click();
  await picker.getByRole('button', { name: 'Use this media' }).click();
  await picker.waitFor({ state: 'detached' });
  await dialog.getByLabel('What should the captions focus on?').fill('Quiet studio mornings.');
  await dialog.getByRole('button', { name: 'Write 2 captions' }).click();
  await dialog.locator('.qu-ai-item').nth(1).waitFor({ timeout: 30_000 });
  const first = dialog.locator('.qu-ai-item').first().getByLabel('Caption');
  assert.ok((await first.inputValue()).length > 10, 'a caption was written');
  await first.fill('Edited AI caption for the queue.');
  await dialog.locator('.qu-ai-item').nth(1).getByRole('checkbox', { name: 'Keep' }).click();
  await shot(page, 'queues-ai-1280-light');
  await dialog.getByRole('button', { name: 'Add 1 item' }).click();
  await page.getByText('Added 1 item to "Throwback Thursday".').waitFor();
  const list = (await stored('lists')).lists.find((l) => l.name === 'Throwback Thursday');
  const ai = list.items.filter((it) => it.source === 'ai');
  assert.equal(ai.length, 1);
  assert.equal(ai[0].caption, 'Edited AI caption for the queue.');
  assert.equal(ai[0].type, 'feed');
});

test('RSS feed: add the demo feed, the worker adds its newest 3 usable posts and downloads their images', async () => {
  const { page } = h;
  const card = page.locator('.qu-card', { hasText: 'Throwback Thursday' });
  await card.getByRole('button', { name: 'Add feed' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a feed to "Throwback Thursday"' });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Add feed' }).click();
  await dialog.getByText('Paste the feed address.').waitFor();
  await dialog.getByLabel('Feed address').fill('studionorth.example/feed');
  await dialog.getByRole('button', { name: 'Add feed' }).click();
  await dialog.getByText('Use a web address that starts with http:// or https://.').waitFor();
  await dialog.getByLabel('Feed address').fill(`${h.url}/mock/feed/demo.xml`);
  await shot(page, 'queues-feed-modal-1280-light');
  await dialog.getByRole('button', { name: 'Add feed' }).click();
  await dialog.waitFor({ state: 'detached' });
  const row = card.locator('.qu-feed');
  await row.getByText('Not checked yet').waitFor();

  // "Check now" runs the worker (in the dev server) and waits for it.
  await page.getByRole('button', { name: 'Check now' }).click();
  await page.getByText('Added 3 items from the feed.').waitFor({ timeout: 60_000 });
  await row.getByText('Studio North Journal').waitFor();
  await row.getByText(/Checked .* · 3 items added/).waitFor();

  const list = (await stored('lists')).lists.find((l) => l.name === 'Throwback Thursday');
  const feed = list.feeds[0];
  assert.equal(feed.url, `${h.url}/mock/feed/demo.xml`);
  assert.equal(feed.added, 3);
  assert.equal(feed.error, null);
  // "The studio playlist" declares a PNG picture, so it is skipped; "Workshop dates" does not say,
  // so its picture is downloaded and then refused.
  const fromFeed = list.items.filter((it) => it.source === 'rss');
  assert.deepEqual(fromFeed.map((it) => it.caption.split('\n')[0]), ['Workshop dates for November', 'Kiln opening: five things we learned', 'Glaze day: ocean and sand']);
  assert.ok(fromFeed.every((it) => it.link.startsWith(`${h.url}/mock/feed/`) && it.feedId === feed.id));
  const lib = (await stored('library')).assets;
  const assetOf = (it) => lib.find((a) => a.id === it.media[0].assetId);
  const [png, og, glaze] = fromFeed.map(assetOf);
  assert.match(png.importError, /PNG image/);
  assert.equal(png.importErrorCode, 'not_jpeg');
  assert.equal(og.importUrl, undefined);
  assert.equal(og.sourceUrl, `${h.url}/mock/img/f10.jpg`, 'og:image of the post page');
  assert.equal(glaze.sourceUrl, `${h.url}/mock/img/f05.jpg`);
  assert.equal(glaze.thumbPath, glaze.path);
  assert.equal(glaze.width, 1080);
  // The CSV links from the earlier test were downloaded in the same run.
  assert.ok(lib.some((a) => a.sourceUrl === `${h.url}/mock/img/f11.jpg` && !a.importUrl));
  const clip = lib.find((a) => a.sourceUrl === `${h.url}/mock/img/clip.mp4`);
  assert.equal(clip.kind, 'video');
  assert.equal(clip.importUrl, undefined);

  await card.getByText('1 item is skipped: its image is not a JPEG. Download it, upload it in the Library (which converts to JPEG), then swap it in.').waitFor();
  assert.equal(await card.getByText(/waiting for the worker to download/).count(), 0);

  // Editor: "From feed" tag and the post link; the failed download shows its reason.
  await card.getByRole('button', { name: 'Edit queue' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit "Throwback Thursday"' });
  await editor.waitFor();
  const glazeItem = editor.locator(`.qu-item[data-item-id="${fromFeed[2].id}"]`);
  await glazeItem.getByText('From feed').waitFor();
  assert.equal(await glazeItem.locator('a.qu-item-link').getAttribute('href'), `${h.url}/mock/feed/glaze-day.html`);
  assert.equal(await glazeItem.locator('a.qu-item-link').getAttribute('target'), '_blank');
  await glazeItem.locator('.pl-thumb img').waitFor();
  const pngItem = editor.locator(`.qu-item[data-item-id="${fromFeed[0].id}"]`);
  await pngItem.getByText(/could not be downloaded from its link: This is a PNG image/).waitFor();
  await pngItem.locator('.pl-thumb.is-import-failed').waitFor();
  // The downloaded video has no poster frame: its thumbnail shows a video icon, not an empty box.
  const videoItem = editor.locator(`.qu-item[data-item-id="${list.items.find((it) => it.caption === 'Video link').id}"]`);
  await videoItem.locator('.pl-thumb.is-video svg').waitFor();
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await editor.waitFor({ state: 'detached' });

  // Turn the feed off and on again, then remove it (items stay).
  await row.getByRole('switch').click();
  await waitFor(async () => (await stored('lists')).lists.find((l) => l.name === 'Throwback Thursday').feeds[0].disabled === true, { message: 'feed off' });
  await row.getByText(/^Off ·/).waitFor();
  await row.getByRole('switch').click();
  await waitFor(async () => (await stored('lists')).lists.find((l) => l.name === 'Throwback Thursday').feeds[0].disabled === false, { message: 'feed on' });
  await openMenu(row.getByRole('button', { name: /^Actions for the feed/ }));
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await page.getByRole('dialog', { name: 'Remove this feed?' }).getByRole('button', { name: 'Remove feed' }).click();
  await row.waitFor({ state: 'detached' });
  const after = (await stored('lists')).lists.find((l) => l.name === 'Throwback Thursday');
  assert.equal(after.feeds.length, 0);
  assert.equal(after.items.filter((it) => it.source === 'rss').length, 3, 'items stay');
  // Put it back for the screenshots.
  await card.getByRole('button', { name: 'Add feed' }).click();
  const again = page.getByRole('dialog', { name: 'Add a feed to "Throwback Thursday"' });
  await again.getByLabel('Feed address').fill(`${h.url}/mock/feed/demo.xml`);
  await again.getByRole('button', { name: 'Add feed' }).click();
  await again.waitFor({ state: 'detached' });
});

test('"Check now" while the worker is paused in Settings says the feed was not checked', async () => {
  const { page } = h;
  const row = page.locator('.qu-card', { hasText: 'Throwback Thursday' }).locator('.qu-feed');
  await row.waitFor();
  const setWorker = (enabled) =>
    page.evaluate(async (on) => {
      const data = await import('/postpilot/js/data.js');
      await data.mutate('settings', (s) => void (s.worker = { ...(s.worker || {}), enabled: on }), { message: 'e2e: worker on/off' });
    }, enabled);
  await setWorker(false);
  try {
    await openMenu(row.getByRole('button', { name: /^Actions for the feed/ }));
    await page.getByRole('menuitem', { name: 'Check now' }).click();
    // The run skips the feeds job (run.skipped.feeds = 'paused'): no "Checked." claim.
    const toast = page.locator('.toast', { hasText: 'The worker is paused in Settings, so the feed was not checked.' });
    await toast.waitFor({ timeout: 60_000 });
    await toast.getByRole('button', { name: 'Open Settings' }).waitFor();
    assert.equal(await page.locator('.toast', { hasText: /^Checked\./ }).count(), 0);
  } finally {
    await setWorker(true);
  }
});

test('pause, duplicate and delete', async () => {
  const { page } = h;
  const seeded = page.locator('.qu-card', { hasText: 'Throwback Thursday' });
  await seeded.getByRole('switch', { name: /^Throwback Thursday:/ }).click();
  await page.getByText(/"Throwback Thursday" is paused/).waitFor();
  await waitFor(async () => (await stored('lists')).lists.find((l) => l.name === 'Throwback Thursday').enabled === false, { message: 'paused' });
  assert.equal(await seeded.getByRole('switch', { name: /^Throwback Thursday:/ }).getAttribute('aria-checked'), 'false');

  await openMenu(seeded.getByRole('button', { name: 'Actions for Throwback Thursday' }));
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await page.locator('.qu-card', { hasText: 'Copy of Throwback Thursday' }).waitFor();

  const card = page.locator('.qu-card', { hasText: 'Studio tips' });
  await openMenu(card.getByRole('button', { name: 'Actions for Studio tips' }));
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete "Studio tips"?' });
  await confirm.getByText(/2 upcoming posts/).waitFor();
  await confirm.getByRole('button', { name: 'Delete queue' }).click();
  await page.getByText(/Deleted "Studio tips" and 2 upcoming posts/).waitFor();
  await card.waitFor({ state: 'detached' });
  const lists = (await stored('lists')).lists;
  assert.ok(!lists.some((l) => l.name === 'Studio tips'));
  const posts = (await stored('posts')).posts;
  assert.ok(!posts.some((p) => p.caption.startsWith('Tip ')), 'its scheduled posts are gone');
});

test('screenshots: desktop and phone, light and dark', async () => {
  for (const [w, hgt] of [[1280, 860], [390, 844]]) {
    for (const scheme of ['light', 'dark']) {
      const ctx = await h.browser.newContext({ viewport: { width: w, height: hgt }, colorScheme: scheme });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      await page.goto(`${h.url}/postpilot/index.html#/queues`);
      await unlock(page);
      await page.waitForSelector('.qu-card');
      await page.waitForFunction(() => !document.querySelector('.pl-thumb:empty'), null, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `no horizontal scroll at ${w}px`);
      await shot(page, `queues-${w}-${scheme}`);
      await page.locator('.qu-card', { hasText: 'Throwback Thursday' }).first().getByRole('button', { name: 'Edit queue' }).click();
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(400);
      await shot(page, `queues-editor-${w}-${scheme}`);
      // Scroll to the feed items at the end of the list.
      await page.locator('.qu-item').last().scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shot(page, `queues-editor-feed-${w}-${scheme}`);
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'Add feed' }).first().click();
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(300);
      await shot(page, `queues-feed-modal-${w}-${scheme}`);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  }
});

test('no console errors', () => {
  assert.deepEqual(h.consoleErrors, []);
});
