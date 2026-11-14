// E2E: Competitors + Hashtags screens against the seeded dev server.
// Run: node --test tests/e2e/research.spec.mjs
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, shot, unlock } from './helpers.mjs';

const PORT = 5217;
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/claude-0/-home-user-claude/61a6d9a0-a933-5d86-8721-920a439be9c7/scratchpad/shots';
const BENIGN = [/favicon/i, /Failed to load resource: the server responded with a status of 404/i];

let h;
let page;

async function go(hash) {
  await page.evaluate((hsh) => (location.hash = hsh), hash);
  await page.waitForSelector('.page-title');
}

async function setMode(p, mode) {
  await p.evaluate(async (m) => {
    const data = await import('/postpilot/js/data.js');
    await data.mutate('settings', (d) => {
      d.ig.mode = m;
    });
  }, mode);
}

async function readDoc(p, name) {
  return p.evaluate(async (n) => {
    const data = await import('/postpilot/js/data.js');
    return data.readDoc(n);
  }, name);
}

/** Screenshot after toasts are dismissed and open/close animations finished. */
async function snap(p, name) {
  await p.evaluate(() => document.querySelectorAll('.toast-close').forEach((b) => b.click()));
  if (await p.locator('.overlay').count()) {
    // Full-page captures resize the viewport, which replays the drawer animation: capture the viewport.
    await p.waitForTimeout(450);
    const file = `${SHOT_DIR}/${name}.png`;
    await p.screenshot({ path: file });
    return file;
  }
  // Load lazy images below the fold so the full-page capture shows them.
  await p.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
  });
  await p.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(300);
  return shot(p, name);
}

/** Open a kit Menu. The kit closes menus on any scroll, so scroll the trigger into view first. */
async function openMenu(trigger) {
  await trigger.scrollIntoViewIfNeeded();
  await trigger.page().waitForTimeout(150);
  await trigger.click();
  await trigger.page().locator('.menu-pop').waitFor();
}

async function confirmDialog(p, label) {
  const dialog = p.locator('.modal-confirm');
  await dialog.waitFor();
  await dialog.getByRole('button', { name: label }).click();
  await dialog.waitFor({ state: 'detached' });
}

async function toastText(p, re) {
  const t = p.locator('.toast', { hasText: re }).first();
  await t.waitFor({ timeout: 10_000 });
  return t.textContent();
}

/** Open a phone/dark context on the same server, unlocked, at `hash`. */
async function extraPage({ viewport, colorScheme, hash }) {
  const ctx = await h.browser.newContext({ viewport, colorScheme });
  const p = await ctx.newPage();
  const errors = [];
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`${h.url}/postpilot/index.html${hash}`);
  await unlock(p);
  await p.waitForSelector('.page-title');
  return { p, ctx, errors };
}

async function noHorizontalScroll(p) {
  const { sw, cw } = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(sw <= cw + 1, `page scrolls horizontally (${sw} > ${cw})`);
}

const realErrors = (list) => list.filter((e) => !BENIGN.some((re) => re.test(e)));

