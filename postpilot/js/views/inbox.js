// Inbox: comments on recent posts, DM conversations and mentions, with replies, moderation,
// saved replies and AI suggestions. Live from Instagram when possible; otherwise the worker's
// cached copy (inbox doc), with actions queued for the worker (inbox.outbox).

import { uid } from '../../core/model.js';
import { formatDateTime, formatDay, formatTime, dayKey, relative } from '../../core/time.js';
import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { aiPrefs, getAi } from '../ai-client.js';
import { useApp } from '../app.js';
import { loadViewCss } from '../css.js';
import { mutate, useDocs } from '../data.js';
import { setQuery } from '../router.js';
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

// Live results survive switching tabs and screens for a couple of minutes (Graph API calls are rate limited).
const live = { comments: null, conversations: null, threads: new Map(), tags: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
};

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
  const recent = (outbox || []).filter((c) => c && c.type !== 'publish_now' && (c.status === 'pending' || (c.status === 'failed' && Date.now() - ms(c.doneAt || c.createdAt) < 3 * 864e5)));
  if (!recent.length) return null;
  const pending = recent.filter((c) => c.status === 'pending').length;
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

function CommentsTab({ ctx, groups, mode, loading, filter, setFilter, keep, needsCount, hiddenCount, onToggleComments, togglingId }) {
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
            body=${filter === 'needs' ? `Every comment on your latest ${MEDIA_LIMIT} posts has a reply or is marked done.` : filter === 'hidden' ? 'Comments you or your automations hide show up here.' : 'Comments on your latest posts appear here.'}
            action=${filter === 'needs' ? html`<${Button} size="sm" variant="secondary" onClick=${() => setFilter('all')}>Show all comments<//>` : null} />`
        : filtered.map(({ g, list }) => html`<${PostGroup} key=${g.media.id} group=${g} comments=${list} ctx=${ctx} onToggleComments=${onToggleComments} toggling=${togglingId === g.media.id} />`)}
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

function DmProblem({ problem }) {
  if (!problem) return null;
  if (problem === 'needs_advanced_access') {
    return html`<${Callout} tone="warning" title="Instagram only allows messages to people with a role on your app">
      <p>Until Meta grants your app Advanced Access to instagram_business_manage_messages (App Review in the Meta App Dashboard), you can only message accounts that are testers or admins of the app. Reply from the Instagram app meanwhile.</p>
    <//>`;
  }
  if (problem === 'dm_disabled') {
    return html`<${Callout} tone="warning" title="Message access is turned off in Instagram">
      <p>In the Instagram app open Settings → Messages and story replies → Message controls → Connected tools and turn on “Allow access to messages”. Then refresh this page.</p>
    <//>`;
  }
  if (problem === 'no_permission') {
    return html`<${Callout} tone="warning" title="Postpilot cannot read your messages">
      <p>The Instagram token is missing the messages permission. Replace it in <a href="#/settings?section=instagram">Settings</a> with one that includes instagram_business_manage_messages.</p>
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

function Bubble({ m, mine, tz }) {
  const atts = m.attachments || [];
  return html`<div class=${cx('ibx-msg', mine ? 'is-mine' : 'is-theirs')}>
    <div class="ibx-msg-bubble">
      ${atts.map((a, i) => {
        const url = (a.image_data && (a.image_data.url || a.image_data.preview_url)) || null;
        return url
          ? html`<img key=${i} class="ibx-msg-img" src=${url} alt="Photo they sent" loading="lazy" referrerpolicy="no-referrer" />`
          : html`<span key=${i} class="ibx-msg-att"><${Icon} name=${a.video_data ? 'video' : 'image'} size=${14} />${a.video_data ? 'Video' : 'Photo'} (open Instagram to view)</span>`;
      })}
      ${m.text ? html`<span class="ibx-msg-text">${m.text}</span>` : !atts.length ? html`<span class="faint">Unsupported message</span>` : null}
    </div>
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
      setState({ status: 'cache', messages: lm ? [{ id: lm.id, createdTime: lm.createdTime, fromId: lm.fromId, fromUsername: lm.fromUsername, text: lm.text, attachments: [], mineHint: lm.fromMe }] : [] });
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
    <${DmProblem} problem=${ctx.dmProblem} />
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
                              ${lm ? html`${lm.fromMe ? html`<span class="faint">You: </span>` : null}${lm.text || (lm.attachments ? 'Sent an attachment' : '…')}` : html`<span class="faint">${c.loadingPreview ? 'Loading…' : 'New activity'}</span>`}
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

  return html`<div class="stack-lg">
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

export default function InboxView() {
  const { settings, ig, tz, route, toast, confirm, dispatchWorker, navigate } = useApp();
  const { data } = useDocs(['inbox', 'hashtags', 'automations']);
  const inbox = data.inbox;
  const phone = usePhone();
  const tab = ['comments', 'messages', 'mentions'].includes(route.query.tab) ? route.query.tab : 'comments';
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
              merged = merged.map((x) => (x.id === c.id ? { ...x, lastMessage: { id: last.id, text: last.text, fromId: last.fromId, fromUsername: last.fromUsername, createdTime: last.createdTime, attachments: (last.attachments || []).length, fromMe: isMineMsg(last) } } : x));
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

  const groups = comments.mode === 'cache' ? groupsFromCache(inbox.comments) : comments.groups;
  const pendingByComment = new Map();
  for (const c of outbox) if (c && c.payload && c.payload.commentId && (c.status === 'pending' || c.status === 'failed')) pendingByComment.set(c.payload.commentId, c);
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
  const unreadCount = convList.filter((c) => c.lastMessage && !c.lastMessage.fromMe && (!seen[c.id] || ms(seen[c.id]) < ms(c.lastMessage.createdTime))).length;

  // ---- actions
  const setGroups = (fn) => {
    setComments((s) => {
      if (s.mode !== 'live') return s;
      const next = fn(s.groups);
      if (live.comments) live.comments = { ...live.comments, groups: next };
      return { ...s, groups: next };
    });
  };
  const keepVisible = (id) => setKeep((k) => new Set(k).add(id));

  const queue = async (type, payload, what) => {
    try {
      await mutate('inbox', (d) => {
        d.outbox ||= [];
        d.outbox.push({ id: uid('ob_'), type, payload, status: 'pending', error: null, createdAt: new Date().toISOString() });
      }, { message: `inbox: queue ${type}` });
    } catch {
      return false;
    }
    toast(`Instagram could not be reached from this browser. The worker will ${what} within a few minutes.`, { kind: 'info', duration: 7000 });
    dispatchWorker('inbox').catch(() => {});
    return true;
  };

  /**
   * After a network failure: queue the command for the worker. When the request may already have
   * reached Instagram (err.maybeSent: replies and messages), queuing it could post it twice, so ask
   * the owner to check Instagram first and only queue it on request.
   */
  const queueAfterFailure = async (err, type, payload, what) => {
    if (err && err.maybeSent) {
      toast(errText(err), { kind: 'error', duration: 12000, action: { label: 'Send it with the worker', onClick: () => queue(type, payload, what) } });
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
          setGroups((gs) => updateComment(gs, c.id, (x) => ({ ...x, replies: [...(x.replies || []), reply] })));
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
          toast('Comment deleted', { kind: 'success' });
        },
      });
    },
    privateReply: async (c, text) => {
      const record = () =>
        mutate('inbox', (d) => {
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
        await mutate('inbox', (d) => {
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
    try {
      await mutate('inbox', (d) => {
        const c = (d.outbox || []).find((x) => x.id === cmd.id);
        if (c) {
          c.status = 'pending';
          c.error = null;
          c.attempts = 0;
        }
      }, { message: 'inbox: retry command' });
      dispatchWorker('inbox').catch(() => {});
    } catch {
      /* toast shown */
    }
  };
  const dismissCommand = async (cmd) => {
    try {
      await mutate('inbox', (d) => {
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
    mutate('inbox', (d) => {
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
    setReloadKey((k) => k + 1);
  };

  const cacheAge = inbox.fetchedAt ? relative(inbox.fetchedAt) : null;

  return html`<div class="page inbox">
    <${PageHeader} title="Inbox" subtitle="Comments on your latest posts and direct messages, in one place."
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

    <${Tabs} label="Inbox sections" value=${tab} onChange=${(id) => setQuery({ tab: id === 'comments' ? null : id })}
      tabs=${[
        { id: 'comments', label: 'Comments', icon: 'comment', badge: needsCount || null },
        { id: 'messages', label: 'Messages', icon: 'message', badge: unreadCount || null },
        { id: 'mentions', label: 'Mentions', icon: 'at', badge: mentionComments.length || null },
      ]} />

    ${tab === 'comments'
      ? html`<${CommentsTab} ctx=${ctx} groups=${groups} mode=${comments.mode === 'loading' ? null : comments.mode} loading=${comments.mode === 'loading'}
          filter=${filter} setFilter=${(f) => {
            setKeep(new Set());
            setQuery({ filter: f === 'needs' ? null : f });
          }}
          keep=${keep} needsCount=${needsCount} hiddenCount=${hiddenCount} onToggleComments=${toggleComments} togglingId=${togglingId} />`
      : tab === 'messages'
        ? html`<${MessagesTab} ctx=${ctx} convs=${convList} mode=${convState.mode === 'loading' ? null : convState.mode} loading=${convState.mode === 'loading'} error=${convError}
            selectedId=${selectedConv || (!phone && convList[0] ? convList[0].id : null)} explicit=${!!selectedConv} onSelect=${(id) => setQuery({ c: id })} seen=${seen} phone=${phone} />`
        : html`<${MentionsTab} ctx=${ctx} mentionComments=${mentionComments} settings=${settings} />`}
  </div>`;
}
