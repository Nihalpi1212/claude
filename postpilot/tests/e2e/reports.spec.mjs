// E2E: Reports (builder sections, AI summary, CSV, print stylesheet, monthly reports saved by the
// worker, logo from the library, campaign section). Run: node --test tests/e2e/reports.spec.mjs
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, shot, unlock } from './helpers.mjs';

const PORT = Number(process.env.REPORTS_E2E_PORT || 5522);
// The seed stores a report for last month in the demo time zone.
const todayNY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const [Y, M] = todayNY.split('-').map(Number);
const PREV = new Date(Date.UTC(Y, M - 2, 15));
const MONTH = PREV.toISOString().slice(0, 7);
const MONTH_LABEL = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(PREV);
const MONTH_SHORT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' }).format(PREV);
const LAST_DAY = new Date(Date.UTC(Y, M - 1, 0)).toISOString().slice(0, 10);
// The two months before it (a partly saved report is added for MONTH2 in one test).
const monthAt = (back) => new Date(Date.UTC(Y, M - 1 - back, 15));
const fmtMonth = (d, month) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month, year: 'numeric' }).format(d);
const MONTH2 = monthAt(2).toISOString().slice(0, 7);
const PREV_SHORT_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short' }).format(monthAt(2));
const PREV_LAST = new Date(Date.UTC(Y, M - 2, 0)).getUTCDate();

let h;
let page;

before(async () => {
  h = await openApp({ port: PORT, hash: '#/reports' });
  page = h.page;
  await page.waitForSelector('.rp-doc .rp-h2', { timeout: 20_000 });
});

after(async () => {
  if (h && h.server.child.exitCode !== null) console.log(`dev server exited (${h.server.child.exitCode}):\n${h.server.output().slice(-4000)}`);
  await h?.close();
});

async function go(hash) {
  await page.evaluate((x) => {
    location.hash = x;
  }, hash);
}

/** Open a kit Menu by its trigger name (it closes on scroll, so start from the top and retry). */
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

