// Planner: month / week calendar, list with bulk actions, Instagram grid preview, CSV import and export.

import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { addHistory, hasErrors, validatePost } from '../../core/model.js';
import { parseTimestamp } from '../../core/analytics.js';
import { bestTimeMatrix } from '../../core/schedule.js';
import { addDaysKey, dayKey, format, formatDateTime, formatDay, formatTime, pad, weekdayOfKey, zonedToUtc } from '../../core/time.js';
import { useApp } from '../app.js';
import { loadViewCss } from '../css.js';
import { exportCsv, readImport, templateCsv, upcomingPosts } from '../csv-import.js';
import { mutate, transact, useDocs } from '../data.js';
import { saveBlob } from '../media.js';
import { setQuery } from '../router.js';
import {
  MonthView,
  PostThumb,
  SOURCE_LABEL,
  TYPE_ICON,
  TYPE_LABEL,
  WeekView,
  bestTimeOn,
  currentDrag,
  dayLabel,
  endDrag,
  filterStatus,
  igType,
  localMinutes,
  monthDays,
  monthTitle,
  postInstant,
  postTitle,
  previewAsset,
  sameTimeOn,
  shortTime,
  startDrag,
  statusKey,
  toneClass,
  weekDays,
} from '../ui/calendar.js';
import { Icon } from '../ui/icons.js';
import { useAssetUrl } from '../ui/media-picker.js';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Checkbox,
  Chip,
  DateTimeField,
  EmptyState,
  Field,
  IconButton,
  Menu,
  Modal,
  PageHeader,
  Segmented,
  Skeleton,
  StatusPill,
  TextInput,
  cx,
  usePhone,
} from '../ui/kit.js';

loadViewCss('planner');

const VIEWS = [
  { value: 'month', label: 'Month', icon: 'calendar' },
  { value: 'week', label: 'Week', icon: 'clock' },
  { value: 'list', label: 'List', icon: 'list' },
  { value: 'grid', label: 'Grid', icon: 'grid' },
];
const FILTERS = {
  type: [
    { value: 'feed', label: 'Posts' },
    { value: 'carousel', label: 'Carousels' },
    { value: 'reel', label: 'Reels' },
    { value: 'story', label: 'Stories' },
  ],
  status: [
    { value: 'scheduled', label: 'Scheduled' },
    { value: 'draft', label: 'Drafts' },
    { value: 'approval', label: 'Needs approval' },
    { value: 'published', label: 'Published' },
    { value: 'failed', label: 'Failed' },
  ],
  source: [
    { value: 'manual', label: 'Manual' },
    { value: 'autopilot', label: 'Autopilot' },
    { value: 'evergreen', label: 'Queues' },
    { value: 'csv', label: 'CSV import' },
  ],
};
const FILTER_TITLES = { type: 'Type', status: 'Status', source: 'Source' };
const BASIS_TEXT = {
  audience: 'when your followers are online',
  engagement: 'how your past posts performed',
  blend: 'when your followers are online and how your past posts performed',
  default: 'typical Instagram activity, until there is enough data from your account',
};

const isDayKey = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDaysKey(s, 0) === s;
const splitQ = (s) => (s ? String(s).split(',').filter(Boolean) : []);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hhmm = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

