// E2E: reminder posts end to end. Compose a reminder post due now, let the worker run (Settings → Run
// now, against the mock Instagram), follow it from Today to the post-by-hand screen, save the media,
// copy the caption, mark it as posted; "Remind me again", "Post by hand now", unknown ids, screenshots.
//   node --test tests/e2e/post-now.spec.mjs
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp, unlock } from './helpers.mjs';

const PORT = Number(process.env.POST_NOW_E2E_PORT || 5514);
const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.SCREENSHOT_DIR || '/tmp/claude-0/-home-user-claude/61a6d9a0-a933-5d86-8721-920a439be9c7/scratchpad/shots';

let h;
let page;

const go = (p, hash) => p.evaluate((x) => (location.hash = x), hash);
const drawer = (p) => p.locator('.cmp-drawer');
const footer = (p) => p.locator('.cmp-drawer .overlay-foot');

async function readPosts(p = page) {
  return p.evaluate(async () => {
    const data = await import('/postpilot/js/data.js');
    await data.refreshNow();
    return (await data.getStore().read('posts')).posts;
  });
}

/** Add a post straight to the posts document (as another device would). */
async function addPost(partial, assetName = 'Vase trio') {
  return page.evaluate(
    async ({ partial, assetName }) => {
      const data = await import('/postpilot/js/data.js');
      const { newPost } = await import('/postpilot/core/model.js');
      const lib = await data.getStore().read('library');
      const a = lib.assets.find((x) => x.name === assetName);
      const post = newPost({ media: [{ assetId: a.id, kind: a.kind, altText: '' }], ...partial });
      await data.mutate('posts', (doc) => void doc.posts.push(post), { message: 'e2e: post' });
      return post.id;
    },
    { partial, assetName },
  );
}

