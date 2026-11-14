import { test, expect } from '@playwright/test';
import { openApp, openFixture, run, withReload, listAnnotations, pageInfo, pageBox, drag } from './helpers.mjs';

test('page tools: rotate, delete, organize (reorder + rotate), insert and extract', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf', { expectPages: 5 });
  await withReload(page, () => run(page, 'pages:rotate', { indices: [0], delta: 90 }));
  let info = await pageInfo(page);
  expect(info.pages[0].rotation).toBe(90);

  // delete page 2 through the confirmation dialog
  await run(page, 'pages:delete', { indices: [1] });
  await withReload(page, () => page.locator('.dialog button.danger').click());
  info = await pageInfo(page);
  expect(info.count).toBe(4);
  await expect(page.locator('#tb-page-count')).toHaveText('of 4');

  // organize dialog: reverse order and apply
  await run(page, 'pages:organize');
  const dialog = page.locator('.organize-dialog');
  await expect(dialog.locator('.organize-card')).toHaveCount(4);
  await dialog.locator('[data-act="reverse"]').click();
  await withReload(page, () => dialog.locator('button.primary').click());
  const texts = await page.evaluate(async () => {
    const v = window.folioApp.view;
    const out = [];
    for (let i = 0; i < v.numPages; i++) out.push(await v.getPageText(i));
    return out.map((t) => /Page (\d+) of/.exec(t)?.[1]);
  });
  expect(texts).toEqual(['5', '4', '3', '1']);
  info = await pageInfo(page);
  expect(info.pages[3].rotation).toBe(90);

  // insert the mixed fixture at the end (the test bridge answers the file dialog)
  await page.evaluate(() => {
    window.__folioTest.nextOpenFiles = ['/fixtures/mixed.pdf'];
  });
  await withReload(page, () => run(page, 'pages:insert', { at: 4 }));
  expect((await pageInfo(page)).count).toBe(8);

  // extract pages 1-2 to a "file" in the test bridge
  await page.evaluate(() => {
    window.__folioTest.nextSavePath = '/out/extract.pdf';
  });
  await run(page, 'pages:extract', { indices: [0, 1] });
  await expect.poll(() => page.evaluate(() => !!window.__folioTest.written['/out/extract.pdf'])).toBe(true);
  const extracted = await page.evaluate(async () => {
    const engine = await import('/shared/engine.js');
    return engine.getPageInfo(window.__folioTest.written['/out/extract.pdf']);
  });
  expect(extracted.count).toBe(2);
  await run(page, 'edit:undo');
  await expect.poll(() => pageInfo(page).then((i) => i.count)).toBe(4);
});

test('forms: fill, export data, reset and flatten', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'form.pdf');
  await expect(page.locator('#statusbar')).toContainText('Form: 6 fields');
  const nameInput = page.locator('.annotationLayer input[type="text"]').first();
  await nameInput.fill('Grace Hopper');
  await nameInput.blur();
  await page.locator('.annotationLayer input[type="checkbox"]').first().check();
  expect(await page.evaluate(() => window.folioApp.session.dirty)).toBe(true);

  await page.evaluate(() => {
    window.__folioTest.nextSavePath = '/out/form.json';
  });
  await run(page, 'form:export');
  await expect.poll(() => page.evaluate(() => !!window.__folioTest.written['/out/form.json'])).toBe(true);
  const json = await page.evaluate(() => JSON.parse(new TextDecoder().decode(window.__folioTest.written['/out/form.json'])));
  expect(json.fields.name).toBe('Grace Hopper');
  expect(json.fields.agree).toBe(true);

  // save keeps the values in the file
  await page.evaluate(() => {
    window.__folioTest.nextSavePath = '/out/filled.pdf';
  });
  await run(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => !!window.__folioTest.written['/out/filled.pdf'])).toBe(true);
  const saved = await page.evaluate(async () => {
    const engine = await import('/shared/engine.js');
    return engine.getFormData(window.__folioTest.written['/out/filled.pdf']);
  });
  expect(saved.find((f) => f.name === 'name').value).toBe('Grace Hopper');
  await expect(page.locator('.tab-dirty')).toHaveCount(0);

  // reset clears everything
  await run(page, 'form:reset');
  await withReload(page, () => page.locator('.dialog button.danger').click());
  const afterReset = await page.evaluate(async () => {
    const engine = await import('/shared/engine.js');
    return engine.getFormData(await window.folioApp.session.flush());
  });
  expect(afterReset.find((f) => f.name === 'name').value).toBe('');

  // flatten removes the fields
  await run(page, 'file:flatten');
  await withReload(page, () => page.locator('.dialog button.primary').click());
  await expect(page.locator('.annotationLayer input')).toHaveCount(0);
});

