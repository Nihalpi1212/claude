// Queues: evergreen lists with recurring time slots. The worker turns each upcoming slot into a
// scheduled post, cycling through the list's items.
//
// Items come from the library, from a CSV file (library file names or links), from Claude ("Generate
// with AI") or from RSS / Atom feeds that the worker checks hourly (lists[].feeds, worker/jobs/feeds.mjs).
// Files from links are downloaded by the worker; until then their thumbnails show a placeholder.

import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { DOWNLOADS_PER_RUN, FEED_TEMPLATE, IMPORT_REFUSED, MAX_DOWNLOAD_TRIES, downloadRetryAt, feedBacklogCap, fitsFeed, isHttpUrl } from '../../core/feed.js';
import { engagementRate, topMedia } from '../../core/analytics.js';
import { LIMITS, hasErrors, newList, uid, validatePost } from '../../core/model.js';
import { expandListSlots } from '../../core/schedule.js';
import { formatDateTime, relative } from '../../core/time.js';
import { aiPrefs, getAi } from '../ai-client.js';
import { useApp } from '../app.js';
import { loadViewCss } from '../css.js';
import { queueTemplateCsv, readQueueImport } from '../csv-import.js';
import { mutate, readDoc, transact, useDocs } from '../data.js';
import { importState, saveBlob, thumbBase64 } from '../media.js';
import { PostThumb, TYPE_ICON, TYPE_LABEL, shortTime } from '../ui/calendar.js';
import { Icon } from '../ui/icons.js';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  EmptyState,
  Field,
  IconButton,
  Menu,
  Modal,
  PageHeader,
  ProgressBar,
  Segmented,
  Select,
  Skeleton,
  TextArea,
  TextInput,
  Toggle,
  cx,
} from '../ui/kit.js';
import { MediaPicker } from '../ui/media-picker.js';

loadViewCss('queues');

const DAY_MS = 864e5;
const WEEKDAYS = [
  { value: 1, label: 'Monday', short: 'Mon' },
  { value: 2, label: 'Tuesday', short: 'Tue' },
  { value: 3, label: 'Wednesday', short: 'Wed' },
  { value: 4, label: 'Thursday', short: 'Thu' },
  { value: 5, label: 'Friday', short: 'Fri' },
  { value: 6, label: 'Saturday', short: 'Sat' },
  { value: 0, label: 'Sunday', short: 'Sun' },
];
const SHORT = Object.fromEntries(WEEKDAYS.map((w) => [w.value, w.short]));
const COLORS = [
  { value: '#1D66A6', label: 'Blue' },
  { value: '#E8662B', label: 'Orange' },
  { value: '#189E6E', label: 'Green' },
  { value: '#6250D6', label: 'Violet' },
  { value: '#D9628F', label: 'Pink' },
  { value: '#B8860B', label: 'Ochre' },
  { value: '#8b5cf6', label: 'Lilac' },
  { value: '#484F56', label: 'Graphite' },
];

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
const SOURCE_TAG = { rss: 'From feed', csv: 'From CSV', ai: 'Written with AI' };

