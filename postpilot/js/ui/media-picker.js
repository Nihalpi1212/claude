// MediaPicker: pick photos and videos from the library (multi-select with order numbers, filters,
// search, folders, upload inside the picker). Also exports small helpers for decrypted media URLs.
//
//   <MediaPicker open onClose onPick=${(assets) => ...} multiple kinds=${['image']} max=${10} />
//
// Props: {open, onClose, onPick(assets[]), multiple=true, kinds=['image','video'], max?, title?,
//         confirmLabel?, initialSelected? (asset ids), blockPending? (files still downloading from
//         their link cannot be picked, for uses that need the bytes now, like AI captions)}
// onPick receives Asset objects in the order the owner selected them. The picker does not close
// itself: call onClose from onPick when you are done.
//
// Files imported from a link (CSV, RSS) have no bytes until the worker has downloaded them
// (asset.importUrl): thumbnails show a "Downloading…" or "Download failed" placeholder instead of
// requesting a file that does not exist yet.

import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { unusedAssets } from '../../core/schedule.js';
import { loadViewCss } from '../css.js';
import { useDoc } from '../data.js';
import { hasThumb, importState, isImageFile, isVideoFile, onMediaUrlRevoked, originalUrl, prepareFile, thumbUrl, uploadPrepared } from '../media.js';
import { Icon } from './icons.js';
import { Button, Callout, EmptyState, Frame, Modal, ProgressBar, Segmented, Select, Skeleton, TextInput, cx } from './kit.js';

loadViewCss('composer');

// ---------------------------------------------------------------------------
// Decrypted media URLs

const resolved = new Map(); // path -> object URL (already decrypted)
onMediaUrlRevoked((path) => resolved.delete(path)); // media.js revokes least recently used URLs

/** Object URL of an asset's thumbnail ('thumb') or original ('original'); null while loading or on error. */
export function useAssetUrl(asset, variant = 'thumb') {
  // Nothing to load while a linked file is still downloading, or for a video without a thumbnail.
  const loadable = asset && (variant === 'original' ? !importState(asset) : hasThumb(asset));
  const path = loadable ? (variant === 'original' ? asset.path : asset.thumbPath) : null;
  const [state, setState] = useState(() => ({ path, url: path ? resolved.get(path) || null : null, failed: false }));
  useEffect(() => {
    if (!loadable || !path) {
      setState({ path, url: null, failed: false });
      return undefined;
    }
    if (resolved.has(path)) {
      setState({ path, url: resolved.get(path), failed: false });
      return undefined;
    }
    let alive = true;
    setState({ path, url: null, failed: false });
    const p = variant === 'original' ? originalUrl(asset) : thumbUrl(asset);
    p.then((url) => {
      resolved.set(path, url);
      if (alive) setState({ path, url, failed: false });
    }).catch(() => alive && setState({ path, url: null, failed: true }));
    return () => {
      alive = false;
    };
  }, [path, variant]);
  return state.path === path ? state.url : null;
}

