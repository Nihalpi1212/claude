// Collaboration invites: other accounts asking to add this account as a collaborator on their post.
//
// At most every 6 hours (inbox.invitesCheckedAt) the job reads the pending invites
// (ig.collaborationInvites) and merges them into inbox.invites, one entry per mediaId:
// - an invite from a username on automations.collabAllowlist (case-insensitive, without @) is
//   accepted right away (ig.respondCollabInvite). When Instagram may have the answer but did not
//   confirm it (lost connection), the invite is recorded as accepted with `unconfirmed: true` and no
//   push goes out; the next check confirms it (no longer listed) or accepts it again (still listed).
//   An invite Instagram reports as not found was answered in the app or withdrawn: it is left out;
// - any other new invite queues one 'collab' push notification and waits for the owner (Inbox →
//   Invites, which answers it live from the browser);
// - a pending invite Instagram no longer lists was answered in the Instagram app or withdrawn, so it
//   is dropped; answered invites are kept for 30 days;
// - an answer is trusted over Instagram's list for DECISION_HOLD_MS (Instagram may still list it for a
//   moment). An invite still or again listed after that is open: the answer did not take, or the
//   account sent a new invite after a decline. It is handled like a new invite (accepted
//   automatically or notified once).
// When Instagram does not offer the endpoint to this connection (IgError code 'unsupported'), the job
// records that in inbox.invitesStatus and returns {skipped: 'unsupported'} until the next check.
// Console output stays numbers only; usernames and captions go to the encrypted log and inbox doc.

import { uid } from '../../core/model.js';
import { describeError } from '../context.mjs';
import { clip, DAY_MS } from './shared.mjs';

export const CHECK_EVERY_MS = 6 * 36e5;
export const DECISION_HOLD_MS = 60 * 60e3; // same rule in js/views/inbox.js
const KEEP_DECIDED_MS = 30 * DAY_MS;
const MAX_INVITES = 100;

/** Normalized username for allowlist comparisons ('@Atelier.Kin ' -> 'atelier.kin'). */
export function normUsername(u) {
  return String(u || '').trim().replace(/^@+/, '').toLowerCase();
}

function ms(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : NaN;
}

/** Does a stored answer still outweigh Instagram listing the invite as open? */
export function decisionHolds(inv, nowMs) {
  return !!inv && inv.status !== 'pending' && nowMs - ms(inv.decidedAt) < DECISION_HOLD_MS;
}