/** "studionorth.example/journal" for showing a link compactly. */
function shortUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.hostname.replace(/^www\./, '')}${path.length > 28 ? `${path.slice(0, 27)}…` : path}`;
  } catch {
    return String(url || '');
  }
}
const slotSort = (a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7) || String(a.time).localeCompare(String(b.time));

function to12h(time) {
  const [h, m] = String(time).split(':').map(Number);
  const d = new Date(Date.UTC(2026, 0, 5, h, m));
  return shortTime(d.toISOString(), 'UTC');
}

/** "Tue 12:00p · Thu 6:00p" */
export function slotSummary(slots = []) {
  const valid = slots.filter((s) => validTime(s.time));
  if (!valid.length) return 'No time slots';
  return [...valid].sort(slotSort).map((s) => `${SHORT[s.weekday]} ${to12h(s.time)}`).join(' · ');
}

function itemType(media, assetsById) {
  if ((media || []).length > 1) return 'carousel';
  const a = media && media[0] && assetsById[media[0].assetId];
  return a && a.kind === 'video' ? 'reel' : 'feed';
}

/** A photo Instagram refuses in the feed (outside 4:5 to 1.91:1). Queues only post to the feed. */
const wrongShape = (a) => !!a && !a.importUrl && a.kind === 'image' && !fitsFeed(a.width, a.height);

/**
 * Why the worker skips an item (worker/jobs/evergreen.mjs): 'failed' (its file could not be
 * downloaded from its link), 'shape' (a photo of the wrong shape for the feed), else null.
 */
function skipReason(it, assetsById) {
  const assets = (it.media || []).map((m) => assetsById[m.assetId]);
  if (assets.some((a) => importState(a) === 'failed')) return 'failed';
  if (assets.some(wrongShape)) return 'shape';
  return null;
}

/** "Last try failed: … Trying again after 3:40p (try 2 of 5)." for a file still waiting for a download. */
function retryNote(a, tz, nowMs) {
  if (!a || !a.importLastError) return '';
  const at = downloadRetryAt(a);
  const when = at && at > nowMs ? `after ${shortTime(new Date(at).toISOString(), tz)}` : 'on the next worker run';
  return `Last try failed: ${a.importLastError} Trying again ${when} (try ${(a.importAttempts || 0) + 1} of ${MAX_DOWNLOAD_TRIES}).`;
}

/** Items the worker can still use (repeat off: never used and not waiting in a post), without the ones it skips. */
function usableItems(list, posts, assetsById = null) {
  const broken = (it) => !!assetsById && !!skipReason(it, assetsById);
  if (list.repeat !== false) return (list.items || []).filter((it) => !broken(it));
  const busy = new Set(posts.filter((p) => p.listId === list.id && p.status !== 'canceled' && p.listItemId).map((p) => p.listItemId));
  return (list.items || []).filter((it) => !busy.has(it.id) && !(it.timesUsed > 0) && !broken(it));
}

/** When the worker will next create a post for this list. */
function nextFill(list, posts, tz, nowMs, assetsById) {
  if (list.enabled === false) return { text: 'Paused' };
  if (!(list.items || []).length) return { text: 'Add items to start' };
  if (!(list.slots || []).filter((s) => validTime(s.time)).length) return { text: 'Add a time slot to start' };
  const items = usableItems(list, posts, assetsById);
  if (!items.length) return { text: 'Every item has been used', tone: 'warn' };
  const horizon = Number(list.horizonDays) > 0 ? Number(list.horizonDays) : 14;
  const { slots } = expandListSlots({ ...list, items, nextIndex: 0, enabled: true }, { tz, now: nowMs, horizonDays: horizon + 21, existingPosts: posts });
  const first = slots[0];
  if (!first) return { text: 'No upcoming slots' };
  const fillAt = Date.parse(first.scheduledAt) - horizon * DAY_MS;
  const when = formatDateTime(first.scheduledAt, tz);
  if (fillAt <= nowMs) return { text: 'Next worker run', detail: `creates the post for ${when}` };
  return { text: relative(new Date(fillAt), new Date(nowMs)), detail: `creates the post for ${when}` };
}

async function quietly(promise) {
  try {
    return await promise;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------

export default function Queues() {
  const { tz, toast, confirm, dispatchWorker, settings, navigate } = useApp();
  const { data, loading, error } = useDocs(['lists', 'posts', 'library']);
  const [editing, setEditing] = useState(null); // { draft, isNew, originalItemIds }
  const [feedEdit, setFeedEdit] = useState(null); // { listId, feed|null }
  const [csvFor, setCsvFor] = useState(null); // list id
  const [aiFor, setAiFor] = useState(null); // list id
  const [checking, setChecking] = useState(null); // feed id being checked by the worker
  const ai = getAi(settings);
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const lists = (data.lists && data.lists.lists) || [];
  const posts = (data.posts && data.posts.posts) || [];
  const assets = (data.library && data.library.assets) || [];
  const assetsById = useMemo(() => Object.fromEntries(assets.map((a) => [a.id, a])), [data.library]);

  const openNew = () => {
    const used = new Set(lists.map((l) => l.color));
    const color = (COLORS.find((c) => !used.has(c.value)) || COLORS[0]).value;
    setEditing({ draft: newList({ name: '', color, slots: [{ weekday: 2, time: '12:00' }], items: [] }), isNew: true, originalItemIds: new Set() });
  };
  const openEdit = (list) => setEditing({ draft: structuredClone(list), isNew: false, originalItemIds: new Set((list.items || []).map((it) => it.id)) });

  const save = async ({ draft, isNew, originalItemIds }) => {
    const fields = {
      name: draft.name.trim(),
      color: draft.color,
      enabled: draft.enabled !== false,
      order: draft.order === 'shuffle' ? 'shuffle' : 'sequential',
      repeat: draft.repeat !== false,
      slots: draft.slots.filter((s) => validTime(s.time)).map((s) => ({ weekday: Number(s.weekday), time: s.time })).sort(slotSort),
      horizonDays: Math.min(60, Math.max(1, Math.round(Number(draft.horizonDays) || 14))),
    };
    const ok = await quietly(
      mutate(
        'lists',
        (doc) => {
          const idx = doc.lists.findIndex((l) => l.id === draft.id);
          const cur = idx >= 0 ? doc.lists[idx] : null;
          const live = new Map(((cur && cur.items) || []).map((it) => [it.id, it]));
          const items = [];
          const draftIds = new Set(draft.items.map((it) => it.id));
          for (const it of draft.items) {
            const was = live.get(it.id);
            // Used up by the worker while the editor was open (repeat off): keep it removed.
            if (!was && originalItemIds.has(it.id)) continue;
            const mediaChanged = was && JSON.stringify(was.media) !== JSON.stringify(it.media);
            const next = {
              ...(was || {}),
              id: it.id,
              type: it.type,
              caption: it.caption || '',
              firstComment: it.firstComment || '',
              media: structuredClone(it.media || []),
              timesUsed: was ? was.timesUsed || 0 : 0,
              lastUsedAt: was ? was.lastUsedAt || null : null,
            };
            if (mediaChanged) delete next.mediaMissing;
            items.push(next);
          }
          // Items added while the editor was open (a feed check, a CSV import in another tab) stay.
          for (const it of (cur && cur.items) || []) if (!originalItemIds.has(it.id) && !draftIds.has(it.id)) items.push(it);
          if (!cur) {
            doc.lists.push({ ...structuredClone(draft), ...fields, items, nextIndex: 0, createdAt: draft.createdAt || new Date().toISOString() });
            return;
          }
          const next = { ...cur, ...fields, items };
          if (next.order === 'sequential') next.nextIndex = items.length ? (Number(cur.nextIndex) || 0) % items.length : 0;
          doc.lists[idx] = next;
        },
        { message: isNew ? 'create queue' : 'update queue' },
      ),
    );
    if (!ok) return false;
    setEditing(null);
    const runs = fields.enabled && draft.items.length && fields.slots.length;
    toast(isNew ? `Queue "${fields.name}" created.${runs ? ' Posts appear after the next worker run.' : ''}` : `Queue "${fields.name}" saved.`, {
      kind: 'success',
      action: runs ? { label: 'Fill now', onClick: () => dispatchWorker('fill queues').catch(() => {}) } : undefined,
    });
    return true;
  };

  const setEnabled = async (list, enabled) => {
    const ok = await quietly(
      mutate(
        'lists',
        (doc) => {
          const l = doc.lists.find((x) => x.id === list.id);
          if (l) l.enabled = enabled;
        },
        { message: enabled ? 'resume queue' : 'pause queue' },
      ),
    );
    if (!ok) return;
    const waiting = posts.filter((p) => p.listId === list.id && p.status === 'scheduled' && Date.parse(p.scheduledAt) > Date.now()).length;
    toast(
      enabled
        ? `"${list.name}" is on. New posts appear after the next worker run.`
        : `"${list.name}" is paused.${waiting ? ` ${plural(waiting, 'post')} already scheduled from it will still publish; delete them in the Planner if you want.` : ''}`,
      { kind: 'success' },
    );
  };

  const duplicate = async (list) => {
    const copy = {
      ...structuredClone(list),
      id: uid('l_'),
      name: `Copy of ${list.name}`,
      enabled: false,
      nextIndex: 0,
      createdAt: new Date().toISOString(),
      items: (list.items || []).map((it) => ({ ...structuredClone(it), id: uid('li_'), timesUsed: 0, lastUsedAt: null })),
      feeds: (list.feeds || []).map((f) => ({ ...structuredClone(f), id: uid('fd_') })),
    };
    const ok = await quietly(
      mutate(
        'lists',
        (doc) => {
          if (!doc.lists.some((l) => l.id === copy.id)) doc.lists.push(copy);
        },
        { message: 'duplicate queue' },
      ),
    );
    if (ok) toast(`Created "${copy.name}". It is paused until you turn it on.`, { kind: 'success' });
  };

  // ---- feeds -------------------------------------------------------------------

  const saveFeed = async (listId, { id, url, template }) => {
    const clean = { url: new URL(url.trim()).href, template: template.trim() && template.trim() !== FEED_TEMPLATE ? template.trim() : '' };
    let dup = false;
    const ok = await quietly(
      mutate(
        'lists',
        (doc) => {
          dup = false;
          const l = doc.lists.find((x) => x.id === listId);
          if (!l) return;
          l.feeds = Array.isArray(l.feeds) ? l.feeds : [];
          if (l.feeds.some((f) => f.url === clean.url && f.id !== id)) {
            dup = true;
            return;
          }
          const f = id && l.feeds.find((x) => x.id === id);
          if (f) {
            if (f.url !== clean.url) Object.assign(f, { url: clean.url, title: '', checkedAt: null, error: null, seen: [], etag: null, lastModified: null });
            f.template = clean.template;
          } else {
            l.feeds.push({ id: uid('fd_'), url: clean.url, title: '', template: clean.template, disabled: false, addedAt: new Date().toISOString(), checkedAt: null, error: null, seen: [], added: 0 });
          }
        },
        { message: id ? 'update queue feed' : 'add queue feed' },
      ),
    );
    if (!ok) return false;
    if (dup) {
      toast('This queue already has that feed.', { kind: 'error' });
      return false;
    }
    setFeedEdit(null);
    if (!id) {
      const list = lists.find((l) => l.id === listId);
      toast(
        `Feed added. The worker checks it within the hour${list && list.enabled === false ? ' once the queue is on' : ''} and adds the newest 3 posts as items.`,
        { kind: 'success', action: list && list.enabled !== false ? { label: 'Check now', onClick: () => checkFeeds(listId, null) } : undefined },
      );
    } else toast('Feed saved.', { kind: 'success' });
    return true;
  };

  const setFeedDisabled = async (listId, feedId, disabled) => {
    await quietly(
      mutate(
        'lists',
        (doc) => {
          const f = (doc.lists.find((x) => x.id === listId)?.feeds || []).find((x) => x.id === feedId);
          if (f) f.disabled = disabled;
        },
        { message: disabled ? 'pause queue feed' : 'resume queue feed' },
      ),
    );
  };

  const removeFeed = async (listId, feed) => {
    const yes = await confirm({
      title: 'Remove this feed?',
      body: 'The worker stops checking it. Items it already added stay in the queue.',
      confirmLabel: 'Remove feed',
      danger: true,
    });
    if (!yes) return;
    const ok = await quietly(
      mutate(
        'lists',
        (doc) => {
          const l = doc.lists.find((x) => x.id === listId);
          if (l) l.feeds = (l.feeds || []).filter((f) => f.id !== feed.id);
        },
        { message: 'remove queue feed' },
      ),
    );
    if (ok) toast('Feed removed.', { kind: 'success' });
  };

  /** Mark feeds as due and run the worker now; reports what the check found. feedId null = every feed of the list. */
  const checkFeeds = async (listId, feedId) => {
    const before = await quietly(readDoc('lists'));
    const pick = (doc) => ((doc && doc.lists.find((x) => x.id === listId)?.feeds) || []).filter((f) => !feedId || f.id === feedId);
    const addedBefore = pick(before).reduce((n, f) => n + (f.added || 0), 0);
    const ok = await quietly(
      mutate(
        'lists',
        (doc) => {
          for (const f of pick(doc)) f.checkedAt = null;
        },
        { message: 'check queue feeds now' },
      ),
    );
    if (!ok) return;
    setChecking(feedId || listId);
    try {
      const run = await dispatchWorker('check feeds', { quiet: true, wait: true });
      const after = await quietly(readDoc('lists'));
      const feeds = pick(after);
      const added = feeds.reduce((n, f) => n + (f.added || 0), 0) - addedBefore;
      const failed = feeds.filter((f) => f.error);
      // The run may have skipped the feeds job (worker paused, out of time): then nothing was checked.
      const skipped = run && run.skipped && run.skipped.feeds;
      if (!run) toast('The worker is still running. New items appear here when it finishes.', { kind: 'info' });
      else if (skipped === 'paused') {
        toast(`The worker is paused in Settings, so ${feedId ? 'the feed was' : 'the feeds were'} not checked.`, {
          kind: 'info',
          action: { label: 'Open Settings', onClick: () => navigate('#/settings?section=worker') },
        });
      } else if (skipped) toast(`The worker did not get to ${feedId ? 'the feed' : 'the feeds'} this time. It checks ${feedId ? 'it' : 'them'} on its next run (about every 10 minutes).`, { kind: 'info' });
      else if (failed.length) toast(`Could not read ${failed.length === 1 ? 'the feed' : `${failed.length} feeds`}: ${failed[0].error}`, { kind: 'error' });
      else if (added) toast(`Added ${plural(added, 'item')} from the feed.`, { kind: 'success' });
      else if (feeds.some((f) => f.full)) toast('Checked. The queue already has enough unused items from this feed, so new posts are skipped for now.', { kind: 'info' });
      else toast('Checked. No new posts with an image the worker can post.', { kind: 'info' });
    } catch {
      /* dispatchWorker showed the error */
    } finally {
      setChecking(null);
    }
  };

  /** Append items (and their new link assets) to a list in one commit. */
  const addItems = async (listId, items, newAssets = [], what = 'items') => {
    const ok = await quietly(
      transact(
        async (tx) => {
          const doc = await tx.read('lists');
          const l = doc.lists.find((x) => x.id === listId);
          if (!l) return false;
          const have = new Set((l.items || []).map((it) => it.id));
          l.items = [...(l.items || []), ...items.filter((it) => !have.has(it.id)).map((it) => structuredClone(it))];
          tx.write('lists', doc);
          if (newAssets.length) {
            const lib = await tx.read('library');
            const known = new Set(lib.assets.map((a) => a.id));
            for (const a of newAssets) if (!known.has(a.id)) lib.assets.unshift(structuredClone(a));
            tx.write('library', lib);
          }
          return true;
        },
        { message: `queue: add ${what}` },
      ),
    );
    return !!ok;
  };

  const remove = async (list) => {
    const upcoming = posts.filter((p) => p.listId === list.id && (p.status === 'scheduled' || p.status === 'draft')).length;
    const yes = await confirm({
      title: `Delete "${list.name}"?`,
      body: upcoming
        ? `This deletes the queue and its ${plural(upcoming, 'upcoming post')}. Posts already on Instagram stay there.`
        : 'This deletes the queue and its items. Posts already on Instagram stay there.',
      confirmLabel: 'Delete queue',
      danger: true,
    });
    if (!yes) return;
    let removed = 0;
    const ok = await quietly(
      transact(
        async (tx) => {
          removed = 0;
          const listsDoc = await tx.read('lists');
          const postsDoc = await tx.read('posts');
          listsDoc.lists = listsDoc.lists.filter((l) => l.id !== list.id);
          postsDoc.posts = postsDoc.posts.filter((p) => {
            if (p.listId !== list.id || (p.status !== 'scheduled' && p.status !== 'draft' && p.status !== 'canceled')) return true;
            if (p.status !== 'canceled') removed++;
            return false;
          });
          tx.write('lists', listsDoc);
          tx.write('posts', postsDoc);
          return true;
        },
        { message: 'delete queue' },
      ),
    );
    if (ok) toast(`Deleted "${list.name}"${removed ? ` and ${plural(removed, 'upcoming post')}` : ''}.`, { kind: 'success' });
  };

  let body;
  if (error && !data.lists) {
    body = html`<${Callout} tone="danger" title="Could not load your queues">${error.message || String(error)}. Check your connection, then reload the page.<//>`;
  } else if (loading && !data.lists) {
    body = html`<div class="grid-auto qu-grid">${[0, 1].map((i) => html`<${Skeleton} key=${i} height=${260} />`)}</div>`;
  } else if (!lists.length) {
    body = html`<div class="panel"><${EmptyState} icon="repeat" title="No queues yet"
      body="A queue keeps evergreen posts going: pick a few photos with captions and the days and times to post them. The worker recycles them for you."
      action=${html`<${Button} variant="primary" icon="plus" onClick=${openNew}>Create a queue<//>`} /></div>`;
  } else {
    body = html`<div class="grid-auto qu-grid">
      ${lists.map((l) => html`<${QueueCard} key=${l.id} list=${l} posts=${posts} assetsById=${assetsById} tz=${tz} nowMs=${nowMs} ai=${!!ai} checking=${checking}
        onEdit=${() => openEdit(l)} onToggle=${(on) => setEnabled(l, on)} onDuplicate=${() => duplicate(l)} onDelete=${() => remove(l)}
        onImportCsv=${() => setCsvFor(l.id)} onGenerate=${() => setAiFor(l.id)}
        onAddFeed=${() => setFeedEdit({ listId: l.id, feed: null })} onEditFeed=${(f) => setFeedEdit({ listId: l.id, feed: f })}
        onFeedDisabled=${(f, off) => setFeedDisabled(l.id, f.id, off)} onRemoveFeed=${(f) => removeFeed(l.id, f)} onCheckFeed=${(f) => checkFeeds(l.id, f.id)} />`)}
    </div>`;
  }
  const listFor = (id) => lists.find((l) => l.id === id);

  return html`<div class="page queues">
    <${PageHeader} title="Queues"
      subtitle="Evergreen content on repeat. The worker creates a post for each upcoming time slot, cycling through the queue's items."
      actions=${html`<${Button} variant="primary" icon="plus" onClick=${openNew}>New queue<//>`} />
    ${body}
    ${editing
      ? html`<${QueueEditor} key=${editing.draft.id} editing=${editing} posts=${posts} assetsById=${assetsById} tz=${tz} nowMs=${nowMs}
          onClose=${() => setEditing(null)} onSave=${save} />`
      : null}
    ${feedEdit && listFor(feedEdit.listId)
      ? html`<${FeedModal} list=${listFor(feedEdit.listId)} feed=${feedEdit.feed} onClose=${() => setFeedEdit(null)} onSave=${(v) => saveFeed(feedEdit.listId, v)} />`
      : null}
    ${csvFor && listFor(csvFor)
      ? html`<${QueueCsvModal} list=${listFor(csvFor)} assets=${assets} onClose=${() => setCsvFor(null)}
          onAdd=${async (items, newAssets) => {
            const ok = await addItems(csvFor, items, newAssets, 'items from CSV');
            if (!ok) return false;
            const n = newAssets.length;
            const downloads = !n
              ? ''
              : n > DOWNLOADS_PER_RUN
                ? ` The worker starts downloading ${plural(n, 'linked file')} on its next run (up to ${DOWNLOADS_PER_RUN} a run, about every 10 minutes).`
                : ` The worker downloads ${plural(n, 'linked file')} on its next run.`;
            toast(`Added ${plural(items.length, 'item')} to "${listFor(csvFor).name}".${downloads}`, { kind: 'success' });
            setCsvFor(null);
            return true;
          }} />`
      : null}
    ${aiFor && listFor(aiFor) && ai
      ? html`<${AiItemsModal} ai=${ai} settings=${settings} list=${listFor(aiFor)} onClose=${() => setAiFor(null)}
          onAdd=${async (items) => {
            const ok = await addItems(aiFor, items, [], 'items written with AI');
            if (!ok) return false;
            toast(`Added ${plural(items.length, 'item')} to "${listFor(aiFor).name}".`, { kind: 'success' });
            setAiFor(null);
            return true;
          }} />`
      : null}
  </div>`;
}

// ---------------------------------------------------------------------------

function QueueCard({ list, posts, assetsById, tz, nowMs, ai, checking, onEdit, onToggle, onDuplicate, onDelete, onImportCsv, onGenerate, onAddFeed, onEditFeed, onFeedDisabled, onRemoveFeed, onCheckFeed }) {
  const items = list.items || [];
  const fill = nextFill(list, posts, tz, nowMs, assetsById);
  const upcoming = posts
    .filter((p) => p.listId === list.id && p.status === 'scheduled' && Date.parse(p.scheduledAt) >= nowMs)
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  const missing = items.filter((it) => it.mediaMissing || (it.media || []).some((m) => !assetsById[m.assetId])).length;
  const failed = items.filter((it) => skipReason(it, assetsById) === 'failed');
  const shapes = items.filter((it) => skipReason(it, assetsById) === 'shape').length;
  const pending = items.flatMap((it) => (it.media || []).map((m) => assetsById[m.assetId])).filter((a) => importState(a) === 'pending');
  const downloading = items.filter((it) => (it.media || []).some((m) => importState(assetsById[m.assetId]) === 'pending')).length;
  // The most recent temporary failure among the files still waiting.
  const lastTry = pending.filter((a) => a.importLastError).sort((a, b) => String(b.importTriedAt).localeCompare(String(a.importTriedAt)))[0];
  const failedNote = (() => {
    const n = failed.length;
    if (!n) return '';
    const one = n === 1;
    const codes = failed.flatMap((it) => (it.media || []).map((m) => assetsById[m.assetId]).filter((a) => importState(a) === 'failed').map((a) => a.importErrorCode || ''));
    const skipped = `${plural(n, 'item')} ${one ? 'is' : 'are'} skipped`;
    if (codes.every((c) => c === 'not_jpeg')) {
      return `${skipped}: ${one ? 'its image is not a JPEG' : 'their images are not JPEGs'}. Download ${one ? 'it' : 'them'}, upload ${one ? 'it' : 'them'} in the Library (which converts to JPEG), then swap ${one ? 'it' : 'them'} in.`;
    }
    if (codes.every((c) => IMPORT_REFUSED.has(c))) return `${skipped}: Instagram cannot take ${one ? 'its file' : 'their files'} as ${one ? 'it is' : 'they are'}. Edit the queue to see why.`;
    return `${skipped}: ${one ? 'its file' : 'their files'} could not be downloaded. Edit the queue to see why, then try again in the Library or change the media.`;
  })();
  const addMenu = [
    { label: 'Add from library', icon: 'image', onClick: onEdit },
    { label: 'Import CSV', icon: 'upload', onClick: onImportCsv },
    ai ? { label: 'Generate with AI', icon: 'sparkle', onClick: onGenerate } : null,
    { label: 'Add RSS feed', icon: 'link', onClick: onAddFeed },
  ];
  const thumbs = items.slice(0, 6);
  const paused = list.enabled === false;
  return html`<article class=${cx('panel qu-card', paused && 'is-paused')} style=${{ '--qu-color': list.color || 'var(--accent)' }} aria-labelledby=${`qu-${list.id}`} data-list-id=${list.id}>
    <header class="qu-card-head">
      <span class="qu-swatch" aria-hidden="true"></span>
      <h2 class="qu-name" id=${`qu-${list.id}`}>${list.name || 'Untitled queue'}</h2>
      <${Toggle} checked=${!paused} onChange=${onToggle} aria-label=${`${list.name}: ${paused ? 'paused' : 'on'}`} />
      <${Menu} label=${`Actions for ${list.name}`} size="sm" items=${[
        { label: 'Edit', icon: 'edit', onClick: onEdit },
        { label: 'Import CSV into this queue', icon: 'upload', onClick: onImportCsv },
        ai ? { label: 'Generate with AI', icon: 'sparkle', onClick: onGenerate } : null,
        { label: 'Add RSS feed', icon: 'link', onClick: onAddFeed },
        { label: 'Duplicate', icon: 'copy', onClick: onDuplicate },
        '-',
        { label: 'Delete', icon: 'trash', danger: true, onClick: onDelete },
      ]} />
    </header>
    <button type="button" class="qu-strip" onClick=${onEdit} aria-label=${`Edit ${list.name}: ${plural(items.length, 'item')}`}>
      ${thumbs.length
        ? thumbs.map((it) => {
            const m = (it.media || [])[0];
            return html`<span class="qu-strip-item" key=${it.id}><${PostThumb} asset=${m && assetsById[m.assetId]} size=${52} /></span>`;
          })
        : html`<span class="qu-strip-empty muted text-sm"><${Icon} name="plus" size=${14} />Add items</span>`}
      ${items.length > thumbs.length ? html`<span class="qu-strip-more mono">+${items.length - thumbs.length}</span>` : null}
    </button>
    <dl class="kv qu-facts">
      <dt>Slots</dt>
      <dd class="mono qu-slots">${slotSummary(list.slots)}</dd>
      <dt>Items</dt>
      <dd>${plural(items.length, 'item')} · ${list.order === 'shuffle' ? 'shuffled' : 'in order'} · ${list.repeat === false ? 'each used once' : 'repeats'}</dd>
      <dt>Next post</dt>
      <dd>${upcoming.length ? html`${formatDateTime(upcoming[0].scheduledAt, tz)}${upcoming.length > 1 ? html` <span class="muted">+${upcoming.length - 1} more</span>` : null}` : html`<span class="muted">None scheduled</span>`}</dd>
      <dt>Next fill</dt>
      <dd>${fill.text}${fill.detail ? html` <span class="muted">${fill.detail}</span>` : null}</dd>
    </dl>
    ${missing ? html`<${Callout} tone="warning">${plural(missing, 'item')} ${missing === 1 ? 'uses' : 'use'} media that is no longer in the library and ${missing === 1 ? 'is' : 'are'} skipped.<//>` : null}
    ${failedNote ? html`<${Callout} tone="warning">${failedNote}<//>` : null}
    ${shapes
      ? html`<${Callout} tone="warning">${plural(shapes, 'item')} ${shapes === 1 ? 'is' : 'are'} skipped: ${shapes === 1 ? 'its photo is' : 'their photos are'} not a shape the feed allows (4:5 to 1.91:1). Edit the queue to pick other media.<//>`
      : null}
    ${downloading
      ? html`<p class="qu-downloading muted text-sm"><${Icon} name="download" size=${14} /><span>${plural(downloading, 'item')} waiting for the worker to download ${downloading === 1 ? 'its file' : 'their files'}.${lastTry ? ` ${retryNote(lastTry, tz, nowMs)}` : ''}</span></p>`
      : null}
    <${FeedsSection} list=${list} tz=${tz} nowMs=${nowMs} checking=${checking} onAdd=${onAddFeed} onEdit=${onEditFeed}
      onDisabled=${onFeedDisabled} onRemove=${onRemoveFeed} onCheck=${onCheckFeed} />
    <footer class="qu-card-foot">
      ${paused ? html`<${Badge} tone="neutral">Paused<//>` : html`<${Badge} tone="success" icon="repeat">Fills ${list.horizonDays || 14} days ahead<//>`}
      <span class="qu-card-actions">
        <${Menu} trigger="Add items" label=${`Add items to ${list.name}`} size="sm" items=${addMenu} />
        <${Button} size="sm" icon="edit" onClick=${onEdit}>Edit queue<//>
      </span>
    </footer>
  </article>`;
}

// ---------------------------------------------------------------------------
// Feeds

function FeedsSection({ list, tz, nowMs, checking, onAdd, onEdit, onDisabled, onRemove, onCheck }) {
  const feeds = Array.isArray(list.feeds) ? list.feeds : [];
  const paused = list.enabled === false;
  return html`<section class="qu-feeds" aria-label=${`Feeds of ${list.name}`}>
    <div class="qu-feeds-head">
      <span class="label-caps">Feeds</span>
      <span class="spacer"></span>
      <${Button} size="sm" variant="ghost" icon="plus" onClick=${onAdd}>Add feed<//>
    </div>
    ${feeds.length
      ? html`<ul class="qu-feed-list">
          ${feeds.map((f) => {
            const name = f.title || shortUrl(f.url);
            const busy = checking === f.id || checking === list.id;
            const checked = f.checkedAt ? `Checked ${relative(new Date(Math.min(Date.parse(f.checkedAt), nowMs)), new Date(nowMs))}` : 'Not checked yet';
            return html`<li key=${f.id} class=${cx('qu-feed', f.disabled && 'is-off', f.error && 'has-error')} data-feed-id=${f.id}>
              <span class="qu-feed-icon" aria-hidden="true"><${Icon} name="link" size=${14} /></span>
              <div class="qu-feed-main">
                <span class="qu-feed-title" title=${f.url}>${name}</span>
                <span class="qu-feed-meta">
                  ${busy ? 'Checking…' : f.disabled ? 'Off' : paused ? 'Queue paused' : checked} · ${plural(f.added || 0, 'item')} added
                </span>
                ${f.error && !f.disabled ? html`<span class="qu-feed-error"><${Icon} name="alert" size=${13} /><span>${f.error}</span></span>` : null}
                ${f.full && !f.error && !f.disabled
                  ? html`<span class="qu-feed-full"><${Icon} name="info" size=${13} /><span>The queue has enough unused items from this feed. New posts are skipped until it has used some.</span></span>`
                  : null}
              </div>
              <${Toggle} checked=${!f.disabled} onChange=${(on) => onDisabled(f, !on)} aria-label=${`${name}: ${f.disabled ? 'off' : 'on'}`} />
              <${Menu} label=${`Actions for the feed ${name}`} size="sm" items=${[
                { label: 'Check now', icon: 'refresh', disabled: busy || f.disabled || paused, onClick: () => onCheck(f) },
                { label: 'Edit feed', icon: 'edit', onClick: () => onEdit(f) },
                { label: 'Open feed', icon: 'external', onClick: () => window.open(f.url, '_blank', 'noopener,noreferrer') },
                '-',
                { label: 'Remove', icon: 'trash', danger: true, onClick: () => onRemove(f) },
              ]} />
            </li>`;
          })}
        </ul>`
      : html`<p class="qu-feeds-empty muted text-sm">Add an RSS or Atom feed (a blog, a shop, a news page) and its new posts become items here.</p>`}
  </section>`;
}

function FeedModal({ list, feed, onClose, onSave }) {
  const [url, setUrl] = useState(feed ? feed.url : '');
  const [template, setTemplate] = useState(feed && feed.template ? feed.template : FEED_TEMPLATE);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const urlError = !url.trim() ? 'Paste the feed address.' : !isHttpUrl(url.trim()) ? 'Use a web address that starts with http:// or https://.' : undefined;
  const submit = async () => {
    setTried(true);
    if (urlError) return;
    setSaving(true);
    const ok = await onSave({ id: feed ? feed.id : null, url, template });
    if (!ok) setSaving(false);
  };
  const footer = html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//>
    <${Button} variant="primary" loading=${saving} onClick=${submit}>${feed ? 'Save feed' : 'Add feed'}<//>`;
  return html`<${Modal} open title=${feed ? 'Edit feed' : `Add a feed to "${list.name}"`} onClose=${onClose} footer=${footer} class="qu-feed-modal">
    <div class="stack">
      <p class="muted">The worker checks the feed every hour. Each new post with a JPEG picture becomes an item in this queue: the first check adds the newest 3, later checks up to 5 at a time, while the queue has fewer than ${feedBacklogCap(list)} unused items from the feed.</p>
      <${Field} label="Feed address" error=${tried ? urlError : undefined} hint="The RSS or Atom link of a blog or site, for example https://example.com/feed/">
        <${TextInput} type="url" value=${url} onChange=${setUrl} placeholder="https://" data-autofocus inputmode="url" autocomplete="off"
          onKeyDown=${(e) => e.key === 'Enter' && (e.preventDefault(), submit())} />
      <//>
      <${Field} label="Caption" hint="{title}, {summary} and {link} are filled in from the post. Links are not clickable in Instagram captions; write “Link in bio” if you send people there.">
        <${TextArea} value=${template} onChange=${setTemplate} rows=${3} maxRows=${8} class="mono" />
      <//>
      ${feed && url.trim() !== feed.url ? html`<${Callout} tone="info">A new address is checked from scratch: the newest 3 posts are added again.<//>` : null}
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------
// CSV into a queue

