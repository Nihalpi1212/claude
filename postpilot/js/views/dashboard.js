// Today: the first screen after unlock. Summary first (what goes out next, what needs you, reminder
// posts to post by hand), then detail (KPIs, the coming week, up next, inbox / autopilot / automations,
// recent post performance).

import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { runBroken, useApp } from '../app.js';
import { readDoc, useDocs } from '../data.js';
import { loadViewCss } from '../css.js';
import { thumbUrl, uploadFiles } from '../media.js';
import { getAi } from '../ai-client.js';
import { buildHash } from '../router.js';
import { Avatar, Button, Callout, EmptyState, Frame, Icon, PageHeader, Panel, Skeleton, Stat, StatusPill, cx } from '../ui/kit.js';
import { addDaysKey, dayKey, dayRange, format, formatTime, relative } from '../../core/time.js';
import { comparePeriods, engagementRate, formatNumber, formatPercent, interactionsOf, parseTimestamp, seriesFor, toList } from '../../core/analytics.js';
import { unusedAssets } from '../../core/schedule.js';

loadViewCss('dashboard');

const DAY_MS = 864e5;
const TYPE_LABEL = { feed: 'Post', carousel: 'Carousel', reel: 'Reel', story: 'Story' };
const TYPE_ICON = { feed: 'image', carousel: 'carousel', reel: 'reel', story: 'story' };
const FRAME_KIND = { carousel: 'carousel', reel: 'reel', story: 'story' };

// ---------------------------------------------------------------------------
// Small helpers

/**
 * useDocs plus one re-render once every document has loaded. Works around a race in data.js: when a load
 * resolves between the first render and useDocs' subscribe effect, the change notification is missed.
 */
function useLoadedDocs(names) {
  const res = useDocs(names);
  const [, bump] = useState(0);
  const key = names.join('|');
  useEffect(() => {
    let alive = true;
    Promise.all(names.map((n) => readDoc(n).catch(() => null))).then(() => alive && bump((x) => x + 1));
    return () => {
      alive = false;
    };
  }, [key]);
  return res;
}

