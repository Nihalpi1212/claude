// Library: the contact sheet of every photo and video. Upload (button, drag-and-drop, paste, or shared
// from another app through the Android share sheet: #/library?shared=1), folders, tags, filters, the
// autopilot pool, bulk actions and a detail drawer per file. Files imported from a link (CSV, RSS) show
// a placeholder until the worker has downloaded them (asset.importUrl / importError).

import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { useApp } from '../app.js';
import { mutate, readDoc, useDocs } from '../data.js';
import { loadViewCss } from '../css.js';
import { deleteAssets, isImageFile, isVideoFile, originalUrl, prepareFile, thumbUrl, uploadPrepared } from '../media.js';
import { clearShared, readShared } from '../push.js';
import { setQuery } from '../router.js';
import {
  Badge, Button, Callout, ChipInput, EmptyState, Field, Frame, Icon, IconButton, Menu, Modal, PageHeader, ProgressBar,
  Segmented, Select, Skeleton, StatusPill, TextArea, TextInput, Toggle, Drawer, cx, usePhone,
} from '../ui/kit.js';
import { IMPORT_REFUSED } from '../../core/feed.js';
import { LIMITS, uid } from '../../core/model.js';
import { unusedAssets } from '../../core/schedule.js';
import { formatDateTime } from '../../core/time.js';

loadViewCss('library');

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'photos', label: 'Photos' },
  { value: 'videos', label: 'Videos' },
  { value: 'unused', label: 'Unused' },
  { value: 'autopilot', label: 'Autopilot pool' },
];
const TYPE_LABEL = { feed: 'Post', carousel: 'Carousel', reel: 'Reel', story: 'Story' };
// Frames shown at once. Each one fetches and decrypts its thumbnail as soon as it mounts, so a large
// library on a cold cache would otherwise send one GitHub request per file at once (secondary rate limit).
const SHEET_PAGE = 120;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const REMOVED_HINT = 'The original was removed to save space (Settings → Free up space). Only the thumbnail is kept; upload the file again to post it.';
// A file the worker still has to download from a link has no bytes yet: never try to load it.
const importing = (a) => !!(a && a.importUrl);
const importFailed = (a) => !!(a && a.importUrl && a.importError);
// Refused for good: Instagram cannot take the file as it is (a PNG, the wrong shape, too big...).
// Downloading it again gives the same file, so only a fixed copy uploaded in the Library helps.
const importRefused = (a) => importFailed(a) && IMPORT_REFUSED.has(a.importErrorCode);
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'its link';
  }
};

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function ratioLabel(w, h) {
  if (!w || !h) return '';
  const r = w / h;
  const known = [[1, '1:1'], [4 / 5, '4:5'], [1.91, '1.91:1'], [9 / 16, '9:16'], [16 / 9, '16:9'], [3 / 4, '3:4'], [4 / 3, '4:3']];
  const hit = known.find(([v]) => Math.abs(v - r) < 0.015);
  return hit ? hit[1] : `${r.toFixed(2)}:1`;
}

