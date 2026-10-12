// Automations: poll recent comments and DMs, apply keyword rules, welcome DMs and blocked words.
//
// Polling design (Instagram has no "since" filter for comments):
// - Recent media (last 14 days, at most 15). A media item's comments are fetched only when its
//   comments_count changed since the last run (cursors.mediaComments[mediaId] = count).
// - DM threads whose updated_time is newer than cursors.dmUpdatedTime (or whose cached preview is
//   stale) have their latest messages read.
// - Rules only act on comments/messages created after automations were switched on
//   (cursors.startedAt), so turning automations on never answers old conversations.
// - Every handled comment/message id goes into processed.{comments,messages}; rules marked
//   oncePerUser use processed.users (core/rules.js recordFired).
// Limits: limits.maxActionsPerRun, limits.maxDmsPerHour, the 7-day private-reply window, the 24h DM
// window, one automated DM per conversation per run. Permission problems (Advanced Access, message
// access turned off) are recorded in automations.status and stop DMs for the run.
// Also refreshes inbox.comments / inbox.conversations, the cached view the app shows when live
// Instagram calls are not possible.

import { evaluate, recordFired } from '../../core/rules.js';
import { describeError } from '../context.mjs';
import { clip, DAY_MS, isRetryable } from './shared.mjs';

const MEDIA_WINDOW_DAYS = 14;
const MEDIA_MAX = 15;
const COMMENTS_PER_MEDIA = 100;
const PRIVATE_REPLY_WINDOW_MS = 7 * DAY_MS - 30 * 60e3; // keep a margin for slow runs
const DM_WINDOW_MS = 24 * 36e5 - 10 * 60e3;
const BASELINE_SLACK_MS = 5 * 60e3;
const COMMENT_CACHE_MAX = 100;
const CONVERSATION_CACHE_MAX = 30;
const ACTIVITY_MAX = 100;
const CACHE_REFRESH_MS = 60 * 60e3;
const FLUSH_EVERY = 5;

const DM_TYPES = new Set(['private_reply', 'send_dm']);
// DM problems the owner has to fix; the worker re-checks them every few hours instead of every run.
const DM_BLOCKED = new Set(['needs_advanced_access', 'dm_disabled', 'no_permission']);
const DM_RECHECK_MS = 6 * 36e5;

function ms(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : NaN;
}

function latestActivity(c) {
  let t = ms(c.timestamp) || 0;
  for (const r of c.replies || []) t = Math.max(t, ms(r.timestamp) || 0);
  return t;
}

