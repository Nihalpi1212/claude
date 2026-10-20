// Hashtags: hashtag sets, caption templates and saved replies (reused by the composer, autopilot
// and inbox), hashtag research (Facebook Login) and hashtag performance of the owner's posts.
//
// hashtags doc:
//   sets[]         {id, name, tags: ['#tag'], createdAt, updatedAt}
//   templates[]    {id, name, text, createdAt, updatedAt}
//   savedReplies[] {id, name, text, createdAt, updatedAt}
//   tracked[]      {tag (no #), id (Instagram hashtag id), firstAt, lastAt}: research lookups of the last
//                  7 days. Instagram allows 30 unique hashtags per rolling 7 days; repeats are free.

import { html, useMemo, useState } from '../../vendor/preact.js';
import { useApp } from '../app.js';
import { loadViewCss } from '../css.js';
import { mutate, useDoc } from '../data.js';
import { setQuery } from '../router.js';
import { BarChart } from '../ui/charts.js';
import {
  Badge,
  Button,
  Callout,
  CharCounter,
  Chip,
  ChipInput,
  DataTable,
  EmptyState,
  Field,
  Frame,
  Icon,
  Menu,
  Modal,
  PageHeader,
  Panel,
  ProgressBar,
  Segmented,
  Skeleton,
  Tabs,
  TextArea,
  TextInput,
  usePhone,
} from '../ui/kit.js';
import { LIMITS, hashtagsIn, uid } from '../../core/model.js';
import { formatNumber, formatPercent, hashtagPerformance, parseTimestamp } from '../../core/analytics.js';
import { formatDay, formatDateTime, relative } from '../../core/time.js';

loadViewCss('hashtags');

const DAY_MS = 864e5;
const WEEK_MS = 7 * DAY_MS;
const SEARCH_BUDGET = 30; // unique hashtags per rolling 7 days (Instagram Hashtag Search)
const RECOMMENDED = LIMITS.hashtagsRecommended; // 5
const MAX_TAGS = LIMITS.hashtags; // 30
const REPLY_MAX = 1000; // Instagram direct messages are limited to 1,000 characters
const MEDIA_PREVIEW = 18;
const LOOKUPS_PREVIEW = 8;

const TAB_IDS = ['sets', 'templates', 'replies', 'research', 'performance'];

// ---------------------------------------------------------------------------
// Pure helpers

