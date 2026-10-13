// Reports: a printable Instagram report built from the same numbers as Analytics.
// Builder (title, range, sections, optional AI summary, logo) on the left, a paper-styled preview on
// the right. "Print or save as PDF" uses the browser's print dialog; css/views/reports.css hides
// the app chrome and the builder when printing.
// Monthly reports saved by the worker (worker/jobs/reports.mjs, the `reports` document) are listed
// under "Monthly reports": open one to see its stored numbers (?report=<id>), or load its month into
// the builder (a whole month is compared with the month before, like the stored report). A month
// with under 90% of its days saved is flagged and not compared. Top-post thumbnails come from the
// library (posts Postpilot published) or the current analytics-media entry, since the Instagram URL
// stored with the report expires. The logo is a library image (reports.branding.logoAssetId); the
// Instagram profile picture is used when none is set.

import { html, useEffect, useMemo, useState } from '../../vendor/preact.js';
import { useApp } from '../app.js';
import { aiPrefs, getAi } from '../ai-client.js';
import { loadViewCss } from '../css.js';
import { mutate, useDoc } from '../data.js';
import { setQuery } from '../router.js';
import { StackedBar } from '../ui/charts.js';
import { MediaPicker, useAssetUrl } from '../ui/media-picker.js';
import { Avatar, Badge, Button, Callout, Checkbox, DataTable, EmptyState, Field, Menu, PageHeader, Panel, Select, Skeleton, Stat, TextArea, TextInput, cx, formatDelta, formatValue } from '../ui/kit.js';
import { RangePicker, formatRangeLabel, rangeFromQuery, rangeToQuery, resolveRange } from '../ui/range-picker.js';
import {
  campaignStats,
  engagementRate,
  formatPercent,
  hashtagPerformance,
  interactionsOf,
  mediaWithLabel,
  metricValue,
  monthBounds,
  monthCoverage,
  parseTimestamp,
  previousMonth,
  reportComparable,
  topMedia,
} from '../../core/analytics.js';
import { addDaysKey, format } from '../../core/time.js';
import {
  AudienceCharts,
  BestTimesSection,
  CampaignStats,
  FollowerReachChart,
  FollowersChart,
  InteractionsChart,
  KIND_LABEL,
  OverviewStats,
  PostingFrequency,
  ReachViewsChart,
  ReelViewsChart,
  ReelsSummary,
  StoriesSummary,
  Thumb,
  captionLine,
  computeOverview,
  exportDailyCsv,
  exportPostsCsv,
  hashtagColumns,
  labelOptions,
  mediaKindOf,
  previewOf,
  reelsOf,
  shortDateTime,
  storiesInRange,
  storyColumns,
  typeColor,
  typeLabel,
  typeOrder,
  useAnalytics,
  useBestTimes,
  ViewsByFormatChart,
} from './analytics.js';

loadViewCss('reports');

export const SECTIONS = [
  { id: 'summary', label: 'Summary', hint: 'Key numbers and the AI summary' },
  { id: 'followers', label: 'Follower growth' },
  { id: 'content', label: 'Content performance', hint: 'Reach, views, interactions, posting' },
  { id: 'top', label: 'Top posts' },
  { id: 'campaign', label: 'Campaign', hint: 'Posts with one label: totals, averages, top post' },
  { id: 'reels', label: 'Reels' },
  { id: 'stories', label: 'Stories' },
  { id: 'audience', label: 'Audience' },
  { id: 'best', label: 'Best times' },
  { id: 'hashtags', label: 'Hashtags' },
  { id: 'competitors', label: 'Competitors' },
];

const DEFAULT_SECTIONS = ['summary', 'followers', 'content', 'top', 'reels', 'stories', 'audience', 'best', 'hashtags'];
const PREFS_KEY = 'postpilot.report';

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    if (raw && Array.isArray(raw.sections)) {
      return {
        title: typeof raw.title === 'string' ? raw.title : '',
        sections: raw.sections.filter((id) => SECTIONS.some((s) => s.id === id)),
        campaignLabel: typeof raw.campaignLabel === 'string' ? raw.campaignLabel : '',
      };
    }
  } catch {
    /* storage unavailable: use defaults */
  }
  return { title: '', sections: DEFAULT_SECTIONS, campaignLabel: '' };
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d = 0) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const rel = (c, p) => (isNum(c) && isNum(p) && p !== 0 ? (c - p) / Math.abs(p) : null);
const signed = (n) => (isNum(n) ? `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatValue(Math.abs(n))}` : '—');

/** "September 2026" (long) or "Sep 2026" for a 'YYYY-MM' month. */
export function monthName(month, style = 'long') {
  const [y, m] = String(month).split('-').map(Number);
  if (!y || !m) return String(month || '');
  return format(new Date(Date.UTC(y, m - 1, 15)), 'UTC', { month: style, year: 'numeric' });
}