export default async function automations(ctx) {
  const ig = ctx.ig;
  const doc = await ctx.store.read('automations');
  const inboxDoc = await ctx.store.read('inbox');
  const enabled = doc.enabled !== false;
  const nowMs = ctx.nowMs();
  const nowIso = ctx.nowIso();
  const own = {
    id: String(ig.userId || ctx.settings.ig?.userId || ''),
    username: String(ctx.settings.ig?.username || '').toLowerCase(),
  };
  const isOwn = (fromId, username) => (fromId && String(fromId) === own.id) || (!!username && own.username && String(username).toLowerCase() === own.username);

  const limits = { maxActionsPerRun: 25, maxDmsPerHour: 40, ...(doc.limits || {}) };
  const cursors = doc.cursors || {};
  const startedAt = enabled ? cursors.startedAt || nowIso : null;
  const baselineMs = startedAt ? ms(startedAt) - BASELINE_SLACK_MS : Infinity;
  const dmDelayMs = ctx.env.POSTPILOT_DM_DELAY_MS != null ? Number(ctx.env.POSTPILOT_DM_DELAY_MS) : 550;

  // Working state: `proc` is what evaluate() sees; the deltas are merged into the stored document.
  const proc = structuredClone(doc.processed || {});
  for (const k of ['comments', 'messages', 'conversations', 'users']) proc[k] ||= {};
  const recentDms = (cursors.recentDms || []).filter((t) => nowMs - t < 36e5);
  let delta = newDelta();
  const result = { replies: 0, dms: 0, hidden: 0, deleted: 0, aiReplies: 0, commentsChecked: 0, messagesChecked: 0 };
  let actionsLeft = Math.max(0, Number(limits.maxActionsPerRun) || 0);
  const prevStatus = doc.status || {};
  const dmRecheckDue = !DM_BLOCKED.has(prevStatus.dm) || !(nowMs - ms(prevStatus.checkedAt || prevStatus.at) < DM_RECHECK_MS);
  let dmBlocked = !dmRecheckDue;
  let status = null; // new automations.status.dm info, when it changed
  let unflushed = 0;
  // Push notifications for new comments/DMs: anything newer than what the previous run saw
  // (nothing on the very first run). Works whether or not rules are switched on.
  const prevCommentSeen = ms(cursors.commentsSeenAt);
  const prevDmSeen = ms(cursors.dmSeenAt);
  const newComments = [];
  const newDms = [];

  function newDelta() {
    return { comments: {}, messages: {}, conversations: {}, users: [], mediaComments: {}, dmUpdatedTime: null, seen: {}, stats: {}, rules: {}, activity: [] };
  }

  function markFired(ruleId, userId) {
    if (!ruleId || !userId) return;
    recordFired(proc, ruleId, userId, nowIso);
    delta.users.push([ruleId, userId]);
    const r = (delta.rules[ruleId] ||= { fired: 0 });
    r.fired++;
  }

  function bump(key) {
    delta.stats[key] = (delta.stats[key] || 0) + 1;
  }

  function activity(entry) {
    delta.activity.push({ at: ctx.nowIso(), ...entry });
  }

  function dmAllowed() {
    if (dmBlocked) return false;
    return recentDms.length < Math.max(0, Number(limits.maxDmsPerHour) || 0);
  }

  function setDmStatus(dm, message = '') {
    const at = ctx.nowIso();
    status = { dm, at: prevStatus.dm === dm && prevStatus.at ? prevStatus.at : at, checkedAt: at, message };
    return prevStatus.dm !== dm; // true when this is news
  }

  function noteDmProblem(err) {
    if (err && (err.needsAdvancedAccess || err.isDmDisabled)) {
      dmBlocked = true;
      setDmStatus(err.isDmDisabled ? 'dm_disabled' : 'needs_advanced_access', describeError(err));
      return true;
    }
    return false;
  }

  function seen(key, iso) {
    if (iso && (!delta.seen[key] || iso > delta.seen[key])) delta.seen[key] = iso;
  }

  async function flush(final = false) {
    const d = delta;
    delta = newDelta();
    unflushed = 0;
    const statusNow = status;
    let blockedNow = null;
    await ctx.store.transact(
      async (tx) => {
        blockedNow = null;
        const a = await tx.read('automations');
        let changed = false;
        a.processed ||= {};
        for (const k of ['comments', 'messages', 'conversations']) {
          if (!Object.keys(d[k]).length) continue;
          a.processed[k] = { ...(a.processed[k] || {}), ...d[k] };
          changed = true;
        }
        for (const [ruleId, userId] of d.users) {
          recordFired(a.processed, ruleId, userId, nowIso);
          changed = true;
        }
        a.cursors ||= {};
        if (Object.keys(d.mediaComments).length) {
          a.cursors.mediaComments = { ...(a.cursors.mediaComments || {}), ...d.mediaComments };
          changed = true;
        }
        if (d.dmUpdatedTime && (!a.cursors.dmUpdatedTime || d.dmUpdatedTime > a.cursors.dmUpdatedTime)) {
          a.cursors.dmUpdatedTime = d.dmUpdatedTime;
          changed = true;
        }
        for (const [k, v] of Object.entries(d.seen)) {
          if (!a.cursors[k] || v > a.cursors[k]) {
            a.cursors[k] = v;
            changed = true;
          }
        }
        if ((a.cursors.startedAt || null) !== startedAt && (final || startedAt)) {
          a.cursors.startedAt = startedAt;
          changed = true;
        }
        const keepDms = recentDms.filter((t) => ctx.nowMs() - t < 36e5);
        if (JSON.stringify(a.cursors.recentDms || []) !== JSON.stringify(keepDms) && (keepDms.length || (a.cursors.recentDms || []).length)) {
          a.cursors.recentDms = keepDms;
          changed = true;
        }
        if (Object.keys(d.stats).length) {
          a.stats ||= {};
          for (const [k, v] of Object.entries(d.stats)) a.stats[k] = (a.stats[k] || 0) + v;
          changed = true;
        }
        for (const [ruleId, r] of Object.entries(d.rules)) {
          const rule = (a.rules || []).find((x) => x.id === ruleId);
          if (!rule) continue;
          rule.stats = { fired: (rule.stats?.fired || 0) + r.fired, lastFiredAt: nowIso };
          changed = true;
        }
        if (d.activity.length) {
          a.activity = [...d.activity.slice().reverse(), ...(a.activity || [])].slice(0, ACTIVITY_MAX);
          changed = true;
        }
        if (statusNow) {
          const prev = a.status || {};
          if (prev.dm !== statusNow.dm || (statusNow.dm !== 'ok' && (prev.message !== statusNow.message || prev.checkedAt !== statusNow.checkedAt))) {
            if (prev.dm !== statusNow.dm && statusNow.dm !== 'ok') blockedNow = statusNow;
            a.status = { ...prev, ...statusNow };
            changed = true;
          }
        }
        if (changed) tx.write('automations', a);
      },
      { message: 'automations: record activity' },
    );
    if (blockedNow) ctx.notify('account', { message: blockedNow.message });
  }

  async function maybeFlush() {
    if (unflushed >= FLUSH_EVERY) await flush();
  }

  /** Run one action. Returns true when it was performed. */
  async function perform(action, ev, ctxInfo) {
    if (actionsLeft <= 0) return false;
    const base = { source: ev.source, type: action.type, ruleId: action.ruleId || null, ruleName: action.ruleName || (action.reason === 'welcome' ? 'Welcome message' : action.reason === 'blocked_word' ? 'Blocked words' : ''), username: ev.username || null, mediaId: ev.mediaId || null };
    let text = action.text || '';
    let channel = action.type === 'ai_reply' ? action.channel || (ev.source === 'comment' ? 'comment' : 'dm') : null;
    try {
      if (action.type === 'ai_reply') {
        if (ctx.ai) {
          try {
            const reply = await ctx.ai.autoReply({ message: ev.text || '', guidance: action.guidance || '', kind: channel === 'dm' ? 'dm' : 'comment', postCaption: ctxInfo.caption || '' });
            if (reply) {
              text = reply;
              result.aiReplies++;
            } else if (!text) {
              activity({ ...base, ok: false, skipped: 'ai_declined', text: '' });
              return false;
            }
          } catch (err) {
            ctx.log('automations', 'warn', `AI reply failed: ${describeError(err)}`);
            if (!text) return false;
          }
        } else if (!text) {
          activity({ ...base, ok: false, skipped: 'ai_not_configured' });
          return false;
        }
      }
      const kind = action.type === 'ai_reply' ? (ev.source === 'comment' ? (channel === 'dm' ? 'private_reply' : 'reply_comment') : 'send_dm') : action.type;
      if (DM_TYPES.has(kind)) {
        if (!dmAllowed()) {
          activity({ ...base, ok: false, skipped: dmBlocked ? 'dm_blocked' : 'dm_hourly_limit' });
          return false;
        }
        if (kind === 'private_reply' && nowMs - ms(ev.timestamp) > PRIVATE_REPLY_WINDOW_MS) {
          activity({ ...base, ok: false, skipped: 'outside_window' });
          ctx.log('automations', 'info', 'Skipped a private reply because the comment is older than 7 days.');
          return false;
        }
        if (kind === 'send_dm' && nowMs - ms(ev.timestamp) > DM_WINDOW_MS) {
          activity({ ...base, ok: false, skipped: 'outside_window' });
          ctx.log('automations', 'info', 'Skipped a DM because the message is older than 24 hours.');
          return false;
        }
      }
      if (!text && kind !== 'hide_comment' && kind !== 'delete_comment') return false;
      actionsLeft--;
      switch (kind) {
        case 'reply_comment':
          // Instagram threads are one level deep: answer a reply on its parent comment.
          await ig.replyToComment(ev.parentId || ev.id, text);
          result.replies++;
          bump('replies');
          break;
        case 'private_reply':
          await ig.privateReply(ev.id, text);
          recentDms.push(ctx.nowMs());
          result.dms++;
          bump('dms');
          if (!status) setDmStatus('ok');
          break;
        case 'send_dm':
          await ig.sendMessage(ev.userId, text);
          recentDms.push(ctx.nowMs());
          result.dms++;
          bump('dms');
          if (!status) setDmStatus('ok');
          break;
        case 'hide_comment':
          await ig.hideComment(ev.id, true);
          result.hidden++;
          bump('hidden');
          break;
        case 'delete_comment':
          await ig.deleteComment(ev.id);
          result.deleted++;
          bump('deleted');
          break;
        default:
          return false;
      }
      unflushed++;
      activity({ ...base, type: kind, ok: true, text: clip(text, 200) });
      return true;
    } catch (err) {
      const wasBlocked = DM_BLOCKED.has(prevStatus.dm);
      const dmProblem = noteDmProblem(err);
      activity({ ...base, ok: false, error: describeError(err) });
      if (!dmProblem || !wasBlocked) {
        ctx.log('automations', dmProblem ? 'error' : 'warn', `Could not ${String(action.type).replace(/_/g, ' ')}: ${describeError(err)}`, { code: err?.code ?? null, subcode: err?.subcode ?? null });
      }
      if (err && err.isAuth) throw err;
      if (isRetryable(err)) throw Object.assign(err, { retryLater: true });
      return false;
    }
  }

  /** Evaluate and act on one event. Returns {done: boolean, acted: boolean}. */
  async function handle(ev, ctxInfo, { isFirstContact = false } = {}) {
    const actions = evaluate({ rules: doc.rules || [], event: ev, processed: proc, blockedWords: doc.blockedWords, welcome: doc.welcome, isFirstContact, vars: doc.vars || {} });
    if (!actions.length) return { done: true, acted: false };
    if (actionsLeft <= 0) return { done: false, acted: false };
    let acted = false;
    const fired = new Set();
    for (const action of actions) {
      try {
        if (await perform(action, ev, ctxInfo)) {
          acted = true;
          if (action.ruleId) fired.add(action.ruleId);
        }
      } catch (err) {
        if (err && err.retryLater && !acted) return { done: false, acted: false };
        if (err && err.isAuth) throw err;
      }
    }
    for (const ruleId of fired) markFired(ruleId, ev.userId);
    return { done: true, acted };
  }

  // ---- comments ------------------------------------------------------------------------------
  let media = [];
  let mediaOk = true;
  try {
    media = await ig.listMedia({ limit: MEDIA_MAX, max: MEDIA_MAX });
  } catch (err) {
    if (err && err.isAuth) throw err;
    mediaOk = false;
    ctx.log('automations', 'warn', `Could not list recent posts: ${describeError(err)}`);
  }
  const recent = media.filter((m) => m && m.id && nowMs - ms(m.timestamp) <= MEDIA_WINDOW_DAYS * DAY_MS);
  const counts = cursors.mediaComments || {};
  const fetched = new Map(); // mediaId -> comments
  for (const m of recent) {
    const prev = counts[m.id];
    const unchanged = prev !== undefined && m.commentsCount != null && prev === m.commentsCount;
    if (unchanged || (prev === undefined && m.commentsCount === 0)) {
      if (prev === undefined) delta.mediaComments[m.id] = 0;
      continue;
    }
    let comments;
    try {
      comments = await ig.comments(m.id, { max: COMMENTS_PER_MEDIA });
    } catch (err) {
      if (err && err.isAuth) throw err;
      ctx.log('automations', 'warn', `Could not read comments: ${describeError(err)}`);
      continue;
    }
    fetched.set(m.id, comments);
    let complete = true;
    // Oldest first so replies go out in the order people commented.
    const flat = comments.flatMap((c) => [c, ...(c.replies || []).map((r) => ({ ...r, parentId: r.parentId || c.id }))]).sort((a, b) => (ms(a.timestamp) || 0) - (ms(b.timestamp) || 0));
    for (const c of flat) {
      if (isOwn(c.fromId, c.username) || !c.timestamp) continue;
      if (ms(c.timestamp) > prevCommentSeen) newComments.push(c);
      seen('commentsSeenAt', c.timestamp);
    }
    for (const c of flat) {
      if (!c.id || proc.comments[c.id]) continue;
      if (isOwn(c.fromId, c.username)) continue;
      if (!enabled || !(ms(c.timestamp) >= baselineMs)) continue; // before automations were on
      if (c.hidden) {
        // Hidden by the owner: Instagram does not allow replies, and it needs no automation.
        proc.comments[c.id] = nowIso;
        delta.comments[c.id] = nowIso;
        continue;
      }
      result.commentsChecked++;
      const ev = {
        source: 'comment',
        id: c.id,
        text: c.text || '',
        mediaId: m.id,
        userId: c.fromId || (c.username ? `u:${String(c.username).toLowerCase()}` : null),
        username: c.username || null,
        isOwn: false,
        timestamp: c.timestamp,
        parentId: c.parentId || null,
      };
      const r = await handle(ev, { caption: m.caption });
      if (!r.done) {
        complete = false;
        if (actionsLeft <= 0) break;
        continue;
      }
      proc.comments[c.id] = nowIso;
      delta.comments[c.id] = nowIso;
      await maybeFlush();
    }
    if (complete && m.commentsCount != null) delta.mediaComments[m.id] = m.commentsCount;
  }

  // ---- DMs -------------------------------------------------------------------------------------
  let convs = [];
  let convsOk = false;
  const cachedConvs = new Map((inboxDoc.conversations || []).map((c) => [c.id, c]));
  const threadMessages = new Map();
  // Message access turned off or missing permission: Instagram refuses even to list threads, so
  // only look again every few hours (the app shows automations.status meanwhile).
  const skipListing = dmBlocked && (prevStatus.dm === 'dm_disabled' || prevStatus.dm === 'no_permission');
  try {
    if (!skipListing) {
      convs = await ig.conversations({ max: 50 });
      convsOk = true;
      if (prevStatus.dm === 'dm_disabled' || prevStatus.dm === 'no_permission') setDmStatus('ok');
    }
  } catch (err) {
    if (err && err.isAuth) throw err;
    let news = false;
    if (noteDmProblem(err)) news = status.dm !== prevStatus.dm;
    else if (err && err.isPermission) {
      dmBlocked = true;
      news = setDmStatus('no_permission', describeError(err));
    } else news = true; // temporary problem: worth a warning
    if (news) ctx.log('automations', status && status.dm !== 'ok' ? 'error' : 'warn', `Could not read direct messages: ${describeError(err)}`, { code: err?.code ?? null });
  }
  const dmCursorMs = ms(cursors.dmUpdatedTime) || baselineMs;
  const ordered = convs.filter((c) => c && c.id).sort((a, b) => (ms(a.updatedTime) || 0) - (ms(b.updatedTime) || 0));
  const top = new Set(ordered.slice(-CONVERSATION_CACHE_MAX).map((c) => c.id));
  let calls = 0;
  let cursorBlocked = false;
  for (const conv of ordered) {
    const updated = ms(conv.updatedTime) || 0;
    // updated_time has one-second precision: re-check a thread whose time equals the cursor
    // (already handled messages are skipped through processed.messages).
    const isNew = enabled && updated >= dmCursorMs;
    const cached = cachedConvs.get(conv.id);
    const cacheStale = top.has(conv.id) && (!cached || cached.updatedTime !== conv.updatedTime);
    if (!isNew && !cacheStale) continue;
    let msgs;
    try {
      if (calls++ && dmDelayMs > 0) await ctx.sleep(dmDelayMs); // Conversations API: 2 calls/second
      msgs = await ig.messages(conv.id);
    } catch (err) {
      if (err && err.isAuth) throw err;
      ctx.log('automations', 'warn', `Could not read a conversation: ${describeError(err)}`);
      cursorBlocked = true;
      continue;
    }
    threadMessages.set(conv.id, msgs);
    for (const m of msgs) {
      if (isOwn(m.fromId, m.fromUsername) || !m.createdTime) continue;
      if (ms(m.createdTime) > prevDmSeen) newDms.push({ ...m, username: m.fromUsername || (conv.participants || []).find((p) => !isOwn(p.id, p.username))?.username || null });
      seen('dmSeenAt', m.createdTime);
    }
    if (!isNew) continue;

    const seenBefore = !!proc.conversations[conv.id];
    const fromUs = msgs.some((m) => isOwn(m.fromId, m.fromUsername));
    let firstContact = !seenBefore && !fromUs && msgs.length > 0 && msgs.every((m) => ms(m.createdTime) >= baselineMs);
    let sentInThread = false;
    let complete = true;
    const inbound = msgs.filter((m) => m.id && !isOwn(m.fromId, m.fromUsername) && !proc.messages[m.id]).sort((a, b) => (ms(a.createdTime) || 0) - (ms(b.createdTime) || 0));
    const participant = (conv.participants || []).find((p) => !isOwn(p.id, p.username));
    for (const m of inbound) {
      if (ms(m.createdTime) >= baselineMs && !sentInThread) {
        result.messagesChecked++;
        const ev = {
          source: m.replyTo && m.replyTo.story ? 'story_reply' : 'dm',
          id: m.id,
          text: m.text || '',
          userId: m.fromId || participant?.id || null,
          username: m.fromUsername || participant?.username || null,
          isOwn: false,
          timestamp: m.createdTime,
        };
        const r = await handle(ev, {}, { isFirstContact: firstContact });
        firstContact = false;
        if (!r.done) {
          complete = false;
          break;
        }
        if (r.acted) sentInThread = true;
      }
      proc.messages[m.id] = nowIso;
      delta.messages[m.id] = nowIso;
      await maybeFlush();
    }
    proc.conversations[conv.id] = nowIso;
    delta.conversations[conv.id] = nowIso;
    if (!complete) cursorBlocked = true;
    if (!cursorBlocked && conv.updatedTime) delta.dmUpdatedTime = conv.updatedTime;
    if (actionsLeft <= 0) cursorBlocked = true;
  }

  await flush(true);

  const newest = (list, key) => list.slice().sort((a, b) => (ms(b[key]) || 0) - (ms(a[key]) || 0))[0];
  if (newComments.length) {
    const c = newest(newComments, 'timestamp');
    ctx.notify('comment', { count: newComments.length, username: c.username, text: c.text });
  }
  if (newDms.length) {
    const m = newest(newDms, 'createdTime');
    ctx.notify('dm', { count: newDms.length, username: m.username, text: m.text || (m.attachments?.length ? 'Sent an attachment.' : '') });
  }

  // ---- inbox cache -----------------------------------------------------------------------------
  const mediaInfo = new Map(recent.map((m) => [m.id, m]));
  await ctx.store.transact(
    async (tx) => {
      const ib = await tx.read('inbox');
      const before = JSON.stringify([ib.comments, ib.conversations]);
      if (mediaOk && fetched.size) {
        const keep = (ib.comments || []).filter((c) => !fetched.has(c.mediaId));
        const fresh = [];
        for (const [mediaId, list] of fetched) {
          const m = mediaInfo.get(mediaId) || {};
          for (const c of list) {
            fresh.push({
              ...c,
              mediaId,
              media: { permalink: m.permalink || null, thumbnailUrl: m.thumbnailUrl || m.mediaUrl || null, caption: clip(m.caption, 120), timestamp: m.timestamp || null, productType: m.productType || null },
            });
          }
        }
        ib.comments = [...fresh, ...keep].sort((a, b) => latestActivity(b) - latestActivity(a)).slice(0, COMMENT_CACHE_MAX);
      }
      if (convsOk) {
        const prev = new Map((ib.conversations || []).map((c) => [c.id, c]));
        ib.conversations = ordered
          .slice(-CONVERSATION_CACHE_MAX)
          .reverse()
          .map((conv) => {
            const msgs = threadMessages.get(conv.id);
            const old = prev.get(conv.id);
            let lastMessage = old?.lastMessage || null;
            if (msgs && msgs.length) {
              const last = msgs.slice().sort((a, b) => (ms(b.createdTime) || 0) - (ms(a.createdTime) || 0))[0];
              lastMessage = {
                id: last.id,
                text: clip(last.text, 200),
                fromId: last.fromId,
                fromUsername: last.fromUsername,
                createdTime: last.createdTime,
                attachments: (last.attachments || []).length,
                fromMe: isOwn(last.fromId, last.fromUsername),
              };
            }
            return { id: conv.id, updatedTime: conv.updatedTime, participants: conv.participants || [], lastMessage };
          });
      }
      const changed = JSON.stringify([ib.comments, ib.conversations]) !== before;
      const stale = !ib.fetchedAt || ctx.nowMs() - ms(ib.fetchedAt) >= CACHE_REFRESH_MS;
      if (!changed && !stale) return;
      if (mediaOk || convsOk) ib.fetchedAt = ctx.nowIso();
      tx.write('inbox', ib);
    },
    { message: 'automations: refresh inbox' },
  );

  if (!enabled) return { skipped: 'disabled' };
  const acted = result.replies + result.dms + result.hidden + result.deleted;
  if (acted) ctx.log('automations', 'info', `Automations replied to ${result.replies} comment${result.replies === 1 ? '' : 's'}, sent ${result.dms} DM${result.dms === 1 ? '' : 's'}, hid ${result.hidden}, deleted ${result.deleted}.`);
  return result;
}
