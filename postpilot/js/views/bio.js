// Link in bio: edit the public page (title, bio, photo, links, post grid, look), preview it live with
// the same renderer as bio.html, and publish or unpublish it.
//
// The bio document is public JSON (public/bio.json). Edits stay local until "Publish"/"Save draft";
// the photo is saved right away because it is a file upload. Links switched off ("Show" off) are
// never written to the public file: they are kept in the encrypted settings doc
// (settings.bioHiddenLinks, each with its position in the list) and merged back in the editor.

import { uid } from '../../core/model.js';
import { formatDay, relative } from '../../core/time.js';
import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { useApp } from '../app.js';
import { BioView, DEFAULT_ACCENT, contrastInk, normalAccent, publicFileUrl, safeHref, withUtm } from '../bio-page.js';
import { bioPageUrl } from '../config.js';
import { loadViewCss } from '../css.js';
import { getStore, mutate, transact, useDoc } from '../data.js';
import { blobBytes, loadBitmap, renderJpeg } from '../media.js';
import { CopyButton, ExtLink } from '../ui/connect-instagram.js';
import { Icon } from '../ui/icons.js';
import {
  Badge, Button, Callout, EmptyState, Field, Frame, IconButton, Modal, PageHeader, Panel, Segmented, Skeleton, TextArea, TextInput, Toggle,
  cx, usePhone,
} from '../ui/kit.js';

loadViewCss('bio');
loadPublicCss();

function loadPublicCss() {
  if (typeof document === 'undefined' || document.querySelector('link[data-bio-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../../css/bio.css', import.meta.url).href;
  link.dataset.bioCss = '';
  document.head.appendChild(link);
}

const MAX_GRID = 12;
const ACCENTS = ['#1f5f8b', '#2d7a4d', '#b03a2e', '#c27a1a', '#6250d6', '#15191c'];

/** Put hidden links (from settings.bioHiddenLinks) back at their saved positions. */
function withHiddenLinks(links, hidden) {
  const out = [...links];
  const have = new Set(out.map((l) => l && l.id));
  const list = (Array.isArray(hidden) ? hidden : []).filter((l) => l && l.id && !have.has(l.id));
  list.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
  for (const { position, ...l } of list) {
    const at = Number.isInteger(position) && position >= 0 ? Math.min(position, out.length) : out.length;
    out.splice(at, 0, { ...l, enabled: false });
  }
  return out;
}

function normalize(d, hiddenLinks) {
  const doc = structuredClone(d || {});
  doc.links = withHiddenLinks(doc.links || [], hiddenLinks);
  doc.title = doc.title || '';
  doc.bio = doc.bio || '';
  doc.theme = doc.theme === 'ink' ? 'ink' : 'paper';
  doc.accent = normalAccent(doc.accent);
  doc.links = (doc.links || []).map((l) => ({
    ...l,
    id: l.id || uid('bl_'),
    title: l.title ?? l.label ?? '',
    url: l.url || '',
    enabled: l.enabled !== false,
    highlight: !!l.highlight,
    utm: { source: '', medium: '', campaign: '', ...(l.utm || {}) },
  }));
  doc.grid = (doc.grid || []).map((g) => ({ ...g, id: g.id || uid('bg_') }));
  return doc;
}

/** "studio.com/shop" -> "https://studio.com/shop" (only when it looks like a web address). */
export function fixUrl(url) {
  const u = String(url || '').trim();
  if (!u || /^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  if (/^[^\s/]+\.[^\s/]{2,}(\/\S*)?$/.test(u)) return `https://${u}`;
  return u;
}

export function validateBio(doc) {
  const errors = {};
  for (const l of doc.links || []) {
    const e = {};
    if (l.enabled !== false) {
      if (!String(l.title || '').trim()) e.title = 'Add a label, for example "Shop".';
      if (!safeHref(l.url)) e.url = 'Enter a full address starting with https://';
    } else if (l.url && !safeHref(l.url)) e.url = 'Enter a full address starting with https://';
    if (Object.keys(e).length) errors[l.id] = e;
  }
  for (const g of doc.grid || []) {
    if (g.url && !safeHref(g.url)) errors[g.id] = { url: 'Enter a full address starting with https://, or leave it empty.' };
  }
  return errors;
}

function cleanLink(l) {
  const utm = Object.fromEntries(Object.entries(l.utm || {}).map(([k, v]) => [k, String(v || '').trim()]).filter(([, v]) => v));
  const out = { id: l.id, title: String(l.title || '').trim(), url: String(l.url || '').trim(), enabled: l.enabled !== false, highlight: !!l.highlight };
  if (Object.keys(utm).length) out.utm = utm;
  return out;
}

/** What gets written to public/bio.json from the editor state. Hidden links are left out entirely. */
export function publishable(draft) {
  return {
    title: String(draft.title || '').trim(),
    bio: String(draft.bio || '').trim(),
    theme: draft.theme === 'ink' ? 'ink' : 'paper',
    accent: normalAccent(draft.accent),
    links: (draft.links || []).filter((l) => l.enabled !== false).map((l) => {
      const out = cleanLink(l);
      out.href = withUtm(out.url, out.utm);
      return out;
    }),
    grid: (draft.grid || []).map((g) => ({ ...g, url: String(g.url || '').trim() })),
  };
}

/** Hidden links with their place in the list, for the encrypted settings doc (never the public file). */
export function hiddenLinks(draft) {
  return (draft.links || [])
    .map((l, position) => (l.enabled === false ? { ...cleanLink(l), enabled: false, position } : null))
    .filter(Boolean);
}

function useAvatarUrl(path) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!path) {
      setUrl(null);
      return undefined;
    }
    if (/^(https?:|data:|blob:)/.test(path)) {
      setUrl(path);
      return undefined;
    }
    let alive = true;
    let made = null;
    getStore()
      .readBytes(path, { decrypt: false })
      .then((bytes) => {
        if (!alive || !bytes) return;
        made = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
        setUrl(made);
      })
      .catch(() => alive && setUrl(null));
    return () => {
      alive = false;
      if (made) setTimeout(() => URL.revokeObjectURL(made), 1000);
    };
  }, [path]);
  return url;
}

