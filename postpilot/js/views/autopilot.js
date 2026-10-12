// Autopilot: keeps the queue filled from media the owner hands it. This screen shows its state first
// (on/off, what it is waiting on), then the drafts to approve, the pool, a preview of what it would
// plan right now, and the settings.

import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { useApp } from '../app.js';
import { getStore, mutate, readDoc, refreshNow, transact, useDocs } from '../data.js';
import { loadViewCss } from '../css.js';
import { getAi } from '../ai-client.js';
import { MediaPicker, MediaThumb } from '../ui/media-picker.js';
import {
  Button, Callout, Checkbox, Chip, EmptyState, Field, Icon, IconButton, PageHeader, Panel, Segmented, Select, Skeleton,
  StatusPill, TextArea, TextInput, Toggle, cx,
} from '../ui/kit.js';
import { addHistory, hasErrors, LIMITS, validatePost } from '../../core/model.js';
import { bestTimeMatrix, planAutopilot, suggestSlots, unusedAssets } from '../../core/schedule.js';
import { dayKey, format, formatDateTime, formatTime, relative } from '../../core/time.js';
import { parseTimestamp } from '../../core/analytics.js';

loadViewCss('autopilot');

const DAY_MS = 864e5;
const TYPE_LABEL = { feed: 'Post', carousel: 'Carousel', reel: 'Reel', story: 'Story' };
const TYPE_ICON = { feed: 'image', carousel: 'carousel', reel: 'reel', story: 'story' };
const WEEKDAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
];
const HORIZONS = [3, 7, 14, 21, 30].map((d) => ({ value: d, label: `${d} days` }));
const GAPS = [4, 8, 12, 16, 20, 24, 36, 48].map((h) => ({ value: h, label: `${h} hours` }));
const SETTING_KEYS = ['mode', 'postsPerWeek', 'horizonDays', 'slotStrategy', 'fixedSlots', 'minGapHours', 'allowedTypes', 'useAi', 'captionStyle', 'hashtagSetIds', 'useAllUnused'];

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function keyDiff(a, b) {
  const t = (k) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
  return Math.round((t(a) - t(b)) / DAY_MS);
}

/** "today at 5:00 PM", "tomorrow at 12:00 PM", "Wednesday at 9:30 AM", "Oct 22 at 6:00 PM". */
function whenLabel(iso, tz, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'No time set';
  const diff = keyDiff(dayKey(d, tz), dayKey(now, tz));
  const t = formatTime(d, tz);
  if (diff === 0) return `today at ${t}`;
  if (diff === 1) return `tomorrow at ${t}`;
  if (diff === -1) return `yesterday at ${t}`;
  if (diff > 1 && diff < 7) return `${format(d, tz, { weekday: 'long' })} at ${t}`;
  return `${format(d, tz, { month: 'short', day: 'numeric' })} at ${t}`;
}

/** "5 min. ago" for a past timestamp; never "in 2 sec." when clocks disagree slightly. */
function ago(iso) {
  const n = Date.now();
  const t = parseTimestamp(iso);
  return relative(new Date(Number.isFinite(t) ? Math.min(t, n) : n), new Date(n));
}

function excerpt(text, n = 140) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

function pickSettings(doc) {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = structuredClone(doc[k]);
  out.fixedSlots = Array.isArray(out.fixedSlots) ? out.fixedSlots : [];
  out.allowedTypes = Array.isArray(out.allowedTypes) ? out.allowedTypes : ['feed', 'carousel', 'reel'];
  out.hashtagSetIds = Array.isArray(out.hashtagSetIds) ? out.hashtagSetIds : [];
  out.useAllUnused = !!out.useAllUnused;
  out.useAi = out.useAi !== false;
  return out;
}

