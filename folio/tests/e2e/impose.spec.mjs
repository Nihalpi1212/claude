import { test, expect } from '@playwright/test';
import { openApp, openFixture, run, withReload, pageInfo } from './helpers.mjs';

const dialog = (page) => page.locator('.impose-dialog');
const pageTexts = (page) =>
  page.evaluate(async () => {
    const v = window.folioApp.view;
    const out = [];
    for (let i = 0; i < v.numPages; i++) out.push(await v.getPageText(i));
    return out;
  });

test('booklet opens as a new tab; page numbers apply in place and undo', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf', { expectPages: 5 });

  // booklet: 5 pages -> 8 with blanks -> 4 two-up sheets, in a new tab
  await run(page, 'impose:booklet');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('[data-f="sheet"]')).toHaveValue('auto');
  await dialog(page).locator('button.primary').click();
  await expect(page.locator('.tab')).toHaveCount(2);
  await expect(page.locator('.tab[aria-selected="true"] .tab-title')).toHaveText('text-booklet.pdf');
  await expect(page.locator('#tb-page-count')).toHaveText('of 4');
  let info = await pageInfo(page);
  expect(info.pages[0].width).toBeCloseTo(1224, 0);
  expect(info.pages[0].height).toBeCloseTo(792, 0);
  expect(await page.evaluate(() => window.folioApp.session.dirty)).toBe(true);
  // sheet 1 front carries pages 8 (blank) and 1, sheet 4 back carries 4 and 5
  const texts = await pageTexts(page);
  expect(texts[0]).toContain('Page 1 of 5');
  expect(texts[3]).toContain('Page 4 of 5');
  expect(texts[3]).toContain('Page 5 of 5');

  // page numbers on the booklet sheets, in place (default), then undo
  await run(page, 'impose:page-numbers');
  await expect(dialog(page)).toBeVisible();
  await dialog(page).locator('[data-f="text"]').fill('Sheet {page} of {pages}');
  await withReload(page, () => dialog(page).locator('button.primary').click());
  const numbered = await pageTexts(page);
  expect(numbered[0]).toContain('Sheet 1 of 4');
  expect(numbered[3]).toContain('Sheet 4 of 4');
  await withReload(page, () => run(page, 'edit:undo'));
  expect((await pageTexts(page))[0]).not.toContain('Sheet 1 of 4');
});

test('page info table, sheet sizes and the sample document', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'mixed.pdf', { expectPages: 4 });
  await run(page, 'impose:page-info');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.impose-table tbody tr')).toHaveCount(4);
  await expect(dialog(page).locator('.impose-table tbody tr').nth(1)).toContainText('landscape');
  await expect(dialog(page).locator('.impose-table tbody tr').nth(3)).toContainText('90°');
  await dialog(page).locator('button.primary').click();
  await expect(dialog(page)).toHaveCount(0);

  // a custom sheet size shows up in the imposition dialogs
  await run(page, 'impose:sheet-sizes');
  await expect(dialog(page)).toBeVisible();
  await dialog(page).locator('[data-name]').fill('Poster');
  await dialog(page).locator('[data-w]').fill('500');
  await dialog(page).locator('[data-h]').fill('700');
  await dialog(page).locator('[data-add]').click();
  await expect(dialog(page).locator('.impose-list-row')).toHaveCount(1);
  await dialog(page).locator('button.primary').click();
  await expect.poll(() => page.evaluate(() => window.folioApp.settings.customSheetSizes.length)).toBe(1);
  await run(page, 'impose:nup');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('[data-f="sheet"] option', { hasText: 'Poster' })).toHaveCount(1);
  const posterValue = await dialog(page).locator('[data-f="sheet"] option', { hasText: 'Poster' }).getAttribute('value');
  await dialog(page).locator('[data-f="sheet"]').selectOption(posterValue);
  await dialog(page).locator('[data-f="sheet-orient"]').selectOption('portrait'); // n-up defaults to landscape
  await dialog(page).locator('[data-f="rows"]').fill('2');
  await dialog(page).locator('[data-f="cols"]').fill('2');
  await dialog(page).locator('button.primary').click();
  await expect(page.locator('.tab')).toHaveCount(2);
  await expect(page.locator('#tb-page-count')).toHaveText('of 1');
  const info = await pageInfo(page);
  // 500 x 700 mm, portrait
  expect(info.pages[0].width).toBeCloseTo((500 / 25.4) * 72, 0);
  expect(info.pages[0].height).toBeCloseTo((700 / 25.4) * 72, 0);

  // sample document
  await run(page, 'impose:sample');
  await expect(dialog(page)).toBeVisible();
  await dialog(page).locator('[data-f="pages"]').fill('6');
  await dialog(page).locator('button.primary').click();
  await expect(page.locator('.tab')).toHaveCount(3);
  await expect(page.locator('#tb-page-count')).toHaveText('of 6');
  expect((await pageTexts(page))[5]).toContain('Page 6 of 6');
});

