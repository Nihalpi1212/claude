import { test, expect } from '@playwright/test';
import { openApp, openFixture, run, selectText, withReload, listAnnotations, pageBox, drag } from './helpers.mjs';

test('underline, strikeout and squiggly from a text selection, with undo', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf');
  await selectText(page, 1, 'ZEBRA-1');
  await withReload(page, () => run(page, 'tool:underline'));
  let list = await listAnnotations(page);
  expect(list.map((a) => a.subtype)).toEqual(['Underline']);
  expect(list[0].page).toBe(0);
  expect(list[0].rect[0]).toBeGreaterThan(60);
  await expect(page.locator('.tab-dirty')).toHaveCount(1);

  // the tool stays active: a new selection is marked up on mouse up
  await selectText(page, 1, 'quick brown');
  await withReload(page, () => page.mouse.click(5, 300)); // mouseup anywhere applies the pending selection
  list = await listAnnotations(page);
  expect(list.map((a) => a.subtype).sort()).toEqual(['Underline', 'Underline']);

  await run(page, 'tool:none');
  await selectText(page, 2, 'bravo');
  await withReload(page, () => run(page, 'annot:markup-selection', 'strikeout'));
  await selectText(page, 2, 'lazy dog');
  await withReload(page, () => run(page, 'annot:markup-selection', 'squiggly'));
  list = await listAnnotations(page);
  expect(list.map((a) => a.subtype).sort()).toEqual(['Squiggly', 'StrikeOut', 'Underline', 'Underline']);
  expect(list.find((a) => a.subtype === 'Squiggly').page).toBe(1);

  await withReload(page, () => run(page, 'edit:undo'));
  list = await listAnnotations(page);
  expect(list.map((a) => a.subtype).sort()).toEqual(['StrikeOut', 'Underline', 'Underline']);
  await withReload(page, () => run(page, 'edit:redo'));
  expect((await listAnnotations(page)).length).toBe(4);
});

test('sticky note placement through the prompt, then edit and erase', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf');
  await run(page, 'tool:note');
  await expect(page.locator('#toolbar-secondary')).toBeVisible();
  const box = await pageBox(page, 1);
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.2);
  const dialog = page.locator('.dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('textarea').fill('Remember to review this');
  await withReload(page, () => dialog.locator('button.primary').click());
  let list = await listAnnotations(page);
  expect(list.length).toBe(1);
  expect(list[0].subtype).toBe('Text');
  expect(list[0].contents).toBe('Remember to review this');
  expect(list[0].author).toBeTruthy();
  expect(await page.evaluate(() => window.folioApp.tool)).toBe('none');

  // the note is rendered by pdf.js with a popup
  await expect(page.locator('.annotationLayer .textAnnotation')).toHaveCount(1);
  await expect(page.locator('.annotationLayer .popupAnnotation')).toHaveCount(1);

  // edit through the engine
  await withReload(page, () => page.evaluate(async (id) => {
    const engine = await import('/shared/engine.js');
    await window.folioApp.edit.apply((bytes) => engine.updateAnnotation(bytes, id, { contents: 'Edited' }), { label: 'Edit' });
  }, list[0].id));
  list = await listAnnotations(page);
  expect(list[0].contents).toBe('Edited');

  // eraser: click on the note icon
  await run(page, 'tool:eraser');
  const noteBox = await page.locator('.annotationLayer .textAnnotation').boundingBox();
  await withReload(page, () => page.mouse.click(noteBox.x + noteBox.width / 2, noteBox.y + noteBox.height / 2));
  expect(await listAnnotations(page)).toEqual([]);
});

test('shapes are drawn by dragging and saved as Square, Circle and Line annotations', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf');
  const box = await pageBox(page, 1);
  const p = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  await run(page, 'tool:rect');
  await withReload(page, () => drag(page, p(0.1, 0.55), p(0.4, 0.7)));
  await run(page, 'tool:ellipse');
  await withReload(page, () => drag(page, p(0.5, 0.55), p(0.7, 0.7)));
  await run(page, 'tool:arrow');
  await withReload(page, () => drag(page, p(0.1, 0.8), p(0.5, 0.9)));
  const list = await listAnnotations(page);
  expect(list.map((a) => a.subtype)).toEqual(['Square', 'Circle', 'Line']);
  const square = list[0];
  expect(square.rect[1]).toBeGreaterThanOrEqual(0);
  expect(square.rect[3]).toBeLessThanOrEqual(792);
  expect(square.rect[2] - square.rect[0]).toBeGreaterThan(150);
  expect(square.rect[3] - square.rect[1]).toBeGreaterThan(40);
  expect(await page.evaluate(() => window.folioApp.tool)).toBe('none');
  await expect(page.locator('.annotationLayer .squareAnnotation, .annotationLayer section[data-annotation-id]').first()).toBeAttached();
});

test('pdf.js highlight editor from a selection is saved as a Highlight annotation', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf');
  await selectText(page, 1, 'ZEBRA-1');
  await run(page, 'tool:highlight');
  await expect(page.locator('.annotationEditorLayer .highlightEditor')).toHaveCount(1);
  expect(await page.evaluate(() => window.folioApp.session.dirty)).toBe(true);
  const list = await listAnnotations(page);
  expect(list.map((a) => a.subtype)).toEqual(['Highlight']);
  expect(list[0].color?.toLowerCase()).toBe('#ffff98'); // the default highlight colour from settings
  await run(page, 'tool:none');
  expect(await page.evaluate(() => window.folioApp.view.editorMode)).toBe(0);
});

test('text stamp placement', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf');
  await run(page, 'tool:stamp', 'APPROVED');
  const box = await pageBox(page, 1);
  await withReload(page, () => page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.3));
  const list = await listAnnotations(page);
  expect(list.map((a) => a.subtype)).toEqual(['Stamp']);
  expect(list[0].contents).toBe('APPROVED');
});