/** '#Ceramics', 'ceramics ' -> '#ceramics'; null when it isn't a valid hashtag. */
export function normalizeTag(raw) {
  const s = String(raw || '').trim().replace(/^#+/, '').toLowerCase();
  if (!s || s.length > 100 || !/^[\p{L}\p{N}_]+$/u.test(s)) return null;
  return `#${s}`;
}

/** Unique {placeholder} names in a template. */
export function placeholdersIn(text) {
  return [...new Set((String(text || '').match(/\{[^{}\n]{1,40}\}/g) || []).map((m) => m.slice(1, -1).trim()).filter(Boolean))];
}

/** Lookups that still count toward the 7-day budget, oldest first. */
export function activeLookups(tracked, nowMs) {
  return (tracked || [])
    .filter((t) => t && t.tag && nowMs - parseTimestamp(t.firstAt) < WEEK_MS)
    .sort((a, b) => parseTimestamp(a.firstAt) - parseTimestamp(b.firstAt));
}

/** New tracked list after looking up `tag` (pure). Expired entries are dropped. */
export function recordLookup(tracked, tag, id, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const out = (tracked || []).filter((t) => t && t.tag && nowMs - parseTimestamp(t.firstAt) < WEEK_MS).map((t) => ({ ...t }));
  const hit = out.find((t) => t.tag === tag);
  if (hit) {
    hit.id = id || hit.id;
    hit.lastAt = nowIso;
  } else {
    out.push({ tag, id, firstAt: nowIso, lastAt: nowIso });
  }
  return out;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall back to a hidden textarea (older Safari, denied permission).
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

const errText = (err) => (err && (err.userMessage || err.message)) || 'Something went wrong.';
const plural = (n, one, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Small pieces

/** "6/5" counter: Instagram counts 5 hashtags per post (warning above), 30 is the hard limit. */
export function HashtagCount({ count, class: cls }) {
  const state = count > MAX_TAGS ? 'is-bad' : count > RECOMMENDED ? 'is-warn' : count ? 'is-ok' : '';
  const title =
    count > MAX_TAGS
      ? `Instagram rejects posts with more than ${MAX_TAGS} hashtags.`
      : count > RECOMMENDED
        ? `Instagram counts ${RECOMMENDED} hashtags per post; the rest may be ignored.`
        : `Instagram counts up to ${RECOMMENDED} hashtags per post.`;
  return html`<span class=${['ht-count', state, cls].filter(Boolean).join(' ')} title=${title}>
    ${count > RECOMMENDED ? html`<${Icon} name="alert" size=${13} />` : null}<span class="num" aria-hidden="true">${count}/${RECOMMENDED}</span>
    <span class="sr-only">${count} ${count === 1 ? 'hashtag' : 'hashtags'}. ${title}</span>
  </span>`;
}

function TagChips({ tags }) {
  return html`<div class="ht-chips">
    ${tags.map(
      (t, i) => html`<${Chip} key=${t} class=${i >= RECOMMENDED ? 'ht-extra' : ''}
        title=${i >= RECOMMENDED ? `Past the first ${RECOMMENDED}: Instagram may ignore it` : undefined}>${t}<//>`,
    )}
  </div>`;
}

function AddToSetMenu({ tags, sets, onAdd, onNewSet, size = 'sm', label = 'Add to set' }) {
  const items = [
    ...sets.map((s) => ({ label: s.name || 'Untitled set', hint: `${s.tags.length}/${RECOMMENDED}`, onClick: () => onAdd(s.id, tags) })),
    ...(sets.length ? ['-'] : []),
    { label: 'New set…', icon: 'plus', onClick: () => onNewSet(tags) },
  ];
  return html`<${Menu} trigger=${label} size=${size} label=${`Add ${tags.join(' ')} to a set`} items=${items} />`;
}

function MediaTile({ media, index }) {
  const src = media.mediaUrl || (media.children && media.children[0] && media.children[0].mediaUrl) || null;
  const isVideo = media.mediaType === 'VIDEO' || (src && /\.(mp4|mov)(\?|#|$)/i.test(src));
  const kind = media.mediaType === 'CAROUSEL_ALBUM' ? 'carousel' : isVideo ? 'video' : undefined;
  const date = media.timestamp ? new Date(parseTimestamp(media.timestamp)) : null;
  const badge = html`<span class="ht-badge"><${Icon} name="heart" size=${11} />${formatNumber(media.likeCount, { compact: true })}<${Icon} name="comment" size=${11} />${formatNumber(media.commentsCount, { compact: true })}</span>`;
  const frame = html`<${Frame} src=${isVideo ? null : src} alt=${media.caption ? media.caption.slice(0, 120) : 'Instagram post'}
    number=${index + 1} label=${date ? relative(date) : ''} ratio="4 / 5" kind=${kind} badge=${badge}>
    ${isVideo && src ? html`<video src=${`${src}#t=0.1`} muted playsinline preload="metadata" aria-hidden="true"></video>` : null}
  <//>`;
  const title = `${formatNumber(media.likeCount)} likes, ${formatNumber(media.commentsCount)} comments. Open on Instagram`;
  return media.permalink
    ? html`<a class="ht-tile" href=${media.permalink} target="_blank" rel="noopener noreferrer" title=${title}>${frame}</a>`
    : html`<div class="ht-tile" title=${title}>${frame}</div>`;
}

// ---------------------------------------------------------------------------
// Editors

function SetEditor({ editor, onClose, onSave }) {
  const item = editor.item;
  const [name, setName] = useState(item ? item.name : '');
  const [tags, setTags] = useState(item ? item.tags : editor.tags || []);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  async function save() {
    const e = {};
    if (!name.trim()) e.name = 'Give the set a name.';
    if (!tags.length) e.tags = 'Add at least one hashtag.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const ok = await onSave({ id: item && item.id, name: name.trim(), tags });
    setBusy(false);
    if (ok) onClose();
  }
  return html`<${Modal} open=${true} title=${item ? 'Edit hashtag set' : 'New hashtag set'} onClose=${onClose}
    footer=${html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//><${Button} variant="primary" loading=${busy} onClick=${save}>${item ? 'Save set' : 'Create set'}<//>`}>
    <form class="stack" onSubmit=${(e) => (e.preventDefault(), save())}>
      <${Field} label="Name" error=${errors.name}>
        <${TextInput} value=${name} onChange=${setName} placeholder="Ceramics" maxlength="60" data-autofocus />
      <//>
      <${Field} label="Hashtags" error=${errors.tags} action=${html`<${HashtagCount} count=${tags.length} />`}
        hint=${`Press Enter or comma after each one. Letters, numbers and underscores only. Up to ${MAX_TAGS} per set.`}>
        <${ChipInput} values=${tags} onChange=${setTags} normalize=${normalizeTag} max=${MAX_TAGS} placeholder="#ceramics, #pottery" />
      <//>
      ${tags.length > RECOMMENDED
        ? html`<${Callout} tone="warning" class="ht-callout-sm">
            Instagram counts ${RECOMMENDED} hashtags per post since December 2025, so ${plural(tags.length - RECOMMENDED, 'hashtag')} in this set may be ignored. Keep your best ${RECOMMENDED} first.
          <//>`
        : html`<p class="text-sm muted">Instagram counts up to ${RECOMMENDED} hashtags per post, so a focused set of ${RECOMMENDED} works best.</p>`}
    </form>
  <//>`;
}

function TextItemEditor({ editor, onClose, onSave }) {
  const isReply = editor.kind === 'reply';
  const item = editor.item;
  const max = isReply ? REPLY_MAX : LIMITS.captionChars;
  const [name, setName] = useState(item ? item.name : '');
  const [text, setText] = useState(item ? item.text : '');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const placeholders = placeholdersIn(text);
  const tagCount = hashtagsIn(text).length;
  const noun = isReply ? 'reply' : 'template';
  async function save() {
    const e = {};
    if (!name.trim()) e.name = `Give the ${noun} a name.`;
    if (!text.trim()) e.text = isReply ? 'Write the reply.' : 'Write the caption text.';
    else if (text.length > max) e.text = `Keep it under ${formatNumber(max)} characters.`;
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const ok = await onSave({ id: item && item.id, name: name.trim(), text });
    setBusy(false);
    if (ok) onClose();
  }
  return html`<${Modal} open=${true} wide title=${item ? `Edit ${isReply ? 'saved reply' : 'caption template'}` : isReply ? 'New saved reply' : 'New caption template'} onClose=${onClose}
    footer=${html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//><${Button} variant="primary" loading=${busy} onClick=${save}>${item ? `Save ${noun}` : `Create ${noun}`}<//>`}>
    <form class="stack" onSubmit=${(e) => (e.preventDefault(), save())}>
      <${Field} label="Name" error=${errors.name}>
        <${TextInput} value=${name} onChange=${setName} placeholder=${isReply ? 'Shipping' : 'New drop'} maxlength="60" data-autofocus />
      <//>
      <${Field} label=${isReply ? 'Reply' : 'Caption'} error=${errors.text} action=${html`<${CharCounter} value=${text} max=${max} />`}
        hint=${isReply
          ? `Shows up in Inbox when you answer comments and messages. Under ${formatNumber(REPLY_MAX)} characters so it also fits in a direct message.`
          : 'Write {placeholders} such as {product} or {date} for the parts you change each time.'}>
        <${TextArea} value=${text} onChange=${setText} rows=${isReply ? 4 : 7} maxRows=${14}
          placeholder=${isReply ? 'Yes, we ship worldwide. Orders go out every Friday.' : 'New in the shop: {product}. {detail}'} />
      <//>
      ${!isReply && (placeholders.length || tagCount)
        ? html`<div class="row ht-meta">
            ${placeholders.length ? html`<span class="text-sm muted">Placeholders</span>${placeholders.map((p) => html`<${Badge} key=${p} tone="outline" class="mono">{${p}}<//>`)}` : null}
            ${tagCount ? html`<span class="spacer"></span><span class="text-sm muted">Hashtags</span><${HashtagCount} count=${tagCount} />` : null}
          </div>`
        : null}
    </form>
  <//>`;
}