test('manual imposition with auto-arrange, and recorded sequences replay', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf', { expectPages: 5 });

  await run(page, 'impose:manual');
  await expect(dialog(page)).toBeVisible();
  await dialog(page).locator('[data-act="add-all"]').click();
  await expect(dialog(page).locator('[data-rows] tr')).toHaveCount(5);
  await expect(dialog(page).locator('[data-preview] .cell')).toHaveCount(5);
  await dialog(page).locator('[data-act="add-sheet"]').click();
  await dialog(page).locator('[data-act="add-page"]').click();
  await dialog(page).locator('[data-act="arrange"]').click(); // scale the Letter page onto the landscape A4 sheet
  await expect(dialog(page).locator('[data-sheet-select] option')).toHaveCount(2);
  await expect(dialog(page).locator('[data-rows] tr')).toHaveCount(1);
  await dialog(page).locator('button.primary').click();
  await expect(page.locator('.tab')).toHaveCount(2);
  await expect(page.locator('#tb-page-count')).toHaveText('of 2');
  const texts = await pageTexts(page);
  for (let i = 1; i <= 5; i++) expect(texts[0]).toContain(`Page ${i} of 5`);
  expect(texts[1]).toContain('Page 1 of 5');
  await run(page, 'file:close');
  await expect(page.locator('.dialog')).toBeVisible(); // "Save changes?" for the unsaved imposition
  await page.locator('.dialog button', { hasText: /Don.t Save|Discard/i }).click();
  await expect(page.locator('.tab')).toHaveCount(1);

  // record: reverse + fill to a multiple of 4, then replay on the sample document
  await run(page, 'impose:record');
  await expect(page.locator('.dialog')).toBeVisible();
  await page.locator('.dialog input').fill('Prep');
  await page.locator('.dialog button.primary').click();
  await expect(page.locator('#statusbar')).toContainText('Recording “Prep”');
  await withReload(page, () => run(page, 'impose:reverse'));
  expect((await pageTexts(page))[0]).toContain('Page 5 of 5');
  await run(page, 'impose:fill-multiple');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('[data-record-only]')).toBeVisible();
  await withReload(page, () => dialog(page).locator('button.primary').click());
  await expect(page.locator('#tb-page-count')).toHaveText('of 8');
  await expect(page.locator('#statusbar')).toContainText('2 steps');
  await run(page, 'impose:record'); // stop
  await expect.poll(() => page.evaluate(() => (window.folioApp.settings.imposeSequences ?? []).map((s) => [s.name, s.steps.map((st) => st.op)]))).toEqual([['Prep', ['reverse', 'fill-multiple']]]);
  await expect(page.locator('#statusbar')).not.toContainText('Recording');

  // undo both steps, then run the sequence in one go
  await withReload(page, () => run(page, 'edit:undo'));
  await withReload(page, () => run(page, 'edit:undo'));
  await expect(page.locator('#tb-page-count')).toHaveText('of 5');
  await withReload(page, () => run(page, 'impose:run-sequence', { name: 'Prep' }));
  await expect(page.locator('#tb-page-count')).toHaveText('of 8');
  expect((await pageTexts(page))[0]).toContain('Page 5 of 5');

  // the sequences dialog lists it and can run it again
  await run(page, 'impose:sequences');
  await expect(dialog(page).locator('.impose-list-row')).toHaveCount(1);
  await expect(dialog(page).locator('.impose-list-row')).toContainText('2 steps');
  await withReload(page, () => dialog(page).locator('[data-run]').click());
  await expect(page.locator('#tb-page-count')).toHaveText('of 8');
  const again = await pageTexts(page); // [5,4,3,2,1,b,b,b] reversed -> three blanks, then 1..5; already a multiple of 4
  expect(again[0]).toBe('');
  expect(again[3]).toContain('Page 1 of 5');
  expect(again[7]).toContain('Page 5 of 5');
});