test('signature: draw and place as a stamp editor, saved into the PDF', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf');
  await run(page, 'tool:sign');
  const pad = page.locator('.sign-pad');
  await expect(pad).toBeVisible();
  const box = await pad.boundingBox();
  await drag(page, { x: box.x + 40, y: box.y + 100 }, { x: box.x + 300, y: box.y + 60 }, { steps: 20 });
  await drag(page, { x: box.x + 300, y: box.y + 60 }, { x: box.x + 500, y: box.y + 120 }, { steps: 20 });
  await page.locator('.dialog button.primary').click();
  await expect(page.locator('.annotationEditorLayer .stampEditor')).toHaveCount(1);
  expect(await page.evaluate(() => window.folioApp.tool)).toBe('sign');
  expect(await page.evaluate(() => (window.folioApp.settings.signatures ?? []).length)).toBe(1);
  await run(page, 'tool:none');
  // saving writes a Stamp annotation with the image
  const list = await listAnnotations(page);
  expect(list.map((a) => a.subtype)).toEqual(['Stamp']);
  // the saved signature can be reused from the menu
  await page.evaluate(() => window.folioApp.commands.run('sign:use-saved', window.folioApp.settings.signatures[0].id, 'api'));
  await expect(page.locator('.annotationEditorLayer .stampEditor')).toHaveCount(2);
});

test('export text and page images, properties dialog, preferences', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf');
  await page.evaluate(() => {
    window.__folioTest.nextSavePath = '/out/text.txt';
  });
  await run(page, 'file:export-text');
  await expect.poll(() => page.evaluate(() => !!window.__folioTest.written['/out/text.txt'])).toBe(true);
  const text = await page.evaluate(() => new TextDecoder().decode(window.__folioTest.written['/out/text.txt']));
  expect(text).toContain('ZEBRA-1');
  expect(text).toContain('ZEBRA-5');

  await page.evaluate(() => {
    window.__folioTest.nextSavePath = '/out/page1.png';
  });
  await run(page, 'file:export-images');
  await page.locator('.dialog button.primary').click();
  await expect.poll(() => page.evaluate(() => window.__folioTest.written['/out/page1.png']?.byteLength ?? 0)).toBeGreaterThan(1000);

  await run(page, 'file:properties');
  const props = page.locator('.dialog');
  await expect(props.locator('[data-k="title"]')).toHaveValue('Folio sample document');
  await props.locator('.dialog-tab[data-tab="details"]').click();
  await expect(props.locator('[data-v="pages"]')).toHaveText('5');
  await props.locator('.dialog-tab[data-tab="desc"]').click();
  await props.locator('[data-k="title"]').fill('Renamed document');
  await withReload(page, () => props.locator('button.primary').click());
  const meta = await page.evaluate(async () => {
    const engine = await import('/shared/engine.js');
    return engine.getMetadata(await window.folioApp.session.flush());
  });
  expect(meta.title).toBe('Renamed document');

  await run(page, 'edit:preferences');
  const prefs = page.locator('.dialog');
  await prefs.locator('[data-k="authorName"]').fill('Test Person');
  await prefs.locator('[data-k="theme"]').selectOption('dark');
  await prefs.locator('button.primary').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => window.folioApp.settings.authorName)).toBe('Test Person');

  // measure tool reports a distance
  await run(page, 'tool:measure');
  const box = await pageBox(page, 1);
  await page.mouse.click(box.x + 100, box.y + 100);
  await page.mouse.click(box.x + 200, box.y + 100);
  await expect(page.locator('#statusbar')).toContainText('Distance:');
  await run(page, 'tool:none');
});

test('print prepares the print container and calls the host', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf');
  await run(page, 'file:print');
  const dialog = page.locator('.dialog');
  await dialog.locator('input[value="custom"]').check();
  await dialog.locator('[data-pages]').fill('1-2');
  await dialog.locator('button.primary').click();
  await expect(page.locator('#print-container .print-page')).toHaveCount(2);
  await expect(page.locator('#print-container img').first()).toHaveAttribute('src', /^data:image\/jpeg/);
});