/** Compact, number-only description of the period for the AI summary (no ids, no URLs). */
function aiSummary(ov, a, username) {
  const c = ov.current;
  const p = ov.previous;
  return {
    account: username ? `@${username}` : undefined,
    period: a.range.label,
    days: a.range.days,
    previousPeriod: formatRangeLabel(a.prev.fromKey, a.prev.toKey),
    current: {
      followers: ov.followers.end,
      followerGrowth: ov.followers.growth,
      reach: c.reach,
      views: c.views,
      interactions: ov.interactions,
      engagementRate: round(ov.er, 4),
      accountsEngaged: c.accountsEngaged,
      profileLinkTaps: c.profileLinksTaps,
      postsPublished: ov.posts.length,
      postsPerWeek: round(ov.perWeek, 1),
    },
    previous: {
      followerGrowth: ov.followers.prevGrowth,
      reach: p.reach,
      views: p.views,
      interactions: ov.prevInteractions,
      engagementRate: round(ov.prevEr, 4),
      accountsEngaged: p.accountsEngaged,
      profileLinkTaps: p.profileLinksTaps,
      postsPublished: ov.prevPosts.length,
    },
    byPostType: ov.typeRows.map((r) => ({ type: KIND_LABEL[r.kind], posts: r.count, avgReach: round(r.avgReach), avgEngagementRate: round(r.avgEr, 4) })),
    topPosts: ov.top.map((m) => ({
      type: KIND_LABEL[mediaKindOf(m)],
      reach: metricValue(m, 'reach'),
      interactions: interactionsOf(m),
      engagementRate: round(engagementRate(m), 4),
      caption: captionLine(m.caption, 80),
    })),
  };
}

// ---------------------------------------------------------------------------
// Report sections

function Section({ n, title, children, class: cls }) {
  return html`<section class=${cx('rp-section', cls)} aria-labelledby=${`rp-s-${n}`}>
    <h2 class="rp-h2" id=${`rp-s-${n}`}><span class="rp-num">${String(n).padStart(2, '0')}</span>${title}</h2>
    ${children}
  </section>`;
}

/** A post's thumbnail: its library image when Postpilot published it (that one does not expire), else Instagram's. */
function PostThumb({ m, asset, size = 36 }) {
  const url = useAssetUrl(asset, 'thumb');
  return html`<${Thumb} src=${url || previewOf(m)} size=${size} kind=${mediaKindOf(m)} eager />`;
}

function TopPostsTable({ ov, tz, rows: given, caption = 'Top posts', assetFor }) {
  const rows = given || topMedia(ov.posts, 'interactions', 5);
  if (!rows.length) return html`<p class="rp-empty">No post stats for this period.</p>`;
  const cols = [
    {
      key: 'thumb',
      label: '',
      width: 48,
      render: (m) => (assetFor ? html`<${PostThumb} m=${m} asset=${assetFor(m)} />` : html`<${Thumb} src=${previewOf(m)} size=${36} kind=${mediaKindOf(m)} eager />`),
    },
    {
      key: 'post',
      label: 'Post',
      class: 'rp-caption-cell',
      render: (m) => html`<span class="rp-caption">${captionLine(m.caption, 70) || 'No caption'}</span>
        <span class="rp-post-meta"><span class="mono">${String(rows.indexOf(m) + 1).padStart(2, '0')}</span> · ${KIND_LABEL[mediaKindOf(m)]} · ${shortDateTime(m.timestamp, tz)}</span>`,
    },
    { key: 'reach', label: 'Reach', align: 'right', render: (m) => formatValue(metricValue(m, 'reach')) },
    { key: 'inter', label: 'Interactions', align: 'right', render: (m) => formatValue(interactionsOf(m)) },
    { key: 'er', label: 'Eng. rate', align: 'right', render: (m) => formatPercent(engagementRate(m)) },
  ];
  return html`<div class="rp-table"><${DataTable} dense columns=${cols} rows=${rows} rowKey=${(m) => m.id} caption=${caption} /></div>`;
}

/**
 * Campaign: the posts in the period that carry one label, their totals, averages and top post. Only in
 * the report once a label is chosen (the options panel says so), so no instruction to the app user prints.
 */
function CampaignBlock({ a, ov, tz, label }) {
  const list = mediaWithLabel(ov.posts, a.labels, label);
  if (!list.length) return html`<p class="rp-empty">No posts labelled “${label}” were published in this period.</p>`;
  const c = campaignStats(list);
  const top = c.top;
  const rows = [...list].sort((x, y) => parseTimestamp(y.timestamp) - parseTimestamp(x.timestamp));
  return html`<div class="stack rp-campaign">
    <p class="rp-note">${c.posts} ${c.posts === 1 ? 'post' : 'posts'} labelled “${label}” in this period. The change shows each average per post against all ${ov.posts.length} posts of the period.</p>
    <${CampaignStats} list=${list} all=${ov.posts} class="rp-stats" />
    ${top
      ? html`<div class="rp-campaign-top">
          <${Thumb} src=${previewOf(top)} size=${72} ratio="4 / 5" kind=${mediaKindOf(top)} eager />
          <div class="rp-campaign-top-text">
            <span class="label-caps muted">Top post</span>
            <span class="rp-caption">${captionLine(top.caption, 90) || 'No caption'}</span>
            <span class="rp-post-meta">${KIND_LABEL[mediaKindOf(top)]} · ${shortDateTime(top.timestamp, tz)} · ${formatValue(interactionsOf(top))} interactions · ${formatValue(metricValue(top, 'reach'))} reach</span>
          </div>
        </div>`
      : null}
    <${TopPostsTable} ov=${ov} tz=${tz} rows=${rows} caption=${`Posts labelled ${label}`} />
  </div>`;
}