const normalizeTag = (t) => {
  const s = String(t || '').trim().replace(/^#+/, '').toLowerCase();
  return s.length ? s.slice(0, 40) : null;
};

/** Decrypted thumbnail object URL for an asset. */
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

const LIB_DOCS = ['library', 'posts'];

/** Posts (not canceled) that use each asset: assetId -> Post[]. */
function usageMap(posts) {
  const map = new Map();
  for (const p of posts) {
    if (p.status === 'canceled') continue;
    const ids = new Set([...(p.media || []).map((m) => m.assetId), ...(p.coverAssetId ? [p.coverAssetId] : [])]);
    for (const id of ids) {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(p);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Contact sheet item

function SheetItem({ asset, index, selected, selecting, usedCount, onOpen, onToggle }) {
  const pending = importing(asset);
  const failed = importFailed(asset);
  const refused = importRefused(asset);
  const src = useThumb(pending ? null : asset);
  const kind = asset.kind === 'video' ? 'video' : undefined;
  const desc = [
    asset.name || 'Untitled',
    asset.kind === 'video' ? `video${asset.durationSec ? `, ${formatDuration(asset.durationSec)}` : ''}` : 'photo',
    refused ? 'Instagram cannot take it as it is' : failed ? 'could not be downloaded from its link' : pending ? 'still downloading from its link' : null,
    asset.autopilot ? 'in the autopilot pool' : null,
    usedCount ? `used in ${plural(usedCount, 'post')}` : 'unused',
    asset.originalRemovedAt ? 'original removed' : null,
  ]
    .filter(Boolean)
    .join(', ');
  return html`<li class=${cx('lib-item', selected && 'is-selected', selecting && 'is-selecting', pending && 'is-importing')} data-asset=${asset.id}>
    <${Frame} src=${src} alt="" number=${index + 1} label=${asset.name || 'Untitled'} kind=${kind}
      badge=${asset.originalRemovedAt ? 'Original removed' : !pending && asset.kind === 'video' && asset.durationSec ? formatDuration(asset.durationSec) : undefined}
      title=${asset.originalRemovedAt ? REMOVED_HINT : refused ? `Cannot be posted: ${asset.importError}` : failed ? `Could not download: ${asset.importError}` : pending ? `Downloading from ${hostOf(asset.importUrl)}` : undefined}
      class=${cx('lib-frame', selected && 'is-selected', usedCount && 'is-used')}
      onClick=${(e) => (selecting || e.shiftKey || e.metaKey || e.ctrlKey ? onToggle(e) : onOpen())}
      aria-label=${selecting ? `${selected ? 'Deselect' : 'Select'} ${desc}` : `Open ${desc}`}>
      ${pending
        ? html`<span class=${cx('lib-import', failed && 'is-error')}>
            <${Icon} name=${failed ? 'alert' : 'download'} size=${18} />
            <span>${refused ? 'Cannot be posted' : failed ? 'Download failed' : 'Downloading from link…'}</span>
          </span>`
        : null}
      ${asset.autopilot || usedCount
        ? html`<span class="lib-flags" aria-hidden="true">
            ${asset.autopilot ? html`<span class="lib-flag is-pool" title="In the autopilot pool"><${Icon} name="wand" size=${12} /></span>` : null}
            ${usedCount ? html`<span class="lib-flag is-used" title=${`Used in ${plural(usedCount, 'post')}`}><${Icon} name="calendar" size=${12} /></span>` : null}
          </span>`
        : null}
    <//>
    <button type="button" class="lib-check" aria-pressed=${selected ? 'true' : 'false'} aria-label=${`Select ${asset.name || 'file'}`}
      title=${selected ? 'Deselect' : 'Select'} onClick=${onToggle}>
      <${Icon} name="check" size=${12} strokeWidth=${2.75} />
    </button>
  </li>`;
}

// ---------------------------------------------------------------------------
// Asset drawer

function AssetPreview({ asset }) {
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    setErr(null);
    if (importing(asset)) return undefined; // nothing to show until the worker has the file
    // Without the original (Free up space), show the thumbnail that was kept.
    (asset.originalRemovedAt ? thumbUrl(asset) : originalUrl(asset))
      .then((u) => alive && setUrl(u))
      .catch((e) => alive && setErr(e.message || 'The file could not be opened.'));
    return () => {
      alive = false;
    };
  }, [asset.id]);
  const [poster, setPoster] = useState(null);
  useEffect(() => {
    let alive = true;
    if (asset.kind === 'video' && !importing(asset)) thumbUrl(asset).then((u) => alive && setPoster(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [asset.id]);
  const r = asset.width && asset.height ? asset.width / asset.height : null;
  const style = r ? { aspectRatio: `${asset.width} / ${asset.height}`, width: `min(100%, calc(46vh * ${r.toFixed(4)}))` } : null;
  return html`<div class="lib-preview" style=${style} tabindex="-1" data-autofocus>
    ${importing(asset)
      ? html`<div class="lib-preview-msg"><${Icon} name=${importFailed(asset) ? 'alert' : 'download'} /><span>${importFailed(asset) ? 'Not downloaded' : 'Downloading from link…'}</span></div>`
      : err
      ? html`<div class="lib-preview-msg"><${Icon} name="alert" /><span>${err}</span></div>`
      : !url
        ? html`<div class="lib-preview-msg"><span class="spinner" style="width:18px;height:18px" aria-label="Loading preview" role="status"></span></div>`
        : asset.kind === 'video' && !asset.originalRemovedAt
          ? html`<video src=${url} poster=${poster || undefined} controls playsinline preload="metadata" aria-label=${asset.name || 'Video'}></video>`
          : html`<img src=${url} alt=${asset.name || ''} />`}
  </div>`;
}

function ImportStatus({ asset, onRetry }) {
  const [busy, setBusy] = useState(false);
  if (!importing(asset)) return null;
  const host = hostOf(asset.importUrl);
  const link = html`<a class="lib-import-url mono" href=${asset.importUrl} target="_blank" rel="noopener noreferrer">${asset.importUrl}</a>`;
  if (importRefused(asset)) {
    // The error says what to do (download it, upload it in the Library); trying again cannot help.
    return html`<${Callout} tone="danger" title="Instagram cannot take this file">
      <span>${asset.importError}</span>
      ${link}
      <span class="muted">Posts that use this file cannot publish. Upload a fixed copy in the Library, then swap it into those posts.</span>
    <//>`;
  }
  if (importFailed(asset)) {
    return html`<${Callout} tone="danger" title="Could not download this file"
      action=${html`<${Button} size="sm" variant="secondary" icon="refresh" loading=${busy}
        onClick=${async () => {
          setBusy(true);
          await onRetry([asset.id]);
          setBusy(false);
        }}>Try again<//>`}>
      <span>${asset.importError}</span>
      ${link}
      <span class="muted">Check that the link opens the photo or video itself, then try again. Posts that use this file cannot publish until it is here.</span>
    <//>`;
  }
  return html`<${Callout} tone="info" title="Downloading from link…">
    <span>The worker downloads this file from ${host} on its next run (about every 10 minutes). Posts that use it wait until it is here.</span>
    ${asset.importLastError ? html`<span class="muted">Last try failed: ${asset.importLastError} The worker tries again.</span>` : null}
    ${link}
  <//>`;
}

function AssetDrawer({ asset, folders, usedBy, tz, onClose, onCreatePost, onDelete, onRetry }) {
  const { toast, confirm, openComposer } = useApp();
  const pick = (a) => ({
    name: a.name || '',
    folderId: a.folderId || null,
    tags: [...(a.tags || [])],
    captionHint: a.captionHint || '',
    notes: a.notes || '',
    autopilot: !!a.autopilot,
  });
  const [draft, setDraft] = useState(() => pick(asset));
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(pick(asset)), [asset.id]);
  const base = pick(asset);
  const dirty = JSON.stringify(base) !== JSON.stringify(draft);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    setSaving(true);
    try {
      const patch = { ...draft, name: draft.name.trim() || asset.name };
      await mutate(
        'library',
        (lib) => {
          const a = lib.assets.find((x) => x.id === asset.id);
          if (a) Object.assign(a, patch);
          return lib;
        },
        { message: 'edit media details' },
      );
      toast('Saved.', { kind: 'success' });
    } catch {
      /* mutate already showed the error */
    } finally {
      setSaving(false);
    }
  };

  const close = async () => {
    if (dirty && !(await confirm({ title: 'Discard your changes?', body: 'The edits to this file have not been saved.', confirmLabel: 'Discard', danger: true }))) return;
    onClose();
  };

  const [dl, setDl] = useState(null);
  useEffect(() => {
    let alive = true;
    setDl(null);
    if (asset.originalRemovedAt || importing(asset)) return undefined;
    originalUrl(asset)
      .then((u) => alive && setDl(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [asset.id]);
  const fileName = asset.name && /\.[a-z0-9]{2,4}$/i.test(asset.name) ? asset.name : `${asset.name || 'media'}.${asset.kind === 'video' ? 'mp4' : 'jpg'}`;
  const folderOptions = [{ value: null, label: 'No folder' }, ...folders.map((f) => ({ value: f.id, label: f.name }))];

  return html`<${Drawer} open title=${asset.name || 'Media'} onClose=${close} width=${560} class="lib-drawer"
    footer=${html`
      <${Button} variant="ghost" icon="trash" class="lib-danger" onClick=${() => onDelete(asset)}>Delete<//>
      <span class="spacer"></span>
      ${dl ? html`<${Button} variant="ghost" icon="download" href=${dl} download=${fileName}>Download<//>` : null}
      <${Button} variant="secondary" icon="plus" onClick=${() => onCreatePost([asset])}>Create post<//>
      <${Button} variant="primary" onClick=${save} loading=${saving} disabled=${!dirty}>Save changes<//>`}>
    <div class="stack">
      <${ImportStatus} asset=${asset} onRetry=${onRetry} />
      <${AssetPreview} asset=${asset} />
      ${asset.originalRemovedAt
        ? html`<p class="text-sm"><${Badge} tone="warning">Original removed<//> <span class="muted">${REMOVED_HINT}</span></p>`
        : null}
      <dl class="kv lib-kv">
        <dt>Type</dt><dd>${importing(asset)
          ? html`<span class="muted">Not downloaded yet</span>`
          : html`${asset.kind === 'video' ? 'Video' : 'Photo'} · <span class="mono">${(asset.mime || '').replace(/^\w+\//, '').toUpperCase() || '—'}</span>`}</dd>
        <dt>Size</dt><dd class="mono">${asset.width && asset.height ? `${asset.width} × ${asset.height}` : '—'}${ratioLabel(asset.width, asset.height) ? html` <span class="muted">(${ratioLabel(asset.width, asset.height)})</span>` : null}</dd>
        <dt>File</dt><dd class="mono">${formatBytes(asset.bytes)}</dd>
        ${asset.kind === 'video' ? html`<dt>Length</dt><dd class="mono">${asset.durationSec ? formatDuration(asset.durationSec) : '—'}</dd>` : null}
        <dt>Added</dt><dd>${asset.createdAt ? formatDateTime(asset.createdAt, tz) : '—'}</dd>
      </dl>
      <${Field} label="Name"><${TextInput} value=${draft.name} onChange=${(v) => set({ name: v })} maxLength=${120} /><//>
      <div class="grid-2 lib-drawer-row">
        <${Field} label="Folder"><${Select} options=${folderOptions} value=${draft.folderId} onChange=${(v) => set({ folderId: v })} /><//>
        <div class="lib-pool-toggle">
          <${Toggle} checked=${draft.autopilot} onChange=${(v) => set({ autopilot: v })} label="Autopilot pool" hint="Autopilot may post this for you." />
        </div>
      </div>
      <${Field} label="Tags" hint="Press Enter after each tag. Tags help you search and group media.">
        <${ChipInput} values=${draft.tags} onChange=${(v) => set({ tags: v })} normalize=${normalizeTag} placeholder="Add a tag" max=${30} />
      <//>
      <${Field} label="Caption hint" hint="Autopilot uses this as the caption when AI is off, and as a note for AI captions.">
        <${TextArea} value=${draft.captionHint} onChange=${(v) => set({ captionHint: v })} rows=${2} maxLength=${LIMITS.captionChars} />
      <//>
      <${Field} label="Notes" hint="Only you see these.">
        <${TextArea} value=${draft.notes} onChange=${(v) => set({ notes: v })} rows=${2} />
      <//>
      <section class="lib-usedin" aria-labelledby="lib-usedin-title">
        <h3 class="label-caps" id="lib-usedin-title">Used in</h3>
        ${usedBy.length
          ? html`<ul class="list">
              ${usedBy.map(
                (p) => html`<li key=${p.id} class="list-row">
                  <${StatusPill} status=${p.status === 'draft' && p.needsApproval ? 'needs-approval' : p.status} />
                  <span class="grow truncate">${TYPE_LABEL[p.type] || 'Post'}${p.caption ? ` · ${p.caption.replace(/\s+/g, ' ').slice(0, 60)}` : ''}</span>
                  <span class="mono muted nowrap text-sm">${p.publishedAt || p.scheduledAt ? formatDateTime(p.publishedAt || p.scheduledAt, tz) : 'No date'}</span>
                  <${IconButton} icon="arrow-right" size="sm" label="Open post" onClick=${() => {
                    onClose();
                    openComposer(p.id);
                  }} />
                </li>`,
              )}
            </ul>`
          : html`<p class="muted text-sm">Not used in any post yet.</p>`}
      </section>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------
// Small modals

function NameModal({ open, title, label, hint, initial = '', confirmLabel, onClose, onSubmit }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => open && setName(initial), [open]);
  const submit = async (e) => {
    e && e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch {
      /* error toasted */
    } finally {
      setBusy(false);
    }
  };
  return html`<${Modal} open=${open} title=${title} onClose=${onClose}
    footer=${html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//><${Button} variant="primary" loading=${busy} disabled=${!name.trim()} onClick=${submit}>${confirmLabel}<//>`}>
    <form onSubmit=${submit}>
      <${Field} label=${label} hint=${hint}><${TextInput} value=${name} onChange=${setName} maxLength=${60} data-autofocus /><//>
    </form>
  <//>`;
}

function TagsModal({ open, count, onClose, onSubmit }) {
  const [tags, setTags] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => open && setTags([]), [open]);
  const submit = async () => {
    if (!tags.length) return;
    setBusy(true);
    try {
      await onSubmit(tags);
      onClose();
    } catch {
      /* error toasted */
    } finally {
      setBusy(false);
    }
  };
  return html`<${Modal} open=${open} title=${`Add tags to ${plural(count, 'file')}`} onClose=${onClose}
    footer=${html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//><${Button} variant="primary" loading=${busy} disabled=${!tags.length} onClick=${submit}>Add tags<//>`}>
    <${Field} label="Tags" hint="Press Enter after each tag. Existing tags are kept.">
      <${ChipInput} values=${tags} onChange=${setTags} normalize=${normalizeTag} placeholder="e.g. glaze" max=${30} data-autofocus />
    <//>
  <//>`;
}

// ---------------------------------------------------------------------------
// Upload

function UploadList({ items, onDismiss }) {
  if (!items.length) return null;
  const done = items.filter((i) => i.phase === 'done' || i.phase === 'error').length;
  const busy = done < items.length;
  const label = { queued: 'Waiting', processing: 'Preparing', uploading: 'Encrypting and uploading', done: 'Added', error: 'Failed' };
  return html`<section class="lib-uploads" aria-live="polite" aria-label="Uploads">
    <div class="row-between row">
      <strong>${busy ? `Uploading ${Math.min(done + 1, items.length)} of ${items.length}` : `Finished: ${plural(items.filter((i) => i.phase === 'done').length, 'file')} added`}</strong>
      ${busy ? null : html`<${IconButton} icon="x" size="sm" label="Hide uploads" onClick=${onDismiss} />`}
    </div>
    <${ProgressBar} value=${done} max=${items.length} label="Upload progress" tone=${items.some((i) => i.phase === 'error') ? 'warn' : 'accent'} />
    <ul class="lib-upload-rows">
      ${items.map(
        (i) => html`<li key=${i.id} class=${cx('lib-upload-row', `is-${i.phase}`)}>
          <${Icon} name=${i.phase === 'done' ? 'check' : i.phase === 'error' ? 'alert' : i.kind === 'video' ? 'video' : 'image'} size=${15} />
          <span class="grow truncate">${i.name}</span>
          <span class="lib-upload-phase">${i.phase === 'error' ? i.error : label[i.phase]}</span>
        </li>`,
      )}
    </ul>
  </section>`;
}

// ---------------------------------------------------------------------------
// Shared from another app (manifest share_target -> sw.js -> #/library?shared=1)

/** The text that was shared: the text (or page title) plus the link when the text lacks it. */
export function sharedHint({ title = '', text = '', url = '' } = {}) {
  const body = String(text || title || '').trim();
  const link = String(url || '').trim();
  return (link && !body.includes(link) ? `${body}${body ? '\n' : ''}${link}` : body).slice(0, LIMITS.captionChars);
}

function SharedThumb({ file }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!isImageFile(file)) return undefined;
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return html`<${Frame} src=${src} alt="" label=${file.name} kind=${isVideoFile(file) ? 'video' : undefined} />`;
}

// Any website can send a share (see sw.js), so the shared text is only shown, never used on its own:
// the caption hint starts empty and takes the text only when the owner asks.
function SharedPanel({ shared, setShared, onAdd, onDiscard, onCompose }) {
  const files = shared.files.filter((f) => isImageFile(f) || isVideoFile(f));
  const n = files.length;
  const videos = files.filter(isVideoFile).length;
  const what = videos === n ? plural(n, 'video') : videos ? `${n} photos and videos` : plural(n, 'photo');
  const quote = shared.quote
    ? html`<figure class="lib-shared-quote">
        <figcaption class="muted text-sm">Shared text</figcaption>
        <blockquote class="pre-wrap">${shared.quote}</blockquote>
      </figure>`
    : null;
  return html`<section class="lib-shared" aria-labelledby="lib-shared-title">
    <div class="lib-shared-head">
      <${Icon} name="share" size=${18} />
      <h2 class="section-title" id="lib-shared-title">Something was shared with Postpilot. Only add it if you shared it yourself.</h2>
      <span class="muted text-sm">${n ? what : 'No photos or videos'}</span>
    </div>
    ${shared.skipped
      ? html`<p class="text-sm text-warn">${plural(shared.skipped, 'more file was', 'more files were')} not kept: a share holds up to 10 files and 300 MB.</p>`
      : null}
    ${n
      ? html`<ul class="contact-sheet lib-shared-files" aria-label="Shared files">${files.map((f, i) => html`<li key=${i}><${SharedThumb} file=${f} /></li>`)}</ul>
          ${shared.files.length > n ? html`<p class="text-sm text-warn">${plural(shared.files.length - n, 'file')} cannot be added: only photos and videos can.</p>` : null}
          ${quote}
          <${Field} label=${n === 1 ? 'Caption hint' : 'Caption hint for the first file'}
            hint="Autopilot uses this as the caption when AI is off, and as a note for AI captions.">
            <${TextArea} rows=${2} maxRows=${6} value=${shared.hint} onChange=${(v) => setShared((s) => ({ ...s, hint: v }))} placeholder="Optional" />
          <//>
          ${shared.quote && shared.hint !== shared.quote
            ? html`<div class="row"><${Button} variant="secondary" size="sm" onClick=${() => setShared((s) => ({ ...s, hint: s.quote }))}>Use shared text as caption hint<//></div>`
            : null}
          <${Toggle} checked=${shared.pool} onChange=${(v) => setShared((s) => ({ ...s, pool: v }))} label="Add to the autopilot pool"
            hint=${n === 1 ? 'Autopilot may post it for you.' : 'Autopilot may post them for you.'} />
          <div class="row">
            <${Button} variant="primary" icon="upload" onClick=${() => onAdd(files)}>${n === 1 ? 'Add to library' : `Add ${n} files to library`}<//>
            <${Button} variant="ghost" onClick=${onDiscard}>Discard<//>
          </div>`
      : html`<p class="text-sm">Only photos and videos can be added to the library.${shared.quote ? ' You can start a post with the shared text instead.' : ''}</p>
          ${quote}
          <div class="row">
            ${shared.quote ? html`<${Button} variant="primary" icon="plus" onClick=${() => onCompose(shared.quote)}>Start a post with this text<//>` : null}
            <${Button} variant="ghost" onClick=${onDiscard}>Discard<//>
          </div>`}
  </section>`;
}

// ---------------------------------------------------------------------------

export default function Library() {
  const { route, tz, toast, confirm, openComposer } = useApp();
  const { data, error } = useLoadedDocs(LIB_DOCS);
  const phone = usePhone();
  const lib = data.library;
  const assets = (lib && lib.assets) || [];
  const folders = (lib && lib.folders) || [];
  const posts = (data.posts && data.posts.posts) || [];

  const filter = FILTERS.some((f) => f.value === route.query.filter) ? route.query.filter : 'all';
  const folder = route.query.folder || null; // null = all, 'none' = unfiled, else folder id
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [openId, setOpenId] = useState(route.query.asset || null);
  const [uploads, setUploads] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [modal, setModal] = useState(null); // 'new-folder' | 'rename-folder' | 'tags'
  const [limit, setLimit] = useState(SHEET_PAGE);
  const fileRef = useRef(null);
  const lastIndex = useRef(-1);
  const [shared, setShared] = useState(null); // {files, quote, hint, pool, skipped} shared from another app

  // Files shared from another app wait in the service worker's mailbox until they are added here.
  const sharedFlag = route.query.shared;
  useEffect(() => {
    if (!sharedFlag) return undefined;
    if (sharedFlag === 'error') {
      toast('Postpilot could not read what was shared. Share it again.', { kind: 'error' });
      setQuery({ shared: null });
      return undefined;
    }
    let alive = true;
    readShared()
      .then((s) => {
        if (!alive) return;
        if (!s || (!s.files.length && !sharedHint(s) && !s.skipped)) {
          setQuery({ shared: null }); // already added (or discarded) on another visit
          return;
        }
        setShared({ files: s.files, quote: sharedHint(s), hint: '', pool: false, skipped: s.skipped || 0 });
      })
      .catch(() => {
        if (!alive) return;
        toast('Postpilot could not read what was shared. Share it again.', { kind: 'error' });
        setQuery({ shared: null });
      });
    return () => {
      alive = false;
    };
  }, [sharedFlag]);

  const closeShared = () => {
    setShared(null);
    setQuery({ shared: null });
    clearShared().catch(() => {});
  };

  const usage = useMemo(() => usageMap(posts), [data.posts]);
  const unusedIds = useMemo(() => new Set(unusedAssets(assets, posts).map((a) => a.id)), [data.library, data.posts]);
  const activeFolder = folder && folder !== 'none' ? folders.find((f) => f.id === folder) : null;

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^#/, '');
    return assets.filter((a) => {
      if (filter === 'photos' && a.kind !== 'image') return false;
      if (filter === 'videos' && a.kind !== 'video') return false;
      if (filter === 'unused' && !unusedIds.has(a.id)) return false;
      if (filter === 'autopilot' && !a.autopilot) return false;
      if (folder === 'none' && a.folderId) return false;
      if (folder && folder !== 'none' && a.folderId !== folder) return false;
      if (needle) {
        const hay = [a.name, ...(a.tags || []), a.captionHint, a.notes].join(' ').toLowerCase();
        if (!needle.split(/\s+/).every((w) => hay.includes(w))) return false;
      }
      return true;
    });
  }, [assets, filter, folder, q, unusedIds]);
  useEffect(() => setLimit(SHEET_PAGE), [filter, folder, q]);

  // Drop selections that no longer exist.
  useEffect(() => {
    if (!selected.size) return;
    const ids = new Set(assets.map((a) => a.id));
    const next = new Set([...selected].filter((id) => ids.has(id)));
    if (next.size !== selected.size) setSelected(next);
  }, [data.library]);

  const selectedAssets = [...selected].map((id) => assets.find((a) => a.id === id)).filter(Boolean);
  const selecting = selected.size > 0;

  const toggle = (id, index, e) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (e && e.shiftKey && lastIndex.current >= 0 && lastIndex.current !== index) {
        const [a, b] = [Math.min(lastIndex.current, index), Math.max(lastIndex.current, index)];
        for (const x of visible.slice(a, b + 1)) next.add(x.id);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastIndex.current = index;
  };
  const clearSelection = () => {
    setSelected(new Set());
    lastIndex.current = -1;
  };

  // Escape clears the selection when no dialog is open.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && selected.size && !document.querySelector('.overlay')) clearSelection();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected.size]);

  // ---- upload --------------------------------------------------------------------------------
  const busyRef = useRef(false);
  const queueRef = useRef([]);
  /**
   * Queue files for upload. extra: {opts (uploadPrepared options), firstHint (caption hint of the first
   * file), onDone(batch)} where batch is {added: Asset[], failed, opts}; without onDone a toast reports it.
   */
  const startUpload = (fileList, { opts: extraOpts = {}, firstHint = '', onDone } = {}) => {
    const files = [...(fileList || [])];
    const ok = files.filter((f) => isImageFile(f) || isVideoFile(f));
    const skipped = files.length - ok.length;
    if (skipped) toast(`${plural(skipped, 'file')} skipped: only photos and videos can be added.`, { kind: 'error' });
    if (!ok.length) return false;
    const opts = { folderId: activeFolder ? activeFolder.id : null, autopilot: filter === 'autopilot', ...extraOpts };
    const batch = { left: ok.length, added: [], failed: 0, opts, onDone };
    const items = ok.map((f, i) => ({
      id: uid('up_'),
      name: f.name,
      kind: isVideoFile(f) ? 'video' : 'image',
      phase: 'queued',
      error: null,
      file: f,
      batch,
      opts: i === 0 && firstHint ? { ...opts, captionHint: firstHint } : opts,
    }));
    setUploads((prev) => [...prev.filter((p) => p.phase !== 'done' && p.phase !== 'error'), ...items]);
    queueRef.current.push(...items);
    if (!busyRef.current) runQueue();
    return true;
  };
  const patchUpload = (id, patch) => setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  const finishBatch = (b) => {
    if (b.onDone) return b.onDone(b);
    const where = b.opts.folderId ? ` in ${(folders.find((f) => f.id === b.opts.folderId) || {}).name || 'the folder'}` : '';
    if (b.added.length) toast(`Added ${plural(b.added.length, 'file')} to your library${where}.`, { kind: 'success' });
    if (b.failed) toast(`${plural(b.failed, 'file')} could not be added. See the upload list for why.`, { kind: 'error' });
  };
  const runQueue = async () => {
    busyRef.current = true;
    while (queueRef.current.length) {
      const item = queueRef.current.shift();
      try {
        patchUpload(item.id, { phase: 'processing' });
        const prepared = await prepareFile(item.file);
        patchUpload(item.id, { phase: 'uploading' });
        item.batch.added.push(await uploadPrepared(prepared, item.opts));
        patchUpload(item.id, { phase: 'done' });
      } catch (err) {
        item.batch.failed++;
        patchUpload(item.id, { phase: 'error', error: err.message || 'Upload failed.' });
      }
      if (--item.batch.left === 0) finishBatch(item.batch);
    }
    busyRef.current = false;
  };

  // Paste images from the clipboard anywhere on the page.
  useEffect(() => {
    const onPaste = (e) => {
      if (document.querySelector('.overlay')) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const files = [...((e.clipboardData && e.clipboardData.files) || [])];
      if (!files.length) return;
      e.preventDefault();
      startUpload(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i + 1}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }))));
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

  const dragDepth = useRef(0);
  const hasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
  const dropHandlers = {
    onDragEnter: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    },
    onDragOver: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    },
    onDrop: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      startUpload(e.dataTransfer.files);
    },
  };

  // ---- library writes ------------------------------------------------------------------------
  const writeAssets = (ids, fn, message) =>
    mutate(
      'library',
      (doc) => {
        const set = new Set(ids);
        for (const a of doc.assets) if (set.has(a.id)) fn(a);
        return doc;
      },
      { message },
    );

  const setPool = async (ids, on) => {
    try {
      await writeAssets(ids, (a) => (a.autopilot = on), on ? 'add media to autopilot' : 'remove media from autopilot');
      toast(on ? `Added ${plural(ids.length, 'file')} to the autopilot pool.` : `Removed ${plural(ids.length, 'file')} from the autopilot pool.`, { kind: 'success' });
    } catch {
      /* toasted */
    }
  };

  // folderName: pass it for a folder created in this render (`folders` does not have it yet).
  const moveTo = async (ids, folderId, folderName) => {
    try {
      await writeAssets(ids, (a) => (a.folderId = folderId), 'move media');
      const name = folderId ? folderName || (folders.find((f) => f.id === folderId) || {}).name || 'the folder' : null;
      toast(name ? `Moved ${plural(ids.length, 'file')} to ${name}.` : `Moved ${plural(ids.length, 'file')} out of folders.`, { kind: 'success' });
    } catch {
      /* toasted */
    }
  };

  const addTags = async (ids, tags) => {
    await writeAssets(ids, (a) => (a.tags = [...new Set([...(a.tags || []), ...tags])]), 'tag media');
    toast(`Tagged ${plural(ids.length, 'file')} with ${tags.map((t) => `#${t}`).join(' ')}.`, { kind: 'success' });
  };

  const removeAssets = async (list) => {
    const n = list.length;
    // 'reminded' posts still need their media: the owner posts them by hand (#/post-now).
    const usedBy = (a, statuses) => (usage.get(a.id) || []).some((p) => statuses.includes(p.status));
    const inUse = list.filter((a) => usedBy(a, ['scheduled', 'publishing', 'draft', 'reminded'])).length;
    const deletable = n - inUse;
    if (!deletable) {
      toast(n === 1 ? 'This file is used by a scheduled post or draft. Remove it from that post first.' : 'These files are used by scheduled posts or drafts. Remove them from those posts first.', { kind: 'info' });
      return false;
    }
    const ok = await confirm({
      title: deletable === 1 ? (n === 1 ? `Delete "${list[0].name || 'this file'}"?` : 'Delete 1 file?') : `Delete ${deletable} files?`,
      body: `${deletable === 1 ? 'It is' : 'They are'} removed from your library and storage. This cannot be undone.${inUse ? ` ${plural(inUse, 'other file')} ${inUse === 1 ? 'is' : 'are'} used by a scheduled post or draft and will be kept.` : ''}`,
      confirmLabel: deletable === 1 ? 'Delete file' : `Delete ${deletable} files`,
      danger: true,
    });
    if (!ok) return false;
    try {
      // media.js deleteAssets does not know about reminder posts yet, so leave their files out here.
      const { removed, kept } = await deleteAssets(list.filter((a) => !usedBy(a, ['reminded'])).map((a) => a.id));
      if (removed.length) toast(`Deleted ${plural(removed.length, 'file')}.${kept.length ? ` Kept ${kept.length} that a scheduled post or draft still uses.` : ''}`, { kind: 'success' });
      else toast('Nothing was deleted: these files are used by scheduled posts or drafts. Remove them from those posts first.', { kind: 'error' });
      setSelected((prev) => new Set([...prev].filter((id) => !removed.includes(id))));
      return removed.length > 0;
    } catch {
      return false;
    }
  };

  const retryImport = async (ids) => {
    try {
      await writeAssets(
        ids,
        (a) => {
          // A fresh start: the worker tries again on its next run with a new retry count.
          for (const k of ['importError', 'importErrorCode', 'importLastError', 'importAttempts', 'importTriedAt']) delete a[k];
        },
        'retry media download',
      );
      toast('The worker tries the download again on its next run.', { kind: 'success' });
    } catch {
      /* toasted */
    }
  };

  const createPost = (picked) => {
    // Files whose original was removed (Free up space) or could not be downloaded cannot be posted.
    // Files still downloading can: the post waits for them.
    const broken = picked.filter(importFailed);
    if (broken.length) {
      toast(
        broken.length === picked.length
          ? broken.every(importRefused)
            ? `Instagram cannot take ${broken.length === 1 ? 'this file' : 'these files'} as ${broken.length === 1 ? 'it is' : 'they are'}. Upload a fixed copy in the Library first.`
            : `${broken.length === 1 ? 'This file' : 'These files'} could not be downloaded from ${broken.length === 1 ? 'its link' : 'their links'}. Try the download again first.`
          : `Left out ${plural(broken.length, 'file')} that could not be downloaded from ${broken.length === 1 ? 'its link' : 'their links'}.`,
        { kind: broken.length === picked.length ? 'error' : 'info' },
      );
      picked = picked.filter((a) => !importFailed(a));
      if (!picked.length) return;
    }
    const removed = picked.filter((a) => a.originalRemovedAt);
    const list = picked.filter((a) => !a.originalRemovedAt);
    if (removed.length) {
      const one = removed.length === 1;
      toast(
        list.length
          ? `Left out ${plural(removed.length, 'file')} whose original was removed to save space. Upload ${one ? 'it' : 'them'} again to post ${one ? 'it' : 'them'}.`
          : `The original of ${one ? 'this file' : 'these files'} was removed to save space. Upload ${one ? 'it' : 'them'} again to post ${one ? 'it' : 'them'}.`,
        { kind: list.length ? 'info' : 'error' },
      );
    }
    if (!list.length) return;
    if (list.length > LIMITS.carouselMax) {
      toast(`A carousel holds at most ${LIMITS.carouselMax} photos or videos. Select fewer.`, { kind: 'error' });
      return;
    }
    const type = list.length > 1 ? 'carousel' : list[0].kind === 'video' ? 'reel' : 'feed';
    openComposer({ type, media: list.map((a) => ({ assetId: a.id, kind: a.kind, altText: '' })) });
    setOpenId(null);
    clearSelection();
  };

  const createFolder = async (name) => {
    const id = uid('fd_');
    await mutate(
      'library',
      (doc) => {
        doc.folders = doc.folders || [];
        if (!doc.folders.some((f) => f.id === id)) doc.folders.push({ id, name, createdAt: new Date().toISOString() });
        return doc;
      },
      { message: 'create folder' },
    );
    toast(`Folder "${name}" created.`, { kind: 'success' });
    if (selected.size) await moveTo([...selected], id, name);
    setQuery({ folder: id });
  };
  const renameFolder = async (name) => {
    const id = activeFolder.id;
    await mutate(
      'library',
      (doc) => {
        const f = (doc.folders || []).find((x) => x.id === id);
        if (f) f.name = name;
        return doc;
      },
      { message: 'rename folder' },
    );
    toast(`Renamed to "${name}".`, { kind: 'success' });
  };
  const deleteFolder = async () => {
    const f = activeFolder;
    const n = assets.filter((a) => a.folderId === f.id).length;
    const ok = await confirm({
      title: `Delete the folder "${f.name}"?`,
      body: n ? `The ${plural(n, 'file')} in it stay in your library without a folder.` : 'The folder is empty.',
      confirmLabel: 'Delete folder',
      danger: true,
    });
    if (!ok) return;
    try {
      await mutate(
        'library',
        (doc) => {
          doc.folders = (doc.folders || []).filter((x) => x.id !== f.id);
          for (const a of doc.assets) if (a.folderId === f.id) a.folderId = null;
          return doc;
        },
        { message: 'delete folder' },
      );
      toast(`Folder "${f.name}" deleted.`, { kind: 'success' });
      setQuery({ folder: null });
    } catch {
      /* toasted */
    }
  };

  // ---- render --------------------------------------------------------------------------------
  const totalBytes = assets.reduce((a, x) => a + (Number(x.bytes) || 0), 0);
  const poolCount = assets.filter((a) => a.autopilot).length;
  const openAsset = openId ? assets.find((a) => a.id === openId) : null;
  const folderCount = (id) => assets.filter((a) => (id === 'none' ? !a.folderId : a.folderId === id)).length;
  const filtersActive = filter !== 'all' || folder || q.trim();
  const failedImports = assets.filter(importFailed).length;
  const refusedImports = assets.filter(importRefused).length;
  const retryable = failedImports - refusedImports;
  const pendingImports = assets.filter(importing).length - failedImports;
  const importNote = [
    pendingImports ? `${plural(pendingImports, 'file')} ${pendingImports === 1 ? 'is' : 'are'} waiting for the worker to download ${pendingImports === 1 ? 'it' : 'them'} from a link (it runs about every 10 minutes).` : '',
    retryable ? `${plural(retryable, 'file')} could not be downloaded. Open ${retryable === 1 ? 'it' : 'them'} to try again.` : '',
    refusedImports ? `Instagram cannot take ${plural(refusedImports, 'file')} from a link as ${refusedImports === 1 ? 'it is' : 'they are'}. Open ${refusedImports === 1 ? 'it' : 'them'} to see why.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const folderNav = html`<nav class="lib-folders" aria-label="Folders">
    <div class="lib-folders-head label-caps">Folders</div>
    <ul>
      ${[{ id: null, name: 'All media', count: assets.length, icon: 'layers' }, { id: 'none', name: 'No folder', count: folderCount('none'), icon: 'image' }]
        .concat(folders.map((f) => ({ id: f.id, name: f.name, count: folderCount(f.id), icon: 'folder' })))
        .map(
          (f) => html`<li key=${f.id || 'all'}>
            <button type="button" class="lib-folder" aria-current=${folder === f.id ? 'true' : undefined} onClick=${() => setQuery({ folder: f.id })}>
              <${Icon} name=${f.icon} size=${16} /><span class="lib-folder-name">${f.name}</span><span class="lib-folder-count num">${f.count}</span>
            </button>
          </li>`,
        )}
      <li>
        <button type="button" class="lib-folder lib-folder-new" onClick=${() => setModal('new-folder')}>
          <${Icon} name="plus" size=${16} /><span class="lib-folder-name">New folder</span>
        </button>
      </li>
    </ul>
  </nav>`;

  const selectionBar = selecting
    ? html`<div class="lib-selbar" role="region" aria-label="Selection actions">
        <span class="lib-selcount"><strong class="num">${selected.size}</strong> selected</span>
        <${Button} size="sm" variant="primary" icon="plus" onClick=${() => createPost(selectedAssets)}>Create post<//>
        ${selectedAssets.every((a) => a.autopilot)
          ? html`<${Button} size="sm" icon="wand" onClick=${() => setPool([...selected], false)}>Remove from autopilot<//>`
          : html`<${Button} size="sm" icon="wand" onClick=${() => setPool([...selected], true)}>Add to autopilot<//>`}
        <${Menu} trigger="Move to" size="sm" label="Move to folder"
          items=${[
            ...folders.map((f) => ({ label: f.name, icon: 'folder', onClick: () => moveTo([...selected], f.id) })),
            { label: 'No folder', icon: 'image', onClick: () => moveTo([...selected], null) },
            '-',
            { label: 'New folder…', icon: 'plus', onClick: () => setModal('new-folder') },
          ]} />
        <${Button} size="sm" icon="tag" onClick=${() => setModal('tags')}>Add tags<//>
        <${Button} size="sm" variant="ghost" icon="trash" class="lib-danger" onClick=${() => removeAssets(selectedAssets)}>Delete<//>
        <span class="spacer"></span>
        ${selected.size < visible.length ? html`<${Button} size="sm" variant="ghost" onClick=${() => setSelected(new Set(visible.map((a) => a.id)))}>Select all ${visible.length}<//>` : null}
        <${Button} size="sm" variant="ghost" icon="x" onClick=${clearSelection}>Clear<//>
      </div>`
    : null;

  let body;
  if (error && !lib) {
    body = html`<${Callout} tone="danger" title="Your library could not be loaded">${error.message || String(error)} Reload the page to try again.<//>`;
  } else if (!lib) {
    body = html`<ul class="contact-sheet lib-sheet" aria-hidden="true">${Array.from({ length: 10 }, (_, i) => html`<li key=${i}><${Skeleton} height=${150} /></li>`)}</ul>`;
  } else if (!assets.length) {
    body = html`<${EmptyState} icon="image" title="Your library is empty"
      body="Add photos and videos here, then turn them into posts or hand them to autopilot. Everything is encrypted before it leaves this device."
      action=${html`<${Button} variant="primary" icon="upload" onClick=${() => fileRef.current && fileRef.current.click()}>Upload media<//>`} />`;
  } else if (!visible.length) {
    body = html`<${EmptyState} compact icon="search" title="Nothing matches"
      body=${filter === 'autopilot' ? 'No media is in the autopilot pool yet. Select photos and choose "Add to autopilot".' : filter === 'unused' ? 'Every file is already used in a post.' : 'Try another filter or search.'}
      action=${html`<${Button} size="sm" onClick=${() => {
        setQ('');
        setQuery({ filter: null, folder: null });
      }}>Show all media<//>`} />`;
  } else {
    const more = visible.length - limit;
    body = html`<ol class="contact-sheet lib-sheet" aria-label="Media">
      ${visible.slice(0, limit).map(
        (a, i) => html`<${SheetItem} key=${a.id} asset=${a} index=${i} selected=${selected.has(a.id)} selecting=${selecting}
          usedCount=${(usage.get(a.id) || []).length}
          onOpen=${() => setOpenId(a.id)}
          onToggle=${(e) => toggle(a.id, i, e)} />`,
      )}
    </ol>
    ${more > 0
      ? html`<div class="row lib-more">
          <span class="muted text-sm">Showing ${limit} of ${visible.length}</span>
          <${Button} size="sm" variant="secondary" onClick=${() => setLimit((n) => n + SHEET_PAGE)}>Show ${Math.min(more, SHEET_PAGE)} more<//>
        </div>`
      : null}`;
  }

  return html`<div class="page lib" ...${dropHandlers}>
    <${PageHeader} title="Library"
      subtitle=${lib ? `${plural(assets.length, 'file')} · ${formatBytes(totalBytes)} · ${poolCount} in the autopilot pool` : 'Loading your media…'}
      actions=${html`
        <input ref=${fileRef} type="file" accept="image/*,video/mp4,video/quicktime,.mov,.m4v,.heic,.heif" multiple hidden class="lib-file-input"
          aria-label="Choose photos or videos to upload"
          onChange=${(e) => {
            startUpload(e.currentTarget.files);
            e.currentTarget.value = '';
          }} />
        <${Button} variant="primary" icon="upload" onClick=${() => fileRef.current && fileRef.current.click()}>Upload<//>`} />

    <div class="lib-layout">
      ${phone ? null : folderNav}
      <div class="lib-main">
        ${phone ? folderNav : null}
        <div class=${cx('lib-dropzone', dragging && 'is-over')}>
          <${Icon} name="upload" size=${18} />
          <span>Drop photos or videos here, or paste from the clipboard${activeFolder ? html` into <strong>${activeFolder.name}</strong>` : ''}.</span>
          <button type="button" class="lib-dropzone-btn" onClick=${() => fileRef.current && fileRef.current.click()}>Choose files</button>
        </div>
        ${shared
          ? html`<${SharedPanel} shared=${shared} setShared=${setShared}
              onDiscard=${closeShared}
              onCompose=${(caption) => {
                closeShared();
                openComposer({ caption });
              }}
              onAdd=${(files) => {
                const { hint, pool } = shared;
                setShared(null);
                setQuery({ shared: null });
                startUpload(files, {
                  opts: { autopilot: pool },
                  firstHint: hint.trim(),
                  onDone: (b) => {
                    // The files are read from the share mailbox until here, so empty it only now.
                    clearShared().catch(() => {});
                    const where = pool ? 'your library and the autopilot pool' : 'your library';
                    if (b.added.length) {
                      toast(`Added ${plural(b.added.length, 'shared file')} to ${where}.`, {
                        kind: 'success',
                        action: b.added.length <= LIMITS.carouselMax ? { label: 'Create post', onClick: () => createPost(b.added) } : undefined,
                      });
                    }
                    if (b.failed) toast(`${plural(b.failed, 'file')} could not be added. See the upload list for why.`, { kind: 'error' });
                  },
                });
              }} />`
          : null}
        <${UploadList} items=${uploads} onDismiss=${() => setUploads([])} />

        <div class="toolbar lib-toolbar">
          <div class="lib-filter scroll-x">
            <${Segmented} options=${FILTERS} value=${filter} onChange=${(v) => setQuery({ filter: v === 'all' ? null : v })} label="Show" size="sm" />
          </div>
          <span class="spacer hide-phone"></span>
          <${TextInput} type="search" icon="search" value=${q} onChange=${setQ} placeholder="Search names and tags" aria-label="Search media" class="lib-search" />
        </div>

        ${activeFolder || folder === 'none' || filtersActive
          ? html`<div class="lib-context">
              <span class="lib-context-title">
                ${activeFolder ? html`<${Icon} name="folder" size=${16} /> ${activeFolder.name}` : folder === 'none' ? 'Media without a folder' : 'Filtered'}
                <span class="muted"> · ${plural(visible.length, 'file')}</span>
              </span>
              ${activeFolder
                ? html`<${Menu} label="Folder actions" size="sm" items=${[
                    { label: 'Rename folder', icon: 'edit', onClick: () => setModal('rename-folder') },
                    { label: 'Delete folder', icon: 'trash', danger: true, onClick: deleteFolder },
                  ]} />`
                : null}
              <span class="spacer"></span>
              ${filtersActive ? html`<${Button} size="sm" variant="ghost" onClick=${() => {
                setQ('');
                setQuery({ filter: null, folder: null });
              }}>Clear filters<//>` : null}
            </div>`
          : null}

        ${importNote ? html`<p class=${cx('lib-imports', failedImports && 'is-error')} role="status"><${Icon} name=${failedImports ? 'alert' : 'download'} size=${15} /><span>${importNote}</span></p>` : null}
        ${selectionBar}
        ${!selecting && lib && visible.length ? html`<p class="lib-tip faint">Click a frame to see details. Use the circle (or Shift-click) to select several.</p>` : null}
        ${body}
      </div>
    </div>

    ${dragging ? html`<div class="lib-drop-overlay" aria-hidden="true"><div><${Icon} name="upload" size=${28} /><p>Drop to add to your library${activeFolder ? ` (${activeFolder.name})` : ''}</p></div></div>` : null}

    ${openAsset
      ? html`<${AssetDrawer} key=${openAsset.id} asset=${openAsset} folders=${folders} usedBy=${usage.get(openAsset.id) || []} tz=${tz}
          onClose=${() => setOpenId(null)}
          onCreatePost=${createPost}
          onRetry=${retryImport}
          onDelete=${async (a) => {
            if (await removeAssets([a])) setOpenId(null);
          }} />`
      : null}

    <${NameModal} open=${modal === 'new-folder'} title="New folder" label="Folder name" confirmLabel="Create folder"
      hint=${selected.size ? `The ${selected.size === 1 ? 'selected file moves' : `${selected.size} selected files move`} into it.` : undefined}
      onClose=${() => setModal(null)} onSubmit=${createFolder} />
    <${NameModal} open=${modal === 'rename-folder' && !!activeFolder} title="Rename folder" label="Folder name" confirmLabel="Rename"
      initial=${activeFolder ? activeFolder.name : ''} onClose=${() => setModal(null)} onSubmit=${renameFolder} />
    <${TagsModal} open=${modal === 'tags'} count=${selected.size} onClose=${() => setModal(null)} onSubmit=${(tags) => addTags([...selected], tags)} />
  </div>`;
}
