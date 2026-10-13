// Planner calendar pieces: post helpers, search, thumbnails, drag state, Month, Week and Day views.
// Used by js/views/planner.js (and the post helpers by js/views/queues.js).

import { html, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { addDaysKey, dayKey, format, formatDay, formatTime, pad, weekdayOfKey, zonedParts, zonedToUtc } from '../../core/time.js';
import { hasThumb, importState } from '../media.js';
import { Icon } from './icons.js';
import { IconButton, StatusPill, cx } from './kit.js';
import { useAssetUrl } from './media-picker.js';
import { loadViewCss } from '../css.js';

// The calendar pieces are styled by the planner stylesheet (pl-* classes), also used by Queues.
loadViewCss('planner');

// ---------------------------------------------------------------------------
// Post helpers

export const TYPE_LABEL = { feed: 'Post', carousel: 'Carousel', reel: 'Reel', story: 'Story' };
export const TYPE_ICON = { feed: 'image', carousel: 'carousel', reel: 'reel', story: 'story' };
export const SOURCE_LABEL = { manual: 'Manual', autopilot: 'Autopilot', evergreen: 'Queue', csv: 'CSV import', recycle: 'Repost' };
export const WEEKDAYS_MON = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The asset that represents a post visually (reel cover when set, else the first media item). */
export function previewAsset(post, assetsById) {
  if (!post) return null;
  if (post.type === 'reel' && post.coverAssetId && assetsById[post.coverAssetId]) return assetsById[post.coverAssetId];
  const first = (post.media || [])[0];
  return (first && assetsById[first.assetId]) || null;
}

/** One-line title for a post: first caption line, else notes, else the type. */
export function postTitle(post) {
  const line = String(post.caption || '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean);
  if (line) return line;
  if (post.notes) return String(post.notes).split('\n')[0];
  return `${TYPE_LABEL[post.type] || 'Post'} without caption`;
}

/** Status key for StatusPill ('needs-approval' for drafts waiting for approval). */
export function statusKey(post) {
  if (post.needsApproval && post.status === 'draft') return 'needs-approval';
  return post.status;
}

/**
 * StatusPill for a post ('reminded' = waiting for the owner to post it by hand: the reminder went out,
 * or "Post by hand now" skipped it, so the pill never says a reminder was sent).
 */
export function PostStatus({ post }) {
  if (post.status === 'reminded') return html`<${StatusPill} status="reminded" class="is-reminded" />`;
  return html`<${StatusPill} status=${statusKey(post)} />`;
}

/** Hash of the screen that posts a reminded post by hand. */
export const postNowHash = (post) => `#/post-now/${encodeURIComponent(post.id)}`;

// instagram.com/p/<code>/, /reel/<code>/ (also /reels/, /tv/, or with the account name in front),
// with or without the scheme; the query (?igsh=…) and fragment are ignored.
const PERMALINK_RE = /^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(p|reels?|tv)\/([A-Za-z0-9_-]+)\/?(?:[?#]\S*)?$/i;

/**
 * A pasted link to an Instagram post as {url, shortcode} (url cleaned up:
 * https://www.instagram.com/p/<code>/ or /reel/<code>/), or null when it is not a post link.
 */
export function parsePermalink(text) {
  const m = PERMALINK_RE.exec(String(text || '').trim());
  if (!m) return null;
  const kind = m[1].toLowerCase();
  return { url: `https://www.instagram.com/${kind.startsWith('reel') ? 'reel' : kind}/${m[2]}/`, shortcode: m[2] };
}

/** Shortcode of an analytics-media item (stored, or read from its permalink), or null. */
export function mediaCode(m) {
  return (m && (m.shortcode || (parsePermalink(m.permalink) || {}).shortcode)) || null;
}

/**
 * Instagram media ids and shortcodes already shown as a Postpilot post: by igMediaId, and by the
 * link of a post marked as posted by hand before the worker linked it (so it never shows twice).
 */
export function linkedMedia(posts) {
  const ids = new Set();
  const codes = new Set();
  for (const p of posts || []) {
    if (!p) continue;
    if (p.igMediaId) ids.add(String(p.igMediaId));
    else if (p.status === 'published' && p.permalink) {
      const parsed = parsePermalink(p.permalink);
      if (parsed) codes.add(parsed.shortcode);
    }
  }
  return { ids, codes, has: (m) => !!m && (ids.has(String(m.id)) || codes.has(mediaCode(m))) };
}

/**
 * Does a post match a search? Every word must appear in its caption, first comment, notes or labels
 * (case-insensitive; a leading # or @ is optional).
 */
export function matchesSearch(post, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [post.caption, post.firstComment, post.notes, ...(post.labels || [])].map((v) => String(v || '').toLowerCase()).join('\n');
  return words.every((w) => hay.includes(w) || hay.includes(w.replace(/^[#@]/, '')));
}

/** Status bucket used by the planner filters. */
export function filterStatus(post) {
  if (post.needsApproval && post.status === 'draft') return 'approval';
  if (post.status === 'publishing') return 'scheduled';
  return post.status;
}

/** When a post appears on the calendar (publish time for published posts). */
export function postInstant(post) {
  return post.status === 'published' ? post.publishedAt || post.scheduledAt : post.scheduledAt;
}

/** Calendar chip tone class for a post. */
export function toneClass(post) {
  if (!post) return 'is-published';
  if (post.needsApproval && post.status === 'draft') return 'is-attention';
  return { draft: 'is-draft', published: 'is-published', failed: 'is-failed', publishing: 'is-attention', canceled: 'is-draft', reminded: 'is-reminded' }[post.status] || '';
}

/** Post type of an Instagram media item from analytics-media. */
export function igType(m) {
  if (m.productType === 'REELS') return 'reel';
  if (m.productType === 'STORY') return 'story';
  if (m.mediaType === 'CAROUSEL_ALBUM') return 'carousel';
  return 'feed';
}

/** Compact clock time: "6:00p" in 12-hour locales, "18:00" otherwise. */
export function shortTime(iso, tz) {
  return formatTime(iso, tz).replace(/\s?([AaPp])\.?\s?[Mm]\.?$/, (_, p) => p.toLowerCase());
}

/** Same wall-clock time on another day, as an ISO string. */
export function sameTimeOn(iso, day, tz) {
  const p = zonedParts(new Date(iso), tz);
  return zonedToUtc(day, `${pad(p.hour)}:${pad(p.minute)}`, tz).toISOString();
}

/** Minutes after local midnight of an instant. */
export function localMinutes(iso, tz) {
  const p = zonedParts(new Date(iso), tz);
  return p.hour * 60 + p.minute;
}

/**
 * Best publish time on a day: the highest-scoring hour of the best-time matrix that is at least
 * 20 minutes in the future. Returns an ISO string, or null when the day has no future hours left.
 */
export function bestTimeOn(day, { matrix, tz, nowMs = Date.now() }) {
  const wd = weekdayOfKey(day);
  const row = (matrix && matrix[wd]) || [];
  const hours = Array.from({ length: 24 }, (_, h) => h)
    .filter((h) => h >= 6)
    .sort((a, b) => (row[b] || 0) - (row[a] || 0) || a - b);
  for (const h of hours) {
    const iso = zonedToUtc(day, `${pad(h)}:00`, tz).toISOString();
    if (Date.parse(iso) >= nowMs + 20 * 60_000) return iso;
  }
  // Late today: the next quarter hour at least 30 minutes away, if still on the same day.
  const next = Math.ceil((nowMs + 30 * 60_000) / (15 * 60_000)) * 15 * 60_000;
  return dayKey(new Date(next), tz) === day ? new Date(next).toISOString() : null;
}

/** "Today", "Tomorrow", "Yesterday" or "Tue, Oct 13". */
export function dayLabel(day, today, tz) {
  if (day === today) return 'Today';
  if (day === addDaysKey(today, 1)) return 'Tomorrow';
  if (day === addDaysKey(today, -1)) return 'Yesterday';
  return formatDay(zonedToUtc(day, '12:00', tz), tz);
}

// ---------------------------------------------------------------------------
// Thumbnails

/**
 * Small thumbnail of a library asset (or a direct image URL for Instagram media). Files the worker
 * still has to download from a link show a download icon (an alert icon when the download failed);
 * videos without a picture (downloaded by the worker, which makes no poster frame) a video icon.
 */
export function PostThumb({ asset, src, size = 20, class: cls }) {
  const url = useAssetUrl(src ? null : asset);
  const image = src || url;
  const state = src ? null : importState(asset);
  const tip =
    state === 'failed'
      ? `Could not download from its link: ${asset.importError}`
      : state
        ? `Downloading from its link on the next worker run${asset.importLastError ? `. Last try failed: ${asset.importLastError}` : ''}`
        : undefined;
  const icon = state === 'failed' ? 'alert' : state ? 'download' : !src && asset && asset.kind === 'video' && !hasThumb(asset) ? 'video' : null;
  return html`<span class=${cx('pl-thumb', state === 'pending' && 'is-importing', state === 'failed' && 'is-import-failed', icon === 'video' && 'is-video', cls)}
    style=${{ width: `${size}px`, height: `${size}px` }} aria-hidden="true" title=${tip}>
    ${image
      ? html`<img src=${image} alt="" loading="lazy" decoding="async" draggable="false" referrerpolicy="no-referrer" />`
      : icon
        ? html`<${Icon} name=${icon} size=${Math.max(10, Math.min(18, Math.round(size * 0.42)))} />`
        : null}
  </span>`;
}

// ---------------------------------------------------------------------------
// Drag state (HTML5 drag and drop does not expose data during dragover)

let drag = null;

export function startDrag(e, id, extra = {}) {
  drag = { id, ...extra };
  try {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  } catch {
    /* some browsers refuse setData on certain targets */
  }
}

export function endDrag() {
  drag = null;
}

export function currentDrag() {
  return drag;
}

function activate(handler) {
  return (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handler(e);
    }
  };
}

// ---------------------------------------------------------------------------
// Month view

/**
 * items: [{key, kind: 'post'|'ig', at (ISO), day, minutes, post?, media?, asset?, src?, movable, listColor?}]
 */
function Chip({ item, tz, onOpen }) {
  const type = item.post ? item.post.type : igType(item.media);
  const title = item.post ? postTitle(item.post) : (item.media.caption || '').split('\n')[0] || 'Published on Instagram';
  const time = shortTime(item.at, tz);
  const label = `${time} · ${TYPE_LABEL[type]} · ${title}`;
  const content = html`
    <${PostThumb} asset=${item.asset} src=${item.src} size=${18} />
    <span class="cal-time">${time}</span>
    ${type !== 'feed' ? html`<span class="pl-chip-type" title=${TYPE_LABEL[type]}><${Icon} name=${TYPE_ICON[type]} size=${12} /></span>` : null}
    ${item.listColor ? html`<span class="pl-list-dot" style=${{ background: item.listColor }} aria-hidden="true"></span>` : null}
    <span class="cal-title">${title}</span>`;
  if (item.kind === 'ig') {
    return html`<a class="cal-event pl-chip is-published is-ig" href=${item.media.permalink || undefined} target="_blank" rel="noopener noreferrer"
      title=${`Published on Instagram: ${label}`} aria-label=${`Published on Instagram: ${label}`}>${content}</a>`;
  }
  return html`<div role="button" tabindex="0" class=${cx('cal-event pl-chip', toneClass(item.post), item.movable && 'is-movable')}
    draggable=${!!item.movable} data-post-id=${item.post.id}
    title=${item.movable ? `${label} (drag to another day to move it)` : item.post.status === 'reminded' ? `${label} (post it by hand)` : label}
    aria-label=${`${label}, ${item.post.status === 'reminded' ? 'post by hand' : statusKey(item.post).replace('-', ' ')}`}
    onDragStart=${item.movable ? (e) => startDrag(e, item.post.id) : (e) => e.preventDefault()} onDragEnd=${endDrag}
    onClick=${() => onOpen(item)} onKeyDown=${activate(() => onOpen(item))}>${content}</div>`;
}

/**
 * MonthView {days, month (1-12), today, tz, items, selected, phone, onCellClick(day), onSelect(day), onOpen(item), onDropPost(id, day)}
 */
export function MonthView({ days, month, today, tz, items, selected, phone, onCellClick, onSelect, onOpen, onDropPost }) {
  const [dropDay, setDropDay] = useState(null);
  const byDay = useMemo(() => {
    const m = new Map();
    for (const it of items) {
      if (!m.has(it.day)) m.set(it.day, []);
      m.get(it.day).push(it);
    }
    for (const list of m.values()) list.sort((a, b) => a.minutes - b.minutes || (a.kind === 'ig') - (b.kind === 'ig'));
    return m;
  }, [items]);
  const max = phone ? 2 : 3;
  return html`<div class="cal pl-month">
    ${WEEKDAYS_MON.map((d) => html`<div class="cal-head" key=${d}><span aria-hidden=${phone ? 'true' : undefined}>${phone ? d.slice(0, 1) : d}</span>${phone ? html`<span class="sr-only">${d}</span>` : null}</div>`)}
    ${days.map((day) => {
      const list = byDay.get(day) || [];
      const other = Number(day.slice(5, 7)) !== month;
      const past = day < today;
      const shown = list.length > max ? list.slice(0, max - 1) : list;
      const rest = list.length - shown.length;
      const dateLabel = `${formatDay(zonedToUtc(day, '12:00', tz), tz)}${day === today ? ', today' : ''}: ${list.length ? `${list.length} post${list.length === 1 ? '' : 's'}` : 'nothing planned'}`;
      return html`<div key=${day} data-day=${day}
        class=${cx('cal-day pl-day', other && 'is-other', day === today && 'is-today', past && 'is-past', dropDay === day && 'is-drop', selected === day && 'is-selected')}
        onClick=${(e) => {
          if (e.target.closest('.cal-event, .pl-more, .cal-date')) return;
          onCellClick(day);
        }}
        onDragOver=${(e) => {
          if (!currentDrag() || past) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dropDay !== day) setDropDay(day);
        }}
        onDragLeave=${(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setDropDay((d) => (d === day ? null : d));
        }}
        onDrop=${(e) => {
          e.preventDefault();
          const d = currentDrag();
          endDrag();
          setDropDay(null);
          if (d && !past) onDropPost(d.id, day);
        }}>
        <button type="button" class="cal-date" aria-label=${dateLabel} aria-pressed=${selected === day ? 'true' : 'false'} onClick=${() => onSelect(day)}>${Number(day.slice(8))}</button>
        ${shown.map((it) => html`<${Chip} key=${it.key} item=${it} tz=${tz} onOpen=${onOpen} />`)}
        ${rest > 0 ? html`<button type="button" class="pl-more" onClick=${() => onSelect(day)} aria-label=${`${rest} more on ${dateLabel}`}>+${rest}<span class="hide-phone"> more</span></button>` : null}
      </div>`;
    })}
  </div>`;
}

// ---------------------------------------------------------------------------
// Week view

export const WEEK_START_HOUR = 6;
const END_HOUR = 24;
const HOUR_PX = 48;
const SNAP = 15;
const BLOCK_H = 40;

function layoutDay(list) {
  const out = [];
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = [];
    for (const ev of cluster) {
      let lane = lanes.findIndex((end) => end <= ev.top);
      if (lane < 0) {
        lane = lanes.length;
        lanes.push(0);
      }
      lanes[lane] = ev.top + BLOCK_H;
      ev.lane = lane;
    }
    for (const ev of cluster) ev.lanes = lanes.length;
    out.push(...cluster);
    cluster = [];
    clusterEnd = -1;
  };
  const height = (END_HOUR - WEEK_START_HOUR) * HOUR_PX;
  for (const it of [...list].sort((a, b) => a.minutes - b.minutes)) {
    const raw = ((it.minutes - WEEK_START_HOUR * 60) / 60) * HOUR_PX;
    const top = Math.min(Math.max(0, raw), height - BLOCK_H);
    const ev = { ...it, top, early: raw < 0 };
    if (cluster.length && top >= clusterEnd) flush();
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, top + BLOCK_H);
  }
  flush();
  return out;
}

function minutesAt(e, col, offsetY = 0, round = Math.round) {
  const rect = col.getBoundingClientRect();
  const y = e.clientY - rect.top - offsetY;
  const m = WEEK_START_HOUR * 60 + round(((y / HOUR_PX) * 60) / SNAP) * SNAP;
  return Math.min(Math.max(m, WEEK_START_HOUR * 60), END_HOUR * 60 - SNAP);
}

function clock(minutes, tz, day) {
  return shortTime(zonedToUtc(day, `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`, tz).toISOString(), tz);
}

/**
 * WeekView {days (7 keys from Monday), today, nowMs, tz, items, matrix,
 *           onCompose(day, minutes), onComposeDay(day), onOpen(item), onDropPost(id, day, minutes)}
 */
export function WeekView({ days, today, nowMs, tz, items, matrix, onCompose, onComposeDay, onOpen, onDropPost }) {
  const [ghost, setGhost] = useState(null);
  const scrollRef = useRef(null);
  const byDay = useMemo(() => {
    const m = new Map(days.map((d) => [d, []]));
    for (const it of items) if (m.has(it.day)) m.get(it.day).push(it);
    for (const [d, list] of m) m.set(d, layoutDay(list));
    return m;
  }, [items, days.join()]);

  // Start scrolled to the earliest post of the week (or 08:00).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const earliest = Math.min(8 * 60, ...items.filter((it) => days.includes(it.day)).map((it) => it.minutes));
    el.scrollTop = Math.max(0, ((Math.max(earliest, WEEK_START_HOUR * 60) - WEEK_START_HOUR * 60 - 30) / 60) * HOUR_PX);
  }, [days[0]]);

  const hours = Array.from({ length: END_HOUR - WEEK_START_HOUR }, (_, i) => WEEK_START_HOUR + i);
  const nowP = zonedParts(new Date(nowMs), tz);
  const nowMin = nowP.hour * 60 + nowP.minute;

  return html`<div class="pl-week-scroll" ref=${scrollRef} style=${{ '--hour-px': `${HOUR_PX}px` }}>
    <div class="pl-week">
      <div class="pl-week-head">
        <div class="pl-week-corner" aria-hidden="true"></div>
        ${days.map((day) => {
          const wd = WEEKDAY_SHORT[weekdayOfKey(day)];
          return html`<div key=${day} class=${cx('pl-week-dayhead', day === today && 'is-today', day < today && 'is-past')}>
            <span class="pl-week-wd">${wd}</span>
            <span class=${cx('pl-week-dn', day === today && 'today-mark')}>${Number(day.slice(8))}</span>
            ${day >= today ? html`<${IconButton} icon="plus" size="sm" class="pl-week-add" label=${`New post on ${formatDay(zonedToUtc(day, '12:00', tz), tz)}`} onClick=${() => onComposeDay(day)} />` : null}
          </div>`;
        })}
      </div>
      <div class="pl-week-body" style=${{ height: `${hours.length * HOUR_PX}px` }}>
        <div class="pl-week-gutter" aria-hidden="true">
          ${hours.map((h) => html`<span key=${h} class="pl-week-hour" style=${{ top: `${(h - WEEK_START_HOUR) * HOUR_PX}px` }}>${clock(h * 60, tz, days[0]).replace(':00', '')}</span>`)}
        </div>
        ${days.map((day) => {
          const wd = weekdayOfKey(day);
          const row = (matrix && matrix[wd]) || [];
          const past = day < today;
          return html`<div key=${day} class=${cx('pl-week-col', past && 'is-past', day === today && 'is-today')} data-day=${day}
            onClick=${(e) => {
              if (e.target.closest('.pl-week-event')) return;
              onCompose(day, minutesAt(e, e.currentTarget, 0, Math.floor));
            }}
            onDragOver=${(e) => {
              const d = currentDrag();
              if (!d || past) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const minutes = minutesAt(e, e.currentTarget, d.offsetY || 0);
              if (!ghost || ghost.day !== day || ghost.minutes !== minutes) setGhost({ day, minutes });
            }}
            onDragLeave=${(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) setGhost((g) => (g && g.day === day ? null : g));
            }}
            onDrop=${(e) => {
              e.preventDefault();
              const d = currentDrag();
              const minutes = d ? minutesAt(e, e.currentTarget, d.offsetY || 0) : null;
              endDrag();
              setGhost(null);
              if (d && !past) onDropPost(d.id, day, minutes);
            }}>
            ${hours.map((h) => {
              const s = Math.min(1, Math.max(0, ((row[h] || 0) - 0.5) / 0.5));
              return s > 0.05
                ? html`<div key=${h} class="pl-best" style=${{ top: `${(h - WEEK_START_HOUR) * HOUR_PX}px`, '--s': s.toFixed(2) }} title="Good time to post"></div>`
                : null;
            })}
            ${day === today && nowMin >= WEEK_START_HOUR * 60
              ? html`<div class="pl-week-now" style=${{ top: `${((nowMin - WEEK_START_HOUR * 60) / 60) * HOUR_PX}px` }} aria-hidden="true"></div>`
              : null}
            ${ghost && ghost.day === day
              ? html`<div class="pl-week-ghost" style=${{ top: `${((ghost.minutes - WEEK_START_HOUR * 60) / 60) * HOUR_PX}px` }} aria-hidden="true">${clock(ghost.minutes, tz, day)}</div>`
              : null}
            ${(byDay.get(day) || []).map((ev) => html`<${WeekEvent} key=${ev.key} ev=${ev} tz=${tz} onOpen=${onOpen} />`)}
          </div>`;
        })}
      </div>
    </div>
  </div>`;
}

function WeekEvent({ ev, tz, onOpen }) {
  const type = ev.post ? ev.post.type : igType(ev.media);
  const title = ev.post ? postTitle(ev.post) : (ev.media.caption || '').split('\n')[0] || 'Published on Instagram';
  const time = shortTime(ev.at, tz);
  const style = {
    top: `${ev.top}px`,
    left: `calc(${ev.lane} * (100% - 4px) / ${ev.lanes} + 2px)`,
    width: `calc((100% - 4px) / ${ev.lanes} - 2px)`,
  };
  const inner = html`
    <${PostThumb} asset=${ev.asset} src=${ev.src} size=${28} />
    <span class="pl-week-event-text">
      <span class="pl-week-event-time"><${Icon} name=${TYPE_ICON[type]} size=${11} />${time}</span>
      <span class="pl-week-event-title">${title}</span>
    </span>`;
  if (ev.kind === 'ig') {
    return html`<a class="pl-week-event cal-event is-published is-ig" style=${style} href=${ev.media.permalink || undefined} target="_blank" rel="noopener noreferrer"
      title=${`Published on Instagram: ${time} · ${title}`}>${inner}</a>`;
  }
  return html`<div role="button" tabindex="0" class=${cx('pl-week-event cal-event', toneClass(ev.post), ev.movable && 'is-movable')} style=${style}
    data-post-id=${ev.post.id} draggable=${!!ev.movable}
    aria-label=${`${time} · ${TYPE_LABEL[type]} · ${title}, ${ev.post.status === 'reminded' ? 'post by hand' : statusKey(ev.post).replace('-', ' ')}`}
    title=${`${time} · ${TYPE_LABEL[type]} · ${title}${ev.movable ? ' (drag to move)' : ev.post.status === 'reminded' ? ' (post it by hand)' : ''}`}
    onDragStart=${ev.movable ? (e) => startDrag(e, ev.post.id, { offsetY: e.clientY - e.currentTarget.getBoundingClientRect().top }) : (e) => e.preventDefault()}
    onDragEnd=${endDrag}
    onClick=${() => onOpen(ev)} onKeyDown=${activate(() => onOpen(ev))}>${inner}</div>`;
}

// ---------------------------------------------------------------------------
// Day view

const DAY_FIRST_HOUR = 6;

/**
 * DayView {day, today, nowMs, tz, items, matrix, onCompose(day, minutes), onOpen(item), onDropPost(id, day, minutes)}
 * One row per hour (from 06:00, or earlier when something is planned before that), each post in the
 * row of its hour in time order. Posts are buttons (Enter or Space opens them), every future hour has
 * an "add" button, and a post can be dragged to another hour (it keeps its minutes).
 */
export function DayView({ day, today, nowMs, tz, items, matrix, onCompose, onOpen, onDropPost }) {
  const [dropHour, setDropHour] = useState(null);
  const list = useMemo(() => items.filter((it) => it.day === day).sort((a, b) => a.minutes - b.minutes || (a.kind === 'ig') - (b.kind === 'ig')), [items, day]);
  const first = Math.min(DAY_FIRST_HOUR, ...list.map((it) => Math.floor(it.minutes / 60)));
  const hours = Array.from({ length: 24 - first }, (_, i) => first + i);
  const row = (matrix && matrix[weekdayOfKey(day)]) || [];
  const nowP = zonedParts(new Date(nowMs), tz);
  const nowHour = day === today ? nowP.hour : null;
  const past = (h) => day < today || (day === today && h < nowP.hour);
  const dateLabel = formatDay(zonedToUtc(day, '12:00', tz), tz);
  return html`<ol class="pl-dayview" aria-label=${`${dateLabel} by hour`}>
    ${hours.map((h) => {
      const inHour = list.filter((it) => Math.floor(it.minutes / 60) === h);
      const good = Math.min(1, Math.max(0, ((row[h] || 0) - 0.5) / 0.5));
      const label = clock(h * 60, tz, day);
      const canAdd = !past(h) || h === nowHour;
      return html`<li key=${h} data-hour=${h}
        class=${cx('pl-hour', past(h) && h !== nowHour && 'is-past', h === nowHour && 'is-now', good > 0.05 && 'is-good', dropHour === h && 'is-drop')}
        style=${good > 0.05 ? { '--s': good.toFixed(2) } : null}
        onDragOver=${(e) => {
          if (!currentDrag() || (past(h) && h !== nowHour)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dropHour !== h) setDropHour(h);
        }}
        onDragLeave=${(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setDropHour((x) => (x === h ? null : x));
        }}
        onDrop=${(e) => {
          e.preventDefault();
          const d = currentDrag();
          endDrag();
          setDropHour(null);
          if (d && !(past(h) && h !== nowHour)) onDropPost(d.id, day, h * 60 + (d.minute || 0));
        }}>
        <span class="pl-hour-label">
          <span class="mono">${label}</span>
          ${h === nowHour ? html`<span class="pl-hour-now">Now</span>` : good > 0.5 ? html`<span class="pl-hour-good" title="A good time to post">Good time</span>` : null}
        </span>
        <div class="pl-hour-items">
          ${inHour.map((it) => html`<${DayEvent} key=${it.key} item=${it} tz=${tz} onOpen=${onOpen} />`)}
        </div>
        ${canAdd
          ? html`<${IconButton} icon="plus" size="sm" class="pl-hour-add" label=${`New post on ${dateLabel} at ${label}`}
              onClick=${() => onCompose(day, h === nowHour ? Math.min(23 * 60 + 45, Math.ceil((nowP.hour * 60 + nowP.minute + 20) / 15) * 15) : h * 60)} />`
          : html`<span class="pl-hour-add-pad" aria-hidden="true"></span>`}
      </li>`;
    })}
  </ol>`;
}

function DayEvent({ item, tz, onOpen }) {
  const type = item.post ? item.post.type : igType(item.media);
  const title = item.post ? postTitle(item.post) : (item.media.caption || '').split('\n')[0] || 'Published on Instagram';
  const time = shortTime(item.at, tz);
  const inner = html`
    <${PostThumb} asset=${item.asset} src=${item.src} size=${40} />
    <span class="pl-dayevent-text">
      <span class="pl-dayevent-meta">
        <span class="mono">${time}</span>
        <span class="pl-meta-item"><${Icon} name=${TYPE_ICON[type]} size=${12} />${TYPE_LABEL[type]}</span>
        ${item.listColor ? html`<span class="pl-list-dot" style=${{ background: item.listColor }} aria-hidden="true"></span>` : null}
      </span>
      <span class="pl-dayevent-title">${title}</span>
    </span>`;
  if (item.kind === 'ig') {
    return html`<a class="pl-dayevent cal-event is-published is-ig" href=${item.media.permalink || undefined} target="_blank" rel="noopener noreferrer"
      aria-label=${`Published on Instagram at ${time}: ${title}`}>${inner}<span class="pl-dayevent-side"><${StatusPill} status="published" /></span></a>`;
  }
  const p = item.post;
  const reminded = p.status === 'reminded';
  const minute = zonedParts(new Date(item.at), tz).minute;
  return html`<div role="button" tabindex="0" class=${cx('pl-dayevent cal-event', toneClass(p), item.movable && 'is-movable')} data-post-id=${p.id}
    draggable=${!!item.movable}
    aria-label=${`${time} · ${TYPE_LABEL[type]} · ${title}, ${reminded ? 'post by hand' : statusKey(p).replace('-', ' ')}`}
    title=${reminded ? 'Open "Post by hand"' : item.movable ? 'Open, or drag to another hour' : undefined}
    onDragStart=${item.movable ? (e) => startDrag(e, p.id, { minute }) : (e) => e.preventDefault()} onDragEnd=${endDrag}
    onClick=${() => onOpen(item)} onKeyDown=${activate(() => onOpen(item))}>
    ${inner}
    <span class="pl-dayevent-side"><${PostStatus} post=${p} /></span>
  </div>`;
}

/** Monday-start days of the week that contains `day`. */
export function weekDays(day) {
  const wd = (weekdayOfKey(day) + 6) % 7;
  const start = addDaysKey(day, -wd);
  return Array.from({ length: 7 }, (_, i) => addDaysKey(start, i));
}

/** Monday-start cells (5 or 6 weeks) covering the month that contains `day`. */
export function monthDays(day) {
  const first = `${day.slice(0, 7)}-01`;
  const start = weekDays(first)[0];
  const nextMonth = addDaysKey(first, 32).slice(0, 7);
  const last = addDaysKey(`${nextMonth}-01`, -1);
  const end = weekDays(last)[6];
  const out = [];
  for (let k = start; k <= end; k = addDaysKey(k, 1)) out.push(k);
  return out;
}

/** "October 2026" for a day key. */
export function monthTitle(day, tz) {
  return format(zonedToUtc(day, '12:00', tz), tz, { month: 'long', year: 'numeric' });
}