// ---------------------------------------------------------------------------
// Tabs

function SetsTab({ sets, onEdit, onDelete, onCopy, onNew }) {
  if (!sets.length) {
    return html`<${EmptyState} icon="hash" title="No hashtag sets yet"
      body="Save the hashtags you use together, then add them to a post in one click from the composer."
      action=${html`<${Button} variant="primary" icon="plus" onClick=${onNew}>New set<//>`} />`;
  }
  return html`<div class="stack">
    <p class="text-sm muted ht-lede">
      Instagram counts ${RECOMMENDED} hashtags per post since December 2025. Sets show the count as x/${RECOMMENDED}; hashtags past the first ${RECOMMENDED} are dashed.
    </p>
    <div class="grid-auto ht-cards" style="--min: 300px">
      ${sets.map(
        (s) => html`<${Panel} key=${s.id} class="ht-card" title=${s.name || 'Untitled set'}
          actions=${html`<${Button} size="sm" icon="copy" onClick=${() => onCopy(s.tags.join(' '), plural(s.tags.length, 'hashtag'))} aria-label=${`Copy ${s.name} hashtags`}>Copy<//>
            <${Menu} size="sm" label=${`More actions for ${s.name}`} items=${[
              { label: 'Edit', icon: 'edit', onClick: () => onEdit(s) },
              { label: 'Delete', icon: 'trash', danger: true, onClick: () => onDelete(s) },
            ]} />`}>
          <div class="stack stack-sm">
            ${s.tags.length ? html`<${TagChips} tags=${s.tags} />` : html`<p class="muted text-sm">No hashtags in this set.</p>`}
            <div class="row ht-meta text-xs muted">
              <${HashtagCount} count=${s.tags.length} />
              <span>${s.tags.length > RECOMMENDED ? `Only the first ${RECOMMENDED} are likely to count` : plural(s.tags.length, 'hashtag')}</span>
            </div>
          </div>
        <//>`,
      )}
    </div>
  </div>`;
}

function TextItemsTab({ kind, items, onEdit, onDelete, onCopy, onNew }) {
  const isReply = kind === 'reply';
  if (!items.length) {
    return html`<${EmptyState} icon=${isReply ? 'message' : 'file'} title=${isReply ? 'No saved replies yet' : 'No caption templates yet'}
      body=${isReply
        ? 'Save answers you write again and again, like shipping times or custom orders. Pick them in Inbox when you reply.'
        : 'Save captions you reuse, like a new-drop announcement, and insert them from the composer.'}
      action=${html`<${Button} variant="primary" icon="plus" onClick=${onNew}>${isReply ? 'New reply' : 'New template'}<//>`} />`;
  }
  return html`<div class="grid-auto ht-cards" style="--min: 320px">
    ${items.map((it) => {
      const ph = isReply ? [] : placeholdersIn(it.text);
      const tagCount = hashtagsIn(it.text || '').length;
      return html`<${Panel} key=${it.id} class="ht-card" title=${it.name || 'Untitled'}
        actions=${html`<${Button} size="sm" icon="copy" onClick=${() => onCopy(it.text, isReply ? 'reply' : 'caption')} aria-label=${`Copy ${it.name}`}>Copy<//>
          <${Menu} size="sm" label=${`More actions for ${it.name}`} items=${[
            { label: 'Edit', icon: 'edit', onClick: () => onEdit(it) },
            { label: 'Delete', icon: 'trash', danger: true, onClick: () => onDelete(it) },
          ]} />`}>
        <div class="stack stack-sm">
          <p class="pre-wrap clamp-3 ht-text">${it.text}</p>
          <div class="row ht-meta text-xs muted">
            <span class="num">${formatNumber((it.text || '').length)} characters</span>
            ${ph.map((p) => html`<${Badge} key=${p} tone="outline" class="mono">{${p}}<//>`)}
            ${tagCount ? html`<span class="spacer"></span><${HashtagCount} count=${tagCount} />` : null}
          </div>
        </div>
      <//>`;
    })}
  </div>`;
}

function ResearchTab({ doc, sets, onAdd, onNewSet }) {
  const { ig, settings, tz } = useApp();
  const fbMode = settings && settings.ig && settings.ig.mode === 'facebook';
  const [query, setQueryText] = useState('');
  const [edge, setEdge] = useState('top');
  const [result, setResult] = useState(null); // {tag, id, edge, media}
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState([]);
  const [showAllMedia, setShowAllMedia] = useState(false);
  const [showAllLookups, setShowAllLookups] = useState(false);

  const nowMs = Date.now();
  const active = activeLookups(doc.tracked, nowMs);
  const used = active.length;
  const left = Math.max(0, SEARCH_BUDGET - used);
  const nextFree = active.length ? new Date(parseTimestamp(active[0].firstAt) + WEEK_MS) : null;

  const related = useMemo(() => {
    if (!result) return [];
    const counts = new Map();
    for (const m of result.media) for (const t of new Set(hashtagsIn(m.caption || ''))) if (t !== `#${result.tag}`) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 16);
  }, [result]);

  const summary = useMemo(() => {
    if (!result || !result.media.length) return null;
    const avg = (k) => result.media.reduce((s, m) => s + (m[k] || 0), 0) / result.media.length;
    return { likes: avg('likeCount'), comments: avg('commentsCount') };
  }, [result]);

  if (!settings || !settings.ig) {
    return html`<${Callout} tone="info" title="Connect Instagram first"
      action=${html`<${Button} href="#/settings?section=instagram" size="sm">Open Settings<//>`}>Hashtag research looks up posts on Instagram, so connect your account first.<//>`;
  }
  if (!fbMode) {
    return html`<${Callout} tone="info" title="Hashtag research needs Facebook Login"
      action=${html`<${Button} href="#/settings?section=instagram" size="sm" variant="secondary">Open Settings<//>`}>
      Instagram only offers hashtag search to accounts connected through a Facebook Page. Switch the connection in Settings to see top and recent posts for any hashtag.
    <//>`;
  }

  async function search(raw, edgeArg) {
    const norm = normalizeTag(raw);
    if (!norm) {
      setError('Enter a hashtag, like ceramics. Letters, numbers and underscores only.');
      return;
    }
    if (!ig) {
      setError('Instagram is not connected. Check Settings.');
      return;
    }
    const tag = norm.slice(1);
    const now = Date.now();
    const known = activeLookups(doc.tracked, now).find((t) => t.tag === tag);
    if (!known && activeLookups(doc.tracked, now).length >= SEARCH_BUDGET) {
      setError(`You looked up ${SEARCH_BUDGET} different hashtags in the last 7 days, which is Instagram’s limit. The next lookup frees up ${nextFree ? formatDateTime(nextFree, tz) : 'soon'}. Hashtags you already looked up this week stay free.`);
      return;
    }
    setError(null);
    setBusy(true);
    setQueryText(tag);
    try {
      const id = (known && known.id) || (await ig.hashtagSearch(tag));
      // Record the lookup as soon as Instagram counted it, even if loading posts fails next.
      mutate('hashtags', (d) => void (d.tracked = recordLookup(d.tracked, tag, id, now)), { message: 'hashtags: research lookup', silent: true }).catch(() => {});
      const media = await ig.hashtagMedia(id, edgeArg, { limit: 30 });
      setResult({ tag, id, edge: edgeArg, media });
      setEdge(edgeArg);
      setPicked((p) => (result && result.tag === tag ? p : []));
      setShowAllMedia(false);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const tone = used >= SEARCH_BUDGET ? 'bad' : used >= SEARCH_BUDGET - 6 ? 'warn' : 'accent';
  return html`<div class="ht-research">
    <div class="stack ht-research-main">
      <${Panel} title="Look up a hashtag">
        <form class="ht-search" onSubmit=${(e) => (e.preventDefault(), search(query, edge))}>
          <${Field} label="Hashtag" error=${error} class="grow">
            <${TextInput} value=${query} onChange=${(v) => (setQueryText(v), error && setError(null))} prefix="#" placeholder="ceramics"
              autocomplete="off" autocapitalize="none" spellcheck=${false} />
          <//>
          <${Segmented} size="sm" label="Which posts" value=${edge}
            onChange=${(v) => (result ? search(result.tag, v) : setEdge(v))}
            options=${[{ value: 'top', label: 'Top' }, { value: 'recent', label: 'Recent' }]} class="ht-edge" />
          <${Button} type="submit" variant="primary" icon="search" loading=${busy} class="ht-search-btn">Search<//>
        </form>
        <p class="text-xs muted ht-search-note">Top shows the most popular posts. Recent shows posts from the last 24 hours.</p>
      <//>

      ${result
        ? html`<${Panel} title=${`#${result.tag}`} subtitle=${`${result.edge === 'recent' ? 'Recent posts, last 24 hours' : 'Top posts'} · ${plural(result.media.length, 'post')}`}
            actions=${html`<${AddToSetMenu} tags=${[`#${result.tag}`, ...picked]} sets=${sets} onAdd=${onAdd} onNewSet=${onNewSet}
              label=${picked.length ? `Add ${picked.length + 1} to set` : 'Add to set'} />`}>
            <div class="stack">
              ${summary
                ? html`<p class="text-sm muted">These posts average <span class="num strong ht-ink">${formatNumber(Math.round(summary.likes))}</span> likes and${' '}<span class="num strong ht-ink">${formatNumber(Math.round(summary.comments))}</span> comments.</p>`
                : null}
              ${related.length
                ? html`<div class="stack stack-sm">
                    <p class="label-caps">Used together with #${result.tag}</p>
                    <div class="ht-chips">
                      ${related.map(
                        ([t, n]) => html`<${Chip} key=${t} selected=${picked.includes(t)} title=${`In ${n} of these posts`}
                          onClick=${() => setPicked((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]))}>${t} <span class="ht-chip-n num">${n}</span><//>`,
                      )}
                    </div>
                    <p class="text-xs muted">Select hashtags to add them to a set together with #${result.tag}.</p>
                  </div>`
                : null}
              ${result.media.length
                ? html`<div class="contact-sheet ht-sheet">${(showAllMedia ? result.media : result.media.slice(0, MEDIA_PREVIEW)).map((m, i) => html`<${MediaTile} key=${m.id} media=${m} index=${i} />`)}</div>
                    ${!showAllMedia && result.media.length > MEDIA_PREVIEW
                      ? html`<div class="row row-end"><${Button} variant="ghost" size="sm" iconRight="chevron-down" onClick=${() => setShowAllMedia(true)}>Show all ${result.media.length} posts<//></div>`
                      : null}`
                : html`<${EmptyState} compact icon="image" title="No posts found" body=${result.edge === 'recent' ? 'Nobody used this hashtag in the last 24 hours.' : 'Instagram returned no top posts for this hashtag.'} />`}
            </div>
          <//>`
        : html`<${EmptyState} icon="search" title="See what works for any hashtag"
            body="Look up a hashtag to see its top and recent posts, how much engagement they get, and which hashtags people use with it." />`}
    </div>

    <${Panel} title="Lookups this week" class="ht-budget"
      subtitle=${`Instagram allows ${SEARCH_BUDGET} different hashtags per 7 days. Looking one up again is free.`}>
      <div class="stack">
        <div class="stack stack-sm">
          <div class="row row-between">
            <span><span class="num strong ht-big">${used}</span><span class="muted"> of ${SEARCH_BUDGET} used</span></span>
            <span class=${`text-sm ${left ? 'muted' : 'text-bad'}`}>${left} left</span>
          </div>
          <${ProgressBar} value=${used} max=${SEARCH_BUDGET} tone=${tone} label="Hashtag lookups used this week" />
          ${nextFree && used >= SEARCH_BUDGET - 6 ? html`<p class="text-xs muted">Next one frees up ${formatDateTime(nextFree, tz)}.</p>` : null}
        </div>
        ${active.length
          ? html`<ul class="list ht-tracked">
              ${[...active].reverse().slice(0, showAllLookups ? undefined : LOOKUPS_PREVIEW).map(
                (t) => html`<li key=${t.tag} class="list-row">
                  <span class="grow">
                    <span class="mono ht-tracked-tag">#${t.tag}</span>
                    <span class="text-xs muted ht-tracked-meta">Counts until ${formatDay(new Date(parseTimestamp(t.firstAt) + WEEK_MS), tz)}</span>
                  </span>
                  <${Button} size="sm" variant="ghost" disabled=${busy} onClick=${() => search(t.tag, edge)} aria-label=${`Show posts for #${t.tag}`}>Show posts<//>
                </li>`,
              )}
            </ul>
            ${active.length > LOOKUPS_PREVIEW
              ? html`<${Button} variant="ghost" size="sm" iconRight=${showAllLookups ? 'chevron-up' : 'chevron-down'} onClick=${() => setShowAllLookups((v) => !v)}>
                  ${showAllLookups ? 'Show fewer' : `Show all ${active.length}`}
                <//>`
              : null}`
          : html`<p class="text-sm muted">No lookups in the last 7 days.</p>`}
      </div>
    <//>
  </div>`;
}

function PerformanceTab({ sets, onAdd, onNewSet }) {
  const { data: media, loading, error } = useDoc('analytics-media');
  const phone = usePhone();
  const [minPosts, setMinPosts] = useState(2);
  const rows = useMemo(() => hashtagPerformance((media && media.media) || {}, { minPosts }), [media, minPosts]);
  const inSets = useMemo(() => new Set(sets.flatMap((s) => s.tags)), [sets]);
  const postsWithData = media ? Object.keys(media.media || {}).length : 0;

  if (error && !media) return html`<${Callout} tone="danger" title="Could not load your post statistics">${errText(error)}<//>`;
  if (loading && !media) return html`<${Panel}><${Skeleton} lines=${6} /><//>`;
  if (!postsWithData) {
    return html`<${EmptyState} icon="chart" title="No post statistics yet"
      body="The worker saves statistics for your posts every day. Hashtag results show up once a few posts have them." />`;
  }

  const bars = rows.filter((r) => r.avgER != null).slice(0, 10).map((r) => ({ label: r.tag, value: r.avgER }));
  const columns = [
    { key: 'tag', label: 'Hashtag', sortable: true, render: (r) => html`<span class="row row-nowrap ht-tag-cell"><span class="mono">${r.tag}</span>${inSets.has(r.tag) ? html`<${Badge} tone="outline">In a set<//>` : null}</span>` },
    { key: 'posts', label: 'Posts', align: 'right', sortable: true, render: (r) => formatNumber(r.posts) },
    { key: 'avgReach', label: 'Avg reach', align: 'right', sortable: true, render: (r) => formatNumber(r.avgReach == null ? null : Math.round(r.avgReach)) },
    { key: 'avgInteractions', label: 'Avg interactions', align: 'right', sortable: true, render: (r) => formatNumber(r.avgInteractions == null ? null : Math.round(r.avgInteractions)) },
    { key: 'avgER', label: 'Avg engagement', align: 'right', sortable: true, render: (r) => html`<span class="strong">${formatPercent(r.avgER, 1)}</span>` },
    { key: 'add', label: html`<span class="sr-only">Add to set</span>`, align: 'right', render: (r) => html`<${AddToSetMenu} tags=${[r.tag]} sets=${sets} onAdd=${onAdd} onNewSet=${onNewSet} label="Add" />` },
  ];

  return html`<div class="stack">
    <div class="toolbar">
      <span class="text-sm muted">Hashtags used on at least</span>
      <${Segmented} size="sm" label="Minimum posts per hashtag" value=${minPosts} onChange=${setMinPosts}
        options=${[{ value: 2, label: '2 posts' }, { value: 3, label: '3 posts' }, { value: 5, label: '5 posts' }]} />
    </div>
    ${rows.length
      ? html`<div class="ht-perf">
          <${Panel} title="Best hashtags by engagement" subtitle="Average engagement (interactions ÷ reach) of your posts that used each hashtag">
            <${BarChart} data=${bars} horizontal format="percent" label="Average engagement by hashtag" />
          <//>
          <${Panel} title="All hashtags" flush subtitle=${`From ${plural(postsWithData, 'post')} with statistics. Hashtags only count once per post.`}>
            ${phone
              ? html`<ul class="list ht-perf-list" aria-label="Hashtag performance">
                  ${rows.map(
                    (r) => html`<li key=${r.tag} class="list-row">
                      <span class="grow">
                        <span class="row row-nowrap ht-tag-cell"><span class="mono truncate">${r.tag}</span>${inSets.has(r.tag) ? html`<${Badge} tone="outline">In a set<//>` : null}</span>
                        <span class="text-xs muted num">${plural(r.posts, 'post')} · ${formatNumber(r.avgReach == null ? null : Math.round(r.avgReach))} avg reach</span>
                      </span>
                      <span class="num strong">${formatPercent(r.avgER, 1)}</span>
                      <${AddToSetMenu} tags=${[r.tag]} sets=${sets} onAdd=${onAdd} onNewSet=${onNewSet} label="Add" />
                    </li>`,
                  )}
                </ul>`
              : html`<${DataTable} columns=${columns} rows=${rows} rowKey=${(r) => r.tag} initialSort=${{ key: 'avgER', dir: 'desc' }} maxHeight=${520} caption="Hashtag performance" />`}
          <//>
        </div>`
      : html`<${EmptyState} icon="hash" title=${`No hashtag on ${minPosts} or more posts`} body="Pick a lower minimum, or use the same hashtags on a few more posts to compare them." />`}
  </div>`;
}

// ---------------------------------------------------------------------------
// View

export default function Hashtags() {
  const { route, toast, confirm } = useApp();
  const { data: doc, loading, error, reload } = useDoc('hashtags');
  const [editor, setEditor] = useState(null); // {kind: 'set'|'template'|'reply', item?, tags?}
  const tab = TAB_IDS.includes(route.query.tab) ? route.query.tab : 'sets';

  const sets = (doc && doc.sets) || [];
  const templates = (doc && doc.templates) || [];
  const replies = (doc && doc.savedReplies) || [];
  const tabs = [
    { id: 'sets', label: 'Sets', badge: sets.length || null },
    { id: 'templates', label: 'Caption templates', badge: templates.length || null },
    { id: 'replies', label: 'Saved replies', badge: replies.length || null },
    { id: 'research', label: 'Research' },
    { id: 'performance', label: 'Performance' },
  ];

  const listKey = (kind) => (kind === 'set' ? 'sets' : kind === 'template' ? 'templates' : 'savedReplies');
  const nounOf = (kind) => (kind === 'set' ? 'Set' : kind === 'template' ? 'Template' : 'Reply');

  async function saveItem(kind, values) {
    const key = listKey(kind);
    const id = values.id || uid(kind === 'set' ? 'hs_' : kind === 'template' ? 'tp_' : 'sr_');
    const nowIso = new Date().toISOString();
    try {
      await mutate(
        'hashtags',
        (d) => {
          d[key] = Array.isArray(d[key]) ? d[key] : [];
          const fields = kind === 'set' ? { name: values.name, tags: values.tags } : { name: values.name, text: values.text };
          const i = d[key].findIndex((x) => x.id === id);
          if (i >= 0) d[key][i] = { ...d[key][i], ...fields, updatedAt: nowIso };
          else d[key].push({ id, ...fields, createdAt: nowIso, updatedAt: nowIso });
        },
        { message: `hashtags: save ${kind}` },
      );
      toast(`${nounOf(kind)} “${values.name}” saved.`, { kind: 'success' });
      return true;
    } catch {
      return false; // mutate() already showed the error
    }
  }

  async function deleteItem(kind, item) {
    const label = kind === 'set' ? 'hashtag set' : kind === 'template' ? 'caption template' : 'saved reply';
    const ok = await confirm({
      title: `Delete “${item.name || 'Untitled'}”?`,
      body: kind === 'set' ? 'Posts that already use these hashtags keep them. Autopilot stops adding this set.' : `The ${label} is removed. Posts and replies already sent are not affected.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const key = listKey(kind);
    try {
      await mutate('hashtags', (d) => void (d[key] = (d[key] || []).filter((x) => x.id !== item.id)), { message: `hashtags: delete ${kind}` });
      toast(`Deleted “${item.name || 'Untitled'}”.`, { kind: 'success' });
    } catch {
      // mutate() already showed the error
    }
  }

  async function addToSet(setId, tags) {
    const clean = tags.map(normalizeTag).filter(Boolean);
    const target = sets.find((s) => s.id === setId);
    let result = null;
    try {
      await mutate(
        'hashtags',
        (d) => {
          const s = (d.sets || []).find((x) => x.id === setId);
          if (!s) throw new Error('That set no longer exists.');
          const before = s.tags.length;
          s.tags = [...new Set([...s.tags, ...clean])].slice(0, MAX_TAGS);
          s.updatedAt = new Date().toISOString();
          result = { added: s.tags.length - before, total: s.tags.length };
        },
        { message: 'hashtags: add to set' },
      );
      const name = (target && target.name) || 'the set';
      if (!result.added) toast(`${clean.join(' ')} ${clean.length === 1 ? 'is' : 'are'} already in ${name}.`);
      else {
        const over = result.total > RECOMMENDED ? ` It now has ${result.total} hashtags; Instagram counts ${RECOMMENDED} per post.` : '';
        toast(`Added ${plural(result.added, 'hashtag')} to ${name}.${over}`, { kind: 'success' });
      }
    } catch {
      // mutate() already showed the error
    }
  }

  async function onCopy(text, what) {
    const ok = await copyText(text);
    toast(ok ? `Copied ${what}.` : 'Could not copy. Select the text and copy it yourself.', { kind: ok ? 'success' : 'error' });
  }

  const newButton = {
    sets: html`<${Button} variant="primary" icon="plus" onClick=${() => setEditor({ kind: 'set' })}>New set<//>`,
    templates: html`<${Button} variant="primary" icon="plus" onClick=${() => setEditor({ kind: 'template' })}>New template<//>`,
    replies: html`<${Button} variant="primary" icon="plus" onClick=${() => setEditor({ kind: 'reply' })}>New reply<//>`,
  }[tab];

  const header = html`<${PageHeader} eyebrow="Measure" title="Hashtags"
    subtitle="Reusable hashtag sets, captions and replies, plus research into which hashtags work."
    actions=${doc ? newButton : null} />`;

  if (error && !doc) {
    return html`<div class="page">${header}
      <${Callout} tone="danger" title="Could not load your hashtags" action=${html`<${Button} size="sm" onClick=${reload}>Try again<//>`}>${errText(error)}<//>
    </div>`;
  }

  let body;
  if (loading && !doc) body = html`<${Panel}><${Skeleton} lines=${6} /><//>`;
  else if (tab === 'sets') {
    body = html`<${SetsTab} sets=${sets} onNew=${() => setEditor({ kind: 'set' })} onEdit=${(item) => setEditor({ kind: 'set', item })}
      onDelete=${(item) => deleteItem('set', item)} onCopy=${onCopy} />`;
  } else if (tab === 'templates' || tab === 'replies') {
    const kind = tab === 'templates' ? 'template' : 'reply';
    body = html`<${TextItemsTab} key=${kind} kind=${kind} items=${tab === 'templates' ? templates : replies} onNew=${() => setEditor({ kind })}
      onEdit=${(item) => setEditor({ kind, item })} onDelete=${(item) => deleteItem(kind, item)} onCopy=${onCopy} />`;
  } else if (tab === 'research') {
    body = html`<${ResearchTab} doc=${doc} sets=${sets} onAdd=${addToSet} onNewSet=${(tags) => setEditor({ kind: 'set', tags })} />`;
  } else {
    body = html`<${PerformanceTab} sets=${sets} onAdd=${addToSet} onNewSet=${(tags) => setEditor({ kind: 'set', tags })} />`;
  }

  return html`<div class="page ht-page">
    ${header}
    <${Tabs} tabs=${tabs} value=${tab} onChange=${(id) => setQuery({ tab: id === 'sets' ? undefined : id })} label="Hashtag tools" />
    <div role="tabpanel" aria-label=${tabs.find((t) => t.id === tab).label}>${body}</div>
    ${editor && editor.kind === 'set'
      ? html`<${SetEditor} editor=${editor} onClose=${() => setEditor(null)} onSave=${(v) => saveItem('set', v)} />`
      : null}
    ${editor && editor.kind !== 'set'
      ? html`<${TextItemEditor} editor=${editor} onClose=${() => setEditor(null)} onSave=${(v) => saveItem(editor.kind, v)} />`
      : null}
  </div>`;
}
