// E2E: Analytics (all tabs, range switch, live fallback, CSV export, post drawer, audience refresh)
// and Reports (sections, AI summary, CSV, print stylesheet). Run: node --test tests/e2e/analytics.spec.mjs
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openApp, shot, unlock } from './helpers.mjs';

const PORT = 5213;
// A range before the worker's first snapshot (it saves the last 28 days) but within Instagram's 90 days.
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const OLD_FROM = daysAgo(63);
const OLD_TO = daysAgo(37);
const OLD_RANGE = `#/analytics?range=custom&from=${OLD_FROM}&to=${OLD_TO}`;
let h;
let page;

before(async () => {
  h = await openApp({ port: PORT, hash: '#/analytics' });
  page = h.page;
});

after(async () => {
  // If the dev server died mid-run, show why.
  if (h && h.server.child.exitCode !== null) console.log(`dev server exited (${h.server.child.exitCode}):\n${h.server.output().slice(-4000)}`);
  await h?.close();
});

async function go(hash) {
  await page.evaluate((x) => {
    location.hash = x;
  }, hash);
}

function tile(label) {
  return page.locator('.an-stats .stat').filter({ has: page.locator('.stat-label', { hasText: new RegExp(`^${label}$`) }) }).first();
}

async function tileValue(label) {
  return (await tile(label).locator('.stat-value').innerText()).trim();
}

async function waitForNumber(label) {
  await page.waitForFunction(
    (l) => {
      const t = [...document.querySelectorAll('.an-stats .stat')].find((s) => s.querySelector('.stat-label')?.textContent.trim() === l);
      return t && /\d/.test(t.querySelector('.stat-value')?.textContent || '');
    },
    label,
    { timeout: 20_000 },
  );
  return tileValue(label);
}

/** Open a kit Menu by its trigger name. The menu closes on any scroll, so start from the top and retry once. */
async function openMenu(p, name) {
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(150);
  for (let i = 0; i < 3; i++) {
    await p.getByRole('button', { name }).click();
    try {
      await p.getByRole('menuitem').first().waitFor({ timeout: 1500 });
      return;
    } catch {
      /* closed by a layout scroll; try again */
    }
  }
  throw new Error(`menu "${name}" did not open`);
}

async function openTab(name) {
  await page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
  await page.waitForFunction((n) => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim().startsWith(n), name);
}

async function prepareShot(p) {
  await p.mouse.move(1, 1);
  await p.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
  });
  await p.waitForTimeout(300);
}

test('overview renders numbers and charts from the seeded workspace', async () => {
  const reach = await waitForNumber('Reach');
  assert.match(reach, /^\d[\d,.]*K?$/);
  assert.match(await waitForNumber('Followers'), /\d/);
  assert.match(await waitForNumber('Engagement rate'), /%$/);
  assert.match(await waitForNumber('Posts published'), /^\d+$/);
  // Previous period comes live from the mock Instagram, so deltas appear.
  await page.waitForSelector('text=Previous period loaded live from Instagram', { timeout: 20_000 });
  assert.match(await tile('Reach').locator('.stat-delta').innerText(), /%/);
  assert.ok((await page.locator('.chart-line svg').count()) >= 3, 'line charts render');
  assert.equal(await page.locator('.an-top-card').count(), 3);
  assert.match(await page.locator('.an-freshness').innerText(), /Updated .* by the worker/);
});

test('range switch changes the numbers and the URL', async () => {
  const before28 = await waitForNumber('Reach');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.range-trigger').click();
  await page.getByRole('menuitem', { name: /Last 7 days/ }).click();
  await page.waitForFunction(() => location.hash.includes('range=7d'));
  await page.waitForFunction((v) => {
    const t = [...document.querySelectorAll('.an-stats .stat')].find((s) => s.querySelector('.stat-label')?.textContent.trim() === 'Reach');
    const now = t?.querySelector('.stat-value')?.textContent.trim();
    return now && /\d/.test(now) && now !== v;
  }, before28);
  assert.notEqual(await tileValue('Reach'), before28);
  assert.match(await page.locator('.range-trigger').innerText(), /Last 7 days/);

  // Compare off hides the deltas on the period tiles; on brings them back.
  await page.getByRole('switch', { name: /Compare with previous period/ }).click();
  await page.waitForFunction(() => location.hash.includes('compare=0'));
  assert.equal(await tile('Reach').locator('.stat-delta').count(), 0);
  await page.getByRole('switch', { name: /Compare with previous period/ }).click();
  await page.waitForFunction(() => !location.hash.includes('compare=0'));
  assert.equal(await tile('Reach').locator('.stat-delta').count(), 1);
});