function QueueCsvModal({ list, assets, onClose, onAdd }) {
  const [result, setResult] = useState(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const readFile = async (file) => {
    if (!file) return;
    setFileName(file.name);
    if (file.size > 2 * 1024 * 1024) {
      setResult({ error: 'This file is larger than 2 MB. Split it into smaller files.', rows: [] });
      return;
    }
    setResult(readQueueImport(await file.text(), { assets }));
  };
  const rows = (result && result.rows) || [];
  const ready = rows.filter((r) => r.item);
  const problems = rows.length - ready.length;
  const downloads = [...new Map(ready.flatMap((r) => r.newAssets).map((a) => [a.id, a])).values()];
  const add = async () => {
    setBusy(true);
    const ok = await onAdd(ready.map((r) => r.item), downloads);
    if (!ok) setBusy(false);
  };
  const footer = result && !result.error
    ? html`<${Button} variant="ghost" onClick=${() => setResult(null)}>Choose another file<//>
        <span class="spacer"></span>
        <${Button} variant="ghost" onClick=${onClose}>Cancel<//>
        <${Button} variant="primary" loading=${busy} disabled=${!ready.length} onClick=${add}>${ready.length ? `Add ${plural(ready.length, 'item')}` : 'Nothing to add'}<//>`
    : html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//>`;
  return html`<${Modal} open wide title=${`Import CSV into "${list.name}"`} onClose=${onClose} footer=${footer} class="qu-csv">
    ${!result || result.error
      ? html`<div class="stack">
          <p class="muted">Each row becomes an item in this queue. The queue's time slots decide when items post, so date and time columns are ignored.</p>
          <label class=${cx('qu-dropzone', dragOver && 'is-over')}
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
            <input type="file" accept=".csv,text/csv,text/plain" class="sr-only" aria-label="CSV file"
              onChange=${(e) => {
                const f = e.currentTarget.files[0];
                e.currentTarget.value = '';
                readFile(f);
              }} />
            <${Icon} name="upload" size=${22} />
            <span><strong>Choose a CSV file</strong> or drop it here</span>
            <span class="muted text-sm">Columns: caption, first_comment, media, type</span>
          </label>
          ${result && result.error ? html`<${Callout} tone="danger" title=${`Could not read ${fileName || 'the file'}`}>${result.error}<//>` : null}
          <dl class="kv qu-csv-kv">
            <dt class="mono">media</dt><dd>Library file names, or direct links (https://…) to JPEG photos or MP4 videos, separated by |. The worker downloads links.</dd>
            <dt class="mono">caption</dt><dd>Post text</dd>
            <dt class="mono">first_comment</dt><dd>Optional</dd>
            <dt class="mono">type</dt><dd>post, carousel or reel (blank: worked out from the media)</dd>
          </dl>
          <div><${Button} size="sm" variant="ghost" icon="download"
            onClick=${() => saveBlob(new Blob([queueTemplateCsv(assets)], { type: 'text/csv;charset=utf-8' }), 'postpilot-queue-template.csv')}>Download template<//></div>
        </div>`
      : html`<div class="stack">
          <div class="qu-csv-summary">
            <span class="mono text-sm truncate">${fileName}</span>
            <span><strong class="num">${ready.length}</strong> ready</span>
            ${problems ? html`<span class="text-bad"><strong class="num">${problems}</strong> with problems (skipped)</span>` : null}
            ${result.ignored.length ? html`<span class="muted text-sm">Ignored columns: ${result.ignored.join(', ')}</span>` : null}
          </div>
          ${downloads.length
            ? html`<p class="qu-downloading text-sm"><${Icon} name="download" size=${14} /><span>${plural(downloads.length, 'file')} will be downloaded by the worker from ${downloads.length === 1 ? 'its link' : 'their links'} after the import.</span></p>`
            : null}
          ${result.truncated ? html`<${Callout} tone="warning">Only the first 500 rows are used. Split the file to import the rest.<//>` : null}
          ${!rows.length ? html`<${EmptyState} compact icon="file" title="The file has no rows under the header" />` : null}
          <ol class="qu-csv-rows">
            ${rows.map(
              (r) => html`<li key=${r.line} class=${cx('qu-csv-row', r.item ? 'is-ok' : 'has-error')}>
                <span class="qu-csv-line mono">Row ${r.line}</span>
                <div class="qu-csv-main">
                  <div class="qu-csv-head">
                    <span class="qu-csv-thumbs">${r.assets.slice(0, 4).map((a) => html`<${PostThumb} key=${a.id} asset=${a} size=${36} />`)}</span>
                    ${r.item ? html`<span class="pl-meta-item text-sm"><${Icon} name=${TYPE_ICON[r.item.type]} size=${13} />${TYPE_LABEL[r.item.type]}</span>` : null}
                  </div>
                  <p class="clamp-2 text-sm">${r.data.caption ? r.data.caption : html`<span class="muted">No caption</span>`}</p>
                  ${r.errors.map((e) => html`<p class="qu-csv-msg text-bad"><${Icon} name="alert" size=${13} /><span>${e}</span></p>`)}
                  ${r.warnings.map((w) => html`<p class="qu-csv-msg text-warn"><${Icon} name="info" size=${13} /><span>${w}</span></p>`)}
                  ${r.notes.map((n) => html`<p class="qu-csv-msg muted"><${Icon} name="download" size=${13} /><span>${n}</span></p>`)}
                </div>
              </li>`,
            )}
          </ol>
        </div>`}
  <//>`;
}

// ---------------------------------------------------------------------------
// Generate items with AI

function AiItemsModal({ ai, settings, list, onClose, onAdd }) {
  const [picked, setPicked] = useState([]); // assets
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [progress, setProgress] = useState(null); // {done, total}
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState(null); // [{asset, idea, caption, firstComment, altText, keep}]
  const [saving, setSaving] = useState(false);
  const abort = useRef(null);
  useEffect(() => () => abort.current?.abort(), []);

  const generate = async () => {
    setError('');
    abort.current = new AbortController();
    const signal = abort.current.signal;
    const prefs = aiPrefs(settings);
    setProgress({ done: 0, total: picked.length });
    // One idea per file gives each caption its own angle; when ideas fail, captions still work.
    let ideas = [];
    try {
      const media = await readDoc('analytics-media').catch(() => null);
      const followers = settings && settings.ig ? settings.ig.followersCount ?? undefined : undefined;
      const topPosts = topMedia(Object.values((media && media.media) || {}).filter((m) => m && m.productType !== 'STORY'), 'er', 8, { followers }).map((m) => ({ caption: m.caption || '', productType: m.productType, er: engagementRate(m, followers) }));
      ideas = await ai.ideas({ topPosts, voice: prefs.voice, language: prefs.language, count: picked.length, notes: [`Posts for the recurring queue "${list.name}".`, notes].filter(Boolean).join('\n'), signal });
    } catch (err) {
      if (signal.aborted) return;
      ideas = [];
    }
    const out = [];
    for (let i = 0; i < picked.length; i++) {
      const a = picked[i];
      const idea = ideas[i] || null;
      try {
        const b64 = await thumbBase64(a).catch(() => null);
        const options = await ai.captions({
          images: b64 ? [{ base64: b64, mediaType: 'image/jpeg' }] : [],
          postType: a.kind === 'video' ? 'reel' : 'feed',
          notes: [idea ? `Angle: ${idea.title}. ${idea.hook}` : '', a.captionHint || '', notes].filter(Boolean).join('\n'),
          voice: prefs.voice,
          language: prefs.language,
          emoji: prefs.emoji,
          count: 1,
          includeHashtags: true,
          signal,
        });
        const best = options[0];
        if (best) {
          const caption = [best.caption, (best.hashtags || []).join(' ')].filter(Boolean).join('\n\n').slice(0, LIMITS.captionChars);
          out.push({ asset: a, idea, caption, firstComment: best.firstComment || '', altText: best.altText || '', keep: true });
        }
      } catch (err) {
        if (signal.aborted) return;
        setError(err.userMessage || err.message || String(err));
        break;
      }
      setProgress({ done: i + 1, total: picked.length });
    }
    setProgress(null);
    if (out.length) setDrafts(out);
  };

  const kept = (drafts || []).filter((d) => d.keep && d.caption.trim());
  const add = async () => {
    setSaving(true);
    const items = kept.map((d) => ({
      id: uid('li_'),
      type: d.asset.kind === 'video' ? 'reel' : 'feed',
      caption: d.caption.trim(),
      firstComment: d.firstComment || '',
      media: [{ assetId: d.asset.id, kind: d.asset.kind, altText: d.asset.kind === 'image' ? d.altText || '' : '' }],
      timesUsed: 0,
      lastUsedAt: null,
      source: 'ai',
    }));
    const ok = await onAdd(items);
    if (!ok) setSaving(false);
  };
  const setDraft = (i, patch) => setDrafts((list) => list.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const running = !!progress;

  const footer = drafts
    ? html`<${Button} variant="ghost" onClick=${() => setDrafts(null)} disabled=${saving}>Start over<//>
        <span class="spacer"></span>
        <${Button} variant="ghost" onClick=${onClose}>Cancel<//>
        <${Button} variant="primary" loading=${saving} disabled=${!kept.length} onClick=${add}>${kept.length ? `Add ${plural(kept.length, 'item')}` : 'Keep at least one'}<//>`
    : html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//>
        <${Button} variant="primary" icon="sparkle" loading=${running} disabled=${!picked.length} onClick=${generate}>
          ${running ? `Writing ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…` : picked.length ? `Write ${plural(picked.length, 'caption')}` : 'Choose media first'}
        <//>`;

  return html`<${Modal} open wide title=${`Generate items for "${list.name}"`} onClose=${onClose} footer=${footer} closeOnBackdrop=${false} class="qu-ai">
    ${drafts
      ? html`<div class="stack">
          <p class="muted">Edit the captions, untick any you do not want, then add them to the queue.</p>
          <ol class="qu-ai-list">
            ${drafts.map(
              (d, i) => html`<li key=${d.asset.id} class=${cx('qu-ai-item', !d.keep && 'is-off')}>
                <div class="qu-ai-side">
                  <${PostThumb} asset=${d.asset} size=${72} />
                  <${Checkbox} checked=${d.keep} onChange=${(v) => setDraft(i, { keep: v })} label="Keep" />
                </div>
                <div class="qu-ai-body">
                  ${d.idea ? html`<p class="text-sm"><span class="label-caps">Angle</span> ${d.idea.title}</p>` : null}
                  <${Field} label="Caption">
                    <${TextArea} value=${d.caption} onChange=${(v) => setDraft(i, { caption: v })} rows=${3} maxRows=${10} />
                  <//>
                  <${Field} label="First comment">
                    <${TextInput} value=${d.firstComment} onChange=${(v) => setDraft(i, { firstComment: v })} placeholder="Optional" />
                  <//>
                </div>
              </li>`,
            )}
          </ol>
          ${error ? html`<${Callout} tone="warning" title="Some captions could not be written">${error}<//>` : null}
        </div>`
      : html`<div class="stack">
          <p class="muted">Pick the photos and videos for the new items. Claude suggests an angle for each from what worked on your account, then writes a caption that fits the picture, in your brand voice.</p>
          <div class="qu-ai-picked">
            ${picked.map((a) => html`<${PostThumb} key=${a.id} asset=${a} size=${56} />`)}
            <${Button} size="sm" icon=${picked.length ? 'edit' : 'plus'} onClick=${() => setPickerOpen(true)} disabled=${running}>${picked.length ? `Change media (${picked.length})` : 'Choose media'}<//>
          </div>
          <${Field} label="What should the captions focus on?" hint="Optional. For example a theme, a product or a call to action.">
            <${TextArea} value=${notes} onChange=${setNotes} rows=${2} maxLength=${1000} placeholder="Behind-the-scenes tips for beginners." disabled=${running} />
          <//>
          ${running ? html`<${ProgressBar} value=${progress.done} max=${progress.total} label="Writing captions" />` : null}
          ${error ? html`<${Callout} tone="danger" title="Could not write the captions">${error}<//>` : null}
        </div>`}
    <${MediaPicker} open=${pickerOpen} onClose=${() => setPickerOpen(false)} max=${10} title="Media for the new items" confirmLabel="Use this media"
      initialSelected=${picked.map((a) => a.id)} blockPending
      onPick=${(assets) => {
        setPicked(assets.filter((a) => !importState(a)));
        setPickerOpen(false);
      }} />
  <//>`;
}

// ---------------------------------------------------------------------------
// Editor

function QueueEditor({ editing, posts, assetsById, tz, nowMs, onClose, onSave }) {
  const { confirm } = useApp();
  const { isNew, originalItemIds } = editing;
  const [initial] = useState(() => ({ ...editing.draft, items: (editing.draft.items || []).map((it) => ({ firstComment: '', caption: '', ...it })) }));
  const [draft, setDraft] = useState(initial);
  const [picker, setPicker] = useState(null); // { mode: 'add' } | { mode: 'replace', id }
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);
  const [dragIndex, setDragIndex] = useState(null);

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setSlot = (i, patch) => setDraft((d) => ({ ...d, slots: d.slots.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const setItem = (id, patch) => setDraft((d) => ({ ...d, items: d.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) }));
  const moveItem = (from, to) =>
    setDraft((d) => {
      if (to < 0 || to >= d.items.length || from === to) return d;
      const items = [...d.items];
      const [it] = items.splice(from, 1);
      items.splice(to, 0, it);
      return { ...d, items };
    });

  const addSlot = () =>
    setDraft((d) => {
      const used = new Set(d.slots.map((s) => Number(s.weekday)));
      const next = WEEKDAYS.find((w) => !used.has(w.value)) || WEEKDAYS[0];
      const time = (d.slots[d.slots.length - 1] || {}).time || '12:00';
      return { ...d, slots: [...d.slots, { weekday: next.value, time }] };
    });

  const nameError = tried && !draft.name.trim() ? 'Give the queue a name.' : undefined;
  const badSlots = draft.slots.some((s) => !validTime(s.time));
  const dupSlots = new Set(draft.slots.map((s) => `${s.weekday}|${s.time}`)).size !== draft.slots.length;
  const horizon = Number(draft.horizonDays);
  const horizonError = !Number.isFinite(horizon) || horizon < 1 || horizon > 60 ? 'Use 1 to 60 days.' : undefined;
  const itemIssues = useMemo(
    () =>
      Object.fromEntries(
        draft.items.map((it) => {
          const missing = (it.media || []).some((m) => !assetsById[m.assetId]);
          const issues = missing
            ? [{ level: 'error', message: 'Some media is no longer in the library. Choose new media.' }]
            : validatePost({ type: it.type, media: it.media, caption: it.caption, firstComment: it.firstComment, status: 'draft' }, assetsById);
          for (const m of it.media || []) {
            const note = retryNote(importState(assetsById[m.assetId]) === 'pending' ? assetsById[m.assetId] : null, tz, nowMs);
            if (note) issues.push({ level: 'warning', message: `"${assetsById[m.assetId].name || 'A file'}": ${note}` });
          }
          return [it.id, issues];
        }),
      ),
    [draft.items, assetsById, nowMs],
  );
  const blocking = !draft.name.trim() || badSlots || !!horizonError;

  const preview = useMemo(() => {
    const items = usableItems(draft, posts, assetsById);
    if (!items.length || !draft.slots.some((s) => validTime(s.time))) return { slots: [], items };
    const start = draft.repeat === false ? 0 : Number(draft.nextIndex) || 0;
    const { slots } = expandListSlots(
      { ...draft, enabled: true, items, nextIndex: start, slots: draft.slots.filter((s) => validTime(s.time)).map((s) => ({ ...s, weekday: Number(s.weekday) })) },
      { tz, now: nowMs, horizonDays: Math.max(1, Math.min(60, horizon || 14)), existingPosts: posts },
    );
    return { slots: draft.repeat === false ? slots.slice(0, items.length) : slots, items };
  }, [draft, posts, tz, nowMs]);
  const already = posts.filter((p) => p.listId === draft.id && p.status === 'scheduled' && Date.parse(p.scheduledAt) >= nowMs).length;

  const submit = async () => {
    setTried(true);
    if (blocking) return;
    setSaving(true);
    const ok = await onSave({ draft, isNew, originalItemIds });
    if (!ok) setSaving(false);
  };

  const onPick = (picked) => {
    if (!picker) return;
    if (picker.mode === 'add') {
      const items = picked.map((a) => ({
        id: uid('li_'),
        type: a.kind === 'video' ? 'reel' : 'feed',
        caption: a.captionHint || '',
        firstComment: '',
        media: [{ assetId: a.id, kind: a.kind, altText: '' }],
        timesUsed: 0,
        lastUsedAt: null,
      }));
      setDraft((d) => ({ ...d, items: [...d.items, ...items] }));
    } else {
      const media = picked.map((a) => ({ assetId: a.id, kind: a.kind, altText: '' }));
      setItem(picker.id, { media, type: itemType(media, Object.fromEntries(picked.map((a) => [a.id, a]))) });
    }
    setPicker(null);
  };
  const pickerItem = picker && picker.mode === 'replace' ? draft.items.find((it) => it.id === picker.id) : null;

  const requestClose = async () => {
    if (saving) return;
    if (JSON.stringify(draft) !== JSON.stringify(initial)) {
      const discard = await confirm({
        title: 'Discard your changes?',
        body: isNew ? 'This queue has not been created yet.' : 'Your changes to this queue will be lost.',
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!discard) return;
    }
    onClose();
  };

  const footer = html`<${Button} variant="ghost" onClick=${requestClose}>Cancel<//>
    <${Button} variant="primary" loading=${saving} onClick=${submit} disabled=${tried && blocking}>${isNew ? 'Create queue' : 'Save queue'}<//>`;

  return html`<${Modal} open wide title=${isNew ? 'New queue' : `Edit "${editing.draft.name}"`} onClose=${requestClose} footer=${footer} closeOnBackdrop=${false} class="qu-modal">
    <p class="qu-explain muted">The worker creates a post for each upcoming slot, cycling through the items below.</p>
    <div class="qu-editor">
      <div class="qu-settings stack">
        <${Field} label="Name" error=${nameError} required>
          <${TextInput} value=${draft.name} onChange=${(v) => set({ name: v })} placeholder="Throwback Thursday" maxlength="60" data-autofocus />
        <//>
        <div class="field">
          <span class="field-label" id="qu-color-label">Color</span>
          <div class="qu-colors" role="radiogroup" aria-labelledby="qu-color-label">
            ${COLORS.map(
              (c) => html`<button key=${c.value} type="button" role="radio" class="qu-color" aria-checked=${draft.color === c.value ? 'true' : 'false'}
                aria-label=${c.label} title=${c.label} style=${{ '--c': c.value }} onClick=${() => set({ color: c.value })}></button>`,
            )}
          </div>
        </div>
        <${Field} label="Order" hint=${draft.order === 'shuffle' ? 'A new random order each round, never the same item twice in a row.' : 'Items go out from top to bottom, then start over.'}>
          <${Segmented} options=${[{ value: 'sequential', label: 'In order' }, { value: 'shuffle', label: 'Shuffle' }]} value=${draft.order} onChange=${(v) => set({ order: v })} label="Order" />
        <//>
        <${Toggle} checked=${draft.repeat !== false} onChange=${(v) => set({ repeat: v })} label="Repeat items"
          hint=${draft.repeat !== false ? 'Items go back into the rotation after they publish.' : 'Off: each item is posted once, then removed from the queue.'} />
        <${Field} label="Fill ahead" hint="How far ahead the worker schedules posts from this queue." error=${horizonError}>
          <${TextInput} type="number" value=${draft.horizonDays} onChange=${(v) => set({ horizonDays: v })} min="1" max="60" suffix="days" class="qu-horizon" />
        <//>
        <div class="field">
          <div class="field-label-row">
            <span class="field-label">Time slots</span>
            <span class="muted text-sm">${tz}</span>
          </div>
          <ul class="qu-slots-edit">
            ${draft.slots.map(
              (s, i) => html`<li key=${i} class="qu-slot">
                <${Select} options=${WEEKDAYS} value=${Number(s.weekday)} onChange=${(v) => setSlot(i, { weekday: v })} aria-label=${`Slot ${i + 1} day`} class="qu-slot-day" />
                <input type="time" class=${cx('input qu-slot-time', tried && !validTime(s.time) && 'is-invalid')} value=${s.time} step="300" aria-label=${`Slot ${i + 1} time`}
                  aria-invalid=${tried && !validTime(s.time) ? 'true' : undefined}
                  onInput=${(e) => setSlot(i, { time: e.currentTarget.value })} />
                <${IconButton} icon="x" size="sm" label=${`Remove slot ${i + 1}`} onClick=${() => setDraft((d) => ({ ...d, slots: d.slots.filter((_, j) => j !== i) }))} />
              </li>`,
            )}
          </ul>
          ${!draft.slots.length ? html`<p class="field-hint">Add at least one slot, or the queue never posts.</p>` : null}
          ${dupSlots ? html`<p class="field-hint text-warn">Two slots are the same; only one post is created for them.</p>` : null}
          <${Button} size="sm" icon="plus" onClick=${addSlot} class="qu-add-slot">Add time slot<//>
          <p class="field-hint">${draft.slots.length ? `${plural(draft.slots.length, 'post')} a week.` : ''} Changing slots does not move posts already scheduled.</p>
        </div>
      </div>

      <div class="qu-items-col stack">
        <div class="row row-between">
          <h3 class="section-title">Items <span class="qu-count num">${draft.items.length}</span></h3>
          <${Button} size="sm" icon="plus" onClick=${() => setPicker({ mode: 'add' })}>Add from library<//>
        </div>
        ${draft.items.length
          ? html`<ol class="qu-items">
              ${draft.items.map((it, i) => {
                const issues = itemIssues[it.id] || [];
                return html`<li key=${it.id} class=${cx('qu-item', dragIndex === i && 'is-dragging')} data-item-id=${it.id}
                  onDragOver=${(e) => {
                    if (dragIndex == null || dragIndex === i) return;
                    e.preventDefault();
                    moveItem(dragIndex, i);
                    setDragIndex(i);
                  }}
                  onDrop=${(e) => {
                    e.preventDefault();
                    setDragIndex(null);
                  }}>
                  <div class="qu-item-side">
                    <span class="qu-handle" draggable="true" title="Drag to reorder" aria-hidden="true"
                      onDragStart=${(e) => {
                        setDragIndex(i);
                        try {
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', it.id);
                        } catch {
                          /* ignore */
                        }
                      }}
                      onDragEnd=${() => setDragIndex(null)}><${Icon} name="drag" size=${16} /></span>
                    <span class="qu-item-no mono">${String(i + 1).padStart(2, '0')}</span>
                    <${IconButton} icon="chevron-up" size="sm" label=${`Move item ${i + 1} up`} disabled=${i === 0} onClick=${() => moveItem(i, i - 1)} />
                    <${IconButton} icon="chevron-down" size="sm" label=${`Move item ${i + 1} down`} disabled=${i === draft.items.length - 1} onClick=${() => moveItem(i, i + 1)} />
                  </div>
                  <div class="qu-item-body">
                    <div class="qu-item-media">
                      <button type="button" class="qu-item-thumbs" onClick=${() => setPicker({ mode: 'replace', id: it.id })} aria-label=${`Change media for item ${i + 1}`}>
                        ${(it.media || []).slice(0, 3).map((m) => html`<${PostThumb} key=${m.assetId} asset=${assetsById[m.assetId]} size=${56} />`)}
                        ${(it.media || []).length > 3 ? html`<span class="qu-strip-more mono">+${it.media.length - 3}</span>` : null}
                      </button>
                      <div class="qu-item-meta">
                        <span class="qu-item-tags">
                          <span class="pl-meta-item"><${Icon} name=${TYPE_ICON[it.type] || 'image'} size=${13} />${TYPE_LABEL[it.type] || 'Post'}${(it.media || []).length > 1 ? ` · ${it.media.length}` : ''}</span>
                          ${SOURCE_TAG[it.source] ? html`<${Badge} tone=${it.source === 'rss' ? 'info' : 'outline'} class="qu-source">${SOURCE_TAG[it.source]}<//>` : null}
                        </span>
                        ${it.source === 'rss' && it.link
                          ? html`<a class="qu-item-link text-sm" href=${it.link} target="_blank" rel="noopener noreferrer" title=${it.link}>
                              <${Icon} name="external" size=${12} /><span>${shortUrl(it.link)}</span>
                            </a>`
                          : null}
                        <span class="muted text-sm">${it.timesUsed ? `Used ${plural(it.timesUsed, 'time')}${it.lastUsedAt ? `, last ${formatDateTime(it.lastUsedAt, tz)}` : ''}` : 'Not used yet'}</span>
                        <${Button} size="sm" variant="ghost" icon="image" onClick=${() => setPicker({ mode: 'replace', id: it.id })}>Change media<//>
                      </div>
                      <${IconButton} icon="trash" size="sm" label=${`Remove item ${i + 1}`} class="qu-item-remove"
                        onClick=${() => setDraft((d) => ({ ...d, items: d.items.filter((x) => x.id !== it.id) }))} />
                    </div>
                    <${Field} label="Caption">
                      <${TextArea} value=${it.caption} onChange=${(v) => setItem(it.id, { caption: v })} rows=${2} maxRows=${8} placeholder="Write the caption for this item" />
                    <//>
                    <${Field} label="First comment">
                      <${TextInput} value=${it.firstComment} onChange=${(v) => setItem(it.id, { firstComment: v })} placeholder="Optional" />
                    <//>
                    ${issues.length
                      ? html`<ul class="qu-issues">${issues.map((x, k) => html`<li key=${k} class=${x.level === 'error' ? 'text-bad' : 'text-warn'}><${Icon} name=${x.level === 'error' ? 'alert' : 'info'} size=${13} /><span>${x.message}</span></li>`)}</ul>`
                      : null}
                  </div>
                </li>`;
              })}
            </ol>`
          : html`<${EmptyState} compact icon="image" title="No items yet" body="Add photos or videos from your library. Each one becomes an item with its own caption."
              action=${html`<${Button} size="sm" icon="plus" onClick=${() => setPicker({ mode: 'add' })}>Add from library<//>`} />`}

        <section class="qu-preview" aria-label="Coming up">
          <h3 class="label-caps">Coming up</h3>
          ${preview.slots.length
            ? html`<ol class="qu-preview-list">
                ${preview.slots.slice(0, 6).map((s) => {
                  const it = preview.items[s.itemIndex];
                  return html`<li key=${s.scheduledAt}>
                    <span class="mono text-sm qu-preview-when">${formatDateTime(s.scheduledAt, tz)}</span>
                    <span class="truncate text-sm">${it ? (it.caption || '').split('\n')[0] || `${TYPE_LABEL[it.type] || 'Post'} without caption` : ''}</span>
                  </li>`;
                })}
              </ol>`
            : html`<p class="muted text-sm">${!draft.items.length ? 'Add items and time slots to see the next posts.' : !draft.slots.length ? 'Add a time slot to see the next posts.' : preview.items.length ? 'Every slot in the next days already has a post.' : 'Every item has been used. Add items or turn on Repeat items.'}</p>`}
          ${already ? html`<p class="muted text-sm">${plural(already, 'post')} from this queue ${already === 1 ? 'is' : 'are'} already scheduled.</p>` : null}
          ${draft.items.some((it) => hasErrors(itemIssues[it.id] || [])) ? html`<p class="text-sm text-bad">Items with problems fail when they publish. Fix them first.</p>` : null}
        </section>
      </div>
    </div>
    ${picker
      ? html`<${MediaPicker} open multiple max=${picker.mode === 'add' ? 20 : 10} onClose=${() => setPicker(null)} onPick=${onPick}
          title=${picker.mode === 'add' ? 'Add items from the library' : 'Choose media for this item'}
          confirmLabel=${picker.mode === 'replace' ? 'Use this media' : undefined}
          initialSelected=${pickerItem ? (pickerItem.media || []).map((m) => m.assetId).filter((id) => assetsById[id]) : []} />`
      : null}
  <//>`;
}