function StoriesBlock({ a, tz }) {
  const stories = storiesInRange(a.storiesDoc, a.range, tz).sort((x, y) => (y.metrics?.reach ?? 0) - (x.metrics?.reach ?? 0));
  if (!stories.length) return html`<p class="rp-empty">No story stats were saved for this period.</p>`;
  const cols = storyColumns(tz).map((c) => ({ ...c, sortable: false }));
  return html`<div class="stack">
    <${StoriesSummary} stories=${stories} />
    <div class="rp-table"><${DataTable} dense columns=${cols} rows=${stories.slice(0, 10)} rowKey=${(s) => s.id} caption="Stories by reach" /></div>
    ${stories.length > 10 ? html`<p class="rp-note">The 10 stories with the most reach, of ${stories.length}.</p>` : null}
  </div>`;
}

function HashtagsBlock({ ov }) {
  const rows = hashtagPerformance(ov.posts, { minPosts: 2 }).slice(0, 10);
  if (!rows.length) return html`<p class="rp-empty">Not enough posts in this period to compare hashtags (each needs at least 2 posts).</p>`;
  const cols = hashtagColumns().map((c) => ({ ...c, sortable: false }));
  return html`<div class="rp-table"><${DataTable} dense columns=${cols} rows=${rows} rowKey=${(r) => r.tag} caption="Hashtags by engagement rate" /></div>`;
}

function usernameOf(account) {
  const raw = typeof account === 'string' ? account : account && account.username;
  return String(raw || '').trim().replace(/^@/, '').toLowerCase();
}

function CompetitorsBlock({ doc, range }) {
  const names = [...new Set(((doc && doc.accounts) || []).map(usernameOf).filter(Boolean))];
  if (!names.length) return html`<p class="rp-empty">No competitors are tracked yet. Add accounts on the Competitors screen.</p>`;
  const snaps = (doc && doc.snapshots) || {};
  const rows = names
    .map((u) => {
      const days = Object.keys(snaps[u] || {}).filter((k) => k <= range.toKey).sort();
      if (!days.length) return null;
      const last = snaps[u][days[days.length - 1]];
      const target = addDaysKey(days[days.length - 1], -30);
      const earlier = days.filter((k) => k <= target).pop() || days[0];
      const base = snaps[u][earlier];
      const change = isNum(last.followers) && isNum(base?.followers) && earlier !== days[days.length - 1] ? last.followers - base.followers : null;
      return { id: u, username: u, followers: last.followers, change, avgLikes: last.avgLikes, avgComments: last.avgComments, er: last.er, posts: last.postsLast30 };
    })
    .filter(Boolean);
  if (!rows.length) {
    return html`<p class="rp-empty">${doc && doc.status === 'needs_facebook_login'
      ? 'Competitor numbers need a Facebook Login connection. Connect it in Settings to compare accounts.'
      : 'The worker saves competitor numbers once a day. Check back tomorrow.'}</p>`;
  }
  const n = (v, d = 0) => formatValue(isNum(v) ? round(v, d) : null);
  const cols = [
    { key: 'username', label: 'Account', render: (r) => html`<span class="mono">@${r.username}</span>` },
    { key: 'followers', label: 'Followers', align: 'right', render: (r) => n(r.followers) },
    { key: 'change', label: '30-day change', align: 'right', render: (r) => (isNum(r.change) ? `${r.change > 0 ? '+' : r.change < 0 ? '−' : ''}${formatValue(Math.abs(r.change))}` : '—') },
    { key: 'avgLikes', label: 'Avg likes', align: 'right', render: (r) => n(r.avgLikes) },
    { key: 'avgComments', label: 'Avg comments', align: 'right', render: (r) => n(r.avgComments, 1) },
    { key: 'er', label: 'Eng. rate', align: 'right', render: (r) => formatPercent(r.er) },
    { key: 'posts', label: 'Posts (30 days)', align: 'right', render: (r) => n(r.posts) },
  ];
  return html`<div class="stack">
    <div class="rp-table"><${DataTable} dense columns=${cols} rows=${rows} caption="Competitors" /></div>
    <p class="rp-note">Competitor engagement rate is average likes and comments per post divided by followers (Instagram doesn't share their reach).</p>
  </div>`;
}

/** The printable document. */
/** Report header mark: the chosen logo, else the Instagram profile picture (or initials). */
function ReportMark({ logoUrl, account }) {
  return logoUrl
    ? html`<img class="rp-logo" src=${logoUrl} alt="Logo" />`
    : html`<${Avatar} src=${account.profilePictureUrl} name=${account.name || account.username || 'Account'} size=${40} />`;
}