function imageOf(m) {
  return m.thumbnailUrl || (m.mediaType !== 'VIDEO' ? m.mediaUrl : null) || null;
}

function GridPicker({ open, onClose, media, existing, room, onAdd, tz }) {
  const [sel, setSel] = useState([]);
  useEffect(() => {
    if (open) setSel([]);
  }, [open]);
  const taken = new Set(existing.map((g) => g.igMediaId).filter(Boolean));
  const items = Object.values((media && media.media) || {})
    .filter((m) => m && m.productType !== 'STORY' && imageOf(m))
    .sort((a, b) => (Date.parse(b.timestamp || 0) || 0) - (Date.parse(a.timestamp || 0) || 0))
    .slice(0, 36);
  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= room ? s : [...s, id]));
  return html`<${Modal} open=${open} wide title="Choose posts for the grid" onClose=${onClose}
    footer=${html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//>
      <${Button} variant="primary" disabled=${!sel.length} onClick=${() => onAdd(sel.map((id) => items.find((m) => m.id === id)).filter(Boolean))}>
        ${sel.length ? `Add ${sel.length} post${sel.length === 1 ? '' : 's'}` : 'Add posts'}
      <//>`}>
    ${items.length
      ? html`<p class="muted bio-picker-note">Pick up to ${room} of your recent posts. Each tile opens the post on Instagram unless you give it another link.</p>
          <div class="contact-sheet bio-picker">
            ${items.map((m, i) => {
              const already = taken.has(m.id);
              const n = sel.indexOf(m.id);
              return html`<${Frame}
                key=${m.id}
                src=${imageOf(m)}
                alt=${(m.caption || '').slice(0, 80)}
                number=${i + 1}
                label=${m.timestamp ? formatDay(m.timestamp, tz) : ''}
                kind=${m.mediaType === 'CAROUSEL_ALBUM' ? 'carousel' : m.productType === 'REELS' ? 'reel' : undefined}
                selected=${n >= 0}
                badge=${already ? 'In grid' : n >= 0 ? `#${n + 1}` : ''}
                onClick=${already ? undefined : () => toggle(m.id)}
                aria-label=${`${n >= 0 ? 'Deselect' : 'Select'} post from ${m.timestamp ? formatDay(m.timestamp, tz) : 'unknown date'}`}
              />`;
            })}
          </div>`
      : html`<${EmptyState} icon="grid" title="No Instagram posts yet"
          body="The worker saves your recent posts when it takes its analytics snapshot. Run it from Settings → Worker, then come back." />`}
  <//>`;
}

