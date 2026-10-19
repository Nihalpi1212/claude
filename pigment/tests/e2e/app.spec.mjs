import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait } from './helpers.mjs';
import { buildMenuTemplate } from '../../src/main/menu.js';

test('starts without errors, shows the welcome screen and creates a document from a preset', async ({ page }) => {
  const errors = await openApp(page);
  await expect(page.locator('#welcome')).toBeVisible();
  await page.locator('[data-preset="1"]').click(); // Square post 1080x1080
  await expect.poll(() => page.evaluate(() => [window.pigmentApp.doc?.width, window.pigmentApp.doc?.height])).toEqual([1080, 1080]);
  await expect(page.locator('#welcome')).toBeHidden();
  await expect(page.locator('.tab')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('every native menu command is registered in the renderer', async ({ page }) => {
  await openApp(page);
  const ids = new Set();
  const walk = (items) => {
    for (const it of items) {
      if (it.submenu) walk(it.submenu);
      if (it.click) it.click();
    }
  };
  walk(buildMenuTemplate({ platform: 'linux', state: { hasDocument: true }, recent: [], run: (c) => ids.add(c), isPackaged: false }));
  const missing = await page.evaluate((list) => list.filter((id) => !window.pigmentApp.commands.has(id)), [...ids]);
  expect(missing).toEqual([]);
});

test('every toolbox tool activates and renders its options', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const ids = await page.evaluate(() => [...window.pigmentApp.tools.tools.keys()].filter((id) => id !== 'transform'));
  expect(ids.length).toBeGreaterThan(40);
  for (const id of ids) {
    await page.evaluate((t) => window.pigmentApp.tools.activate(t), id);
    await expect(page.locator('#options-bar .options-title')).toBeVisible();
  }
  // tool shortcuts: B picks the brush slot's current tool (never cycles), Shift+B cycles inside the slot, M marquee
  await page.evaluate(() => window.pigmentApp.tools.activate('brush'));
  await page.evaluate(() => window.pigmentApp.tools.activate('move'));
  await page.locator('canvas.view').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Escape');
  await page.keyboard.press('b');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('brush');
  await page.keyboard.press('b');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('brush');
  await page.keyboard.press('Shift+B');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).not.toBe('brush');
  await page.keyboard.press('m');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toMatch(/^marquee/);
  expect(errors).toEqual([]);
});

test('panels are registered and switch', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const panels = await page.evaluate(() => [...window.pigmentApp.panels.panels.keys()]);
  for (const id of ['color', 'swatches', 'brushes', 'properties', 'adjustments', 'character', 'paths', 'layers', 'channels', 'history', 'navigator', 'info']) expect(panels).toContain(id);
  for (const id of panels) {
    await runAwait(page, `window:panel-${id}`);
    await expect(page.locator(`[data-panel="${id}"].panel`)).toBeVisible();
  }
  await run(page, 'window:toggle-panels');
  await expect(page.locator('#panels')).toBeHidden();
  await run(page, 'window:toggle-panels');
  await expect(page.locator('#panels')).toBeVisible();
  expect(errors).toEqual([]);
});
