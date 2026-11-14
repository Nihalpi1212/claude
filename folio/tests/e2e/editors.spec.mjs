import { test, expect } from '@playwright/test';
import { openApp, openFixture, run, listAnnotations, pageBox, drag } from './helpers.mjs';

test('freehand drawing with the pdf.js ink editor is saved as an Ink annotation', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf');
  await run(page, 'tool:ink');
  await expect(page.locator('#toolbar-secondary')).toContainText('Draw on the page');
  const box = await pageBox(page, 1);
  const p = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  await drag(page, p(0.2, 0.6), p(0.5, 0.7), { steps: 15 });
  await drag(page, p(0.5, 0.7), p(0.3, 0.85), { steps: 15 });
  // strokes accumulate in the draw layer; leaving the tool commits them into one ink editor
  await expect(page.locator('.canvasWrapper svg.draw path, .canvasWrapper svg.draw').first()).toBeAttached();
  await run(page, 'tool:none');
  await expect(page.locator('.annotationEditorLayer .inkEditor')).toHaveCount(1);
  expect(await page.evaluate(() => window.folioApp.session.dirty)).toBe(true);
  const list = await listAnnotations(page);
  expect(list.map((a) => a.subtype)).toEqual(['Ink']);
  expect(list[0].color?.toLowerCase()).toBe('#e53935');

  // pdf.js undo removes the editor again (edit:undo routes to pdf.js first)
  await run(page, 'tool:ink');
  await drag(page, p(0.6, 0.6), p(0.8, 0.8), { steps: 10 });
  await run(page, 'tool:none');
  await expect(page.locator('.annotationEditorLayer .inkEditor')).toHaveCount(2);
  await run(page, 'edit:undo');
  await expect(page.locator('.annotationEditorLayer .inkEditor')).toHaveCount(1);
});

test('text box editor: type text, saved as FreeText with the chosen colour', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf');
  await run(page, 'tool:text');
  const box = await pageBox(page, 1);
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5);
  const editor = page.locator('.annotationEditorLayer .freeTextEditor');
  await expect(editor).toHaveCount(1);
  await page.keyboard.type('Hello from Folio');
  // commit the editor by leaving the tool
  await run(page, 'tool:none');
  const list = await listAnnotations(page);
  expect(list.map((a) => a.subtype)).toEqual(['FreeText']);
  expect(list[0].contents).toContain('Hello from Folio');
  // pdf.js stores the colour in the DA string with limited precision
  const rgb = list[0].color.match(/[0-9a-f]{2}/gi).map((h) => parseInt(h, 16));
  for (const c of rgb) expect(Math.abs(c - 0x1e)).toBeLessThanOrEqual(2);
  expect(list[0].page).toBe(0);
});

test('save as writes pdf.js editor annotations and reopening shows them', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf');
  await run(page, 'tool:text');
  const box = await pageBox(page, 1);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.4);
  await page.keyboard.type('Persisted');
  await run(page, 'tool:none');
  await page.evaluate(() => {
    window.__folioTest.nextSavePath = '/saved/with-text.pdf';
  });
  await run(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => !!window.__folioTest.written['/saved/with-text.pdf'])).toBe(true);
  await expect(page.locator('.tab[aria-selected="true"] .tab-title')).toHaveText('with-text.pdf');
  await expect(page.locator('.tab-dirty')).toHaveCount(0);
  await run(page, 'file:close');
  // reopen the saved bytes (the browser bridge keeps written files)
  await page.evaluate(async () => {
    window.__folioTest.files['/saved/with-text.pdf'] = window.__folioTest.written['/saved/with-text.pdf'];
    await window.folioApp.tabs.open({ path: '/saved/with-text.pdf' });
  });
  await page.waitForSelector('.doc-host:not([hidden]) .page[data-loaded="true"] canvas');
  await expect(page.locator('.annotationLayer .freeTextAnnotation, .annotationLayer section[data-annotation-id]').first()).toBeAttached();
  const list = await listAnnotations(page);
  expect(list.map((a) => a.subtype)).toEqual(['FreeText']);
  expect(list[0].contents).toContain('Persisted');
});