function shiftMonth(key, n) {
  const [y, m] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-01`;
}

function useNow(ms = 60_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function matchPost(p, f) {
  if (f.type.length && !f.type.includes(p.type)) return false;
  if (f.status.length && !f.status.includes(filterStatus(p))) return false;
  if (f.source.length && !f.source.includes(p.source || 'manual')) return false;
  return true;
}

/** Run a data-layer write; errors are already toasted by the data layer. */
async function quietly(promise) {
  try {
    return await promise;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------

export default function Planner() {
  const { tz, route, openComposer, toast, confirm, dispatchWorker, settings } = useApp();
  const { data, loading, error } = useDocs(['posts', 'library', 'analytics-media', 'audience', 'lists']);
  const phone = usePhone();
  const nowMs = useNow();
  const today = dayKey(new Date(nowMs), tz);
  const q = route.query || {};
  const view = VIEWS.some((v) => v.value === q.view) ? q.view : 'month';
  const anchor = isDayKey(q.date) ? q.date : today;
  const filters = { type: splitQ(q.type), status: splitQ(q.status), source: splitQ(q.source) };
  const filterCount = filters.type.length + filters.status.length + filters.source.length;

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState(null);
  const [selection, setSelection] = useState(() => new Set());
  const [moving, setMoving] = useState(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => setSelection(new Set()), [view]);

  const postsDoc = data.posts;
  const posts = (postsDoc && postsDoc.posts) || [];
  const assets = (data.library && data.library.assets) || [];
  const assetsById = useMemo(() => Object.fromEntries(assets.map((a) => [a.id, a])), [data.library]);
  const lists = (data.lists && data.lists.lists) || [];
  const listsById = useMemo(() => Object.fromEntries(lists.map((l) => [l.id, l])), [data.lists]);
  const mediaStats = (data['analytics-media'] && data['analytics-media'].media) || {};
  const best = useMemo(
    () => bestTimeMatrix({ onlineFollowers: data.audience && data.audience.onlineFollowers, mediaStats, tz }),
    [data.audience, data['analytics-media'], tz],
  );

  const livePosts = useMemo(() => posts.filter((p) => p.status !== 'canceled'), [postsDoc]);
  const visiblePosts = livePosts.filter((p) => matchPost(p, filters));
  const showIg = !filters.source.length && (!filters.status.length || filters.status.includes('published'));

  const calItems = useMemo(() => {
    const linked = new Set(posts.map((p) => p.igMediaId).filter(Boolean));
    const out = [];
    for (const p of visiblePosts) {
      const at = postInstant(p);
      if (!at) continue;
      out.push({
        key: p.id,
        kind: 'post',
        post: p,
        at,
        day: dayKey(new Date(at), tz),
        minutes: localMinutes(at, tz),
        asset: previewAsset(p, assetsById),
        movable: p.status === 'draft' || p.status === 'scheduled',
        listColor: p.listId && listsById[p.listId] ? listsById[p.listId].color : null,
      });
    }
    if (showIg) {
      for (const m of Object.values(mediaStats)) {
        if (!m || !m.id || linked.has(m.id) || m.productType === 'STORY') continue;
        if (filters.type.length && !filters.type.includes(igType(m))) continue;
        const t = parseTimestamp(m.timestamp);
        if (!Number.isFinite(t)) continue;
        const at = new Date(t).toISOString();
        out.push({ key: `ig_${m.id}`, kind: 'ig', media: m, at, day: dayKey(new Date(t), tz), minutes: localMinutes(at, tz), src: m.thumbnailUrl || null, movable: false });
      }
    }
    return out;
  }, [postsDoc, data['analytics-media'], assetsById, listsById, tz, q.type, q.status, q.source]);

  // ---- writes ---------------------------------------------------------------

  const reschedule = async (post, iso, { verb } = {}) => {
    if (Date.parse(iso) < Date.now() + 60_000) {
      toast('That time has already passed. Pick a later time.', { kind: 'error' });
      return;
    }
    const before = post.scheduledAt;
    const label = formatDateTime(iso, tz);
    const ok = await quietly(
      mutate(
        'posts',
        (doc) => {
          const p = doc.posts.find((x) => x.id === post.id);
          if (!p || (p.status !== 'draft' && p.status !== 'scheduled')) return;
          p.scheduledAt = iso;
          addHistory(p, 'rescheduled', `Moved to ${label}`);
        },
        { message: 'reschedule post' },
      ),
    );
    if (!ok) return;
    toast(`${verb || (post.status === 'draft' ? 'Draft moved' : 'Rescheduled')} to ${label}`, {
      kind: 'success',
      action: {
        label: 'Undo',
        onClick: () =>
          quietly(
            mutate(
              'posts',
              (doc) => {
                const p = doc.posts.find((x) => x.id === post.id);
                if (!p || p.scheduledAt !== iso) return;
                p.scheduledAt = before;
                addHistory(p, 'rescheduled', 'Move undone');
              },
              { message: 'undo reschedule' },
            ),
          ),
      },
    });
  };

  const dropOnDay = (id, day, minutes = null) => {
    const post = livePosts.find((p) => p.id === id);
    if (!post) return;
    let iso;
    if (minutes != null) iso = zonedToUtc(day, hhmm(minutes), tz).toISOString();
    else if (post.scheduledAt) iso = sameTimeOn(post.scheduledAt, day, tz);
    else iso = bestTimeOn(day, { matrix: best.matrix, tz, nowMs: Date.now() });
    if (!iso) {
      toast('There is no time left on that day. Pick a later day.', { kind: 'error' });
      return;
    }
    if (iso === post.scheduledAt) return;
    reschedule(post, iso);
  };

  const composeOnDay = (day) => {
    const iso = bestTimeOn(day, { matrix: best.matrix, tz, nowMs: Date.now() });
    if (!iso) {
      toast('That day has passed. Pick today or a later day.', { kind: 'info' });
      return;
    }
    openComposer({ scheduledAt: iso });
  };

  const composeAt = (day, minutes) => {
    const iso = zonedToUtc(day, hhmm(minutes), tz).toISOString();
    if (Date.parse(iso) < Date.now() + 5 * 60_000) {
      toast('That time has passed. Click a later slot.', { kind: 'info' });
      return;
    }
    openComposer({ scheduledAt: iso });
  };

  const toDrafts = async (ids) => {
    let changed = 0;
    const ok = await quietly(
      mutate(
        'posts',
        (doc) => {
          changed = 0;
          for (const p of doc.posts) {
            if (!ids.includes(p.id) || (p.status !== 'scheduled' && p.status !== 'failed')) continue;
            p.status = 'draft';
            p.attempts = 0;
            addHistory(p, 'unscheduled', 'Moved to drafts');
            changed++;
          }
        },
        { message: 'move posts to drafts' },
      ),
    );
    if (!ok) return;
    setSelection(new Set());
    toast(changed ? `Moved ${plural(changed, 'post')} to drafts. They will not publish until you schedule them again.` : 'Those posts are already drafts.', {
      kind: changed ? 'success' : 'info',
    });
  };

  const shiftDays = async (ids, n) => {
    if (!Number.isInteger(n) || !n) {
      toast('Enter a whole number of days, for example 2 or -1.', { kind: 'error' });
      return;
    }
    let moved = 0;
    let skipped = 0;
    const now = Date.now();
    const ok = await quietly(
      mutate(
        'posts',
        (doc) => {
          moved = 0;
          skipped = 0;
          for (const p of doc.posts) {
            if (!ids.includes(p.id)) continue;
            if (!p.scheduledAt || (p.status !== 'draft' && p.status !== 'scheduled')) {
              skipped++;
              continue;
            }
            const next = sameTimeOn(p.scheduledAt, addDaysKey(dayKey(new Date(p.scheduledAt), tz), n), tz);
            if (Date.parse(next) < now + 60_000) {
              skipped++;
              continue;
            }
            p.scheduledAt = next;
            addHistory(p, 'rescheduled', `Shifted by ${n} day${Math.abs(n) === 1 ? '' : 's'}`);
            moved++;
          }
        },
        { message: 'shift posts' },
      ),
    );
    if (!ok) return;
    setSelection(new Set());
    const dir = n > 0 ? 'later' : 'earlier';
    toast(
      `${moved ? `Moved ${plural(moved, 'post')} ${plural(Math.abs(n), 'day')} ${dir}.` : 'Nothing was moved.'}${skipped ? ` Skipped ${skipped} without a date or that would land in the past.` : ''}`,
      { kind: moved ? 'success' : 'info' },
    );
  };

  const remove = async (ids) => {
    const n = ids.length;
    const yes = await confirm({
      title: n === 1 ? 'Delete this post?' : `Delete ${n} posts?`,
      body: 'They are removed from the planner. Anything already on Instagram stays there.',
      confirmLabel: n === 1 ? 'Delete post' : `Delete ${n} posts`,
      danger: true,
    });
    if (!yes) return;
    let removed = 0;
    const ok = await quietly(
      transact(
        async (tx) => {
          removed = 0;
          const doc = await tx.read('posts');
          const lib = await tx.read('library');
          const fromAutopilot = new Set();
          doc.posts = doc.posts.filter((p) => {
            if (!ids.includes(p.id) || p.status === 'publishing' || p.status === 'published') return true;
            removed++;
            if (p.source === 'autopilot') for (const m of p.media || []) fromAutopilot.add(m.assetId);
            // Queue posts are canceled, not removed: a removed one would be created again for its slot.
            if (p.listId) {
              p.status = 'canceled';
              addHistory(p, 'canceled', 'Deleted in the planner');
              return true;
            }
            return false;
          });
          tx.write('posts', doc);
          if (fromAutopilot.size) {
            for (const a of lib.assets) if (fromAutopilot.has(a.id)) a.autopilot = false;
            tx.write('library', lib);
          }
          return true;
        },
        { message: 'delete posts' },
      ),
    );
    if (!ok) return;
    setSelection(new Set());
    toast(`Deleted ${plural(removed, 'post')}.`, { kind: 'success' });
  };

  const approve = async (post) => {
    if (hasErrors(validatePost({ ...post, status: 'scheduled' }, assetsById))) {
      toast('Fix the problems in this post before approving it.', { kind: 'error' });
      openComposer(post.id);
      return;
    }
    if (!post.scheduledAt || Date.parse(post.scheduledAt) < Date.now() + 60_000) {
      toast('Pick a future time for this post, then approve it.', { kind: 'info' });
      openComposer(post.id);
      return;
    }
    const ok = await quietly(
      mutate(
        'posts',
        (doc) => {
          const p = doc.posts.find((x) => x.id === post.id);
          if (!p || p.status !== 'draft') return;
          p.needsApproval = false;
          p.status = 'scheduled';
          addHistory(p, 'approved', 'Approved in the planner');
        },
        { message: 'approve post' },
      ),
    );
    if (ok) toast(`Approved. Scheduled for ${formatDateTime(post.scheduledAt, tz)}`, { kind: 'success' });
  };

  const retry = async (post) => {
    if (hasErrors(validatePost({ ...post, status: 'scheduled' }, assetsById))) {
      toast('Fix the problems in this post, then try again.', { kind: 'error' });
      openComposer(post.id);
      return;
    }
    const ok = await quietly(
      mutate(
        'posts',
        (doc) => {
          const p = doc.posts.find((x) => x.id === post.id);
          if (!p || p.status !== 'failed') return;
          p.status = 'scheduled';
          p.scheduledAt = new Date().toISOString();
          p.attempts = 0;
          p.lastError = null;
          addHistory(p, 'retry', 'Try again from the planner');
        },
        { message: 'retry failed post' },
      ),
    );
    if (!ok) return;
    toast('Publishing again. This usually takes 1–3 minutes.', { kind: 'info' });
    dispatchWorker('retry failed post', { quiet: true }).catch(() => {});
  };

  const swap = async (idA, idB) => {
    const a = livePosts.find((p) => p.id === idA);
    const b = livePosts.find((p) => p.id === idB);
    if (!a || !b || a === b || !a.scheduledAt || !b.scheduledAt) return;
    if (Math.min(Date.parse(a.scheduledAt), Date.parse(b.scheduledAt)) < Date.now() + 60_000) {
      toast('One of these times has already passed, so they cannot be swapped.', { kind: 'error' });
      return;
    }
    const ok = await quietly(
      mutate(
        'posts',
        (doc) => {
          const pa = doc.posts.find((x) => x.id === idA);
          const pb = doc.posts.find((x) => x.id === idB);
          if (!pa || !pb || !pa.scheduledAt || !pb.scheduledAt) return;
          [pa.scheduledAt, pb.scheduledAt] = [pb.scheduledAt, pa.scheduledAt];
          addHistory(pa, 'rescheduled', 'Swapped in the grid preview');
          addHistory(pb, 'rescheduled', 'Swapped in the grid preview');
        },
        { message: 'swap post times' },
      ),
    );
    if (ok) toast(`Swapped. "${postTitle(a).slice(0, 40)}" now posts ${formatDateTime(b.scheduledAt, tz)}.`, { kind: 'success' });
  };

  const exportUpcoming = () => {
    const list = upcomingPosts(posts, { now: Date.now() });
    if (!list.length) {
      toast('There are no upcoming posts to export.', { kind: 'info' });
      return;
    }
    saveBlob(new Blob([exportCsv(posts, assets, { tz, now: Date.now() })], { type: 'text/csv;charset=utf-8' }), `postpilot-upcoming-${today}.csv`);
    toast(`Exported ${plural(list.length, 'upcoming post')}.`, { kind: 'success' });
  };

  const postActions = {
    open: (post) => openComposer(post.id),
    move: (post) => setMoving(post),
    approve,
    retry,
    toDrafts: (post) => toDrafts([post.id]),
    remove: (post) => remove([post.id]),
  };

  // ---- header ---------------------------------------------------------------

  const weekAhead = livePosts.filter((p) => p.status === 'scheduled' && p.scheduledAt && Date.parse(p.scheduledAt) >= nowMs && Date.parse(p.scheduledAt) < nowMs + 7 * 864e5).length;
  const drafts = livePosts.filter((p) => p.status === 'draft' && !p.needsApproval).length;
  const approvals = livePosts.filter((p) => p.status === 'draft' && p.needsApproval).length;
  const failed = livePosts.filter((p) => p.status === 'failed').length;
  const summary = postsDoc
    ? [
        `${weekAhead} scheduled in the next 7 days`,
        plural(drafts, 'draft'),
        approvals ? `${approvals} to approve` : null,
        failed ? `${failed} failed` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Plan, move and preview your posts.';

  const actions = phone
    ? html`<${Menu} label="Import or export CSV" trigger="CSV" items=${[
          { label: 'Import CSV', icon: 'upload', onClick: () => setImporting(true) },
          { label: 'Export upcoming posts', icon: 'download', onClick: exportUpcoming },
        ]} />
        <${Button} variant="primary" icon="plus" onClick=${() => openComposer()}>New post<//>`
    : html`<${Button} icon="upload" onClick=${() => setImporting(true)}>Import CSV<//>
        <${Button} icon="download" onClick=${exportUpcoming}>Export CSV<//>
        <${Button} variant="primary" icon="plus" onClick=${() => openComposer()}>New post<//>`;

  // ---- toolbar --------------------------------------------------------------

  const days = view === 'week' ? weekDays(anchor) : monthDays(anchor);
  const month = Number(anchor.slice(5, 7));
  const step = (dir) => {
    const next = view === 'week' ? addDaysKey(anchor, dir * 7) : shiftMonth(anchor, dir);
    setQuery({ date: next });
  };
  const inPeriod = view === 'week' ? days.includes(today) : today.slice(0, 7) === anchor.slice(0, 7);
  let period = '';
  if (view === 'month') period = monthTitle(anchor, tz);
  if (view === 'week') {
    const a = zonedToUtc(days[0], '12:00', tz);
    const b = zonedToUtc(days[6], '12:00', tz);
    const sameMonth = days[0].slice(0, 7) === days[6].slice(0, 7);
    period = `${format(a, tz, { month: 'short', day: 'numeric' })} – ${format(b, tz, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}, ${days[6].slice(0, 4)}`;
  }

  const toggleFilter = (group, value) => {
    const cur = filters[group];
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
    setQuery({ [group]: next.join(',') || undefined });
  };
  const clearFilters = () => setQuery({ type: undefined, status: undefined, source: undefined });

  const toolbar = html`<div class="pl-toolbar">
    <${Segmented} label="Planner view" options=${VIEWS} value=${view} onChange=${(v) => setQuery({ view: v === 'month' ? undefined : v })} class="pl-views" />
    ${view === 'month' || view === 'week'
      ? html`<div class="pl-nav">
          <${IconButton} icon="chevron-left" label=${view === 'week' ? 'Previous week' : 'Previous month'} onClick=${() => step(-1)} />
          <${Button} size="sm" variant=${inPeriod ? 'ghost' : 'secondary'} onClick=${() => setQuery({ date: undefined })} disabled=${inPeriod && anchor === today}>Today<//>
          <${IconButton} icon="chevron-right" label=${view === 'week' ? 'Next week' : 'Next month'} onClick=${() => step(1)} />
          <h2 class="pl-period" aria-live="polite">${period}</h2>
        </div>`
      : null}
    <span class="spacer"></span>
    <${Button} size="sm" variant=${filterCount ? 'secondary' : 'ghost'} icon="filter" aria-expanded=${filtersOpen ? 'true' : 'false'} aria-controls="planner-filters"
      onClick=${() => setFiltersOpen((o) => !o)}>Filters${filterCount ? html` <span class="pl-count num">${filterCount}</span>` : null}<//>
  </div>`;

  const filterPanel = filtersOpen
    ? html`<div class="pl-filters" id="planner-filters" role="group" aria-label="Filters">
        ${Object.entries(FILTERS).map(
          ([group, opts]) => html`<div class="pl-filter-group" key=${group}>
            <span class="label-caps pl-filter-title">${FILTER_TITLES[group]}</span>
            <div class="pl-filter-chips">
              ${opts.map((o) => html`<${Chip} key=${o.value} selected=${filters[group].includes(o.value)} onClick=${() => toggleFilter(group, o.value)}>${o.label}<//>`)}
            </div>
          </div>`,
        )}
        ${filterCount ? html`<${Button} size="sm" variant="ghost" icon="x" onClick=${clearFilters}>Clear filters<//>` : null}
      </div>`
    : filterCount
      ? html`<div class="pl-active-filters" aria-label="Active filters">
          ${Object.entries(FILTERS).flatMap(([group, opts]) =>
            opts
              .filter((o) => filters[group].includes(o.value))
              .map((o) => html`<${Chip} key=${group + o.value} selected onRemove=${() => toggleFilter(group, o.value)} removeLabel=${`Remove filter ${o.label}`}>${o.label}<//>`),
          )}
          <${Button} size="sm" variant="ghost" onClick=${clearFilters}>Clear<//>
        </div>`
      : null;

  // ---- body -----------------------------------------------------------------

  let body;
  if (error && !postsDoc) {
    body = html`<${Callout} tone="danger" title="Could not load your posts">${error.message || String(error)}. Check your connection, then reload the page.<//>`;
  } else if (!postsDoc || (loading && !data.library)) {
    body = html`<div class="pl-loading"><${Skeleton} height=${phone ? 380 : 560} /></div>`;
  } else if (view === 'month') {
    const sel = selectedDay && days.includes(selectedDay) ? selectedDay : days.includes(today) && today.slice(0, 7) === anchor.slice(0, 7) ? today : null;
    const unscheduled = visiblePosts.filter((p) => p.status === 'draft' && !p.scheduledAt);
    body = html`
      <${MonthView} days=${days} month=${month} today=${today} tz=${tz} items=${calItems} selected=${sel} phone=${phone}
        onCellClick=${(day) => (phone || day < today ? setSelectedDay(day) : composeOnDay(day))}
        onSelect=${setSelectedDay}
        onOpen=${(it) => postActions.open(it.post)}
        onDropPost=${(id, day) => dropOnDay(id, day)} />
      ${unscheduled.length ? html`<${DraftTray} posts=${unscheduled} assetsById=${assetsById} onOpen=${postActions.open} />` : null}
      ${sel
        ? html`<${DayPanel} day=${sel} today=${today} tz=${tz} items=${calItems.filter((it) => it.day === sel).sort((a, b) => a.minutes - b.minutes)}
            listsById=${listsById} actions=${postActions} onCompose=${() => composeOnDay(sel)} />`
        : html`<p class="muted text-sm pl-hint">Choose a day to see its posts. ${phone ? '' : 'Click an empty part of a day to plan a post at its best time, or drag a post to another day.'}</p>`}`;
  } else if (view === 'week') {
    body = html`
      <${WeekLegend} best=${best} days=${days} tz=${tz} nowMs=${nowMs} onCompose=${(iso) => openComposer({ scheduledAt: iso })} />
      <${WeekView} days=${days} today=${today} nowMs=${nowMs} tz=${tz} items=${calItems} matrix=${best.matrix}
        onCompose=${composeAt} onComposeDay=${composeOnDay} onOpen=${(it) => postActions.open(it.post)}
        onDropPost=${(id, day, minutes) => dropOnDay(id, day, minutes)} />`;
  } else if (view === 'list') {
    body = html`<${ListView} posts=${visiblePosts} assetsById=${assetsById} listsById=${listsById} tz=${tz} today=${today} nowMs=${nowMs}
      selection=${selection} setSelection=${setSelection} actions=${postActions}
      onToDrafts=${toDrafts} onShift=${shiftDays} onDelete=${remove} onCompose=${() => openComposer()} filtered=${filterCount > 0} />`;
  } else {
    body = html`<${GridView} posts=${visiblePosts} mediaStats=${showIg ? mediaStats : {}} assetsById=${assetsById} tz=${tz} nowMs=${nowMs}
      account=${settings && settings.ig} onOpen=${postActions.open} onSwap=${swap} phone=${phone} />`;
  }

  return html`<div class="page planner">
    <${PageHeader} title="Planner" subtitle=${summary} actions=${actions} />
    <div class="pl-controls">
      ${toolbar}
      ${filterPanel}
    </div>
    ${body}
    ${moving ? html`<${MoveDialog} post=${moving} tz=${tz} onClose=${() => setMoving(null)} onMove=${(iso) => {
      const p = moving;
      setMoving(null);
      reschedule(p, iso);
    }} />` : null}
    ${importing ? html`<${ImportModal} assets=${assets} tz=${tz} toast=${toast} onClose=${() => setImporting(false)} />` : null}
  </div>`;
}