test('a range the worker never saved loads live from Instagram', async () => {
  await go(OLD_RANGE);
  await page.waitForSelector('.an-source >> text=Live from Instagram', { timeout: 30_000 });
  assert.match(await waitForNumber('Reach'), /\d/);
  assert.match(await waitForNumber('Followers'), /\d/);
  assert.equal(await page.locator('input[aria-label="From"]').inputValue(), OLD_FROM);
  assert.equal(await page.locator('input[aria-label="To"]').inputValue(), OLD_TO);
  await go('#/analytics');
  await waitForNumber('Reach');
});

test('CSV export downloads daily metrics and posts', async () => {
  await openMenu(page, 'Export CSV');
  const [daily] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Daily metrics/ }).click()]);
  assert.match(daily.suggestedFilename(), /^postpilot-daily-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
  const text = (await readFile(await daily.path(), 'utf8')).replace(/^﻿/, '');
  const lines = text.split('\r\n');
  assert.match(lines[0], /^Date,Followers,New follows,Unfollows,Reach,Views/);
  assert.equal(lines.length, 1 + 28, 'header + 28 days');
  assert.match(lines[1], /^\d{4}-\d{2}-\d{2},\d+/);

  await openMenu(page, 'Export CSV');
  const [posts] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^Posts/ }).click()]);
  const ptext = (await readFile(await posts.path(), 'utf8')).replace(/^﻿/, '');
  assert.match(ptext.split('\r\n')[0], /^Date,Time,Type,Caption,Link,Reach/);
  assert.ok(ptext.split('\r\n').length > 2, 'at least one post row');
});

test('posts tab: table, type filter and the post drawer with a live refresh', async () => {
  await openTab('Posts');
  const rows = page.locator('[role="tabpanel"] tbody tr');
  await rows.first().waitFor();
  const all = await rows.count();
  assert.ok(all > 3, `posts rows (${all})`);
  await page.getByRole('radio', { name: 'Reels' }).click();
  const reels = await rows.count();
  assert.ok(reels > 0 && reels < all, `reels filter (${reels} of ${all})`);
  await page.getByRole('radio', { name: 'All' }).click();
  await rows.first().click();
  const drawer = page.getByRole('dialog', { name: 'Post details' });
  await drawer.waitFor();
  assert.match(await drawer.innerText(), /Reach[\s\S]*Engagement rate/);
  assert.equal(await drawer.getByRole('link', { name: /View on Instagram/ }).count(), 1);
  await drawer.getByRole('button', { name: /Refresh from Instagram/ }).click();
  await page.waitForSelector('.toast >> text=Post stats updated from Instagram.', { timeout: 20_000 });
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'detached' });
});

