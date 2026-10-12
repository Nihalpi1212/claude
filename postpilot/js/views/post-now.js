// Post by hand (#/post-now/<postId>): opened from a reminder notification, the Today screen or the
// composer. For reminder posts (publishMode 'reminder'): what Instagram's API cannot post (music from
// Instagram's library, link stickers, polls, product tags, filters) the owner posts in the Instagram
// app. The page saves the media to the phone, copies the caption and first comment, opens Instagram,
// and records the result ("Mark as posted") or asks for another reminder in an hour.
// Phone first: one column of numbered steps.

import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { addHistory } from '../../core/model.js';
import { formatDateTime, relative } from '../../core/time.js';
import { useApp } from '../app.js';
import { loadViewCss } from '../css.js';
import { getStore, mutate, readDoc, transact, useDocs } from '../data.js';
import { saveBlob } from '../media.js';
import { reminderDelivery } from '../push.js';
import { useAssetUrl } from '../ui/media-picker.js';
import { Button, Callout, EmptyState, Field, Icon, PageHeader, Skeleton, StatusPill, TextInput, cx } from '../ui/kit.js';

loadViewCss('post-now');

const TYPE_NAME = { feed: 'post', carousel: 'carousel', reel: 'reel', story: 'story' };
const INSTAGRAM_URL = 'https://www.instagram.com/';
const PERMALINK_RE = /^https:\/\/(www\.)?instagram\.com\/\S+$/i;
// Statuses a post can be posted by hand from ('publishing' belongs to the worker).
const OPEN = ['reminded', 'scheduled', 'draft', 'failed'];

const errText = (err) => (err && (err.userMessage || err.message)) || String(err);

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

/** "postpilot-1-vase-trio.jpg": a file name the phone's photo library and Instagram accept. */
export function fileNameFor(asset, index) {
  const slug = String((asset && asset.name) || 'media')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'media';
  const mime = String((asset && asset.mime) || '');
  const ext = asset && asset.kind === 'video' ? (mime === 'video/quicktime' ? 'mov' : 'mp4') : 'jpg';
  return `postpilot-${index + 1}-${slug}.${ext}`;
}

/** Copy text to the clipboard; falls back to selecting it in `el` (a textarea) and execCommand. */
async function copyText(text, el) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* no clipboard permission (or an older browser): select the text instead */
  }
  if (el) {
    el.focus();
    el.select();
    el.setSelectionRange(0, text.length);
    try {
      if (document.execCommand('copy')) return true;
    } catch {
      /* not supported */
    }
  }
  return false;
}

/**
 * Decrypt the post's originals into File objects ahead of time, so "Save to phone" can call
 * navigator.share right inside the tap (browsers only allow it during a user gesture).
 * Returns {status: 'loading'|'ready'|'error', items: [{file, url, asset, ref, problem}], error}.
 */
