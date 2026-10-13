// Inbox: comments on recent posts, DM conversations (with story replies and story mentions marked),
// mentions and collaboration invites, with replies, moderation, saved replies and AI suggestions.
// Live from Instagram when possible; otherwise the worker's cached copy (inbox doc), with actions
// queued for the worker (inbox.outbox). Collaboration invites are answered live only.
// Routes: #/inbox?tab=messages|mentions|invites; #/inbox/invites also opens the Invites tab (push
// notifications for new invites link there).

import { uid } from '../../core/model.js';
import { formatDateTime, formatDay, formatTime, dayKey, relative } from '../../core/time.js';
import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { aiPrefs, getAi } from '../ai-client.js';
import { useApp } from '../app.js';
import { loadViewCss } from '../css.js';
import { mutate, useDocs } from '../data.js';
import { notifyDelivery } from '../push.js';
import { buildHash, parseHash, setQuery } from '../router.js';
import { Icon } from '../ui/icons.js';
import {
  Avatar, Badge, Button, Callout, CharCounter, EmptyState, Frame, IconButton, Menu, PageHeader, Segmented, Skeleton, Spinner, Tabs, TextArea, cx, usePhone,
} from '../ui/kit.js';

loadViewCss('inbox');

const MEDIA_LIMIT = 12;
const PRIVATE_REPLY_MS = 7 * 864e5;
const DM_WINDOW_MS = 24 * 36e5;
const LIVE_TTL_MS = 2 * 60_000;
const PREVIEW_FETCH_MAX = 8;
const DM_MAX = 1000;
const COMMENT_MAX = 2200;
const DONE_MAX = 2000;
const TABS = ['comments', 'messages', 'mentions', 'invites'];
const INVITE_KEEP_MS = 30 * 864e5;

// Live results survive switching tabs and screens for a couple of minutes (Graph API calls are rate limited).
const live = { comments: null, conversations: null, threads: new Map(), tags: null, invites: null };