test('reels, stories, audience, best times and hashtags tabs render', async () => {
  await openTab('Reels');
  await page.waitForSelector('text=Views per reel');
  assert.ok((await page.locator('.chart-bar .chart-barmark').count()) > 0, 'reel bars');
  assert.ok((await page.locator('[role="tabpanel"] tbody tr').count()) > 0, 'reel rows');
  assert.match(await page.locator('.stats .stat', { hasText: 'Avg watch time' }).innerText(), /\d+(\.\d)?s/);

  await openTab('Stories');
  await page.waitForSelector('text=Story stats are saved while stories are live');
  assert.ok((await page.locator('[role="tabpanel"] tbody tr').count()) >= 1, 'story rows');
  assert.match(await page.locator('.stats .stat', { hasText: 'Avg exit rate' }).innerText(), /%/);

  await openTab('Audience');
  await page.waitForSelector('.chart-donut');
  assert.ok((await page.locator('.chart-heatmap .chart-cell').count()) === 7 * 24, 'online followers heatmap');
  assert.match(await page.locator('.panel', { hasText: 'Top countries' }).innerText(), /United States/);
  await page.getByRole('radio', { name: 'Engaged audience' }).click();
  await page.waitForSelector('.chart-donut');
  await page.getByRole('button', { name: /Refresh from Instagram/ }).click();
  await page.waitForSelector('.toast >> text=Audience updated from Instagram.', { timeout: 20_000 });

  await openTab('Best times');
  await page.waitForSelector('.an-slots .list-row');
  assert.equal(await page.locator('.an-slots .list-row').count(), 5);
  assert.match(await page.locator('.an-best-map').innerText(), /Based on/);

  await openTab('Hashtags');
  await page.waitForSelector('text=Instagram uses at most 5 hashtags per post');
  if (await page.getByRole('button', { name: 'Show last 90 days' }).count()) await page.getByRole('button', { name: 'Show last 90 days' }).click();
  await page.locator('[role="tabpanel"] tbody tr').first().waitFor();
  assert.match(await page.locator('[role="tabpanel"] tbody tr').first().innerText(), /^#/);
  await go('#/analytics');
  await waitForNumber('Reach');
});

test('refresh now starts the worker', async () => {
  await page.getByRole('button', { name: 'Refresh now' }).click();
  await page.waitForSelector('.toast >> text=Worker started', { timeout: 20_000 });
});

test('reports: preview, sections, AI summary, CSV and print stylesheet', async () => {
  await go('#/reports');
  await page.waitForSelector('.rp-doc .rp-h2', { timeout: 20_000 });
  assert.match(await page.locator('.rp-title').innerText(), /Instagram report/);
  const sections = await page.locator('.rp-doc .rp-h2').count();
  assert.ok(sections >= 9, `default sections (${sections})`);
  assert.match(await page.locator('.rp-doc .an-stats').innerText(), /REACH|Reach/);

  await page.getByRole('checkbox', { name: /Hashtags/ }).uncheck();
  await page.waitForFunction((n) => document.querySelectorAll('.rp-doc .rp-h2').length === n - 1, sections);
  await page.getByRole('checkbox', { name: /Competitors/ }).check();
  await page.waitForSelector('.rp-h2 >> text=Competitors');
  assert.match(await page.locator('.rp-section', { hasText: 'Competitors' }).innerText(), /Facebook Login/);

  await page.locator('.rp-builder input').first().fill('Autumn drop results');
  await page.waitForFunction(() => document.querySelector('.rp-title')?.textContent === 'Autumn drop results');

  await page.getByRole('button', { name: 'Write a summary' }).click();
  await page.waitForSelector('.rp-ai', { timeout: 30_000 });
  assert.ok((await page.locator('.rp-ai').innerText()).trim().length > 20, 'AI summary text');

  await openMenu(page, 'Download CSV');
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Daily metrics/ }).click()]);
  assert.match(csv.suggestedFilename(), /\.csv$/);

  await page.emulateMedia({ media: 'print' });
  const vis = await page.evaluate(() => {
    const shown = (sel) => {
      const el = document.querySelector(sel);
      return !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
    };
    return { sidebar: shown('.sidebar'), builder: shown('.rp-builder'), actions: shown('.rp-page .page-actions'), tabbar: shown('.tabbar'), doc: shown('.rp-doc'), bg: getComputedStyle(document.body).backgroundColor };
  });
  assert.deepEqual(vis, { sidebar: false, builder: false, actions: false, tabbar: false, doc: true, bg: 'rgb(255, 255, 255)' });
  await shot(page, 'reports-print-desktop-light');
  await page.emulateMedia({ media: 'screen' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).display !== 'none'), true);

  // Restore the default report choices for the screenshots.
  await page.getByRole('checkbox', { name: /Hashtags/ }).check();
  await page.getByRole('checkbox', { name: /Competitors/ }).uncheck();
  await page.locator('.rp-builder input').first().fill('');
});

test('screenshots at desktop and phone sizes, light and dark, without horizontal scroll', async () => {
  const variants = [
    ['desktop', { width: 1280, height: 860 }, 'light'],
    ['desktop', { width: 1280, height: 860 }, 'dark'],
    ['phone', { width: 390, height: 844 }, 'light'],
    ['phone', { width: 390, height: 844 }, 'dark'],
  ];
  const screens = [
    ['analytics', '#/analytics'],
    ['analytics-posts', '#/analytics?tab=posts'],
    ['analytics-reels', '#/analytics?tab=reels'],
    ['analytics-stories', '#/analytics?tab=stories'],
    ['analytics-audience', '#/analytics?tab=audience'],
    ['analytics-best-times', '#/analytics?tab=best-times'],
    ['analytics-hashtags', '#/analytics?tab=hashtags&range=90d'],
    ['analytics-live', OLD_RANGE],
    ['reports', '#/reports'],
  ];
  for (const [size, viewport, colorScheme] of variants) {
    const ctx = await h.browser.newContext({ viewport, colorScheme });
    const p = await ctx.newPage();
    const errors = [];
    p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(`${h.url}/postpilot/index.html#/analytics`);
    await unlock(p);
    // Tabs other than the overview only in light mode, to keep the run short.
    const list = colorScheme === 'dark' ? screens.filter(([n]) => n === 'analytics' || n === 'reports' || n === 'analytics-audience') : screens;
    for (const [name, hash] of list) {
      await p.evaluate((x) => {
        location.hash = x;
      }, hash);
      await p.waitForSelector(name === 'reports' ? '.rp-doc .rp-h2' : '[role="tabpanel"] > *', { timeout: 20_000 });
      await p.waitForFunction(() => !document.querySelector('.an-panel.is-refreshing') && !document.querySelector('[aria-busy="true"]'), null, { timeout: 30_000 });
      await p.waitForTimeout(600);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${name} ${size} ${colorScheme}: horizontal page scroll of ${overflow}px`);
      await prepareShot(p);
      await shot(p, `${name}-${size}-${colorScheme}`);
    }
    assert.deepEqual(errors, [], `console errors (${size} ${colorScheme})`);
    await ctx.close();
  }
});

test('no console errors', () => {
  assert.deepEqual(h.consoleErrors, []);
});
