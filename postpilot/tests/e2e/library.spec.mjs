// E2E: Library folders, delete confirmation and paging of a large contact sheet.
// Run: node --test tests/e2e/library.spec.mjs
//
// The dev server runs in this process so the test can read and change the seeded documents. It binds an
// ephemeral port by default so it can run next to the other e2e specs; set LIBRARY_E2E_PORT to pin one.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startDevServer } from '../../dev/server.mjs';
import { loadPlaywright, shot, unlock } from './helpers.mjs';

const PORT = Number(process.env.LIBRARY_E2E_PORT || 0);

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

  test('no console errors', () => {
    assert.deepEqual(consoleErrors, []);
  });
});
