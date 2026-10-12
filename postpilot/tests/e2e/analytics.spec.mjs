// E2E: Analytics (all tabs, range switch, live fallback, CSV export, post drawer with its history
// curve, Reels 24 h / 7-day views and trial hint, label filter, reach/views breakdown charts, audience
// refresh). Reports have their own spec (reports.spec.mjs). Run: node --test tests/e2e/analytics.spec.mjs
// Some tests change the encrypted documents through the app's data module (as the worker would)
// and put them back afterwards (page.evaluate: the app's CSP allows no eval, so no helper wraps it).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openApp, shot, unlock } from './helpers.mjs';

const PORT = 5521;
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

  // Followers move by a few dozen a week: the y-axis must still show distinct labels (not "4.8K" four times).
  const axes = await page.locator('[role="tabpanel"] .chart-line').evaluateAll((charts) =>
    charts.map((c) => ({ name: c.getAttribute('aria-label'), ticks: [...c.querySelectorAll('.chart-axis text[text-anchor="end"]')].map((t) => t.textContent) })),
  );
  assert.ok(axes.some((a) => a.name === 'Followers per day'), 'followers chart renders');
  for (const a of axes) assert.equal(new Set(a.ticks).size, a.ticks.length, `${a.name}: repeated y-axis labels ${a.ticks.join(' / ')}`);

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