test('monthly reports: the saved report opens with its stored numbers and loads its month in the builder', async () => {
  const list = page.locator('.rp-monthly');
  await list.waitFor();
  const row = list.locator('.rp-monthly-row').first();
  assert.match(await row.innerText(), new RegExp(MONTH_LABEL));
  assert.match(await row.locator('.rp-monthly-headline').innerText(), /^Reach [\d.,]+K? \([+−]\d+%\) · \d+ posts/);
  await row.locator('.rp-monthly-open').click();
  await page.waitForFunction(() => /report=rp_/.test(location.hash));
  const doc = page.locator('.rp-stored');
  await doc.waitFor();
  assert.equal(await page.locator('.rp-builder').getByText('Report options').count(), 0, 'builder options are hidden while a saved report is open');
  assert.equal(await row.locator('.rp-monthly-open').getAttribute('aria-pressed'), 'true');
  assert.equal(await doc.locator('.rp-title').innerText(), `Monthly report · ${MONTH_LABEL}`);
  assert.match(await doc.locator('.rp-range').innerText(), new RegExp(`${MONTH_SHORT.split(' ')[0]} 1 – `));
  assert.ok((await doc.locator('.rp-ai').innerText()).length > 40, 'the stored AI summary');
  const reach = doc.locator('.stat', { has: page.locator('.stat-label', { hasText: /^Reach$/ }) });
  assert.match(await reach.locator('.stat-value').innerText(), /^[\d,.]+K?$/);
  assert.match(await reach.locator('.stat-foot').innerText(), /vs [\d,]+ in /);
  assert.match(await doc.locator('.stat', { hasText: 'Non-follower reach' }).innerText(), /\d+(\.\d)?%/);
  assert.match(await doc.locator('.rp-section', { hasText: 'Views by format' }).innerText(), /Reels/);
  assert.ok((await doc.locator('.rp-section', { hasText: 'Top posts' }).locator('tbody tr').count()) >= 1);
  assert.equal(await doc.locator('.rp-coverage').count(), 0, 'both months fully saved: no coverage note');

  // Download CSV covers the open report's month, not the hidden builder range.
  await openMenu(page, 'Download CSV');
  const item = page.getByRole('menuitem', { name: /Daily metrics/ });
  assert.match(await item.innerText(), new RegExp(MONTH_SHORT));
  const [csv] = await Promise.all([page.waitForEvent('download'), item.click()]);
  assert.equal(csv.suggestedFilename(), `postpilot-daily-${MONTH}-01_${LAST_DAY}.csv`);
  await page.waitForSelector(`.toast >> text=Downloaded ${Number(LAST_DAY.slice(8))} days of metrics.`);

  // Print shows only the saved report.
  await page.emulateMedia({ media: 'print' });
  const vis = await page.evaluate(() => {
    const shown = (sel) => {
      const el = document.querySelector(sel);
      return !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
    };
    return { builder: shown('.rp-builder'), label: shown('.rp-preview-label'), doc: shown('.rp-stored') };
  });
  assert.deepEqual(vis, { builder: false, label: false, doc: true });
  await page.emulateMedia({ media: 'screen' });

  await page.getByRole('button', { name: new RegExp(`Load ${MONTH_SHORT.split(' ')[0]} \\d{4} in the builder`) }).click();
  await page.waitForFunction(([from, to]) => location.hash.includes(`from=${from}`) && location.hash.includes(`to=${to}`) && !location.hash.includes('report='), [`${MONTH}-01`, LAST_DAY]);
  await page.locator('.rp-doc:not(.rp-stored) .rp-h2').first().waitFor();
  assert.match(await page.locator('.rp-range').first().innerText(), new RegExp(`${MONTH_SHORT.split(' ')[0]} 1 – `));
  // A whole month is compared with the calendar month before, like the saved report.
  assert.match(await page.locator('.rp-range').first().innerText(), new RegExp(`compared with ${PREV_SHORT_DAY} 1 – ${PREV_SHORT_DAY} ${PREV_LAST}, \\d{4}$`));

  // Back to the builder from a saved report.
  await row.locator('.rp-monthly-open').click();
  await doc.waitFor();
  await page.getByRole('button', { name: 'Back to the builder' }).click();
  await page.waitForFunction(() => !location.hash.includes('report='));
  await page.locator('.rp-builder').getByText('Report options').waitFor();
  await go('#/reports');
});

