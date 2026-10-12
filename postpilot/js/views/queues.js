// Queues: evergreen lists with recurring time slots. The worker turns each upcoming slot into a
// scheduled post, cycling through the list's items.

import { html, useEffect, useMemo, useState } from '../../vendor/preact.js';
import { hasErrors, newList, uid, validatePost } from '../../core/model.js';
import { expandListSlots } from '../../core/schedule.js';
import { formatDateTime, relative } from '../../core/time.js';
import { useApp } from '../app.js';
import { loadViewCss } from '../css.js';
import { mutate, transact, useDocs } from '../data.js';
import { PostThumb, TYPE_ICON, TYPE_LABEL, shortTime } from '../ui/calendar.js';
import { Icon } from '../ui/icons.js';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Field,
  IconButton,
  Menu,
  Modal,
  PageHeader,
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

/** Items the worker can still use (repeat off: never used and not waiting in a post). */
function usableItems(list, posts) {
  if (list.repeat !== false) return list.items || [];
  const busy = new Set(posts.filter((p) => p.listId === list.id && p.status !== 'canceled' && p.listItemId).map((p) => p.listItemId));
  return (list.items || []).filter((it) => !busy.has(it.id) && !(it.timesUsed > 0));
}

/** When the worker will next create a post for this list. */
function nextFill(list, posts, tz, nowMs) {
  if (list.enabled === false) return { text: 'Paused' };
  if (!(list.items || []).length) return { text: 'Add items to start' };
  if (!(list.slots || []).filter((s) => validTime(s.time)).length) return { text: 'Add a time slot to start' };
  const items = usableItems(list, posts);
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
  const { tz, toast, confirm, dispatchWorker } = useApp();
  const { data, loading, error } = useDocs(['lists', 'posts', 'library']);
  const [editing, setEditing] = useState(null); // { draft, isNew, originalItemIds }
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
      ${lists.map((l) => html`<${QueueCard} key=${l.id} list=${l} posts=${posts} assetsById=${assetsById} tz=${tz} nowMs=${nowMs}
        onEdit=${() => openEdit(l)} onToggle=${(on) => setEnabled(l, on)} onDuplicate=${() => duplicate(l)} onDelete=${() => remove(l)} />`)}
    </div>`;
  }

  return html`<div class="page queues">
    <${PageHeader} title="Queues"
      subtitle="Evergreen content on repeat. The worker creates a post for each upcoming time slot, cycling through the queue's items."
      actions=${html`<${Button} variant="primary" icon="plus" onClick=${openNew}>New queue<//>`} />
    ${body}
    ${editing
      ? html`<${QueueEditor} key=${editing.draft.id} editing=${editing} posts=${posts} assetsById=${assetsById} tz=${tz} nowMs=${nowMs}
          onClose=${() => setEditing(null)} onSave=${save} />`
      : null}
  </div>`;
}

// ---------------------------------------------------------------------------

function QueueCard({ list, posts, assetsById, tz, nowMs, onEdit, onToggle, onDuplicate, onDelete }) {
  const items = list.items || [];
  const fill = nextFill(list, posts, tz, nowMs);
  const upcoming = posts
    .filter((p) => p.listId === list.id && p.status === 'scheduled' && Date.parse(p.scheduledAt) >= nowMs)
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  const missing = items.filter((it) => it.mediaMissing || (it.media || []).some((m) => !assetsById[m.assetId])).length;
  const thumbs = items.slice(0, 6);
  const paused = list.enabled === false;
  return html`<article class=${cx('panel qu-card', paused && 'is-paused')} style=${{ '--qu-color': list.color || 'var(--accent)' }} aria-labelledby=${`qu-${list.id}`} data-list-id=${list.id}>
    <header class="qu-card-head">
      <span class="qu-swatch" aria-hidden="true"></span>
      <h2 class="qu-name" id=${`qu-${list.id}`}>${list.name || 'Untitled queue'}</h2>
      <${Toggle} checked=${!paused} onChange=${onToggle} aria-label=${`${list.name}: ${paused ? 'paused' : 'on'}`} />
      <${Menu} label=${`Actions for ${list.name}`} size="sm" items=${[
        { label: 'Edit', icon: 'edit', onClick: onEdit },
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
    <footer class="qu-card-foot">
      ${paused ? html`<${Badge} tone="neutral">Paused<//>` : html`<${Badge} tone="success" icon="repeat">Fills ${list.horizonDays || 14} days ahead<//>`}
      <span class="spacer"></span>
      <${Button} size="sm" icon="edit" onClick=${onEdit}>Edit queue<//>
    </footer>
  </article>`;
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
          return [it.id, issues];
        }),
      ),
    [draft.items, assetsById],
  );
  const blocking = !draft.name.trim() || badSlots || !!horizonError;

  const preview = useMemo(() => {
    const items = usableItems(draft, posts);
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
                        <span class="pl-meta-item"><${Icon} name=${TYPE_ICON[it.type] || 'image'} size=${13} />${TYPE_LABEL[it.type] || 'Post'}${(it.media || []).length > 1 ? ` · ${it.media.length}` : ''}</span>
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

