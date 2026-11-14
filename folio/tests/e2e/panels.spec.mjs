import { test, expect } from '@playwright/test';
import { openApp, openFixture, run, selectText, withReload, listAnnotations } from './helpers.mjs';

test('thumbnails, bookmarks, attachments and layers panels', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'text.pdf');
  await run(page, 'view:sidebar', 'thumbnails');
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(page.locator('.thumb')).toHaveCount(5);
  await expect(page.locator('.thumb.current')).toHaveAttribute('aria-label', 'Page 1');
  await expect(page.locator('.thumb').nth(1).locator('canvas')).toBeAttached();
  await page.locator('.thumb').nth(3).click();
  await expect(page.locator('#tb-page-input')).toHaveValue('4');
  await expect(page.locator('.thumb.current')).toHaveAttribute('aria-label', 'Page 4');

  await run(page, 'view:sidebar', 'outline');
  await expect(page.locator('.outline-label')).toHaveCount(5);
  await expect(page.locator('.outline-label').first()).toHaveText('Section 1: alpha');
  await page.locator('.outline-label').nth(2).click();
  await expect(page.locator('#tb-page-input')).toHaveValue('3');

  await run(page, 'view:sidebar', 'attachments');
  await expect(page.locator('#panel-attachments')).toContainText('no attachments');
  await run(page, 'view:sidebar', 'layers');
  await expect(page.locator('#panel-layers')).toContainText('no layers');
});

test('comments panel lists, navigates, replies to and deletes annotations', async ({ page }) => {
  await openApp(page);
  await openFixture(page, 'annotated.pdf');
  await run(page, 'view:sidebar', 'comments');
  await expect(page.locator('.comment')).toHaveCount(3);
  await expect(page.locator('.comment-author').first()).toHaveText('Fixture Author');
  await expect(page.locator('#panel-comments')).toContainText('Existing sticky note');

  // add one on page 1 and see it listed after the reload
  await selectText(page, 1, 'square annotation');
  await withReload(page, () => run(page, 'annot:markup-selection', 'underline'));
  await expect(page.locator('.comment')).toHaveCount(4);

  // reply through the dialog
  const first = page.locator('.comment').first();
  await first.hover();
  await first.locator('> .comment-actions button[title="Reply"]').click();
  const dialog = page.locator('.dialog');
  await dialog.locator('textarea').fill('Agreed');
  await withReload(page, () => dialog.locator('button.primary').click());
  await expect(page.locator('.comment-replies .comment')).toHaveCount(1);
  await expect(page.locator('.comment-replies .comment-body')).toHaveText('Agreed');
  const list = await listAnnotations(page);
  expect(list.filter((a) => a.inReplyTo).length).toBe(1);

  // delete the parent removes the reply too
  await first.hover();
  await first.locator('> .comment-actions button[title="Delete"]').click();
  await withReload(page, () => page.locator('.dialog button.danger').click());
  await expect(page.locator('.comment')).toHaveCount(3);
  expect((await listAnnotations(page)).length).toBe(3);
});