export function ReportDocument({ a, ov, tz, title, sections, aiText, compare, account, logoUrl, campaignLabel }) {
  const on = (id) => sections.includes(id);
  const reels = reelsOf(ov);
  const bt = useBestTimes(a, tz);
  const generated = format(new Date(), tz, { month: 'long', day: 'numeric', year: 'numeric' });
  let n = 0;
  const next = () => ++n;
  const live = a.live.current && a.live.current.status === 'done';
  return html`<article class="rp-doc" aria-label="Report preview">
    <header class="rp-doc-head">
      <div class="rp-account">
        <${ReportMark} logoUrl=${logoUrl} account=${account} />
        <div class="rp-account-text">
          <span class="rp-account-name">${account.name || account.username || 'Instagram account'}</span>
          ${account.username ? html`<span class="rp-account-handle mono">@${account.username}</span>` : null}
        </div>
        <span class="spacer"></span>
        <span class="rp-generated mono">Generated ${generated}</span>
      </div>
      <h1 class="rp-title">${title}</h1>
      <p class="rp-range">
        <strong>${a.range.label}</strong>
        ${compare ? html`<span class="muted"> · compared with ${formatRangeLabel(a.prev.fromKey, a.prev.toKey)}</span>` : null}
      </p>
      ${live ? html`<p class="rp-note">Some daily numbers in this report were loaded live from Instagram because Postpilot had not saved them yet.</p>` : null}
    </header>

    ${!sections.length ? html`<p class="rp-empty">Choose at least one section to include.</p>` : null}

    ${on('summary')
      ? html`<${Section} n=${next()} title="Summary">
          ${aiText ? html`<p class="rp-ai pre-wrap">${aiText}</p>` : null}
          <${OverviewStats} ov=${ov} class="rp-stats" />
        <//>`
      : null}
    ${on('followers') ? html`<${Section} n=${next()} title="Follower growth"><${FollowersChart} ov=${ov} height=${200} /><//>` : null}
    ${on('content')
      ? html`<${Section} n=${next()} title="Content performance">
          <div class="stack">
            <${ReachViewsChart} ov=${ov} height=${200} />
            <div class="grid-2 rp-grid">
              <${FollowerReachChart} ov=${ov} compare=${compare} height=${170} />
              <${ViewsByFormatChart} ov=${ov} trend=${false} />
              <${InteractionsChart} ov=${ov} trend=${false} />
              <${PostingFrequency} ov=${ov} compare=${compare} />
            </div>
          </div>
        <//>`
      : null}
    ${on('top') ? html`<${Section} n=${next()} title="Top posts"><${TopPostsTable} ov=${ov} tz=${tz} /><//>` : null}
    ${on('campaign') && campaignLabel ? html`<${Section} n=${next()} title=${`Campaign: ${campaignLabel}`} class="rp-campaign-section"><${CampaignBlock} a=${a} ov=${ov} tz=${tz} label=${campaignLabel} /><//>` : null}
    ${on('reels')
      ? html`<${Section} n=${next()} title="Reels">
          ${reels.length
            ? html`<div class="stack"><${ReelsSummary} reels=${reels} /><${ReelViewsChart} reels=${reels} tz=${tz} height=${180} /></div>`
            : html`<p class="rp-empty">No reels were published in this period.</p>`}
        <//>`
      : null}
    ${on('stories') ? html`<${Section} n=${next()} title="Stories"><${StoriesBlock} a=${a} tz=${tz} /><//>` : null}
    ${on('audience')
      ? html`<${Section} n=${next()} title="Audience">
          <p class="rp-note">Followers over the last 30 days${a.audience && a.audience.fetchedAt ? `, updated ${format(a.audience.fetchedAt, tz, { month: 'short', day: 'numeric' })}` : ''}.</p>
          <${AudienceCharts} audience=${a.audience} who="follower" compact />
        <//>`
      : null}
    ${on('best') ? html`<${Section} n=${next()} title="Best times to post"><${BestTimesSection} bt=${bt} tz=${tz} count=${5} compact /><//>` : null}
    ${on('hashtags') ? html`<${Section} n=${next()} title="Hashtags"><${HashtagsBlock} ov=${ov} /><//>` : null}
    ${on('competitors') ? html`<${Section} n=${next()} title="Competitors"><${CompetitorsBlock} doc=${a.competitors} range=${a.range} /><//>` : null}

    <footer class="rp-foot">
      <span>Engagement rate = interactions ÷ reach.</span>
      <span>Made with Postpilot</span>
    </footer>
  </article>`;
}

// ---------------------------------------------------------------------------
// Monthly reports saved by the worker

/** Why a stored report's months are not compared (some days were not saved), or null. */
export function coverageNote(report) {
  const prevMonth = previousMonth(report.month);
  const cur = monthCoverage(report.summary, report.month);
  const pre = monthCoverage(report.previous, prevMonth);
  const part = (c, m) => `${c.saved ?? 0} of ${c.total} days of ${monthName(m)}`;
  if (!cur.complete && !pre.complete) {
    return pre.saved
      ? `Postpilot saved ${part(cur, report.month)} and ${part(pre, prevMonth)}, so these totals cover only the saved days and the two months are not compared.`
      : `Postpilot saved ${part(cur, report.month)} and has no numbers for ${monthName(prevMonth)}, so these totals cover only the saved days.`;
  }
  if (!cur.complete) return `Postpilot saved ${part(cur, report.month)}, so these totals cover only those days and are not compared with ${monthName(prevMonth)}.`;
  if (!pre.complete) {
    return pre.saved
      ? `Postpilot saved only ${part(pre, prevMonth)}, so ${monthName(report.month)} is not compared with it.`
      : `Postpilot has no numbers for ${monthName(prevMonth)}, so ${monthName(report.month)} is not compared with it.`;
  }
  return null;
}

/** The stored numbers of a monthly report (no live data: what the worker saved at the time). */
export function StoredReportDocument({ report, account, logoUrl, tz, media, assetFor }) {
  const s = report.summary || {};
  const p = report.previous || {};
  const label = monthName(report.month);
  const prevShort = monthName(previousMonth(report.month), 'short');
  const { fromKey, toKey } = monthBounds(report.month);
  const comparable = reportComparable(report);
  const note = coverageNote(report);
  const share = (x) => (isNum(x.nonFollowerReachShare) ? x.nonFollowerReachShare : isNum(x.reachNonFollowers) && (x.reachFollowers ?? 0) + x.reachNonFollowers > 0 ? x.reachNonFollowers / ((x.reachFollowers ?? 0) + x.reachNonFollowers) : null);
  // Month-on-month changes only when both months were (nearly) fully saved.
  const d = (c, pv) => (comparable ? rel(c, pv) ?? undefined : undefined);
  const vs = (v, kind = 'number') => (!comparable ? `Not compared with ${prevShort}` : isNum(v) ? `vs ${kind === 'percent' ? formatPercent(v) : formatValue(round(v))} in ${prevShort}` : `No numbers for ${prevShort}`);
  const followerLabel = isNum(s.followerGrowth) ? `${signed(s.followerGrowth)} this month` : isNum(s.followersEnd) ? 'Only one follower count saved' : 'No follower count saved';
  const tiles = [
    { label: 'Followers', value: s.followersEnd, delta: isNum(s.followerGrowthPct) ? s.followerGrowthPct : undefined, deltaLabel: followerLabel },
    { label: 'Reach', value: s.reach, delta: d(s.reach, p.reach), deltaLabel: vs(p.reach) },
    { label: 'Views', value: s.views, delta: d(s.views, p.views), deltaLabel: vs(p.views) },
    { label: 'Interactions', value: s.interactions, delta: d(s.interactions, p.interactions), deltaLabel: vs(p.interactions) },
    { label: 'Engagement rate', value: isNum(s.engagementRate) ? formatPercent(s.engagementRate) : null, delta: d(s.engagementRate, p.engagementRate), deltaLabel: vs(p.engagementRate, 'percent') },
    { label: 'Accounts engaged', value: s.accountsEngaged, delta: d(s.accountsEngaged, p.accountsEngaged), deltaLabel: vs(p.accountsEngaged) },
    // Posts are counted from their publish dates, not from the saved days: always comparable.
    { label: 'Posts published', value: s.posts, delta: rel(s.posts, p.posts) ?? undefined, deltaLabel: `${s.reels ?? 0} reels · ${s.stories ?? 0} stories saved` },
    { label: 'Non-follower reach', value: isNum(share(s)) ? formatPercent(share(s)) : null, deltaLabel: isNum(share(p)) ? `${formatPercent(share(p))} in ${prevShort}` : `Not saved for ${prevShort}` },
  ];
  const types = s.viewsByType && typeof s.viewsByType === 'object' ? Object.entries(s.viewsByType).filter(([, v]) => isNum(v) && v > 0).sort(([x], [y]) => typeOrder(x) - typeOrder(y)) : [];
  const partialTypes = isNum(s.viewsByTypeDays) && isNum(s.daysSaved) && s.viewsByTypeDays < s.daysSaved;
  // The thumbnail URL saved with the report expires: prefer the current one from analytics-media.
  const top = (report.top || []).map((m) => {
    const now = media && media.get(String(m.id));
    return now && previewOf(now) ? { ...m, thumbnailUrl: previewOf(now) } : m;
  });
  const created = parseTimestamp(report.createdAt);
  return html`<article class="rp-doc rp-stored" aria-label=${`Monthly report for ${label}`}>
    <header class="rp-doc-head">
      <div class="rp-account">
        <${ReportMark} logoUrl=${logoUrl} account=${account} />
        <div class="rp-account-text">
          <span class="rp-account-name">${account.name || account.username || 'Instagram account'}</span>
          ${account.username ? html`<span class="rp-account-handle mono">@${account.username}</span>` : null}
        </div>
        <span class="spacer"></span>
        <span class="rp-generated mono">${Number.isFinite(created) ? `Saved ${format(new Date(created), tz, { month: 'long', day: 'numeric', year: 'numeric' })}` : 'Saved by the worker'}</span>
      </div>
      <h1 class="rp-title">Monthly report · ${label}</h1>
      <p class="rp-range"><strong>${formatRangeLabel(fromKey, toKey)}</strong>${comparable ? html`<span class="muted"> · compared with ${monthName(previousMonth(report.month))}</span>` : null}</p>
      ${note ? html`<p class="rp-note rp-coverage">${note}</p>` : null}
      <p class="rp-note">These are the numbers the worker saved when it made this report. Instagram can still adjust its numbers for a few days, so Analytics may show slightly different totals.</p>
    </header>
    <${Section} n=${1} title="Summary">
      ${report.ai ? html`<p class="rp-ai pre-wrap">${report.ai}</p>` : null}
      <div class="stats an-stats rp-stats">
        ${tiles.map((t) => html`<${Stat} key=${t.label} label=${t.label} value=${t.value ?? '—'} format=${isNum(t.value) && Math.abs(t.value) >= 100000 ? 'compact' : 'number'} delta=${t.delta} deltaLabel=${t.deltaLabel} />`)}
      </div>
    <//>
    <${Section} n=${2} title="Views by format">
      ${types.length
        ? html`<${StackedBar} label="Views by format" format="compact" segments=${types.map(([t, v]) => ({ label: typeLabel(t), value: v, color: typeColor(t) }))} />
            ${partialTypes ? html`<p class="rp-note">Instagram's split by format was saved for ${s.viewsByTypeDays} of the ${s.daysSaved} days, so these parts add up to less than the month's views.</p>` : null}`
        : html`<p class="rp-empty">Instagram's split of views by format was not saved for this month.</p>`}
    <//>
    <${Section} n=${3} title="Top posts">
      <${TopPostsTable} ov=${{ posts: [] }} tz=${tz} rows=${top} assetFor=${assetFor} />
    <//>
    <footer class="rp-foot">
      <span>Engagement rate = interactions ÷ reach.</span>
      <span>Made with Postpilot</span>
    </footer>
  </article>`;
}

/** List of monthly reports (newest first): open one, or load its month in the builder. */
function MonthlyReports({ doc, openId, onOpen, onLoad }) {
  const [all, setAll] = useState(false);
  const list = ((doc && doc.reports) || []).filter((r) => r && r.month);
  const shown = all ? list : list.slice(0, 4);
  return html`<${Panel} title="Monthly reports" class="rp-monthly">
    ${list.length
      ? html`<ul class="list rp-monthly-list">
          ${shown.map(
            (r, i) => html`<li key=${r.id || r.month} class=${cx('list-row rp-monthly-row', openId === r.id && 'is-open')}>
              <button type="button" class="rp-monthly-open" aria-pressed=${openId === r.id} onClick=${() => onOpen(r)}>
                <span class="rp-monthly-month">${monthName(r.month)}${i === 0 && Date.now() - parseTimestamp(r.createdAt) < 7 * 864e5 ? html` <${Badge} tone="accent">New<//>` : null}</span>
                <span class="rp-monthly-headline" title=${r.headline || ''}>${r.headline || 'Open to see the numbers'}</span>
              </button>
              <${Button} size="sm" variant="ghost" icon="calendar" class="rp-monthly-load" onClick=${() => onLoad(r)}
                aria-label=${`Load ${monthName(r.month)} in the builder`} title="Load this month in the builder" />
            </li>`,
          )}
        </ul>
        ${list.length > shown.length || all ? html`<${Button} size="sm" variant="ghost" onClick=${() => setAll(!all)}>${all ? 'Show fewer' : `Show all ${list.length}`}<//>` : null}`
      : html`<p class="field-hint rp-monthly-empty">The worker saves a report for last month on the 2nd or 3rd of each month, once it has saved that month's numbers.</p>`}
  <//>`;
}