async function snap(p, name) {
  mkdirSync(SHOTS, { recursive: true });
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function toast(p, re, timeout = 15_000) {
  await p.locator('.toast', { hasText: re }).first().waitFor({ timeout });
}

describe('post by hand', { timeout: 300_000 }, () => {
  before(async () => {
    h = await openApp({ port: PORT, hash: '#/' });
    page = h.page;
    await h.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: h.url });
  });
  after(async () => {
    if (h) await h.close();
  });

  test('a reminder post due now: worker sends the reminder, Today links to it, mark as posted', async () => {
    // Compose: photo, caption, "Send me a reminder", a time one minute ago (account time zone).
    await page.locator('.sidebar .compose-button').click();
    await drawer(page).waitFor();
    await page.locator('.cmp-main').waitFor();
    await drawer(page).getByRole('button', { name: 'Library', exact: true }).click();
    const modal = page.locator('.mp-modal');
    await modal.locator('.mp-grid').waitFor();
    await modal.locator('.mp-tile[aria-label*="Vase trio"]').first().click();
    await modal.locator('.overlay-foot').getByRole('button', { name: /^(Add|Use)/ }).click();
    await modal.waitFor({ state: 'detached' });
    const caption = 'E2E reminder: new vases, with the poll sticker.\n\n#ceramics #handmade';
    await page.locator('#cmp-caption').fill(caption);
    await page.locator('#cmp-first-comment').fill('Which one should we glaze next?');
    await page.getByRole('radio', { name: /Send me a reminder to post it myself/ }).check();
    assert.equal(await footer(page).getByRole('button', { name: 'Post by hand now' }).count(), 1);
    // The demo workspace has no device with notifications: the composer does not promise a phone notification.
    await page.locator('.cmp-mode-warn', { hasText: 'No device has notifications turned on, so you only see the reminder on the Today screen.' }).waitFor();
    await page.locator('.cmp-mode-warn').getByRole('button', { name: 'Turn on notifications' }).waitFor();
    assert.doesNotMatch(await page.locator('.cmp-mode-option.is-on').textContent(), /phone notification/);
    const { date, time } = await page.evaluate(async () => {
      const t = await import('/postpilot/core/time.js');
      const data = await import('/postpilot/js/data.js');
      const tz = (await data.getStore().read('settings')).timezone;
      const at = new Date(Date.now() - 60_000);
      return { date: t.dayKey(at, tz), time: t.timeKey(at, tz) };
    });
    await page.locator('#cmp-when input[type="date"]').fill(date);
    await page.locator('#cmp-when input[type="time"]').fill(time);
    await page.locator('.cmp-when-warn', { hasText: 'the reminder goes out on the next worker run' }).waitFor();
    await footer(page).getByRole('button', { name: 'Schedule reminder' }).click();
    await toast(page, /Reminder set for .*It shows on the Today screen then\./);
    await drawer(page).waitFor({ state: 'detached' });
    let post = (await readPosts()).find((p) => p.caption === caption);
    assert.equal(post.status, 'scheduled');
    assert.equal(post.publishMode, 'reminder');

    // Run the worker from Settings (workflow_dispatch against the mocks) and wait for the reminder.
    await go(page, '#/settings?section=worker');
    await page.getByRole('button', { name: 'Run now' }).click();
    for (let i = 0; i < 60 && post.status !== 'reminded'; i++) {
      await page.waitForTimeout(1000);
      post = (await readPosts()).find((p) => p.id === post.id);
    }
    assert.equal(post.status, 'reminded', 'the worker sent the reminder');
    assert.ok(post.reminderSentAt);
    assert.equal(post.igMediaId, null, 'nothing was published to Instagram');
    const sentEntry = post.history.find((e) => e.event === 'reminder sent');
    assert.ok(sentEntry);
    assert.match(sentEntry.detail, /No device gets notifications/, 'the history says nobody got a push');

    // Today: "Post these by hand" links to the post-by-hand screen.
    await go(page, '#/');
    const card = page.locator('.dash-hand');
    await card.waitFor({ timeout: 20_000 });
    await card.locator('.dash-post', { hasText: 'E2E reminder' }).waitFor();
    await card.getByRole('link', { name: /Post this post by hand: E2E reminder/ }).click();
    await page.waitForFunction((id) => location.hash === `#/post-now/${encodeURIComponent(id)}`, post.id);

    // Post by hand: the decrypted photo, save it, copy caption and first comment, open Instagram.
    await page.locator('.pn-steps').waitFor();
    assert.match(await page.locator('.page-title').textContent(), /Post your post/);
    await page.locator('.pn-media img[src^="blob:"]').waitFor({ timeout: 20_000 });
    const save = page.getByRole('button', { name: 'Save to phone' });
    await page.waitForFunction(() => [...document.querySelectorAll('.pn button')].some((b) => /Save to phone/.test(b.textContent) && !b.disabled));
    // Desktop Chromium on Linux has no share sheet, so the file downloads.
    const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
    assert.equal(download.suggestedFilename(), 'postpilot-1-vase-trio.jpg');
    const bytes = await readFile(await download.path());
    assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8], 'a JPEG');
    await page.locator('.pn-step.is-done').first().waitFor();

    await page.getByRole('button', { name: 'Copy caption' }).click();
    await toast(page, /Caption copied/);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), caption.trim());
    await page.getByRole('button', { name: 'Copy first comment' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Which one should we glaze next?');
    assert.equal(await page.getByRole('link', { name: 'Open Instagram' }).getAttribute('href'), 'https://www.instagram.com/');

    // Mark as posted, with a link (a wrong one first).
    await page.getByRole('textbox', { name: 'Link to the post' }).fill('https://example.com/p/1');
    await page.getByRole('button', { name: 'Mark as posted' }).click();
    await page.getByText('Paste the link to the post, starting with https://www.instagram.com/').waitFor();
    await page.getByRole('textbox', { name: 'Link to the post' }).fill('https://www.instagram.com/p/E2Ereminder/');
    await page.getByRole('button', { name: 'Mark as posted' }).click();
    await toast(page, /Marked as posted/);
    await page.locator('.callout', { hasText: 'Already posted' }).waitFor();
    post = (await readPosts()).find((p) => p.id === post.id);
    assert.equal(post.status, 'published');
    assert.ok(Date.parse(post.publishedAt) > Date.now() - 120_000);
    assert.equal(post.permalink, 'https://www.instagram.com/p/E2Ereminder/');
    assert.ok(post.history.some((e) => e.event === 'posted by hand'));
    // It left the "by hand" card.
    await go(page, '#/');
    await page.locator('.dash-account').waitFor();
    assert.equal(await page.locator('.dash-hand .dash-post', { hasText: 'E2E reminder' }).count(), 0);
  });

  test('a pasted link is cleaned up and matched to its Instagram media, so the planner shows the post once', async () => {
    // The two newest Instagram posts no Postpilot post has (analytics-media fills in shortly after the server starts).
    const media = await page.evaluate(async () => {
      const data = await import('/postpilot/js/data.js');
      for (let i = 0; i < 60; i++) {
        await data.refreshNow();
        const store = data.getStore();
        const linked = new Set((await store.read('posts')).posts.map((p) => p.igMediaId).filter(Boolean));
        const list = Object.values((await store.read('analytics-media')).media || {})
          .filter((m) => m.productType !== 'STORY' && m.permalink && !linked.has(m.id))
          .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
        if (list.length >= 2) return list.slice(0, 2);
        await new Promise((r) => setTimeout(r, 1000));
      }
      return [];
    });
    assert.equal(media.length, 2, 'Instagram media to post by hand');
    const [saved, live] = media;
    const dayOf = (ts) =>
      page.evaluate(async (x) => {
        const t = await import('/postpilot/core/time.js');
        const data = await import('/postpilot/js/data.js');
        return t.dayKey(new Date(x), (await data.getStore().read('settings')).timezone);
      }, ts);
    // Before: the planner's Day view shows the Instagram post as "Published on Instagram".
    await go(page, `#/planner?view=day&date=${await dayOf(saved.timestamp)}`);
    await page.locator(`.pl-dayview a.is-ig[href="${saved.permalink}"]`).waitFor();
    const at = new Date(Date.now() - 600e3).toISOString();
    const reminded = (caption) => addPost({ status: 'reminded', publishMode: 'reminder', caption, scheduledAt: at, reminderSentAt: at });

    // 1. A link to a post whose numbers Postpilot already saved: linked at once. A profile link is refused,
    //    the share query (?igsh=…) is dropped.
    const first = await reminded('E2E posted by hand, saved media.');
    await go(page, `#/post-now/${first}`);
    await page.locator('.pn-steps').waitFor();
    assert.equal((await page.locator('.pn-status .status').textContent()).trim(), 'Post by hand');
    const box = page.getByRole('textbox', { name: 'Link to the post' });
    await box.fill('https://www.instagram.com/studio.north/');
    await page.getByRole('button', { name: 'Mark as posted' }).click();
    await page.getByText('Paste the link to the post, starting with https://www.instagram.com/').waitFor();
    await box.fill(`  ${saved.permalink}?igsh=ZTJlLXRlc3Q=  `);
    await page.getByRole('button', { name: 'Mark as posted' }).click();
    await page.locator('.callout', { hasText: 'Already posted' }).waitFor();
    let post = (await readPosts()).find((p) => p.id === first);
    assert.equal(post.status, 'published');
    assert.equal(post.igMediaId, saved.id, 'linked to its Instagram media');
    assert.equal(post.permalink, saved.permalink, 'the clean link');
    assert.match(post.history.find((e) => e.event === 'posted by hand').detail, /matched to the Instagram post/);

    // 2. A post Postpilot has no numbers for yet: looked up on Instagram (the newest posts).
    await page.evaluate(async (id) => {
      const data = await import('/postpilot/js/data.js');
      await data.mutate('analytics-media', (doc) => void delete doc.media[id], { message: 'e2e: not saved yet' });
    }, live.id);
    try {
      const second = await reminded('E2E posted by hand, live lookup.');
      await go(page, `#/post-now/${second}`);
      await page.locator('.pn-steps').waitFor();
      await page.getByRole('textbox', { name: 'Link to the post' }).fill(live.permalink.replace(/^https:\/\/www\./, ''));
      await page.getByRole('button', { name: 'Mark as posted' }).click();
      await page.locator('.callout', { hasText: 'Already posted' }).waitFor();
      post = (await readPosts()).find((p) => p.id === second);
      assert.equal(post.igMediaId, live.id, 'found among the newest posts on Instagram');
      assert.equal(post.permalink, live.permalink);
    } finally {
      await page.evaluate(async (m) => {
        const data = await import('/postpilot/js/data.js');
        await data.mutate('analytics-media', (doc) => void (doc.media[m.id] = doc.media[m.id] || m), { message: 'e2e: restore media' });
      }, live);
    }

    // 3. The planner shows each once: no separate "Published on Instagram" item, one grid tile.
    for (const m of [saved, live]) {
      await go(page, `#/planner?view=day&date=${await dayOf(m.timestamp)}`);
      await page.locator('.pl-dayview').waitFor();
      await page.waitForTimeout(300);
      assert.equal(await page.locator(`.pl-dayview a.is-ig[href="${m.permalink}"]`).count(), 0, `${m.permalink} is not shown apart from its post`);
    }
    await go(page, '#/planner?view=grid');
    await page.locator('.pl-ig-grid').waitFor();
    await page.locator(`.pl-tile.is-published[href="${saved.permalink}"]`).first().waitFor();
    for (const m of [saved, live]) assert.equal(await page.locator(`.pl-tile.is-published[href="${m.permalink}"]`).count(), 1, `one grid tile for ${m.permalink}`);
  });

  test('remind me again in 1 hour puts the post back on the schedule', async () => {
    const id = await addPost({ status: 'reminded', publishMode: 'reminder', type: 'story', caption: 'E2E story with a link sticker.', scheduledAt: new Date(Date.now() - 600e3).toISOString(), reminderSentAt: new Date().toISOString() }, 'Story: kiln opening');
    await go(page, `#/post-now/${id}`);
    await page.locator('.pn-steps').waitFor();
    assert.match(await page.locator('.page-title').textContent(), /Post your story/);
    await page.getByRole('button', { name: 'Copy text' }).waitFor();
    await page.getByRole('button', { name: 'Remind me again in 1 hour' }).click();
    await toast(page, /another reminder/);
    await page.waitForFunction(() => location.hash === '#/' || location.hash === '');
    const post = (await readPosts()).find((p) => p.id === id);
    assert.equal(post.status, 'scheduled');
    assert.equal(post.reminderSentAt, null);
    const inMin = (Date.parse(post.scheduledAt) - Date.now()) / 60e3;
    assert.ok(inMin > 55 && inMin <= 60, `about an hour from now (${inMin.toFixed(1)} min)`);
    assert.ok(post.history.some((e) => e.event === 'remind again'));
    // The planned reminder shows among the upcoming posts on Today.
    await page.locator('.dash-upnext .dash-post', { hasText: 'E2E story with a link sticker' }).locator('.dash-post-src', { hasText: 'Reminder' }).waitFor({ timeout: 20_000 });
  });

  test('"Post by hand now" in the composer opens the steps right away', async () => {
    await page.locator('.sidebar .compose-button').click();
    await drawer(page).waitFor();
    await drawer(page).getByRole('button', { name: 'Library', exact: true }).click();
    const modal = page.locator('.mp-modal');
    await modal.locator('.mp-tile[aria-label*="Night hills"]').first().click();
    await modal.locator('.overlay-foot').getByRole('button', { name: /^(Add|Use)/ }).click();
    await modal.waitFor({ state: 'detached' });
    await page.locator('#cmp-caption').fill('E2E by hand now.');
    await page.getByRole('radio', { name: /Send me a reminder/ }).check();
    await footer(page).getByRole('button', { name: 'Post by hand now' }).click();
    await drawer(page).waitFor({ state: 'detached' });
    await page.waitForFunction(() => location.hash.startsWith('#/post-now/'));
    await page.locator('.pn-steps').waitFor();
    const post = (await readPosts()).find((p) => p.caption === 'E2E by hand now.');
    assert.equal(post.status, 'reminded');
    assert.equal(post.publishMode, 'reminder');
    assert.equal(post.reminderSentAt, null);
    // No reminder went out, so the page does not say one did.
    assert.equal((await page.locator('.page-subtitle').textContent()).trim(), 'Follow the steps, then mark it as posted.');
    // Opening it in the composer offers the steps again.
    await page.getByRole('link', { name: 'Today' }).first().click();
    await page.locator('.dash-hand .dash-post', { hasText: 'E2E by hand now' }).waitFor();
    await page.evaluate(() => (location.hash = '#/planner?view=list'));
  });

  test('unknown and already-posted ids explain themselves', async () => {
    await go(page, '#/post-now/p_does_not_exist');
    await page.getByText('This post is not in Postpilot').waitFor();
    await page.getByRole('link', { name: 'Open the planner' }).waitFor();
    const posts = await readPosts();
    const published = posts.find((p) => p.status === 'published' && p.igMediaId);
    await go(page, `#/post-now/${published.id}`);
    await page.locator('.callout', { hasText: 'Already posted' }).waitFor();
    assert.equal(await page.locator('.pn-steps').count(), 0);
  });

  test('mark as posted counts the use of an evergreen queue item (or drops it when the queue does not repeat)', async () => {
    const ids = await page.evaluate(async () => {
      const data = await import('/postpilot/js/data.js');
      const { newList, newPost, uid } = await import('/postpilot/core/model.js');
      const lib = await data.getStore().read('library');
      const a = lib.assets.find((x) => x.name === 'Vase trio');
      const media = [{ assetId: a.id, kind: 'image', altText: '' }];
      const once = newList({ name: 'E2E once', enabled: false, repeat: false, items: [{ id: uid('li_'), type: 'feed', caption: 'Once only', media, timesUsed: 0 }] });
      const again = newList({ name: 'E2E repeats', enabled: false, repeat: true, items: [{ id: uid('li_'), type: 'feed', caption: 'Every time', media, timesUsed: 2 }] });
      await data.mutate('lists', (doc) => void doc.lists.push(once, again), { message: 'e2e: lists' });
      const at = new Date(Date.now() - 600e3).toISOString();
      const mk = (list) => newPost({ status: 'reminded', publishMode: 'reminder', source: 'evergreen', listId: list.id, listItemId: list.items[0].id, caption: list.items[0].caption, media, scheduledAt: at, reminderSentAt: at });
      const p1 = mk(once);
      const p2 = mk(again);
      await data.mutate('posts', (doc) => void doc.posts.push(p1, p2), { message: 'e2e: queue reminders' });
      return { once: once.id, again: again.id, p1: p1.id, p2: p2.id };
    });
    for (const id of [ids.p1, ids.p2]) {
      await go(page, `#/post-now/${id}`);
      await page.locator('.pn-steps').waitFor();
      await page.getByRole('button', { name: 'Mark as posted' }).click();
      await page.locator('.callout', { hasText: 'Already posted' }).waitFor();
    }
    const lists = await page.evaluate(async () => {
      const data = await import('/postpilot/js/data.js');
      await data.refreshNow();
      return (await data.getStore().read('lists')).lists;
    });
    assert.equal(lists.find((l) => l.id === ids.once).items.length, 0, 'a queue that does not repeat drops the item');
    const item = lists.find((l) => l.id === ids.again).items[0];
    assert.equal(item.timesUsed, 3);
    assert.ok(Date.parse(item.lastUsedAt) > Date.now() - 120_000);
    await page.evaluate(async (ids) => {
      const data = await import('/postpilot/js/data.js');
      await data.mutate('lists', (doc) => void (doc.lists = doc.lists.filter((l) => l.id !== ids.once && l.id !== ids.again)), { message: 'e2e: clean up' });
    }, ids);
  });

  test('the post-by-hand page opens while Instagram is disconnected', async () => {
    const id = await addPost({ status: 'reminded', publishMode: 'reminder', caption: 'E2E while disconnected', scheduledAt: new Date(Date.now() - 600e3).toISOString(), reminderSentAt: new Date().toISOString() });
    const saved = await page.evaluate(async () => {
      const data = await import('/postpilot/js/data.js');
      let ig = null;
      await data.mutate('settings', (s) => {
        ig = s.ig;
        s.ig = null;
      }, { message: 'e2e: disconnect' });
      return ig;
    });
    try {
      await go(page, `#/post-now/${id}`);
      await page.locator('.pn-steps').waitFor({ timeout: 20_000 });
      assert.match(await page.locator('.page-title').textContent(), /Post your post/);
      assert.equal(await page.getByText('Connect your Instagram account').count(), 0, 'not sent to onboarding');
    } finally {
      await page.evaluate(async (ig) => {
        const data = await import('/postpilot/js/data.js');
        await data.mutate('settings', (s) => void (s.ig = ig), { message: 'e2e: reconnect' });
      }, saved);
    }
    await go(page, '#/');
    await page.locator('.dash-account').waitFor({ timeout: 20_000 });
  });

  test('screenshots on desktop and phone, light and dark, without horizontal overflow', async () => {
    const id = await addPost({
      status: 'reminded',
      publishMode: 'reminder',
      type: 'carousel',
      caption: 'Swipe through the glaze tests.\n\n#ceramics #glaze',
      firstComment: 'Which one wins?',
      notes: 'Add the poll sticker and music from the library.',
      collaborators: ['atelier.kin'],
      location: { id: '', name: 'Studio North' },
      scheduledAt: new Date(Date.now() - 1200e3).toISOString(),
      reminderSentAt: new Date(Date.now() - 900e3).toISOString(),
    });
    await page.evaluate(async (id) => {
      const data = await import('/postpilot/js/data.js');
      const lib = await data.getStore().read('library');
      const b = lib.assets.find((a) => a.name === 'Night hills');
      await data.mutate('posts', (doc) => {
        const p = doc.posts.find((x) => x.id === id);
        p.media.push({ assetId: b.id, kind: 'image', altText: '' });
      });
    }, id);
    const publishedId = (await readPosts()).find((p) => p.status === 'published' && p.igMediaId).id;
    for (const [w, hgt, scheme] of [[1280, 860, 'light'], [1280, 860, 'dark'], [390, 844, 'light'], [390, 844, 'dark']]) {
      const ctx = await h.browser.newContext({ viewport: { width: w, height: hgt }, colorScheme: scheme });
      const p = await ctx.newPage();
      const errs = [];
      p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
      p.on('pageerror', (e) => errs.push(String(e)));
      await p.goto(`${h.url}/postpilot/index.html#/post-now/${id}`);
      await unlock(p);
      await p.locator('.pn-media img[src^="blob:"]').first().waitFor({ timeout: 20_000 });
      await snap(p, `post-now-${w}-${scheme}`);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `no horizontal page overflow at ${w}px (${overflow})`);
      if (w < 760) {
        // Short states (unknown post, already posted) do not stretch the phone top bar.
        for (const hash of ['#/post-now/p_does_not_exist', `#/post-now/${publishedId}`]) {
          await p.evaluate((x) => (location.hash = x), hash);
          await p.locator('.pn .empty, .pn .callout').first().waitFor();
          const bar = await p.evaluate(() => document.querySelector('.mobile-topbar').getBoundingClientRect().height);
          assert.ok(bar <= 60, `top bar keeps its height on ${hash} (${bar}px)`);
        }
        await snap(p, `post-now-published-${w}-${scheme}`);
      }
      await p.evaluate(() => (location.hash = '#/'));
      await p.locator('.dash-hand').waitFor({ timeout: 20_000 });
      await p.waitForTimeout(600);
      await p.locator('.dash-hand').screenshot({ path: path.join(SHOTS, `today-by-hand-${w}-${scheme}.png`) });
      assert.deepEqual(errs.filter((e) => !/favicon/i.test(e)), [], `no console errors (${w} ${scheme})`);
      await ctx.close();
    }
  });

  test('no console errors', () => {
    assert.deepEqual(h.consoleErrors.filter((e) => !/favicon/i.test(e)), []);
  });
});