export default async function invites(ctx) {
  const ig = ctx.ig;
  const inboxDoc = await ctx.store.read('inbox');
  const nowMs = ctx.nowMs();
  if (nowMs - ms(inboxDoc.invitesCheckedAt) < CHECK_EVERY_MS) return { skipped: 'not_due' };

  const auto = await ctx.store.read('automations');
  const allow = new Set((auto.collabAllowlist || []).map(normUsername).filter(Boolean));
  const wasUnsupported = inboxDoc.invitesStatus && inboxDoc.invitesStatus.state === 'unsupported';

  let list;
  try {
    list = await ig.collaborationInvites({ max: MAX_INVITES });
  } catch (err) {
    if (!err || err.code !== 'unsupported') throw err;
    const nowIso = ctx.nowIso();
    if (!wasUnsupported) ctx.log('invites', 'info', `Collaboration invites are not available with this Instagram connection: ${describeError(err.cause || err)}`);
    await ctx.store.transact(
      async (tx) => {
        const ib = await tx.read('inbox');
        ib.invitesCheckedAt = nowIso;
        ib.invitesStatus = { state: 'unsupported', at: ib.invitesStatus?.state === 'unsupported' ? ib.invitesStatus.at || nowIso : nowIso, message: describeError(err) };
        tx.write('inbox', ib);
      },
      { message: 'invites: not available' },
    );
    return { skipped: 'unsupported' };
  }

  // Accept invites from allowlisted accounts before saving, so the saved state says what happened.
  // (Outside the transaction: a transaction may run again, an Instagram call must not.)
  const known = new Map((inboxDoc.invites || []).map((i) => [String(i.mediaId), i]));
  const accepted = new Map(); // mediaId -> {at: ISO, unconfirmed: boolean}
  const closed = new Set(); // Instagram says the invite is not open (answered in the app or withdrawn)
  let invitesAccepted = 0;
  for (const inv of list) {
    if (decisionHolds(known.get(inv.mediaId), nowMs)) continue;
    if (!allow.has(normUsername(inv.owner))) continue;
    const who = `@${normUsername(inv.owner)}`;
    try {
      const res = await ig.respondCollabInvite(inv.mediaId, true);
      const unconfirmed = !!(res && res.unconfirmed);
      accepted.set(inv.mediaId, { at: ctx.nowIso(), unconfirmed });
      invitesAccepted++;
      ctx.log('invites', 'info', `Accepted ${who}'s collaboration invite automatically (on your allowlist).${unconfirmed ? ' The connection dropped before Instagram confirmed it; Postpilot checks again at the next look.' : ''}`, { mediaId: inv.mediaId });
    } catch (err) {
      if (err && err.isAuth) throw err;
      if (err && err.maybeSent) {
        // Instagram may have accepted it: never report it as waiting. The next check confirms it.
        accepted.set(inv.mediaId, { at: ctx.nowIso(), unconfirmed: true });
        invitesAccepted++;
        ctx.log('invites', 'warn', `Instagram did not confirm the automatic accept of ${who}'s collaboration invite. Postpilot checks again at the next look.`, { mediaId: inv.mediaId, code: err.code ?? null });
        continue;
      }
      if (err && err.isNotFound) {
        closed.add(inv.mediaId);
        continue;
      }
      ctx.log('invites', 'warn', `Could not accept ${who}'s collaboration invite automatically: ${describeError(err)}`, { mediaId: inv.mediaId, code: err?.code ?? null });
    }
  }

  const nowIso = ctx.nowIso();
  let fresh = []; // first seen and waiting for the owner (notified)
  let invitesNew = 0; // first seen this run, accepted automatically or not
  await ctx.store.transact(
    async (tx) => {
      fresh = [];
      invitesNew = 0;
      const ib = await tx.read('inbox');
      const byMedia = new Map((ib.invites || []).map((i) => [String(i.mediaId), i]));
      const open = list.filter((i) => !closed.has(i.mediaId));
      const listed = new Set(open.map((i) => i.mediaId));
      const out = [];
      for (const inv of open) {
        const prev = byMedia.get(inv.mediaId);
        const acc = accepted.get(inv.mediaId);
        if (!acc && decisionHolds(prev, nowMs)) {
          out.push(prev); // just answered here; Instagram may list it until it catches up
          continue;
        }
        // Answered long enough ago and still (or again) listed: open again, like a new invite.
        const isNew = !prev || prev.status !== 'pending';
        const entry = {
          ...(prev || { id: uid('ci_') }),
          ...(isNew ? { seenAt: nowIso } : {}),
          mediaId: inv.mediaId,
          owner: inv.owner || (prev && prev.owner) || '',
          caption: clip(inv.caption || (prev && prev.caption) || '', 300),
          permalink: inv.permalink || (prev && prev.permalink) || null,
          mediaUrl: inv.mediaUrl || (prev && prev.mediaUrl) || null,
          status: acc ? 'accepted' : 'pending',
          decidedAt: acc ? acc.at : null,
        };
        delete entry.auto;
        delete entry.unconfirmed;
        if (acc) entry.auto = true;
        if (acc && acc.unconfirmed) entry.unconfirmed = true;
        if (isNew) invitesNew++;
        if (isNew && !acc) fresh.push(entry);
        out.push(entry);
      }
      // Answered here (or accepted automatically) and kept for a while; no longer listed confirms an
      // unconfirmed automatic accept. Pending ones Instagram stopped listing were answered in the app
      // or withdrawn.
      for (const prev of ib.invites || []) {
        if (listed.has(String(prev.mediaId))) continue;
        if (prev.status === 'pending' || !(nowMs - ms(prev.decidedAt || prev.seenAt) < KEEP_DECIDED_MS)) continue;
        const kept = { ...prev };
        delete kept.unconfirmed;
        out.push(kept);
      }
      ib.invites = out.sort((a, b) => String(b.seenAt || '').localeCompare(String(a.seenAt || ''))).slice(0, MAX_INVITES);
      ib.invitesCheckedAt = nowIso;
      ib.invitesStatus = { state: 'ok', at: nowIso };
      tx.write('inbox', ib);
    },
    { message: 'invites: refresh' },
  );

  if (wasUnsupported) ctx.log('invites', 'info', 'Collaboration invites can be read again with this Instagram connection.');
  for (const inv of fresh) ctx.notify('collab', { owner: inv.owner });
  if (fresh.length) ctx.log('invites', 'info', `${fresh.length} new collaboration invite${fresh.length === 1 ? '' : 's'} waiting in Inbox → Invites.`);
  return { invitesNew, invitesAccepted };
}