const plural = (n, one, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

function keyDiff(a, b) {
  const t = (k) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
  return Math.round((t(a) - t(b)) / DAY_MS);
}

/** "today at 5:00 PM", "tomorrow at 12:00 PM", "Wednesday at 9:30 AM", "Oct 22 at 6:00 PM". */
export function whenLabel(iso, tz, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = keyDiff(dayKey(d, tz), dayKey(now, tz));
  const t = formatTime(d, tz);
  if (diff === 0) return `today at ${t}`;
  if (diff === 1) return `tomorrow at ${t}`;
  if (diff === -1) return `yesterday at ${t}`;
  if (diff > 1 && diff < 7) return `${format(d, tz, { weekday: 'long' })} at ${t}`;
  return `${format(d, tz, { month: 'short', day: 'numeric' })} at ${t}`;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "5 min. ago" for a past timestamp; never "in 2 sec." when clocks disagree slightly. */
function ago(iso) {
  const n = Date.now();
  const t = parseTimestamp(iso);
  return relative(new Date(Number.isFinite(t) ? Math.min(t, n) : n), new Date(n));
}

/** Countdown for an upcoming time: "in 40 minutes", "in 21 hours", "in 3 days". */
function eta(iso) {
  const ms = parseTimestamp(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms < 3600e3) return `in ${Math.max(1, Math.round(ms / 60e3))} min`;
  if (ms < 48 * 3600e3) return `in ${Math.round(ms / 3600e3)} hours`;
  return `in ${Math.round(ms / DAY_MS)} days`;
}

function excerpt(text, n = 90) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/** Decrypted thumbnail object URL for a library asset (null while loading or when missing). */
function useThumb(asset) {
  const [src, setSrc] = useState(null);
  const path = asset ? asset.thumbPath : null;
  useEffect(() => {
    if (!asset) return undefined;
    let alive = true;
    setSrc(null);
    thumbUrl(asset)
      .then((u) => alive && setSrc(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path]);
  return src;
}

function PostThumb({ post, assetsById, size = 56 }) {
  const first = post.media && post.media[0];
  const asset = first ? assetsById.get(first.assetId) : null;
  const src = useThumb(asset);
  return html`<${Frame} src=${src} alt="" size=${size} kind=${FRAME_KIND[post.type] || (asset && asset.kind === 'video' ? 'video' : undefined)} class="dash-thumb" />`;
}

/** Followers now and over the last 7 days, from daily snapshots (net follows when older counts are missing). */
function followerSummary(days, today, fallbackCount) {
  const map = days || {};
  const keys = Object.keys(map)
    .filter((k) => k <= today && map[k] && typeof map[k].followers === 'number')
    .sort();
  const latestKey = keys[keys.length - 1] || null;
  const latest = latestKey ? map[latestKey].followers : typeof fallbackCount === 'number' ? fallbackCount : null;
  const net = (k) => {
    const s = map[k];
    return s && typeof s.followsGained === 'number' ? s.followsGained - (typeof s.unfollows === 'number' ? s.unfollows : 0) : null;
  };
  let prev = null;
  const weekAgo = addDaysKey(today, -7);
  for (let i = 0; i <= 3 && prev == null; i++) {
    const s = map[addDaysKey(weekAgo, -i)];
    if (s && typeof s.followers === 'number') prev = s.followers;
  }
  let change = null;
  if (latest != null && prev != null) change = latest - prev;
  else {
    const nets = dayRange(addDaysKey(today, -7), addDaysKey(today, -1)).map(net).filter((v) => v != null);
    if (nets.length) change = nets.reduce((a, b) => a + b, 0);
  }
  const pct = change != null && latest != null && latest - change > 0 ? change / (latest - change) : null;
  // Sparkline: walk back from today's count using daily net follows.
  let spark = null;
  if (latest != null) {
    const keys14 = dayRange(addDaysKey(today, -13), today);
    const vals = new Array(keys14.length);
    let v = latest;
    let known = 0;
    for (let i = keys14.length - 1; i >= 0; i--) {
      vals[i] = v;
      const n = net(keys14[i]);
      if (n != null) {
        known++;
        v -= n;
      }
    }
    if (known >= 3) spark = vals;
  }
  return { latest, change, pct, spark };
}

function interactionsSum(summary) {
  if (typeof summary.totalInteractions === 'number') return summary.totalInteractions;
  return interactionsOf(summary);
}

/** Alerts, most serious first. Each: {id, tone, title, body, action: {label, href|onClick}}. */
function buildAlerts({ settings, log, posts, automations, now, dispatchWorker }) {
  const out = [];
  const ig = settings && settings.ig;
  if (ig) {
    const expiresMs = parseTimestamp(ig.tokenExpiresAt);
    const daysLeft = Number.isFinite(expiresMs) ? Math.floor((expiresMs - now) / DAY_MS) : null;
    if ((ig.status && ig.status.state === 'expired') || (daysLeft != null && expiresMs <= now)) {
      out.push({
        id: 'token-expired',
        tone: 'danger',
        title: 'Instagram is disconnected',
        body: (ig.status && ig.status.message) || 'Your Instagram login expired. Posts set to publish automatically wait until you connect again; reminder posts still come due.',
        action: { label: 'Reconnect', href: '#/settings?section=instagram' },
      });
    } else if (daysLeft != null && daysLeft < 10) {
      out.push({
        id: 'token-expiring',
        tone: 'warning',
        title: `Your Instagram login expires in ${plural(Math.max(daysLeft, 0), 'day')}`,
        body: 'Postpilot renews it automatically, but the last renewal did not go through. Replace the token in Settings to keep publishing.',
        action: { label: 'Open settings', href: '#/settings?section=instagram' },
      });
    }
  }

  const runs = (log && log.runs) || [];
  const last = runs[0];
  if (!log) {
    /* still loading */
  } else if (!last) {
    out.push({
      id: 'worker-never',
      tone: 'warning',
      title: 'The worker has not run yet',
      body: 'Scheduled posts, auto-replies and analytics all come from the worker. Connect it in Settings so it runs every 10 minutes.',
      action: { label: 'Set up the worker', href: '#/settings?section=worker' },
    });
  } else if (runBroken(last)) {
    // Not for a run whose only problem was a failed post: that post has its own alert below.
    const err = (last.errors || [])[0];
    out.push({
      id: 'worker-failed',
      tone: 'danger',
      title: 'The last worker run had a problem',
      body: err && err.message ? err.message : 'Open Settings → Worker to see what went wrong.',
      action: { label: 'See details', href: '#/settings?section=worker' },
    });
  } else {
    const at = parseTimestamp(last.finishedAt || last.startedAt);
    const ageMin = (now - at) / 60000;
    if (Number.isFinite(ageMin) && ageMin > 90) {
      out.push({
        id: 'worker-late',
        tone: 'warning',
        title: 'The worker is running late',
        body: `It last ran ${ago(at)}. GitHub sometimes delays scheduled runs; if this lasts, check Settings → Worker.`,
        action: { label: 'Run it now', onClick: () => dispatchWorker('dashboard').catch(() => {}) },
      });
    }
  }

  const list = (posts && posts.posts) || [];
  const failed = list.filter((p) => p.status === 'failed');
  if (failed.length) {
    const first = failed.slice().sort((a, b) => (parseTimestamp(b.updatedAt) || 0) - (parseTimestamp(a.updatedAt) || 0))[0];
    out.push({
      id: 'failed',
      tone: 'danger',
      title: `${plural(failed.length, 'post')} failed to publish`,
      body: (first.lastError && first.lastError.message) || 'Open the post to see what Instagram said and try again.',
      action: { label: 'Review', href: buildHash('planner', { view: 'list' }) },
    });
  }
  const approvals = list.filter((p) => p.status === 'draft' && p.needsApproval);
  if (approvals.length) {
    out.push({
      id: 'approval',
      tone: 'marker',
      title: `${plural(approvals.length, 'autopilot draft')} waiting for your approval`,
      body: 'Approve them to schedule, or reject the ones you do not want.',
      action: { label: 'Review drafts', href: '#/autopilot' },
    });
  }

  const dm = automations && automations.status && automations.status.dm;
  if (dm && dm !== 'ok') {
    const titles = {
      needs_advanced_access: 'Instagram is not letting Postpilot send DMs',
      dm_disabled: 'Message access is turned off in Instagram',
      no_permission: 'Postpilot cannot read or send DMs',
    };
    out.push({
      id: 'dm',
      tone: 'warning',
      title: titles[dm] || 'Automated DMs are blocked',
      body: automations.status.message || 'DM rules and the welcome message are paused until this is fixed.',
      action: { label: 'How to fix', href: '#/automations' },
    });
  }

  const ai = settings && settings.ai;
  if (ai && ai.enabled && ai.apiKey && log) {
    const bad = (log.entries || []).find(
      (e) => (e.level === 'warn' || e.level === 'error') && /api key/i.test(e.message || '') && now - parseTimestamp(e.at) < 3 * DAY_MS,
    );
    if (bad) {
      out.push({
        id: 'ai-key',
        tone: 'warning',
        title: 'Your Anthropic API key was rejected',
        body: 'AI captions and replies are paused; autopilot uses caption hints instead. Add a valid key in Settings → AI.',
        action: { label: 'Open AI settings', href: '#/settings?section=ai' },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sections

function AlertList({ alerts }) {
  if (!alerts.length) return null;
  return html`<section class="dash-alerts stack-sm" aria-label="Needs your attention">
    ${alerts.map(
      (a) => html`<${Callout} key=${a.id} tone=${a.tone} title=${a.title}
        action=${a.action
          ? a.action.href
            ? html`<${Button} size="sm" variant="secondary" href=${a.action.href}>${a.action.label}<//>`
            : html`<${Button} size="sm" variant="secondary" onClick=${a.action.onClick}>${a.action.label}<//>`
          : null}>
        ${a.body}
      <//>`,
    )}
  </section>`;
}

function HealthItem({ tone, label, title, href }) {
  const inner = html`<span class="dot" aria-hidden="true"></span><span>${label}</span>`;
  return href
    ? html`<li><a class=${cx('dash-health-item', `is-${tone}`)} href=${href} title=${title}>${inner}</a></li>`
    : html`<li class=${cx('dash-health-item', `is-${tone}`)} title=${title}>${inner}</li>`;
}

function AccountStrip({ settings, followers, log, now }) {
  const ig = (settings && settings.ig) || {};
  const last = log && log.runs && log.runs[0];
  let worker;
  if (!log) worker = { tone: 'neutral', label: 'Checking the worker…' };
  else if (!last) worker = { tone: 'warn', label: 'Worker not running yet' };
  else {
    const at = new Date(last.finishedAt || last.startedAt);
    const late = (now - at.getTime()) / 60000 > 90;
    worker = runBroken(last) ? { tone: 'bad', label: `Worker had a problem ${ago(at)}` } : { tone: late ? 'warn' : 'ok', label: `Worker ran ${ago(at)}` };
  }
  const exp = parseTimestamp(ig.tokenExpiresAt);
  const daysLeft = Number.isFinite(exp) ? Math.floor((exp - now) / DAY_MS) : null;
  const login =
    ig.status && ig.status.state === 'expired'
      ? { tone: 'bad', label: 'Instagram login expired' }
      : daysLeft == null
        ? { tone: 'ok', label: 'Instagram connected' }
        : daysLeft < 0
          ? { tone: 'bad', label: 'Instagram login expired' }
          : { tone: daysLeft < 10 ? 'warn' : 'ok', label: `Login renews in ${plural(daysLeft, 'day')}` };
  const aiOn = !!getAi(settings);
  const change = followers.change;
  return html`<section class="dash-account" aria-label="Account">
    <div class="dash-id">
      <${Avatar} src=${ig.profilePictureUrl} name=${ig.name || ig.username || 'Instagram'} size=${52} />
      <div class="dash-id-text">
        <div class="dash-name">${ig.name || ig.username || 'Instagram account'}</div>
        ${ig.username
          ? html`<a class="dash-handle" href=${`https://www.instagram.com/${encodeURIComponent(ig.username)}/`} target="_blank" rel="noopener noreferrer">@${ig.username}</a>`
          : null}
      </div>
    </div>
    <div class="dash-followers">
      <span class="dash-followers-value num">${followers.latest == null ? '—' : formatNumber(followers.latest)}</span>
      <span class="dash-followers-label">followers</span>
      ${change != null
        ? html`<span class=${cx('dash-followers-change', change > 0 && 'is-up', change < 0 && 'is-down')}>
            ${change > 0 ? '+' : change < 0 ? '−' : '±'}${formatNumber(Math.abs(change))} this week
          </span>`
        : null}
    </div>
    <ul class="dash-health" aria-label="System status">
      <${HealthItem} tone=${worker.tone} label=${worker.label} href="#/settings?section=worker" title="Worker status" />
      <${HealthItem} tone=${login.tone} label=${login.label} href="#/settings?section=instagram" title="Instagram connection" />
      <${HealthItem} tone=${aiOn ? 'ok' : 'neutral'} label=${aiOn ? 'AI captions on' : 'AI captions off'} href="#/settings?section=ai" title="AI assistant" />
    </ul>
  </section>`;
}

function KpiStrip({ days, today, followers, source, liveError, loading }) {
  const from = addDaysKey(today, -7);
  const to = addDaysKey(today, -1);
  const cmp = days ? comparePeriods(days, from, to) : null;
  const cur = cmp ? cmp.current : {};
  const curInter = cmp ? interactionsSum(cmp.current) : null;
  const prevInter = cmp ? interactionsSum(cmp.previous) : null;
  const interDelta = curInter != null && prevInter ? (curInter - prevInter) / Math.abs(prevInter) : null;
  const spark = (metric) => {
    if (!days) return undefined;
    const vals = seriesFor(days, metric, addDaysKey(today, -14), to).values;
    return vals.filter((v) => v != null).length > 2 ? vals.map((v) => v ?? 0) : undefined;
  };
  const interSpark = (() => {
    if (!days) return undefined;
    const keys = dayRange(addDaysKey(today, -14), to);
    const map = days;
    const vals = keys.map((k) => (map[k] ? interactionsOf(map[k]) : null));
    return vals.filter((v) => v != null).length > 2 ? vals.map((v) => v ?? 0) : undefined;
  })();
  const empty = cmp && !cmp.current.daysWithData;
  return html`<section class="dash-kpis" aria-labelledby="dash-kpi-title">
    <div class="dash-section-head">
      <h2 class="section-title" id="dash-kpi-title">Last 7 days</h2>
      <span class="dash-section-note">
        ${source === 'live' ? 'Live from Instagram, compared with the 7 days before' : 'Compared with the 7 days before'}
      </span>
    </div>
    ${liveError ? html`<p class="dash-note text-warn">${liveError}</p>` : null}
    <div class="stats">
      <${Stat} label="Followers" value=${followers.latest ?? '—'} format="number" loading=${loading}
        delta=${followers.pct ?? undefined} deltaLabel=${followers.change != null ? `${followers.change >= 0 ? '+' : '−'}${formatNumber(Math.abs(followers.change))} this week` : 'no history yet'}
        sparkline=${followers.spark || undefined} />
      <${Stat} label="Reach" value=${empty ? '—' : cur.reach ?? '—'} format="compact" loading=${loading}
        delta=${cmp ? cmp.delta.reach ?? undefined : undefined} deltaLabel="vs previous week" sparkline=${spark('reach')} />
      <${Stat} label="Views" value=${empty ? '—' : cur.views ?? '—'} format="compact" loading=${loading}
        delta=${cmp ? cmp.delta.views ?? undefined : undefined} deltaLabel="vs previous week" sparkline=${spark('views')} />
      <${Stat} label="Interactions" value=${empty ? '—' : curInter ?? '—'} format="compact" loading=${loading}
        delta=${interDelta ?? undefined} deltaLabel=${cur.engagementRate != null ? `${formatPercent(cur.engagementRate)} of reach` : 'vs previous week'} sparkline=${interSpark} />
    </div>
  </section>`;
}

const DOT_LIMIT = 5;

function WeekStrip({ posts, today, tz, now, navigate }) {
  const keys = dayRange(today, addDaysKey(today, 6));
  const byDay = new Map(keys.map((k) => [k, []]));
  for (const p of posts) {
    if (p.status === 'canceled') continue;
    const iso = p.status === 'published' ? p.publishedAt || p.scheduledAt : p.scheduledAt;
    const t = parseTimestamp(iso);
    if (!Number.isFinite(t)) continue;
    const k = dayKey(new Date(t), tz);
    if (byDay.has(k)) byDay.get(k).push({ p, t });
  }
  const stateOf = (p) => (p.status === 'draft' && p.needsApproval ? 'approval' : p.status === 'scheduled' && p.publishMode === 'reminder' ? 'reminder' : p.status);
  const has = (state) => [...byDay.values()].some((l) => l.some(({ p }) => stateOf(p) === state));
  const legend = [
    ['scheduled', 'Scheduled'],
    ...(has('reminder') ? [['reminder', 'Reminder']] : []),
    ...(has('reminded') ? [['reminded', 'Post by hand']] : []),
    ['draft', 'Draft'],
    ['approval', 'Needs approval'],
    ['published', 'Published'],
    ['failed', 'Failed'],
  ];
  const total = [...byDay.values()].reduce((a, l) => a + l.filter(({ p }) => p.status === 'scheduled').length, 0);
  return html`<section class="dash-week" aria-labelledby="dash-week-title">
    <div class="dash-section-head">
      <h2 class="section-title" id="dash-week-title">Next 7 days</h2>
      <span class="dash-section-note">${plural(total, 'post')} scheduled</span>
      <span class="spacer"></span>
      <a class="dash-link" href=${buildHash('planner', { view: 'week' })}>Open planner<${Icon} name="arrow-right" size=${14} /></a>
    </div>
    <ol class="dash-week-grid">
      ${keys.map((k) => {
        const items = byDay.get(k).sort((a, b) => a.t - b.t);
        const dayNo = Number(k.slice(8, 10));
        const wd = format(new Date(`${k}T12:00:00Z`), 'UTC', { weekday: 'short' });
        const isToday = k === today;
        const label = `${format(new Date(`${k}T12:00:00Z`), 'UTC', { weekday: 'long', month: 'long', day: 'numeric' })}: ${items.length ? plural(items.length, 'post') : 'nothing planned'}. Open in the planner.`;
        return html`<li key=${k}>
          <button type="button" class=${cx('dash-day', isToday && 'is-today', !items.length && 'is-empty')} aria-label=${label}
            onClick=${() => navigate(buildHash('planner', { view: 'week', date: k }))}>
            <span class="dash-day-name">${isToday ? 'Today' : wd}</span>
            <span class="dash-day-date"><span class=${isToday ? 'today-mark' : ''}>${dayNo}</span></span>
            <span class="dash-day-dots" aria-hidden="true">
              ${items.slice(0, DOT_LIMIT).map(({ p: post }) => html`<i key=${post.id} class=${`dash-dot is-${stateOf(post)}`}></i>`)}
              ${items.length > DOT_LIMIT ? html`<span class="dash-day-more">+${items.length - DOT_LIMIT}</span>` : null}
            </span>
            <span class="dash-day-count">${items.length ? plural(items.length, 'post') : '—'}</span>
          </button>
        </li>`;
      })}
    </ol>
    <ul class="dash-legend" aria-label="Legend">
      ${legend.map(([k, l]) => html`<li key=${k}><i class=${`dash-dot is-${k}`}></i>${l}</li>`)}
    </ul>
  </section>`;
}

/**
 * Whether the worker still has to download one of the post's files from its link (asset.importUrl):
 * 'failed', 'pending' or null. The worker does not publish (or remind about) such a post until then.
 */
function downloadState(post, assetsById) {
  let state = null;
  for (const id of [...(post.media || []).map((m) => m && m.assetId), post.coverAssetId]) {
    const a = id && assetsById.get(id);
    if (!a || !a.importUrl) continue;
    if (a.importError) return 'failed';
    state = 'pending';
  }
  return state;
}

function UpNext({ posts, assetsById, tz, now, openComposer }) {
  const upcoming = posts
    .filter((p) => (p.status === 'scheduled' || p.status === 'publishing') && Number.isFinite(parseTimestamp(p.scheduledAt)))
    .sort((a, b) => parseTimestamp(a.scheduledAt) - parseTimestamp(b.scheduledAt))
    .slice(0, 5);
  return html`<${Panel} title="Up next" class="dash-upnext" flush
    actions=${html`<${Button} size="sm" variant="ghost" icon="plus" onClick=${() => openComposer()}>New post<//>`}>
    ${upcoming.length
      ? html`<ul class="list">
          ${upcoming.map((p) => {
            const due = parseTimestamp(p.scheduledAt) <= now;
            const download = p.status === 'scheduled' ? downloadState(p, assetsById) : null;
            const pill = () =>
              download === 'failed'
                ? html`<${StatusPill} status="failed" label="Download failed" />`
                : download && due
                  ? html`<${StatusPill} status="pending" label="Downloading" />`
                  : p.status === 'publishing' || (due && p.publishMode !== 'reminder')
                    ? html`<${StatusPill} status="publishing" />`
                    : due
                      ? html`<${StatusPill} status="needs-approval" label="Reminder due" />`
                      : html`<span class="dash-post-eta mono">${eta(p.scheduledAt)}</span>`;
            return html`<li key=${p.id} class="list-row dash-post">
              <button type="button" class="dash-post-hit" onClick=${() => openComposer(p.id)}
                aria-label=${`Open ${TYPE_LABEL[p.type] || 'post'} ${p.publishMode === 'reminder' ? 'with a reminder' : 'scheduled'} ${whenLabel(p.scheduledAt, tz, new Date(now))}`}></button>
              <${PostThumb} post=${p} assetsById=${assetsById} />
              <div class="dash-post-body">
                <div class="dash-post-when">
                  <span class="mono">${cap(whenLabel(p.scheduledAt, tz, new Date(now)))}</span>
                  <span class="faint">·</span>
                  <span class="dash-post-type"><${Icon} name=${TYPE_ICON[p.type] || 'image'} size=${14} />${TYPE_LABEL[p.type] || 'Post'}</span>
                  ${p.publishMode === 'reminder' ? html`<span class="dash-post-src is-hand" title="You get a reminder and post it yourself">Reminder</span>` : null}
                  ${p.source === 'autopilot' ? html`<span class="dash-post-src">Autopilot</span>` : p.source === 'evergreen' ? html`<span class="dash-post-src">Queue</span>` : null}
                </div>
                <div class="dash-post-caption">${excerpt(p.caption) || html`<span class="faint">${p.type === 'story' ? 'Story (no caption)' : 'No caption yet'}</span>`}</div>
              </div>
              ${pill()}
            </li>`;
          })}
        </ul>`
      : html`<${EmptyState} compact icon="calendar" title="Nothing scheduled"
          body="Plan your next post and Postpilot publishes it for you."
          action=${html`<${Button} size="sm" variant="primary" icon="plus" onClick=${() => openComposer()}>New post<//>`} />`}
  <//>`;
}

/** Reminder posts whose notification went out: the owner posts them in the Instagram app. */
function HandPosts({ posts, assetsById, tz, now }) {
  const list = posts
    .filter((p) => p.status === 'reminded')
    .sort((a, b) => (parseTimestamp(a.scheduledAt) || 0) - (parseTimestamp(b.scheduledAt) || 0));
  if (!list.length) return null;
  return html`<${Panel} title="Post these by hand" class="dash-hand" flush
    subtitle=${list.length === 1 ? 'Waiting for you to post it in Instagram. Open it to save the media and copy the caption.' : 'Waiting for you to post them in Instagram. Open one to save the media and copy the caption.'}>
    <ul class="list">
      ${list.map((p) => {
        const href = `#/post-now/${encodeURIComponent(p.id)}`;
        return html`<li key=${p.id} class="list-row dash-post">
          <a class="dash-post-hit" href=${href} aria-label=${`Post this ${(TYPE_LABEL[p.type] || 'post').toLowerCase()} by hand: ${excerpt(p.caption, 60) || 'no caption'}`}></a>
          <${PostThumb} post=${p} assetsById=${assetsById} />
          <div class="dash-post-body">
            <div class="dash-post-when">
              <span class="mono">${p.scheduledAt ? `Due ${whenLabel(p.scheduledAt, tz, new Date(now))}` : 'Due now'}</span>
              <span class="faint">·</span>
              <span class="dash-post-type"><${Icon} name=${TYPE_ICON[p.type] || 'image'} size=${14} />${TYPE_LABEL[p.type] || 'Post'}</span>
            </div>
            <div class="dash-post-caption">${excerpt(p.caption) || html`<span class="faint">${p.type === 'story' ? 'Story (no caption)' : 'No caption'}</span>`}</div>
          </div>
          <span class="dash-hand-go" aria-hidden="true">Post now<${Icon} name="arrow-right" size=${14} /></span>
        </li>`;
      })}
    </ul>
  <//>`;
}

function SideRow({ label, value, tone }) {
  return html`<div class="dash-kv-row"><dt>${label}</dt><dd class=${cx('num', tone && `text-${tone}`)}>${value}</dd></div>`;
}

function AutopilotCard({ autopilot, posts, library, tz, now }) {
  if (!autopilot) return html`<${Panel} title="Autopilot"><${Skeleton} lines=${3} /><//>`;
  const list = posts;
  const approvals = list.filter((p) => p.status === 'draft' && p.needsApproval).length;
  const next = list
    .filter((p) => p.source === 'autopilot' && p.status === 'scheduled' && parseTimestamp(p.scheduledAt) > now)
    .sort((a, b) => parseTimestamp(a.scheduledAt) - parseTimestamp(b.scheduledAt))[0];
  const pool = unusedAssets(((library && library.assets) || []).filter((a) => a.autopilot), list).length;
  const on = !!autopilot.enabled;
  const res = autopilot.lastResult;
  return html`<${Panel} title="Autopilot" class="dash-side"
    actions=${html`<${StatusPill} status=${on ? 'active' : 'paused'} label=${on ? 'On' : 'Off'} />`}>
    <p class="dash-side-lead">
      ${on
        ? `${autopilot.mode === 'auto' ? 'Schedules' : 'Drafts'} ${plural(Number(autopilot.postsPerWeek) || 0, 'post')} a week${autopilot.mode === 'auto' ? ' automatically' : ' for you to approve'}.`
        : 'Off. Turn it on to keep your queue filled from the media you pick.'}
    </p>
    <dl class="dash-kv">
      <${SideRow} label="Waiting for approval" value=${approvals} tone=${approvals ? 'warn' : null} />
      <${SideRow} label="Unused media in the pool" value=${pool} tone=${on && !pool ? 'bad' : null} />
      <${SideRow} label="Next autopilot post" value=${next ? cap(whenLabel(next.scheduledAt, tz, new Date(now))) : '—'} />
    </dl>
    ${res && res.reason && on ? html`<p class="dash-side-note">${res.reason} <span class="faint">(${ago(res.at)})</span></p>` : null}
    <div class="dash-side-foot">
      <${Button} size="sm" variant=${approvals ? 'primary' : 'secondary'} href="#/autopilot">${approvals ? 'Review drafts' : 'Open autopilot'}<//>
    </div>
  <//>`;
}

/**
 * Cached comments that need a reply, newest first. Same rule as the Inbox "Needs reply" filter
 * (js/views/inbox.js): not the owner's own (by account id or username), not hidden, not marked done,
 * and no reply from the owner. Like the Inbox's cached view, comments without a post are skipped.
 */
export function commentsNeedingReply(inbox, settings) {
  const ig = (settings && settings.ig) || {};
  const ownId = String(ig.userId || '');
  const ownName = String(ig.username || '').toLowerCase();
  const isMine = (c) => !!c && ((ownId && c.fromId && String(c.fromId) === ownId) || (!!ownName && String(c.username || '').toLowerCase() === ownName));
  const done = (inbox && inbox.done) || {};
  return ((inbox && inbox.comments) || [])
    .filter((c) => c && c.mediaId && !isMine(c) && !c.hidden && !done[c.id] && !(c.replies || []).some(isMine))
    .sort((a, b) => (parseTimestamp(b.timestamp) || 0) - (parseTimestamp(a.timestamp) || 0));
}

/**
 * When the worker last checked comments and messages: the later of inbox.fetchedAt and
 * automations.cursors.inboxCheckedAt (the worker rewrites the inbox only when it changed, or every 6 hours).
 */
export function inboxCheckedAt(inbox, automations) {
  const times = [inbox && inbox.fetchedAt, automations && automations.cursors && automations.cursors.inboxCheckedAt].filter((t) => Number.isFinite(parseTimestamp(t)));
  return times.sort((a, b) => parseTimestamp(b) - parseTimestamp(a))[0] || null;
}

function InboxCard({ inbox, automations, settings, now }) {
  if (!inbox) return html`<${Panel} title="Inbox"><${Skeleton} lines=${3} /><//>`;
  // Comments and conversations are cached by the worker; before its first check there is nothing to count.
  const synced = !!inbox.fetchedAt;
  const checkedAt = synced ? inboxCheckedAt(inbox, automations) : null;
  const needs = commentsNeedingReply(inbox, settings);
  const seen = inbox.seen || {};
  const waiting = (inbox.conversations || []).filter((c) => {
    const m = c.lastMessage;
    if (!m || m.fromMe) return false;
    const s = seen[c.id];
    return !(s && parseTimestamp(s) >= parseTimestamp(m.createdTime));
  }).length;
  return html`<${Panel} title="Inbox" class="dash-side"
    actions=${checkedAt ? html`<span class="dash-side-meta">Checked ${ago(checkedAt)}</span>` : null}>
    <dl class="dash-kv">
      <${SideRow} label="Comments to answer (recent posts)" value=${synced ? needs.length : '—'} tone=${synced && needs.length ? 'warn' : null} />
      <${SideRow} label="Messages waiting" value=${synced ? waiting : '—'} tone=${synced && waiting ? 'warn' : null} />
    </dl>
    ${synced ? html`<p class="dash-side-scope faint">From the worker's last check of the posts it watches. The Inbox shows the same comments, with your latest 12 posts read live.</p>` : null}
    ${!synced
      ? html`<p class="dash-side-note">Comments and messages show up here after the worker's first check.</p>`
      : needs.length
      ? html`<ul class="dash-comments">
          ${needs.slice(0, 3).map(
            (c) => html`<li key=${c.id} class="dash-comment">
              <${Avatar} name=${c.username || '?'} size=${28} />
              <div class="dash-comment-body">
                <div class="dash-comment-head"><span class="strong">@${c.username || 'someone'}</span><span class="faint mono">${ago(c.timestamp)}</span></div>
                <div class="dash-comment-text">${excerpt(c.text, 110)}</div>
              </div>
            </li>`,
          )}
        </ul>`
      : html`<p class="dash-side-note">You are all caught up on comments.</p>`}
    <div class="dash-side-foot">
      <${Button} size="sm" variant="secondary" href=${buildHash('inbox', { tab: 'comments' })}>Open inbox<//>
    </div>
  <//>`;
}

function AutomationsCard({ automations, now }) {
  if (!automations) return html`<${Panel} title="Automations"><${Skeleton} lines=${3} /><//>`;
  const rules = (automations.rules || []).filter((r) => r.enabled).length;
  const s = automations.stats || {};
  const last = (automations.activity || [])[0];
  const on = automations.enabled !== false;
  return html`<${Panel} title="Automations" class="dash-side"
    actions=${html`<${StatusPill} status=${on ? 'active' : 'paused'} label=${on ? 'On' : 'Off'} />`}>
    <p class="dash-side-lead">${on ? `${plural(rules, 'rule')} answering comments and DMs.` : 'Paused. Nothing is answered automatically.'}</p>
    <ul class="dash-tally" aria-label="Automation totals">
      <li><span class="dash-tally-n num">${formatNumber(s.replies || 0)}</span><span>replies</span></li>
      <li><span class="dash-tally-n num">${formatNumber(s.dms || 0)}</span><span>DMs sent</span></li>
      <li><span class="dash-tally-n num">${formatNumber(s.hidden || 0)}</span><span>hidden</span></li>
    </ul>
    <p class="dash-side-note">${last ? `Last action ${ago(last.at)}.` : 'No automatic actions yet.'}</p>
    <div class="dash-side-foot"><${Button} size="sm" variant="secondary" href="#/automations">Open automations<//></div>
  <//>`;
}

const PRODUCT_KIND = { REELS: 'reel', CAROUSEL_ALBUM: 'carousel', STORY: 'story' };

/**
 * Instagram media still on Instagram: without the worker's deletedAt mark, and without media of posts
 * deleted with "Delete from Instagram" (posts[].deletedFromInstagramAt, shown before the worker's next run).
 */
export function liveMedia(media, posts) {
  const gone = new Set((posts || []).filter((p) => p && p.deletedFromInstagramAt && p.igMediaId).map((p) => String(p.igMediaId)));
  return toList(media).filter((m) => m && !m.deletedAt && !gone.has(String(m.id)));
}

function RecentPosts({ media, posts, tz, followers, synced }) {
  const list = liveMedia(media, posts)
    .filter((m) => m.productType !== 'STORY' && Number.isFinite(parseTimestamp(m.timestamp)))
    .sort((a, b) => parseTimestamp(b.timestamp) - parseTimestamp(a.timestamp))
    .slice(0, 6);
  const rows = list.map((m) => ({ m, er: engagementRate(m, followers), reach: m.metrics && typeof m.metrics.reach === 'number' ? m.metrics.reach : null }));
  const ers = rows.map((r) => r.er).filter((v) => v != null);
  const best = ers.length > 1 ? Math.max(...ers) : null;
  const avg = ers.length ? ers.reduce((a, b) => a + b, 0) / ers.length : null;
  return html`<section class="dash-recent" aria-labelledby="dash-recent-title">
    <div class="dash-section-head">
      <h2 class="section-title" id="dash-recent-title">Recent posts</h2>
      ${avg != null ? html`<span class="dash-section-note">Average engagement ${formatPercent(avg)} of reach. The circled post did best.</span>` : null}
      <span class="spacer"></span>
      <a class="dash-link" href=${buildHash('analytics', { tab: 'posts' })}>All post stats<${Icon} name="arrow-right" size=${14} /></a>
    </div>
    ${rows.length
      ? html`<ol class="contact-sheet dash-sheet">
          ${rows.map(({ m, er, reach }, i) => {
            const kind = PRODUCT_KIND[m.productType] || (m.mediaType === 'CAROUSEL_ALBUM' ? 'carousel' : m.mediaType === 'VIDEO' ? 'reel' : undefined);
            const date = format(new Date(parseTimestamp(m.timestamp)), tz, { month: 'short', day: 'numeric' });
            const body = html`<${Frame} src=${m.thumbnailUrl || undefined} alt="" number=${i + 1} label=${date} ratio="1 / 1" kind=${kind} marked=${best != null && er === best} />
              <dl class="dash-sheet-stats">
                <div><dt>Reach</dt><dd class="num">${formatNumber(reach, { compact: true })}</dd></div>
                <div><dt>Eng.</dt><dd class=${cx('num', avg != null && er != null && (er >= avg ? 'text-ok' : ''))}>${formatPercent(er)}</dd></div>
              </dl>`;
            return html`<li key=${m.id}>
              ${m.permalink
                ? html`<a class="dash-sheet-item" href=${m.permalink} target="_blank" rel="noopener noreferrer"
                    aria-label=${`Open on Instagram: ${excerpt(m.caption, 60) || 'post'} (${date})`}>${body}</a>`
                : html`<div class="dash-sheet-item">${body}</div>`}
            </li>`;
          })}
        </ol>`
      : synced
        ? html`<${EmptyState} compact icon="chart" title="No published posts yet" body="Once you publish, each post's reach and engagement shows up here." />`
        : html`<${EmptyState} compact icon="chart" title="Post stats are on their way" body="Your published posts and their reach show up here after the worker's first run." />`}
  </section>`;
}

// ---------------------------------------------------------------------------

function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const DOCS = ['posts', 'library', 'analytics-daily', 'analytics-media', 'log', 'autopilot', 'automations', 'inbox'];

export default function Dashboard() {
  const { settings, ig, tz, navigate, openComposer, dispatchWorker, toast } = useApp();
  const { data, error } = useLoadedDocs(DOCS);
  const now = useNow();
  const today = dayKey(new Date(now), tz);
  const posts = (data.posts && data.posts.posts) || [];
  const assetsById = useMemo(() => new Map(((data.library && data.library.assets) || []).map((a) => [a.id, a])), [data.library]);
  const snapDays = data['analytics-daily'] ? data['analytics-daily'].days || {} : null;

  // Live fallback when the worker has fewer than 3 days of snapshots for the last week.
  const [live, setLive] = useState({ days: null, error: null, state: 'idle' });
  const needLive = !!snapDays && !!ig && comparePeriods(snapDays, addDaysKey(today, -7), addDaysKey(today, -1)).current.daysWithData < 3;
  useEffect(() => {
    if (!needLive || live.state !== 'idle') return undefined;
    let alive = true;
    setLive({ days: null, error: null, state: 'loading' });
    ig.accountDaily({ sinceKey: addDaysKey(today, -14), untilKey: addDaysKey(today, -1), tz })
      .then((d) => alive && setLive({ days: d || {}, error: null, state: 'done' }))
      .catch((err) => alive && setLive({ days: null, error: err.userMessage || err.message || 'Instagram did not answer.', state: 'done' }));
    return () => {
      alive = false;
    };
  }, [needLive, today]);
  const useLiveDays = needLive && live.days && Object.keys(live.days).length > 0;
  const days = useLiveDays ? { ...snapDays, ...live.days } : snapDays;

  const followers = followerSummary(snapDays, today, settings && settings.ig && settings.ig.followersCount);
  // Post stats come from the worker: until it has run, an empty list says nothing about the account.
  // (An account with no posts never gets analytics-media.updatedAt, so any recorded run counts too.)
  const mediaSynced = !!(data['analytics-media'] && data['analytics-media'].updatedAt) || !!(data.log && (data.log.runs || []).length);
  const alerts = buildAlerts({ settings, log: data.log, posts: data.posts, automations: data.automations, now, dispatchWorker });

  // Quick upload straight into the library.
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(null);
  const onFiles = async (fileList) => {
    const files = [...(fileList || [])];
    if (!files.length) return;
    setUploading({ index: 0, total: files.length });
    let ok = 0;
    const failed = [];
    for (const f of files) {
      try {
        await uploadFiles([f], {}, () => setUploading({ index: ok + failed.length, total: files.length }));
        ok++;
      } catch (err) {
        failed.push(`${f.name}: ${err.message}`);
      }
    }
    setUploading(null);
    if (ok) toast(`Added ${plural(ok, 'file')} to the library.`, { kind: 'success', action: { label: 'Open library', onClick: () => navigate('#/library') } });
    if (failed.length) toast(`Could not add ${failed.join('; ')}`, { kind: 'error' });
  };

  // Summary sentence (header subtitle). Reminder posts do not "go out": the owner posts them by hand.
  const upcoming = posts
    .filter((p) => p.status === 'scheduled' && parseTimestamp(p.scheduledAt) > now)
    .sort((a, b) => parseTimestamp(a.scheduledAt) - parseTimestamp(b.scheduledAt));
  const isReminder = (p) => p.publishMode === 'reminder';
  const nextPost = upcoming.find((p) => !isReminder(p));
  const nextReminder = upcoming.find(isReminder);
  const weekEnd = now + 7 * DAY_MS;
  const inWeek = upcoming.filter((p) => parseTimestamp(p.scheduledAt) <= weekEnd);
  const weekCount = inWeek.filter((p) => !isReminder(p)).length;
  const weekReminders = inWeek.length - weekCount;
  const approvals = posts.filter((p) => p.status === 'draft' && p.needsApproval).length;
  let summary = data.posts
    ? nextPost
      ? `${plural(weekCount, 'post')} scheduled for the next 7 days. The next one goes out ${whenLabel(nextPost.scheduledAt, tz, new Date(now))}.`
      : nextReminder
        ? 'Nothing publishes automatically yet.'
        : 'Nothing is scheduled yet. Plan a post or turn on autopilot to keep your feed going.'
    : 'Loading your week…';
  if (data.posts && nextReminder) {
    summary += weekReminders
      ? ` ${plural(weekReminders, 'reminder')} to post by hand this week, the next ${whenLabel(nextReminder.scheduledAt, tz, new Date(now))}.`
      : ` Your next reminder to post by hand is ${whenLabel(nextReminder.scheduledAt, tz, new Date(now))}.`;
  }
  if (data.posts && approvals) summary += ` ${plural(approvals, 'draft')} ${approvals === 1 ? 'needs' : 'need'} your approval.`;
  const byHand = posts.filter((p) => p.status === 'reminded').length;
  if (data.posts && byHand) summary += ` ${plural(byHand, 'post')} ${byHand === 1 ? 'is' : 'are'} waiting for you to post by hand.`;

  const eyebrow = format(new Date(now), tz, { weekday: 'long', month: 'long', day: 'numeric' });

  return html`<div class="page dash">
    <${PageHeader} eyebrow=${eyebrow} title="Today" subtitle=${summary}
      actions=${html`
        <input ref=${fileRef} type="file" accept="image/*,video/mp4,video/quicktime" multiple hidden
          onChange=${(e) => {
            const fl = e.currentTarget.files;
            onFiles(fl).finally(() => (e.target.value = ''));
          }} />
        <${Button} variant="secondary" icon="upload" loading=${!!uploading} onClick=${() => fileRef.current && fileRef.current.click()}>
          ${uploading ? `Uploading ${Math.min(uploading.index + 1, uploading.total)} of ${uploading.total}` : 'Upload media'}
        <//>
        <${Button} variant="secondary" icon="chart" href="#/analytics">Analytics<//>
        <${Button} variant="primary" icon="plus" onClick=${() => openComposer()}>New post<//>`} />

    ${error ? html`<${Callout} tone="danger" title="Some of your data could not be loaded">${error.message || String(error)} Reload the page to try again.<//>` : null}

    <${AlertList} alerts=${alerts} />

    ${data.posts && data.library ? html`<${HandPosts} posts=${posts} assetsById=${assetsById} tz=${tz} now=${now} />` : null}

    <${AccountStrip} settings=${settings} followers=${followers} log=${data.log} now=${now} />

    <${KpiStrip} days=${days} today=${today} followers=${followers} source=${useLiveDays ? 'live' : 'snapshots'}
      liveError=${needLive && live.error ? `Could not load live numbers from Instagram: ${live.error}` : null}
      loading=${!data['analytics-daily'] || (needLive && live.state === 'loading')} />

    <${WeekStrip} posts=${posts} today=${today} tz=${tz} now=${now} navigate=${navigate} />

    <div class="dash-columns">
      <div class="dash-col-main stack">
        ${data.posts && data.library ? html`<${UpNext} posts=${posts} assetsById=${assetsById} tz=${tz} now=${now} openComposer=${openComposer} />` : html`<${Panel} title="Up next"><${Skeleton} lines=${5} /><//>`}
        ${data['analytics-media']
          ? html`<${RecentPosts} media=${data['analytics-media'].media} posts=${posts} tz=${tz} followers=${followers.latest ?? undefined} synced=${mediaSynced} />`
          : html`<${Skeleton} height=${220} />`}
      </div>
      <div class="dash-col-side stack">
        <${AutopilotCard} autopilot=${data.autopilot} posts=${posts} library=${data.library} tz=${tz} now=${now} />
        <${InboxCard} inbox=${data.inbox} automations=${data.automations} settings=${settings} now=${now} />
        <${AutomationsCard} automations=${data.automations} now=${now} />
      </div>
    </div>
  </div>`;
}