/** Logo picker: a library image, or the Instagram profile picture when none is chosen. */
function LogoField({ branding, library, account, logoUrl }) {
  const { toast } = useApp();
  const [picking, setPicking] = useState(false);
  const id = branding && branding.logoAssetId;
  const asset = id ? ((library && library.assets) || []).find((x) => x.id === id) : null;
  const save = async (assetId) => {
    try {
      await mutate(
        'reports',
        (d) => {
          d.branding = { ...(d.branding || {}) };
          if (assetId) d.branding.logoAssetId = assetId;
          else delete d.branding.logoAssetId;
        },
        { message: assetId ? 'reports: logo' : 'reports: remove logo' },
      );
      toast(assetId ? 'Logo saved. It appears on every report.' : 'Reports use your profile picture again.', { kind: 'success' });
    } catch {
      /* mutate already showed the error */
    }
  };
  return html`<div class="field rp-logo-field">
    <span class="field-label">Logo</span>
    <div class="rp-logo-row">
      <span class="rp-logo-preview"><${ReportMark} logoUrl=${logoUrl} account=${account} /></span>
      <div class="stack-sm stack rp-logo-actions">
        <div class="row">
          <${Button} size="sm" variant="secondary" icon="image" onClick=${() => setPicking(true)}>${asset ? 'Change logo' : 'Choose from library'}<//>
          ${id ? html`<${Button} size="sm" variant="ghost" onClick=${() => save(null)}>Use profile picture<//>` : null}
        </div>
        <span class="field-hint">${asset ? asset.name || 'Library image' : id ? 'The chosen logo is no longer in the library, so your profile picture is used.' : 'Your Instagram profile picture is used until you choose a logo.'}</span>
      </div>
    </div>
    <${MediaPicker} open=${picking} onClose=${() => setPicking(false)} multiple=${false} kinds=${['image']} title="Choose a logo" confirmLabel="Use as logo"
      initialSelected=${asset ? [asset.id] : []}
      onPick=${(list) => {
        setPicking(false);
        if (list && list[0]) save(list[0].id);
      }} />
  </div>`;
}

// ---------------------------------------------------------------------------
// Screen

export default function ReportsView() {
  const { route, tz, settings, toast } = useApp();
  const q = route.query || {};
  const sel = rangeFromQuery(q);
  const compare = q.compare !== '0';
  const range = resolveRange(sel, tz);
  const a = useAnalytics(range, { compare });
  const ov = useMemo(() => (a.ready ? computeOverview(a, tz, { compare }) : null), [a.days, a.media, a.ready, range.fromKey, range.toKey, a.live.previous && a.live.previous.status, tz, compare]);

  const [prefs, setPrefs] = useState(loadPrefs);
  useEffect(() => savePrefs(prefs), [prefs]);
  const reportsDoc = useDoc('reports').data;
  const library = useDoc('library').data;
  const branding = (reportsDoc && reportsDoc.branding) || {};
  const logoAsset = branding.logoAssetId ? ((library && library.assets) || []).find((x) => x.id === branding.logoAssetId) || null : null;
  const logoUrl = useAssetUrl(logoAsset, 'thumb');
  const stored = q.report ? ((reportsDoc && reportsDoc.reports) || []).find((r) => r && r.id === q.report) || null : null;
  const mediaById = useMemo(() => new Map((a.media || []).map((m) => [String(m.id), m])), [a.media]);
  // Library image of a post Postpilot published (its cover, else its first media item).
  const assetFor = (m) => {
    const post = a.postsByMedia && a.postsByMedia.get(String(m.id));
    const id = post && (post.coverAssetId || (post.media && post.media[0] && post.media[0].assetId));
    return id ? ((library && library.assets) || []).find((x) => x.id === id) || null : null;
  };
  const loadMonth = (r) => {
    const { fromKey, toKey } = monthBounds(r.month);
    setQuery({ range: 'custom', from: fromKey, to: toKey, report: undefined });
  };
  // On narrow screens the report sits below the list: bring it into view when one is opened.
  useEffect(() => {
    if (!stored || !globalThis.matchMedia || !globalThis.matchMedia('(max-width: 1100px)').matches) return;
    document.querySelector('.rp-preview')?.scrollIntoView({ block: 'start' });
  }, [stored && stored.id]);
  const campaignOpts = useMemo(() => (ov ? labelOptions(ov.posts, a.labels, prefs.campaignLabel) : []), [ov, a.labels, prefs.campaignLabel]);
  const [aiText, setAiText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState(null);
  useEffect(() => setAiError(null), [range.fromKey, range.toKey]);

  const account = (settings && settings.ig) || {};
  const defaultTitle = `${account.name || (account.username ? `@${account.username}` : 'Instagram')} · Instagram report`;
  const title = prefs.title.trim() || defaultTitle;
  const ai = getAi(settings);

  const toggleSection = (id, checked) =>
    setPrefs((p) => ({ ...p, sections: SECTIONS.map((s) => s.id).filter((x) => (x === id ? checked : p.sections.includes(x))) }));
  const allOn = prefs.sections.length === SECTIONS.length;

  const writeSummary = async () => {
    if (!ai || !ov) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const text = await ai.explain({ summary: aiSummary(ov, a, account.username), language: aiPrefs(settings).language });
      setAiText(String(text || '').trim());
      if (!prefs.sections.includes('summary')) toggleSection('summary', true);
    } catch (err) {
      setAiError(err.userMessage || err.message || String(err));
    } finally {
      setAiBusy(false);
    }
  };

  // While a saved monthly report is open, the CSV covers its month (not the hidden builder range).
  const csvSource = stored ? { ...a, range: { ...a.range, ...monthBounds(stored.month) } } : a;
  const csvHint = stored ? monthName(stored.month, 'short') : 'CSV';
  const doExport = (kind) => {
    if (!a.ready) return;
    const count = kind === 'daily' ? exportDailyCsv(csvSource) : exportPostsCsv(csvSource, tz);
    toast(kind === 'daily' ? `Downloaded ${count} days of metrics.` : `Downloaded ${count} ${count === 1 ? 'post' : 'posts'}.`, { kind: 'success' });
  };

  return html`<div class="page rp-page">
    <${PageHeader} eyebrow="Measure" title="Reports" subtitle="Build a report of your results, then print it or save it as a PDF."
      actions=${html`
        <${Menu} label="Download CSV" align="end"
          trigger=${(p) => html`<${Button} ...${p} variant="secondary" icon="download" iconRight="chevron-down">Download CSV<//>`}
          items=${[
            { label: 'Daily metrics', icon: 'calendar', hint: csvHint, onClick: () => doExport('daily'), disabled: !a.ready },
            { label: 'Posts', icon: 'grid', hint: csvHint, onClick: () => doExport('posts'), disabled: !a.ready },
          ]} />
        <${Button} variant="primary" icon="printer" disabled=${!ov && !stored} onClick=${() => window.print()}>Print or save as PDF<//>`} />

    <div class="rp-layout">
      <aside class="rp-builder" aria-label="Report options">
        <${MonthlyReports} doc=${reportsDoc} openId=${stored && stored.id} onOpen=${(r) => setQuery({ report: r.id })} onLoad=${loadMonth} />
        ${stored ? null : html`<${Panel} title="Report options">
          <div class="stack">
            <${Field} label="Title">
              <${TextInput} value=${prefs.title} placeholder=${defaultTitle} onChange=${(v) => setPrefs((p) => ({ ...p, title: v }))} />
            <//>
            <div class="field">
              <span class="field-label" id="rp-range-label">Date range</span>
              <${RangePicker} class="rp-range-picker" value=${sel} tz=${tz} onChange=${(next) => setQuery(rangeToQuery(next))}
                compare=${compare} onCompareChange=${(v) => setQuery({ compare: v ? undefined : '0' })} />
            </div>
            <fieldset class="rp-sections">
              <legend class="field-label">Sections</legend>
              <div class="rp-section-list">
                ${SECTIONS.map(
                  (s) => html`<${Checkbox} key=${s.id} label=${s.label} hint=${s.hint} checked=${prefs.sections.includes(s.id)}
                    onChange=${(v) => toggleSection(s.id, v)} />`,
                )}
              </div>
              <${Button} size="sm" variant="ghost" onClick=${() => setPrefs((p) => ({ ...p, sections: allOn ? [] : SECTIONS.map((s) => s.id) }))}>
                ${allOn ? 'Clear all' : 'Select all'}
              <//>
            </fieldset>
            ${prefs.sections.includes('campaign')
              ? html`<${Field} label="Campaign"
                  hint=${!campaignOpts.length
                    ? 'No post in this range has a label, so the Campaign section is left out. Add labels in the composer (for example a campaign name).'
                    : prefs.campaignLabel
                      ? 'Posts in the date range that carry this label.'
                      : 'Choose a label, or the Campaign section is left out of the report.'}>
                  <${Select} options=${campaignOpts} value=${prefs.campaignLabel || null} placeholder="Choose a label"
                    onChange=${(v) => setPrefs((p) => ({ ...p, campaignLabel: v || '' }))} />
                <//>`
              : null}
            <${LogoField} branding=${branding} library=${library} account=${account} logoUrl=${logoUrl} />
            <div class="rp-ai-box stack-sm stack">
              <span class="field-label">AI summary</span>
              ${ai
                ? html`<p class="field-hint">Claude reads the numbers in this report and writes a short plain-language summary. You can edit it before printing.</p>
                    <div class="row">
                      <${Button} size="sm" variant="secondary" icon="sparkle" loading=${aiBusy} disabled=${!ov} onClick=${writeSummary}>${aiText ? 'Write it again' : 'Write a summary'}<//>
                      ${aiText ? html`<${Button} size="sm" variant="ghost" onClick=${() => setAiText('')}>Remove<//>` : null}
                    </div>
                    ${aiError ? html`<${Callout} tone="danger" title="Could not write the summary">${aiError}<//>` : null}
                    ${aiText ? html`<${TextArea} aria-label="AI summary text" value=${aiText} onChange=${setAiText} rows=${4} />` : null}`
                : html`<p class="field-hint">Turn on AI in <a href="#/settings?section=ai">Settings → AI</a> (an Anthropic API key and “Use AI features”) to add a written summary.</p>`}
            </div>
          </div>
        <//>`}
      </aside>

      <div class="rp-preview">
        ${stored
          ? html`<div class="rp-preview-label no-print">
              <${Button} size="sm" variant="secondary" icon="arrow-left" onClick=${() => setQuery({ report: undefined })}>Back to the builder<//>
              <span class="muted text-sm">Saved by the worker</span>
              <span class="spacer"></span>
              <${Button} size="sm" variant="ghost" icon="calendar" onClick=${() => loadMonth(stored)}>Load ${monthName(stored.month, 'short')} in the builder<//>
            </div>
            <${StoredReportDocument} report=${stored} account=${account} logoUrl=${logoUrl} tz=${tz} media=${mediaById} assetFor=${assetFor} />`
          : html`<div class="rp-preview-label no-print"><${Badge} tone="outline" icon="file">Preview<//><span class="muted text-sm">This is what prints. Charts print in light colours.</span></div>
            ${q.report && reportsDoc ? html`<${Callout} tone="warning" title="That monthly report is no longer saved">Only the last 24 monthly reports are kept.<//>` : null}
            ${a.error
              ? html`<${Callout} tone="danger" title="Could not open your analytics">${a.error.userMessage || a.error.message}<//>`
              : ov
                ? html`<${ReportDocument} a=${a} ov=${ov} tz=${tz} title=${title} sections=${prefs.sections} aiText=${aiText} compare=${compare} account=${account}
                    logoUrl=${logoUrl} campaignLabel=${prefs.campaignLabel} />`
                : html`<div class="rp-doc" aria-busy="true"><${Skeleton} lines=${3} /><div style="height:16px"></div><${Skeleton} height=${180} /></div>`}
            ${ov && !ov.posts.length && !isNum(ov.current.reach)
              ? html`<${EmptyState} compact icon="chart" title="Nothing to report for this range yet" body="Pick another date range, or run the worker from Analytics to save fresh numbers." />`
              : null}`}
      </div>
    </div>
  </div>`;
}