// ---------------------------------------------------------------------------
// Rows (day panel + list view)

function PostRow({ post, asset, tz, listsById, actions, selectable, checked, onCheck, showDate }) {
  const title = postTitle(post);
  const at = postInstant(post);
  const list = post.listId && listsById[post.listId];
  const editable = post.status === 'draft' || post.status === 'scheduled';
  const approval = post.needsApproval && post.status === 'draft';
  const menu = [
    { label: post.status === 'published' ? 'View details' : 'Edit', icon: 'edit', onClick: () => actions.open(post) },
    editable ? { label: post.scheduledAt ? 'Move to…' : 'Set a date…', icon: 'calendar', onClick: () => actions.move(post) } : null,
    approval ? { label: 'Approve', icon: 'check', onClick: () => actions.approve(post) } : null,
    post.status === 'failed' ? { label: 'Try again', icon: 'refresh', onClick: () => actions.retry(post) } : null,
    post.status === 'scheduled' || post.status === 'failed' ? { label: 'Move to drafts', icon: 'file', onClick: () => actions.toDrafts(post) } : null,
    post.status !== 'published' && post.status !== 'publishing' ? '-' : null,
    post.status !== 'published' && post.status !== 'publishing' ? { label: 'Delete', icon: 'trash', danger: true, onClick: () => actions.remove(post) } : null,
  ].filter(Boolean);
  return html`<li class=${cx('list-row pl-row', checked && 'is-checked')} data-post-id=${post.id}>
    ${selectable ? html`<${Checkbox} checked=${checked} onChange=${onCheck} aria-label=${`Select: ${title}`} class="pl-row-check" />` : null}
    <button type="button" class="pl-row-thumb" onClick=${() => actions.open(post)} tabindex="-1" aria-hidden="true">
      <${PostThumb} asset=${asset} size=${44} />
    </button>
    <div class="pl-row-main">
      <button type="button" class="pl-row-title" onClick=${() => actions.open(post)}>${title}</button>
      <div class="pl-row-meta">
        <span class="pl-meta-item mono">${at ? (showDate ? formatDateTime(at, tz) : formatTime(at, tz)) : 'No date yet'}</span>
        <span class="pl-meta-item"><${Icon} name=${TYPE_ICON[post.type]} size=${13} />${TYPE_LABEL[post.type]}${post.media && post.media.length > 1 ? ` · ${post.media.length}` : ''}</span>
        ${post.source && post.source !== 'manual' ? html`<span class="pl-meta-item">${list ? html`<span class="pl-list-dot" style=${{ background: list.color }} aria-hidden="true"></span>${list.name}` : SOURCE_LABEL[post.source] || post.source}</span>` : null}
        ${(post.labels || []).slice(0, 2).map((l) => html`<${Badge} tone="outline" key=${l}>${l}<//>`)}
      </div>
      ${post.status === 'failed' && post.lastError ? html`<p class="pl-row-error"><${Icon} name="alert" size=${13} /><span>${post.lastError.message}</span></p>` : null}
    </div>
    <div class="pl-row-side">
      <${StatusPill} status=${statusKey(post)} />
      ${approval ? html`<${Button} size="sm" variant="primary" icon="check" onClick=${() => actions.approve(post)}>Approve<//>` : null}
      ${post.status === 'failed' ? html`<${Button} size="sm" icon="refresh" onClick=${() => actions.retry(post)}>Try again<//>` : null}
      <${Menu} items=${menu} label=${`Actions for ${title}`} size="sm" />
    </div>
  </li>`;
}

function IgRow({ item, tz }) {
  const m = item.media;
  const title = (m.caption || '').split('\n')[0] || 'Published on Instagram';
  return html`<li class="list-row pl-row is-ig">
    <span class="pl-row-thumb"><${PostThumb} src=${item.src} size=${44} /></span>
    <div class="pl-row-main">
      <span class="pl-row-title is-static">${title}</span>
      <div class="pl-row-meta">
        <span class="pl-meta-item mono">${formatTime(item.at, tz)}</span>
        <span class="pl-meta-item"><${Icon} name=${TYPE_ICON[igType(m)]} size=${13} />${TYPE_LABEL[igType(m)]}</span>
        <span class="pl-meta-item">Posted outside Postpilot or before it was set up</span>
      </div>
    </div>
    <div class="pl-row-side">
      <${StatusPill} status="published" />
      ${m.permalink ? html`<${Button} size="sm" variant="ghost" iconRight="external" href=${m.permalink} target="_blank" rel="noopener noreferrer">View<//>` : null}
    </div>
  </li>`;
}

function DayPanel({ day, today, tz, items, listsById, actions, onCompose }) {
  const date = formatDay(zonedToUtc(day, '12:00', tz), tz);
  const label = dayLabel(day, today, tz);
  return html`<section class="panel pl-daypanel" aria-label=${`Posts on ${date}`}>
    <header class="pl-daypanel-head">
      <div>
        <h2 class="section-title">${label}</h2>
        ${label !== date ? html`<p class="muted text-sm">${date}</p>` : null}
      </div>
      ${day >= today ? html`<${Button} size="sm" icon="plus" onClick=${onCompose}>New post on this day<//>` : null}
    </header>
    ${items.length
      ? html`<ul class="list pl-rows">
          ${items.map((it) =>
            it.kind === 'ig'
              ? html`<${IgRow} key=${it.key} item=${it} tz=${tz} />`
              : html`<${PostRow} key=${it.key} post=${it.post} asset=${it.asset} tz=${tz} listsById=${listsById} actions=${actions} />`,
          )}
        </ul>`
      : html`<${EmptyState} compact icon="calendar" title=${day < today ? 'Nothing was posted this day' : 'Nothing planned for this day'}
          body=${day >= today ? 'Plan a post at the best time of the day.' : undefined} />`}
  </section>`;
}

function DraftTray({ posts, assetsById, onOpen }) {
  return html`<section class="pl-tray" aria-label="Drafts without a date">
    <div class="pl-tray-head">
      <span class="label-caps">Drafts without a date</span>
      <span class="muted text-sm hide-phone">Drag one onto a day to plan it.</span>
    </div>
    <div class="pl-tray-items">
      ${posts.map((p) => {
        const title = postTitle(p);
        return html`<div key=${p.id} role="button" tabindex="0" class=${cx('cal-event pl-chip is-draft is-movable', toneClass(p))} draggable="true" data-post-id=${p.id}
          title=${`${title} (drag onto a day to plan it)`} aria-label=${`Draft: ${title}`}
          onDragStart=${(e) => startDrag(e, p.id)} onDragEnd=${endDrag}
          onClick=${() => onOpen(p)} onKeyDown=${(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(p))}>
          <${PostThumb} asset=${previewAsset(p, assetsById)} size=${18} />
          <span class="pl-chip-type"><${Icon} name=${TYPE_ICON[p.type]} size=${12} /></span>
          <span class="cal-title">${title}</span>
        </div>`;
      })}
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Week legend (best times)

function WeekLegend({ best, days, tz, nowMs, onCompose }) {
  const picks = [];
  for (const t of best.top || []) {
    if (picks.length >= 3) break;
    let day = days.find((d) => weekdayOfKey(d) === t.weekday);
    if (!day) continue;
    let iso = zonedToUtc(day, `${pad(t.hour)}:00`, tz).toISOString();
    if (Date.parse(iso) < nowMs + 20 * 60_000) {
      day = addDaysKey(day, 7);
      iso = zonedToUtc(day, `${pad(t.hour)}:00`, tz).toISOString();
    }
    if (picks.some((p) => p.iso === iso)) continue;
    picks.push({ iso, label: `${format(iso, tz, { weekday: 'short' })} ${shortTime(iso, tz)}` });
  }
  return html`<div class="pl-legend">
    <p class="muted text-sm pl-legend-text"><span class="pl-legend-swatch" aria-hidden="true"></span>Shaded hours are good times to post, based on ${BASIS_TEXT[best.basis] || BASIS_TEXT.default}.</p>
    ${picks.length
      ? html`<span class="pl-legend-best">
          <span class="label-caps">Best</span>
          ${picks.map((p) => html`<${Chip} key=${p.iso} icon="clock" onClick=${() => onCompose(p.iso)} title=${`Plan a post on ${formatDateTime(p.iso, tz)}`}>${p.label}<//>`)}
        </span>`
      : null}
  </div>`;
}

// ---------------------------------------------------------------------------
// List view

function ListView({ posts, assetsById, listsById, tz, today, nowMs, selection, setSelection, actions, onToDrafts, onShift, onDelete, onCompose, filtered }) {
  const [shift, setShift] = useState(1);
  const byTime = (a, b) => (Date.parse(a.scheduledAt || '') || Infinity) - (Date.parse(b.scheduledAt || '') || Infinity);
  const approval = posts.filter((p) => p.status === 'draft' && p.needsApproval).sort(byTime);
  const failedList = posts.filter((p) => p.status === 'failed').sort((a, b) => byTime(b, a));
  const scheduled = posts.filter((p) => p.status === 'scheduled' || p.status === 'publishing').sort(byTime);
  const draftList = posts
    .filter((p) => p.status === 'draft' && !p.needsApproval)
    .sort((a, b) => (a.scheduledAt && b.scheduledAt ? byTime(a, b) : a.scheduledAt ? -1 : b.scheduledAt ? 1 : String(b.updatedAt).localeCompare(String(a.updatedAt))));
  const selectable = (p) => p.status !== 'publishing' && p.status !== 'published';
  const ids = new Set(posts.map((p) => p.id));
  const chosen = [...selection].filter((id) => ids.has(id));

  const toggle = (id, on) => {
    const next = new Set(selection);
    if (on) next.add(id);
    else next.delete(id);
    setSelection(next);
  };
  const toggleAll = (list, on) => {
    const next = new Set(selection);
    for (const p of list) if (selectable(p)) on ? next.add(p.id) : next.delete(p.id);
    setSelection(next);
  };

  const rows = (list, showDate = true) => html`<ul class="list pl-rows">
    ${list.map((p) => html`<${PostRow} key=${p.id} post=${p} asset=${previewAsset(p, assetsById)} tz=${tz} listsById=${listsById} actions=${actions}
      selectable=${selectable(p)} checked=${selection.has(p.id)} onCheck=${(on) => toggle(p.id, on)} showDate=${showDate} />`)}
  </ul>`;

  const section = (id, title, list, content, hint) => {
    if (!list.length) return null;
    const sel = list.filter((p) => selection.has(p.id)).length;
    const all = list.filter(selectable).length;
    return html`<section class="pl-section" aria-labelledby=${`pl-sec-${id}`} data-section=${id}>
      <header class="pl-section-head">
        ${all ? html`<${Checkbox} checked=${sel > 0 && sel === all} indeterminate=${sel > 0 && sel < all} onChange=${(on) => toggleAll(list, on)} aria-label=${`Select all: ${title}`} />` : null}
        <h2 class="section-title" id=${`pl-sec-${id}`}>${title}</h2>
        <span class="pl-section-count num">${list.length}</span>
        ${hint ? html`<span class="muted text-sm pl-section-hint">${hint}</span>` : null}
      </header>
      ${content}
    </section>`;
  };

  // Scheduled posts grouped by day.
  const groups = [];
  for (const p of scheduled) {
    const d = dayKey(new Date(p.scheduledAt), tz);
    const g = groups[groups.length - 1];
    if (g && g.day === d) g.posts.push(p);
    else groups.push({ day: d, posts: [p] });
  }
  const scheduledContent = html`<div class="pl-daygroups">
    ${groups.map(
      (g) => html`<div class="pl-daygroup" key=${g.day}>
        <h3 class="pl-daygroup-head">
          <span class=${cx(g.day === today && 'marker-underline')}>${dayLabel(g.day, today, tz)}</span>
          ${dayLabel(g.day, today, tz) !== formatDay(zonedToUtc(g.day, '12:00', tz), tz) ? html`<span class="muted">${formatDay(zonedToUtc(g.day, '12:00', tz), tz)}</span>` : null}
          ${g.day < today ? html`<${Badge} tone="warning">Due now<//>` : null}
        </h3>
        ${rows(g.posts, false)}
      </div>`,
    )}
  </div>`;

  const empty = !approval.length && !failedList.length && !scheduled.length && !draftList.length;
  return html`<div class="pl-list">
    ${empty
      ? html`<${EmptyState} icon="list" title=${filtered ? 'No posts match these filters' : 'Nothing planned yet'}
          body=${filtered ? 'Clear a filter to see more.' : 'Create a post, import a CSV or set up a queue to fill your calendar.'}
          action=${filtered ? null : html`<${Button} variant="primary" icon="plus" onClick=${onCompose}>New post<//>`} />`
      : null}
    ${section('approval', 'Needs approval', approval, rows(approval), 'Created by autopilot. Approve to schedule.')}
    ${section('failed', 'Failed', failedList, rows(failedList), 'Fix the problem or try again.')}
    ${section('scheduled', 'Scheduled', scheduled, scheduledContent)}
    ${section('drafts', 'Drafts', draftList, rows(draftList), 'Drafts never publish on their own.')}
    ${chosen.length
      ? html`<div class="pl-bulk" role="region" aria-label="Bulk actions">
          <span class="pl-bulk-count"><strong class="num">${chosen.length}</strong> selected</span>
          <${Button} size="sm" icon="file" onClick=${() => onToDrafts(chosen)}>Move to drafts<//>
          <span class="pl-bulk-shift">
            <label class="text-sm" for="pl-shift-days">Shift by</label>
            <${TextInput} id="pl-shift-days" type="number" value=${shift} onChange=${setShift} class="pl-shift-input" min="-365" max="365" step="1" />
            <span class="text-sm">days</span>
            <${Button} size="sm" onClick=${() => onShift(chosen, Number(shift))}>Shift<//>
          </span>
          <${Button} size="sm" variant="danger" icon="trash" onClick=${() => onDelete(chosen)}>Delete<//>
          <span class="spacer"></span>
          <${Button} size="sm" variant="ghost" onClick=${() => setSelection(new Set())}>Clear selection<//>
        </div>`
      : null}
  </div>`;
}

// ---------------------------------------------------------------------------
// Grid view (Instagram profile preview)

function GridImage({ asset, src }) {
  const url = useAssetUrl(src ? null : asset);
  const image = src || url;
  return image
    ? html`<img src=${image} alt="" decoding="async" draggable="false" referrerpolicy="no-referrer" />`
    : html`<span class="pl-tile-blank"><${Icon} name="image" size=${20} /></span>`;
}

function GridView({ posts, mediaStats, assetsById, tz, nowMs, account, onOpen, onSwap, phone }) {
  const [dropId, setDropId] = useState(null);
  const upcoming = posts
    .filter((p) => p.type !== 'story' && !(p.type === 'reel' && p.shareToFeed === false) && p.scheduledAt)
    .filter((p) => p.status === 'scheduled' || p.status === 'publishing' || (p.status === 'draft' && Date.parse(p.scheduledAt) >= nowMs))
    .sort((a, b) => Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt));
  const published = [
    ...Object.values(mediaStats)
      .filter((m) => m && m.id && m.productType !== 'STORY')
      .map((m) => ({ key: `ig_${m.id}`, t: parseTimestamp(m.timestamp), src: m.thumbnailUrl, permalink: m.permalink, type: igType(m), caption: m.caption || '' })),
    ...posts
      .filter((p) => p.status === 'published' && p.type !== 'story' && !(p.igMediaId && mediaStats[p.igMediaId]))
      .map((p) => ({ key: p.id, t: Date.parse(p.publishedAt || p.scheduledAt), asset: previewAsset(p, assetsById), permalink: p.permalink, type: p.type, caption: p.caption || '', post: p })),
  ]
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => b.t - a.t)
    .slice(0, 18);

  const tile = (p, i) => {
    const title = postTitle(p);
    const when = `${format(p.scheduledAt, tz, { month: 'short', day: 'numeric' })} ${shortTime(p.scheduledAt, tz)}`;
    const movable = (p.status === 'scheduled' || p.status === 'draft') && Date.parse(p.scheduledAt) > nowMs;
    const items = [
      { label: 'Edit', icon: 'edit', onClick: () => onOpen(p) },
      { label: 'Move up in grid', icon: 'arrow-up', disabled: !movable || i === 0 || !upcoming[i - 1], onClick: () => onSwap(p.id, upcoming[i - 1].id) },
      { label: 'Move down in grid', icon: 'arrow-down', disabled: !movable || i === upcoming.length - 1, onClick: () => onSwap(p.id, upcoming[i + 1].id) },
    ];
    return html`<div key=${p.id} class=${cx('pl-tile is-upcoming', p.status === 'draft' && 'is-draft', dropId === p.id && 'is-drop')} data-post-id=${p.id}
      draggable=${movable ? 'true' : 'false'}
      onDragStart=${movable ? (e) => startDrag(e, p.id) : (e) => e.preventDefault()}
      onDragEnd=${() => {
        endDrag();
        setDropId(null);
      }}
      onDragOver=${(e) => {
        const d = currentDrag();
        if (!d || d.id === p.id || !movable) return;
        e.preventDefault();
        if (dropId !== p.id) setDropId(p.id);
      }}
      onDragLeave=${(e) => !e.currentTarget.contains(e.relatedTarget) && setDropId((x) => (x === p.id ? null : x))}
      onDrop=${(e) => {
        e.preventDefault();
        const d = currentDrag();
        endDrag();
        setDropId(null);
        if (d && d.id !== p.id) onSwap(d.id, p.id);
      }}>
      <div role="button" tabindex="0" class="pl-tile-open" aria-label=${`${p.status === 'draft' ? 'Draft' : 'Scheduled'} ${TYPE_LABEL[p.type]}, ${when}: ${title}`}
        onClick=${() => onOpen(p)} onKeyDown=${(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(p))}>
        <${GridImage} asset=${previewAsset(p, assetsById)} />
        <span class="pl-tile-time">${when}</span>
        ${p.status === 'draft' ? html`<span class="pl-tile-flag">Draft</span>` : null}
        ${p.type !== 'feed' ? html`<span class="pl-tile-kind" aria-hidden="true"><${Icon} name=${TYPE_ICON[p.type]} size=${14} /></span>` : null}
      </div>
      <${Menu} class="pl-tile-menu" items=${items} label=${`Actions for ${title}`} size="sm" icon="more" />
    </div>`;
  };

  return html`<div class="pl-gridview">
    <div class="pl-phone">
      <div class="pl-profile">
        <${Avatar} src=${account && account.profilePictureUrl} name=${(account && (account.name || account.username)) || 'Account'} size=${phone ? 48 : 56} />
        <div class="pl-profile-text">
          <strong>${account ? `@${account.username}` : 'Your account'}</strong>
          <span class="muted text-sm">${plural(upcoming.length, 'planned post')} · ${plural(published.length, 'recent post')}</span>
        </div>
      </div>
      ${upcoming.length || published.length
        ? html`<div class="ig-grid pl-ig-grid" aria-label="Profile grid preview">
            ${upcoming.map(tile)}
            ${published.map(
              (m) => html`<a key=${m.key} class="pl-tile is-published" href=${m.permalink || undefined} target="_blank" rel="noopener noreferrer"
                aria-label=${`Published ${TYPE_LABEL[m.type]}: ${(m.caption || '').split('\n')[0] || 'no caption'}`}>
                <${GridImage} asset=${m.asset} src=${m.src} />
                ${m.type !== 'feed' ? html`<span class="pl-tile-kind" aria-hidden="true"><${Icon} name=${TYPE_ICON[m.type]} size=${14} /></span>` : null}
              </a>`,
            )}
          </div>`
        : html`<${EmptyState} icon="grid" title="Nothing to preview yet" body="Scheduled posts and reels appear here above your published posts." />`}
    </div>
    <aside class="pl-grid-notes">
      <h2 class="section-title">How your grid will look</h2>
      <p class="muted">Planned posts and reels sit above what is already on your profile, newest first. Stories and reels that skip the feed are left out.</p>
      <ul class="pl-notes">
        <li><span class="pl-note-swatch is-upcoming" aria-hidden="true"></span>Scheduled</li>
        <li><span class="pl-note-swatch is-draft" aria-hidden="true"></span>Draft with a date</li>
        <li><span class="pl-note-swatch is-published" aria-hidden="true"></span>Published</li>
      </ul>
      <p class="muted text-sm">${phone ? 'Use the menu on a tile to move it up or down; that swaps the two publish times.' : 'Drag a planned tile onto another to swap their publish times, or use the tile menu.'}</p>
    </aside>
  </div>`;
}

