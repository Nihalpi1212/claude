// E2E: Link-in-bio editor + the public bio.html page.
// Run: node --test tests/e2e/bio.spec.mjs
// Uses a free port (or BIO_E2E_PORT) so it can run next to settings.spec.mjs, which owns 5216.
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openApp, shot, unlock } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const AVATAR = path.resolve(here, '../../dev/fixtures/avatar.jpg');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function trackErrors(page) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = (m.location() && m.location().url) || '';
    if (/^Failed to load resource/.test(m.text()) && /fonts\.(googleapis|gstatic)\.com/.test(url)) return;
    errors.push(`${m.text()} ${url}`.trim());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** Wait until every image on the page has loaded; fail on broken ones. */
async function imagesLoaded(page, label) {
  await page.evaluate(() => Promise.all([...document.images].map((img) => { img.loading = 'eager'; return img.decode().catch(() => {}); })));
  const broken = await page.evaluate(() => [...document.images].filter((img) => !img.complete || img.naturalWidth === 0).map((img) => img.src));
  assert.deepEqual(broken, [], `${label}: images failed to load`);
}

/** The public bio.json exactly as visitors can fetch it. */
async function publicBioText(page) {
  return page.evaluate(async () => {
    const { DATA_BRANCH, ENDPOINTS } = await import('/postpilot/js/config.js');
    const res = await fetch(`${ENDPOINTS.github}/repos/demo/postpilot/contents/public/bio.json?ref=${DATA_BRANCH}`, {
      headers: { Accept: 'application/vnd.github.raw+json' },
      cache: 'no-store',
    });
    return res.text();
  });
}

async function noSideScroll(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `${label}: page scrolls sideways by ${overflow}px`);
}

