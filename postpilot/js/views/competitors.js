// Competitors: public numbers of accounts the owner watches (Instagram Business Discovery,
// Facebook Login only), compared with the owner's own account.
//
// Data: competitors doc (written here and by worker/jobs/competitors.mjs)
//   accounts[]  {username, addedAt} (strings accepted)
//   snapshots   { [username]: { [dayKey]: {followers, follows, mediaCount, avgLikes, avgComments, er, postsLast30, capturedAt} } }
//   posts       { [username]: latest 12 media from businessDiscovery() }
//   profiles    { [username]: {name, biography, website, profilePictureUrl, followersCount, ...} }
//   errors      { [username]: {message, at, day} }

import { html, useMemo, useState } from '../../vendor/preact.js';
import { useApp } from '../app.js';
import { loadViewCss } from '../css.js';
import { mutate, useDocs } from '../data.js';
import { BarChart, LineChart } from '../ui/charts.js';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  Frame,
  Icon,
  Menu,
  PageHeader,
  Panel,
  Segmented,
  Skeleton,
  TextInput,
  usePhone,
} from '../ui/kit.js';
import { formatNumber, formatPercent, parseTimestamp, toList } from '../../core/analytics.js';
import { addDaysKey, dayKey, dayRange, formatDay, relative } from '../../core/time.js';

loadViewCss('competitors');

const MEDIA_LIMIT = 12;
const DAY_MS = 864e5;
const USERNAME_RE = /^[a-z0-9._]{1,30}$/;

// ---------------------------------------------------------------------------
// Pure helpers

/** Lower-case username from a stored account entry (string or {username}). */
export function usernameOf(account) {
  const raw = typeof account === 'string' ? account : account && account.username;
  return String(raw || '').trim().replace(/^@/, '').toLowerCase();
}

/** Username typed by the owner: "@name", "name" or an instagram.com profile link. null when invalid. */
export function normalizeUsername(raw) {
  let s = String(raw || '').trim();
  const link = s.match(/instagram\.com\/([A-Za-z0-9._]+)/i);
  if (link) s = link[1];
  s = s.replace(/^@+/, '').replace(/\/+$/, '').toLowerCase();
  return USERNAME_RE.test(s) ? s : null;
}

