// Composer e2e: create, schedule, edit, publish now (worker against the mock), carousel, upload + crop,
// reel options, AI assist, validation, unsaved-changes guard, phone layout and screenshots.
//   node --test tests/e2e/composer.spec.mjs
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openApp, unlock } from './helpers.mjs';

const PORT = Number(process.env.COMPOSER_E2E_PORT || 5511);
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '../../dev/fixtures');
const SHOTS = process.env.SCREENSHOT_DIR || '/tmp/claude-0/-home-user-claude/61a6d9a0-a933-5d86-8721-920a439be9c7/scratchpad/shots';

let h;
let page;

/** Viewport screenshot (the composer is an overlay, so a full-page capture is not useful). */
async function snap(p, name) {
  mkdirSync(SHOTS, { recursive: true });
  await p.waitForTimeout(350);
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function readPosts(p) {
  return p.evaluate(async () => {
    const data = await import('/postpilot/js/data.js');
    await data.refreshNow();
    const doc = await data.getStore().read('posts');
    return doc.posts;
  });
}

async function readLibrary(p) {
  return p.evaluate(async () => {
    const data = await import('/postpilot/js/data.js');
    await data.refreshNow();
    return (await data.getStore().read('library')).assets;
  });
}

const drawer = (p) => p.locator('.cmp-drawer');
const footer = (p) => p.locator('.cmp-drawer .overlay-foot');

async function openNew(p) {
  if (await p.locator('.sidebar .compose-button').isVisible()) await p.locator('.sidebar .compose-button').click();
  else await p.locator('.mobile-topbar').getByRole('button', { name: 'New post' }).click();
  await drawer(p).waitFor();
  await p.locator('.cmp-main').waitFor();
}

async function pickFromLibrary(p, names) {
  await drawer(p).getByRole('button', { name: 'Library', exact: true }).click();
  const modal = p.locator('.mp-modal');
  await modal.locator('.mp-grid').waitFor();
  for (const name of names) await modal.locator(`.mp-tile[aria-label*="${name}"]`).first().click();
  await modal.locator('.overlay-foot').getByRole('button', { name: /^(Add|Use)/ }).click();
  await modal.waitFor({ state: 'detached' });
}

async function closeComposer(p) {
  if (!(await drawer(p).count())) return;
  await p.keyboard.press('Escape');
  const confirmDlg = p.locator('.modal-confirm');
  await confirmDlg.waitFor({ timeout: 1500 }).catch(() => {});
  if (await confirmDlg.isVisible().catch(() => false)) await confirmDlg.locator('.overlay-foot').getByRole('button', { name: /^(Discard|Close)$/ }).click();
  await drawer(p).waitFor({ state: 'detached' });
}

/** Close whatever a failed test left open (dialogs, picker, crop editor, composer). */
async function reset(p) {
  for (let i = 0; i < 6 && (await p.locator('.overlay').count()); i++) {
    const dlg = p.locator('.modal-confirm');
    if (await dlg.isVisible().catch(() => false)) await dlg.locator('.overlay-foot .btn').last().click();
    else await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
  }
}

async function setWhen(p, daysAhead, time) {
  const d = new Date(Date.now() + daysAhead * 864e5).toISOString().slice(0, 10);
  const when = p.locator('#cmp-when');
  await when.locator('input[type="date"]').fill(d);
  await when.locator('input[type="time"]').fill(time);
}

/** Set a range input (Playwright cannot fill those) and fire the input event Preact listens to. */
async function setRange(locator, value) {
  await locator.evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

// The mock Instagram serves just-published media from the worker's temporary public files, which the
// worker deletes after publishing, so thumbnails of those posts 404 locally. Anything else is a bug.
const badResponses = [];
function trackResponses(p) {
  p.on('response', (r) => {
    if (r.status() >= 400 && !/\/public\/tmp\//.test(r.url())) badResponses.push(`${r.status()} ${r.url()}`);
  });
}

function fresh(errors) {
  return errors.filter((e) => !/favicon/i.test(e) && !/^Failed to load resource/.test(e));
}

describe('composer', () => {
  before(async () => {
    h = await openApp({ port: PORT, viewport: { width: 1280, height: 860 } });
    page = h.page;
    trackResponses(page);
  });
  after(async () => {
    if (h) await h.close();
  });
  beforeEach(async () => {
    if (page) await reset(page);
  });

  it('creates a post from the library with caption and first comment, schedules it, then edits it', async () => {
    await openNew(page);
    assert.equal(await page.locator('.cmp-drawer .overlay-title').textContent(), 'New post');
    const scheduleBtn = footer(page).getByRole('button', { name: 'Schedule', exact: true });
    assert.equal(await scheduleBtn.isDisabled(), true, 'Schedule waits for media and a time');

    await pickFromLibrary(page, ['Vase trio']);
    await page.locator('.cmp-strip .cmp-item').first().waitFor();
    assert.equal(await page.locator('#cmp-type [role="radio"][aria-checked="true"]').textContent(), 'Post');

    const caption = 'E2E: three new vases, fresh from the kiln.\n\n#ceramics #handmade';
    await page.locator('#cmp-caption').fill(caption);
    await page.locator('#cmp-first-comment').fill('Which one is your favourite?');
    // Preview mirrors the caption and the first comment.
    await page.locator('.pv-caption', { hasText: 'three new vases' }).waitFor();
    await page.locator('.pv-comment', { hasText: 'Which one is your favourite?' }).waitFor();
    assert.equal(await page.locator('.cmp-caption .cmp-count').first().textContent(), '2/5 hashtags');

    // Best-time chip sets the time.
    const chip = page.locator('.cmp-best .chip-main').first();
    await chip.click();
    assert.equal(await chip.getAttribute('aria-pressed'), 'true');
    assert.equal(await scheduleBtn.isDisabled(), false);
    await scheduleBtn.click();
    const toast = page.locator('.toast', { hasText: 'Scheduled for' });
    await toast.waitFor();
    await drawer(page).waitFor({ state: 'detached' });

    let posts = await readPosts(page);
    let post = posts.find((p) => p.caption === caption);
    assert.ok(post, 'post saved');
    assert.equal(post.status, 'scheduled');
    assert.equal(post.type, 'feed');
    assert.equal(post.firstComment, 'Which one is your favourite?');
    assert.ok(post.scheduledAt && Date.parse(post.scheduledAt) > Date.now());
    assert.equal(post.media.length, 1);

    // Edit it from the toast.
    await toast.getByRole('button', { name: 'Edit' }).click();
    await drawer(page).waitFor();
    await page.locator('.cmp-main').waitFor();
    assert.equal(await page.locator('.cmp-drawer .overlay-title').textContent(), 'Scheduled post');
    assert.equal(await page.locator('#cmp-caption').inputValue(), caption);
    const edited = `${caption}\n\nEdited in the e2e test.`;
    await page.locator('#cmp-caption').fill(edited);
    await setWhen(page, 4, '15:30');
    await footer(page).getByRole('button', { name: 'Save changes' }).click();
    await page.locator('.toast', { hasText: 'Scheduled for' }).last().waitFor();
    await drawer(page).waitFor({ state: 'detached' });
    posts = await readPosts(page);
    post = posts.find((p) => p.id === post.id);
    assert.equal(post.caption, edited);
    assert.equal(post.status, 'scheduled');
    assert.ok(post.history.some((e) => e.event === 'rescheduled' || e.event === 'edited'));
  });

  it('publishes now: the worker publishes it against the mock Instagram', async () => {
    await openNew(page);
    await pickFromLibrary(page, ['Desert sunrise']);
    const caption = 'E2E publish now: morning light on the drive to the studio.';
    await page.locator('#cmp-caption').fill(caption);
    await footer(page).getByRole('button', { name: 'Publish now' }).click();
    const dlg = page.locator('.modal-confirm');
    await dlg.waitFor();
    await dlg.locator('.overlay-foot').getByRole('button', { name: 'Publish now' }).click();
    const publishing = page.locator('.toast', { hasText: 'Publishing' });
    await publishing.waitFor();
    await drawer(page).waitFor({ state: 'detached' });
    // Open it from the toast: a read-only view that updates by itself when Instagram has the post.
    await publishing.getByRole('button', { name: 'Open' }).click();
    await drawer(page).waitFor();
    await page.locator('.cmp-drawer .overlay-title', { hasText: 'Published post' }).waitFor({ timeout: 45_000 });
    await page.locator('.cmp-main .callout', { hasText: 'Published' }).waitFor();
    await page.locator('.toast', { hasText: 'Published on Instagram' }).waitFor({ timeout: 45_000 });
    await snap(page, 'composer-published-1280-light');
    assert.equal(await page.locator('#cmp-caption').count(), 0, 'published posts are read-only');
    // Duplicate as a new post.
    await footer(page).getByRole('button', { name: 'Duplicate as new post' }).click();
    await page.locator('.cmp-drawer .overlay-title', { hasText: 'New post' }).waitFor();
    assert.equal(await page.locator('#cmp-caption').inputValue(), caption);
    await closeComposer(page);
    const posts = await readPosts(page);
    const post = posts.find((p) => p.caption === caption);
    assert.equal(post.status, 'published');
    assert.ok(post.igMediaId, 'has an Instagram media id');
    assert.ok(post.history.some((e) => e.event === 'publish_now'));
  });

  it('builds a carousel with 2 images: auto-switch, reorder, alt text, schedule', async () => {
    await openNew(page);
    await pickFromLibrary(page, ['Speckled cream vases', 'Studio still life']);
    await page.locator('.cmp-note', { hasText: 'Switched to Carousel' }).waitFor();
    assert.equal(await page.locator('#cmp-type [role="radio"][aria-checked="true"]').textContent(), 'Carousel');
    assert.equal(await page.locator('.cmp-strip .cmp-item:not(.cmp-uploading)').count(), 2);
    await page.locator('.pv-counter', { hasText: '1/2' }).waitFor();

    const lib = await readLibrary(page);
    const id = (name) => lib.find((a) => a.name === name).id;
    // Move the second item first.
    await page.getByRole('button', { name: 'Move item 2 earlier' }).click();
    assert.match(await page.locator('.cmp-strip .frame').first().getAttribute('aria-label'), /Studio still life/);
    // Alt text for the selected (moved) photo.
    await page.locator('.cmp-detail textarea').fill('A grey ceramic vase beside an orange sphere on a dark table.');
    // Carousel preview navigation.
    await page.locator('.pv-nav.is-next').click();
    await page.locator('.pv-counter', { hasText: '2/2' }).waitFor();

    await page.locator('#cmp-caption').fill('E2E carousel: this week in the studio.');
    await setWhen(page, 5, '10:15');
    await snap(page, 'composer-carousel-1280-light');
    await page.keyboard.press('Control+Enter');
    await page.locator('.toast', { hasText: 'Scheduled for' }).last().waitFor();
    await drawer(page).waitFor({ state: 'detached' });
    const post = (await readPosts(page)).find((p) => p.caption === 'E2E carousel: this week in the studio.');
    assert.equal(post.type, 'carousel');
    assert.equal(post.status, 'scheduled');
    assert.deepEqual(post.media.map((m) => m.assetId), [id('Studio still life'), id('Speckled cream vases')]);
    assert.equal(post.media[0].altText, 'A grey ceramic vase beside an orange sphere on a dark table.');
  });

  it('validation errors block scheduling until they are fixed', async () => {
    await openNew(page);
    await pickFromLibrary(page, ['Studio lights (9:16)']);
    await page.locator('.cmp-issue.is-error', { hasText: 'Feed photos must be between 4:5 and 1.91:1' }).waitFor();
    assert.equal(await page.locator('.cmp-strip .frame.is-marked').count(), 1, 'the photo is marked');
    await setWhen(page, 3, '12:00');
    const scheduleBtn = footer(page).getByRole('button', { name: 'Schedule', exact: true });
    assert.equal(await scheduleBtn.isDisabled(), true);
    assert.equal(await footer(page).getByRole('button', { name: 'Publish now' }).isDisabled(), true);
    await footer(page).getByText('1 thing to fix').waitFor();
    await page.keyboard.press('Control+Enter'); // ignored while invalid
    assert.equal(await drawer(page).count(), 1);

    // Too many hashtags is a hard error too.
    const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ');
    await page.locator('#cmp-caption').fill(`Too many tags ${tags}`);
    await page.locator('.cmp-issue.is-error', { hasText: 'at most 30 hashtags' }).waitFor();
    await page.locator('#cmp-caption').fill('Late night at the studio. #studiolife #ceramics #pottery #handmade #stoneware #wheelthrown');
    await page.locator('.cmp-issue.is-warning', { hasText: 'limits posts to 5 hashtags' }).waitFor();
    assert.match(await page.locator('.cmp-caption .cmp-count').first().getAttribute('class'), /is-warn/);

    // Fix the photo: crop it to 4:5 (creates a cropped copy in the library).
    await page.locator('.cmp-detail').getByRole('button', { name: 'Crop' }).click();
    const crop = page.locator('.crop-modal');
    await crop.locator('canvas.crop-canvas').waitFor();
    await snap(page, 'composer-crop-1280-light');
    await crop.getByRole('radio', { name: '4:5', exact: true }).click();
    await crop.getByRole('button', { name: 'Save crop' }).click();
    await page.locator('.toast', { hasText: 'Cropped copy saved' }).waitFor({ timeout: 20_000 });
    await page.locator('.cmp-issue.is-error').first().waitFor({ state: 'detached' });
    assert.equal(await scheduleBtn.isDisabled(), false);
    const lib = await readLibrary(page);
    const copy = lib.find((a) => /Studio lights.*4:5/.test(a.name));
    assert.ok(copy, 'cropped copy in the library');
    assert.equal(Math.round((copy.width / copy.height) * 100) / 100, 0.8);
    await closeComposer(page);
  });

  it('uploads a photo through the crop editor and keeps unsaved changes behind a confirm', async () => {
    await openNew(page);
    await page.locator('.cmp-main input[type="file"]').setInputFiles(path.join(FIXTURES, 'story02.jpg'));
    const crop = page.locator('.crop-modal');
    await crop.locator('canvas.crop-canvas').waitFor();
    await crop.getByRole('radio', { name: '1:1', exact: true }).click();
    await setRange(crop.locator('input[type="range"]'), 1.5);
    await crop.getByRole('button', { name: 'Use photo' }).click();
    await page.locator('.cmp-strip .cmp-item:not(.cmp-uploading)').first().waitFor({ timeout: 20_000 });
    await page.locator('.cmp-uploading').waitFor({ state: 'detached' });
    const lib = await readLibrary(page);
    const up = lib[0];
    assert.equal(up.width, up.height, 'square crop');

    await page.locator('#cmp-caption').fill('Unsaved words');
    await page.keyboard.press('Escape');
    const dlg = page.locator('.modal-confirm');
    await dlg.waitFor();
    await dlg.locator('.overlay-foot').getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await drawer(page).count(), 1, 'still open after Cancel');
    await page.keyboard.press('Escape');
    await dlg.locator('.overlay-foot').getByRole('button', { name: 'Discard' }).click();
    await drawer(page).waitFor({ state: 'detached' });
  });

  it('reel options: cover frame, trial reel, AI label; saved as a draft', async () => {
    await openNew(page);
    await page.locator('#cmp-type').getByRole('radio', { name: 'Reel' }).click();
    await pickFromLibrary(page, ['Reel: on the wheel']);
    await page.locator('#cmp-reel').waitFor();
    await setRange(page.locator('#cmp-reel input[type="range"]'), 2000);
    await page.locator('#cmp-reel').getByRole('radio', { name: 'Share manually later' }).click();
    await page.locator('.cmp-details .cmp-disclosure').click();
    await page.getByRole('switch', { name: 'Label as AI-generated' }).click();
    await page.locator('#cmp-caption').fill('E2E reel: five seconds on the wheel.');
    await page.locator('.pv-reel .pv-badge', { hasText: 'Trial' }).waitFor();
    await snap(page, 'composer-reel-1280-light');
    await footer(page).getByRole('button', { name: 'Save draft' }).click();
    await page.locator('.toast', { hasText: 'Draft saved' }).waitFor();
    const post = (await readPosts(page)).find((p) => p.caption === 'E2E reel: five seconds on the wheel.');
    assert.equal(post.type, 'reel');
    assert.equal(post.status, 'draft');
    assert.equal(post.trialReel, 'MANUAL');
    assert.equal(post.aiGenerated, true);
    assert.equal(post.thumbOffsetMs, 2000);
    assert.equal(post.shareToFeed, true);
  });

  it('AI assist writes caption ideas and suggests hashtags (5 preselected)', async () => {
    await openNew(page);
    await pickFromLibrary(page, ['Latte art']);
    await page.getByRole('textbox', { name: 'Notes for the AI' }).fill('Morning coffee before the wheel starts');
    await page.getByRole('button', { name: 'Write captions' }).click();
    await page.locator('.cmp-variant').first().waitFor({ timeout: 20_000 });
    assert.ok((await page.locator('.cmp-variant').count()) >= 1);
    await page.getByRole('button', { name: 'Use caption idea 1' }).click();
    const caption = await page.locator('#cmp-caption').inputValue();
    assert.ok(caption.length > 10, 'caption filled');

    await page.locator('#cmp-caption').fill('Coffee first, clay second.');
    await page.locator('#cmp-first-comment').fill('');
    await page.getByRole('button', { name: 'Suggest hashtags' }).click();
    await page.locator('.cmp-ai-tags .chip').first().waitFor({ timeout: 20_000 });
    const offered = await page.locator('.cmp-ai-tags .chip').count();
    assert.ok(offered > 5 && offered <= 10, `offers up to 10 hashtags (got ${offered})`);
    const picked = await page.locator('.cmp-ai-tags .chip-main[aria-pressed="true"]').count();
    assert.equal(picked, 5, 'five preselected');
    await page.locator('.cmp-ai-tags').getByRole('button', { name: /^Add 5 hashtags/ }).click();
    assert.match(await page.locator('#cmp-caption').inputValue(), /Coffee first, clay second\.\n\n#\S+( #\S+){4}$/);
    await snap(page, 'composer-ai-1280-light');
    await closeComposer(page);
  });

  it('adds a post to the queue at the next free best time', async () => {
    await openNew(page);
    await pickFromLibrary(page, ['Arched windows']);
    await page.locator('#cmp-caption').fill('E2E queue: golden hour in the studio.');
    await page.locator('#cmp-when').getByRole('button', { name: 'Add to queue' }).click();
    await page.locator('.toast', { hasText: 'Added to the queue for' }).waitFor();
    await drawer(page).waitFor({ state: 'detached' });
    const post = (await readPosts(page)).find((p) => p.caption === 'E2E queue: golden hour in the studio.');
    assert.equal(post.status, 'scheduled');
    assert.ok(Date.parse(post.scheduledAt) > Date.now());
    assert.ok(post.history.some((e) => e.event === 'queued'));
  });

  it('crop hint only says "Zoom out" when zooming out is possible', async () => {
    await openNew(page);
    await pickFromLibrary(page, ['Studio still life']); // 1080 x 1080
    await page.locator('.cmp-detail').getByRole('button', { name: 'Crop' }).click();
    const crop = page.locator('.crop-modal');
    await crop.locator('canvas.crop-canvas').waitFor();
    const hint = crop.locator('.crop-hint');
    // Default 4:5 at 1.0x is 864 px wide: zooming out is impossible, so suggest square instead.
    await hint.filter({ hasText: '864 px wide' }).waitFor();
    assert.match(await hint.textContent(), /Square keeps the full width\.$/);
    assert.doesNotMatch(await hint.textContent(), /Zoom out/);
    await setRange(crop.locator('input[type="range"]'), 1.5);
    await hint.filter({ hasText: 'Zoom out if you can.' }).waitFor();
    await setRange(crop.locator('input[type="range"]'), 1);
    await crop.getByRole('radio', { name: '1:1', exact: true }).click();
    await hint.waitFor({ state: 'detached' });
    await crop.getByRole('button', { name: 'Cancel' }).click();
    await crop.waitFor({ state: 'detached' });
    await closeComposer(page);
  });

  it('deleting a queue post cancels it so its slot is not filled again', async () => {
    const id = await page.evaluate(async () => {
      const data = await import('/postpilot/js/data.js');
      const { newPost } = await import('/postpilot/core/model.js');
      const store = data.getStore();
      const [lists, lib] = [await store.read('lists'), await store.read('library')];
      const asset = lib.assets.find((a) => a.name === 'Vase trio');
      const post = newPost({
        status: 'scheduled',
        source: 'evergreen',
        listId: lists.lists[0].id,
        caption: 'E2E queue post to delete.',
        media: [{ assetId: asset.id, kind: asset.kind }],
        scheduledAt: new Date(Date.now() + 6 * 864e5).toISOString(),
      });
      await data.mutate('posts', (doc) => void doc.posts.push(post), { message: 'e2e: queue post' });
      return post.id;
    });
    await page.evaluate(() => (location.hash = '#/planner?view=list'));
    await page.locator(`.pl-row[data-post-id="${id}"] .pl-row-title`).click();
    await drawer(page).waitFor();
    await page.locator('.cmp-main').waitFor();
    await footer(page).getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete post' }).click();
    await page.locator('.modal-confirm .overlay-foot').getByRole('button', { name: 'Delete post' }).click();
    await page.locator('.toast', { hasText: 'Post deleted.' }).waitFor();
    await drawer(page).waitFor({ state: 'detached' });
    const post = (await readPosts(page)).find((p) => p.id === id);
    assert.ok(post, 'queue posts are kept so the evergreen job sees the slot as taken');
    assert.equal(post.status, 'canceled');
    assert.ok(post.history.some((e) => e.event === 'canceled'));
    await page.locator(`.pl-row[data-post-id="${id}"]`).waitFor({ state: 'detached' });
    await page.evaluate(() => (location.hash = '#/'));
  });

  it('inserts a hashtag set and moves hashtags to the first comment', async () => {
    await openNew(page);
    await page.locator('#cmp-caption').fill('Shop update.');
    await page.getByRole('button', { name: 'Hashtag sets' }).click();
    await page.getByRole('menuitem', { name: /Shop/ }).click();
    assert.match(await page.locator('#cmp-caption').inputValue(), /Shop update\.\n\n#smallbusiness #shopsmall #handmadegifts #makersmovement/);
    await page.getByRole('button', { name: 'Move hashtags to first comment' }).click();
    assert.equal(await page.locator('#cmp-caption').inputValue(), 'Shop update.');
    assert.match(await page.locator('#cmp-first-comment').inputValue(), /#smallbusiness #shopsmall/);
    // Caption template: inserted at the end, first {placeholder} selected for typing.
    await page.getByRole('button', { name: 'Templates' }).click();
    await page.getByRole('menuitem', { name: /New drop/ }).click();
    const selected = await page.locator('#cmp-caption').evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd));
    assert.equal(selected, '{product}');
    assert.match(await page.locator('#cmp-caption').inputValue(), /^Shop update\.\n\nNew in the shop: \{product\}/);
    await closeComposer(page);
  });

  it('reminder mode: media rules still apply, caption limits become warnings, schedules a reminder', async () => {
    await openNew(page);
    await pickFromLibrary(page, ['Story: kiln opening']); // 9:16, too tall for a feed post
    await page.getByRole('radio', { name: /Send me a reminder to post it myself/ }).check();
    await page.locator('.cmp-mode-option.is-on', { hasText: 'link stickers, polls' }).waitFor();
    // The 9:16 photo is still an error: Instagram's app needs a feed-sized photo too.
    await page.locator('.cmp-issue.is-error', { hasText: 'Feed photos must be between 4:5 and 1.91:1' }).waitFor();
    await page.getByRole('button', { name: 'Remove item 1' }).click();
    await pickFromLibrary(page, ['Speckled cream vases']);
    const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ');
    const caption = `E2E reminder with a poll sticker. ${tags}`;
    await page.locator('#cmp-caption').fill(caption);
    await page.locator('.cmp-issue.is-warning', { hasText: 'at most 30 hashtags' }).waitFor();
    assert.equal(await page.locator('.cmp-issue.is-error').count(), 0, 'caption limits do not block a reminder');
    await setWhen(page, 2, '18:15');
    const primary = footer(page).getByRole('button', { name: 'Schedule reminder' });
    assert.equal(await primary.isDisabled(), false);
    // No device has notifications in the demo workspace: no promise of a phone notification.
    await page.locator('.cmp-mode-warn', { hasText: 'No device has notifications turned on' }).waitFor();
    assert.equal(await footer(page).getByRole('button', { name: 'Publish now' }).count(), 0, 'nothing publishes automatically');
    await footer(page).getByRole('button', { name: 'Post by hand now' }).waitFor();
    await snap(page, 'composer-reminder-1280-light');
    // Switching back to automatic publishing makes the hashtag limit an error again.
    await page.getByRole('radio', { name: 'Publish automatically' }).check();
    await page.locator('.cmp-issue.is-error', { hasText: 'at most 30 hashtags' }).waitFor();
    await page.getByRole('radio', { name: /Send me a reminder/ }).check();
    await primary.click();
    await page.locator('.toast', { hasText: /Reminder set for .*It shows on the Today screen then\./ }).waitFor();
    await drawer(page).waitFor({ state: 'detached' });
    const post = (await readPosts(page)).find((p) => p.caption === caption);
    assert.equal(post.status, 'scheduled');
    assert.equal(post.publishMode, 'reminder');
    assert.equal(post.reminderSentAt, null);
  });

  it('a story posted by hand gets a text field; a file still downloading cannot be cropped', async () => {
    await openNew(page);
    await page.locator('#cmp-type').getByRole('radio', { name: 'Story' }).click();
    await pickFromLibrary(page, ['Story: kiln opening']);
    assert.equal(await page.locator('#cmp-caption').count(), 0, 'an automatic story has no caption');
    await page.getByRole('radio', { name: /Send me a reminder/ }).check();
    await page.locator('.cmp-story-note', { hasText: 'You post this one yourself' }).waitFor();
    await page.getByLabel('Text or link to add').fill('New glazes in the shop: https://example.com/shop');
    assert.equal(await page.locator('.cmp-issue', { hasText: 'captions on stories' }).count(), 0, 'no caption warning for a story posted by hand');
    await snap(page, 'composer-story-reminder-1280-light');
    await closeComposer(page);

    const assetId = await page.evaluate(async () => {
      const data = await import('/postpilot/js/data.js');
      const { newAsset } = await import('/postpilot/core/model.js');
      const a = newAsset({ kind: 'image', name: 'E2E pending from link.jpg', mime: 'image/jpeg', importUrl: 'https://example.invalid/e2e/pending.jpg', tags: ['csv'] });
      await data.mutate('library', (doc) => void doc.assets.unshift(a), { message: 'e2e: pending asset' });
      return a.id;
    });
    try {
      await openNew(page);
      await pickFromLibrary(page, ['E2E pending from link']);
      const detail = page.locator('.cmp-detail');
      await detail.getByText('Downloading from link…').waitFor();
      assert.equal(await detail.getByRole('button', { name: 'Crop' }).count(), 0, 'nothing to crop yet');
      await page.locator('.cmp-strip .mp-import').first().waitFor();
      await closeComposer(page);
    } finally {
      await page.evaluate(async (id) => {
        const data = await import('/postpilot/js/data.js');
        await data.mutate('library', (doc) => void (doc.assets = doc.assets.filter((a) => a.id !== id)), { message: 'e2e: clean up' });
      }, assetId);
    }
  });

  it('AI writing actions rewrite the caption; the result waits for "Use this"', async () => {
    await openNew(page);
    await pickFromLibrary(page, ['Heart latte']);
    const rewrite = page.locator('.cmp-rewrite');
    assert.equal(await rewrite.getByRole('button', { name: 'Shorter' }).isDisabled(), true, 'nothing to rewrite yet');
    const original = 'our morning ritual.  i love this cup. Which mug do you reach for first?\n\n#coffee #slowmorning';
    await page.locator('#cmp-caption').fill(original);

    await rewrite.getByRole('button', { name: 'Shorter' }).click();
    const result = page.locator('.cmp-rewrite-result');
    await result.waitFor({ timeout: 20_000 });
    assert.match(await result.textContent(), /Shorter/);
    assert.equal(await page.locator('#cmp-caption').inputValue(), original, 'the caption only changes on "Use this"');
    await result.getByRole('button', { name: 'Discard' }).click();
    await result.waitFor({ state: 'detached' });

    await rewrite.getByRole('button', { name: 'Fix grammar' }).click();
    await result.waitFor({ timeout: 20_000 });
    await result.getByRole('button', { name: 'Use this' }).click();
    assert.equal(await page.locator('#cmp-caption').inputValue(), 'Our morning ritual. I love this cup. Which mug do you reach for first?\n\n#coffee #slowmorning');

    await rewrite.getByRole('button', { name: 'Change tone' }).click();
    await page.getByRole('menuitem', { name: 'Playful' }).click();
    await result.waitFor({ timeout: 20_000 });
    assert.match(await result.textContent(), /Playful tone/);
    await result.getByRole('button', { name: 'Discard' }).click();

    await rewrite.getByRole('combobox', { name: 'Language to translate into' }).selectOption({ label: 'German' });
    await rewrite.getByRole('button', { name: 'Translate' }).click();
    await result.waitFor({ timeout: 20_000 });
    assert.match(await result.textContent(), /In German/);
    await result.getByRole('button', { name: 'Add below' }).click();
    const withTranslation = await page.locator('#cmp-caption').inputValue();
    assert.match(withTranslation, /#slowmorning\n\n\[German\] Our morning ritual\./);
    // The translation keeps the hashtags, but the caption already has them: they are not added twice.
    assert.equal(withTranslation.match(/#slowmorning/g).length, 1);
    assert.equal(withTranslation.match(/#coffee/g).length, 1);
    assert.match(withTranslation, /reach for first\?$/);

    await rewrite.getByRole('button', { name: 'Add call to action' }).click();
    await result.waitFor({ timeout: 20_000 });
    await snap(page, 'composer-rewrite-1280-light');
    await result.getByRole('button', { name: 'Discard' }).click();

    // Errors show inline (the AI service cannot be reached).
    const route = /\/mock\/anthropic\/v1\/messages/;
    await page.route(route, (r) => r.abort('failed'));
    try {
      await rewrite.getByRole('button', { name: 'Longer' }).click();
      await page.locator('.cmp-ai .callout', { hasText: 'Could not reach the AI service' }).waitFor({ timeout: 30_000 });
    } finally {
      await page.unroute(route);
    }
    await closeComposer(page);
  });

  it('delete from Instagram: explained with Instagram Login, deletes with Facebook Login', async () => {
    const openPublished = async () => {
      await page.evaluate(() => (location.hash = '#/library'));
      await page.locator('.lib-item').first().waitFor();
      await page.getByRole('button', { name: /^Open Latte art/ }).click();
      const row = page.locator('.lib-usedin .list-row', { hasText: 'What is in your mug' });
      await row.getByRole('button', { name: 'Open post' }).click();
      await page.locator('.cmp-drawer .overlay-title', { hasText: /Published post|Deleted from Instagram/ }).waitFor();
    };
    const posts = await readPosts(page);
    const target = posts.find((p) => p.status === 'published' && /What is in your mug/.test(p.caption));
    assert.ok(target && target.igMediaId, 'seeded published post with an Instagram id');

    await openPublished();
    const section = page.locator('.cmp-delete-ig');
    await section.getByText('needs a Facebook Login connection').waitFor();
    assert.equal(await section.getByRole('button', { name: 'Delete from Instagram' }).isDisabled(), true);
    await closeComposer(page);

    const setMode = (mode) =>
      page.evaluate(async (mode) => {
        const data = await import('/postpilot/js/data.js');
        await data.mutate('settings', (s) => void (s.ig.mode = mode), { message: 'e2e: login mode' });
      }, mode);
    const assetId = target.media[0].assetId;
    await page.evaluate(async (id) => {
      const data = await import('/postpilot/js/data.js');
      await data.mutate('library', (doc) => void (doc.assets.find((a) => a.id === id).autopilot = true), { message: 'e2e: autopilot pool' });
    }, assetId);
    await setMode('facebook');
    // Graph answers 100/33 ("does not exist, cannot be loaded due to missing permissions, or does not
    // support this operation") when the token may not delete: the media is still there, so nothing is recorded.
    const mediaRoute = (url) => url.pathname.endsWith(`/${target.igMediaId}`);
    const refuse = (route) =>
      route.request().method() === 'DELETE'
        ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: `Unsupported delete request. Object with ID '${target.igMediaId}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`, type: 'GraphMethodException', code: 100, error_subcode: 33, fbtrace_id: 'e2e' } }) })
        : route.continue();
    const confirmDelete = async () => {
      await section.getByRole('button', { name: 'Delete from Instagram' }).click();
      const dlg = page.locator('.modal-confirm');
      await dlg.getByText('removes the post from your Instagram profile').waitFor();
      await dlg.locator('.overlay-foot').getByRole('button', { name: 'Delete from Instagram' }).click();
    };
    try {
      await openPublished();
      await page.route(mediaRoute, refuse);
      try {
        await confirmDelete();
        await section.locator('[role="alert"]', { hasText: 'Instagram did not delete the post: it is still on your profile' }).waitFor({ timeout: 20_000 });
        assert.match(await section.locator('[role="alert"]').textContent(), /instagram_manage_contents/);
      } finally {
        await page.unroute(mediaRoute, refuse);
        // The refusal above was injected on purpose; any other failed request is still a bug.
        for (let i = badResponses.length - 1; i >= 0; i--) if (badResponses[i].startsWith('400 ') && badResponses[i].includes(`/${target.igMediaId}?`)) badResponses.splice(i, 1);
      }
      const still = (await readPosts(page)).find((p) => p.id === target.id);
      assert.equal(still.status, 'published', 'a refused delete is not recorded');
      assert.equal(still.deletedFromInstagramAt ?? null, null);
      assert.equal(await page.locator('.cmp-drawer .overlay-title').textContent(), 'Published post');

      await confirmDelete();
      await page.locator('.toast', { hasText: 'Deleted from Instagram. Its media was taken out of the autopilot pool.' }).waitFor({ timeout: 20_000 });
      await page.locator('.cmp-drawer .overlay-title', { hasText: 'Deleted from Instagram' }).waitFor();
      await page.locator('.cmp-side .pv-time', { hasText: /^Deleted from Instagram · / }).waitFor();
      await snap(page, 'composer-deleted-1280-light');
      await closeComposer(page);
    } finally {
      await setMode('instagram');
    }
    const lib = await readLibrary(page);
    assert.equal(lib.find((a) => a.id === assetId).autopilot, false, 'autopilot does not post the deleted media again');
    const post = (await readPosts(page)).find((p) => p.id === target.id);
    assert.equal(post.status, 'canceled');
    assert.ok(post.deletedFromInstagramAt);
    assert.ok(post.history.some((e) => e.event === 'deleted from Instagram'));
    // The mock Instagram no longer has the media.
    const gone = (await fetch(`${h.url}/mock/ig/v26.0/${target.igMediaId}?fields=id&access_token=demo-instagram-token`)).status;
    assert.ok(gone >= 400, `media is gone from Instagram (${gone})`);
    await page.evaluate(() => (location.hash = '#/'));
  });

  it('on a phone the footer keeps every button on screen with its full label (360 and 390 px); source badges use the planner names', async () => {
    // The footer sits in a drawer that clips overflow, so the page never scrolls sideways: measure the buttons.
    const ids = await page.evaluate(async () => {
      const data = await import('/postpilot/js/data.js');
      const { newPost } = await import('/postpilot/core/model.js');
      const lib = await data.getStore().read('library');
      const a = lib.assets.find((x) => x.name === 'Vase trio');
      const media = [{ assetId: a.id, kind: 'image', altText: '' }];
      const at = (hours) => new Date(Date.now() + hours * 36e5).toISOString();
      const posts = {
        scheduled: newPost({ status: 'scheduled', scheduledAt: at(50), caption: 'E2E footer: scheduled', media, source: 'csv' }),
        reminded: newPost({ status: 'reminded', publishMode: 'reminder', scheduledAt: at(-1), reminderSentAt: at(-1), caption: 'E2E footer: reminded', media }),
        approval: newPost({ status: 'draft', needsApproval: true, source: 'recycle', scheduledAt: at(74), caption: 'E2E footer: approval', media }),
      };
      await data.mutate('posts', (doc) => void doc.posts.push(...Object.values(posts)), { message: 'e2e: footer posts' });
      return Object.fromEntries(Object.entries(posts).map(([k, p]) => [k, p.id]));
    });
    for (const w of [360, 390]) {
      const ctx = await h.browser.newContext({ viewport: { width: w, height: 780 } });
      const p = await ctx.newPage();
      const errs = [];
      p.on('pageerror', (e) => errs.push(String(e)));
      await p.goto(`${h.url}/postpilot/index.html#/planner?view=list`);
      await unlock(p);
      const fits = async (what) => {
        const bad = await p.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          return [...document.querySelectorAll('.cmp-drawer .overlay-foot .btn, .cmp-drawer .overlay-foot .icon-btn')]
            .filter((b) => b.getClientRects().length)
            .map((b) => {
              const r = b.getBoundingClientRect();
              const label = b.querySelector('.btn-label');
              return { text: (b.textContent || b.getAttribute('aria-label') || '').trim(), left: Math.round(r.left), right: Math.round(r.right), cut: !!label && label.scrollWidth > label.clientWidth + 1 };
            })
            .filter((b) => b.left < 0 || b.right > vw || b.cut);
        });
        assert.deepEqual(bad, [], `${what} at ${w}px: footer buttons off screen or cut`);
      };
      for (const [what, label, badge] of [['scheduled', 'Save changes', 'CSV import'], ['reminded', 'Schedule reminder', null], ['approval', 'Approve and schedule', 'Repost']]) {
        const row = p.locator(`.pl-row[data-post-id="${ids[what]}"]`);
        await row.waitFor({ timeout: 20_000 });
        await row.getByRole('button', { name: /^Actions for/ }).click();
        await p.getByRole('menuitem', { name: 'Edit', exact: true }).click();
        await footer(p).getByRole('button', { name: label }).waitFor();
        await fits(what);
        if (w === 360) await snap(p, `composer-footer-${what}-${w}`);
        if (badge) await p.locator('.cmp-status .badge', { hasText: new RegExp(`^${badge}$`) }).waitFor();
        if (what === 'reminded') {
          // One name for the status everywhere: "Post by hand" (not "Reminder sent").
          assert.equal((await p.locator('.cmp-status .status').textContent()).trim(), 'Post by hand');
        }
        await closeComposer(p);
      }
      await openNew(p);
      await pickFromLibrary(p, ['Vase trio']);
      await setWhen(p, 2, '10:00');
      await footer(p).getByRole('button', { name: 'Schedule', exact: true }).waitFor();
      await fits('new post');
      await p.getByRole('radio', { name: /Send me a reminder/ }).check();
      await footer(p).getByRole('button', { name: 'Schedule reminder' }).waitFor();
      await fits('new reminder');
      await closeComposer(p);
      assert.deepEqual(errs, []);
      await ctx.close();
    }
    await page.evaluate(async (ids) => {
      const data = await import('/postpilot/js/data.js');
      const gone = new Set(Object.values(ids));
      await data.mutate('posts', (doc) => void (doc.posts = doc.posts.filter((x) => !gone.has(x.id))), { message: 'e2e: clean up' });
    }, ids);
  });

  it('best times keep the gap from a post being posted by hand (timed at its reminder)', async () => {
    // The first best time as the composer works it out (core/schedule.js on the same documents).
    const firstBest = () =>
      page.evaluate(async () => {
        const data = await import('/postpilot/js/data.js');
        const { bestTimeMatrix, suggestSlots } = await import('/postpilot/core/schedule.js');
        const { dayKey, timeKey } = await import('/postpilot/core/time.js');
        await data.refreshNow();
        const store = data.getStore();
        const tz = (await store.read('settings')).timezone;
        const audience = await store.read('audience');
        const media = await store.read('analytics-media');
        const posts = (await store.read('posts')).posts;
        const matrix = bestTimeMatrix({ onlineFollowers: audience.onlineFollowers, mediaStats: media.media, tz }).matrix;
        const taken = posts
          .filter((p) => ['scheduled', 'publishing', 'reminded'].includes(p.status) && p.scheduledAt && p.type !== 'story')
          .map((p) => (p.status === 'reminded' ? p.reminderSentAt || p.scheduledAt : p.scheduledAt));
        const iso = suggestSlots({ matrix, tz, count: 3, taken, horizonDays: 14 })[0];
        return iso ? { iso, date: dayKey(new Date(iso), tz), time: timeKey(new Date(iso), tz) } : null;
      });
    /** Click the composer's first best-time chip and read back the time it set. */
    const chipTimeOnce = async () => {
      await openNew(page);
      await page.locator('.cmp-best .chip-main').first().click();
      const when = page.locator('#cmp-when');
      const picked = { date: await when.locator('input[type="date"]').inputValue(), time: await when.locator('input[type="time"]').inputValue() };
      await closeComposer(page);
      return picked;
    };
    // The chips are recomputed when the posts document refreshes after a write, so a click can land on a
    // chip that is being replaced: retry briefly until the composer shows the expected time.
    const chipTime = async (expected) => {
      let picked;
      for (let i = 0; i < 6; i++) {
        picked = await chipTimeOnce();
        if (picked.date === expected.date && picked.time === expected.time) break;
        await page.waitForTimeout(500);
      }
      return picked;
    };
    const before = await firstBest();
    assert.ok(before, 'there is a free best time');
    assert.deepEqual(await chipTime(before), { date: before.date, time: before.time });
    // A post the owner is posting by hand: planned long ago, its reminder went out at that best time.
    const id = await page.evaluate(async (at) => {
      const data = await import('/postpilot/js/data.js');
      const { newPost } = await import('/postpilot/core/model.js');
      const lib = await data.getStore().read('library');
      const a = lib.assets.find((x) => x.name === 'Vase trio');
      const post = newPost({ status: 'reminded', publishMode: 'reminder', caption: 'E2E gap: posting by hand', media: [{ assetId: a.id, kind: 'image', altText: '' }], scheduledAt: new Date(Date.parse(at) - 10 * 864e5).toISOString(), reminderSentAt: at });
      await data.mutate('posts', (doc) => void doc.posts.push(post), { message: 'e2e: reminded post' });
      return post.id;
    }, before.iso);
    try {
      const after = await firstBest();
      assert.ok(after && after.iso !== before.iso, 'the reminded post takes that time');
      assert.ok(Math.abs(Date.parse(after.iso) - Date.parse(before.iso)) >= 20 * 36e5, 'at least the 20-hour gap away');
      assert.deepEqual(await chipTime(after), { date: after.date, time: after.time });
    } finally {
      await page.evaluate(async (id) => {
        const data = await import('/postpilot/js/data.js');
        await data.mutate('posts', (doc) => void (doc.posts = doc.posts.filter((p) => p.id !== id)), { message: 'e2e: clean up' });
      }, id);
    }
  });

  it('the activity list names the worker\'s "linked" event', async () => {
    const id = await page.evaluate(async () => {
      const data = await import('/postpilot/js/data.js');
      const { newPost } = await import('/postpilot/core/model.js');
      const lib = await data.getStore().read('library');
      const a = lib.assets.find((x) => x.name === 'Vase trio');
      const at = new Date(Date.now() - 36e5).toISOString();
      const post = newPost({
        status: 'published',
        publishMode: 'reminder',
        caption: 'E2E linked: posted by hand',
        media: [{ assetId: a.id, kind: 'image', altText: '' }],
        scheduledAt: at,
        publishedAt: at,
        history: [
          { at, event: 'posted by hand', detail: '' },
          { at: new Date().toISOString(), event: 'linked', detail: 'Found this post on Instagram; its numbers now show here.' },
        ],
      });
      await data.mutate('posts', (doc) => void doc.posts.push(post), { message: 'e2e: linked post' });
      return post.id;
    });
    try {
      await page.evaluate(() => (location.hash = '#/library'));
      await page.locator('.lib-item').first().waitFor();
      await page.getByRole('button', { name: /^Open Vase trio/ }).click();
      await page.locator('.lib-usedin .list-row', { hasText: 'E2E linked: posted by hand' }).getByRole('button', { name: 'Open post' }).click();
      await page.locator('.cmp-drawer .overlay-title', { hasText: 'Published post' }).waitFor();
      await page.locator('.cmp-history .cmp-disclosure').click();
      const first = page.locator('.cmp-history-list li').first();
      assert.match(await first.textContent(), /Found on Instagram: Found this post on Instagram; its numbers now show here\./);
      await closeComposer(page);
    } finally {
      await page.evaluate(async (id) => {
        const data = await import('/postpilot/js/data.js');
        await data.mutate('posts', (doc) => void (doc.posts = doc.posts.filter((p) => p.id !== id)), { message: 'e2e: clean up' });
      }, id);
    }
  });

  it('screenshots in dark mode and on a phone, without horizontal overflow', async () => {
    const shots = [
      { w: 1280, hgt: 860, scheme: 'dark' },
      { w: 390, hgt: 844, scheme: 'light' },
      { w: 390, hgt: 844, scheme: 'dark' },
    ];
    for (const s of shots) {
      const ctx = await h.browser.newContext({ viewport: { width: s.w, height: s.hgt }, colorScheme: s.scheme });
      const p = await ctx.newPage();
      const errs = [];
      p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
      p.on('pageerror', (e) => errs.push(String(e)));
      trackResponses(p);
      await p.goto(`${h.url}/postpilot/index.html#/`);
      await unlock(p);
      await openNew(p);
      await snap(p, `composer-new-${s.w}-${s.scheme}`);
      await pickFromLibrary(p, ['Vase trio', 'Night hills']);
      await p.locator('#cmp-caption').fill('Three new shapes for the autumn drop. Which one goes home with you?\n\n#ceramics #handmade');
      await snap(p, `composer-filled-${s.w}-${s.scheme}`);
      const overflow = await p.evaluate(() => {
        const body = document.querySelector('.cmp-drawer .overlay-body');
        return { page: document.documentElement.scrollWidth - window.innerWidth, body: body.scrollWidth - body.clientWidth };
      });
      assert.ok(overflow.page <= 0, `no page overflow at ${s.w}px`);
      assert.ok(overflow.body <= 0, `no composer overflow at ${s.w}px`);
      if (s.w < 760) {
        await p.locator('.cmp-tabs').getByRole('radio', { name: 'Preview' }).click();
        await p.locator('.cmp-side .pv-card').waitFor();
        await snap(p, `composer-preview-${s.w}-${s.scheme}`);
        await p.locator('.cmp-tabs').getByRole('radio', { name: 'Edit' }).click();
      }
      await p.locator('.cmp-drawer').getByRole('button', { name: 'Library', exact: true }).click();
      await p.locator('.mp-grid').waitFor();
      await snap(p, `composer-picker-${s.w}-${s.scheme}`);
      await p.locator('.mp-modal').getByRole('button', { name: 'Cancel' }).click();
      assert.deepEqual(fresh(errs), [], `no console errors (${s.w} ${s.scheme})`);
      await ctx.close();
    }
  });

  it('logged no console errors and no failed requests', () => {
    assert.deepEqual(fresh(h.consoleErrors), []);
    assert.deepEqual(badResponses, []);
  });
});