function LinkEditor({ link, index, count, errors, onChange, onMove, onRemove }) {
  const [utmOpen, setUtmOpen] = useState(() => Object.values(link.utm || {}).some(Boolean));
  const e = errors || {};
  const final = withUtm(link.url, link.utm);
  return html`<li class=${cx('bio-link-edit', !link.enabled && 'is-hidden')}>
    <div class="bio-link-top">
      <span class="bio-link-no mono" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
      <div class="bio-link-fields">
        <${Field} label="Label" error=${e.title}>
          <${TextInput} value=${link.title} onChange=${(v) => onChange({ title: v })} placeholder="Shop the new collection" maxlength="80" />
        <//>
        <${Field} label="Address" error=${e.url}>
          <${TextInput} type="url" inputmode="url" value=${link.url} onChange=${(v) => onChange({ url: v })}
            onBlur=${() => link.url && fixUrl(link.url) !== link.url && onChange({ url: fixUrl(link.url) })}
            placeholder="https://" autocomplete="off" spellcheck=${false} />
        <//>
      </div>
    </div>
    <div class="bio-link-actions">
      <${Toggle} checked=${link.enabled} onChange=${(v) => onChange({ enabled: v })} label="Show" />
      <${Toggle} checked=${link.highlight} onChange=${(v) => onChange({ highlight: v })} label="Highlight" />
      <button type="button" class="link-btn" aria-expanded=${utmOpen ? 'true' : 'false'} onClick=${() => setUtmOpen((o) => !o)}>
        <${Icon} name=${utmOpen ? 'chevron-up' : 'chevron-down'} size=${14} />UTM tags
      </button>
      <span class="spacer"></span>
      <${IconButton} icon="arrow-up" size="sm" label=${`Move "${link.title || 'link'}" up`} disabled=${index === 0} onClick=${() => onMove(-1)} />
      <${IconButton} icon="arrow-down" size="sm" label=${`Move "${link.title || 'link'}" down`} disabled=${index === count - 1} onClick=${() => onMove(1)} />
      <${IconButton} icon="trash" size="sm" label=${`Delete "${link.title || 'link'}"`} onClick=${onRemove} />
    </div>
    ${!link.enabled ? html`<p class="muted text-sm bio-link-private">Hidden from your page. Its address stays private and is not in the public page file.</p>` : null}
    ${utmOpen
      ? html`<div class="bio-utm">
          <div class="grid-3">
            <${Field} label="Source"><${TextInput} value=${link.utm.source} onChange=${(v) => onChange({ utm: { ...link.utm, source: v } })} placeholder="instagram" /><//>
            <${Field} label="Medium"><${TextInput} value=${link.utm.medium} onChange=${(v) => onChange({ utm: { ...link.utm, medium: v } })} placeholder="social" /><//>
            <${Field} label="Campaign"><${TextInput} value=${link.utm.campaign} onChange=${(v) => onChange({ utm: { ...link.utm, campaign: v } })} placeholder="link_in_bio" /><//>
          </div>
          <p class="bio-utm-final"><span class="muted">Visitors go to</span> <span class="mono break">${final || '—'}</span></p>
        </div>`
      : null}
  </li>`;
}