test('a partly saved month: coverage note, no month-on-month changes, fresh top-post thumbnail', async () => {
  // A report as the worker makes it for a month with 12 saved days, compared with a month with 17.
  const setup = await page.evaluate(async (month) => {
    const d = await import('/postpilot/js/data.js');
    const A = await import('/postpilot/core/analytics.js');
    const media = Object.values((await d.readDoc('analytics-media')).media).filter((m) => m.thumbnailUrl && m.productType !== 'STORY');
    const posts = (await d.readDoc('posts')).posts;
    const linked = new Set(posts.map((p) => p.igMediaId).filter(Boolean));
    // One post Postpilot did not publish (its thumbnail comes from analytics-media) and one it did
    // (its library image is used).
    const top = media.filter((m) => !linked.has(m.id)).sort((x, y) => (y.metrics?.reach ?? 0) - (x.metrics?.reach ?? 0))[0];
    const ours = media.find((m) => linked.has(m.id) && posts.find((p) => p.igMediaId === m.id).media?.length);
    const lite = (m) => ({ id: m.id, caption: m.caption, mediaType: m.mediaType, productType: m.productType, permalink: m.permalink, timestamp: m.timestamp, thumbnailUrl: 'https://scontent.cdninstagram.com/expired.jpg', metrics: m.metrics });
    const total = Number(A.monthBounds(month).toKey.slice(8));
    const prevTotal = Number(A.monthBounds(A.previousMonth(month)).toKey.slice(8));
    const report = {
      id: 'rp_e2epartial',
      month,
      createdAt: new Date().toISOString(),
      summary: { reach: 15598, views: 40210, interactions: 1210, engagementRate: 0.0776, accountsEngaged: 2900, posts: 12, reels: 4, stories: 3, followersEnd: 4820, followerGrowth: null, followerGrowthPct: null, daysInMonth: total, daysSaved: 12, followerDays: 1, viewsByType: { POST: 9000, REEL: 12000 }, viewsByTypeDays: 6, breakdownDays: 6, nonFollowerReachShare: 0.41 },
      previous: { reach: 26567, views: 70100, interactions: 2010, engagementRate: 0.0757, accountsEngaged: 4100, posts: 15, daysInMonth: prevTotal, daysSaved: 17 },
      top: [lite(top), lite(ours)],
      ai: null,
    };
    report.headline = A.reportHeadline(report);
    await d.mutate('reports', (doc) => {
      doc.reports = [...(doc.reports || []).filter((r) => r.id !== report.id), report];
    });
    return { headline: report.headline, total, prevTotal, thumb: top.thumbnailUrl };
  }, MONTH2);
  try {
    assert.match(setup.headline, new RegExp(`^Reach 15.6K · 12 posts · 12 of ${setup.total} days saved$`));
    const row = page.locator('.rp-monthly-row', { hasText: fmtMonth(monthAt(2), 'long') });
    assert.equal(await row.locator('.rp-monthly-headline').innerText(), setup.headline);
    await row.locator('.rp-monthly-open').click();
    const doc = page.locator('.rp-stored');
    await doc.waitFor();
    assert.equal(
      await doc.locator('.rp-coverage').innerText(),
      `Postpilot saved 12 of ${setup.total} days of ${fmtMonth(monthAt(2), 'long')} and 17 of ${setup.prevTotal} days of ${fmtMonth(monthAt(3), 'long')}, so these totals cover only the saved days and the two months are not compared.`,
    );
    assert.doesNotMatch(await doc.locator('.rp-range').innerText(), /compared with/);
    const reach = doc.locator('.stat', { has: page.locator('.stat-label', { hasText: /^Reach$/ }) });
    assert.equal((await reach.locator('.stat-delta').innerText()).trim(), '—', 'no change against a partly saved month');
    assert.match(await reach.innerText(), new RegExp(`Not compared with ${fmtMonth(monthAt(3), 'short')}`));
    assert.match(await doc.locator('.stat', { hasText: 'Followers' }).innerText(), /Only one follower count saved/);
    assert.match(await doc.locator('.stat', { hasText: 'Non-follower reach' }).innerText(), /41(\.0)?%/);
    assert.match(await doc.locator('.rp-section', { hasText: 'Views by format' }).innerText(), /saved for 6 of the 12 days/);
    // Top-post thumbnails: not the expired stored URL, but the current analytics-media one, or the
    // library image for a post Postpilot published.
    const imgs = doc.locator('.rp-section', { hasText: 'Top posts' }).locator('tbody tr img');
    await page.waitForFunction(() => [...document.querySelectorAll('.rp-stored tbody tr img')].filter((i) => i.naturalWidth > 0).length === 2);
    assert.equal(await imgs.nth(0).getAttribute('src'), setup.thumb);
    assert.match(await imgs.nth(1).getAttribute('src'), /^blob:/);
    await page.getByRole('button', { name: 'Back to the builder' }).click();
  } finally {
    await page.evaluate(async () => {
      const d = await import('/postpilot/js/data.js');
      await d.mutate('reports', (doc) => {
        doc.reports = (doc.reports || []).filter((r) => r.id !== 'rp_e2epartial');
      });
    });
  }
  await go('#/reports');
});

