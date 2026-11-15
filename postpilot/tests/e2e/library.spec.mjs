// E2E: Library folders, delete confirmation and paging of a large contact sheet.
// Run: node --test tests/e2e/library.spec.mjs
//
// The dev server runs in this process so the test can read and change the seeded documents. It binds a
// fixed port of its own (5512) so it can run next to the other e2e specs; set LIBRARY_E2E_PORT to change it.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startDevServer } from '../../dev/server.mjs';
import { loadPlaywright, shot, unlock } from './helpers.mjs';

const PORT = Number(process.env.LIBRARY_E2E_PORT || 5512);

let dev;
let browser;
let page;
const consoleErrors = [];

async function readDoc(name) {
  await dev.seeded.store.refresh();
  return dev.seeded.store.read(name);
}

async function toastText(re, timeout = 15_000) {
  const t = page.locator('.toast', { hasText: re }).first();
  await t.waitFor({ timeout });
  return t.textContent();
}

const items = () => page.locator('.lib-item');
const select = (name) => page.getByRole('button', { name: `Select ${name}`, exact: true }).click();

describe('Library', { timeout: 240_000 }, () => {
  before(async () => {
    dev = await startDevServer({ port: PORT, seed: true, quiet: true });
    const { chromium } = loadPlaywright();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'light' });
    page = await context.newPage();
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.goto(`${dev.url}/postpilot/index.html#/library`);
    await unlock(page);
    await items().first().waitFor({ timeout: 30_000 });
  });

  after(async () => {
    await browser?.close().catch(() => {});
    await dev?.close();
  });

  test('a new folder made with files selected says they moved into it', async () => {
    await select('Glaze bubbles');
    await select('Green hills');
    await page.locator('.lib-selbar', { hasText: '2 selected' }).waitFor();
    await page.locator('.lib-selbar').getByRole('button', { name: 'Move to' }).click();
    await page.getByRole('menuitem', { name: 'New folder…' }).click();
    const dialog = page.getByRole('dialog', { name: 'New folder' });
    await dialog.getByText('The 2 selected files move into it.').waitFor();
    await dialog.getByLabel('Folder name').fill('Mugs');
    await dialog.getByRole('button', { name: 'Create folder' }).click();
    await toastText(/Folder "Mugs" created/);
    await toastText(/Moved 2 files to Mugs\./);
    assert.equal(await page.locator('.toast', { hasText: 'out of folders' }).count(), 0);
    await page.waitForFunction(() => document.querySelectorAll('.lib-item').length === 2);

    const lib = await readDoc('library');
    const mugs = lib.folders.find((f) => f.name === 'Mugs');
    assert.ok(mugs, 'folder saved');
    assert.deepEqual(lib.assets.filter((a) => a.folderId === mugs.id).map((a) => a.name).sort(), ['Glaze bubbles', 'Green hills']);

    await page.locator('.lib-selbar').getByRole('button', { name: 'Clear' }).click();
    await page.locator('.lib-folder', { hasText: 'All media' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.lib-item').length === 16);
  });

  test('delete does not offer to delete files that scheduled posts or drafts still use', async () => {
    const [lib, postsDoc] = [await readDoc('library'), await readDoc('posts')];
    const active = postsDoc.posts.filter((p) => ['scheduled', 'publishing', 'draft'].includes(p.status));
    const used = new Set(active.flatMap((p) => [...(p.media || []).map((m) => m.assetId), p.coverAssetId].filter(Boolean)));
    const inUse = lib.assets.filter((a) => used.has(a.id)).map((a) => a.name);
    const free = lib.assets.filter((a) => !used.has(a.id) && !postsDoc.posts.some((p) => (p.media || []).some((m) => m.assetId === a.id))).map((a) => a.name);
    assert.ok(inUse.length >= 2 && free.length >= 1, `seed has files in use (${inUse.length}) and unused files (${free.length})`);

    // Every selected file is in use: nothing to confirm, just an explanation.
    await select(inUse[0]);
    await select(inUse[1]);
    await page.locator('.lib-selbar').getByRole('button', { name: 'Delete' }).click();
    await toastText(/These files are used by scheduled posts or drafts\. Remove them from those posts first\./);
    assert.equal(await page.getByRole('dialog').count(), 0, 'no delete confirmation');

    // One of two is in use: the dialog counts only the file that will be deleted.
    await select(inUse[1]);
    await select(free[0]);
    await page.locator('.lib-selbar', { hasText: '2 selected' }).waitFor();
    await page.locator('.lib-selbar').getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete 1 file?' });
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /1 other file is used by a scheduled post or draft and will be kept/);
    await dialog.getByRole('button', { name: 'Delete file', exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.locator('.lib-selbar').getByRole('button', { name: 'Clear' }).click();
    assert.equal((await readDoc('library')).assets.length, 16, 'nothing was deleted');
  });

  test('a large library shows its frames in pages', async () => {
    // 130 more files (copies of a seeded one, sharing its thumbnail).
    await dev.seeded.store.update('library', (lib) => {
      const src = lib.assets.find((a) => a.name === 'Vase trio');
      for (let i = 1; i <= 130; i++) lib.assets.push({ ...src, id: `as_bulk${i}`, name: `Bulk ${String(i).padStart(3, '0')}`, folderId: null, autopilot: false, tags: ['bulk'] });
      return lib;
    }, { message: 'e2e: bulk assets' });
    await page.reload();
    await page.waitForSelector('.app', { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelectorAll('.lib-item').length === 120, null, { timeout: 30_000 });
    assert.match(await page.locator('.page-subtitle').textContent(), /146 files/);
    assert.match(await page.locator('.lib-more').textContent(), /Showing 120 of 146/);
    await shot(page, 'library-e2e-paged');
    await page.locator('.lib-more').getByRole('button', { name: 'Show 26 more' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.lib-item').length === 146);
    assert.equal(await page.locator('.lib-more').count(), 0);

    // A new search starts again from the first page; "Select all" still takes every match.
    await page.getByRole('searchbox', { name: 'Search media' }).fill('bulk');
    await page.waitForFunction(() => document.querySelectorAll('.lib-item').length === 120);
    assert.match(await page.locator('.lib-more').textContent(), /Showing 120 of 130/);
    await select('Bulk 001');
    await page.locator('.lib-selbar').getByRole('button', { name: 'Select all 130' }).click();
    await page.locator('.lib-selbar', { hasText: '130 selected' }).waitFor();
    await page.locator('.lib-selbar').getByRole('button', { name: 'Clear' }).click();
  });

  test('files still downloading from a link show a placeholder; a failed download can be tried again', async () => {
    await dev.seeded.store.update('library', (lib) => {
      const src = lib.assets.find((a) => a.name === 'Vase trio');
      const base = { ...src, folderId: null, autopilot: false, tags: [], usedBy: [] };
      lib.assets.unshift(
        { ...base, id: 'as_pending', name: 'From the RSS feed', path: 'media/as_pending', thumbPath: 'media/as_pending', importUrl: 'https://studionorth.example/blog/kiln.jpg' },
        { ...base, id: 'as_broken', name: 'Broken CSV link', path: 'media/as_broken', thumbPath: 'media/as_broken', importUrl: 'https://example.com/missing.jpg', importError: 'The link answered 404 Not Found.' },
      );
      return lib;
    }, { message: 'e2e: imported assets' });
    await page.reload();
    await page.waitForSelector('.app', { timeout: 30_000 });
    await page.locator('.lib-item[data-asset="as_pending"]').waitFor({ timeout: 30_000 });
    const pending = page.locator('.lib-item[data-asset="as_pending"]');
    const broken = page.locator('.lib-item[data-asset="as_broken"]');
    await pending.locator('.lib-import', { hasText: 'Downloading from link…' }).waitFor();
    await broken.locator('.lib-import.is-error', { hasText: 'Download failed' }).waitFor();
    // No bytes are loaded for them: nothing to show yet.
    await page.waitForTimeout(500);
    assert.equal(await pending.locator('img').count(), 0);
    assert.equal(await broken.locator('img').count(), 0);
    assert.match(await page.locator('.lib-imports').textContent(), /1 file is waiting for the worker to download it from a link.*1 file could not be downloaded/);
    await shot(page, 'library-e2e-importing');

    // The failed one: why, the link, Try again (clears the error so the worker downloads it again).
    await broken.locator('.lib-frame').click();
    const drawer = page.locator('.lib-drawer');
    await drawer.locator('.callout', { hasText: 'Could not download this file' }).waitFor();
    await drawer.getByText('The link answered 404 Not Found.').waitFor();
    await drawer.getByText('https://example.com/missing.jpg').waitFor();
    assert.equal(await drawer.getByRole('link', { name: 'Download' }).count(), 0, 'nothing to download');
    await drawer.getByRole('button', { name: 'Try again' }).click();
    await toastText(/tries the download again on its next run/);
    await drawer.locator('.callout', { hasText: 'Downloading from link…' }).waitFor();
    const a = (await readDoc('library')).assets.find((x) => x.id === 'as_broken');
    assert.equal(a.importError, undefined);
    assert.equal(a.importUrl, 'https://example.com/missing.jpg');

    // Delete works for files that never arrived.
    await drawer.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog', { name: /Delete "Broken CSV link"/ }).getByRole('button', { name: 'Delete file' }).click();
    await toastText(/Deleted 1 file/);
    await page.locator('.lib-item[data-asset="as_pending"]').locator('.lib-frame').click();
    await drawer.locator('.callout', { hasText: 'Downloading from link…' }).waitFor();
    await drawer.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog', { name: /Delete "From the RSS feed"/ }).getByRole('button', { name: 'Delete file' }).click();
    await toastText(/Deleted 1 file/);
    await page.locator('.lib-item[data-asset="as_pending"]').waitFor({ state: 'detached' });
    const left = (await readDoc('library')).assets;
    assert.ok(!left.some((x) => x.id === 'as_pending' || x.id === 'as_broken'));
  });

  test('a linked file Instagram cannot take (a PNG) says how to fix it, without "Try again"', async () => {
    const url = 'https://studionorth.example/img/workshop-poster';
    await dev.seeded.store.update('library', (lib) => {
      const src = lib.assets.find((a) => a.name === 'Vase trio');
      lib.assets.unshift({
        ...src, id: 'as_png', name: 'Workshop poster', folderId: null, autopilot: false, tags: [], usedBy: [],
        path: 'media/as_png', thumbPath: 'media/as_png', mime: 'image/jpeg', // the placeholder type of a linked file
        importUrl: url, importErrorCode: 'not_jpeg',
        importError: 'This is a PNG image. Instagram only takes JPEG photos and the worker cannot convert images. Download the file and upload it in the Library, which converts it to JPEG.',
      });
      return lib;
    }, { message: 'e2e: refused import' });
    await page.reload();
    await page.waitForSelector('.app', { timeout: 30_000 });
    const tile = page.locator('.lib-item[data-asset="as_png"]');
    await tile.waitFor({ timeout: 30_000 });
    await tile.locator('.lib-import.is-error', { hasText: 'Cannot be posted' }).waitFor();
    const note = await page.locator('.lib-imports').textContent();
    assert.match(note, /Instagram cannot take 1 file from a link as it is\. Open it to see why\./);
    assert.doesNotMatch(note, /try again/i, 'trying again downloads the same PNG');

    await tile.locator('.lib-frame').click();
    const drawer = page.locator('.lib-drawer');
    const callout = drawer.locator('.callout', { hasText: 'Instagram cannot take this file' });
    await callout.waitFor();
    await callout.getByText(/This is a PNG image\./).waitFor();
    assert.match(await callout.textContent(), /Upload a fixed copy in the Library/);
    assert.doesNotMatch(await callout.textContent(), /Check that the link opens|then try again/);
    assert.equal(await drawer.getByRole('button', { name: 'Try again' }).count(), 0);
    // The link opens in a new tab, so the file can be downloaded from there.
    const link = callout.getByRole('link', { name: url });
    assert.equal(await link.getAttribute('href'), url);
    assert.equal(await link.getAttribute('target'), '_blank');
    // The type is not known until the file is here (not the "JPEG" placeholder).
    const type = drawer.locator('.lib-kv dt', { hasText: /^Type$/ }).locator('xpath=following-sibling::dd[1]');
    assert.equal((await type.textContent()).trim(), 'Not downloaded yet');
    await shot(page, 'library-e2e-refused-import');

    await drawer.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog', { name: /Delete "Workshop poster"/ }).getByRole('button', { name: 'Delete file' }).click();
    await toastText(/Deleted 1 file/);
    await tile.waitFor({ state: 'detached' });
  });

  test('photos shared from another app (share target) are uploaded from the service worker mailbox', async () => {
    // The app registers the service worker on start; it must control the page to receive the share.
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 });
    const before = (await readDoc('library')).assets.length;
    const res = await page.evaluate(async () => {
      const jpeg = await (await fetch('/postpilot/dev/fixtures/f02.jpg')).blob();
      const form = new FormData();
      form.append('title', 'Glaze notes');
      form.append('text', 'New glaze test from the kiln');
      form.append('url', 'https://studionorth.example/blog/glaze');
      form.append('media', new File([jpeg], 'IMG_2041.jpg', { type: 'image/jpeg' }));
      form.append('media', new File([new Uint8Array([37, 80, 68, 70])], 'notes.pdf', { type: 'application/pdf' }));
      // What Android does when Postpilot is picked in the share sheet (manifest share_target).
      const r = await fetch(new URL('share-target', location.href), { method: 'POST', body: form });
      return { redirected: r.redirected, url: r.url, mailbox: await caches.has('postpilot-share') };
    });
    assert.ok(res.redirected, 'the service worker answered with a redirect');
    assert.match(res.url, /\/postpilot\//);
    assert.ok(res.mailbox, 'the files wait in the share mailbox');

    await page.evaluate(() => (location.hash = '#/library?shared=1'));
    const panel = page.locator('.lib-shared');
    await panel.waitFor({ timeout: 15_000 });
    await panel.getByText('1 file cannot be added: only photos and videos can.').waitFor();
    await panel.locator('.frame img').waitFor();
    // Any website can send a share, so the panel asks the owner to check, and the shared text is only quoted.
    assert.equal((await panel.getByRole('heading').textContent()).trim(), 'Something was shared with Postpilot. Only add it if you shared it yourself.');
    assert.equal(await panel.locator('.lib-shared-quote blockquote').textContent(), 'New glaze test from the kiln\nhttps://studionorth.example/blog/glaze');
    const hint = panel.getByRole('textbox', { name: 'Caption hint' });
    assert.equal(await hint.inputValue(), '', 'the caption hint is not filled from the shared text');
    assert.equal(await panel.getByText(/not kept/).count(), 0, 'nothing was skipped');
    await panel.getByRole('button', { name: 'Use shared text as caption hint' }).click();
    assert.equal(await hint.inputValue(), 'New glaze test from the kiln\nhttps://studionorth.example/blog/glaze');
    await shot(page, 'library-e2e-shared');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await panel.screenshot({ path: '/tmp/claude-0/-home-user-claude/61a6d9a0-a933-5d86-8721-920a439be9c7/scratchpad/shots/library-e2e-shared-390.png' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `no horizontal overflow on a phone (${overflow})`);
    await page.setViewportSize({ width: 1280, height: 860 });

    await panel.getByRole('switch', { name: 'Add to the autopilot pool' }).click();
    await panel.getByRole('button', { name: 'Add to library' }).click();
    await panel.waitFor({ state: 'detached' });
    const done = page.locator('.toast', { hasText: 'Added 1 shared file to your library and the autopilot pool.' });
    await done.waitFor({ timeout: 30_000 });
    const lib = (await readDoc('library')).assets;
    assert.equal(lib.length, before + 1);
    const added = lib[0];
    assert.equal(added.name, 'IMG_2041.jpg');
    assert.equal(added.autopilot, true);
    assert.equal(added.captionHint, 'New glaze test from the kiln\nhttps://studionorth.example/blog/glaze');
    assert.equal(await page.evaluate(() => caches.has('postpilot-share')), false, 'the mailbox is emptied');
    assert.doesNotMatch(await page.evaluate(() => location.hash), /shared=/);

    // The toast offers a post with the new file.
    await done.getByRole('button', { name: 'Create post' }).click();
    await page.locator('.cmp-drawer .cmp-strip .cmp-item').first().waitFor({ timeout: 20_000 });
    await page.keyboard.press('Escape');
    const discard = page.locator('.modal-confirm').getByRole('button', { name: 'Discard' });
    if (await discard.isVisible().catch(() => false)) await discard.click();
    await page.locator('.cmp-drawer').waitFor({ state: 'detached' });
  });

  test('a shared link without photos can start a post', async () => {
    await page.evaluate(async () => {
      const form = new FormData();
      form.append('title', 'Studio blog');
      form.append('text', 'Read how we mix our glazes');
      form.append('url', 'https://studionorth.example/blog/mixing');
      await fetch(new URL('share-target', location.href), { method: 'POST', body: form });
    });
    await page.evaluate(() => (location.hash = '#/library?shared=1'));
    const panel = page.locator('.lib-shared');
    await panel.getByText('Only photos and videos can be added to the library.').waitFor({ timeout: 15_000 });
    assert.equal(await panel.locator('.lib-shared-quote blockquote').textContent(), 'Read how we mix our glazes\nhttps://studionorth.example/blog/mixing');
    await panel.getByRole('button', { name: 'Start a post with this text' }).click();
    await page.locator('#cmp-caption').waitFor({ timeout: 20_000 });
    assert.equal(await page.locator('#cmp-caption').inputValue(), 'Read how we mix our glazes\nhttps://studionorth.example/blog/mixing');
    await page.keyboard.press('Escape');
    const discard = page.locator('.modal-confirm').getByRole('button', { name: 'Discard' });
    await discard.waitFor({ timeout: 3000 }).catch(() => {});
    if (await discard.isVisible().catch(() => false)) await discard.click();
    await page.locator('.cmp-drawer').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => caches.has('postpilot-share')), false);
  });

  test('files past the share mailbox limit are counted and mentioned; Discard adds nothing', async () => {
    const before = (await readDoc('library')).assets.length;
    await page.evaluate(async () => {
      const jpeg = await (await fetch('/postpilot/dev/fixtures/f02.jpg')).blob();
      // Two shares: the second one is added to the first, and the mailbox keeps at most 10 files.
      for (const n of [6, 6]) {
        const form = new FormData();
        for (let i = 0; i < n; i++) form.append('media', new File([jpeg], `IMG_${i}.jpg`, { type: 'image/jpeg' }));
        await fetch(new URL('share-target', location.href), { method: 'POST', body: form });
      }
    });
    await page.evaluate(() => (location.hash = '#/library?shared=1'));
    const panel = page.locator('.lib-shared');
    await panel.getByText('2 more files were not kept: a share holds up to 10 files and 300 MB.').waitFor({ timeout: 15_000 });
    assert.equal(await panel.locator('.lib-shared-files > li').count(), 10);
    assert.equal(await panel.locator('.lib-shared-quote').count(), 0, 'no text was shared');
    await panel.getByRole('button', { name: 'Discard' }).click();
    await panel.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => caches.has('postpilot-share')), false);
    assert.equal((await readDoc('library')).assets.length, before, 'nothing was added');
  });

  test('no console errors', () => {
    assert.deepEqual(consoleErrors, []);
  });
});
