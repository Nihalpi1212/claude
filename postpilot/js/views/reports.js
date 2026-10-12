// Reports: a printable Instagram report built from the same numbers as Analytics.
// Builder (title, range, sections, optional AI summary) on the left, a paper-styled preview on
// the right. "Print or save as PDF" uses the browser's print dialog; css/views/reports.css hides
// the app chrome and the builder when printing.

import { html, useEffect, useMemo, useState } from '../../vendor/preact.js';
import { useApp } from '../app.js';
import { aiPrefs, getAi } from '../ai-client.js';
import { loadViewCss } from '../css.js';
import { setQuery } from '../router.js';
import { Avatar, Badge, Button, Callout, Checkbox, DataTable, EmptyState, Field, Menu, PageHeader, Panel, Skeleton, TextArea, TextInput, cx, formatValue } from '../ui/kit.js';
import { RangePicker, formatRangeLabel, rangeFromQuery, rangeToQuery, resolveRange } from '../ui/range-picker.js';
import { engagementRate, formatPercent, hashtagPerformance, interactionsOf, metricValue, topMedia } from '../../core/analytics.js';
import { addDaysKey, format } from '../../core/time.js';
import {
  AudienceCharts,
  BestTimesSection,
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
  mediaKindOf,
  previewOf,
  reelsOf,
  shortDateTime,
  storiesInRange,
  storyColumns,
  useAnalytics,
  useBestTimes,
} from './analytics.js';

loadViewCss('reports');

export const SECTIONS = [
  { id: 'summary', label: 'Summary', hint: 'Key numbers and the AI summary' },
  { id: 'followers', label: 'Follower growth' },
  { id: 'content', label: 'Content performance', hint: 'Reach, views, interactions, posting' },
  { id: 'top', label: 'Top posts' },
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
      return { title: typeof raw.title === 'string' ? raw.title : '', sections: raw.sections.filter((id) => SECTIONS.some((s) => s.id === id)) };
    }
  } catch {
    /* storage unavailable: use defaults */
  }
  return { title: '', sections: DEFAULT_SECTIONS };
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

function TopPostsTable({ ov, tz }) {
  const rows = topMedia(ov.posts, 'interactions', 5);
  if (!rows.length) return html`<p class="rp-empty">No post stats for this period.</p>`;
  const cols = [
    { key: 'thumb', label: '', width: 48, render: (m) => html`<${Thumb} src=${previewOf(m)} size=${36} kind=${mediaKindOf(m)} eager />` },
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
  return html`<div class="rp-table"><${DataTable} dense columns=${cols} rows=${rows} rowKey=${(m) => m.id} caption="Top posts" /></div>`;
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
export function ReportDocument({ a, ov, tz, title, sections, aiText, compare, account }) {
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
        <${Avatar} src=${account.profilePictureUrl} name=${account.name || account.username || 'Account'} size=${40} />
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
              <${InteractionsChart} ov=${ov} trend=${false} />
              <${PostingFrequency} ov=${ov} compare=${compare} />
            </div>
          </div>
        <//>`
      : null}
    ${on('top') ? html`<${Section} n=${next()} title="Top posts"><${TopPostsTable} ov=${ov} tz=${tz} /><//>` : null}
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

  const doExport = (kind) => {
    if (!a.ready) return;
    const count = kind === 'daily' ? exportDailyCsv(a) : exportPostsCsv(a, tz);
    toast(kind === 'daily' ? `Downloaded ${count} days of metrics.` : `Downloaded ${count} ${count === 1 ? 'post' : 'posts'}.`, { kind: 'success' });
  };

  return html`<div class="page rp-page">
    <${PageHeader} eyebrow="Measure" title="Reports" subtitle="Build a report of your results, then print it or save it as a PDF."
      actions=${html`
        <${Menu} label="Download CSV" align="end"
          trigger=${(p) => html`<${Button} ...${p} variant="secondary" icon="download" iconRight="chevron-down">Download CSV<//>`}
          items=${[
            { label: 'Daily metrics', icon: 'calendar', hint: 'CSV', onClick: () => doExport('daily'), disabled: !a.ready },
            { label: 'Posts', icon: 'grid', hint: 'CSV', onClick: () => doExport('posts'), disabled: !a.ready },
          ]} />
        <${Button} variant="primary" icon="printer" disabled=${!ov} onClick=${() => window.print()}>Print or save as PDF<//>`} />

    <div class="rp-layout">
      <aside class="rp-builder" aria-label="Report options">
        <${Panel} title="Report options">
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
                : html`<p class="field-hint">Add an Anthropic API key in <a href="#/settings?section=ai">Settings → AI</a> to add a written summary.</p>`}
            </div>
          </div>
        <//>
      </aside>

      <div class="rp-preview">
        <div class="rp-preview-label no-print"><${Badge} tone="outline" icon="file">Preview<//><span class="muted text-sm">This is what prints. Charts print in light colours.</span></div>
        ${a.error
          ? html`<${Callout} tone="danger" title="Could not open your analytics">${a.error.userMessage || a.error.message}<//>`
          : ov
            ? html`<${ReportDocument} a=${a} ov=${ov} tz=${tz} title=${title} sections=${prefs.sections} aiText=${aiText} compare=${compare} account=${account} />`
            : html`<div class="rp-doc" aria-busy="true"><${Skeleton} lines=${3} /><div style="height:16px"></div><${Skeleton} height=${180} /></div>`}
        ${ov && !ov.posts.length && !isNum(ov.current.reach)
          ? html`<${EmptyState} compact icon="chart" title="Nothing to report for this range yet" body="Pick another date range, or run the worker from Analytics to save fresh numbers." />`
          : null}
      </div>
    </div>
  </div>`;
}