test('a previous period Instagram fails to return is reported and can be retried', async () => {
  // A week the worker never saved, so both it and the week before load live. Only the requests for
  // the week before fail (their `until` is at or before the start of the range).
  const from = daysAgo(50);
  const rangeStart = Date.parse(`${from}T12:00:00Z`) / 1000;
  let block = true;
  const isPrevious = (url) => {
    const until = Number(new URL(url).searchParams.get('until'));
    return /\/insights$/.test(new URL(url).pathname) && until > 0 && until < rangeStart;
  };
  const graph = /\/mock\/(ig|fb)\//;
  await page.route(graph, (route) => (block && isPrevious(route.request().url()) ? route.abort('failed') : route.continue()));
  const errorsBefore = h.consoleErrors.length;
  try {
    await go(`#/analytics?range=custom&from=${from}&to=${daysAgo(44)}`);
    const note = page.locator('.an-source', { hasText: 'Could not load the previous period from Instagram' });
    await note.waitFor({ timeout: 30_000 });
    await waitForNumber('Reach');
    assert.match(await tile('Reach').innerText(), /Could not load the previous period from Instagram/);
    assert.doesNotMatch(await tile('Reach').innerText(), /No data for the previous period/);

    block = false;
    await note.getByRole('button', { name: 'Try again' }).click();
    await page.waitForSelector('.an-source >> text=Previous period loaded live from Instagram', { timeout: 30_000 });
    assert.match(await tile('Reach').locator('.stat-delta').innerText(), /%/);
  } finally {
    await page.unroute(graph);
    // The blocked requests are logged by Chromium; only those are expected.
    const added = h.consoleErrors.splice(errorsBefore);
    h.consoleErrors.push(...added.filter((e) => !/Failed to load resource: net::ERR_FAILED/.test(e)));
    await go('#/analytics');
  }
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

test('overview: reach followers/non-followers and views by format charts from the worker\'s breakdowns', async () => {
  await go('#/analytics');
  await waitForNumber('Reach');
  const split = page.locator('.panel', { has: page.locator('.panel-title', { hasText: 'Reach: followers vs non-followers' }) });
  await split.locator('.chart-stackcol svg').waitFor();
  assert.match(await split.innerText(), /\d+(\.\d)?% of reach came from non-followers/);
  assert.ok((await split.locator('.chart-barmark').count()) >= 2 * 20, 'two stacked parts per day');
  assert.match(await split.locator('.legend').innerText(), /Followers[\s\S]*Non-followers/);
  // The hidden data table lists both parts and the total for every day.
  assert.match(await split.locator('.sr-only caption').innerText(), /followers and non-followers/);
  const views = page.locator('.panel', { has: page.locator('.panel-title', { hasText: 'Views by format' }) });
  await views.locator('.stackbar').waitFor();
  const legend = await views.locator('.chart-stack .legend').innerText();
  for (const t of ['Posts', 'Reels', 'Stories', 'Carousels']) assert.match(legend, new RegExp(t));
  assert.match(await views.locator('.panel-subtitle').innerText(), /of views from followers/);
  assert.ok((await views.locator('.chart-stackcol .chart-barmark').count()) > 20, 'views per day by format');
  // Hover shows every part and the total.
  await split.locator('.chart-stackcol .chart-hit').last().hover({ force: true });
  await split.locator('.chart-tip').waitFor();
  assert.match(await split.locator('.chart-tip').innerText(), /Non-followers[\s\S]*Followers[\s\S]*Total/);
  await page.mouse.move(1, 1);
});

test('posts tab: label filter shows the labelled posts and their numbers', async () => {
  await go('#/analytics?tab=posts');
  const rows = page.locator('[role="tabpanel"] tbody tr');
  await rows.first().waitFor();
  const all = await rows.count();
  const select = page.getByRole('combobox', { name: 'Filter by label' });
  const options = await select.locator('option').allInnerTexts();
  assert.ok(options.some((o) => /^autumn drop \(\d+\)$/.test(o)), `label options: ${options.join(' | ')}`);
  await select.selectOption({ label: options.find((o) => o.startsWith('autumn drop')) });
  await page.waitForFunction(() => /label=autumn(%20|\+)drop/.test(location.hash));
  await page.waitForFunction((n) => document.querySelectorAll('[role="tabpanel"] tbody tr').length < n, all);
  const labelled = await rows.count();
  assert.ok(labelled >= 2, `labelled rows (${labelled} of ${all})`);
  const strip = page.locator('.an-campaign-stats');
  assert.equal((await strip.locator('.stat').filter({ hasText: /^Posts/ }).locator('.stat-value').innerText()).trim(), String(labelled));
  assert.match(await strip.innerText(), /per post vs/);
  assert.match(await page.locator('[role="tabpanel"] .toolbar').innerText(), new RegExp(`${labelled} posts`));
  // The trial reel carries a badge in the caption cell.
  assert.ok((await page.locator('[role="tabpanel"] .an-trial-badge').count()) >= 1);
  // Reload keeps the filter (it lives in the URL); "All posts" clears it.
  await page.reload();
  await unlock(page);
  await page.locator('.an-campaign-stats').waitFor({ timeout: 20_000 });
  await page.getByRole('combobox', { name: 'Filter by label' }).selectOption({ label: 'All posts' });
  await page.waitForFunction(() => !location.hash.includes('label='));
  await page.waitForFunction((n) => document.querySelectorAll('[role="tabpanel"] tbody tr').length === n, all);
  assert.equal(await page.locator('.an-campaign-stats').count(), 0);
});

test('reels: views at 24 h and 7 days against the median, and the trial reel hint', async () => {
  await go('#/analytics?tab=reels');
  await page.locator('[role="tabpanel"] tbody tr').first().waitFor();
  const heads = await page.locator('[role="tabpanel"] thead th').allInnerTexts();
  assert.ok(heads.some((h) => /Views at 24 h/i.test(h)) && heads.some((h) => /Views at 7 days/i.test(h)), heads.join('|'));
  const cells = page.locator('[role="tabpanel"] tbody td.an-age-cell');
  const texts = await cells.allInnerTexts();
  assert.ok(texts.some((t) => /^[\d,]+/.test(t)), 'known values');
  assert.ok(texts.some((t) => /^—$/.test(t.trim())), 'blank (—) when not known yet (a reel under 7 days old)');
  assert.ok((await page.locator('[role="tabpanel"] .an-vs').count()) >= 4, 'median comparison chips');
  assert.match(await page.locator('[role="tabpanel"] .an-note', { hasText: 'median' }).innerText(), /Median of all your reels: [\d,.K]+ at 24 h/);
  // Sorting by 24 h views puts the unknown ones last.
  await page.locator('[role="tabpanel"] thead th', { hasText: 'Views at 24 h' }).locator('button').click();
  await page.waitForFunction(() => document.querySelector('[role="tabpanel"] thead th[aria-sort="descending"], [role="tabpanel"] thead th[aria-sort="ascending"]')?.textContent.includes('Views at 24 h'));
  // The seeded trial reel is judged at its latest known age. For a hint, point the trial post at the
  // reel under 7 days old with the most views at 24 hours (ahead of the median); put it back after.
  const setup = await page.evaluate(async () => {
    const d = await import('/postpilot/js/data.js');
    const A = await import('/postpilot/core/analytics.js');
    const media = Object.values((await d.readDoc('analytics-media')).media);
    const hist = (await d.readDoc('analytics-media-history')).media;
    const reels = media
      .filter((m) => m.productType === 'REELS' && hist[m.id])
      .map((m) => ({ id: m.id, v24: A.valueAtAge(hist[m.id].points, m.timestamp, 24), v7: A.valueAtAge(hist[m.id].points, m.timestamp, 168) }));
    const young = reels.filter((r) => r.v24 != null && r.v7 == null).sort((x, y) => y.v24 - x.v24)[0];
    const med24 = A.median(reels.filter((r) => r !== young).map((r) => r.v24));
    const trial = (await d.readDoc('posts')).posts.find((p) => p.trialReel);
    await d.mutate('posts', (doc) => {
      doc.posts.find((p) => p.id === trial.id).igMediaId = young.id;
    });
    return { post: trial.id, was: trial.igMediaId, young: young.id, ahead: young.v24 > med24, points: hist[young.id].points };
  });
  assert.ok(setup.ahead, 'the youngest reels include one ahead of the median at 24 hours');
  try {
    const hint = page.locator('.an-trial-hint').first();
    await hint.waitFor();
    assert.equal(await hint.locator('.callout-title').innerText(), 'Doing well with non-followers — share it to your followers in the Instagram app');
    assert.match(await hint.innerText(), /views at 24 hours; the median of your other reels is [\d,]+/);
    assert.match(await hint.innerText(), /can't share a trial reel/);
    await hint.getByRole('button', { name: 'Details' }).click();
    const drawer = page.getByRole('dialog', { name: 'Post details' });
    await drawer.waitFor();
    assert.match(await drawer.innerText(), /Trial reel/);
    assert.equal(await drawer.locator('.an-trial-hint').count(), 1);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });

    // Once its 7-day views are known and below the median, the hint goes: it never contradicts the
    // newer number in the same row.
    await page.evaluate(async (s) => {
      const d = await import('/postpilot/js/data.js');
      const A = await import('/postpilot/core/analytics.js');
      const m = (await d.readDoc('analytics-media')).media[s.young];
      const t0 = A.parseTimestamp(m.timestamp);
      const at = (h) => new Date(t0 + h * 36e5).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await d.mutate('analytics-media-history', (doc) => {
        doc.media[s.young].points = [...s.points, { t: at(160), v: 10, r: 5 }, { t: at(176), v: 12, r: 6 }];
      });
    }, setup);
    await page.waitForFunction(() => !document.querySelector('.an-trial-hint'));
    const row = page.locator('[role="tabpanel"] tbody tr', { has: page.locator('.an-trial-badge') }).first();
    assert.match(await row.locator('td.an-age-cell').nth(1).innerText(), /^11\s*−\d+(\.\d)?%$/, '7-day views (interpolated) below the median');
  } finally {
    await page.evaluate(async (s) => {
      const d = await import('/postpilot/js/data.js');
      await d.mutate('posts', (doc) => {
        doc.posts.find((p) => p.id === s.post).igMediaId = s.was;
      });
      await d.mutate('analytics-media-history', (doc) => {
        doc.media[s.young].points = s.points;
      });
    }, setup);
  }
});

test('post drawer: views and reach since publishing, with 24 h and 7-day values', async () => {
  await go('#/analytics?tab=reels');
  const rows = page.locator('[role="tabpanel"] tbody tr');
  await rows.first().waitFor();
  // A reel (not the trial one) whose 7-day views are known.
  const idx = await rows.evaluateAll((list) =>
    list.findIndex((r) => {
      const c = r.querySelectorAll('td.an-age-cell');
      return c.length === 2 && /\d/.test(c[1].textContent) && !r.querySelector('.an-trial-badge');
    }),
  );
  assert.ok(idx >= 0, 'a reel with known 7-day views');
  await rows.nth(idx).click();
  const drawer = page.getByRole('dialog', { name: 'Post details' });
  await drawer.waitFor();
  const chart = drawer.locator('.chart-curve');
  await chart.locator('svg').waitFor();
  assert.equal(await chart.locator('.chart-line-path').count(), 2, 'views and reach lines');
  assert.match(await chart.locator('.legend').innerText(), /Views[\s\S]*Reach/);
  const ticks = await chart.locator('.chart-axis text[text-anchor="middle"]').evaluateAll((els) => els.map((e) => e.textContent));
  assert.ok(ticks.includes('1d') && ticks.includes('7d'), `hour/day ticks: ${ticks.join(' ')}`);
  const kv = await drawer.locator('.an-age').innerText();
  assert.match(kv, /Views at 24 h\s+[\d,]+/);
  assert.match(kv, /Views at 7 days\s+[\d,]+/);
  assert.match(kv, /vs median/);
  // Keyboard: the chart is focusable and arrows move the tooltip along the curve.
  await chart.focus();
  await page.keyboard.press('Home');
  await chart.locator('.chart-tip').waitFor();
  assert.match(await chart.locator('.chart-tip-title').innerText(), /^0 min after posting$/);
  await page.keyboard.press('End');
  assert.match(await chart.locator('.chart-tip-title').innerText(), /days after posting$/);
  // A live refresh still works (and may add a history point).
  await drawer.getByRole('button', { name: /Refresh from Instagram/ }).click();
  await page.waitForSelector('.toast >> text=Post stats updated from Instagram.', { timeout: 20_000 });
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'detached' });
});

