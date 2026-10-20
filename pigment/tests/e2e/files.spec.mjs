import { test, expect } from '@playwright/test';
import { openApp, openFixture, runAwait, run, pixel, confirmDialog } from './helpers.mjs';

test('opens a PNG with its size and transparency', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'shapes.png');
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([200, 150]);
  expect(await pixel(page, 40, 40)).toEqual([255, 0, 0, 255]);
  expect((await pixel(page, 5, 5))[3]).toBe(0);
  const blue = await pixel(page, 140, 90);
  expect(blue[2]).toBeGreaterThan(240);
  expect(Math.abs(blue[3] - 128)).toBeLessThan(3);
  expect(errors).toEqual([]);
});

test('opens a layered PSD keeping layers, opacity, blend mode and visibility', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'layers.psd');
  const layers = await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => ({ name: l.name, opacity: Math.round(l.opacity * 100), blend: l.blend, visible: l.visible, x: l.x, y: l.y })));
  expect(layers.map((l) => l.name)).toEqual(['Background', 'Red box', 'Hidden green']);
  expect(layers[1]).toMatchObject({ opacity: 50, blend: 'multiply', visible: true, x: 10, y: 12 });
  expect(layers[2].visible).toBe(false);
  // multiply at 50%: grey 240 * red -> (240, ~120, ~120)
  const p = await pixel(page, 20, 20);
  expect(p[0]).toBeGreaterThan(230);
  expect(p[1]).toBeGreaterThan(110);
  expect(p[1]).toBeLessThan(130);
  // the hidden layer does not show
  expect(await pixel(page, 70, 50)).toEqual([240, 240, 240, 255]);
  expect(errors).toEqual([]);
});

test('saves a .pigment document and reopens it with layers, masks and styles intact', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'layers.psd');
  await page.evaluate(() => {
    const app = window.pigmentApp;
    const d = app.doc;
    const red = d.layers()[1];
    red.styles = { stroke: { enabled: true, size: 2, position: 'outside', color: '#00ff00', opacity: 1, blend: 'normal' } };
    red.touch();
    d.setActive(red);
    app.commands.run('layer:mask', 'reveal-all', 'api');
    d.guides.push({ axis: 'x', pos: 33 });
    window.__pigmentTest.nextSavePath = 'mem:/saved.pigment';
  });
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/saved.pigment'])).toBe(true);
  const before = await pixel(page, 9, 20);
  await page.evaluate(() => {
    window.__pigmentTest.files['mem:/reopen.pigment'] = window.__pigmentTest.written['mem:/saved.pigment'];
  });
  await runAwait(page, 'file:open-paths', ['mem:/reopen.pigment']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.path)).toBe('mem:/reopen.pigment');
  const info = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return { names: d.layers().map((l) => l.name), mask: !!d.layers()[1].mask, stroke: d.layers()[1].styles?.stroke?.enabled, guides: d.guides.length, dirty: d.history.dirty };
  });
  expect(info).toEqual({ names: ['Background', 'Red box', 'Hidden green'], mask: true, stroke: true, guides: 1, dirty: false });
  expect(await pixel(page, 9, 20)).toEqual(before);
  expect(errors).toEqual([]);
});

test('PSD export round-trips layers', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'layers.psd');
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/out.psd'));
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => window.__pigmentTest.written['mem:/out.psd']?.length ?? 0)).toBeGreaterThan(1000);
  await page.evaluate(() => (window.__pigmentTest.files['mem:/again.psd'] = window.__pigmentTest.written['mem:/out.psd']));
  await runAwait(page, 'file:open-paths', ['mem:/again.psd']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.path)).toBe('mem:/again.psd');
  const layers = await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => [l.name, Math.round(l.opacity * 100), l.blend, l.visible]));
  expect(layers).toEqual([['Background', 100, 'normal', true], ['Red box', 50, 'multiply', true], ['Hidden green', 100, 'normal', false]]);
  expect(errors).toEqual([]);
});

test('Export As writes a JPEG and a resized PNG', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'gradient.png');
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/out.jpg'));
  await run(page, 'file:export');
  await page.locator('.dialog select[data-key="format"]').selectOption('jpeg');
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => Array.from(window.__pigmentTest.written['mem:/out.jpg']?.slice(0, 3) ?? []))).toEqual([0xff, 0xd8, 0xff]);
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/half.png'));
  await run(page, 'file:export');
  await page.locator('.dialog select[data-key="format"]').selectOption('png');
  await page.locator('.dialog select[data-key="scale"]').selectOption('0.5');
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/half.png'])).toBe(true);
  const size = await page.evaluate(async () => {
    const bmp = await createImageBitmap(new Blob([window.__pigmentTest.written['mem:/half.png']]));
    return [bmp.width, bmp.height];
  });
  expect(size).toEqual([160, 100]);
  expect(errors).toEqual([]);
});