test('trim and shift, split and masking tape change the pages in place with unit conversion', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf', { expectPages: 5 });
  await run(page, 'impose:trim-shift');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('[data-f="top"]').locator('..')).toContainText('(mm)');
  await dialog(page).locator('[data-f="top"]').fill('25.4'); // one inch = 72 pt
  await dialog(page).locator('[data-f="left"]').fill('12.7');
  await withReload(page, () => dialog(page).locator('button.primary').click());
  let info = await pageInfo(page);
  expect(info.pages[0].width).toBeCloseTo(612 - 36, 0);
  expect(info.pages[0].height).toBeCloseTo(792 - 72, 0);
  expect(info.pages[4].width).toBeCloseTo(612 - 36, 0);

  await run(page, 'impose:split');
  await dialog(page).locator('[data-f="mode"]').selectOption('quad');
  await dialog(page).locator('input[type="radio"][value="current"]').check();
  await withReload(page, () => dialog(page).locator('button.primary').click());
  info = await pageInfo(page);
  expect(info.count).toBe(8);
  expect(info.pages[0].width).toBeCloseTo((612 - 36) / 2, 0);

  await run(page, 'impose:tape');
  await dialog(page).locator('[data-f="depth"]').fill('50');
  await withReload(page, () => dialog(page).locator('button.primary').click());
  expect((await pageInfo(page)).count).toBe(8);

  // invalid page ranges keep the dialog open
  await run(page, 'impose:mirror');
  await dialog(page).locator('input[type="radio"][value="range"]').check();
  await dialog(page).locator('[data-f="pageIndices-range"]').fill('99');
  await dialog(page).locator('button.primary').click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator('.toast.error')).toBeVisible();
  await dialog(page).locator('[data-f="pageIndices-range"]').fill('1-2');
  await withReload(page, () => dialog(page).locator('button.primary').click());
  expect((await pageInfo(page)).count).toBe(8);
});

test('every Impose dialog opens and applies its defaults without errors', async ({ page }) => {
  const errors = await openApp(page);
  const first = await openFixture(page, 'text.pdf', { expectPages: 5 });
  const commands = [
    'impose:booklet', 'impose:nup', 'impose:step-repeat', 'impose:shuffle', 'impose:insert-blank', 'impose:fill-multiple', 'impose:duplicate',
    'impose:trim-shift', 'impose:adjust-size', 'impose:mirror', 'impose:rotate-content', 'impose:split', 'impose:tile', 'impose:page-boxes',
    'impose:page-numbers', 'impose:bates', 'impose:stick-text', 'impose:tape', 'impose:marks',
  ];
  for (const cmd of commands) {
    await page.evaluate((id) => {
      const app = window.folioApp;
      app.tabs.activate(app.tabs.list().find((s) => s.id === id));
      window.__imposeDone = new Promise((resolve) => {
        const offA = app.on('doc:reloaded', () => (offA(), offB(), resolve('reloaded')));
        const offB = app.on('doc:loaded', () => (offA(), offB(), resolve('new-tab')));
      });
    }, first.id);
    await run(page, cmd);
    await expect(dialog(page), cmd).toBeVisible();
    if (cmd === 'impose:stick-text') await dialog(page).locator('[data-f="text"]').fill('{file} {date}');
    if (cmd === 'impose:tape') await dialog(page).locator('[data-f="mode"]').selectOption('rect'); // 0x0 rect must be rejected...
    await dialog(page).locator('button.primary').click();
    if (cmd === 'impose:tape') {
      await expect(page.locator('.toast.error'), cmd).toBeVisible(); // ...and keep the dialog open
      await expect(dialog(page)).toBeVisible();
      await dialog(page).locator('[data-f="mode"]').selectOption('edge');
      await dialog(page).locator('button.primary').click();
    }
    const outcome = await page.evaluate(() => window.__imposeDone);
    await expect(dialog(page), cmd).toHaveCount(0);
    if (outcome === 'reloaded') {
      const count = await page.evaluate(() => window.folioApp.session.view.numPages);
      expect(count, cmd).toBeGreaterThan(0);
      await withReload(page, () => run(page, 'edit:undo'));
      expect(await page.evaluate(() => window.folioApp.session.view.numPages), cmd).toBe(5);
    } else {
      expect(await page.evaluate(() => window.folioApp.session.view.numPages), cmd).toBeGreaterThan(0);
    }
  }
  expect(errors, errors.join('\n')).toEqual([]);
  const info = await pageInfo(page);
  expect(info.count).toBeGreaterThan(0);
});