test('post drawer: a history that starts late is not drawn from 0 and has no 24 h / 7-day values', async () => {
  await go('#/analytics?tab=reels');
  await page.locator('[role="tabpanel"] tbody tr').first().waitFor();
  // A reel over 20 days old loses its first 20 days of points, as for a post that was already that
  // old when Postpilot started saving history.
  const setup = await page.evaluate(async () => {
    const d = await import('/postpilot/js/data.js');
    const A = await import('/postpilot/core/analytics.js');
    const media = Object.values((await d.readDoc('analytics-media')).media);
    const hist = (await d.readDoc('analytics-media-history')).media;
    const m = media
      .filter((x) => x.productType === 'REELS' && hist[x.id] && Date.now() - A.parseTimestamp(x.timestamp) > 21 * 864e5)
      .sort((x, y) => A.parseTimestamp(y.timestamp) - A.parseTimestamp(x.timestamp))[0];
    const t0 = A.parseTimestamp(m.timestamp);
    const points = hist[m.id].points;
    await d.mutate('analytics-media-history', (doc) => {
      doc.media[m.id].points = points.filter((p) => A.parseTimestamp(p.t) - t0 >= 20 * 864e5);
    });
    const line = String(m.caption || '').split('\n').find((l) => l.trim()) || '';
    return { id: m.id, points, line: line.trim().slice(0, 40) };
  });
  try {
    const row = page.locator('[role="tabpanel"] tbody tr').filter({ hasText: setup.line }).first();
    const cells = await row.locator('td.an-age-cell').allInnerTexts();
    assert.deepEqual(cells.map((c) => c.trim()), ['—', '—'], 'no 24 h or 7-day value from a late history');
    await row.click();
    const drawer = page.getByRole('dialog', { name: 'Post details' });
    await drawer.waitFor();
    const chart = drawer.locator('.chart-curve');
    await chart.locator('svg').waitFor();
    assert.match(await drawer.locator('.an-history-late').innerText(), /^History starts 2\d(\.\d)? days after publishing\. Postpilot was not saving this post's growth before then\.$/);
    await chart.focus();
    await page.keyboard.press('Home');
    await chart.locator('.chart-tip').waitFor();
    assert.match(await chart.locator('.chart-tip-title').innerText(), /^2\d(\.\d)? days after posting$/, 'the line starts at the first saved point, not at 0');
    assert.equal(await drawer.locator('.an-note', { hasText: 'Compared with the median' }).count(), 0);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });
  } finally {
    await page.evaluate(async (s) => {
      const d = await import('/postpilot/js/data.js');
      await d.mutate('analytics-media-history', (doc) => {
        doc.media[s.id].points = s.points;
      });
    }, setup);
  }
});