test('link in bio: edit, validate, publish, public page, photo, unpublish', { timeout: 240_000 }, async () => {
  const port = Number(process.env.BIO_E2E_PORT) || (await freePort());
  const h = await openApp({ port, hash: '#/bio' });
  const { page } = h;
  const errors = trackErrors(page);
  const publicUrl = `${h.url}/postpilot/bio.html`;
  try {
    await page.waitForSelector('.bio-editor', { timeout: 20_000 });

    // Seeded content renders in the editor and the live preview. Labels name their inputs.
    assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), 'Studio North');
    assert.equal(await page.getByLabel('Short bio', { exact: true }).count(), 1);
    assert.equal(await page.locator('#bio-title').inputValue(), 'Studio North');
    assert.equal(await page.locator('.bio-link-edit').count(), 3);
    assert.equal(await page.locator('.bio-grid-row').count(), 6);
    const preview = page.locator('.bio-phone');
    await preview.locator('.bio-title', { hasText: 'Studio North' }).waitFor();
    assert.equal(await preview.locator('.bio-link').count(), 3);
    await page.getByText('Live', { exact: true }).waitFor();
    await page.locator('.bio-url-link', { hasText: '/postpilot/bio.html' }).waitFor();

    // Edit the title and add a highlighted link with UTM tags; the preview follows.
    await page.locator('#bio-title').fill('Studio North Ceramics');
    await page.getByRole('button', { name: 'Add link' }).click();
    const added = page.locator('.bio-link-edit').nth(3);
    await added.getByLabel('Label').fill('Newsletter');
    await added.getByLabel('Address').fill('studionorth.example/news');
    await added.getByLabel('Address').blur();
    assert.equal(await added.getByLabel('Address').inputValue(), 'https://studionorth.example/news');
    await added.getByRole('switch', { name: 'Highlight' }).click();
    await added.getByRole('button', { name: 'UTM tags' }).click();
    await added.getByLabel('Source').fill('instagram');
    await added.getByLabel('Campaign').fill('bio');
    await added.getByText('https://studionorth.example/news?utm_source=instagram&utm_campaign=bio').waitFor();
    await preview.locator('.bio-title', { hasText: 'Studio North Ceramics' }).waitFor();
    await preview.locator('.bio-link.is-highlight', { hasText: 'Newsletter' }).waitFor();
    await page.getByText('Unsaved changes').first().waitFor();

    // An empty link blocks publishing with a clear message, then gets deleted.
    await page.getByRole('button', { name: 'Add link' }).click();
    await page.getByRole('button', { name: 'Publish changes' }).first().click();
    await page.getByText('Fix the highlighted fields first.').waitFor();
    const broken = page.locator('.bio-link-edit').nth(4);
    await broken.getByText('Add a label, for example "Shop".').waitFor();
    await broken.getByText('Enter a full address starting with https://').waitFor();
    await broken.getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete link' }).click();
    assert.equal(await page.locator('.bio-link-edit').count(), 4);

    // Move the new link to the top.
    for (let i = 0; i < 3; i++) await page.locator('.bio-link-edit').nth(3 - i).getByRole('button', { name: /up$/ }).click();
    assert.equal(await page.locator('.bio-link-edit').first().getByLabel('Label').inputValue(), 'Newsletter');

    // Add one more post to the grid from the picker.
    await page.getByRole('button', { name: 'Choose posts' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Choose posts for the grid' });
    await dialog.waitFor();
    await dialog.locator('button.frame').first().click();
    await dialog.getByRole('button', { name: 'Add 1 post' }).click();
    assert.equal(await page.locator('.bio-grid-row').count(), 7);

    // Ink theme with a custom accent.
    await page.getByRole('radio', { name: 'Ink' }).click();
    await page.getByRole('button', { name: 'Accent #2d7a4d' }).click();
    await preview.locator('.bio-page.bio-theme-ink').waitFor();

    await imagesLoaded(page, 'bio editor');
    await shot(page, 'bio-editor-dirty-desktop-light');

    // Publish and check the public page.
    await page.getByRole('button', { name: 'Publish changes' }).first().click();
    await page.getByText('Changes are live.').waitFor();
    assert.equal(await page.getByText('Unsaved changes').count(), 0);

    const pub = await h.context.newPage();
    const pubErrors = trackErrors(pub);
    await pub.goto(publicUrl);
    await pub.locator('h1.bio-title', { hasText: 'Studio North Ceramics' }).waitFor({ timeout: 20_000 });
    assert.equal(await pub.title(), 'Studio North Ceramics');
    const links = await pub.locator('a.bio-link').evaluateAll((as) => as.map((a) => ({ text: a.textContent.trim(), href: a.href, hi: a.classList.contains('is-highlight') })));
    assert.deepEqual(links.map((l) => l.text), ['Newsletter', 'Shop the autumn drop', 'Book a wheel-throwing workshop', 'Custom orders']);
    assert.equal(links[0].href, 'https://studionorth.example/news?utm_source=instagram&utm_campaign=bio');
    assert.ok(links[0].hi, 'the new link is highlighted');
    assert.equal(await pub.locator('.bio-grid a.bio-tile').count(), 7);
    assert.ok(await pub.locator('.bio-page.bio-theme-ink').count());
    await noSideScroll(pub, 'public bio desktop');

    // A link switched off never reaches the public file; it stays in the editor at its place.
    const workshop = page.locator('.bio-link-edit').nth(2);
    assert.equal(await workshop.getByLabel('Label').inputValue(), 'Book a wheel-throwing workshop');
    const workshopUrl = await workshop.getByLabel('Address').inputValue();
    assert.ok(workshopUrl.startsWith('https://'), workshopUrl);
    await workshop.getByRole('switch', { name: 'Show' }).click();
    await workshop.getByText('Its address stays private').waitFor();
    // The earlier "Changes are live." toast may still be up: wait for the save itself.
    await page.getByRole('button', { name: 'Publish changes' }).first().click();
    await page.locator('.bio-savebar').waitFor({ state: 'detached', timeout: 20_000 });
    let rawBio = await publicBioText(page);
    assert.ok(rawBio.includes('Shop the autumn drop'), 'public file has the visible links');
    assert.ok(!rawBio.includes(workshopUrl) && !rawBio.includes('wheel-throwing'), 'hidden link leaked into public/bio.json');
    const hiddenSaved = await page.evaluate(async () => (await (await import('/postpilot/js/data.js')).readDoc('settings')).bioHiddenLinks);
    assert.deepEqual(hiddenSaved.map((l) => [l.title, l.position, l.enabled]), [['Book a wheel-throwing workshop', 2, false]]);
    await page.reload();
    await unlock(page);
    await page.waitForSelector('.bio-editor', { timeout: 20_000 });
    assert.deepEqual(await page.locator('.bio-link-edit').evaluateAll((els) => els.map((e) => e.querySelector('input').value)),
      ['Newsletter', 'Shop the autumn drop', 'Book a wheel-throwing workshop', 'Custom orders']);
    assert.equal(await page.locator('.bio-link-edit').nth(2).getByRole('switch', { name: 'Show' }).getAttribute('aria-checked'), 'false');
    assert.equal(await page.locator('.bio-link-edit').nth(2).getByLabel('Address').inputValue(), workshopUrl);
    await pub.reload();
    await pub.locator('a.bio-link').first().waitFor({ timeout: 20_000 });
    assert.deepEqual(await pub.locator('a.bio-link').allTextContents().then((t) => t.map((x) => x.trim())), ['Newsletter', 'Shop the autumn drop', 'Custom orders']);
    // Showing it again puts it back in the public file at the same place.
    await page.locator('.bio-link-edit').nth(2).getByRole('switch', { name: 'Show' }).click();
    await page.locator('.bio-savebar').waitFor();
    await page.getByRole('button', { name: 'Publish changes' }).first().click();
    await page.locator('.bio-savebar').waitFor({ state: 'detached', timeout: 20_000 });
    rawBio = await publicBioText(page);
    assert.deepEqual(JSON.parse(rawBio).links.map((l) => l.title), ['Newsletter', 'Shop the autumn drop', 'Book a wheel-throwing workshop', 'Custom orders']);
    assert.deepEqual(await page.evaluate(async () => (await (await import('/postpilot/js/data.js')).readDoc('settings')).bioHiddenLinks), []);
    await pub.reload();
    await pub.locator('h1.bio-title', { hasText: 'Studio North Ceramics' }).waitFor({ timeout: 20_000 });

    // ?repo= cannot point a github.io address at another repository; custom domains still use it.
    const repos = await pub.evaluate(async () => {
      const { bioRepo } = await import('/postpilot/js/bio-page.js');
      return {
        pages: bioRepo({ hostname: 'owner.github.io', pathname: '/site/postpilot/bio.html', search: '?repo=attacker/x' }),
        custom: bioRepo({ hostname: 'links.example.com', pathname: '/bio.html', search: '?repo=owner/site' }),
      };
    });
    assert.notEqual(repos.pages && repos.pages.owner, 'attacker');
    assert.deepEqual(repos.custom, { owner: 'owner', repo: 'site' });

    // Photo upload: saved to public/bio/ right away and shown on the live page.
    await page.locator('.bio-avatar-row input[type=file]').setInputFiles(AVATAR);
    await page.getByText('Photo updated on your live page.').waitFor({ timeout: 20_000 });
    await preview.locator('img.bio-avatar').waitFor();
    await pub.reload();
    const avatar = pub.locator('img.bio-avatar');
    await avatar.waitFor({ timeout: 20_000 });
    assert.match(await avatar.getAttribute('src'), /\/postpilot-data\/public\/bio\/avatar-[a-z0-9]+\.jpg$/);
    await pub.waitForFunction(() => {
      const img = document.querySelector('img.bio-avatar');
      return img && img.complete && img.naturalWidth > 0;
    });

    // Phone screenshots of the public page.
    await pub.setViewportSize({ width: 390, height: 844 });
    await imagesLoaded(pub, 'public bio');
    await noSideScroll(pub, 'public bio phone');
    await shot(pub, 'bio-public-phone-ink');

    // Unpublish: the public page says so.
    await page.getByRole('button', { name: 'Unpublish' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Unpublish' }).click();
    await page.getByText('Your page is offline.').waitFor();
    await page.getByText('Not published', { exact: true }).waitFor();
    await pub.reload();
    await pub.getByText('This page is not published yet').waitFor({ timeout: 20_000 });
    await shot(pub, 'bio-public-phone-unpublished');

    // Publish again (paper theme) for the remaining screenshots.
    await page.getByRole('radio', { name: 'Paper' }).click();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await page.getByText('Your page is live.').waitFor();
    await pub.reload();
    await pub.locator('h1.bio-title', { hasText: 'Studio North Ceramics' }).waitFor({ timeout: 20_000 });
    await imagesLoaded(pub, 'public bio (paper)');
    await shot(pub, 'bio-public-phone-paper');
    await pub.setViewportSize({ width: 1280, height: 860 });
    await shot(pub, 'bio-public-desktop-paper');

    assert.deepEqual(errors, []);
    assert.deepEqual(pubErrors, []);

    // Editor screenshots: desktop and phone, light and dark.
    for (const [vw, vh, tag] of [[1280, 860, 'desktop'], [390, 844, 'phone']]) {
      for (const scheme of ['light', 'dark']) {
        const ctx = await h.browser.newContext({ viewport: { width: vw, height: vh }, colorScheme: scheme });
        const p = await ctx.newPage();
        const errs = trackErrors(p);
        await p.goto(`${h.url}/postpilot/index.html#/bio`);
        await unlock(p);
        await p.waitForSelector('.bio-editor', { timeout: 20_000 });
        await p.waitForTimeout(500);
        await imagesLoaded(p, `bio editor ${tag} ${scheme}`);
        await noSideScroll(p, `bio editor ${tag} ${scheme}`);
        await shot(p, `bio-editor-${tag}-${scheme}`);
        if (tag === 'phone') {
          await p.getByRole('radio', { name: 'Preview' }).click();
          await p.locator('.bio-phone .bio-title').waitFor();
          await imagesLoaded(p, `bio preview ${tag} ${scheme}`);
          await noSideScroll(p, `bio preview ${tag} ${scheme}`);
          await shot(p, `bio-editor-preview-${tag}-${scheme}`);
        }
        assert.deepEqual(errs, []);
        await ctx.close();
      }
    }

    // Posts deleted from Instagram: their tiles are marked and the picker no longer offers them.
    // (The dev server runs in another process: change the documents through the app's data module, as the worker would.)
    const docs = await page.evaluate(async () => {
      const d = await import('/postpilot/js/data.js');
      await d.getStore().refresh();
      return { grid: (await d.readDoc('bio')).grid, media: (await d.readDoc('analytics-media')).media };
    });
    const grid = docs.grid;
    const [flagged, deletedInApp] = [String(grid[0].igMediaId), String(grid[1].igMediaId)];
    const entry = docs.media[flagged];
    assert.ok(entry, 'the first tile is a post analytics knows');
    await page.evaluate(async (ids) => {
      const d = await import('/postpilot/js/data.js');
      await d.mutate('analytics-media', (doc) => {
        doc.media[ids.flagged].deletedAt = new Date().toISOString();
      }, { message: 'e2e: worker flagged a deleted post' });
      await d.mutate('posts', (doc) => {
        doc.posts.push({ id: 'p_e2e_deleted', type: 'feed', status: 'canceled', igMediaId: ids.deletedInApp, deletedFromInstagramAt: new Date().toISOString(), media: [], history: [] });
      }, { message: 'e2e: post deleted from Instagram in the app' });
    }, { flagged, deletedInApp });
    await page.reload();
    await unlock(page);
    await page.waitForSelector('.bio-editor', { timeout: 20_000 });
    const rows = page.locator('.bio-grid-row');
    for (const i of [0, 1]) {
      await rows.nth(i).getByText('Deleted from Instagram.').waitFor();
      assert.match(await rows.nth(i).getAttribute('class'), /\bis-deleted\b/);
      assert.match(await rows.nth(i).textContent(), /The worker takes it off your page on its next run\./);
    }
    assert.equal(await rows.nth(2).getByText('Deleted from Instagram.').count(), 0);
    await page.getByRole('button', { name: 'Choose posts' }).first().click();
    const picker = page.getByRole('dialog', { name: 'Choose posts for the grid' });
    await picker.locator('.frame').first().waitFor();
    const srcs = await picker.locator('.frame img').evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src')));
    // The picker lists the newest 36 posts with an image (as js/views/bio.js GridPicker); images repeat in the demo,
    // so compare the whole list with and without the two deleted posts.
    const srcOf = (m) => m.thumbnailUrl || (m.mediaType !== 'VIDEO' ? m.mediaUrl : null);
    const offered = (skip) => Object.values(docs.media)
      .filter((m) => m && m.productType !== 'STORY' && !skip.has(String(m.id)) && srcOf(m))
      .sort((a, b) => (Date.parse(b.timestamp || 0) || 0) - (Date.parse(a.timestamp || 0) || 0))
      .slice(0, 36)
      .map(srcOf);
    assert.deepEqual(srcs, offered(new Set([flagged, deletedInApp])), 'the two deleted posts are left out');
    assert.notDeepEqual(srcs, offered(new Set()), 'they were among the posts offered before');
    await page.keyboard.press('Escape');
    await shot(page, 'bio-editor-deleted-tiles-desktop-light');
    assert.deepEqual(errors, []);
  } finally {
    await h.close();
  }
});
