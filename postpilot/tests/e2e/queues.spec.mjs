// Queues e2e: seeded queue card, create a queue with 2 items and 2 slots (repeat off), worker fills it,
// reorder items, pause, duplicate, delete; screenshots in both themes and sizes.
// Run: node --test tests/e2e/queues.spec.mjs

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, shot, unlock } from './helpers.mjs';

// Separate from the planner spec's port (5212) so both files can run in parallel.
const PORT = 5282;
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
  assert.equal(await card.getByRole('switch').getAttribute('aria-checked'), 'true');
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

test('pause, duplicate and delete', async () => {
  const { page } = h;
  const seeded = page.locator('.qu-card', { hasText: 'Throwback Thursday' });
  await seeded.getByRole('switch').click();
  await page.getByText(/"Throwback Thursday" is paused/).waitFor();
  await waitFor(async () => (await stored('lists')).lists.find((l) => l.name === 'Throwback Thursday').enabled === false, { message: 'paused' });
  assert.equal(await seeded.getByRole('switch').getAttribute('aria-checked'), 'false');

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
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `no horizontal scroll at ${w}px`);
      await shot(page, `queues-${w}-${scheme}`);
      await page.locator('.qu-card', { hasText: 'Throwback Thursday' }).first().getByRole('button', { name: 'Edit queue' }).click();
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(400);
      await shot(page, `queues-editor-${w}-${scheme}`);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  }
});

test('no console errors', () => {
  assert.deepEqual(h.consoleErrors, []);
});