function useOriginals(post, assetsById) {
  const [state, setState] = useState({ status: 'loading', items: [], error: null });
  const refs = (post && post.media) || [];
  const key = refs.map((m) => `${m.assetId || m.remoteUrl}:${(assetsById.get(m.assetId) || {}).importUrl ? 'i' : ''}`).join('|');
  useEffect(() => {
    if (!post) return undefined;
    let alive = true;
    const urls = [];
    setState({ status: 'loading', items: [], error: null });
    (async () => {
      const items = [];
      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        const asset = ref.assetId ? assetsById.get(ref.assetId) : null;
        if (!asset) {
          items.push({ ref, asset: null, file: null, url: null, problem: ref.remoteUrl ? 'remote' : 'missing' });
          continue;
        }
        if (asset.importUrl) {
          items.push({ ref, asset, file: null, url: null, problem: asset.importError ? 'import_failed' : 'importing' });
          continue;
        }
        if (asset.originalRemovedAt) {
          items.push({ ref, asset, file: null, url: null, problem: 'removed' });
          continue;
        }
        const bytes = await getStore().readBytes(asset.path);
        if (!bytes) {
          items.push({ ref, asset, file: null, url: null, problem: 'missing' });
          continue;
        }
        const type = asset.mime || (asset.kind === 'video' ? 'video/mp4' : 'image/jpeg');
        const file = new File([bytes], fileNameFor(asset, i), { type });
        const url = URL.createObjectURL(file);
        urls.push(url);
        items.push({ ref, asset, file, url, problem: null });
      }
      if (alive) setState({ status: 'ready', items, error: null });
    })().catch((err) => alive && setState({ status: 'error', items: [], error: errText(err) }));
    return () => {
      alive = false;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [post && post.id, key]);
  return state;
}

const PROBLEM_TEXT = {
  remote: 'This item is a link, not a file in your library. Open it and save it from there.',
  missing: 'This file is missing from your library.',
  importing: 'The worker has not downloaded this file from its link yet.',
  import_failed: 'This file could not be downloaded from its link.',
  removed: 'The original was removed to save space. Only a small preview is left.',
};

function MediaItem({ item, index, count }) {
  const thumb = useAssetUrl(item.asset && !item.asset.importUrl ? item.asset : null, 'thumb');
  const isVideo = (item.asset && item.asset.kind === 'video') || item.ref.kind === 'video';
  const label = `${isVideo ? 'Video' : 'Photo'} ${index + 1} of ${count}`;
  return html`<li class=${cx('pn-media-item', item.problem && 'has-problem')}>
    <div class="pn-media-box">
      ${isVideo && item.url
        ? html`<video src=${item.url} poster=${thumb || undefined} controls playsinline preload="metadata" aria-label=${label}></video>`
        : item.url || thumb
          ? html`<img src=${item.url || thumb} alt=${item.ref.altText || label} />`
          : item.problem === 'remote'
            ? html`<img src=${item.ref.remoteUrl} alt=${item.ref.altText || label} referrerpolicy="no-referrer" />`
            : html`<span class="pn-media-blank"><${Icon} name=${isVideo ? 'video' : 'image'} size=${22} /></span>`}
      ${count > 1 ? html`<span class="pn-media-no mono">${String(index + 1).padStart(2, '0')}</span>` : null}
    </div>
    ${item.problem
      ? html`<p class="pn-media-problem text-sm">
          <${Icon} name="alert" size=${14} /><span>${PROBLEM_TEXT[item.problem]}</span>
          ${item.problem === 'remote' ? html` <a href=${item.ref.remoteUrl} target="_blank" rel="noopener noreferrer">Open the image</a>` : null}
        </p>`
      : null}
  </li>`;
}

function CopyBlock({ id, label, text, buttonLabel, toast, onCopied, secondary = false }) {
  const ref = useRef(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(t);
  }, [copied]);
  const rows = Math.min(10, Math.max(2, text.split('\n').length + Math.floor(text.length / 60)));
  return html`<div class="pn-copy">
    <label class="pn-copy-label label-caps" for=${id}>${label}</label>
    <textarea id=${id} ref=${ref} class="pn-copy-text" readonly rows=${rows} value=${text}></textarea>
    <div class="row">
      <${Button} variant=${copied || secondary ? 'secondary' : 'primary'} icon=${copied ? 'check' : 'copy'}
        onClick=${async () => {
          const ok = await copyText(text, ref.current);
          if (ok) {
            setCopied(true);
            onCopied && onCopied();
            toast(`${label} copied.`, { kind: 'success', duration: 2500 });
          } else {
            toast('Your browser did not allow copying. The text is selected: copy it from the menu.', { kind: 'info' });
          }
        }}>${copied ? 'Copied' : buttonLabel}<//>
      <span class="text-xs muted mono num">${text.length} characters</span>
    </div>
  </div>`;
}

/** What else to add in the Instagram app, from the post's details. */
function extrasOf(post) {
  const out = [];
  if (post.location && (post.location.name || post.location.id)) out.push(['map-pin', `Location: ${post.location.name || post.location.id}`]);
  const collabs = (post.collaborators || []).filter(Boolean);
  if (collabs.length) out.push(['users', `Invite collaborators: ${collabs.map((c) => `@${c}`).join(', ')}`]);
  const tags = [...new Set((post.userTags || []).map((t) => t.username).filter(Boolean))];
  if (tags.length) out.push(['at', `Tag people: ${tags.map((t) => `@${t}`).join(', ')}`]);
  if (post.aiGenerated) out.push(['sparkle', 'Turn on the "AI info" label']);
  if (post.type === 'reel' && post.trialReel) out.push(['eye', 'Share it as a trial reel']);
  if (post.type === 'reel' && post.shareToFeed === false) out.push(['grid', 'Turn off "Also share to feed"']);
  return out;
}

