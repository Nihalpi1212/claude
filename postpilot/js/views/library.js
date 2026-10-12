// Library: the contact sheet of every photo and video. Upload (button, drag-and-drop, paste), folders,
// tags, filters, the autopilot pool, bulk actions and a detail drawer per file.

import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { useApp } from '../app.js';
import { mutate, readDoc, useDocs } from '../data.js';
import { loadViewCss } from '../css.js';
import { deleteAssets, isImageFile, isVideoFile, originalUrl, prepareFile, thumbUrl, uploadPrepared } from '../media.js';
import { setQuery } from '../router.js';
import {
  Badge, Button, Callout, ChipInput, EmptyState, Field, Frame, Icon, IconButton, Menu, Modal, PageHeader, ProgressBar,
  Segmented, Select, Skeleton, StatusPill, TextArea, TextInput, Toggle, Drawer, cx, usePhone,
} from '../ui/kit.js';
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

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const REMOVED_HINT = 'The original was removed to save space (Settings → Free up space). Only the thumbnail is kept; upload the file again to post it.';

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
  const src = useThumb(asset);
  const kind = asset.kind === 'video' ? 'video' : undefined;
  const desc = [
    asset.name || 'Untitled',
    asset.kind === 'video' ? `video${asset.durationSec ? `, ${formatDuration(asset.durationSec)}` : ''}` : 'photo',
    asset.autopilot ? 'in the autopilot pool' : null,
    usedCount ? `used in ${plural(usedCount, 'post')}` : 'unused',
    asset.originalRemovedAt ? 'original removed' : null,
  ]
    .filter(Boolean)
    .join(', ');
  return html`<li class=${cx('lib-item', selected && 'is-selected', selecting && 'is-selecting')} data-asset=${asset.id}>
    <${Frame} src=${src} alt="" number=${index + 1} label=${asset.name || 'Untitled'} kind=${kind}
      badge=${asset.originalRemovedAt ? 'Original removed' : asset.kind === 'video' && asset.durationSec ? formatDuration(asset.durationSec) : undefined}
      title=${asset.originalRemovedAt ? REMOVED_HINT : undefined}
      class=${cx('lib-frame', selected && 'is-selected', usedCount && 'is-used')}
      onClick=${(e) => (selecting || e.shiftKey || e.metaKey || e.ctrlKey ? onToggle(e) : onOpen())}
      aria-label=${selecting ? `${selected ? 'Deselect' : 'Select'} ${desc}` : `Open ${desc}`}>
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
    if (asset.kind === 'video') thumbUrl(asset).then((u) => alive && setPoster(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [asset.id]);
  const r = asset.width && asset.height ? asset.width / asset.height : null;
  const style = r ? { aspectRatio: `${asset.width} / ${asset.height}`, width: `min(100%, calc(46vh * ${r.toFixed(4)}))` } : null;
  return html`<div class="lib-preview" style=${style} tabindex="-1" data-autofocus>
    ${err
      ? html`<div class="lib-preview-msg"><${Icon} name="alert" /><span>${err}</span></div>`
      : !url
        ? html`<div class="lib-preview-msg"><span class="spinner" style="width:18px;height:18px" aria-label="Loading preview" role="status"></span></div>`
        : asset.kind === 'video' && !asset.originalRemovedAt
          ? html`<video src=${url} poster=${poster || undefined} controls playsinline preload="metadata" aria-label=${asset.name || 'Video'}></video>`
          : html`<img src=${url} alt=${asset.name || ''} />`}
  </div>`;
}

function AssetDrawer({ asset, folders, usedBy, tz, onClose, onCreatePost, onDelete }) {
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
    if (asset.originalRemovedAt) return undefined;
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
      <${AssetPreview} asset=${asset} />
      ${asset.originalRemovedAt
        ? html`<p class="text-sm"><${Badge} tone="warning">Original removed<//> <span class="muted">${REMOVED_HINT}</span></p>`
        : null}
      <dl class="kv lib-kv">
        <dt>Type</dt><dd>${asset.kind === 'video' ? 'Video' : 'Photo'} · <span class="mono">${(asset.mime || '').replace(/^\w+\//, '').toUpperCase() || '—'}</span></dd>
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

function NameModal({ open, title, label, initial = '', confirmLabel, onClose, onSubmit }) {
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
      <${Field} label=${label}><${TextInput} value=${name} onChange=${setName} maxLength=${60} data-autofocus /><//>
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
  const fileRef = useRef(null);
  const lastIndex = useRef(-1);

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
  const startUpload = (fileList) => {
    const files = [...(fileList || [])];
    const ok = files.filter((f) => isImageFile(f) || isVideoFile(f));
    const skipped = files.length - ok.length;
    if (skipped) toast(`${plural(skipped, 'file')} skipped: only photos and videos can be added.`, { kind: 'error' });
    if (!ok.length) return;
    const items = ok.map((f) => ({ id: uid('up_'), name: f.name, kind: isVideoFile(f) ? 'video' : 'image', phase: 'queued', error: null, file: f }));
    setUploads((prev) => [...prev.filter((p) => p.phase !== 'done' && p.phase !== 'error'), ...items]);
    queueRef.current.push(...items);
    const opts = { folderId: activeFolder ? activeFolder.id : null, autopilot: filter === 'autopilot' };
    if (!busyRef.current) runQueue(opts);
  };
  const patchUpload = (id, patch) => setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  const runQueue = async (opts) => {
    busyRef.current = true;
    let added = 0;
    let failed = 0;
    while (queueRef.current.length) {
      const item = queueRef.current.shift();
      try {
        patchUpload(item.id, { phase: 'processing' });
        const prepared = await prepareFile(item.file);
        patchUpload(item.id, { phase: 'uploading' });
        await uploadPrepared(prepared, opts);
        patchUpload(item.id, { phase: 'done' });
        added++;
      } catch (err) {
        failed++;
        patchUpload(item.id, { phase: 'error', error: err.message || 'Upload failed.' });
      }
    }
    busyRef.current = false;
    if (added) toast(`Added ${plural(added, 'file')} to your library${opts.folderId ? ` in ${(folders.find((f) => f.id === opts.folderId) || {}).name || 'the folder'}` : ''}.`, { kind: 'success' });
    if (failed) toast(`${plural(failed, 'file')} could not be added. See the upload list for why.`, { kind: 'error' });
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

  const moveTo = async (ids, folderId) => {
    try {
      await writeAssets(ids, (a) => (a.folderId = folderId), 'move media');
      const name = folderId ? (folders.find((f) => f.id === folderId) || {}).name : null;
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
    const inUse = list.filter((a) => (usage.get(a.id) || []).some((p) => ['scheduled', 'publishing', 'draft'].includes(p.status))).length;
    const ok = await confirm({
      title: n === 1 ? `Delete "${list[0].name || 'this file'}"?` : `Delete ${n} files?`,
      body: `${n === 1 ? 'It is' : 'They are'} removed from your library and storage. This cannot be undone.${inUse ? ` ${inUse === n && n === 1 ? 'It is' : `${plural(inUse, 'file')} ${inUse === 1 ? 'is' : 'are'}`} used by a scheduled post or draft and will be kept.` : ''}`,
      confirmLabel: n === 1 ? 'Delete file' : `Delete ${n} files`,
      danger: true,
    });
    if (!ok) return false;
    try {
      const { removed, kept } = await deleteAssets(list.map((a) => a.id));
      if (removed.length) toast(`Deleted ${plural(removed.length, 'file')}.${kept.length ? ` Kept ${kept.length} that a scheduled post or draft still uses.` : ''}`, { kind: 'success' });
      else toast('Nothing was deleted: these files are used by scheduled posts or drafts. Remove them from those posts first.', { kind: 'error' });
      setSelected((prev) => new Set([...prev].filter((id) => !removed.includes(id))));
      return removed.length > 0;
    } catch {
      return false;
    }
  };

  const createPost = (picked) => {
    // Files whose original was removed (Free up space) cannot be posted.
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
    if (selected.size) await moveTo([...selected], id);
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
    body = html`<ol class="contact-sheet lib-sheet" aria-label="Media">
      ${visible.map(
        (a, i) => html`<${SheetItem} key=${a.id} asset=${a} index=${i} selected=${selected.has(a.id)} selecting=${selecting}
          usedCount=${(usage.get(a.id) || []).length}
          onOpen=${() => setOpenId(a.id)}
          onToggle=${(e) => toggle(a.id, i, e)} />`,
      )}
    </ol>`;
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
          onDelete=${async (a) => {
            if (await removeAssets([a])) setOpenId(null);
          }} />`
      : null}

    <${NameModal} open=${modal === 'new-folder'} title="New folder" label="Folder name" confirmLabel="Create folder"
      onClose=${() => setModal(null)} onSubmit=${createFolder} />
    <${NameModal} open=${modal === 'rename-folder' && !!activeFolder} title="Rename folder" label="Folder name" confirmLabel="Rename"
      initial=${activeFolder ? activeFolder.name : ''} onClose=${() => setModal(null)} onSubmit=${renameFolder} />
    <${TagsModal} open=${modal === 'tags'} count=${selected.size} onClose=${() => setModal(null)} onSubmit=${(tags) => addTags([...selected], tags)} />
  </div>`;
}
