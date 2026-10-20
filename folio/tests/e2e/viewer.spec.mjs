import { test, expect } from '@playwright/test';
import { openApp, openFixture, run, selectText } from './helpers.mjs';

test('opens a document, navigates, zooms, rotates and searches', async ({ page }) => {
  const errors = await openApp(page);
  await expect(page.locator('#welcome')).toBeVisible();
  await openFixture(page, 'text.pdf', { expectPages: 5 });
  await expect(page.locator('#welcome')).toBeHidden();
  await expect(page.locator('#tb-page-count')).toHaveText('of 5');
  await expect(page.locator('.tab')).toHaveCount(1);

  await run(page, 'view:next-page');
  await expect(page.locator('#tb-page-input')).toHaveValue('2');
  await run(page, 'view:last-page');
  await expect(page.locator('#tb-page-input')).toHaveValue('5');
  await run(page, 'view:go-to-page', 3);
  await expect(page.locator('#tb-page-input')).toHaveValue('3');

  const before = await page.evaluate(() => window.folioApp.view.scale);
  await run(page, 'view:zoom-in');
  expect(await page.evaluate(() => window.folioApp.view.scale)).toBeGreaterThan(before);
  await run(page, 'view:fit-width');
  expect(await page.evaluate(() => window.folioApp.view.zoom)).toBe('page-width');
  await run(page, 'view:rotate-cw');
  expect(await page.evaluate(() => window.folioApp.view.rotation)).toBe(90);
  await run(page, 'view:rotate-ccw');

  await run(page, 'edit:find');
  await expect(page.locator('#findbar')).toBeVisible();
  await page.fill('#find-input', 'charlie');
  await expect(page.locator('#find-status')).toContainText('of 5 matches');
  await expect(page.locator('#tb-page-input')).toHaveValue('3');
  await page.keyboard.press('Escape');
  await expect(page.locator('#findbar')).toBeHidden();

  // keyboard shortcuts reach the command registry
  await page.locator('.viewerContainer').focus();
  await page.keyboard.press('Home');
  await expect(page.locator('#tb-page-input')).toHaveValue('1');
  await page.keyboard.press('End');
  await expect(page.locator('#tb-page-input')).toHaveValue('5');
  expect(errors).toEqual([]);
});

test('multiple tabs, sidebar, layouts and night mode', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf');
  await openFixture(page, 'form.pdf');
  await expect(page.locator('.tab')).toHaveCount(2);
  await expect(page.locator('.tab[aria-selected="true"] .tab-title')).toHaveText('form.pdf');
  await run(page, 'view:prev-tab');
  await expect(page.locator('.tab[aria-selected="true"] .tab-title')).toHaveText('text.pdf');
  await run(page, 'view:scroll-wrapped');
  expect(await page.evaluate(() => window.folioApp.view.scrollMode)).toBe(2);
  await run(page, 'view:spread-odd');
  expect(await page.evaluate(() => window.folioApp.view.spreadMode)).toBe(1);
  await run(page, 'view:night-mode');
  await expect(page.locator('.viewerContainer.night')).toHaveCount(1);
  await run(page, 'view:toggle-sidebar');
  await expect(page.locator('#sidebar')).toBeVisible();
  await run(page, 'file:close');
  await expect(page.locator('.tab')).toHaveCount(1);
  await run(page, 'file:close');
  await expect(page.locator('#welcome')).toBeVisible();
});

test('text selection exposes PDF-space quads', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf');
  await selectText(page, 1, 'ZEBRA-1');
  const selection = await page.evaluate(() => window.folioApp.view.getSelection());
  expect(selection).not.toBeNull();
  expect(selection[0].pageIndex).toBe(0);
  expect(selection[0].text).toContain('ZEBRA-1');
  const [x1, y1, x2, y2] = selection[0].rects[0];
  // the marker is drawn at x=72, y=380 (baseline) with size 11
  expect(x1).toBeGreaterThan(60);
  expect(x1).toBeLessThan(80);
  expect(y1).toBeGreaterThan(370);
  expect(y2).toBeLessThan(400);
  expect(x2).toBeGreaterThan(x1 + 50);
});

test('password-protected documents prompt for the password and report wrong ones', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    window.folioApp.tabs.open({ path: '/fixtures/secret.pdf' });
  });
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('is protected');
  await dialog.locator('input[type="password"]').fill('nope');
  await dialog.locator('button.primary').click();
  await expect(page.locator('.dialog')).toContainText('incorrect');
  await page.locator('.dialog input[type="password"]').fill('secret');
  await page.locator('.dialog button.primary').click();
  await page.waitForSelector('.doc-host:not([hidden]) .page[data-loaded="true"] canvas');
  await expect(page.locator('.textLayer')).toContainText('Secret page');
  await expect(page.locator('.tab')).toHaveCount(1);
});