describe('Competitors and Hashtags', { timeout: 240_000 }, () => {
  before(async () => {
    h = await openApp({ port: PORT, hash: '#/competitors' });
    page = h.page;
    await h.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: h.url });
    await page.waitForSelector('.page-title');
  });

  after(async () => {
    await h?.close();
  });

  // Keep one failure from cascading: close any dialog a failed test left open.
  afterEach(async () => {
    for (let i = 0; i < 4 && (await page.locator('.overlay').count()); i++) await page.keyboard.press('Escape');
  });

  test('competitors: Instagram Login explains Facebook Login and still manages the list', async () => {
    await go('#/competitors');
    await page.getByText('Competitor numbers need Facebook Login').waitFor();
    const table = page.locator('table.table');
    await table.waitFor();
    const text = await table.textContent();
    for (const u of ['@studio.north', '@atelier.kin', '@northbound.coffee', '@lumen.ceramics']) assert.ok(text.includes(u), `${u} missing from table`);
    // Own account comes first with real numbers from analytics.
    const firstRow = await page.locator('table.table tbody tr').first().textContent();
    assert.match(firstRow, /You/);
    assert.match(firstRow, /4,8\d\d/);
    // No Refresh button without Facebook Login.
    assert.equal(await page.getByRole('button', { name: 'Refresh now' }).count(), 0);

    // Adding without Facebook Login stores the name without checking it.
    await page.getByLabel('Add an account').fill('@Kiln.Club');
    await page.getByRole('button', { name: 'Add account' }).click();
    await toastText(page, /Added @kiln\.club/);
    await page.locator('table.table', { hasText: '@kiln.club' }).waitFor();

    // Duplicate and invalid names are rejected inline.
    await page.getByLabel('Add an account').fill('atelier.kin');
    await page.getByRole('button', { name: 'Add account' }).click();
    await page.getByText('@atelier.kin is already on your list.').waitFor();
    await page.getByLabel('Add an account').fill('not a name!');
    await page.getByRole('button', { name: 'Add account' }).click();
    await page.getByText('Enter an Instagram username, like atelier.kin.').waitFor();

    // Remove two accounts (confirm first).
    for (const u of ['kiln.club', 'lumen.ceramics']) {
      await openMenu(page.getByRole('button', { name: `Actions for @${u}` }));
      await page.getByRole('menuitem', { name: 'Remove' }).click();
      await confirmDialog(page, 'Remove');
      await toastText(page, new RegExp(`Stopped tracking @${u.replace('.', '\\.')}`));
    }
    const doc = await readDoc(page, 'competitors');
    assert.deepEqual(doc.accounts.map((a) => a.username || a).sort(), ['atelier.kin', 'northbound.coffee']);
    assert.ok(!(await page.locator('table.table').textContent()).includes('@lumen.ceramics'));
    await snap(page, 'competitors-ig-mode-desktop-light');
  });

  test('competitors: composer styles do not reshape the page (no shared class names)', async () => {
    await go('#/competitors');
    // The planner, queues, autopilot and composer load composer.css for the rest of the session.
    await page.evaluate(async () => {
      const { loadViewCss } = await import('/postpilot/js/css.js');
      loadViewCss('composer');
      const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find((l) => l.href.includes('/css/views/composer.css'));
      for (let i = 0; i < 100 && !(link.sheet && link.sheet.cssRules.length); i++) await new Promise((r) => setTimeout(r, 50));
    });
    const form = page.locator('form', { has: page.getByLabel('Add an account') });
    const style = await form.evaluate((f) => {
      const cs = getComputedStyle(f);
      return { dir: cs.flexDirection, width: f.getBoundingClientRect().width, border: cs.borderTopStyle };
    });
    assert.equal(style.dir, 'row');
    assert.equal(style.border, 'none');
    assert.ok(style.width > 400, `add form is ${style.width}px wide`);
    assert.equal(await page.locator('.page [class*="cmp-"]').count(), 0, 'Competitors uses the composer class prefix');
  });

  test('competitors: Facebook Login validates, adds, refreshes and shows posts', async () => {
    await setMode(page, 'facebook');
    await go('#/competitors');
    await page.getByRole('button', { name: 'Refresh now' }).waitFor();
    assert.equal(await page.getByText('Competitor numbers need Facebook Login').count(), 0);

    // Start from an empty list, then add both accounts through the live check.
    for (const u of ['atelier.kin', 'northbound.coffee']) {
      await openMenu(page.getByRole('button', { name: `Actions for @${u}` }));
      await page.getByRole('menuitem', { name: 'Remove' }).click();
      await confirmDialog(page, 'Remove');
    }
    await page.getByText('No accounts tracked yet').waitFor();

    // Unknown account: Instagram's error is shown on the field.
    await page.getByLabel('Add an account').fill('nobody.here.zz');
    await page.getByRole('button', { name: 'Add account' }).click();
    await page.getByText(/Instagram could not find @nobody\.here\.zz/).waitFor();
    // Chromium logs the Graph API's 400 for the unknown account; that one is expected.
    const i400 = h.consoleErrors.findIndex((e) => /status of 400/.test(e));
    assert.ok(i400 >= 0, 'expected the 400 from Business Discovery');
    h.consoleErrors.splice(i400, 1);

    for (const u of ['atelier.kin', 'northbound.coffee']) {
      await page.getByLabel('Add an account').fill(u);
      await page.getByRole('button', { name: 'Add account' }).click();
      await toastText(page, new RegExp(`Added @${u.replace('.', '\\.')}\\.`));
    }
    const table = page.locator('table.table');
    await table.locator('tr', { hasText: '@atelier.kin' }).locator('td', { hasText: '12,480' }).waitFor();
    await table.locator('tr', { hasText: '@northbound.coffee' }).locator('td', { hasText: '8,930' }).waitFor();
    let doc = await readDoc(page, 'competitors');
    assert.equal(Object.keys(doc.snapshots['atelier.kin']).length, 1);
    assert.equal(doc.posts['atelier.kin'].length, 12);
    assert.equal(doc.profiles['northbound.coffee'].name, 'Northbound Coffee');
    const er = doc.snapshots['atelier.kin'][Object.keys(doc.snapshots['atelier.kin'])[0]].er;
    assert.ok(er > 0 && er < 1, `engagement rate ${er}`);

    // Charts render with data (line for followers, bars for engagement).
    await page.locator('.chart-line svg').first().waitFor();
    await page.locator('.chart-hbar svg').first().waitFor();
    await page.getByRole('radio', { name: 'Change %' }).click();
    await page.locator('.chart-line svg').first().waitFor();
    await page.getByRole('radio', { name: 'Followers' }).click();

    // Refresh now updates every account.
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await toastText(page, /Updated 2 accounts\./);
    doc = await readDoc(page, 'competitors');
    assert.ok(doc.profiles['atelier.kin'].updatedAt);

    await snap(page, 'competitors-fb-desktop-light');

    // Drawer with recent and best posts.
    await table.locator('tr', { hasText: '@atelier.kin' }).click();
    const drawer = page.locator('.drawer');
    await drawer.getByRole('heading', { name: 'Atelier Kin' }).waitFor();
    await drawer.getByText('Best recent posts').waitFor();
    assert.equal(await drawer.locator('.cpt-sheet .frame').count(), 12);
    assert.equal(await drawer.locator('.cpt-best').count(), 3);
    const href = await drawer.locator('.cpt-tile').first().getAttribute('href');
    assert.match(href, /^https:\/\/www\.instagram\.com\/p\//);
    await snap(page, 'competitors-drawer-desktop-light');
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });
  });

  test('hashtags: sets CRUD with x/5 guidance and copy', async () => {
    await go('#/hashtags');
    await page.getByRole('tab', { name: /Sets/ }).waitFor();
    const ceramics = page.locator('.ht-card', { hasText: 'Ceramics' });
    await ceramics.waitFor();
    assert.equal((await ceramics.locator('.ht-count .num').textContent()).trim(), '6/5');
    assert.match(await ceramics.locator('.ht-count').getAttribute('class'), /is-warn/);
    assert.equal(await ceramics.locator('.chip.ht-extra').count(), 1);
    const coffee = page.locator('.ht-card', { hasText: 'Coffee' });
    assert.equal((await coffee.locator('.ht-count .num').textContent()).trim(), '4/5');
    assert.match(await coffee.locator('.ht-count').getAttribute('class'), /is-ok/);
    await snap(page, 'hashtags-sets-desktop-light');

    // Create
    await page.getByRole('button', { name: 'New set' }).click();
    const modal = page.locator('.modal');
    await modal.getByLabel('Name').fill('Glaze week');
    const chipInput = modal.getByRole('textbox', { name: 'Hashtags' });
    await chipInput.fill('#Glaze, ceramicart, glazetest');
    await chipInput.press('Enter');
    assert.equal((await modal.locator('.ht-count .num').textContent()).trim(), '3/5');
    await chipInput.fill('kiln, studio, potterylove');
    await chipInput.press('Enter');
    await chipInput.fill('not valid!');
    await chipInput.press('Enter');
    assert.equal((await modal.locator('.ht-count .num').textContent()).trim(), '6/5');
    await modal.locator('.callout', { hasText: 'may be ignored' }).waitFor();
    await snap(page, 'hashtags-set-editor-desktop-light');
    await modal.getByRole('button', { name: 'Create set' }).click();
    await modal.waitFor({ state: 'detached' });
    await toastText(page, /Set “Glaze week” saved/);
    const card = page.locator('.ht-card', { hasText: 'Glaze week' });
    await card.waitFor();
    assert.equal((await card.locator('.ht-count .num').textContent()).trim(), '6/5');
    let doc = await readDoc(page, 'hashtags');
    const created = doc.sets.find((s) => s.name === 'Glaze week');
    assert.deepEqual(created.tags, ['#glaze', '#ceramicart', '#glazetest', '#kiln', '#studio', '#potterylove']);

    // Copy
    await card.getByRole('button', { name: 'Copy Glaze week hashtags' }).click();
    await toastText(page, /Copied 6 hashtags/);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(clip, '#glaze #ceramicart #glazetest #kiln #studio #potterylove');

    // Edit: rename and drop a tag back to 5
    await openMenu(card.getByRole('button', { name: 'More actions for Glaze week' }));
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await modal.getByLabel('Name').fill('Glaze notes');
    await modal.getByRole('button', { name: 'Remove #potterylove' }).click();
    assert.equal((await modal.locator('.ht-count .num').textContent()).trim(), '5/5');
    await modal.getByRole('button', { name: 'Save set' }).click();
    await modal.waitFor({ state: 'detached' });
    await toastText(page, /Set “Glaze notes” saved/);
    doc = await readDoc(page, 'hashtags');
    assert.equal(doc.sets.find((s) => s.id === created.id).tags.length, 5);

    // Validation
    await page.getByRole('button', { name: 'New set' }).click();
    await modal.getByRole('button', { name: 'Create set' }).click();
    await modal.getByText('Give the set a name.').waitFor();
    await modal.getByText('Add at least one hashtag.').waitFor();
    await modal.getByRole('button', { name: 'Cancel' }).click();

    // Delete
    const renamed = page.locator('.ht-card', { hasText: 'Glaze notes' });
    await openMenu(renamed.getByRole('button', { name: 'More actions for Glaze notes' }));
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await confirmDialog(page, 'Delete');
    await toastText(page, /Deleted “Glaze notes”/);
    await renamed.waitFor({ state: 'detached' });
    doc = await readDoc(page, 'hashtags');
    assert.equal(doc.sets.length, 3);
  });

  test('hashtags: caption templates and saved replies', async () => {
    await page.getByRole('tab', { name: /Caption templates/ }).click();
    await page.locator('.ht-card', { hasText: 'New drop' }).waitFor();
    assert.match(page.url(), /tab=templates/);
    await page.getByRole('button', { name: 'New template' }).click();
    const modal = page.locator('.modal');
    await modal.getByLabel('Name').fill('Kiln opening');
    await modal.getByLabel('Caption').fill('Kiln opening on {date}! Come see {product}.\n\n#ceramics #kiln');
    await modal.locator('.badge', { hasText: '{date}' }).waitFor();
    await modal.locator('.badge', { hasText: '{product}' }).waitFor();
    assert.equal((await modal.locator('.ht-count .num').textContent()).trim(), '2/5');
    await modal.getByRole('button', { name: 'Create template' }).click();
    await modal.waitFor({ state: 'detached' });
    await toastText(page, /Template “Kiln opening” saved/);
    const tcard = page.locator('.ht-card', { hasText: 'Kiln opening' });
    await tcard.waitFor();
    await openMenu(tcard.getByRole('button', { name: 'More actions for Kiln opening' }));
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await modal.getByLabel('Caption').fill('Kiln opening on {date}.');
    await modal.getByRole('button', { name: 'Save template' }).click();
    await modal.waitFor({ state: 'detached' });
    await toastText(page, /Template “Kiln opening” saved/);
    let doc = await readDoc(page, 'hashtags');
    assert.equal(doc.templates.find((t) => t.name === 'Kiln opening').text, 'Kiln opening on {date}.');
    await snap(page, 'hashtags-templates-desktop-light');
    await openMenu(tcard.getByRole('button', { name: 'More actions for Kiln opening' }));
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await confirmDialog(page, 'Delete');
    await tcard.waitFor({ state: 'detached' });

    await page.getByRole('tab', { name: /Saved replies/ }).click();
    await page.locator('.ht-card', { hasText: 'Shipping' }).waitFor();
    await page.getByRole('button', { name: 'New reply' }).click();
    await modal.getByLabel('Name').fill('Restock');
    await modal.getByLabel('Reply').fill('The next restock is Friday at noon. Turn on post notifications so you do not miss it.');
    await modal.getByRole('button', { name: 'Create reply' }).click();
    await modal.waitFor({ state: 'detached' });
    await toastText(page, /Reply “Restock” saved/);
    const rcard = page.locator('.ht-card', { hasText: 'Restock' });
    await rcard.waitFor();
    await rcard.getByRole('button', { name: 'Copy Restock' }).click();
    await toastText(page, /Copied reply/);
    doc = await readDoc(page, 'hashtags');
    assert.equal(doc.savedReplies.length, 4);
    await openMenu(rcard.getByRole('button', { name: 'More actions for Restock' }));
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await confirmDialog(page, 'Delete');
    await rcard.waitFor({ state: 'detached' });
    doc = await readDoc(page, 'hashtags');
    assert.equal(doc.savedReplies.length, 3);
  });

  test('hashtags: research needs Facebook Login, then searches and tracks the weekly budget', async () => {
    await setMode(page, 'instagram');
    await page.getByRole('tab', { name: 'Research' }).click();
    await page.getByText('Hashtag research needs Facebook Login').waitFor();
    await setMode(page, 'facebook');
    await page.getByRole('heading', { name: 'Look up a hashtag' }).waitFor();

    await page.getByLabel('Hashtag', { exact: true }).fill('#Ceramics');
    await page.getByRole('button', { name: 'Search' }).click();
    const results = page.locator('.panel', { has: page.getByRole('heading', { name: '#ceramics' }) });
    await results.waitFor();
    assert.equal(await results.locator('.ht-sheet .frame').count(), 18);
    await results.getByRole('button', { name: 'Show all 30 posts' }).click();
    assert.equal(await results.locator('.ht-sheet .frame').count(), 30);
    await page.locator('.ht-budget', { hasText: '1 of 30 used' }).waitFor();

    // Recent is free for a hashtag already looked up this week.
    await page.getByRole('radio', { name: 'Recent' }).click();
    await results.getByText(/Recent posts, last 24 hours/).waitFor();
    await page.locator('.ht-budget', { hasText: '1 of 30 used' }).waitFor();
    await snap(page, 'hashtags-research-desktop-light');

    // Pick a related hashtag and add both to the Coffee set.
    const chips = results.locator('.ht-chips .chip');
    let related = null;
    let relatedTag = null;
    for (let i = 0; i < (await chips.count()); i++) {
      const tag = (await chips.nth(i).locator('.chip-label').textContent()).trim().split(/\s+/)[0];
      if (tag !== '#coffeetime') {
        related = chips.nth(i);
        relatedTag = tag;
        break;
      }
    }
    await related.locator('button').click();
    await openMenu(results.getByRole('button', { name: /Add 2 to set/ }));
    await page.getByRole('menuitem', { name: /Coffee/ }).click();
    await toastText(page, /Added 2 hashtags to Coffee/);
    let doc = await readDoc(page, 'hashtags');
    const coffee = doc.sets.find((s) => s.name === 'Coffee');
    assert.ok(coffee.tags.includes('#ceramics'));
    assert.ok(coffee.tags.includes(relatedTag), `${relatedTag} not added`);

    await page.getByLabel('Hashtag', { exact: true }).fill('pottery');
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByRole('heading', { name: '#pottery' }).waitFor();
    await page.locator('.ht-budget', { hasText: '2 of 30 used' }).waitFor();
    doc = await readDoc(page, 'hashtags');
    assert.deepEqual(doc.tracked.map((t) => t.tag).sort(), ['ceramics', 'pottery']);

    // Budget exhausted: a new hashtag is refused, a known one still works.
    await page.evaluate(async () => {
      const data = await import('/postpilot/js/data.js');
      const now = Date.now();
      await data.mutate('hashtags', (d) => {
        for (let i = 0; i < 28; i++) d.tracked.push({ tag: `filler${i}`, id: `x${i}`, firstAt: new Date(now - i * 3600e3).toISOString(), lastAt: new Date(now).toISOString() });
      });
    });
    await page.locator('.ht-budget', { hasText: '30 of 30 used' }).waitFor();
    await page.getByLabel('Hashtag', { exact: true }).fill('wheelthrown');
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByText(/Instagram’s limit/).waitFor();
    await page.getByRole('button', { name: 'Show posts for #ceramics' }).click();
    await page.getByRole('heading', { name: '#ceramics' }).waitFor();
  });

  test('hashtags: performance of your own hashtags', async () => {
    await page.getByRole('tab', { name: 'Performance' }).click();
    await page.getByRole('heading', { name: 'Best hashtags by engagement' }).waitFor();
    const rows = page.locator('.ht-perf .table-wrap table.table tbody tr');
    await rows.first().waitFor();
    assert.ok((await rows.count()) > 3);
    await page.locator('.ht-perf .chart-hbar svg').waitFor();
    await page.getByRole('radio', { name: '5 posts' }).click();
    await snap(page, 'hashtags-performance-desktop-light');
    await openMenu(rows.first().getByRole('button', { name: /Add/ }));
    await page.getByRole('menuitem', { name: 'New set…' }).click();
    const modal = page.locator('.modal');
    await modal.getByLabel('Name').fill('Best performers');
    assert.equal(await modal.locator('.chip').count(), 1);
    await modal.getByRole('button', { name: 'Create set' }).click();
    await modal.waitFor({ state: 'detached' });
    await toastText(page, /Set “Best performers” saved/);
  });

  test('no console errors on desktop', () => {
    assert.deepEqual(realErrors(h.consoleErrors), []);
  });

  test('phone and dark mode render without horizontal scroll', async () => {
    const combos = [
      { name: 'phone-light', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
      { name: 'phone-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
      { name: 'desktop-dark', viewport: { width: 1280, height: 860 }, colorScheme: 'dark' },
    ];
    for (const c of combos) {
      const { p, ctx, errors } = await extraPage({ ...c, hash: '#/competitors' });
      await p.getByText('@atelier.kin').first().waitFor();
      await noHorizontalScroll(p);
      await snap(p, `competitors-${c.name}`);
      if (c.name === 'phone-light') {
        await p.locator('.cpt-list-main', { hasText: '@northbound.coffee' }).click();
        await p.locator('.drawer').getByRole('heading', { name: 'Recent posts', exact: true }).waitFor();
        await snap(p, 'competitors-drawer-phone-light');
        await p.keyboard.press('Escape');
      }
      for (const tab of ['sets', 'research', 'performance', 'templates']) {
        await p.evaluate((t) => (location.hash = `#/hashtags?tab=${t}`), tab);
        await p.waitForSelector('.ht-page');
        if (tab === 'sets') await p.locator('.ht-card').first().waitFor();
        if (tab === 'research') {
          await p.getByLabel('Hashtag', { exact: true }).fill('pottery');
          await p.getByRole('button', { name: 'Search' }).click();
          await p.getByRole('heading', { name: '#pottery' }).waitFor();
        }
        if (tab === 'performance') await p.locator('.ht-perf-list, .ht-perf table.table').first().waitFor();
        if (tab === 'templates') await p.locator('.ht-card').first().waitFor();
        await noHorizontalScroll(p);
        await snap(p, `hashtags-${tab}-${c.name}`);
      }
      assert.deepEqual(realErrors(errors), [], `console errors in ${c.name}`);
      await ctx.close();
    }
  });
});