// ---------------------------------------------------------------------------
// Move dialog

function MoveDialog({ post, tz, onClose, onMove }) {
  const [value, setValue] = useState(post.scheduledAt || null);
  const past = value && Date.parse(value) < Date.now() + 60_000;
  const title = postTitle(post);
  return html`<${Modal} open title=${post.scheduledAt ? 'Move post' : 'Set a date'} onClose=${onClose}
    footer=${html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//>
      <${Button} variant="primary" disabled=${!value || past || value === post.scheduledAt} onClick=${() => onMove(value)}>${post.scheduledAt ? 'Move post' : 'Set date'}<//>`}>
    <div class="stack">
      <p class="muted clamp-2">${title}</p>
      <${Field} label="New date and time" hint=${`Times are in ${tz}. The post keeps its status (${post.status === 'draft' ? 'draft' : 'scheduled'}).`}
        error=${past ? 'Pick a time in the future.' : undefined}>
        <${DateTimeField} value=${value} tz=${tz} onChange=${setValue} min=${new Date().toISOString()} />
      <//>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------
// CSV import

const COLUMN_HELP = [
  ['date', 'YYYY-MM-DD, for example 2026-03-14'],
  ['time', 'HH:mm in 24-hour time, in your time zone'],
  ['type', 'post, carousel, reel or story (blank: worked out from the media)'],
  ['caption', 'Post text'],
  ['first_comment', 'Optional first comment'],
  ['media', 'Library file names or asset ids, separated by |'],
  ['status', 'draft or scheduled (blank: scheduled when a date and time are set)'],
];