export default function LinkInBio() {
  const { session, settings, toast, confirm, tz } = useApp();
  const { data: bio, loading, error } = useDoc('bio');
  const { data: media } = useDoc('analytics-media');
  const savedHidden = settings && settings.bioHiddenLinks;
  const base = useMemo(() => (bio ? normalize(bio, savedHidden) : null), [bio, savedHidden]);
  const [draft, setDraft] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tab, setTab] = useState('edit');
  const phone = usePhone();
  const fileRef = useRef(null);
  const doc = draft || base;
  const avatarUrl = useAvatarUrl(doc && doc.avatarUrl);
  const url = bioPageUrl();

  if (error && !bio) {
    return html`<div class="page"><${PageHeader} title="Link in bio" /><${Callout} tone="danger" title="Could not load your link-in-bio page">${error.message || String(error)}. Reload to try again.<//></div>`;
  }
  if (loading || !doc) {
    return html`<div class="page"><${PageHeader} title="Link in bio" /><${Skeleton} lines=${6} /></div>`;
  }

  const dirty = !!draft;
  const published = !!(bio && bio.published);
  const edit = (fn) => {
    setDraft((d) => {
      const next = structuredClone(d || base);
      fn(next);
      return next;
    });
  };
  const editLink = (id, patch) => {
    edit((d) => {
      const l = d.links.find((x) => x.id === id);
      if (l) Object.assign(l, patch);
    });
    if (errors[id]) setErrors((e) => ({ ...e, [id]: undefined }));
  };
  const move = (key, id, dir) =>
    edit((d) => {
      const list = d[key];
      const i = list.findIndex((x) => x.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
    });

  async function save(publish) {
    const current = doc;
    const errs = validateBio(current);
    setErrors(errs);
    if (Object.keys(errs).length) {
      toast('Fix the highlighted fields first.', { kind: 'error' });
      return;
    }
    const out = publishable(current);
    const hidden = hiddenLinks(current);
    const now = new Date().toISOString();
    setBusy(publish === true ? 'publish' : 'save');
    try {
      await transact(async (tx) => {
        const d = await tx.read('bio');
        d.title = out.title;
        d.bio = out.bio;
        d.theme = out.theme;
        d.accent = out.accent;
        d.links = out.links;
        // Keep image URLs the worker refreshed meanwhile (Instagram image links expire).
        d.grid = out.grid.map((g) => {
          const cur = (d.grid || []).find((x) => x.id === g.id);
          return cur ? { ...g, imageUrl: cur.imageUrl || g.imageUrl, permalink: cur.permalink || g.permalink } : g;
        });
        if (publish === true) d.published = true;
        d.updatedAt = now;
        tx.write('bio', d);
        const s = await tx.read('settings');
        if (hidden.length || (s.bioHiddenLinks && s.bioHiddenLinks.length)) {
          s.bioHiddenLinks = hidden;
          tx.write('settings', s);
        }
      }, { message: publish ? 'publish link in bio' : 'save link in bio' });
      setDraft(null);
      toast(publish === true ? (published ? 'Changes are live.' : 'Your page is live.') : 'Draft saved.', { kind: 'success' });
    } catch {
      /* transact showed the error */
    } finally {
      setBusy('');
    }
  }

  async function unpublish() {
    const ok = await confirm({
      title: 'Unpublish your link-in-bio page?',
      body: 'Visitors will see "This page is not published yet" until you publish again. Your links and settings are kept.',
      confirmLabel: 'Unpublish',
      danger: true,
    });
    if (!ok) return;
    setBusy('unpublish');
    try {
      await mutate('bio', (d) => {
        d.published = false;
        d.updatedAt = new Date().toISOString();
      }, { message: 'unpublish link in bio' });
      toast('Your page is offline.', { kind: 'success' });
    } catch {
      /* shown */
    } finally {
      setBusy('');
    }
  }

  async function discard() {
    const ok = await confirm({ title: 'Discard your changes?', body: 'The editor goes back to the saved version.', confirmLabel: 'Discard', danger: true });
    if (ok) {
      setDraft(null);
      setErrors({});
    }
  }

  async function uploadAvatar(file) {
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif|heic|heif|avif)$/i.test(file.name || '')) {
      toast(`"${file.name}" is not a photo. Choose a JPEG or PNG.`, { kind: 'error' });
      return;
    }
    setBusy('avatar');
    try {
      const bmp = await loadBitmap(file);
      const { blob } = await renderJpeg(bmp, { aspect: 1, maxSide: 480, quality: 0.86 });
      if (bmp.close) bmp.close();
      const bytes = await blobBytes(blob);
      const path = `public/bio/avatar-${Date.now().toString(36)}.jpg`;
      await transact(async (tx) => {
        const d = await tx.read('bio');
        const old = d.avatarUrl;
        tx.writePublic(path, bytes);
        if (old && old.startsWith('public/bio/') && old !== path && tx.exists(old)) tx.delete(old);
        d.avatarUrl = path;
        d.updatedAt = new Date().toISOString();
        tx.write('bio', d);
      }, { message: 'link in bio photo' });
      setDraft((d) => (d ? { ...d, avatarUrl: path } : d));
      toast(published ? 'Photo updated on your live page.' : 'Photo saved.', { kind: 'success' });
    } catch (err) {
      toast(err.message || String(err), { kind: 'error' });
    } finally {
      setBusy('');
    }
  }

  async function removeAvatar() {
    const ok = await confirm({ title: 'Remove the photo?', body: 'Your page shows your initials instead.', confirmLabel: 'Remove photo', danger: true });
    if (!ok) return;
    setBusy('avatar');
    try {
      await transact(async (tx) => {
        const d = await tx.read('bio');
        if (d.avatarUrl && d.avatarUrl.startsWith('public/bio/') && tx.exists(d.avatarUrl)) tx.delete(d.avatarUrl);
        d.avatarUrl = '';
        d.updatedAt = new Date().toISOString();
        tx.write('bio', d);
      }, { message: 'remove link in bio photo' });
      setDraft((d) => (d ? { ...d, avatarUrl: '' } : d));
      toast('Photo removed.', { kind: 'success' });
    } catch {
      /* shown */
    } finally {
      setBusy('');
    }
  }

  const resolve = (p) => (p && p === doc.avatarUrl && avatarUrl ? avatarUrl : publicFileUrl(session, p));
  const room = MAX_GRID - doc.grid.length;

  const actions = html`
    ${published ? html`<${Badge} tone="success" icon="check">Live<//>` : html`<${Badge} tone="neutral">Not published<//>`}
    ${published
      ? html`<${Button} variant="ghost" loading=${busy === 'unpublish'} onClick=${unpublish}>Unpublish<//>
          <${Button} variant="primary" icon="upload" loading=${busy === 'publish'} disabled=${!dirty} onClick=${() => save(true)}>Publish changes<//>`
      : html`<${Button} variant="secondary" loading=${busy === 'save'} disabled=${!dirty} onClick=${() => save(false)}>Save draft<//>
          <${Button} variant="primary" icon="upload" loading=${busy === 'publish'} onClick=${() => save(true)}>Publish<//>`}`;

  const form = html`<div class="bio-form">
    <${Panel} title="Profile">
      <div class="stack">
        <div class="bio-avatar-row">
          <span class="bio-avatar-thumb">
            ${avatarUrl ? html`<img src=${avatarUrl} alt="Current photo" />` : html`<${Icon} name="user" size=${22} />`}
          </span>
          <div class="stack-sm stack">
            <div class="row">
              <${Button} size="sm" variant="secondary" icon="upload" loading=${busy === 'avatar'} onClick=${() => fileRef.current && fileRef.current.click()}>
                ${doc.avatarUrl ? 'Change photo' : 'Upload photo'}
              <//>
              ${doc.avatarUrl ? html`<${Button} size="sm" variant="ghost" disabled=${busy === 'avatar'} onClick=${removeAvatar}>Remove<//>` : null}
            </div>
            <span class="muted text-sm">Square crop, saved right away${published ? ' to your live page' : ''}.</span>
          </div>
          <input ref=${fileRef} type="file" accept="image/*" class="sr-only" tabindex="-1" aria-hidden="true"
            onChange=${(e) => {
              const f = e.currentTarget.files && e.currentTarget.files[0];
              e.currentTarget.value = '';
              uploadAvatar(f);
            }} />
        </div>
        <${Field} id="bio-title" label="Title" hint="Your name or brand, shown in large type.">
          <${TextInput} value=${doc.title} onChange=${(v) => edit((d) => (d.title = v))} placeholder="Studio North" maxlength="80" />
        <//>
        <${Field} id="bio-text" label="Short bio" hint="One or two lines about you. Line breaks are kept.">
          <${TextArea} value=${doc.bio} onChange=${(v) => edit((d) => (d.bio = v))} rows=${2} maxRows=${6} maxlength="300" />
        <//>
      </div>
    <//>

    <${Panel} title="Links" subtitle="Buttons in the order shown. Highlight the one that matters most."
      actions=${html`<${Button} size="sm" variant="secondary" icon="plus"
        onClick=${() => edit((d) => d.links.push({ id: uid('bl_'), title: '', url: '', enabled: true, highlight: false, utm: { source: '', medium: '', campaign: '' } }))}>Add link<//>`}>
      ${doc.links.length
        ? html`<ol class="bio-links-edit">
            ${doc.links.map(
              (l, i) => html`<${LinkEditor}
                key=${l.id}
                link=${l}
                index=${i}
                count=${doc.links.length}
                errors=${errors[l.id]}
                onChange=${(patch) => editLink(l.id, patch)}
                onMove=${(dir) => move('links', l.id, dir)}
                onRemove=${async () => {
                  const ok = await confirm({ title: `Delete "${l.title || 'this link'}"?`, body: 'It disappears from your page after you publish.', confirmLabel: 'Delete link', danger: true });
                  if (ok) edit((d) => (d.links = d.links.filter((x) => x.id !== l.id)));
                }}
              />`,
            )}
          </ol>`
        : html`<${EmptyState} compact icon="link" title="No links yet" body="Add your shop, booking page, newsletter or latest video." />`}
      <p class="muted text-sm bio-note">
        <${Icon} name="info" size=${14} /> This page is static, so Postpilot cannot count clicks on each link. Instagram reports taps on the link in your bio
        as "profile link taps" in Analytics; UTM tags let your shop's analytics see where visitors came from.
      </p>
    <//>

    <${Panel} title="Post grid" subtitle=${`Recent posts shown under your links (up to ${MAX_GRID}).`}
      actions=${html`<${Button} size="sm" variant="secondary" icon="grid" disabled=${room <= 0} onClick=${() => setPickerOpen(true)}>Choose posts<//>`}>
      ${doc.grid.length
        ? html`<ul class="bio-grid-edit">
            ${doc.grid.map(
              (g, i) => html`<li key=${g.id} class="bio-grid-row">
                <span class="bio-grid-thumb">${g.imageUrl ? html`<img src=${g.imageUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />` : html`<${Icon} name="image" />`}</span>
                <${Field} class="grow" label=${`Tile ${i + 1} opens`} error=${errors[g.id] && errors[g.id].url}
                  hint=${!g.url || g.url === g.permalink ? 'The post on Instagram.' : null}>
                  <${TextInput} type="url" value=${g.url || ''} placeholder=${g.permalink || 'https://'}
                    onChange=${(v) => edit((d) => {
                      const t = d.grid.find((x) => x.id === g.id);
                      if (t) t.url = v;
                    })}
                    onBlur=${() => g.url && fixUrl(g.url) !== g.url && edit((d) => {
                      const t = d.grid.find((x) => x.id === g.id);
                      if (t) t.url = fixUrl(t.url);
                    })} />
                <//>
                <div class="bio-grid-tools">
                  <${IconButton} icon="arrow-up" size="sm" label=${`Move tile ${i + 1} up`} disabled=${i === 0} onClick=${() => move('grid', g.id, -1)} />
                  <${IconButton} icon="arrow-down" size="sm" label=${`Move tile ${i + 1} down`} disabled=${i === doc.grid.length - 1} onClick=${() => move('grid', g.id, 1)} />
                  <${IconButton} icon="x" size="sm" label=${`Remove tile ${i + 1}`} onClick=${() => edit((d) => (d.grid = d.grid.filter((x) => x.id !== g.id)))} />
                </div>
              </li>`,
            )}
          </ul>`
        : html`<${EmptyState} compact icon="grid" title="No posts in the grid" body="Show your latest posts as a tappable grid, like your profile."
            action=${html`<${Button} size="sm" variant="secondary" onClick=${() => setPickerOpen(true)}>Choose posts<//>`} />`}
    <//>

    <${Panel} title="Look">
      <div class="stack">
        <${Field} label="Theme">
          <${Segmented} label="Theme" value=${doc.theme} onChange=${(v) => edit((d) => (d.theme = v))}
            options=${[{ value: 'paper', label: 'Paper', icon: 'sun' }, { value: 'ink', label: 'Ink', icon: 'moon' }]} />
        <//>
        <${Field} label="Accent color" hint="Used for highlighted links.">
          <div class="bio-accents">
            ${ACCENTS.map(
              (c) => html`<button key=${c} type="button" class=${cx('bio-swatch', doc.accent.toLowerCase() === c && 'is-selected')} style=${{ '--swatch': c }}
                aria-label=${`Accent ${c}`} aria-pressed=${doc.accent.toLowerCase() === c ? 'true' : 'false'} onClick=${() => edit((d) => (d.accent = c))}></button>`,
            )}
            <label class="bio-color">
              <input type="color" value=${doc.accent} onInput=${(e) => {
                const v = e.currentTarget.value;
                edit((d) => (d.accent = v));
              }} />
              <span class="mono text-sm">${doc.accent.toUpperCase()}</span>
              <span class="sr-only">Custom accent color</span>
            </label>
          </div>
        <//>
        ${contrastInk(doc.accent) === '#121517' && doc.theme === 'paper'
          ? html`<p class="muted text-sm">Light accents get dark text on highlighted buttons so they stay readable.</p>`
          : null}
      </div>
    <//>
    ${dirty
    ? html`<div class="bio-savebar" role="region" aria-label="Unsaved changes">
        <span><${Icon} name="edit" size=${15} /> Unsaved changes</span>
        <span class="spacer"></span>
        <${Button} size="sm" variant="ghost" onClick=${discard}>Discard<//>
        ${published
          ? html`<${Button} size="sm" variant="primary" loading=${busy === 'publish'} onClick=${() => save(true)}>Publish changes<//>`
          : html`<${Button} size="sm" variant="secondary" loading=${busy === 'save'} onClick=${() => save(false)}>Save draft<//>`}
      </div>`
    : null}
  </div>`;

  const preview = html`<aside class="bio-preview" aria-label="Preview">
    <div class="bio-phone">
      <div class="bio-phone-screen">
        <${BioView} doc=${doc} preview resolveUrl=${resolve} />
      </div>
    </div>
    <p class="muted text-sm bio-preview-note">${dirty ? 'Preview of your unsaved changes.' : published ? 'This is what visitors see.' : 'Preview. Publish to make it visible.'}</p>
  </aside>`;

  return html`<div class="page bio-editor">
    <${PageHeader} title="Link in bio" subtitle="One page for the link in your Instagram bio. Anyone can open it; no login needed." actions=${actions} />

    <section class="panel bio-url" aria-label="Public address">
      <div class="panel-body">
        <div class="bio-url-row">
          <${Icon} name="globe" />
          <a class="mono bio-url-link" href=${url} target="_blank" rel="noopener noreferrer">${url}<span class="sr-only"> (opens in a new tab)</span></a>
          <div class="row">
            <${CopyButton} text=${url} label="Copy link" />
            <${Button} size="sm" variant="ghost" icon="external" href=${url} target="_blank" rel="noopener noreferrer">Open<//>
          </div>
        </div>
        <p class="muted text-sm">
          ${published
            ? html`Live${bio.updatedAt ? `, last published ${relative(bio.updatedAt)}` : ''}. Add it to your profile in the Instagram app: <strong>Edit profile</strong> → <strong>Links</strong> → <strong>Add external link</strong>.`
            : 'Not published yet: visitors see a "not published" note. Everything here except hidden links is stored in a public file, so keep private notes elsewhere.'}
        </p>
      </div>
    </section>

    ${phone
      ? html`<${Segmented} label="Editor view" value=${tab} onChange=${setTab}
          options=${[{ value: 'edit', label: 'Edit', icon: 'edit' }, { value: 'preview', label: 'Preview', icon: 'eye' }]} />`
      : null}

    <div class="bio-layout">
      ${!phone || tab === 'edit' ? form : null}
      ${!phone || tab === 'preview' ? preview : null}
    </div>


    <${GridPicker}
      open=${pickerOpen}
      onClose=${() => setPickerOpen(false)}
      media=${media}
      existing=${doc.grid}
      room=${Math.max(0, room)}
      tz=${tz}
      onAdd=${(picked) => {
        edit((d) => {
          for (const m of picked) {
            if (d.grid.length >= MAX_GRID || d.grid.some((g) => g.igMediaId === m.id)) continue;
            d.grid.push({
              id: uid('bg_'),
              igMediaId: m.id,
              imageUrl: imageOf(m),
              url: m.permalink || '',
              permalink: m.permalink || '',
              alt: String(m.caption || '').replace(/\s+/g, ' ').slice(0, 120),
            });
          }
        });
        setPickerOpen(false);
      }}
    />
  </div>`;
}