function Step({ n, title, done, children }) {
  return html`<li class=${cx('pn-step', done && 'is-done')}>
    <span class="pn-step-no mono" aria-hidden="true">${done ? html`<${Icon} name="check" size=${14} strokeWidth=${2.5} />` : String(n).padStart(2, '0')}</span>
    <div class="pn-step-body">
      <h2 class="pn-step-title">${title}</h2>
      ${children}
    </div>
  </li>`;
}

export default function PostNow() {
  const { route, tz, toast, navigate, openComposer, settings } = useApp();
  const postId = route.params[0] || '';
  const { data, error } = useLoadedDocs(['posts', 'library']);
  const posts = (data.posts && data.posts.posts) || [];
  const post = posts.find((p) => p.id === postId) || null;
  const assetsById = useMemo(() => new Map(((data.library && data.library.assets) || []).map((a) => [a.id, a])), [data.library]);
  const originals = useOriginals(data.library ? post : null, assetsById);
  const [saved, setSaved] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    document.title = 'Post by hand · Postpilot';
  }, []);

  if (error && !data.posts) {
    return html`<div class="page pn"><${Callout} tone="danger" title="Your posts could not be loaded">${errText(error)} Reload the page to try again.<//></div>`;
  }
  if (!data.posts || !data.library) {
    return html`<div class="page pn"><${Skeleton} height=${28} width="60%" /><${Skeleton} height=${260} /><${Skeleton} lines=${4} /></div>`;
  }
  if (!post) {
    return html`<div class="page pn">
      <${EmptyState} icon="search" title="This post is not in Postpilot"
        body="It may have been deleted, or the link is incomplete."
        action=${html`<${Button} variant="primary" href="#/planner">Open the planner<//>`} />
    </div>`;
  }

  const what = TYPE_NAME[post.type] || 'post';
  if (!OPEN.includes(post.status)) {
    const body =
      post.status === 'published'
        ? html`<${Callout} tone="success" title="Already posted"
            action=${post.permalink ? html`<${Button} size="sm" variant="secondary" icon="external" href=${post.permalink} target="_blank" rel="noopener noreferrer">View on Instagram<//>` : null}>
            ${post.publishedAt ? `This ${what} went up ${formatDateTime(post.publishedAt, tz)}.` : `This ${what} is already on Instagram.`} There is nothing left to do.
          <//>`
        : post.status === 'publishing'
          ? html`<${Callout} tone="marker" title="Postpilot is publishing this ${what}">It publishes automatically, so there is nothing to post by hand.<//>`
          : html`<${Callout} tone="neutral" title="This ${what} was canceled">It will not be posted. Duplicate it in the composer to use it again.<//>`;
    return html`<div class="page pn">
      <${PageHeader} eyebrow="Post by hand" title=${`Your ${what}`} />
      ${body}
      <div class="row pn-after">
        <${Button} variant="secondary" icon="home" href="#/">Back to Today<//>
        <${Button} variant="ghost" onClick=${() => openComposer(post.id)}>Open the post<//>
      </div>
    </div>`;
  }

  const items = originals.items;
  const files = items.map((i) => i.file).filter(Boolean);
  const problems = items.filter((i) => i.problem);
  const caption = (post.caption || '').trim();
  const firstComment = (post.firstComment || '').trim();
  const extras = extrasOf(post);
  const delivery = reminderDelivery(settings);
  const auto = post.publishMode !== 'reminder';
  const videos = items.filter((i) => (i.asset ? i.asset.kind : i.ref.kind) === 'video').length;
  const mediaWord =
    items.length <= 1
      ? videos ? 'video' : 'photo'
      : `${items.length} ${videos === items.length ? 'videos' : videos ? 'photos and videos' : 'photos'}`;

  const saveToPhone = async () => {
    if (!files.length) return;
    // navigator.share must run inside the tap, so the files were prepared when the page opened.
    if (navigator.canShare && navigator.share && navigator.canShare({ files })) {
      try {
        await navigator.share({ files });
        setSaved(true);
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // closed the share sheet
        /* sharing refused: download instead */
      }
    }
    for (const f of files) saveBlob(f, f.name);
    setSaved(true);
    toast(files.length === 1 ? 'Downloaded the file.' : `Downloaded ${files.length} files.`, { kind: 'success' });
  };

  const markPosted = async () => {
    const url = link.trim();
    if (url && !PERMALINK_RE.test(url)) {
      setLinkError('Paste the link to the post, starting with https://www.instagram.com/, or leave this empty.');
      return;
    }
    setLinkError('');
    setBusy('posted');
    try {
      await transact(
        async (tx) => {
          const doc = await tx.read('posts');
          const p = doc.posts.find((x) => x.id === post.id);
          if (!p) throw new Error('This post no longer exists.');
          if (p.status === 'published') return;
          if (!OPEN.includes(p.status)) throw new Error(p.status === 'publishing' ? 'Postpilot is publishing this post right now.' : 'This post was canceled.');
          p.status = 'published';
          p.publishedAt = new Date().toISOString();
          if (url) p.permalink = url;
          p.lastError = null;
          addHistory(p, 'posted by hand', url ? 'Link to the post saved.' : undefined);
          tx.write('posts', doc);
          // Library: remember which posts used each file (as the worker does after publishing).
          const lib = await tx.read('library');
          const ids = new Set([...(p.media || []).map((m) => m.assetId), p.coverAssetId].filter(Boolean));
          let changed = false;
          for (const a of lib.assets || []) {
            if (!ids.has(a.id)) continue;
            a.usedBy = a.usedBy || [];
            if (!a.usedBy.includes(p.id)) {
              a.usedBy.push(p.id);
              changed = true;
            }
          }
          if (changed) tx.write('library', lib);
          // Evergreen queue: count the use, or drop the item when the queue does not repeat (as the
          // worker does after publishing, worker/jobs/publish.mjs finishPublished), so it is not
          // planned again once this post moves to the archive.
          if (p.listId && p.listItemId) {
            const lists = await tx.read('lists');
            const list = (lists.lists || []).find((l) => l.id === p.listId);
            const idx = list ? (list.items || []).findIndex((it) => it.id === p.listItemId) : -1;
            if (idx >= 0) {
              if (list.repeat === false) list.items.splice(idx, 1);
              else {
                list.items[idx].timesUsed = (list.items[idx].timesUsed || 0) + 1;
                list.items[idx].lastUsedAt = p.publishedAt;
              }
              tx.write('lists', lists);
            }
          }
        },
        { message: 'post by hand: posted', silent: true },
      );
      toast('Marked as posted.', { kind: 'success' });
    } catch (err) {
      toast(errText(err), { kind: 'error' });
    } finally {
      setBusy('');
    }
  };

  const remindLater = async () => {
    setBusy('later');
    const at = new Date(Date.now() + 36e5).toISOString();
    try {
      await mutate(
        'posts',
        (doc) => {
          const p = doc.posts.find((x) => x.id === post.id);
          if (!p) throw new Error('This post no longer exists.');
          if (p.status !== 'reminded' && p.status !== 'scheduled') throw new Error('This post is no longer waiting to be posted.');
          p.status = 'scheduled';
          p.publishMode = 'reminder';
          p.scheduledAt = at;
          p.reminderSentAt = null;
          p.needsApproval = false;
          addHistory(p, 'remind again', 'In 1 hour.');
        },
        { message: 'post by hand: remind again', silent: true },
      );
      toast(`You will get another reminder ${formatDateTime(at, tz)}.`, { kind: 'success' });
      navigate('#/');
    } catch (err) {
      toast(errText(err), { kind: 'error' });
    } finally {
      setBusy('');
    }
  };

  // "Post by hand now" in the composer opens this page without a reminder (reminderSentAt stays null).
  const subtitle =
    post.status === 'reminded'
      ? `${post.reminderSentAt ? `Reminder sent ${relative(post.reminderSentAt)}. ` : ''}Follow the steps, then mark it as posted.`
      : post.scheduledAt
        ? `${post.status === 'scheduled' ? 'Scheduled' : 'Planned'} for ${formatDateTime(post.scheduledAt, tz)}. You can post it now.`
        : 'Follow the steps, then mark it as posted.';

  return html`<div class="page pn">
    <${PageHeader} eyebrow="Post by hand" title=${`Post your ${what}`} subtitle=${subtitle}>
      <div class="pn-status"><${StatusPill} status=${post.status === 'reminded' ? 'needs-approval' : post.status} label=${post.status === 'reminded' ? 'Waiting for you' : undefined} /></div>
    <//>

    ${auto && post.status === 'scheduled'
      ? html`<${Callout} tone="info" title="This post publishes automatically">Postpilot posts it at its time. Post it here only if you want to do it yourself; then mark it as posted so it is not published twice.<//>`
      : null}
    ${post.notes && post.notes.trim() ? html`<${Callout} tone="marker" title="Your notes" icon="file"><span class="pre-wrap">${post.notes}</span><//>` : null}

    <ol class="pn-steps">
      <${Step} n=${1} title=${`Save the ${mediaWord} to your phone`} done=${saved}>
        ${originals.status === 'loading'
          ? html`<div class="pn-media-loading"><${Skeleton} height=${220} /></div>`
          : originals.status === 'error'
            ? html`<${Callout} tone="danger" title="Could not open the media">${originals.error}<//>`
            : html`<ul class=${cx('pn-media', items.length > 1 && 'is-multi')} aria-label="Media">
                ${items.map((it, i) => html`<${MediaItem} key=${i} item=${it} index=${i} count=${items.length} />`)}
              </ul>`}
        <div class="row">
          <${Button} variant="primary" icon="download" onClick=${saveToPhone}
            disabled=${originals.status !== 'ready' || !files.length} loading=${originals.status === 'loading'}>Save to phone<//>
        </div>
        <p class="text-sm muted">On a phone, choose “Save image” or “Save to Photos” in the share sheet. On a computer the files download.${post.type === 'carousel' ? ' Keep them in this order.' : ''}</p>
        ${problems.length && originals.status === 'ready' && !files.length ? html`<p class="text-sm text-bad">Nothing can be saved from here yet.</p>` : null}
      <//>

      ${caption || firstComment
        ? html`<${Step} n=${2} title=${post.type === 'story' ? 'Copy the text' : 'Copy the caption'} done=${copiedAll}>
            ${caption ? html`<${CopyBlock} id="pn-caption" label=${post.type === 'story' ? 'Story text' : 'Caption'} text=${caption} buttonLabel=${post.type === 'story' ? 'Copy text' : 'Copy caption'} toast=${toast} onCopied=${() => setCopiedAll(true)} />` : null}
            ${firstComment ? html`<${CopyBlock} id="pn-first-comment" label="First comment" text=${firstComment} buttonLabel="Copy first comment" toast=${toast} secondary=${!!caption} onCopied=${() => !caption && setCopiedAll(true)} />` : null}
            ${firstComment ? html`<p class="text-sm muted">Post the first comment yourself right after the ${what} is up.</p>` : null}
          <//>`
        : null}

      <${Step} n=${caption || firstComment ? 3 : 2} title="Post it in Instagram">
        <div class="row">
          <${Button} variant="primary" icon="external" href=${INSTAGRAM_URL} target="_blank" rel="noopener noreferrer">Open Instagram<//>
        </div>
        <p class="text-sm muted">Opens the Instagram app if it is installed, otherwise instagram.com. Pick the saved ${items.length > 1 ? mediaWord.replace(/^\d+ /, '') : mediaWord}, paste the caption${post.type === 'story' ? ' or add it as text' : ''}, then add what Postpilot could not.</p>
        ${extras.length
          ? html`<ul class="pn-extras" aria-label="Also add in Instagram">
              ${extras.map(([icon, text]) => html`<li key=${text}><${Icon} name=${icon} size=${15} /><span>${text}</span></li>`)}
            </ul>`
          : null}
      <//>

      <${Step} n=${caption || firstComment ? 4 : 3} title="Mark it as posted">
        <${Field} label="Link to the post" hint="Optional. In Instagram, tap ⋯ on the post, then Copy link." error=${linkError}>
          <${TextInput} type="url" inputmode="url" value=${link} onChange=${(v) => (setLink(v), linkError && setLinkError(''))} placeholder="https://www.instagram.com/p/…" />
        <//>
        <div class="row pn-finish">
          <${Button} variant="primary" icon="check" onClick=${markPosted} loading=${busy === 'posted'} disabled=${!!busy && busy !== 'posted'}>Mark as posted<//>
          ${post.status === 'reminded'
            ? html`<${Button} variant="secondary" icon="clock" onClick=${remindLater} loading=${busy === 'later'} disabled=${!!busy && busy !== 'later'}>Remind me again in 1 hour<//>`
            : null}
        </div>
        ${post.status === 'reminded' && delivery !== 'ok'
          ? html`<p class="text-sm text-warn">${delivery === 'off' ? 'Reminder notifications are turned off' : 'No device has notifications turned on'}, so another reminder only shows up on the Today screen. <a href="#/settings?section=notifications">${delivery === 'off' ? 'Notification settings' : 'Turn on notifications'}</a>.</p>`
          : null}
      <//>
    </ol>
  </div>`;
}