test('logo: picked from the library, shown in the report header and in print, removable', async () => {
  await page.locator('.rp-doc .rp-h2').first().waitFor();
  assert.equal(await page.locator('.rp-doc .rp-logo').count(), 0, 'profile picture by default');
  await page.getByRole('button', { name: 'Choose from library' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a logo' });
  await picker.waitFor();
  await picker.locator('.mp-tile').first().click();
  await picker.getByRole('button', { name: 'Use as logo' }).click();
  await picker.waitFor({ state: 'detached' });
  await page.waitForSelector('.toast >> text=Logo saved. It appears on every report.');
  const logo = page.locator('.rp-doc .rp-doc-head .rp-logo');
  await logo.waitFor();
  assert.match(await logo.getAttribute('src'), /^blob:/);
  await page.waitForFunction(() => document.querySelector('.rp-doc .rp-logo')?.naturalWidth > 0);
  assert.match(await page.locator('.rp-logo-field').innerText(), /Change logo/);

  // It is stored (encrypted, in the reports document): a reload keeps it, and saved reports use it too.
  await page.reload();
  await unlock(page);
  await page.locator('.rp-doc .rp-doc-head .rp-logo').waitFor({ timeout: 20_000 });
  await page.locator('.rp-monthly-open').first().click();
  await page.locator('.rp-stored .rp-logo').waitFor();
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.rp-stored .rp-logo')).display !== 'none'), true, 'logo prints');
  await shot(page, 'reports-stored-print-logo');
  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('button', { name: 'Back to the builder' }).click();

  await page.getByRole('button', { name: 'Use profile picture' }).click();
  await page.waitForSelector('.toast >> text=Reports use your profile picture again.');
  await page.waitForFunction(() => !document.querySelector('.rp-doc .rp-logo'));
  assert.equal(await page.locator('.rp-doc .rp-doc-head .avatar').count(), 1);
});

test('campaign section: pick a label to see its posts, totals, averages and top post', async () => {
  await go('#/reports?range=90d');
  await page.locator('.rp-doc .rp-h2').first().waitFor();
  await page.getByRole('checkbox', { name: /^Campaign/ }).check();
  const section = page.locator('.rp-section.rp-campaign-section');
  // Until a label is chosen the section stays out of the report (no instruction to the app user
  // prints); the options panel says so next to the label picker.
  const select = page.getByRole('combobox', { name: 'Campaign' });
  await select.waitFor();
  await page.locator('.rp-builder .field', { has: select }).getByText('Choose a label, or the Campaign section is left out of the report.').waitFor();
  assert.equal(await section.count(), 0);
  assert.ok(!(await page.locator('.rp-doc .rp-h2').allInnerTexts()).some((t) => /Campaign/.test(t)), 'no Campaign heading');
  assert.doesNotMatch(await page.locator('.rp-doc').innerText(), /Pick a label|report options/);
  const options = await select.locator('option').allInnerTexts();
  const autumn = options.find((o) => /^autumn drop \(\d+\)$/.test(o));
  assert.ok(autumn, `label options: ${options.join(' | ')}`);
  const n = Number(autumn.match(/\((\d+)\)/)[1]);
  await select.selectOption({ label: autumn });
  await section.locator('.rp-h2', { hasText: 'Campaign: autumn drop' }).waitFor();
  assert.equal((await section.locator('.stat', { hasText: /^Posts/ }).locator('.stat-value').innerText()).trim(), String(n));
  for (const label of ['Reach', 'Views', 'Interactions', 'Engagement rate']) {
    assert.match(await section.locator('.stat', { has: page.locator('.stat-label', { hasText: new RegExp(`^${label}$`) }) }).innerText(), /\d/);
  }
  assert.match(await section.locator('.rp-campaign-top').innerText(), /Top post[\s\S]*interactions/i);
  assert.equal(await section.locator('tbody tr').count(), n);
  assert.match(await section.locator('.rp-note').first().innerText(), new RegExp(`${n} posts labelled “autumn drop”`));
  // The choice is remembered on this device.
  await page.reload();
  await unlock(page);
  await page.locator('.rp-section.rp-campaign-section .rp-h2', { hasText: 'Campaign: autumn drop' }).waitFor({ timeout: 20_000 });
  await page.getByRole('checkbox', { name: /^Campaign/ }).uncheck();
  await page.waitForFunction(() => !document.querySelector('.rp-campaign-section'));
  await go('#/reports');
});

test('reports: preview, sections, AI summary, CSV and print stylesheet', async () => {
  await go('#/reports');
  await page.waitForSelector('.rp-doc .rp-h2', { timeout: 20_000 });
  assert.match(await page.locator('.rp-title').innerText(), /Instagram report/);
  const sections = await page.locator('.rp-doc .rp-h2').count();
  assert.ok(sections >= 9, `default sections (${sections})`);
  assert.match(await page.locator('.rp-doc .an-stats').innerText(), /REACH|Reach/);
  assert.match(await page.locator('.rp-section', { hasText: 'Content performance' }).innerText(), /Reach: followers vs non-followers[\s\S]*Views by format/);

  await page.getByRole('checkbox', { name: /Hashtags/ }).uncheck();
  await page.waitForFunction((n) => document.querySelectorAll('.rp-doc .rp-h2').length === n - 1, sections);
  await page.getByRole('checkbox', { name: /Competitors/ }).check();
  await page.waitForSelector('.rp-h2 >> text=Competitors');
  assert.match(await page.locator('.rp-section', { hasText: 'Competitors' }).innerText(), /Facebook Login/);

  await page.locator('.rp-builder input').first().fill('Autumn drop results');
  await page.waitForFunction(() => document.querySelector('.rp-title')?.textContent === 'Autumn drop results');

  await page.getByRole('button', { name: 'Write a summary' }).click();
  await page.waitForSelector('.rp-doc .rp-ai', { timeout: 30_000 });
  assert.ok((await page.locator('.rp-doc .rp-ai').innerText()).trim().length > 20, 'AI summary text');

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
  for (const [size, viewport, colorScheme] of variants) {
    const ctx = await h.browser.newContext({ viewport, colorScheme });
    const p = await ctx.newPage();
    const errors = [];
    p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    p.on('pageerror', (e) => errors.push(String(e)));
    // A campaign label chosen on this device, so the campaign section is in the shot.
    await p.addInitScript(() => {
      try {
        localStorage.setItem('postpilot.report', JSON.stringify({ title: '', sections: ['summary', 'followers', 'content', 'top', 'campaign', 'reels', 'stories', 'audience', 'best', 'hashtags'], campaignLabel: 'autumn drop' }));
      } catch {
        /* ignore */
      }
    });
    await p.goto(`${h.url}/postpilot/index.html#/reports?range=90d`);
    await unlock(p);
    for (const [name, open] of [['reports', false], ['reports-stored', true]]) {
      if (open) {
        await p.locator('.rp-monthly-open').first().click();
        await p.locator('.rp-stored').waitFor();
      }
      await p.waitForSelector('.rp-doc .rp-h2', { timeout: 20_000 });
      await p.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 30_000 });
      await p.waitForTimeout(600);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${name} ${size} ${colorScheme}: horizontal page scroll of ${overflow}px`);
      await p.mouse.move(1, 1);
      if (open) {
        // Viewport shot of the report itself (on phones it is scrolled into view).
        await p.locator('.rp-stored').scrollIntoViewIfNeeded();
        await shot(p, `${name}-${size}-${colorScheme}`);
      } else {
        await p.evaluate(async () => {
          for (let y = 0; y < document.body.scrollHeight; y += 500) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 40));
          }
          window.scrollTo(0, 0);
        });
        await p.waitForTimeout(300);
        await shot(p, `${name}-${size}-${colorScheme}`);
      }
    }
    assert.deepEqual(errors, [], `console errors (${size} ${colorScheme})`);
    await ctx.close();
  }
});

test('no console errors', () => {
  assert.deepEqual(h.consoleErrors, []);
});