test('stories: accurate capture copy and a stories CSV', async () => {
  await go('#/analytics?tab=stories');
  const callout = page.locator('.callout', { hasText: 'Story stats are saved while stories are live' });
  await callout.waitFor();
  const text = await callout.innerText();
  assert.match(text, /when it first sees the story, then once an hour, and on every run .* in the story's last 90 minutes/);
  assert.doesNotMatch(text, /every 10 minutes while a story is live/);
  // The file holds what the tab lists, live stories included.
  const listed = await page.locator('[role="tabpanel"] tbody tr').count();
  const live = await page.locator('[role="tabpanel"] tbody tr', { hasText: 'Live' }).count();
  assert.ok(live >= 1, 'the seed has live stories');
  await openMenu(page, 'Export CSV');
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^Stories/ }).click()]);
  assert.match(file.suggestedFilename(), /^postpilot-stories-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = (await readFile(await file.path(), 'utf8')).replace(/^\uFEFF/, '').split('\r\n');
  assert.match(csv[0], /^Date,Time,Type,Link,Reach,Views,Replies,Shares,Interactions,Follows,Profile visits,Taps forward,Taps back,Exits,Swipes forward,Exit rate \(%\),Numbers saved at$/);
  assert.equal(csv.length - 1, listed, 'one row per listed story');
  assert.match(csv[1], /^\d{4}-\d{2}-\d{2},\d{2}:\d{2},(Photo|Video),https:/);
  await page.waitForSelector(`.toast >> text=Downloaded ${listed} ${listed === 1 ? 'story' : 'stories'}.`);
  await go('#/analytics');
  await waitForNumber('Reach');
});