function ImportRowThumb({ asset }) {
  return html`<${PostThumb} asset=${asset} size=${36} />`;
}

function ImportModal({ assets, tz, toast, onClose }) {
  const [result, setResult] = useState(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

  const readFile = async (file) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setFileName(file.name);
      setResult({ error: 'This file is larger than 2 MB. Split it into smaller files and import them one at a time.', rows: [] });
      return;
    }
    const text = await file.text();
    setFileName(file.name);
    setResult(readImport(text, { assets, tz, now: Date.now() }));
  };

  const rows = (result && result.rows) || [];
  const ready = rows.filter((r) => r.post);
  const problems = rows.length - ready.length;

  const create = async () => {
    setBusy(true);
    try {
      await transact(
        async (tx) => {
          const doc = await tx.read('posts');
          const have = new Set(doc.posts.map((p) => p.id));
          for (const r of ready) if (!have.has(r.post.id)) doc.posts.push(structuredClone(r.post));
          tx.write('posts', doc);
        },
        { message: 'import posts from CSV' },
      );
      const scheduled = ready.filter((r) => r.post.status === 'scheduled').length;
      toast(
        `Imported ${plural(ready.length, 'post')}${scheduled && scheduled < ready.length ? ` (${scheduled} scheduled, ${plural(ready.length - scheduled, 'draft')})` : scheduled ? ' as scheduled' : ' as drafts'}.${problems ? ` Skipped ${plural(problems, 'row')} with problems.` : ''}`,
        { kind: 'success' },
      );
      onClose();
    } catch {
      /* the data layer showed the error */
    } finally {
      setBusy(false);
    }
  };

  const template = () => saveBlob(new Blob([templateCsv(assets, { tz, now: Date.now() })], { type: 'text/csv;charset=utf-8' }), 'postpilot-import-template.csv');

  const footer = result && !result.error
    ? html`<${Button} variant="ghost" onClick=${() => setResult(null)}>Choose another file<//>
        <span class="spacer"></span>
        <${Button} variant="ghost" onClick=${onClose}>Cancel<//>
        <${Button} variant="primary" loading=${busy} disabled=${!ready.length} onClick=${create}>${ready.length ? `Create ${plural(ready.length, 'post')}` : 'Nothing to import'}<//>`
    : html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//>`;

  return html`<${Modal} open wide title="Import posts from CSV" onClose=${onClose} footer=${footer} class="pl-import">
    ${!result || result.error
      ? html`<div class="stack">
          <p class="muted">Plan many posts at once from a spreadsheet. Upload the photos and videos to your library first, then refer to them by file name. Nothing is created until you check the preview.</p>
          <label class=${cx('pl-dropzone', dragOver && 'is-over')}
            onDragOver=${(e) => {
              if ([...(e.dataTransfer?.types || [])].includes('Files')) {
                e.preventDefault();
                setDragOver(true);
              }
            }}
            onDragLeave=${() => setDragOver(false)}
            onDrop=${(e) => {
              e.preventDefault();
              setDragOver(false);
              readFile(e.dataTransfer?.files?.[0]);
            }}>
            <input ref=${fileRef} type="file" accept=".csv,text/csv,text/plain" class="sr-only" aria-label="CSV file"
              onChange=${(e) => {
                const f = e.currentTarget.files[0];
                e.currentTarget.value = '';
                readFile(f);
              }} />
            <${Icon} name="upload" size=${22} />
            <span><strong>Choose a CSV file</strong> or drop it here</span>
            <span class="muted text-sm">UTF-8, comma or semicolon separated, up to 500 rows</span>
          </label>
          ${result && result.error ? html`<${Callout} tone="danger" title=${`Could not read ${fileName || 'the file'}`}>${result.error}<//>` : null}
          <div class="pl-columns">
            <div class="row row-between">
              <h3 class="label-caps">Columns</h3>
              <${Button} size="sm" variant="ghost" icon="download" onClick=${template}>Download template<//>
            </div>
            <dl class="kv pl-columns-kv">
              ${COLUMN_HELP.map(([k, v]) => html`<dt class="mono">${k}</dt><dd>${k === 'time' ? `${v} (${tz})` : v}</dd>`)}
            </dl>
          </div>
        </div>`
      : html`<div class="stack">
          <div class="pl-import-summary">
            <span class="mono text-sm truncate">${fileName}</span>
            <span><strong class="num">${ready.length}</strong> ready</span>
            ${problems ? html`<span class="text-bad"><strong class="num">${problems}</strong> with problems (skipped)</span>` : null}
            ${result.ignored.length ? html`<span class="muted text-sm">Ignored columns: ${result.ignored.join(', ')}</span>` : null}
          </div>
          ${result.truncated ? html`<${Callout} tone="warning">Only the first 500 rows are shown and imported. Split the file to import the rest.<//>` : null}
          ${!rows.length ? html`<${EmptyState} compact icon="file" title="The file has no rows under the header" />` : null}
          <ol class="pl-import-rows">
            ${rows.map((r) => {
              const when = r.scheduledAt ? formatDateTime(r.scheduledAt, tz) : 'No date';
              return html`<li key=${r.line} class=${cx('pl-import-row', r.post ? 'is-ok' : 'has-error')}>
                <span class="pl-import-line mono">Row ${r.line}</span>
                <div class="pl-import-main">
                  <div class="pl-import-head">
                    <span class="pl-import-thumbs">${r.assets.slice(0, 4).map((a) => html`<${ImportRowThumb} key=${a.id} asset=${a} />`)}</span>
                    <span class="mono text-sm">${when}</span>
                    ${r.type ? html`<span class="pl-meta-item text-sm"><${Icon} name=${TYPE_ICON[r.type]} size=${13} />${TYPE_LABEL[r.type]}</span>` : null}
                    <${StatusPill} status=${r.status} />
                  </div>
                  <p class="clamp-2 text-sm">${r.data.caption ? r.data.caption : html`<span class="muted">No caption</span>`}</p>
                  ${r.errors.map((e) => html`<p class="pl-import-msg text-bad"><${Icon} name="alert" size=${13} /><span>${e}</span></p>`)}
                  ${r.warnings.map((w) => html`<p class="pl-import-msg text-warn"><${Icon} name="info" size=${13} /><span>${w}</span></p>`)}
                </div>
              </li>`;
            })}
          </ol>
        </div>`}
  <//>`;
}