/** Duration "0:05" / "1:02:03" for videos. */
export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '';
  const s = Math.max(0, Math.round(Number(sec)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

// Inline styles (this module has no stylesheet of its own; tokens keep both themes right).
const IMPORT_STYLE = {
  position: 'absolute',
  inset: '0',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '4px',
  padding: '6px',
  background: 'repeating-linear-gradient(-45deg, var(--surface-2) 0 8px, var(--surface-3) 8px 16px)',
  color: 'var(--ink-2)',
  fontSize: 'var(--fs-xs)',
  lineHeight: '1.25',
  textAlign: 'center',
};
const IMPORT_ERROR_STYLE = { ...IMPORT_STYLE, background: 'var(--bad-soft)', color: 'var(--bad-ink)' };

/**
 * Placeholder for a file the worker still has to download from its link, or whose download failed.
 * Renders nothing for ordinary assets. {asset, compact?} (compact: icon only, for small thumbnails)
 */
export function ImportPlaceholder({ asset, compact = false, class: cls }) {
  const state = importState(asset);
  if (!state) return null;
  const failed = state === 'failed';
  const text = failed ? 'Download failed' : 'Downloading…';
  const tip = failed
    ? `Could not download from its link: ${asset.importError}`
    : `The worker downloads this file from its link on its next run.${asset.importLastError ? ` Last try failed: ${asset.importLastError}` : ''}`;
  return html`<span class=${cx('mp-import', failed && 'is-error', cls)} style=${failed ? IMPORT_ERROR_STYLE : IMPORT_STYLE} title=${tip}>
    <${Icon} name=${failed ? 'alert' : 'download'} size=${compact ? 14 : 18} />
    ${compact ? html`<span class="sr-only">${text}</span>` : html`<span>${text}</span>`}
  </span>`;
}

/**
 * MediaThumb {asset | assetId, ratio='1 / 1', number?, label?, kind?, onClick?, selected?, badge?}
 * A library asset in a contact-sheet Frame, with its decrypted thumbnail.
 */
export function MediaThumb({ asset, assetId, ratio = '1 / 1', kind, badge, children, ...rest }) {
  const { data: lib } = useDoc('library');
  const a = asset || (assetId && lib ? (lib.assets || []).find((x) => x.id === assetId) : null);
  const src = useAssetUrl(a);
  const k = kind || (a && a.kind === 'video' ? 'video' : undefined);
  const b = badge != null ? badge : a && a.kind === 'video' && !importState(a) ? formatDuration(a.durationSec) : undefined;
  const placeholder = importState(a) ? html`<${ImportPlaceholder} asset=${a} compact=${rest.size != null && Number(rest.size) < 72} />` : null;
  // Frame shows its blank icon only when there are no children, so pass none for ordinary assets.
  const inner = placeholder && children ? [placeholder, children] : placeholder || children;
  return html`<${Frame} src=${src} alt=${(a && a.name) || ''} ratio=${ratio} kind=${k} badge=${b} ...${rest} children=${inner} />`;
}

// ---------------------------------------------------------------------------
// Picker

const FILTERS_ALL = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Photos' },
  { value: 'video', label: 'Videos' },
  { value: 'unused', label: 'Unused' },
];

function kindWord(kinds, n) {
  const one = kinds.length === 1 ? (kinds[0] === 'video' ? 'video' : 'photo') : 'item';
  return n === 1 ? one : `${one}s`;
}

const REMOVED_HINT = 'The original was removed to save space (Settings → Free up space). Only the thumbnail is kept; upload the file again to post it.';
const PENDING_HINT = 'The worker is still downloading this file from its link. You can pick it here once it is in your library.';

function Tile({ asset, index, order, onToggle, onQuickPick, disabled, blockPending }) {
  const src = useAssetUrl(asset);
  const selected = order > 0;
  const removed = !!asset.originalRemovedAt;
  const imported = importState(asset);
  const blocked = removed || imported === 'failed' || (blockPending && imported === 'pending');
  const kindLabel = asset.kind === 'video' ? 'Video' : 'Photo';
  const state = removed
    ? ', original removed, cannot be picked'
    : imported === 'failed'
      ? ', download from its link failed, cannot be picked'
      : imported
        ? `, still downloading from its link${blockPending ? ', cannot be picked yet' : ''}`
        : '';
  // Frame shows its blank icon only without children, so pass none when there is nothing to add.
  const parts = [
    imported ? html`<${ImportPlaceholder} key="import" asset=${asset} />` : null,
    selected ? html`<span key="order" class="mp-order num" aria-hidden="true">${order}</span>` : null,
  ].filter(Boolean);
  const inner = parts.length ? parts : null;
  return html`<${Frame}
    class=${cx('mp-tile', selected && 'is-selected', (disabled || blocked) && !selected && 'is-dimmed')}
    src=${src}
    alt=""
    number=${index + 1}
    label=${asset.name}
    kind=${asset.kind === 'video' ? 'video' : undefined}
    badge=${removed ? 'Original removed' : asset.kind === 'video' && !imported ? formatDuration(asset.durationSec) : undefined}
    onClick=${() => onToggle(asset.id)}
    onDblClick=${() => onQuickPick(asset.id)}
    disabled=${blocked && !selected}
    title=${removed ? REMOVED_HINT : imported === 'failed' ? `Could not download from its link: ${asset.importError}` : blocked ? PENDING_HINT : undefined}
    aria-pressed=${selected ? 'true' : 'false'}
    aria-label=${`${kindLabel}: ${asset.name || 'untitled'}${state}${selected ? `, selected ${order}` : ''}`}
    data-asset-id=${asset.id}
    children=${inner}
  />`;
}

function PickerBody({ onClose, onPick, multiple = true, kinds = ['image', 'video'], max, title, confirmLabel, initialSelected = [], blockPending = false }) {
  const { data: lib, loading, error } = useDoc('library');
  const { data: postsDoc } = useDoc('posts');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState('all');
  const [selected, setSelected] = useState(() => [...initialSelected]);
  const [uploads, setUploads] = useState(null); // {done, total, name, errors: []}
  const [notice, setNotice] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  const limit = multiple ? max || Infinity : 1;

  const allAssets = (lib && lib.assets) || [];
  const folders = (lib && lib.folders) || [];
  const kindAssets = useMemo(() => allAssets.filter((a) => kinds.includes(a.kind)), [allAssets, kinds.join()]);
  const unused = useMemo(() => new Set(unusedAssets(kindAssets, (postsDoc && postsDoc.posts) || []).map((a) => a.id)), [kindAssets, postsDoc]);
  const byId = useMemo(() => new Map(allAssets.map((a) => [a.id, a])), [allAssets]);

  const filters = FILTERS_ALL.filter((f) => f.value === 'all' || f.value === 'unused' || kinds.includes(f.value));
  const q = query.trim().toLowerCase();
  const shown = kindAssets.filter((a) => {
    if (filter === 'image' || filter === 'video') {
      if (a.kind !== filter) return false;
    } else if (filter === 'unused' && !unused.has(a.id)) return false;
    if (folder === 'none' && a.folderId) return false;
    if (folder !== 'all' && folder !== 'none' && a.folderId !== folder) return false;
    if (q) {
      const hay = [a.name, ...(a.tags || []), a.captionHint || '', a.notes || ''].join(' ').toLowerCase();
      if (!q.split(/\s+/).every((w) => hay.includes(w.replace(/^#/, '')))) return false;
    }
    return true;
  });

  const toggle = (id) => {
    setNotice('');
    const a = byId.get(id);
    if (a && a.originalRemovedAt && !selected.includes(id)) {
      setNotice(REMOVED_HINT);
      return;
    }
    if (importState(a) === 'failed' && !selected.includes(id)) {
      setNotice(`"${a.name || 'This file'}" could not be downloaded from its link: ${a.importError} Fix it in the Library first.`);
      return;
    }
    if (blockPending && importState(a) === 'pending' && !selected.includes(id)) {
      setNotice(`"${a.name || 'This file'}" is still downloading from its link. You can pick it here once the worker has downloaded it.`);
      return;
    }
    setSelected((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      if (limit === 1) return [id];
      if (cur.length >= limit) {
        setNotice(`You can add up to ${limit} ${kindWord(kinds, limit)} here.`);
        return cur;
      }
      return [...cur, id];
    });
  };

  const confirm = (ids = selected) => {
    const assets = ids.map((id) => byId.get(id)).filter(Boolean);
    if (assets.length) onPick?.(assets);
  };

  const quickPick = (id) => {
    const a = byId.get(id);
    if (limit === 1 && !(a && a.originalRemovedAt) && importState(a) !== 'failed' && !(blockPending && importState(a) === 'pending')) confirm([id]);
  };

  async function handleFiles(fileList) {
    const files = [...fileList].filter((f) => (kinds.includes('image') && isImageFile(f)) || (kinds.includes('video') && isVideoFile(f)));
    const skipped = fileList.length - files.length;
    if (!files.length) {
      setNotice(skipped ? `Those files are not ${kinds.includes('video') && !kinds.includes('image') ? 'videos' : kinds.includes('image') && !kinds.includes('video') ? 'photos' : 'photos or videos'}.` : '');
      return;
    }
    setNotice('');
    const errors = [];
    const added = [];
    setUploads({ done: 0, total: files.length, name: files[0].name, errors });
    for (let i = 0; i < files.length; i++) {
      setUploads({ done: i, total: files.length, name: files[i].name, errors: [...errors] });
      try {
        const prepared = await prepareFile(files[i]);
        added.push(await uploadPrepared(prepared));
      } catch (err) {
        errors.push(`${files[i].name}: ${err.userMessage || err.message || err}`);
      }
    }
    setUploads(errors.length ? { done: files.length, total: files.length, name: '', errors } : null);
    if (added.length) {
      setFilter('all');
      setFolder('all');
      setQuery('');
      setSelected((cur) => {
        const ids = added.map((a) => a.id);
        if (limit === 1) return [ids[0]];
        const next = [...cur];
        for (const id of ids) if (!next.includes(id) && next.length < limit) next.push(id);
        return next;
      });
    }
    if (skipped) setNotice(`${skipped} file${skipped === 1 ? ' was' : 's were'} skipped because ${skipped === 1 ? 'it is' : 'they are'} not a supported type.`);
  }

  // Paste files while the picker is open.
  useEffect(() => {
    const onPaste = (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      handleFiles(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  const n = selected.length;
  const label = confirmLabel || (n ? `Add ${n} ${kindWord(kinds, n)}` : `Add ${kindWord(kinds, limit === 1 ? 1 : 2)}`);
  const accept = [kinds.includes('image') ? 'image/*' : '', kinds.includes('video') ? 'video/mp4,video/quicktime,video/*' : ''].filter(Boolean).join(',');
  const busy = uploads && uploads.done < uploads.total;

  const footer = html`<div class="mp-foot">
    <span class="mp-count muted" aria-live="polite">${n ? `${n} selected${limit !== Infinity && limit > 1 ? ` of ${limit}` : ''}` : limit === 1 ? 'Choose one' : 'Choose in the order they should appear'}</span>
    ${n ? html`<${Button} variant="ghost" size="sm" onClick=${() => setSelected([])}>Clear<//>` : null}
    <span class="spacer"></span>
    <${Button} variant="ghost" onClick=${onClose}>Cancel<//>
    <${Button} variant="primary" disabled=${!n || busy} onClick=${() => confirm()}>${label}<//>
  </div>`;

  return html`<${Modal} open=${true} wide title=${title || (limit === 1 ? `Choose a ${kindWord(kinds, 1)}` : 'Choose from library')} onClose=${onClose} footer=${footer} class="mp-modal">
    <div
      class=${cx('mp', dragOver && 'is-drag')}
      onDragOver=${(e) => {
        if ([...(e.dataTransfer?.types || [])].includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave=${(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop=${(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
      }}
    >
      <div class="mp-toolbar">
        <${TextInput} icon="search" type="search" value=${query} onChange=${setQuery} placeholder="Search name or tag" aria-label="Search media" class="mp-search" />
        ${filters.length > 2 ? html`<${Segmented} size="sm" label="Show" options=${filters} value=${filter} onChange=${setFilter} />` : null}
        ${folders.length
          ? html`<${Select} aria-label="Folder" class="mp-folder" value=${folder} onChange=${setFolder}
              options=${[{ value: 'all', label: 'All folders' }, { value: 'none', label: 'No folder' }, ...folders.map((f) => ({ value: f.id, label: f.name }))]} />`
          : null}
        <span class="spacer"></span>
        <input ref=${fileRef} type="file" class="sr-only" tabindex="-1" aria-hidden="true" multiple=${limit !== 1} accept=${accept}
          onChange=${(e) => {
            const files = [...e.currentTarget.files];
            e.currentTarget.value = '';
            handleFiles(files);
          }} />
        <${Button} icon="upload" size="sm" loading=${busy} onClick=${() => fileRef.current?.click()}>Upload<//>
      </div>

      ${uploads
        ? html`<div class="mp-upload" role="status">
            ${busy
              ? html`<div class="row row-between text-sm"><span class="truncate">Encrypting and uploading ${uploads.name}</span><span class="mono num">${uploads.done + 1} / ${uploads.total}</span></div>
                  <${ProgressBar} value=${uploads.done} max=${uploads.total} label="Upload progress" />`
              : null}
            ${uploads.errors.length
              ? html`<${Callout} tone="danger" title="Some files could not be added"
                  action=${!busy ? html`<${Button} size="sm" variant="ghost" onClick=${() => setUploads(null)}>Dismiss<//>` : null}>
                  ${uploads.errors.map((e) => html`<div>${e}</div>`)}
                <//>`
              : null}
          </div>`
        : null}
      ${notice ? html`<p class="mp-notice text-sm" role="status">${notice}</p>` : null}

      ${error
        ? html`<${Callout} tone="danger" title="Could not open the library">${error.message || String(error)}. Check your connection and try again.<//>`
        : loading && !lib
          ? html`<div class="contact-sheet mp-grid">${Array.from({ length: 8 }, (_, i) => html`<${Skeleton} key=${i} height=${130} />`)}</div>`
          : !kindAssets.length
            ? html`<${EmptyState} icon="image" title=${`No ${kindWord(kinds, 2)} in your library yet`}
                body="Upload from this device, or drop files here. Files are encrypted before they leave your browser."
                action=${html`<${Button} variant="primary" icon="upload" onClick=${() => fileRef.current?.click()}>Upload<//>`} />`
            : !shown.length
              ? html`<${EmptyState} compact icon="search" title="Nothing matches" body=${filter === 'unused' ? 'Everything here is already used in a post.' : 'Try another search or filter.'} />`
              : html`<div class="contact-sheet mp-grid" role="group" aria-label="Library media">
                  ${shown.map((a, i) => html`<${Tile} key=${a.id} asset=${a} index=${i} order=${selected.indexOf(a.id) + 1}
                    onToggle=${toggle} onQuickPick=${quickPick} disabled=${limit !== 1 && n >= limit} blockPending=${blockPending} />`)}
                </div>`}
      ${dragOver ? html`<div class="mp-drop" aria-hidden="true"><span>Drop to upload</span></div>` : null}
    </div>
  <//>`;
}

/**
 * MediaPicker {open, onClose, onPick(assets[]), multiple=true, kinds=['image','video'], max?, title?, confirmLabel?, initialSelected?}
 */
export function MediaPicker(props) {
  if (!props.open) return null;
  return html`<${PickerBody} ...${props} />`;
}

export default MediaPicker;