test('refresh now starts the worker', async () => {
  await page.getByRole('button', { name: 'Refresh now' }).click();
  await page.waitForSelector('.toast >> text=Worker started', { timeout: 20_000 });
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
    ['analytics-posts-label', '#/analytics?tab=posts&label=autumn%20drop'],
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
    const list = colorScheme === 'dark' ? screens.filter(([n]) => ['analytics', 'analytics-audience', 'analytics-reels'].includes(n)) : screens;
    for (const [name, hash] of list) {
      await p.evaluate((x) => {
        location.hash = x;
      }, hash);
      await p.waitForSelector('[role="tabpanel"] > *', { timeout: 20_000 });
      await p.waitForFunction(() => !document.querySelector('.an-panel.is-refreshing') && !document.querySelector('[aria-busy="true"]'), null, { timeout: 30_000 });
      await p.waitForTimeout(600);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${name} ${size} ${colorScheme}: horizontal page scroll of ${overflow}px`);
      await prepareShot(p);
      await shot(p, `${name}-${size}-${colorScheme}`);
    }
    // The post drawer with its history curve (viewport shot: the drawer is an overlay).
    await p.evaluate(() => (location.hash = '#/analytics?tab=reels'));
    await p.locator('[role="tabpanel"] tbody tr').first().waitFor({ timeout: 20_000 });
    await p.locator('[role="tabpanel"] tbody tr', { has: p.locator('.an-trial-badge') }).first().click();
    const drawer = p.getByRole('dialog', { name: 'Post details' });
    await drawer.locator('.chart-curve svg').waitFor();
    await p.mouse.move(1, 1);
    await p.waitForTimeout(500);
    assert.ok((await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, `drawer ${size} ${colorScheme}: horizontal scroll`);
    await shot(p, `analytics-drawer-${size}-${colorScheme}`);
    await p.keyboard.press('Escape');
    assert.deepEqual(errors, [], `console errors (${size} ${colorScheme})`);
    await ctx.close();
  }
});

test('no console errors', () => {
  assert.deepEqual(h.consoleErrors, []);
});