function cleanSettings(d) {
  const perWeek = Math.round(Number(d.postsPerWeek));
  return {
    ...d,
    postsPerWeek: Number.isFinite(perWeek) ? Math.min(28, Math.max(1, perWeek)) : 4,
    fixedSlots: (d.fixedSlots || []).filter((s) => /^\d{2}:\d{2}$/.test(s.time || '')),
    captionStyle: String(d.captionStyle || '').slice(0, 500),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** useDocs plus a re-render once all docs loaded (works around a missed-notification race in data.js). */
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

const DOCS = ['autopilot', 'posts', 'library', 'hashtags', 'audience', 'analytics-media', 'log'];

// ---------------------------------------------------------------------------
// Post rows

function PostMedia({ post, assetsById }) {
  const refs = (post.media || []).slice(0, 3);
  return html`<div class=${cx('ap-media', refs.length > 1 && 'is-stack')} aria-hidden="true">
    ${refs.map((m, i) => {
      const a = assetsById.get(m.assetId);
      return html`<${MediaThumb} key=${m.assetId + i} asset=${a || null} assetId=${m.assetId} class="ap-media-frame"
        kind=${i === 0 && post.type === 'carousel' ? 'carousel' : i === 0 && post.type === 'reel' ? 'reel' : undefined} badge="" />`;
    })}
  </div>`;
}

function ApprovalRow({ post, assetsById, tz, now, busy, onApprove, onEdit, onReject }) {
  const t = parseTimestamp(post.scheduledAt);
  const passed = Number.isFinite(t) && t < now + 5 * 60e3;
  return html`<li class="ap-row" data-post=${post.id}>
    <${PostMedia} post=${post} assetsById=${assetsById} />
    <div class="ap-row-body">
      <div class="ap-row-when">
        <span class="mono">${Number.isFinite(t) ? cap(whenLabel(post.scheduledAt, tz, new Date(now))) : 'No time yet'}</span>
        <span class="ap-type"><${Icon} name=${TYPE_ICON[post.type] || 'image'} size=${14} />${TYPE_LABEL[post.type] || 'Post'}</span>
        ${passed ? html`<span class="ap-warn">Time passed: approving picks the next free slot</span>` : null}
      </div>
      <p class="ap-caption">${excerpt(post.caption) || html`<span class="faint">No caption</span>`}</p>
      <div class="ap-row-actions">
        <${Button} size="sm" variant="primary" icon="check" loading=${busy === 'approve'} disabled=${!!busy} onClick=${onApprove}>Approve<//>
        <${Button} size="sm" icon="edit" disabled=${!!busy} onClick=${onEdit}>Edit<//>
        <${Button} size="sm" variant="ghost" icon="x" class="ap-reject" loading=${busy === 'reject'} disabled=${!!busy} onClick=${onReject}>Reject<//>
      </div>
    </div>
  </li>`;
}

function ScheduledRow({ post, assetsById, tz, now, onEdit }) {
  return html`<li class="ap-row is-compact">
    <${PostMedia} post=${post} assetsById=${assetsById} />
    <div class="ap-row-body">
      <div class="ap-row-when">
        <span class="mono">${cap(whenLabel(post.scheduledAt, tz, new Date(now)))}</span>
        <span class="ap-type"><${Icon} name=${TYPE_ICON[post.type] || 'image'} size=${14} />${TYPE_LABEL[post.type] || 'Post'}</span>
      </div>
      <p class="ap-caption is-one">${excerpt(post.caption, 90) || html`<span class="faint">No caption</span>`}</p>
    </div>
    <${IconButton} icon="edit" size="sm" label="Edit post" onClick=${onEdit} />
  </li>`;
}

// ---------------------------------------------------------------------------
// Settings form

function FixedSlots({ slots, onChange }) {
  const set = (i, patch) => onChange(slots.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return html`<div class="ap-slots">
    ${slots.length
      ? html`<ul class="ap-slot-list">
          ${slots.map(
            (s, i) => html`<li key=${i} class="ap-slot">
              <${Select} options=${WEEKDAYS} value=${Number(s.weekday)} onChange=${(v) => set(i, { weekday: v })} aria-label=${`Day of time ${i + 1}`} />
              <input type="time" class="input ap-time" value=${s.time} step="300" aria-label=${`Time ${i + 1}`}
                onInput=${(e) => e.currentTarget.value && set(i, { time: e.currentTarget.value })} />
              <${IconButton} icon="x" size="sm" label=${`Remove time ${i + 1}`} onClick=${() => onChange(slots.filter((_, j) => j !== i))} />
            </li>`,
          )}
        </ul>`
      : html`<p class="muted text-sm">No fixed times yet.</p>`}
    <${Button} size="sm" variant="ghost" icon="plus" onClick=${() => onChange([...slots, { weekday: 3, time: '12:00' }])}>Add a time<//>
  </div>`;
}

function SettingsForm({ draft, set, sets, aiOn, onSave, onDiscard, dirty, saving }) {
  const perWeek = Number(draft.postsPerWeek) || 0;
  const target = Math.max(1, Math.round((perWeek * (Number(draft.horizonDays) || 7)) / 7));
  const chosenTags = new Set(sets.filter((s) => draft.hashtagSetIds.includes(s.id)).flatMap((s) => s.tags || []));
  const toggleType = (t, on) => set({ allowedTypes: on ? [...new Set([...draft.allowedTypes, t])] : draft.allowedTypes.filter((x) => x !== t) });
  return html`<${Panel} title="Settings" subtitle="Changes apply from the next worker run." class="ap-settings"
    actions=${dirty ? html`<span class="ap-dirty">Unsaved changes</span>` : null}>
    <div class="ap-form">
      <fieldset class="ap-group">
        <legend class="label-caps">How it posts</legend>
        <${Field} label="Mode" hint=${draft.mode === 'auto' ? 'Posts are scheduled straight away. You can still edit or cancel them in the planner.' : 'Autopilot drafts each post and waits for your approval before anything is scheduled.'}>
          <${Segmented} label="Mode" value=${draft.mode} onChange=${(v) => set({ mode: v })}
            options=${[{ value: 'review', label: 'Review drafts first' }, { value: 'auto', label: 'Schedule automatically' }]} />
        <//>
        <div class="grid-2">
          <${Field} label="Posts per week" hint=${`Keeps about ${plural(target, 'post')} planned at any time.`}>
            <${TextInput} type="number" min="1" max="28" step="1" value=${draft.postsPerWeek} onChange=${(v) => set({ postsPerWeek: v })} mono />
          <//>
          <${Field} label="Plan ahead" hint="How far ahead it fills the calendar.">
            <${Select} options=${HORIZONS} value=${draft.horizonDays} onChange=${(v) => set({ horizonDays: v })} />
          <//>
        </div>
      </fieldset>

      <fieldset class="ap-group">
        <legend class="label-caps">When</legend>
        <${Field} label="Times" hint=${draft.slotStrategy === 'fixed' ? 'Autopilot uses these weekly times, earliest free one first.' : 'Picks the hours when your followers are most active and your posts did best.'}>
          <${Segmented} label="Times" value=${draft.slotStrategy} onChange=${(v) => set({ slotStrategy: v })}
            options=${[{ value: 'best', label: 'Best times' }, { value: 'fixed', label: 'Fixed times' }]} />
        <//>
        ${draft.slotStrategy === 'fixed' ? html`<${FixedSlots} slots=${draft.fixedSlots} onChange=${(v) => set({ fixedSlots: v })} />` : null}
        <${Field} label="Minimum gap between posts" hint="Counts every post, not only autopilot ones.">
          <${Select} options=${GAPS.some((g) => g.value === draft.minGapHours) ? GAPS : [...GAPS, { value: draft.minGapHours, label: `${draft.minGapHours} hours` }]}
            value=${draft.minGapHours} onChange=${(v) => set({ minGapHours: v })} />
        <//>
      </fieldset>

      <fieldset class="ap-group">
        <legend class="label-caps">What</legend>
        <div class="ap-types" role="group" aria-label="Post types autopilot may create">
          <${Checkbox} checked=${draft.allowedTypes.includes('feed')} onChange=${(v) => toggleType('feed', v)} label="Single posts" />
          <${Checkbox} checked=${draft.allowedTypes.includes('carousel')} onChange=${(v) => toggleType('carousel', v)} label="Carousels" hint="From photos in the same folder" />
          <${Checkbox} checked=${draft.allowedTypes.includes('reel')} onChange=${(v) => toggleType('reel', v)} label="Reels" hint="From videos" />
        </div>
        ${!draft.allowedTypes.length ? html`<p class="field-error"><${Icon} name="alert" size=${14} /><span>Pick at least one type.</span></p>` : null}
        <${Toggle} checked=${draft.useAllUnused} onChange=${(v) => set({ useAllUnused: v })} label="When the pool runs out, use any unused media"
          hint="Off: only media you added to the pool is posted." />
      </fieldset>

      <fieldset class="ap-group">
        <legend class="label-caps">Captions</legend>
        ${aiOn
          ? html`<${Toggle} checked=${draft.useAi} onChange=${(v) => set({ useAi: v })} label="Write captions with AI"
              hint="Claude looks at the photos and uses each caption hint and your style notes. Off: the caption hint is used as is." />`
          : html`<${Callout} tone="neutral" title="AI captions are off"
              action=${html`<${Button} size="sm" href="#/settings?section=ai">Set up AI<//>`}>
              Autopilot uses each file's caption hint plus the hashtag sets below.
            <//>`}
        <${Field} label="Caption style" hint="A sentence or two about tone and length. Used for AI captions.">
          <${TextArea} value=${draft.captionStyle} onChange=${(v) => set({ captionStyle: v })} rows=${2} maxLength=${500}
            placeholder="Short, warm, ends with a question." />
        <//>
        <div class="field">
          <div class="field-label-row"><span class="field-label" id="ap-sets-label">Hashtag sets to add</span></div>
          ${sets.length
            ? html`<div class="ap-chips" role="group" aria-labelledby="ap-sets-label">
                ${sets.map(
                  (s) => html`<${Chip} key=${s.id} selected=${draft.hashtagSetIds.includes(s.id)} icon="hash"
                    onClick=${() => set({ hashtagSetIds: draft.hashtagSetIds.includes(s.id) ? draft.hashtagSetIds.filter((x) => x !== s.id) : [...draft.hashtagSetIds, s.id] })}>
                    ${s.name} <span class="faint num">${(s.tags || []).length}</span>
                  <//>`,
                )}
              </div>`
            : html`<p class="muted text-sm">No hashtag sets yet. <a href="#/hashtags">Create one</a>.</p>`}
          <p class=${cx('field-hint', chosenTags.size > LIMITS.hashtagsRecommended && 'text-warn')}>
            ${chosenTags.size
              ? `${chosenTags.size} hashtags selected. Instagram limits posts to ${LIMITS.hashtagsRecommended} since December 2025${aiOn && draft.useAi ? '; AI picks the best ones' : ''}.`
              : 'Optional.'}
          </p>
        </div>
      </fieldset>
    </div>
    <div class="ap-form-foot">
      <${Button} variant="ghost" disabled=${!dirty || saving} onClick=${onDiscard}>Discard changes<//>
      <${Button} variant="primary" loading=${saving} disabled=${!dirty || !draft.allowedTypes.length} onClick=${onSave}>Save settings<//>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------

export default function Autopilot() {
  const { settings, tz, toast, confirm, openComposer, dispatchWorker } = useApp();
  const { data, error } = useLoadedDocs(DOCS);
  const ap = data.autopilot;
  const posts = (data.posts && data.posts.posts) || [];
  const assets = (data.library && data.library.assets) || [];
  const assetsById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [data.library]);
  const sets = (data.hashtags && data.hashtags.sets) || [];
  const aiOn = !!getAi(settings);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Settings draft
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const saved = ap ? pickSettings(ap) : null;
  const dirty = !!(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));
  useEffect(() => {
    if (ap && (!draft || !dirty)) setDraft(pickSettings(ap));
  }, [ap]);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const saveSettings = async ({ quiet = false } = {}) => {
    const clean = cleanSettings(draft);
    setSaving(true);
    try {
      const next = await mutate(
        'autopilot',
        (doc) => {
          for (const k of SETTING_KEYS) doc[k] = structuredClone(clean[k]);
          return doc;
        },
        { message: 'autopilot settings' },
      );
      setDraft(pickSettings(next));
      if (!quiet) toast('Autopilot settings saved.', { kind: 'success' });
      return true;
    } catch {
      return false;
    } finally {
      setSaving(false);
    }
  };

  const [toggling, setToggling] = useState(false);
  const setEnabled = async (on) => {
    setToggling(true);
    try {
      await mutate(
        'autopilot',
        (doc) => {
          doc.enabled = on;
          return doc;
        },
        { message: on ? 'autopilot on' : 'autopilot off' },
      );
      toast(on ? `Autopilot is on. It fills the next ${plural(Number(ap.horizonDays) || 7, 'day')} on the next worker run.` : 'Autopilot is off. Posts it already planned stay in your calendar.', { kind: 'success' });
    } catch {
      /* toasted */
    } finally {
      setToggling(false);
    }
  };

  // Best-time matrix and planning preview
  const matrixInfo = useMemo(() => {
    if (!data.audience || !data['analytics-media']) return null;
    return bestTimeMatrix({
      onlineFollowers: data.audience.onlineFollowers,
      mediaStats: data['analytics-media'].media,
      tz,
      now,
      followers: settings && settings.ig ? settings.ig.followersCount ?? undefined : undefined,
    });
  }, [data.audience, data['analytics-media'], tz, Math.floor(now / 36e5)]);

  const preview = useMemo(() => {
    if (!draft || !matrixInfo || !data.posts || !data.library) return null;
    const settingsNow = { ...cleanSettings(draft), enabled: true };
    const plan = planAutopilot({ autopilot: settingsNow, assets, posts, matrix: matrixInfo.matrix, tz, now });
    let open = [];
    if (!plan.create.length) {
      const taken = posts
        .filter((p) => ['draft', 'scheduled', 'publishing'].includes(p.status) && p.scheduledAt)
        .map((p) => p.scheduledAt);
      const fixed = settingsNow.slotStrategy === 'fixed' && settingsNow.fixedSlots.length ? settingsNow.fixedSlots : null;
      open = suggestSlots({ matrix: matrixInfo.matrix, tz, now, count: 3, horizonDays: Math.max(14, settingsNow.horizonDays), minGapHours: settingsNow.minGapHours, taken, fixedSlots: fixed, maxPerDay: fixed ? null : Math.max(1, Math.ceil(settingsNow.postsPerWeek / 7)) });
    }
    return { plan, open };
  }, [draft, matrixInfo, data.posts, data.library, now]);

  // Lists
  const approvals = posts
    .filter((p) => p.status === 'draft' && p.needsApproval)
    .sort((a, b) => (parseTimestamp(a.scheduledAt) || Infinity) - (parseTimestamp(b.scheduledAt) || Infinity));
  const scheduled = posts
    .filter((p) => p.source === 'autopilot' && (p.status === 'scheduled' || p.status === 'publishing') && parseTimestamp(p.scheduledAt) > now - 3600e3)
    .sort((a, b) => parseTimestamp(a.scheduledAt) - parseTimestamp(b.scheduledAt));
  const pool = assets.filter((a) => a.autopilot);
  const unusedIds = useMemo(() => new Set(unusedAssets(assets, posts).map((a) => a.id)), [data.library, data.posts]);
  const ready = pool.filter((a) => unusedIds.has(a.id));

  // Approve / reject
  const [busy, setBusy] = useState({}); // postId -> 'approve' | 'reject'
  const mark = (id, v) => setBusy((b) => ({ ...b, [id]: v }));

  const approve = async (post) => {
    const issues = validatePost({ ...post, status: 'scheduled' }, assetsById).filter((i) => i.level === 'error');
    if (hasErrors(issues)) {
      toast(`This draft cannot be scheduled yet: ${issues[0].message} Open it with Edit to fix it.`, { kind: 'error' });
      return;
    }
    mark(post.id, 'approve');
    const minGap = ap ? Number(ap.minGapHours) || 20 : 20;
    const matrix = matrixInfo ? matrixInfo.matrix : undefined;
    let when = null;
    try {
      await mutate(
        'posts',
        (doc) => {
          const p = doc.posts.find((x) => x.id === post.id);
          if (!p || p.status !== 'draft') return doc;
          let at = p.scheduledAt;
          const t = parseTimestamp(at);
          if (!Number.isFinite(t) || t < Date.now() + 5 * 60e3) {
            const taken = doc.posts
              .filter((x) => x.id !== p.id && ['scheduled', 'publishing', 'draft'].includes(x.status) && x.scheduledAt)
              .map((x) => x.scheduledAt);
            at = suggestSlots({ matrix, tz, count: 1, horizonDays: 21, minGapHours: minGap, taken, maxPerDay: null })[0] || new Date(Date.now() + 3600e3).toISOString();
          }
          p.scheduledAt = at;
          p.status = 'scheduled';
          p.needsApproval = false;
          addHistory(p, 'approved', 'Approved in the app.');
          when = at;
          return doc;
        },
        { message: 'approve autopilot post' },
      );
      if (when) toast(`Approved. Scheduled for ${formatDateTime(when, tz)}.`, { kind: 'success' });
    } catch {
      /* toasted */
    } finally {
      mark(post.id, null);
    }
  };

  const approveAll = async () => {
    const ok = await confirm({ title: `Approve ${plural(approvals.length, 'draft')}?`, body: 'Each one is scheduled at the time autopilot picked (or the next free slot if that time has passed).', confirmLabel: 'Approve all' });
    if (!ok) return;
    for (const p of approvals) await approve(p);
  };

  const reject = async (post) => {
    const ok = await confirm({
      title: 'Reject this draft?',
      body: 'The draft is removed from your calendar and its media leaves the autopilot pool, so autopilot does not suggest it again.',
      confirmLabel: 'Reject draft',
      danger: true,
    });
    if (!ok) return;
    mark(post.id, 'reject');
    try {
      await transact(
        async (tx) => {
          const doc = await tx.read('posts');
          const p = doc.posts.find((x) => x.id === post.id);
          if (!p || p.status !== 'draft') return;
          p.status = 'canceled';
          p.needsApproval = false;
          addHistory(p, 'rejected', 'Rejected in the app.');
          tx.write('posts', doc);
          const ids = new Set((p.media || []).map((m) => m.assetId));
          const lib = await tx.read('library');
          let changed = false;
          for (const a of lib.assets) {
            if (ids.has(a.id) && a.autopilot) {
              a.autopilot = false;
              changed = true;
            }
          }
          if (changed) tx.write('library', lib);
        },
        { message: 'reject autopilot post' },
      );
      toast('Draft rejected. Its media left the autopilot pool.', { kind: 'success' });
    } catch {
      /* toasted */
    } finally {
      mark(post.id, null);
    }
  };

  // Pool
  const [pickerOpen, setPickerOpen] = useState(false);
  const setPool = async (ids, on) => {
    if (!ids.length) {
      toast('Those files are already in the pool.', { kind: 'info' });
      return;
    }
    try {
      await mutate(
        'library',
        (doc) => {
          const s = new Set(ids);
          for (const a of doc.assets) if (s.has(a.id)) a.autopilot = on;
          return doc;
        },
        { message: on ? 'add media to autopilot' : 'remove media from autopilot' },
      );
      toast(on ? `Added ${plural(ids.length, 'file')} to the pool.` : 'Removed from the pool. The file stays in your library.', { kind: 'success' });
    } catch {
      /* toasted */
    }
  };

  // Run now: dispatch the worker, then poll for its result.
  const [running, setRunning] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => (alive.current = false), []);
  const runNow = async () => {
    if (dirty && !(await saveSettings({ quiet: true }))) return;
    const current = await readDoc('autopilot');
    if (!current.enabled) {
      const ok = await confirm({ title: 'Turn on autopilot and run it?', body: 'Autopilot is off. Turning it on lets the worker plan posts now and on every run after this one.', confirmLabel: 'Turn on and run' });
      if (!ok) return;
      await setEnabled(true);
    }
    setRunning(true);
    const store = getStore();
    const beforeLog = await store.read('log').catch(() => null);
    const before = { run: beforeLog && beforeLog.runs && beforeLog.runs[0] ? beforeLog.runs[0].startedAt : null, ap: current.lastRunAt };
    try {
      await dispatchWorker('autopilot');
    } catch {
      setRunning(false);
      return;
    }
    const deadline = Date.now() + 150_000;
    let result = null;
    while (alive.current && Date.now() < deadline) {
      await sleep(2500);
      try {
        await refreshNow();
        const [log, a] = await Promise.all([store.read('log'), store.read('autopilot')]);
        const run = log.runs && log.runs[0];
        if ((run && run.startedAt !== before.run && run.finishedAt) || a.lastRunAt !== before.ap) {
          result = a.lastResult || null;
          if (a.lastRunAt === before.ap && run && run.skipped && run.skipped.autopilot) result = { reason: `Autopilot skipped this run (${run.skipped.autopilot}).` };
          break;
        }
      } catch {
        /* keep polling */
      }
    }
    if (!alive.current) return;
    setRunning(false);
    if (result) {
      const created = result.created || 0;
      toast(created ? `Autopilot ${current.mode === 'auto' ? 'scheduled' : 'drafted'} ${plural(created, 'post')}.${current.mode === 'auto' ? '' : ' Review them below.'}` : `Autopilot ran: ${result.reason || 'nothing to do.'}`, { kind: created ? 'success' : 'info', duration: 7000 });
    } else {
      toast('The worker is still running. New drafts appear here when it finishes.', { kind: 'info' });
    }
  };

  // ---- render --------------------------------------------------------------------------------
  if (error && !ap) {
    return html`<div class="page"><${PageHeader} title="Autopilot" /><${Callout} tone="danger" title="Autopilot settings could not be loaded">${error.message || String(error)} Reload the page to try again.<//></div>`;
  }
  if (!ap || !draft) {
    return html`<div class="page"><${PageHeader} title="Autopilot" subtitle="Loading…" /><${Skeleton} height=${120} /><${Skeleton} lines=${6} /></div>`;
  }

  const on = !!ap.enabled;
  const res = ap.lastResult;
  const statusLine = on
    ? `${ap.mode === 'auto' ? 'Schedules' : 'Drafts'} ${plural(Number(ap.postsPerWeek) || 0, 'post')} a week for the next ${plural(Number(ap.horizonDays) || 7, 'day')}, at ${ap.slotStrategy === 'fixed' ? 'your fixed times' : 'your best times'}${ap.mode === 'auto' ? '.' : ', and waits for your approval.'}`
    : 'Turn it on and it keeps your calendar filled from the media in its pool.';
  const basisText = matrixInfo
    ? {
        audience: 'Best times come from when your followers are online.',
        engagement: `Best times come from how your last ${plural(matrixInfo.postsUsed, 'post')} performed.`,
        blend: `Best times blend when followers are online with how your last ${plural(matrixInfo.postsUsed, 'post')} did.`,
        default: 'Best times use typical Instagram activity until there is enough data from your account.',
      }[matrixInfo.basis]
    : '';

  return html`<div class="page ap">
    <${PageHeader} title="Autopilot"
      subtitle="Give autopilot the photos and videos you are happy to post. It picks good times, writes the captions and keeps your calendar filled. In review mode nothing goes out until you approve it."
      actions=${html`<${Button} variant="secondary" icon="refresh" loading=${running} disabled=${saving || toggling} onClick=${runNow}>
        ${running ? 'Running…' : dirty ? 'Save and run now' : 'Run autopilot now'}
      <//>`} />

    <section class=${cx('ap-status', on ? 'is-on' : 'is-off')} aria-label="Autopilot status">
      <div class="ap-status-main">
        <${Toggle} checked=${on} disabled=${toggling} onChange=${setEnabled} label=${on ? 'Autopilot is on' : 'Autopilot is off'} hint=${statusLine} class="ap-master" />
      </div>
      <dl class="ap-status-stats">
        <div><dt>Ready in pool</dt><dd class=${cx('num', on && !ready.length && 'text-bad')}>${ready.length}</dd></div>
        <div><dt>To approve</dt><dd class=${cx('num', approvals.length && 'text-warn')}>${approvals.length}</dd></div>
        <div><dt>Scheduled</dt><dd class="num">${scheduled.length}</dd></div>
      </dl>
      <p class="ap-status-last">
        ${res
          ? html`<${Icon} name=${res.code === 'planned' ? 'check' : res.code === 'full' ? 'calendar' : 'info'} size=${15} />
              <span>Last run ${ago(res.at)}: ${res.reason || 'done.'}</span>`
          : html`<${Icon} name="clock" size=${15} /><span>${on ? 'Waiting for the next worker run (every 10 minutes).' : 'Has not run yet.'}</span>`}
      </p>
    </section>

    ${on && !ready.length && !draft.useAllUnused
      ? html`<${Callout} tone="warning" title="The pool is empty"
          action=${html`<${Button} size="sm" onClick=${() => setPickerOpen(true)}>Add media<//>`}>
          Autopilot has no unused photos or videos to post. Add some from your library.
        <//>`
      : null}

    <div class="ap-columns">
      <div class="stack ap-col-main">
        <${Panel} title="Waiting for your approval" class="ap-approvals" flush
          subtitle=${approvals.length ? 'Approve to schedule, edit to change the caption or time, or reject.' : null}
          actions=${approvals.length > 1 ? html`<${Button} size="sm" variant="secondary" icon="check" onClick=${approveAll}>Approve all<//>` : null}>
          ${approvals.length
            ? html`<ul class="ap-list">
                ${approvals.map(
                  (p) => html`<${ApprovalRow} key=${p.id} post=${p} assetsById=${assetsById} tz=${tz} now=${now} busy=${busy[p.id]}
                    onApprove=${() => approve(p)} onEdit=${() => openComposer(p.id)} onReject=${() => reject(p)} />`,
                )}
              </ul>`
            : html`<${EmptyState} compact icon="check" title="Nothing to approve"
                body=${ap.mode === 'auto' ? 'Autopilot is in automatic mode: it schedules posts without asking.' : 'New drafts from autopilot show up here.'} />`}
        <//>

        <${Panel} title="Scheduled by autopilot" class="ap-scheduled" flush>
          ${scheduled.length
            ? html`<ul class="ap-list">
                ${scheduled.slice(0, 8).map((p) => html`<${ScheduledRow} key=${p.id} post=${p} assetsById=${assetsById} tz=${tz} now=${now} onEdit=${() => openComposer(p.id)} />`)}
              </ul>`
            : html`<${EmptyState} compact icon="calendar" title="Nothing scheduled by autopilot yet" />`}
        <//>
      </div>

      <div class="stack ap-col-side">
        <${Panel} title="If it ran now" subtitle=${basisText} class="ap-preview">
          ${!preview
            ? html`<${Skeleton} lines=${3} />`
            : preview.plan.create.length
              ? html`<ol class="ap-plan">
                  ${preview.plan.create.slice(0, 6).map(
                    (c, i) => html`<li key=${i} class="ap-plan-item">
                      <div class=${cx('ap-media', c.assetIds.length > 1 && 'is-stack')} aria-hidden="true">
                        ${c.assetIds.slice(0, 3).map((id) => html`<${MediaThumb} key=${id} asset=${assetsById.get(id) || null} class="ap-media-frame" badge="" />`)}
                      </div>
                      <div class="ap-plan-body">
                        <span class="mono">${cap(whenLabel(c.scheduledAt, tz, new Date(now)))}</span>
                        <span class="muted text-sm">${TYPE_LABEL[c.type]}${c.assetIds.length > 1 ? ` · ${c.assetIds.length} items` : ''} · ${(assetsById.get(c.assetIds[0]) || {}).name || ''}</span>
                      </div>
                    </li>`,
                  )}
                </ol>
                <p class="ap-note">${preview.plan.reason}${on ? '' : ' Turn autopilot on to let it do this.'}</p>`
              : html`<p class="ap-note">${preview.plan.reason}</p>
                  ${preview.open.length
                    ? html`<div class="ap-open">
                        <span class="label-caps">Next open times</span>
                        <ul>${preview.open.map((t) => html`<li key=${t} class="mono">${cap(whenLabel(t, tz, new Date(now)))}</li>`)}</ul>
                      </div>`
                    : null}`}
        <//>

        <${Panel} title="Content pool" class="ap-pool"
          subtitle=${pool.length ? `${ready.length} ready · ${pool.length - ready.length} already used` : null}
          actions=${html`<${Button} size="sm" icon="plus" onClick=${() => setPickerOpen(true)}>Add from library<//>`}>
          ${pool.length
            ? html`<ul class="ap-pool-grid">
                ${pool
                  .slice()
                  .sort((a, b) => Number(unusedIds.has(b.id)) - Number(unusedIds.has(a.id)))
                  .map(
                    (a) => html`<li key=${a.id} class=${cx('ap-pool-item', !unusedIds.has(a.id) && 'is-used')}>
                      <${MediaThumb} asset=${a} label=${unusedIds.has(a.id) ? 'Ready' : 'Used'} />
                      <button type="button" class="ap-pool-remove" aria-label=${`Remove ${a.name || 'file'} from the pool`} title="Remove from pool"
                        onClick=${() => setPool([a.id], false)}><${Icon} name="x" size=${12} strokeWidth=${2.5} /></button>
                    </li>`,
                  )}
              </ul>
              <p class="ap-note"><a href="#/library?filter=autopilot">Manage the pool in the library</a>. Photos in the same folder can become a carousel.</p>`
            : html`<${EmptyState} compact icon="wand" title="The pool is empty"
                body="Add the photos and videos you are happy for autopilot to post."
                action=${html`<${Button} size="sm" variant="primary" icon="plus" onClick=${() => setPickerOpen(true)}>Add from library<//>`} />`}
        <//>
      </div>
    </div>

    <${SettingsForm} draft=${draft} set=${set} sets=${sets} aiOn=${aiOn} dirty=${dirty} saving=${saving}
      onSave=${() => saveSettings()} onDiscard=${() => setDraft(pickSettings(ap))} />

    <${MediaPicker} open=${pickerOpen} onClose=${() => setPickerOpen(false)} title="Add to the autopilot pool" confirmLabel="Add to pool"
      kinds=${draft.allowedTypes.includes('reel') ? ['image', 'video'] : ['image']}
      onPick=${(picked) => {
        setPickerOpen(false);
        setPool(picked.map((a) => a.id).filter((id) => !(assetsById.get(id) || {}).autopilot), true);
      }} />
  </div>`;
}