/** Switch tabs; also leaves the #/inbox/invites form so ?tab= is the only source of truth. */
function setTab(id) {
  const r = parseHash();
  history.replaceState(null, '', buildHash('inbox', { ...r.query, tab: id === 'comments' ? null : id }, []));
  globalThis.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** 'reply' | 'mention' | null for a message (live, or the worker's cached lastMessage.story). */
function storyKind(m) {
  if (!m) return null;
  if (m.storyMention) return 'mention';
  if (m.storyReply) return 'reply';
  return m.story === 'mention' || m.story === 'reply' ? m.story : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
};
/** The later of two ISO times (either may be missing), or null. */
export const latestTime = (a, b) => (ms(a) || ms(b) ? (ms(a) >= ms(b) ? a : b) : null);

function clip(text, n = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function isNetworkError(err) {
  return !!err && (err.code === 'network' || (err.name === 'TypeError' && /fetch|network/i.test(err.message || '')));
}

function errText(err) {
  return (err && (err.userMessage || err.message)) || String(err);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function kindLabel(m) {
  if (m.productType === 'REELS' || m.mediaType === 'VIDEO') return 'Reel';
  if (m.mediaType === 'CAROUSEL_ALBUM') return 'Carousel';
  return 'Post';
}

function mediaFromLive(m) {
  return {
    id: m.id,
    caption: m.caption || '',
    permalink: m.permalink || null,
    thumb: m.thumbnailUrl || (m.mediaType !== 'VIDEO' ? m.mediaUrl : null) || (m.children && m.children[0] && (m.children[0].thumbnailUrl || m.children[0].mediaUrl)) || null,
    timestamp: m.timestamp || null,
    productType: m.productType || null,
    mediaType: m.mediaType || null,
    commentsEnabled: m.commentsEnabled ?? null,
    commentsCount: m.commentsCount ?? null,
  };
}

// This screen's writes to the inbox document go one at a time: two commits built on the same version
// conflict (GitHub answers 422 and the store starts over), e.g. a hide right after a reply.
let inboxWrites = Promise.resolve();
function mutateInbox(fn, opts) {
  const run = inboxWrites.then(() => mutate('inbox', fn, opts));
  inboxWrites = run.catch(() => {});
  return run;
}

/** Where a comment or reply sits in the worker's cached list (as worker/jobs/shared.mjs findCachedComment). */
function findCached(list, id) {
  for (let i = 0; i < (list || []).length; i++) {
    const c = list[i];
    if (!c) continue;
    if (c.id === id) return { comment: c, parent: null, index: i };
    const r = (c.replies || []).findIndex((x) => x && x.id === id);
    if (r >= 0) return { comment: c.replies[r], parent: c, index: r };
  }
  return null;
}

/**
 * Reflect a live action in the worker's cached comments, as worker/jobs/outbox.mjs does for queued
 * ones: older posts are shown from that copy and the Today screen counts it, while the worker reads a
 * post's comments again only when its comment count changes (a hidden comment would stay unhidden).
 * edit(doc, found) changes the found comment in place.
 */
function patchCache(inbox, commentId, edit) {
  if (!findCached(inbox && inbox.comments, commentId)) return;
  mutateInbox((d) => {
    const found = findCached(d.comments, commentId);
    if (found) edit(d, found);
  }, { message: 'inbox: update the saved copy of a comment', silent: true }).catch(() => {});
}

/** Group the worker's cached comments (inbox.comments) by post. */
function groupsFromCache(list) {
  const by = new Map();
  for (const c of list || []) {
    if (!c || !c.mediaId) continue;
    if (!by.has(c.mediaId)) {
      const m = c.media || {};
      by.set(c.mediaId, {
        media: { id: c.mediaId, caption: m.caption || '', permalink: m.permalink || null, thumb: m.thumbnailUrl || null, timestamp: m.timestamp || null, productType: m.productType || null, mediaType: null, commentsEnabled: null, commentsCount: null },
        comments: [],
      });
    }
    by.get(c.mediaId).comments.push(c);
  }
  const groups = [...by.values()];
  for (const g of groups) g.comments.sort((a, b) => ms(b.timestamp) - ms(a.timestamp));
  return groups.sort((a, b) => ms(b.media.timestamp) - ms(a.media.timestamp));
}

async function loadLiveComments(ig) {
  const media = (await ig.listMedia({ limit: MEDIA_LIMIT, max: MEDIA_LIMIT })).filter((m) => m && m.productType !== 'STORY').slice(0, MEDIA_LIMIT);
  const groups = await mapLimit(media, 4, async (m) => {
    if (m.commentsCount === 0) return { media: mediaFromLive(m), comments: [] };
    try {
      const comments = await ig.comments(m.id, { max: 60 });
      return { media: mediaFromLive(m), comments: comments.sort((a, b) => ms(b.timestamp) - ms(a.timestamp)) };
    } catch (err) {
      if (err && (err.isAuth || isNetworkError(err))) throw err;
      return { media: mediaFromLive(m), comments: [], error: errText(err) };
    }
  });
  return groups;
}

/** Immutable update of one comment (or reply) by id. fn returns the new comment, or null to remove it. */
function updateComment(groups, id, fn) {
  return groups.map((g) => {
    let changed = false;
    const comments = [];
    for (const c of g.comments) {
      if (c.id === id) {
        changed = true;
        const n = fn(c);
        if (n) comments.push(n);
      } else if ((c.replies || []).some((r) => r.id === id)) {
        changed = true;
        const replies = [];
        for (const r of c.replies) {
          if (r.id !== id) replies.push(r);
          else {
            const n = fn(r);
            if (n) replies.push(n);
          }
        }
        comments.push({ ...c, replies });
      } else comments.push(c);
    }
    return changed ? { ...g, comments } : g;
  });
}

function describeCommand(cmd) {
  const p = cmd.payload || {};
  const t = clip(p.text, 60);
  switch (cmd.type) {
    case 'reply_comment':
      return `Reply: “${t}”`;
    case 'hide_comment':
      return p.hide === false ? 'Unhide a comment' : 'Hide a comment';
    case 'delete_comment':
      return 'Delete a comment';
    case 'private_reply':
      return `Private reply: “${t}”`;
    case 'send_dm':
      return `Message: “${t}”`;
    case 'publish_now':
      return 'Publish a post now';
    default:
      return cmd.type.replace(/_/g, ' ');
  }
}

// ---------------------------------------------------------------------------------------------
// Reply composer (comments, private replies and DMs)

function SuggestButton({ kind, message, postCaption, onPick }) {
  const { settings, toast } = useApp();
  const ai = getAi(settings);
  const [state, setState] = useState({ loading: false, items: null });
  const ctrl = useRef(null);
  useEffect(() => () => ctrl.current && ctrl.current.abort(), []);
  if (!ai) return null;
  const run = async () => {
    ctrl.current?.abort();
    ctrl.current = new AbortController();
    setState({ loading: true, items: null });
    try {
      const prefs = aiPrefs(settings);
      const items = await ai.replySuggestions({ kind, message, postCaption, voice: prefs.voice, language: prefs.language, count: 3, signal: ctrl.current.signal });
      setState({ loading: false, items });
      if (!items.length) toast('The AI had no suggestions for this one.', { kind: 'info' });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      setState({ loading: false, items: null });
      toast(errText(err), { kind: 'error' });
    }
  };
  return html`<${Button} size="sm" variant="ghost" icon="sparkle" loading=${state.loading} onClick=${run}>Suggest replies<//>
    ${state.items && state.items.length
      ? html`<div class="ibx-suggestions" role="group" aria-label="AI suggestions">
          ${state.items.map(
            (s, i) => html`<button type="button" class="ibx-suggestion" key=${i} onClick=${() => {
              onPick(s);
              setState({ loading: false, items: null });
            }}><${Icon} name="sparkle" size=${13} /><span>${s}</span></button>`,
          )}
        </div>`
      : null}`;
}

function ReplyComposer({ initial = '', label, placeholder, sendLabel = 'Send', kind = 'comment', context = {}, savedReplies = [], max = COMMENT_MAX, note, onSend, onCancel, autofocus = true, disabled = false, disabledReason }) {
  const { navigate } = useApp();
  const [text, setText] = useState(initial);
  const [sending, setSending] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!autofocus) return;
    const el = ref.current && ref.current.querySelector('textarea');
    if (el) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);
  const insert = (t) => {
    setText((cur) => {
      const base = cur.trimEnd();
      if (!base || base === initial.trim()) return `${initial}${t}`;
      return `${base} ${t}`;
    });
    const el = ref.current && ref.current.querySelector('textarea');
    el && el.focus();
  };
  const trimmed = text.trim();
  const empty = !trimmed || trimmed === initial.trim();
  const over = text.length > max;
  const send = async () => {
    if (empty || over || sending || disabled) return;
    setSending(true);
    try {
      const ok = await onSend(trimmed);
      if (ok !== false) setText(initial);
    } finally {
      setSending(false);
    }
  };
  const savedItems = [
    ...(savedReplies.length
      ? savedReplies.map((r) => ({ label: r.name || clip(r.text, 24), hint: clip(r.text, 26), onClick: () => insert(r.text) }))
      : [{ label: 'No saved replies yet', disabled: true }]),
    '-',
    { label: 'Manage saved replies', icon: 'edit', onClick: () => navigate('#/hashtags?tab=replies') },
  ];
  return html`<div class="ibx-composer" ref=${ref}>
    ${note ? html`<p class="ibx-composer-note">${note}</p>` : null}
    <${TextArea} value=${text} rows=${2} maxRows=${8} aria-label=${label} placeholder=${placeholder} disabled=${disabled || sending}
      onChange=${setText}
      onKeyDown=${(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          send();
        } else if (e.key === 'Escape' && onCancel) {
          e.preventDefault();
          onCancel();
        }
      }} />
    <div class="ibx-composer-bar">
      ${!disabled
        ? html`<${Menu} trigger="Saved replies" label="Saved replies" align="start" size="sm" items=${savedItems} />
            <${SuggestButton} kind=${kind} message=${context.message || ''} postCaption=${context.postCaption || ''} onPick=${insert} />`
        : null}
      <span class="spacer"></span>
      ${max ? html`<${CharCounter} value=${text} max=${max} />` : null}
      ${onCancel ? html`<${Button} size="sm" variant="ghost" onClick=${onCancel} disabled=${sending}>Cancel<//>` : null}
      <${Button} size="sm" variant="primary" icon="send" loading=${sending} disabled=${empty || over || disabled} onClick=${send}
        title=${disabled ? disabledReason : 'Ctrl+Enter or ⌘+Enter sends'}>${sendLabel}<//>
    </div>
    ${disabled && disabledReason ? html`<p class="ibx-composer-note text-warn">${disabledReason}</p>` : null}
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Comments

function CommentItem({ c, parent, group, ctx }) {
  const { tz, isMine, done, privateSent, pendingFor, canAct, composer, setComposer, savedReplies, actions } = ctx;
  const isReply = !!parent;
  const mine = isMine(c);
  const handle = c.username ? `@${c.username}` : 'Someone';
  const pending = pendingFor(c.id);
  const age = Date.now() - ms(c.timestamp);
  const prSent = privateSent(c.id);
  const prExpired = age > PRIVATE_REPLY_MS;
  const open = composer && composer.id === c.id ? composer.mode : null;
  const isDone = !!done[c.id];
  const replies = c.replies || [];

  const menuItems = [
    ...(c.username && !mine ? [{ label: 'Open profile', icon: 'external', onClick: () => window.open(`https://www.instagram.com/${encodeURIComponent(c.username)}/`, '_blank', 'noopener') }] : []),
    { label: 'Delete comment', icon: 'trash', danger: true, onClick: () => actions.remove(c) },
  ];
  const more = html`<${Menu} size="sm" label=${`More actions for comment from ${handle}`} items=${menuItems} />`;
  const btn = (label, icon, onClick, opts = {}) => html`<${Button} size="sm" variant="ghost" icon=${icon} onClick=${onClick} disabled=${!canAct || opts.disabled}
    aria-label=${opts.aria} title=${opts.title} class=${opts.active ? 'is-active' : ''} aria-expanded=${opts.expanded}>${label}<//>`;

  return html`<li class=${cx('ibx-c', isReply && 'is-reply', c.hidden && 'is-hidden', mine && 'is-mine')} id=${`comment-${c.id}`} data-comment-id=${c.id}>
    <${Avatar} name=${c.username || '?'} size=${isReply ? 26 : 32} />
    <div class="ibx-c-body">
      <div class="ibx-c-meta">
        <span class="ibx-c-user">${handle}</span>
        ${mine ? html`<${Badge} tone="accent">You<//>` : null}
        <time class="faint" datetime=${c.timestamp} title=${c.timestamp ? formatDateTime(c.timestamp, tz) : ''}>${c.timestamp ? relative(c.timestamp) : ''}</time>
        ${c.likeCount ? html`<span class="ibx-c-likes faint" title=${`${c.likeCount} likes`}><${Icon} name="heart" size=${13} /><span class="num">${c.likeCount}</span></span>` : null}
        ${c.hidden ? html`<${Badge} tone="warning" icon="eye">Hidden<//>` : null}
        ${isDone ? html`<${Badge} tone="success" icon="check">Done<//>` : null}
        ${prSent ? html`<${Badge} tone="neutral" icon="send">Private reply sent<//>` : null}
        ${pending ? html`<${Badge} tone="accent" icon="clock" title="Queued for the worker">${pending.status === 'failed' ? 'Failed' : 'Sending'}<//>` : null}
        ${mine && canAct ? html`<span class="ibx-c-menu">${more}</span>` : null}
      </div>
      <p class="ibx-c-text">${c.text || html`<span class="faint">(no text)</span>`}</p>
      ${canAct && !mine
        ? html`<div class="ibx-c-actions">
            ${!isReply && !mine
              ? btn('Reply', 'comment', () => setComposer(open === 'reply' ? null : { id: c.id, mode: 'reply' }), {
                  aria: `Reply to ${handle}`,
                  disabled: c.hidden,
                  title: c.hidden ? 'Unhide the comment to reply. Instagram does not allow replies to hidden comments.' : undefined,
                  active: open === 'reply',
                  expanded: open === 'reply' ? 'true' : 'false',
                })
              : null}
            ${!mine
              ? btn('Private reply', 'send', () => setComposer(open === 'dm' ? null : { id: c.id, mode: 'dm' }), {
                  aria: `Send ${handle} a private reply`,
                  disabled: prSent || prExpired,
                  title: prSent ? 'Instagram allows one private reply per comment.' : prExpired ? 'Private replies are only possible within 7 days of the comment.' : 'Reply by DM (one per comment, within 7 days)',
                  active: open === 'dm',
                  expanded: open === 'dm' ? 'true' : 'false',
                })
              : null}
            ${!mine ? btn(c.hidden ? 'Unhide' : 'Hide', 'eye', () => actions.hide(c, !c.hidden), { aria: `${c.hidden ? 'Unhide' : 'Hide'} comment from ${handle}` }) : null}
            ${!isReply && !mine ? btn(isDone ? 'Not done' : 'Mark done', 'check', () => actions.markDone(c, !isDone), { aria: `${isDone ? 'Mark as not done' : 'Mark as done'}: comment from ${handle}` }) : null}
            ${more}
          </div>`
        : null}
      ${open === 'reply'
        ? html`<${ReplyComposer} key="reply" initial=${c.username ? `@${c.username} ` : ''} label=${`Reply to ${handle}`} placeholder="Write a public reply…"
            sendLabel="Send reply" kind="comment" context=${{ message: c.text, postCaption: group.media.caption }} savedReplies=${savedReplies}
            onCancel=${() => setComposer(null)} onSend=${(text) => actions.reply(c, text)} />`
        : null}
      ${open === 'dm'
        ? html`<${ReplyComposer} key="dm" label=${`Private reply to ${handle}`} placeholder="Write a private message…" sendLabel="Send private reply"
            kind="dm" max=${DM_MAX} context=${{ message: c.text, postCaption: group.media.caption }} savedReplies=${savedReplies}
            note=${`Goes to ${handle}'s DMs (their message requests if they don't follow you). Instagram allows one private reply per comment, within 7 days — this one is possible until ${formatDateTime(ms(c.timestamp) + PRIVATE_REPLY_MS, tz)}.`}
            onCancel=${() => setComposer(null)} onSend=${(text) => actions.privateReply(c, text)} />`
        : null}
      ${replies.length
        ? html`<ul class="ibx-replies" aria-label=${`Replies to ${handle}`}>
            ${replies.map((r) => html`<${CommentItem} key=${r.id} c=${r} parent=${c} group=${group} ctx=${ctx} />`)}
          </ul>`
        : null}
    </div>
  </li>`;
}

const GROUP_PREVIEW = 4;

function PostGroup({ group, comments, ctx, onToggleComments, toggling }) {
  const m = group.media;
  const [expanded, setExpanded] = useState(false);
  const collapsed = !expanded && comments.length > GROUP_PREVIEW + 1;
  const shown = collapsed ? comments.slice(0, GROUP_PREVIEW) : comments;
  const day = m.timestamp ? formatDay(m.timestamp, ctx.tz) : '';
  const total = m.commentsCount ?? group.comments.length;
  return html`<section class="ibx-group" aria-label=${`Comments on ${kindLabel(m).toLowerCase()} from ${day}`}>
    <header class="ibx-post">
      ${m.permalink
        ? html`<a class="ibx-post-thumb" href=${m.permalink} target="_blank" rel="noopener noreferrer" aria-label="Open the post on Instagram">${m.thumb ? html`<img src=${m.thumb} alt="" loading="lazy" referrerpolicy="no-referrer" />` : html`<${Icon} name="image" size=${18} />`}</a>`
        : html`<span class="ibx-post-thumb">${m.thumb ? html`<img src=${m.thumb} alt="" loading="lazy" referrerpolicy="no-referrer" />` : html`<${Icon} name="image" size=${18} />`}</span>`}
      <div class="ibx-post-info">
        <p class="ibx-post-caption clamp-2">${clip(m.caption, 160) || html`<span class="faint">No caption</span>`}</p>
        <p class="ibx-post-meta">
          <span>${kindLabel(m)}</span><span aria-hidden="true">·</span><span>${day}</span>
          ${total != null ? html`<span aria-hidden="true">·</span><span class="num">${total} ${total === 1 ? 'comment' : 'comments'}</span>` : null}
          ${m.commentsEnabled === false ? html`<${Badge} tone="warning">Comments off<//>` : null}
        </p>
      </div>
      <div class="ibx-post-actions">
        ${m.commentsEnabled != null && ctx.canLive
          ? html`<${Button} size="sm" variant="ghost" icon="comment" loading=${toggling} onClick=${() => onToggleComments(group)}>${m.commentsEnabled ? 'Turn comments off' : 'Turn comments on'}<//>`
          : null}
        ${m.permalink ? html`<a class="icon-btn icon-btn-ghost icon-btn-sm" href=${m.permalink} target="_blank" rel="noopener noreferrer" aria-label="Open on Instagram" title="Open on Instagram"><${Icon} name="external" size=${16} /></a>` : null}
      </div>
    </header>
    ${group.error ? html`<p class="ibx-group-error text-warn text-sm">Could not load comments for this post: ${group.error}</p>` : null}
    <ul class="ibx-comments">
      ${shown.map((c) => html`<${CommentItem} key=${c.id} c=${c} group=${group} ctx=${ctx} />`)}
    </ul>
    ${collapsed
      ? html`<div class="ibx-more"><${Button} size="sm" variant="ghost" icon="chevron-down" onClick=${() => setExpanded(true)}>Show ${comments.length - GROUP_PREVIEW} more ${comments.length - GROUP_PREVIEW === 1 ? 'comment' : 'comments'}<//></div>`
      : null}
  </section>`;
}

function OutboxStrip({ outbox, onRetry, onDismiss }) {
  const waiting = (c) => c.status === 'pending' || c.status === 'sending'; // 'sending' = claimed by a worker run
  const recent = (outbox || []).filter((c) => c && c.type !== 'publish_now' && (waiting(c) || (c.status === 'failed' && Date.now() - ms(c.doneAt || c.createdAt) < 3 * 864e5)));
  if (!recent.length) return null;
  const pending = recent.filter(waiting).length;
  return html`<div class="ibx-outbox" role="status">
    <p class="ibx-outbox-title"><${Icon} name="clock" size=${15} />${pending ? `${pending} waiting for the worker` : 'Some actions could not be sent'}</p>
    <ul class="ibx-outbox-list">
      ${recent.slice(0, 6).map(
        (c) => html`<li key=${c.id} class=${cx('ibx-outbox-item', c.status === 'failed' && 'is-failed')}>
          <span class="grow truncate">${describeCommand(c)}</span>
          ${c.status === 'failed'
            ? html`<span class="text-bad text-sm truncate" title=${c.error || ''}>${c.error || 'Failed'}</span>
                <${Button} size="sm" variant="ghost" onClick=${() => onRetry(c)}>Try again<//>
                <${IconButton} size="sm" icon="x" label="Dismiss" onClick=${() => onDismiss(c)} />`
            : html`<span class="faint text-sm nowrap">queued ${relative(c.createdAt)}</span>`}
        </li>`,
      )}
    </ul>
  </div>`;
}

function CommentsTab({ ctx, groups, mode, loading, filter, setFilter, keep, needsCount, hiddenCount, onToggleComments, togglingId, cacheAge }) {
  const { isMine, done } = ctx;
  const filtered = useMemo(() => {
    const keepSet = keep;
    return groups
      .map((g) => {
        let list = g.comments;
        if (filter === 'needs') {
          list = list.filter((c) => keepSet.has(c.id) || (!isMine(c) && !c.hidden && !done[c.id] && !(c.replies || []).some(isMine)));
        } else if (filter === 'hidden') {
          list = list.filter((c) => keepSet.has(c.id) || c.hidden || (c.replies || []).some((r) => r.hidden));
        }
        return { g, list };
      })
      .filter((x) => x.list.length || (filter === 'all' && x.g.error));
  }, [groups, filter, keep, done]);
  const recent = filtered.filter((x) => !x.g.cached);
  const older = filtered.filter((x) => x.g.cached);
  const group = ({ g, list }) => html`<${PostGroup} key=${g.media.id} group=${g} comments=${list} ctx=${ctx} onToggleComments=${onToggleComments} toggling=${togglingId === g.media.id} />`;

  return html`<div class="stack ibx-comments-tab">
    <div class="toolbar ibx-toolbar">
      <${Segmented} label="Show" value=${filter} onChange=${setFilter}
        options=${[
          { value: 'needs', label: `Needs reply${needsCount ? ` (${needsCount})` : ''}` },
          { value: 'all', label: 'All' },
          { value: 'hidden', label: `Hidden${hiddenCount ? ` (${hiddenCount})` : ''}` },
        ]} />
      <span class="spacer"></span>
      ${mode === 'live' ? html`<${Badge} tone="success" icon="check">Live from Instagram<//>` : mode === 'cache' ? html`<${Badge} tone="warning" icon="database">Cached copy<//>` : null}
    </div>
    ${loading && !groups.length
      ? html`<div class="stack">${[0, 1].map((i) => html`<div class="ibx-group" key=${i}><div class="ibx-post"><span class="ibx-post-thumb"></span><div class="grow"><${Skeleton} lines=${2} /></div></div><div class="ibx-skel"><${Skeleton} lines=${3} /></div></div>`)}</div>`
      : !filtered.length
        ? html`<${EmptyState} icon=${filter === 'hidden' ? 'eye' : 'check'}
            title=${filter === 'needs' ? 'All caught up' : filter === 'hidden' ? 'No hidden comments' : 'No comments yet'}
            body=${filter === 'needs' ? 'Every comment on your recent posts has a reply or is marked done.' : filter === 'hidden' ? 'Comments you or your automations hide show up here.' : 'Comments on your latest posts appear here.'}
            action=${filter === 'needs' ? html`<${Button} size="sm" variant="secondary" onClick=${() => setFilter('all')}>Show all comments<//>` : null} />`
        : html`${recent.map(group)}
            ${older.length
              ? html`<section class="stack ibx-older" aria-labelledby="ibx-older-title">
                  <div class="ibx-older-head">
                    <h2 class="section-title" id="ibx-older-title">Older posts</h2>
                    <p class="muted text-sm">Comments on older posts the worker watches, from its last check${cacheAge ? ` ${cacheAge}` : ''}. Your latest ${MEDIA_LIMIT} posts above come straight from Instagram.</p>
                  </div>
                  ${older.map(group)}
                </section>`
              : null}`}
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Messages

function windowInfo(messages, isMineMsg, tz) {
  const inbound = messages.filter((m) => !isMineMsg(m)).sort((a, b) => ms(b.createdTime) - ms(a.createdTime))[0];
  if (!inbound) return { open: false, never: true };
  const until = ms(inbound.createdTime) + DM_WINDOW_MS;
  const left = until - Date.now();
  const sameDay = dayKey(new Date(until), tz) === dayKey(new Date(), tz);
  return { open: left > 0, until, left, label: sameDay ? formatTime(until, tz) : formatDateTime(until, tz) };
}

function WindowNote({ info }) {
  if (info.never) {
    return html`<p class="ibx-window is-closed"><${Icon} name="clock" size=${14} />They haven't written to you yet. Instagram only allows a message after they do.</p>`;
  }
  if (info.open) {
    const h = Math.floor(info.left / 36e5);
    const m = Math.max(1, Math.floor((info.left % 36e5) / 6e4));
    return html`<p class="ibx-window is-open"><${Icon} name="clock" size=${14} />You can reply until ${info.label} <span class="faint">(${h ? `${h} h ` : ''}${m} min left)</span></p>`;
  }
  return html`<p class="ibx-window is-closed"><${Icon} name="clock" size=${14} />The 24-hour reply window closed at ${info.label}. Instagram only lets apps reply within 24 hours of the person's last message, so answer from the Instagram app.</p>`;
}

/** The messages permission of the connection's login type (the two scope families are never mixed). */
export const messagesPermission = (mode) => (mode === 'facebook' ? 'instagram_manage_messages' : 'instagram_business_manage_messages');

function DmProblem({ problem, mode }) {
  if (!problem) return null;
  if (problem === 'needs_advanced_access') {
    return html`<${Callout} tone="warning" title="Instagram only allows messages to people with a role on your app">
      <p>Until Meta grants your app Advanced Access to ${messagesPermission(mode)} (App Review in the Meta App Dashboard), you can only message accounts that are testers or admins of the app. Reply from the Instagram app meanwhile.</p>
    <//>`;
  }
  if (problem === 'dm_disabled') {
    return html`<${Callout} tone="warning" title="Message access is turned off in Instagram">
      <p>In the Instagram app open Settings → Messages and story replies → Message controls → Connected tools and turn on “Allow access to messages”. Then refresh this page.</p>
    <//>`;
  }
  if (problem === 'no_permission') {
    return html`<${Callout} tone="warning" title="Postpilot cannot read your messages">
      <p>The Instagram token is missing the messages permission. Replace it in <a href="#/settings?section=instagram">Settings</a> with one that includes ${messagesPermission(mode)}.</p>
    <//>`;
  }
  return null;
}

function problemOf(err) {
  if (!err) return null;
  if (err.isDmDisabled) return 'dm_disabled';
  if (err.needsAdvancedAccess) return 'needs_advanced_access';
  if (err.isPermission) return 'no_permission';
  return null;
}

/**
 * "Replied to your story" / "Mentioned you in their story", with a link to the story while Instagram
 * still serves it. On the account's own messages (if Instagram marks them; unverified) the roles flip.
 */
function StoryChip({ m, mine }) {
  const kind = storyKind(m);
  if (!kind) return null;
  const ref = kind === 'mention' ? m.storyMention : m.storyReply;
  const url = ref && typeof ref.url === 'string' && /^https?:\/\//.test(ref.url) ? ref.url : null;
  const label = mine
    ? kind === 'mention' ? 'You mentioned them in your story' : 'You replied to their story'
    : kind === 'mention' ? 'Mentioned you in their story' : 'Replied to your story';
  return html`<p class="ibx-story-chip">
    <${Icon} name=${kind === 'mention' ? 'at' : 'story'} size=${13} />
    <span>${label}</span>
    ${url ? html`<a href=${url} target="_blank" rel="noopener noreferrer" title="Stories disappear after 24 hours">View story</a>` : null}
  </p>`;
}

function Bubble({ m, mine, tz }) {
  // Story mentions carry no text: the chip says what happened. Story-mention attachments are not shown twice.
  const atts = (m.attachments || []).filter((a) => !(a && a.type === 'story_mention'));
  const story = storyKind(m);
  return html`<div class=${cx('ibx-msg', mine ? 'is-mine' : 'is-theirs', story && 'has-story')}>
    <${StoryChip} m=${m} mine=${mine} />
    ${m.text || atts.length || !story
      ? html`<div class="ibx-msg-bubble">
          ${atts.map((a, i) => {
            const url = (a.image_data && (a.image_data.url || a.image_data.preview_url)) || null;
            return url
              ? html`<img key=${i} class="ibx-msg-img" src=${url} alt="Photo they sent" loading="lazy" referrerpolicy="no-referrer" />`
              : html`<span key=${i} class="ibx-msg-att"><${Icon} name=${a.video_data ? 'video' : 'image'} size=${14} />${a.video_data ? 'Video' : 'Photo'} (open Instagram to view)</span>`;
          })}
          ${m.text ? html`<span class="ibx-msg-text">${m.text}</span>` : !atts.length ? html`<span class="faint">Unsupported message</span>` : null}
        </div>`
      : null}
    <time class="ibx-msg-time" datetime=${m.createdTime} title=${formatDateTime(m.createdTime, tz)}>${formatTime(m.createdTime, tz)}${m.pending ? ' · queued' : ''}</time>
  </div>`;
}

function Thread({ conv, ctx, onBack, phone, markRead }) {
  const { ig, tz, isMineMsg, savedReplies, toast, queue, queueAfterFailure, canLive, setDmProblem, markSeen, onSent } = ctx;
  const other = conv.other || {};
  const handle = other.username ? `@${other.username}` : 'Instagram user';
  const [state, setState] = useState(() => {
    const cached = live.threads.get(conv.id);
    return cached ? { status: 'ready', messages: cached.messages } : { status: 'loading', messages: [] };
  });
  const scroller = useRef(null);

  const load = async (force = false) => {
    const cached = live.threads.get(conv.id);
    if (!force && cached && Date.now() - cached.at < LIVE_TTL_MS && cached.updatedTime === conv.updatedTime) {
      setState({ status: 'ready', messages: cached.messages });
      return;
    }
    if (!canLive) {
      const lm = conv.lastMessage;
      setState({ status: 'cache', messages: lm ? [{ id: lm.id, createdTime: lm.createdTime, fromId: lm.fromId, fromUsername: lm.fromUsername, text: lm.text, attachments: [], mineHint: lm.fromMe, story: lm.story || null }] : [] });
      return;
    }
    setState((s) => ({ ...s, status: s.messages.length ? 'refreshing' : 'loading' }));
    try {
      const msgs = (await ig.messages(conv.id)).slice().sort((a, b) => ms(a.createdTime) - ms(b.createdTime));
      live.threads.set(conv.id, { at: Date.now(), updatedTime: conv.updatedTime, messages: msgs });
      setState({ status: 'ready', messages: msgs });
    } catch (err) {
      const p = problemOf(err);
      if (p) setDmProblem(p);
      setState({ status: 'error', messages: [], error: errText(err) });
    }
  };
  useEffect(() => {
    load();
  }, [conv.id]);

  const messages = state.messages;
  const mineOf = (m) => (m.mineHint != null ? m.mineHint : isMineMsg(m));
  const info = windowInfo(messages.length ? messages : conv.lastMessage ? [{ ...conv.lastMessage, mineHint: conv.lastMessage.fromMe }] : [], mineOf, tz);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    const lastIn = messages.filter((m) => !mineOf(m)).sort((a, b) => ms(b.createdTime) - ms(a.createdTime))[0];
    if (lastIn && markRead) markSeen(conv.id, lastIn.createdTime);
  }, [messages.length, conv.id, markRead]);

  const send = async (text) => {
    if (!other.id) {
      toast('This conversation has no recipient id, so it cannot be answered here.', { kind: 'error' });
      return false;
    }
    const append = (m) => {
      setState((s) => {
        const next = [...s.messages, m];
        if (s.status === 'ready') live.threads.set(conv.id, { at: Date.now(), updatedTime: conv.updatedTime, messages: next });
        return { ...s, messages: next };
      });
      onSent(conv.id, m);
    };
    if (!canLive) {
      await queue('send_dm', { recipientId: other.id, text }, `send your message to ${handle}`);
      append({ id: uid('pending_'), createdTime: new Date().toISOString(), text, attachments: [], mineHint: true, pending: true });
      return true;
    }
    try {
      const r = await ig.sendMessage(other.id, text);
      append({ id: r.messageId || uid('sent_'), createdTime: new Date().toISOString(), fromId: ctx.ownId, fromUsername: ctx.ownName, text, attachments: [], mineHint: true });
      toast(`Message sent to ${handle}`, { kind: 'success' });
      return true;
    } catch (err) {
      if (isNetworkError(err)) {
        const queued = await queueAfterFailure(err, 'send_dm', { recipientId: other.id, text }, `send your message to ${handle}`);
        if (queued) append({ id: uid('pending_'), createdTime: new Date().toISOString(), text, attachments: [], mineHint: true, pending: true });
        return queued;
      }
      const p = problemOf(err);
      if (p) setDmProblem(p);
      toast(errText(err), { kind: 'error' });
      return false;
    }
  };

  // Group by day for separators.
  const rows = [];
  let lastDay = null;
  for (const m of messages) {
    const d = m.createdTime ? dayKey(new Date(m.createdTime), tz) : '';
    if (d !== lastDay) {
      rows.push({ sep: true, key: `d${d}`, label: m.createdTime ? formatDay(m.createdTime, tz) : '' });
      lastDay = d;
    }
    rows.push({ key: m.id, m });
  }
  const lastInbound = messages.filter((m) => !mineOf(m)).slice(-3).map((m) => m.text).filter(Boolean).join('\n');

  return html`<section class="ibx-thread" aria-label=${`Conversation with ${handle}`}>
    <header class="ibx-thread-head">
      ${phone ? html`<${IconButton} icon="chevron-left" label="Back to conversations" onClick=${onBack} />` : null}
      <${Avatar} name=${other.username || '?'} size=${34} />
      <p class="ibx-thread-name grow truncate">${handle}</p>
      ${canLive ? html`<${IconButton} icon="refresh" label="Reload conversation" onClick=${() => load(true)} />` : null}
      ${other.username ? html`<a class="icon-btn icon-btn-ghost" href=${`https://www.instagram.com/${encodeURIComponent(other.username)}/`} target="_blank" rel="noopener noreferrer" aria-label=${`Open ${handle} on Instagram`} title="Open profile on Instagram"><${Icon} name="external" size=${17} /></a>` : null}
    </header>
    <${WindowNote} info=${info} />
    <div class="ibx-thread-body" ref=${scroller} tabindex="0" aria-label="Messages">
      ${state.status === 'loading'
        ? html`<div class="ibx-thread-loading"><${Spinner} label="Loading messages" /></div>`
        : state.status === 'error'
          ? html`<${Callout} tone="danger" title="Could not load this conversation">${state.error}<//>`
          : html`${state.status === 'cache' ? html`<p class="ibx-thread-cache faint text-sm">Showing the latest message from the worker's copy. Connect to Instagram to see the whole conversation.</p>` : null}
              ${rows.map((r) => (r.sep ? html`<p class="ibx-day" key=${r.key}><span>${r.label}</span></p>` : html`<${Bubble} key=${r.key} m=${r.m} mine=${mineOf(r.m)} tz=${tz} />`))}
              ${messages.length >= 20 ? html`<p class="faint text-sm ibx-thread-cap">Instagram only shares the latest 20 messages of a conversation.</p>` : null}`}
    </div>
    <div class="ibx-thread-foot">
      <${ReplyComposer} key=${conv.id} label=${`Message to ${handle}`} placeholder=${info.open ? 'Write a message…' : 'Reply window closed'} sendLabel="Send" kind="dm" max=${DM_MAX}
        autofocus=${false} context=${{ message: lastInbound }} savedReplies=${savedReplies} onSend=${send}
        disabled=${!info.open || !ctx.canAct}
        disabledReason=${!ctx.canAct ? 'Connect Instagram in Settings to reply.' : info.never ? 'Instagram only allows a message after they write to you.' : 'The 24-hour reply window is closed. Reply from the Instagram app.'} />
    </div>
  </section>`;
}

function MessagesTab({ ctx, convs, mode, loading, error, selectedId, explicit, onSelect, seen, phone }) {
  const selected = convs.find((c) => c.id === selectedId) || null;
  const showList = !phone || !selected;
  const showThread = !phone || !!selected;
  const unread = (c) => {
    const lm = c.lastMessage;
    if (!lm || lm.fromMe) return false;
    const s = seen[c.id];
    return !s || ms(s) < ms(lm.createdTime);
  };
  return html`<div class="stack">
    <${DmProblem} problem=${ctx.dmProblem} mode=${ctx.igMode} />
    ${error ? html`<${Callout} tone="warning" title="Live messages are unavailable">${error}<//>` : null}
    <div class=${cx('ibx-dm', phone && 'is-phone')}>
      ${showList
        ? html`<nav class="ibx-convs" aria-label="Conversations">
            <div class="ibx-convs-head">
              <span class="label-caps">Conversations</span>
              ${mode === 'live' ? html`<${Badge} tone="success">Live<//>` : mode === 'cache' ? html`<${Badge} tone="warning">Cached<//>` : null}
            </div>
            ${loading && !convs.length
              ? html`<div class="ibx-convs-skel"><${Skeleton} lines=${6} /></div>`
              : !convs.length
                ? html`<${EmptyState} compact icon="message" title="No conversations" body="Direct messages to your account show up here." />`
                : html`<ul class="ibx-conv-list">
                    ${convs.map((c) => {
                      const other = c.other || {};
                      const lm = c.lastMessage;
                      const isUnread = unread(c);
                      return html`<li key=${c.id}>
                        <button type="button" class=${cx('ibx-conv', c.id === selectedId && 'is-selected', isUnread && 'is-unread')} aria-current=${c.id === selectedId ? 'true' : undefined} onClick=${() => onSelect(c.id)}>
                          <${Avatar} name=${other.username || '?'} size=${36} />
                          <span class="ibx-conv-text">
                            <span class="ibx-conv-top">
                              <span class="ibx-conv-name truncate">${other.username ? `@${other.username}` : 'Instagram user'}</span>
                              <time class="ibx-conv-time faint mono" datetime=${c.updatedTime}>${c.updatedTime ? relative(c.updatedTime) : ''}</time>
                            </span>
                            <span class="ibx-conv-preview truncate">
                              ${lm
                                ? html`${lm.fromMe ? html`<span class="faint">You: </span>` : null}${!lm.fromMe && storyKind(lm) === 'reply' ? html`<span class="ibx-conv-story">Story reply: </span>` : null}${lm.text || (!lm.fromMe && storyKind(lm) === 'mention' ? 'Mentioned you in their story' : lm.attachments ? 'Sent an attachment' : '…')}`
                                : html`<span class="faint">${c.loadingPreview ? 'Loading…' : 'New activity'}</span>`}
                            </span>
                          </span>
                          ${isUnread ? html`<span class="ibx-unread" aria-label="Unread"></span>` : null}
                        </button>
                      </li>`;
                    })}
                  </ul>`}
          </nav>`
        : null}
      ${showThread
        ? selected
          ? html`<${Thread} key=${selected.id} conv=${selected} ctx=${ctx} phone=${phone} markRead=${explicit} onBack=${() => onSelect(null)} />`
          : html`<div class="ibx-thread ibx-thread-empty"><${EmptyState} icon="message" title="Pick a conversation" body="Messages from the last few weeks appear on the left." /></div>`
        : null}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Mentions

function MentionsTab({ ctx, mentionComments, settings }) {
  const { ig, tz } = ctx;
  const fb = settings && settings.ig && settings.ig.mode === 'facebook';
  const [state, setState] = useState(() => (live.tags ? { status: 'ready', items: live.tags.items } : { status: fb && ig ? 'loading' : 'off', items: [] }));
  useEffect(() => {
    if (!fb || !ig) return;
    if (live.tags && Date.now() - live.tags.at < LIVE_TTL_MS) return;
    let alive = true;
    ig.tags({ max: 30 })
      .then((items) => {
        live.tags = { at: Date.now(), items };
        alive && setState({ status: 'ready', items });
      })
      .catch((err) => alive && setState({ status: 'error', items: [], error: errText(err) }));
    return () => {
      alive = false;
    };
  }, [fb, ig]);

  return html`<div class="stack stack-lg">
    ${!fb
      ? html`<${Callout} tone="info" title="Tagged posts need a Facebook Login connection"
          action=${html`<${Button} size="sm" variant="secondary" href="#/settings?section=instagram">Open Settings<//>`}>
          Instagram Login does not let apps see posts that tag or mention you. Connect through the Facebook Page linked to your account to see them here.
        <//>`
      : null}
    ${fb
      ? html`<section class="stack" aria-labelledby="ibx-tags-title">
          <h2 class="section-title" id="ibx-tags-title">Posts that tag you</h2>
          ${state.status === 'loading'
            ? html`<${Skeleton} lines=${3} />`
            : state.status === 'error'
              ? html`<${Callout} tone="danger" title="Could not load tagged posts">${state.error}<//>`
              : !state.items.length
                ? html`<${EmptyState} compact icon="at" title="No tagged posts" body="When someone tags your account in a post, it appears here." />`
                : html`<div class="contact-sheet ibx-tags">
                    ${state.items.map(
                      (m, i) => html`<a key=${m.id} class="ibx-tag" href=${m.permalink || '#'} target="_blank" rel="noopener noreferrer">
                        <${Frame} src=${m.thumbnailUrl || (m.mediaType !== 'VIDEO' ? m.mediaUrl : null)} alt=${clip(m.caption, 80)} number=${i + 1}
                          kind=${m.mediaType === 'VIDEO' ? 'video' : m.mediaType === 'CAROUSEL_ALBUM' ? 'carousel' : undefined}
                          label=${m.username ? `@${m.username}` : ''} />
                        <span class="ibx-tag-meta faint text-sm">${m.timestamp ? formatDay(m.timestamp, tz) : ''}</span>
                      </a>`,
                    )}
                  </div>`}
        </section>`
      : null}
    <section class="stack" aria-labelledby="ibx-mention-title">
      <h2 class="section-title" id="ibx-mention-title">Mentions in your comments</h2>
      <p class="muted text-sm">Comments on your latest posts that mention @${(settings.ig && settings.ig.username) || 'you'}.</p>
      ${!mentionComments.length
        ? html`<${EmptyState} compact icon="at" title="No mentions yet" />`
        : html`<ul class="list ibx-mentions">
            ${mentionComments.map(
              ({ c, g }) => html`<li class="list-row" key=${c.id}>
                <${Avatar} name=${c.username || '?'} size=${28} />
                <div class="grow">
                  <p><span class="strong">@${c.username || 'someone'}</span> <span class="faint text-sm">${relative(c.timestamp)}</span></p>
                  <p class="pre-wrap">${c.text}</p>
                  <p class="faint text-sm truncate">On: ${clip(g.media.caption, 70) || kindLabel(g.media)}</p>
                </div>
                <${Button} size="sm" variant="ghost" onClick=${() => ctx.showComment(c.id)}>Show<//>
              </li>`,
            )}
          </ul>`}
    </section>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Collaboration invites

// Same rules as worker/jobs/invites.mjs: an answer given here outweighs Instagram's list for an hour
// (Instagram may still list it for a moment); listed after that, the invite is open again (the answer
// did not take, or the account sent a new invite after a decline).
const DECISION_HOLD_MS = 60 * 60e3;
const decisionHolds = (inv, now) => !!inv && inv.status !== 'pending' && now - ms(inv.decidedAt) < DECISION_HOLD_MS;

/** Invites still waiting for an answer (none counted while Instagram does not offer invites to this connection). */
function waitingInvites(inbox) {
  if (!inbox || (inbox.invitesStatus && inbox.invitesStatus.state === 'unsupported')) return [];
  return (inbox.invites || []).filter((i) => i.status === 'pending');
}

/**
 * inbox.invites brought in line with a live list from Instagram (pure; the worker applies the same
 * rules): pending invites it no longer lists are dropped, answered ones it lists again after the hold
 * are open again, new ones are added, and a successful read clears an 'unsupported' state.
 * Returns {invites, status, changed}.
 */
function reconcileInvites(stored, status, items, now) {
  const nowIso = new Date(now).toISOString();
  const listed = new Map(items.map((i) => [String(i.mediaId), i]));
  let changed = false;
  const out = [];
  for (const x of stored || []) {
    const inv = listed.get(String(x.mediaId));
    if (!inv) {
      if (x.status === 'pending') {
        changed = true; // answered in the Instagram app or withdrawn
        continue;
      }
      if (x.unconfirmed) {
        const confirmed = { ...x };
        delete confirmed.unconfirmed;
        out.push(confirmed);
        changed = true;
      } else out.push(x);
      continue;
    }
    if (x.status !== 'pending' && !decisionHolds(x, now)) {
      const reopened = { ...x, status: 'pending', decidedAt: null, seenAt: nowIso };
      delete reopened.auto;
      delete reopened.unconfirmed;
      out.push(reopened);
      changed = true;
      continue;
    }
    out.push(x);
  }
  const have = new Set(out.map((x) => String(x.mediaId)));
  for (const i of items) {
    if (have.has(String(i.mediaId))) continue;
    out.unshift({ id: uid('ci_'), mediaId: String(i.mediaId), owner: i.owner, caption: clip(i.caption, 300), permalink: i.permalink, mediaUrl: i.mediaUrl, status: 'pending', seenAt: nowIso, decidedAt: null });
    changed = true;
  }
  const okStatus = status && status.state === 'ok' ? status : { state: 'ok', at: nowIso };
  if (okStatus !== status) changed = true;
  return { invites: out, status: okStatus, changed };
}

/** Post preview; Instagram's links expire, so a broken image falls back to an icon. */
function InviteThumb({ src }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  return html`<span class="ibx-invite-thumb">
    ${src && !broken ? html`<img src=${src} alt="" loading="lazy" referrerpolicy="no-referrer" onError=${() => setBroken(true)} />` : html`<${Icon} name="image" size=${20} />`}
  </span>`;
}

function InviteRow({ inv, tz, busy, canAnswer, appOnly, onAnswer }) {
  const owner = inv.owner ? `@${inv.owner}` : 'An account';
  const decided = inv.status === 'accepted' || inv.status === 'declined';
  return html`<li class=${cx('ibx-invite', decided && 'is-decided')} data-media-id=${inv.mediaId}>
    <${InviteThumb} src=${inv.mediaUrl} />
    <div class="ibx-invite-body">
      <p class="ibx-invite-title"><span class="strong">${owner}</span> invited you to collaborate on their post</p>
      ${inv.caption ? html`<p class="ibx-invite-caption muted clamp-2">${inv.caption}</p>` : null}
      <p class="ibx-invite-meta faint text-sm">
        ${inv.seenAt ? html`<span>Received <time datetime=${inv.seenAt} title=${formatDateTime(inv.seenAt, tz)}>${relative(inv.seenAt)}</time></span>` : null}
        ${inv.permalink ? html`<a href=${inv.permalink} target="_blank" rel="noopener noreferrer">Open on Instagram</a>` : null}
      </p>
    </div>
    <div class="ibx-invite-actions">
      ${decided
        ? html`<${Badge} tone=${inv.status === 'accepted' ? 'success' : 'neutral'} icon=${inv.status === 'accepted' ? 'check' : 'x'}>${inv.status === 'accepted' ? (inv.auto ? 'Accepted automatically' : 'Accepted') : 'Declined'}<//>
            ${inv.unconfirmed
              ? html`<span class="ibx-invite-note text-warn text-sm" title="The connection dropped before Instagram confirmed the answer. Postpilot checks again at its next look.">Not confirmed yet</span>`
              : inv.decidedAt ? html`<time class="faint text-sm" datetime=${inv.decidedAt} title=${formatDateTime(inv.decidedAt, tz)}>${relative(inv.decidedAt)}</time>` : null}`
        : appOnly
          ? html`<span class="ibx-invite-note muted text-sm">Answer in the Instagram app</span>`
          : html`<${Button} size="sm" variant="primary" icon="check" loading=${busy === 'accept'} disabled=${!canAnswer || !!busy}
                aria-label=${`Accept ${owner}’s invite`} title=${canAnswer ? undefined : 'Connect Instagram in Settings to answer invites.'} onClick=${() => onAnswer(inv, true)}>Accept<//>
              <${Button} size="sm" variant="ghost" loading=${busy === 'decline'} disabled=${!canAnswer || !!busy}
                aria-label=${`Decline ${owner}’s invite`} title=${canAnswer ? undefined : 'Connect Instagram in Settings to answer invites.'} onClick=${() => onAnswer(inv, false)}>Decline<//>`}
    </div>
  </li>`;
}

/**
 * Invites from inbox.invites (written by worker/jobs/invites.mjs) merged with a live read when
 * Instagram is connected; a live read also brings inbox.invites up to date (reconcileInvites).
 * Accept / Decline call Instagram directly (core/ig.js resends a lost answer and reports one Instagram
 * may have received as unconfirmed) and then record the answer in inbox.invites.
 */
function InvitesTab({ ig, inbox, settings, tz, toast, confirm }) {
  const stored = (inbox && inbox.invites) || [];
  // The worker found that this connection has no invites: no automatic live read (it would fail on
  // every visit) until the owner asks for one or the worker's next check says otherwise.
  const storedUnsupported = !!(inbox && inbox.invitesStatus && inbox.invitesStatus.state === 'unsupported');
  const [state, setState] = useState(() => (live.invites ? { status: 'ready', items: live.invites.items } : { status: !ig ? 'off' : storedUnsupported ? 'idle' : 'loading', items: [] }));
  const [busy, setBusy] = useState({}); // mediaId -> 'accept'|'decline'
  const [asked, setAsked] = useState(0); // "Check again" presses
  const unsupported = state.status === 'unsupported' || (state.status !== 'ready' && storedUnsupported);
  const inboxRef = useRef(inbox);
  inboxRef.current = inbox;

  useEffect(() => {
    if (!ig) return undefined;
    if (!asked && live.invites && Date.now() - live.invites.at < LIVE_TTL_MS) return undefined;
    if (!asked && storedUnsupported) return undefined;
    let alive = true;
    if (asked) setState((s) => ({ ...s, status: 'loading' }));
    ig.collaborationInvites()
      .then((items) => {
        live.invites = { at: Date.now(), items };
        if (alive) setState({ status: 'ready', items });
        // Bring the saved copy (tab badge, Automations) in line with Instagram's list.
        const cur = inboxRef.current || {};
        if (reconcileInvites(cur.invites, cur.invitesStatus, items, Date.now()).changed) {
          mutateInbox((d) => {
            const r = reconcileInvites(d.invites, d.invitesStatus, items, Date.now());
            d.invites = r.invites;
            d.invitesStatus = r.status;
          }, { message: 'inbox: refresh collaboration invites', silent: true }).catch(() => {});
        }
      })
      .catch((err) => alive && setState({ status: err && err.code === 'unsupported' ? 'unsupported' : 'error', items: [], error: errText(err) }));
    return () => {
      alive = false;
    };
  }, [ig, asked]);

  const now = Date.now();
  const byMedia = new Map(stored.map((i) => [String(i.mediaId), i]));
  // Live: Instagram's list is the truth for what is still open. Otherwise: the worker's copy.
  const pending = state.status === 'ready'
    ? state.items.map((i) => {
        const s = byMedia.get(i.mediaId);
        return decisionHolds(s, now) ? null : { ...(s || {}), ...i, caption: i.caption || (s && s.caption) || '', status: 'pending' };
      }).filter(Boolean)
    : stored.filter((i) => i.status === 'pending');
  const answered = stored
    .filter((i) => (i.status === 'accepted' || i.status === 'declined') && now - ms(i.decidedAt || i.seenAt) < INVITE_KEEP_MS && !pending.some((p) => p.mediaId === i.mediaId))
    .sort((a, b) => ms(b.decidedAt) - ms(a.decidedAt));

  const record = (inv, status, unconfirmed) =>
    mutateInbox((d) => {
      d.invites ||= [];
      const at = new Date().toISOString();
      let x = d.invites.find((i) => String(i.mediaId) === String(inv.mediaId));
      if (!x) {
        x = { id: uid('ci_'), mediaId: String(inv.mediaId), owner: inv.owner || '', caption: clip(inv.caption, 300), permalink: inv.permalink || null, mediaUrl: inv.mediaUrl || null, seenAt: inv.seenAt || at };
        d.invites.unshift(x);
      }
      x.status = status;
      x.decidedAt = at;
      delete x.auto;
      if (unconfirmed) x.unconfirmed = true;
      else delete x.unconfirmed;
    }, { message: `inbox: ${status} collaboration invite` });

  const dropLive = (mediaId) => {
    if (live.invites) live.invites = { ...live.invites, items: live.invites.items.filter((i) => i.mediaId !== mediaId) };
    setState((s) => (s.status === 'ready' ? { ...s, items: s.items.filter((i) => i.mediaId !== mediaId) } : s));
  };

  const answer = async (inv, accept) => {
    const owner = inv.owner ? `@${inv.owner}` : 'this account';
    if (!ig) return;
    if (!accept) {
      const ok = await confirm({ title: `Decline ${owner}’s invite?`, body: 'You will not be added as a collaborator on their post. They can send a new invite later.', confirmLabel: 'Decline invite', danger: true });
      if (!ok) return;
    }
    setBusy((b) => ({ ...b, [inv.mediaId]: accept ? 'accept' : 'decline' }));
    const status = accept ? 'accepted' : 'declined';
    try {
      const res = await ig.respondCollabInvite(inv.mediaId, accept);
      dropLive(inv.mediaId);
      await record(inv, status, !!(res && res.unconfirmed)).catch(() => {});
      if (res && res.unconfirmed) toast(`The connection dropped, but Instagram no longer lists ${owner}’s invite, so your answer most likely went through. Check the Instagram app to be sure.`, { kind: 'info' });
      else toast(accept ? `Accepted. The post now shows on your profile too.` : `Declined ${owner}’s invite.`, { kind: 'success' });
    } catch (err) {
      if (err && err.maybeSent) {
        // Instagram may have the answer: record it (unconfirmed) rather than offering the buttons again.
        dropLive(inv.mediaId);
        await record(inv, status, true).catch(() => {});
        toast(errText(err), { kind: 'info' });
      } else if (err && err.isNotFound) {
        dropLive(inv.mediaId);
        mutateInbox((d) => {
          d.invites = (d.invites || []).filter((i) => !(String(i.mediaId) === String(inv.mediaId) && i.status === 'pending'));
        }, { message: 'inbox: remove closed collaboration invite', silent: true }).catch(() => {});
        toast('This invite is no longer open. It was answered in the Instagram app or withdrawn.', { kind: 'info' });
      } else if (err && err.code === 'network') {
        toast('Could not reach Instagram, so nothing was sent. Try again.', { kind: 'error' });
      } else {
        toast(errText(err), { kind: 'error' });
      }
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[inv.mediaId];
        return next;
      });
    }
  };

  return html`<div class="stack stack-lg ibx-invites">
    <p class="muted ibx-invites-intro">When another account adds you as a collaborator on their post, the invite waits here. Accepting adds the post to your profile too, with shared likes and comments. <a href="#/automations?section=collab">Accept trusted accounts automatically</a>.</p>
    ${unsupported
      ? html`<${Callout} tone="warning" title="Invites are not available with this connection"
          action=${ig ? html`<${Button} size="sm" variant="secondary" loading=${state.status === 'loading'} onClick=${() => setAsked((n) => n + 1)}>Check again<//>` : null}>
          Instagram does not share collaboration invites with Postpilot for this account. Answer them in the Instagram app.
        <//>`
      : state.status === 'error'
        ? html`<${Callout} tone="warning" title="Live invites are unavailable">${state.error} Showing the worker’s copy instead.<//>`
        : null}
    <section class="stack" aria-labelledby="ibx-inv-open">
      <div class="row row-between">
        <h2 class="section-title" id="ibx-inv-open">Waiting for you</h2>
        ${state.status === 'ready' ? html`<${Badge} tone="success">Live<//>` : stored.length ? html`<${Badge} tone="warning">Cached<//>` : null}
      </div>
      ${state.status === 'loading' && !pending.length
        ? html`<${Skeleton} lines=${3} />`
        : !pending.length
          ? html`<${EmptyState} compact icon="users" title="No open invites"
              body=${`New collaboration invites show up here${notifyDelivery(settings, 'collab') === 'ok' ? ' and on your phone' : ''}.`} />`
          : html`<ul class="ibx-invite-list">
              ${pending.map((inv) => html`<${InviteRow} key=${inv.mediaId} inv=${inv} tz=${tz} busy=${busy[inv.mediaId]} canAnswer=${!!ig} appOnly=${unsupported} onAnswer=${answer} />`)}
            </ul>`}
    </section>
    ${answered.length
      ? html`<section class="stack" aria-labelledby="ibx-inv-done">
          <h2 class="section-title" id="ibx-inv-done">Answered</h2>
          <ul class="ibx-invite-list">
            ${answered.map((inv) => html`<${InviteRow} key=${inv.mediaId} inv=${inv} tz=${tz} />`)}
          </ul>
          <p class="faint text-sm">Answered invites are listed for 30 days.</p>
        </section>`
      : null}
  </div>`;
}

// ---------------------------------------------------------------------------------------------

export default function InboxView() {
  const { settings, ig, tz, route, toast, confirm, dispatchWorker, navigate } = useApp();
  const { data } = useDocs(['inbox', 'hashtags', 'automations']);
  const inbox = data.inbox;
  const phone = usePhone();
  // ?tab= wins; #/inbox/invites (the push notification link) also opens a tab.
  const tab = TABS.includes(route.query.tab) ? route.query.tab : TABS.includes(route.params[0]) ? route.params[0] : 'comments';
  const filter = ['needs', 'all', 'hidden'].includes(route.query.filter) ? route.query.filter : 'needs';
  const selectedConv = route.query.c || null;

  const ownId = settings && settings.ig ? String(settings.ig.userId || '') : '';
  const ownName = settings && settings.ig ? String(settings.ig.username || '').toLowerCase() : '';
  const isMine = (c) => !!c && ((ownId && c.fromId && String(c.fromId) === ownId) || (!!ownName && String(c.username || '').toLowerCase() === ownName));
  const isMineMsg = (m) => !!m && ((ownId && m.fromId && String(m.fromId) === ownId) || (!!ownName && String(m.fromUsername || '').toLowerCase() === ownName));

  // ---- comments state
  const [comments, setComments] = useState(() => (live.comments ? { mode: 'live', groups: live.comments.groups, at: live.comments.at } : { mode: 'loading', groups: [] }));
  const [commentsError, setCommentsError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [composer, setComposer] = useState(null);
  const [keep, setKeep] = useState(() => new Set());
  const [localPrivate, setLocalPrivate] = useState(() => new Set());
  const [togglingId, setTogglingId] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  // Live actions on comments shown from the worker's copy (older posts), applied until that copy
  // catches up (patchCache). Each is an idempotent groups -> groups function.
  const [cacheEdits, setCacheEdits] = useState([]);

  // ---- messages state
  const [convState, setConvState] = useState(() => (live.conversations ? { mode: 'live', list: live.conversations.list } : { mode: 'loading', list: [] }));
  const [convError, setConvError] = useState(null);
  const [dmProblem, setDmProblem] = useState(null);
  const seenWrites = useRef(new Map());

  const alive = useRef(true);
  useEffect(() => () => (alive.current = false), []);

  // Load comments (live first, then the worker's cache).
  useEffect(() => {
    let cancelled = false;
    const force = reloadKey > 0;
    if (!ig) {
      setComments({ mode: 'cache', groups: [] });
      return undefined;
    }
    if (!force && live.comments && Date.now() - live.comments.at < LIVE_TTL_MS) {
      setComments({ mode: 'live', groups: live.comments.groups, at: live.comments.at });
      return undefined;
    }
    setComments((s) => ({ ...s, mode: s.groups.length && s.mode === 'live' ? 'live' : 'loading', loading: true }));
    setRefreshing(force);
    loadLiveComments(ig)
      .then((groups) => {
        if (cancelled) return;
        live.comments = { at: Date.now(), groups };
        setComments({ mode: 'live', groups, at: live.comments.at });
        setCommentsError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setComments({ mode: 'cache', groups: [] });
        setCommentsError(err);
      })
      .finally(() => !cancelled && setRefreshing(false));
    return () => {
      cancelled = true;
    };
  }, [ig, reloadKey]);

  // Load conversations when the Messages tab is first opened.
  const convLoaded = useRef(false);
  const convReload = useRef(0);
  useEffect(() => {
    if (tab !== 'messages' && !(reloadKey !== convReload.current && convLoaded.current)) return undefined;
    let cancelled = false;
    const force = reloadKey !== convReload.current && convLoaded.current;
    convReload.current = reloadKey;
    convLoaded.current = true;
    if (!ig) {
      setConvState({ mode: 'cache', list: [] });
      return undefined;
    }
    if (!force && live.conversations && Date.now() - live.conversations.at < LIVE_TTL_MS) {
      setConvState({ mode: 'live', list: live.conversations.list });
      return undefined;
    }
    setConvState((s) => ({ ...s, mode: s.list.length && s.mode === 'live' ? 'live' : 'loading' }));
    ig.conversations({ max: 40 })
      .then(async (list) => {
        if (cancelled) return;
        const cache = new Map(((inbox && inbox.conversations) || []).map((c) => [c.id, c]));
        const prev = new Map(((live.conversations && live.conversations.list) || []).map((c) => [c.id, c]));
        let merged = list.map((c) => {
          const cached = cache.get(c.id);
          const before = prev.get(c.id);
          const fresh = (x) => x && x.lastMessage && x.updatedTime === c.updatedTime;
          return { ...c, lastMessage: fresh(before) ? before.lastMessage : fresh(cached) ? cached.lastMessage : null };
        });
        live.conversations = { at: Date.now(), list: merged };
        setConvState({ mode: 'live', list: merged });
        setConvError(null);
        setDmProblem(null);
        // Fill missing previews a few at a time (Instagram allows about 2 conversation calls per second).
        const todo = merged.filter((c) => !c.lastMessage).slice(0, PREVIEW_FETCH_MAX);
        for (const c of todo) {
          if (cancelled || !alive.current) return;
          try {
            const msgs = await ig.messages(c.id);
            const sorted = msgs.slice().sort((a, b) => ms(a.createdTime) - ms(b.createdTime));
            live.threads.set(c.id, { at: Date.now(), updatedTime: c.updatedTime, messages: sorted });
            const last = sorted[sorted.length - 1];
            if (last) {
              merged = merged.map((x) => (x.id === c.id ? { ...x, lastMessage: { id: last.id, text: last.text, fromId: last.fromId, fromUsername: last.fromUsername, createdTime: last.createdTime, attachments: (last.attachments || []).length, fromMe: isMineMsg(last), story: isMineMsg(last) ? null : storyKind(last) } } : x));
              live.conversations = { at: live.conversations.at, list: merged };
              if (!cancelled) setConvState({ mode: 'live', list: merged });
            }
          } catch (err) {
            if (err && (err.isAuth || problemOf(err))) break;
          }
          await sleep(550);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const p = problemOf(err);
        if (p) setDmProblem(p);
        setConvState({ mode: 'cache', list: [] });
        setConvError(p ? null : `${errText(err)} Showing the worker's copy instead.`);
      });
    return () => {
      cancelled = true;
    };
  }, [ig, tab === 'messages', reloadKey]);

  if (!inbox) {
    return html`<div class="page inbox"><${PageHeader} title="Inbox" subtitle="Comments and messages from Instagram in one place." />
      <div class="panel"><div class="panel-body"><${Skeleton} lines=${6} /></div></div></div>`;
  }

  const savedReplies = (data.hashtags && data.hashtags.savedReplies) || [];
  const done = inbox.done || {};
  const seen = inbox.seen || {};
  const outbox = inbox.outbox || [];
  const canAct = !!ig;
  const canLive = !!ig && comments.mode === 'live';

  // Live mode reads the latest MEDIA_LIMIT posts; the worker also watches older posts (up to
  // automations.limits watchPosts / watchDays) and the Today screen counts their comments too, so
  // those come from its copy, after the live ones.
  const liveIds = new Set(comments.groups.map((g) => String(g.media.id)));
  const older = comments.mode === 'live'
    ? cacheEdits.reduce((gs, fn) => fn(gs), groupsFromCache(inbox.comments).filter((g) => !liveIds.has(String(g.media.id))).map((g) => ({ ...g, cached: true })))
    : [];
  const groups = comments.mode === 'cache' ? groupsFromCache(inbox.comments) : [...comments.groups, ...older];
  const pendingByComment = new Map();
  for (const c of outbox) if (c && c.payload && c.payload.commentId && (c.status === 'pending' || c.status === 'sending' || c.status === 'failed')) pendingByComment.set(c.payload.commentId, c);
  const privateMap = inbox.privateReplies || {};

  let needsCount = 0;
  let hiddenCount = 0;
  const mentionComments = [];
  for (const g of groups) {
    for (const c of g.comments) {
      if (!isMine(c) && !c.hidden && !done[c.id] && !(c.replies || []).some(isMine)) needsCount++;
      if (c.hidden) hiddenCount++;
      for (const x of [c, ...(c.replies || [])]) {
        if (x.hidden && x !== c) hiddenCount++;
        if (ownName && !isMine(x) && String(x.text || '').toLowerCase().includes(`@${ownName}`)) mentionComments.push({ c: x, g });
      }
    }
  }

  const convCache = (inbox.conversations || []).map((c) => c);
  const convList = (convState.mode === 'cache' ? convCache : convState.list).map((c) => ({
    ...c,
    other: (c.participants || []).find((p) => !((ownId && String(p.id) === ownId) || (ownName && String(p.username || '').toLowerCase() === ownName))) || (c.participants || [])[0] || {},
  }));
  const invitesPending = waitingInvites(inbox).length;
  // Conversations load when the Messages tab opens; until then its badge counts the worker's copy (as Today does).
  const unreadOf = (list) => list.filter((c) => c.lastMessage && !c.lastMessage.fromMe && (!seen[c.id] || ms(seen[c.id]) < ms(c.lastMessage.createdTime))).length;
  const unreadCount = unreadOf(convState.mode === 'loading' && !convState.list.length ? convCache : convList);

  // ---- actions
  const setGroups = (fn) => {
    setComments((s) => {
      if (s.mode !== 'live') return s;
      const next = fn(s.groups);
      if (live.comments) live.comments = { ...live.comments, groups: next };
      return { ...s, groups: next };
    });
    setCacheEdits((list) => [...list, fn]);
  };
  const keepVisible = (id) => setKeep((k) => new Set(k).add(id));

  const queue = async (type, payload, what) => {
    try {
      await mutateInbox((d) => {
        d.outbox ||= [];
        d.outbox.push({ id: uid('ob_'), type, payload, status: 'pending', error: null, createdAt: new Date().toISOString() });
      }, { message: `inbox: queue ${type}` });
    } catch {
      return false;
    }
    toast(`Instagram could not be reached from this browser. The worker will ${what} within a few minutes.`, { kind: 'info', duration: 7000 });
    dispatchWorker('inbox', { quiet: true }).catch(() => {});
    return true;
  };

  /**
   * After a network failure: queue the command for the worker. When the request may already have
   * reached Instagram (err.maybeSent: replies and messages), queuing it could post it twice, so
   * nothing is queued and the owner is asked to check Instagram first.
   */
  const queueAfterFailure = async (err, type, payload, what) => {
    if (err && err.maybeSent === true) {
      toast('Instagram did not confirm this. Refresh in a moment and check before trying again.', { kind: 'error', duration: 12000 });
      return false;
    }
    return queue(type, payload, what);
  };

  /** Run a live Instagram call; on a network failure (or without live data) queue it for the worker. */
  const runOrQueue = async ({ call, type, payload, what, onDone }) => {
    if (!canLive) {
      const ok = await queue(type, payload, what);
      return ok;
    }
    try {
      const r = await call();
      onDone && onDone(r);
      return true;
    } catch (err) {
      if (isNetworkError(err)) return queueAfterFailure(err, type, payload, what);
      toast(errText(err), { kind: 'error' });
      return false;
    }
  };

  const actions = {
    reply: async (c, text) => {
      const ok = await runOrQueue({
        call: () => ig.replyToComment(c.id, text),
        type: 'reply_comment',
        payload: { commentId: c.id, text },
        what: `post your reply to @${c.username}`,
        onDone: (r) => {
          const reply = { id: r.id || uid('reply_'), text, timestamp: new Date().toISOString(), username: (settings.ig && settings.ig.username) || '', fromId: ownId, likeCount: 0, hidden: false, parentId: c.id, replies: [] };
          const withReply = (x) => ({ ...x, replies: [...(x.replies || []).filter((y) => y.id !== reply.id), reply] });
          setGroups((gs) => updateComment(gs, c.id, withReply));
          patchCache(inbox, c.id, (d, f) => Object.assign(f.comment, withReply(f.comment)));
          keepVisible(c.id);
          toast(`Replied to @${c.username}`, { kind: 'success' });
        },
      });
      if (ok) setComposer(null);
      return ok;
    },
    hide: async (c, hide) => {
      await runOrQueue({
        call: () => ig.hideComment(c.id, hide),
        type: 'hide_comment',
        payload: { commentId: c.id, hide },
        what: hide ? 'hide the comment' : 'unhide the comment',
        onDone: () => {
          setGroups((gs) => updateComment(gs, c.id, (x) => ({ ...x, hidden: hide })));
          patchCache(inbox, c.id, (d, f) => {
            f.comment.hidden = hide;
          });
          keepVisible(c.parentId || c.id);
          if (hide && composer && composer.id === c.id && composer.mode === 'reply') setComposer(null);
          toast(hide ? `Comment from @${c.username} hidden. Only they and their followers can still see it.` : `Comment from @${c.username} is visible again`, {
            kind: 'success',
            action: { label: 'Undo', onClick: () => actions.hide({ ...c, hidden: hide }, !hide) },
          });
        },
      });
    },
    remove: async (c) => {
      const ok = await confirm({ title: 'Delete this comment?', body: `The comment from @${c.username || 'someone'}${c.replies && c.replies.length ? ' and its replies' : ''} will be removed from Instagram. This cannot be undone.`, confirmLabel: 'Delete comment', danger: true });
      if (!ok) return;
      await runOrQueue({
        call: () => ig.deleteComment(c.id),
        type: 'delete_comment',
        payload: { commentId: c.id },
        what: 'delete the comment',
        onDone: () => {
          setGroups((gs) => updateComment(gs, c.id, () => null));
          patchCache(inbox, c.id, (d, f) => (f.parent ? f.parent.replies : d.comments).splice(f.index, 1));
          toast('Comment deleted', { kind: 'success' });
        },
      });
    },
    privateReply: async (c, text) => {
      const record = () =>
        mutateInbox((d) => {
          d.privateReplies ||= {};
          d.privateReplies[c.id] = new Date().toISOString();
          const keys = Object.keys(d.privateReplies);
          if (keys.length > DONE_MAX) for (const k of keys.sort((a, b) => ms(d.privateReplies[a]) - ms(d.privateReplies[b])).slice(0, keys.length - DONE_MAX)) delete d.privateReplies[k];
        }, { message: 'inbox: private reply sent', silent: true }).catch(() => {});
      let ok;
      if (!canLive) ok = await queue('private_reply', { commentId: c.id, text }, `send your private reply to @${c.username}`);
      else {
        try {
          await ig.privateReply(c.id, text);
          toast(`Private reply sent to @${c.username}`, { kind: 'success' });
          ok = true;
        } catch (err) {
          if (isNetworkError(err)) ok = await queueAfterFailure(err, 'private_reply', { commentId: c.id, text }, `send your private reply to @${c.username}`);
          else {
            const p = problemOf(err);
            if (p) setDmProblem(p);
            toast(errText(err), { kind: 'error' });
            ok = false;
          }
        }
      }
      if (ok) {
        setLocalPrivate((s) => new Set(s).add(c.id));
        keepVisible(c.parentId || c.id);
        setComposer(null);
        record();
      }
      return ok;
    },
    markDone: async (c, on) => {
      try {
        await mutateInbox((d) => {
          d.done ||= {};
          if (on) d.done[c.id] = new Date().toISOString();
          else delete d.done[c.id];
          const keys = Object.keys(d.done);
          if (keys.length > DONE_MAX) for (const k of keys.sort((a, b) => ms(d.done[a]) - ms(d.done[b])).slice(0, keys.length - DONE_MAX)) delete d.done[k];
        }, { message: 'inbox: mark done' });
        toast(on ? 'Marked as done' : 'Marked as not done', { kind: 'success', action: on ? { label: 'Undo', onClick: () => actions.markDone(c, false) } : undefined });
      } catch {
        /* toast shown by mutate */
      }
    },
  };

  const toggleComments = async (g) => {
    const enable = g.media.commentsEnabled === false;
    if (!enable) {
      const ok = await confirm({ title: 'Turn comments off for this post?', body: 'Nobody can comment until you turn comments back on. Existing comments are hidden from the post meanwhile and come back when you turn them on.', confirmLabel: 'Turn comments off' });
      if (!ok) return;
    }
    setTogglingId(g.media.id);
    try {
      await ig.setCommentsEnabled(g.media.id, enable);
      setGroups((gs) => gs.map((x) => (x.media.id === g.media.id ? { ...x, media: { ...x.media, commentsEnabled: enable } } : x)));
      toast(enable ? 'Comments are on for this post' : 'Comments are off for this post', { kind: 'success' });
    } catch (err) {
      toast(errText(err), { kind: 'error' });
    } finally {
      if (alive.current) setTogglingId(null);
    }
  };

  const retryCommand = async (cmd) => {
    if (cmd.maybeSent) {
      const ok = await confirm({ title: 'Check Instagram first', body: 'This may already have been sent. Retry only if it is not on Instagram.', confirmLabel: 'Try again' });
      if (!ok) return;
    }
    try {
      // Reset only a command that is still failed in the latest copy: another tab or device may have
      // retried it already, and resetting one the worker is sending (or sent) would send it twice.
      let latest = null;
      await mutateInbox((d) => {
        const c = (d.outbox || []).find((x) => x.id === cmd.id);
        latest = c ? c.status : null;
        if (latest === 'failed') {
          c.status = 'pending';
          c.error = null;
          c.attempts = 0;
        }
      }, { message: 'inbox: retry command' });
      if (latest !== 'failed') {
        toast(latest ? 'This action is already being sent or was sent.' : 'This action is no longer in the queue.', { kind: 'info' });
        return;
      }
      dispatchWorker('inbox', { quiet: true }).catch(() => {});
    } catch {
      /* toast shown */
    }
  };
  const dismissCommand = async (cmd) => {
    try {
      await mutateInbox((d) => {
        d.outbox = (d.outbox || []).filter((x) => x.id !== cmd.id);
      }, { message: 'inbox: dismiss command' });
    } catch {
      /* toast shown */
    }
  };

  const markSeen = (convId, iso) => {
    if (!iso) return;
    const prev = seenWrites.current.get(convId) || seen[convId];
    if (prev && ms(prev) >= ms(iso)) return;
    seenWrites.current.set(convId, iso);
    mutateInbox((d) => {
      d.seen ||= {};
      if (!d.seen[convId] || ms(d.seen[convId]) < ms(iso)) d.seen[convId] = iso;
    }, { message: 'inbox: mark conversation read', silent: true }).catch(() => seenWrites.current.delete(convId));
  };

  const onSent = (convId, m) => {
    const lm = { id: m.id, text: m.text, fromId: ownId, fromUsername: ownName, createdTime: m.createdTime, attachments: 0, fromMe: true };
    setConvState((s) => {
      const list = s.list.map((c) => (c.id === convId ? { ...c, lastMessage: lm } : c));
      if (s.mode === 'live' && live.conversations) live.conversations = { ...live.conversations, list };
      return { ...s, list };
    });
  };

  const showComment = (id) => {
    setQuery({ tab: 'comments', filter: 'all' });
    setTimeout(() => {
      const el = document.getElementById(`comment-${id}`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('is-flash');
        setTimeout(() => el.classList.remove('is-flash'), 1600);
      }
    }, 60);
  };

  const ctx = {
    ig, tz, isMine, isMineMsg, ownId, ownName, done, savedReplies, toast, queue, queueAfterFailure, canAct, canLive: !!ig && (tab === 'messages' ? convState.mode === 'live' : canLive),
    igMode: settings && settings.ig ? settings.ig.mode : null,
    composer, setComposer, actions, setDmProblem, markSeen, onSent, showComment,
    dmProblem: dmProblem || (data.automations && data.automations.status && ['needs_advanced_access', 'dm_disabled', 'no_permission'].includes(data.automations.status.dm) ? data.automations.status.dm : null),
    privateSent: (id) => localPrivate.has(id) || !!privateMap[id],
    pendingFor: (id) => pendingByComment.get(id) || null,
  };

  const refresh = () => {
    live.comments = null;
    live.conversations = null;
    live.threads.clear();
    live.tags = null;
    live.invites = null;
    setCacheEdits([]);
    setReloadKey((k) => k + 1);
  };

  // inbox.fetchedAt moves at most every 6 hours when nothing changed; automations.cursors.inboxCheckedAt is the worker's latest read.
  const checkedAt = latestTime(inbox.fetchedAt, data.automations && data.automations.cursors && data.automations.cursors.inboxCheckedAt);
  const cacheAge = checkedAt ? relative(checkedAt) : null;

  return html`<div class="page inbox">
    <${PageHeader} title="Inbox" subtitle="Comments, direct messages, mentions and collaboration invites, in one place."
      actions=${html`<${Button} variant="secondary" icon="refresh" loading=${refreshing} disabled=${!ig} onClick=${refresh}>Refresh<//>`} />

    ${!ig
      ? html`<${Callout} tone="warning" title="Instagram is not connected" action=${html`<${Button} size="sm" onClick=${() => navigate('#/settings?section=instagram')}>Open Settings<//>`}>
          Connect your Instagram account to read and answer comments and messages.${(inbox.comments || []).length ? ' Below is the last copy the worker saved.' : ''}
        <//>`
      : null}
    ${ig && commentsError && tab === 'comments'
      ? html`<${Callout} tone=${commentsError.isAuth ? 'danger' : 'warning'} title=${commentsError.isAuth ? 'Reconnect Instagram' : 'Showing the worker’s copy'}
          action=${commentsError.isAuth ? html`<${Button} size="sm" onClick=${() => navigate('#/settings?section=instagram')}>Open Settings<//>` : html`<${Button} size="sm" variant="secondary" onClick=${refresh}>Try again<//>`}>
          ${errText(commentsError)}${commentsError.isAuth ? '' : ` This is the copy the worker saved${cacheAge ? ` ${cacheAge}` : ''}. Replies and other actions are queued and the worker sends them on its next run.`}
        <//>`
      : null}

    <${OutboxStrip} outbox=${outbox} onRetry=${retryCommand} onDismiss=${dismissCommand} />

    <${Tabs} label="Inbox sections" value=${tab} onChange=${setTab}
      tabs=${[
        { id: 'comments', label: 'Comments', icon: 'comment', badge: needsCount || null },
        { id: 'messages', label: 'Messages', icon: 'message', badge: unreadCount || null },
        { id: 'mentions', label: 'Mentions', icon: 'at', badge: mentionComments.length || null },
        { id: 'invites', label: 'Invites', icon: 'users', badge: invitesPending || null },
      ]} />

    ${tab === 'comments'
      ? html`<${CommentsTab} ctx=${ctx} groups=${groups} mode=${comments.mode === 'loading' ? null : comments.mode} loading=${comments.mode === 'loading'}
          filter=${filter} setFilter=${(f) => {
            setKeep(new Set());
            setQuery({ filter: f === 'needs' ? null : f });
          }}
          keep=${keep} needsCount=${needsCount} hiddenCount=${hiddenCount} onToggleComments=${toggleComments} togglingId=${togglingId} cacheAge=${cacheAge} />`
      : tab === 'messages'
        ? html`<${MessagesTab} ctx=${ctx} convs=${convList} mode=${convState.mode === 'loading' ? null : convState.mode} loading=${convState.mode === 'loading'} error=${convError}
            selectedId=${selectedConv || (!phone && convList[0] ? convList[0].id : null)} explicit=${!!selectedConv} onSelect=${(id) => setQuery({ c: id })} seen=${seen} phone=${phone} />`
        : tab === 'mentions'
          ? html`<${MentionsTab} ctx=${ctx} mentionComments=${mentionComments} settings=${settings} />`
          : html`<${InvitesTab} key=${reloadKey} ig=${ig} inbox=${inbox} settings=${settings} tz=${tz} toast=${toast} confirm=${confirm} />`}
  </div>`;
}
