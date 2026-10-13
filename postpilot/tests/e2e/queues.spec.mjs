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

test('a new feed address clears the failure count and the full flag; a feed that keeps failing says it is checked less often', async () => {
  const { page } = h;
  const card = page.locator('.qu-card', { hasText: 'Throwback Thursday' });
  const row = card.locator('.qu-feed');
  await row.waitFor();
  const feedOf = async () => (await stored('lists')).lists.find((l) => l.name === 'Throwback Thursday').feeds[0];
  // As the worker leaves a feed after five failed checks in a row (worker/jobs/feeds.mjs feedInterval).
  await page.evaluate(async () => {
    const data = await import('/postpilot/js/data.js');
    await data.mutate('lists', (doc) => {
      const f = doc.lists.find((l) => l.name === 'Throwback Thursday').feeds[0];
      Object.assign(f, { error: 'The feed answered 500 Internal Server Error.', errorCount: 5, full: true, checkedAt: new Date().toISOString() });
    }, { message: 'e2e: failing feed' });
  });
  await row.getByText('The feed answered 500 Internal Server Error. It keeps failing, so it is checked less often, up to once a day.').waitFor({ timeout: 15_000 });

  await openMenu(row.getByRole('button', { name: /^Actions for the feed/ }));
  await page.getByRole('menuitem', { name: 'Edit feed' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit feed' });
  await dialog.getByText('A feed that keeps failing is checked less often, up to once a day.').waitFor();
  const url = `${h.url}/mock/feed/demo.xml?e2e=moved`;
  await dialog.getByLabel('Feed address').fill(url);
  await dialog.getByText('A new address is checked from scratch: the newest 3 posts are added again.').waitFor();
  await dialog.getByRole('button', { name: 'Save feed' }).click();
  await dialog.waitFor({ state: 'detached' });
  const feed = await waitFor(async () => {
    const f = await feedOf();
    return f.url === url ? f : null;
  }, { message: 'feed saved' });
  assert.equal(feed.error, null);
  assert.equal(feed.checkedAt, null);
  assert.equal(feed.errorCount, undefined, 'the new address starts without failures');
  assert.equal(feed.full, undefined, 'and without the full flag');
  await row.getByText('Not checked yet').waitFor();
  assert.equal(await row.getByText(/checked less often/).count(), 0);
});

test('removing items or deleting a queue offers to delete the link files nothing else uses', async () => {
  const { page } = h;
  // Files from links (downloads that failed, so the page never loads them): one per case.
  const ids = await page.evaluate(async () => {
    const data = await import('/postpilot/js/data.js');
    const { newAsset, newList, newPost, uid } = await import('/postpilot/core/model.js');
    const lib = await data.getStore().read('library');
    const vase = lib.assets.find((a) => a.name === 'Vase trio');
    const link = (name, extra = {}) =>
      newAsset({ name, importUrl: `https://example.invalid/e2e/${name}`, importError: 'The link answered 404 Not Found.', importErrorCode: 'http', ...extra });
    const a = {
      gone: link('e2e-gone.jpg'), // only in the queue
      kept: link('e2e-kept.jpg'), // only in the queue, offer left unticked
      shared: link('e2e-shared.jpg'), // also in another queue
      posted: link('e2e-posted.jpg'), // used by a published post
      pool: link('e2e-pool.jpg', { autopilot: true }), // in the autopilot pool
      last1: link('e2e-last1.jpg'),
      last2: link('e2e-last2.jpg'),
    };
    const item = (asset, caption) => ({ id: uid('li_'), type: 'feed', caption, firstComment: '', media: [{ assetId: asset.id, kind: 'image', altText: '' }], timesUsed: 0, lastUsedAt: null });
    const list = newList({ name: 'E2E link cleanup', enabled: false, items: [
      item(a.gone, 'Gone'), item(a.kept, 'Kept'), item(a.shared, 'Shared'), item(a.posted, 'Posted'), item(a.pool, 'Pool'), item(vase, 'Library file'), item(a.last1, 'Last one'), item(a.last2, 'Last two'),
    ] });
    const other = newList({ name: 'E2E other queue', enabled: false, items: [item(a.shared, 'Shared too')] });
    const post = newPost({ status: 'published', caption: 'E2E posted from a link', media: [{ assetId: a.posted.id, kind: 'image', altText: '' }], scheduledAt: new Date(Date.now() - 864e5).toISOString(), publishedAt: new Date(Date.now() - 864e5).toISOString() });
    await data.mutate('library', (doc) => void doc.assets.push(...Object.values(a)), { message: 'e2e: link files' });
    await data.mutate('lists', (doc) => void doc.lists.push(list, other), { message: 'e2e: link queues' });
    await data.mutate('posts', (doc) => void doc.posts.push(post), { message: 'e2e: posted link file' });
    return { assets: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.id])), vase: vase.id, list: list.id, other: other.id, post: post.id, items: list.items.map((it) => it.id) };
  });
  const inLibrary = async () => new Set((await stored('library')).assets.map((a) => a.id));
  const card = page.locator('.qu-card', { hasText: 'E2E link cleanup' });
  await card.waitFor({ timeout: 15_000 });
  const editor = page.getByRole('dialog', { name: 'Edit "E2E link cleanup"' });
  const removeItem = (id) => editor.locator(`.qu-item[data-item-id="${id}"]`).locator('.qu-item-remove').click();
  const offer = editor.getByRole('checkbox', { name: /^Also delete/ });

  // Files that something else uses are never offered: another queue, a published post, the autopilot pool, uploads.
  await card.getByRole('button', { name: 'Edit queue' }).click();
  await editor.waitFor();
  for (const i of [2, 3, 4, 5]) await removeItem(ids.items[i]);
  assert.equal(await offer.count(), 0, 'nothing to offer');
  // Removing an item whose file is only in this queue offers it, unticked.
  await removeItem(ids.items[0]);
  await offer.waitFor();
  assert.match(await editor.locator('.qu-cleanup').textContent(), /Also delete 1 file from the library.*It came from links \(a feed or a CSV file\) and nothing else uses it\./);
  assert.equal(await offer.isChecked(), false);
  await removeItem(ids.items[1]);
  await editor.locator('.qu-cleanup', { hasText: 'Also delete 2 files from the library' }).waitFor();
  // Tick it, then untick it again: unticked keeps the files.
  await offer.check();
  await offer.uncheck();
  await editor.getByRole('button', { name: 'Save queue' }).click();
  await page.locator('.toast-msg', { hasText: /^Queue "E2E link cleanup" saved\.$/ }).waitFor();
  let lib = await inLibrary();
  assert.ok(lib.has(ids.assets.gone) && lib.has(ids.assets.kept), 'unticked: the files stay');

  // Edit again: the two files are no longer in any queue item, so removing more items offers only theirs.
  await card.getByRole('button', { name: 'Edit queue' }).click();
  await editor.waitFor();
  await removeItem(ids.items[6]);
  await editor.locator('.qu-cleanup', { hasText: 'Also delete 1 file from the library' }).waitFor();
  await offer.check();
  await editor.getByRole('button', { name: 'Save queue' }).click();
  await page.locator('.toast', { hasText: 'Queue "E2E link cleanup" saved. Deleted 1 file from the library.' }).waitFor();
  lib = await inLibrary();
  assert.ok(!lib.has(ids.assets.last1), 'the ticked file is deleted');
  for (const k of ['gone', 'kept', 'shared', 'posted', 'pool', 'last2']) assert.ok(lib.has(ids.assets[k]), `${k} stays`);
  assert.ok(lib.has(ids.vase));

  // Delete the queue: its last link file is offered (the uploaded one is not).
  await openMenu(card.getByRole('button', { name: 'Actions for E2E link cleanup' }));
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete "E2E link cleanup"?' });
  await confirm.getByText('This deletes the queue and its items. Posts already on Instagram stay there.').waitFor();
  const del = confirm.getByRole('checkbox', { name: /^Also delete 1 file from the library/ });
  assert.equal(await del.isChecked(), false);
  await del.check();
  await confirm.getByRole('button', { name: 'Delete queue' }).click();
  await page.locator('.toast', { hasText: 'Deleted "E2E link cleanup" and 1 file from the library.' }).waitFor();
  await card.waitFor({ state: 'detached' });
  lib = await inLibrary();
  assert.ok(!lib.has(ids.assets.last2));
  for (const k of ['gone', 'kept', 'shared', 'posted', 'pool']) assert.ok(lib.has(ids.assets[k]), `${k} stays`);
  assert.ok(lib.has(ids.vase), 'uploaded files are never offered');

  // The file the other queue shared is now only there: deleting that queue offers it. Left unticked, it stays.
  const other = page.locator('.qu-card', { hasText: 'E2E other queue' });
  await openMenu(other.getByRole('button', { name: 'Actions for E2E other queue' }));
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const again = page.getByRole('dialog', { name: 'Delete "E2E other queue"?' });
  await again.getByRole('checkbox', { name: /^Also delete 1 file from the library/ }).waitFor();
  await again.getByRole('button', { name: 'Delete queue' }).click();
  await page.locator('.toast-msg', { hasText: /^Deleted "E2E other queue"\.$/ }).waitFor();
  await other.waitFor({ state: 'detached' });
  assert.ok((await inLibrary()).has(ids.assets.shared), 'unticked: the file stays');

  // Clean up what is left for the tests that follow.
  await page.evaluate(async (ids) => {
    const data = await import('/postpilot/js/data.js');
    const drop = new Set(Object.values(ids.assets));
    await data.mutate('posts', (doc) => void (doc.posts = doc.posts.filter((p) => p.id !== ids.post)), { message: 'e2e: clean up' });
    await data.mutate('library', (doc) => void (doc.assets = doc.assets.filter((a) => !drop.has(a.id))), { message: 'e2e: clean up' });
  }, ids);
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