/** Snapshot numbers from businessDiscovery() (same formula as worker/jobs/competitors.mjs). */
export function snapshotOf(bd, nowMs) {
  const media = bd.media || [];
  const avg = (key) => {
    const vals = media.map((m) => m[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const avgLikes = avg('likeCount');
  const avgComments = avg('commentsCount');
  const followers = typeof bd.followersCount === 'number' ? bd.followersCount : null;
  const er = followers && (avgLikes != null || avgComments != null) ? ((avgLikes || 0) + (avgComments || 0)) / followers : null;
  const postsLast30 = media.filter((m) => nowMs - Date.parse(m.timestamp || '') <= 30 * DAY_MS).length;
  const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  return {
    followers,
    follows: bd.followsCount ?? null,
    mediaCount: bd.mediaCount ?? null,
    avgLikes: round(avgLikes, 1),
    avgComments: round(avgComments, 1),
    er: round(er, 5),
    postsLast30,
  };
}

/** Write one businessDiscovery() result into the competitors doc (pure: safe to re-run). */
function applyDiscovery(d, u, bd, { today, nowIso, nowMs }) {
  d.snapshots ||= {};
  d.posts ||= {};
  d.profiles ||= {};
  d.errors ||= {};
  d.snapshots[u] = { ...(d.snapshots[u] || {}), [today]: { ...snapshotOf(bd, nowMs), capturedAt: nowIso } };
  d.posts[u] = (bd.media || []).slice(0, MEDIA_LIMIT);
  d.profiles[u] = {
    id: bd.id || null,
    username: bd.username || u,
    name: bd.name || '',
    biography: bd.biography || '',
    website: bd.website || '',
    profilePictureUrl: bd.profilePictureUrl || null,
    followersCount: bd.followersCount ?? null,
    followsCount: bd.followsCount ?? null,
    mediaCount: bd.mediaCount ?? null,
    updatedAt: nowIso,
  };
  delete d.errors[u];
}

/** Posts per week from a list of recent media (handles lists that don't reach back 30 days). */
export function postsPerWeek(media, nowMs) {
  const times = toList(media)
    .map((m) => parseTimestamp(m.timestamp))
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  if (!times.length) return null;
  const oldest = times[times.length - 1];
  const windowMs = 30 * DAY_MS;
  if (nowMs - oldest >= windowMs) return times.filter((t) => nowMs - t <= windowMs).length / (30 / 7);
  // Every post we have is newer than 30 days: the list was cut off, so use the span it covers.
  const spanDays = Math.max(7, (nowMs - oldest) / DAY_MS);
  return times.length / (spanDays / 7);
}

function sortedKeys(snaps) {
  return Object.keys(snaps || {}).sort();
}

function latestOf(snaps) {
  const keys = sortedKeys(snaps);
  for (let i = keys.length - 1; i >= 0; i--) if (snaps[keys[i]] && snaps[keys[i]].followers != null) return [keys[i], snaps[keys[i]]];
  return keys.length ? [keys[keys.length - 1], snaps[keys[keys.length - 1]]] : [null, null];
}

/** Follower change over `days`, comparing the latest value with the latest one at least `days` older. */
function changeFrom(valueAt, latestKey, latestValue, days) {
  if (!latestKey || latestValue == null) return null;
  const target = addDaysKey(latestKey, -days);
  const prev = valueAt(target);
  if (prev == null || !prev) return null;
  return { abs: latestValue - prev, pct: (latestValue - prev) / prev };
}

function snapshotValueOnOrBefore(snaps, key) {
  const keys = sortedKeys(snaps).filter((k) => k <= key);
  for (let i = keys.length - 1; i >= 0; i--) {
    const v = snaps[keys[i]] && snaps[keys[i]].followers;
    if (typeof v === 'number') return keys[i] >= addDaysKey(key, -3) ? v : null; // only near the target day
  }
  return null;
}

/**
 * The owner's followers per day. Days without a snapshot are rebuilt backwards from the next known
 * value using that day's follows gained and lost (what Instagram reports per day).
 */
export function ownFollowerSeries(days, keys) {
  const out = new Array(keys.length).fill(null);
  let next = null;
  for (let i = keys.length - 1; i >= 0; i--) {
    const d = days[keys[i]] || {};
    if (typeof d.followers === 'number') out[i] = d.followers;
    else if (next != null) {
      const nd = days[keys[i + 1]] || {};
      const net = (typeof nd.followsGained === 'number' ? nd.followsGained : 0) - (typeof nd.unfollows === 'number' ? nd.unfollows : 0);
      out[i] = next - net;
    }
    next = out[i];
  }
  return out;
}

function avgOf(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function isOffline(err) {
  return !!err && (err.code === 'network' || err instanceof TypeError);
}

function errText(err) {
  return (err && (err.userMessage || err.message)) || 'Something went wrong.';
}

const keyLabel = (k) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${k}T12:00:00Z`));
const fmtPct = (f) => (f == null ? '—' : formatPercent(f, Math.abs(f) < 0.01 ? 2 : 1));
const fmtAvg = (n) => (n == null ? '—' : formatNumber(Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10));

// ---------------------------------------------------------------------------
// Rows

function buildRows({ doc, settings, daily, media, tz, nowMs }) {
  const today = dayKey(new Date(nowMs), tz);
  const rows = [];

  // Own account (from the worker's analytics snapshots).
  const igc = settings && settings.ig;
  if (igc) {
    const days = (daily && daily.days) || {};
    const keys = dayRange(addDaysKey(today, -40), today);
    const series = ownFollowerSeries(days, keys);
    let li = series.length - 1;
    while (li >= 0 && series[li] == null) li--;
    const followers = li >= 0 ? series[li] : igc.followersCount ?? null;
    const latestKey = li >= 0 ? keys[li] : null;
    const at = (k) => {
      const i = keys.indexOf(k);
      return i >= 0 ? series[i] : null;
    };
    const list = toList(media && media.media)
      .filter((m) => m.productType !== 'STORY')
      .sort((a, b) => parseTimestamp(b.timestamp) - parseTimestamp(a.timestamp));
    const recent = list.slice(0, MEDIA_LIMIT);
    const likes = avgOf(recent.map((m) => m.likeCount ?? m.metrics?.likes));
    const comments = avgOf(recent.map((m) => m.commentsCount ?? m.metrics?.comments));
    rows.push({
      id: '__own',
      own: true,
      username: igc.username || 'you',
      name: igc.name || '',
      avatar: igc.profilePictureUrl || null,
      followers,
      change7: changeFrom(at, latestKey, followers, 7),
      change30: changeFrom(at, latestKey, followers, 30),
      ppw: postsPerWeek(list.slice(0, 60), nowMs),
      avgLikes: likes,
      avgComments: comments,
      er: followers && (likes != null || comments != null) ? ((likes || 0) + (comments || 0)) / followers : null,
      error: null,
      updatedAt: latestKey ? days[latestKey]?.capturedAt : null,
    });
  }

  const seen = new Set();
  for (const a of toList(doc && doc.accounts)) {
    const u = usernameOf(a);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    const snaps = (doc.snapshots && doc.snapshots[u]) || {};
    const [latestKey, latest] = latestOf(snaps);
    const profile = (doc.profiles && doc.profiles[u]) || {};
    const posts = (doc.posts && doc.posts[u]) || [];
    const followers = latest?.followers ?? profile.followersCount ?? null;
    const at = (k) => snapshotValueOnOrBefore(snaps, k);
    rows.push({
      id: u,
      own: false,
      username: u,
      name: profile.name || '',
      avatar: profile.profilePictureUrl || null,
      followers,
      change7: changeFrom(at, latestKey, followers, 7),
      change30: changeFrom(at, latestKey, followers, 30),
      ppw: postsPerWeek(posts, nowMs),
      avgLikes: latest?.avgLikes ?? null,
      avgComments: latest?.avgComments ?? null,
      er: latest?.er ?? null,
      error: (doc.errors && doc.errors[u]) || null,
      updatedAt: latest?.capturedAt || profile.updatedAt || null,
      addedAt: typeof a === 'object' ? a.addedAt : null,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Small pieces

function Change({ value }) {
  if (!value) return html`<span class="faint">—</span>`;
  const tone = value.abs > 0 ? 'text-ok' : value.abs < 0 ? 'text-bad' : 'muted';
  const sign = value.abs > 0 ? '+' : value.abs < 0 ? '−' : '';
  return html`<span class=${`cpt-change ${tone}`}>
    <span class="num">${sign}${formatNumber(Math.abs(value.abs))}</span>
    <span class="cpt-change-pct num">${sign}${formatPercent(Math.abs(value.pct), 1)}</span>
  </span>`;
}

function AccountCell({ row }) {
  return html`<span class="cpt-account">
    <${Avatar} src=${row.avatar} name=${row.name || row.username} size=${30} />
    <span class="cpt-account-text">
      ${row.name ? html`<span class="cpt-account-name truncate">${row.name}</span>` : null}
      <span class=${row.name ? 'cpt-account-handle truncate' : 'cpt-account-handle is-only truncate'}>@${row.username}</span>
    </span>
    ${row.own ? html`<${Badge} tone="accent">You<//>` : null}
    ${row.error ? html`<${Badge} tone="warning" icon="alert" title=${row.error.message}>Check<//>` : null}
  </span>`;
}

function MediaTile({ post, index, followers }) {
  const isVideo = post.mediaType === 'VIDEO' || post.productType === 'REELS';
  const kind = post.productType === 'REELS' ? 'reel' : post.mediaType === 'CAROUSEL_ALBUM' ? 'carousel' : isVideo ? 'video' : undefined;
  const er = followers ? ((post.likeCount || 0) + (post.commentsCount || 0)) / followers : null;
  const badge = html`<span class="cpt-badge"><${Icon} name="heart" size=${11} />${formatNumber(post.likeCount, { compact: true })}<${Icon} name="comment" size=${11} />${formatNumber(post.commentsCount, { compact: true })}</span>`;
  const frame = html`<${Frame}
    src=${isVideo ? null : post.mediaUrl}
    alt=${post.caption ? post.caption.slice(0, 120) : 'Instagram post'}
    number=${index + 1}
    label=${post.timestamp ? keyLabel(post.timestamp.slice(0, 10)) : ''}
    ratio="4 / 5"
    kind=${kind}
    badge=${badge}>
    ${isVideo && post.mediaUrl ? html`<video src=${`${post.mediaUrl}#t=0.1`} muted playsinline preload="metadata" aria-hidden="true"></video>` : null}
  <//>`;
  const title = `${formatNumber(post.likeCount)} likes, ${formatNumber(post.commentsCount)} comments${er != null ? `, ${fmtPct(er)} engagement` : ''}. Open on Instagram`;
  return post.permalink
    ? html`<a class="cpt-tile" href=${post.permalink} target="_blank" rel="noopener noreferrer" title=${title}>${frame}</a>`
    : html`<div class="cpt-tile" title=${title}>${frame}</div>`;
}

// ---------------------------------------------------------------------------
// Drawer

function CompetitorDrawer({ row, doc, onClose, onRemove, fbMode }) {
  const { tz } = useApp();
  if (!row) return html`<${Drawer} open=${false} onClose=${onClose} />`;
  const u = row.username;
  const profile = (doc.profiles && doc.profiles[u]) || {};
  const posts = (doc.posts && doc.posts[u]) || [];
  const snaps = (doc.snapshots && doc.snapshots[u]) || {};
  const keys = sortedKeys(snaps).filter((k) => snaps[k] && typeof snaps[k].followers === 'number');
  const best = [...posts].sort((a, b) => (b.likeCount || 0) + (b.commentsCount || 0) - ((a.likeCount || 0) + (a.commentsCount || 0))).slice(0, 3);
  const profileUrl = `https://www.instagram.com/${u}/`;

  return html`<${Drawer} open=${true} title=${row.name || `@${u}`} onClose=${onClose} width=${620}
    footer=${html`<${Button} variant="danger" icon="trash" onClick=${() => onRemove(u)}>Remove<//>
      <span class="spacer"></span>
      <${Button} href=${profileUrl} target="_blank" rel="noopener noreferrer" icon="external">Open on Instagram<//>`}>
    <div class="stack stack-lg cpt-drawer">
      <div class="row row-nowrap cpt-profile">
        <${Avatar} src=${row.avatar} name=${row.name || u} size=${56} />
        <div class="min-w-0">
          <p class="cpt-profile-handle">@${u}</p>
          ${profile.biography ? html`<p class="muted pre-wrap text-sm">${profile.biography}</p>` : null}
          ${profile.website
            ? html`<a class="text-sm break" href=${profile.website} target="_blank" rel="noopener noreferrer">${profile.website.replace(/^https?:\/\//, '')}</a>`
            : null}
        </div>
      </div>

      ${row.error ? html`<${Callout} tone="warning" title="Instagram could not read this account last time">${row.error.message}<//>` : null}

      ${row.followers == null && !posts.length
        ? html`<${EmptyState} icon="users" title="No numbers yet"
            body=${fbMode ? 'Use Refresh now, or wait for the worker’s daily run.' : 'Numbers appear once Instagram is connected with Facebook Login.'} />`
        : html`<div class="stats cpt-drawer-stats">
              <div class="stat"><div class="stat-label">Followers</div><div class="stat-value">${formatNumber(row.followers)}</div></div>
              <div class="stat"><div class="stat-label">Posts per week</div><div class="stat-value">${row.ppw == null ? '—' : formatNumber(row.ppw, { digits: 1 })}</div></div>
              <div class="stat"><div class="stat-label">Avg likes</div><div class="stat-value">${fmtAvg(row.avgLikes)}</div></div>
              <div class="stat"><div class="stat-label">Engagement</div><div class="stat-value">${fmtPct(row.er)}</div></div>
            </div>
            <dl class="kv text-sm">
              <dt>Following</dt><dd class="num">${formatNumber(profile.followsCount)}</dd>
              <dt>Posts on profile</dt><dd class="num">${formatNumber(profile.mediaCount)}</dd>
              <dt>Avg comments</dt><dd class="num">${fmtAvg(row.avgComments)}</dd>
              <dt>Change, 7 days</dt><dd><${Change} value=${row.change7} /></dd>
              <dt>Last updated</dt><dd>${row.updatedAt ? `${formatDay(row.updatedAt, tz)} (${relative(row.updatedAt)})` : '—'}</dd>
            </dl>`}

      ${keys.length > 1
        ? html`<section class="stack stack-sm">
            <h3 class="section-title">Followers</h3>
            <${LineChart} series=${[{ name: `@${u}`, values: keys.map((k) => snaps[k].followers) }]} xLabels=${keys.map(keyLabel)}
              height=${160} area=${false} label=${`Followers of @${u}`} />
          </section>`
        : null}

      ${best.length
        ? html`<section class="stack stack-sm">
            <h3 class="section-title">Best recent posts</h3>
            <ul class="list">
              ${best.map(
                (p) => html`<li class="list-row cpt-best" key=${p.id}>
                  <span class="cpt-best-thumb">${p.mediaType === 'VIDEO' || p.productType === 'REELS'
                    ? html`${p.mediaUrl ? html`<video src=${`${p.mediaUrl}#t=0.1`} muted playsinline preload="metadata" aria-hidden="true"></video>` : null}
                        <span class="cpt-play" aria-hidden="true"><${Icon} name="reel" size=${13} /></span>`
                    : p.mediaUrl ? html`<img src=${p.mediaUrl} alt="" loading="lazy" />` : null}</span>
                  <span class="grow stack stack-sm cpt-best-text">
                    <span class="clamp-2 text-sm">${p.caption || 'No caption'}</span>
                    <span class="row text-xs muted num">
                      <span class="cpt-inline"><${Icon} name="heart" size=${13} />${formatNumber(p.likeCount)}</span>
                      <span class="cpt-inline"><${Icon} name="comment" size=${13} />${formatNumber(p.commentsCount)}</span>
                      ${row.followers ? html`<span>${fmtPct(((p.likeCount || 0) + (p.commentsCount || 0)) / row.followers)} engagement</span>` : null}
                      ${p.timestamp ? html`<span>${formatDay(p.timestamp, tz)}</span>` : null}
                    </span>
                  </span>
                  ${p.permalink ? html`<a class="btn btn-ghost btn-sm" href=${p.permalink} target="_blank" rel="noopener noreferrer" aria-label="Open post on Instagram"><${Icon} name="external" size=${15} /></a>` : null}
                </li>`,
              )}
            </ul>
          </section>`
        : null}

      ${posts.length
        ? html`<section class="stack stack-sm">
            <h3 class="section-title">Recent posts</h3>
            <div class="contact-sheet cpt-sheet">${posts.map((p, i) => html`<${MediaTile} key=${p.id} post=${p} index=${i} followers=${row.followers} />`)}</div>
          </section>`
        : null}
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------
// Add form

function AddAccount({ names, ownUsername, fbMode, autofocus }) {
  const { ig, toast, tz } = useApp();
  const [value, setValue] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const u = normalizeUsername(value);
    if (!u) return setError('Enter an Instagram username, like atelier.kin.');
    if (ownUsername && u === ownUsername.toLowerCase()) return setError('That is your own account. It is always shown first.');
    if (names.includes(u)) return setError(`@${u} is already on your list.`);
    setError(null);
    setBusy(true);
    let bd = null;
    let note = '';
    if (fbMode && ig) {
      try {
        bd = await ig.businessDiscovery(u, { mediaLimit: MEDIA_LIMIT });
      } catch (err) {
        if (!isOffline(err)) {
          setBusy(false);
          setError(errText(err));
          return;
        }
        note = ' Instagram could not be reached to check it; the worker will try on its next run.';
      }
    } else {
      note = ' Its numbers appear once Instagram is connected with Facebook Login.';
    }
    const nowMs = Date.now();
    const ctx = { today: dayKey(new Date(nowMs), tz), nowIso: new Date(nowMs).toISOString(), nowMs };
    try {
      await mutate(
        'competitors',
        (d) => {
          d.accounts = toList(d.accounts);
          if (!d.accounts.some((a) => usernameOf(a) === u)) d.accounts.push({ username: u, addedAt: ctx.nowIso });
          if (bd) applyDiscovery(d, u, bd, ctx);
        },
        { message: 'competitors: add account' },
      );
      setValue('');
      toast(`Added @${u}.${note}`, { kind: 'success' });
    } catch {
      // mutate() already showed the error
    } finally {
      setBusy(false);
    }
  }

  return html`<form class="cpt-add" onSubmit=${submit} novalidate>
    <${Field} label="Add an account" error=${error}
      hint=${fbMode ? 'Business and creator accounts only. Postpilot checks the username with Instagram.' : 'Business and creator accounts only.'}>
      <${TextInput} value=${value} onChange=${(v) => (setValue(v), error && setError(null))} prefix="@" placeholder="username"
        autocomplete="off" autocapitalize="none" spellcheck=${false} data-autofocus=${autofocus ? '' : undefined} />
    <//>
    <${Button} type="submit" variant="primary" icon="plus" loading=${busy} class="cpt-add-btn">Add account<//>
  </form>`;
}

// ---------------------------------------------------------------------------
// View

export default function Competitors() {
  const { settings, ig, tz, toast, confirm, navigate } = useApp();
  const { data, loading, error } = useDocs(['competitors', 'analytics-daily', 'analytics-media']);
  const phone = usePhone();
  const [openUser, setOpenUser] = useState(null);
  const [chartMode, setChartMode] = useState('followers');
  const [refreshing, setRefreshing] = useState(null); // {done, total}
  const [refreshError, setRefreshError] = useState(null);

  const doc = data.competitors;
  const fbMode = settings && settings.ig && settings.ig.mode === 'facebook';
  const nowMs = Date.now();
  const today = dayKey(new Date(nowMs), tz);

  const rows = useMemo(
    () => (doc ? buildRows({ doc, settings, daily: data['analytics-daily'], media: data['analytics-media'], tz, nowMs }) : []),
    [doc, settings, data['analytics-daily'], data['analytics-media'], tz],
  );
  const competitorRows = rows.filter((r) => !r.own);
  const names = competitorRows.map((r) => r.username);

  const chartKeys = useMemo(() => dayRange(addDaysKey(today, -29), today), [today]);
  const lineSeries = useMemo(() => {
    if (!doc) return [];
    const out = [];
    const own = rows.find((r) => r.own);
    if (own) {
      const days = (data['analytics-daily'] && data['analytics-daily'].days) || {};
      out.push({ name: `@${own.username} (you)`, values: ownFollowerSeries(days, chartKeys), color: 'var(--series-1)' });
    }
    competitorRows.forEach((r) => {
      const snaps = (doc.snapshots && doc.snapshots[r.username]) || {};
      const values = chartKeys.map((k) => (snaps[k] && typeof snaps[k].followers === 'number' ? snaps[k].followers : null));
      if (values.some((v) => v != null)) out.push({ name: `@${r.username}`, values });
    });
    out.forEach((s, i) => {
      if (!s.color) s.color = i < 6 ? `var(--series-${i + 1})` : 'var(--series-muted)';
    });
    if (chartMode === 'growth') {
      return out.map((s) => {
        const first = s.values.find((v) => v != null && v > 0);
        return { ...s, values: s.values.map((v) => (v == null || !first ? null : v / first - 1)) };
      });
    }
    return out;
  }, [doc, rows, chartKeys, chartMode]);

  const erBars = rows
    .filter((r) => r.er != null)
    .map((r) => ({ label: r.own ? 'You' : `@${r.username}`, value: r.er, color: r.own ? 'var(--series-1)' : 'var(--series-muted)' }));

  const lastUpdated = competitorRows.map((r) => r.updatedAt).filter(Boolean).sort().pop() || null;
  const openRow = openUser ? competitorRows.find((r) => r.username === openUser) : null;

  async function remove(u) {
    const ok = await confirm({
      title: `Stop tracking @${u}?`,
      body: 'Its saved follower history and posts are removed from Postpilot. You can add it again later.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await mutate(
        'competitors',
        (d) => {
          d.accounts = toList(d.accounts).filter((a) => usernameOf(a) !== u);
          for (const k of ['snapshots', 'posts', 'profiles', 'errors']) if (d[k]) delete d[k][u];
        },
        { message: 'competitors: remove account' },
      );
      setOpenUser(null);
      toast(`Stopped tracking @${u}.`, { kind: 'success' });
    } catch {
      // mutate() already showed the error
    }
  }

  async function refreshNow() {
    if (!ig || !names.length) return;
    setRefreshError(null);
    setRefreshing({ done: 0, total: names.length });
    const got = new Map();
    const errors = new Map();
    let fatal = null;
    for (let i = 0; i < names.length; i++) {
      const u = names[i];
      try {
        got.set(u, await ig.businessDiscovery(u, { mediaLimit: MEDIA_LIMIT }));
      } catch (err) {
        if (isOffline(err) || err.isAuth || err.isRateLimit) {
          fatal = err;
          break;
        }
        errors.set(u, errText(err));
      }
      setRefreshing({ done: i + 1, total: names.length });
    }
    const nowMs2 = Date.now();
    const ctx = { today: dayKey(new Date(nowMs2), tz), nowIso: new Date(nowMs2).toISOString(), nowMs: nowMs2 };
    try {
      if (got.size || errors.size) {
        await mutate(
          'competitors',
          (d) => {
            for (const [u, bd] of got) if (toList(d.accounts).some((a) => usernameOf(a) === u)) applyDiscovery(d, u, bd, ctx);
            d.errors ||= {};
            for (const [u, message] of errors) d.errors[u] = { message, at: ctx.nowIso, day: ctx.today };
            d.status = 'ok';
          },
          { message: 'competitors: refresh' },
        );
      }
      if (fatal) {
        const msg = isOffline(fatal) ? 'Could not reach Instagram. Showing the last saved numbers.' : errText(fatal);
        setRefreshError(msg);
        toast(msg, { kind: 'error' });
      } else if (errors.size) {
        toast(`Updated ${got.size} of ${names.length} accounts. ${errors.size === 1 ? 'One account' : `${errors.size} accounts`} could not be read.`, { kind: 'info' });
      } else {
        toast(`Updated ${got.size} ${got.size === 1 ? 'account' : 'accounts'}.`, { kind: 'success' });
      }
    } catch {
      // mutate() already showed the error
    } finally {
      setRefreshing(null);
    }
  }

  const header = html`<${PageHeader} eyebrow="Measure" title="Competitors"
    subtitle="See how accounts you watch grow and what they post, next to your own numbers."
    actions=${fbMode && ig && names.length
      ? html`<${Button} icon="refresh" loading=${!!refreshing} onClick=${refreshNow}>
          ${refreshing ? `Refreshing ${refreshing.done} of ${refreshing.total}` : 'Refresh now'}
        <//>`
      : null} />`;

  if (error && !doc) {
    return html`<div class="page">${header}
      <${Callout} tone="danger" title="Could not load your competitors">${errText(error)} Reload the page to try again.<//>
    </div>`;
  }
  if (loading && !doc) {
    return html`<div class="page">${header}<${Panel}><${Skeleton} lines=${6} /><//></div>`;
  }

  const ownUsername = settings && settings.ig && settings.ig.username;
  const columns = [
    { key: 'account', label: 'Account', render: (r) => html`<${AccountCell} row=${r} />`, sortValue: (r) => (r.own ? '' : r.username), sortable: true },
    { key: 'followers', label: 'Followers', align: 'right', sortable: true, render: (r) => formatNumber(r.followers) },
    { key: 'change7', label: '7 days', align: 'right', sortable: true, sortValue: (r) => r.change7?.pct ?? null, render: (r) => html`<${Change} value=${r.change7} />` },
    { key: 'change30', label: '30 days', align: 'right', sortable: true, sortValue: (r) => r.change30?.pct ?? null, render: (r) => html`<${Change} value=${r.change30} />` },
    { key: 'ppw', label: 'Posts/week', align: 'right', sortable: true, render: (r) => (r.ppw == null ? '—' : formatNumber(r.ppw, { digits: 1 })) },
    { key: 'avgLikes', label: 'Avg likes', align: 'right', sortable: true, render: (r) => fmtAvg(r.avgLikes) },
    { key: 'avgComments', label: 'Avg comments', align: 'right', sortable: true, render: (r) => fmtAvg(r.avgComments) },
    { key: 'er', label: 'Engagement', align: 'right', sortable: true, render: (r) => html`<span class="strong">${fmtPct(r.er)}</span>` },
    {
      key: 'actions',
      label: html`<span class="sr-only">Actions</span>`,
      align: 'right',
      render: (r) =>
        r.own
          ? html`<${Menu} label=${'Actions for your account'} items=${[{ label: 'Open analytics', icon: 'chart', onClick: () => navigate('#/analytics') }]} />`
          : html`<${Menu} label=${`Actions for @${r.username}`} items=${[
              { label: 'View posts', icon: 'image', onClick: () => setOpenUser(r.username) },
              { label: 'Open on Instagram', icon: 'external', onClick: () => window.open(`https://www.instagram.com/${r.username}/`, '_blank', 'noopener,noreferrer') },
              '-',
              { label: 'Remove', icon: 'trash', danger: true, onClick: () => remove(r.username) },
            ]} />`,
    },
  ];
  const onRow = (r) => (r.own ? navigate('#/analytics') : setOpenUser(r.username));

  return html`<div class="page cpt-page">
    ${header}

    ${!settings?.ig
      ? html`<${Callout} tone="info" title="Connect Instagram first"
          action=${html`<${Button} href="#/settings?section=instagram" size="sm">Open Settings<//>`}>
          Competitor numbers come from Instagram, so connect your account in Settings.
        <//>`
      : !fbMode
        ? html`<${Callout} tone="info" title="Competitor numbers need Facebook Login"
            action=${html`<${Button} href="#/settings?section=instagram" size="sm" variant="secondary">Open Settings<//>`}>
            Instagram only shares other accounts’ followers and posts with apps connected through a Facebook Page. Switch the connection in Settings to see numbers here; you can still keep your list.
          <//>`
        : null}

    ${refreshError ? html`<${Callout} tone="warning" title="Refresh did not finish">${refreshError}<//>` : null}

    <${Panel} title="Accounts" flush
      subtitle=${lastUpdated
        ? `Updated ${relative(lastUpdated)}. The worker refreshes these numbers once a day.`
        : 'The worker refreshes these numbers once a day.'}>
      <div class="cpt-add-wrap"><${AddAccount} names=${names} ownUsername=${ownUsername} fbMode=${fbMode} /></div>
      ${!competitorRows.length
        ? html`<${EmptyState} icon="users" title="No accounts tracked yet"
            body="Add a business or creator account you want to compare with, like a studio you admire or a shop in your niche." />`
        : null}
      ${phone
        ? html`<ul class="list cpt-list" aria-label="Tracked accounts">
            ${rows.map(
              (r) => html`<li key=${r.id} class="list-row">
                <button type="button" class="cpt-list-main" onClick=${() => onRow(r)}>
                  <${AccountCell} row=${r} />
                  <span class="cpt-list-nums">
                    <span class="num strong">${formatNumber(r.followers)}</span>
                    <span class="text-xs muted">${fmtPct(r.er)} eng.</span>
                  </span>
                </button>
                ${r.own ? null : html`<${Menu} label=${`Actions for @${r.username}`} items=${[
                  { label: 'View posts', icon: 'image', onClick: () => setOpenUser(r.username) },
                  { label: 'Remove', icon: 'trash', danger: true, onClick: () => remove(r.username) },
                ]} />`}
              </li>`,
            )}
          </ul>`
        : html`<${DataTable} columns=${columns} rows=${rows} onRowClick=${onRow} rowKey=${(r) => r.id} caption="Your account and tracked accounts" />`}
      <p class="cpt-foot text-xs muted">
        Engagement = average likes + comments on recent posts ÷ followers. Instagram doesn’t share reach or saves for other accounts, so your row uses the same formula.
      </p>
    <//>

    <div class="grid-2 cpt-charts">
      <${Panel} title="Followers" subtitle="Last 30 days"
        actions=${html`<${Segmented} size="sm" label="Chart values" value=${chartMode} onChange=${setChartMode}
          options=${[{ value: 'followers', label: 'Followers' }, { value: 'growth', label: 'Change %' }]} />`}>
        <${LineChart} series=${lineSeries} xLabels=${chartKeys.map(keyLabel)} height=${240} area=${false}
          format=${chartMode === 'growth' ? 'percent' : undefined}
          label=${chartMode === 'growth' ? 'Follower change since the first day shown' : 'Followers over the last 30 days'}
          emptyText="No follower history yet. The worker saves one snapshot a day." />
        ${lineSeries.length && lineSeries.length < competitorRows.length + 1
          ? html`<p class="text-xs muted cpt-chart-note">Accounts without saved numbers yet are not shown.</p>`
          : null}
      <//>
      <${Panel} title="Engagement rate" subtitle="Likes + comments per post ÷ followers">
        <${BarChart} data=${erBars} horizontal format="percent" label="Engagement rate by account"
          emptyText="No engagement numbers yet." />
      <//>
    </div>

    <${CompetitorDrawer} row=${openRow} doc=${doc} fbMode=${fbMode} onClose=${() => setOpenUser(null)} onRemove=${remove} />
  </div>`;
}
